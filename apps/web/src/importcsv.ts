// Parser tabel untuk dialog Impor Produk (CSV / tempelan Excel).
//
// Tanpa dependensi: CSV RFC4180 ditulis tangan. Repo ini memang tanpa framework
// dan print-agent wajib nol-dep — membuat parser sendiri lebih kecil daripada
// membawa pustaka untuk SATU dialog.
//
// Pemisah kolom dideteksi dari baris pertama, bukan ditebak per sel:
//   TAB  = hasil tempel dari Excel (Excel menyalin sel dengan tab di antaranya)
//   ','  = file CSV biasa
//   ';'  = CSV dari Excel berbahasa Indonesia (pemisah lokal Windows)

export interface Tabel {
  header: string[];
  rows: string[][];
  delim: string;
}

/** Baris hasil peta: siap dikirim ke `POST /api/products/import`. */
export interface BarisImpor {
  /** Nomor baris ASLI di file (baris judul = 1), untuk pesan error yang bisa dicari. */
  baris: number;
  /** SKU untuk tampilan; `(otomatis)` bila kosong dan server yang menurunkan. */
  sku: string;
  data: Record<string, unknown> | null;
  aksi: 'baru' | 'timpa' | 'gagal';
  error: string | null;
}

/** Alias judul kolom -> field API. Dinormalisasi dulu: huruf kecil, `._-` jadi spasi,
 *  jadi `category_slug`, `CATEGORY-SLUG`, dan "Category Slug" jatuh ke kunci yang sama. */
const ALIAS: Record<string, string> = {
  sku: 'sku', kode: 'sku', 'kode barang': 'sku',
  nama: 'name', 'nama produk': 'name', name: 'name', produk: 'name', 'nama barang': 'name',
  kategori: 'category_slug', category: 'category_slug', 'category slug': 'category_slug',
  jenis: 'category_slug',
  barcode: 'barcode', 'bar code': 'barcode', 'kode barcode': 'barcode',
  satuan: 'unit', unit: 'unit',
  harga: 'price', 'harga jual': 'price', price: 'price',
  modal: 'cost', 'harga beli': 'cost', cost: 'cost',
  markup: 'markup', margin: 'markup', 'persen margin': 'markup',
  stok: 'stock', stock: 'stock', qty: 'stock', jumlah: 'stock',
  'min stok': 'min_stock', minimum: 'min_stock', 'stok minimum': 'min_stock',
  'harga dinamis': 'price_dynamic', 'price dynamic': 'price_dynamic',
  aktif: 'is_active', 'is active': 'is_active', status: 'is_active',
};

function normalJudul(h: string): string {
  return h.toLowerCase().replace(/[._\-/]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function pemisahDariBarisPertama(baris: string): string {
  if (baris.includes('\t')) return '\t';
  const koma = (basar(baris, ',')).length;
  const titikKoma = (basar(baris, ';')).length;
  return titikKoma > koma ? ';' : ',';
}

/** Buang kutip yang mengelilingi nilai hasil tempel Excel: Excel membungkus
 *  sel berisi pemisah dengan `"`, tetapi juga menyalinnya apa adanya pada
 *  kasus lain. Dipakai HANYA saat menghitung pemisah (baris judul), bukan di
 *  parser — parser sudah menangani kutip sendiri. */
function basar(s: string, c: string): string[] {
  return s.split(c);
}

/** Baca teks CSV/TSV jadi tabel. Kutip ganda mengikuti RFC4180:
 *  `"a, b"` = satu sel berisi koma, `""` = kutip literal, sel boleh berisi baris baru.
 *  Baris yang sepenuhnya kosong dibuang (Excel sering menyisakan baris kosong di kaki file). */
export function parseTable(text: string): Tabel {
  const t = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const firstLine = t.split('\n', 1)[0] ?? '';
  if (!firstLine.trim()) return { header: [], rows: [], delim: ',' };
  const delim = pemisahDariBarisPertama(firstLine);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (quoted) {
      if (ch === '"') {
        if (t[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === delim) { row.push(field); field = ''; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  row.push(field);
  rows.push(row);

  const header = (rows.shift() ?? []).map((h) => h.trim());
  const isi = rows.filter((r) => r.some((c) => c.trim() !== ''));
  return { header, rows: isi, delim };
}

/** Angka gaya Indonesia dan gaya internasional dipakai bersama karena file bisa
 *  datang dari mana saja: `1.500` / `1.500,50` (titik = ribuan) dan `1,500` /
 *  `1500.5` (koma = desimal). Kembalikan `null` kalau bukan angka sama sekali —
 *  pemanggil yang memutuskan itu error atau memang kosong. */
export function parseAngka(v: string): number | null {
  // Spasi dibuang dulu supaya "Rp 3.000" -> "Rp3.000" -> "3.000": sel Excel
  // ber-format Rupiah menyalin prefiksnya ikut menempel saat disalin.
  const s = v.trim().replace(/\s/g, '').replace(/^rp\.?/i, '');
  if (!s) return null;
  let t = s;
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) {
    // Format Indonesia: titik pemisah ribuan, koma desimal -> 1.500,50 = 1500.5
    t = t.replace(/\./g, '').replace(',', '.');
  } else if (/^-?\d{1,3}(,\d{3})+$/.test(t)) {
    // `1,500` / `1,234,567` = gaya internasional (ribuan). Diputuskan jadi
    // RIBUAN bukan desimal karena yang diimpor harga/harga beli bulat;
    // `1,5` (desimal) tidak cocok pola ini dan jatuh ke cabang bawah.
    t = t.replace(/,/g, '');
  } else if (t.includes(',') && !t.includes('.')) {
    // Sisa koma tanpa titik = desimal gaya Indonesia -> `1500,50` = 1500.5
    t = t.replace(',', '.');
  }
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** `aktif`/`1`/`ya`/`y`/`true` -> 1; `nonaktif`/`0`/`tidak`/`n`/`false` -> 0.
 *  Kosong -> `null` (kunci TIDAK dikirim, biar server pakai default-nya). */
export function parseAktif(v: string): number | null {
  const s = v.trim().toLowerCase();
  if (!s) return null;
  if (['1', 'ya', 'y', 'true', 'aktif', 'yes'].includes(s)) return 1;
  if (['0', 'tidak', 'n', 'false', 'nonaktif', 'no'].includes(s)) return 0;
  return null;
}

export interface MapOpts {
  kategori: { slug: string; name: string }[];
  satuan: { slug: string; name: string }[];
  /** SKU yang sudah ada di server (untuk menandai "timpa" di pratinjau). */
  adaSku: (sku: string) => boolean;
}

const KOLOM_ANGKA = ['price', 'cost', 'markup', 'stock', 'min_stock', 'price_dynamic'] as const;

/** Peta baris mentah jadi payload API + status per baris.
 *  Kategori & satuan dicocokkan berdasarkan SLUG ATAU NAMA (case-insensitive):
 *  orang menulis "ATK" / "Lembar" di Excel, bukan slug `atk` / `lembar`. */
export function mapRows(tb: Tabel, o: MapOpts): BarisImpor[] {
  const kolom = tb.header.map(normalJudul).map((h) => ALIAS[h] ?? null);
  const catBySlug = new Map(o.kategori.map((c) => [c.slug.toLowerCase(), c.slug]));
  const catByName = new Map(o.kategori.map((c) => [c.name.trim().toLowerCase(), c.slug]));
  const satBySlug = new Map(o.satuan.map((c) => [c.slug.toLowerCase(), c.slug]));
  const satByName = new Map(o.satuan.map((c) => [c.name.trim().toLowerCase(), c.slug]));

  return tb.rows.map((sel, i) => {
    const baris = i + 2; // +1 header, +1 agar 1-based — sama dengan nomor baris di editor
    const out: Record<string, unknown> = {};
    const ambil = (f: string) => {
      const idx = kolom.indexOf(f);
      return idx >= 0 ? (sel[idx] ?? '').trim() : '';
    };

    const name = ambil('name');
    const sku = ambil('sku');
    const kategoriRaw = ambil('category_slug');
    const satuanRaw = ambil('unit');

    const gagal = (pesan: string): BarisImpor => ({
      baris, sku: sku || '(otomatis)', data: null, aksi: 'gagal', error: pesan,
    });

    if (kolom.every((k) => k === null)) {
      return gagal('Judul kolom tidak dikenal — pakai tombol "Contoh format"');
    }
    if (!name) return gagal('Nama produk kosong');
    if (!kategoriRaw) return gagal('Kategori kosong');

    const slugCat = catBySlug.get(kategoriRaw.toLowerCase()) ?? catByName.get(kategoriRaw.toLowerCase());
    if (!slugCat) return gagal(`Kategori "${kategoriRaw}" tidak ada di master`);

    out.name = name;
    out.category_slug = slugCat;
    if (sku) out.sku = sku;
    if (satuanRaw) {
      const slugSat = satBySlug.get(satuanRaw.toLowerCase()) ?? satByName.get(satuanRaw.toLowerCase());
      if (!slugSat) return gagal(`Satuan "${satuanRaw}" tidak ada di master`);
      out.unit = slugSat;
    }

    for (const f of KOLOM_ANGKA) {
      const raw = ambil(f);
      if (!raw) continue;
      const n = parseAngka(raw);
      if (n === null) return gagal(`Nilai "${raw}" pada kolom ${f} bukan angka`);
      out[f] = n;
    }

    const aktif = parseAktif(ambil('is_active'));
    if (aktif !== null) out.is_active = aktif;

    const aksi = sku && o.adaSku(sku) ? 'timpa' : 'baru';
    return { baris, sku: sku || '(otomatis)', data: out, aksi, error: null };
  });
}

/** Judul kolom contoh yang disalin ke textarea. Hanya judul (tanpa baris data)
 *  supaya tombol "Contoh format" tidak diam-diam menanam produk sampel. */
export const CONTOH_KOLOM = 'sku,nama,kategori,satuan,harga,modal,stok';
