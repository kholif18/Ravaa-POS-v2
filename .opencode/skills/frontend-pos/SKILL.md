---
name: frontend-pos
description: Standar UI/UX kasir Ravaa POS — design token, pola layout kasir touch-friendly, dan aturan konsistensi. Muat setiap tugas menyentuh apps/web.
---

# frontend-pos — standar UI/UX kasir

## Kapan dipakai

Setiap perubahan `apps/web/`: tambah tab/kategori, ubah tombol/form/keranjang,
panel topup/laporan, modal struk, atau styling apa pun.

## Design token (KUNCI — sistem vanilla ala shadcn/bag-ui, `styles.css` + `admin.css`)

* Palet restyle **2026-10-08** (arahan pemilik *"style lebih modern, warna
  lebih hidup seperti KulaPOS"* — daftar ini = nilai `@theme` `styles.css`
  apa adanya; jangan menulis warna hex baru di template tanpa mengubah +
  menyinkronkan token di sini): primer biru **`#1d6df0`** (dari `#0087ff` —
  kontras putih 13px ~4.7:1 lolos AA, `#0087ff` lama hanya ~3.1:1 GAGAL),
  hover **`#1757c8`**, primary-soft **`#e9f1ff`**, canvas **`#f2f5fa`**
  (kartu putih `#fff`, garis `border-gray-200/70`), sidebar navy
  **`#0b1220`** (gradien ke `#131d33`) + hover **`#16213a`** + aktif
  **`#1d4ed8`** (pil biru solid ber-shadow) + teks **`#93a3bd`**, teks
  `#18181b`/muted `#71717a` tidak berubah. Dua token bayangan BARU:
  **`--shadow-card`** (kartu/tabel — `.card`, `.table-wrap`, `.modal`)
  dan **`--shadow-pop`** (dropdown/toast/lapis melayang). Success
  `#16a34a`, warning `#d97706`, danger `#dc2626` tidak berubah.
  Dark `[data-theme="dark"]` (bg `#09090b`, kartu `#18181b`, garis
  `#27272a`); **aksen teks primer di dark memakai override khusus**
  `#6aa5ff` (di blok setelah swal — `--color-primary` #1d6df0 sebagai teks
  di kartu gelap hanya ~3.7:1). Font `Inter` self-hosted (`public/fonts/`,
  offline).
* **Skala SUPER-COMPACT (permintaan pemilik "ala KulaPOS", 2026-10-04 — SEMUA
  halaman termasuk POS)**: seluruh tangga teks Tailwind diturunkan SATU tingkat
  di `@theme` `styles.css`: `--text-xs` **11px** (label, th tabel, badge, chip,
  hint, sub-teks), `--text-sm` **13px** (judul, body, isi tabel, tombol —
  default app), `--text-base` 14 / `lg` 15 / `xl` 17 / `2xl` 20 / `3xl` 24.
  Angka tsb = SATU-SATUNYA sumber ukuran teks (±90 pemakaian `text-xs` + ±89
  `text-sm` ikut otomatis — jangan set px hardcode baru per template).
  Hierarki dibangun `font-bold/semibold` + warna, BUKAN ukuran besar.
  Dilarang `text-base|lg|xl|2xl|3xl` di `apps/web` (sudah 0 sisa — jangan
  dikembalikan). Angka penting (total, kembalian, angka stok) tetap
  `text-sm` (13px) + `font-bold tabular-nums`; label/badge boleh 11px;
  jangan <11px.
* Komponen (vanilla, tanpa framework): `.btn` + varian `.btn-primary` /
  `.btn-ghost` / `.btn-outline` / `.btn-sm` / `.btn.is-on` **34px** (min-h) /
  teks 13 semibold — **daftar ini = styles.css apa adanya; jangan memakai
  varian `.btn` yang tidak terdefinisi (mis. `.btn-danger`/`.btn-lg`) —
  class hantu = no-op tanpa error** (bukti putaran 8b 2026-10-04:
  `#pos-pay-pas` jadi tanpa warna karena `btn-outline` belum ada),
  `.input` **±33px** (`py-1.5`; deviasi 16px anti-zoom iOS), `.input-sm` **±31px**,
  `.card` radius 10 + shadow-sm + `p-3`,
  `.table` (th **11px** uppercase muted — ikut skala; guard
  `satuan-test.mjs` §header sudah disesuaikan ke 11px secara sadar),
  `.badge-*` 11px medium, `.chip` teks 11px / badan **±26px** (chip = tombol
  metode bayar & nominal cepat — jangan dipangkas di bawah 26px),
  `.modal-overlay(.is-open/.is-closing) > .modal(.wide)` (spring-in 180ms,
  keluar 120ms — node dilepas modal.ts setelah 160ms),
  sidebar `#sidebar` 240px (`.collapsed` 72px, drawer HP ≤860px) + `.nav-dropdown(.open)`,
  tabs/pills segmented (kontainer muted, aktif kartu shadow-sm).
  **Tinggi lain (super-compact)**: header halaman `.app-header` **44px**
  (h-11), brand sidebar 44px, `.sw-btn` (tombol swal) **tetap 40px**
  (target sentuh, dijaga test `satuan-test.mjs`), `.icon-btn` **32px**,
  `.row-btn` 32px. PENTING: bila `.page` padding diubah, ikut sinkronkan
  sticky wrapper halaman Produk (`-mx/-mt/px/pt` + `-top-*` di products.ts)
  — selisihnya tak terlihat (sama-sama bg-canvas) tapi toolbar menjorok. `.table-wrap` = `relative` +
  `overflow-x-auto` (WAJIB bungkus tiap `.table` — tanpa itu kolom kanan
  terpotong tak bisa digulir di HP, dan `.sr-only` absolute menggeser
  documentElement; bukti & perbaikan 2026-10-04 di history.ts/satuan.ts).
* Ikon Lucide autentik inline SVG (`ui/icons.ts`, tanpa runtime dep).
  Teks tombol/stepper: dilarang glyph (`✎×+−`) — pakai ikon.
* Radius: 10px base / 8px sm / pill penuh. Total POS = `#pos-grand` **48px bold
  tabular kustom** (`text-[48px]` arbitrary value — permintaan pemilik
  2026-10-04 "custom ukuran font, besarkan 2x lipat" dari `text-2xl` 24px;
  baris "Grand total" duplikat di sidebar sudah DIHAPUS), struk
  `ui-monospace 13px`.
* Layout: `#app` max-width 100%; admin full-height (`100dvh`, konten scroll
  sendiri, `body.mode-admin` lock); POS grid `1fr 380px`
  (→330px ≤1020px →1 kolom ≤860px); grid produk
  `repeat(auto-fill, minmax(150px, 1fr))`, min-tap produk 96px/stepper 30px.
* Animasi (vanilla, hormat `prefers-reduced-motion`): view fade-slide 180ms,
  scrim modal 180ms masuk / 120ms keluar, modal spring-in 180ms
  `cubic-bezier(.34,1.56,.64,1)` (overshoot halus) / keluar 120ms ease-in,
  toast slide-kanan, drawer 250ms, dropdown 300ms. SweetAlert2 ikut kunci
  yang sama lewat `--swal2-show-animation` / `--swal2-hide-animation`
  (bukan override per-rule — var memang jalur bersih swal). Umpan balik tekan:
  `.btn:active` dan `.sw-btn:active` scale 0.97 / 90ms.

## Pola interaksi baku kasir (jangan diubah tanpa persetujuan)

1. Search selalu autofocus; Enter = tambah hasil pertama (kompatibel scanner barcode
   yang bertindak sebagai keyboard).
2. Tab kategori horizontal scroll; tab aktif = primer solid (#0087FF).
3. Harga dinamis (`price_dynamic=1`): **TANPA dialog** — scan langsung masuk
   dengan harga DEFAULT master, lalu kasir mengubahnya lewat **kolom Harga
   baris keranjang yang berupa input** (`setHarga()`, event `change`, re-key +
   gabung; harga berbeda = baris baru). `askPrice` dihapus 2026-10-06 (*"karena
   harga bisa di ubah inline, modal dynamic harga tidak usah"*). Jangan
   kembalikan `prompt()`/halaman baru/panel harga.
4. Uang selalu format `Rp` id-ID; total hijau besar; kembalian `max(0, tunai-total)`.
5. Setelah bayar/topup: coba `sendToPrinter()` dulu; gagal -> modal struk
   (`showReceiptModal`) + tombol Cetak browser. JANGAN diam saat print gagal.
6. Mode print (`@media print`): hanya modal struk yang tercetak, tombol disembunyikan.
7. Scan bar POS (`apps/web/src/pages/pos.ts`): sintaks **`Qty*Kode`** (mis. `3*PRD00001`
   = 3 pcs) lewat `bacaQtyKode()` — dicopot sebelum pencarian supaya dropdown tetap
   menampilkan produknya; qty eksplisit menang atas chip Qty/F4 untuk baris itu
   **tanpa** mengosongkan preset F4. Aturan yang sama untuk **Enter maupun klik
   baris hasil**; tanpa `*` perilaku lama dipertahankan.
8. Pintasan level document POS: **F1 fokus kolom scan** (KulaPOS `[F1/Cmd+K]`),
   **F8 modal Pending** (dialihkan dari alias scan lama, 2026-10-06), F2 bayar,
   F3 cari, F4 qty berikutnya, F5 bersihkan,
   F6 diskon transaksi, **F7 tahan (Pending)**, **F9 cari pelanggan**
   (`openCariPelanggan()`), **F10 buka
   form bayar**, **F12 bayar pas**, Enter bayar, Esc ke scan, dan **↑↓**
   pindah antar baris keranjang (`pindahBarisKeranjang()` — baris catatan dilewati,
   input catatan dikecualikan karena panah = kursor). Guard: hanya mode `jual` +
   shift terbuka; jangan dicuri untuk keperluan lain (mis. F7 untuk pelanggan).
   Guard lapis kedua: **swal terbuka** (`.swal2-popup` non-toast — konfirmasi
   hutang, pilihan cetak) = seluruh pintasan dilepas; form bayar yang terbuka
   mengizinkan hanya F2/F10/F12 (`.modal-overlay` menemukan form bayar yang
   bisa berada di bawah swal — tanpa guard ini F12 membayar lewat belakang
   dialog konfirmasi).
9. Bayar terbagi dua permukaan (permintaan pemilik 2026-10-04, putaran 5-6):
   **side panel** = `#pos-bayar` (buka form, F10) dan **`#pos-pay-pas` "Bayar
   pas" tepat DI BAWAHNYA** (gaya akhir **gradasi hijau + shadow + hover hijau
   lebih gelap** `bg-linear-to-r from-emerald-500 to-emerald-600 shadow-md
   shadow-emerald-600/40 hover:from-emerald-600 hover:to-emerald-700`,
   `!py-4`, F12 — hover SENADA warna tombol, permintaan 8c "hover tombol F12
   juga ubah ke hijau jangan biru, karena tombolnya warna hijau"; bayar tunai
    persis total SEKALI ketuk tanpa modal); **modal form bayar** =
   `formBayarHtml()` — **putaran 10 (2026-10-05): layout 2 panel ala
   Ravaa POS v1** (referensi `payment-modal.blade.php`, flex 5/7 → grid
   `sm:grid-cols-[5fr_7fr]`, modal `wide` 768px): kolom KIRI = kartu Total
   tagihan border-2 primer `#bayar-total` + kotak pelanggan `#bayar-cust`
   (ikon users) + **kartu metode `data-pay`** gaya `.btn-method-card`
   (ikon wallet/qr/sync, aktif = `!border-primary bg-primary-soft
   !text-primary dark:bg-primary/15`; jangan ubah daftar kelas ini di satu
   tempat saja — `paintFormBayar()` harus toggle persis sama) + petunjuk
   pintasan; kolom KANAN `bg-gray-50` = input besar `#pos-cash` (`text-2xl`
   prefix Rp + tombol × `#bayar-clear`), chip `data-cash` grid 2 kolom,
   kotak KEMBALIAN putus-putus (`#pos-change` kelas dari `kelasPosChange()`,
   satu sumber dengan `paintCart()`) + `#pos-change-ctx`, petunjuk hutang;
   OK footer = `#pos-pay`; metode non-tunai = `#bayar-non-tunai` (toggle
   `hidden`, jangan render ulang HTML). **Putaran 10b (2026-10-05): semua
   tombol + kolom uang dalam modal ~2x** (permintaan pemilik) — kartu
   metode 78px/24px **layout kolom ikon-atas-label-bawah** (horizontal
   @24px tidak muat di kolom 137px), chip 51px/22px, `#pos-cash` 91px/font
   40px + prefix Rp 24px + `!pr-[76px]` (angka tak tertimpa × 56px), footer
   via `classList` di `bukaBayar` (modal lain normal). **Putaran 10c
   (2026-10-05)**: chip "Uang pas" DIHAPUS dari modal (F12 `#pos-pay-pas`
   sudah mengurusi uang persis total → `QUICK_CASH` = 20k/50k/100k/200k),
   chip uang KEMBALI ukuran normal 1x, `#pos-change` font **40px =
   seukuran `#pos-cash`** (kelasPosChange), `#bayar-total` **36px** (+50%).
   **Putaran 10d (2026-10-05)**: chip pecahan **44px/17px** (diperbesar dari
   25/11 — "tombol nominalnya terlalu kecil") + **auto-isi uang pas DIHAPUS**
   — `bukaBayar()` reset `cashIn=0`, kolom uang **default kosong** (tujuan:
   isi uang kurang/lebih), fokus `#pos-cash` tetap.
   **Jebakan**: kelas arbitrary yang MENEMPEL `${` tanpa spasi TIDAK
   di-generate scanner
   Tailwind v4 — selalu spasi sebelum interpolasi template literal.
   **Kecepatan wajib dipertahankan**: fokus `#pos-cash` saat buka (default kosong), klik chip → fokus balik ke
   kolom uang (kasir tinggal Enter), Enter-on-input/F2/F10/F12. untuk kasus
   **uang lebih / uang kurang / metode lain**. Uang kurang boleh jadi HUTANG
   hanya dengan pelanggan terpilih selain "Pelanggan Umum" — konfirmasi swal
   dulu, baru `pay({hutang:true})`; penolakannya = toast barrier lama + fokus
   kolom uang. Id lama (`#pos-cash`, `#pos-pay`, `data-cash`, `#pos-change`,
   `#bayar-tunai`, `#bayar-non-tunai`) tetap dipertahankan supaya pintasan &
   suite test tidak patah.

## Larangan UI

* Tailwind CSS v4 DISETUJUI user 2026-09-25 (alasan: kecepatan bangun kulit;
  hanya CSS build-time via `@tailwindcss/vite`, offline-safe, tanpa CDN).
  Tetap DILARANG: framework JS (React/Vue/Svelte/Electron), chart lib,
  font-icon lib. File CSS = DUA: `styles.css` (token `@theme` + komponen
  bersama `@layer components`) + `pos.css` KHUSUS POS (2026-10-09, pola
  RPOS V1 `pos-system.css` — SELURUH aturan `.pos-*`/`.ptk*`/`.pos-scope`;
  di-link SETELAH styles.css; `@reference "./styles.css"` WAJIB supaya
  `@apply` mengenal token, tanpa itu build gagal "unknown utility").
  Komponen custom via `@layer components` — dilarang deklarasi mentah
  (`justify-content:` dsb) di dalam `@apply` (build gagal); dilarang
  duplikat rule. `pos.css` DILARANG warna/token baru (palet tetap milik
  `styles.css`), `@apply` utility saja — sinkronkan AGENTS.md §2 bila
  aturan cakupan ini berubah.
* DILARANG warna/ukuran baru di luar token tanpa update `styles.css` + daftar di sini.
* DILARANG teks <11px di mana pun. Info penting (total, kembalian, angka stok
  di tabel) minimal **13px** (`text-sm` + bold bila perlu); 11px (`text-xs`)
  hanya untuk label/badge/hint/sub-teks — KECUALI halaman POS: minimum
  **13px di semua teks** (keputusan pemilik 2026-10-09 "text-xs terlalu
  kecil, sementara di POS dulu", lewat `.pos-scope` di `pos.css`).
* DILARANG dialog `confirm()`/`prompt()` baru selain yang sudah ada
  (harga dinamis, modal shift, nama kasir) — ajukan pola inline dulu.
* KONFIRMASI WAJIB lewat SweetAlert2 (`apps/web/src/ui/confirm.ts`), bukan `confirm()`.
  Jebakan yang sudah pernah terjadi: `buttonsStyling: false` membuat SweetAlert2
  TIDAK menata tombol sama sekali dan opsi `confirmButtonColor`/`cancelButtonColor`
  ikut DIABAIKAN. Hasilnya tombol transparan, tanpa padding, dan menempel jadi satu
  baris ("Batal Nonaktifkan") yang dikira user cuma satu tombol. Karena itu gaya
  tombol dipegang `.sw-btn*` di `styles.css` (prefix `.swal2-container` supaya
  menang atas CSS swal yang di-inject tanpa `@layer`).
  Wajib: minimal 2 tombol harus terpisah jarak >= 8px, tinggi >= 40px (sentuh),
  kontras teks >= 4.5:1, dan labelnya tegas ("Ya, nonaktifkan" vs "Batal, jangan diubah").
  Ukur dengan `getComputedStyle` — jangan hanya cek `.textContent` (yang dulu lolos
  padahal tombolnya tak terlihat).
  Ukuran popup diseragamkan dengan modal (2026-09-29, semua di `styles.css`
  lewat var `--swal2-*`): popup `24rem` (384px) radius 16 + shadow-xl,
  backdrop `rgb(24 24 27 / .5)` + blur 4px, judul **13px** semibold (skala
  super-compact 2026-10-04 — 30 → 18 → 14 → 13), isi **13px**,
   ikon box **45px** (font-size 0.5625rem — skalakan `font-size`, bukan cuma box,
   karena geometri glyph ikon memakai `em`; glyph "!" 33.75px = piktogram,
   satu-satunya >13px yang sah), padding judul `.5em 1.25em`,
   aksi `.875em auto 0`. Dark: popup `#18181b`, teks `#a1a1aa`.
* CSS SweetAlert2 di-inject TANPA `@layer`; aturan ber-layer (Tailwind) kalah
  specificity. Naikkan specificity, jangan andalkan urutan.
* Struk layar (modal `<pre>`) dan struk cetak HARUS dari builder yang sama
  (`apps/web/src/escpos.ts`), maks 32 kolom ASCII.

## Cara verifikasi

1. `npm run build -w apps/web` lolos.
2. Cek visual: `npm run dev:web`, buka `http://localhost:5656` di lebar
   desktop (>860px) DAN mobile (~390px) — screenshot bila memungkinkan.
3. Uji alur: tambah item tiap tab -> bayar tunai pas/kurang/lebih -> topup ->
   modal struk muncul -> Cetak browser hanya mencetak struk.
