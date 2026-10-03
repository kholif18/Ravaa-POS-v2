-- Seed master awal. Dijalankan via apps/api/src/seed.ts (jangan sqlite3 manual di prod).
-- `use_expiry` = tampilkan field "Tanggal kadaluarsa" di form produk kategori tsb
-- (pengganti hardcode snack/eskrim — bisa diubah pemilik lewat form Kategori).
INSERT OR IGNORE INTO categories (slug, name, track_stock, sort, use_expiry) VALUES
  ('atk',    'ATK',            1, 10, 0),
  ('cetak',  'Cetak',          0, 20, 0),
  ('desain', 'Desain',         0, 30, 0),
  ('jasa',   'Jasa Ketik & Service', 0, 40, 0),
  ('topup',  'Topup & Tarik Tunai',  0, 50, 0),
  ('eskrim', 'Es Krim & Minuman',    1, 60, 1),
  ('snack',  'Snack',          1, 70, 1),
  ('rokok',  'Rokok',          1, 80, 0);

-- Master satuan (WAJIB sebelum produk: products.unit REFERENCES units(slug)).
-- '-' dipakai produk tanpa satuan (shortcut topup/tarik) -> ditampilkan kosong di UI.
INSERT OR IGNORE INTO units (slug, name) VALUES
  ('pcs',     'Pcs'           ),
  ('lembar',  'Lembar'        ),
  ('btl',     'Botol'         ),
  ('halaman', 'Halaman'       ),
  ('bungkus', 'Bungkus'       ),
  ('batang',  'Batang'        ),
  ('box',     'Box'           ),
  ('pack',    'Pack'          ),
  ('lusin',   'Lusin'         ),
  ('rim',     'Rim'           ),
  ('set',     'Set'           ),
  ('item',    'Item'          ),
  ('-',       'Tanpa satuan'  );

-- ATK
INSERT OR IGNORE INTO products (category_id, sku, barcode, name, unit, price, cost, markup, avg_cost, stock, min_stock)
SELECT c.id, 'PRD00001', NULL, 'Pulpen Hitam', 'pcs', 3000, 2100, 42.86, 2100, 50, 10 FROM categories c WHERE c.slug='atk'
UNION ALL SELECT c.id, 'PRD00002', NULL, 'Buku Tulis', 'pcs', 6000, 4200, 42.86, 4200, 30, 5 FROM categories c WHERE c.slug='atk';

-- Cetak (harga per lembar, stok tidak dilacak)
INSERT OR IGNORE INTO products (category_id, sku, name, unit, price, cost, avg_cost, markup)
SELECT c.id, 'PRD00003', 'Print BW A4 /lembar', 'lembar', 1000, 300, 300, 233.33 FROM categories c WHERE c.slug='cetak'
UNION ALL SELECT c.id, 'PRD00004', 'Print Warna A4 /lembar', 'lembar', 2000, 800, 800, 150 FROM categories c WHERE c.slug='cetak'
UNION ALL SELECT c.id, 'PRD00005', 'Cetak Foto 4R /lembar', 'lembar', 5000, 2000, 2000, 150 FROM categories c WHERE c.slug='cetak'
UNION ALL SELECT c.id, 'PRD00006', 'Laminating /lembar', 'lembar', 5000, 1500, 1500, 233.33 FROM categories c WHERE c.slug='cetak'
UNION ALL SELECT c.id, 'PRD00007', 'Fotokopi /lembar', 'lembar', 500, 150, 150, 233.33 FROM categories c WHERE c.slug='cetak';

-- Desain & jasa (harga dinamis)
INSERT OR IGNORE INTO products (category_id, sku, name, unit, price, price_dynamic)
SELECT c.id, 'PRD00008', 'Jasa Desain (logo/banner/undangan)', 'item', 0, 1 FROM categories c WHERE c.slug='desain'
UNION ALL SELECT c.id, 'PRD00009', 'Jasa Ketik /halaman', 'halaman', 3000, 0 FROM categories c WHERE c.slug='jasa'
UNION ALL SELECT c.id, 'PRD00010', 'Service Laptop/PC ringan (install/cleaning)', 'item', 0, 1 FROM categories c WHERE c.slug='jasa'
UNION ALL SELECT c.id, 'PRD00011', 'Service Laptop/PC berat (hardware)', 'item', 0, 1 FROM categories c WHERE c.slug='jasa';

-- Es krim & minuman
INSERT OR IGNORE INTO products (category_id, sku, name, unit, price, cost, avg_cost, markup, stock, min_stock)
SELECT c.id, 'PRD00012', 'Es Walls Magnum', 'pcs', 12000, 8500, 8500, 41.18, 20, 5 FROM categories c WHERE c.slug='eskrim'
UNION ALL SELECT c.id, 'PRD00013', 'Aqua 600ml', 'btl', 4000, 3000, 3000, 33.33, 24, 6 FROM categories c WHERE c.slug='eskrim';

-- Snack
INSERT OR IGNORE INTO products (category_id, sku, name, unit, price, cost, avg_cost, markup, stock, min_stock)
SELECT c.id, 'PRD00014', 'Chitato Sapi Panggang', 'pcs', 11000, 8500, 8500, 29.41, 15, 5 FROM categories c WHERE c.slug='snack';

-- Rokok: bungkus & ketengan SKU terpisah
INSERT OR IGNORE INTO products (category_id, sku, name, unit, price, cost, avg_cost, markup, stock, min_stock)
SELECT c.id, 'PRD00015', 'Sampoerna Mild 12 (bungkus)', 'bungkus', 28000, 25000, 25000, 12, 10, 2 FROM categories c WHERE c.slug='rokok'
UNION ALL SELECT c.id, 'PRD00016', 'Sampoerna Mild (keteng/batang)', 'batang', 3000, 2700, 2700, 11.11, 0, 0 FROM categories c WHERE c.slug='rokok';

-- Topup: placeholder harga dinamis (nominal diisi saat transaksi)
INSERT OR IGNORE INTO products (category_id, sku, name, unit, price, price_dynamic)
SELECT c.id, 'PRD00017', 'Topup e-wallet / Pulsa / PLN (nominal bebas)', '-', 0, 1 FROM categories c WHERE c.slug='topup'
UNION ALL SELECT c.id, 'PRD00018', 'Tarik tunai (nominal bebas)', '-', 0, 1 FROM categories c WHERE c.slug='topup';

-- Pengaturan default. '0' = stok TIDAK boleh minus (penjualan melebihi stok
-- ditolak 400 — perilaku asli repo); pemilik mengubahnya lewat halaman #/settings.
-- '0' kedua = barang kadaluarsa MASIH boleh terjual (hanya strip/badge visual di
-- POS); '1' = POST /api/sales menolak baris yang expiry_date-nya sudah lewat.
-- INSERT OR IGNORE: seed ulang tidak mereset pilihan yang sudah diubah pemilik.
INSERT OR IGNORE INTO settings (key, value) VALUES ('allow_negative_stock', '0');
INSERT OR IGNORE INTO settings (key, value) VALUES ('tolak_jual_kadaluarsa', '0');

-- Kop INVOICE A4 (cetak gaya Aronium, sejak 2026-10-03) — disimpan DI SERVER
-- (bukan localStorage) supaya semua device mencetak kop yang sama. Default
-- diisi dari contoh pemilik (invoice Aronium "RAVAA STUDIO"); pemilik
-- mengubahnya lewat kartu "Pengaturan toko" di halaman #/settings.
INSERT OR IGNORE INTO settings (key, value) VALUES ('store_name', 'RAVAA STUDIO');
INSERT OR IGNORE INTO settings (key, value) VALUES ('store_address', 'Gedong, Ds. Ngluyu Kec. Ngluyu, 64452 NGANJUK');
INSERT OR IGNORE INTO settings (key, value) VALUES ('store_phone', '082233377661');
INSERT OR IGNORE INTO settings (key, value) VALUES ('store_email', 'ravaastudio@gmail.com');
