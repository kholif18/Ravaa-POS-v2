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
- [ ] **P4 — Grid katalog + tab kategori di POS** (mode `Daftar|Grid`, ≥860px;
      HP tetap search) — tanpa API baru (cache produk + `/api/categories`).
- [x] **P5 — Tahan/pending transaksi** — SELESAI 2026-10-04: snapshot keranjang
      (`Hold` = items/diskon/pelanggan/waktu/kasir) ke **IndexedDB per device**
      (`getHolds()`/`saveHolds()` di `store.ts`, kv key `'holds'` — tanpa
      endpoint baru), tombol **Tahan** + **Pending (n)** (badge
      `#pos-hold-count`) di section **Aksi cepat** sidebar POS, modal daftar
      **[Lanjutkan] [Hapus]** (konfirmasi swal; Lanjutkan validasi pelanggan
      ke master + dorong `manualSeq`), persisten setelah reload. Uji
      `uji-hold.mjs` 23/23 + `npm test` 837 hijau.
- [ ] **P6 — Biaya tambahan / voucher** ⚠️ butuh diskusi kontrak `POST /api/sales`
      (jangan diimplementasi sepihak; kompromi saat ini = Item manual Rp500).
- [ ] **P7 — Customer display** (jendela kedua via `BroadcastChannel`, struk
      live gaya KulaPOS) — client-only, tanpa API.

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
- Docs ikut: AGENTS §2 (deskripsi `pilihCetakSelesai` + kartu Cetak struk),
  README (judul butir "Modal resume + pilihan cetak" + kartu Sistem),
  `print-pref.ts` doc `getAutoPrint()`.

**Gap analysis KulaPOS vs Ravaa POS (2026-10-04)** — sumber: `kula-01..12*.png`
(khususnya `kula-02-transaksi-pos.png`, `kula-07-pos-kasir.png`) +
`kulapos-transcript.txt` segmen 35:00–41:00:

* **Sudah setara / selesai**: Pending-Tahan (P5) + pintasan F7, `Qty*Kode`,
  navigasi ↑↓ baris, Bersihkan F5, diskon faktur F6, pelanggan inline, strip
  stok/kadaluarsa, cetak struk otomatis, satuan jual, catatan per baris.
* **Menyusul (sudah tercatat)**: P4 grid katalog, P6 biaya tambahan/voucher,
  P7 customer display, plus kandidat kecil di section Menyusul
  (tutup shift dari POS, ganti satuan baris, **hapus duplikat Item manual**,
  **hapus baris Subtotal sidebar**, **cari pelanggan ala F3** — ketiganya
  permintaan pemilik 2026-10-04 di akhir section itu).
* **Ditunda keputusan pemilik**: **pajak PPN 10% + service charge**
  ("D pajak skip dulu", 2026-10-04) — butuh kolom/setting baru dan menyentuh
  `POST /api/sales`, laporan, struk, invoice; harga baris bisa diedit kasir
  (bertabrakan dengan "harga non-dinamis dikunci server").
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

- [ ] **Keranjang POS: kolom angka compact** — Harga / Qty / Diskon /
      Subtotal / Aksi diperkecil sesuai isi kontennya (width auto/shrink),
      hanya kolom **Nama barang** yang melebar menyerap sisa lebar tabel
      (permintaan pemilik 2026-10-04: "selanjutnya nanti pada tabel
      keranjang kolom Harga, QTY, Diskon, sub total, aksi di perkecil,
      compact saja sesuai ukuran konten, buat kolom nama barang saja yang
      lebar").
- [ ] **Rapikan layout sidebar POS** — permintaan pemilik "sidebar nanti
      rapikan layoutnya" (menyusul masuknya section Aksi cepat + penghapusan
      baris Grand total).
- [ ] **Tombol placeholder → fitur nyata** — **Voucher** (kaitan dengan P6,
      butuh diskusi kontrak `POST /api/sales`) dan **Cetak ulang** (ulang
      struk nota terakhir?) saat ini `data-soon` → toast "menyusul"
      (permintaan pemilik "placeholder/hardcode dulu tidak apa-apa").
- [ ] **Tutup shift dari dalam POS** (sisa gap analysis) — KulaPOS punya
      tombol merah "Tutup Sesi Kas" di header POS; shell Ravaa sengaja tanpa
      menu, jadi kasir harus keluar ke `#/shifts` (halaman Shift Kasir sudah
      punya dialog tutup + rumus expected-cash). Butuh keputusan bentuk:
      tombol di info bar / sidebar, atau sekadar tautan.
- [ ] **Ganti satuan baris yang sudah ada di keranjang** (sisa gap analysis) —
      KulaPOS punya select Satuan di bar "Parameter Barang Aktif"; Ravaa
      memilih satuan saat menambah (key baris = `<id>:<unit>`), jadi ubah
      satuan kini = hapus baris + scan ulang. Butuh keputusan UI (chip
      satuan per baris vs dialog) — jangan disentuh tanpa itu.
- [ ] **Hapus duplikat "Item manual"** (permintaan pemilik 2026-10-04) —
      tombol itu muncul **DUA kali**: di scan bar (`#pos-manual`, tetap) dan
      lagi di grid **Aksi cepat** sidebar (`#pos-qa-manual`, dipanggil
      `bindCart()` pos.ts) → **yang di Aksi cepat dihapus** (redundan);
      pasangannya di `pos.ts` (render `cartGridHtml` + listener) ikut
      dibuang, bukan hanya tombolnya.
- [ ] **Hapus baris "Subtotal" di sidebar** (permintaan pemilik 2026-10-04) —
      `<span id="pos-subtotal">` + baris flex-nya di `cartGridHtml()` dihapus;
      angka subtotal tetap hidup di ringkasan struk/laporan, jadi tidak ada
      sumber data yang hilang. `paintCart()` yang menulis `#pos-subtotal`
      ikut dibersihkan supaya tidak jadi query mati.
- [ ] **Pelanggan bisa dicari seperti cari produk F3** (permintaan pemilik
      2026-10-04) — `<select id="pos-customer">` sudah memuat master
      (`GET /api/customers`) tapi daftarnya makin panjang (banyak kontak
      supplier/pembeli) dan kasir harus men-scroll; ganti jadi pencarian
      multi-kata seperti layar cari produk (**F3**) — pola `openCariProduk()`
      di `pos.ts` (input + listbox + ↑↓ + Enter) atau dropdown hasil cari di
      samping select. `customer_id` yang terpilih tetap dikirim `pay()`
      seperti sekarang (server yang men-SNAPSHOT `customer_name`), jadi ini
      **murni UI** — tidak menyentuh kontrak API.
