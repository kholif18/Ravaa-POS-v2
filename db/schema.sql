-- Ravaa POS v2 — sumber kebenaran skema. Dijalankan via apps/api/src/seed.ts.
-- DB: SQLite (file data.db di server). Satu penulis aktif, tanpa replikasi.

PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT NOT NULL UNIQUE,   -- atk, cetak, desain, jasa, topup, eskrim, snack, rokok
  name        TEXT NOT NULL,
  track_stock INTEGER NOT NULL DEFAULT 0,  -- 1 = barang fisik (kurangi stok saat jual)
  sort        INTEGER NOT NULL DEFAULT 0,
  -- 1 = form produk kategori ini MENAMPILKAN "Tanggal kadaluarsa".
  -- Pengganti daftar hardcode snack/eskrim: pemilik bisa menyalakan kategori
  -- mana pun (mis. Frozen food) tanpa menyentuh kode.
  use_expiry  INTEGER NOT NULL DEFAULT 0
);

-- Master satuan (CRUD di halaman #/satuan). Dipakai form produk sebagai dropdown.
CREATE TABLE IF NOT EXISTS units (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  slug   TEXT NOT NULL UNIQUE,   -- pcs, btl, lembar, ... dan '-' = tanpa satuan
  name   TEXT NOT NULL           -- urutan tampil = alfabetis nama (lihat api/units)
);

CREATE TABLE IF NOT EXISTS products (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id   INTEGER NOT NULL REFERENCES categories(id),
  sku           TEXT NOT NULL UNIQUE,  -- cth: PRD00001, PRD00015 (nomor urut server; boleh juga diketik manual)
  barcode       TEXT UNIQUE,           -- opsional, dari scanner USB
  name          TEXT NOT NULL,
  unit          TEXT NOT NULL DEFAULT 'pcs' REFERENCES units(slug), -- satuan untuk struk
  price         INTEGER NOT NULL DEFAULT 0,     -- rupiah; harga jual. 0 = harga dinamis (diisi saat jual)
  -- Harga GROSIR per satuan dasar (2026-10-11, tier pelanggan): dipakai POS
  -- bila pelanggan terpilih tier-nya `grosir` (lihat customers.tier). 0 =
  -- ikut harga ecer (tanpa tier) — tanpa beban isi bila tak dipakai.
  -- Pack/dus: eksplisit di product_units bila diisi, ikut
  -- `price_grosir × factor` bila NULL (aturan sama dengan ecer).
  price_grosir  INTEGER NOT NULL DEFAULT 0,
  price_dynamic INTEGER NOT NULL DEFAULT 0,     -- 1 = kasir boleh ubah harga sebelum transaksi
  cost          INTEGER NOT NULL DEFAULT 0,     -- harga beli / modal (diisi manual di form, dasar markup)
  -- Modal RATA-RATA TERTIMBANG hasil restock, bukan harga beli terakhir:
  -- A' = round((stok_lama*A + qty*harga_beli) / (stok_lama + qty)).
  -- Dipisah dari `cost` supaya input manual pemilik tidak tertimpa diam-diam
  -- oleh restock, dan `cost` tetap menjadi patokan markup di form.
  -- HPP penjualan memakai kolom INI, bukan `cost`.
  avg_cost      INTEGER NOT NULL DEFAULT 0,
  markup        REAL    NOT NULL DEFAULT 0,     -- margin % dari modal: (price-cost)/cost*100
  stock         INTEGER NOT NULL DEFAULT 0,     -- hanya berarti bila kategori track_stock=1
  min_stock     INTEGER NOT NULL DEFAULT 0,     -- peringatan stok menipis
  -- Foto produk: HANYA thumbnail (di-resize client ke <=512px, JPEG) — foto asli
  -- tidak pernah disimpan (permintaan pemilik, 2026-09-29). Nilai kolom ini =
  -- NAMA FILE di apps/api/data/img/, BUKAN isi gambar: isi gambar di DB membuat
  -- setiap ?since= delta sync menarik megabyte foto karena stok saja sudah
  -- menaikkan version. File dibaca lewat GET /api/products/:id/image.
  -- NULL/'' = tanpa foto.
  image         TEXT,
  -- Diskon per produk (Tipe + Nilai) = PREFILL saat produk masuk keranjang POS.
  -- Kasir boleh mengubahnya per baris (ala OSPOS/Aronium), jadi master ini hanya
  -- modal awal — bukan angka yang dikunci saat jual. 'rp' = rupiah, 'pct' = %.
  discount_type TEXT NOT NULL DEFAULT 'rp',     -- 'rp' | 'pct'
  discount      INTEGER NOT NULL DEFAULT 0,     -- nilai sesuai tipe (rp bulat / persen)
  -- Tanggal kadaluarsa (ISO YYYY-MM-DD), HANYA diisi kategori track_stock yang
  -- isinya cepat basi: snack & eskrim (Es Krim & Minuman). NULL = tidak berlaku
  -- (ATK/cetak/rokok tidak punya tanggal kadaluarsa).
  expiry_date   TEXT,
  -- Catatan per baris di POS (2026-10-03): 1 = baris keranjang produk ini
  -- punya input catatan (cth produk "Cetak Banner" -> kasir mengetik
  -- "ukuran 1 x 3 meter"). Teksnya di-snapshot ke sale_items.note dan ikut
  -- tercetak di struk — bukan kolom teks master, karena catatan bersifat
  -- PER TRANSAKSI, bukan per produk.
  use_note      INTEGER NOT NULL DEFAULT 0,
  is_active     INTEGER NOT NULL DEFAULT 1,
  -- Hapus produk = SOFT delete (tombstone), bukan DELETE keras. Baris sengaja
  -- dibiarkan supaya version++ di bawah bisa menyiarkan "produk ini dihapus"
  -- ke cache kasir lewat ?since= (delta sync). Tanpa ini produk yang dihapus
  -- di server akan tetap nempel selamanya di IndexedDB kasir, karena
  -- syncMaster cuma merge per sku dan tidak pernah membuang.
  deleted_at    TEXT,                   -- NULL = masih ada; diisi = dihapus
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  version       INTEGER NOT NULL DEFAULT 1      -- naik tiap update master (untuk ?since= sync)
);

-- Satuan jual ALTERNATIF per produk (fitur #3 Multi satuan).
-- Satuan DASAR tetap implisit: products.unit + products.price (tidak jadi baris).
-- Contoh Pulpen Hitam (dasar pcs Rp3.000):
--   unit=pack, factor=12,   price=NULL  -> Rp36.000 (12 x Rp3.000, ikut rumus)
--   unit=dus,  factor=144,  price=450000 -> harga grosir EKSPLISIT (bukan 432rb)
-- price NULL = ikut products.price * factor; diisi = harga grosir sendiri.
-- Stok SELALU satuan dasar: jual 2 pack = 2*12 pcs -> stock -= qty*factor.
CREATE TABLE IF NOT EXISTS product_units (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  unit       TEXT NOT NULL REFERENCES units(slug),
  factor     REAL NOT NULL CHECK (factor > 0),  -- 1 unit jual = berapa satuan dasar
  price      INTEGER,                          -- NULL = products.price * factor
  UNIQUE (product_id, unit)
);
CREATE INDEX IF NOT EXISTS idx_product_units_product ON product_units(product_id);

-- Harga borongan per qty (2026-10-19) — model "kelipatan paket", keputusan
-- pemilik dari contoh nyata toko: "beli 6 lembar Rp5.000", "beli 10 buku
-- Rp33.000". Baris berarti: SETIAP kelipatan `qty` satuan dasar berharga
-- `price`; kelebihannya dihitung harga normal (6 -> 5000, 7 = 5000 + harga
-- satuan). Hanya berlaku untuk SATUAN DASAR — pak/dus memakai harga
-- product_units sendiri (aturan tidak dicampur).
-- Klien POS yang menghitung potongannya sebagai `items[].discount`; server
-- tetap penjaga lewat validasi diskon baris (0 <= discount <= qty*price).
-- Tanpa baris di sini = produk tanpa aturan borongan (perilaku lama).
CREATE TABLE IF NOT EXISTS product_borongan (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  qty        INTEGER NOT NULL CHECK (qty >= 2),    -- jumlah satuan dasar
  price      INTEGER NOT NULL CHECK (price >= 0),  -- total harga paket qty itu
  UNIQUE (product_id, qty)
);
CREATE INDEX IF NOT EXISTS idx_product_borongan_product ON product_borongan(product_id);

CREATE TABLE IF NOT EXISTS shifts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  opened_at   TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at   TEXT,
  modal_awal  INTEGER NOT NULL DEFAULT 0,
  modal_akhir INTEGER,                 -- kas fisik saat tutup
  cashier     TEXT NOT NULL DEFAULT 'kasir',
  status      TEXT NOT NULL DEFAULT 'open'  -- open | closed
);
-- 1 shift terbuka per kasir (mendukung 2 kasir bersamaan, umumnya 1 aktif).
-- Ditegakkan di DB agar race open-shift tidak bisa dobel.
CREATE UNIQUE INDEX IF NOT EXISTS idx_shifts_open_cashier ON shifts(cashier) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS sales (
  id          TEXT PRIMARY KEY,        -- uuid dari client (idempotent, aman retry offline)
  shift_id    INTEGER REFERENCES shifts(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  -- Nomor invoice (2026-10-03, direvisi 2026-10-04): `YYMMDD-NNNNNN` =
  -- tahun 2 digit + bulan + tanggal + '-' + 6 digit urut, urut HARIAN UTC
  -- (mis. `261004-000001`). Di-assign SERVER saat INSERT, di
  -- dalam transaksi yang sama — retry idempotent tidak menghitung ulang
  -- (cek duplikat dijalankan sebelum perhitungan nomor).
  invoice_no  TEXT,
  pay_method  TEXT NOT NULL DEFAULT 'tunai', -- tunai | qris | transfer | campuran (split 1.6.5)
  subtotal    INTEGER NOT NULL,
  discount    INTEGER NOT NULL DEFAULT 0,
  total       INTEGER NOT NULL,
  cash_in     INTEGER NOT NULL DEFAULT 0,
  change      INTEGER NOT NULL DEFAULT 0,
  cashier     TEXT NOT NULL DEFAULT 'kasir',
  -- Pelanggan pada transaksi (revisi 2026-10-04): POS memilih pelanggan di
  -- header (bawaan = "Pelanggan Umum"). `customer_name` = SNAPSHOT nama saat
  -- jual — riwayat / cetak ulang struk & invoice A4 harus tetap menampilkan
  -- data customer walau kontaknya kelak diubah/dihapus (pola snapshot yang
  -- sama dengan sale_items.name & sale_items.cost).
  customer_id   INTEGER REFERENCES customers(id),
  customer_name TEXT NOT NULL DEFAULT '',
  -- Catatan TRANSAKSI (2026-10-10, permintaan pemilik "tambahkan catatan di
  -- setiap transaksi"): teks bebas per nota dari kolom "Catatan transaksi" di
  -- modal bayar POS (bukan per baris seperti sale_items.note). Di-TRIM +
  -- divalidasi server (maks 200 karakter, sama seperti catatan baris).
  -- Tahap 1 = simpan + baca ulang (struk/history); cetak di kaki struk =
  -- tahap 2 (menyusul bila pemilik minta).
  note          TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS sale_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id     TEXT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id  INTEGER REFERENCES products(id),
  name        TEXT NOT NULL,           -- snapshot nama saat jual
  qty         REAL NOT NULL DEFAULT 1,
  price       INTEGER NOT NULL,        -- harga satuan aktual (penting untuk harga dinamis)
  amount      INTEGER NOT NULL,        -- KOTOR: qty*price, sebelum diskon baris
  -- Diskon PER BARIS yang disnapshot saat jual (prefill dari products.discount,
  -- boleh diubah kasir). Nilai BERSIH baris = amount - discount, dan itulah yang
  -- masuk ke sales.total. Disnapshot bukan dibaca ulang dari products supaya
  -- riwayat & laba hari lalu tidak ikut berubah kalau pemilik mengubah diskon
  -- master besok — persis alasan yang sama dengan `cost`.
  discount    INTEGER NOT NULL DEFAULT 0,
  -- HPP satuan yang di-SNAPSHOT saat jual (products.avg_cost saat itu).
  -- Snapshot wajib: rata-rata modal berubah tiap restock, kalau laporan hanya
  -- membaca products.avg_cost maka laba MASA LALU ikut berubah retroaktif.
  -- HPP baris = qty*cost; laba baris = amount - qty*cost.
  cost        INTEGER NOT NULL DEFAULT 0,
  -- Snapshot SATUAN yang terjual (fitur #3). Tanpa kolom ini laporan/struk lama
  -- menampilkan angka apa adanya padahal satuan aslinya `pack`, dan satuan dasar
  -- produk nanti bisa berubah lalu membengkokkan riwayat. '' = item manual
  -- (tanpa produk) / satuan dasar.
  unit        TEXT NOT NULL DEFAULT '',
  -- Catatan PER BARIS dari keranjang POS (produk dengan use_note=1), 0-200
  -- karakter, di-snapshot saat jual seperti discount/cost: riwayat & struk
  -- ulang tidak ikut berubah walau isi input berubah di keranjang berikutnya.
  -- '' = tanpa catatan (mayoritas baris).
  note        TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);

-- Split payment / pembayaran 2+ metode (butir ROADMAP 1.6.5, ACC pemilik
-- 19 Okt 2026): rincian ATRIBUSI pembayaran per metode untuk SATU nota —
-- Σ `amount` per nota SELALU = `sales.total` (satu-satunya sumber angka per
-- metode untuk laporan byMethod & agregat tunai/qris/transfer shift).
--   - Nota satu metode (termasuk nota lama yang belum punya baris — dibaca
--     lewat fallback `(pay_method, total)` di query): satu baris =
--     (pay_method, total). Nota hutang ikut penuh di metode tunai — porsi
--     yang belum dibayar memang ditampilkan TERPISAH sebagai `hutang_baru`/
--     `sisa_hutang` (perilaku lama dipertahankan; rumus laci =
--     omzet − hutang_baru, bukan dari tabel ini).
--   - Nota campuran (`sales.pay_method = 'campuran'`, POS modal bayar 2
--     metode): satu baris per metode, porsi = uang yang diterapkan ke total
--     (untuk tunai = uang fisik − kembalian), Σ = total.
--   - Server menulis baris untuk SETIAP nota baru; baris lama sengaja TIDAK
--     di-backfill (query punya fallback) — jangan tambah backfill diam-diam.
CREATE TABLE IF NOT EXISTS sale_payments (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id  TEXT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  method   TEXT NOT NULL,                       -- tunai | qris | transfer
  amount   INTEGER NOT NULL CHECK (amount >= 0), -- 0 hanya mungkin di nota total 0
  UNIQUE (sale_id, method)
);
CREATE INDEX IF NOT EXISTS idx_sale_payments_sale ON sale_payments(sale_id);

-- Retur penjualan (Tahap 2, 2026-10-11, halaman #/returns + tombol per nota
-- di #/history): barang kembali dari pelanggan, uang kembali ke pelanggan.
-- Stok produk fisik KEMBALI masuk (`stock += qty` + `version++` + `stock_moves`
-- `reason='retur'`, qty positif = barang masuk). Uang tunai KELUAR dari laci:
-- mengurangi `kasSeharusnya()` bila terikat shift (agregat `retur_total` di
-- GET /api/shifts — keputusan pemilik (a): retur kurangi laci). Rekap harian
-- di GET /api/reports/daily (`retur:{n,total}`); laporan menampilkan 3 angka
-- hybrid — Omzet kotor + Retur terpisah + Omzet bersih (keputusan (c)).
CREATE TABLE IF NOT EXISTS returns (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  -- Nota asal (opsional): NULL = retur tanpa nota (barang dibawa tanpa struk).
  -- Bila terisi harus sales yang ada — sisa qty per baris divalidasi server
  -- (qty retur ≤ qty terjual − sudah diretura).
  sale_id     TEXT REFERENCES sales(id),
  -- Total uang kembali = SUM(qty*harga) baris. Tunai keluar laci shift ini
  -- (bila shift_id terikat); NULL = di luar shift (tetap tercatat + laporan).
  total       INTEGER NOT NULL CHECK (total > 0),
  cashier     TEXT NOT NULL DEFAULT 'kasir',
  shift_id    INTEGER REFERENCES shifts(id),
  note        TEXT NOT NULL DEFAULT ''  -- maks 200 char (aturan catatan)
);
CREATE TABLE IF NOT EXISTS return_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  return_id     INTEGER NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
  -- Baris nota asal (opsional, terisi bila retur ber-nota): harga & nama
  -- di-SNAPSHOT dari sale_items (bukan dari master — harga saat jual yang
  -- kembali, bukan harga sekarang).
  sale_item_id  INTEGER REFERENCES sale_items(id),
  product_id    INTEGER REFERENCES products(id),
  name          TEXT NOT NULL,           -- snapshot nama (struk/riwayat stabil)
  qty           REAL NOT NULL CHECK (qty > 0),
  price         INTEGER NOT NULL,        -- harga satuan saat jual (snapshot)
  amount        INTEGER NOT NULL         -- qty*price (nilai kembali baris ini)
);
CREATE INDEX IF NOT EXISTS idx_returns_tanggal ON returns(created_at);
CREATE INDEX IF NOT EXISTS idx_returns_shift ON returns(shift_id);
CREATE INDEX IF NOT EXISTS idx_returns_sale ON returns(sale_id);
CREATE INDEX IF NOT EXISTS idx_return_items_return ON return_items(return_id);
CREATE INDEX IF NOT EXISTS idx_return_items_sale_item ON return_items(sale_item_id);

-- Pembelian / kulakan (Tahap 3, 2026-10-11, halaman #/purchases): nota PO ke
-- supplier — order dulu, barang datang baru receive (stok masuk), bayar tunai
-- (bawaan lunas; boleh sisa hutang — keputusan pemilik (b): praktik selalu
-- tunai, kolom hutang hanya bila suatu saat terjadi).
--   - order: TANPA sentuhan stok/kas (catatan pesanan saja).
--   - receive: per item rumus SAMA PERSIS dengan restock (avg_cost tertimbang
--     + stock += qty + version++ + stock_moves reason='beli'); `terbayar`
--     bawaan = total (tunai penuh); kurang dari itu = sisa hutang supplier.
--   - Kas keluar = `terbayar` (bukan total): yang mengurangi laci hanya uang
--     yang benar-benar keluar, di shift yang tertera (`n_purchase` /
--     `purchase_total` di GET /api/shifts → kasSeharusnya). Rekap harian di
--     GET /api/reports/daily (`purchase:{n,total}` = nilai yang DITERIMA).
CREATE TABLE IF NOT EXISTS purchases (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  -- Pemasok + snapshot namanya (pola sales.customer_id/customer_name):
  -- riwayat tetap menampilkan nama walau master supplier kelak diubah/dihapus.
  -- NULL = tanpa pemasok (kulakan eceran). Guard hapus supplier (400) memakai
  -- kolom ini — supplier yang pernah dipakai PO tidak bisa dihapus.
  supplier_id   INTEGER REFERENCES suppliers(id),
  supplier_name TEXT NOT NULL DEFAULT '',
  -- order = pesanan (belum ada barang/uang) | received = barang masuk (+kas
  -- keluar sebesar terbayar) | cancel = batal (hanya dari order).
  status      TEXT NOT NULL DEFAULT 'order' CHECK (status IN ('order', 'received', 'cancel')),
  total       INTEGER NOT NULL CHECK (total > 0),   -- SUM(qty*harga_beli)
  terbayar    INTEGER NOT NULL DEFAULT 0 CHECK (terbayar >= 0), -- tunai keluar
  -- Waktu TERIMA (NULL selama masih order): rekap harian + agregat
  -- dihitung dari tanggal ini (tanggal PO ≠ tanggal barang datang).
  received_at TEXT,
  cashier     TEXT NOT NULL DEFAULT 'kasir',
  shift_id    INTEGER REFERENCES shifts(id),  -- NULL = di luar shift
  note        TEXT NOT NULL DEFAULT ''        -- maks 200 char (aturan catatan)
);
CREATE TABLE IF NOT EXISTS purchase_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id   INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  product_id    INTEGER NOT NULL REFERENCES products(id),
  name          TEXT NOT NULL,           -- snapshot nama (riwayat stabil)
  qty           REAL NOT NULL CHECK (qty > 0),
  harga_beli    INTEGER NOT NULL CHECK (harga_beli >= 0),
  amount        INTEGER NOT NULL         -- qty*harga_beli
);
-- Penerimaan PO BERTAHAP (butir ROADMAP 3.7, 2026-10-25): satu baris per
-- KEDATANGAN barang (sebagian atau penuh). Header `purchases` tetap menyimpan
-- status tersimpan: 'order' selama qty belum lengkap, 'received' saat semua
-- baris terpenuhi — status "Sebagian" adalah COMPUTED dari Σ kedatangan,
-- jadi CHECK lama tidak perlu diubah (tanpa rebuild tabel).
-- `dibayar` = uang keluar pada kedatangan INI (bukan total PO); sisa hutang
-- dihitung dari nilai yang SUDAH diterima (`diterima - terbayar`), bukan
-- total PO. `client_id` = kunci idempotensi retry (uuid dari klien); NULL
-- untuk pemanggil lama — SQLite mengizinkan banyak NULL di kolom UNIQUE.
CREATE TABLE IF NOT EXISTS purchase_receives (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  shift_id    INTEGER REFERENCES shifts(id),          -- NULL = di luar shift
  cashier     TEXT NOT NULL DEFAULT 'kasir',
  total       INTEGER NOT NULL CHECK (total >= 0),    -- nilai barang kedatangan ini
  dibayar     INTEGER NOT NULL DEFAULT 0 CHECK (dibayar >= 0),
  note        TEXT NOT NULL DEFAULT '',               -- maks 200 char
  client_id   TEXT UNIQUE
);
CREATE TABLE IF NOT EXISTS purchase_receive_items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  receive_id       INTEGER NOT NULL REFERENCES purchase_receives(id) ON DELETE CASCADE,
  purchase_item_id INTEGER NOT NULL REFERENCES purchase_items(id) ON DELETE CASCADE,
  qty              REAL NOT NULL CHECK (qty > 0),
  harga_beli       INTEGER NOT NULL CHECK (harga_beli >= 0), -- snapshot saat terima
  amount           INTEGER NOT NULL                          -- round(qty*harga_beli)
);
CREATE INDEX IF NOT EXISTS idx_purchases_status ON purchases(status, created_at);
CREATE INDEX IF NOT EXISTS idx_purchases_shift ON purchases(shift_id);
CREATE INDEX IF NOT EXISTS idx_purchases_supplier ON purchases(supplier_id);
CREATE INDEX IF NOT EXISTS idx_purchase_items_purchase ON purchase_items(purchase_id);
CREATE INDEX IF NOT EXISTS idx_purchase_receives_purchase ON purchase_receives(purchase_id);
CREATE INDEX IF NOT EXISTS idx_purchase_receives_shift ON purchase_receives(shift_id);
CREATE INDEX IF NOT EXISTS idx_purchase_receives_tanggal ON purchase_receives(created_at);
CREATE INDEX IF NOT EXISTS idx_purchase_receive_items_receive ON purchase_receive_items(receive_id);
CREATE INDEX IF NOT EXISTS idx_purchase_receive_items_item ON purchase_receive_items(purchase_item_id);

-- Topup & tarik tunai: nominal bebas + admin editable.
-- nominal = mutasi modal/e-money, admin = pendapatan jasa.
CREATE TABLE IF NOT EXISTS topup_txns (
  id          TEXT PRIMARY KEY,        -- uuid dari client
  shift_id    INTEGER REFERENCES shifts(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  kind        TEXT NOT NULL,           -- topup | tarik
  provider    TEXT NOT NULL,           -- jenis layanan: E-WALLET | PULSA | PLN-TOKEN | PLN-BILL | TARIK-EWALLET | TARIK-BANK
  nomor       TEXT NOT NULL DEFAULT '',-- no HP / no pelanggan ('' = layanan tanpa nomor: e-wallet/pulsa/tarik, pemilik 2026-10-06)
  token       TEXT NOT NULL DEFAULT '',-- Nomor Token PLN (dicetak di struk; kosong untuk layanan lain)
  nominal     INTEGER NOT NULL,        -- nilai isi/tarik
  admin       INTEGER NOT NULL DEFAULT 0, -- biaya admin (pendapatan)
  total       INTEGER NOT NULL,        -- nominal + admin (yang dibayar pelanggan)
  pay_method  TEXT NOT NULL DEFAULT 'tunai',
  cashier     TEXT NOT NULL DEFAULT 'kasir',
  -- Relasi LEMBUT ke sales.id (opsional): topup/tarik yang dibayar BERSAMA satu
  -- nota penjualan (Opsi B hybrid, 2026-10-08) — di-stamp client sebelum POST
  -- /api/sales. NULL = topup/tarik mandiri (tanpa nota produk). TANPA FK:
  -- baris topup ditulis SEBELUM baris sales tercipta, jadi foreign key akan
  -- gagal saat insert. Dipakai Riwayat mengelompokkan topup di bawah nota.
  sale_id     TEXT
);

CREATE TABLE IF NOT EXISTS stock_moves (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  product_id  INTEGER NOT NULL REFERENCES products(id),
  qty         REAL NOT NULL,           -- +masuk / -keluar
  reason      TEXT NOT NULL,           -- sale | restock | opname | rusak | retur (Tahap 2) | beli (Tahap 3)
  ref_id      TEXT,                    -- id sale bila reason=sale
  -- Biaya per satuan pada saat mutasi: restock = harga beli; sale/opname =
  -- avg_cost saat itu. Inilah riwayat pembelian yang selama ini tidak ada —
  -- menjadi dasar audit kalau avg_cost di products perlu dihitung ulang.
  unit_cost   INTEGER NOT NULL DEFAULT 0,
  cashier     TEXT NOT NULL DEFAULT 'kasir'
);
CREATE INDEX IF NOT EXISTS idx_stock_moves_product ON stock_moves(product_id);

-- Pengaturan toko: key/value berbasis teks supaya menambah opsi TIDAK butuh ALTER
-- (kebijakan migrasi repo = re-create DB, jadi kolom baru mahal — baris baru murah).
-- Dibaca SEMUA device lewat GET /api/settings, bukan localStorage: aturan stok
-- harus sama di server dan di kasir, kalau tidak kasir bisa menolak/menerima
-- penjualan yang server anggap sebaliknya.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Pelanggan & hutang (piutang toko) — baru 2026-10-04, halaman #/customers & #/debts.
-- Pelanggan = master kontak terpisah dari data kasir (karyawan) di tabel shifts.
-- Kolom `supplier_no` DICABUT 2026-10-11 (perintah pemilik: no. supplier
-- tidak pantas di modal customer) — pindah ke master `suppliers` di bawah
-- dengan penomorannya sendiri (`SUP-000001`).
CREATE TABLE IF NOT EXISTS customers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Nomor urut OTOMATIS dari server (revisi pemilik 2026-10-04): `CUS-000001`
  -- untuk no customer. Kosong = baris lama; server mengisinya saat pertama
  -- kali baris disimpan ulang.
  code        TEXT NOT NULL DEFAULT '',
  -- Tier harga (2026-10-11): `ecer` (bawaan) | `grosir` (POS memakai
  -- products.price_grosir saat pelanggan ini dipilih di header kasir).
  tier        TEXT NOT NULL DEFAULT 'ecer' CHECK (tier IN ('ecer', 'grosir')),
  name        TEXT NOT NULL,
  phone       TEXT NOT NULL DEFAULT '',
  address     TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Supplier (pemasok barang kulakan) — baru 2026-10-11, halaman #/suppliers.
-- Lahir dari pencabutan `customers.supplier_no`: nomor `SUP-000001` yang dulu
-- menempel di tiap kontak kini menjadi `code` master ini. Dipakai Tahap 3
-- Pembelian sebagai pilihan pemasok (kolom `purchases.supplier_id` menyusul).
CREATE TABLE IF NOT EXISTS suppliers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Nomor urut OTOMATIS dari server (`SUP-000001`), pola sama dengan
  -- `customers.code`: diambil dari baris terbesar (MAX, bukan COUNT) supaya
  -- celah nomor tidak dipakai ulang; tidak pernah berubah setelah terbit.
  code        TEXT NOT NULL DEFAULT '',
  name        TEXT NOT NULL,
  phone       TEXT NOT NULL DEFAULT '',
  address     TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Pengeluaran kas operasional (Tahap 1, 2026-10-11, halaman #/expenses):
-- belanja plastik, bensin, listrik, dsb. Uang TUNAI yang keluar dari laci,
-- jadi mengurangi `kasSeharusnya()` di shift-tutup.ts (agregat `expense_total`
-- di GET /api/shifts) dan tampil di laporan harian (`expense` di
-- GET /api/reports/daily). TIDAK menyentuh `products.version` (bukan mutasi
-- stok) dan tidak masuk HPP/laba (laba = omzet − HPP, definisi lama tetap).
CREATE TABLE IF NOT EXISTS expenses (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  -- Kategori bebas (Tahap 1 tanpa master kategori: 'Listrik', 'Plastik',
  -- 'Bensin', ...). Master kategori menyusul bila daftar sudah stabil.
  kategori    TEXT NOT NULL,
  jumlah      INTEGER NOT NULL CHECK (jumlah > 0),  -- rupiah bulat, wajib > 0
  note        TEXT NOT NULL DEFAULT '',             -- maks 200 char (aturan
                                                    -- catatan, divalidasi server)
  cashier     TEXT NOT NULL DEFAULT 'kasir',
  -- Shift yang menanggung (opsional): NULL = di luar shift (mis. bayar
  -- listrik pagi sebelum buka). Hanya yang terikat shift yang mengurangi
  -- laci shift itu — yang NULL tetap tercatat + masuk laporan harian.
  shift_id    INTEGER REFERENCES shifts(id)
);
CREATE INDEX IF NOT EXISTS idx_expenses_tanggal ON expenses(created_at);
CREATE INDEX IF NOT EXISTS idx_expenses_shift ON expenses(shift_id);

-- Kas masuk non-penjualan (butir ROADMAP 1.6.2, keputusan pemilik 19 Okt
-- 2026, halaman #/kas-masuk): PASANGAN `expenses` — injeksi modal / koreksi
-- laci. Uang TUNAI yang MASUK ke laci di luar penjualan, jadi MENAMBAH
-- `kasSeharusnya()` di shift-tutup.ts (agregat `kas_masuk_total` di
-- GET /api/shifts) dan tampil di laporan harian (`kas_masuk` di
-- GET /api/reports/daily). TIDAK menyentuh `products.version` (bukan mutasi
-- stok), bukan omzet, dan tidak menggerus laba (laba = omzet − HPP).
CREATE TABLE IF NOT EXISTS kas_masuk (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  -- Kategori bebas (pola expenses): 'Injeksi modal', 'Koreksi laci', ...
  kategori    TEXT NOT NULL,
  jumlah      INTEGER NOT NULL CHECK (jumlah > 0),  -- rupiah bulat, wajib > 0
  note        TEXT NOT NULL DEFAULT '',             -- maks 200 char (aturan
                                                    -- catatan, divalidasi server)
  cashier     TEXT NOT NULL DEFAULT 'kasir',
  -- Shift yang menerima (opsional): NULL = di luar shift (mis. setor modal
  -- pagi sebelum buka). Hanya yang terikat shift yang menambah laci shift
  -- itu — yang NULL tetap tercatat + masuk laporan harian.
  shift_id    INTEGER REFERENCES shifts(id)
);
CREATE INDEX IF NOT EXISTS idx_kas_masuk_tanggal ON kas_masuk(created_at);
CREATE INDEX IF NOT EXISTS idx_kas_masuk_shift ON kas_masuk(shift_id);

-- Pesanan jasa (butir ROADMAP 1.6.6, ACC pemilik 19 Okt 2026, halaman
-- #/orders): cetak/desain/service — order dulu, dikerjakan, diambil.
-- Model uang (5 keputusan pemilik, dikonfirmasi 2026-10-19):
--   1. Omzet DIKAKUI SAAT DIAMBIL — nota penjualan penuh dibuat saat
--      pesanan diserahkan (`orders.sale_id`), DP = uang muka.
--   2. Item pesanan = teks bebas (nama+qty+harga) — stok TIDAK dipotong.
--   3. Sisa yang belum dibayar saat diambil dicatat ke ledger Hutang
--      pelanggan (`orders.hutang_sisa` = angka penanda, ledger tetap).
--   4. Pembayaran (DP & pelunasan) satu metode: tunai|qris|transfer.
--   5. Nota pesanan dicetak thermal 58mm (klien).
-- Uang tiap pembayaran terikat shift saat DITERIMA (`order_payments.shift_id`)
-- — agregat `order_masuk_total` MENAMBAH laci, dan nota pesanan dikeluarkan
-- dari hitungan laci lewat `order_omzet_total` (uangnya sudah dicatat di
-- pembayaran; lihat kasSeharusnya() shift-tutup.ts).
CREATE TABLE IF NOT EXISTS orders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Nomor OTOMATIS `ORD-YYMMDD-NNN` (urut harian UTC, pola invoice_no).
  order_no      TEXT UNIQUE,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  customer_id   INTEGER NOT NULL REFERENCES customers(id),
  customer_name TEXT NOT NULL DEFAULT '',   -- snapshot (pola sales.customer_name)
  status        TEXT NOT NULL DEFAULT 'dikerjakan'
                CHECK (status IN ('dikerjakan', 'selesai', 'diambil', 'batal')),
  total         INTEGER NOT NULL DEFAULT 0 CHECK (total >= 0),
  note          TEXT NOT NULL DEFAULT '',   -- maks 200 char (aturan catatan)
  cashier       TEXT NOT NULL DEFAULT 'kasir',
  -- Diisi saat status -> 'diambil': waktu penyerahan, nota penjualan yang
  -- terbit (TANPA FK — sales dibuat di transaction yang sama, kolom ini
  -- hanya jembatan; query laci ikut lewat kolom ini), dan sisa yang
  -- dicatat ke Hutang pelanggan.
  taken_at      TEXT,
  sale_id       TEXT,
  hutang_sisa   INTEGER NOT NULL DEFAULT 0,
  -- Diisi saat status -> 'batal' (koreksi sebelum diambil; DP dikembalikan
  -- lewat baris order_payments kind='refund').
  batal_at      TEXT,
  batal_note    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, id DESC);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_sale ON orders(sale_id);

-- Baris item pesanan — TEKS BEBAS (keputusan pemilik: tanpa potong stok).
CREATE TABLE IF NOT EXISTS order_items (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  name     TEXT NOT NULL,
  qty      REAL NOT NULL CHECK (qty > 0),
  price    INTEGER NOT NULL CHECK (price >= 0),
  amount   INTEGER NOT NULL,   -- round(qty * price), DI-SNAPSHOT
  note     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

-- Pembayaran pesanan — SATU ledger uang untuk pesanan (DP, pelunasan saat
-- diambil, refund saat batal). `amount` SELALU positif; `kind='refund'`
-- artinya uang KELUAR (mengurangi agregat order_masuk_total di GET
-- /api/shifts). `shift_id` opsional (pola expenses): hanya yang terikat
-- shift yang menggerakkan laci shift itu.
CREATE TABLE IF NOT EXISTS order_payments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  kind       TEXT NOT NULL CHECK (kind IN ('dp', 'pelunasan', 'refund')),
  method     TEXT NOT NULL,      -- tunai | qris | transfer
  amount     INTEGER NOT NULL CHECK (amount > 0),
  shift_id   INTEGER REFERENCES shifts(id),
  cashier    TEXT NOT NULL DEFAULT 'kasir',
  note       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_order_payments_order ON order_payments(order_id);
CREATE INDEX IF NOT EXISTS idx_order_payments_shift ON order_payments(shift_id);

-- Ledger hutang per pelanggan — SATU tabel mutasi dua arah, bukan saldo tersimpan.
-- type 'charge'  = pelanggan berhutang (beli belum bayar)
-- type 'payment' = pembayaran pelanggan
-- saldo = SUM(charge) - SUM(payment), selalu dihitung ulang oleh server —
-- angka saldo yang disimpan akan selisih begitu salah satu baris diedit/dihapus.
CREATE TABLE IF NOT EXISTS customer_debts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  type        TEXT NOT NULL CHECK (type IN ('charge', 'payment')),
  amount      INTEGER NOT NULL CHECK (amount > 0),
  note        TEXT NOT NULL DEFAULT '',
  -- Atribusi laci (Paket A, 2026-10-20): pembayaran piutang dicatat pada
  -- shift yang sedang terbuka saat kasir menerima uang. Baris lama tetap
  -- `shift_id NULL` + `cashier ''` dan dibaca lewat fallback periode waktu
  -- di GET /api/shifts (lihat AGENTS §3); baris BARU selalu menyimpan
  -- cashier non-kosong sehingga pembayaran di luar shift tidak pernah
  -- jatuh ke laporan shift lain.
  shift_id    INTEGER REFERENCES shifts(id),
  cashier     TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_customer_debts_customer
  ON customer_debts(customer_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_customer_debts_shift
  ON customer_debts(shift_id);

-- Akun & peran (login, 2026-10-11): 2 role, `owner` (semua) dan `kasir`
-- (POS + Riwayat + Stok + Pelanggan + Hutang + Retur + shift sendiri).
-- password_hash format `saltHex:hashHex` (scrypt node:crypto bawaan, tanpa
-- dep baru — lihat hashPassword()/verifyPassword() di apps/api/src/db.ts).
-- must_change=1 = wajib ganti sandi saat login pertama (akun seed + reset
-- pemilik). Sessions: token acak 32 byte, kedaluwarsa 30 hari; logout =
-- hapus baris. Display `name` dipakai sebagai nama kasir di shift/laporan.
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('owner', 'kasir')),
  -- Avatar OPSIONAL: nama file di folder img/ sebelah DB (pola products.image),
  -- di-resize client (sisi terpanjang <=256px JPEG). NULL/'' = pakai inisial
  -- nama (atau /avatar.png bawaan). Diunggah lewat POST /api/users/me/avatar.
  avatar        TEXT,
  -- Email opsional profil (belum dipakai kirim email — hanya identitas).
  email         TEXT NOT NULL DEFAULT '',
  is_active     INTEGER NOT NULL DEFAULT 1,
  must_change   INTEGER NOT NULL DEFAULT 0,
  -- Izin operasional per akun (Paket B, 2026-10-20): JSON array kunci izin
  -- (lihat IZIN_OPERASIONAL di apps/api/src/index.ts). NULL = default role;
  -- [] = valid (tidak punya izin operasional). Izin core owner TIDAK masuk
  -- kolom ini — selalu dijaga hanyaOwner.
  permissions   TEXT,
  -- PIN 6 digit untuk kunci layar/quick switch (Paket B5). Hash scrypt
  -- format salt:hash (hashPassword) — plaintext/PIN TIDAK PERNAH dikirim.
  pin_hash      TEXT,
  pin_failed    INTEGER NOT NULL DEFAULT 0,
  pin_locked_until TEXT,
  pin_updated_at TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Jejak audit (2026-10-16, halaman #/audit khusus owner): "siapa mengubah
-- apa" untuk mutasi yang RISIKO-nya tidak terlihat dari tabel aslinya —
-- master (produk/kategori/satuan/pelanggan/supplier/pengguna/setting),
-- stok (restock/opname), koreksi dokumen uang (pengeluaran/piutang/retur
-- dibatalkan), restore backup, dan login. Penjualan/topup/pembelian TIDAK
-- dicatat di sini: nota-nota itu sudah tabelnya sendiri (tidak ada induk
-- ganda). Ditulis lewat helper catatAudit() di index.ts — gagal tulis audit
-- TIDAK PERNAH menggagalkan operasi aslinya (audit = metadata, bukan
-- transaksi). Baris audit boleh dipangkas manual bila sudah terlalu tua;
-- tidak ada endpoint hapus (jejak yang bisa dihapus dari UI bukan jejak).
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL DEFAULT (datetime('now')),
  -- Aktor: user_id NULL = bukan sesi login (mis. percobaan login gagal).
  -- username/role disalin (snapshot) supaya jejak tetap terbaca walau akun
  -- kelak dihapus/di-rename — pola snapshot sale_items.name.
  user_id     INTEGER,
  username    TEXT NOT NULL DEFAULT '',
  role        TEXT NOT NULL DEFAULT '',
  action      TEXT NOT NULL,            -- create|update|delete|restock|opname|import|restore|login|login-gagal
  entity      TEXT NOT NULL,            -- product|category|unit|customer|supplier|user|setting|stock|expense|debt|return|backup|session
  entity_id   TEXT NOT NULL DEFAULT '',
  detail      TEXT NOT NULL DEFAULT ''  -- ringkasan singkat (JSON/teks, dipotong 500 char oleh server)
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at, id);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, id DESC);
