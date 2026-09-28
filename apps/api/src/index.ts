import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { randomUUID } from 'node:crypto';
import { db, migrate } from './db.js';

migrate();

const app = new Hono();
app.use('*', cors({ origin: (process.env.CORS_ORIGIN ?? '*').split(',') }));

const rupiah = (n: number) => `Rp${Number(n || 0).toLocaleString('id-ID')}`;

// ---------- health ----------
app.get('/health', (c) => c.json({ ok: true, time: new Date().toISOString() }));

// ---------- master ----------
app.get('/api/categories', (c) => {
  const rows = db.prepare('SELECT * FROM categories ORDER BY sort, id').all();
  return c.json({ data: rows });
});

// Tambah / ubah kategori (upsert by slug; slug tidak bisa diganti setelah dibuat).
// track_stock=1 berarti SEMUA produk kategori ini melacak stok (butuh konfirmasi di UI).
// slug opsional: kalau kosong, diturunkan otomatis dari name (huruf kecil + strip).
app.post('/api/categories', async (c) => {
  try {
    const body = await c.req.json();
    const name = String(body?.name ?? '').trim();
    const slug = String(body?.slug ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 32);
    if (!slug || !name) return c.json({ error: 'slug dan name wajib' }, 400);
    if (!/^[a-z0-9-]+$/.test(slug)) return c.json({ error: 'slug hanya huruf kecil, angka, strip' }, 400);
    const track = body?.track_stock ? 1 : 0;
    const sort = Number(body?.sort ?? 0) || 0;
    const existed = db.prepare('SELECT id FROM categories WHERE slug = ?').get(slug) as { id: number } | undefined;
    const row = db.prepare(
      `INSERT INTO categories (slug, name, track_stock, sort) VALUES (?, ?, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET name = excluded.name, track_stock = excluded.track_stock, sort = excluded.sort
       RETURNING *`,
    ).get(slug, name, track, sort);
    return c.json({ data: row }, existed ? 200 : 201);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'gagal simpan kategori' }, 400);
  }
});

// Hapus kategori — DITOLAK bila masih ada produk (FK categories<-products, foreign_keys=ON).
// Produk yang sudah punya riwayat jual tidak bisa dihapus, jadi kategori bekas pakai praktis permanen.
app.delete('/api/categories/:slug', (c) => {
  const slug = c.req.param('slug');
  const cat = db.prepare('SELECT id FROM categories WHERE slug = ?').get(slug) as { id: number } | undefined;
  if (!cat) return c.json({ error: 'kategori tidak ada' }, 404);
  const n = db.prepare('SELECT COUNT(*) AS n FROM products WHERE category_id = ?').get(cat.id) as { n: number };
  if (n.n > 0) return c.json({ error: `kategori dipakai ${n.n} produk — pindahkan/nonaktifkan produknya dulu` }, 400);
  db.prepare('DELETE FROM categories WHERE id = ?').run(cat.id);
  return c.json({ data: { slug } });
});

// ---------- Master satuan (dipakai form produk sebagai dropdown) ----------

// `dipakai` dihitung server-side (bukan dari cache client) supaya dialog hapus
// di halaman Satuan tidak pernah berbohong soal produk yang memakainya.
app.get('/api/units', (c) => {
  const rows = db
    .prepare(
      `SELECT u.*, (SELECT COUNT(*) FROM products p WHERE p.unit = u.slug) AS dipakai
       FROM units u ORDER BY u.name, u.id`,
    )
    .all();
  return c.json({ data: rows });
});

// Tambah / ubah satuan (upsert by slug; slug tidak bisa diganti setelah dibuat).
// Mirip kategori: slug opsional, kalau kosong diturunkan dari name.
app.post('/api/units', async (c) => {
  try {
    const body = await c.req.json();
    const name = String(body?.name ?? '').trim();
    const slug = String(body?.slug ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 32);
    if (!slug || !name) return c.json({ error: 'slug dan name wajib' }, 400);
    if (!/^[a-z0-9-]+$/.test(slug)) return c.json({ error: 'slug hanya huruf kecil, angka, strip' }, 400);
    const existed = db.prepare('SELECT id FROM units WHERE slug = ?').get(slug) as { id: number } | undefined;
    const row = db.prepare(
      `INSERT INTO units (slug, name) VALUES (?, ?)
       ON CONFLICT(slug) DO UPDATE SET name = excluded.name
       RETURNING *`,
    ).get(slug, name);
    return c.json({ data: row }, existed ? 200 : 201);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'gagal simpan satuan' }, 400);
  }
});

// Hapus satuan — DITOLAK bila masih dipakai produk (FK units<-products, foreign_keys=ON).
app.delete('/api/units/:slug', (c) => {
  const slug = c.req.param('slug');
  const u = db.prepare('SELECT id FROM units WHERE slug = ?').get(slug) as { id: number } | undefined;
  if (!u) return c.json({ error: 'satuan tidak ada' }, 404);
  const n = db.prepare('SELECT COUNT(*) AS n FROM products WHERE unit = ?').get(slug) as { n: number };
  if (n.n > 0) return c.json({ error: `satuan dipakai ${n.n} produk — pindahkan produknya dulu` }, 400);
  db.prepare('DELETE FROM units WHERE id = ?').run(u.id);
  return c.json({ data: { slug } });
});

// GET /api/products?since=<version>&category=<slug>&q=<teks>&status=<aktif|nonaktif|semua>
// since   -> sinkronisasi inkremental master (client simpan maxVersion lokal)
// status  -> default 'aktif' (WAJIB untuk kasir: produk nonaktif tak boleh muncul di POS).
//            'nonaktif' untuk layar Manage, 'semua' untuk audited. Row nonaktif TIDAK
//            boleh ikut delta sync (?since=) karena client aktif tidak menyimpannya.
app.get('/api/products', (c) => {
  const since = Number(c.req.query('since') ?? 0);
  const category = c.req.query('category');
  const q = (c.req.query('q') ?? '').trim();
  const status = c.req.query('status') ?? 'aktif';
  if (!['aktif', 'nonaktif', 'semua'].includes(status)) {
    return c.json({ error: `status tidak dikenal: ${status} (pakai aktif|nonaktif|semua)` }, 400);
  }
  const conds: string[] = [];
  const params: unknown[] = [];
  const isDelta = since > 0;
  // Mode delta sync (since>0) SELALU dibatasi ke produk aktif: cache kasir tidak
  // menyimpan produk nonaktif, jadi mengirimnya akan resurrect produk di POS.
  //
  // PENGECUALIAN (tombstone): baris deleted_at IS NOT NULL tetap DIKIRIM di mode
  // delta walau is_active-nya apa pun — tujuannya supaya client bisa MEMBUANG
  // produk yang dihapus di server. Tanpa ini tombstone tidak pernah terkirim dan
  // produk mati nempel selamanya di cache IndexedDB kasir. Pada mode biasa
  // (since=0) tombstone tetap DISIMPAN supaya daftar tidak menampilkan yang sudah
  // dihapus.
  if (isDelta) conds.push('(p.is_active = 1 OR p.deleted_at IS NOT NULL)');
  else {
    conds.push('p.deleted_at IS NULL');
    if (status === 'aktif') conds.push('p.is_active = 1');
    else if (status === 'nonaktif') conds.push('p.is_active = 0');
    // status 'semua' tanpa since -> tanpa filter status (dipakai layar Manage).
  }
  if (since > 0) { conds.push('p.version > ?'); params.push(since); }
  if (category) { conds.push('c.slug = ?'); params.push(category); }
  if (q) { conds.push('(p.name LIKE ? OR p.sku LIKE ? OR p.barcode = ?)'); params.push(`%${q}%`, `%${q}%`, q); }
  const rows = db.prepare(
    `SELECT p.*, c.slug AS category_slug, c.name AS category_name, c.track_stock
     FROM products p JOIN categories c ON c.id = p.category_id
     ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''}
     ORDER BY p.version ASC LIMIT 2000`,
  ).all(...params) as Record<string, unknown>[];
  // Satuan jual alternatif (fitur #3). Disaring dengan kondisi yang SAMA lewat
  // subquery supaya ?since= delta sync ikut menariknya: ubah satuan jual ->
  // products.version++ -> produk terkirim -> unit barisnya ikut terkirim.
  const unitRows = db.prepare(
    `SELECT pu.product_id, pu.unit, pu.factor, pu.price
       FROM product_units pu
      WHERE pu.product_id IN (
        SELECT p.id FROM products p JOIN categories c ON c.id = p.category_id
        ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''}
      )`,
  ).all(...params) as { product_id: number; unit: string; factor: number; price: number | null }[];
  const unitsPerProduct = new Map<number, { unit: string; factor: number; price: number | null }[]>();
  for (const r of unitRows) {
    const arr = unitsPerProduct.get(r.product_id) ?? [];
    arr.push({ unit: r.unit, factor: r.factor, price: r.price });
    unitsPerProduct.set(r.product_id, arr);
  }
  const data = rows.map((r) => ({ ...r, units: unitsPerProduct.get(Number(r.id)) ?? [] }));
  const maxVersion = db.prepare('SELECT COALESCE(MAX(version),0) AS v FROM products').get() as { v: number };
  return c.json({ data, maxVersion: maxVersion.v });
});

// Hapus produk (soft delete / tombstone).
//
// Guard 1 (aturan Aronium): produk yang PERNAH terjual tidak bisa dihapus —
// riwayat penjualan harus tetap utuh, jadi pakai nonaktifkan saja.
// Guard 2: tombstone, bukan DELETE keras — kolom deleted_at diisi + version++,
// supaya delta sync (?since=) membawanya ke kasir untuk dibuang dari cache.
// Baris sengaja TIDAK dihapus dari DB agar sale_items/stock_moves tetap valid
// secara referensial walau produknya sudah tidak bisa dijual lagi.
app.delete('/api/products/:id', (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'id tidak valid' }, 400);
  const p = db.prepare('SELECT id, sku, name, deleted_at FROM products WHERE id=?').get(id) as
    { id: number; sku: string; name: string; deleted_at: string | null } | undefined;
  if (!p || p.deleted_at) return c.json({ error: 'produk tidak ada' }, 404);
  const sold = (db.prepare('SELECT COUNT(*) AS c FROM sale_items WHERE product_id=?').get(id) as { c: number }).c;
  if (sold > 0) {
    return c.json({
      error: `produk ini sudah pernah terjual (${sold} baris penjualan) — riwayatnya harus utuh, jadi pakai nonaktifkan saja`,
    }, 400);
  }
  db.transaction(() => {
    db.prepare(
      `UPDATE products SET deleted_at=datetime('now'), updated_at=datetime('now'),
         version=(SELECT COALESCE(MAX(version),0)+1 FROM products)
       WHERE id=?`,
    ).run(id);
  })();
  return c.json({ data: { id: p.id, sku: p.sku, deleted: true } });
});

// SKU kosong -> diisi server dengan nomor urut `PRD00001`, `PRD00002`, ...
// (ala Aronium "default value based on max value"). Pola PRD + 5 digit dipilih
// karena pendek, urut alami walau diurutkan sebagai teks, dan tabrakan nol.
// SKU masih boleh diketik manual — fungsi ini hanya dipanggil saat kolom kosong.
//
// Nomor diambil dari MAX, bukan COUNT: baris produk yang pernah dihapus tetap
// ada di DB (tombstone — wajib, supaya sale_items/stock_moves tetap valid), jadi
// COUNT bisa menghasilkan nomor yang sudah pernah terpakai dan membingungkan
// label yang sudah tercetak. `SUBSTR(sku, 4) GLOB '[0-9]*'` mengecualikan SKU
// manual yang tidak berbentuk urut (mis. `PRD-FOO`), tapi tetap menghitung
// ekor panjang (`PRD100000`) sehingga MAX tidak mundur.
//
// WAJIB unik: SKU adalah kunci upsert, jadi SKU yang bentrok tidak sekadar
// gagal — ia akan menimpa produk lain.
function skuDariUrut(): string {
  const row = db
    .prepare(
      `SELECT MAX(CAST(SUBSTR(sku, 4) AS INTEGER)) AS n
         FROM products
        WHERE sku LIKE 'PRD%' AND SUBSTR(sku, 4) GLOB '[0-9]*'`,
    )
    .get() as { n: number | null };
  return `PRD${String((row?.n ?? 0) + 1).padStart(5, '0')}`;
}

// Satuan jual ALTERNATIF (fitur #3 Multi satuan).
//
// Satuan dasar IMPLISIT dari products.unit + products.price — sengaja bukan
// baris di sini, supaya produk lama (yang tidak pernah menyentuh fitur ini)
// tetap valid tanpa baris dummy, dan supaya payload lama tanpa field `units`
// tidak menghapus apa pun.
//
// Kontrak `units` di POST /api/products:
//   - `undefined` / tidak dikirim = TIDAK mengubah satuan jual (penting: payload
//     toggle is_active & tiap baris import tidak boleh menghapus satuan)
//   - `[]` (array kosong) = HAPUS semua satuan jual alternatif
//   - `[{unit,factor,price?}]` = ganti seluruh daftar (replace, bukan merge)
function simpanSatuanJual(productId: number, baseUnit: string, rows: unknown[]): void {
  if (!Array.isArray(rows)) throw new Error('units harus berupa array');
  const seen = new Set<string>();
  type Baris = { unit?: unknown; factor?: unknown; price?: unknown };
  const disiapkan: { unit: string; factor: number; price: number | null }[] = [];
  for (const raw of rows as Baris[]) {
    const unit = String(raw?.unit ?? '').trim();
    if (!unit) throw new Error('satuan jual: unit wajib diisi');
    if (unit === baseUnit) {
      throw new Error(`satuan dasar (${baseUnit}) tidak perlu diulang — satuan dasar selalu tersedia`);
    }
    if (seen.has(unit)) throw new Error(`satuan jual duplikat: ${unit}`);
    seen.add(unit);
    const factor = Number(raw?.factor);
    if (!Number.isFinite(factor) || factor <= 0) throw new Error(`satuan ${unit}: factor harus angka > 0`);
    const satu = db.prepare('SELECT 1 FROM units WHERE slug = ?').get(unit);
    if (!satu) throw new Error(`satuan tidak dikenal: ${unit} — buat dulu di halaman Satuan`);
    const pRaw = raw?.price;
    const price = pRaw === undefined || pRaw === null || pRaw === '' ? null : Number(pRaw);
    if (price !== null && (!Number.isFinite(price) || price < 0)) {
      throw new Error(`satuan ${unit}: price harus angka >= 0`);
    }
    disiapkan.push({ unit, factor, price });
  }
  // Ganti seluruh daftar. Baris yang menyamai satuan dasar ikut terbuang — dasar
  // baru bisa saja dulunya jadi baris alternatif (mis. dasar pcs -> pack, dan
  // sebelumnya ada baris pack).
  db.prepare('DELETE FROM product_units WHERE product_id = ?').run(productId);
  const ins = db.prepare('INSERT INTO product_units (product_id, unit, factor, price) VALUES (?, ?, ?, ?)');
  for (const b of disiapkan) ins.run(productId, b.unit, b.factor, b.price);
}

// Tambah / ubah master. Naikkan version agar client yang cache bisa sync via ?since=
const upsertProduct = db.transaction((input: {
  sku?: string; name: string; category_slug: string;
  barcode?: string | null; unit?: string; price?: number; cost?: number; markup?: number;
  price_dynamic?: number; stock?: number; min_stock?: number; is_active?: number;
  units?: unknown[];
}) => {
  const cat = db.prepare('SELECT id FROM categories WHERE slug = ?').get(input.category_slug) as { id: number } | undefined;
  if (!cat) throw new Error(`kategori tidak dikenal: ${input.category_slug}`);
  const sku = input.sku?.trim() || skuDariUrut();
  const unit = input.unit?.trim() || 'pcs';
  // Satuan harus ada di master (form produk pakai dropdown). Dicek di sini biar
  // jawabannya 400 yang jelas, bukan error FK mentah dari SQLite.
  const satu = db.prepare('SELECT id FROM units WHERE slug = ?').get(unit) as { id: number } | undefined;
  if (!satu) throw new Error(`satuan tidak dikenal: ${unit} — buat dulu di halaman Satuan`);
  const existing = db.prepare('SELECT id FROM products WHERE sku = ?').get(sku) as { id: number } | undefined;
  let pid: number;
  if (!existing) {
    const info = db.prepare(
      `INSERT INTO products (category_id, sku, barcode, name, unit, price, price_dynamic, cost, markup, stock, min_stock, is_active, updated_at, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'),
         COALESCE((SELECT MAX(version) FROM products), 0) + 1)`,
    ).run(cat.id, sku, input.barcode ?? null, input.name, unit,
      input.price ?? 0, input.price_dynamic ?? 0, input.cost ?? 0, input.markup ?? 0,
      input.stock ?? 0, input.min_stock ?? 0, input.is_active ?? 1);
    pid = Number(info.lastInsertRowid);
  } else {
    pid = existing.id;
    db.prepare(
      `UPDATE products SET category_id=?, barcode=?, name=?, unit=?, price=?, price_dynamic=?,
         cost=?, markup=?, stock=?, min_stock=?, is_active=?, updated_at=datetime('now'),
         version=(SELECT COALESCE(MAX(version),0)+1 FROM products)
       WHERE id=?`,
    ).run(cat.id, input.barcode ?? null, input.name, unit,
      input.price ?? 0, input.price_dynamic ?? 0, input.cost ?? 0, input.markup ?? 0,
      input.stock ?? 0, input.min_stock ?? 0, input.is_active ?? 1, pid);
  }
  // units === undefined -> biarkan apa adanya; array (termasuk []) -> ganti semua.
  if (input.units !== undefined) simpanSatuanJual(pid, unit, input.units);
  else db.prepare('DELETE FROM product_units WHERE product_id = ? AND unit = ?').run(pid, unit);
  return db.prepare('SELECT * FROM products WHERE sku = ?').get(sku);
});

app.post('/api/products', async (c) => {
  try {
    const body = await c.req.json();
    // sku tidak wajib: kosong berarti server yang menurunkan dari nama (unik).
    if (!body?.name || !body?.category_slug) {
      return c.json({ error: 'name dan category_slug wajib' }, 400);
    }
    const row = upsertProduct(body);
    return c.json({ data: row }, 201);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'gagal simpan produk' }, 400);
  }
});

// ---------- Import massal (CSV / tempelan Excel) ----------
// tiap baris di-upsert lewat upsertProduct YANG SAMA dengan POST /api/products:
// validasi kategori, cek satuan di master, dan turunan SKU tetap satu sumber
// kebenaran, bukan versi kedua yang bisa melenceng.
// `dry_run:true` = hitung hasil tanpa menyimpan: seluruh baris dijalankan dalam
// satu transaksi yang sengaja DIBATALKAN di akhir (rollback lempar error), jadi
// validasinya tetap kode yang sama persis seperti import sungguhan.
app.post('/api/products/import', async (c) => {
  try {
    const body = await c.req.json();
    const rows = Array.isArray(body?.rows) ? body.rows : null;
    if (!rows) return c.json({ error: 'rows wajib berupa array' }, 400);
    if (rows.length === 0) return c.json({ error: 'rows kosong' }, 400);
    if (rows.length > 1000) return c.json({ error: 'maksimal 1000 baris per import' }, 400);
    const dry = body?.dry_run === true;

    const rep = { total: rows.length, ok: 0, baru: 0, update: 0, gagal: 0,
      errors: [] as { baris: number; sku: string; error: string }[] };
    const skuDipakai = new Set<string>();
    const ROLLBACK = '__rollback_dry_run__';

    const kerjakan = () => {
      for (let i = 0; i < rows.length; i++) {
        const r = (rows[i] ?? {}) as Record<string, unknown>;
        const baris = i + 1;
        const sku = typeof r.sku === 'string' ? r.sku.trim() : '';
        // SKU eksplisit yang sama di dalam file yang sama = baris kedua akan
        // MENIMPA yang pertama tanpa disadari — tolak, jangan diam-diam overwrite.
        if (sku && skuDipakai.has(sku)) {
          rep.gagal++;
          rep.errors.push({ baris, sku, error: `SKU "${sku}" muncul lebih dari satu kali di file ini` });
          continue;
        }
        if (sku) skuDipakai.add(sku);
        if (!r.name || !String(r.name).trim()) {
          rep.gagal++; rep.errors.push({ baris, sku, error: 'name wajib diisi' }); continue;
        }
        if (!r.category_slug) {
          rep.gagal++; rep.errors.push({ baris, sku, error: 'category_slug wajib diisi' }); continue;
        }
        try {
          const existed = db.prepare('SELECT 1 FROM products WHERE sku = ?').get(
            sku || skuDariUrut(),
          );
          upsertProduct(r as never);
          rep.ok++;
          if (existed) rep.update++; else rep.baru++;
        } catch (e) {
          rep.gagal++;
          rep.errors.push({ baris, sku, error: e instanceof Error ? e.message : 'gagal simpan' });
        }
      }
      if (dry) throw new Error(ROLLBACK);
    };

    if (dry) {
      try { db.transaction(kerjakan)(); } catch (e) {
        if (!(e instanceof Error && e.message === ROLLBACK)) throw e;
      }
    } else {
      db.transaction(kerjakan)();
    }
    rep.errors = rep.errors.slice(0, 50);   // jangan kirim ribuan baris error
    return c.json({ data: rep });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'gagal import' }, 400);
  }
});

// Restock barang fisik (tidak untuk jasa/topup).
// `harga_beli` OPSIONAL — restock kadang dilakukan tanpa nota beli, dan kalau
// tidak dikirim rata-rata modal harus tetap seperti semula (bukan dianggap 0,
// yang akan membuat HPP jadi nol dan laba palsu). Bila diisi wajib angka >= 0;
// input kosong/huruf ditolak, bukan dianggap 0.
app.post('/api/restock', async (c) => {
  const body = await c.req.json();
  const qty = Number(body?.qty ?? 0);
  if (!body?.product_id || !(qty > 0)) return c.json({ error: 'product_id dan qty>0 wajib' }, 400);
  const raw = body?.harga_beli;
  const adaHarga = raw !== undefined && raw !== null && raw !== '';
  const harga = Number(raw);
  if (adaHarga && (!Number.isFinite(harga) || harga < 0)) {
    return c.json({ error: 'harga_beli harus angka >= 0' }, 400);
  }
  const p = db.prepare(
    `SELECT p.*, c.track_stock FROM products p JOIN categories c ON c.id=p.category_id WHERE p.id=?`,
  ).get(body.product_id) as { track_stock: number; stock: number; avg_cost: number } | undefined;
  if (!p) return c.json({ error: 'produk tidak ada' }, 404);
  if (!p.track_stock) return c.json({ error: 'produk ini tidak dilacak stoknya (jasa/topup/cetak)' }, 400);
  const tx = db.transaction(() => {
    // Modal rata-rata tertimbang. stok_lama diambil SEBELUM update — memakai
    // stok hasil penambahan akan menghitung barang lama seolah ikut terbeli
    // pada harga batch baru.
    const avgBaru = adaHarga
      ? Math.round((p.stock * p.avg_cost + qty * harga) / (p.stock + qty))
      : p.avg_cost;
    // version HARUS naik: perubahan stok tidak terlihat client bila version tetap,
    // karena sync master hanya menarik p.version > since.
    db.prepare(
      `UPDATE products SET stock = stock + ?, avg_cost = ?, updated_at=datetime('now'),
         version = (SELECT COALESCE(MAX(version),0) + 1 FROM products)
       WHERE id=?`,
    ).run(qty, avgBaru, body.product_id);
    // unit_cost = harga batch bila dikirim; kalau tidak, rata-rata yang berlaku.
    db.prepare(`INSERT INTO stock_moves (product_id, qty, reason, unit_cost, cashier) VALUES (?, ?, 'restock', ?, ?)`)
      .run(body.product_id, qty, adaHarga ? Math.round(harga) : p.avg_cost,
        body.cashier ?? process.env.CASHIER_DEFAULT ?? 'kasir');
  });
  tx();
  return c.json({ data: db.prepare('SELECT * FROM products WHERE id=?').get(body.product_id) });
});

// Stok opname: kasir MENGGANTI stok dengan hasil hitung fisik (bukan selisih).
// Bedanya dengan restock: restock menambah `qty` yang dikirim, opname menulis
// `qty_fisik` apa adanya — termasuk 0 (semua hilang/rusak).
// `stock_moves.qty` tetap disimpan sebagai SELISIH (fisik - tercatat) supaya
// riwayat mutasi tetap bermakna: + = kelebihan ditemukan, - = kekurangan.
// reason 'opname' memang sudah ada di skema sejak awal (schema.sql) — tidak ada
// kolom/tabel baru, jadi tidak perlu re-create database.
app.post('/api/stock-opname', async (c) => {
  const body = await c.req.json();
  const raw = body?.qty_fisik;
  const fisik = Number(raw);
  // Wajib angka dan >= 0. NaN sengaja ditolak: input kosong/huruf tidak boleh
  // dianggap 0, karena 0 berarti "semua barang hilang".
  if (!body?.product_id || raw === undefined || raw === '' || !Number.isFinite(fisik) || fisik < 0) {
    return c.json({ error: 'product_id dan qty_fisik (angka, boleh 0) wajib' }, 400);
  }
  const p = db.prepare(
    `SELECT p.stock, p.avg_cost, c.track_stock FROM products p JOIN categories c ON c.id=p.category_id WHERE p.id=?`,
  ).get(body.product_id) as { stock: number; avg_cost: number; track_stock: number } | undefined;
  if (!p) return c.json({ error: 'produk tidak ada' }, 404);
  if (!p.track_stock) return c.json({ error: 'produk ini tidak dilacak stoknya (jasa/topup/cetak)' }, 400);

  const selisih = fisik - p.stock;
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE products SET stock = ?, updated_at=datetime('now'),
         version = (SELECT COALESCE(MAX(version),0) + 1 FROM products)
       WHERE id=?`,
    ).run(fisik, body.product_id);
    // avg_cost TIDAK diubah opname: stok bertambah = barang tambahan yang tidak
    // punya harga beli (dibiarkan pada rata-rata lama), stok berkurang = nilai
    // ikut turun lewat `stock`. unit_cost tetap dicatat sebagai harga buku.
    db.prepare(`INSERT INTO stock_moves (product_id, qty, reason, unit_cost, cashier) VALUES (?, ?, 'opname', ?, ?)`)
      .run(body.product_id, selisih, p.avg_cost, body.cashier ?? process.env.CASHIER_DEFAULT ?? 'kasir');
  });
  tx();
  return c.json({ data: { product_id: body.product_id, sebelum: p.stock, sesudah: fisik, selisih } });
});

// ---------- shift ----------
// Satu shift terbuka per kasir (2 kasir boleh bersamaan, tiap device pakai nama kasir beda).
// Tanpa ?cashier= -> kembalikan shift terbuka terbaru (kompatibilitas).
app.get('/api/shifts/open', (c) => {
  const cashier = c.req.query('cashier');
  const row = cashier
    ? db.prepare(`SELECT * FROM shifts WHERE status='open' AND cashier=? LIMIT 1`).get(cashier)
    : db.prepare(`SELECT * FROM shifts WHERE status='open' ORDER BY id DESC LIMIT 1`).get();
  return c.json({ data: row ?? null });
});

app.post('/api/shifts/open', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const cashier = body?.cashier ?? process.env.CASHIER_DEFAULT ?? 'kasir';
  try {
    const info = db.prepare(
      `INSERT INTO shifts (modal_awal, cashier, status) VALUES (?, ?, 'open') RETURNING *`,
    ).get(Number(body?.modal_awal ?? 0), cashier);
    return c.json({ data: info }, 201);
  } catch {
    return c.json({ error: `kasir "${cashier}" masih punya shift terbuka, tutup dulu` }, 409);
  }
});

app.post('/api/shifts/:id/close', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const id = Number(c.req.param('id'));
  const info = db.prepare(
    `UPDATE shifts SET closed_at=datetime('now'), modal_akhir=?, status='closed'
     WHERE id=? AND status='open' RETURNING *`,
  ).get(Number(body?.modal_akhir ?? 0), id);
  if (!info) return c.json({ error: 'shift tidak ditemukan / sudah tutup' }, 404);
  return c.json({ data: info });
});

// ---------- penjualan ----------
// Body: { id?, shift_id, items: [{product_id?, name?, qty, price?, unit?}], pay_method, discount?, cash_in?, cashier? }
// - id uuid dari client: kirim ulang dengan id sama = tidak dobel (idempotent, penting untuk retry offline)
// - price boleh diisi client untuk produk price_dynamic (jasa/cetak/desain); server validasi stok & snapshot nama
// - unit = satuan jual TERPILIH (opsional, default = satuan dasar produk).
//   Server yang menentukan harga & faktor stoknya — harga produk non-dinamis
//   TIDAK boleh ditentukan dari client (lihat cabang `unitJual !== p.unit`).
const insertSale = db.transaction((sale: {
  id: string; shift_id: number | null; pay_method: string; discount: number;
  cash_in: number; cashier: string;
  items: { product_id?: number; name?: string; qty: number; price?: number; unit?: string }[];
}) => {
  const dup = db.prepare('SELECT * FROM sales WHERE id = ?').get(sale.id);
  if (dup) return { row: dup, duplicate: true };

  let subtotal = 0;
  const lines: { product_id: number | null; name: string; qty: number; price: number; amount: number; cost: number; unit: string }[] = [];
  for (const it of sale.items) {
    const qty = Number(it.qty);
    if (!(qty > 0)) throw new Error('qty harus > 0');
    let name = it.name ?? '';
    let price = Number(it.price ?? NaN);
    let pid: number | null = it.product_id ?? null;
    let unitJual = '';
    let cost = 0;
    if (pid) {
      const p = db.prepare(
        `SELECT p.*, c.track_stock FROM products p JOIN categories c ON c.id=p.category_id WHERE p.id=? AND p.is_active=1`,
      ).get(pid) as {
        id: number; name: string; unit: string; price: number; price_dynamic: number; stock: number;
        track_stock: number; avg_cost: number;
      } | undefined;
      if (!p) throw new Error(`produk #${pid} tidak aktif/tidak ada`);
      name = p.name;
      // Resolusi SATUAN & HARGA sepenuhnya di server. Client hanya mengirim
      // unit terpilih + (untuk produk dinamis) harga; harga produk non-dinamis
      // tidak boleh ditentukan dari client.
      const unitMinta = String(it.unit ?? '').trim();
      unitJual = unitMinta || p.unit;
      let factor = 1;
      if (unitJual !== p.unit) {
        const ru = db.prepare('SELECT factor, price FROM product_units WHERE product_id=? AND unit=?')
          .get(pid, unitJual) as { factor: number; price: number | null } | undefined;
        if (!ru) throw new Error(`satuan tidak dijual untuk ${p.name}: ${unitJual}`);
        factor = ru.factor;
        if (p.price_dynamic) {
          if (!(price >= 0)) throw new Error(`harga dinamis wajib diisi untuk ${p.name}`);
        } else {
          // price di baris satuan = harga grosir eksplisit; NULL = ikut rumus.
          price = ru.price ?? Math.round(p.price * factor);
        }
      } else if (p.price_dynamic) {
        if (!(price >= 0)) throw new Error(`harga dinamis wajib diisi untuk ${p.name}`);
      } else {
        price = p.price; // harga dikunci dari master, client tidak boleh mengubah
      }
      // HPP per SATUAN JUAL: stok dikeluarkan dalam satuan dasar (qty*factor),
      // jadi HPP baris juga harus dikalikan faktor yang sama.
      cost = Math.round(p.avg_cost * factor);
      const keluar = qty * factor;
      if (p.track_stock) {
        if (p.stock < keluar) {
          const butuh = Number.isInteger(keluar) ? keluar : Math.round(keluar * 1000) / 1000;
          throw new Error(`stok kurang: ${p.name} (butuh ${butuh} ${unitJual}, sisa ${p.stock})`);
        }
        db.prepare(
          `UPDATE products SET stock = stock - ?,
             version = (SELECT COALESCE(MAX(version),0) + 1 FROM products)
           WHERE id = ?`,
        ).run(keluar, pid);
        // stock_moves.qty selalu SATUAN DASAR (riwayat mutasi & opname tetap sebanding).
        db.prepare(`INSERT INTO stock_moves (product_id, qty, reason, ref_id, cashier) VALUES (?, ?, 'sale', ?, ?)`)
          .run(pid, -keluar, sale.id, sale.cashier);
      }
    } else {
      // item manual (misal jasa dadakan): nama + harga wajib
      if (!name || !(price >= 0)) throw new Error('item manual wajib ada name + price');
      unitJual = '';
    }
    const amount = Math.round(qty * price);
    subtotal += amount;
    // HPP disnapshot SEKARANG (avg_cost saat jual), bukan dibaca ulang saat
    // laporan di-query — rata-rata modal berubah tiap restock, kalau dibaca ulang
    // maka laba hari lalu ikut berubah setelah pembelian hari ini.
    // Item manual (pid=null) tidak punya persediaan -> HPP 0.
    lines.push({ product_id: pid, name, qty, price, amount, cost, unit: unitJual });
  }
  const total = subtotal - Math.max(0, sale.discount);
  if (total < 0) throw new Error('diskon melebihi subtotal');
  const change = Math.max(0, sale.cash_in - total);
  const row = db.prepare(
    `INSERT INTO sales (id, shift_id, pay_method, subtotal, discount, total, cash_in, change, cashier)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  ).get(sale.id, sale.shift_id, sale.pay_method, subtotal, Math.max(0, sale.discount), total, sale.cash_in, change, sale.cashier);
  const insItem = db.prepare(
    `INSERT INTO sale_items (sale_id, product_id, name, qty, price, amount, cost, unit)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const l of lines) insItem.run(sale.id, l.product_id, l.name, l.qty, l.price, l.amount, l.cost, l.unit);
  return { row, duplicate: false as const, lines };
});

app.post('/api/sales', async (c) => {
  try {
    const body = await c.req.json();
    if (!Array.isArray(body?.items) || body.items.length === 0) {
      return c.json({ error: 'items kosong' }, 400);
    }
    const { row, duplicate, lines } = insertSale({
      id: body.id ?? randomUUID(),
      shift_id: body.shift_id ?? null,
      pay_method: body.pay_method ?? 'tunai',
      discount: Number(body.discount ?? 0),
      cash_in: Number(body.cash_in ?? 0),
      cashier: body.cashier ?? process.env.CASHIER_DEFAULT ?? 'kasir',
      items: body.items,
    });
    const items = lines ?? db.prepare('SELECT * FROM sale_items WHERE sale_id=?').all((row as { id: string }).id);
    return c.json({ data: { sale: row, items, duplicate: duplicate ?? true } }, duplicate ? 200 : 201);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'gagal simpan penjualan' }, 400);
  }
});

app.get('/api/sales/:id', (c) => {
  const sale = db.prepare('SELECT * FROM sales WHERE id=?').get(c.req.param('id'));
  if (!sale) return c.json({ error: 'tidak ditemukan' }, 404);
  const items = db.prepare('SELECT * FROM sale_items WHERE sale_id=?').all(c.req.param('id'));
  return c.json({ data: { sale, items } });
});

// ---------- topup & tarik tunai ----------
app.post('/api/topups', async (c) => {
  try {
    const body = await c.req.json();
    const kind = body?.kind;
    if (!['topup', 'tarik'].includes(kind)) return c.json({ error: 'kind harus topup|tarik' }, 400);
    const nominal = Number(body?.nominal ?? 0);
    const admin = Number(body?.admin ?? 0);
    if (!(nominal > 0)) return c.json({ error: 'nominal harus > 0' }, 400);
    if (!(admin >= 0)) return c.json({ error: 'admin harus >= 0' }, 400);
    if (!body?.provider || !body?.nomor) return c.json({ error: 'provider dan nomor wajib' }, 400);
    const id = body.id ?? randomUUID();
    const dup = db.prepare('SELECT * FROM topup_txns WHERE id=?').get(id);
    if (dup) return c.json({ data: dup, duplicate: true });
    const total = nominal + admin; // yang dibayar pelanggan
    const row = db.prepare(
      `INSERT INTO topup_txns (id, shift_id, kind, provider, nomor, nominal, admin, total, pay_method, cashier)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    ).get(id, body.shift_id ?? null, kind, String(body.provider).toUpperCase(), String(body.nomor),
      nominal, admin, total, body.pay_method ?? 'tunai', body.cashier ?? process.env.CASHIER_DEFAULT ?? 'kasir');
    return c.json({ data: row }, 201);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'gagal simpan topup' }, 400);
  }
});

// Saran admin default (boleh diubah kasir per transaksi)
app.get('/api/topups/suggest-admin', (c) => {
  const nominal = Number(c.req.query('nominal') ?? 0);
  const admin = nominal <= 0 ? 0 : nominal < 50000 ? 3000 : nominal < 200000 ? 5000 : 7000;
  return c.json({ data: { nominal, admin } });
});

// ---------- laporan harian ----------
app.get('/api/reports/daily', (c) => {
  const date = c.req.query('date') ?? new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const sales = db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS omzet, COALESCE(SUM(discount),0) AS diskon
     FROM sales WHERE date(created_at)=date(?)`,
  ).get(date);
  const byMethod = db.prepare(
    `SELECT pay_method, COUNT(*) AS n, COALESCE(SUM(total),0) AS total
     FROM sales WHERE date(created_at)=date(?) GROUP BY pay_method`,
  ).all(date);
  const topup = db.prepare(
    `SELECT kind, COUNT(*) AS n, COALESCE(SUM(nominal),0) AS nominal, COALESCE(SUM(admin),0) AS admin
     FROM topup_txns WHERE date(created_at)=date(?) GROUP BY kind`,
  ).all(date);
  // Dikelompokkan per (name, unit) — tanpa `unit`, penjualan "2 pack" dan
  // "3 btl" produk sama jadi satu baris qty=5 campur satuan.
  const topItems = db.prepare(
    `SELECT si.name, si.unit, SUM(si.qty) AS qty, SUM(si.amount) AS amount
     FROM sale_items si JOIN sales s ON s.id=si.sale_id
     WHERE date(s.created_at)=date(?) GROUP BY si.name, si.unit ORDER BY amount DESC LIMIT 10`,
  ).all(date);
  const lowStock = db.prepare(
    `SELECT p.sku, p.name, p.stock, p.min_stock FROM products p
     JOIN categories c ON c.id=p.category_id
     WHERE c.track_stock=1 AND p.is_active=1 AND p.stock <= p.min_stock ORDER BY p.stock ASC LIMIT 20`,
  ).all();
  // HPP = jumlah qty*cost baris yang sudah di-snapshot saat jual (lihat insertSale).
  // Dibulatkan ke integer rupiah: qty REAL x cost INTEGER bisa pecahan.
  const hpp = Math.round((db.prepare(
    `SELECT COALESCE(SUM(si.qty * si.cost), 0) AS hpp
     FROM sale_items si JOIN sales s ON s.id = si.sale_id
     WHERE date(s.created_at) = date(?)`,
  ).get(date) as { hpp: number }).hpp);
  // laba = omzet SETELAH diskon - HPP. Jasa/cetak punya cost 0, jadi seluruh
  // penjualannya dihitung sebagai laba (tidak ada biaya persediaan yang dilacak).
  const laba = (sales as { omzet: number }).omzet - hpp;
  return c.json({ data: { date, sales, hpp, laba, byMethod, topup, topItems, lowStock } });
});

const port = Number(process.env.PORT ?? 3001);
const server = serve({ fetch: app.fetch, port });

// Tanpa handler ini, EADDRINUSE muncul sebagai "Unhandled 'error' event" + stack trace
// panjang yang menyesatkan (terdapat beberapa kali di repo ini).
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `\n[PORT ${port} SUDAH DIPAKAI PROSES LAIN]\n` +
        `  lihat pemakainya : ss -tlnp | grep :${port}\n` +
        `  matikan           : kill -9 <PID>\n` +
        `  atau port lain    : PORT=3002 npm run dev:api\n` +
        `  CATATAN: jangan Ctrl+Z (menyuspend -> proses yatim tetap memegang port). Pakai Ctrl+C.`,
    );
    process.exit(1);
  }
  throw err;
});

server.on('listening', () => {
  console.log(`ravaa-pos-api listening on :${port}  (db: ${process.env.DB_PATH ?? './data/data.db'})`);
  console.log(`cek: curl localhost:${port}/health`);
});
