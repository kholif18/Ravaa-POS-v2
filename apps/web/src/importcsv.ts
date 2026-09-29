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
  // `MinStock` (gaya Aronium, tanpa spasi) -> normalJudul jadi `minstock`;
  // `Min Stock` -> `min stock`. Dua-duanya belum tertangkap di atas.
  minstock: 'min_stock', 'min stock': 'min_stock',
  'harga dinamis': 'price_dynamic', 'price dynamic': 'price_dynamic',
  // Label persis di form produk (switch): "Boleh ubah harga saat jual".
  // normalJudul membuang tanda baca -> jadi tiga kata ini.
  'boleh ubah harga saat jual': 'price_dynamic', 'boleh ubah harga': 'price_dynamic',
  aktif: 'is_active', 'is active': 'is_active', status: 'is_active',
  // ── Diskon permanen & kadaluarsa (fitur 2026-09-29) ──────────────────────
  // Kolom kita "Diskon" (`1500` = Rp, `10%` = persen) dan "Tanggal kadaluarsa".
  // normalJudul membuang tanda, jadi "expiry-date" & "Tgl Kadaluarsa" ikut masuk.
  diskon: 'discount', discount: 'discount',
  'potongan harga': 'discount', 'diskon harga': 'discount',
  kadaluarsa: 'expiry_date', kedaluwarsa: 'expiry_date',
  'tanggal kadaluarsa': 'expiry_date', 'tgl kadaluarsa': 'expiry_date',
  'tanggal kedaluwarsa': 'expiry_date', 'tgl kedaluwarsa': 'expiry_date',
  'expiry date': 'expiry_date', expiry: 'expiry_date',
  // ── Header resmi Aronium ────────────────────────────────────────────────
  // Sumber: help.aronium.com "Import products using CSV" + file template
  // bawaannya (products.csv, 16 kolom). Aronium menulis CamelCase tanpa spasi
  // (`ProductGroup`, `MeasurementUnit`, `IsPriceChangeAllowed`, `IsEnabled`,
  // `Quantity`), sedangkan normalJudul() menghapus tanda jadi satu kata — jadi
  // kedua bentuk (dengan/tanpa spasi) dicatat eksplisit di sini.
  // Sengaja TIDAK dicatat, berarti diabaikan dengan aman: Tax,
  // IsTaxInclusivePrice, IsUsingDefaultQuantity, IsService, Description —
  // Ravaa tidak punya konsep pajak/deskripsi, dan track_stock diambil dari
  // kategori, bukan dari IsService.
  productgroup: 'category_slug', 'product group': 'category_slug',
  measurementunit: 'unit', 'measurement unit': 'unit',
  ispricechangeallowed: 'price_dynamic', 'price change allowed': 'price_dynamic',
  isenabled: 'is_active', enabled: 'is_active',
  quantity: 'stock',
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

/** Nilai kolom Diskon. Satuan DITENTUKAN tanda persen:
 *    `1500` / `Rp 1.500`  -> rupiah (default, sama dengan form produk)
 *    `10%`  / `10 %`      -> persen
 *  `""` (sel kosong)      -> `null` = TIDAK dikirim = kolom dianggap absen
 *                            (produk lama dipertahankan, produk baru default 0),
 *                            sama seperti kolom lain di parser ini.
 *  Angka tidak dikenal / negatif / persen > 100 -> `{ error }` supaya barisnya
 *  GAGAL di pratinjau dengan pesan yang bisa dicari, bukan diam-diam dibuang. */
export function parseDiskon(v: string): { type: 'rp' | 'pct'; nilai: number } | { error: string } {
  const s = v.trim();
  const pct = /%\s*$/.test(s);
  const n = parseAngka(s.replace(/%\s*$/, '').trim());
  if (n === null) return { error: `Nilai "${s}" pada kolom Diskon bukan angka` };
  if (n < 0) return { error: `Diskon tidak boleh negatif: "${s}"` };
  if (pct && n > 100) return { error: `Diskon persen maksimal 100: "${s}"` };
  return { type: pct ? 'pct' : 'rp', nilai: n };
}

/** Tanggal kadaluarsa. Dua bentuk diterima:
 *    `YYYY-MM-DD`          -> dipakai apa adanya (format ekspor & syarat server)
 *    `DD-MM-YYYY`/`DD/MM/YYYY` -> gaya tempelan Excel Indonesia, dinormalkan
 *  Sel kosong -> `null` = tidak dikirim (lihat catatan `parseDiskon`).
 *  `31-02-2026` (tanggal yang tidak ada) harus ditolak di sini: `Date.parse`
 *  menerimanya dengan ROLLOVER ke Maret, jadi dicek bolak-balik dengan
 *  `toISOString()`, bukan sekadar `isNaN`. */
export function parseTanggal(v: string): { iso: string } | { error: string } {
  const s = v.trim();
  let iso = '';
  const isoFix = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  const dmy = !isoFix ? /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s) : null;
  if (isoFix) {
    iso = `${isoFix[1]}-${isoFix[2].padStart(2, '0')}-${isoFix[3].padStart(2, '0')}`;
  } else if (dmy) {
    iso = `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  }
  if (!iso) return { error: `Tanggal kadaluarsa bukan tanggal (pakai YYYY-MM-DD): "${s}"` };
  const t = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== iso) {
    return { error: `Tanggal kadaluarsa tidak ada di kalender: "${s}"` };
  }
  return { iso };
}

/** Tulis kolom Diskon saat EKSPOR: `10%` / `1500` / `""` (tanpa diskon).
 *  Sengaja bentuk MESIN, bukan label `Rp 1.500` yang dipakai di layar —
 *  hasil unduh wajib bisa langsung dimasukkan lagi ke dialog Impor. */
export function formatDiskon(tipe: string | undefined | null, nilai: number | undefined | null): string {
  if (!nilai) return '';
  return tipe === 'pct' ? `${nilai}%` : String(nilai);
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
    // Barcode: ALIAS sudah memetakannya sejak awal, tetapi dulu tidak pernah
    // disalin ke payload — kolom Barcode terbaca tapi isinya dibuang diam-diam
    // setiap impor. Ditemukan oleh test format Aronium (barcode wajib di sana).
    const barcode = ambil('barcode');
    if (barcode) out.barcode = barcode;
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

    // Diskon permanen & kadaluarsa (2026-09-29). Sel kosong = kolom absen,
    // bukan "hapus diskon": server mode `pertahankanTidakDikirim` mempertahankan
    // nilai lama, jadi file ekspor LAMA (tanpa dua kolom ini) tidak menghapus
    // diskon produk yang sudah ada. Membersihkan diskon tetap lewat form Produk.
    const diskonRaw = ambil('discount');
    if (diskonRaw) {
      const d = parseDiskon(diskonRaw);
      if ('error' in d) return gagal(d.error);
      // discount_type & discount SELALU dikirim berpasangan — kalau hanya salah
      // satu, server memakai nilai lama untuk sisanya (mis. lama `pct` menjadi
      // `rp` tanpa angkanya berubah) dan impor jadi menulis angka yang salah.
      out.discount_type = d.type;
      out.discount = d.nilai;
    }

    const expRaw = ambil('expiry_date');
    if (expRaw) {
      const t = parseTanggal(expRaw);
      if ('error' in t) return gagal(t.error);
      out.expiry_date = t.iso;
    }

    const aksi = sku && o.adaSku(sku) ? 'timpa' : 'baru';
    return { baris, sku: sku || '(otomatis)', data: out, aksi, error: null };
  });
}

/** Header ARONIUM ASLI (16 kolom) — disimpan utuh BUKAN untuk diunduh, tapi
 *  sebagai alat bukti: test menggunakannya untuk membuktikan file ekspor
 *  Aronium lama yang beredar masih BISA diimpor. Parser mengabaikan kolom yang
 *  tidak kita punya, jadi tidak perlu ada header khusus untuk file lama. */
export const HEADER_ARONIUM_ORI =
  'Name,ProductGroup,SKU,Barcode,MeasurementUnit,Cost,Markup,Price,Tax,IsTaxInclusivePrice,IsPriceChangeAllowed,IsUsingDefaultQuantity,IsService,IsEnabled,Description,Quantity';

/** Header template yang KITA unduh — nama kolom bergaya Aronium, tapi ISINYA
 *  harus mencerminkan form produk Ravaa — namanya DIAMBIL DARI LABEL FORM,
 *  bukan istilah Aronium, supaya kasir bisa mencocokkan kolom CSV dengan layar
 *  yang dia lihat:
 *    Nama                          <- "Nama produk *"
 *    Kategori                      <- "Kategori *"   (bukan "ProductGroup")
 *    SKU, Barcode                  <- kolom form
 *    Satuan                        <- "Satuan"
 *    Harga beli                    <- "Harga beli (Rp)"
 *    Markup                        <- "Markup (%)"
 *    Harga jual                    <- "Harga jual (Rp) *"
 *    Boleh ubah harga saat jual    <- label switch-nya, persis
 *    Aktif                         <- switch "Aktif"
 *    Stok, Stok minimum            <- "Stok", "Stok minimum"
 *    Diskon                        <- "Diskon permanen" (1500 = Rp, 10% = persen)
 *    Tanggal kadaluarsa            <- "Tanggal kadaluarsa" (YYYY-MM-DD)
 *
 *  Lima kolom Aronium sengaja TIDAK ikut karena tidak ada di form:
 *    Tax, IsTaxInclusivePrice   -> sistem pajak tidak dipakai
 *    Description                -> tidak ada di form produk
 *    IsUsingDefaultQuantity     -> tidak ada "jumlah bawaan"
 *    IsService                  -> keputusan stok ada di kategori.track_stock,
 *                                  bukan per produk
 *  Parser TETAP menerima semuanya (lihat blok "Header resmi Aronium" di ALIAS),
 *  jadi file ekspor Aronium lama yang beredar tetap bisa langsung diimpor. */
export const HEADER_TEMPLATE =
  'Nama,Kategori,SKU,Barcode,Satuan,Harga beli,Markup,Harga jual,Boleh ubah harga saat jual,Aktif,Stok,Stok minimum,Diskon,Tanggal kadaluarsa';

/** Placeholder textarea = header template yang sama (satu baris, tanpa baris data).
 *  Dulu diisi oleh tombol "Contoh format" — tombol itu DIHAPUS karena tombol
 *  Unduh template sudah menghasilkan file lengkap berisi baris contoh. */
export const CONTOH_KOLOM = HEADER_TEMPLATE;

/** Kutip satu sel CSV sesuai RFC4180 (kutip ganda digandakan). */
function sel(v: string | number): string {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Isi file template yang diunduh: header KITA (HEADER_TEMPLATE) + 2 baris
 *  contoh. Dua penyesuaian penting dibanding file ekspor Aronium yang beredar:
 *  1. Nilai Kategori diambil dari MASTER HIDUP, bukan "Group 1" — kalau
 *     memakai "Group 1", begitu diimpor semua baris langsung gagal dengan
 *     `Kategori "Group 1" tidak ada di master`.
 *  2. Baris contoh memuat `CONTOH` di awal Nama, supaya gampang dikenali dan
 *     dihapus. Tidak ada kolom Description di template kita, jadi catatan
 *     "hapus saya" tidak bisa ditaruh di file.
 *  Nilai Harga beli/Markup/Harga jual sengaja konsisten
 *  (Harga jual = Harga beli x (1+Markup/100)) supaya tidak membingungkan
 *  saat diedit di Excel. Garis CRLF mengikuti Excel Windows. */
export function templateProduk(
  kategori: { slug: string; name: string; track_stock?: number }[],
  satuan: { slug: string }[],
): string {
  // Utamakan kategori yang melacak stok, karena kolom Stok = stok.
  const track = kategori.filter((c) => c.track_stock);
  const cat1 = track[0] ?? kategori[0];
  // Baris kedua memakai kategori stok berbeda bila ada, supaya kedua contoh
  // tidak terlihat seperti dua nama produk pada kategori yang sama.
  const cat2 = track.find((c) => c.slug !== cat1?.slug) ?? cat1;
  const u = satuan[0]?.slug ?? 'pcs';
  // Urutan nilai HARUS identik dengan HEADER_TEMPLATE:
  // Nama, Kategori, SKU, Barcode, Satuan, Harga beli, Markup, Harga jual,
  // Boleh ubah harga saat jual, Aktif, Stok, Stok minimum, Diskon,
  // Tanggal kadaluarsa
  // Dua kolom terakhir sengaja diisi CONTOH BEDA bentuk (persen vs rupiah,
  // tanggal vs kosong) supaya kasir melihat keduanya sebelum menghapus baris
  // contoh — sekaligus jadi uji nyata bahwa parser memetakan kolomnya.
  const baris = [
    // Kolom ke-9 ("Boleh ubah harga saat jual") sengaja 1 / 0 bergantian:
    // kalau keduanya 0, test tidak akan bisa membedakan kolomnya TERPETAKAN
    // dari kolomnya gagal dibaca lalu jatuh ke default 0.
    ['CONTOH Pulpen', cat1?.name ?? '', 'CONTOH-1', '', u, '2000', '50', '3000', '1', '1', '10', '2', '10%', ''],
    ['CONTOH Minuman', cat2?.name ?? '', 'CONTOH-2', '', u, '3000', '50', '4500', '0', '1', '10', '2', '500', '2027-12-31'],
  ];
  return [HEADER_TEMPLATE, ...baris.map((r) => r.map(sel).join(','))].join('\r\n');
}

/* ==========================================================================
 * EKSPOR — sengaja di file yang sama dengan parser, supaya urutan kolom
 * template, pembaca, dan penulis tidak bisa berjalan menjauh satu sama lain.
 * ========================================================================== */

/** Baris produk yang dibutuhkan penulis CSV. Sengaja structural, bukan import
 *  `Product` dari store — modul ini dipakai test di Node tanpa IndexedDB. */
export interface ProdukEkspor {
  name: string; category_name: string; sku: string; barcode: string | null;
  unit: string; cost: number; markup: number; price: number;
  price_dynamic: number; is_active: number; stock: number; min_stock: number;
  /** `rp` | `pct`; opsional supaya struct tanpa field ini (test Node) tetap masuk. */
  discount_type?: string | null;
  /** Diskon permanen dalam satuan `discount_type` (0 = tidak ada). */
  discount?: number | null;
  /** `YYYY-MM-DD` atau null/kosong. */
  expiry_date?: string | null;
}

/** Isi CSV ekspor produk. URUTAN KOLOM identik dengan `HEADER_TEMPLATE`, dan
 *  kategori ditulis NAMA (bukan slug) persis seperti `templateProduk` — jadi
 *  hasil unduh bisa langsung dimasukkan lagi ke dialog Impor tanpa disesuaikan.
 *  `Stok` ikut terbawa supaya bolak-baliknya utuh; mengimpor kembali berarti
 *  menulis ulang angka stok, dan dialog Impor selalu menampilkan pratinjau
 *  sebelum mengirim, jadi itu keputusan sadar pengguna, bukan diam-diam. */
export function csvProduk(list: ProdukEkspor[]): string {
  const baris = list.map((p) =>
    [
      p.name, p.category_name ?? '', p.sku, p.barcode ?? '', p.unit ?? '',
      p.cost, p.markup, p.price, p.price_dynamic, p.is_active, p.stock, p.min_stock,
      formatDiskon(p.discount_type, p.discount),
      p.expiry_date ?? '',
    ].map(sel).join(','),
  );
  return [HEADER_TEMPLATE, ...baris].join('\r\n');
}

/** Header ekspor & template stok. Hanya `SKU` dan `Stok` yang DIHARAPKAN oleh
 *  pembaca (`bacaStok`); `Nama` sekadar keterangan manufaktur. Kolom
 *  `Stok minimum` DIBUANG 2026-09-29: ekspor pernah menulisnya tetapi impor
 *  tidak pernah membacanya, jadi user yang mengubahnya lalu mengimpor ulang
 *  mendapat diam-diam tanpa efek apa pun — kolom yang tidak diproses lebih
 *  baik tidak ditawarkan sama sekali. Ambang minimum tetap diubah lewat form
 *  Produk atau impor Produk (`min_stock` memang dibaca di sana). */
export const HEADER_STOK = 'SKU,Nama,Stok';

export interface StokEkspor {
  sku: string; name: string; stock: number;
}

/** Isi CSV ekspor stok (halaman Stok): hanya produk `track_stock=1`. */
export function csvStok(list: StokEkspor[]): string {
  const baris = list.map((p) => [p.sku, p.name, p.stock].map(sel).join(','));
  return [HEADER_STOK, ...baris].join('\r\n');
}

export interface BarisStok {
  /** Nomor baris ASLI di file (baris judul = 1). */
  baris: number;
  sku: string;
  /** `null` = tidak terbaca sebagai angka; penilaian akhir (mis. >0 untuk
   *  restock) dilakukan di dialog karena bergantung mode yang dipilih. */
  qty: number | null;
  error: string | null;
}

export interface HasilBacaStok {
  /** Kedua kolom wajib ada. `false` = file ini bukan daftar stok. */
  ada: boolean;
  baris: BarisStok[];
}

/** Baca CSV/TSV daftar stok. Hanya kolom `SKU` dan `Stok` yang dipakai —
 *  kolom lain (termasuk seluruh kolom ekspor produk) dilewati, jadi file hasil
 *  unduh halaman Stok MAUPUN halaman Produk bisa ditempel apa adanya.
 *  Nama kolom dinormalisasi dulu (huruf besar/kecil, titik/garis/kurung-bayang
 *  diabaikan), dan fallback `stock`/`qty` dipakai supaya file ekspor Aronium
 *  lama tetap masuk. */
export function bacaStok(text: string): HasilBacaStok {
  const tb = parseTable(text);
  const norm = (s: string) => s.trim().toLowerCase().replace(/[.\-_]+/g, ' ');
  const iSku = tb.header.findIndex((h) => ['sku', 'kode', 'code'].includes(norm(h)));
  const iQty = tb.header.findIndex((h) => ['stok', 'stock', 'qty', 'jumlah'].includes(norm(h)));
  if (iSku < 0 || iQty < 0) return { ada: false, baris: [] };

  const baris: BarisStok[] = tb.rows.map((r, i) => {
    const nomor = i + 2; // +2: baris judul = 1
    const sku = (r[iSku] ?? '').trim();
    const mentah = (r[iQty] ?? '').trim();
    if (!sku) return { baris: nomor, sku, qty: null, error: 'SKU kosong' };
    if (!mentah) return { baris: nomor, sku, qty: null, error: 'kolom Stok kosong' };
    const qty = parseAngka(mentah);
    if (qty === null) return { baris: nomor, sku, qty: null, error: `bukan angka: "${mentah}"` };
    return { baris: nomor, sku, qty, error: null };
  });
  return { ada: true, baris };
}

/** Unduh string jadi file CSV. BOM ditanam DI SINI (bukan di pemanggil)
 *  supaya tidak bisa terlewat dan membuat Excel Windows membaca UTF-8 salah;
 *  parser membuang BOM-nya sendiri, jadi file hasil unduh tetap langsung bisa
 *  diimpor. */
export function unduhCSV(isi: string, namaFile: string): void {
  const url = URL.createObjectURL(new Blob(['\uFEFF' + isi], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = namaFile;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
