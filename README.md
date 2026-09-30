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
  diganti; hapus ditolak bila masih ada produk). Dialognya memuat dua centang:
  **Lacak stok** dan **Gunakan tanggal kadaluarsa** — yang kedua adalah
  pengaturan server (`categories.use_expiry`) yang menentukan tampil/hilangnya
  kolom **Tanggal kadaluarsa** di form produk kategori itu. Kategori baru dari UI
  dev wajib dituangkan juga ke `db/seed.sql` agar STB baru mulai dari master yang sama.
* **Master satuan** (`#/satuan`, menu sidebar): CRUD satuan struk (pcs, lembar,
  dus, ...). Tambah/ubah/hapus lewat UI; `slug` diturunkan otomatis dari nama dan
  terkunci setelah dibuat; satuan yang masih dipakai produk tidak bisa dihapus
  (server menolak dengan 400). Jumlah "Dipakai" dihitung server, jadi dialog hapus
  tidak pernah bilang "tidak dipakai" padahal ada produknya. Urutan tampil mengikuti
  alfabetis nama. Seed: 13 satuan, termasuk `Tanpa satuan` untuk shortcut topup/tarik.
* **Form produk** (`#/products` -> Tambah/Edit) memakai **modal 2 kolom ala
  RPOS** (lebar `max-w-5xl`): kolom **kiri = kotak foto persegi** (seluruh kotak
  diklik untuk pilih berkas; mode Tambah/Duplikat menampilkan placeholder karena
  endpoint foto butuh id produk), kolom **kanan = form berseksi** — **Detail
  produk** (nama, SKU, barcode, kategori, satuan), **Harga**
  (harga beli, markup %, harga jual), **Diskon**, **Satuan jual**, lalu blok
  **Stok** yang hanya muncul kalau
  kategori pilihan itu `track_stock=1`. Price change allowed ditulis "Boleh ubah
  harga saat jual" (switch, bukan checkbox kotak). `cost` + `markup` + `price`
  disimpan semua: mengubah `cost`/`markup` menghitung ulang `price` (dibulatkan
  ke ratusan), mengubah `price` menghitung ulang `markup`. Satuan dipilih dari
  master (dropdown `GET /api/units`), bukan diketik bebas — jadi tidak ada lagi
  "pcs" vs "Pcs" untuk produk yang sama; satuan yang tak dikenal ditolak 400.
  Produk baru default ke `pcs` (kalau `pcs` tak ada di master, ke satuan pertama).
  **SKU boleh kosong** —
  server menomori sendiri `PRD00001`, `PRD00002`, ... (`PRD` + 5 digit, dihitung
  dari MAX yang ada di DB), jadi dua produk tidak mungkin diam-diam saling
   menimpa. SKU tetap boleh diketik manual; form sengaja membiarkannya kosong.
   - **Foto produk** (kolom `image`): DB hanya menyimpan **nama file**
     (`apps/api/data/img/`), bukan isi gambar — jadi foto tidak ikut naik-turun
     lewat delta sync setiap penjualan. Upload lewat
     `POST /api/products/:id/image` (data URL `image/jpeg|png|webp`; server yang
     memperkecil ke thumbnail JPEG maks 512px), hapus dengan nilai `""`.
     Isi gambarnya diunduh sekali lalu di-cache IndexedDB, jadi thumbnail tetap
     tampil **offline**. Yang boleh dikirim lewat kolom `image` hanya nama
     filenya (dicek regex anti path-traversal).
   - **Diskon permanen** (`discount_type` + `discount`): `rp` (Rp1.500) atau
     `pct` (10%). Tampil sebagai badge `-10%` / `-Rp500` dan harga coret di
     kolom Harga; **POS memakai harga yang sama** (`hargaDiskon()`), jadi harga
     diskon tidak perlu diketik ulang di kasir. `pct` dibulatkan ke ratusan,
     `rp` dibatasi setara harga (tampilan tidak boleh menampilkan harga minus).
    - **Tanggal kadaluarsa** (`expiry_date`, `YYYY-MM-DD`): isian muncul kalau
      **kategori**-nya menyalakan centang *Gunakan tanggal kadaluarsa* di form
      Kategori (seed: **snack & eskrim** menyala, sisanya mati). Aturannya ada di
      server (`categories.use_expiry`), bukan daftar hardcode di klien — kategori
      baru seperti Frozen food cukup dicentang pemilik. Produk yang sudah punya
      tanggal tetap menampilkan isian walau kategorinya berubah atau pengaturan
      dimatikan. Baris
      tabel menandainya: merah *lewat kadaluarsa*, amber *kadaluarsa ≤ 30 hari*.
* Layar kasir (`#/pos`) **tidak memakai grid produk**. Satu input scan/ketik
  (barcode persis → SKU persis → nama mengandung) dengan dropdown hasil: ArrowUp /
  ArrowDown menyorot, Enter atau klik memasukkan ke keranjang, Escape menutup.
   Mode: **Penjualan / Topup / Tarik** (bar yang sama). Topup-tarik memakai
   `POST /api/topups`; admin terisi otomatis dari tier toko yang sama dengan
   `GET /api/topups/suggest-admin`, dan bisa diedit kasir.
  - **Diskon permanen terpakai otomatis di keranjang**: baris yang masuk
    memecut `discount`/`discount_type` produk sebagai **prefill** (diskon Rp
    dihitung per baris, persen dibulatkan ke ratusan), harga coret + harga
    bersih tampil di kolom, dan total memakai `hargaDiskon()` yang sama dengan
    tabel produk. Produk tanpa diskon = sel Diskon kosong.
  - **Diskon per baris bisa diketik ulang kasir** (kolom **Diskon** di tabel
    keranjang, satuan rupiah selalu) dan **diskon transaksi** (panel
    **Diskon transaksi (Rp)** di kanan). Keduanya saling membatasi: diskon
    baris tidak boleh melebihi `qty × harga`, diskon transaksi tidak boleh
    melebihi `subtotal − Σ diskon baris`, dan TOTAL tidak pernah minus.
    Semua dikirim ke `POST /api/sales` (`items[].discount` per baris,
    `discount` transaksi) lalu **di-snapshot** ke `sale_items.discount` /
    `sales.discount` — laporan `diskon` hari itu = keduanya dijumlah.
  - **Strip peringatan stok menipis** di atas keranjang (mode Penjualan saja):
    daftar maks 3 produk yang `stock ≤ min_stock` + tombol **Buka Stok** yang
    menuju `#/stock`. Hanya kategori yang melacak stok; tanpa kandidat strip
    tidak dirender sama sekali.
  - **Strip peringatan kadaluarsa** di bawahnya (juga mode Penjualan saja):
    produk yang tanggalnya sudah lewat (**merah**, urutan pertama) atau
    ≤ 30 hari (**kuning**) diambil dari cache `products.expiry_date` — tanpa
    panggilan API, sama seperti strip stok menipis. Tombol **Buka Produk**
    menuju `#/products`. Setiap **baris keranjang** ikut memakai badge yang sama
    (`lewat kadaluarsa 20 Sep 2026` / `kadaluarsa 14 Okt 2026`), jadi kasir
    melihatnya tepat saat barang diambil. Ambang & format tanggal dipakai
    bersama dengan tabel Produk lewat `apps/web/src/ui/expiry.ts`
    (`statusExpiry`, `tglExpiry`, `AMBAT_EXPIRY = 30`).
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
* Produk kategori **`topup`** (`PRD00017` topup, `PRD00018` tarik) **bukan item jual**:
  scan/ketik/klik produk itu membuka mode topup atau tarik, tidak pernah masuk
  keranjang. Alasannya satu produk hanya punya satu harga, sedangkan topup butuh
  dua angka (`nominal` + `admin`); kalau jadi `sale_item`, `SUM(sales.total)`
  ikut ditambah dan omzet jadi lebih besar dari kenyataan.
* Rokok: SKU per-bungkus dan ketengan terpisah.
* Produk punya status **aktif / nonaktif**. Nonaktif disembunyikan dari kasir; bisa
  diaktifkan kembali dari halaman Products (filter status **Nonaktif**).
* **Kolom Aksi** — hanya dua tombol yang selalu tampil langsung: **Ubah** ✎ dan
  **Hapus** 🗑. Aksi yang lebih jarang dipakai masuk ke **menu ⋮** (titik tiga) di
  ujung baris: *Duplikat* dan *Nonaktifkan* / *Aktifkan kembali*. Perubahan stok
  tidak lewat menu ini — restock & opname ada di halaman Stok. Menu pakai
  `position: fixed` yang dihitung
  dari tombolnya, supaya lolos dari `overflow-x-auto` pembungkus tabel, jatuh ke
  atas kalau baris berada di tepi bawah layar, dan menutup sendiri saat diklik di
  luar atau saat Esc ditekan.
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
* **Tabel produk bisa diurutkan** (klik header: **Nama, Kategori, Harga, Stok**;
  klik lagi membalik arah, panah di header menandai kolom & arahnya). Nama selalu
  jadi tie-break, jadi dua produk berharga sama tidak berpindah-pindah tiap render.
* **Cetak label harga — halaman sendiri** (`#/labels`, menu **Label harga** di
  sidebar): panel **kiri 20%** berisi alat (cari, filter kategori, centang
  massal, status print-agent) dan **pratinjau 80%** berisi kartu label per
  produk — masing-masing menampilkan thumbnail, nama, SKU/barcode, dan label
  yang persis akan dicetak.
  - Yang **layak dicetak**: produk aktif, `price_dynamic ≠ 1`, harga > 0 —
    produk harga-berubah-otomatis sengaja dilewati karena labelnya tidak bisa
    menampilkan satu angka. Jumlah yang dilewati dilaporkan di footer alat.
  - Semua produk layak **tercentang saat pertama buka**; pilihan tersimpan di
    sesi (kosongkan / pilih ulang sesuai kebutuhan).
  - Cetak butuh **print-agent hidup**: tombol mati + pesan jelas kalau
    `${urlAgent()}/health` (default `:9100`) tidak menjawab.
  - Byte tetap `apps/web/src/escpos.ts` (ESC/POS 32 kolom: nama/SKU bold ->
    harga **2x2** -> barcode -> FEED -> CUT), digabung `gabungLabel()` lalu
    `kirimPrint()`. Barcode **EAN13/UPC-A/EAN8** dikirim sebagai barcode asli,
    selain itu dicetak angka biasa.
  - Tombol **Label** lama di toolbar halaman Produk **dipindah ke halaman ini**
    (satu pintu, bisa dipilih produknya, bukan cuma "yang sedang tampil").
  - Tanpa printer, print-agent menyimpan ke `apps/print-agent/out/*.bin`
    (bisa dicek/CUPS-kan manual), jadi alur ini bisa diuji tanpa hardware.
* **Cetak struk otomatis** (saklar **Cetak struk otomatis** pada baris **Mode**,
  tampil di semua mode): setiap penjualan dan topup/tarik mengirim struk ke
  print-agent **sebelum** keranjang/state direset.
  - Struk disusun `struk()` di `apps/web/src/escpos.ts` — INIT -> nama toko
    (bold, rata tengah) -> tanggal/no transaksi/kasir/shift -> garis 32 kolom ->
    item (`qty x nama` + line total; baris yang didiskon memunculkan baris
    **Diskon item -Rp…** tepat di bawahnya) -> Subtotal/Diskon (total item +
    diskon transaksi, bila ada)/**TOTAL** (bold)/Tunai/
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
* **Stok & opname** (ikon truk di tiap baris **halaman Stok**, kategori yang dilacak
  stok) kini satu dialog dengan dua mode:
  - **Masuk barang** = restock lama: menambah `qty`, minimal 1.
  - **Hitung fisik** = opname: menulis jumlah HASIL HITUNG apa adanya, termasuk
    `0` (barang habis/rusak). Hint menampilkan **selisih live** sebelum disimpan
    (`Stok tercatat: 57 · selisih -5 -> stok jadi 52`), dan toast melaporkan
    `57 -> 52 (-5)`. Angka input mengikuti mode (`1` untuk masuk, stok tercatat
    untuk hitung fisik) supaya angka tidak berpindah mode dengan arti berbeda.
  - Riwayat masuk ke `stock_moves` dengan `reason='opname'` dan `qty` = selisih.
* **Duplikat produk** (menu **⋮** pada baris) — untuk membuat **varian**
  dari produk yang sudah ada, mis. *Bolpoin Snowman* punya warna hitam/merah/biru:
  cukup salin, ganti nama & barcode, selesai.
  - **Disalin**: kategori, satuan, harga beli, markup, harga jual, satuan jual
    alternatif, stok minimum, saklar harga-dinamis, **diskon permanen**
    (`discount_type` + `discount`) dan **tanggal kadaluarsa** — keduanya ikut
    terisi di form, tinggal dikosongkan kalau varian tidak boleh diskon.
  - **TIDAK disalin** (sengaja):
    - **SKU** — selalu baru. Diisi otomatis (`NAMA-2`, `-3`, ...) dan ikut
      digenerate ulang selama kasir belum mengetik SKU sendiri.
    - **Barcode** — dikosongkan, karena 1 barcode = 1 produk.
    - **Stok** — direset `0`. Varian baru belum tentu ada barang fisiknya;
      menyalin angkanya berarti menciptakan persediaan yang tidak ada.
    - **Foto** — blok Foto hanya dirender mode Ubah (unggah butuh `product_id`,
      dan endpointnya memang per id), jadi varian baru mulai tanpa foto.
  - **SKU wajib unik**: hint di bawah kolom menandai `unik` / `sudah dipakai!`
    secara live, dan tombol Simpan ditolak dengan toast bila SKU sudah dipakai
    produk lain. Tanpa cek ini, `POST /api/products` yang meng-*upsert* by SKU
    akan **menimpa produk lain diam-diam**. Pola daftarnya sama dengan dialog
    impor (aktif + nonaktif). Kosongkan SKU untuk menyerahkan kehitungan ke
    server — server memeriksa langsung DB, paling aman bila state belum sinkron.
* **Halaman Stok** (`#/stock`, menu **Stok** di sidebar) — selama ini masih
  kerangka, kini terisi:
  - **Ringkasan**: jumlah produk dilacak stok, stok habis, stok menipis, dan
    nilai persediaan (`stok × modal rata-rata` — bukan `cost` manual).
  - **Filter** Semua / Stok menipis / Stok habis / **Stok minus** plus pencarian
    (nama, SKU, barcode, kategori). Urutan tabel diurutkan menurut urgensi:
    minus dulu, lalu habis, lalu menipis, lalu aman. "Stok minus" hanya muncul
    bermakna setelah pengaturan **Stok boleh minus** diaktifkan (lihat entri
    **Pengaturan**); minus ≠ habis (0) dan ≠ menipis (butuh `min_stock > 0`).
  - **Restock & opname** langsung dari barisnya (dialog yang sama dengan
    halaman Produk), dan angka langsung ter-update setelah disimpan.
  - **Riwayat mutasi** (ikon jam di tiap baris): modal **Riwayat stok —
    &lt;produk&gt;** menampilkan 100 mutasi terakhir dari
    `GET /api/stock-moves?product_id=&limit=100` — waktu, jenis (penjualan /
    pembelian masuk / selisih hitung fisik / rusak-hilang), qty berwarna
    (+hijau / −merah / 0 abu), keterangan (nama pembeli, kasir, nomor nota),
    harga modal per mutasi, dan kasir. **Hanya baca** — semua tulis stok tetap
    lewat tombol truk; tanpa mutasi ada pesan kosong, bukan tabel kosong.
  - **Ekspor** (tombol di toolbar): mengunduh `stok-ravaa.csv` berisi
    `SKU,Nama,Stok` untuk **baris yang sedang tampil** — ikut
    filter dan pencarian, jadi "yang saya lihat = yang saya dapat".
  - **Impor** (tombol di toolbar): menerapkan angka stok dari CSV, dengan alur
    yang sama dengan impor produk (pilih file / tempel dari Excel ->
    **Baca & tinjau** -> **Impor**). Tombol **Impor** mati sampai pratinjau
    ada, dan mati lagi begitu isi diubah, supaya yang dikirim selalu sama
    dengan yang dilihat kasir.
    - **Impor hanya untuk HITUNG FISIK.** Angka pada kolom `Stok` menjadi stok
      baru apa adanya, termasuk 0, dan selisihnya tercatat sebagai mutasi
      (`POST /api/stock-opname`). Pratinjau menampilkan kolom **Saat ini** dan
      **Sesudah**, jadi dampaknya terlihat sebelum satu pun angka berubah.
    - **Masuk barang tidak lewat impor** — alasannya dua-duanya fakta, bukan
      selera: (1) format ekspor (`SKU,Nama,Stok`) berisi
      hitungan **absolut**, jadi menjumlahkannya kembali akan **menggandakan
      stok** setiap kali file hasil unduh diimpor ulang; (2) berkasnya tidak
      punya kolom harga beli dan dialog tidak pernah mengirim `harga_beli`,
      sehingga `avg_cost` tak akan pernah terperbarui — padahal `avg_cost`
      adalah satu-satunya sumber HPP. Masuk barang dikerjakan per item lewat
      tombol truk, yang sudah punya isian **Harga beli / nota**.
    - Pembaca hanya memakai kolom `SKU` dan `Stok`; kolom lain dilewati, jadi
      hasil unduh halaman Stok **maupun halaman Produk** bisa langsung masuk.
    - **Tidak ada endpoint baru**: tiap baris ditembak ke
      `POST /api/stock-opname`, sehingga `version` naik per baris persis
      seperti dilakukan manual lewat tombol truk.
  - Hanya produk kategori `track_stock=1` yang tampil — jasa/cetak/desain/topup
    tidak punya stok.
* **Riwayat transaksi** (`#/history`, menu **Riwayat transaksi** di sidebar,
  baru 2026-09-30) — linimasa **penjualan + topup/tarik** digabung per hari:
  - **Pemilih hari**: tanggal + tombol sebelumnya/berikutnya + **Hari ini**.
    Harinya memakai UTC persis seperti `GET /api/reports/daily` (filter
    `date(created_at)=date(?)`), jadi baris di halaman ini dan angka halaman
    Laporan **tidak mungkin berbeda**. Tanggal rusak (`2026-02-31`, `rabu`)
    ditolak 400 — bukan menghasilkan hari kosong palsu.
  - **Ringkasan** kanan atas diambil dari `GET /api/reports/daily` (jumlah &
    omzet penjualan, jumlah topup/tarik + nominal + admin) — bukan dihitung dari
    daftar, supaya tetap benar walau daftar dibatasi 200 baris.
  - **Tabel**: Waktu · Jenis (badge Penjualan / Topup / Tarik) · Keterangan
    (`n item · Nota …` atau `layanan · nomor`) · Metode · Total. Klik baris ->
    rincian terbuka: penjualan menarik **isi nota** lewat `GET /api/sales/:id`
    (item + diskon per baris, subtotal, diskon transaksi, total, uang
    diterima/kembali, kasir, shift) — hanya saat dibuka, jadi seratus nota
    tidak ditarik sekaligus; topup/tarik menampilkan nominal/admin/nomor dari
    baris yang sudah ada di daftar.
  - **Tanpa pembatalan/refund**: riwayat bersifat catatan, sama seperti riwayat
    mutasi stok. Koreksi lewat stok opname + transaksi baru.
  - Endpoint baru: `GET /api/sales` dan `GET /api/topups`, keduanya berparameter
    `date` / `limit` / `offset` (kontrak lengkap di AGENTS §3).
* **Laporan** (`#/reports`, menu **Laporan** di sidebar) — laporan harian pemilik
  toko, seluruh angka diambil **utuh** dari `GET /api/reports/daily?date=`
  (satu sumber data; halaman ini tidak menghitung ulang apa pun, jadi angkanya
  mustahil beda dengan ringkasan halaman Riwayat transaksi / Dashboard):
  - **Pemilih hari**: tanggal + tombol sebelumnya/berikutnya + **Hari ini**,
    aturan hari UTC yang sama dengan server.
  - **4 kartu ringkasan**: Omzet (dengan jumlah transaksi), Laba, HPP, Diskon.
  - **Rekap metode bayar** (tunai/QRIS/transfer + baris Jumlah), **Topup &
    tarik** (nominal vs admin, dengan catatan bahwa keduanya di luar omzet),
    **Produk terlaris** 10 teratas (dikelompokkan per nama + satuan, jadi
    "2 pack" dan "3 btl" tidak tercampur), **Stok menipis** (tautan ke halaman
    Stok).
  - **Ekspor CSV** `laporan-YYYY-MM-DD.csv` (BOM UTF-8, ISO/Excel-friendly)
    dari data yang sedang tampil — tiga blok berurutan: Ringkasan, Metode
    bayar, Produk terlaris.
  - **Tanpa endpoint baru**: memakai `GET /api/reports/daily` yang sudah ada.
* **Pengaturan** (`#/settings`, menu **Sistem** di sidebar) — satu kartu yang
  tumbuh sendiri: **Stok boleh minus** (`settings.allow_negative_stock`).
  Daring = penjualan boleh membuat stok menembus nol (stok jadi angka minus dan
  langsung terlihat di filter **Stok minus** halaman Stok); mati = `POST /api/sales`
  menolak dengan 400 seperti perilaku lama. Nilainya disimpan lewat
  `GET/POST /api/settings` (boolean sungguhan — angka `0`/`"ya"`/`null` ditolak
  400), jadi HP kasir yang offline tetap memakai keputusan terakhir.
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
    `min_stok`, `harga_dinamis`, `aktif`, ...) **maupun nama Aronium**
    (`Name`, `ProductGroup`, `SKU`, `Barcode`, `MeasurementUnit`, `Cost`,
    `Markup`, `Price`, `IsPriceChangeAllowed`, `IsEnabled`, `Quantity`,
    `MinStock`) — jadi **file ekspor Aronium lama (16 kolom) tetap bisa langsung
    dimasukkan tanpa diubah**. Lima kolom Aronium yang tidak dipakai Ravaa
    (`Tax`, `IsTaxInclusivePrice`, `IsUsingDefaultQuantity`, `IsService`,
    `Description`) diabaikan dengan aman; `track_stock` tetap diambil dari
    kategori, bukan dari `IsService`.
    (Kolom `Barcode` dulu terbaca tapi **dibuang diam-diam** — `ALIAS` sudah
    memetakannya, `mapRows` tak pernah menyalinnya ke payload. Sekarang ikut
    tersimpan; ketahuan lewat test format Aronium.)
  - Tombol **Unduh template** mengunduh CSV `template-produk-ravaa.csv`
    berisi **14 kolom — namanya persis label di form**, supaya kasir bisa
    mencocokkan kolom CSV dengan layar yang dia lihat:

    ```
    Nama,Kategori,SKU,Barcode,Satuan,Harga beli,Markup,Harga jual,
    Boleh ubah harga saat jual,Aktif,Stok,Stok minimum,Diskon,Tanggal kadaluarsa
    ```

    Lima kolom Aronium sengaja tidak ikut karena memang tidak ada di form:
    `Tax`, `IsTaxInclusivePrice` (sistem pajak tidak dipakai), `Description`,
    `IsUsingDefaultQuantity`, `IsService`. **Parser tetap menerima semuanya**,
    jadi file ekspor Aronium lama (16 kolom) tetap bisa langsung diimpor.
    Dua kolom terakhir (baru 2026-09-29) ditambahkan di **ujung** supaya file
    yang sudah beredar tidak bergeser urutannya:
    - **`Diskon`**: `1500` = Rp1.500, `10%` = 10 persen (tanpa tanda =
      rupiah, sama seperti form). Sel **kosong = kolom absen = tidak diubah**
      (produk lama tetap mempertahankan diskonnya), sedangkan `0` yang ditulis
      eksplisit berarti *hapus diskon*.
    - **`Tanggal kadaluarsa`**: `YYYY-MM-DD` (format ekspor) atau
      `DD/MM/YYYY` / `DD-MM-YYYY` gaya Excel Indonesia — keduanya dinormalkan
      ke ISO sebelum dikirim (server hanya menerima ISO). Tanggal yang tidak
      ada di kalender (`31-02-2026`) gagal di pratinjau, bukan diterima diam.
    Tombol **Contoh format** lama sudah dihapus — digantikan tombol ini
    (satu tombol, satu file, sudah berisi baris contoh: satu baris diskon
    persen + satu baris diskon rupiah dengan tanggal kadaluarsa).
    Berbeda dari file ekspor Aronium yang beredar, template ini **tidak** memuat
    baris `Group 1`: kategori/satuan contohnya diambil dari **master hidup**,
    karena `Group 1` tidak ada di Ravaa dan akan membuat semua baris gagal
    `Kategori tidak ada di master`. Baris contoh ditandai `CONTOH` di awal
    nama — hapus atau ganti sebelum impor. Ada BOM di depan supaya Excel
    Windows membaca UTF-8 benar (parser membuang BOM-nya sendiri).
  - **Kategori & satuan boleh ditulis namanya** ("ATK", "Lembar") — server/master
    menurunkan slug-nya. Kategori yang belum ada di master harus dibuat dulu:
    barisnya dilaporkan `Kategori "..." tidak ada di master` (bukan gagal diam).
  - Angka menerima gaya Indonesia dan internasional (`1.500` = 1500, `1500,50` =
    1500.5, `Rp 3.000` = 3000).
  - Baris bermasalah TIDAK menggugurkan file: baris valid tetap diimpor, baris
    gagal dilaporkan per nomor baris aslinya.
  - **Kolom yang tidak ada di berkas = jangan diubah**, bukan "setel ke 0".
    Kontrak `POST /api/products` memang mereset field yang tidak dikirim ke
    default server, tapi di impor kolom absen berarti *file ini tidak
    memuatnya*. Tanpa aturan itu, file tanpa kolom `Stok`/`Harga jual`/
    `Satuan` akan diam-diam menyetel produk yang sudah ada jadi 0 / `pcs`
    tanpa jejak `stock_moves` — kejadian nyata sebelum diperbaiki: stok 7 ->
    0, harga 1000 -> 0 lewat satu baris impor tanpa kolom tersebut. Server
    memasang bendera `pertahankanTidakDikirim` **hanya** di
    `/api/products/import`, sehingga perilaku `POST /api/products` (form
    produk & toggle aktif yang mengirim payload lenkap) tidak berubah.
    Angka yang memang dikirim tetap ditulis apa adanya — kolom `Stok` di
    berkas tetap menulis ulang stok.
  - **Bukan `.xlsx`**: file itu ZIP+XML dan butuh dependensi parser — sengaja
    tidak dipasang. Jalan pintas Excel: Blok sel -> Ctrl+C -> tempel.
* **Ekspor produk** (`#/products` -> tombol **Ekspor**): mengunduh
  `produk-ravaa.csv` berisi **produk yang lolos filter saat ini** — ikut filter
  status, kategori, dan pencarian ("yang saya lihat = yang saya dapat"; batas
  render 50 baris tidak ikut membatasi — yang diekspor adalah seluruh hasil
  filter yang sudah termuat).
  - Urutan kolom **identik dengan `HEADER_TEMPLATE`** (14 kolom di atas), jadi
    hasil unduh bisa langsung dimasukkan lagi lewat tombol **Impor** tanpa
    disesuaikan — bolak-balik utuh (termasuk `Diskon` ditulis `10%`/`1500` dan
    `Tanggal kadaluarsa` ISO), dan itu diuji langsung (ekspor produk
    diterima pembaca stok).
  - Kolom `Stok` ikut terbawa supaya bolak-baliknya lengkap. Mengimpor kembali
    memang menulis ulang angka stok, tapi dialog Impor selalu menampilkan
    pratinjau sebelum mengirim — jadi keputusan sadar, bukan diam-diam.
  - BOM Excel dipasang di helper `unduhCSV()` (bukan di tiap pemanggil), supaya
    tidak bisa terlewat dan membuat Excel membaca UTF-8 salah.
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
