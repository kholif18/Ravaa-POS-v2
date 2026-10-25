# ROADMAP — Ravaa POS v2

> Disusun **2026-10-01** dari hasil riset fitur kompetitor (Aronium, Kasir
> Pintar, tren POS 2026) dipetakan ke kondisi repo. Sumber riset tercantum di
> bagian bawah; setiap butir "Gap" di bawah punya bukti absennya di kode
> (diverifikasi dengan grep/read sesi riset, bukan ingatan).
>
> **Aturan main roadmap ini:**
> 1. Satu butir = satu commit/PR sendiri, kontrak `.opencode/agents/AGENTS.md`
>    §3 ikut di-update, test suite hijau + angka `ekspek` `tests/run.mjs`
>    disesuaikan (DoD §7 AGENTS).
> 2. Tanpa framework/dependency baru; struk tetap 32 kolom; aturan hari UTC
>    lewat `apps/web/src/ui/waktu.ts`.
> 3. Butir yang menandai **[KEPUTUSAN]** = butuh jawaban pemilik dulu — jangan
>    dikembangkan sebelum keputusan itu ada (larangan anti-halusinasi).
> 4. Urutan = prioritas. Next step resmi ada di **§1**.

---

## 1. NEXT STEP (mulai dari sini)

**Fase 1 — Quick wins, tanpa keputusan bisnis, tanpa migrasi skema:**

| # | Butir | Kenapa sekarang |
|---|-------|-----------------|
| 1.1 | **Bagikan struk & rekap harian via WhatsApp** | Gap diverifikasi (grep `wa.me\|whatsapp` = 0 di `apps/web/src`); tren pasar 2026 (rekap-ke-pemilik via WA = fitur andalan app Indonesia); murni client-side — **tidak ada endpoint/skema baru**, risiko paling kecil |
| 1.2 | **Backup otomatis DB** | Gap diverifikasi (grep `backup` = 0 di `apps/api/src/index.ts`); meniru Aronium "automatic database backups"; data toko hidup di satu file SQLite — kehilangan = toko mati |
| 1.3 | **Expected-cash saat tutup shift** | Gap yang diakui repo sendiri (`apps/web/src/pages/shifts.ts:14,20` komentar + README §shift); **keputusan pemilik sudah lengkap 2026-10-01** (lihat §1.3) — **SELESAI 2026-10-02** |

**Eksekusi berurutan: ~~1.1~~ → ~~1.2~~ → ~~1.3~~ (Fase 1 SELESAI 2026-10-02).**
(1.1 **dicoret pemilik 2026-10-01**:
toko kecil tidak perlu notif/rekap WhatsApp.) Setelah Fase 1 hijau, lanjut Fase 2
(laporan per jam/kategori dulu — tanpa keputusan baru), lalu Fase 3 hanya
butir yang sudah di-ACC pemilik.

### ~~1.1 Bagikan struk & rekap harian via WhatsApp~~ **DICORET (2026-10-01)**
> Alasan pemilik: untuk toko kecil, notif/rekap WhatsApp tidak perlu.
> Rincian desain di bawah dipertahankan sebagai arsip — jangan dikerjakan
> tanpa permintaan baru.
- **Isi:** tombol **Bagikan** (a) di rincian nota halaman Riwayat — teks nota
  rapi (waktu/no/kasir/item/total/tunai-kembali) siap tempel ke chat; (b) di
  Laporan/Dashboard — ringkasan harian (omzet/laba/topup/stok menipis) untuk
  dikirim ke pemilik/GRUP toko. Buka `https://wa.me/?text=<urlencoded>` —
  pemilih kontak ada di WhatsApp.
- **Bukan:** struk ESC/POS (itu tetap lewat print-agent). Ini teks chat.
- **File:** builder teks baru di `apps/web/src/escpos.ts` (atau modul baru
  `apps/web/src/ui/share.ts`) + tombol di `pages/history.ts`,
  `pages/reports.ts`, `pages/dashboard.ts`.
- **Tanpa** endpoint baru, tanpa dependency, tanpa skema.
- **DoD:** teks terbaca utuh (escape `%0A`), tombol tidak merusak alur cetak
  yang sudah ada, suite regresi hijau, uji klik manual di 3 halaman.

### 1.2 Backup otomatis DB
- **Isi:** `POST /api/backup` -> salin `data.db` konsisten (WAL aman) ke
  `data/backups/data-YYYY-MM-DD-HHMMSS.db`, simpan N terakhir (default 14,
  diatur lewat `settings`), `GET /api/backup` daftar + `GET /api/backup/:nama`
  unduh. Dipanggil cron ringan **di dalam API** (interval jam) + tombol manual
  di halaman Sistem. Tanpa dependency baru (pakai mekanisme salin yang
  disediakan better-sqlite3 / checkpoint dulu — **verifikasi API persis saat
  implementasi, jangan asumsi**).
- **File:** `apps/api/src/index.ts` (endpoint + jadwal), `pages/settings.ts`
  (kartu Backup), kontrak §3 AGENTS, README.
- **DoD:** `curl POST /api/backup` membuktikan file backup lahir & DB asli
  sehat (jalankan `PRAGMA integrity_check`), restore = salin file manual
  (didokumentasikan), test suite baru + `ekspek` naik.

### 1.3 Expected-cash tutup shift **[SELESAI 2026-10-02]**
- **Isi:** hitung **kas yang seharusnya di laci** = `modal_awal + gerak kas`
  lalu bandingkan dengan `modal_akhir`; tampil rincian di dialog Tutup shift.
  Rumus di dua fungsi `kasSeharusnya()` + `hitungSelisih()`
  (`apps/web/src/pages/shifts.ts`); agregatnya (`qris`, `transfer`,
  `topup_nominal/admin`, `tarik_nominal/admin`) ditambahkan ke subquery
  `GET /api/shifts`.
- **Keputusan pemilik (2026-10-01), tercatat:**
  1. **Topup e-wallet = tunai** — pelanggan bayar tunai (nominal + admin) ->
     laci **NAIK**. Admin **fleksibel per transaksi** (kontrak sudah:
     `admin` editable; tarif indikatif pemilik: <49rb→2.000, 50–100rb→3.000,
     101–500rb→5.000, ≥501rb→10.000 — beda provider bisa beda tarif.
     Saat eksekusi: samakan default `GET /api/topups/suggest-admin`
     dengan tangga ini **bila pemilik ACC**).
  2. **Tarik tunai JANGAN mengurangi laci** — cukup **dicatat** sebagai
     info transaksi, jangan masuk hitungan expected-cash. Alasan pemilik:
     kalau baru buka shift (modal kecil) lalu ada tarik tunai besar,
     expected-cash bisa jadi minus. Catatan: konsekuensinya selisih kas
     akhir TIDAK mencerminkan arus tarik tunai — tampilkan saja angka
     fakta per baris tanpa membawanya ke rumus.
  3. **QRIS/transfer TETAP masuk hitungan laci** (kebalikan dari asumsi
     awal riset yang menganggapnya dana rekening) — **dan wajib tercatat**
     sumbernya transfer/QRIS. `sales.pay_method` sudah menyimpan ini;
     rincian per metode tinggal ditampilkan di dialog tutup shift.
- **DoD:** rumus disepakati tertulis di README + kontrak; angka contoh dari
  data asli diverifikasi dengan `curl`; test shift-test menambah asersi rincian.
  **Terpenuhi 2026-10-02** — curl `GET /api/shifts` vs sqlite langsung
  (shift #1: expected = 100000 + 100000 + 950000 + 95000 = **Rp1.245.000**),
  `shift-test.mjs` 19 → **23** asersi (2 agregat + 2 dialog), README §shift +
  kontrak §3 diperbarui, `npm test` SEMUA HIJAU.

### 1.4 Refactor halaman Label harga — cetak lembar A4/Folio **[SELESAI 2026-10-18 — termasuk uji cetak fisik pemilik]**
- **Latar (keputusan pemilik 2026-10-17):** printer label toko = **Epson
  L3110 & L1210** (inkjet lembar), kertas **A4 + Folio (215×330 mm)** — bukan
  printer thermal 58 mm. Halaman `#/labels` direfactor total mengikuti
  riset Aronium (23 opsi price-tag) + pelengkap dari POS lain (live preview,
  setelan diingat per device, satuan, harga promo opsional dari Erzap).
- **Keputusan yang sudah lengkap:** (1) cetak = dokumen HTML `@page` mm lewat
  `window.print()` browser (pola invoice A4 — print-agent ESC/POS TIDAK
  dipakai lagi untuk label, tetap dipakai struk thermal); (2) halaman full
  tanpa sidebar admin + header (tombol ← Kembali ke Produk), menu sidebar
  "Label harga" dihapus, tombol pindah ke toolbar Produk antara
  "Sinkron" dan "Impor"; (3) split kiri ±30% pengaturan / kanan pratinjau
  lembar (kertas + tata letak + isi label ala Aronium, live preview).
- **Butir 1 — modul murni `apps/web/src/labelsheet.ts` + `tests/labelsheet-test.ts`:**
  setelan halaman (kertas/margin/kolom/tinggi label/jarak/isi/font/barcode
  tinggi/salinan), tata letak grid (`hitungTataLetak`/`hitungHalaman`),
  encoder barcode SVG EAN-13/EAN-8 (checksum dihitung), builder HTML lembar
  (`labelHtml`/`lembarHtml`/`htmlDokumenLabel`), `cetakLabel()`.
- **Butir 2 — halaman & navigasi:** tulis ulang `pages/labels.ts` (panel
  pengaturan + pratinjau live + pemilihan produk pola lama), `renderLabelShell()`
  di `ui/shell.ts` + plumbing rute `labels` tanpa menu nav (tetap owner-only),
  tombol Label di `pages/products.ts` (antara `#sync` dan `#prod-import`).
- **Butir 3 — bersih-bersih & tes:** hapus fungsi label lama di `escpos.ts`
  (`ProdukLabel`/`labelHarga`/`kolomSub`/`teksLabel`/`gabungLabel`/
  `blokBarcode`/`sesuaikanPrinter` — terverifikasi hanya dipakai halaman label
  + test), sesuaikan `tests/escpos-test.ts` (ekspek turun), tulis ulang
  `tests/e2e-label.mjs` (tanpa print-agent :9101; verifikasi shell, pratinjau,
  popup cetak ber-`@page`), update ekspek `tests/run.mjs`, AGENTS.md §2,
  README.
- **Hasil:** butir 1–3 selesai; `labelsheet-test.ts` 64 asersi, `escpos-test.ts`
  46 (blok label dihapus), `e2e-label.mjs` 34 (popup cetak browser, tanpa
  print-agent), suite penuh **1398 hijau**. Selama jeda cetak (`getPrintPause`)
  halaman menolak klik Cetak (chip "Cetak dijeda" + toast).
- **Revisi 2026-10-17 (pemilihan produk — *"ganti sebagai dropdown saja, jadi
  teknisnya seperti keranjang belanja"*):** daftar penuh di panel kiri diganti
  **kolom cari + dropdown hasil** (klik opsi = masuk keranjang "Produk
  terpilih", opsi terdaftar diberi centang + no-op; Enter/Esc/blur 150ms —
  pola dropdown `#po-hasil`) + kotak **"Produk terpilih"** ber-ikon hapus per
  baris. `e2e-label.mjs` 34 → **42**; ditemukan + diperbaiki bug ikon SVG 0px
  yang sama di dropdown `#po-hasil` purchases.ts. Suite penuh **1406 hijau**.
- **Revisi 2026-10-17 (barcode Code 128 + fallback SKU — pemilik: *"barcode
  pilihan pertama, SKU bagi produk yang tidak memiliki barcode"*):** kolom
  `barcode` EAN → batang EAN (lama); barcode non-EAN → **Code 128 subset B**;
  barcode kosong → **SKU sebagai Code 128** (semua produk punya SKU); kode tak
  encodable (> `MAKS_KODE128` = 10 char / non-ASCII) atau tak muat lebar label
  (lebar isi − padding/border) tetap **teks** `lb-barcode-num` (tanpa
  pengecilan modul). Encoder `kode128`/`barcode128Svg` di `labelsheet.ts`,
  tabel 107 simbol diverifikasi silang JsBarcode + Wikipedia (vektor uji
  'PRD00001' checksum 24). SKU sengaja TIDAK pernah lewat EAN (checksum ulang
  bisa mengubah digit → scan tak lagi cocok exact-match POS). `labelsheet-test`
  64 → **80**; `e2e-label` 42 → **46** (produk uji kedua tanpa barcode);
  suite penuh **1426 hijau**.
- **Revisi 2026-10-17 (kaki label — pemilik: *"di bagian atas barcode dibawah
  Harga tidak perlu, bisa di hapus"*):** baris `SKU · satuan` (`lb-kaki`)
  dihapus penuh dari `labelHtml` + `CSS_LABEL` + opsi `IsiLabel` + toggle kartu
  Sistem (sengaja bukan default-off: setelan device lama masih `true` sehingga
  toggle mati akan tampak menyala tanpa efek); SKU tetap terbaca di
  `lb-barcode-num`. Jumlah asersi tidak berubah (guard anti-regresi mengganti
  asersi lama) — suite tetap **1426 hijau**.
- **Revisi 2026-10-17 (keranjang default kosong — pemilik: *"buat default
  kosong, jangan sampai memilih semua produk, jika ada ribuan akan
  menghambat/menyebabkan system lemot. biar user yang memilihnya sendiri"*):**
  auto-centang SEMUA produk layak saat mount — dulu di DUA jalur (cache
  IndexedDB + `load()` server) — DIHAPUS; `state.pilih` mulai `new Set()`,
  pratinjau langsung empty-state, tombol Cetak mati sampai ada pilihan;
  pemilihan hanya lewat aksi user (dropdown `#lb-hasil` / `#lb-pilih` /
  `#lb-kosong`). `e2e-label` 46 → **48** (asersi anti-regresi "default
  kosong" + strip info terisi setelah pilih); suite penuh **1428 hijau**.
- **DoD:** build web lolos, suite regresi hijau dengan ekspek baru, cetak uji
  nyata 1× (pemilik, kertas A4 & Folio, skala 100%) **termasuk scan fisik
  Code 128** (belum pernah diuji di atas kertas).
- **Uji cetak fisik — SELESAI 2026-10-18:** pemilik menguji cetak label
  langsung di kertas dan memindai barcode hasil cetaknya: *"sudah saya uji
  coba dan hasilnya sempurna, saya anggap cetak label selesai"*.

### 1.5 Refactor halaman Laporan + byHour + Laba per transaksi **[SELESAI 2026-10-17]**
- **Latar (permintaan pemilik 2026-10-17):** *"kerjakan byHour, laba per
  produk, laba transaksi perhari, kemudian baru kerjakan laporan yang kamu
  list. perlu refactor juga halaman report untuk menampung seluruh menu
  laporan"*.
- **Butir server (`apps/api/src/index.ts`):** `laporanRentang()` (satu fungsi,
  daily = rentang 1 hari) + **`byHour`** (24 ember UTC zero-fill); `topItems`
  + kolom **`hpp`/`laba`** (server — rumus = products); `reports/products`
  + **`laba`** per baris (klien tidak menghitung ulang lagi); endpoint BARU
  **`GET /api/reports/profit`** `{total, days, trx}` — `days` HANYA hari yang
  ada penjualan (rentang kosong = `[]`), `trx` = 200 nota terbaru dengan HPP
  per nota lewat subquery (join langsung menggandakan `s.total`).
- **Butir web (`reports.ts` ditulis ulang):** registry **`MENUS`** — 6 menu
  (Harian/Laba/Kasir/Produk/Piutang/Stok) di sidebar kiri grup
  Penjualan/Keuangan/Stok; tiap menu satu objek (`label/grup/filter/cari/
  muat/isi/csv/cetak`); `cetakLaporan()` (popup + `window.print`, builder
  `DokLaporan` di invoice.ts); grafik batang per jam `[data-jam]` (DIV
  sengaja bukan tabel — urutan DOM kontrak `laporan-test` tidak bergeser).
  Menu Harian tetap pemilih satu hari (prev/next + chip Hari ini).
- **Revisi (filter rentang, 2 putaran):** putaran 1 *"date filter seperti
  downloadan"* (referensi Blueprint) — dialog date-range; putaran 2 pemilik
  *"jadikan dropdown saja jangan seperti modal"* — panel `#rp-pop` melayang
  di bawah tombol: 8 preset + Kustom kiri, dua kalender (kepala Senin–
  Minggu, select bulan/tahun + panah) kanan, highlight+hover satu rumus
  (`kelasHari()`/`bulanHtml()` di `ui/waktu.ts`), batas 366 hari divalidasi
  di panel, tutup klik luar/Esc/Batal/Terapkan (`AbortController`, pola
  shell.ts; `tutupPopRentang()` juga dipanggil `paint()`). `#rp-from`/
  `#rp-to` kini hidden (kontrak test membaca rentang berlaku dari situ).
- **Revisi (aside, 4 putaran):** *"tingginya tidak sama dengan yang kanan"*
  → sempat di-stretch penuh setinggi kolom; *"aside jadi tidak sticky lagi"*
  → sticky dipindah ke blok isi; lalu *"cardnya mengikuti tinggi kolom
  kanan … yang full hanya Harian/Laba … hanya textnya yang sticky"* + label
  *"beri warna atau tambahkan gap dari atasnya"* → KARTU MANDIRI setinggi
  isinya + SELURUH kartu sticky; lalu *"jadikan template untuk semua laporan,
  agar perilaku dan layout sama persis — di setiap halaman laporan seperti
  berbeda"* → inset `top-4` **diganti `top-0`**: inset positif membuat kartu
  tergeser turun hanya di menu yang kolom kanannya memberi ruang geser
  (terukur Harian/Laba/Produk y=72 vs Kasir/Piutang/Stok y=56); kini posisi
  kartu identik di KEENAM menu (y=56, sejajar tepi kolom kanan) dan menempel
  di posisi itu saat digulir (56 → 56). `<aside>` pembungkus tanpa visual yang
  stretch sebagai containing block sticky; label grup `text-primary` +
  `pt-4` vs item `text-sm text-gray-700`.
- **Tes:** `laporan-test.mjs` 16 → **20** (byHour + kolom HPP/Laba);
  `laporan-menu-test.mjs` 16 → **33** (registry 6 menu + dropdown: 8 preset
  + 2 kalender + bukan modal + klik-luar + Esc; CSV/cetak per menu;
  3 asersi anti-regresi aside: kartu mandiri, sticky utuh, template identik
  6 menu termasuk sejajar kolom kanan). Suite penuh **1449 hijau**.
- **Bersih-bersih:** `bukaDialogRentang`/`openModal` dihapus dari reports.ts;
  docs diperbarui (AGENTS §2/§3 + README).

### 1.6 Antrian implementasi — keputusan pemilik 2026-10-19 (usulan baru)

> Jawaban pemilik atas 12 usulan prioritas (`docs/perbandingan-pos.md` §4;
> daftar bernomor dikirim 2026-10-19 lewat chat). **7 butir ACC** — dikerjakan
> satu per satu (satu butir = satu commit, aturan §3.4); **5 butir ditolak**
> (dirinci di §4.1). Status per baris ikut diperbarui di
> `docs/perbandingan-pos.md` §4–§5.

| # | Butir (kandidat §4) | Scope kunci | Status |
|---|---------------------|-------------|--------|
| 1.6.1 | **Scan barcode kamera HP** (4.4) | `getUserMedia` + `BarcodeDetector` (API browser, tanpa dependensi); tombol di scan bar POS & header mobile; hasil deteksi masuk ke alur `#pos-q` yang sama (`Qty*Kode` tetap jalan). Konteks aman (HTTPS/localhost) wajib — pesan jelas bila diblokir | **SELESAI 2026-10-19** |
| 1.6.2 | **Kas masuk** (4.5) | Pasangan Pengeluaran: kas masuk non-penjualan (injeksi modal/koreksi laci) terikat shift opsional; laci **NAIK** di `kasSeharusnya()`; rekap harian + Z-report ikut | **SELESAI 2026-10-19** |
| 1.6.3 | **Cetak/ekspor nota PO** (4.6) | Dokumen PO A4 (kop `store_*`, supplier, item, total/terbayar/sisa) lewat `window.print()` (pola `cetakInvoice`/`cetakHutangA4`) + tombol di sub-halaman `#/purchases/<id>` | **SELESAI 2026-10-19** |
| 1.6.4 | **Logo di struk thermal** (4.11) | Unggah logo di Sistem (file di `img/`, pola avatar — bukan localStorage); raster ESC/POS `GS v 0` dikonversi di klien & disisipkan di awal struk thermal semua jalur cetak; uji kertas oleh pemilik | **SELESAI 2026-10-19** (uji kertas oleh pemilik) |
| 1.6.5 | **Split payment** (4.1 / 3.4) | Tabel `sale_payments` (atribusi per metode, Σ = total) + `payments[]` di `POST /api/sales`; modal bayar 2 metode (vs1 lebar `wider` 1024px + toggle pil di judul + panel 2 kolom — **tanpa scroll di 1366×720**); `pay_method='campuran'`; byMethod/laporan, agregat tunai/qris/transfer shift, struk/invoice, resume, Riwayat, lapisan mobile ikut | **SELESAI 2026-10-19** |
| 1.6.6 | **Pesanan jasa + DP/status** (4.3) | Halaman `#/orders` (daftar + sub-halaman baru/rincian): item teks bebas **tanpa potong stok**, pelanggan wajib + snapshot nama, nomor `ORD-YYMMDD-NNN`; **DP** per metode (bukan omzet, masuk laci shift penerima); **Serahkan** = nota penjualan penuh (omzet di sini; `insertSale` satu transaction + atribusi `sale_payments` per metode + sisa → Hutang ledger + status diambil) — **Batalkan** refund DP; laci: `order_masuk_total`/`order_omzet_total`; `reports/daily.piutang.baru` += `orders.hutang_sisa`; Riwayat `order_no`; nota pesanan thermal + struk penjualan reuse dialog Riwayat. Diuji `orders-test.mjs` (68 asersi) | **SELESAI 2026-10-19** |
| 1.6.7 | **Analitik lanjutan** (4.10) | Menu laporan **Analitik** (registry `MENUS`, 8 menu): valuasi persediaan per kategori (Σ stok × modal tertimbang vs Σ stok × harga jual — snapshot stok KINI, barang fisik saja) + barang **tidak laku** dalam rentang (berstok > 0 tanpa penjualan; `last_sold` all-time) + 4 kartu ringkas + CSV dua seksi + Cetak satu dokumen dua tabel; endpoint `GET /api/reports/analytics` (**sejak 2026-10-25 `wajibIzin('laporan.lihat')`** — dulu `hanyaOwner`, kini satu aturan dengan menu laporan lain) | **SELESAI 2026-10-19** |

**Ditolak pemilik 2026-10-19** (jangan dikerjakan tanpa permintaan baru,
rincian di §4.1): metode e-wallet + MDR · price list per pelanggan ·
bundling/paket · varian produk · akses dari luar LAN (Tailscale) ·
pengingat hutang via WA (4.12) · absensi staf (4.14) — "tidak perlu karena
tidak membutuhkannya". Tidak ada kandidat "belum dibahas" tersisa.

---

## 2. Fase 2 — Analitik (setelah Fase 1)

| # | Butir | Catatan |
|---|-------|---------|
| 2.1 | **Laporan penjualan per jam** **[SELESAI 2026-10-17 — lihat §1.5]** | `GET /api/reports/daily` tambah `byHour` (`strftime('%H', created_at)`, aturan UTC sama) + grafik batang di `#/reports`. Tren 2026: "4 laporan wajib" = per jam salah satunya. Endpoint lama diperluas (bukan baru) — update §3. |
| 2.2 | **Laporan penjualan per kategori** **[SELESAI 2026-10-18]** | `byCategory` di `laporanRentang()` = `sale_items` -> `products` -> `categories` (ikut `GET /api/reports/daily` + `/summary`), rumus amount/hpp/laba sama persis dengan menu Produk, baris manual tanpa produk -> "Tanpa kategori". Menu **Kategori** (grup Penjualan) di `#/reports`: tabel + baris Jumlah + catatan + CSV + Cetak; `laporan-menu-test` 33 -> **38** asersi. |
| 2.3 | **Tahan nota (transaksi tertunda)** **[SELESAI 2026-10-04 — P5]** | Keranjang sementara per device (IndexedDB kv `holds` — `getHolds()`/`saveHolds()` di `store.ts`, tanpa skema/endpoint API) + tombol **Tahan (F7)** / **Pending n (F8)** + modal split antrean‖pratinjau (`bukaTertahan()`); meniru Aronium "named order"/Erzap "F3 pending". |
| 2.4 | **Margin (laba) per produk di laporan** **[SELESAI 2026-10-17 — lihat §1.5; termasuk laba per hari + per transaksi]** | `topItems` sudah ada qty/amount; tambah `hpp` & `laba` per baris (angka `cost` sudah di-snapshot per baris — cukup `SUM(qty*cost)`). Revisi 2026-10-18: baris **"Jumlah"** di bawah tabel **Laba per transaksi** (total rentang; label "Jumlah periode" saat daftar terpotong 200) — permintaan pemilik *"berikan total jumlah di bawah tabel"*. |

## 3. Fase 3 — Fitur relasional (butuh ACC pemilik per butir)

> Tiap butir = tabel/kontrak baru -> migrasi re-create DB (kebijakan
> 2026-09-26 §5 AGENTS) + backup dulu. Jangan dikerjakan berurutan tanpa ACC.

| # | Butir | Sumber ide | Keputusan yang dibutuhkan |
|---|-------|-----------|---------------------------|
| 3.1 | **Pelanggan (tabel `customers`)** — **SELESAI 2026-10-04** | Kasir Pintar "Manajemen Pelanggan" (free), semua app Indonesia | Terjawab: opsional (201), tampil di struk/invoice lewat snapshot `customer_name`; tier menyusul 2026-10-11 |
| 3.2 | **Loyalty poin** — **DIBATALKAN pemilik 2026-10-18 ("tidak butuh")** | Kasir Pintar (plugin), Moka CRM, tren 2026 | — (tidak dikerjakan) |
| 3.3 | **Hutang/piutang tempo** — **SELESAI 2026-10-04** (ledger + aging FIFO + cetak A4) | Kasir Pintar free "Hutang/Piutang", Aronium "credit payments" | Terjawab: cicilan bebas ≤ sisa (lebih = 400); POS auto-catat hutang saat uang kurang + pelanggan valid |
| 3.4 | **Split payment** (tunai+QRIS satu nota) — **SELESAI 2026-10-19** (skema `sale_payments` + laporan byMethod + modal 2 metode) | Tren 2026, Erzap/Moka | Terjawab: atribusi per metode (Σ = total); split hanya 2 metode & butuh uang tunai cukup; hutang tetap jalur satu metode |
| 3.5 | **Harga bertingkat per jumlah qty** — **SELESAI 2026-10-19** (tabel `product_borongan` + API `borongan` + blok form produk + potongan otomatis POS) | Kasir Pintar "Tipe Harga", Olsera harga grosir + pertanyaan pemilik 2026-10-18 saat membedah form "Satuan jual" (*"jika qty tercapai harga juga berubah?"*) | Terjawab — keputusan pemilik 2026-10-18/19 (3 opsi rekomendasi dipilih); detail + implementasi di bawah |
| 3.6 | **Supplier & riwayat pembelian (PO)** — **SELESAI Tahap 3, 2026-10-11** | Kasir Pintar free, Loyverse purchase order | Terjawab: master `suppliers` penuh + PO (order → terima → bayar/cancel) + hutang supplier + aging |
| 3.7 | **Penerimaan PO sebagian (partial receive)** — **SELESAI 2026-10-25** (tabel `purchase_receives` + `purchase_receive_items`, receive bertahap + idempotensi `client_id`, UI form Terima & riwayat kedatangan) | Aronium/Loyverse: barang datang bertahap per qty | Terjawab: status tersimpan tetap `order`/`received` ("Sebagian" computed), uang dicatat per kedatangan, laporan/laci per tanggal kedatangan, PO hanya bisa dibatalkan sebelum ada penerimaan |

### 3.5 Harga bertingkat per jumlah qty — **SELESAI 2026-10-19**
- **Keputusan pemilik 2026-10-19 (semua opsi rekomendasi dipilih):**
  1. **Bentuk tingkatan = "kelipatan paket"** — contoh nyata pemilik: cetak
     foto 3×4 Rp1.000/lembar *"beli 6 = Rp5.000"* + buku tulis Rp3.500
     *"beli 10 = Rp33.000"*; sisa di atas paket tetap harga normal
     (7 lembar = 5.000 + 1.000; 12 buku = 33.000 + 7.000). **Opt-in per
     produk** (boleh beberapa tingkatan; kosong = tanpa aturan), berlaku juga
     untuk jasa (tanpa gate kategori).
  2. **Hanya satuan dasar** — jual per pak/dus tetap harga `product_units`
     sendiri (tidak dicampur). Pelanggan grosir: **"termurah menang"**
     (grosir vs borongan dihitung dari harga baris, tidak ditumpuk).
  3. **Keranjang POS**: potongan otomatis begitu qty berubah (ketik qty,
     tombol +/−, scan `6*SKU`), tampil transparan di kolom Diskon; edit
     diskon manual (termasuk menyetel 0) / ganti satuan = otomatisasi baris
     itu berhenti; baris TIDAK dipecah (aturan "harga beda = baris baru"
     tidak tersentuh).
  4. **Penjaga server tidak berubah** — harga non-dinamis tetap dikunci
     server; potongan lewat jalur diskon baris yang sudah divalidasi
     (`0 ≤ discount ≤ qty*price`); data ikut delta sync offline (`?since=`).
- **Implementasi 2026-10-19:** modul `apps/web/src/borongan.ts` (DP min-cost
  cover, fallback greedy qty > 100.000), tabel `product_borongan` + field API
  `borongan` (pola `units`: absen = tidak diubah, `[]` = hapus, isi = replace;
  validasi `qty ≥ 2`, tanpa qty ganda, `price < qty × harga jual`), blok
  "Harga borongan (qty)" di form produk, integrasi `pos.ts`
  (`CartLine.borongan` + `hitungPrefill` + `discManual`). Uji:
  `tests/borongan-test.ts` (31 asersi) + `tests/e2e-borongan.mjs`
  (52 asersi — API, qty 6/7/12/20, `6*SKU`, edit manual, ganti satuan,
  grosir termurah-menang, pulih setelah reload, nilai di
  `sale_items.discount`, form produk). SQL migrasi manual: AGENTS §5.
- **Latar (arsip):** pemilik bertanya saat membedah form produk bagian "Satuan
  jual" (*"Tambah satuan untuk apa? apakah bukan untuk menentukan harga qty
  tertentu harga jadi berubah? … jika qty tercapai harga juga berubah?"*).
  Jawaban status repo waktu itu (terverifikasi kode): "Tambah satuan" = harga
  per **SATUAN** (`resolusiSatuan`), harga grosir = per **PELANGGAN**
  (`customers.tier`), dan aturan qty→harga belum ada. ACC 2026-10-18
  (*"harga bertingkat OK"*); skema usulan riset `min_qty` di `product_units`
  **diganti** tabel tingkatan per produk (`product_borongan`) supaya
  tingkatan bisa beberapa level terpisah dari satuan jual.

### 3.7 Penerimaan PO sebagian (partial receive) — **SELESAI 2026-10-25**
- **Keputusan pemilik 2026-10-25 (opsi A + rekomendasi 1–3 diterima):**
  1. **Penyimpan = dua tabel baru** — `purchase_receives` (satu baris per
     EVENT kedatangan: shift, kasir, nilai, `dibayar`, catatan, `client_id`)
     + `purchase_receive_items` (qty & harga beli snapshot per baris PO).
     **Status tersimpan TIDAK diubah** (`order|received|cancel`): "Sebagian"
     dihitung dari Σ kedatangan, `received` hanya saat semua qty terpenuhi.
  2. **Uang per kedatangan** — `dibayar` = uang keluar pada kedatangan ITU
     (bawaan = nilai barang yang datang), `purchases.terbayar` mengakumulasi.
     Boleh melunasi kekurangan kedatangan sebelumnya, **tidak boleh** melebihi
     nilai barang yang sudah diterima (barang belum datang bukan hutang).
  3. **Laporan & laci per tanggal kedatangan** — `reports/daily`/`summary`
     dan agregat `GET /api/shifts` menghitung tiap event pada `created_at`-nya;
     nota lama `received` tanpa baris kedatangan tetap dihitung 1 event lewat
     `received_at` (fallback, **tanpa backfill**).
  4. **Koreksi, bukan hapus riwayat** — setelah ada penerimaan (walau
     sebagian) PO tidak bisa dibatalkan; koreksi stok lewat Opname, kas lewat
     Pengeluaran. Pembatalan hanya selama `n_terima === 0`.
- **Implementasi 2026-10-25:** API `POST /:id/receive` menerima `items`
  opsional (`{purchase_item_id, qty}`; tanpa `items` = terima semua sisa —
  pemanggil lama sah), idempotensi retry `client_id` (UNIQUE global, kirim
  ulang = `duplicate:true` tanpa menambah stok/uang), `sisa`/`sisa_terima`/
  `status_tampil`/`n_terima` computed di list/detail/POST; filter baru
  `status=sebagian` + `hutang` diperluas ke PO bertahap bersisa; `GET
  /:id` mengirim `receives[]` (riwayat kedatangan + items). UI
  `#/purchases`: badge `data-po-badge` (Order/Sebagian/Hutang/Lunas/Batal),
  progress qty diterima, form Terima per baris (default sisa, `#pt-bayar`
  live dengan maks nilai diterima), riwayat kedatangan, tombol batal hanya
  sebelum ada penerimaan; A4 menambah kolom **Diterima** + label baris
  ketiga kontekstual (`Belum diterima`/`Sisa hutang`/`Sisa (lunas)`).
  Uji: `tests/purchase-partial-test.mjs` (50 asersi: API bertahap,
  idempotensi, agregat shift/laporan, fallback nota lama, form/detail/A4) +
  penyesuaian `purchase-test` (46), `aging-test` (21), `recap-test` (16),
  `shift-test` (23), `laporan-test` (20). SQL migrasi: AGENTS §5 (murni tabel
  tambahan — `migrate()`/`npm run seed` cukup, tanpa ALTER).

## 4. Sengaja TIDAK diusulkan (domain 1–2 kasir toko fisik)

- **Multi-cabang / multi-outlet** — di luar domain; skala naik >5 device baru
  pertimbangkan Postgres (AGENTS §1).
- **QR self-order, manajemen meja, kitchen printer** — F&B, bukan toko
  ATK/cetak/service.
- **PPOB terintegrasi (batch provider)** — butuh API partner + saldo deposit;
  topup manual `nominal+admin` sudah mencakup use-case toko ini.
- **AI forecasting / demand prediction** — ranah vendor cloud berbayar;
  versi cukup = alert `min_stock` (sudah ada) + laporan per jam (2.1).
- **Email reporting terjadwal (Aronium $30/thn)** — butuh SMTP; jalur
  WhatsApp (1.1) sudah menutup kebutuhan rekap pemilik.
- ~~**Refund/retur jual**~~ — **SELESAI Tahap 2 (2026-10-11)**: retur dari
  nota + retur manual + pembatalan (stok kembali, uang kembali); koreksi lain
  tetap lewat opname.

### 4.1 Ditolak pemilik 2026-10-19 (hasil keputusan atas usulan baru)

- **Metode bayar e-wallet + jejak MDR** (kandidat 4.2) — toko pribadi, tidak
  ada payment gateway; QRIS/transfer manual (klik konfirmasi) sudah cukup.
- **Price list khusus per pelanggan** (4.7) — "sepertinya tidak butuh";
  tier ecer/grosir + harga borongan per qty dianggap cukup.
- **Bundling/paket produk** (4.8) — "sepertinya tidak butuh".
- **Varian produk** (4.9) — tidak perlu; pola SKU terpisah (rokok
  bungkus/ketengan) + multi-satuan tetap dipertahankan.
- **Akses dari luar LAN (Tailscale/tunnel)** (4.13) — tidak perlu (19 Okt
  2026); tetap self-hosted LAN.

---

## 5. Sumber riset (2026-10-01)

- Aronium — fitur inti & plugin + release notes:
  <https://www.aronium.com/en/features>, <https://www.aronium.com/en/download>,
  <https://www.aronium.com/en/release-notes>
- Kasir Pintar — tabel perbandingan Free vs Pro (di-fetch langsung):
  <https://kasirpintar.co.id/> (+ halaman fitur, plugin Business Account)
- Tren POS 2026: panduan pembeli szzcs.com (2026-06), foliopos.com
  (2026-05), ezeelink.co.id (2026-08), atureen.com (2026-08),
  founderplus.id perbandingan harga (2026-07), Deliverect (tren resto),
  freekasir.com (offline-first & PWA Indonesia)
- Pemetaan gap: verifikasi grep/read terhadap repo ini sendiri
  (schema.sql, index.ts, pos.ts, shifts.ts, history.ts, settings.ts)
