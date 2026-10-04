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
  pay_method  TEXT NOT NULL DEFAULT 'tunai', -- tunai | qris | transfer
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
  customer_name TEXT NOT NULL DEFAULT ''
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

-- Topup & tarik tunai: nominal bebas + admin editable.
-- nominal = mutasi modal/e-money, admin = pendapatan jasa.
CREATE TABLE IF NOT EXISTS topup_txns (
  id          TEXT PRIMARY KEY,        -- uuid dari client
  shift_id    INTEGER REFERENCES shifts(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  kind        TEXT NOT NULL,           -- topup | tarik
  provider    TEXT NOT NULL,           -- jenis layanan: E-WALLET | PULSA | PLN-TOKEN | PLN-BILL | TARIK-EWALLET | TARIK-BANK
  nomor       TEXT NOT NULL,           -- no HP / no pelanggan
  nominal     INTEGER NOT NULL,        -- nilai isi/tarik
  admin       INTEGER NOT NULL DEFAULT 0, -- biaya admin (pendapatan)
  total       INTEGER NOT NULL,        -- nominal + admin (yang dibayar pelanggan)
  pay_method  TEXT NOT NULL DEFAULT 'tunai',
  cashier     TEXT NOT NULL DEFAULT 'kasir'
);

CREATE TABLE IF NOT EXISTS stock_moves (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  product_id  INTEGER NOT NULL REFERENCES products(id),
  qty         REAL NOT NULL,           -- +masuk / -keluar
  reason      TEXT NOT NULL,           -- sale | restock | opname | rusak
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
CREATE TABLE IF NOT EXISTS customers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Nomor urut OTOMATIS dari server (revisi pemilik 2026-10-04): `CUS-000001`
  -- untuk no customer, `SUP-000001` untuk no supplier (master supplier belum
  -- ada — disimpan di kontak dulu, halaman Supplier menyusul). Kosong = baris
  -- lama; server mengisinya saat pertama kali baris disimpan ulang.
  code        TEXT NOT NULL DEFAULT '',
  supplier_no TEXT NOT NULL DEFAULT '',
  name        TEXT NOT NULL,
  phone       TEXT NOT NULL DEFAULT '',
  address     TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

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
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_customer_debts_customer
  ON customer_debts(customer_id, created_at, id);
