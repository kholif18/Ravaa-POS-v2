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
  warning `#d97706`, danger `#dc2626`. Stok menipis: teks danger 12px semibold.
  Dark `[data-theme="dark"]` (bg `#09090b`, kartu `#18181b`, garis `#27272a`).
  Font `Inter` self-hosted (`public/fonts/`, offline).
* Komponen (vanilla, tanpa framework): `.btn(.btn-primary/.btn-danger/.btn-outline/
  .btn-outline-secondary/.btn-sm/.btn-lg)` 36px/teks 14 medium, `.input/.select`
  40px (deviasi 16px anti-zoom iOS), `.card` radius 10 + shadow-sm,
  `.table` (th 12px uppercase muted), `.badge-*` 12px medium,
  `.modal-overlay(.active) > .modal(.wide)` (zoom-in 160ms),
  sidebar `#sidebar` 240px (`.collapsed` 72px, drawer HP ≤860px) + `.nav-dropdown(.open)`,
  tabs/pills segmented (kontainer muted, aktif kartu shadow-sm).
* Ikon Lucide autentik inline SVG (`ui/icons.ts`, tanpa runtime dep).
  Teks tombol/stepper: dilarang glyph (`✎×+−`) — pakai ikon.
* Radius: 10px base / 8px sm / pill penuh. Total POS 24px semibold tabular,
  struk `ui-monospace 13px`.
* Layout: `#app` max-width 100%; admin full-height (`100dvh`, konten scroll
  sendiri, `body.mode-admin` lock); POS grid `1fr 380px`
  (→330px ≤1020px →1 kolom ≤860px); grid produk
  `repeat(auto-fill, minmax(150px, 1fr))`, min-tap produk 96px/stepper 30px.
* Animasi (vanilla, hormat `prefers-reduced-motion`): view fade-slide 180ms,
  modal zoom 160ms, toast slide-kanan, scrim/drawer 250ms, dropdown 300ms.

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
* DILARANG teks <13px untuk info penting (stok, total, kembalian).
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
