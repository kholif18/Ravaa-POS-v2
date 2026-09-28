# Ravaa POS v2

Kasir sederhana untuk toko: ATK, Cetak, Desain, Jasa (ketik & service Laptop/PC),
Topup e-wallet / Tarik tunai, Es krim, Minuman, Snack, Rokok.

Desain: **1–2 kasir bersamaan (umumnya 1 aktif)** + fallback HP Android, database terpusat di home server,
frontend SPA cepat (tanpa reload), printer thermal 58mm ESC/POS via print-agent.

## Struktur

```
ravaaposv2/
  apps/api/          # API Hono + SQLite (jalan di home server :3001)
  apps/web/          # SPA kasir Vite+TS, PWA (jalan di home server :5656 / dibuka dari PC & HP)
  apps/print-agent/  # Bridge HTTP->USB printer 58mm (jalan di PC kasir :9100, tanpa deps)
  db/                # schema.sql + seed.sql (sumber kebenaran skema)
  infra/             # docker-compose + Caddy untuk home server
  .opencode/agents/AGENTS.md   # panduan AI agent
  .opencode/skills/  # ravaa-pos + antislop + frontend-pos
```

## Jalankan (dev, tanpa Docker)

```bash
cd ~/Projects/ravaaposv2
npm install
npm run seed        # buat data.db + data master
npm run dev         # api :3001 + web :5656 sekaligus (Ctrl+C mematikan keduanya)
# atau terpisah: npm run dev:api  |  npm run dev:web
# di PC kasir (untuk struk USB):
npm run dev:agent   # :9100
npm test            # regresi penuh (butuh api :3001 + web :5656 sudah jalan)
```

> Selama dev di PC: setiap perubahan **master** (kategori/produk/harga) wajib
> dituangkan juga ke `db/seed.sql` agar STB baru nanti mulai dari master yang sama.
> Data transaksi dev (di `apps/api/data/data.db`) tidak ikut pindah — jangan
> dicopy ke server produksi kecuali disengaja.

## Jalankan (home server STB/ARM, native tanpa Docker — hemat RAM/disk)

```bash
# di server, dari folder repo:
sh infra/deploy-native.sh
# skrip: cek/install Node 22 arm64 bila perlu, npm install, build web, seed,
# pasang systemd user service ravaa-api (DB di ~/ravaa-data/data.db)
systemctl --user status ravaa-api
curl localhost:3001/health
# web: sudo apt install -y caddy && sudo cp infra/Caddyfile.server /etc/caddy/Caddyfile && sudo systemctl reload caddy
# buka http://<ip-server>:5656 dari PC/HP sek jaringan
```

## Jalankan (home server, Docker — bila spek longgar)

```bash
cd ~/Projects/ravaaposv2/infra
cp ../apps/api/.env.example ../apps/api/.env  # atau set ENV di compose
docker compose up -d --build
# web: http://<ip-server>:5656, api: http://<ip-server>:3001
```

Backup DB (SQLite file): copy `apps/api/data/data.db` tiap hari via cron.

## Aturan main

* Master (kategori/produk/harga) hanya diubah via API server, client hanya cache.
  Kategori di-CRUD dari **sidebar Kategori di halaman Produk** (slug tak bisa
  diganti; hapus ditolak bila masih ada produk). Kategori baru dari UI dev wajib
  dituangkan juga ke `db/seed.sql` agar STB baru mulai dari master yang sama.
* **Master satuan** (`#/satuan`, menu sidebar): CRUD satuan struk (pcs, lembar,
  dus, ...). Tambah/ubah/hapus lewat UI; `slug` diturunkan otomatis dari nama dan
  terkunci setelah dibuat; satuan yang masih dipakai produk tidak bisa dihapus
  (server menolak dengan 400). Jumlah "Dipakai" dihitung server, jadi dialog hapus
  tidak pernah bilang "tidak dipakai" padahal ada produknya. Urutan tampil mengikuti
  alfabetis nama. Seed: 13 satuan, termasuk `Tanpa satuan` untuk shortcut topup/tarik.
* **Form produk** (`#/products` -> Tambah/Edit) mengikuti layout Aronium: dua
  seksi — **Detail produk** (nama, SKU, barcode, kategori, satuan) dan **Harga**
  (harga beli, markup %, harga jual) — lalu blok **Stok** yang hanya muncul kalau
  kategori pilihan itu `track_stock=1`. Price change allowed ditulis "Boleh ubah
  harga saat jual" (switch, bukan checkbox kotak). `cost` + `markup` + `price`
  disimpan semua: mengubah `cost`/`markup` menghitung ulang `price` (dibulatkan
  ke ratusan), mengubah `price` menghitung ulang `markup`. Satuan dipilih dari
  master (dropdown `GET /api/units`), bukan diketik bebas — jadi tidak ada lagi
  "pcs" vs "Pcs" untuk produk yang sama; satuan yang tak dikenal ditolak 400.
  Produk baru default ke `pcs` (kalau `pcs` tak ada di master, ke satuan pertama).
  **SKU boleh kosong** —
  server menurunkan dari nama dan menjamin unik (`Kopi Kapal Api Sachet` ->
  `KOPI-KAPAL-API-SACHET`, nama kembar -> `...-2`), jadi dua produk tidak mungkin
  diam-diam saling menimpa.
* Layar kasir (`#/pos`) **tidak memakai grid produk**. Satu input scan/ketik
  (barcode persis → SKU persis → nama mengandung) dengan dropdown hasil: ArrowUp /
  ArrowDown menyorot, Enter atau klik memasukkan ke keranjang, Escape menutup.
  Mode: **Penjualan / Topup / Tarik** (bar yang sama). Topup-tarik memakai
  `POST /api/topups`; admin terisi otomatis dari tier toko yang sama dengan
  `GET /api/topups/suggest-admin`, dan bisa diedit kasir.
* Tiap device kasir pakai **nama kasir berbeda** dan buka **shift sendiri**
  (1 shift terbuka per kasir, ditegakkan DB). Laporan harian menggabungkan semua shift.
* Stok hanya untuk barang fisik (ATK, es krim/minuman/snack, rokok). Jasa/topup/cetak/desain `stock_track=0`.
* Topup/tarik tunai: nominal bebas + admin editable per transaksi. Nominal = mutasi modal, admin = pendapatan jasa.
  **Tanpa pilih provider** — kasir cuma memilih *jenis* (satu klik), nama brand
  (DANA/OVO/GoPay/BCA/…) tidak pernah jadi pilihan. Kolom `provider` di
  `topup_txns` diisi **kode jenis**:
  | Mode | Jenis | `provider` | Isian nomor |
  | --- | --- | --- | --- |
  | Topup | E-wallet | `E-WALLET` | nomor HP tujuan |
  | Topup | Pulsa | `PULSA` | nomor HP tujuan |
  | Topup | Token PLN | `PLN-TOKEN` | nomor meter |
  | Topup | Tagihan PLN | `PLN-BILL` | ID pelanggan / meter |
  | Tarik | Dari e-wallet (cash out) | `TARIK-EWALLET` | nomor HP pemilik e-wallet |
  | Tarik | Dari rekening | `TARIK-BANK` | nomor rekening |
  Kontrak `POST /api/topups` tidak berubah — `provider` tetap TEXT non-kosong,
  hanya maknanya yang jadi kode jenis. Putar `GET /api/reports/daily` untuk
  memecah omzet per jenis.
* Produk kategori **`topup`** (`TOPUP-ALL`, `TARIK-TUNAI`) **bukan item jual**:
  scan/ketik/klik produk itu membuka mode topup atau tarik, tidak pernah masuk
  keranjang. Alasannya satu produk hanya punya satu harga, sedangkan topup butuh
  dua angka (`nominal` + `admin`); kalau jadi `sale_item`, `SUM(sales.total)`
  ikut ditambah dan omzet jadi lebih besar dari kenyataan.
* Rokok: SKU per-bungkus dan ketengan terpisah.
* Produk punya status **aktif / nonaktif**. Nonaktif disembunyikan dari kasir; bisa
  diaktifkan kembali dari halaman Products (filter status **Nonaktif**).
* **Hapus produk** (tombol tong sampah di tiap baris) berbeda dari nonaktifkan:
  - Hapus = **soft delete**: barisnya tetap ada di DB (kolom `deleted_at` terisi)
    tapi hilang permanen dari daftar, dari POS, dan dari laporan baru. Dipakai
    untuk buang produk salah input / sisa uji.
  - Nonaktifkan = disembunyikan sementara, bisa diaktifkan lagi.
  - **Guard (aturan Aronium)**: produk yang pernah terjual tidak bisa dihapus —
    server balas `400` dengan pesan `produk ini sudah pernah terjual (N baris
    penjualan) — riwayatnya harus utuh, jadi pakai nonaktifkan saja`. Alasannya
    `sale_items` tetap harus merujuk produk yang valid, jadi riwayat penjualan
    lama tidak boleh kehilangan barisnya.
* **Kenapa hapusnya tombstone, bukan `DELETE` keras?** Delta sync kasir hanya
  mengirim `version > since` dan `syncMaster()` hanya *merge* per SKU — kalau baris
  benar-benar dihapus, kasir tidak pernah menerima apa-apa dan produk mati nempel
  selamanya di cache IndexedDB. Dengan `deleted_at` + `version++`, tombstone ikut
  terkirim lewat `?since=` dan `syncMaster()` membuangnya. Jangan menghapus baris
  tombstone dari DB selama masih ada device kasir yang belum sinkron.
* **Cetak label harga** (tombol **Label** di toolbar): mencetak label untuk
  produk di **filter saat ini** — saring dulu lewat kolom cari kalau hanya mau
  sebagian ("Aqua" -> 1 label). Dialog menampilkan jumlah, daftar, dan pratinjau
  label lebar **32 kolom** sebelum dikirim; tombol cetak otomatis mati kalau
  print-agent tidak terjangkau.
  - Byte dibuat `apps/web/src/escpos.ts` (ESC/POS: INIT -> nama/SKU bold ->
    harga **2x2** -> barcode -> FEED -> CUT per label), lalu POST ke print-agent.
  - Barcode: **EAN13 / UPC-A / EAN8** (digit saja) dikirim sebagai barcode
    asli; selain itu dicetak sebagai angka biasa — sengaja, salah byte CODE128
    = label yang tidak bisa discan diam-diam.
  - Tanpa printer, print-agent menyimpan ke `apps/print-agent/out/*.bin`
    (bisa dicek/CUPS-kan manual), jadi alur ini bisa diuji tanpa hardware.
* **Cetak struk otomatis** (saklar **Cetak struk otomatis** pada baris **Mode**,
  tampil di semua mode): setiap penjualan dan topup/tarik mengirim struk ke
  print-agent **sebelum** keranjang/state direset.
  - Struk disusun `struk()` di `apps/web/src/escpos.ts` — INIT -> nama toko
    (bold, rata tengah) -> tanggal/no transaksi/kasir/shift -> garis 32 kolom ->
    item (`qty x nama` + line total) -> Subtotal/Diskon/**TOTAL** (bold)/Tunai/
    Kembalian -> kaki -> FEED -> CUT.
  - **Setiap baris diakhiri LF**; tanpa LF seluruh struk menempel jadi satu baris
    memanjang (firmware thermal memisah baris dengan LF, bukan FEED). Semua baris
    dijamin <= 32 kolom, dan kolom uang (14) selalu menempel di tepi kanan supaya
    nama barang panjang tidak menelannya.
  - Struk topup/tarik memakai blok yang sama **tanpa** baris item — jadi tidak ada
    `(tanpa item)` dan tidak ada garis ganda.
  - Nama toko diambil dari **Pengaturan Akun** (`ravaa.toko`, bawaan `RAVA POS`
    = merk aplikasi, bukan nama toko sungguhan — ganti sekali di situ).
  - Saklar disimpan di `ravaa.cetak` (bawaan **nyala**). **Gagal cetak tidak
    membatalkan penjualan**: uang sudah tercatat, hanya kertasnya belum keluar;
    toast peringatan muncul sekali per sesi agar tidak membanjiri layar kasir.
* **Stok & opname** (ikon truk di tiap baris produk, kategori yang dilacak
  stok) kini satu dialog dengan dua mode:
  - **Masuk barang** = restock lama: menambah `qty`, minimal 1.
  - **Hitung fisik** = opname: menulis jumlah HASIL HITUNG apa adanya, termasuk
    `0` (barang habis/rusak). Hint menampilkan **selisih live** sebelum disimpan
    (`Stok tercatat: 57 · selisih -5 -> stok jadi 52`), dan toast melaporkan
    `57 -> 52 (-5)`. Angka input mengikuti mode (`1` untuk masuk, stok tercatat
    untuk hitung fisik) supaya angka tidak berpindah mode dengan arti berbeda.
  - Riwayat masuk ke `stock_moves` dengan `reason='opname'` dan `qty` = selisih.
* **HPP & laba (modal rata-rata)** — menutup celah "HPP rata-rata" di bawah.
  - Restock kini menerima **`harga_beli`** (opsional, isian "Harga beli / nota"
    di dialog stok, mode **Masuk barang**). Tidak diisi = rata-rata modal tidak
    diubah; input kosong/huruf ditolak server, bukan dianggap 0.
  - Rumus rata-rata **tertimbang**: `avg' = round((stok_lama*avg + qty*harga) / (stok_lama+qty))`,
    dengan `stok_lama` dihitung sebelum barang ditambahkan. Dialog menampilkan
    pratinjau live `Rp778 -> Rp836` sebelum disimpan.
  - `products.avg_cost` (baru) **terpisah** dari `products.cost`: `cost` adalah
    angka manual Anda di form (patokan markup) dan tidak ikut berubah restock.
    Form produk memperlihatkan keduanya berdampingan supaya tidak tertukar.
  - Saat jual, HPP **di-snapshot** ke `sale_items.cost` — kalau dibaca ulang dari
    `avg_cost` saat laporan dibuka, laba hari lalu ikut berubah setelah pembelian
    hari ini. `stock_moves.unit_cost` mencatat riwayat harga beli per mutasi.
  - `GET /api/reports/daily` kini mengembalikan `hpp` dan `laba`
    (`laba = omzet - hpp`, omzet sudah setelah diskon). Jasa/cetak ber-HPP 0,
    jadi seluruh penjualannya dihitung laba.
* **Multi satuan** (fitur #3) — satu produk bisa dijual per pcs, per pack, per dus
  dengan harga yang ikut menyesuaikan. Master satuan tetap `#/satuan`; yang baru
  adalah **tabel `product_units`**: `(product_id, unit, factor, price)`.
  - Satuan **dasar** tetap implisit dari `products.unit` + `products.price` —
    tidak jadi baris, sehingga produk lama tetap valid tanpa data tambahan.
  - `factor` = berapa satuan dasar dalam 1 satuan jual. **`price` opsional**:
    kosong = `products.price × factor` (otomatis), diisi = harga grosir sendiri
    (dus biasanya jauh di bawah kelipatan eceran, bukan di atasnya).
  - **Stok selalu satuan dasar**: jual 2 pack (12 pcs) -> `stock -= 24`.
    Restock / opname / laporan tidak berubah sama sekali.
  - **HPP ikut dikalikan**: `sale_items.cost = round(avg_cost × factor)`, dan
    `sale_items.unit` menyimpan satuan yang terjual supaya laporan tidak
    mencampur "2 pack" dengan "3 btl" jadi satu angka.
  - UI POS: hasil pencarian menampilkan **chip satuan** di bawah baris produk.
    Ketuk barisnya = satuan dasar (kebiasaan lama tidak berubah), ketuk chip =
    satuan itu. Keduanya jadi baris keranjang **terpisah** — kuncinya
    `product_id:unit`, bukan `product_id` saja.
  - **Semua resolusi harga & faktor ada di server** (`POST /api/sales`): client
    hanya mengirim `unit`, harga produk non-dinamis tidak bisa dimanipulasi.
  - Form produk punya seksi **Satuan jual** untuk menambah/mengubah barisnya.
* **Impor produk** (`#/products` -> tombol **Impor**): tempel tabel dari Excel
  atau pilih file CSV. Dialognya dua langkah — **Baca & tinjau** dulu (tabel
  pratinjau + badge `baru`/`timpa`/`gagal`), baru tombol **Impor** aktif.
  Tombol sengaja mati sampai pratinjau ada, dan mati lagi begitu isi diubah,
  supaya yang dikirim server selalu sama dengan yang dilihat kasir.
  - Pemisah dideteksi otomatis: **TAB** untuk tempelan Excel, **koma** untuk CSV,
    **titik-koma** untuk CSV Excel Indonesia. Kutip `"` mengikuti RFC4180.
  - Kolom dikenali dalam nama Indonesia/Inggris (`nama`/`name`, `stok`/`stock`,
    `min_stok`, `harga_dinamis`, `aktif`, ...). **Kategori & satuan boleh ditulis
    namanya** ("ATK", "Lembar") — server/master menurunkan slug-nya.
  - Angka menerima gaya Indonesia dan internasional (`1.500` = 1500, `1500,50` =
    1500.5, `Rp 3.000` = 3000).
  - Baris bermasalah TIDAK menggugurkan file: baris valid tetap diimpor, baris
    gagal dilaporkan per nomor baris aslinya.
  - **Bukan `.xlsx`**: file itu ZIP+XML dan butuh dependensi parser — sengaja
    tidak dipasang. Jalan pintas Excel: Blok sel -> Ctrl+C -> tempel.
* Kolom `products.type` (barang|jasa|cetak|desain|topup) **sudah dihapus** — nature
  produk sudah tercermin dari `categories.track_stock`. DB dev sudah dimigrasi.
  Install lain (mis. `~/ravaa-data/data.db` di STB) jalankan manual:
  ```bash
  sqlite3 ~/ravaa-data/data.db "ALTER TABLE products DROP COLUMN type;"   # butuh SQLite >= 3.35
  ```
  `db/seed.sql` sudah disesuaikan. Gejala migrasi belum jalan: `npm run seed` gagal
  dengan `table products has no column named type`.
* **Yang belum ada (celah terbuka):** impor belum mendukung `.xlsx` (pakai tempel
  dari Excel). **Varian (warna/ukuran) sengaja TIDAK dibuat** — keputusan pemilik:
  warna berbeda dibuat sebagai produk terpisah dengan nama & harga sendiri, bukan
  varian. Yang sudah tertutup: multi-satuan (lihat entri "Multi satuan"), HPP
  rata-rata (bagian "HPP & laba"), riwayat pembelian (`stock_moves.unit_cost`).
* Baca `.opencode/agents/AGENTS.md` sebelum mengubah apa pun.
