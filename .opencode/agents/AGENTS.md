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
* Tanggal kadaluarsa ditawarkan HANYA untuk kategori `categories.use_expiry=1`
  (seed: snack + eskrim) — disetel pemilik lewat centang di form Kategori, bukan
  hardcode.
* Rokok: SKU bungkus dan ketengan TERPISAH (cth `PRD00015` bungkus vs `PRD00016` ketengan).
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
apps/web/src/store.ts    Cache master IndexedDB + maxVersion (?since= delta sync)
                         + **kv `'holds'` transaksi tertahan POS** (`getHolds()`/
                         `saveHolds()` — per device, P5).
apps/web/src/pages/pos.ts  UI kasir utama (rute POS). **Urutan atas-ke-bawah =
                          referensi KulaPOS (kula-02-transaksi-pos.png):
                          info bar → scan bar (+ Mode) → label keranjang →
                          tabel ‖ sidebar kanan (panel bayar).** Shell POS (`renderPosShell()` di
                          `ui/shell.ts`) **TANPA `<header>` sama sekali**
                          (permintaan pemilik 2026-10-04 "full hapus" — tidak
                          ada judul "Kasir (POS)"). Tombol kembali ke
                          dashboard = `tombolKembaliHtml()` (pos.ts): kiri
                          info bar (mode jual) + kiri baris Mode
                          (topup/tarik, info bar tak dirender) supaya kasir
                           tidak terkunci di `#/pos`). Scan bar = input `#pos-q` + dropdown
                           cari — input memuat **badge `<kbd>F1</kbd>` di ujung
                           kanan** (`pr-14` + span absolut; putaran 8 2026-10-04,
                           penanda shortcut fokus scan ala KulaPOS
                           `[F1/Cmd+K]`) —
                           (**sintaks `Qty*Kode`**: `3*PRD00001` = 3 pcs —
                           `bacaQtyKode()`, qty eksplisit menang atas chip
                           Qty/F4 dan sengaja TIDAK mengosongkan preset itu;
                           aturan sama untuk Enter & klik hasil; tanpa `*`
                           perilaku lama dipertahankan), **info bar** (mode Penjualan: kolom kiri =
                          tombol ⬅ + tumpukan dua baris **Waktu** (atas) /
                          **Kasir + Shift** (bawah) — jam live
                          `jamPos()`/`mulaiJam()` — jam lokal konsisten
                          `waktuStruk()`, dihentikan di `unmountPosPage`;
                          select `#pos-customer` pelanggan + tombol
                          `#pos-cust-cari` **INLINE sebelah select** (flex
                          row; putaran 8b 2026-10-04 "tombol dan dropdown
                          customer tidak inline" — versi awal yang memindahnya
                          ke baris label DITOLAK). Bentuk KOMPAK: ikon search
                          + teks "F9" polos TANPA teks "Cari" ("cukup pakai
                          text label yang F9 dan ganti logo kuncinya dengan
                          search … space select jadi lebih besar"); select
                          `min-w-0 flex-1`. Pembuka `openCariPelanggan()` ala
                          F3, putaran 7 2026-10-04, default "Pelanggan Umum",
                          dimuat dari `GET /api/customers`;
                          kolom kanan = label TOTAL BELANJA + `#pos-owncount`
                          "n item (n Qty)" di KIRI kolom + `#pos-grand` angka
                          besar di KANAN — **`text-[48px]` kustom (2x lipat
                          `text-2xl` lama), permintaan pemilik 2026-10-04**;
                          **ketiga kolom SAMA RATA `lg:grid-cols-3`**
                          (putaran 9 — "jangan lebar di tengah"; menggantikan
                          `[auto_1fr_auto]` yang memberi sisa lebar ke kolom
                          tengah; `lg:min-w-[340px]` kolom kanan ikut
                          dibuang) **dipisah garis vertikal**
                          `border-l` ≥lg — border-t saat kolom menumpuk),
                          lalu scan bar, strip stok menipis
                          & kadaluarsa, **label baris di ATAS tabel**
                          (`#pos-count` "n item"/"Keranjang kosong" kiri +
                          `#pos-clear` Bersihkan F5 kanan — dipindah dari
                          bawah tabel 2026-10-04, id tetap), **tabel keranjang
                          8 kolom**
                          (No / Kode / Nama barang / Harga / Qty / Diskon /
                          Subtotal / Aksi — SKU di kolom Kode mono, baris
                          catatan & empty `colspan="8"`; **lebar kolom
                          eksplisit** putaran 8 2026-10-04: No `w-10`, Kode
                          `w-24`, **Nama barang `w-auto`** = menyerap seluruh
                          sisa lebar (referensi KulaPOS), Harga/Diskon/
                          Subtotal `w-24`, Qty `w-32`, Aksi `w-14`;
                          **hover per baris KEBIRUAN**
                          `hover:bg-primary-soft dark:hover:bg-primary/15
                          transition-colors` (putaran 8c 2026-10-04 "hover di
                          tabel keranjang ubah jadi kebiru-biruan" — pakai
                          token `--color-primary-soft #e6f3ff`, sama dengan
                          state aktif tombol; riwayat: gray-50 → gray-100 →
                          primary-soft) pada
                          tiap `<tr data-key>`; **input Qty `!w-20` +
                          font-semibold** — dulu `!w-16`), chip nominal cepat,
                          chip Qty + tombol
                          Cari (F4 = qty item berikutnya sekali pakai, F3 =
                          layar cari produk; tombol ganda `#pos-manual` di
                          scan bar DIHAPUS putaran 7 karena sudah ada di
                          panel kanan `#pos-qa-manual`), input catatan per
                          baris (produk
                          `use_note`, ikut ke struk via `items[].note`).
                            **Panel bayar = SIDEBAR KANAN 320px** (grid
                            `lg:grid-cols-[1fr_320px]` — putaran 4 2026-10-04:
                            footer horizontal DITOLAK pemilik, "tetap jadi
                            sidebar kanan tadi"): ringkasan
                            **Diskon item** saja (baris Subtotal ikut DIHAPUS
                            putaran 7 2026-10-04, "ini juga hapus saja" —
                            subtotal terbaca dari TOTAL BELANJA di info bar) →
                            **Aksi cepat** → input
                            diskon transaksi (label polos — chip `<kbd>F6</kbd>`
                            DIHAPUS, putaran 7 2026-10-04 "ghapus saja,
                            di atasnya sudah ada label F6 ternyata di tombol
                            diskon"; pintasan F6 disebut **hanya** di tombol
                            **Diskon F6** grid Aksi cepat) → **dua tombol bayar
                            (mt-auto di
                            dasar, putaran 6 2026-10-04)**. **Baris "Grand
                            total" DIHAPUS** (duplikat
                            TOTAL BELANJA di info bar — permintaan pemilik
                            2026-10-04); `#pos-grand` = satu-satunya angka
                            total besar. **Aksi cepat** (grid 2 kolom):
                            **Tahan** (`tahanKeranjang()`) + **Pending (n)**
                            (`bukaTertahan()`, badge `#pos-hold-count`) =
                            fitur **P5 transaksi tertahan** — snapshot keranjang
                            (`Hold` type: items/discount/pelanggan) disimpan di
                            **IndexedDB per device** lewat `getHolds()`/
                             `saveHolds()` (kv key `'holds'` di `store.ts`,
                             tanpa endpoint API); **MODAL SPLIT ala Ravaa
                             POS v1** (putaran 9 2026-10-05: *"ke modal
                             pending, buat 2 kolom, kiri daftar antrian,
                             kanannya preview barang"*; putaran 9b: *"sebagai
                             referensi lihat layout di ravaa POS versi 1 …
                             coba di terapkan pada modal pending"* —
                             referensi `hold-modal.blade.php` +
                             `.modal-split` + `showHoldDetail()`; `wider`
                             ≈ modal-lg 900px v1):
                             grid **30/70** (`sm:grid-cols-[3fr_7fr]`,
                             pemisah = border kanan kolom kiri), tiap kolom
                             **tinggi FIX `h-[60vh]` + gulir sendiri**
                             (permintaan *"tinggi fix misal 60%/80% dari
                             screen, scrollable jika barang banyak"* — 60vh
                             supaya header+footer modal `max-h-[90vh]` tetap
                             muat). KIRI = split-header bar **"DAFTAR
                             ANTRIAN (n)"** (`#hold-antrian-count`) + kartu
                             `#hold-list` gaya `.split-item` v1 (hover
                             `blue-50`, **aktif = bg primer SOLID + teks
                             putih + shadow**; klik kartu = pilih); KANAN =
                             `#hold-preview` persis struktur `detailHtml`
                             v1: header-info **Pelanggan | Waktu simpan**
                             (garis dashed, kasir di bawah pelanggan) →
                             label **"Daftar Produk (N item)"** → kartu
                             abu-abu per barang (nomor. nama, `SKU · qty ×
                             harga` [+ diskon + catatan], netto primer di
                             kanan) → kotak ringkasan **Subtotal/Diskon
                             (bila >0)/Total** (garis dashed, angka Total
                             `text-xl` primer) → dua tombol **[Hapus outline
                             merah] [Lanjutkan primer] di BAWAH detail**
                             (bukan per kartu — v1 menaruh aksi di detail;
                             **Lanjutkan** = `muatHold()` — konfirmasi swal
                             bila keranjang tak kosong, validasi `customerId`
                             ke master, dorong `manualSeq`; **Hapus** =
                             `hapusHold()` + `confirmDialog` danger — kedua
                             kolom di-render ulang lewat `tampil()`,
                             pemilihan jatuh ke antrian berikutnya, modal
                             ditutup sendiri bila antrian habis); listener
                             SATU di `api.el`; **selector
                             `#hold-list li[data-hold-row]` / `[data-hold-act]`
                             DIPERTAHANKAN** (dipakai
                             `tests/pos-qtykode-test.mjs` §C3);
                            **Item manual** & **Diskon F6** memanggil aksi
                            lama; **Voucher** & **Cetak ulang** = placeholder
                            `[data-soon]` (toast "menyusul" — permintaan
                            pemilik "placeholder dulu, fitur nanti").
                            **Isian bayar = FORM BAYAR (modal)** (putaran 5
                            2026-10-04, permintaan pemilik "pindahkan ke modal
                            ketika klik bayar" — ala payment screen Aronium
                            F10): tombol **Bayar `#pos-bayar` (F10)** membuka
                            `bukaBayar()`, modal `formBayarHtml()` memuat
                            Total tagihan `#bayar-total`, metode `data-pay`
                            (Tunai/QRIS/Transfer), `#pos-cash` uang diterima,
                            chip `data-cash`, KEMBALIAN `#pos-change` +
                            `#pos-change-ctx`, dan petunjuk hutang; **tombol
                            OK footer modal = `#pos-pay`** (disetel di
                            `bukaBayar` — Enter-on-input modal.ts ->
                            `ok.click()`). **`#pos-pay-pas` ("Bayar pas"
                            `bayarPas()`; **gradasi hijau + shadow + hover
                            hijau LEBIH GELAP** `bg-linear-to-r
                            from-emerald-500 to-emerald-600 shadow-md
                            shadow-emerald-600/40 hover:from-emerald-600
                            hover:to-emerald-700` — gaya
                            akhir putaran 8c 2026-10-04: hover SENADA warna
                            tombol (*"hover tombol F12 juga ubah ke hijau
                            jangan biru, karena tombolnya warna hijau"* —
                            hover biru sempat dipakai 8b lalu dibatalkan).
                            Riwayat: permintaan awal "pakai outline saja"
                            menghasilkan tombol tanpa
                            warna karena class `btn-outline` TIDAK ADA di
                            styles.css = no-op → "style hilang yang tombol
                            warna hijaunya"; lalu "warna buat modern, gradasi
                            dan ada shadownya"; `!py-4`,
                            kbd F12) = PENGECUALIAN: tetap di SIDE PANEL tepat
                            DI BAWAH `#pos-bayar`** (permintaan pemilik
                            putaran kedua 2026-10-04 "bayar uang pas
                            letakkan di sidepanel bawahnya Bayar F10") —
                            bayar tunai persis total SEKETIKA, tanpa modal.
                            **Uang lebih** = kembalian dihitung di form.
                            **Uang kurang = boleh berujung HUTANG**
                            (permintaan pemilik 2026-10-04): `pay()` memanggil
                            `cekHutangDiperbolehkan()` — wajib ada pelanggan
                            terpilih DAN bukan bawaan "Pelanggan Umum"
                            (`name` persis / `code = CUS-000001`); lolos ->
                            `confirmDialog` "Uang kurang — catat jadi hutang?"
                            -> `pay({hutang:true})` melewati barrier ->
                            penjualan lalu `POST /api/customer-debts`
                            `{type:'charge', amount:sisa,
                            note:'Nota <invoice_no> — sisa bayar POS'}` (gagal
                            ledger = penjualan TETAP sukses + toast penunjuk
                            halaman Hutang). TIDAK lolos syarat = penolakan
                            barrier lama **persis** (pesan "Uang diterima
                            belum diisi/kurang dari total" + buka form + fokus
                            kolom uang) — jadi uang kurang tidak pernah lolos
                            diam-diam. Struk memuat baris `Hutang` bila sisa >
                            0.
                            **SEMUA id lama dipertahankan**
                            (`#pos-cash`, `#pos-pay`, `data-cash`, `#pos-change`)
                            supaya F2/Enter/barrier + suite test tetap jalan.
                           `pay()` kirim `customer_id` + struk meta
                           `Pelanggan: <customer_name>` + reset pilihan ke
                            Pelanggan Umum. Pintasan level document di
                            `bindPintasan()` (**F1/F8 fokus kolom scan** —
                            F1 referensi KulaPOS `[F1/Cmd+K]`, F8 alias
                            jalan pendek; F2 bayar, F3 cari, F4 qty,
                            F5 bersihkan, F6 diskon transaksi, **F7 tahan**
                            — alokasi F7 sebab F2/F3 sudah terpakai, label
                            `<kbd>F7>` ikut tertulis di tombol Tahan,
                            **F9 cari pelanggan** (`openCariPelanggan()`),
                            **F10 buka form bayar**, **F12 bayar pas**,
                            Enter bayar, Esc ke scan — jangan dicuri untuk
                            pelanggan; **guard swal**: ada `.swal2-popup`
                            non-toast (konfirmasi hutang / pilihan cetak) =
                            SELURUH pintasan dilepas dulu, sebab
                            `.modal-overlay` bisa menemukan form bayar yang
                            ada di bawah swal)
                           plus **↑↓ navigasi baris keranjang**
                           (`pindahBarisKeranjang()`: hanya saat fokus di
                           dalam `#pos-rows`, baris catatan dilewati, input
                           catatan dikecualikan karena panah di sana = kursor,
                           clamp di ujung — referensi KulaPOS "↑↓ Navigasi
                           Baris"). Setelah
                          penjualan sukses **`pilihCetakSelesai()`** membuka
                          dialog **[Thermal] [A4] [Selesai]**
                          (`choiceDialog`, HANYA bila saklar auto-print ON —
                          guard `if (autoPrint)` wajib, tanpa itu backdrop
                          swal memblokir seluruh UI): judul **`Kembalian
                          RpX`** (bila `kembalian > 0`) / "Pembayaran
                          berhasil", Thermal = struk ESC/POS via print-agent,
                          A4 = invoice browser (`cetakInvoice`), pilihan
                          terakhir menyetel pref layout topup berikutnya.
                          Slot swal TIDAK berubah (`.swal2-confirm`=Thermal,
                          `.swal2-deny`=A4, `.swal2-cancel`=Selesai) —
                          `tests/e2e-struk.mjs` `pilihCetak()` bergantung
                          padanya. Ikon label info bar dipegang CSS
                          `.info-bar svg { size-4 }` di `styles.css` (pola
                          `.chip svg` — `icon()` tidak menulis width/height).
apps/web/src/pages/satuan.ts  Halaman #/satuan: CRUD master satuan.
apps/web/src/pages/dashboard.ts  Halaman #/dashboard (rute pembuka #/): kartu
                          omzet/laba/topup/outbox, grafik 7 hari murni CSS
                          (7x GET /api/reports/daily paralel), status shift
                          (GET /api/shifts/open?cashier=) + stok menipis.
                          Seluruh angka diambil apa adanya dari API.
apps/web/src/pages/shifts.ts  Halaman #/shifts (menu Shift Kasir): tabel
                          riwayat dari GET /api/shifts (agregat penjualan/
                          topup per baris), filter status, dialog Buka shift
                          (POST /api/shifts/open) & Tutup shift
                          (POST /api/shifts/:id/close + selisih polos
                          modal_akhir − modal_awal).
apps/web/src/pages/history.ts  Halaman #/history (menu Riwayat transaksi):
                         linimasa penjualan + topup/tarik per hari; daftar dari
                         GET /api/sales & /api/topups (filter hari sama dengan
                          /api/reports/daily), isi nota dibuka lewat GET /api/sales/:id,
                          plus tombol **Cetak ulang struk** (bangun ulang Struk
                          dari isi nota + `base_unit` + `note` per baris +
                          baris meta `Pelanggan:` dari `sale.customer_name`
                          (fallback "Pelanggan Umum") — sama dengan struk
                          asli POS, lalu dialog pilihan
                          **[Thermal] [A4] [Batal]** — A4 = `cetakInvoice()`,
                          Thermal = `kirimPrint(strukUntuk(...,'thermal'))`
                          eksplisit seperti POS).
apps/web/src/pages/reports.ts  Halaman #/reports (menu Laporan): laporan harian
                          pemilik — 4 kartu (omzet/laba/HPP/diskon), rekap metode
                          bayar, topup & tarik, produk terlaris, stok menipis,
                          ekspor CSV. SELURUH angka dari GET /api/reports/daily
                          apa adanya (tanpa hitung ulang di klien).
apps/web/src/pages/labels.ts  Halaman #/labels (menu Label harga): pilih produk
                         + pratinjau label, cetak via gabungLabel()/kirimPrint().
apps/web/src/pages/settings.ts  Halaman #/settings (menu Sistem): DUA kartu
                          saklar SERVER — "Stok boleh minus" + "Tolak jual
                          kadaluarsa" -> GET/POST /api/settings (update PARSIAL:
                          satu kunci per toggle, konfirmasi swal tiap
                          perubahan), PLUS kartu **Pengaturan toko** (baru
                          2026-10-03: 4 input nama/alamat/Phone/Email ->
                          kunci `store_*` di POST /api/settings, tanpa swal —
                          kop INVOICE A4 tersimpan di server supaya semua
                          device mencetak kop yang sama), PLUS kartu
                          **Cetak struk** (preferensi
                          PER-DEVICE lewat ui/print-pref.ts: saklar auto-print
                          + select layout thermal/A4, tanpa swal & tanpa API —
                          printer tiap PC kasir beda, jangan dipindah ke
                          server), PLUS kartu
                           **Backup data** (tombol "Backup sekarang" ->
                           POST /api/backup + daftar file + Unduh per baris dari
                           GET /api/backup; tanpa swal — non-destruktif; daftar
                           gagal-muat tidak mematahkan halaman).
apps/web/src/pages/customers.ts  Halaman #/customers (menu Pelanggan, baru
                           2026-10-04): master kontak pembeli — tabel nama/
                           HP/catatan, cari multi-kata, CRUD via openModal +
                           confirmDialog (pola satuan.ts). Hapus DITOLAK 400
                           bila pelanggan masih punya catatan hutang (pesan
                           server menunjuk halaman Hutang). Read-only terhadap
                           products.version.
apps/web/src/pages/debts.ts  Halaman #/debts (menu Hutang, baru 2026-10-04):
                           kartu "Total piutang berjalan" (dari total GET
                           /api/customer-debts), tabel per-pelanggan (sisa
                           DESC, toggle open|semua), dialog rincian ledger
                           (baris charge/payment + sisa berjalan, hapus baris
                           salah ketik), dan form "Catat hutang"/"Catat bayar"
                           (POST /api/customer-debts — pembayaran > sisa
                           ditolak server, toast error). Sejak 2026-10-04:
                           tombol **Bayar** per baris tabel (prefill sisa +
                           pratinjau "Sisa setelah bayar") dan tombol
                           **Cetak A4** di dialog rincian (`htmlHutangA4`/
                           `cetakHutangA4` — pola popup `invoice.ts`, tanpa
                           print-agent, gagal = toast). Hutang DICATAT
                           MANUAL di sini — POS tidak punya mode piutang.
apps/web/src/escpos.ts   ESC/POS: label harga + struk DUA LAYOUT + POST ke print-agent.
                          Layout struk: `thermal` 32 kolom (COLS) ekor FEED+CUT —
                          bawaan toko; `a4` 64 kolom (COLS_A4) ekor FEED+Form
                          Feed 0x0C TANPA CUT — untuk Epson L3110 (inkjet tanpa
                          pisau; tanpa FF kertas menumpuk di dalam).
                          **Sejak 2026-10-03 pilihan A4 penjualan = invoice
                          browser (`invoice.ts`), BUKAN struk ini** — `strukA4()`
                          kini hanya dipakai struk topup/tarik saat pref layout
                          `a4` dan tetap diuji unit di `escpos-test.ts`.
                          Pemilihan: strukUntuk() (panggil dari tiap pencetakan
                          struk) & sesuaikanPrinter() untuk stream non-struk
                          (label), pref di ui/print-pref.ts.
                          Berisi: label harga (labelHarga/teksLabel/gabungLabel),
                          struk (struk thermal/strukA4/StrukBaris), ascii()/potong/baris
                          dua kolom, kirimPrint() + urlAgent() (`ravaa.printagent`,
                         default :9100). Dipanggil dari halaman Label harga dan dari
                         pay()/submitTopup() POS. PENTING: `teks()` tidak
                         menambah baris baru — setiap baris struk HARUS diakhiri
                          LF, kalau tidak seluruh struk menempel jadi satu baris.
apps/web/src/invoice.ts  **INVOICE A4 gaya Aronium** (baru 2026-10-03):
                          `htmlInvoice(sale, items, toko)` menyusun HTML + CSS
                          `@page A4 margin 16mm 14mm` (kop INVOICE + nama/
                          alamat/Phone/Email dari `store_*` + logo lingkaran "R",
                          Bill to = `sale.customer_name` snapshot ("Pelanggan
                          Umum" bila kosong), Invoice No. = `sales.invoice_no`,
                          Payment status Lunas, tabel item + baris `* note`,
                          ringkasan Discount/Total, footer "Dicetak dari Ravaa
                          POS"), dan `cetakInvoice(saleId)` = fetch
                          `GET /api/sales/:id` + `GET /api/settings` -> window.open
                          -> document.write -> `window.print()` otomatis saat
                          load. **Tanpa print-agent** (rendering HTML tidak bisa
                          diserahkan ke server nol-dependensi — cetak lewat
                          browser/CUPS `lp -d EPSON-L3110-Series`). Lempar Error
                          bila popup diblokir (POS men-toast, penjualan TIDAK
                          dibatalkan). Dipanggil dari POS (dialog A4) & Riwayat.
apps/web/src/ui/confirm.ts  Swal wrapper repo: `confirmDialog()` (ya/batal,
                          konfirmasi destruktif), `alertDialog()` (satu tombol),
                          dan **`choiceDialog({title,message,choices,cancelLabel})`**
                          (baru 2026-10-03, resolve `key` choice | null) — SweetAlert2
                          punya tepat 3 slot (confirm/deny/cancel), jadi maks 3
                          pilihan. Dipakai pilihan cetak POS/Riwayat. Jangan pakai
                          `confirm()`/`prompt()` native (dilarang frontend-pos).
apps/web/src/ui/switch.ts  Saklar checkbox bergaya (label + toggle) dipakai form
                          produk, panel mode POS, dan kartu Sistem.
apps/web/src/ui/print-pref.ts  Preferensi cetak PER DEVICE (localStorage):
                          getAutoPrint/setAutoPrint (`ravaa.cetak`, default
                          nyala — matikan lewat panel Sistem -> Cetak struk
                          atau scan bar POS; penjualan TIDAK PERNAH dibatalkan
                          oleh gagal cetak) dan getStrukLayout/setStrukLayout
                          (`ravaa.struklayout` = `thermal`|`a4`, default
                          `thermal`). `a4` = pref struk topup/tarik + pilihan
                          terakhir dialog cetak (A4 penjualan sendiri lewat
                          `invoice.ts`, bukan struk ESC/POS). SATU sumber untuk
                          panel Sistem + scan bar
                          POS + strukUntuk()/sesuaikanPrinter() — jangan baca
                          localStorage langsung dari halaman lain.
apps/web/src/ui/waktu.ts  Tanggal/jam bersama: waktu()/jam() (tampil UTC apa
                         adanya), hariIni()/geser()/tglPanjang()/tglPendek()/
                         hariPendek() — SATU aturan hari UTC untuk Riwayat,
                         Laporan, dan Dashboard (jangan tulis ulang di halaman
                         baru: aritmetika tanggal harus lewat file ini).
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
* `GET /api/categories` -> `{data}` (baris memuat `track_stock`, `sort`, **`use_expiry`**)
* `POST /api/categories` `{name,slug?,track_stock?,sort?,use_expiry?}` (upsert by slug; `slug` OPSIONAL —
  bila kosong server turunkan otomatis dari `name` (lowercase `[a-z0-9-]`), client kirim
  slug readonly. 200 update / 201 baru. Slug tidak bisa diganti setelah dipakai)
  - **`use_expiry` (0/1)**: 1 = form produk kategori ini **menampilkan** kolom
    `Tanggal kadaluarsa`. Aturannya DATA di server (kolom `categories.use_expiry`,
    seed: snack + eskrim = 1), menggantikan daftar hardcode `KATEGORI_KADALUARSA`
    yang pernah ada di klien. **DIKECUALIKAN dari pola "tidak dikirim = reset"**:
    nilai lama dipertahankan — kalau di-reset seperti `track_stock`, upsert yang
    hanya mengganti nama kategori akan diam-diam mematikan tanggal kadaluarsa
    seluruh produk kategori itu. Dibaca klien lewat `perluExpiry()` di
    `apps/web/src/pages/products.ts` (produk yang sudah punya tanggal tetap
    menampilkan fieldnya).
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
* **Pelanggan & hutang (piutang) — baru 2026-10-04** (halaman `#/customers` +
  `#/debts`; tabel `customers` + ledger `customer_debts` di `db/schema.sql`).
  Read-only terhadap `products.version` (tidak menyentuh kolom itu sama sekali).
  - **Prinsip ledger: saldo TIDAK PERNAH disimpan sebagai angka.** `sisa` =
    `SUM(charge) - SUM(payment)` selalu dihitung ulang saat dibaca — angka
    tersimpan akan selisih begitu salah satu baris mutasi diedit/dihapus.
    `charge` = pelanggan berhutang (beli belum bayar), `payment` = pembayaran.
  - `GET /api/customers?q=` -> `{data:[{id,code,supplier_no,name,phone,address,note,created_at,updated_at}], total}`
    - `q` opsional, multi-kata (SEMUA kata harus cocok di `name`/`phone`/`note`,
      pola search produk — tidak harus di field atau urutan yang sama).
    - Urutan `name COLLATE NOCASE, id`; `total` = jumlah baris TANPA filter
      (dipakai footer halaman).
    - **`code` / `supplier_no` / `address` (revisi pemilik 2026-10-04)**:
      `code` = no customer auto (`CUS-000001`), `supplier_no` = no supplier
      auto (`SUP-000001` — master supplier belum ada, nomor disimpan di kontak
      dulu), `address` = alamat pelanggan. Baris lama bernomor `''` tampil
      sebagai `—` dan diisi server saat pertama disimpan ulang.
  - `POST /api/customers` `{id?,name,phone?,address?,note?}` -> 201 baru / 200 update
    - `id` dikirim = update (404 bila tak ada), tanpa id = insert baru.
      **Sengaja TIDAK upsert by phone** — dua orang bisa berbagi nomor
      (keluarga/karyawan toko), nomor bukan kunci identitas.
    - `name` wajib non-kosong (trim) -> 400 `"nama pelanggan wajib diisi"`.
    - `phone`/`address`/`note` teks bebas (default `''`); `updated_at` di-set
      ulang saat update. `id` harus integer bila dikirim -> selain itu 400.
    - **Nomor urut OTOMATIS di server** (`nomorUrutPelanggan`): `code` ->
      `CUS-<6 digit>`, `supplier_no` -> `SUP-<6 digit>`, di-assign saat INSERT;
      saat UPDATE hanya baris yang masih `''` yang diisi — **nomor TIDAK
      pernah berubah** setelah terbit. Urutan = baris terbesar lewat
      `CAST(substr(code,5))` + pola `LIKE 'CUS-%'` (BUKAN COUNT: celah nomor
      tidak dipakai ulang). Prefiks WAJIB ikut dash (`'CUS-'`), kalau tidak
      `CAST('-000001')` = -1 untuk semua baris dan nomor dobel (bug nyata yang
      pernah terjadi, sudah diuji manual lewat curl).
  - `DELETE /api/customers/:id` -> `{data:{id,deleted:true}}`
    - Guard **400 bila masih punya catatan hutang**: `"pelanggan ini masih
      punya N catatan hutang — hapus catatannya dulu di halaman Hutang"`
      (riwayat harus utuh, pola sama dengan hapus produk yang pernah terjual).
      TIDAK ada cascade hapus — baris `customer_debts` dirujuk `sale_items` masa
      depan dan wajib utuh selama masih ada.
    - 404 tak ada / sudah dihapus; 400 bila `:id` bukan integer.
  - `GET /api/customer-debts?status=open|semua` -> `{data:[{customer_id,name,phone,charge,bayar,sisa,terakhir}], total}`
    - **Ringkasan saldo per pelanggan** (tabel utama halaman `#/debts`).
      Read-only.
    - `status` default `open` = hanya `sisa > 0`; `semua` = semua yang punya
      riwayat (termasuk lunas, `sisa` 0). Nilai lain -> 400
      `"status harus open|semua"`.
    - Urutan `sisa DESC, terakhir DESC, customer_id`; `total` = jumlah `sisa`
      (dipakai kartu "Total piutang berjalan").
  - `GET /api/customer-debts/:customerId` ->
    `{data:{customer:{id,name,phone,note,...}, rows:[{id,customer_id,type,amount,note,created_at,sisa}], charge, bayar, sisa}}`
    - Rincian ledger satu pelanggan; `rows` urut **terbaru di atas** (DESC),
      tiap baris membawa `sisa` **berjalan setelah baris itu** (dihitung dari
      terlama dulu lalu dibalik — jadi "sisa setelah mutasi ini" masuk akal).
    - 404 bila pelanggan tak ada; `:customerId` harus integer -> 400.
  - `POST /api/customer-debts` `{customer_id,type:charge|payment,amount>0,note?}` -> 201 `{data:<baris>}`
    - Validasi (semua 400): `type` harus persis `charge`|`payment`; `amount`
      angka bulat `> 0` (rupiah bulat — desimal ditolak); `note` maks 200
      karakter; pelanggan tidak ada -> **404**.
    - **`payment` > sisa -> 400** `"pembayaran melebihi sisa hutang (sisa RpX)"`
      (uang lebih dari utang memang tidak ada; keputusan jadi saldo kredit/
      awal = wewenang pemilik, ditunda). Check + insert dijalankan dalam
      `db.transaction` (skala 1-2 kasir: atomik cukup).
    - Endpoint ini TIDAK mengubah `POST /api/sales` / `pay_method` — nota
      tetap tercatat apa adanya. **Sejak 2026-10-04 ada pelanggan KEDUA: POS.**
      Form bayar (modal) menawarkan "uang kurang = HUTANG" bila pelanggan
      terpilih bukan bawaan "Pelanggan Umum": setelah penjualan tersimpan,
      client mengirim **`charge` terpisah** ke endpoint ini dengan
      `note:'Nota <invoice_no> — sisa bayar POS'` (lihat `pay()` di
      `apps/web/src/pages/pos.ts`; gagal ledger = penjualan TETAP sukses +
      toast penunjuk halaman Hutang). Jalur **manual** di halaman Hutang
      tetap ada untuk koreksi & catatan di luar alur kasir.
  - `DELETE /api/customer-debts/:id` -> `{data:{id,deleted:true}}`
    - Hapus 1 baris mutasi (salah ketik). Sengaja TANPA cek sisa: hapus
      `payment` memperbesar sisa, hapus `charge` memperkecil — dua-duanya
      diinginkan saat membetulkan input. 404 tak ada; 400 `:id` bukan integer.
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
* `POST /api/products` `{sku?,name,category_slug,barcode?,unit?,price?,cost?,markup?,price_dynamic?,stock?,min_stock?,is_active?,units?,image?,discount_type?,discount?,expiry_date?,use_note?}` (upsert by sku, version++)
  - `sku` **opsional**: kosong berarti server menomori sendiri `PRD00001`,
    `PRD00002`, ... (`PRD` + 5 digit, sejak 2026-09-28 — sebelumnya diturunkan
    dari nama). Nomor = **MAX** SKU `PRD[0-9]+` di DB + 1, **BUKAN COUNT**:
    baris tombstone (`deleted_at`) wajib tetap dihitung supaya nomor tidak pernah
    mundur, dan COUNT bisa menabrak rangkaian begitu ada celah di tengah.
    Wajib tetap unik — SKU adalah kunci upsert, jadi SKU bentrok akan menimpa
    produk lain. SKU manual yang diketik sendiri dipakai apa adanya; **client
    dilarang menebak nomornya** (angka berikutnya bisa saja sudah terpakai di
    server — biar server yang menghitung dari DB).
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
  - **`image` (foto produk, sejak 2026-09-29)**: berisi **nama file** thumbnail
    (bukan isi gambar — isinya lewat `GET /api/products/:id/image`).
    **DIKECUALIKAN dari aturan reset, sama seperti `units`**: `undefined` =
    tidak diubah, `''`/null = **hapus foto**. Alasan sama: `payloadToggleAktif()`
    dan tiap baris impor tidak boleh menghapus foto diam-diam. File thumbnail
    dikirim lewat `POST /api/products/:id/image`, bukan lewat kolom ini.
  - **`discount_type` + `discount`** (diskon per produk): `'rp'` (rupiah) atau
    `'pct'` (persen) + nilai. Keduanya hanya **prefill** saat produk masuk
    keranjang POS — kasir boleh mengubahnya per baris (ala OSPOS/Aronium),
    jadi angka master bukan angka yang dikunci saat jual. Field BIASA (ikut
    aturan reset) -> wajib masuk `payloadToggleAktif()`.
  - **`expiry_date`**: tanggal kadaluarsa ISO `YYYY-MM-DD` atau `null`.
    Hanya diisi untuk kategori track_stock yang isinya cepat basi (snack,
    eskrim) — form menyembunyikannya untuk kategori lain. Field BIASA (ikut
    aturan reset) -> wajib masuk `payloadToggleAktif()`.
  - **`discount`/`expiry_date` divalidasi server**: `discount >= 0` dan
    `discount_type ∈ {rp,pct}` (pct juga `<= 100`); `expiry_date` harus
    `''`/null atau pola `YYYY-MM-DD` sah -> selain itu 400.
  - **`use_note` (0/1, sejak 2026-10-03)**: 1 = baris keranjang POS untuk produk
    ini menampilkan **input catatan** di bawahnya (contoh pemilik: Cetak Banner
    -> kasir mengetik "ukuran 1 x 3 meter"). Teks per transaksi DIKIRIM sebagai
    `items[].note` di `POST /api/sales` (bukan kolom teks master — catatannya
    bersifat per nota). Field BIASA (ikut aturan reset) -> wajib masuk
    `payloadToggleAktif()` dan payload form. UI switch: "Catatan di POS" di
    form produk create/edit.
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
  - **POST ulang SKU tombstone = BANGKITKAN kembali** (sejak 2026-09-29):
    `POST /api/products` / `POST /api/products/import` dengan SKU yang sama akan
    mengosongkan `deleted_at` + `version++`, bukan sekadar membalas 201.
    Alasannya kebalikannya justru fatal: tanpa ini upsert by SKU menemukan baris
    tombstone (pencarian `SELECT * WHERE sku=?` tanpa filter), meng-update
    kolom-kolom lain, tapi `deleted_at` tetap terisi — produk tampak "tersimpan"
    padahal tidak pernah muncul di `status=aktif|semua`, dan tetap terkirim lewat
    `?since=` sebagai tombstone sehingga client justru **membuangnya dari cache**.
    Naiknya `version` membuat device yang sudah membuang baris ikut menariknya
    kembali. Diuji di `tests/product-delete-test.mjs` bagian E.
* **Foto produk (sejak 2026-09-29) — file di disk, DB hanya menyimpan NAMANYA**
  * `POST /api/products/:id/image` `{image: "<dataURL>"}` -> `{data:{image:"<nama file>"}}` (200)
    - Payload adalah **data URL hasil resize di client** (canvas, sisi terpanjang
      <=512px, JPEG kualitas ~0.72 -> ±10-20KB). Server TIDAK mengubah ukuran
      (tanpa dependensi gambar), hanya menulis byte apa adanya.
    - File ditulis ke `apps/api/data/img/<produk.id>.<ext>` (folder ikut
      `DB_PATH`, jadi instalasi Docker/native tetap terisolasi). Kolom
      `products.image` diisi nama file itu + **`version++`** supaya device lain
      menarik perubahan fotonya lewat `?since=`.
    - 400 bila `image` bukan data URL `data:image/...;base64,...`, base64 tidak
      valid, atau byte > **300.000** (thumbnail 512px jauh di bawah itu; batas
      ini menahan kasir yang menempel foto asli HP 4MB).
    - Ekstensi diambil dari mime (`jpeg|png|webp`), selain itu ditolak 400.
    - File lama (ekstensi berbeda) ikut DIBUANG supaya tidak menumpuk.
  * `POST /api/products/:id/image` `{image: ""}` -> `{data:{image:null}}` (hapus foto;
    file di-unlink bila ada)
  * `GET /api/products/:id/image` -> byte + `Content-Type` + `ETag` dari
    `updated_at` (`no-cache`, jadi browser revalidasi murah).
    404 bila produk tidak ada / tanpa foto / filenya hilang.
  * **Offline**: isi gambar TIDAK ikut delta sync (sengaja). Client mengunduh
    satu kali lalu menyimpannya di IndexedDB dan menampilkannya dari cache —
    jadi setelah sekali terlihat, foto tetap tampil walau server mati.
* `GET /api/stock-moves?product_id=&reason=&limit=&offset=` ->
  `{data:[{id,created_at,product_id,sku,name,qty,reason,ref_id,ref_invoice,unit_cost,cashier}], total}`
  - **Riwayat mutasi stok / product history.** Read-only: TIDAK mengubah
    `products.version` dan tidak perlu.
  - `product_id` **wajib** (riwayat selalu milik satu produk) -> 400 tanpa itu.
  - `reason` opsional (`sale|restock|opname|rusak`); `limit` default 50, maks
    200; `offset` default 0. `total` = jumlah baris tanpa limit (untuk paginasi).
  - **`ref_invoice` (sejak 2026-10-04)**: nomor invoice penjualan
    (`sales.invoice_no`) lewat subquery `(SELECT invoice_no FROM sales WHERE
    id = sm.ref_id)` — dikirim **hanya supaya tampilan Riwayat Stok memakai
    nomor nota yang sama** dengan Riwayat transaksi/struk (dulu `Nota
    <8 digit uuid>`). NULL bila `reason != sale` / `ref_id` bukan penjualan /
    nota lama. Additive — field lama tidak berubah.
  - Urutan `created_at DESC, id DESC` (yang terbaru di atas).
  - Data sudah ada sejak awal (`stock_moves` diisi oleh sale/restock/opname) —
    endpoint ini hanya MEMBUKANYA, bukan memodifikasi riwayat.
* `GET /api/settings` -> `{data:{allow_negative_stock:false,tolak_jual_kadaluarsa:false,
  store_name:"",store_address:"",store_phone:"",store_email:""}}`
  (selalu ada — dua baris boolean default di-seed `db/seed.sql` lewat `INSERT OR
  IGNORE` jadi seed ulang tidak mereset pilihan pemilik; empat kunci `store_*`
  = **kop INVOICE A4** (nama/alamat/Phone/Email toko) juga `INSERT OR IGNORE`
  dengan data contoh pemilik)
* `POST /api/settings` `{allow_negative_stock?:boolean, tolak_jual_kadaluarsa?:boolean,
  store_name?:string, store_address?:string, store_phone?:string, store_email?:string}`
  -> `{data:{...}}` (200)
  - **Update PARSIAL (sejak 2026-10-01)**: kunci yang TIDAK dikirim TIDAK
    diubah — berbeda dengan `POST /api/products` yang mereset kolom tak-dikirim.
    Alasan: halaman #/settings punya kartu-kartu terpisah; client hanya mengirim
    kunci yang diubah, dan `{tolak_jual_kadaluarsa:true}` tidak boleh mereset
    `allow_negative_stock` milik pemilik diam-diam.
  - 400 bila payload `{}` (minimal satu kunci). Tiap kunci yang dikirim wajib
    tipe yang benar -> 400 dengan nama kuncinya: dua saklar boolean **sungguhan**
    (angka 0/1, `"ya"`, `null` ditolak, memaksa client mengirim `true`/`false`);
    empat `store_*` wajib **teks** (string) — nilai di-trim server.
    Kunci tidak dikenal (mis. `waduh`) -> 400 `"pengaturan tidak dikenal: <k>"`.
  - **Pembacaan**: dua boolean hanya di `POST /api/sales` (dari DB SETIAP
    penjualan, bukan cache): `allow_negative_stock` = boleh stok minus, lihat
    aturan stok di kontrak penjualan; `tolak_jual_kadaluarsa` = tolak barang
    lewat `expiry_date`, lihat aturan kadaluarsa di kontrak penjualan. Default
    `false`. Empat `store_*` dibaca client saat **membuka invoice A4**
    (`cetakInvoice()` di `apps/web/src/invoice.ts`) — satu kop untuk semua
    device, sengaja di server bukan localStorage.
* `POST /api/products/import` `{rows:[<payload POST /api/products>], dry_run?:bool}` -> `{data:{total,ok,baru,update,gagal,errors:[{baris,sku,error}]}}` (200)
  - Tiap baris di-upsert lewat **fungsi yang sama** dengan `POST /api/products`
    (kategori/satuan/turunan SKU jadi satu sumber kebenaran, bukan versi kedua).
  - **SATU-SATUNYA beda dengan `POST /api/products`: kolom yang TIDAK dikirim
    = jangan diubah, bukan reset ke default.** Server memasang bendera
    `pertahankanTidakDikirim` **hanya** di endpoint ini. Alasan: berkas CSV
    cuma memuat sebagian kolom; tanpa aturan ini file tanpa kolom
    `Stok`/`price`/`Satuan` akan menyetel produk yang sudah ada jadi 0 / `pcs`
    **diam-diam dan tanpa `stock_moves`** (terbukti sebelum diperbaiki: stok
    7 -> 0, price 1000 -> 0 lewat satu baris tanpa kolom tersebut).
    `POST /api/products` **TETAP** perilaku reset ke default — form produk dan
    toggle aktif memang mengirim payload lenkap, dan itu kontrak yang diuji.
    Angka yang benar-benar dikirim tetap ditulis apa adanya.
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
  - **Dipakai juga oleh tombol Impor halaman Stok — impor stok HANYA hitung
    fisik, tidak ada pilihan mode "tambah/restock".** Alasannya fakta, bukan
    selera: format ekspor `csvStok` (`SKU,Nama,Stok,Stok minimum`) berisi
    hitungan **absolut**, jadi menerapkannya sebagai restock akan
    **menggandakan stok** tiap file hasil unduh diimpor ulang; dan berkasnya
    tidak punya kolom `harga_beli`, sehingga restock lewat impor tidak akan
    pernah memperbarui `avg_cost` (padahal `avg_cost` = sumber HPP). Masuk
    barang massal = lewat `POST /api/restock` per item (tombol truk), yang
    isian `harga_beli`-nya sudah ada. Jangan "memperluas" impor stok dengan
    menambahkan mode restock tanpa menambahkan kolom harga dan semantik absolut
    sekaligus.
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
* `GET /api/shifts?status=&cashier=&limit=&offset=` -> `{data, total}`
  - **Daftar riwayat shift (menu "Shift Kasir")** (baru 2026-10-01).
    Read-only: tidak mengubah `products.version`.
  - `status` default `semua`. Nilai sah `open|closed|semua`; selain itu
    **400** `"status harus open|closed|semua"` (seperti pola `status` produk).
  - `cashier` opsional (filter persis per kasir); `limit` default 50 maks 200;
    `offset` default 0; `total` = jumlah baris tanpa limit.
  - Urutan **`id DESC`** (shift terbaru di atas).
  - Tiap baris = kolom `shifts` + **agregat via subquery** (satu kali baca,
    bukan N+1): `n_sales`, `omzet` (SUM total penjualan yang `shift_id`-nya
    cocok), `tunai` / `qris` / `transfer` (bagian `pay_method` masing-masing —
    rincian per metode di dialog tutup shift; ketiganya semua masuk omzet),
    `n_topup` (JUMLAH semua `topup_txns` shift ini — **semua kind**, makna
    lama tidak berubah), `topup_nominal` / `topup_admin` (SUM kind=`topup`
    saja), `tarik_nominal` / `tarik_admin` (SUM kind=`tarik` saja).
    `topup`/`tarik` terpisah dua kolom karena aturan domain: **jangan satukan
    nominal+admin jadi satu angka di laporan**.
  - Agregat dihitung **all-time** (bukan per hari), sehingga penjualan offline
    yang masuk lewat outbox ikut terhitung begitu tersimpan dengan `shift_id`.
  - **Rumus selisih tutup shift = expected-cash (keputusan pemilik
    2026-10-01, lihat ROADMAP §1.3)** — bukan lagi `modal_akhir − modal_awal`:
    1. Topup (kind=`topup`): laci **NAIK** `nominal + admin`.
    2. Tarik (kind=`tarik`): **DI LUAR rumus** — hanya dicatat (kalau ikut,
       expected bisa minus saat shift baru lalu ada tarik besar).
    3. Penjualan **semua metode** (tunai/qris/transfer) masuk hitungan laci
       — keputusan #3, kebalikan dari asumsi awal yang memisahkan dana
       rekening; rincian per metode wajib ditampilkan.
    `kas seharusnya = modal_awal + omzet + topup_nominal + topup_admin`
    dan `selisih = modal_akhir − kas seharusnya`. Rumusnya di DUA fungsi
    `kasSeharusnya()` + `hitungSelisih()` (`apps/web/src/pages/shifts.ts`)
    — bila keputusan berubah, ubah di situ; jangan menyebar ke tempat lain.
* `POST /api/sales` `{id(uuid!),shift_id,items:[{product_id?,name?,qty>0,price?,unit?,discount?,note?}],pay_method,discount?,cash_in?,cashier?,customer_id?}`
  - **`invoice_no` (baru 2026-10-03, direvisi 2026-10-04, fitur Invoice A4)**:
    di-assign **SERVER**, tidak pernah dari client. Format **`YYMMDD-NNNNNN`**
    (UTC — tahun 2 digit + bulan 2 digit + **tanggal** 2 digit + `-` + 6 digit
    urut **harian**): `261004-000001` (revisi pemilik: kombinasi tahun/bulan/
    tanggal + urut, bukan per bulan seperti `YYMM-NNNNNN` lama). Urutan dihitung
    `ORDER BY CAST(substr(invoice_no,8) AS INTEGER) DESC` dengan pola
    `LIKE '<YYMMDD>-%'` — **BUKAN COUNT dan BUKAN teks** (`000010 < 000009`
    secara leksikal) — dan dicek duplikat idempotent dulu (POST ulang `id` yang
    sama tidak menggandakan nomor). Baris lama berformat `YYMM-…` tidak cocok
    dengan pola hari baru sehingga tidak mengganggu urutan; nomornya dibiarkan
    apa adanya. Disimpan di kolom `sales.invoice_no`; muncul di `GET /api/sales`,
    `GET /api/sales/:id`, dan tercetak di kop invoice A4.
  - **`customer_id?` + snapshot `customer_name` (revisi pemilik 2026-10-04)**:
    client mengirim **id** pelanggan terpilih di header POS (bawaan =
    "Pelanggan Umum", `CUS-000001`); kolom `sales.customer_id` + **snapshot**
    `sales.customer_name` diisi saat INSERT — riwayat, cetak ulang struk, dan
    invoice A4 tetap menampilkan pelanggan walau kontak kelak diedit/dihapus
    (pola sama dengan `sale_items.name`/`cost`). **`customer_id` OPSIONAL**:
    absen/null = transaksi tanpa kontak (201, kolom kosong; client lama & outbox
    tidak rusak). Bila DIKIRIM: bukan integer atau tak ada di `customers` ->
    **400** `"pelanggan tidak dikenal: <id>"` (payload korup, seperti produk/
    satuan tak dikenal). `GET /api/sales` & `GET /api/sales/:id` ikut
    mengembalikan kedua kolom (SELECT `s.*`).
  - **Diskon PER BARIS `discount?`** (baru 2026-09-29): nilai rupiah mutlak.
    Diisi client (prefill dari `products.discount` tipe `rp`/`pct`, boleh
    diubah kasir per baris) lalu **DI-SNAPSHOT** ke `sale_items.discount` —
    riwayat tidak ikut berubah kalau pemilik mengubah diskon master besok.
    Validasi server: `0 <= discount <= qty*price`, selain itu 400
    "diskon baris melebihi jumlah baris". Client yang mengirim persen akan
    **ditolak** (kontrak server = rupiah) — konversi `% -> Rp` ada di client.
    `sale_items.amount` tetap **kotor** `qty*price`; nilai bersih baris =
    `amount - discount`.
  - **Stok boleh minus — tunduk pada `GET/POST /api/settings`
    `allow_negative_stock`** (baru 2026-09-29):
    `false` (default) = perilaku lama, `p.stock < qty*factor` -> 400
    `"stok kurang: <nama> (butuh X, sisa Y)"`.
    `true` = cek **dilewati**, stok boleh jadi negatif, `stock_moves` tetap
    tercatat minus dan `version` tetap naik (minus menyeberang ke device lain
    lewat `?since=`). Pengaturan dibaca dari DB **setiap penjualan** — bukan
    cache — supaya keputusan server tidak pernah terpecah dari isi tabel.
  - **Tolak jual kadaluarsa — tunduk pada `GET/POST /api/settings`
    `tolak_jual_kadaluarsa`** (baru 2026-10-01, default `false`):
    `false` = penjualan barang lewat tanggal kadaluarsa BOLEH (layar kasir
    hanya strip/badge peringatan).
    `true` = tiap baris dengan `products.expiry_date` dicek per penjualan:
    `expiry_date < hari UTC` -> **400**
    `"barang kadaluarsa: <nama> (berakhir <tanggal>)"`.
    **Hari kadaluarsa == hari ini masih SAH** (kemarin boleh untuk stok yang
    habis terjual hari ini; hanya yang SUDAH lewat yang ditolak). Item manual
    (tanpa `product_id`, tanpa tanggal) bebas cek. Dibaca dari DB setiap
    penjualan seperti `allow_negative_stock`. Saklar UI: kartu "Tolak jual
    kadaluarsa" di halaman #/settings (konfirmasi swal, update parsial).
  - **HPP di-snapshot per baris**: `sale_items.cost` = `products.avg_cost` saat
    jual (0 untuk item manual). WAJIB snapshot, bukan dibaca ulang saat laporan
    di-query — `avg_cost` berubah tiap restock, kalau dibaca ulang laba hari lalu
    ikut berubah retroaktif. `laba baris = (amount - discount) - qty*cost`.
  Idempotent per `id`. Error 400 bila: items kosong, qty<=0, stok kurang
  (bila `allow_negative_stock=false`), harga dinamis kosong,
  item manual tanpa name+price, diskon baris > jumlah baris, diskon transaksi > subtotal bersih,
  barang kadaluarsa (bila `tolak_jual_kadaluarsa=true`, lihat aturan di atas),
  catatan baris > 200 karakter (lihat aturan `note` di atas).
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
  - **`note` (catatan per baris, sejak 2026-10-03)**: teks bebas 0-200 karakter
    dari input catatan di keranjang (produk `use_note=1`). **DI-TRIM lalu
    DI-SNAPSHOT** ke `sale_items.note` — sumber struk (baris indented
    `"  - <note>"`, thermal & A4) dan **Cetak ulang struk** di Riwayat.
    Validasi: `> 200` karakter -> 400 `"catatan baris terlalu panjang: <nama>
    (maks 200 karakter)"`. Server TIDAK mengecek flag `use_note` produk (input
    memang hanya dirender untuk produk yang menyala, tapi payload item manual
    / outbox lama tidak boleh ditolak karena alasan kosmetik); `''`/absen =
    tanpa catatan.
* `GET /api/sales/:id` -> `{data:{sale,items}}` (isi lengkap satu nota)
  - `sale` memuat **`invoice_no`** (`YYMMDD-NNNNNN`, urut harian) sejak
    2026-10-03 — diambil client oleh `cetakInvoice()` untuk dicetak di kop
    invoice A4.
  - `sale` juga memuat **`customer_id`** + **`customer_name`** (snapshot, sejak
    2026-10-04) — sumber baris `Pelanggan:` di struk ulang dan "Bill to"
    invoice A4. Baris lama bernama `''` = tampilkan "Pelanggan Umum".
  - Tiap baris `items` memuat **`base_unit`** (satuan dasar produk lewat
    `LEFT JOIN products`, `NULL` untuk item manual) sejak 2026-10-01 — dipakai
    tombol **Cetak ulang struk** di halaman Riwayat: struk hanya mencetak
    `unit` bila berbeda dari `base_unit` (aturan sama dengan struk POS).
  - Sejak 2026-10-03 tiap baris juga memuat **`note`** (catatan per baris,
    `''` bila tanpa) lewat `SELECT si.*` — dipakai cetak ulang supaya baris
    catatan ikut tercetak persis seperti struk aslinya.
* `GET /api/sales?date=&limit=&offset=`
  -> `{data:[{id,shift_id,created_at,invoice_no,pay_method,subtotal,discount,total,cash_in,change,cashier,n_items}], total}`
  - **Daftar penjualan untuk menu "Riwayat transaksi"** (baru 2026-09-30).
    Read-only: tidak mengubah `products.version` dan tidak perlu.
  - `date` default hari UTC (`YYYY-MM-DD`). Divalidasi round-trip
    (`date('2026-02-31')` = NULL di SQLite -> halaman kosong palsu) -> selain
    itu **400** `"date harus format YYYY-MM-DD"`.
  - Filter `date(created_at)=date(?)` **SAMA PERSIS** dengan
    `/api/reports/daily` — angka baris di Riwayat dan `sales.n` di Laporan
    tidak boleh bisa berbeda.
  - `limit` default 50, maks 200 (dibatasi server); `offset` default 0;
    `total` = jumlah baris tanpa limit.
  - `n_items` = jumlah `sale_items` per nota (subquery). Daftar sengaja TIDAK
    menarik isi itemnya — isi diambil saat baris dibuka lewat `GET /api/sales/:id`,
    jadi satu hari ratusan nota tidak ditarik sekaligus.
  - Urutan `created_at DESC, rowid DESC` (yang terbaru di atas).
* `POST /api/topups` `{id?,kind:topup|tarik,provider,nomor,nominal>0,admin>=0,pay_method?,shift_id?,cashier?}`
  - `provider` = **kode jenis layanan** (bukan brand). Nilai yang digunakan POS:
    `E-WALLET | PULSA | PLN-TOKEN | PLN-BILL` (kind=topup) dan `TARIK-EWALLET | TARIK-BANK` (kind=tarik).
    Kontrak API tidak berubah; kolom tetap TEXT non-kosong. Penambahan brand
    (DANA/OVO/GoPay/BCA) dilakukan sebagai kolom baru jika dibutuhkan, bukan
    dengan mengubah `provider` menjadi opsional.
* `GET /api/topups?date=&limit=&offset=` -> `{data:[<baris topup_txns>], total}`
  - Daftar topup/tarik untuk menu **Riwayat transaksi**; aturan `date`
    (validasi round-trip, default hari UTC, filter `date(created_at)=date(?)`),
    `limit`/`offset`, dan urutan **sama persis** dengan `GET /api/sales`
    di atas, supaya keduanya bisa digabung jadi satu linimasa tanpa tanggal
    yang bertengkar.
* `GET /api/topups/suggest-admin?nominal=` (<=0->0, <50rb->3000, <200rb->5000, else 7000)
* `GET /api/reports/daily?date=YYYY-MM-DD`
  -> `{data:{date,sales:{n,omzet,diskon},hpp,laba,byMethod,topup,topItems,lowStock}}`
  - `hpp = ROUND(SUM(sale_items.qty * sale_items.cost))` untuk penjualan hari itu.
  - `laba = sales.omzet - hpp` (omzet sudah **setelah** semua diskon).
  - `sales.diskon` = **TOTAL diskon hari itu** = `SUM(sales.discount)` (transaksi)
    + `SUM(sale_items.discount)` (per baris). Tanpa penjumlahan ini angka diskon
    akan menyembunyikan diskon per baris padahal omzet sudah menguranginya —
    dan `omzet - diskon != subtotal` jadi tidak terjawab.
  - `topItems` dikelompokkan per `(name, unit)` dan tiap baris memuat `unit` —
    tanpa pemisahan ini penjualan "2 pack" dan "3 btl" produk sama tercampur
    jadi satu baris qty=5 campur satuan.
  - Jasa/cetak/desain punya `cost = 0` (tidak ada persediaan) -> penjualannya
    seluruhnya dihitung laba. Topup/tarik TIDAK masuk omzet (lihat §domain).
* **Backup DB (fitur 1.2, sejak 2026-10-02)** — file backup disimpan di folder
  `backups/` sebelah database (`path.join(path.dirname(dbPath),'backups')`,
  pola `IMG_DIR`), nama `data-<YYYY-MM-DD>-<HHMMSS>.db` (semua **UTC**),
  whitelist regex `^data-\d{4}-\d{2}-\d{2}-\d{6}\.db$`.
  * `GET /api/backup` -> `{data:[{nama,ukuran,waktu}]}` (urutan **nama DESC** =
    terbaru dulu; `waktu` = mtime ISO). Read-only, tidak menyentuh
    `products.version`.
  * `POST /api/backup` `{}` -> **201** `{data:{nama,ukuran,waktu}}` — selalu
    membuat file **BARU** (tanpa cek "hari ini sudah ada" — cek harian itu
    milik scheduler, bukan endpoint ini). **Nama detik-kuantum dijamin unik**:
    dua POST pada detik yang sama (klik ganda / scheduler + manual) dahulu
    menghasilkan nama identik sehingga backup KEDUA MENIMPA yang pertama —
    kini reservasi sinkron `NAMA_BACKUP_TERPAKAI` + `existsSync` menggeser
    nama +1 detik sampai bebas (urut leksikografis = kronologis tetap utuh).
    Gagal (disk penuh/integrity rusak) -> **500** `{error}` dan file rusak
    **dibuang** (bukan ditinggal sebagai "backup" yang tak bisa direstore).
  * `GET /api/backup/:nama` -> byte file + `Content-Type: application/octet-stream`
    + `Content-Disposition: attachment`. **Guard GANDA**: `path.basename(nama)
    !== nama` ATAU tidak cocok pola whitelist -> **404**; file tidak ada ->
    404. Jangan pernah menerima `:nama` apa pun dari client.
  * Mekanisme: `db.backup()` (better-sqlite3, async) -> paksa file hasil ke
    `journal_mode=DELETE` (source WAL meninggalkan pendamping `-shm`/`-wal`
    yang membuat restore manual tidak portabel) -> `integrity_check` koneksi
    terpisah; selain `'ok'` -> file + pendamping dihapus + error.
  * **Retensi `KEEP = 14`** (konstanta di `apps/api/src/index.ts`, BUKAN
    `/api/settings` — kontrak settings tervalidasi boolean): tiap backup
    membuang 15+ terbesar (urutan nama = kronologis) beserta `-shm`/`-wal`.
  * **Scheduler idempoten harian**: `backupHarian()` jalan sekali saat API
    hidup + `setInterval` tiap 1 jam; cek "sudah ada `data-<hari-UTC>-*.db`?"
    sebelum membuat — restart `tsx watch` tidak menggandakan backup, gap
    maksimal ±25 jam.
  * **Restore = manual dokumentasi** (tanpa endpoint, disengaja): matikan API,
    ganti `data.db` dengan file backup, hidupkan lagi. Jangan menambah endpoint
    restore tanpa diskusi — menulis DB dari body request = risiko keamanan baru.
* Endpoints backup diuji `tests/backup-test.mjs` (27 asersi, terdaftar di
  `tests/run.mjs`): daftar/POST/unduh+integrity/guard 3×404/retensi 16
  dummy/UI kartu. Test MEMINDAHKAN file asli ke snapshot lalu mengembalikan
  file asli di `finally` — jangan menghapus file `backups/` milik pemilik di
  luar test.

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
  (Sudah pernah dikonfirmasi user & dijalankan 2026-09-28: seluruh 18 SKU seed
  di-rename ke pola `PRD00001`..`PRD00018` mengikuti urutan `db/seed.sql`,
  produk buatan user ikut jadi `PRD00019`. Backup:
  `apps/api/data/data.db.bak.sku-prd`.)
* DILARANG menambah framework (React/Svelte/Electron) tanpa persetujuan — web vanilla-TS adalah keputusan sadar (ringan, tanpa build rapuh).
* Tailwind CSS v4 DISETUJUI 2026-09-25 (hanya build-time `@tailwindcss/vite` di `apps/web`,
  tanpa CDN; logika tetap vanilla-TS, tanpa Alpine/jQuery/chart-lib/font-icon).
* DILARANG menambah dependency print-agent — harus tetap nol-deps (node:http + node:fs).
* Perubahan struk: layout `thermal` lebar TETAP 32 kolom (`apps/web/src/escpos.ts:COLS`),
  layout `a4` TETAP 64 kolom (`COLS_A4`) — lebar masing-masing tidak boleh berubah
  tanpa menyesuaikan test (`escpos-test.ts`, `e2e-struk.mjs`). Uji dengan
  `npx tsx tests/escpos-test.ts` (asersi kolom) atau ukur tiap baris di test.
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
  **Migrasi terakhir 2026-10-04 (Pelanggan toko — nomor urut + alamat +
  pelanggan pada penjualan):** 3 kolom `customers` (`code`, `supplier_no`,
  `address`) + 2 kolom `sales` (`customer_id`, `customer_name`).
  **Dijalankan sebagai ALTER in-place di dev (bukan re-create)** — keputusan
  sadar: data pelanggan + riwayat penjualan sudah berisi, re-create akan
  membuangnya (re-create hanya untuk perubahan murni skema di awal dev).
  Urutan yang dipakai (backup DENGAN checkpoint WAL dulu):
  ```bash
  sqlite3 apps/api/data/data.db 'PRAGMA wal_checkpoint(TRUNCATE);'
  cp apps/api/data/data.db apps/api/data/data.db.bak.customer-sales
  sqlite3 apps/api/data/data.db <<'SQL'
  ALTER TABLE customers ADD COLUMN code TEXT NOT NULL DEFAULT '';
  ALTER TABLE customers ADD COLUMN supplier_no TEXT NOT NULL DEFAULT '';
  ALTER TABLE customers ADD COLUMN address TEXT NOT NULL DEFAULT '';
  ALTER TABLE sales ADD COLUMN customer_id INTEGER REFERENCES customers(id);
  ALTER TABLE sales ADD COLUMN customer_name TEXT NOT NULL DEFAULT '';
  SQL
  npm run seed   # tanam "Pelanggan Umum" (WHERE NOT EXISTS by code)
  ```
  `db/schema.sql` tetap ditulis penuh dengan kolom baru (sumber kebenaran) —
  `migrate()` memakai `CREATE IF NOT EXISTS`, jadi install lama tidak otomatis
  dapat kolomnya; SQL di atas juga dipakai untuk install yang tidak boleh
  di-recreate. Seed menanam kontak default **`Pelanggan Umum` (`CUS-000001` /
  `SUP-000001`)** — pilihan otomatis header POS & "Bill to" invoice A4.
  Migrasi sebelumnya 2026-10-04 (Pelanggan & hutang): dua tabel baru
  **`customers`** + **`customer_debts`** (re-create penuh, backup
  `data.db.bak.customers` — dibuat DENGAN checkpoint WAL dulu, sesuai aturan di
  bawah). Tabel baru = baris baru di `db/schema.sql` + `npm run seed`; tidak ada
  kolom lama yang berubah, jadi data API lain ikut hilang bersama re-create
  (buka shift lagi setelahnya).
  Migrasi sebelumnya 2026-10-03 (Invoice A4 — nomor invoice + kop toko):
  kolom **`sales.invoice_no`** + 4 baris `settings store_name/store_address/
  store_phone/store_email` (re-create penuh, backup `data.db.bak.invoice-no`;
  seed menanam kop contoh pemilik lewat `INSERT OR IGNORE`, jadi seed ulang
  tidak menghapus kop yang sudah diisi). **PERINGATAN backup WAL** (bukti dari
  migrasi ini): `cp data.db data.db.bak` TANPA checkpoint meninggalkan seluruh
  isi di file pendamping `-wal` — file backup jadi 4096 byte (kosong). Selalu
  jalankan `sqlite3 data.db 'PRAGMA wal_checkpoint(TRUNCATE);'` (atau
  `VACUUM INTO 'backup.db'`) SEBELUM menyalin DB.
  Migrasi sebelumnya 2026-10-03 (catatan per baris di POS): kolom
  **`products.use_note`** + **`sale_items.note`** (re-create penuh, backup
  `data.db.bak.use-note`).
  Migrasi sebelumnya 2026-09-30 (saklar kadaluarsa per kategori): kolom
  **`categories.use_expiry`** (re-create penuh, backup
  `data.db.bak.use-expiry`) — seed menyalakannya untuk `snack` + `eskrim`.
  Catatan: API `POST /api/categories` berjalan via **tsx watch**, jadi setelah
  file DB diganti proses API **harus di-restart** (proses lama masih memegang
  inode DB lama yang sudah terhapus) — `pkill -f 'tsx [w]atch'` lalu
  `npm run dev:api`.
  Migrasi sebelumnya 2026-09-29 (foto + diskon + kadaluarsa + pengaturan):
  kolom `products.image`, `products.discount_type`, `products.discount`,
  `products.expiry_date`, kolom `sale_items.discount`, dan **tabel `settings`**
  (re-create penuh, backup `data.db.bak.foto-diskon-kadaluarsa`). Seeder juga
  menanam baris `settings ('allow_negative_stock','0')` lewat `INSERT OR IGNORE`
  — seed ulang TIDAK mereset pilihan pemilik.
  Migrasi sebelumnya 2026-09-28 (fitur #3 Multi satuan): tabel
  `product_units` + kolom `sale_items.unit` (backup
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
  Untuk migrasi 2026-09-29 di install yang tidak boleh di-recreate, jalankan
  (di luar repo ini):
  ```sql
  ALTER TABLE products ADD COLUMN image TEXT;
  ALTER TABLE products ADD COLUMN discount_type TEXT NOT NULL DEFAULT 'rp';
  ALTER TABLE products ADD COLUMN discount INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE products ADD COLUMN expiry_date TEXT;
  ALTER TABLE sale_items ADD COLUMN discount INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT OR IGNORE INTO settings (key, value) VALUES ('allow_negative_stock', '0');
  ```
  Folder thumbnail `apps/api/data/img/` dibuat sendiri oleh API saat unggah
  pertama — tidak perlu dibuat manual.
  Migrasi 2026-09-30 (`categories.use_expiry`) di install yang TIDAK boleh
  di-recreate:
  ```sql
  ALTER TABLE categories ADD COLUMN use_expiry INTEGER NOT NULL DEFAULT 0;
  UPDATE categories SET use_expiry = 1 WHERE slug IN ('snack', 'eskrim');
  ```
  Migrasi 2026-10-03 (catatan per baris) di install yang TIDAK boleh
  di-recreate:
  ```sql
  ALTER TABLE products ADD COLUMN use_note INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE sale_items ADD COLUMN note TEXT NOT NULL DEFAULT '';
  ```
  Migrasi 2026-10-03 (Invoice A4) di install yang TIDAK boleh di-recreate —
  `invoice_no` diisi sendiri oleh `POST /api/sales` berikutnya (lama tetap
  NULL, tampil `—` di invoice); `store_*` sengaja default kosong, pemilik
  mengisinya lewat kartu **Pengaturan toko** di `#/settings`:
   ```sql
   ALTER TABLE sales ADD COLUMN invoice_no TEXT;
   INSERT OR IGNORE INTO settings (key, value) VALUES ('store_name', '');
   INSERT OR IGNORE INTO settings (key, value) VALUES ('store_address', '');
   INSERT OR IGNORE INTO settings (key, value) VALUES ('store_phone', '');
   INSERT OR IGNORE INTO settings (key, value) VALUES ('store_email', '');
   ```
  Migrasi 2026-10-04 (Pelanggan & hutang) di install yang TIDAK boleh
  di-recreate — dua tabel BARU (tanpa data lama, jadi tidak ada risiko
  kehilangan kolom; jalankan saat API mati):
  ```sql
  CREATE TABLE IF NOT EXISTS customers (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    phone       TEXT NOT NULL DEFAULT '',
    note        TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
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
  ```


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
