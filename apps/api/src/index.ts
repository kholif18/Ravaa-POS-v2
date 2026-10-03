import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { db, dbPath, migrate } from './db.js';

migrate();

// Thumbnail foto produk disimpan di samping file DB (ikut DB_PATH, jadi Docker
// / install native / test dengan DB_PATH khusus tidak pernah saling menimpa).
// Dibuat lazy: jarang dipakai, dan folder yang kosong tidak mengganggu git.
const IMG_DIR = path.join(path.dirname(dbPath), 'img');
function imgDir(): string {
  fs.mkdirSync(IMG_DIR, { recursive: true });
  return IMG_DIR;
}

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
// use_expiry=1  berarti form produk kategori ini MENAMPILKAN "Tanggal kadaluarsa"
//   (lihat kolom `categories.use_expiry`) — ini yang menggantikan hardcode snack/eskrim.
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
    const cur = db.prepare('SELECT id, use_expiry FROM categories WHERE slug = ?').get(slug) as
      { id: number; use_expiry: number } | undefined;
    // `use_expiry` DIKECUALIKAN dari pola "tidak dikirim = reset": tidak dikirim
    // berarti TIDAK DIUBAH. Kalau direset seperti track_stock, skrip/upsert yang
    // hanya mengganti nama kategori akan diam-diam mematikan tanggal kadaluarsa
    // kategori — dan seluruh produknya mendadak kehilangan field itu di form.
    const useExpiry =
      body?.use_expiry === undefined ? (cur?.use_expiry ?? 0) : body.use_expiry ? 1 : 0;
    const row = db.prepare(
      `INSERT INTO categories (slug, name, track_stock, sort, use_expiry) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET name = excluded.name, track_stock = excluded.track_stock,
         sort = excluded.sort, use_expiry = excluded.use_expiry
       RETURNING *`,
    ).get(slug, name, track, sort, useExpiry);
    return c.json({ data: row }, cur ? 200 : 201);
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
//
// `opts.pertahankanTidakDikirim` dipasang SATU-SATUNYA oleh /api/products/import.
// Di sana berkas = daftar kolom, jadi kolom yang tidak ada berarti "jangan
// diubah" — BUKAN "setel ke default". Tanpa bendera ini, file CSV tanpa kolom
// Stok/Harga/Satuan akan diam-diam menyetel ulang produk yang sudah ada jadi 0
// / 'pcs' tanpa jejak stock_moves (diuji langsung: stok 7 -> 0, price 1000 -> 0).
// POST /api/products TETAP perilaku lamanya (field kosong -> default server)
// sesuai kontrak AGENTS.md §3, karena form & toggle aktif mengirim payload lenkap.
const upsertProduct = db.transaction((
  input: {
    sku?: string; name: string; category_slug: string;
    barcode?: string | null; unit?: string; price?: number; cost?: number; markup?: number;
    price_dynamic?: number; stock?: number; min_stock?: number; is_active?: number;
    units?: unknown[];
    image?: string | null; discount_type?: string; discount?: number; expiry_date?: string | null;
    use_note?: number;
  },
  opts?: { pertahankanTidakDikirim?: boolean },
) => {
  const cat = db.prepare('SELECT id FROM categories WHERE slug = ?').get(input.category_slug) as { id: number } | undefined;
  if (!cat) throw new Error(`kategori tidak dikenal: ${input.category_slug}`);
  const sku = input.sku?.trim() || skuDariUrut();
  const pertahankan = opts?.pertahankanTidakDikirim === true;
  // Baris lama dibaca lebih dulu: satuan ikut diambil dari sini, karena satuan
  // menentukan cek master dan nilai FK — kalau kolom Satuan absen, satuan
  // lama harus dipakai, bukan jatuh ke 'pcs'.
  const existing = db.prepare('SELECT * FROM products WHERE sku = ?').get(sku) as
    | ({ id: number } & Record<string, unknown>) | undefined;
  const lama = pertahankan ? existing : undefined;
  /** Kolom tidak dikirim + bendera pasang = nilai lama; baris baru tetap default. */
  const amb = <T>(baru: T | undefined, kunci: string, bawaan: T): T => {
    if (pertahankan && baru === undefined && lama && lama[kunci] !== undefined) {
      return lama[kunci] as T;
    }
    return baru ?? bawaan;
  };
  const unitRaw = input.unit?.trim();
  const unit = unitRaw || amb(undefined, 'unit', 'pcs');
  // Satuan harus ada di master (form produk pakai dropdown). Dicek di sini biar
  // jawabannya 400 yang jelas, bukan error FK mentah dari SQLite.
  const satu = db.prepare('SELECT id FROM units WHERE slug = ?').get(unit) as { id: number } | undefined;
  if (!satu) throw new Error(`satuan tidak dikenal: ${unit} — buat dulu di halaman Satuan`);
  const barcode = amb(input.barcode ?? undefined, 'barcode', null);
  const price = amb(input.price, 'price', 0);
  const priceDynamic = amb(input.price_dynamic, 'price_dynamic', 0);
  const cost = amb(input.cost, 'cost', 0);
  const markup = amb(input.markup, 'markup', 0);
  const stock = amb(input.stock, 'stock', 0);
  const minStock = amb(input.min_stock, 'min_stock', 0);
  const isActive = amb(input.is_active, 'is_active', 1);
  // Catatan per baris di POS (0/1) — pola sama dengan `use_expiry` kategori:
  // field biasa, jadi ikut aturan reset (tidak dikirim = kembali default 0)
  // dan wajib dibawa payloadToggleAktif/form.
  const useNote = amb(input.use_note, 'use_note', 0) ? 1 : 0;

  // ---- Foto: aturan KHUSUS, bukan pakai `amb` ----
  // `undefined` = tidak diubah di SEMUA mode (bukan cuma impor). Kalau pakai
  // amb(), payload toggle aktif & tiap baris CSV yang tidak membawa foto akan
  // jatuh ke default '' dan MENGHAPUS FOTO diam-diam — persis kecelakaan yang
  // pernah terjadi pada `units`.
  // File-nya sendiri ditulis oleh POST /api/products/:id/image; endpoint ini
  // hanya menerima nama filenya (dipakai impor & payload yang membawa referensi).
  let image: string | null;
  if (input.image === undefined) image = (existing?.image as string | null) ?? null;
  else if (input.image === null || String(input.image).trim() === '') image = null;
  else {
    const nama = String(input.image).trim();
    // Tanpa slash & tanpa '..': nilai kolom ini nanti dipakai sebagai nama file,
    // jadi `../..` akan membuka jalan path traversal dari payload client.
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(nama) || nama.includes('..')) {
      throw new Error('image: nama file tidak valid');
    }
    image = nama;
  }

  const discountType = String(amb(input.discount_type, 'discount_type', 'rp'));
  if (discountType !== 'rp' && discountType !== 'pct') {
    throw new Error("discount_type harus 'rp' atau 'pct'");
  }
  const discount = Number(amb(input.discount, 'discount', 0));
  if (!Number.isFinite(discount) || discount < 0) throw new Error('discount harus angka >= 0');
  if (discountType === 'pct' && discount > 100) throw new Error('discount persen maksimal 100');

  const expiryRaw = amb<string | null | undefined>(input.expiry_date, 'expiry_date', null);
  const expiry = expiryRaw === null || expiryRaw === undefined || String(expiryRaw).trim() === ''
    ? null
    : String(expiryRaw).trim();
  if (expiry !== null) {
    // `Date.parse` TIDAK menolak `2026-02-31` — ia ROLLOVER jadi 3 Maret, jadi
    // pola regex saja meloloskan tanggal yang tidak ada di kalender. Dibolak-
    // balikkan lewat `toISOString()`: tanggal fiktif bentuknya berbeda setelah
    // dinormalkan. Klien menolaknya lebih dulu (importcsv.parseTanggal), tapi
    // endpoint ini juga dipakai import & payload lain yang bisa datang dari
    // tempelan Excel — validasinya harus sama ketatnya di dua sisi.
    const t = new Date(`${expiry}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)
      || Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== expiry) {
      throw new Error('expiry_date harus tanggal YYYY-MM-DD yang valid');
    }
  }

  let pid: number;
  if (!existing) {
    const info = db.prepare(
      `INSERT INTO products (category_id, sku, barcode, name, unit, price, price_dynamic, cost, markup, stock, min_stock,
                             image, discount_type, discount, expiry_date, use_note, is_active, updated_at, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'),
         COALESCE((SELECT MAX(version) FROM products), 0) + 1)`,
    ).run(cat.id, sku, barcode, input.name, unit,
      price, priceDynamic, cost, markup, stock, minStock,
      image, discountType, discount, expiry, useNote, isActive);
    pid = Number(info.lastInsertRowid);
  } else {
    pid = existing.id;
    // deleted_at IKUT di-set NULL di sini: pencarian `existing` (baris 310) tidak
    // memfilter tombstone, jadi baris yang pernah dihapus ketemu dan masuk cabang
    // UPDATE ini. Kalau kolomnya tidak dikosongkan, POST ulang SKU yang sudah
    // dihapus membalas 201 OK tapi produknya tetap MAYAT — tak pernah muncul di
    // `status=aktif|semua` (line ~150) dan tetap terkirim sbg `deleted_at` terisi
    // lewat `?since=` (line ~148), sehingga client justru MEMBUANGNYA dari cache.
    // Konsisten dengan semangat upsert by SKU: menyebut SKU yang sama berarti
    // "produk ini ada (lagi)". version tetap naik supaya delta sync membangkitkan
    // barisnya kembali di semua device (dipertegas di tests bagian E).
    db.prepare(
      `UPDATE products SET category_id=?, barcode=?, name=?, unit=?, price=?, price_dynamic=?,
         cost=?, markup=?, stock=?, min_stock=?, image=?, discount_type=?, discount=?, expiry_date=?,
         use_note=?, is_active=?, deleted_at=NULL,
         updated_at=datetime('now'),
         version=(SELECT COALESCE(MAX(version),0)+1 FROM products)
       WHERE id=?`,
    ).run(cat.id, barcode, input.name, unit,
      price, priceDynamic, cost, markup, stock, minStock,
      image, discountType, discount, expiry, useNote, isActive, pid);
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

// ---------- Foto produk: file di disk, DB hanya menyimpan NAMANYA ----------
// Kenapa bukan base64 di kolom: stok saja sudah menaikkan `version`, jadi foto
// yang menempel di baris produk ikut ditarik ulang oleh ?since= tiap penjualan
// /restock. Dengan file terpisah, delta sync cuma membawa nama file, dan isi
// gambar diunduh sekali lalu di-cache client (tampil offline setelah itu).
const IMG_MIME: Record<string, string> = { jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const IMG_EXT: Record<string, string> = { jpeg: 'jpg', jpg: 'jpg', png: 'png', webp: 'webp' };
// Thumbnail 512px hasil resize client ~10-20KB. 300KB masih longgar, tapi
// menahan kasir yang menempel foto asli HP (2-4MB) apa adanya.
const IMG_MAKS_BYTE = 300_000;

function buangFileFoto(nama: string): void {
  const aman = path.basename(nama); // jaring pengaman: nilai kolom tidak boleh keluar dari img/
  try { fs.rmSync(path.join(imgDir(), aman), { force: true }); } catch { /* file mungkin tak ada */ }
}

app.post('/api/products/:id/image', async (c) => {
  try {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'id tidak valid' }, 400);
    const p = db.prepare('SELECT id, image FROM products WHERE id=? AND deleted_at IS NULL').get(id) as
      { id: number; image: string | null } | undefined;
    if (!p) return c.json({ error: 'produk tidak ada' }, 404);

    let body: { image?: unknown };
    try { body = await c.req.json(); } catch { return c.json({ error: 'body harus JSON' }, 400); }
    const kiriman = body?.image;
    // Tanpa kunci `image` sama sekali = 400, bukan dianggap hapus: menghapus
    // foto karena payload yang tidak lengkap terlalu mahal harganya.
    if (kiriman === undefined) return c.json({ error: 'image wajib diisi ("" untuk menghapus foto)' }, 400);

    const tulis = db.transaction((nama: string | null, lama: string | null) => {
      if (lama) buangFileFoto(lama);
      db.prepare(
        `UPDATE products SET image=?, updated_at=datetime('now'),
           version=(SELECT COALESCE(MAX(version),0)+1 FROM products)
         WHERE id=?`,
      ).run(nama, id);
    });

    if (kiriman === null || String(kiriman).trim() === '') {
      tulis(null, p.image);
      return c.json({ data: { image: null } });
    }

    const val = String(kiriman).trim();
    const m = /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=\s]+)$/i.exec(val);
    if (!m) return c.json({ error: 'image harus data URL base64 (data:image/jpeg;base64,...)' }, 400);
    const ext = IMG_EXT[m[1].toLowerCase()];
    if (!ext) return c.json({ error: `format gambar tidak didukung: ${m[1]}` }, 400);
    const buf = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
    if (!buf.length) return c.json({ error: 'gambar kosong' }, 400);
    if (buf.length > IMG_MAKS_BYTE) {
      return c.json({
        error: `thumbnail terlalu besar (${buf.length} byte, maks ${IMG_MAKS_BYTE}) — resize dulu di client`,
      }, 400);
    }

    const nama = `${id}.${ext}`;
    fs.writeFileSync(path.join(imgDir(), nama), buf);
    // File lama dengan ekstensi berbeda ikut dibuang (png -> jpg meninggalkan
    // barang bukti yang tidak pernah dibaca siapa pun).
    for (const e of new Set(Object.values(IMG_EXT))) {
      if (e !== ext) buangFileFoto(`${id}.${e}`);
    }
    tulis(nama, p.image && p.image !== nama ? p.image : null);
    return c.json({ data: { image: nama } });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'gagal simpan foto' }, 400);
  }
});

app.get('/api/products/:id/image', (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'id tidak valid' }, 400);
  const p = db.prepare('SELECT image, updated_at FROM products WHERE id=?').get(id) as
    { image: string | null; updated_at: string } | undefined;
  if (!p?.image) return c.json({ error: 'foto tidak ada' }, 404);
  const file = path.join(imgDir(), path.basename(p.image));
  if (!fs.existsSync(file)) return c.json({ error: 'file foto hilang' }, 404);
  const etag = `"${p.updated_at}"`;
  if (c.req.header('if-none-match') === etag) return c.body(null, 304);
  const buf = fs.readFileSync(file);
  return c.body(new Uint8Array(buf), 200, {
    'Content-Type': IMG_MIME[path.extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream',
    'ETag': etag,
    // Revalidasi murah (ETag sudah dikirim) dan tidak menyimpan lama di cache —
    // kunci tampilan offline justru di IndexedDB client, bukan di cache browser.
    'Cache-Control': 'no-cache',
  });
});

// ---------- Import massal (CSV / tempelan Excel) ----------
// tiap baris di-upsert lewat upsertProduct YANG SAMA dengan POST /api/products:
// validasi kategori, cek satuan di master, dan turunan SKU tetap satu sumber
// kebenaran, bukan versi kedua yang bisa melenceng.
// SATU-SATUNYA bedanya: bendera `pertahankanTidakDikirim` — di impor, kolom yang
// tidak ada di berkas berarti "biarkan", bukan "setel ke 0".
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
          // pertahankanTidakDikirim: kolom yang tidak ada di berkas = jangan
          // diubah. Lihat komentar upsertProduct — tanpa ini file tanpa kolom
          // Stok/Harga menyetel produk lama jadi 0 diam-diam.
          upsertProduct(r as never, { pertahankanTidakDikirim: true });
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

// ---------- Riwayat stok / product history ----------
// Baris `stock_moves` sudah ditulis sejak awal oleh sale/restock/opname —
// endpoint ini hanya MEMBUKANYannya ke halaman Stok. Read-only: tidak menyentuh
// products.version, jadi tidak ikut delta sync (dan memang tidak perlu — riwayat
// bukan master yang di-cache client; diambil saat dialog dibuka).
app.get('/api/stock-moves', (c) => {
  const pid = Number(c.req.query('product_id'));
  if (!Number.isInteger(pid) || pid <= 0) {
    return c.json({ error: 'product_id wajib (riwayat selalu milik satu produk)' }, 400);
  }
  const reason = (c.req.query('reason') ?? '').trim();
  if (reason && !['sale', 'restock', 'opname', 'rusak'].includes(reason)) {
    return c.json({ error: `reason tidak dikenal: ${reason} (pakai sale|restock|opname|rusak)` }, 400);
  }
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50) || 50, 1), 200);
  const offset = Math.max(Number(c.req.query('offset') ?? 0) || 0, 0);
  const conds = ['sm.product_id = ?'];
  const params: unknown[] = [pid];
  if (reason) { conds.push('sm.reason = ?'); params.push(reason); }
  const where = `WHERE ${conds.join(' AND ')}`;
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM stock_moves sm ${where}`).get(...params) as { n: number }).n;
  const data = db.prepare(
    `SELECT sm.id, sm.created_at, sm.product_id, p.sku, p.name, sm.qty, sm.reason,
            sm.ref_id, sm.unit_cost, sm.cashier
       FROM stock_moves sm JOIN products p ON p.id = sm.product_id
       ${where}
      ORDER BY sm.created_at DESC, sm.id DESC
      LIMIT ? OFFSET ?`,
  ).all(...params, limit, offset);
  return c.json({ data, total });
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

// Riwayat shift (menu "Shift Kasir"): daftar + agregat penjualan/topup per
// shift lewat subquery — satu kali baca, bukan N+1. Agregat berasal dari baris
// yang memang terikat `shift_id` (penjualan offline yang masuk lewat outbox
// ikut terhitung setelah tersimpan, karena ikut membawa shift_id).
app.get('/api/shifts', (c) => {
  const status = c.req.query('status') ?? 'semua';
  if (!['semua', 'open', 'closed'].includes(status)) {
    return c.json({ error: 'status harus open|closed|semua' }, 400);
  }
  const cashier = c.req.query('cashier');
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50) || 50, 1), 200);
  const offset = Math.max(Number(c.req.query('offset') ?? 0) || 0, 0);
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (status !== 'semua') { where.push(`s.status=?`); params.push(status); }
  if (cashier) { where.push(`s.cashier=?`); params.push(cashier); }
  const klausul = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM shifts s ${klausul}`)
    .get(...params) as { n: number }).n;
  const data = db.prepare(
    `SELECT s.*,
            (SELECT COUNT(*) FROM sales sl WHERE sl.shift_id = s.id) AS n_sales,
            (SELECT COALESCE(SUM(sl.total),0) FROM sales sl WHERE sl.shift_id = s.id) AS omzet,
            (SELECT COALESCE(SUM(sl.total),0) FROM sales sl
              WHERE sl.shift_id = s.id AND sl.pay_method='tunai') AS tunai,
            -- Rincian per metode (keputusan pemilik 2026-10-01: QRIS/transfer
            -- TETAP masuk hitungan laci, wajib tercatat sumbernya) — selain
            -- tunai di atas, supaya dialog tutup shift bisa menampilkan
            -- "per sumber" tanpa menghitung ulang di klien.
            (SELECT COALESCE(SUM(sl.total),0) FROM sales sl
              WHERE sl.shift_id = s.id AND sl.pay_method='qris') AS qris,
            (SELECT COALESCE(SUM(sl.total),0) FROM sales sl
              WHERE sl.shift_id = s.id AND sl.pay_method='transfer') AS transfer,
            (SELECT COUNT(*) FROM topup_txns t WHERE t.shift_id = s.id) AS n_topup,
            -- Gerak kas topup/tarik TERPISAH per kolom & per angka (keputusan
            -- pemilik 2026-10-01): topup = tunai pelanggan -> laci NAIK
            -- (nominal + admin, keduanya dihitung tapi dilaporkan terpisah);
            -- tarik = JANGAN mengurangi laci (cukup dicatat) jadi tidak pernah
            -- masuk rumus expected-cash di klien.
            (SELECT COALESCE(SUM(t.nominal),0) FROM topup_txns t
              WHERE t.shift_id = s.id AND t.kind='topup') AS topup_nominal,
            (SELECT COALESCE(SUM(t.admin),0) FROM topup_txns t
              WHERE t.shift_id = s.id AND t.kind='topup') AS topup_admin,
            (SELECT COALESCE(SUM(t.nominal),0) FROM topup_txns t
              WHERE t.shift_id = s.id AND t.kind='tarik') AS tarik_nominal,
            (SELECT COALESCE(SUM(t.admin),0) FROM topup_txns t
              WHERE t.shift_id = s.id AND t.kind='tarik') AS tarik_admin
       FROM shifts s
       ${klausul}
      ORDER BY s.id DESC
      LIMIT ? OFFSET ?`,
  ).all(...params, limit, offset);
  return c.json({ data, total });
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
  items: { product_id?: number; name?: string; qty: number; price?: number; unit?: string; discount?: number; note?: string }[];
}) => {
  const dup = db.prepare('SELECT * FROM sales WHERE id = ?').get(sale.id);
  if (dup) return { row: dup, duplicate: true };

  // Dibaca sekali per penjualan, langsung dari DB: aturan stok tidak boleh
  // berdasarkan cache client, karena client bisa offline dan berbeda pendapat
  // dengan server tentang boleh-tidaknya stok minus. Aturan kadaluarsa dibaca
  // dengan cara yang sama.
  const bolehMinus = settingBool(K_STOK_MINUS, false);
  const tolakKadaluarsa = settingBool(K_TOLAK_KADALUARSA, false);
  // Satu aturan hari UTC (sama dengan history/reports/dashboard): hari
  // kadaluarsa = expiry_date yang sama dengan hari ini MASIH sah, hanya
  // tanggal yang sudah lewat yang ditolak.
  const hariIniUtc = new Date().toISOString().slice(0, 10);

  let subtotal = 0;
  let totalDiscBaris = 0;
  const lines: { product_id: number | null; name: string; qty: number; price: number; amount: number; discount: number; cost: number; unit: string; note: string }[] = [];
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
        track_stock: number; avg_cost: number; expiry_date: string | null;
      } | undefined;
      if (!p) throw new Error(`produk #${pid} tidak aktif/tidak ada`);
      name = p.name;
      // Tolak jual kadaluarsa (pengaturan, default MATI): pantau per baris,
      // bukan per transaksi — satu keranjang campuran (snack basi + minuman
      // segar) tetap ditolak seluruhnya dengan nama barang yang jelas. Item
      // manual (pid=null) tidak punya tanggal, jadi tidak kena cek ini.
      if (tolakKadaluarsa && p.expiry_date && p.expiry_date < hariIniUtc) {
        throw new Error(`barang kadaluarsa: ${p.name} (berakhir ${p.expiry_date})`);
      }
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
        // SATU-SATUNYA pintu "stok kurang" ada di sini. Dilewati bila pengaturan
        // allow_negative_stock aktif: stok dibiarkan menembus 0 (minus) supaya
        // transaksi di meja kasir tidak macet karena selisih hitungan fisik.
        // stock_moves tetap dicatat minus, jadi riwayat tetap jujur.
        if (!bolehMinus && p.stock < keluar) {
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
    // Diskon PER BARIS: rupiah mutlak (konversi % -> Rp dilakukan client, server
    // tidak perlu tipe). Dibatasi <= jumlah baris supaya tidak bisa membuat
    // total negatif lewat jalan belakang — batas total masih dicek satu kali lagi
    // di bawah untuk kasus diskon transaksi.
    const discMentah = Number(it.discount ?? 0);
    if (!Number.isFinite(discMentah) || discMentah < 0) {
      throw new Error(`diskon baris tidak valid untuk ${name} (harus angka >= 0)`);
    }
    const discBaris = Math.round(discMentah);
    if (discBaris > amount) {
      throw new Error(`diskon baris melebihi jumlah baris: ${name} (${discBaris} > ${amount})`);
    }
    // Catatan per baris (POS: input di bawah baris produk use_note=1).
    // Di-snapshot seperti discount — riwayat & struk ulang tidak ikut berubah.
    // Server TIDAK mengecek flag use_note produk: inputnya memang hanya dirender
    // untuk produk yang menyala, tapi payload sah untuk item apa pun (item
    // manual / outbox lama) tidak boleh ditolak karena alasan kosmetik.
    const note = String(it.note ?? '').trim();
    if (note.length > 200) {
      throw new Error(`catatan baris terlalu panjang: ${name} (maks 200 karakter)`);
    }
    subtotal += amount;
    totalDiscBaris += discBaris;
    // HPP disnapshot SEKARANG (avg_cost saat jual), bukan dibaca ulang saat
    // laporan di-query — rata-rata modal berubah tiap restock, kalau dibaca ulang
    // maka laba hari lalu ikut berubah setelah pembelian hari ini.
    // Item manual (pid=null) tidak punya persediaan -> HPP 0.
    lines.push({ product_id: pid, name, qty, price, amount, discount: discBaris, cost, unit: unitJual, note });
  }
  // Nilai BERSIH = kotor - diskon baris - diskon transaksi. `subtotal` yang
  // disimpan ke sales tetap kotor, supaya subtotal - total = seluruh diskon.
  const total = subtotal - totalDiscBaris - Math.max(0, sale.discount);
  if (total < 0) throw new Error('diskon melebihi subtotal');
  const change = Math.max(0, sale.cash_in - total);
  const row = db.prepare(
    `INSERT INTO sales (id, shift_id, pay_method, subtotal, discount, total, cash_in, change, cashier)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  ).get(sale.id, sale.shift_id, sale.pay_method, subtotal, Math.max(0, sale.discount), total, sale.cash_in, change, sale.cashier);
  const insItem = db.prepare(
    `INSERT INTO sale_items (sale_id, product_id, name, qty, price, amount, discount, cost, unit, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const l of lines) {
    insItem.run(sale.id, l.product_id, l.name, l.qty, l.price, l.amount, l.discount, l.cost, l.unit, l.note);
  }
  return { row, duplicate: false as const, lines };
});

app.post('/api/sales', async (c) => {
  try {
    const body = await c.req.json();
    if (!Array.isArray(body?.items) || body.items.length === 0) {
      return c.json({ error: 'items kosong' }, 400);
    }
    // Divalidasi di sini, bukan di dalam transaksi: `Number('abc')` = NaN, dan
    // NaN lolos cek `total < 0` — penjualan akan tersimpan dengan total NaN.
    const discTransaksi = Number(body.discount ?? 0);
    if (!Number.isFinite(discTransaksi) || discTransaksi < 0) {
      return c.json({ error: 'discount harus angka >= 0' }, 400);
    }
    const { row, duplicate, lines } = insertSale({
      id: body.id ?? randomUUID(),
      shift_id: body.shift_id ?? null,
      pay_method: body.pay_method ?? 'tunai',
      discount: discTransaksi,
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

// ---------- riwayat transaksi (menu "Riwayat transaksi") ----------
// Filter hari memakai `date(created_at) = date(?)` yang SAMA dengan
// /api/reports/daily, dan defaultnya juga hari UTC yang sama
// (`new Date().toISOString().slice(0,10)`), supaya jumlah baris di halaman
// Riwayat dan angka `sales.n` di Laporan tidak mungkin berbeda.
const RE_TGL = /^\d{4}-\d{2}-\d{2}$/;

type Hari = { ok: true; hari: string; limit: number; offset: number } | { ok: false; error: string };

function bacaHari(query: (k: string) => string | undefined): Hari {
  const hari = query('date') ?? new Date().toISOString().slice(0, 10);
  // Tanggal rusak harus 400, bukan diam-diam: `date('rabu')` = NULL di SQLite
  // dan `date('2026-02-31')` ikut NULL — hasilnya halaman kosong yang seolah
  // hari itu memang tidak ada transaksi. Round-trip memakai pola yang sama
  // dengan validasi `expiry_date` (lihat POST /api/products).
  const d = new Date(`${hari}T00:00:00Z`);
  if (!RE_TGL.test(hari) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== hari) {
    return { ok: false, error: 'date harus format YYYY-MM-DD' };
  }
  const limit = Math.min(Math.max(Number(query('limit') ?? 50) || 50, 1), 200);
  const offset = Math.max(Number(query('offset') ?? 0) || 0, 0);
  return { ok: true, hari, limit, offset };
}

app.get('/api/sales', (c) => {
  const h = bacaHari((k) => c.req.query(k));
  if (!h.ok) return c.json({ error: h.error }, 400);
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM sales WHERE date(created_at)=date(?)`)
    .get(h.hari) as { n: number }).n;
  // `n_items` dihitung per baris lewat subquery: daftar riwayat hanya perlu
  // TAHU jumlah item ("3 item") — isi barisnya diambil saat dibuka lewat
  // GET /api/sales/:id, jadi satu hari ratusan nota tidak ditarik sekaligus.
  const data = db.prepare(
    `SELECT s.*, (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id) AS n_items
       FROM sales s
      WHERE date(s.created_at)=date(?)
      ORDER BY s.created_at DESC, s.rowid DESC
      LIMIT ? OFFSET ?`,
  ).all(h.hari, h.limit, h.offset);
  return c.json({ data, total });
});

app.get('/api/sales/:id', (c) => {
  const sale = db.prepare('SELECT * FROM sales WHERE id=?').get(c.req.param('id'));
  if (!sale) return c.json({ error: 'tidak ditemukan' }, 404);
  // base_unit (LEFT JOIN products) ditambahkan 2026-10-01 untuk CETAK ULANG
  // struk dari halaman Riwayat: struk asli hanya mencetak `unit` bila satuan
  // jualnya BUKAN satuan dasar, dan sale_items hanya menyimpan satuan jual —
  // tanpa satuan dasar saat ini, riwayat tidak bisa memutuskan sama persis
  // seperti yang dilakukan POS. Produk terhapus pun tetap ikut (LEFT JOIN).
  const items = db.prepare(
    `SELECT si.*, p.unit AS base_unit
       FROM sale_items si LEFT JOIN products p ON p.id = si.product_id
      WHERE si.sale_id=?`,
  ).all(c.req.param('id'));
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

// Riwayat topup/tarik — aturan hari & halaman yang sama dengan GET /api/sales
// di atas (lihat bacaHari), supaya keduanya digabung jadi satu linimasa tanpa
// tanggal yang saling bertengkar.
app.get('/api/topups', (c) => {
  const h = bacaHari((k) => c.req.query(k));
  if (!h.ok) return c.json({ error: h.error }, 400);
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM topup_txns WHERE date(created_at)=date(?)`)
    .get(h.hari) as { n: number }).n;
  const data = db.prepare(
    `SELECT * FROM topup_txns
      WHERE date(created_at)=date(?)
      ORDER BY created_at DESC, rowid DESC
      LIMIT ? OFFSET ?`,
  ).all(h.hari, h.limit, h.offset);
  return c.json({ data, total });
});

// Saran admin default (boleh diubah kasir per transaksi)
app.get('/api/topups/suggest-admin', (c) => {
  const nominal = Number(c.req.query('nominal') ?? 0);
  const admin = nominal <= 0 ? 0 : nominal < 50000 ? 3000 : nominal < 200000 ? 5000 : 7000;
  return c.json({ data: { nominal, admin } });
});

// ---------- Pengaturan toko ----------
// Tabel key/value supaya menambah opsi baru tidak butuh migrasi kolom.
// Nilai disimpan sebagai teks '0'/'1' — angka boolean dilewatkan lewat JSON
// sebagai boolean betulan, karena menebak '1'/true/'ya' dari client adalah
// cara pasti membuat dua device memahami aturan yang berbeda.
const K_STOK_MINUS = 'allow_negative_stock';
const K_TOLAK_KADALUARSA = 'tolak_jual_kadaluarsa';

function settingBool(key: string, bawaan: boolean): boolean {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? row.value === '1' : bawaan;
}

app.get('/api/settings', (c) => c.json({ data: {
  allow_negative_stock: settingBool(K_STOK_MINUS, false),
  tolak_jual_kadaluarsa: settingBool(K_TOLAK_KADALUARSA, false),
} }));

// Kedua kunci OPSIONAL: yang tidak dikirim TIDAK diubah (update parsial),
// minimal satu wajib ada. Angka 0/1, "ya", null tetap ditolak — client harus
// mengirim boolean sungguhan untuk setiap kirimannya.
app.post('/api/settings', async (c) => {
  try {
    const body = await c.req.json();
    const vMinus = body?.allow_negative_stock;
    const vKadaluarsa = body?.tolak_jual_kadaluarsa;
    if (vMinus !== undefined && typeof vMinus !== 'boolean') {
      return c.json({ error: 'allow_negative_stock harus boolean (true|false)' }, 400);
    }
    if (vKadaluarsa !== undefined && typeof vKadaluarsa !== 'boolean') {
      return c.json({ error: 'tolak_jual_kadaluarsa harus boolean (true|false)' }, 400);
    }
    if (vMinus === undefined && vKadaluarsa === undefined) {
      return c.json({ error: 'tidak ada pengaturan yang dikirim (allow_negative_stock / tolak_jual_kadaluarsa)' }, 400);
    }
    const simpan = db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
    if (vMinus !== undefined) simpan.run(K_STOK_MINUS, vMinus ? '1' : '0');
    if (vKadaluarsa !== undefined) simpan.run(K_TOLAK_KADALUARSA, vKadaluarsa ? '1' : '0');
    return c.json({ data: {
      allow_negative_stock: settingBool(K_STOK_MINUS, false),
      tolak_jual_kadaluarsa: settingBool(K_TOLAK_KADALUARSA, false),
    } });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'gagal simpan pengaturan' }, 400);
  }
});

// ---------- backup DB ----------
// Salin konsisten lewat online backup API better-sqlite3 (`db.backup()` —
// async, snapshot WAL-aman, boleh menimpa file yang sudah ada). File disimpan
// di `backups/` SEBELAH file DB (ikut DB_PATH — pola sama dengan folder img/),
// jadi Docker / install native / test DB_PATH khusus tidak saling menimpa.
const BACKUP_DIR = path.join(path.dirname(dbPath), 'backups');
const KEEP = 14; // retensi: simpan 14 file terbaru
// Nama: data-YYYY-MM-DD-HHMMSS.db (komponen UTC — satu aturan hari UTC dengan
// seluruh repo). Fixed-width -> urut leksikografis = urut kronologis.
const POLA_BACKUP = /^data-\d{4}-\d{2}-\d{2}-\d{6}\.db$/;
// Nama yang sedang/sudah dipilih proses ini (lihat buatBackup) — dua POST pada
// detik yang sama jangan berebut satu nama file dan saling menimpa.
const NAMA_BACKUP_TERPAKAI = new Set<string>();

function backupDir(): string {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  return BACKUP_DIR;
}

function daftarBackup(): { nama: string; ukuran: number; waktu: string }[] {
  const dir = backupDir();
  return fs.readdirSync(dir)
    .filter((n) => POLA_BACKUP.test(n))
    .sort().reverse() // terbaru dulu (leksikografis = kronologis utk format ini)
    .map((nama) => {
      const st = fs.statSync(path.join(dir, nama));
      const t = st.mtime.toISOString();
      return { nama, ukuran: st.size, waktu: t };
    });
}

// Buat satu backup + verifikasi + retensi. Hanya dipanggil dari jalankanBackup
// supaya aturan "backup yang rusak jangan disimpan" ada di SATU tempat.
async function buatBackup(): Promise<{ nama: string; ukuran: number; waktu: string }> {
  const dir = backupDir();
  // Nama = detik UTC saat dibuat. Dua backup pada detik YANG SAMA (klik ganda /
  // scheduler + klik manual) akan berebut satu nama dan yang kedua MENIMPA yang
  // pertama — padahal POST dijanjikan selalu membuat file BARU. Reservasi nama
  // sinkron (cek + catat sebelum await pertama): di satu proses Node tidak ada
  // jeda antar-langkah sinkron, jadi klien yang masuk beruntun tidak bisa lolos
  // cek yang sama. Kalau nama sudah terpakai, geser +1 detik (masih urut
  // leksikografis = kronologis, dan detik "ke depan" itu unik sampai dilewati
  // waktu nyata — sementara file sudah ada, jadi cek berikutnya menolaknya).
  const pad = (n: number) => String(n).padStart(2, '0');
  const bentuk = (t: Date) =>
    `data-${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}` +
    `-${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}${pad(t.getUTCSeconds())}.db`;
  let t = new Date();
  let nama = bentuk(t);
  while (NAMA_BACKUP_TERPAKAI.has(nama) || fs.existsSync(path.join(dir, nama))) {
    t = new Date(t.getTime() + 1000);
    nama = bentuk(t);
  }
  NAMA_BACKUP_TERPAKAI.add(nama);
  const file = path.join(dir, nama);
  try {
    await db.backup(file);
  } catch (e) {
    NAMA_BACKUP_TERPAKAI.delete(nama); // gagal total -> nama bebas dipakai lagi
    throw e;
  }

  // Source dalam WAL -> file backup ikut header WAL, jadi setelah dibuka
  // meninggalkan pendamping .db-shm/.db-wal. Restore manual (salin-satu-file)
  // jadi tidak portabel & folder backups ikut kotor. Dipaksa ke DELETE:
  // SQLite checkpoint + menghapus -wal/-shm sendiri saat ganti mode.
  // Integrity check file HASIL dilakukan sesudahnya — file rusak (disk penuh
  // dsb) dibuang, jangan menumpuk sebagai "backup" yang ternyata tidak bisa
  // direstore. Bukan 'ok' -> lempar error (ditangkap pemanggil).
  let parah = false;
  try {
    const cek = new Database(file, { fileMustExist: true });
    cek.pragma('journal_mode = DELETE');
    const hasil = cek.pragma('integrity_check') as { integrity_check: string }[];
    parah = hasil.length !== 1 || hasil[0].integrity_check !== 'ok';
    cek.close();
  } catch {
    parah = true;
  }
  if (parah) {
    fs.rmSync(file, { force: true });
    fs.rmSync(`${file}-shm`, { force: true });
    fs.rmSync(`${file}-wal`, { force: true });
    throw new Error('integrity check gagal — file backup dibuang');
  }

  // Retensi: buang semua kecuali KEEP terbaru (urutan nama = kronologis).
  // Pendamping -shm/-wal (sisa file versi lama) ikut dibuang supaya bersih.
  const semua = fs.readdirSync(dir).filter((n) => POLA_BACKUP.test(n)).sort().reverse();
  for (const lama of semua.slice(KEEP)) {
    fs.rmSync(path.join(dir, lama), { force: true });
    fs.rmSync(path.join(dir, `${lama}-shm`), { force: true });
    fs.rmSync(path.join(dir, `${lama}-wal`), { force: true });
  }
  // Pengaman pembersihan: walau journal_mode=DELETE seharusnya sudah menghapus
  // pendamping, buang sisa apa pun (mis. dari file lama sebelum aturan ini).
  fs.rmSync(`${file}-shm`, { force: true });
  fs.rmSync(`${file}-wal`, { force: true });

  const st = fs.statSync(file);
  return { nama, ukuran: st.size, waktu: st.mtime.toISOString() };
}

// Jadwal harian IDEMPOTEN: cek "sudah ada file data-<hari-UTC>-*.db?"
// Bukan sekadar setInterval(24 jam) — API sering di-restart (tsx watch),
// interval murni bisa tidak pernah mencapai 24 jam atau menumpuk saat restart.
// Cek per jam: gap maksimal ±25 jam, restart bebas berapa kali.
function backupHarian(): void {
  try {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const hari =
      `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    const sudah = fs.readdirSync(backupDir())
      .some((n) => n.startsWith(`data-${hari}-`) && POLA_BACKUP.test(n));
    if (sudah) return;
    void buatBackup()
      .then((r) => console.log(`[backup] ${r.nama} (${r.ukuran} byte)`))
      .catch((e) => console.error('[backup] GAGAL:', e instanceof Error ? e.message : e));
  } catch (e) {
    console.error('[backup] GAGAL:', e instanceof Error ? e.message : e);
  }
}
backupHarian(); // sekali saat API hidup (idempoten — restart aman)
setInterval(backupHarian, 60 * 60 * 1000); // lalu cek tiap jam

// Daftar file backup (terbaru dulu).
app.get('/api/backup', (c) => c.json({ data: daftarBackup() }));

// Backup manual — selalu membuat file BARU (tanpa cek "hari ini sudah ada";
// cek harian hanya untuk scheduler). Integrity check + retensi tetap berlaku.
app.post('/api/backup', async (c) => {
  try {
    return c.json({ data: await buatBackup() }, 201);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'backup gagal' }, 500);
  }
});

// Unduh satu file backup. Guard GANDA (pola sama dengan endpoint foto):
// path.basename MEMASTIKAN tidak bisa keluar folder backups/, lalu whitelist
// pola nama file — nama lain (termasuk traversal yang sudah dinormalisasi)
// tetap 404. Jangan pernah menerima nama file apa pun yang ditulis client.
app.get('/api/backup/:nama', (c) => {
  const nama = c.req.param('nama');
  if (path.basename(nama) !== nama || !POLA_BACKUP.test(nama)) {
    return c.json({ error: 'file backup tidak ada' }, 404);
  }
  const file = path.join(backupDir(), nama);
  if (!fs.existsSync(file)) return c.json({ error: 'file backup tidak ada' }, 404);
  const buf = fs.readFileSync(file);
  return c.body(new Uint8Array(buf), 200, {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${nama}"`,
    'Cache-Control': 'no-store',
  });
});

// ---------- laporan harian ----------
app.get('/api/reports/daily', (c) => {
  const date = c.req.query('date') ?? new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const sales = db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS omzet, COALESCE(SUM(discount),0) AS diskon
     FROM sales WHERE date(created_at)=date(?)`,
  ).get(date) as { n: number; omzet: number; diskon: number };
  // `diskon` = diskon transaksi + diskon PER BARIS. Tanpa penjumlahan ini angka
  // diskon menyembunyikan potongan per baris padahal omzet sudah menguranginya,
  // lalu `subtotal - total` di layar laporan tidak pernah cocok dengan angka ini.
  sales.diskon += (db.prepare(
    `SELECT COALESCE(SUM(si.discount),0) AS d
       FROM sale_items si JOIN sales s ON s.id = si.sale_id
      WHERE date(s.created_at) = date(?)`,
  ).get(date) as { d: number }).d;
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
