-- Seed MINIMAL untuk PRODUCTION (branch main).
-- Hanya: units (wajib FK products), settings (default aman), users (via db.ts seedDefaultUser).
-- Kategori, produk, pelanggan, supplier, topup-services, dll = KOSONG.
-- Isi master data lewat UI (#/categories, #/units, #/products, #/customers, #/suppliers) atau import CSV.

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

-- Pengaturan default. '0' = stok TIDAK boleh minus (penjualan melebihi stok
-- ditolak 400 — perilaku asli repo); pemilik mengubahnya lewat halaman #/settings.
-- '0' kedua = barang kadaluarsa MASIH boleh terjual (hanya strip/badge visual di
-- POS); '1' = POST /api/sales menolak baris yang expiry_date-nya sudah lewat.
-- INSERT OR IGNORE: seed ulang tidak mereset pilihan yang sudah diubah pemilik.
INSERT OR IGNORE INTO settings (key, value) VALUES ('allow_negative_stock', '0');
INSERT OR IGNORE INTO settings (key, value) VALUES ('tolak_jual_kadaluarsa', '0');

-- Opsi dokumen & struk (riset Aronium 2026-10-20). INSERT OR IGNORE membuat
-- seed ulang tidak menimpa pilihan pemilik. Default = perilaku lama KECUALI
-- jumlah item + total hutang pelanggan (dua fitur baru, default menyala).
-- invoice_footer kosong: baris "Dicetak melalui Ravaa POS pada: <tanggal>" selalu dicetak
-- builder dokumen A4 (permintaan pemilik 2026-10-21).
INSERT OR IGNORE INTO settings (key, value) VALUES ('invoice_title', 'INVOICE');
INSERT OR IGNORE INTO settings (key, value) VALUES ('invoice_footer', '');
INSERT OR IGNORE INTO settings (key, value) VALUES ('receipt_footer', 'Terima kasih sudah berbelanja');
INSERT OR IGNORE INTO settings (key, value) VALUES ('receipt_customer', 'name');
INSERT OR IGNORE INTO settings (key, value) VALUES ('receipt_show_items', '1');
INSERT OR IGNORE INTO settings (key, value) VALUES ('receipt_short_no', '0');
INSERT OR IGNORE INTO settings (key, value) VALUES ('receipt_show_debt', '1');

-- Kop INVOICE A4 (cetak gaya Aronium, sejak 2026-10-03) — disimpan DI SERVER
-- (bukan localStorage) supaya semua device mencetak kop yang sama. Default
-- KOSONG; pemilik mengisinya lewat kartu "Pengaturan toko" di halaman #/settings.
INSERT OR IGNORE INTO settings (key, value) VALUES ('store_name', '');
INSERT OR IGNORE INTO settings (key, value) VALUES ('store_address', '');
INSERT OR IGNORE INTO settings (key, value) VALUES ('store_phone', '');
INSERT OR IGNORE INTO settings (key, value) VALUES ('store_email', '');
INSERT OR IGNORE INTO settings (key, value) VALUES ('store_logo', '');