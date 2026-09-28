-- Seed master awal. Dijalankan via apps/api/src/seed.ts (jangan sqlite3 manual di prod).
INSERT OR IGNORE INTO categories (slug, name, track_stock, sort) VALUES
  ('atk',    'ATK',            1, 10),
  ('cetak',  'Cetak',          0, 20),
  ('desain', 'Desain',         0, 30),
  ('jasa',   'Jasa Ketik & Service', 0, 40),
  ('topup',  'Topup & Tarik Tunai',  0, 50),
  ('eskrim', 'Es Krim & Minuman',    1, 60),
  ('snack',  'Snack',          1, 70),
  ('rokok',  'Rokok',          1, 80);

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
SELECT c.id, 'ATK-PULPEN-HITAM', NULL, 'Pulpen Hitam', 'pcs', 3000, 2100, 42.86, 2100, 50, 10 FROM categories c WHERE c.slug='atk'
UNION ALL SELECT c.id, 'ATK-BUKU-TULIS', NULL, 'Buku Tulis', 'pcs', 6000, 4200, 42.86, 4200, 30, 5 FROM categories c WHERE c.slug='atk';

-- Cetak (harga per lembar, stok tidak dilacak)
INSERT OR IGNORE INTO products (category_id, sku, name, unit, price, cost, avg_cost, markup)
SELECT c.id, 'CETAK-BW-A4', 'Print BW A4 /lembar', 'lembar', 1000, 300, 300, 233.33 FROM categories c WHERE c.slug='cetak'
UNION ALL SELECT c.id, 'CETAK-WARNA-A4', 'Print Warna A4 /lembar', 'lembar', 2000, 800, 800, 150 FROM categories c WHERE c.slug='cetak'
UNION ALL SELECT c.id, 'CETAK-FOTO-4R', 'Cetak Foto 4R /lembar', 'lembar', 5000, 2000, 2000, 150 FROM categories c WHERE c.slug='cetak'
UNION ALL SELECT c.id, 'CETAK-LAMINATING', 'Laminating /lembar', 'lembar', 5000, 1500, 1500, 233.33 FROM categories c WHERE c.slug='cetak'
UNION ALL SELECT c.id, 'CETAK-FOTOKOPI', 'Fotokopi /lembar', 'lembar', 500, 150, 150, 233.33 FROM categories c WHERE c.slug='cetak';

-- Desain & jasa (harga dinamis)
INSERT OR IGNORE INTO products (category_id, sku, name, unit, price, price_dynamic)
SELECT c.id, 'DESAIN-LOGO', 'Jasa Desain (logo/banner/undangan)', 'item', 0, 1 FROM categories c WHERE c.slug='desain'
UNION ALL SELECT c.id, 'JASA-KETIK', 'Jasa Ketik /halaman', 'halaman', 3000, 0 FROM categories c WHERE c.slug='jasa'
UNION ALL SELECT c.id, 'JASA-SERVICE-RINGAN', 'Service Laptop/PC ringan (install/cleaning)', 'item', 0, 1 FROM categories c WHERE c.slug='jasa'
UNION ALL SELECT c.id, 'JASA-SERVICE-BERAT', 'Service Laptop/PC berat (hardware)', 'item', 0, 1 FROM categories c WHERE c.slug='jasa';

-- Es krim & minuman
INSERT OR IGNORE INTO products (category_id, sku, name, unit, price, cost, avg_cost, markup, stock, min_stock)
SELECT c.id, 'ES-WALLS-MAGNUM', 'Es Walls Magnum', 'pcs', 12000, 8500, 8500, 41.18, 20, 5 FROM categories c WHERE c.slug='eskrim'
UNION ALL SELECT c.id, 'MINUM-AQUA-600', 'Aqua 600ml', 'btl', 4000, 3000, 3000, 33.33, 24, 6 FROM categories c WHERE c.slug='eskrim';

-- Snack
INSERT OR IGNORE INTO products (category_id, sku, name, unit, price, cost, avg_cost, markup, stock, min_stock)
SELECT c.id, 'SNK-CHITATO-SAPI', 'Chitato Sapi Panggang', 'pcs', 11000, 8500, 8500, 29.41, 15, 5 FROM categories c WHERE c.slug='snack';

-- Rokok: bungkus & ketengan SKU terpisah
INSERT OR IGNORE INTO products (category_id, sku, name, unit, price, cost, avg_cost, markup, stock, min_stock)
SELECT c.id, 'RK-SMP-12', 'Sampoerna Mild 12 (bungkus)', 'bungkus', 28000, 25000, 25000, 12, 10, 2 FROM categories c WHERE c.slug='rokok'
UNION ALL SELECT c.id, 'RK-SMP-KETENG', 'Sampoerna Mild (keteng/batang)', 'batang', 3000, 2700, 2700, 11.11, 0, 0 FROM categories c WHERE c.slug='rokok';

-- Topup: placeholder harga dinamis (nominal diisi saat transaksi)
INSERT OR IGNORE INTO products (category_id, sku, name, unit, price, price_dynamic)
SELECT c.id, 'TOPUP-ALL', 'Topup e-wallet / Pulsa / PLN (nominal bebas)', '-', 0, 1 FROM categories c WHERE c.slug='topup'
UNION ALL SELECT c.id, 'TARIK-TUNAI', 'Tarik tunai (nominal bebas)', '-', 0, 1 FROM categories c WHERE c.slug='topup';
