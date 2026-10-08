# TODO — Ravaa POS v2

Checklist hidup. Coretan saat selesai. Sumber riset & prioritas di bawah.

## Backlog — hasil riset UI/UX POS (2026-10-04)

Referensi: KulaPOS/NgertiKode (video YouTube `mVE7zPq2VXk` 48 menit — transkrip
`/tmp/opencode/kulapos-transcript.txt`, frame `/tmp/opencode/kp/`; 12 screenshot
galeri `ngertikode.id` → `/tmp/opencode/kula-*.png` — catatan: file /tmp bisa
terhapus, bukti utama sudah diekstrak ke laporan chat 2026-10-04).

- [x] 2026-10-04 **P1 — Uang diterima auto-isi = Total** — selama kasir belum
      menyentuh kolom (`cashTouched`), nilai ikut total tiap keranjang/diskon/
      metode berubah; input manual dihormati, barrier `pay()` tetap pengaman.
      Test: kolom auto-isi Rp4.000 + barrier dijalankan setelah kolom
      dikosongkan (`e2e-struk.mjs` 83 asersi).
      **⚠ DICABUT putaran 10d (2026-10-05)**: pemilik memutuskan kolom harus
      default 0 — lihat Catatan 2026-10-05 putaran 10d di bawah.
- [x] 2026-10-04 **P2 — Teks konteks Kembalian** — `teksKembalian()` di
      `pos.ts`: "Kurang Rp…" (merah) / "Uang pas. Tidak ada kembalian."
      (hijau) di baris `#pos-change-ctx` bawah angka KEMBALIAN.
- [x] 2026-10-04 **P3 — Label shortcut `<kbd>`** — helper `kbd()` + label
      Cari `F3`, Qty `F4`, Bersihkan `F5`, Diskon `F6` pada tombolnya, plus
      pintasan baru **F5** (kosongkan keranjang — sekalian memperbaiki kolom
      diskon yang tidak ikut dikosongkan) dan **F6** (fokus kolom diskon) di
      `bindPintasan()`, preventDefault F5/F6 agar Chrome tidak reload/find.
- [x] **P4 dirombak pemilik 2026-10-06: tampilan grid TIDAK diperlukan**
      (*"P4 tidak perlu tampilan grid"*). Yang diminta sebagai gantinya:
      **layout mobile sendiri + tombol perpindah mode** (*"untuk mobile
      nanti buat layout sendiri … tambahkan layout untuk berpindah ke mode
      mobile saja"*) — dikerjakan sebagai **Tahap 5** (lihat entri
      "Layout mobile + tombol pindah mode").
- [x] **P5 — Tahan/pending transaksi** — SELESAI 2026-10-04: snapshot keranjang
      (`Hold` = items/diskon/pelanggan/waktu/kasir) ke **IndexedDB per device**
      (`getHolds()`/`saveHolds()` di `store.ts`, kv key `'holds'` — tanpa
      endpoint baru), tombol **Tahan** + **Pending (n)** (badge
      `#pos-hold-count`) di section **Aksi cepat** sidebar POS, modal daftar
      **[Lanjutkan] [Hapus]** (konfirmasi swal; Lanjutkan validasi pelanggan
      ke master + dorong `manualSeq`), persisten setelah reload. Uji
      `uji-hold.mjs` 23/23 + `npm test` 837 hijau.
- ❌ **P6 — Biaya tambahan / voucher: DITOLAK PERMANEN** (keputusan pemilik
      2026-10-06: *"pajak dan voucher di app ini tidak pernah terpakai jadi
      saya tidak memerlukan fitur itu"*) — jangan diusulkan lagi, kontrak
      `POST /api/sales` TIDAK disentuh untuk ini; kompromi praktis tetap
      Item manual Rp500. Pajak PPN/service charge (dulu "skip dulu") ikut
      ditutup dengan alasan sama.

Tidak diusulkan (alasan tercatat di laporan riset): multi-tata-letak/tema picker,
member/poin.
**Catatan 2026-10-04 (putaran 5–6)**: dua yang dulu "tidak diusulkan" justru
diminta pemilik dan kini ADA — **piutang saat bayar POS** (uang kurang ->
hutang, syarat pelanggan bukan "Pelanggan Umum") dan **payment modal**
(form bayar terpusat ala Aronium F10); daftar di atas dicabut untuk keduanya.

**Catatan 2026-10-04 (putaran 7)**: tiga fitur kecil permintaan pemilik &
user (saat akhir session):
- ✅ **Chip `<kbd>F6</kbd>` di label diskon transaksi dihapus** — F6 label ada
  hanya di tombol "Diskon F6" grid Aksi cepat; `cartGridHtml` / `paintFormBayar`
  comment diperbarui; screenshot verifikasi.
- ✅ **Baris Subtotal sidebar dihapus** ("ini juga hapus saja") — ringkasan
  sidebar kini hanya Diskon item; `const sub`/`const tot` di `cartGridHtml`
  dihapus; `set('#pos-subtotal')` dihapus.
- ✅ **Tombol Item manual ganda di scan bar dihapus** — tetap ada hanya di
  Aksi cepat `#pos-qa-manual` ("sudah ada pada deretan tombol panel kanan");
  listener `#pos-manual` dihapus.
- ✅ **Layar cari pelanggan ala F3** — `#pos-cust-cari` button di info bar →
  `openCariPelanggan()` (pola identik `openCariProduk()`): input multi-kata
  filter nama/HP/nomor urut/catatan, ↑↓ sorot, Enter/**Pilih**/klik = pilih
  + set `#pos-customer` value + kembali fokus scan. Cust type extend phone/note.
- ✅ **Shortcut F1/F8 (fokus scan)** — **F1** = referensi KulaPOS
  *"Jumlah Beli * Kode [F1/Cmd+K]"*, **F8** = alias jalan pendek satu tekan;
  placeholder Kolom Scan + title tooltip F1/F8/Esc diupdate.
- ✅ **Shortcut F9 (cari pelanggan)** — tombol `#pos-cust-cari` + title
  "Cari pelanggan (F9)" + hint `<kbd>F9</kbd>` di input modal cari pelanggan.
- ✅ **`<kbd>` hint di modal cari produk** — tambah `<kbd>F3</kbd>` di
  modal `openCariProduk()` (samping input search).
- ✅ Docs: AGENTS §2 (info bar + sidebar ringkasan + scan bar), README
  (info bar + sidebar + Aksi cepat + Layar cari pelanggan bullet + shortcut
  F1/F8/F9), SKILL, pos.ts komentar, TODO catatan ini.
- ✅ Tests: `e2e-struk.mjs` section K (6 asersi baru: Subtotal/Manual/Cari
  modal/filter/Enter select/no-match message) → 99 + 6 = **105**, run.mjs
  ekspek diupdate; **npm test total 883 assertion SEMUA HIJAU**.
- ✅ **Bug fix bonus**: `skipable()` di `pos-qtykode-test.mjs` memanggil
  async callback tanpa await (race: note-click paralel dengan fill search
  dropdown); fixed async + await, test kembali hijau 24/24.

**Catatan 2026-10-04 (putaran 8)**: revisi layout tabel + info bar permintaan
pemilik (dari screenshot KulaPOS `kula-02-transaksi-pos.png`):
- ✅ **Lebar kolom tabel keranjang** — "kolom Nama barang kurang panjang, No,
  Kode, Harga, qty, diskon, subtotal dan aksi kurang kecil": lebar `<th>`
  eksplisit (No `w-10`, Kode `w-24`, **Nama barang `w-auto`** menyerap sisa,
  Harga/Diskon/Subtotal `w-24`, Qty `w-32`, Aksi `w-14`).
- ✅ **Badge `<kbd>F1</kbd>` di kolom scan** — penanda shortcut fokus scan di
  ujung kanan input `#pos-q` (`pr-14` + span absolut; referensi KulaPOS
  `[F1/Cmd+K]`), ikut di commit `0d2406d`.
- ✅ **Hover per baris tabel KEBIRUAN** — `hover:bg-primary-soft
  dark:hover:bg-primary/15 transition-colors` di tiap `<tr data-key>`
  (putaran 8c *"hover di tabel keranjang ubah jadi kebiru-biruan"* — token
  `--color-primary-soft #e6f3ff` konsisten dengan state aktif tombol; riwayat
  `gray-50` (terlalu tipis) → `gray-100` → `primary-soft`).
- ✅ **Input Qty diperbesar** — `!w-16` → `!w-20` + `font-semibold`
  ("pada baris 1 perbesar Qty input").
- ✅ **Tombol cari pelanggan INLINE kompak** — `#pos-cust-cari` tetap
  sebaris dengan select (revisi 8b: "tombol dan dropdown customer tidak
  inline" — sempat salah paham dipindah ke baris label), tapi teks "Cari"
  dibuang: tinggal ikon search + label *F9* polos ("cukup pakai text label
  yang F9 dan ganti logo kuncinya dengan search … space select jadi lebih
  besar"); select `min-w-0 flex-1`.
- ✅ **Bayar pas F12 = gradasi + shadow + hover hijau gelap** (gaya akhir 8c) —
  permintaan awal "pakai outline saja" menghasilkan tombol TANPA warna
  karena class **`btn-outline` tidak ada di `styles.css` (no-op)** —
  pemilik: "style hilang yang tombol warna hijaunya"; ganti jadi
  `bg-linear-to-r from-emerald-500 to-emerald-600 shadow-md
  shadow-emerald-600/40 hover:from-emerald-600 hover:to-emerald-700` —
  *"warna buat modern, gradasi dan ada shadownya"* (hover sempat dibuat
  kebiruan 8b, lalu 8c dibatalkan: *"hover tombol F12 juga ubah ke hijau
  jangan biru, karena tombolnya warna hijau"*).
- ✅ **Petunjuk `F2 bayar cepat` dihapus** dari baris `<p>` bawah dua tombol
  bayar (kini hanya `F10 form bayar · F12 bayar pas`).
- ✅ **Bug bonus: `.btn-outline` + `.btn-sm` akhirnya DIDEFINISIKAN** di
  `styles.css` — dua class ini dipakai halaman Sistem (kartu Backup:
  `#set-backup` + tombol Unduh) tapi tidak pernah ada, jadi selama ini tampil
  polos tanpa border (jebakan sama dengan pay-pas). Daftar komponen SKILL
  frontend-pos dikoreksi (`.btn-danger`/`.btn-lg`/`.btn-outline-secondary`
  ternyata juga tidak ada — dihapus dari daftar, diganti catatan "jangan
  pakai class tak terdefinisi = no-op tanpa error").
- ✅ Tests: **npm test 884 assertion SEMUA HIJAU** (tidak ada asersi berubah);
  tsc + build lolos; screenshot verifikasi `/tmp/opencode/putaran8b-*.png`
  (inline F9, gradasi hijau, hover baris, lebar kolom — Nama barang 438px).

**Catatan 2026-10-05 (putaran 9/9b — modal Pending)**:
- ✅ **Putaran 9: modal Pending jadi 2 kolom** — *"ke modal pending, buat 2
  kolom, kiri daftar antrian, kanannya preview barang apa saja yang di
  pending"*: `bukaTertahan()` dirombak jadi grid dua kolom (`wide`),
  KIRI `#hold-list` (klik kartu = pilih) ‖ KANAN `#hold-preview`, plus
  **tinggi fix 60% layar + scroll** (*"previewnya memiliki tinggi fix, misal
  60% dari screen atau 80%, dan buat scrollable jika barang ada banyak"* —
  60vh dipilih supaya header+footer modal `max-h-[90vh]` tetap muat). Test
  `pos-qtykode-test.mjs` +2 asersi (preview + tinggi → 26), run.mjs ekspek
  total 886.
- ✅ **Putaran 9b: layout dirapikan ala Ravaa POS v1** — *"sebagai referensi
  lihat layout di ravaa POS versi 1 ini … coba di terapkan pada modal
  pending di ravaaPOS v2"*. Referensi: `src/RPOS/.../partials/hold-modal.blade.php`
  + `.modal-split`/`.split-header`/`.split-item` di `pos-system.css` +
  `showHoldDetail()` di `assets/js/pos/index.js`. Yang diterapkan: proporsi
  **30/70** (`grid-cols-[3fr_7fr]` — modal `wider` ≈ modal-lg 900px v1),
  split-header bar **"DAFTAR ANTRIAN (n)"**, kartu antrian gaya
  `.split-item` (hover `blue-50`, **aktif = bg primer SOLID + teks putih +
  shadow**, menggantikan bg-soft), panel kanan persis struktur `detailHtml`
  v1: header-info **Pelanggan | Waktu simpan** (garis dashed) → **Daftar
  Produk (N item)** kartu abu-abu (SKU · qty × harga, netto primer) → kotak
  ringkasan **Subtotal/Diskon/Total** (dashed, Total primer `text-xl`) →
  **dua tombol [Hapus outline] [Lanjutkan primer] di bawah detail** (bukan
  per kartu — listener pindah dari `#hold-list` ke `api.el`). Urutan kolom
  TETAP kiri-antrian / kanan-detail (v1 menaruh daftar di kanan 30% — kita
  mirror sisanya, sesuai instruksi putaran 9). Test §C3: cek label lama
  "Preview barang" diganti split-header "Daftar antrian" (jumlah asersi
  tetap 26). **npm test 886 assertion SEMUA HIJAU** (run pertama hijau
  penuh dengan modal baru) + tsc/build lolos; screenshot verifikasi
  `/tmp/opencode/putaran9b-*.png` — computed: kolom 301/703px (30/70),
  preview 540px = 0.60 × 900, `overflowY: auto`, kartu aktif
   `rgb(0,135,255)` + `rgb(255,255,255)`, aksi `[data-hold-act]` HANYA di
   detail.

**Catatan 2026-10-05 (putaran 10 — modal bayar ala v1)**:
- ✅ **Modal bayar dirombak 2 panel ala Ravaa POS v1** — permintaan pemilik:
  *"modal bayar silakan dengan referensi ravaapos v1 di directory tadi,
  pendekatan yang sama, tanpa mengurangi kecepatan dalam transaksi, mungkin
  layout bisa di benahi pada v2 ini"*. Referensi
  `src/RPOS/.../partials/payment-modal.blade.php` + `.payment-layout-wrapper`
  (flex `5fr 7fr`) di `pos-system.css`. Yang diterapkan: `formBayarHtml()`
  → grid **`sm:grid-cols-[5fr_7fr]`** (proporsi terukur **312/436px**) +
  `bukaBayar()` pakai opsi **`wide`** (768px — `max-w-lg` lama terlalu
  sempit untuk dua panel). KIRI: kartu **Total tagihan** border-2 primer
  (`#bayar-total` angka 3xl extra-bold) → kotak **Pelanggan `#bayar-cust`**
  (ikon users, "Pelanggan Umum · CUS-000001" — penanda alur hutang) →
  **kartu metode `data-pay` grid 2 kolom** gaya `.btn-method-card` (ikon
  wallet/qr/sync; **ikon `qr` BARU di `icons.ts`** — set v2 tak punya ikon
  QR; aktif = `!border-primary bg-primary-soft !text-primary
  dark:bg-primary/15`) → hint pintasan. KANAN `bg-gray-50`: **Uang
  diterima** input `#pos-cash` `text-2xl`/700 prefix Rp + **tombol ×
  `#bayar-clear`** (ala `btn-clear-huge` v1: kosongkan + `cashTouched` +
  fokus balik) → chip `data-cash` grid 2 kolom (Uang pas/50k/100k/200k) →
  **kotak KEMBALIAN putus-putus** ala `.payment-section-result` (label
  statis + `#pos-change` lewat helper baru **`kelasPosChange()`** =
  `text-2xl font-extrabold tabular-nums` + `kelasKembalian()` — satu sumber
  untuk render awal & `paintCart()`, ukuran/warna tidak terpecah) →
  petunjuk hutang; `#bayar-non-tunai` untuk QRIS/Transfer. Blok
  tunai/non-tunai dirender SEKALIGUS + ditoggle `hidden`
  (`paintFormBayar()` — toggle 4 kelas kartu WAJIB sama persis dengan
  render awal), jadi `bindFormBayar()` tetap satu kali pasang.
- ✅ **Kecepatan transaksi TIDAK dikurangi** (syarat pemilik): auto-isi P1
  (`isiUangOtomatis()` sebelum HTML) *(fitur ini kemudian DICABUT di putaran
  10d 2026-10-05 — lihat Catatan 10d)*, fokus `#pos-cash` saat buka,
  Enter-on-input → `ok.click()` → `pay()`, F2/F10/F12, plus perilaku BARU:
  **klik chip → fokus balik ke kolom uang** (kasir tinggal Enter — sebelumnya
  fokus tertinggal di chip) dan **tombol ×** untuk salah ketik. Semua id
  lama TANPA perubahan (`#pos-cash`, `#pos-pay` OK footer, `data-pay`,
  `data-cash`, `#pos-change`, `#pos-change-ctx`, `#bayar-tunai`,
  `#bayar-non-tunai`) — `#pos-pay-pas` sengaja tetap di side panel.
- ✅ Tests: `e2e-struk.mjs` **106 → 108 asersi** (section form bayar + cek
  layout 2-panel `layoutBayar{kolom===2,totalDiKiri===0,uangDiKanan===1,
  kartuMetode===3,pelanggan}` + fokus `pos-cash` setelah klik chip),
  `run.mjs` ekspek menyesuaikan → **`npm test` 888 assertion SEMUA HIJAU**
  (run pertama hijau dengan modal bayar baru); tsc + build lolos.
  Screenshot verifikasi `/tmp/opencode/putaran10-*.png` (bayar awal, chip
  100k → kembalian Rp86.000, QRIS → blok bertukar, closeup 768px).
  **Catatan alat**: Read tool sesi ini sempat menyajikan media basi/salah
  (membaca `putaran10-bayar.png` memperlihatkan konten modal Pending;
  closeup 768px ditampilkan sebagai halaman penuh) — diverifikasi ulang via
  md5 + `file` (dimensi) + sampel piksel PIL (Tunai aktif `(166,213,255)`,
  bg kanan gray-50 `(249,250,251)`); bukan bug aplikasi.

**Catatan 2026-10-05 (putaran 10b — tombol + uang diterima ~2x)**:
- ✅ *"kurang besar untuk tombol-tombol dan uang diterima pada modal, silakan
  atur untuk lebih besar sekitar 2x lipat"* — semua kontrol dalam modal
  bayar diperbesar ~2x (baseline diukur Playwright, **ingat `@theme` repo:
  `--text-2xl`=20px, `--text-sm`=13px** — angka Tailwind default tidak
  berlaku):

  | kontrol | sebelum | sesudah | rasio |
  |---|---|---|---|
  | kartu metode `data-pay` | 34px / 13px | **78px / 24px** | 2.3x / 1.85x |
  | chip `data-cash` | 25px / 11px | **51px / 22px** | 2.0x / 2.0x |
  | `#pos-cash` | 41px / 20px | **91px / 40px** | 2.2x / 2.0x |
  | tombol × `#bayar-clear` | 28px | **56px** | 2.0x |
  | footer Batal/Bayar | 34px / 13px | **68px / 24px** | 2.0x / 1.85x |

- ✅ Keputusan: **kartu metode pindah ke layout KOLOM** (ikon atas, label
  bawah, center) persis gaya `.btn-method-card` v1 — label horizontal
  `Transfer` @24px = ±98px + ikon + padding meluber dari kolom 137px
  (lebar panel kiri 5/7); `border-2` ala v1. Prefix `Rp` ikut 24px/800 ala
  `.payment-input-huge` v1; `!pr-[76px]` menjaga angka (text-right) berhenti
  12px sebelum tombol ×. Footer diperbesar lewat `classList` di
  `bukaBayar()` `onMount` — modal lain (pending/cari/konfirmasi) TIDAK ikut
  membesar. `#pos-pay-pas` (side panel) di luar permintaan, tidak diubah.
- ✅ **Jebakan Tailwind tercatat**: `!text-[22px]` yang menempel `${`
  tanpa spasi TIDAK di-generate oleh scanner Tailwind v4 (kekurangan
  pembatas → token dibuang) — chip awalnya naik tingginya tapi font tetap
  11px; diperbaiki dengan spasi eksplisit sebelum interpolasi. Pola ini
  berlaku untuk SEMUA class arbitrary di template literal.
- ✅ Verifikasi: label semua muat (`Transfer` 98≤135), chip `scrollWidth ==
  clientWidth`, tidak ada kotak tumpang tindih, angka tak tertimpa tombol ×,
  modal 546px < 90vh (tanpa scroll), glyph angka 29px PIL = cap-height font
  40px. `npm test` **888 assertion SEMUA HIJAU** (tanpa asersi berubah —
  suite hanya mem-check struktur/interaksi, bukan piksel), tsc + build lolos.
  Screenshot: `/tmp/opencode/putaran10b-*.png` (Read tool sesi ini
  menyajikan media basi — verifikasi ukuran via Playwright evaluate + PIL).

**Catatan 2026-10-05 (putaran 10c — revisi ukuran modal bayar)**:
- ✅ Instruksi pemilik: *"Jangan ada uang pas, karena sudah ada tombol F12
  untuk uang pas, ganti 20.000, tapi tombol uang itu kecilkan 1xnya,
  kembalian kurang besar seukuran uang diterima, total tagihan di besarkan
  setengahnya"* — 5 perubahan:
  1. **Chip "Uang pas" DIHAPUS** dari modal bayar; `QUICK_CASH` kini
     `[20000, 50000, 100000, 200000]` — `#pos-pay-pas` (F12, side panel)
     TIDAK tersentuh, justru jadi alasannya. Semua cabang `raw === 'pas'`
     dibersihkan (`bindFormBayar`, `paintCart`, template).
  2. **Chip uang kembali ukuran normal 1x** (pembesaran 10b dibatalkan
     khusus chip): 51px/22px → **25px/11px** (baseline awal).
  3. **Kembalian `#pos-change` font 20px → 40px** = persis seukuran
     `#pos-cash` (*"seukuran uang diterima"*) — lewat `kelasPosChange()`
     (satu sumber render awal + `paintCart`).
  4. **Total tagihan `#bayar-total` 24px → 36px** (*"di besarkan
     setengahnya"* = +50%).
  5. Toast barrier "tekan 'Uang pas'" → "tekan Bayar pas (F12)" (ujian
     test tetap `includes('Uang diterima belum diisi')`).
- ✅ Test `e2e-struk.mjs`: skenario chip pas diganti **chip 20.000 +
  ketik manual 4000 → kembalian Rp0**; label ok "(Uang pas + 3 pecahan)"
  → "(4 pecahan: 20rb-200rb)". **Jumlah asersi TIDAK berubah (108)** →
  run.mjs tidak disentuh; **`npm test` 888 assertion SEMUA HIJAU** + tsc +
  build lolos. Verifikasi terukur: chips `["Rp20.000","Rp50.000",
  "Rp100.000","Rp200.000"]`, `adaPas:false`, `#pos-change` 40px (sama
  dgn `#pos-cash`), `#bayar-total` 36px, kartu metode 78px & footer 68px
  (10b) tetap; chip100k → kembalian Rp86.000 + tersorot.

**Catatan 2026-10-05 (putaran 10d — chip lebih besar + auto-isi dicabut)**:
- ✅ Instruksi pemilik: *"tombol nominalnya terlalu kecil kalau sekarang,
  form uang di terima jangan langsung di isi uang pas, karena tujuannya
  adalah untuk memasukkan nilai uang kurang atau uang lebih jadi default 0
  dan auto focus sudah OK"* — 2 perubahan:
  1. **Chip pecahan diperbesar** 25px/11px (1x putaran 10c) → **44px/17px**
     (`!min-h-[44px] !px-4 !py-2 !text-[17px]` — di antara 1x dan 2x 10b,
     biar tidak bolak-balik ke ekstrem). Kartu metode/footer/input tidak
     tersentuh.
  2. **Auto-isi "uang pas" (P1) DIHAPUS** — **fitur P1 (2026-10-04) resmi
     dicabut** setelah 1 hari: `isiUangOtomatis()` + 3 pemanggilnya
     (`bukaBayar`, `paint`, `paintCart`) dibuang; `bukaBayar()` kini
     `cashIn=0; cashTouched=false` sehingga kolom **selalu terbuka kosong**
     (placeholder tetap total ala Aronium). Alasan pemilik: kolom itu untuk
     memasukkan uang KURANG/LEBIH sesungguhnya — prefill "pas" menyembunyikan
     niat kasir. **Fokus `#pos-cash` saat buka TIDAK berubah** ("auto focus
     sudah OK"); "uang pas" = F12 `#pos-pay-pas` / klik chip. `cashTouched`
     dipertahankan sebagai penanda sentuhan (guard sinkronisasi paintCart +
     reset ganti metode); `bayarPas()` tetap set `cashIn=total()`.
- ✅ Test `e2e-struk.mjs`: asersi "uang diterima auto-isi = total (P1)" →
  **"uang diterima default KOSONG (tanpa auto-isi — putaran 10d)"**;
  komentar barrier disesuaikan (fill('') = langkah eksplisit). Semua `jual()`
  memang mengisi uang sendiri → **jumlah asersi TIDAK berubah (108)**;
  **`npm test` 888 assertion SEMUA HIJAU** + tsc + build lolos. Verifikasi
  terukur (Playwright): buka form → `value=""`, `fokus=pos-cash`,
  chip `202x44px font=17px`; isi 10.000 dari total 14.000 → ctx
  **"Kurang Rp4.000"** (alur uang kurang jalan); kartu metode 78px,
  `#pos-cash` 91px/40px, `#pos-change` 40px, `#bayar-total` 36px,
  footer 68px (10b/10c) tetap; `#pos-pay-pas` side panel 294×55 tak
  tersentuh.

**Catatan 2026-10-05 (putaran 11 — modal resume pasca-bayar)**:
- ✅ Instruksi pemilik: *"Setelah bayar tambahkan modal resume, dan pilihan
  print thermal atau A4, begitu juga pada bayar PAS F12"* — dengan klarifikasi
  **1A** (muncul setelah SETIAP bayar, semua jalur, tanpa peduli saklar
  auto-print; saklar hanya menentukan apakah tombol Thermal/A4 benar-benar
  mengirim ke printer) dan poin 2 (isi resume): pemilik biasanya cuma butuh
  **uang kembali**, tapi minta lihat saran dulu — *"jika tidak cocok nanti
  kita ubah"*. Saran yang diterapkan (judul hero TETAP `Kembalian RpX`
  ala revisi 2026-10-04):
  1. **Badan resume** (`htmlResumePenjualan()` di `pos.ts`, lewat opsi baru
     `html` di `choiceDialog`): **No. `invoice_no`** (huruf besar via CSS
     `uppercase`) → daftar item `qty × nama` + net per baris (**maks 5 baris**
     + "… +N item lainnya") → **Total** (bold) → baris `Tunai` (uang
     diterima) / label metode QRIS/Transfer (total) — pola baris rincian
     struk. Tombol **[Thermal] [A4] [Selesai]** + slot swal TIDAK berubah
     (`.swal2-confirm/.swal2-deny/.swal2-cancel`, `focusCancel` → fokus awal
     = **Selesai**, Enter = selesai tanpa cetak). Modal ±384×273px.
  2. **Guard dihapus**: `if (autoPrint) void pilihCetakSelesai(...)` →
     **dipanggil tanpa syarat** di `pay()` — F12 `bayarPas()` memang lewat
     `pay()` yang sama, jadi ikut serta tanpa cabang khusus. Snapshot resume
     (invoice/items/metode/uang) di-argumen-kan **SEBELUM** reset
     `cart`/`cashIn`.
  3. **Saklar = izin kirim printer**: Thermal/A4 saat saklar mati →
     `setStrukLayout` tetap jalan (pref tersimpan) + **toast "Cetak sedang
     mati…"** (diam-diam no-op dahulu). **A4 kena guard BARU** — selama ini
     `cetakInvoice()` mem-bypass saklar; kini konsisten. Topup/tarik tetap
     **TANPA dialog** (keputusan lama) dan tetap memakai saklar.
  4. **Test** `e2e-struk.mjs` **108 → 110 asersi** (update
     `tests/run.mjs`): helper `jual()` kini **SELALU** membaca isi dialog
     `{judul, isi}` lalu menutupnya (`pilihan=null` → klik Selesai — tanpa
     ini section B dengan saklar mati memblokir suite lewat backdrop swal);
     +1 "modal resume memuat judul Kembalian + No. nota + item + Tunai"
     (regex `i` — `text-transform: uppercase` membuat `innerText` jadi
     `NO. …`, jebakan pertama suite), +1 "modal resume TETAP muncul walau
     saklar cetak mati (1A)". Komentar helper `pilihCetak` diperbarui.
     **`npm test` 890 assertion SEMUA HIJAU** + `tsc --noEmit` + build lolos.
  5. **Verifikasi Playwright** (`/tmp/opencode/verif11.mjs`): (a) bayar biasa
     → judul `Kembalian Rp8.000`, isi `NO. 261005-000013 3 × Aqua 600ml
     Rp12.000 Total Rp12.000 Tunai Rp20.000`; (b) **F12 Bayar pas** →
     `Pembayaran berhasil` + resume lengkap (tunai = total, kembalian 0);
     (c) saklar OFF → resume tetap muncul + klik Thermal → **toast "Cetak
     sedang mati" = true**; (d) `elementFromPoint` pusat popup = `POPUP`
     (tidak tertutup overlay), element-screenshot `verif11-final-popup.png`
     = bukti visual desain. **Catatan alat**: `page.screenshot()` full-page
     Chrome headless sesi ini kadang menangkap frame basi (jam/toast tertinggal
     menitan — sebangun dengan media basi Read tool); kebenaran diambil dari
     evaluate DOM + locator screenshot, bukan screenshot full-page.
- ✅ **Putaran 11b — judul hero kembalian 48px** (2026-10-05, permintaan
  pemilik: *"kembalian kurang besar, agar kasir mudah melihat kembalian"*):
  judul swal resume kini **HTML dua baris** — label `KEMBALIAN` 11px
  uppercase + **angka `text-[48px] font-extrabold`** (skala sama dengan
  TOTAL BELANJA info bar, revisi 2026-10-04). Fakta teknis: sweetalert2
  merender param `title` sebagai **HTML** (`parseHtmlToContainer`, baris
  1898 dist — `titleText` baru innerText) jadi span Tailwind sah tanpa
  menyentuh CSS swal compact (judul lain tetap 13px); `textContent` judul
  tetap `"Kembalian Rp8.000"` (spasi antar-span dipertahankan) → test
  e2e-struk regex `/Kembalian/` aman. Kembalian 0 (bayar pas) tetap judul
  polos "Pembayaran berhasil". Terukur Playwright: angka 48px/800, popup
  384×330 (dari 274 — bukti byte PNG juga, mengingat media Read tool basi).
- ✅ **Putaran 11c — Esc tutup modal resume + fokus ke scan** (2026-10-05,
  permintaan pemilik: *"jika di esc langsung close untuk mempercepat
  transaksi selanjutnya"*):
  1. **Bug reproduksi dulu** (`/tmp/opencode/esc-test.mjs`): setelah dialog
     terbuka fokus = `INPUT#pos-q` (baris terakhir blok sukses `pay()`
     memfokus scan) → tekan Esc → **`popupAda: true`** (TIDAK tertutup).
     Akar: listener keydown bawaan sweetalert2 menempel di **popup element**
     (`target = keydownListenerCapture ? window : getPopup()`), jadi event
     dari kolom scan tidak pernah sampai.
  2. **Fix**: `choiceDialog` mendapat 2 opsi opsional baru —
     **`keydownListenerCapture: true`** (listener pindah ke window capture)
     + **`returnFocus: false`** (returnFocus swal nanti tidak menimpa
     focusScan) — keduanya hanya dipakai modal resume; caller lama
     (history.ts reprint, confirmDialog) tak tersentuh. Setelah
     `await choiceDialog(...)` → **`focusScan()`** — semua jalur tutup
     (Esc/Selesai/Thermal/A4) berakhir di kolom scan.
  3. **Test**: helper `jual()` mendapat `pilihan:'Escape'` (tekan Esc, tanpa
     klik) — section B kini memakainya + **+2 asersi** ("Esc MENUTUP modal
     resume", "fokus kembali ke kolom scan"); `run.mjs` 110 → **112**.
     Hasil: **`npm test` 892 assertion SEMUA HIJAU** + tsc + build; esc-test
     ulang → `popupAda: false`, `fokus: INPUT#pos-q`. (Catatan: satu run
     `npm test` sempat gagal transient tepat setelah build — suite berjalan
     sendiri 110/110 dan run ulang penuh hijau 890 → 892; flake, bukan regresi.)
- ✅ **Riset KulaPOS (2026-10-06) — butir 1: subtitle + jam di resume**
  (pemilik: "ok 1 dulu"): `htmlResumePenjualan()` kini diawali **subjudul**
  "Transaksi tersimpan. Siap melayani pelanggan berikutnya." + baris no nota
  jadi **`No. <invoice> · HH:MM`** (jam lokal; tanggal sudah terkandung di
  `invoice_no` YYMMDD). Sumber riset: `~/tmp opencode/kulapos.mp4` + transcript
  segmen 37:47–42:00 + **95 frame ffmpeg** di `~/tmp opencode/kp/` (popup
  bayar: tab Tunai/Digital/Piutang, chip Uang Pas, Kembalian + konteks;
  sukses modal: subtitle + no nota/jam + Metode/Diterima/Kembalian + Cetak/
  WhatsApp/Buka Laci + "Transaksi Baru [Space/Enter]"). Detail pembanding
  ada di ringkasan sesi — kandidat berikutnya: Buka Laci Kasir (ESC/POS drawer
  kick via print-agent), `Lihat Struk ›` pratinjau (tunda). Test: +2 asersi
  (subtitle, jam) → `e2e-struk` 114, **`npm test` 894 SEMUA HIJAU**.
- ✅ **Putaran 12 — piutang OTOMATIS: uang kurang / uang 0 → hutang**
  (instruksi pemilik 2026-10-06: "jika uang kurang / uang 0 akan otomatis
  masuk ke hutang dengan catatan harus terpilih customer"; menggantikan
  backlog 📌 di bawah ini):
  1. **`pay()` barrier** — pelanggan MEMENUHI syarat (`cekHutangDiperbolehkan()`
     = "") → `pay({hutang:true})` **langsung, tanpa `confirmDialog`** (dialog
     "Uang kurang — catat jadi hutang?" DIHAPUS). Pelanggan tidak memenuhi →
     penolakan barrier persis + **alasan ikut disisipkan** ke toast
     (`"Uang diterima belum diisi — <alasan cekHutang>"` /
     `"…kurang dari total RpX — <alasan>"` — prefix dipertahankan, test
     lama tetap cocok).
  2. **Resume** — `htmlResumePenjualan()` menerima `hutang?: number` →
     **baris `Hutang` merah** (font-semibold red-600) di bawah baris Tunai —
     pengganti fungsi informatif konfirmasi swal yang dihapus; struk & toast
     `· hutang RpX (nama)` sudah ada dari putaran 2026-10-04.
  3. **Hint form bayar** diperbarui: "Uang kurang / uang 0 **otomatis** jadi
     **hutang** — asal pelanggan terpilih bukan 'Pelanggan Umum'".
  4. **Test section J** dirombak: dialog konfirmasi DIHAPUS dari alur →
     (a) uang kurang+umum tetap ditolak; (b) uang kurang+valid → **langsung
     resume** (assert TIDAK ada judul dialog lama) + baris HUTANG Rp1.000;
     (c) **case baru uang 0** (kolom tak diisi) → resume Hutang Rp4.000 +
     nota cash_in 0 + ledger sisa Rp5.000 (2 charge); cleanup kini fetch
     ulang ledger (2 baris). `tungguCetak(10)` menambah 1 asersi bawaan →
     ekspek `e2e-struk` 114 → **118**; **`npm test` 898 SEMUA HIJAU** +
     tsc + build lolos. Docs: AGENTS §2+§3, README butir HUTANG.
- ✅ **Putaran 13 — penanda HUTANG di Riwayat transaksi** (instruksi pemilik
  2026-10-06: "riwayat transaksi tambahkan kalau itu hutang, beri tanda untuk
  mudah mencari yang transaksi hutang, dan juga langsung tercatat otomatis di
  halaman hutang"):
  1. **Server** — `GET /api/sales` (daftar) dan `GET /api/sales/:id` (rincian)
     menambah field computed **`sisa_hutang`**: `CASE WHEN pay_method='tunai'
     AND total > cash_in AND customer_id IS NOT NULL AND customer_name <>
     'Pelanggan Umum' THEN total - cash_in ELSE 0 END` — syaratnya PERSIS
     kondisi catat-hutang otomatis POS (putaran 12), dari snapshot nota (tanpa
     JOIN ledger — `customer_debts` tak punya FK ke `sales`). Maknanya =
     **kejadian berhutang saat nota**, bukan saldo live; saldo aktual tetap
     dari halaman Hutang. (`s.*` sudah ikut membawa `customer_id`/
     `customer_name`.)
  2. **Riwayat UI** (`history.ts`) — **chip merah `Hutang RpX`** di kolom Jenis
     (`chipHutang()`, gaya `!border-red-500/40` sama dengan halaman Hutang;
     title berisi pelanggan + nomor nota), **kotak merah Hutang** di kartu
     Pembayaran rincian + baris "Otomatis tercatat di halaman Hutang — Nota …",
     dan **chip filter `#h-hutang` "Hutang (n)"** di kepala() →
     `state.hutangOnly` menyaring linimasa client-side (topup/tarik ikut
     tersingkir; empty-state & caption khusus; sengaja bukan elemen `[data-h]`
     supaya tidak tertangkap handler geser tanggal).
  3. **Bukti poin-3 pemilik** (charge otomatis ke halaman Hutang) sudah jalan
     sejak putaran 12 — dipertegas di test: baris rincian menunjuk halaman
     Hutang, dan ledger-nya diuji section J (`2 charge`, sisa Rp5.000).
  4. **Test** — section J +1 asersi (`sisa_hutang` di daftar & `/:id` =
     Rp1.000/Rp4.000 + customer snapshot), **section L baru** (buka
     `#/history` → penanda per baris ≥2 → filter `#h-hutang` menyisakan hanya
     baris berhutang + caption "disaring" → rincian kotak Hutang + teks
     "halaman Hutang"). Ekspek `e2e-struk` 118 → **122**; **`npm test` 902
     SEMUA HIJAU** + tsc + build lolos. Docs: AGENTS §2 history.ts + §3
     `GET /api/sales` (field + butir `sisa_hutang`) + `GET /api/sales/:id`,
     README butir Riwayat.
- ✅ **Putaran 14 — HUTANG di invoice A4** (instruksi pemilik 2026-10-06:
  "pada invoice silakan sesuaikan tambahkan hutang jika pelanggan berhutang";
  rujukan komentar halaman Hutang soal tombol Bayar per baris):
  1. **Payment status jujur** — `Belum lunas` bila `sale.sisa_hutang > 0`
     (snapshot nota INI, field putaran 13), selain itu `Lunas` (dulu
     selalu "Lunas" — salah untuk nota uang kurang/0 putaran 12).
  2. **Baris `Hutang:` merah** di rincian Payment method invoice
     (setelah Paid amount, sebelum Change) memuat sisa nota — CSS
     `.bayar .baris.hutang` `#b91c1c`.
  3. **Baris kotak `Sisa hutang (semua nota)`** = ledger halaman Hutang
     pelanggan (`cetakInvoice()` kini ikut fetch
     `GET /api/customer-debts/:customerId` — hanya bila `customer_id` ada;
     gagal/absen -> 0 -> baris gugur, **cetak tidak dibatalkan**). Tampil
     bila > 0 DAN ≠ hutang nota (tanpa syarat itu nota lunas dengan piutang
     lama + nota berhutang sendiri jadi menampilkan angka sama dua kali).
     Mencakup kasus pelanggan berhutang dari nota lain saat mencetak ulang
     dari Riwayat.
  4. **Test section L** +3 asersi: charge ledger uji Rp7.000 (sengaja >
     Rp4.000 nota uji) → reprint A4 nota uji (buka baris per nomor invoice,
     toggle-safe) → assert `Belum lunas` + baris `Hutang:` + `Sisa hutang
     (semua nota) Rp7,000.00` + print-agent tidak ikut; charge dihapus lagi
     (bersih-bersih section J tetap 0). Ekspek `e2e-struk` 122 → **125**;
     **`npm test` 905 SEMUA HIJAU** + tsc + build lolos. Docs: AGENTS §2
     `invoice.ts`, README butir Pilihan A4.
- ✅ **Putaran 15 — Cetak A4 rincian hutang: ringkas tabel garis-bawah +
  striping semua tabel** (instruksi pemilik 2026-10-06: "bagian bawah Total
  dihutang Rp50.000 / Total dibayar Rp30.000 / Sisa hutang Rp20.000 ini dibuat
  garis tabel bawah saja jangan box seperti itu. dan setiap tabel buat
  striped termasuk tabel yang atas" — merujuk `htmlHutangA4` di `debts.ts`):
  1. **Ringkas bawah**: tiga `div.kotak` → **`<table class="ringkas">`**
     (label tebal kolom kiri, nilai `rp()` rata kanan) — tiap baris hanya
     **`border-bottom`** (baris terakhir #444 + tebal; TANPA garis
     samping/atas, `.kotak`/`.kotak.sisa` dihapus dari CSS dokumen).
  2. **Striped**: `tr:nth-child(even)` di **kedua** tabel —
     `table.ledger` (tabel atas) + `table.ringkas` — dengan
     `print-color-adjust: exact` di `body` supaya arsiran tetap tercetak
     walau opsi "Background graphics" dialog cetak mati.
  3. **Test** `customer-debt-test.mjs` section 11 (state §10 = pelanggan
     lunas, charge Rp50.000/bayar Rp50.000): stub `window.print` context-wide
     → klik **Cetak A4** (`.modal [data-ok]`, modal tidak auto-close) →
     popup: assert tabel 3 baris TANPA `kotak` + label/angka + kedua aturan
     striping + aturan garis bawah ada. Ekspek 33 → **35**;
     **`npm test` 907 SEMUA HIJAU** + tsc + build lolos. Docs: AGENTS §2
     `debts.ts`, README butir Cetak A4 (sekaligus perbaiki kalimat basi
     "POS tidak punya metode bayar piutang" — basi sejak putaran 12).
- Docs ikut: AGENTS §2 (deskripsi `pilihCetakSelesai` + kartu Cetak struk),
  README (judul butir "Modal resume + pilihan cetak" + kartu Sistem),
  `print-pref.ts` doc `getAutoPrint()`.
- ✅ **Putaran 16 — keranjang PERSISTEN: selamat dari refresh & pindah
  halaman** (instruksi pemilik 2026-10-06: *"produk yang berada di keranjang
  jika kasir pindah ke halaman dashboard atau tidak sengaja terrefresh
  barang tidak hilang/keranjang tidak kosong"* — dikerjakan lebih dulu
  sebelum bahas daftar Menyusul):
  1. **Penyimpanan: localStorage sinkron `ravaa.keranjang`** (`store.ts`
     `getKeranjang()`/`saveKeranjang()`) — **BUKAN** kv IndexedDB seperti
     holds. Kasus kanoniknya justru refresh kilat setelah mutasi; tulisan
     IndexedDB (open+tx async) terbukti empiris terbuang oleh `reload()`
     <16ms sehingga isi LAMA terbaca lagi saat mount (kebukti saat menulis
     test section H: clear + reload langsung → qty section G ter-marshal
     kembali → total barrier Rp38.000). Pola outbox `ravaa.outbox.v1`
     memakai localStorage karena alasan yang sama.
  2. **`simpanKeranjang()` (pos.ts)**: snapshot `{items, discount,
     customerId}` pada SETIAP titik mutasi — `addLine`/`setQty`/`setDisc`,
     input catatan, diskon transaksi, select pelanggan + pilih F9, item
     manual, `bersihkanKeranjang`, `muatHold`, `tahanKeranjang`, reset
     `pay()` sukses. Gagal = toast sekali-per-sesi, memori dipertahankan
     (pola `simpanTertahan`). Uang diterima/mode bayar TIDAK ikut (per
     pembayaran, bukan per sesi).
  3. **`muatKeranjang()` di `mountPosPage`** — HANYA saat `cart` memori
     kosong (navigasi hash tanpa reload mempertahankan memori; reset mentah
     `cart = []` dibuang dari mount). Setelah master customers dimuat:
     validasi id (pola `muatHold`), **buang baris tombstone** (pay akan 400
     "produk tidak dikenal"), **samakan harga non-dinamis** ke cache
     (dikunci server), clamp diskon baris + `clampDiskonTransaksi()`,
     dorong `manualSeq`, toast "Keranjang dipulihkan — N baris".
  4. **Test**: section M `e2e-struk.mjs` (8 asersi: baseline kosong, isi +
     reload → pulih baris/total/diskon/toast, nav dashboard↔POS utuh,
     Bersihkan persisten); **section H & J reload kini didahului
     `#pos-clear`** (cart sengaja penuh di sana — tujuannya sync master,
     bukan pemulihan; tanpa clear, restore menggandakan qty). Ekspek 125 →
     **133**; **`npm test` 915 SEMUA HIJAU** + tsc + build lolos. Docs:
     AGENTS §2 `store.ts` + `pos.ts`, README butir "Keranjang tahan
     refresh".

**Gap analysis KulaPOS vs Ravaa POS (2026-10-04)** — sumber: `kula-01..12*.png`
(khususnya `kula-02-transaksi-pos.png`, `kula-07-pos-kasir.png`) +
`kulapos-transcript.txt` segmen 35:00–41:00:

* **Sudah setara / selesai**: Pending-Tahan (P5) + pintasan F7, `Qty*Kode`,
  navigasi ↑↓ baris, Bersihkan F5, diskon faktur F6, pelanggan inline, strip
  stok/kadaluarsa, cetak struk otomatis, satuan jual, catatan per baris.
* **Menyusul (sudah tercatat)**: kandidat kecil di section Menyusul (kolom
  keranjang compact, rapikan sidebar, Cetak ulang nota terakhir, tutup shift
  dari POS, ganti satuan baris) + pengganti P4 = layout mobile (keputusan
  pemilik 2026-10-06). *Ditutup permanen 2026-10-06*: P4 grid (**tidak
  diperlukan**), P6 biaya tambahan/voucher + pajak PPN (**tidak pernah
  terpakai — jangan diusulkan lagi**), P7 customer display (**pemilik tidak
  punya display; PERINTAH: jangan masuk TODO, jangan dikerjakan**). *Dibersihkan 2026-10-06*:
  tiga kandidat lama — hapus duplikat Item manual, hapus baris Subtotal,
  cari pelanggan ala F3 — ternyata sudah dikerjakan putaran 7 (lihat
  Catatan putaran 7 di atas), jadi dihapus dari daftar; arah "hapus Item
  manual" pun berputar: putaran 7 membuang yang di scan bar dan
  mempertahankan yang di Aksi cepat (bukan sebaliknya).
* **Ditunda keputusan pemilik**: **pajak PPN 10% + service charge**
  ("D pajak skip dulu", 2026-10-04) — butuh kolom/setting baru dan menyentuh
  `POST /api/sales`, laporan, struk, invoice; harga baris bisa diedit kasir
  (bertabrakan dengan "harga non-dinamis dikunci server").
* **Belum pernah dibahas pemilik — login/akun kasir** (ditemukan 2026-10-06,
  transcript KulaPOS): KulaPOS punya halaman login + ganti password + role
  owner/kasir (segmen 00:08–01:03, 03:45, 11:33–12:45, 35:02+); Ravaa
  sengaja tanpa akun — `apps/web/src/ui/user.ts` mencatat "Belum ada
  akun/password … nama kasir hanya penanda perangkat, bukan login". Selaras
  skala 1–2 kasir (AGENTS §1) tapi belum ada keputusan eksplisit; tanyakan
  ke pemilik bila dianggap perlu (mis. PIN lindungi halaman Laporan dari
  kasir).
* **Di luar ruang lingkup toko ini** (dicatat, tidak dikerjakan): retur &
  garansi, pengeluaran (kas keluar), supplier/pembelian (PO), Kas In/Out,
  multi-cabang + transfer stok, payment gateway, notif struk WhatsApp,
  member/poin.

## Selesai (ringkas)

- [x] 2026-10-04 **Form bayar (modal) + Bayar pas di side panel + uang
      kurang = HUTANG** (permintaan pemilik putaran 5–6: "pindahkan ke modal
      ketika klik bayar" lalu "bayar uang pas letakkan di sidepanel bawahnya
      Bayar F10 … kalau uang kurang jadi Hutang dengan catatan harus ada
      customer yang terpilih dan tidak boleh customer default/umum"):
      * **Side panel** kini hanya berisi **Bayar F10** (`#pos-bayar`, buka
        form) dan **tepat di bawahnya Bayar pas hijau F12** (`#pos-pay-pas`)
        — sekali ketuk, tanpa modal.
      * **Form bayar = modal** (`bukaBayar()`/`formBayarHtml()`): total
        tagihan, metode `data-pay`, `#pos-cash` + chip `data-cash`,
        kembalian, petunjuk hutang; **OK modal = `#pos-pay`** (Enter/F2/F10
        satu aksi). Isian lama dipindah utuh — id & selector tidak berubah.
      * **Uang kurang -> hutang**: `pay()` menawarkan `confirmDialog`
        bila `cekHutangDiperbolehkan()` lolos (ada pelanggan terpilih, bukan
        "Pelanggan Umum"/`CUS-000001`) -> `pay({hutang:true})` melewati
        barrier -> penjualan + `POST /api/customer-debts` `type=charge`,
        `note: 'Nota <invoice_no> — sisa bayar POS'`; gagal ledger = nota
        tetap sukses + toast penunjuk halaman Hutang. Tidak lolos syarat =
        penolakan barrier lama **persis** (pesan + fokus kolom uang) —
        teruji barrier lama di section F tetap hijau.
      * Struk memuat baris **Hutang** bila sisa > 0; **guard pintasan swal**
        (dialog konfirmasi cetak/hutang menahan F-key, sebab `.modal-overlay`
        bisa menemukan form bayar di bawah swal — tanpa ini F12 membayar
        lewat belakang konfirmasi).
      * Pintasan baru **F8** (fokus kolom scan), **F10** (buka form bayar),
        **F12** (bayar pas) — rujukan help.aronium.com.
      * Test: `tests/e2e-struk.mjs` **83 -> 99 asersi** (section J baru:
        posisi Bayar pas, bayar tanpa form, penolakan pelanggan Umum,
        dialog konfirmasi, ledger charge = sisa, nota invoice, bersih-bersih)
        + `tests/e2e-multisatuan.mjs` menyesuaikan alur form; total suite
        **877 assertion SEMUA HIJAU** (`tests/run.mjs` ekspek 83 -> 99);
        tsc + `npm run build -w apps/web` lolos. Docs: AGENTS §2 + §3
        (customer-debts punya pelanggan kedua = POS), README, skill
        `frontend-pos` pola #8/#9, header pos.ts.
      * **Catatan DB dev**: pelanggan uji `UjiHutang POS E2E` tidak bisa
        dihapus (FK `sales.customer_id`) — dipakai ulang tiap run, ledger
        dibersihkan tiap run.

- [x] 2026-10-04 **Input cepat ala KulaPOS: `Qty*Kode`, navigasi ↑↓ baris,
      pintasan F7 Tahan** (hasil gap analysis, blok C) — `bacaQtyKode()`
      memparse `3*PRD00001` / `2 * aqua` di kolom scan (qty eksplisit menang
      atas chip Qty/F4 tetapi TIDAK mengosongkan preset itu; qty 0 ditolak
      "Qty minimal 1"; kode tak dikenal -> pesan "tidak ditemukan"; tanpa
      tanda `*` perilaku scan lama utuh; placeholder kolom scan ikut
      mengumumkannya), `pindahBarisKeranjang()` ↑↓ selama fokus di dalam
      `#pos-rows` (baris catatan dilewati, input catatan dikecualikan karena
      panah = kursor, clamp di ujung; panah kolom scan tetap milik dropdown),
      **F7** = Tahan (F2/F3 sudah terpakai Bayar/Layar cari) + label `<kbd>F7>`
      di tombolnya. Test baru **`tests/pos-qtykode-test.mjs` 24 asersi**
      (terdaftar `tests/run.mjs`; total suite kini **861 assertion**), docs:
      AGENTS §2 + README + header pos.ts.
- [x] 2026-10-04 **Info bar: 3 kolom SAMA RATA** (permintaan pemilik "buat
      kolomnya sama rata, jangan lebar di tengah, belum sama rata ukuran
      kolomnya"): grid `lg:grid-cols-[auto_1fr_auto]` → **`lg:grid-cols-3`**
      (track select pelanggan `1fr` dulu menyerap seluruh sisa lebar) +
      `lg:min-w-[340px]` kolom kanan ikut dibuang (track sudah 1/3; min-width
      itu meluap di layar 1024px). Uji ukur: **1440px → 453/453/453px,
      1024px → 314/314/314px**, `#pos-grand` tetap 48px menempel kanan, tanpa
      scroll horizontal, `npm test` **837 hijau**.

- [x] 2026-10-04 **Nomor nota konsisten — uuid penuh dibuang dari layar**
      (laporan pemilik: "Nota d35b5731-… kok tidak sama dengan
      261004-000013"): dialog **detail nota Riwayat** (`history.ts` — baris
      `Nota ${s.id}` uuid penuh) kini `invoice_no ?? id.slice(0,8)`, sama
      seperti toast cetak-ulang & toast "Terjual" POS. **Riwayat Stok**
      (`stock.ts` `Nota <8 digit>`) ikut — API `GET /api/stock-moves` kini
      mengembalikan **`ref_invoice`** (subquery `sales.invoice_no`, additive,
      kontrak §3 diupdate) supaya kolom Keterangan memakai nomor nota yang
      sama. Verifikasi curl: `ref_invoice: "261004-000008"` menemani
      `ref_id` uuid; `npm test` 837 assertion hijau.

- [x] 2026-10-04 **Pelanggan tersimpan di penjualan + nomor urut customer/
      supplier** (permintaan pemilik) — kolom `customers.code`/`supplier_no`/
      `address` + `sales.customer_id`/`customer_name` (ALTER in-place, backup
      `data.db.bak.customer-sales`; SQL migrasi dicatat di AGENTS §5).
      `nomorUrutPelanggan()` = MAX+1 via `CAST(substr(...))` (bukan COUNT —
      gap nomor tidak dipakai ulang; **prefiks wajib `'CUS-'`/`'SUP-'`** —
      bug nyata: pref tanpa dash bikin CAST `-1` → nomor dobel). Seed
      **Pelanggan Umum** = `CUS-000001`. `POST /api/sales` terima
      `customer_id?` (400 bila tak dikenal) + snapshot `customer_name`;
      struk/invoice/riwayat/cetak-ulang memuat baris **Pelanggan** (fallback
      "Pelanggan Umum"); select pelanggan di info bar POS, reset tiap bayar.

- [x] 2026-10-04 **Refactor layout POS mengikuti KulaPOS (Fase 2)** — info
      bar (jam live `jamPos()` + Kasir/Shift + select pelanggan + TOTAL
      BELANJA `#pos-grand` + `#pos-owncount`), tabel keranjang **8 kolom**
      (No/Kode/Nama/Harga/Qty/Diskon/Subtotal/Aksi), **footer horizontal
      4 kolom** menggantikan panel bayar vertikal (semua id lama
      `#pos-cash`/`#pos-pay`/`#pos-change` dipertahankan → F2/Enter/barrier +
      suite test aman), tombol **Bayar pas** `#pos-pay-pas`, modal selesai =
      **`Kembalian RpX` [Thermal] [A4] [Selesai]**. Ikon info bar dipegang
      rule `.info-bar svg` (pola `.chip svg` — terbukti ikon clock jadi
      raksasa tanpa itu). **Putaran lanjutan pemilik 2026-10-04**: header
      judul "Kasir (POS)" **full dihapus** dari `renderPosShell()` (POS tanpa
      `<header>` — keluar = back browser), urutan disamakan ke referensi
      (info bar → scan bar → label "n item + Bersihkan [F5]" di atas tabel →
      tabel ‖ sidebar kanan). Putaran 3: baris **Kasir dipindah ke bawah
      Waktu** (tumpukan vertikal) + **tombol ⬅ kembali ke dashboard**
      (`tombolKembaliHtml()`) di kiri info bar / baris Mode topup-tarik.
      Putaran 4: **footer horizontal DITOLAK** — panel bayar kembali jadi
      **sidebar kanan 320px** (grid `lg:grid-cols-[1fr_320px]`, isi & id
      sama). Putaran 5: info bar — kolom total dipecah (label+n item kiri,
      `#pos-grand` kanan) + **garis pemisah vertikal ketiga kolom**
      (`border-l` ≥lg). Putaran 6: select pelanggan **selebar kolom** (hapus
      `max-w-[520px]`) + kolom total `lg:min-w-[340px]` supaya label benar-
      benar menempel kiri & angka kanan. Putaran 7: `#pos-grand` font
      **kustom `text-[48px]`** (2x lipat `text-2xl` 24px — "custom ukuran
      font, besarkan lagi 2x lipat"). Putaran 8 (sidebar): **baris Grand
      total DIHAPUS** (duplikat TOTAL BELANJA) + section **Aksi cepat**
      grid 2 kolom (Tahan/Pending = fitur P5, Item manual/Diskon nyata,
      Voucher/Cetak ulang placeholder `data-soon`). Verifikasi: tsc 0,
      build OK, `npm test` **837 assertion SEMUA HIJAU** (tanpa ubah
      ekspek), uji playwright `uji-pos-layout.mjs` 22/22 + `uji-hold.mjs`
      23/23 (font 48px, grand total hilang, alur Tahan→Pending→Lanjutkan/
      Hapus, persistensi IndexedDB pasca-reload; kasus awal "Lanjutkan
      timeout" = asersi test salah hitung — baris catatan `note-row` juga
      menyandang `data-key`, bukan bug fitur).

- [x] 2026-10-04 **Nomor invoice/struk direvisi: `YYMMDD-NNNNNN`** — permintaan
      pemilik "jangan random, kombinasi tahun+bulan+tanggal+nomor urut":
      generator server `POST /api/sales` kini memakai prefiks **tanggal UTC**
      + urut **harian** (`261004-000001`, pola `LIKE '<YYMMDD>-%'` +
      `CAST(substr(...,8))` — sekaligus memperbaiki off-by-one `slice(6)` lama
      yang salah dihitung). Struk thermal & riwayat kini mencetak **`No.`
      invoice** (bukan lagi 8 digit uuid yang terlihat random), waktu dan No.
      dipisah baris supaya tidak kena `potong(m, 32)`. Kontrak AGENTS §3,
      schema.sql, README, history.ts, 2 asersi `e2e-struk.mjs` ikut diupdate.

- [x] 2026-10-04 **Super-compact skala KulaPOS/RPOS (putaran 2)** — pemilik
      menilai putaran 1 masih "terlalu besar": seluruh tangga teks Tailwind
      diturunkan satu tingkat di `@theme` `styles.css` (`--text-xs` **11px**,
      `--text-sm` **13px**, base 14/lg 15/xl 17/2xl 20/3xl 24) — ±90 `text-xs`
      + ±89 `text-sm` ikut otomatis. Komponen dipersepat: `.btn` **34px**,
      `.input` **33px** / `.input-sm` **31px**, header **44px**, `.icon-btn`
      32px, `.card` p-3, th/td/chip/badge/modal/toast/nav padding satu tingkat;
      chip **26px** (tetap tombol sentuh); swal judul/isi **13px** + ikon
      **45px**; spacing template `gap-3→2`, `gap-4→3`, `p-5→4`. Guard test
      `satuan-test.mjs` `.th` 12 → **11px** disadari + didokumentasikan
      (`.sw-btn` 40px TIDAK disentuh); sticky wrapper halaman Produk
      disinkronkan dengan padding `.page` baru. Total POS tetap
      `text-sm font-bold` (keputusan pemilik putaran 1: menonjol via bold+warna,
      bukan ukuran). Census akhir: **0 teks >14,5px** di 12 rute + modal +
      swal + toast + semua state; 12/12 rute @356px tanpa overflow;
      `npm test` **835 assertion ×3 SEMUA HIJAU**, build + tsc lolos.
- [x] 2026-10-04 **Hutang: tombol bayar per baris + cetak A4 rincian** —
      `pages/debts.ts`: tombol **Bayar** (ikon `wallet`) di tiap baris
      pelanggan berhutang membuka form catat-bayar prefill (nama + sisa +
      pratinjau "Sisa setelah bayar", `—` netral selama kosong, peringatan
      bila melebihi sisa), dan dialog rincian ledger kini punya tombol
      primer **Cetak A4** (`htmlHutangA4` + `cetakHutangA4`: kop `store_*`,
      tabel kronologis, ringkasan sisa — pola popup `invoice.ts`, tanpa
      print-agent; gagal hanya toast). Verifikasi end-to-end 10/10,
      `npm test` 835 hijau. Perbaikan inkonsistensi rute: 9 referensi
      `#/hutang` di 7 file (AGENTS/README/schema/komentar) → `#/debts`
      (rute asli `main.ts`).
      (Bukti ukuran: header 44, btn 34, `.th` 11, body 13, Bayar 43, popup 203px.)

- [x] 2026-10-04 **Halaman Pelanggan `#/customers` + Hutang `#/debts`** — master
      kontak + ledger piutang `charge|payment` (guard hapus saat masih ada
      catatan, bayar > sisa ditolak server), kontrak AGENTS §3 + §2 + §5 +
      README, test `customer-debt-test.mjs` 32 asersi.
- [x] 2026-10-04 **UI compact ala KulaPOS (pilihan C — seluruhnya)** — teks
      `text-base|lg|xl|2xl|3xl` → `text-sm` (14px) di semua halaman, spasi
      kartu/tabel/header/tombol dipersempit (`.btn`/`.input` 38px, header
      48px; `.th` 12px & `.sw-btn` 40px TIDAK disentuh — dijaga test), token
      baru dicatat di skill `frontend-pos`. Audit visual 15 screenshot + scan
      horizontal 12 rute @356px **menemukan 2 bug**: tabel Riwayat & Satuan
      tanpa `.table-wrap` (kolom Metode/Total/Aksi tak terjangkau di HP, dan
      `.sr-only` absolute menggeser halaman jadi 721px) → dibungkus
      `.table-wrap` + kelas itu kini `relative` (akar masalah containment).
      Lanjutan audit computed-style: **judul swal 18 → 14px** (satu-satunya
      teks >14px yang tersisa), padding dialog dipersempit, ikon swal box
      56 → 50px. Census semua rute + modal + swal + toast + state POS:
      **0 teks >14,5px**. `npm test` 835 assertion **×3 SEMUA HIJAU**,
      build + tsc lolos.
- [x] 2026-10-04 Invoice A4 ala Aronium (`invoice_no`, kop `store_*`,
      pilihan cetak [Thermal][A4][Tidak]), kartu Pengaturan toko, keranjang
      compact 43px, panel bayar ala Aronium + barrier uang diterima — push
      `488b382`.
- [x] 2026-10-03 Catatan per baris (`use_note`), F3/F4, dua layout struk, L3110.
- [x] 2026-10-02 Backup DB otomatis + kartu Backup (test 27 asersi).
- [x] 2026-10-01 Expected-cash tutup shift; kadaluarsa per kategori; menu Shift/
      Riwayat; foto produk & diskon per produk.

## Menyusul — permintaan pemilik berikutnya (belum dikerjakan)

- [x] **Keranjang POS: kolom angka compact — SELESAI 2026-10-06** (batch 1a,
      push `629192f`): Harga / Qty / Diskon / Subtotal / Aksi diperkecil
      sesuai isi kontennya (`max(hint, konten)`), hanya kolom **Nama barang**
      yang melebar menyerap sisa lebar tabel (permintaan pemilik 2026-10-04:
      "selanjutnya nanti pada tabel keranjang kolom Harga, QTY, Diskon, sub
      total, aksi di perkecil, compact saja sesuai ukuran konten, buat kolom
      nama barang saja yang lebar") — terukur Nama 438 → ±540px.
- [x] **Rapikan layout sidebar POS — SELESAI diimplementasikan 2026-10-06**
      (mockup direview pemilik lalu dikode): urutan baru per permintaan
      *"diskon item pindah ke bawah menu cepat di atas diskon"* =
      **Aksi cepat → (garis tipis) → Menu cepat → (garis tipis) → Diskon
      item → Diskon transaksi → Bayar (mt-auto)**; tombol **Riwayat**
      (`a[href="#/history"]`) menggantikan slot Voucher; **Menu cepat**
      = **Produk** (`#/products`) | **Stok** (`#/stock`); tombol **Pending**
      kini ber-pintasan **`<kbd>F8</kbd>`** (dialihkan dari alias lama F8 =
      fokus scan — F1 tetap ke scan; uji `e2e-struk` F8 disesuaikan);
      bukti: DOM order + navigasi + toast F8 terverifikasi, **915 hijau**.
- [x] **Harga khusus di POS: kolom Harga jadi INPUT — SELESAI 2026-10-06**
      (permintaan pemilik, referensi Aronium; fitur lama `price_dynamic`
      dipertahankan + diperluas): (1) **kolom Harga baris keranjang = input
      bila `products.price_dynamic=1`**, teks terkunci untuk produk lain
      (`setHarga()`, event `change` seperti Diskon); (2) **aturan baris**:
      produk sama + harga **berbeda = baris BARU**, harga **sama = qty
      tambah** — key baris dinamis kini `<id>:<unit>:<harga>`, edit harga
      di-re-key & bila menabrak baris berharga sama kuantitas **digabung**;
      (3) **dialog harga saat scan DIHAPUS permanen** — permintaan lanjutan
      pemilik 2026-10-06: *"karena harga bisa di ubah inline, modal dynamic
      harga tidak usah"*; scan kini lewat jalur `addProduct()` yang sama
      (harga default `hargaTampil` langsung terisi). Keputusan "batal =
      harga default" pagi harinya **gugur bersama hilangnya dialog**;
      (4) **bugfix**: tombol **Simpan**
      `askNumber` dahulu hanya `resolve` tanpa `close()` — modal Qty (F4)
      nyangkut terbuka setelah baris masuk (Enter sudah menutup; `askPrice`
      sendiri sudah dihapus bersama dialognya).
      Aturan baris juga ditegakkan saat pulihkan keranjang/hold (re-key +
      gabung). Uji baru `tests/harga-dinamis-test.mjs` **18 asersi** (scan
      tanpa dialog, harga default, grouping, edit re-key/tabrak-gabung,
      non-dinamis terkunci, anti-clip, F12 + snapshot server);
      **933 hijau**, tsc + build lolos.
- [x] **Input catatan per baris dipendek — SELESAI 2026-10-06** (permintaan
      pemilik: *"input untuk catatan ini misal di kurangi panjangnya selebar
      No - Nama Barang saja"*): `trCatatan` `colspan="8"` → **`colspan="3"`
      (No..Nama = 609px terukur, dulu 1086px penuh)** — baris kosong tetap
      `colspan="8"`. Selector test (`data-act=note`, `tr.note-row`) tak
      berubah; 933 hijau.
- [x] **Layout mobile + tombol pindah mode — SELESAI (Tahap 5, 2026-10-06)**
      (pengganti P4 grid, keputusan pemilik: *"untuk mobile nanti buat
      layout sendiri … tambahkan layout untuk berpindah ke mode mobile
      saja"*): tombol **`#pos-mobile` "Mobile" KANAN chip Qty** di scan bar
      (ikon `smartphone` baru) → toggle `mobileMode` + pref
      `ravaa.mobile-layout` — semua grid POS dipaksa 1 kolom
      (`gridUtamaCls()` + `gridCls`/`batas` info bar; listener di `paint()`
      semua mode). Probe 14/14 (urutan Cari→Qty→Mobile, stack 1 kolom,
      pref tersimpan, kembali desktop); kartu-list keranjang = opsi lanjut
      setelah approve tampilan.
- [x] **Info bar di mode topup/tarik — SELESAI (2026-10-06)**: pemilik
      *"mode topup dan tarik mengapa bagian ini hilang ya?"* — dulu
      conditional `mode === 'jual'` sehingga Waktu/Kasir/Shift/**Tutup
      shift** ikut lenyap. Kini `infoBarHtml()` dirender **semua mode**;
      cell 2/3 topup = "Mode" (judul·jenis) + "Total dibayar"
      (`#pos-grand`/`#pos-owncount` disinkron `paintTopup()`), listener
      pindah ke `paint()` (dulu `bindCart` = tombol mati di topup), back
      duplikat di baris Mode dihapus. Probe 8/8 + suite 934 hijau.
- [x] **Form topup/tarik disesuaikan per jenis — SELESAI (2026-10-06)**:
      permintaan pemilik: e-wallet/pulsa *"tidak perlu nomor HP"* (cukup
      Nominal + Admin), tarik tunai *"hanya nominal saja dan admin"*, tagihan
      PLN sudah sesuai (ID pelanggan + nominal + admin), **PLN token tetap
      No meter + form BARU Nomor Token yang ikut dicetak di struk**
      (`butuhNomor`/`butuhToken` di `TOPUP_JENIS`/`TARIK_JENIS`, field
      `#tp-token`, baris struk `Token:`), admin = fee toko (PLN 50-50 mitra
      diketahui — angka tetap diisi kasir). Server: `nomor` jadi OPSIONAL
      (`''` = tanpa nomor) + kolom baru **`topup_txns.token`** (ALTER
      in-place, backup `data.db.bak.topup-token`); Riwayat menyembunyikan
      nomor kosong & menampilkan Token. e2e-struk section C diperluas
      (e-wallet tanpa input nomor + struk PLN token) → **939 asersi hijau**.
      **Revisi lanjutan (masih 2026-10-06)**: pemilik *"biaya admin itu
      letakkan di bawahnya nominal saja"* + *"mode topup dan tarik tunai
      semua sama tampilannya … yang berbeda hanya card [kiri]"* → input
      `#tp-admin` pindah dari sidebar kanan ke **card kiri tepat di bawah
      Nominal**; sidebar kanan jadi murni ringkasan read-only (NOMINAL →
      ADMIN `#tp-admin-view` → Total → metode → uang diterima → Proses),
      struktur identik untuk kedua mode (id/listener tidak berubah, e2e
      tetap pakai `inputValue('#tp-admin')`).
      **⚠ Digantikan refactor 1 layout 2026-10-07 — lihat entri di bawah.**
- [x] **Refactor 1 layout desktop: sidebar bayar identik SEMUA mode —
      SELESAI (2026-10-07)**: permintaan pemilik *"untuk mode topup dan
      tarik tunai gunakan layout yang sama dengan mode penjualan … yang
      berbeda hanya keranjang belanja"* → seluruh POS jadi SATU layout:
      area kiri saja berubah (jual = `cartKiriHtml()` tabel; topup/tarik =
      `topupHtml()` form per jenis), sidebar kanan **`sidebarBayarHtml()`
      identik** (Aksi cepat → Menu cepat → Diskon item → diskon transaksi →
      Bayar F10 + Bayar pas F12; listener `bindSidebar()` dari `bindCart`
      + `bindTopup`). **Kolom uang `#tp-tunai`, tombol `#tp-submit`,
      ringkasan `#tp-nominal-view`/`#tp-admin-view`/`#tp-total`/
      `#tp-kembali` DIHAPUS** — angka pindah ke info bar (`paintTopup()`),
      transaksi diproses lewat **MODAL BAYAR bersama**: `pay()` meneruskan
      non-jual ke `submitTopup()` (`totalBayar()` = nominal+admin), barrier
      tunai ATURAN LAMA utuh (topup wajib uang >0 & ≥ total; tarik
      dikecualikan >0; `0 < uang < total` tolak kedua mode) — gagal barrier
      = buka modal + fokus `#pos-cash`; sukses = `tutupBayar()` (topup
      tetap TANPA dialog resume) + reset `cashIn`. Pintasan: F1/F8 semua
      mode; F10/F12/F2 → `pay()`/`bisaBayar()`; F6/F7 non-jual → toast;
      aksi Tahan/Item manual/Diskon sidebar → toast (Opsi A disetujui
      pemilik); `muatHold()` dari topup otomatis pindah ke `jual`;
      `bayarPas()` mode-aware (topup tunai = uang pas, tarik = cashIn tak
      disentuh). e2e-struk section C dialihkan ke alur modal (`#pos-bayar`
      → `#pos-cash` → `#pos-pay`), jumlah asersi **tetap 138 → 939 total
      hijau**; probe barrier `/tmp/opencode/probe-barrier-topup.mjs`
      9/9; screenshot 4 mode `/tmp/opencode/refactor-{jual,topup,
      topup-modal,tarik}.png` — sidebar identik terverifikasi visual.
      tsc `--force` 0, build web ✓. API TIDAK berubah.
- [x] **Info bar: blok Pelanggan identik SEMUA mode — SELESAI (2026-10-07)**:
      permintaan pemilik (blok HTML `#pos-customer` + tombol F9):
      *"harusnya bagian ini juga tetap sama customer"* → sel "Mode"
      (judul·jenis) pengganti di topup/tarik **DIHAPUS**, kolom tengah
      selalu render blok Pelanggan + F9 persis seperti mode jual
      (`infoBarHtml()` tanpa ternary `jual`); listener `#pos-customer`
      pindah dari `bindCart()` ke `paint()` universal + **F9** dilepas dari
      guard `mode !== 'jual'`. Pilihan pelanggan di topup/tarik = state
      tampilan saja (POST /api/topups TIDAK mengirim customer_id — kontrak
      tidak berubah). Verifikasi: DOM probe (`modeAktif=Topup`,
      `#pos-customer` ada, teks info bar tanpa sel Mode; selectOption dari
      topup OK), pixel bbox crop info bar (biru Rp0 kanan-atas + merah
      Tutup shift kiri), tsc 0, 939 asersi hijau. Catatan tooling: read
      tool sempat menyajikan gambar salah saat verifikasi visual — bukti
      final memakai DOM + sampling piksel PNG.
- [x] **Notif stok di baris Mode (mode Penjualan) — SELESAI (2026-10-07)**:
      permintaan pemilik: slot `ml-auto` baris Mode yang di topup/tarik
      berisi petunjuk Bayar, di jual *"bisa buat notif stok barang habis
      atau dll"* → `notifModeRow()`: chip hitungan merah `n stok habis`
      (`track_stock && stock<=0`), kuning `n stok menipis`
      (`0<stock<=min_stock`), merah `n lewat kadaluarsa`
      (`statusExpiry==='lewat'`) → tautan `#/stock`/`#/products`; tanpa
      temuan = slot kosong. Sumber cache lokal (pola strip — tanpa API,
      kesegaran ikut `syncMaster` mount), rincian nama tetap di strip
      `stripStokMenipis`/`stripKadaluarsa` bawah scan bar. Teruji live:
      seed punya PRD00016 stok=0 → chip "1 stok habis" tampil (probe DOM
      count=1) + 939 asersi hijau.
- [x] **Buka Laci Kasir OTOMATIS — SELESAI (Tahap 4a, 2026-10-06)**:
      penjualan **tunai** sukses di `pay()` → `bukaLaciOtomatis()` kirim kick
      **`ESC p 00 19 FA`** (`bukaLaci()` di `escpos.ts`) lewat `kirimPrint()`
      **TANPA syarat saklar "Cetak struk otomatis"** (laci = bagian transaksi
      tunai, bukan cetak; QRIS/transfer tidak kick), segera saat server
      konfirmasi & tanpa menunggu modal resume; gagal = `console.warn` saja
      (penjualan tak pernah dibatalkan). Nol perubahan API/agent.
      Unit: `escpos-test.ts` (+1, ekspek 70→71). Probe:
      `/tmp/opencode/probe-laci2.mjs` — payload persis `1b700019fa`,
      agent `ok:true via /dev/usb/lp0`, struk tak ikut (cetak mati),
      QRIS +0 request, 0 pageerror.
- [x] **Tombol Voucher → Riwayat — SUDAH (2026-10-06)**: `data-soon="Voucher"`
      dibuang, slot kini `a[href="#/history"]` (lihat item sidebar di atas;
      fitur voucher sendiri DITOLAK, lihat P6 di Backlog).
- [x] **Tombol Cetak ulang → nota TERAKHIR — SUDAH (Tahap 2, 2026-10-06)**:
      id nota sukses disimpan `pay()` ke localStorage `ravaa.nota-terakhir`
      (per device) → tombol `#pos-reprint` disabled sampai ada nota → klik =
      fetch `GET /api/sales/:id` → **`cetakUlang()` (di-export dari
      `history.ts`)** dialog [Thermal][A4][Batal] jalur Riwayat, tanpa
      pratinjau Lihat Struk (keputusan pemilik: menyusul). Probe:
      `/tmp/opencode/probe-cetak-ulang.mjs` (disabled→enabled, invoice
      `261007-000002`, dialog 3 pilihan, 0 pageerror).
- [x] **Tutup shift dari dalam POS — SUDAH (Tahap 1, 2026-10-06)**: tombol
      **merah `#pos-shift-tutup` RATA KANAN info bar** (revisi pemilik
      "tombol ini letakkan di rata kanan" — track auto ke-4 grid
      `[1fr_1fr_1fr_auto]`, 3 kolom utama tetap sama rata; versi awal
      sebelah Kasir+Shift dipindah). Keputusan dasar: "tombol merah di pos
      seperti kula pos". Rumus + `dialogTutupShift()` diangkat ke
      **`pages/shift-tutup.ts`** (bersama `#/shifts` — satu sumber kebenaran
      `kasSeharusnya()`/`hitungSelisih()`, AGENTS §5); setelah tutup, POS
      kembali ke gate "Buka shift dulu".
      Probe: `/tmp/opencode/probe-shift-merah.mjs` +
      `/tmp/opencode/probe-tutup-kanan.mjs` (1440/1024/390 — jarak tepi
      kanan 13px, 0 pageerror).
- [x] **2 mode dalam 1 transaksi — jasa/produk + topup/tarik dalam NOTA &
      BAYAR SATU (Opsi B hybrid) — SELESAI 2026-10-07** — permintaan pemilik
      2026-10-07 *"PR bisa 2 mode dalam 1 transaksi"* (contoh: fotokopi 50
      lembar + isi pulsa/e-wallet untuk 1 pelanggan). **Status SEBELUM
      dikerjakan: BELUM bisa** — dulu topup sengaja terpisah (`bukaModeLayanan()` → mode Topup →
      `submitTopup()` → `POST /api/topups`; nota/bayar/struk terpisah dari
      `POST /api/sales`; Item manual dipakai untuk topup = SALAH laporan).
      **Desain Opsi B (disepakati utk dikerjakan)**: (1) keranjang
      Penjualan punya **baris bertipe `topup`** (tombol/panel "Tambah
      topup" — isi jenis/nomor/nominal/admin persis form topup); (2) saat
      **Bayar SEKALI**: `pay()` mengirim **`POST /api/topups` dulu (bila ada
      baris topup) LALU `POST /api/sales`** — record TETAP terpisah supaya
      aturan domain utuh: topup tidak masuk omzet, `nominal` = mutasi
      modal, `admin` = jasa, agregat shift `topup_nominal/topup_admin`
      tetap benar; (3) **1 struk gabungan** (blok items + blok topup);
      (4) barrier uang/hutang dihitung atas **total gabungan**; (5) persist
      keranjang/holds + hold restore ikut tipe baris baru. **API TIDAK
      berubah** (dua endpoint lama dipanggil berurutan — kontrak §3 tetap;
      kegagalan ke-2 = rollback ringan / toast seperti pola ledger hutang).
      Opsi C (topup jadi produk biasa) **DITOLAK**: nominal bebas + admin
      editable bertabrakan dengan "harga non-dinamis dikunci server" +
      omzet jadi kotor. Pekerjaan: `pos.ts` (tipe baris, form mini,
      orkestrasi pay, struk), `escpos.ts` (blok topup di struk), test
      e2e-scenario baru + update AGENTS §1/§3/§5. **HASIL (2026-10-07,
      dikerjakan):** semua butir desain di atas jalan — `cartTopup:
      TopupLine[]` TERPISAH dari `cart` + dialog `openDialogTopupKeranjang()`
      (tombol **Topup** di Aksi cepat, jenis hanya `TOPUP_JENIS`), `pay()`
      POST topup DULU (id uuid stabil = retry idempotent `duplicate:true`)
      lalu sales, barrier atas **total gabungan** dengan **baris topup TIDAK
      BISA hutang**, 1 struk gabungan + resume berisi baris topup (nominal &
      admin terpisah; **pilihan A4 disembunyikan saat ada topup**), `cash_in`
      nota = total + kembalian (invarian server `change = cash_in − total`),
      keranjang hanya-topup = jalur topup-saja (tanpa resume), persist
      keranjang/holds ikut `topups` + validasi restore (jenis dikenal,
      nominal > 0). Teruji **`tests/e2e-topup-keranjang.mjs` 45 asersi**
      (suite total **984 hijau**); AGENTS §2/§3 + README diperbarui.
      Sisa/keputusan menyusul: **A4 gabungan** (invoice server tidak memuat
      topup) dan **cetak ulang nota hybrid dari Riwayat** (baris topup tidak
      bisa direkonstruksi dari `sales` — `topup_txns` tidak menyimpan
      referensi nota).
      **Revisi 2026-10-08 (permintaan lanjutan pemilik — SELESAI):**
      (a) **tarik tunai ikut hybrid**: dialog `openDialogTopupKeranjang()`
      punya grup chip Tarik (`TARIK_JENIS`) — baris tarik (`isTarik()`)
      dikirim `pay()` dengan `kind:'tarik'` (provider `TARIK-*`); yang
      ditagih HANYA admin (`tarikTotal()`, nominal = uang keluar diserahkan
      tunai — harmonis dengan mode Tarik yang membolehkan uang 0); barrier
      tetap tolak hutang untuk SEMUA baris layanan; struk/resume/hold ikut
      blok tarik (nominal & admin terpisah, kaki "Nominal tarik sudah
      diserahkan tunai"); tombol Aksi cepat jadi **Topup/Tarik**.
      (b) **bug "tambah 1 topup masuk 2 baris"** (laporan pemilik, terbukti
      via probe: 1x Enter = 2 baris): handler Enter di dialog (api.el) +
      handler bawaan `modal.ts` (overlay Enter-di-INPUT → ok.click) menembak
      `submit()` 2x — diperbaiki dengan guard `terkirim` setelah validasi
      (dialog topup + item manual yang berpola sama). Teruji
      `tests/e2e-topup-keranjang.mjs` section G (15 asersi tarik + 1 regresi
      Enter) — suite kini **61 asersi**; `history-test.mjs` ikut diperkeras
      (klik baris `sale:` pertama, bukan baris pertama — topup terbaru
      tidak punya tombol cetak-ulang).
- [x] **Hapus mode Topup/Tarik — semua layanan lewat keranjang (Opsi B
      penuh) — SELESAI 2026-10-08** — keputusan pemilik: tombol
      `data-mode="topup"/"tarik"` + form mode (`topupHtml()`/
      `topupKiriHtml()`) "sudah tidak diperlukan ... bisa dibersihkan",
      tarik "sudah digantikan modal untuk masuk ke keranjang". Yang
      dihapus dari `pos.ts` (±380 baris): state `mode`/`top*`, form +
      `bindTopup`/`paintTopup`/`submitTopup`/`bindModeBar`, helper
      `defaultJenis`/`jenisList`/`jenisAktif`/`jenisKode`,
      `paintBayarAktif`/`teksKembalianBayar`/`kembalianBayar`, dan SEMUA
      cabang mode (pay/bayarPas/pintasan/render/info bar/scan bar/sidebar/
      hold). Pintasan katalog produk kategori `topup` kini membuka DIALOG
      (jenis disarankan dari nama). Satu-satunya penyederhanaan perilaku:
      tidak ada lagi form nominal terpisah — kasir yang butuh topup
      cepat tetap 1 klik (tombol Topup/Tarik) + isi dialog. Ditambah
      permintaan yang sama: **tombol dialog ~1.5x** (chip jenis 39px/16px,
      footer Batal/Tambah 51px/20px). `e2e-struk.mjs` section B-tail + C
      ditulis ulang ke alur dialog (141 asersi, +3); suite total
      **1003 hijau**. Catatan test: wait toast HARUS spesifik nominal
      (toast lama menumpuk dan memalsukan wait generik).
- [x] **Resume pasca-bayar untuk layanan-saja + rapikan dialog Topup/Tarik —
      SELESAI 2026-10-08** — laporan pemilik: *"resume setelah bayar tidak
      muncul, kemarin ada modal resume kembalian, dan ada tombol pilih cetak
      thermal print atau inkjet dan selesai"*. Ternyata penjualan/hybrid
      SELALU menampilkan resume (repro F12 & F10 hijau) — satu-satunya jalur
      tanpa resume = keranjang hanya-layanan (`if (!cart.length)` di `pay()`,
      by-design sejak awal). Kini jalur itu memanggil
      `pilihCetakSelesai(null, …)` dengan argumen snapshot `topups` (nominal &
      admin terpisah, `metode`, `uang`); **`saleId: string | null`** → pilihan
      A4 tetap ditawarkan (`saleId !== null` hanya untuk sembunyi A4 penjualan
      hybrid) tapi `saleId === null` mencetak **strukA4** via print-agent —
      invoice A4 butuh `sale.id`. Struk langsung otomatis DIHAPUS dari cabang
      ini (cetak hanya via pilihan resume); toast `${judul} tercatat · RpX`
      tetap. Dialog topup ikut dirapikan searah referensi pemilik (modal
      resume = bahasa visual utama): judul blok terpusat uppercase
      `text-xs`, pemisah `border-dashed`, input balik `.input` polos +
      `space-y-1` (pola modal Cari produk/Item manual yang disebut "rapi"),
      chip jenis → `btn-ghost` radius 8px seukuran sidebar, footer
      `!min-h-[32px] !text-xs` + ikon check, baris ringkasan `#ptk-total`
      (`tampilTotal()`: topup = nominal+admin, tarik = admin saja). Test:
      4 asersi "TANPA modal resume" di `e2e-struk.mjs` (section C) +
      `e2e-topup-keranjang.mjs` (F topup-saja & G tarik-saja) **direpurpos**
      jadi assert judul/isi/tombol resume + klik Thermal sebelum
      `tungguTercetak` — jumlah asersi TIDAK berubah (141 & 61);
      `run.mjs` ekspek 1003 utuh.
- [x] **Stok di suggest/F3 ter-refresh setelah bayar — SELESAI 2026-10-08** —
      laporan pemilik: *"setelah transaksi selesai, stok di bawah nama produk
      tidak terefresh sehingga seolah-olah stok tidak berkurang"* (dropdown
      `#pos-results` + modal Cari produk `#pc-list` menampilkan `sisa 49`
      padahal server sudah memotong). Fakta: potongan stok SUDAH benar di
      server (`POST /api/sales` → `UPDATE products SET stock = stock −
      qty×factor` + `stock_moves`, dibuktikan curl: Pulpen Hitam 49 → 47) —
      yang basi hanya array `products` POS yang **dulu hanya dimuat ulang di
      `mountPosPage()`**. Perbaikan: `segarkanStokPos()` dipanggil di `pay()`
      segera setelah `POST /api/sales` terkonfirmasi (delta sync +
      `getCachedProducts()` + gambar ulang dropdown bila terbuka); gagal/
      offline senyap, cabang layanan-saja tidak memanggil (topup tak
      menyentuh stok). Test baru section **D2** `e2e-struk.mjs` (2 asersi:
      suggest & `#pc-list` memuat `sisa <stok server>`) → ekspek **143**;
      suite total **1005 hijau**.
- [ ] **Ganti satuan baris yang sudah ada di keranjang** (sisa gap analysis) —
      KulaPOS punya select Satuan di bar "Parameter Barang Aktif"; Ravaa
      memilih satuan saat menambah (key baris = `<id>:<unit>`), jadi ubah
      satuan kini = hapus baris + scan ulang. **Keputusan FINAL pemilik 2026-10-06:
      (a) dropdown/chip satuan PER BARIS di tabel keranjang; diskon baris
      DI-RESET saat satuan diganti** (total uang berubah — diskon lama
      tidak relevan; qty mengikuti satuan baru). Re-key `<id>:<unit>`,
      harga diambil ulang dari `product_units` (server tetap mengunci
      harga saat bayar).

*Catatan pembersihan 2026-10-06*: tiga item lama di akhir section ini —
hapus duplikat "Item manual", hapus baris "Subtotal" sidebar, cari pelanggan
ala F3 — DIHAPUS karena sudah dikerjakan putaran 7 2026-10-04 (lihat Catatan
putaran 7 di atas; bukti test `e2e-struk.mjs` section K). Arah "hapus Item
manual" memang berputar: putaran 7 membuang yang di scan bar, mempertahankan
yang di Aksi cepat — jadi keputusan lama "yang di Aksi cepat dihapus" tidak
pernah dilaksanakan dan tidak perlu.
