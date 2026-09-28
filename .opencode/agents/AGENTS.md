# AGENTS.md — Ravaa POS v2 (panduan AI agent)

> WAJIB dibaca sebelum menyentuh repo ini. Skill wajib aktif:
> `ravaa-pos` (kontrak domain) dan `antislop` (protokol anti-halusinasi),
> plus `frontend-pos` untuk setiap tugas UI di `apps/web/`.
> Jika ragu antara menebak atau memverifikasi: VERIFIKASI.

## 1. Konteks bisnis (jangan dilanggar)

* Toko: ATK, Cetak, Desain, Jasa ketik & service Laptop/PC, Topup e-wallet /
  Tarik tunai, Es krim & Minuman, Snack, Rokok.
* **1–2 kasir bersamaan (umumnya 1 aktif)** + fallback HP Android.
  Tiap device WAJIB nama kasir berbeda + shift sendiri. Tidak ada multi-writer
  ke shift yang sama. SQLite WAL + transaksi sinkron single-proses membuat
  cek-kurang-stok atomik untuk skala ini; batas naik ke Postgres bila >5 device
  atau butuh tulis remote concurrent berat.
* Stok dilacak HANYA untuk barang fisik (`categories.track_stock=1`):
  atk, eskrim, snack, rokok. Jasa/cetak/desain/topup: `track_stock=0`.
* Rokok: SKU bungkus dan ketengan TERPISAH (cth `RK-SMP-12` vs `RK-SMP-KETENG`).
* Topup/tarik: `nominal` bebas + `admin` editable per transaksi.
  `nominal` = mutasi modal, `admin` = pendapatan jasa, `total = nominal + admin`.
* Harga produk non-dinamis DIKUNCI server (client tidak boleh override).
  Produk `price_dynamic=1` wajib kirim harga per transaksi.

## 2. Arsitektur (peta file)

```
apps/api/src/index.ts    API Hono. SATU-SATUNYA yang boleh tulis DB.
apps/api/src/db.ts       Koneksi better-sqlite3 + migrate + seed. DB_PATH default ./data/data.db
apps/api/src/seed.ts     Runner seed (idempotent, INSERT OR IGNORE)
db/schema.sql            SUMBER KEBENARAN skema. Ubah skema = edit file ini + migrasi manual.
db/seed.sql              Master awal (8 kategori + contoh SKU).
apps/web/src/main.ts     UI kasir (7+ tab kategori). Semua search/filter lokal.
apps/web/src/api.ts      fetch + outbox offline (localStorage, retry 5 detik, id uuid).
apps/web/src/store.ts    Cache master IndexedDB + maxVersion (?since= delta sync).
apps/web/src/pages/satuan.ts  Halaman #/satuan: CRUD master satuan.
apps/web/src/escpos.ts   ESC/POS 58mm (32 kolom): label harga + struk + POST ke print-agent.
apps/web/src/ui/switch.ts  Saklar checkbox bergaya (label + toggle) dipakai form
                         produk dan panel mode POS.
                         Berisi: label harga (labelHarga/teksLabel/gabungLabel),
                         struk 32 kolom (struk/StrukBaris), ascii()/potong/baris
                         dua kolom, kirimPrint() + urlAgent() (`ravaa.printagent`,
                         default :9100). Dipanggil dari label produk dan dari
                         pay()/submitTopup() POS. PENTING: `teks()` tidak
                         menambah baris baru — setiap baris struk HARUS diakhiri
                         LF, kalau tidak seluruh struk menempel jadi satu baris.
apps/print-agent/server.js  HTTP :9100 -> tulis bytes ke PRINTER_PATH|/dev/usb/lp0|file. TANPA deps.
tests/                 Suite regresi (`npm test` / `node tests/run.mjs`).
                       run.mjs MENOLAK file hilang / crash / 0 asersi / jumlah
                       asersi != `ekspek` — angka `ekspek` wajib diperbarui bila
                       asersi memang sengaja ditambah. Prasyarat: API :3001
                       hidup + ada shift terbuka (runner membukanya sendiri).
infra/                   docker-compose.yml + Dockerfile.api + Dockerfile.web + Caddyfile
```

## 3. Kontrak API (eksak — jangan mengarang endpoint lain)

* `GET /health` -> `{ok:true}`
* `GET /api/categories`
* `POST /api/categories` `{name,slug?,track_stock?,sort?}` (upsert by slug; `slug` OPSIONAL —
  bila kosong server turunkan otomatis dari `name` (lowercase `[a-z0-9-]`), client kirim
  slug readonly. 200 update / 201 baru. Slum tidak bisa diganti setelah dipakai)
* `DELETE /api/categories/:slug` (400 bila masih ada produk — FK `products.category_id`, `foreign_keys=ON`; kategori bekas pakai praktis permanen)
* `GET /api/units` -> `{data}` (urutan `name` alfabetis) + kolom **`dipakai`**
  (jumlah produk per satuan, dihitung server-side). WAJIB pakai angka ini untuk dialog hapus: menghitung dari cache
  client pernah berbohong ("tidak dipakai produk") lalu user diklik server tetap 400.
* `POST /api/units` `{name,slug?}` (upsert by slug; `slug` OPSIONAL — kosong
  diturunkan dari `name`, sama persis aturan kategori). 200 update / 201 baru.
  TIDAK ada `sort` — urutan tampil (tabel master & dropdown form produk) = alfabetis
  `name` dari `GET /api/units`.
* `DELETE /api/units/:slug` (404 tak ada, 400 bila masih dipakai produk — FK
  `products.unit` -> `units.slug`)
* `GET /api/products?since=&category=<slug>&q=&status=aktif|nonaktif|semua` -> `{data, maxVersion}`
  - `status` default `aktif`. `nonaktif` untuk layar Manage (aktifkan kembali), `semua` gabungan.
    Status tak dikenal -> 400.
  - **KEAMANAN:** bila `since>0` (delta sync) hasil status DISIMPAN dan hasil tetap
    hanya `is_active=1` — cache kasir tidak menyimpan produk nonaktif, jadi
    mengirimnya akan membangkitkan produk yang sudah dinonaktifkan di POS.
    **PENGECUALIAN TOMBSTONE:** baris `deleted_at IS NOT NULL` tetap DIKIRIM walau
    `is_active` apa pun, karena tujuannya dibuang dari cache (lihat `DELETE
    /api/products/:id`). Tanpa penghantaran ini produk mati nempel selamanya di
    IndexedDB kasir — `syncMaster()` hanya merge per sku dan tidak pernah hapus.
  - **`units`** (fitur #3 Multi satuan): array satuan jual ALTERNATIF
    `[{unit,factor,price}]`, SELALU ADA (array kosong bila tidak punya).
    Satuan DASAR sengaja bukan baris — ia implisit dari `unit` + `price` produk.
    `price` NULL = ikut `products.price × factor`; diisi = harga grosir eksplisit.
    Disaring dengan subquery kondisi yang SAMA, jadi `?since=` ikut menarik
    perubahannya (ubah satuan jual -> `version++` -> produk terkirim -> unitnya
    ikut). Cache lama tanpa field ini dinormalisasi jadi `[]` saat dibaca
    (`getCachedProducts()`), karena produk yang tidak berubah tidak pernah
    dikirim ulang oleh delta sync.
  - Client WAJIB menghapus SKU nonaktif dari cache (`removeProductBySku`).
    Untuk produk **dihapus** (tombstone) tidak perlu dipanggil manual:
    `syncMaster()` sudah membuangnya saat menerima `deleted_at` terisi.
* `POST /api/products` `{sku?,name,category_slug,barcode?,unit?,price?,cost?,markup?,price_dynamic?,stock?,min_stock?,is_active?,units?}` (upsert by sku, version++)
  - `sku` **opsional**: kosong berarti server menurunkan dari nama.
    Wajib dijamin unik — SKU adalah kunci upsert, jadi SKU bentrok akan menimpa
    produk lain. Bentuk: nama -> uppercase, non-alnum jadi `-`, potong 40 karakter;
    kalau sudah ada, tambahkan `-2`, `-3`, ... sampai baru. Contoh:
    "Kopi Kapal Api Sachet" -> `KOPI-KAPAL-API-SACHET`.
  - `unit` satuan untuk struk, WAJIB ada di master `units` (form produk pakai
    dropdown dari `GET /api/units`). Tidak dikenal -> 400 dengan pesan
    "satuan tidak dikenal: <x> — buat dulu di halaman Satuan", dicek di server
    sebelum query supaya FK-nya tidak meledak sebagai error mentah SQLite.
  - `cost` harga beli (modal), `markup` margin persen terhadap modal. Ketiganya
    (`cost`, `markup`, `price`) DISIMPAN semua karena form perlu ketiganya saat edit.
    Aturan isi form: ubah `cost` atau `markup` -> `price` ikut dihitung;
    ubah `price` -> `markup` ikut dihitung. `price` dibulatkan ke ratusan terdekat.
  - **`type` DIHAPUS 2026-09-26** (barang|jasa|cetak|desain|topup) — nature produk sudah
    tercermin dari `categories.track_stock`. Kolom `type` sudah di-DROP di DB.
  - Field yang tidak dikirim akan di-reset ke default server (price/stock → 0).
    Jadi saat toggle `is_active`, WAJIB kirim payload LENKAP (gagal = produk aktif
    dengan harga Rp0).
  - **`units` DIKECUALIKAN dari aturan reset di atas**: `undefined` / tidak
    dikirim = **tidak ada perubahan** (baris `product_units` dibiarkan);
    `[]` (array kosong) = hapus semua satuan alternatif;
    `[{unit,factor,price?}]` = ganti seluruh daftar (replace, bukan merge).
    Alasan: `payloadToggleAktif()` dan tiap baris import tidak boleh diam-diam
    membuang satuan pack/dus milik produk. Validasi (semua 400):
    `factor` wajib `> 0`, `unit` wajib ada di master `units`, satuan dasar
    TIDAK boleh diulang, dan tidak boleh duplikat. Stok TIDAK pernah dikonversi
    lewat endpoint ini — stok selalu satuan dasar.
* `DELETE /api/products/:id` -> `{data:{id,sku,deleted:true}}` (SOFT delete)
  - Guard: 400 bila produk **pernah terjual** (ada di `sale_items`) dengan pesan
    "produk ini sudah pernah terjual (N baris penjualan) — riwayatnya harus utuh,
    jadi pakai nonaktifkan saja". Aturan ini meniru Aronium (produk yang punya
    riwayat penjualan tidak bisa dihapus, hanya dinonaktifkan).
  - 404 bila tidak ada / sudah `deleted_at`, 400 bila `:id` bukan integer.
  - Bukan `DELETE` keras: isi kolom `deleted_at` + `version++`. Baris tetap ada
    supaya `sale_items`/`stock_moves` tetap valid referensial, dan supaya versi
    barunya menyiarkan tombstone ke kasir lewat `?since=`.
  - **DILARANG menghapus baris tombstone dari DB** selama masih ada device kasir
    yang belum sync — baris hilang = tombstone tidak pernah terkirim = produk mati
    nempel selamanya di cache device itu.
* `POST /api/products/import` `{rows:[<payload POST /api/products>], dry_run?:bool}` -> `{data:{total,ok,baru,update,gagal,errors:[{baris,sku,error}]}}` (200)
  - Tiap baris di-upsert lewat **fungsi yang sama** dengan `POST /api/products`
    (kategori/satuan/turunan SKU jadi satu sumber kebenaran, bukan versi kedua).
  - `dry_run:true` = validasi saja, **tidak menulis apa pun** (dijalankan dalam
    transaksi yang sengaja di-rollback). Dipakai tombol "Baca & tinjau".
  - SKU eksplisit yang muncul **lebih dari satu kali dalam satu file** ditolak di
    baris berikutnya (gagal, bukan diam-diam menimpa baris sebelumnya).
  - Batas 1000 baris/permintaan; `errors` dipotong maks 50 entri.
  - 400 bila `rows` bukan array, kosong, atau >1000.
* `POST /api/restock` `{product_id,qty>0,harga_beli?,cashier?}` (hanya track_stock=1; version++)
  - **`harga_beli` OPSIONAL** — bila tidak dikirim, `products.avg_cost` TIDAK
    diubah (bukan dianggap 0, yang akan membuat HPP nol & laba palsu). Bila diisi
    wajib angka `>= 0`; kosong/huruf/negatif -> 400 `"harga_beli harus angka >= 0"`.
  - **Rata-rata modal tertimbang**: `avg_cost' = round((stok_lama*avg_cost + qty*harga_beli) / (stok_lama + qty))`
    dengan `stok_lama` diambil **SEBELUM** update (memakai stok hasil penambahan
    menghitung barang lama seolah ikut terbeli pada harga batch baru).
  - Kolom `products.avg_cost` (INTEGER, lihat `db/schema.sql`) TERPISAH dari
    `products.cost`: `cost` = angka manual pemilik, patokan markup di form, dan
    tidak boleh tertimpa restock. `avg_cost` = yang dipakai sebagai HPP.
  - `stock_moves.unit_cost` = harga batch bila dikirim, kalau tidak `avg_cost` lama
    (inilah riwayat pembelian — dasar audit HPP).
* `POST /api/stock-opname` `{product_id,qty_fisik>=0,cashier?}` -> `{data:{product_id,sebelum,sesudah,selisih}}` (200)
  - **Beda krusial dengan restock**: restock MENAMBAH `qty` yang dikirim; opname
    MENGGANTI stok dengan `qty_fisik` apa adanya — **`0` sah** (semua hilang),
    jadi validasinya `Number.isFinite && >= 0`, BUKAN `> 0`. Input kosong/huruf
    ditolak 400 supaya tidak diam-diam dianggap 0.
  - `stock_moves.reason = 'opname'` dengan **`qty` = selisih** (fisik - tercatat):
    riwayat mutasi tetap bermakna (+ kelebihan, - kekurangan). Nilai `opname`
    sudah ada di `db/schema.sql` sejak awal — TIDAK ada kolom/tabel baru.
  - `version` wajib naik (aturan mutasi `products`); 400 untuk produk non-track.
* ATURAN WAJIB: **setiap mutasi `products` harus menaikkan `version`** — termasuk
  stok (`POST /api/restock` dan pengurangan stok di `POST /api/sales`). Kalau version
  tidak naik, client offline tidak pernah menarik perubahan tsb karena delta sync
  hanya memfilter `version > since`.
* Produk yang `is_active=0` tidak pernah dikirim API lagi (pada mode normal), jadi
  client **wajib** membuangnya sendiri dari cache (`removeProductBySku`).
  **Beda konsep dengan hapus**: `is_active=0` = disembunyikan (bisa diaktifkan lagi),
  `deleted_at` = hilang permanen dari semua layar tapi barisnya tetap ada di DB.
* **Toggle status aktif = POST upsert dengan payload LENKAP.** Karena field yang
  tidak dikirim di-reset ke default server, memakai `payloadToggleAktif()` di
  `apps/web/src/pages/products.ts` untuk nonaktifkan DAN aktifkan lagi. Jangan
  pernah kirim `{sku, is_active}` saja — `unit` jadi `pcs`, `cost`/`markup` jadi 0.
  Regresi ada di `/tmp/opencode/pos-form-test.mjs` (section 9).
* Search produk & POS memecah query jadi kata: SEMUA kata wajib cocok di
  nama/SKU/barcode, tidak harus di field atau urutan yang sama — jadi "aqua 600"
  dan "600 aqua" sama-sama ketemu. Kalau dipecah balik jadi `includes(query)`
  utuh, search multi-kata jadi 0 hasil.
* `GET /api/shifts/open?cashier=` | `POST /api/shifts/open` `{modal_awal,cashier}`
  (409 hanya bila kasir yang sama masih punya shift open — ditegakkan UNIQUE INDEX
  `idx_shifts_open_cashier`, bukan cek SELECT; jangan kembalikan ke pola cek-manual)
  | `POST /api/shifts/:id/close` `{modal_akhir}`
* `POST /api/sales` `{id(uuid!),shift_id,items:[{product_id?,name?,qty>0,price?,unit?}],pay_method,discount?,cash_in?,cashier?}`
  - **HPP di-snapshot per baris**: `sale_items.cost` = `products.avg_cost` saat
    jual (0 untuk item manual). WAJIB snapshot, bukan dibaca ulang saat laporan
    di-query — `avg_cost` berubah tiap restock, kalau dibaca ulang laba hari lalu
    ikut berubah retroaktif. `laba baris = amount - qty*cost`.
  Idempotent per `id`. Error 400 bila: items kosong, qty<=0, stok kurang, harga dinamis kosong,
  item manual tanpa name+price, diskon > subtotal.
  - **`unit` (opsional, fitur #3)** = satuan jual TERPILIH; kosong = satuan dasar.
    **Resolusi sepenuhnya di server** — client hanya mengirim unit; faktor & harga
    diambil dari `product_units`:
    `harga = product_units.price ?? products.price × factor`,
    `HPP/baris = round(products.avg_cost × factor)`,
    `stok keluar = qty × factor` (stock_moves juga satuan dasar).
    Unit yang tidak ada di `product_units` produk -> 400
    "satuan tidak dijual untuk <produk>: <unit>".
    `sale_items` menyimpan `qty` & `price` DALAM SATUAN JUAL plus kolom `unit`
    (snapshot), sehingga laporan tidak mencampur "2 pack" dan "3 btl" jadi satu
    angka. Harga produk non-dinamis TIDAK boleh ditentukan client.
* `GET /api/sales/:id`
* `POST /api/topups` `{id?,kind:topup|tarik,provider,nomor,nominal>0,admin>=0,pay_method?,shift_id?,cashier?}`
  - `provider` = **kode jenis layanan** (bukan brand). Nilai yang digunakan POS:
    `E-WALLET | PULSA | PLN-TOKEN | PLN-BILL` (kind=topup) dan `TARIK-EWALLET | TARIK-BANK` (kind=tarik).
    Kontrak API tidak berubah; kolom tetap TEXT non-kosong. Penambahan brand
    (DANA/OVO/GoPay/BCA) dilakukan sebagai kolom baru jika dibutuhkan, bukan
    dengan mengubah `provider` menjadi opsional.
* `GET /api/topups/suggest-admin?nominal=` (<=0->0, <50rb->3000, <200rb->5000, else 7000)
* `GET /api/reports/daily?date=YYYY-MM-DD`
  -> `{data:{date,sales:{n,omzet,diskon},hpp,laba,byMethod,topup,topItems,lowStock}}`
  - `hpp = ROUND(SUM(sale_items.qty * sale_items.cost))` untuk penjualan hari itu.
  - `laba = sales.omzet - hpp` (omzet sudah **setelah** diskon).
  - `topItems` dikelompokkan per `(name, unit)` dan tiap baris memuat `unit` —
    tanpa pemisahan ini penjualan "2 pack" dan "3 btl" produk sama tercampur
    jadi satu baris qty=5 campur satuan.
  - Jasa/cetak/desain punya `cost = 0` (tidak ada persediaan) -> penjualannya
    seluruhnya dihitung laba. Topup/tarik TIDAK masuk omzet (lihat §domain).

Aturan DB: tulis HANYA lewat prepared statement + transaction di `index.ts`.
DILARANG: query string concat dari input user, tabel/kolom baru tanpa update `db/schema.sql`.

## 4. Perintah (eksak)

```bash
cd ~/Projects/ravaaposv2
npm install
npm run seed                 # better-sqlite3 butuh toolchain; bila gagal lihat §6
npm run dev:api              # :3001
npm run dev:web              # :3000 (Vite proxy /api -> :3001)
npm run dev:agent            # :9100 (di PC kasir)
curl localhost:3001/health
curl 'localhost:3001/api/topups/suggest-admin?nominal=100000'
cd infra && docker compose up -d --build
# Native STB/ARM tanpa Docker: sh infra/deploy-native.sh (lihat README).
#   Service: infra/ravaa-api.service (user systemd, DB ~/ravaa-data/data.db),
#   Web: infra/Caddyfile.server. JANGAN ubah path DB tanpa update service + README.
```

Port: web 5656, api 3001, print-agent 9100. JANGAN ganti port tanpa update
`apps/web/vite.config.ts`, `infra/*`, dan README sekaligus.

## 5. Batasan perubahan (anti-merusak)

* DILARANG menghapus/mengganti SKU seed yang dipakai struk contoh tanpa konfirmasi user.
* DILARANG menambah framework (React/Svelte/Electron) tanpa persetujuan — web vanilla-TS adalah keputusan sadar (ringan, tanpa build rapuh).
* Tailwind CSS v4 DISETUJUI 2026-09-25 (hanya build-time `@tailwindcss/vite` di `apps/web`,
  tanpa CDN; logika tetap vanilla-TS, tanpa Alpine/jQuery/chart-lib/font-icon).
* DILARANG menambah dependency print-agent — harus tetap nol-deps (node:http + node:fs).
* Perubahan struk: lebar TETAP 32 kolom (`apps/web/src/escpos.ts:COLS`). Uji dengan
  `node -e` atau tampilkan modal dan ukur tiap baris <= 32 char.
* Setiap perubahan API: update kontrak §3 file ini + README bila endpoint berubah.
* **Migrasi skema (kebijakan 2026-09-26): karena masih dev, TULIS kolom langsung
  di `db/schema.sql` (CREATE TABLE) lalu buat ulang DB — jangan pakai ALTER
  inkremental ala Laravel (`ALTER TABLE ... ADD COLUMN`).** Urutannya:
  ```bash
  cp apps/api/data/data.db apps/api/data/data.db.bak   # backup dulu
  rm apps/api/data/data.db apps/api/data/data.db-shm apps/api/data/data.db-wal
  npm run seed                                          # migrate + seed dari schema.sql
  ```
  Lalu **buka shift lagi** lewat `POST /api/shifts/open` (data hilang, tidak
  digenerate seed) bila POS mau dipakai. JANGAN klaim "migrasi otomatis".
  Yang ditambahkan lewat cara ini: kolom `products.unit`, `products.cost`,
  `products.markup`, dan tabel `units` (+ FK `products.unit` -> `units.slug`).
  `units` WAJIB ter-seed SEBELUM `products` (FK checked langsung, bukan deferred).
  Kolom `products.deleted_at` ditambahkan 2026-09-27 (tombstone hapus produk).
  **Migrasi terakhir 2026-09-28 (fitur #3 Multi satuan):** tabel
  `product_units` + kolom `sale_items.unit` (re-create penuh, backup
  `data.db.bak.multisatuan`). Sejak itu `npm run seed` juga mengisi
  `avg_cost = cost` untuk produk seed — sebelumnya `avg_cost` 0 sehingga laba
  penjualan stok awal terlihat terlalu besar sampai restock pertama.
  Kolom `units.sort` pernah ada lalu DIHAPUS (2026-09-26) — `db/schema.sql` kini
  tidak memuat kolom itu, jadi DB yang masih punya kolom tersebut harus di-seed
  ulang, bukan di-ALTER.
* Pengecualian: install yang sudah dipakai (mis. `~/ravaa-data/data.db` di STB
  native) TIDAK boleh di-recreate — di sana baru perlu ALTER manual.
  Kolom `products.type` sudah dihapus di sana dengan:
  ```sql
  ALTER TABLE products DROP COLUMN type;   -- butuh SQLite >= 3.35
  ```
  Kalau `npm run seed` gagal dengan `table products has no column named type`,
  migrasi itu belum dijalankan di install tersebut.

## 6. Troubleshooting yang sudah diketahui (fakta, bukan tebakan)

* `better-sqlite3` perlu kompilasi (node-gyp + python + gcc). Cek: `npm ls -g` sudah ada
  `better-sqlite3@13` dan `node-gyp` global di mesin dev — jadi `npm install` seharusnya bisa.
  Bila gagal, laporkan error persisnya, jangan mengarang solusi.
* `node:sqlite` bawaan TIDAK dipakai di repo ini — jangan "memperbaiki" dengan menggantinya.
* Print-agent menulis ke device: butuh grup `lp` di Linux (`sudo usermod -aG lp $USER`).
* Tanpa sudo, `btrfs subvolume` / `/var/lib/docker` tidak terbaca — itu normal, bukan bug repo.

## 7. Definisi selesai (Definition of Done)

Fitur dianggap selesai bila: (1) kode + skema konsisten dengan §3,
(2) `npm run build -w apps/web` lolos, (3) endpoint baru diuji dengan `curl` nyata
dan outputnya ditempel di jawaban, (4) tidak ada port/ENV baru yang tak terdokumentasi.
