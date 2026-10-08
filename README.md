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

Backup DB: API membuat **backup otomatis** — sekali saat hidup lalu cek tiap
jam (idempoten per hari UTC), file baru juga dari tombol **Backup sekarang**
di `#/settings`. File ada di `apps/api/data/backups/` (retensi 14 terbaru).

**Restore (manual):** matikan API -> salin file backup pilihan menjadi
`apps/api/data/data.db` -> hidupkan lagi -> buka shift baru. Contoh:

```bash
systemctl --user stop ravaa-api   # atau Ctrl+C proses dev:api
cp apps/api/data/backups/data-2026-10-02-140135.db apps/api/data/data.db
npm run dev:api
```

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
* **Pelanggan** (`#/customers`, menu **Pelanggan** di sidebar, baru 2026-10-04):
  master kontak pembeli — **no. customer (`CUS-000001`) & no. supplier
  (`SUP-000001`) otomatis dari server** (urut, tidak pernah diulang; nomor
  lama yang masih kosong diisi saat baris pertama disimpan ulang, nomor yang
  sudah terbit tidak berubah), nama, HP, **alamat**, catatan. Cari multi-kata
  (semua kata harus cocok di nama/HP/catatan, pola search produk). Tambah/ubah/
  hapus lewat modal + konfirmasi. **Pelanggan yang masih punya catatan hutang
  tidak bisa dihapus** (server tolak 400 dan menyuruhnya menghapus catatan di
  halaman Hutang dulu) — riwayat piutang harus utuh. `id` dikirim = update,
  tanpa id = baru; sengaja bukan upsert by phone (nomor bisa dipakai bersama
  keluarga/karyawan). Seed menanam **`Pelanggan Umum`** = pilihan bawaan
  header POS.
* **Hutang** (`#/debts`, menu **Hutang** di sidebar, baru 2026-10-04): buku
  piutang toko — kartu **Total piutang berjalan**, tabel per pelanggan (urut
  sisa terbesar, toggle tampilan `open|semua`), dan per baris dialog **rincian
  ledger** (mutasi `charge` = berhutang, `payment` = bayar, masing-masing
  membawa sisa berjalan; baris salah ketik bisa dihapus). Form **Catat
  hutang** / **Catat bayar** memilih pelanggan lalu nominal — pembayaran lebih
  besar dari sisa ditolak server (400). **Saldo tidak pernah disimpan sebagai
  angka**: sisa selalu dihitung `SUM(charge) − SUM(payment)` saat dibaca, jadi
   hapus 1 baris tidak pernah meninggalkan angka basi. **Per baris tabel**
   ada tombol **Bayar** (ikon dompet, hanya pelanggan belum lunas) yang
   membuka form catat bayar sudah-prefill nama + sisa + pratinjau "Sisa
   setelah bayar" (netral `—` selama nominal kosong), dan dialog rincian
   punya tombol **Cetak A4** — dokumen ledger HTML (`@page A4`, kop
   `store_*` + tabel kronologis **striped** + ringkasan bawah berupa
   **tabel garis-bawah-saja** (`Total dihutang` / `Total dibayar` /
   `Sisa hutang`, **bukan box** — putaran 15, 2026-10-06)) dibuka lewat popup
   browser `window.print()`, pola sama `invoice.ts`, **tanpa print-agent**
   (gagal/popup diblokir hanya toast, tidak membatalkan). Hutang dicatat
   **manual di halaman ini** *dan* **otomatis dari POS** sejak putaran 12
   (uang kurang/0 + pelanggan valid -> `charge` `Nota <invoice_no> — sisa
   bayar POS`; lihat butir Hutang di POS).
* **Form produk** (`#/products` -> Tambah/Edit) memakai **modal 2 kolom ala
  RPOS** (lebar `max-w-5xl`): kolom **kiri = kotak foto persegi** (seluruh kotak
  diklik untuk pilih berkas — di mode Tambah/Duplikat pilihan ditahan di memori
  lalu diunggah otomatis setelah produk disimpan, lihat butir Foto di bawah),
  kolom **kanan = form berseksi** — **Detail
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
      `POST /api/products/:id/image` (data URL `image/jpeg|png|webp` —
      **client** yang me-resize ke thumbnail JPEG maks 512px, server menulis byte
      apa adanya dengan batas 300KB), hapus dengan nilai `""`.
      Isi gambarnya diunduh sekali lalu di-cache IndexedDB, jadi thumbnail tetap
      tampil **offline**. Yang boleh dikirim lewat kolom `image` hanya nama
      filenya (dicek regex anti path-traversal).
      **Mode Tambah/Duplikat (baru 2026-10-01)**: kotak foto kini hidup — foto
      dipilih kapan saja, disimpan sementara di memori (`fotoPending`), lalu
      **diunggah otomatis setelah `POST /api/products` sukses** (endpointnya
      butuh id produk, jadi tidak mungkin lebih awal). **Batal** membuang
      pilihan tanpa menyentuh server; kalau unggah foto gagal setelah produk
      tersimpan, kasir diberi toast peringatan terpisah dan tinggal mengunggah
      ulang lewat mode Ubah (produk TIDAK ikut dibatalkan).
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
  Ujung kanan input memuat badge **`F1`** — penanda shortcut fokus scan
  (F1; Esc juga kembali ke sini).
   Mode: **Penjualan / Topup / Tarik** (bar yang sama). Topup-tarik memakai
   `POST /api/topups`; admin terisi otomatis dari tier toko yang sama dengan
   `GET /api/topups/suggest-admin`, dan bisa diedit kasir.
  - **Dua mode dalam satu transaksi (Opsi B hybrid, 2026-10-07)**: keranjang
    Penjualan bisa memuat **baris topup** (tombol **Topup** di Aksi cepat —
    dialog jenis/nomor/token/nominal/admin persis form topup) supaya
    fotokopi + isi pulsa dibayar **sekali** dan tercetak **satu struk
    gabungan**. Record tetap **terpisah** di server: saat Bayar, POS mengirim
    `POST /api/topups` per baris DULU (id uuid stabil → retry idempotent),
    lalu `POST /api/sales` — nominal topup bukan omzet, admin tetap
    pendapatan jasa, agregat shift tetap benar. Barrier uang memakai total
    gabungan dan **baris topup tidak bisa jadi hutang** (uang kurang =
    tolak, fokus kolom uang; hutang otomatis hanya berlaku tanpa baris
    topup). Keranjang hanya-topup juga jalan (tanpa modal resume). Baris
    topup ikut keranjang persisten & transaksi tertahan. Teruji
    `tests/e2e-topup-keranjang.mjs` (45 asersi).
  - **Tanpa header judul** (permintaan pemilik 2026-10-04): `renderPosShell()`
    (`ui/shell.ts`) TIDAK merender `<header>` sama sekali — tidak ada strip
    "Kasir (POS)"; layar kasir mulai langsung dari baris pertama seperti
    referensi KulaPOS. **Tombol kembali ke dashboard (⬅) kini ada di
    konten** lewat `tombolKembaliHtml()` (`pos.ts`): kiri **info bar** pada
    mode Penjualan, dan kiri **baris Mode** pada mode Topup/Tarik (info bar
    tidak dirender di sana) — supaya kasir tidak pernah terkunci di `#/pos`.
    Susunan atas-ke-bawah = referensi: **info bar → scan bar (+ Mode) →
    label keranjang → tabel ‖ sidebar kanan**.
  - **Info bar = elemen pertama** (mode Penjualan saja, sejak 2026-10-04,
    mengikuti layout KulaPOS): kolom kiri = tombol ⬅ + tumpukan dua baris
    **Waktu** (atas) dan **Kasir + Shift** (bawah, permintaan pemilik
    "kasir pindah di bawah waktu") — **jam live** berjalan tiap detik (jam
    lokal, konsisten dengan waktu struk), **select Pelanggan selebar kolom**
    (revisi pemilik 2026-10-04 — dulu dibatasi `max-w-[520px]`;
    daftar `GET /api/customers`, bawaan **Pelanggan Umum** — dipilih kasir
    sebelum bayar, ikut ke `POST /api/sales` sebagai `customer_id` +
    snapshot `customer_name`, di-simpan ke struk/invoice/riwayat, dan
    **kembali ke Pelanggan Umum** setelah tiap penjualan), **ditemani tombol
    kompak `🔍 F9`** (`#pos-cust-cari` — putaran 7 2026-10-04 *"tambahkan
    cari seperti cari produk F3"*; putaran 8b tombol tetap **inline** di
    sebelah select — *"tombol dan dropdown customer tidak inline"* — hanya
    teks "Cari" dibuang, tinggal ikon search + label **F9** polos supaya
    select tetap lega) yang membuka **layar cari pelanggan**
    `openCariPelanggan()` — pola identik layar cari produk (input multi-kata
    nama/HP/nomor urut/catatan, ↑↓ sorot, Enter/klik/**Pilih** = pilih,
    Esc = tutup), lalu fokus balik ke kolom scan, serta **kolom
    total**: label **TOTAL BELANJA** + "n item (n Qty)" (`#pos-owncount`) di
    **kiri** kolom, angka besar `#pos-grand` di **kanan** — ukuran **kustom
    `text-[48px]` = 2x lipat `text-2xl` lama (24px)**, permintaan pemilik
    2026-10-04 "custom ukuran font, besarkan lagi 2x lipat". **Ketiga kolom
    info bar SAMA RATA `lg:grid-cols-3`** (putaran 9 — "jangan lebar di
    tengah"; menggantikan `[auto_1fr_auto]` di mana kolom select yang
    menyerap seluruh sisa lebar; `lg:min-w-[340px]` lama ikut dibuang)
    **dipisah garis vertikal** (`border-l`
    hanya ≥lg; layar sempit kolom menumpuk jadi garis horizontal).
  - **Keranjang = tabel 8 kolom**: No / **Kode** (SKU, mono) / Nama barang /
    Harga / Qty / **Diskon** / Subtotal / **Aksi** (hapus) — deskripsi
    pendukung (unit, `item manual`, badge kadaluarsa) pindah ke bawah nama.
    Baris kosong memakai `colspan="8"` (penuh); baris catatan (`use_note`)
    memakai `colspan="3"` — hanya selebar kolom No..Nama barang
    (2026-10-06).
    **Kolom Harga jadi input untuk produk harga khusus**
    (`products.price_dynamic` — switch "Boleh ubah harga saat jual" di form
    produk): kasir bisa mengubahnya per baris ala Aronium; produk biasa
    tetap teks terkunci. **Aturan baris**: produk sama + harga berbeda =
    baris **baru**, harga sama = qty tambah (key dinamis
    `<id>:<unit>:<harga>`; edit di baris di-re-key, menabrak baris
    berharga sama = kuantitas digabung). **Scan tanpa dialog harga** —
    harga default master langsung masuk, kasir mengubahnya lewat kolom Harga
    (modal `askPrice` dihapus 2026-10-06: *"karena harga bisa di ubah inline,
    modal dynamic harga tidak usah"*).
    **Lebar kolom eksplisit** (putaran 8 2026-10-04, mengikuti lebar kolom di
    referensi `kula-02-transaksi-pos.png`; **di-compact 2026-10-06** — semua
    kolom non-nama kini `max(hint, konten)`: No `w-8`, Kode `w-20`,
    **Nama barang `w-auto`** menyerap seluruh sisa lebar (438 → ±540px
    terukur), Harga/Diskon/Subtotal `w-16`, Qty `w-36` (konten stepper 152px),
    Aksi `w-10`; **input Harga/Diskon `!w-24 !px-2`, Qty `!w-20 !px-2`**
    (lebar kolom mengikuti konten input — ukuran `!w-16` lama terbukti
    memotong digit, mis. "2000" tampil "200"; diuji asersi anti-clip di
    `tests/harga-dinamis-test.mjs`; total lebar tabel tetap 1086px karena
    kolom Nama menyerap seluruh selisihnya).
    **Hover per baris KEBIRUAN** `hover:bg-primary-soft` (+ `dark:hover:bg-primary/15`)
    dengan `transition-colors` — baris disorot biru muda saat mouse lewat
    (token `--color-primary-soft #e6f3ff`, sama dengan state aktif tombol;
    riwayat gray-50 → gray-100 → primary-soft sesuai permintaan *"hover di
    tabel keranjang ubah jadi kebiru-biruan"*). **Input Qty & diskon** sempat
    dikompakkan ke `!w-16` (2026-10-06), lalu disetel `!w-20`/`!w-24`
    `!px-2` — angka besar (harga jual/diskon) harus terbaca utuh.
    **Label baris di atas tabel**: `#pos-count` ("n item" / "Keranjang
    kosong") di kiri + tombol **Bersihkan [F5]** (`#pos-clear`) di kanan —
    dipindah dari bawah tabel mengikuti baris "Keranjang … Bersihkan [F5]"
    di referensi (id tidak berubah, `paintCart()` tetap sama).
  - **Input cepat ala KulaPOS** (sejak 2026-10-04, hasil gap analysis
    `kula-02-transaksi-pos.png`):
    * **Sintaks `Qty*Kode`** di kolom scan — `3*PRD00001` atau `2 * aqua`
      berarti qty 3/2 untuk produk sesudah `*` (`bacaQtyKode()`); placeholder
      kolom scan ikut mengumumkannya. Qty `0` **ditolak** dengan "Qty minimal
      1" (tidak diam-diam dianggap 1), kode tak dikenal jatuh ke pesan
      "tidak ditemukan", dan **tanpa tanda `*` perilaku scan lama utuh**.
      Qty eksplisit **menang atas chip Qty/F4** untuk baris itu, tapi preset
      F4 tidak dikosongkan (masih berlaku untuk item berikutnya). Aturan yang
      sama dipakai **Enter dan klik baris hasil dropdown**.
    * **↑↓ navigasi antar baris keranjang** (`pindahBarisKeranjang()`) selama
      fokus berada di dalam tabel: baris catatan (`use_note`) **dilewati**,
      input catatan dikecualikan (panah di kolom teks = gerak kursor), arah
      **clamp** di ujung baris. Panah di kolom scan tetap milik dropdown
      pencarian, dan di luar tabel tetap gulir halaman.
    * **F7 = Tahan** — pintasan baru untuk fitur tertahan (P5); alokasi F7
      karena F2/F3 sudah dipakai Bayar/Layar cari, jadi Tahan tidak bisa
      memakai F3 seperti KulaPOS. Tombolnya ikut berlabel `F7`.
      Teruji `tests/pos-qtykode-test.mjs` (24 asersi).
    * **Keranjang tahan refresh (putaran 16, 2026-10-06)** — permintaan
      pemilik: *"produk yang berada di keranjang jika kasir pindah ke
      halaman dashboard atau tidak sengaja terrefresh barang tidak
      hilang/keranjang tidak kosong"*. Setiap perubahan keranjang (baris,
      qty, diskon baris & transaksi, catatan, pelanggan) langsung ditulis
      **sinkron** ke localStorage `ravaa.keranjang` (`simpanKeranjang()`;
      sinkron supaya refresh kilat tepat setelah mutasi pun sempat
      tersimpan — tulisan IndexedDB yang lebih lambat pernah terbukti
      terbuang oleh reload). Saat POS dibuka ulang `muatKeranjang()`
      memulihkannya: baris produk yang sudah dihapus dari katalog dibuang,
      harga non-dinamis disamakan dengan master, diskon dijepit ulang, lalu
      toast **"Keranjang dipulihkan — N baris"**. Pindah halaman
      (dashboard ↔ POS) mempertahankan isi memori tanpa perlu reload;
      **Bersihkan** menulis ulang jadi kosong. Uang diterima & mode bayar
      tidak ikut (milik per pembayaran). Teruji `tests/e2e-struk.mjs`
      section M.
    * **F1 / F8 / F9 / F10 / F12** — pintasan putaran 5–7 (2026-10-04,
      direvisi 2026-10-06): **F1** fokus balik ke kolom scan (referensi KulaPOS
      *"Jumlah Beli * Kode [F1/Cmd+K]"*); **F8** kini membuka **modal Pending**
      (dialihkan dari alias scan lama — pemilik: *"F8 sepertinya belum dipakai
      dan bisa digunakan untuk membuka modal pending"*; F1 tetap 1 tekan ke
      scan; holds kosong → toast *"Belum ada transaksi tertahan"*), **F9** buka layar **Cari pelanggan** (ala F3 produk),
      **F10** buka form bayar (referensi Aronium *"Payment (F10)
      opens payment form"*),       **F12** bayar pas (*"Default payment … F12"* —
      tanpa form, tombol gradasi hijau di sidebar). Guard: **swal konfirmasi/pilihan
      cetak yang terbuka menahan seluruh pintasan**, dan form bayar yang
      terbuka hanya mengizinkan F2/F10/F12.
  - **Panel bayar = sidebar kanan 320px** (grid `lg:grid-cols-[1fr_320px]` —
    revisi pemilik 2026-10-04 putaran 4: footer horizontal ala KulaPOS
    **ditolak**, "tidak usah, tetap jadi sidebar kanan tadi"). Isi panel
    berurutan vertikal (**urutan 2026-10-06**: "diskon item pindah ke
    bawah menu cepat di atas diskon"): **Aksi cepat → Menu cepat (Produk |
    Stok) → Diskon item → Diskon transaksi (Rp) → dua tombol bayar menempel
    dasar panel** — pintasan F6
    disebut **hanya di tombol "Diskon F6" grid Aksi cepat** (chip `<kbd>F6</kbd>`
    di sebelah label inputnya dihapus, permintaan pemilik putaran 7 2026-10-04
    "ghapus saja, di atasnya sudah ada label F6 ternyata di tombol diskon").
    Tombol utama **Bayar F10** (`#pos-bayar`, pembuka **form bayar**) dan **tepat di
    bawahnya** tombol **Bayar pas F12** (`#pos-pay-pas`: tunai persis
    total, langsung proses **tanpa form** — permintaan pemilik putaran 6
    2026-10-04 "bayar uang pas letakkan di sidepanel bawahnya Bayar F10";
    **putaran 8b/8c**: gaya akhir = **gradasi hijau + shadow + hover hijau
    lebih gelap** (`bg-linear-to-r from-emerald-500 to-emerald-600 shadow-md
    shadow-emerald-600/40 hover:from-emerald-600 hover:to-emerald-700`) —
    permintaan
    awal *"pakai outline saja"* menghasilkan tombol tanpa warna karena class
    `btn-outline` ternyata tidak ada di `styles.css` (*"style hilang yang
    tombol warna hijaunya"*), lalu pemilik meminta *"warna buat modern,
    gradasi dan ada shadownya"*; hover sempat dibuat kebiruan lalu dibatalkan
    (8c: *"hover tombol F12 juga ubah ke hijau jangan biru, karena tombolnya
    warna hijau"*). Petunjuk
    `F2 bayar cepat` di baris bawah ikut dihapus — kini hanya `F10 form bayar
    · F12 bayar pas`).
    **Isian bayar pindah ke FORM BAYAR (modal)** (putaran 5, permintaan
    pemilik "pindahkan ke modal ketika klik bayar", ala payment screen
    Aronium F10): **Total tagihan → metode bayar → uang diterima + chip
    nominal cepat → kembalian → petunjuk hutang**, OK modal = `#pos-pay`
    (Enter/F2/F10 tetap satu aksi). **Putaran 10 (2026-10-05): modal
    dirombak 2 panel ala Ravaa POS v1** — *"modal bayar silakan dengan
    referensi ravaapos v1 … pendekatan yang sama, tanpa mengurangi
    kecepatan dalam transaksi"* (referensi `payment-modal.blade.php` +
    `.payment-layout-wrapper` flex 5/7): grid **`sm:grid-cols-[5fr_7fr]`**
    (312/436px terukur) + modal **`wide` 768px**; **kiri** = kartu Total
    tagihan border-2 primer `#bayar-total` (angka 3xl) + kotak **Pelanggan
    `#bayar-cust`** (ikon users · `CUS-xxxxxx`, penanda alur hutang) +
    **kartu metode `data-pay` grid 2 kolom** gaya `.btn-method-card` (ikon
    wallet/qr/sync — ikon `qr` baru di `icons.ts`, aktif = primer muda) +
    petunjuk pintasan; **kanan** `bg-gray-50` = **Uang diterima** input
    besar `text-2xl` prefix Rp + **tombol × `#bayar-clear`** (ala
    `btn-clear-huge` v1, bersihkan + fokus balik) → chip nominal grid 2
    kolom → **kotak KEMBALIAN putus-putus** (label statis + angka
    `text-2xl` dari helper `kelasPosChange()` — satu sumber render awal &
    `paintCart`) → petunjuk hutang; metode non-tunai menukar blok ini
    dengan teks "Tanpa uang diterima". **Kecepatan transaksi dijaga**:
    fokus `#pos-cash` saat buka (kolom default KOSONG sejak putaran 10d),
    **klik chip →
    fokus balik ke kolom uang** (kasir tinggal Enter), Enter-on-input/F2/
    F10/F12 tanpa perubahan; semua id lama (`#pos-cash`, `#pos-pay`,
    `data-pay`, `data-cash`, `#pos-change`, `#pos-change-ctx`,
    `#bayar-tunai`, `#bayar-non-tunai`) TIDAK berubah.
    **Putaran 10b (2026-10-05): tombol + uang diterima ~2x lipat** (permintaan
    pemilik *"kurang besar untuk tombol-tombol dan uang diterima … sekitar 2x
    lipat"*): kartu metode 34→**78px** (font 13→24px, layout kolom ala v1 —
    ikon atas label bawah, karena label horizontal @24px tidak muat di kolom
    137px), chip nominal 25→**51px** (font 11→22px), `#pos-cash` 41→**91px**
    (font 20→**40px**, prefix Rp 24px ala `.payment-input-huge` v1, angka
    berhenti sebelum tombol × lewat `!pr-[76px]`), tombol × 28→**56px**, dan
    footer Batal/Bayar 34→**68px** (font 24px, kelas dipasang di `bukaBayar`
    — modal lain tetap ukuran normal). **Putaran 10c (2026-10-05)** lanjutan:
    chip "Uang pas" dihapus + pecahan baru **20.000**, chip kembali ukuran
    normal 1x, **kembalian `#pos-change` font 40px = seukuran uang diterima**
    (*"kembalian kurang besar, seukuran uang diterima"*), dan **total
    tagihan `#bayar-total` 36px** (*"total tagihan di besarkan setengahnya"*
    — +50% dari 24px). **Putaran 10d (2026-10-05)**: chip pecahan
    diperbesar lagi 25→**44px** (font 11→17px, "tombol nominalnya terlalu
    kecil") dan **auto-isi "uang pas" DIHAPUS** — kolom uang diterima
    **default kosong** (*"form uang diterima jangan langsung di isi uang
    pas, karena tujuannya adalah untuk memasukkan nilai uang kurang atau
    uang lebih jadi default 0"*); auto-focus `#pos-cash` tetap, "uang pas"
    kini hanya F12 Bayar pas / pilih chip. Karena itu sidebar tidak lagi penuh
    isian; hierarki Aronium tetap utuh di dalam modal. **Baris "Grand
    total" DIHAPUS** dari sidebar (permintaan
    pemilik 2026-10-04 — duplikat TOTAL BELANJA di info bar atas) dan
    **baris "Subtotal" ikut DIHAPUS** (putaran 7, "ini juga hapus saja" —
    subtotal terbaca dari TOTAL BELANJA + kolom Subtotal per baris tabel;
    ringkasan sidebar kini hanya **Diskon item**, itupun disembunyikan
    saat nilainya 0).
    **Aksi cepat** (grid 2 kolom): **Tahan** + **Pending (n)** = fitur
    **transaksi tertahan (P5)** — `tahanKeranjang()` membekukan isi
    keranjang (items/diskon/pelanggan) ke **IndexedDB per device**
    (`getHolds()`/`saveHolds()`, kv `'holds'`, tanpa endpoint API) lalu
    mengosongkan keranjang; tombol **Pending (n)** membuka **MODAL SPLIT ala
    Ravaa POS v1** (putaran 9/9b, 2026-10-05 — *"ke modal pending, buat 2
    kolom, kiri daftar antrian, kanannya preview"* lalu *"sebagai referensi
    lihat layout di ravaa POS versi 1 … coba di terapkan pada modal pending"*
    — referensi `hold-modal.blade.php` + `.modal-split` +
    `showHoldDetail()`): grid **30/70** (`grid-cols-[3fr_7fr]`, `wider` ≈
    modal-lg 900px v1), tiap kolom **tinggi fix 60% layar (`h-[60vh]`) +
    scroll** (*"tinggi fix misal 60% dari screen atau 80%, dan buat
    scrollable jika barang ada banyak"*). KIRI = split-header **"DAFTAR
    ANTRIAN (n)"** + kartu antrian gaya `.split-item` v1 (hover biru, kartu
    terpilih **solid primer + teks putih + shadow**; klik kartu = pilih;
    berisi nama pelanggan · total · baris/Qty · waktu). KANAN =
    `#hold-preview` persis struktur v1: header-info **Pelanggan | Waktu
    simpan** (garis dashed) → **Daftar Produk (N item)** kartu abu-abu
    (`SKU · qty × harga`, netto primer di kanan) → kotak ringkasan
    **Subtotal/Diskon/Total** → dua tombol **[Hapus outline] [Lanjutkan
    primer]** di bawah detail (bukan per kartu; **Lanjutkan** = muat balik
    ke keranjang + konfirmasi swal bila keranjang terisi, **Hapus** =
    konfirmasi danger, kedua kolom dirender ulang, modal ditutup sendiri
    bila antrian habis); daftar bertahan setelah reload. **Item manual** & **Diskon** memanggil
    aksi yang sudah ada (putaran 7: tombol ganda `#pos-manual` di scan bar
    DIHAPUS — yang tetap hanya `#pos-qa-manual` di panel kanan, *"karena di
    bawah sudah ada pada deretan tombol panel kanan"*); **Riwayat** (anchor `#/history`,
    menggantikan slot **Voucher** — keputusan 2026-10-06: *"tombol bisa di ubah ke
    history transaksi"*; voucher & PPN ditutup permanen) + **Cetak ulang** = tombol placeholder
    (`data-soon` → toast "menyusul") — tombol sudah dulu, fiturnya
    menyusul sesuai permintaan pemilik. Semua id/selector lama
    (`#pos-cash`, `#pos-pay`,
    `#pos-change`, chip `data-cash`) tetap dipertahankan — pintasan F2/Enter,
    barrier uang diterima, dan suite test tidak berubah. Di layar sempit
    (<lg) panel jatuh di bawah keranjang.
  - **Dialog selesai = uang kembali**: judul **`Kembalian RpX`** (bila
    uang diterima > total) atau "Pembayaran berhasil", pesan memuat total +
    uang diterima, tombol **[Thermal] [A4] [Selesai]** — kasir melihat
    nominal kembalian di layar sebelum menutup transaksi.
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
    Strip ini **murni visual** — blokir keras (400 dari server) adalah pilihan
    terpisah: **Pengaturan → Tolak jual kadaluarsa**, lihat bagian Pengaturan.
  - **Nominal cepat di panel bayar tunai** (gaya Kasir Pintar): **4 pecahan
    Rp20.000 / Rp50.000 / Rp100.000 / Rp200.000** — satu klik mengisi kolom
    **Uang diterima**, kembalian ikut terhitung, chip yang cocok tersorot.
    **Putaran 10c (2026-10-05)**: chip **"Uang pas" DIHAPUS dari modal**
    (permintaan pemilik *"Jangan ada uang pas, karena sudah ada tombol F12"*
    — `#pos-pay-pas` Bayar pas tetap di side panel) dan diganti pecahan
    20.000; chip kembali **ukuran normal 1x** (*"tombol uang itu kecilkan
    1xnya"* — pembesaran 10b dibatalkan khusus chip; lalu **putaran 10d**
    menaikkannya lagi ke **44px/17px** — *"tombol nominalnya terlalu kecil"*).
    Chip hanya ada di mode
    tunai (QRIS/transfer tidak butuh nominal).
  - **Panel bayar disusun seperti payment screen Aronium** (referensi
    help.aronium.com *Payment*): hierarki **Total** angka besar biru ->
    **Uang diterima** input besar (placeholder = amount due, meniru "Paid"
    Aronium yang menampilkan total tagihan) -> **Kembalian** angka besar
    otomatis (hijau saat cukup, merah saat kurang). Sejak putaran 10
    hierarki itu hidup di **kolom kanan panel 5/7 ala Ravaa POS v1**
    (kolom kiri = total + pelanggan + kartu metode, lihat atas), tetap
    dengan token & komponen repo (`.chip`, `.btn`, `.input`).
  - **Barrier uang diterima (tunai)**: tombol **Bayar**/pintasan F2/Enter
    DITOLAK dengan toast bila uang diterima **kosong** ("Uang diterima belum
    diisi — ketik nominal atau tekan Bayar pas (F12)") atau **kurang dari total**
    ("Uang diterima kurang dari total RpX"); fokus dikembalikan ke kolom
    uang.     Dulu `cashIn=0` lolos cek dan transaksi bisa selesai tanpa menerima
    uang. Barrier serupa berlaku untuk **topup tunai** — sejak refactor 1
    layout (2026-10-07) uang diterima diisi di **modal bayar bersama**
    (`cashIn`, kolom `#tp-tunai` lama sudah dihapus); aturannya tetap sama:
    topup tunai wajib uang > 0 dan ≥ total, gagal = modal tetap terbuka +
    fokus kolom uang. Mode **Tarik dikecualikan dari syarat >0**
    (uang mengalir keluar, kolom boleh kosong) — tapi `0 < uang < total`
    tetap ditolak.
    Teruji 6 asersi regresi di `tests/e2e-struk.mjs` (section F).
  - **Uang kurang / uang 0 = HUTANG OTOMATIS** (putaran 12, instruksi
    pemilik 2026-10-06; syarat pelanggan sejak 2026-10-04): bila uang
    diterima < total (termasuk **0/kosong**) dan ada **pelanggan terpilih
    yang bukan bawaan "Pelanggan Umum"**, penjualan **langsung diteruskan
    tanpa konfirmasi** (dialog swal lama "Uang kurang — catat jadi hutang?"
    dihapus) lalu `POST /api/customer-debts` `type=charge` dengan catatan
    `Nota <invoice_no> — sisa bayar POS`. Kasir tahu dari toast
    `· hutang RpX (nama)`, **baris `Hutang` merah di modal resume**, dan
    baris `Hutang` di struk; **gagal mencatat ledger TIDAK membatalkan
    penjualan** (toast menunjuk halaman Hutang). Syarat tidak terpenuhi =
    penolakan barrier **persis** (pesan + fokus kolom uang), jadi uang
    kurang tidak pernah lolos diam-diam. Teruji section **J**
    `tests/e2e-struk.mjs` (penolakan + otomatis kurang + otomatis uang 0 +
    ledger + resume).
  - **Qty item berikutnya** (gaya Aronium *Changing the quantity*): chip
    **Qty** di scan bar (mode Penjualan) atau tekan **F4** — isi angka, item
    BERIKUTNYA masuk keranjang dengan qty itu, chip lalu otomatis kembali
    **Qty 1** (sekali pakai; scan berikutnya tidak ikut kena diam-diam).
    Chip tersorot selama preset > 1.
  - **Layar cari produk** (gaya Aronium *Adding a product*): tombol **Cari**
    di scan bar atau tekan **F3** — modal lebar berisi daftar produk (filter
    nama/SKU/barcode semua-kata-cocok, ↑↓ pilih, Enter/klik = tambah,
    **Tambah**/Esc = tutup), daftar awal memuat sampai 100 produk. Hanya mode
    Penjualan dengan shift terbuka; F3/F4 selalu `preventDefault` (supaya
    browser tidak membuka find bar) walau modal sedang terbuka — aksinya
    sendiri dilewati oleh guard modal yang sama dengan F2.
  - **Layar cari pelanggan** (putaran 7 2026-10-04, *"tambahkan cari seperti
    cari produk F3"*): pemicu **`#pos-cust-cari`** (ikon 🔍 + `<kbd>F9</kbd>`,
    pintasan **F9**) **inline di sebelah select Pelanggan** (putaran 8b — teks
    "Cari" dibuang, tinggal ikon search + **F9**) — modal
    lebar `openCariPelanggan()`
    dengan pola identik layar cari produk F3 (filter bebas nama/no.HP/nomor
    urut/catatan, ↑↓ pilih, Enter/klik/**Pilih** = set `customerId` + nilai
    select, Esc = tutup), lalu fokus otomatis balik ke kolom scan. Sangat
    membantu bila kontak pembeli di master sudah panjang (teruji section **K**
    `tests/e2e-struk.mjs`).
  - **Catatan per baris** (sejak 2026-10-03, kolom `products.use_note`):
    produk yang sakelarnya **"Catatan di POS"** menyala (di-set pemilik lewat
    form produk Tambah/Ubah) menampilkan **input catatan di bawah barisnya**
    di keranjang — contoh pemilik: produk *Cetak Banner* diketik
    `ukuran 1 x 3 meter`. Teks dikirim sebagai `items[].note`, di-snapshot
    server ke `sale_items.note` (maks 200 karakter, di-trim), lalu **ikut
    tercetak di struk** sebagai baris indented `"  - <note>"` di bawah item
    (layout thermal 32 kolom maupun A4 64 kolom) dan ikut **Cetak ulang
    struk** dari halaman Riwayat. Input memakai event `input` live (tanpa
    paint ulang) supaya fokus tidak lompat di tengah ketikan; produk tanpa
    saklar tidak menampilkan baris catatan sama sekali.
  - **Pintasan keyboard level document** (`bindPintasan()` di
    `apps/web/src/pages/pos.ts`): **F2** = bayar cepat (atau proses topup),
    **F3** = layar cari produk, **F4** = qty item berikutnya, **F5** =
    bersihkan keranjang, **F6** = fokus diskon transaksi, **F7** = tahan
    transaksi, **Enter** = bayar
    dari kolom uang diterima / proses topup, **Esc** = fokus
    kembali ke kolom scan, serta **↑↓** = pindah baris keranjang (hanya saat
    fokus di dalam tabel — lihat *Input cepat ala KulaPOS*). Dulu listener
    menempel ke elemen `host`, jadi mati
    begitu fokus jatuh ke `<body>` (klik area kosong / balik dari modal) —
    kini didaftarkan sekali per mount di `document` + dibuang di
    `unmountPosPage()`. Guard: modal terbuka = lepas, tombol/link = aktivasi
    native, isian teks lain (diskon, nominal admin) tidak ikut kena.
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
* **Modal resume + pilihan cetak setiap penjualan** (revisi pemilik
  2026-10-05, putaran 11 — sebelumnya "Cetak struk otomatis"): setiap
  **penjualan selesai** — semua jalur, termasuk **F12 Bayar pas** — membuka
  modal **[Thermal] [A4] [Selesai]** sebelum keranjang/state direset,
  **tanpa syarat saklar** (1A): judul hero **KEMBALIAN** — label kecil +
  **angka kembalian 48px** (putaran 11b, "kembalian kurang besar, agar
  kasir mudah melihat kembalian"; "Pembayaran berhasil" bila kembalian 0)
  + **badan resume** ringkas: **subjudul** *"Siap melayani pelanggan
  berikutnya."* + **No. nota · jam**, daftar item (maks 5 baris + "… +N item
  lainnya"), **Total**, baris
  `Tunai`/metode — supaya kasir verifikasi nota & uang kembali dalam satu
  layar. **Esc = tutup langsung** (putaran 11c — listener Esc dipindah ke
  window-capture karena fokus sempat di kolom scan, bukan di popup) dan
  penutup apa pun (Esc/Selesai/Thermal/A4) **mengembalikan fokus ke kolom
  scan** supaya transaksi berikutnya langsung jalan. Saklar **Cetak struk
  otomatis** (baris **Mode**, juga per-device
  lewat **Sistem → Cetak struk**) kini hanya **mengizinkan tombol
  Thermal/A4 mengirim ke printer** — klik saat saklar mati = toast
  "Cetak sedang mati…", modal tetap muncul. Gagal cetak **tidak pernah**
  membatalkan transaksi (cukup toast peringatan sekali per sesi).
  **Topup/tarik tanpa dialog** — struk langsung dikirim sesuai layout
  per-device.
  - **Pilihan A4 = INVOICE A4 gaya Aronium** (baru 2026-10-03): membuka tab
    baru berisi nota invoice A4 (kop **INVOICE** + nama/alamat/Phone/Email
    toko + logo "R", Bill to pelanggan terpilih — *Pelanggan Umum* bila
    kosong —, **Invoice No. `YYMMDD-NNNNNN`**
    (tahun+bulan+tanggal, nomor urut harian yang di-assign server), tabel item
    + baris catatan
    `* note`, ringkasan Discount/Total, Payment method/Paid amount/Change)
    lalu `window.print()` otomatis — **lewat browser/CUPS, bukan print-agent**
    (`lp -d EPSON-L3110-Series` untuk L3110). Isinya lewat
    `GET /api/sales/:id` + `GET /api/settings`; kalau nota gagal dimuat hanya
    toast peringatan, penjualan tetap tersimpan.
    **Hutang di invoice** (2026-10-06): nota berhutang mencetak **Payment
    status "Belum lunas"** + baris merah **`Hutang:`** (sisa nota ini, dari
    snapshot `sisa_hutang`) di rincian pembayaran; bila pelanggan masih punya
    piutang lain, ditambah kotak **`Sisa hutang (semua nota)`** dari ledger
    halaman Hutang (`GET /api/customer-debts/:id` — gagal muat hanya membuat
    baris itu gugur, cetak tidak dibatalkan).
    Kop disimpan **di server** (4 kunci `store_*`) lewat kartu **Pengaturan
    toko** di **Sistem → Pengaturan toko** — semua device mencetak kop yang
    sama; nilai awal = contoh pemilik (RAVAA STUDIO) lewat seed.
  - **Dua layout struk** — dipilih per device di **Sistem → Cetak struk**
    (default *Thermal*; pilihan dialog terakhir juga menyetel pref ini untuk
    struk topup/tarik berikutnya):
    - **Thermal 58mm** (bawaan): 32 kolom, diakhiri FEED + **CUT** — printer
      termal dengan pisau potong (Caysn/dll).
    - **Epson L3110 (A4)**: 64 kolom, judul dobel lebar, **tanpa CUT**, ditutup
      **Form Feed (0x0C)**. Inkjet tidak punya pisau potong — tanpa perintah
      eject ini kertas tercetak tapi menumpuk di dalam printer (bug nyata di
      L3110). Kini khusus struk topup/tarik (penjualan A4 = invoice browser);
      label harga tetap memakai `sesuaikanPrinter()` (batch ditutup FF).
  - Struk disusun `struk()`/`strukA4()` di `apps/web/src/escpos.ts` — INIT -> nama toko
    (bold, rata tengah) -> tanggal/no transaksi/kasir/shift -> garis 32 kolom ->
    item (`qty x nama` + line total; baris yang didiskon memunculkan baris
    **Diskon item -Rp…** tepat di bawahnya) -> Subtotal/Diskon (total item +
    diskon transaksi, bila ada)/**TOTAL** (bold)/Tunai/
    Kembalian -> kaki -> FEED -> CUT (thermal) / Form Feed (A4).
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
    - **Foto** — foto produk sumber **tidak ikut disalin**, tetapi kotak foto
      di form Duplikat hidup: pilih foto varian sekarang, ia diunggah otomatis
      begitu produk barunya disimpan (aturan sama dengan mode Tambah).
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
* **Dashboard** (`#/dashboard`, rute pembuka `#/`, baru 2026-09-30) — halaman
  pertama yang terbuka, ringkas untuk pemilik & kasir:
  - **4 kartu**: Omzet hari ini (+jumlah transaksi), Laba hari ini, Topup &
    tarik (nominal + admin), dan **Antrian offline** (`outboxCount()` dari
    localStorage — naik otomatis kalau POS gagal menembak server; disegarkan
    tiap 5 detik selama halaman terpasang, jadi angkanya tidak basi).
  - **Grafik penjualan 7 hari**: batang **murni CSS** (tanpa chart-lib —
    dilarang repo), tinggi relatif terhadap hari terlaris, hari ini ditandai
    warna penuh; tiap batang membawa `data-tgl`/`data-omzet`/`data-n` dan
    `title` lengkap, jadi angkanya bisa dicek tanpa membaca tinggi bar.
  - **Status shift** dari `GET /api/shifts/open?cashier=` — **endpoint yang
    sama dengan gerbang POS**, jadi "shift terbuka" di sini = shift yang
    benar-benar bisa dipakai jualan; tanpa shift tersedia tombol ke POS.
    Gagal cek (offline) hanya mengosongkan kartu ini, dashboard tetap tampil.
  - **Stok menipis** (tautan ke halaman Stok) + tombol **Segarkan**.
  - **Tanpa endpoint baru**: 7 pemanggilan paralel
    `GET /api/reports/daily?date=` (hari ini + 6 sebelumnya) — seluruh angka
    diambil apa adanya, tidak dihitung ulang di klien, jadi mustahil beda
    dengan halaman Laporan. Hari UTC lewat `ui/waktu.ts` (satu implementasi
    untuk Riwayat, Laporan, dan Dashboard).
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
  - **Penanda HUTANG + filter** (baru 2026-10-06, putaran 13): nota yang
    berhutang (uang kurang/0 + pelanggan valid — lihat "uang kurang = hutang")
    menampilkan **chip merah `Hutang RpX`** di kolom Jenis (judul chip memuat
    pelanggan + nomor nota), rincian nota menampilkan **kotak merah Hutang**
    + baris "Otomatis tercatat di halaman Hutang — Nota …", dan **chip
    filter `Hutang (n)`** di ringkasan kanan atas menyaring linimasa jadi
    hanya baris berhutang (client-side, tanpa reload). Penanda-nya dihitung
    server dari snapshot nota (field `sisa_hutang` di `GET /api/sales`) —
    menunjuk **kejadian berhutang saat nota**, sedangkan saldo piutang yang
    masih hidup tetap dibaca dari halaman **Hutang** (charge-nya memang sudah
    tercatat otomatis di sana sejak putaran 12).
  - **Cetak ulang struk** (baru 2026-10-01): kartu Pembayaran rincian penjualan
    punya tombol **Cetak ulang struk**. Setelah memilih isi nota, dialog
    menawarkan **[Thermal] [A4] [Batal]** — A4 membuka invoice A4 yang sama
    seperti POS (`cetakInvoice()`), Thermal membangun **ulang struk dari isi
    nota** (waktu `created_at` diformat lokal, nomor/kasir/shift, item — satuan
    non-dasar tercetak lewat `base_unit` dari `GET /api/sales/:id` — subtotal,
    diskon item, diskon transaksi, total, uang diterima/kembali persis seperti
    struk asli) lalu dikirim ke print-agent lewat `kirimPrint()` eksplisit
    layout thermal. Gagal cetak hanya toast peringatan — riwayat tidak
    berubah apa pun.
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
* **Shift Kasir** (`#/shifts`, menu **Shift Kasir** di sidebar, baru 2026-10-01)
  — riwayat shift + buka/tutup shift dari satu layar:
  - **Tabel riwayat** dari endpoint baru `GET /api/shifts?status=…` — tiap baris
    sudah membawa agregatnya (`n_sales`, `omzet`, `tunai`/`qris`/`transfer`,
    `n_topup`, `topup_nominal`/`topup_admin`, `tarik_nominal`/`tarik_admin`)
    lewat subquery, jadi tabel tidak memicu N+1. Filter **Semua / Terbuka / Tutup**
    dikirim ke server (enum `open|closed|semua`, selain itu 400), bukan
    disaring di klien.
  - **Buka shift**: kasir (default nama kasir device) + modal awal ->
    `POST /api/shifts/open`. 409 = kasir ini masih punya shift terbuka
    (UNIQUE INDEX `idx_shifts_open_cashier`) — pesan server langsung ditampilkan.
  - **Tutup shift**: dialog menampilkan rincian lengkap — modal awal,
    penjualan per metode (tunai/QRIS/transfer), topup terpisah nominal +
    admin, tarik tunai sebagai catatan di luar hitungan — lalu input modal
    akhir dengan **selisih live** terhadap **kas seharusnya di laci**
    (keputusan pemilik 2026-10-01, ROADMAP §1.3):
    `kas seharusnya = modal_awal + penjualan (semua metode) + topup
    (nominal + admin)`; `selisih = modal_akhir − kas seharusnya`.
    Tarik tunai sengaja tidak mengurangi laci (hanya dicatat). Rumus ada di
    `kasSeharusnya()` + `hitungSelisih()` di `apps/web/src/pages/shifts.ts`
    — bila keputusan berubah, ubah di situ saja.
  - Shift `kasir` yang dipakai layar POS tidak tersentuh oleh halaman ini
    (test memakai kasir uji sendiri).
* **Pengaturan** (`#/settings`, menu **Sistem** di sidebar) — dua kartu saklar
  server, kartu kop toko, kartu preferensi device, masing-masing dengan
  penjelasan sendiri (bukan lagi satu kartu):
  - **Stok boleh minus** (`settings.allow_negative_stock`): daring = penjualan
    boleh membuat stok menembus nol (stok jadi angka minus dan langsung terlihat
    di filter **Stok minus** halaman Stok); mati = `POST /api/sales` menolak
    dengan 400 seperti perilaku lama.
  - **Tolak jual kadaluarsa** (`settings.tolak_jual_kadaluarsa`, baru
    2026-10-01, bawaan **mati**): daring = server **menolak** penjualan yang
    memuat barang lewat tanggal kadaluarsa — 400
    `barang kadaluarsa: <nama> (berakhir <tanggal>)`, bukan sekadar strip
    peringatan; **hari kadaluarsa sendiri masih boleh dijual**. Mati = layar
    kasir hanya menampilkan strip/badge seperti sebelumnya.
  Keduanya disimpan lewat `GET/POST /api/settings` (boolean **sungguhan** —
  angka `0`/`"ya"`/`null` ditolak 400) dengan **update parsial**: tiap saklar
  hanya mengirim kuncinya sendiri, jadi mengubah satu TIDAK mereset yang lain.
  Aturan dibaca server dari DB pada **setiap penjualan** — keputusan tidak
  pernah terpecah antar device.
  - **Pengaturan toko** (baru 2026-10-03): 4 input — **Nama toko, Alamat,
    Phone, Email** — disimpan di server sebagai kunci `store_name`/
    `store_address`/`store_phone`/`store_email` (update parsial, teks;
    kunci asing ditolak 400). Inilah **kop INVOICE A4** yang dicetak di
    semua device; tombol **Simpan toko** tanpa konfirmasi swal (non-destruktif
    seperti Backup), nilai tampil kembali persis seperti hasil trim server.
    Bawaan seed = contoh pemilik (RAVAA STUDIO, alamat Ngluyu Nganjuk).
  - **Cetak struk** (baru — satu-satunya kartu **per device**): saklar
    **Cetak struk otomatis** + pilihan layout struk (**Thermal 58mm** /
    **Epson L3110 (A4)**, lihat bagan struk di atas). TIDAK lewat API: keduanya
    disimpan di browser device ini (localStorage `ravaa.cetak` dan
    `ravaa.struklayout`, lihat `apps/web/src/ui/print-pref.ts`) — karena dua PC
    bisa menempel pada printer yang berbeda, dan HP fallback mungkin tanpa
    printer sama sekali. Sejak putaran 11 (2026-10-05) saklar **hanya
    mengizinkan pengiriman ke printer** — modal resume + pilihan cetak
    tetap muncul setiap penjualan (lihat "Modal resume" di atas).
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
