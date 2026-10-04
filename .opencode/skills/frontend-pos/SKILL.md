---
name: frontend-pos
description: Standar UI/UX kasir Ravaa POS — design token, pola layout kasir touch-friendly, dan aturan konsistensi. Muat setiap tugas menyentuh apps/web.
---

# frontend-pos — standar UI/UX kasir

## Kapan dipakai

Setiap perubahan `apps/web/`: tambah tab/kategori, ubah tombol/form/keranjang,
panel topup/laporan, modal struk, atau styling apa pun.

## Design token (KUNCI — sistem vanilla ala shadcn/bag-ui, `styles.css` + `admin.css`)

* Palet zinc (ganti total 2026-09-25, referensi bag-ui): bg `#fafafa`,
  kartu `#fff`, garis `#e4e4e7`, teks `#18181b`, muted `#71717a`.
  Primer biru `#2563eb` (aksen kasir, hover `#1d4ed8`), sukses `#16a34a`,
  warning `#d97706`, danger `#dc2626`. Stok menipis: teks danger 11px semibold.
  Dark `[data-theme="dark"]` (bg `#09090b`, kartu `#18181b`, garis `#27272a`).
  Font `Inter` self-hosted (`public/fonts/`, offline).
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
* Komponen (vanilla, tanpa framework): `.btn(.btn-primary/.btn-danger/.btn-outline/
  .btn-outline-secondary/.btn-sm/.btn-lg)` **34px** (min-h) / teks 13 semibold,
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
3. Harga dinamis (`price_dynamic=1`) via `prompt()` — sementara, penggantinya harus
   inline stepper/modal, bukan halaman baru.
4. Uang selalu format `Rp` id-ID; total hijau besar; kembalian `max(0, tunai-total)`.
5. Setelah bayar/topup: coba `sendToPrinter()` dulu; gagal -> modal struk
   (`showReceiptModal`) + tombol Cetak browser. JANGAN diam saat print gagal.
6. Mode print (`@media print`): hanya modal struk yang tercetak, tombol disembunyikan.

## Larangan UI

* Tailwind CSS v4 DISETUJUI user 2026-09-25 (alasan: kecepatan bangun kulit;
  hanya CSS build-time via `@tailwindcss/vite`, offline-safe, tanpa CDN).
  Tetap DILARANG: framework JS (React/Vue/Svelte/Electron), chart lib,
  font-icon lib, CSS lain. Komponen custom via `@layer components` di
  `styles.css` — dilarang deklarasi mentah (`justify-content:` dsb) di dalam
  `@apply` (build gagal); dilarang duplikat rule.
* DILARANG warna/ukuran baru di luar token tanpa update `styles.css` + daftar di sini.
* DILARANG teks <11px di mana pun. Info penting (total, kembalian, angka stok
  di tabel) minimal **13px** (`text-sm` + bold bila perlu); 11px (`text-xs`)
  hanya untuk label/badge/hint/sub-teks.
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
