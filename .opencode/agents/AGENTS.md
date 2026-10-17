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
  Produk `price_dynamic=1` wajib kirim harga per transaksi — **scan TANPA
  dialog** (2026-10-06): harga default master langsung masuk keranjang, kasir
  mengubahnya lewat kolom Harga baris; modal `askPrice` DIHAPUS permanen
  (*"karena harga bisa di ubah inline, modal dynamic harga tidak usah"*).

## 2. Arsitektur (peta file)

```
apps/api/src/index.ts    API Hono. SATU-SATUNYA yang boleh tulis DB.
                         **Guard skema 2026-10-18** (setelah `migrate()`):
                         `peringatkanSkema()` mencetak blok peringatan besar
                         saat boot bila DB ketinggalan kolom (lihat db.ts) —
                         jangan dilepas, kasus nyata: halaman 500 "no such
                         column" tanpa petunjuk di laptop pemilik. + **`app.onError`**:
                         error tak tertangkap dibalas **500 JSON `{error}`**
                         (bukan "Internal Server Error" teks polos) — pesan
                         SQLite "no such column / has no column named / no
                         such table" diberi awalan "database tidak sinkron
                         dengan skema (…) — … AGENTS §5", sehingga api.ts
                         menampilkannya sebagai toast yang menjelaskan sebab +
                         arah perbaikan; detail penuh tetap di log server.
                         Diuji `tests/skema-guard-test.mjs` (11 asersi).
apps/api/src/db.ts       Koneksi better-sqlite3 + migrate + seed. DB_PATH default ./data/data.db
                         + **`kolomHilang()`/`peringatkanSkema()`** (guard
                         skema 2026-10-18): parser mini `db/schema.sql`
                         (sadar komentar/string/kurung) -> bandingkan dengan
                         `pragma_table_info` tiap tabel -> daftar kolom yang
                         tidak ada + perintah `ALTER TABLE … ADD COLUMN` siap
                         tempel (PRIMARY KEY/UNIQUE ditandai "migrasi
                         MANUAL"). `migrate()` TIDAK menyentuh tabel yang
                         sudah ada (`CREATE TABLE IF NOT EXISTS`), jadi tanpa
                         guard ini DB lama diam-diam kehilangan kolom baru;
                         peringatan juga dipanggil `seed.ts` supaya "seed ok"
                         tidak menyesatkan. SENGAJA tanpa auto-ALTER
                         (kebijakan §5: migrasi manual).
                         + **`pulihkanDari(file)`** (restore 2026-10-16: copy
                         tmp -> db.close() -> rename -> buang -wal/-shm ->
                         reopen; dipakai POST /api/backup/restore) + helper
                         **`transaksi(fn)`** — WAJIB untuk setiap transaction
                         di index.ts: `db` di-rebind object-nya saat restore,
                         jadi `const tx = db.transaction(...)` di scope modul
                         mengikat koneksi LAMA dan semua tulis lewat tx mati
                         `The database connection is not open` sampai proses
                         API di-restart (bug nyata 2026-10-16; helper membuat
                         transaction per pemanggilan sehingga selalu ikut
                         koneksi aktif — jangan kembalikan ke pola lama).
apps/api/src/seed.ts     Runner seed (idempotent, INSERT OR IGNORE) +
                         `peringatkanSkema()` di akhir (2026-10-18: seed di
                         DB lama "sukses" tapi kolom baru tak terpasang).
db/schema.sql            SUMBER KEBENARAN skema. Ubah skema = edit file ini + migrasi manual.
db/seed.sql              Master awal (8 kategori + contoh SKU).
apps/web/src/main.ts     UI kasir (7+ tab kategori). Semua search/filter lokal.
                         Router hash (`render()` + guard login/peran) — di awal
                         tiap navigasi memanggil `resetAksiBaru()`
                         (ui/aksi-baru.ts) supaya pintasan Alt+N selalu milik
                         halaman yang sedang tampil (2026-10-18).
                         Registrasi service worker HANYA `import.meta.env.PROD`
                         (PWA 2026-10-16) — dev TIDAK boleh di-cache SW.
apps/web/public/sw.js    Service worker PWA (nol dependensi): shell+aset dari
                         cache (`ravaa-shell-v1`; NAIKKAN versi bila isi file
                         berubah), `/api/*`+non-GET+lintas origin SELALU
                         jaringan (data kasir tak boleh basi; outbox tetap
                         jalur tulis offline), navigasi network-first fallback
                         shell `/`. Didukung `manifest.webmanifest` (display
                         standalone; `start_url`/`scope` `/`) + `icons/`
                         (192/512 any + maskable-512 + apple-touch-icon).
                         Diuji `tests/pwa-test.mjs` (build dist + vite
                         preview :4179 + offline reload).
apps/web/src/api.ts      fetch + outbox offline (localStorage, retry 5 detik, id uuid).
                         `updateOutboxBadge()` menghitung `outboxCount()` sekali
                         lalu merawat DUA penampil: `#outbox-badge` (header, lama)
                         + chip POS `a[data-notif-outbox]` di `#pos-notif`
                         (toggles `hidden` + teks `n transaksi antre offline`) —
                         supaya chip notif POS ikut hidup tiap antrean berubah
                          tanpa menunggu repaint POS (revisi 2026-10-08).
apps/web/src/styles.css  Token + gaya BERSAMA Tailwind v4 (`@theme` + `@layer
                          components`) seluruh halaman (SATU sumber token;
                          pendamping khusus POS ada di `pos.css` di bawah).
                          **Restyle 2026-10-08** (arahan pemilik
                          *"style lebih modern, warna lebih hidup seperti
                          KulaPOS"* — kartu/teks/tombol proporsional):
                          primer biru **#1d6df0** (dari #0087ff; kontras putih
                          13px ~4.7:1 lolos AA — #0087ff lama hanya ~3.1:1
                          GAGAL), hover #1757c8, primary-soft #e9f1ff, canvas
                          #f2f5fa, sidebar gradasi biru Sandik (tema terang
                          `#081533 → #0F2858 → #0a1c45` + glow; tema gelap =
                          gradasi netral `#090d17 → #101828 → #0a0f1b` senada
                          kanvas dark — permintaan pemilik 2026-10-18; diuji
                          `tests/sidebar-dark-test.mjs`) + nav aktif = pil
                          biru #1d6df0 ber-shadow; dua token
                          bayangan BARU **--shadow-card** (kartu/tabel/modal)
                          dan **--shadow-pop** (dropdown/toast/lapis melayang).
                          `.btn` radius 10 + focus ring, `.btn-primary` shadow
                          + hover terangkat, `.btn-ghost` soft pill,
                          `.input` border halus + ring-primary 15% saat fokus,
                          `.card`/`.chip`/`.modal` ikut bayangan berlapis.
                          **`.kbd` (2026-10-18)**: badge tombol pintasan
                          keyboard di tombol halaman admin — `inline-flex
                          rounded border border-current px-1 text-xs
                          leading-4 opacity-80`; border `current` supaya
                          menyatu di tombol putih (ghost) maupun biru
                          (primary). Dipakai tombol buat baru `<kbd
                          class="kbd">Alt+N</kbd>` (lihat `ui/aksi-baru.ts`)
                          — SATU komponen, 10 halaman tidak menyalin utility.
                          Aksen teks primer DI DARK = override khusus #6aa5ff
                          (di blok setelah swal — #1d6df0 sebagai teks di kartu
                          gelap hanya ~3.7:1). **Daftar palet ini = `@theme`
                          apa adanya; sinkronkan `.opencode/skills/
                          frontend-pos/SKILL.md` bila token berubah** (aturan
                          skill: dilarang warna baru di luar token).
apps/web/src/pos.css    File gaya KHUSUS POS (baru 2026-10-09 — keputusan
                          pemilik "refactor total halaman POS, buat css baru
                          khusus untuk POS", pola RPOS V1 `pos-system.css`).
                          SELURUH aturan `.pos-*`/`.ptk*`/`.pos-scope` halaman
                          `#/pos` + modal miliknya: info bar `.pos-ibar-grid`
                          (3 kolom sama rata / `.is-stacked` 1 kolom untuk
                          toggle Mobile, garis pemisah di CSS bukan interpolasi
                          inline), scan bar, `.pos-cartbar`, sidebar `.pos-side`
                          (tombol aksi `.pos-qa` 40px), modal topup `.ptk*`
                          (tile berikon 64px, input 44px/15px, `.ptk-totalbox`
                          dipindah ke header di `onMount`), form bayar
                          wide `.pos-bayar` (mockup "Modern Blue Payment
                          Checkout" 2026-10-10: band biru full-bleed +
                          2 kolom kartu + strip trust; opsi solid+cek,
                          textarea catatan+count, pills, ledger BG hidup,
                          footer kanan px-10, resume `.struk-muka`)
                          + `.pos-pay-cards` 3 kolom sama lebar. Di-link di `index.html` SETELAH
                          styles.css (tie-break komponen = urutan link);
                          memakai `@theme` styles.css lewat `@reference
                          "./styles.css"` (WAJIB — tanpanya build gagal
                          "Cannot apply unknown utility class"). **Token tetap
                          milik styles.css — file ini DILARANG warna/token
                          baru, `@apply` utility saja.** Teks minimum POS =
                           `text-sm` (13px via `.pos-scope .label/.chip/.th/
                           .suggest-unit`; keputusan pemilik 2026-10-09
                           "text-xs terlalu kecil, sementara di POS dulu") —
                           halaman lain tetap 11px. **Tombol kembali ⬅
                           (`tombolKembaliHtml`, `.icon-btn` bersama) di bar
                           biru dipaksa PUTIH di kedua tema** (`.pos-ibar-biru
                           .icon-btn`, 2026-10-18 — aturan dasar .icon-btn
                           gray-600 di tema terang nyaris tak terlihat di atas
                           biru; hover ikut putih/15, bukan gray-100+gray-900);
                           diuji `tests/pos-ibar-test.mjs` (7 asersi: light/
                           dark/hover + guard tombol ⬅ header MOBILE yang
                           SENGAJA tidak ikut putih — latarnya putih).
apps/web/src/pos-mobile.css  Gaya KHUSUS tampilan MOBILE POS (baru 2026-10-17,
                          pasangan `pages/pos-mobile.ts`; pola sama dengan
                          pos.css). SELURUH aturan `.pm-*`: kerangka aplikasi
                          edge-to-edge (`.page:has(.pm-shell)` buang padding,
                          scroll pindah ke `.pm-body` — header/bar bayar/
                          navbar selalu terlihat), header (scan 44px +
                          pelanggan + chip notif scroll-x), panel tab (Katalog
                          2 kolom + chip kategori scroll-x), kartu keranjang
                           (`pm-card-head`/`pm-sub`/`pm-ctr` — SATU baris
                          kontrol stepper‖harga‖diskon‖subtotal, ±115px di
                          390px), bar bayar + navbar bawah dengan
                          `env(safe-area-inset-bottom)`. **Seksi 8 lapisan
                          bayar (2026-10-17)**: `.pm-bayarlayer` (fixed
                          inset-0 z-40 — DI BAWAH toast z-60 supaya toast
                          barrier uang terlihat), header ⬅+total, kartu
                          metode `.pm-paypick*` (aktif = utility
                          `!bg-primary !text-white !border-primary` + `.cek`),
                          kolom uang `.pm-cash*`, chip `.pm-cashchip`, ledger
                          `.pm-ledger*`, footer safe-area-bottom. WAJIB:
                          aturan eksplisit `.pm-bayarlayer[hidden]
                          {display:none}` — `@apply flex` mengalahkan UA rule
                          `[hidden]` (tanpa itu lapisan tampil sepanjang
                          waktu). Kelas `.pm-bayar*` DILARANG bocor ke
                          pos.css. Di-link di
                          index.html SETELAH pos.css; `@reference
                          "./styles.css"` WAJIB; token HANYA dari @theme
                          styles.css (DILARANG warna baru), kelas bersama
                          (.btn/.input/.chip/.row-btn/.pos-qa/.pos-cartbar)
                          DIPAKAI ULANG. Pelajaran terukur 2026-10-17: input
                          number `.pm-inp` WAJIB sembunyikan spinner
                          (`::-webkit-inner-spin-button` +
                          `appearance:textfield`) — tanpa itu spinner
                          merampas ±15px di dalam kotak 64px dan placeholder
                          "Diskon" terpotong "Disko". CATATAN: `text-base` di
                          repo = 14px (BUKAN 16px) — bukan penangkal auto-zoom
                          iOS; device fallback toko = Android. Diuji
                          `tests/pos-mobile-test.mjs` (43 asersi).
apps/web/src/store.ts    Cache master IndexedDB + maxVersion (?since= delta sync)
                         + **kv `'holds'` transaksi tertahan POS** (`getHolds()`/
                         `saveHolds()` — per device, P5)
                         + **`ravaa.keranjang` isi keranjang aktif POS**
                         (`getKeranjang()`/`saveKeranjang()` — **localStorage
                         TULIS SINKRON**, putaran 16 — sengaja BUKAN kv
                         IndexedDB seperti holds: kasus kanonik = refresh kilat
                         setelah mutasi, tulisan IndexedDB yang open+tx async
                         bisa terbuang sebelum sampai; pola outbox
                         `ravaa.outbox.v1` memakai localStorage karena alasan
                         sama).
apps/web/src/pages/pos.ts  UI kasir utama (rute POS). **Urutan atas-ke-bawah =
                          referensi KulaPOS (kula-02-transaksi-pos.png):
                          info bar → scan bar (+ Mode) → label keranjang →
                          tabel ‖ sidebar kanan (panel bayar).** Shell POS (`renderPosShell()` di
                          `ui/shell.ts`) **TANPA `<header>` sama sekali**
                          (permintaan pemilik 2026-10-04 "full hapus" — tidak
                          ada judul "Kasir (POS)"). Tombol kembali ke
                           dashboard = `tombolKembaliHtml()` (pos.ts): kiri
                           info bar (**SEMUA mode** — dulu topup/tarik tak
                           punya info bar, revisi pemilik 2026-10-06 "mode
                           topup dan tarik mengapa bagian ini hilang ya?";
                           back duplikat di baris Mode topup DIHAPUS) supaya kasir
                           tidak terkunci di `#/pos`). Scan bar = input `#pos-q` + dropdown
                           cari — input memuat **badge `<kbd>F1</kbd>` di ujung
                           kanan** (`pr-14` + span absolut; putaran 8 2026-10-04,
                           penanda shortcut fokus scan ala KulaPOS
                           `[F1/Cmd+K]`) —
                           (**sintaks `Qty*Kode`**: `3*PRD00001` = 3 pcs —
                           `bacaQtyKode()`, qty eksplisit menang atas chip
                           Qty/F4 dan sengaja TIDAK mengosongkan preset itu;
                           aturan sama untuk Enter & klik hasil; tanpa `*`
                           perilaku lama dipertahankan),                           **info bar** (SEMUA mode sejak revisi 2026-10-06;
                           kolom 2/3 = blok **Pelanggan + F9 PERSIS SAMA di
                           semua mode sejak revisi pemilik 2026-10-07**
                           *"harusnya bagian ini juga tetap sama customer"* —
                           sel "Mode" (judul·jenis) pengganti di topup/tarik
                           **DIHAPUS**; kolom 3 tetap Total belanja (jual) /
                           Total dibayar (topup/tarik — `#pos-grand`/
                           `#pos-owncount` disinkronkan `paintTopup()`).
                           Listener `#pos-shift-tutup`/`#pos-cust-cari`/
                           **`#pos-customer`** semua di `paint()` universal
                           (dulu di `bindCart` = mati di luar mode jual);
                           pintasan **F9 = cari pelanggan semua mode**:
                           kolom kiri =
                          tombol ⬅ + tumpukan dua baris **Waktu** (atas) /
                          **Kasir + Shift** (bawah) — jam live
                          `jamPos()`/`mulaiJam()` — jam lokal konsisten
                          `waktuStruk()`, dihentikan di `unmountPosPage`;
                          **tombol MERAH `#pos-shift-tutup` "Tutup shift"**
                          **di DALAM kolom kiri info bar** (cell tombol ⬅ +
                          tumpukan Waktu/Kasir), menempel ke tepi KANAN cell
                          lewat `ml-auto` — revisi pemilik 2026-10-06 kedua:
                          *"maksudnya tetap di kolom [kiri] … cuma rata kanan,
                          mepet ke kanan"* (versi antara berupa track ke-4 grid
                          `lg:grid-cols-[1fr_1fr_1fr_auto]` di ujung baris
                          DITOLAK/DIGANTI; grid kini `lg:grid-cols-3` sama
                          rata ala putaran 9 — jangan kembalikan track auto
                          atau `[auto_1fr_auto]`);
                          **`dialogTutupShift()` dari `pages/shift-tutup.ts`**
                          — modul BERSAMA dengan halaman `#/shifts`
                          (satu sumber kebenaran `kasSeharusnya()`/
                          `hitungSelisih()`/`ShiftRow`, AGENTS §5); handler
                          `tutupShiftDariPos()` fetch shift segar
                          `GET /api/shifts?status=open&cashier=…`, guard
                          `.modal-overlay:not(.is-closing)`, setelah sukses
                          `loadShift()`+`paint()` → gate "Buka shift dulu";
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
                          lalu scan bar — **baris Mode slot kanan
                          (`ml-auto`)**: mode jual = **notif ringkas
                          `notifModeRow()`** (revisi pemilik 2026-10-07
                          *"notif stok barang habis atau dll"*, direvisi lagi
                          2026-10-08 *"buat agar lebih informatif, dan buat
                          notif lain bukan hanya stok habis"*): pembungkus
                          `#pos-notif` berisi **`notifChips()` enam chip**
                          — (1) `n stok habis` (merah → `#/stock`), (2) `n
                          stok menipis` (kuning → `#/stock`), (3) `n lewat
                          kadaluarsa` (merah → `#/products`), (4) `n
                          kadaluarsa ≤30 hari` (kuning → `#/products`,
                          `AMBAT_EXPIRY`, baru), (5) `n transaksi antre
                          offline` (biru → `#/dashboard`, elemen
                          `data-notif-outbox` **selalu dirender**/`hidden`
                          saat 0, teks+visibilitas disegarkan
                          `updateOutboxBadge()` di api.ts tiap antrean
                          berubah), (6) `Cetak dijeda` (abu → `#/settings`,
                          bila `getPrintPause()`). **Informatif**: tiap chip
                          memuat nama produk PERTAMA (stok/tanggalnya) +
                          `title` daftar penuh (esc sekali). Rincian
                          kadaluarsa tetap di strip di bawah scan bar
                          (`stripKadaluarsa()`); **strip MENIPIS dihapus
                          2026-10-09** — permintaan pemilik "notifikasi ini
                          hapus saja, karena sudah ada [chip]" (duplikat chip
                          kuningnya; jangan kembalikan tanpa persetujuan);
                          **strip STOK HABIS sengaja TIDAK ada** —
                          keputusan pemilik 2026-10-08 (strip merah sempat
                          ditambah lalu *"ini hapus saja karena sudah ada
                          di atasnya di dalam card"*), chip + judulnya
                          menampung info itu. Sumber = cache lokal (pola
                          strip, tanpa API); **`segNotifPos()`** merender
                          ulang `#pos-notif` + `#pos-strips` (wadah beraid,
                          `hidden` bila kosong) dari `segarkanStokPos()`
                          sesudah penjualan, jadi chip ikut menyegar TANPA
                          `paint()` penuh (regresi: `products` dulu hanya
                          dimuat ulang saat mount). Uji
                          `tests/pos-notif-test.mjs` (6 asersi); topup/tarik
                          (mode lama) sudah dihapus 2026-10-08, **label baris
                          di ATAS tabel**
                          (`#pos-count` "n item"/"Keranjang kosong" kiri +
                          `#pos-clear` Bersihkan F5 kanan — dipindah dari
                          bawah tabel 2026-10-04, id tetap), **tabel keranjang
                          8 kolom**
                          (No / Kode / Nama barang / Harga / Qty / Diskon /
                          Subtotal / Aksi — SKU di kolom Kode mono, baris
                          catatan `colspan="3"` (hanya selebar No..Nama
                          barang, pemendekan permintaan pemilik 2026-10-06)
                          & empty `colspan="8"`; **lebar kolom
                          eksplisit** putaran 8 2026-10-04 lalu **DI-COMPACT
                          2026-10-06** ("Harga, QTY, Diskon, sub total, aksi
                          diperkecil compact sesuai ukuran konten, buat kolom
                          nama barang saja yang lebar" — semua hint ukurannya
                          `max(hint, konten)`, jadi angka besar tetap tumbuh
                          tanpa clip): No `w-8`, Kode `w-20`, **Nama barang
                          `w-auto`** = menyerap SELURUH sisa lebar (438 →
                          ±540px terukur, referensi KulaPOS), Harga/Diskon/
                          Subtotal `w-16`, Qty `w-36` (konten stepper 152px
                          yang menang), Aksi `w-10`;
                          **hover per baris KEBIRUAN**
                          `hover:bg-primary-soft dark:hover:bg-primary/15
                          transition-colors` (putaran 8c 2026-10-04 "hover di
                          tabel keranjang ubah jadi kebiru-biruan" — pakai
                          token `--color-primary-soft #e6f3ff`, sama dengan
                          state aktif tombol; riwayat: gray-50 → gray-100 →
                          primary-soft) pada
                           tiap `<tr data-key>`; **input Qty `!w-20 !px-2` +
                           font-semibold** (riwayat: `!w-20` putaran 8 →
                           compact `!w-16` 2026-10-06 → `!w-20 !px-2` kembali
                           setelah diukur **4 digit "1000" ter-capture di
                           w-16**; `!px-2` = sisihkan ruang spinner), input
                           diskon & harga `!w-24 !px-2` (terukur muat 7 digit
                           `1500000` = Rp1.500.000; w-16 lama memotong
                           "2000" jadi "200" — anti-regresi diuji asersi
                           A5/A6 `harga-dinamis-test`),
                           **kolom Harga = INPUT untuk produk harga khusus**
                           (permintaan pemilik 2026-10-06: *"jika produk
                           memiliki harga price 2000 namun switch On, di POS
                           barang tersebut kolom Harga baris keranjang →
                           input … dan bisa di ubah"* — switch = tombol
                           **"Boleh ubah harga saat jual"**
                           `products.price_dynamic` di form produk; produk
                           lain tetap teks `rp(price)` terkunci, event
                           `change` → `setHarga()` seperti Diskon).
                           **Aturan baris (2026-10-06)**: produk sama dengan
                           harga **BERBEDA = baris BARU**, harga **SAMA =
                           qty bertambah** — untuk itu key baris dinamis =
                           `<id>:<unit>:<harga>` (`addLine()`; non-dinamis
                           tetap `<id>:<unit>`), dan `setHarga()` me-re-key
                           baris yang diedit; menabrak baris lain berharga
                           sama → **kuantitas digabung**. Aturan yang sama
                            ditegakkan saat `muatKeranjang()`/`muatHold()`
                            memulihkan baris lama (re-key idempoten + gabung
                            bila key kembar). **Scan TANPA dialog harga —
                            `askPrice` DIHAPUS permanen** (permintaan pemilik
                            2026-10-06: *"karena harga bisa di ubah inline,
                            modal dynamic harga tidak usah"*): produk dinamis
                            masuk lewat jalur `addProduct()` yang SAMA dengan
                            biasa, harga default master (`hargaTampil`)
                            langsung menjadi isi baris lalu kasir mengedit
                            kolom Harga — kontrak `items[].price` tidak
                            berubah. Aturan "batal = harga default" (yang
                            sempat ditambahkan pagi itu) gugur bersama
                            hilangnya dialog; `askNumber` kini hanya melayani
                            dialog **Qty F4**, dengan bugfix yang tetap
                            berlaku: tombol Simpan dahulu hanya `resolve`
                            tanpa `close()` sehingga modal F4 nyangkut
                            terbuka (2026-10-06);
                           chip nominal cepat,
                           chip Qty + tombol
                          Cari (F4 = qty item berikutnya sekali pakai, F3 =
                          layar cari produk; tombol ganda `#pos-manual` di
                          scan bar DIHAPUS putaran 7 karena sudah ada di
                          panel kanan `#pos-qa-manual`), input catatan per
                          baris (produk
                          `use_note`, ikut ke struk via `items[].note`).
                           **Tampilan mobile = UI TERPISAH (2026-10-17)** —
                           permintaan pemilik *"buat halaman POS Mobile view
                           jadi benar-benar mobile view … mobile view ala
                           mobile dengan navbar di bawah"*: saat `mobileMode`
                           NYALA, `paint()` merender `pmShellHtml()` dari
                           **`pages/pos-mobile.ts`** (navbar bawah
                           Keranjang/Katalog/Lainnya; keranjang KARTU, bukan
                           tabel 8 kolom) MENGGANTIKAN layout desktop — bukan
                           lagi "grid dipaksa 1 kolom" (Tahap 5 2026-10-06);
                           `gridUtamaCls()`/`.is-stacked` kini hanya relevan
                           di desktop. Init `mobileMode`: pref
                           `ravaa.mobile-layout` ('1'/'0') MENANG; tanpa pref
                           = otomatis `window.innerWidth < 1024` (HP kasir
                           langsung dapat tampilan mobile, test desktop
                           viewport 1280+ aman). Tombol `#pos-mobile` di DUA
                           tempat (id sama, SATU listener di `paint()`):
                           desktop = scan bar label "Mobile"; mobile = tab
                           Lainnya → kartu "Perangkat ini" label "Tampilan
                           desktop". Toast konfirmasi tiap perpindahan; semua
                           id/data-act lama dipertahankan (kontrak suite).
                           Rincian → entri `pos-mobile.ts`/`pos-mobile.css`
                           di peta ini.
                            **Lapisan bayar MOBILE (2026-10-17, lanjutan
                            pemisahan UI)**: saat `mobileMode`, `bukaBayar()`
                            TIDAK membuka modal — ia menampilkan **lapisan
                            fullscreen `#pm-bayar`** milik pos-mobile.ts
                            (`fixed inset-0 z-40` DI DALAM shell, "seperti
                            bukan modal"; elemen PERSISTEN, toggle atribut
                            `hidden` — sebab `@apply flex` menang atas UA
                            rule, css menulis `.pm-bayarlayer[hidden]
                            {display:none}` eksplisit). Nilai yang tak
                            disentuh paintCart diisi saat buka: `#pos-cash`
                            dari `cashIn`, `#bayar-note`+counter, `#bayar-cust`
                            dari select info bar (label = teks opsi, mis.
                            "Pelanggan Umum · CUS-000001" — sama desktop);
                            lalu `paintCart()` + `paintFormBayar()` (satu
                            sumber, bukan render kedua). Hook id & logika =
                            PERSIS modal desktop lewat helper **`bayarEl()`**
                            (modal desktop ATAU `#pm-bayar`; dipakai
                            `bukaBayar()`/`paintFormBayar()`);
                            `tutupBayar()` menyembunyikan lapisan; fungsi
                            baru **`bindBayarMobile()`** (dipanggil `paint()`
                            cabang mobile setelah `bindPosMobile`) =
                            `bindFormBayar(layar)` +
                            `[data-pm-bayar-tutup]`→`tutupBayar()` +
                            `#pos-pay`→`pay()` + Enter di `#pos-cash`→`pay()`
                            (Enter-on-input desktop dulu kerja modal.ts —
                            lapisan bukan modal). `pmCtx()` menambah
                            metodeAktif/metode/infoBayar/pelangganNama/
                            uangCepat/cashIn/catatan/formatRibu/change/
                            teksKembalian/kelasChange; `PayMethod`
                            di-export (dipakai `import type` pos-mobile).
                            Barrier uang kurang/hutang & `pilihCetakSelesai()`
                            TIDAK berubah — tetap satu jalur `pay()`.
                            Diuji seksi E `tests/pos-mobile-test.mjs`
                            (E1 "bukan .modal-overlay" + E2 rect = viewport).
                            **Panel bayar = SIDEBAR KANAN 320px** (grid
                            `lg:grid-cols-[1fr_320px]` — putaran 4 2026-10-04:
                            footer horizontal DITOLAK pemilik, "tetap jadi
                            sidebar kanan tadi"): **URUTAN 2026-10-06**
                            (permintaan pemilik "diskon item pindah ke bawah
                            menu cepat di atas diskon"): **Aksi cepat** →
                            garis tipis → **Menu cepat** (tombol **Produk** |
                            **Stok** → hash `#/products`/`#/stock`,
                            permintaan "tambahkan tombol cepat ke produk dan
                            stok juga") → garis tipis → ringkasan
                            **Diskon item** saja (baris Subtotal ikut DIHAPUS
                            putaran 7 2026-10-04, "ini juga hapus saja" —
                            subtotal terbaca dari TOTAL BELANJA di info bar)
                            → input
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
                            (`bukaTertahan()`, badge `#pos-hold-count`,
                            pintasan `<kbd>F8</kbd>` sejak 2026-10-06) =
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
                            lama; **Riwayat** (anchor `#/history`,
                            MENGGANTIKAN slot **Voucher** — keputusan pemilik
                            2026-10-06, voucher & PPN ditutup permanen);
                            **Cetak ulang `#pos-reprint` = nota TERAKHIR
                            device ini** (Tahap 2, 2026-10-06): id nota sukses
                            disimpan `ravaa.nota-terakhir` (localStorage per
                            device, ditulis `pay()` saat server konfirmasi) →
                            tombol disabled sampai device punya nota → klik
                            fetch `GET /api/sales/:id` lalu serahkan ke
                            **`cetakUlang()` di-EXPORT dari `history.ts`**
                            (dialog [Thermal][A4][Batal] + susunan struk
                            IDENTIK jalur Riwayat — jangan ditulis ulang di
                            pos.ts, AGENTS §5); tanpa pratinjau "Lihat Struk"
                            (keputusan pemilik 2026-10-06: menyusul/bila jadi
                            digabung ke dialog ini).
                            **Isian bayar = FORM BAYAR (modal)** (putaran 5
                            2026-10-04, permintaan pemilik "pindahkan ke modal
                            ketika klik bayar" — ala payment screen Aronium
                            F10): tombol **Bayar `#pos-bayar` (F10)** membuka
                            `bukaBayar()`; **putaran 10 (2026-10-05) modal
                            dirombak 2 panel ala Ravaa POS v1** — *"modal
                            bayar silakan dengan referensi ravaapos v1 …
                            pendekatan yang sama, tanpa mengurangi kecepatan
                            dalam transaksi, mungkin layout bisa di benahi
                            pada v2 ini"* — referensi `payment-modal.blade.php`
                            + `.payment-layout-wrapper` (flex 5/7):
                            `formBayarHtml()` kini **grid `sm:grid-cols-[5fr_7fr]`**
                            (dihitung 312/436px) dengan modal **`wide`**
                            (768px; `max-w-lg` lama terlalu sempit). KIRI
                            (border kanan): kartu **Total tagihan
                            `#bayar-total`** (border-2 primer, angka 3xl
                            extra-bold) → kotak **Pelanggan `#bayar-cust`**
                            (ikon users + nama · code — penanda alur hutang)
                            → **kartu metode `data-pay` grid 2 kolom** gaya
                            `.btn-method-card` (ikon wallet/qr/sync dari
                            `PAY_METHODS`, aktif = `!border-primary
                            bg-primary-soft !text-primary dark:bg-primary/15`;
                            ikon **`qr` DITAMBAHKAN ke `icons.ts`** — set v2
                            tidak punya ikon QR) → petunjuk pintasan. KANAN
                            (`bg-gray-50`): blok `#bayar-tunai` = label
                            **Uang diterima** + input besar `#pos-cash`
                            (`text-2xl`/700, prefix `Rp`, tombol ×
                            **`#bayar-clear`** ala `btn-clear-huge` v1 —
                            bersihkan + fokus balik, menandai `cashTouched`)
                            → **chip `data-cash` grid 2 kolom** (Uang pas +
                            3 pecahan) → **kotak hasil putus-putus** ala
                            `.payment-section-result` (label KEMBALIAN
                            statis + `#pos-change` kelas dari helper
                            **`kelasPosChange()`** = `text-2xl font-extrabold
                            tabular-nums` + warna `kelasKembalian()` — SATU
                            sumber untuk render awal & `paintCart()`, plus
                            `#pos-change-ctx`) → petunjuk hutang;
                            `#bayar-non-tunai` = teks "Tanpa uang diterima…"
                            (blok tunai/non-tunai dirender SEKALIGUS lalu
                            ditoggle `hidden` lewat `paintFormBayar()` —
                            toggle 4 kelas kartu metode WAJIB persis sama
                            dengan render awal, listener tidak dipasang
                            ulang). **Kecepatan dijaga**: fokus `#pos-cash`
                            saat buka (kolom SELALU default kosong sejak
                            putaran 10d — auto-isi P1 sudah dihapus),
                            Enter-on-input →
                            `ok.click()`, F2/F10/F12, **chip diklik → fokus
                            balik ke `#pos-cash`** (siap Enter; sebelumnya
                            fokus tertinggal di chip). **Semua id lama TANPA
                            perubahan**: `#pos-cash`, `#pos-pay` (tombol OK
                            footer — disetel di `bukaBayar` + listener
                            `pay()`), `data-pay`, `data-cash`, `#pos-change`,
                            `#pos-change-ctx`, `#bayar-tunai`,
                            `#bayar-non-tunai` — F2/Enter/barrier + suite
                            test tetap jalan; `#pos-pay-pas` sengaja TIDAK
                            ikut ke dalam form (tetap side panel, permintaan
                            putaran kedua 2026-10-04).
                            **Putaran 10b (2026-10-05): tombol + uang diterima
                            ~2x** — *"kurang besar untuk tombol-tombol dan uang
                            diterima pada modal, silakan atur untuk lebih besar
                            sekitar 2x lipat"*. Baseline terukur (Playwright;
                            ingat `@theme` repo: `--text-2xl`=20px,
                            `--text-sm`=13px): kartu metode 34px/13px, chip
                            25px/11px, `#pos-cash` 41px/20px, footer 34px/13px.
                            Kini: **kartu metode** ±78px + font 24px, layout
                            berubah ke KOLOM ala `.btn-method-card` v1 (ikon
                            atas + label bawah center, `border-2`) — kolom
                            wajib sebab label horizontal @24px meluber dari
                            kolom 137px; **chip** ±51px + font 22px;
                            **`#pos-cash`** ±91px + font **40px** (2x tepat),
                            prefix `Rp` 24px ala `.payment-input-huge` v1,
                            `!pr-[76px]` menjaga angka berhenti sebelum tombol
                            ×; **tombol ×** 28→56px (ikon `[&>svg]:size-7`);
                            **footer Batal/Bayar** ±68px + font 24px (kelas
                            dipasang di `bukaBayar()` `onMount` — modal lain
                            tetap normal). Jebakan terpecahkan: kelas
                            `!text-[22px]` TIDAK di-generate Tailwind bila
                            menempel `${` tanpa spasi (scanner butuh pembatas)
                            — selalu spasi sebelum interpolasi. Semua id tidak
                            berubah; test tetap 888.
                            **Putaran 10c (2026-10-05)** — *"Jangan ada uang
                            pas, karena sudah ada tombol F12 untuk uang pas,
                            ganti 20.000, tapi tombol uang itu kecilkan 1xnya,
                            kembalian kurang besar seukuran uang diterima,
                            total tagihan di besarkan setengahnya"*: chip
                            **"Uang pas" DIHAPUS** dari modal (`QUICK_CASH` =
                            `[20000, 50000, 100000, 200000]`; `#pos-pay-pas`
                            F12 side panel TIDAK tersentuh), **chip uang
                            kembali ukuran normal 1x** (kelas pembesaran 10b
                            dibuang — 25px/11px), **`#pos-change` font 40px =
                            seukuran `#pos-cash`** (kelas `kelasPosChange()`),
                            **`#bayar-total` 36px** (+50% dari 24px). Test
                            e2e-struk menyesuaikan skenario chip
                            (`[data-cash="20000"]` + ketik manual untuk
                            kembalian Rp0) tanpa mengubah jumlah asersi.
                            **Putaran 10d (2026-10-05)** — *"tombol nominalnya
                            terlalu kecil kalau sekarang, form uang diterima
                            jangan langsung di isi uang pas, karena tujuannya
                            adalah untuk memasukkan nilai uang kurang atau
                            uang lebih jadi default 0 dan auto focus sudah
                            OK"*: **chip pecahan diperbesar** 25px/11px →
                            **44px/17px** (`!min-h-[44px] !px-4 !py-2
                            !text-[17px]` — di antara 1x dan 2x) dan
                            **auto-isi "uang pas" (P1) DIHAPUS**
                            (`isiUangOtomatis()` + semua pemanggilnya dibuang;
                            `bukaBayar()` me-reset `cashIn=0` sehingga kolom
                            uang SELALU terbuka kosong — kasir mengisi sendiri
                            uang kurang/lebihnya; fokus `#pos-cash` saat buka
                            TIDAK berubah; "uang pas" = F12 `#pos-pay-pas`
                            / chip pecahan saja). Test: asersi "auto-isi
                            Rp4.000" diganti "default KOSONG" — jumlah asersi
                            tetap. **`#pos-pay-pas` ("Bayar pas"
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
                            **Uang kurang / uang 0 = HUTANG OTOMATIS**
                            (instruksi pemilik 2026-10-06: "jika uang kurang /
                            uang 0 akan otomatis masuk ke hutang dengan
                            catatan harus terpilih customer" — putaran 12):
                            `pay()` memanggil `cekHutangDiperbolehkan()` —
                            wajib ada pelanggan terpilih DAN bukan bawaan
                            "Pelanggan Umum" (`name` persis /
                            `code = CUS-000001`); lolos -> **langsung**
                            `pay({hutang:true})` melewati barrier
                            **TANPA konfirmasi swal** (dialog lama "Uang
                            kurang — catat jadi hutang?" DIHAPUS) -> penjualan
                            lalu `POST /api/customer-debts`
                            `{type:'charge', amount:sisa,
                            note:'Nota <invoice_no> — sisa bayar POS'}` (gagal
                            ledger = penjualan TETAP sukses + toast penunjuk
                            halaman Hutang). Kasir tahu sisa dari **toast
                            `· hutang RpX (nama)` + baris `Hutang` merah di
                            modal resume + baris `Hutang` di struk**.
                            TIDAK lolos syarat = penolakan barrier lama
                            **persis** (pesan "Uang diterima belum diisi /
                            kurang dari total — <alasan>" + buka form + fokus
                            kolom uang) — jadi uang kurang tidak pernah lolos
                            diam-diam tanpa kontak penampung hutangnya.
                            **SEMUA id lama dipertahankan**
                            (`#pos-cash`, `#pos-pay`, `data-cash`, `#pos-change`)
                            supaya F2/Enter/barrier + suite test tetap jalan.
                           `pay()` kirim `customer_id` + struk meta
                           `Pelanggan: <customer_name>` + reset pilihan ke
                            Pelanggan Umum. Pintasan level document di
                            `bindPintasan()` (**F1 fokus kolom scan** —
                            referensi KulaPOS `[F1/Cmd+K]`; **F8 = modal
                            Pending** sejak 2026-10-06, dialihkan dari alias
                            scan lama — pemilik: "F8 … bisa digunakan untuk
                            membuka modal pending", holds kosong → toast;
                            F2 bayar, F3 cari, F4 qty,
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
                          **MODAL RESUME pasca-bayar (putaran 11,
                          2026-10-05, revisi pemilik 1A: "setelah bayar
                          tambahkan modal resume, dan pilihan print thermal
                          atau A4, begitu juga pada bayar PAS F12")** —
                          **SELALU tampil setelah SETIAP penjualan sukses**
                          (semua jalur lewat `pay()`: tombol Bayar, F2,
                          Enter, **F12 Bayar pas** — tanpa guard
                          `if (autoPrint)`; guard itu yang dahulu hanya
                          memunculkannya saat saklar ON). "Cetak struk
                          otomatis" kini **hanya menentukan apakah tombol
                          Thermal/A4 benar-benar mengirim ke printer**
                           (guard di cabang `pilihCetakSelesai` + `cetak()`;
                           klik saat mati = toast "Cetak sedang mati…").
                           **LACI OTOMATIS (Tahap 4a, 2026-10-06)**: sebelum
                           modal resume dibuka, penjualan **tunai** mengirim
                           kick `bukaLaci()` (`ESC p` via `kirimPrint()`,
                           `bukaLaciOtomatis()`) — **TANPA syarat saklar
                           autoPrint**, segera saat server konfirmasi, hanya
                           tunai (QRIS/transfer tidak), gagal = `console.warn`
                           (tak membatalkan & tak menambah toast).
                           **SEGAR STOK SETELAH JUAL (revisi pemilik
                           2026-10-08 — "stok di bawah nama produk tidak
                           terefresh sehingga seolah-olah stok tidak
                           berkurang")**: segera setelah `POST /api/sales`
                           terkonfirmasi, `pay()` memanggil
                           **`segarkanStokPos()`** — `syncMaster(?since=)` +
                           `products = await getCachedProducts()` (+ gambar
                           ulang dropdown `#pos-results` bila sedang terbuka).
                           Alasan: server SUDAH memotong stok (`stock = stock
                           − qty×factor` + `stock_moves`), tapi array
                           `products` POS dulu hanya dimuat ulang di
                           `mountPosPage()`, jadi suggest scan & modal Cari
                           produk (F3) mempertunjukkan angka basi selama
                           sesi. Gagal/offline = senyap (penjualan tak pernah
                           dibatalkan); cabang layanan-saja tidak memanggilnya
                           (topup/tarik tak menyentuh stok). Diuji section D2
                           `e2e-struk.mjs` (suggest + `#pc-list` sama-sama
                           memuat `sisa <stok server>`).
                           Isi dialog = judul hero **KEMBALIAN** (bila
                          `kembalian > 0`) / "Pembayaran berhasil" —
                          **putaran 11b** (2026-10-05, "kembalian kurang
                          besar"): judul di-HTML dua baris, label "Kembalian"
                          11px uppercase + **ANGKA 48px font-extrabold**
                          (skala TOTAL BELANJA info bar; sweetalert2
                          merender `title` sebagai HTML — `textContent`
                          tetap "Kembalian RpX" untuk test) + **badan
                          resume** `htmlResumePenjualan()` (lewat opsi baru
                          `html` di `choiceDialog`): **subjudul** "Transaksi
                          tersimpan. Siap melayani pelanggan berikutnya."
                          (riset KulaPOS, 2026-10-06 butir 1) → **No.
                          `invoice_no` · jam lokal HH:MM** (tanggal sudah
                          terkandung di nomor; CSS uppercase -> "NO. …") → daftar
                          item `qty × nama` + net per baris (maks 5 baris +
                          "… +N item lainnya") → **Total** bold → baris
                          `Tunai` (uang diterima) / label metode (QRIS/
                          Transfer, total) — pola baris rincian struk.
                          **Tutup: Esc / Selesai / Thermal / A4 semuanya
                          berakhir `focusScan()`** (siap scan transaksi
                          berikutnya). **Esc = tutup langsung (putaran 11c)**
                          — `pay()` memfokus `#pos-q` sesaat setelah dialog
                          dibuka, sementara listener keydown bawaan
                          sweetalert2 menempel di POPUP (Esc dari kolom scan
                          tidak sampai — terbukti empiris); karena itu
                          choiceDialog dipanggil dengan
                          **`keydownListenerCapture: true`** (listener di
                          window capture) + **`returnFocus: false`**
                          (returnFocus swal jangan menimpa focusScan) —
                          dua opsi baru opsional di `ui/confirm.ts`.
                          Snapshot data resume (invoice/items/metode/uang)
                          diambil di call site SEBELUM `cart`/`cashIn`
                          di-reset. Thermal = struk ESC/POS via print-agent,
                          A4 = invoice browser (`cetakInvoice`), pilihan
                          terakhir menyetel pref layout topup berikutnya.
                          Slot swal TIDAK berubah (`.swal2-confirm`=Thermal,
                          `.swal2-deny`=A4, `.swal2-cancel`=Selesai;
                          `focusCancel` -> fokus awal = Selesai) —
                          `tests/e2e-struk.mjs` `pilihCetak()` bergantung
                          padanya; helper `jual()` kini SELALU membaca isi
                          resume + menutup dialog (`pilihan:'Escape'` =
                           tutup via Esc; e2e-struk 133 asersi). Topup/tarik
                           tetap TANPA dialog. Ikon label info bar dipegang CSS
                           `.info-bar svg { size-4 }` di `styles.css` (pola
                           `.chip svg` — `icon()` tidak menulis width/height).
                          **Keranjang PERSISTEN (putaran 16, 2026-10-06,
                          permintaan pemilik: "produk yang berada di keranjang
                          jika kasir pindah ke halaman dashboard atau tidak
                          sengaja terrefresh barang tidak hilang/keranjang
                          tidak kosong")**: snapshot `{items, discount,
                          customerId}` ditulis **sinkron** ke localStorage
                          `ravaa.keranjang` oleh `simpanKeranjang()` pada
                          SETIAP titik mutasi — `addLine`/`setQty`/`setDisc`,
                          input catatan & diskon transaksi & select pelanggan
                          (ketiganya tanpa repaint → tulis eksplisit), pilih
                          F9, item manual, `bersihkanKeranjang`, `muatHold`,
                          `tahanKeranjang` (sinkron pelanggan bawaan), dan
                          reset `pay()` sukses. **Gagal save** = toast
                          sekali-per-sesi, isi memori TETAP (pola
                          `simpanTertahan`). **Restore `muatKeranjang()` di
                          `mountPosPage` HANYA saat `cart` memori kosong**
                          (navigasi hash TANPA reload dokumen mempertahankan
                          memori apa adanya — `cart = []` mentah sudah dibuang
                          dari mount); setelah master customers dimuat:
                          validasi id pelanggan (pola `muatHold`), **buang
                          baris produk tombstone** (kalau dibiarkan `pay()`
                          mentok 400 "produk tidak dikenal"), **samakan harga
                          non-dinamis** ke cache (harga non-dinamis dikunci
                          server), clamp diskon baris ke jumlah baris +
                          `clampDiskonTransaksi()`, dorong `manualSeq` dari
                          key `manual:<n>`, toast **"Keranjang dipulihkan — N
                          baris"**. Uang diterima & mode bayar TIDAK ikut
                          dipersist (kepemilikan uang per pembayaran, bukan
                          per sesi); uang diterima selalu buka kolom kosong
                          (putaran 10d). E2E `tests/e2e-struk.mjs` **section
                          M** (8 asersi, total 133): baseline kosong → isi
                          + reload → pulih (baris/total/diskon/toast) → nav
                          `#/dashboard`↔`#/pos` utuh → Bersihkan persisten;
                           **section H/J kini `#pos-clear` dulu sebelum
                           reload** (cart sengaja penuh di sana untuk uji sync
                           master — tanpa clear, restore menggandakan qty dan
                           barrier menolak dengan total membengkak).
                           **Mount paralel (revisi 2026-10-08, "terasa lemot
                           berpindah dari halaman admin ke POS")**:
                           `mountPosPage` dulu menjalankan 3 roundtrip network
                           **serial** (products → shifts/open → customers) + 2
                           baca IndexedDB sebelum `paint()` pertama —
                           `renderPosShell()` hanya `<main id="page">` kosong,
                           jadi layar POS blank selama rantai itu. Di localhost
                           cepat (~70 ms), tapi di device kasir asli (WiFi toko
                           / ARM / HP) tiap roundtrip 50–300 ms → 150–900 ms
                           blank. Kini keempat tugas itu (**syncMaster +
                           baca cache produk, loadShift, customers, holds**)
                           dijalankan `Promise.all` — critical path jadi
                           **maksimum** antar-task, bukan jumlah. Dependency
                           tetap aman: `muatKeranjang()` (butuh `products`) dan
                           validasi `customerId` (butuh `customers`) dipanggil
                           **setelah** `Promise.all`; state bebas-network
                           (`results`, reset `discount`/`cashIn`/`busy`) di-reset
                           di awal supaya tidak ikut menunggu fetch. Jangan
                           mengembalikan ke berantai tanpa alasan kuat; kalau
                           ada task baru yang butuh hasil task lain, tempatkan
                           setelah `Promise.all`, jangan disisipkan di dalamnya.
                          **Opsi B hybrid — 2 mode dalam 1 transaksi (SELESAI
                          2026-10-07, permintaan pemilik *"PR bisa 2 mode
                          dalam 1 transaksi"* — contoh fotokopi + isi pulsa):**
                          keranjang Penjualan bisa memuat **baris topup**
                          (`cartTopup: TopupLine[]`, array TERPISAH dari
                          `cart` — loop produk/qty/diskon/payload `items[]`
                          tidak disentuh) lewat dialog
                          `openDialogTopupKeranjang()` (tombol **Topup** di
                          Aksi cepat `#pos-qa-topup`; jenis hanya
                          `TOPUP_JENIS` — tarik tetap mode Tarik). Baris
                          membawa `id` uuid STABIL (kunci idempotensi retry:
                          `POST /api/topups` membalas `duplicate:true`),
                          `key topup:<n>`, jenis/nomor/token/nominal/admin;
                          admin pakai saran `suggestAdmin()` sampai kasir
                          mengedit sendiri. Saat bayar `pay()` mengirim
                          **`POST /api/topups` DULU per baris, LALU
                          `POST /api/sales`** (record tetap TERPISAH —
                          nominal bukan omzet, admin = jasa; kontrak §3 tidak
                          berubah), barrier uang = **total gabungan
                          `totalBayar()`** dan **baris topup TIDAK BISA jadi
                          hutang** (uang kurang = tolak + fokus kolom uang;
                          penanda `sisa_hutang` server dihitung dari porsi
                          penjualan saja), `cash_in` nota = `total +
                          kembalian` (invarian server `change = cash_in −
                          total` tetap sah; jalur hutang tanpa topup tetap
                          mengirim uang apa adanya). Satu **struk gabungan**
                          (items produk + baris `Topup <ringkas>`/`Biaya
                          admin`/`Nomor`/`Token` sebelum TOTAL = gabungan) +
                          **resume** memuat baris topup (nominal & admin
                          terpisah) dengan **pilihan A4 disembunyikan saat
                          ada topup** (invoice server tidak memuat topup);
                          keranjang HANYA topup/tarik = jalur layanan-saja
                          (POST topup — server menolak `items` kosong — lalu
                          **modal resume yang SAMA** sejak revisi pemilik
                          2026-10-08 *"resume setelah bayar tidak muncul"*;
                          `saleId = null` sehingga pilihan A4 = **strukA4**
                          lewat print-agent, bukan invoice A4). Persist
                          keranjang/holds ikut
                          `topups` (restore memvalidasi jenis dikenal +
                          nominal > 0; snapshot lama tanpa field = []).
                          Teruji **`tests/e2e-topup-keranjang.mjs` 61
                          asersi** (suite total 985 hijau).
                          **Revisi 2026-10-08 (tarik ikut hybrid + bugfix):**
                          dialog `openDialogTopupKeranjang()` (`Tambah topup
                          / tarik tunai`, tombol Aksi cepat **Topup/Tarik**)
                          punya grup chip `TARIK_JENIS`; baris tarik
                          (`isTarik()`) = uang keluar — ditagih HANYA admin
                          (`tarikTotal()`), dikirim `kind:'tarik'`, badge
                          amber + angka kanan = admin, struk/resume/hold
                          memuat blok tarik (nominal & admin terpisah, kaki
                          "Nominal tarik sudah diserahkan tunai"); barrier
                          menolak hutang untuk SEMUA baris layanan.
                          **Bug "tambah 1 topup masuk 2 baris"** (laporan
                          pemilik 2026-10-08, terbukti probe): 1x Enter =
                          handler `keydown` dialog (api.el === overlay,
                          terdaftar setelah milik modal.ts) + handler bawaan
                          modal.ts (Enter-di-INPUT → ok.click) = `submit()`
                          2x — diperbaiki guard `terkirim` setelah validasi
                          (dialog topup + item manual yang berpola sama;
                          layar cari aman via `stopPropagation`/resolve
                          idempotent).
                          **Mode Topup/Tarik DIHAPUS (2026-10-08, keputusan
                          pemilik: tombol `data-mode` + form mode "sudah
                          tidak diperlukan ... bisa dibersihkan")** — POS
                          kini SATU mode: `pos.ts` kehilangan ±380 baris
                          (state `mode`/`top*`, `topupKiriHtml()`,
                          `bindTopup()`/`paintTopup()`/`submitTopup()`/
                          `bindModeBar()`, `defaultJenis`/`jenisList`/
                          `jenisAktif`/`jenisKode`, `paintBayarAktif()`/
                          `teksKembalianBayar()`/`kembalianBayar()`, semua
                          cabang mode di pay/bayarPas/pintasan/render/info
                          bar/scan bar/sidebar/hold; `bisaBayar()` =
                          `keranjangTerisi()`, `paintAktif()` =
                          `paintCart()`). Pintasan katalog `topup` membuka
                          dialog (`jenisAwal` dari nama). Tombol dialog
                          ~1.5x (chip 39px/16px, footer 51px/20px).
                          `e2e-struk.mjs` B-tail + C ditulis ulang ke dialog
                          (141 asersi); suite total **1003 hijau**.
apps/web/src/pages/pos-mobile.ts  UI POS versi MOBILE (baru 2026-10-17) —
                          satu file render + binding mobile-only, dipanggil
                          dari pos.ts. Kontrak: (a) `PosMobileCtx` dirakit
                          `pmCtx()` (pos.ts) SETIAP render dan berisi snapshot
                          state + aksi (rp/esc/kartu, keranjangTerisi,
                          cariProduk, tambahProduk, …) — pos-mobile TIDAK
                          menyimpan state bisnis; (b) impor SATU ARAH pos.ts
                          → pos-mobile.ts (pos-mobile hanya `import type`
                          CartLine/TopupLine dari './pos'; jangan pernah balik
                          — impor melingkar runtime); (c) id/data-act SAMA
                          dengan desktop (`#pos-q`, `#pos-rows`, `#pos-bayar`,
                          `data-act inc/dec/qty/price/disc/unit/note/del/
                          topup-del`) — seluruh binder pos.ts (bindCart/
                          bindSidebar/bindPintasan) bekerja apa adanya, JANGAN
                          daftarkan ulang di sini; binding mobile-only cuma
                          navbar `[data-pm-tab]` (`tampilTab()`, panel
                          non-aktif `hidden` sejak render pertama) + tab
                          Katalog (cari lokal `#pm-kat-q`, chip
                          `[data-pm-kat]`, tap `[data-pm-prod]` → temukan di
                          `ctx.products` → `tambahProduk()`, lompat ke tab
                          Keranjang bila bukan layanan). Ekspor:
                          `pmShellHtml()`/`pmCartHtml()`/`bindPosMobile()`/
                          `posMobileSegarkan()` (badge stok katalog pasca-jual,
                          dipanggil `segarkanStokPos()`)/`posMobileReset()`
                          (dari `unmountPosPage()`: tab → Keranjang, filter
                          dibuang, ctx dilepas). Keranjang mobile = KARTU
                          ramping head/sub/`pm-ctr` (revisi pemilik
                          2026-10-17 *"card produk pada keranjang belanja
                          terlalu besar, bisa di perpendek tingginya"* — pola
                          aplikasi kasir mobile: satu baris kontrol tanpa
                           label kolom, ±115px di 390). **(d) Lapisan bayar
                           fullscreen `#pm-bayar` (2026-10-17)** — dirender
                           `pmBayarHtml()` di akhir `pmShellHtml` (fungsi
                           internal; TIDAK diimpor pos.ts — markup kelas
                           `.pm-bayar*` gaya di pos-mobile.css), elemen
                           PERSISTEN di-toggle `hidden` oleh
                           `bukaBayar()`/`tutupBayar()` pos.ts; hook id
                           PERSIS modal desktop sehingga `bindFormBayar`/
                           `paintFormBayar`/`pay` berlaku tanpa cabang
                           (binding-nya `bindBayarMobile` pos.ts).
                           Diuji
                           `tests/pos-mobile-test.mjs` (43 asersi).
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
                         **Penanda HUTANG (putaran 13, 2026-10-06)**: baris
                         penjualan dengan field computed `sisa_hutang > 0`
                         (lihat GET /api/sales) menampilkan **chip merah
                         `Hutang RpX`** di kolom Jenis (`chipHutang()` — gaya
                         chip sama dengan halaman Hutang; title memuat
                         pelanggan + nomor nota), rincian nota (kartu
                         Pembayaran `detailJual()`) menampilkan **kotak
                         merah Hutang** + baris "Otomatis tercatat di halaman
                         Hutang — Nota …", dan **chip filter `#h-hutang`** di
                         kepala() menyaring linimasa jadi hanya baris
                          berhutang (client-side lewat `state.hutangOnly`,
                          tanpa reload — sengaja BUKAN elemen `[data-h]` yang
                          ditangkap handler geser tanggal).
                          **Transaksi hibrida jadi satu baris (2026-10-08,
                          permintaan pemilik *"PR bisa 2 mode dalam 1
                          transaksi"* — tampilan Riwayat)**: baris topup/tarik
                          dengan `sale_id` cocok dengan salah satu sale hari
                          itu dirender sebagai **sub-baris di bawah baris
                          induknya** (`subRowHtml()`, pola catatan-note-di-
                          bawah-produk; kolom Total baris utama = omzet
                          penjualan saja, angka topup tampil di sub-barisnya
                          sendiri + jejak `· +N layanan` di Keterangan). Yang
                          `sale_id` null / yatim tetap baris linimasa mandiri
                          seperti dulu. Kelompokkan via `Set` saleIds + `Map`
                         subMap di `baris()`; `renderTabel()` sisipkan
                         `<tr class="topup-subrow">` (tanpa `data-trx`) tepat
                         setelah induknya.
                         **Tombol "Buat retur" (Tahap 2, 2026-10-11)** di kartu
                         Pembayaran `detailJual()` (`data-retur-nota`):
                         `dialogReturNota()` prefill item nota + input qty
                         kembali per baris → `POST /api/returns`
                         (`sale_id` + shift TERBUKA KINI, bukan shift nota
                         asal) — riwayat nota lama tidak diubah, catatan baru
                         masuk `#/returns`.
                         **Penanda RETUR (2026-10-18, permintaan pemilik
                         *"pada Riwayat transaksi, jika ada retur apakah tidak
                         di tandai?"*)**: baris penjualan dengan computed
                         `n_retur > 0` (lihat GET /api/sales) menampilkan
                         **chip amber `Retur RpX`** di kolom Jenis
                         (`chipRetur()` — amber senada badge Tarik: uang
                         KELUAR kembali ke pelanggan; hutang merah = uang
                         belum masuk) + kartu Pembayaran `detailJual()`
                         menampilkan **kotak amber Retur** + baris "`n`× retur
                         pada nota ini — stok kembali masuk, uang kembali ke
                         pelanggan (halaman Retur)". Tidak ada chip filter
                         (belum diminta); retur manual `sale_id` NULL tidak
                         menandai nota mana pun.
 apps/web/src/pages/reports.ts  Halaman #/reports (menu Laporan ala Aronium) —
                           **refactor registry 2026-10-17** (permintaan pemilik
                           "perlu refactor juga halaman report untuk menampung
                           seluruh menu laporan"): menu pindah ke sidebar KIRI
                           (grup Penjualan/Keuangan/Stok) dan SETIAP laporan =
                           satu objek `MenuDef` di registry `MENUS` (label/
                           grup/filter/cari/muat/isi/csv/cetak) — tambah menu
                           baru = tambah SATU objek, bukan cabang if di lima
                           tempat. Enam menu: **Harian | Laba | Kasir | Produk |
                           Piutang | Stok**. Filter menu "rentang" = **TOMBOL
                           rentang tanggal** yang membuka **dropdown
                           date-range 2026-10-17** (permintaan pemilik "date
                           filter seperti downloadan", referensi Blueprint;
                           REVISI pemilik kedua "jadikan dropdown saja jangan
                           seperti modal" — panel `#rp-pop` melayang menempel
                           di bawah tombol, BUKAN overlay modal):
                           preset Hari ini..Tahun lalu + **Kustom** di KIRI,
                           dua kalender (select bulan/tahun + panah; kepala
                           Senin–Minggu) di KANAN, highlight rentang + hover,
                           batas server **366 hari divalidasi di panel**
                           (Terapkan mati + peringatan merah), nilai masuk
                           `state.from/to` hanya saat Terapkan; tutup via
                           klik luar / Esc / Batal / Terapkan (listener
                           document pakai AbortController, pola shell.ts;
                           `tutupPopRentang()` dipanggil juga di `paint()`).
                           Input
                           `#rp-from`/`#rp-to` kini **hidden** (kontrak test
                           membaca rentang berlaku dari situ — jangan
                           dihapus). Aritmetika + sel kalender lewat
                           `ui/waktu.ts`; `kelasHari()`/`bulanHtml()` SATU
                           rumus untuk render & hover. Menu Harian tetap
                           pemilih satu hari (prev/next + chip Hari ini).
                           Kartu menu kiri = KARTU MANDIRI setinggi isinya
                           yang SELURUH kartunya `lg:sticky lg:top-0` —
                           `<aside>` hanya pembungkus tanpa visual yang
                           stretch sebagai CONTAINING BLOCK sticky. Riwayat
                           2026-10-17 (EMPAT putaran): sempat di-stretch
                           setinggi kolom ("tingginya tidak sama dengan yang
                           kanan"); sticky lalu dipindah ke blok isi ("aside
                           jadi tidak sticky lagi"); lalu pemilik menegaskan
                           kartu jangan ikut tinggi kolom (kentara "yang full
                           hanya Harian/Laba") dan "hanya textnya yang sticky"
                           itu salah -> sticky dikembalikan ke KARTUNYA; dan
                           terakhir *"jadikan template untuk semua laporan,
                           agar perilaku dan layout sama persis"* -> inset
                           `top-4` DIGANTI `top-0`. Sebabnya terukur:
                           inset sticky positif membuat kartu tergeser turun
                           `inset` px HANYA bila kolom kanan memberi ruang
                           geser (Harian/Laba/Produk y=72 vs Kasir/Piutang/
                           Stok y=56 — keluhan "di setiap halaman laporan
                           seperti berbeda"); dengan `top-0` posisi kartu
                           identik di KEENAM menu (y=56, sejajar tepi kolom
                           kanan) dan tetap menempel di posisi itu saat
                           digulir (56 -> 56, tanpa lompatan). Diuji 3 asersi
                           `laporan-menu-test.mjs` (kartu mandiri < kolom;
                           sticky utuh; template identik 6 menu atas+tinggi+
                           sejajar kolom kanan). Label grup menu
                           dibedakan dari tombol: label `text-[10px]
                           uppercase tracking-widest text-primary pt-4`
                           vs item `text-sm` (permintaan pemilik "beri
                           warna atau tambahkan gap dari atasnya"). Harian =
                           tampilan
                           lama (DOM dipertahankan) + **grafik batang per jam**
                           (`byHour` 24 ember UTC; DIV `[data-jam]` —
                           SENGAJA bukan tabel supaya urutan tabel kontrak
                           laporan-test tidak bergeser) + kolom **HPP/Laba di
                           "Produk terlaris"** (angka SERVER). **Laba** =
                           kartu omzet/HPP/laba + tabel per hari + per
                           transaksi (200 nota terbaru; `GET /api/reports/
                           profit`). Tiap menu: CSV sendiri + Cetak/PDF lewat
                           `cetakLaporan()` (popup + window.print, simpan PDF
                           dari browser — builder generik `DokLaporan` di
                           invoice.ts: judul + periode + tabel + ringkasan).
                           **SATU-SUMBER DATA**: rumus laba (per produk/per
                           hari/per transaksi) milik SERVER — klien tidak
                           menghitung ulang (dulu Laba produk = amount−hpp di
                           klien, dipindah 2026-10-17). Piutang = kartu
                           Terbentuk/Terbayar/Sisa live (link Hutang); Stok =
                           reorder (saran = min−stok, link Buat PO — TANPA
                           grup supplier, menyusul bila ada mapping
                           produk→supplier).
 apps/web/src/pages/returns.ts  Halaman #/returns (Tahap 2, 2026-10-11):
                          linimasa retur per hari (toolbar tanggal pola
                          expenses.ts) + kartu uang kembali + tabel (klik baris
                          = rincian + tombol Batalkan) + dialog retur manual
                          (cari produk server-side, baris qty/harga prefill) —
                          retur DARI nota lewat tombol di Riwayat, bukan di sini.
 apps/web/src/pages/purchases.ts  Halaman #/purchases (Tahap 3, 2026-10-11):
                          nota PO kulakan — filter status (Semua/Order/
                          Diterima/Batal) + tabel (badge Order/Lunas/Hutang/
                          Batal). **SUB-HALAMAN, bukan modal (2026-10-17 —
                          permintaan pemilik "PO purchasing buat halaman saja
                          jangan modal, rawan terklik di luar modal dan
                          hilang")**: klik baris = `#/purchases/<id>`
                          (rincian HALAMAN penuh: Terima `#pt-bayar` prefill
                          total + `#pt-ok`, Bayar sisa `#pb-amount`/`#pb-ok`
                          INLINE, Batalkan tetap `confirmDialog` swal) dan
                          `#po-new` = `#/purchases/baru` (form PO halaman
                          penuh: `#po-sup`/`#po-q`/`#po-hasil`/`#po-baris`/
                          `#po-note` + `#po-simpan`/`#po-batal`; sukses →
                          toast + `keDaftar()`). `parseRoute` (ui/shell.ts)
                          mencocokkan SEGMEN PERTAMA hash sehingga route induk
                          tetap `purchases` (nav tetap aktif; `subRute()`
                          halaman yang membaca sisa hash). Tombol
                          `[data-po-kembali]` di semua sub-halaman. JANGAN
                          kembalikan ke `openModal` — alasan eksplisit di
                          header file. **Pengingat aging
                          (2026-10-16)**: chip kuning `#po-lewat` ("n lewat 30
                          hari", dari `lewat30` GET /api/purchases) + badge
                          umur per baris (`umur_hari` sejak `received_at`,
                          hanya nota diterima-belum-lunas; "baru" bila <= 0).
                          **Revisi layout 2026-10-17 kedua** (permintaan
                          pemilik "refactor desain layout purchasing, PO, dan
                          /#/purchases/190 agar lebih mudah dibaca" + chip
                          filter "seperti tidak terlihat, begitu juga di
                          laporan" + "pencarian produk buat dropdown saja" +
                          "kebingungan mencari purchasing yang belum lunas"):
                          (1) filter status = segmented **`.chip-tabs`/
                          `.chip-tab`** (+`.is-active`, ditambahkan ke
                          `styles.css` — kontainer muted pil, aktif kartu
                          putih shadow; dipakai juga chip menu `reports.ts`)
                          kini **5 chip termasuk "Belum lunas"**
                          (`[data-pstatus="hutang"]` → server
                          **`?status=hutang`** = received bersisa, computed —
                          bukan status tersimpan); (2) chip `#po-lewat` jadi
                          **`<button>` yang klik = saring "Belum lunas"**
                          (id + logika `hidden` dipertahankan — aging-test
                          bergantung); (3) daftar dapat **kolom Sisa** (merah
                          bila bersisa, `—` bila bukan received) + tanggal
                          `tglPendek` di bawah nomor; (4) form PO: hasil cari
                          = **DROPDOWN `#po-hasil`** (role=listbox, absolute;
                          klik hasil → baris masuk qty 1 + harga beli master,
                          merge produk+harga sama; Enter = hasil pertama;
                          blur 150ms menutup; **klik-lambat 2026-10-18**:
                          mousedown opsi `preventDefault()` — tanpa itu timer
                          blur menyembunyikan dropdown saat tombol ditahan
                          >150ms dan click tak pernah sampai, pola
                          `#pos-results`) + **tabel baris editable**
                          (`data-po-qty`/`data-po-hb`/`data-po-sub`/
                          `data-po-del`, update `#po-total` live tanpa
                          re-render); (5) rincian PO = **tabel barang**
                          (qty/harga beli/sub total) + tfoot
                          Total/Terbayar/Sisa hutang, catatan pindah ke kartu
                          header. `tests/purchase-test.mjs` 42 asersi.
apps/web/src/labelsheet.ts  **Model cetak label (baru 2026-10-17, refactor
                         halaman Label harga)**: LEMBAR label A4/Folio lewat
                         CETAK BROWSER (`window.print()` + `@page` mm), bukan
                         print-agent/ESC/POS lagi. Berisi: encoder barcode SVG
                         EAN-13/EAN-8 + **Code 128 subset B**
                         (`checksumEan`/`kodeBarcode`/`barcodeSvg` — checksum
                         tidak cocok = null, JANGAN digambar;
                         `kode128`/`barcode128Svg`/`MAKS_KODE128` — tabel 107
                         simbol diverifikasi silang dua sumber (JsBarcode +
                         tabel Wikipedia Code 128), vektor uji checksum
                         'PRD00001' = nilai 24 di labelsheet-test),
                         geometri (`ukuranKertas`/`hitungTataLetak`/
                         `hitungHalaman`), builder HTML (`labelHtml`/
                         `lembarHtml`/`htmlLembarSemua`/`CSS_LABEL`), dokumen
                         cetak (`htmlDokumenLabel`/`cetakLabel` — popup
                         diblokir = throw, pemanggil men-toast), setelan
                         PER DEVICE (`ravaa.label` via
                         `getSetelanLabel`/`setSetelanLabel`/
                         `normalisasiSetelan`). Aturan: `perLembar=0` bila
                         setelan tidak sehat (halaman cetak disabled).
                         **Barcode label (revisi pemilik 2026-10-17 kedua:
                         *"barcode pilihan pertama, SKU bagi produk yang tidak
                         memiliki barcode"*, helper `blokBarcode`)**: kolom
                         `barcode` EAN-13/EAN-8 → batang EAN; barcode non-EAN →
                         Code 128; barcode kosong → **SKU sebagai Code 128**
                         (semua produk punya SKU); tak encodable (non-ASCII /
                         > `MAKS_KODE128` = 10 char) atau tak muat lebar isi
                         label (lebar label − padding 2,4 mm − border 0,6 mm) →
                         TEKS `lb-barcode-num` seperti dulu. **SKU TIDAK pernah
                         lewat jalur EAN** — checksum yang dihitung ulang bisa
                         mengubah digit terakhir sehingga hasil scan tak lagi
                         sama persis dengan SKU (POS mencocokkan persis).
                         **Baris kaki `SKU · satuan` DIHAPUS 2026-10-17
                         (revisi ketiga — pemilik: *"di bagian atas barcode
                         dibawah Harga tidak perlu, bisa di hapus"*)**: opsi
                         `isi.sku`/`isi.satuan` ikut dicabut dari `IsiLabel`
                         + baris toggle kartu Sistem (sengaja FULL removal,
                         bukan default-off — setelan lama device masih `true`
                         di localStorage sehingga toggle mati akan tampak
                         "menyala tapi tak berpengaruh"); SKU sudah terbaca
                         di `lb-barcode-num` bawah batang barcode.
                         Diuji `tests/labelsheet-test.ts` (80 asersi).
apps/web/src/pages/labels.ts  Halaman #/labels — **FULL-PAGE** (di luar
                         `AdminRoute`, shell sendiri `renderLabelShell()` di
                         ui/shell.ts; entri sidebar DIHAPUS 2026-10-17, pintu
                         masuk = tombol `#prod-label` di toolbar Produk antara
                         Sinkron & Impor). Kiri ±350px = pengaturan (kertas
                         A4/Folio/kustom + margin, kolom/tinggi/jarak, isi
                         label nama/harga/barcode/garis tepi/harga
                         promo, font, salinan Nx) + pemilihan produk ala
                         KERANJANG (revisi pemilik 2026-10-17 kedua: *"ganti
                         sebagai dropdown saja, jadi teknisnya seperti
                         keranjang belanja"*): kolom cari `#lb-q` + dropdown
                         `#lb-hasil` (pola dropdown `#po-hasil` purchases.ts —
                         klik opsi = MASUK keranjang; opsi terdaftar diberi
                         centang `aria-selected` dan klik-nya no-op; Enter =
                         opsi pertama, Esc/blur 150ms menutup; **klik-lambat
                          2026-10-18** — laporan pemilik "sudah klik produk
                          kok tidak terpilih" di laptop: mousedown opsi
                          `preventDefault()` supaya input tidak blur (tanpa
                          itu timer 150ms menyembunyikan dropdown saat tombol
                          ditahan >150ms dan click tak pernah sampai; pola
                          `#pos-results`) DAN di bawahnya
                         kotak `#lb-dipilih` = produk TERPILIH saja, tiap
                         baris ber-ikon hapus `[data-hapus]` (pola keranjang
                          belanja; `#lb-dipilih [data-hapus]` = hook test);
                          **Keranjang DEFAULT KOSONG (permintaan pemilik
                          2026-10-17: *"buat default kosong, jangan sampai
                          memilih semua produk, jika ada ribuan akan
                          menghambat/menyebabkan system lemot. biar user yang
                          memilihnya sendiri"*) — TIDAK ada auto-centang semua
                          produk layak saat mount (dulu di DUA jalur: cache
                          IndexedDB + `load()` server; keduanya dihapus);
                          `state.pilih` mulai `new Set()` dan hanya berubah
                          lewat aksi user (dropdown/`#lb-pilih`/hapus); pilihan
                          TIDAK dipersist (per kunjungan, seperti sebelumnya).**
                          tombol `#lb-pilih` "Pilih yang tampil (n)" /
                          `#lb-kosong` tetap; `#lb-diluar` melaporkan pilihan
                         di luar filter. Ikon opsi WAJIB `[&>svg]:size-4`
                         (`icon()` tanpa width/height — SVG konteks tanpa rule
                         ukuran = 0px tak terlihat; bug nyata yang juga ada di
                         `#po-hasil` purchases.ts, keduanya sudah diperbaiki
                         + dijaga asersi e2e-label). Kanan = pratinjau
                         lembar live (`#lb-zoom`, zoom fit) + strip info
                         (`#lb-info` sinkron `#lb-head` di header shell).
                         Cetak = `cetakLabel()` (browser print, BUKAN
                         print-agent) tapi TETAP menghormati `getPrintPause()`
                         (chip `#lb-jeda`, toast tolak) + Ctrl+P di-intercept.
                         Repaint parsial (paintHasil/paintDipilih/
                         segarkanPilihan/paintPratinjau/updateRingkas +
                         bindHasil/bindDipilih) supaya fokus input tidak
                          hilang; listener dokumen
                         via pageAbort (resize + Ctrl+P). Diuji
                         `tests/e2e-label.mjs` (49 asersi — termasuk produk
                         uji tanpa barcode: SKU tampil sebagai Code 128, dan
                         asersi anti-regresi keranjang default kosong + klik
                         lambat >150ms tetap memilih).
apps/web/src/pages/audit.ts  Halaman #/audit (menu Jejak Audit, 2026-10-16,
                         khusus owner): tabel audit_log dari GET /api/audit
                         (chip jumlah `#audit-count`, filter entity/action +
                         cari `#audit-q` multi-kata + tanggal), klik baris =
                         modal detail read-only (pola riwayatForm — satu
                         tombol "Tutup"; baris tanpa detail aman dibuka).
apps/web/src/pages/settings.ts  Halaman #/settings (menu Sistem): **Redesign
                          layout 2026-10-16** (permintaan pemilik "lebih user
                          friendly") — empat seksi berkepala `kepalaSeksi()`
                          (label .form-sec + garis + hint cakupan "berlaku
                          semua device" vs "tersimpan di browser ini"):
                          Aturan transaksi (kartu saklar seragam
                          `kartuSaklar()`: tile ikon + desc + footer "Dibaca
                          server pada setiap penjualan" + switch; baris
                          "Sedang berlaku." dibuang — label switch sendiri
                          sudah Aktif/Nonaktif), Identitas toko, Perangkat ini
                          (Tampilan perangkat + Cetak struk `xl:grid-cols-2`;
                          Cetak struk = 3 baris berlabel: Jeda `#set-pause` /
                          Cetak otomatis `#set-cetak` / Layout `#set-layout`),
                          Backup & pemulihan (daftar full-width di bawah
                          header; tombol `w-full sm:w-auto` supaya mobile
                          tidak menghimpit teks). SEMUA id + teks kontrak test
                          & logika TIDAK berubah. Isinya tetap: DUA kartu
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
                           — sejak putaran 11 2026-10-05 hanya IZIN kirim ke
                           printer, modal resume+tetap tampil tiap penjualan —
                           + select layout thermal/A4 + **saklar "Jeda semua
                           cetak" `#set-pause`** (2026-10-06: default PAUSED,
                           lihat getPrintPause), tanpa swal & tanpa API —
                           printer tiap PC kasir beda, jangan dipindah ke
                           server), PLUS kartu
                           **Backup data** (tombol "Backup sekarang" ->
                           POST /api/backup + daftar file + Unduh per baris dari
                           GET /api/backup; tanpa swal — non-destruktif; daftar
                           gagal-muat tidak mematahkan halaman; **sejak
                           2026-10-16 tombol "Pulihkan" per baris backup**
                           `[data-restore]` -> swal konfirmasi -> POST
                           /api/backup/restore; copy di dialog menjelaskan
                           otomatis backup pengaman + sesi login bisa ikut
                           kembali ke snapshot (device lain mungkin logout)).
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
                           **Layout A4 (putaran 15, 2026-10-06)**: ringkas
                           bawah **`Total dihutang` / `Total dibayar` /
                           `Sisa hutang` (atau `Sisa (lunas)`)** = **`<table
                           class="ringkas">` garis-bawah-saja** (label tebal,
                           nilai rata kanan, baris terakhir ditutup garis #444
                           + tebal) — **`.kotak` DIYAKIN PEMILIK** ("jangan box
                           seperti itu"); **striping `tr:nth-child(even)`**
                           di SEMUA tabel dokumen (`table.ledger` + 
                           `table.ringkas`) dengan `print-color-adjust: exact`
                           di body supaya arsiran tetap keluar walau opsi
                           "Background graphics" cetak mati. Diuji
                           `customer-debt-test.mjs` section 11 (popup A4:
                           tabel 3 baris tanpa `kotak` + kedua aturan
                           striping ada).
                           **Pengingat aging (2026-10-16)**: chip kuning
                           `#hutang-lewat` ("n lewat 30 hari", dari field
                           `lewat30` GET /api/customer-debts) + badge umur
                           per baris (`umur_hari` — hutang TERTUA yang masih
                           terbuka, FIFO; merah bila >= 30, "hari ini" bila
                           <= 0). Angka = cermin API, jangan dihitung ulang
                           di klien.
apps/web/src/escpos.ts   ESC/POS: STRUK DUA LAYOUT + POST ke print-agent
                          (**label harga DIHAPUS dari file ini 2026-10-17** —
                          refactor halaman Label ke cetak lembar browser,
                          lihat labelsheet.ts; jangan kembalikan
                          labelHarga/teksLabel/gabungLabel/sesuaikanPrinter)
                          + **`bukaLaci()` (Tahap 4a 2026-10-06)** — kick
                          `ESC p 00 19 FA` (5 byte) dibuka OTOMATIS tiap
                          penjualan TUNAI sukses lewat `bukaLaciOtomatis()`
                          di pos.ts, TANPA syarat saklar autoPrint (laci ≠
                          cetak); QRIS/transfer tidak kick; gagal = warn
                          console saja. Jangan gabungkan kick ke stream struk.
                          Layout struk: `thermal` 32 kolom (COLS) ekor FEED+CUT —
                          bawaan toko; `a4` 64 kolom (COLS_A4) ekor FEED+Form
                          Feed 0x0C TANPA CUT — untuk Epson L3110 (inkjet tanpa
                          pisau; tanpa FF kertas menumpuk di dalam).
                          **Sejak 2026-10-03 pilihan A4 penjualan = invoice
                          browser (`invoice.ts`), BUKAN struk ini** — `strukA4()`
                          kini hanya dipakai struk topup/tarik saat pref layout
                          `a4` dan tetap diuji unit di `escpos-test.ts`.
                           Pemilihan: strukUntuk() (panggil dari tiap pencetakan
                           struk), pref di ui/print-pref.ts.
                           Berisi: struk (struk thermal/strukA4/StrukBaris), ascii()/potong/baris
                           dua kolom, kirimPrint() + urlAgent() (`ravaa.printagent`,
                          default :9100). Dipanggil dari pay()/submitTopup() POS. PENTING: `teks()` tidak
                         menambah baris baru — setiap baris struk HARUS diakhiri
                         LF, kalau tidak seluruh struk menempel jadi satu baris.
                         **Token PLN DOUBLE-HEIGHT (2026-10-08)**: `StrukBaris`
                         punya flag opsional **`besar?: boolean`** — baris
                         `besar` dirender `GS ! 0x01` (tinggi 2x, lebar 1x)
                         + `ALIGN center` + BOLD, full-width rata tengah, lalu
                         reset `ALIGN(0)`/`SIZE(1,1)` sebelum baris berikutnya.
                         Dipakai **baris `Token`** di `barisStrukTopup()`
                         (`pos.ts`) supaya nomor token ±20 digit MUAT UTUH
                         (dulu `duaKiriKanan` memotongnya ke kolom kanan 14
                         char = terpotong — bug nyata). Berlaku di struk
                         `thermal` (32 kolom) DAN `strukA4` (64 kolom); baris
                         `besar` di-`tengah()` ke lebar penuh masing-masing
                         layout. `tests/escpos-test.ts` `teksDari` me-skip
                         perintah GS (2 byte) sehingga byte SIZE tidak bocor
                         ke asersi kolom; test struk lama tanpa baris `besar`
                         tetap lolos.
 apps/web/src/invoice.ts  **INVOICE A4 gaya Aronium** (baru 2026-10-03):
                          `htmlInvoice(sale, items, toko, piutang?)` menyusun
                          HTML + CSS `@page A4 margin 16mm 14mm` (kop INVOICE +
                          nama/alamat/Phone/Email dari `store_*` + logo lingkaran
                          "R", Bill to = `sale.customer_name` snapshot ("Pelanggan
                          Umum" bila kosong), Invoice No. = `sales.invoice_no`,
                          **Payment status `Lunas`/`Belum lunas`** (putaran 14:
                          `Belum lunas` bila `sale.sisa_hutang > 0`), tabel item
                          + baris `* note`, ringkasan Discount/Total, footer
                          "Dicetak dari Ravaa POS").
                          **HUTANG di invoice (putaran 14, 2026-10-06 —
                          "tambahkan hutang jika pelanggan berhutang")**:
                          (a) baris **`Hutang:` merah** di rincian Payment
                          method memuat `sale.sisa_hutang` (snapshot nota INI,
                          antara Paid amount dan Change) bila > 0; (b) baris
                          kotak **`Sisa hutang (semua nota)`** = param `piutang`
                          (sisa ledger `GET /api/customer-debts/:customerId`,
                          diambil `cetakInvoice()` bila `sale.customer_id` ada —
                          gagal dimuat -> 0, cetak TIDAK dibatalkan) bila > 0
                          DAN ≠ hutang nota ini (supaya tidak dobel). `cetakInvoice(saleId)`
                          = fetch `GET /api/sales/:id` + `GET /api/settings` +
                          ledger piutang (paralel) -> window.open
                          -> document.write -> `window.print()` otomatis saat
                          load. **Tanpa print-agent** (rendering HTML tidak bisa
                          diserahkan ke server nol-dependensi — cetak lewat
                          browser/CUPS `lp -d EPSON-L3110-Series`). Lempar Error
                          bila popup diblokir (POS men-toast, penjualan TIDAK
                          dibatalkan). Dipanggil dari POS (dialog A4) & Riwayat.
 apps/web/src/ui/auth-screen.ts  Kerangka layar auth (login & ubah-sandi):
                          `authLayarHtml(kartu)` — SATU markup untuk dua
                          halaman (pola shift-tutup.ts). Gradasi biru
                          full-bleed (`.page:has(.login-bg)` p-0 di
                          styles.css) + grid 1 kolom HP / 2 kolom >=lg
                          (brand kiri, kartu kanan); `m-auto` = satu-satunya
                          pemusat vertikal (rantai min-h-full bersarang lama
                          tidak teresolusi — kartu terukur mentok atas
                          top=28px; margin-auto juga aman saat konten lebih
                          tinggi dari layar). Restyle 2026-10-17 (pemilik
                          "layout halaman login jadi lebih responsif dan
                          modern") — ID kontrak test (#login-*/#gs-*) tidak
                          berubah. `.login-btn` (styles.css) = tombol putih
                          solid, SENGAJA bukan .btn-primary (background-image
                          gradiennya tak bisa ditimpa !bg-white — bug tombol
                          "tak terlihat" biru-di-atas-biru, ditemukan &
                          diperbaiki 2026-10-17; dulu juga diam di
                          ubah-sandi).
apps/web/src/ui/confirm.ts  Swal wrapper repo: `confirmDialog()` (ya/batal,
                          konfirmasi destruktif), `alertDialog()` (satu tombol),
                          dan **`choiceDialog({title,message,choices,cancelLabel})`**
                          (baru 2026-10-03, resolve `key` choice | null) — SweetAlert2
                          punya tepat 3 slot (confirm/deny/cancel), jadi maks 3
                          pilihan. Dipakai pilihan cetak POS/Riwayat. Jangan pakai
                          `confirm()`/`prompt()` native (dilarang frontend-pos).
                          **`heightAuto: false` WAJIB tetap di mixin `base`**
                          (perbaikan pemilik 2026-10-08 *"sidebar kanan
                          berubah … tombol Bayar F10 dan F12 naik mepet ke
                          atas"*): default `heightAuto:true` memasang class
                          `swal2-height-auto` ke `<html>`+`<body>` tiap dialog
                          backdrop terbuka, dan CSS bawaan
                          `body.swal2-height-auto { height:auto !important }`
                          meruntuhkan rantai `html/body/#app{h-full}` ->
                          `.page flex-1` (terukur 900 -> 660px), card sidebar
                          POS 782 -> 542px, sehingga blok `mt-auto` tombol
                          Bayar/Bayar pas kehilangan ruang bebasnya. Uji
                          regresi visual: ukur `#pos-bayar` saat swal terbuka
                          harus identik kondisi normal.
apps/web/src/ui/switch.ts  Saklar checkbox bergaya (label + toggle) dipakai form
                          produk, panel mode POS, dan kartu Sistem.
apps/web/src/ui/aksi-baru.ts  **Pintasan Alt+N "buat baru" (2026-10-18,
                           permintaan pemilik: "tambahkan shortcut setiap
                           halaman yang ada buat baru … menggunakan Alt + N
                           untuk membuka modal buat baru atau masuk ke halaman
                           buat baru pada masing-masing tampilan guna
                           mempercepat kinerja")** — REGISTRY, bukan listener
                           per halaman: `pasangAksiBaru(fn)` didaftarkan dari
                           `mountXPage` tepat di samping binding tombol buat
                           barunya (closure yang SAMA supaya perilaku identik),
                           `resetAksiBaru()` dipanggil router di baris pertama
                           `render()` (main.ts) tiap navigasi supaya aksi
                           halaman lama tidak bocor. SATU listener `keydown`
                           capture di document: match `altKey && !ctrl/meta/
                           shift` + `key==='n'` (cadangan `code==='KeyN'`),
                           abaikan `repeat`; **guard dialog** —
                           `.modal-overlay:not(.is-closing)` atau
                           `.swal2-popup` terbuka = abaikan (tidak menumpuk
                           modal kedua). Halaman terpasang: Pelanggan,
                           Supplier, Hutang (`catatForm('charge')`),
                           Pengeluaran, Pengguna, Satuan, Produk
                           (`productForm('new', …)`), Retur
                           (`dialogManual()`), Shift (`dialogBuka()`),
                           Pembelian (`location.hash='#/purchases/baru'` —
                           halaman penuh, bukan modal). Sengaja TIDAK
                           didaftarkan: Dashboard/Laporan/Sistem/Audit/
                           Riwayat/Stok/Label/POS (tidak punya "buat baru"
                           tingkat halaman). Tombol buat baru memuat hint
                           `<kbd class="kbd">Alt+N</kbd>` + title. Diuji
                           `tests/altn-test.mjs` (17 asersi: hint, 9 halaman
                           modal/halaman, guard tidak menumpuk, Esc, halaman
                           tanpa aksi, tanpa pageerror).
apps/web/src/ui/print-pref.ts  Preferensi cetak PER DEVICE (localStorage):
                           getAutoPrint/setAutoPrint (`ravaa.cetak`, default
                           nyala — matikan lewat panel Sistem -> Cetak struk
                           atau scan bar POS; penjualan TIDAK PERNAH dibatalkan
                           oleh gagal cetak) dan getStrukLayout/setStrukLayout
                           (`ravaa.struklayout` = `thermal`|`a4`, default
                           `thermal`). `a4` = pref struk topup/tarik + pilihan
                           terakhir dialog cetak (A4 penjualan sendiri lewat
                           `invoice.ts`, bukan struk ESC/POS).
                           **`getPrintPause/setPrintPause` (`ravaa.printpause`,
                           pemilik 2026-10-06 "jangan print dulu sebelum saya
                           perintah — menghabiskan kertas")**: default **PAUSED**
                           (kunci absen = jeda; harus set false untuk nyala) →
                            `kirimPrint()` melempar Error SEBELUM fetch: struk
                            & kick laci nol request ke print-agent; halaman
                            Label (#/labels) juga menolak klik Cetak (toast)
                            selama jeda walau jalurnya cetak browser; nyalakan
                            lewat saklar "Jeda semua cetak" di kartu Cetak struk
                            (settings.ts `#set-pause`). Test yang memang mau
                            memverifikasi payload harus set `'0'` via
                           addInitScript + route-mock `**/print` (jangan sampai
                           menyentuh :9100 — biang kertas dulu = history-test
                           klik [Thermal] menulis struk asli ke /dev/usb/lp0 tiap
                           `npm test`). SATU sumber untuk
                           panel Sistem + scan bar
                           POS + strukUntuk() + halaman Label — jangan baca
                           localStorage langsung dari halaman lain.
apps/web/src/ui/waktu.ts  Tanggal/jam bersama: waktu()/jam() (tampil UTC apa
                         adanya), hariIni()/geser()/tglPanjang()/tglPendek()/
                         hariPendek() + **awalMinggu()/awalBulan()/akhirBulan()**
                         (2026-10-17 — dasar preset dialog rentang halaman
                         Laporan: minggu ala Indonesia Senin–Minggu) — SATU
                         aturan hari UTC untuk Riwayat, Laporan, dan Dashboard
                         (jangan tulis ulang di halaman baru: aritmetika
                         tanggal harus lewat file ini).
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
  - `GET /api/customers?q=&limit=&offset=` -> `{data:[{id,code,tier,name,phone,address,note,created_at,updated_at}], total}`
    - `q` opsional, multi-kata (SEMUA kata harus cocok di `name`/`phone`/`note`,
      pola search produk — tidak harus di field atau urutan yang sama).
    - Urutan `name COLLATE NOCASE, id`; `limit` default 50 maks 200,
      `offset` default 0 (pola shifts/sales, 2026-10-11); `total` = baris
      COCOK filter (tanpa limit) — footer "A–B dari N".
    - **Pager UI (2026-10-11, pola acuan halaman lain)** — footer tabel
      konvensional (bukan infinite-scroll): komponen bersama `ui/pager.ts`
      (`PAGE_SIZE=20` bawaan, `PAGE_CHOICES=[10,20,50,100]`): kiri = info
      "Hal X dari Y · A–B dari N" + select "Tampil N" (`bindPagerLimit`),
      kanan = nomor halaman (`‹ 1 … 4 5 6 … 20 ›`, `bindPager`, halaman aktif
      `aria-current` + disabled). Dipakai customers, suppliers, debts, shifts,
      purchases, returns, expenses, history (client-side: fetch penuh
      MAKS/sumber sekali per tanggal lalu potong 20 induk/halaman — sub-baris
      hybrid menempel induknya; Produk & Stok = infinite scroll, tetap jangan
      disamakan; Satuan = tanpa pager, master 14 baris).
      RESET offset=0 setiap filter/cari/tanggal/status/limit berubah.
    - **`code` / `address` (revisi pemilik 2026-10-04)**: `code` = no customer
      auto (`CUS-000001`), `address` = alamat pelanggan. Baris lama bernomor
      `''` tampil sebagai `—` dan diisi server saat pertama disimpan ulang.
      Kolom `supplier_no` **DICABUT 2026-10-11** (perintah pemilik — pindah ke
      master `suppliers` di bawah).
  - `POST /api/customers` `{id?,name,phone?,address?,note?,tier?}` -> 201 baru / 200 update
    - **`tier` (`ecer`|`grosir`, 2026-10-11)**: tak dikirim = pertahankan lama
      (update) / `ecer` (insert); selain dua itu → 400. POS memakai
      `price_grosir` bila pelanggan terpilih grosir (chip "Grosir" di info
      bar); baris lama tak di-reprice, baris baru ikut tier.
    - `id` dikirim = update (404 bila tak ada), tanpa id = insert baru.
      **Sengaja TIDAK upsert by phone** — dua orang bisa berbagi nomor
      (keluarga/karyawan toko), nomor bukan kunci identitas.
    - `name` wajib non-kosong (trim) -> 400 `"nama pelanggan wajib diisi"`.
    - `phone`/`address`/`note` teks bebas (default `''`); `updated_at` di-set
      ulang saat update. `id` harus integer bila dikirim -> selain itu 400.
    - **Nomor urut OTOMATIS di server** (`nomorUrut(tabel,kolom,pref)`,
      digeneralisasi 2026-10-11 — dulu `nomorUrutPelanggan` khusus customers):
      `code` -> `CUS-<6 digit>`, di-assign saat INSERT;
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
  - **Supplier (master pemasok, baru 2026-10-11, halaman `#/suppliers`)** —
    lahir dari pencabutan `customers.supplier_no`: nomor `SUP-000001` kini
    menjadi `code` master ini. Dipakai Tahap 3 Pembelian sebagai pilihan
    pemasok. Read-only terhadap `products.version`.
    - `GET /api/suppliers?q=&limit=&offset=` -> `{data:[{id,code,name,phone,address,note,created_at,updated_at}], total}`
      (`q` multi-kata name/phone/note, urutan `name COLLATE NOCASE, id`,
      `limit`/`offset` + `total` cocok-filter — pola persis
      `GET /api/customers`, termasuk pager UI).
    - `POST /api/suppliers` `{id?,name,phone?,address?,note?}` -> 201/200
      (validasi & penomoran `SUP-<6 digit>` via `nomorUrut` persis customers;
      **sengaja TIDAK upsert by phone**, alasan sama).
  - `DELETE /api/suppliers/:id` -> `{data:{id,deleted:true}}` — hapus
    LANGSUNG (belum ada tabel yang mereferensinya; Tahap 3 **wajib**
    menambah guard 400 seperti hapus pelanggan berhutang).
  - **Retur penjualan (Tahap 2, 2026-10-11, halaman `#/returns` + tombol per
    nota di `#/history`)** — barang kembali (stok += qty) + uang tunai kembali
    (kurangi laci bila terikat shift — keputusan pemilik (a)). Satu
    `db.transaction` (`simpanRetur`, pola restock/hutang).
    - `POST /api/returns` `{sale_id?,items:[{sale_item_id?,product_id?,qty>0,price?}],note?≤200,cashier?,shift_id?}`
      -> 201 `{data:{retur,items}}`. Baris ber-nota: harga/nama SNAPSHOT dari
      `sale_items` (uang kembali = harga saat jual), `qty ≤ terjual − sudah
      diretura` (400 `"baris N: melebihi sisa..."`); baris manual: produk harus
      ada + `price` wajib (400 bila ditebak). Stok kembali HANYA
      `track_stock=1` (+`version++` + `stock_moves reason='retur'`,
      `unit_cost=avg_cost`); uang dihitung semua baris. `shift_id` opsional
      (harus ada bila dikirim, 400 `"shift tidak dikenal"`); maks 200 baris.
    - `GET /api/returns?date=&limit=&offset=` -> `{data:[{...,invoice_no,n_items}], total, jumlah}`
      (`jumlah` = uang kembali hari itu; `invoice_no` via LEFT JOIN sales).
    - `GET /api/returns/:id` -> `{data:{retur,items}}`.
    - `DELETE /api/returns/:id` (batal salah ketik): stok KELUAR lagi
      (mutasi lawan `reason='retur'` qty negatif, `ref_id='batal-<id>'`) lalu
      baris dihapus, satu transaction; stok tak cukup → 400 (kecuali
      `allow_negative_stock=1`), tak ada → 404.
    - Laci: yang terikat `shift_id` mengurangi expected-cash
      (`n_retur`/`retur_total` di `GET /api/shifts` → `kasSeharusnya()`);
      rekap harian `GET /api/reports/daily` (`retur:{n,total}` — kartu Retur +
      Omzet bersih hybrid, tidak menggerus laba).
  - **Pembelian / kulakan (Tahap 3, 2026-10-11, halaman `#/purchases`)** —
    nota PO: order → receive → pay/cancel. Satu `db.transaction` per aksi.
    - `POST /api/purchases` `{supplier_id?,items:[{product_id,qty>0,harga_beli>=0}],note?≤200,cashier?}`
      -> 201 `{data:{purchase,status:'order',terbayar:0},items}}`. Supplier
      harus ada bila dikirim (404, nama di-snapshot); item HANYA barang fisik
      (`track_stock=1`, 400 untuk jasa — pola restock); total = Σ; TANPA stok.
    - `POST /api/purchases/:id/receive` `{shift_id?,dibayar?=total,cashier?}`
      -> 200. Hanya dari `order` (400 bila `received`/`cancel`); per item rumus
      **sama persis** restock (`avg_cost` tertimbang + `stock+=qty` +
      `version++` + `stock_moves reason='beli'`, `unit_cost=harga_beli`,
      `ref_id='PO-<id>'`); `dibayar` bulat 0..total (default = total = tunai
      penuh; kurang = sisa hutang — keputusan pemilik (b)); `shift_id` harus
      ada bila dikirim (400); produk yang hilang di tengah jalan → 400.
    - `POST /api/purchases/:id/pay` `{amount>0}` -> 200 (`terbayar+=amount`,
      maks total — 400 `"melebihi sisa hutang..."`); hanya `received`.
      Kas susulan diatribusikan ke `shift_id` PO (satu PO satu laci).
    - `POST /api/purchases/:id/cancel` -> 200 (hanya `order`; received tak bisa
      batal — koreksi stok via opname). Tak ada DELETE (nota PO = arsip).
    - `GET /api/purchases?status=order|received|cancel|hutang|semua&limit=&offset=`
      -> `{data:[{...,sisa, n_items, umur_hari}], total, lewat30}` (`sisa = total−terbayar`
      computed, prinsip ledger; `id DESC`).
      **`status=hutang` (2026-10-17)** = nota `received` bersisa > 0 —
      klausul `p.status = 'received' AND p.total - p.terbayar > 0` (computed,
      bukan status tersimpan; sumber chip "Belum lunas" halaman Pembelian).
      Error 400 `"status harus order|received|cancel|hutang|semua"`.
      **Aging (2026-10-16)**: `umur_hari` = lama hutang sejak `received_at`
      (julianday SQLite = UTC; hanya `received` sisa>0 — null untuk
      order/batal/lunas); `lewat30` = jumlah baris sisa>0 berumur >= 30 hari
      (sumber chip `#po-lewat` halaman Pembelian + asersi aging-test).
    - `GET /api/purchases/:id` -> `{data:{purchase(+sisa),items}}`.
    - Laci: `SUM(terbayar)` nota received terikat shift (`n_purchase`/
      `purchase_total` di `GET /api/shifts` → `kasSeharusnya()`); rekap harian
      `GET /api/reports/daily` (`purchase:{n,total}` = nilai DITERIMA,
      by `received_at`, kartu ke-8 — tidak menggerus laba).
  - **Pengeluaran kas (Tahap 1, 2026-10-11, halaman `#/expenses`)** — kas
    TUNAI keluar operasional. Bukan mutasi stok (tidak menyentuh
    `products.version`) dan bukan HPP (laba = omzet − HPP, definisi tetap).
    - `GET /api/expenses?date=&limit=&offset=` ->
      `{data:[{id,created_at,kategori,jumlah,note,cashier,shift_id}], total, jumlah}`
      (filter tanggal + limit/offset via helper `bacaHari`, pola
      `GET /api/sales`; `jumlah` = SUM hari itu untuk kartu halaman).
    - `POST /api/expenses` `{kategori,jumlah>0 bulat,note?≤200,cashier?,shift_id?}`
      -> 201. `kategori` wajib non-kosong; `shift_id` opsional — NULL = di
      luar shift (tetap tercatat + masuk laporan, tak kurangi laci mana
      pun); bila dikirim harus shift yang ada (400 `"shift tidak dikenal"`).
    - `DELETE /api/expenses/:id` (koreksi salah ketik, pola
      `DELETE /api/customer-debts/:id` — tanpa cek saldo).
    - Laci: yang terikat `shift_id` mengurangi expected-cash
      (`n_expense`/`expense_total` di `GET /api/shifts` → `kasSeharusnya()`
      di `shift-tutup.ts`); rekap harian di `GET /api/reports/daily`
      (`expense:{n,total}`, dilaporkan TERPISAH — tidak menggerus laba).
  - `GET /api/customer-debts?status=open|semua&limit=&offset=` -> `{data:[{customer_id,name,phone,charge,bayar,sisa,terakhir,umur_hari}], total, count, lewat30}`
    - **Ringkasan saldo per pelanggan** (tabel utama halaman `#/debts`).
      Read-only. `limit` default 50 maks 200 (2026-10-11); `total` TETAP
      jumlah uang (kartu piutang — jangan dipakai hitung halaman), pager
      memakai `count` (= jumlah pelanggan).
    - `status` default `open` = hanya `sisa > 0`; `semua` = semua yang punya
      riwayat (termasuk lunas, `sisa` 0). Nilai lain -> 400
      `"status harus open|semua"`.
    - Urutan `sisa DESC, terakhir DESC, customer_id`; `total` = jumlah `sisa`
      (dipakai kartu "Total piutang berjalan").
    - **Aging (2026-10-16)**: `umur_hari` = umur HUTANG TERTUA yang masih
      terbuka per pelanggan (FIFO: charge terlama dulu, pembayaran melunasi
      yang tertua — bayar sebagian TIDAK mereset umur), null bila lunas;
      `lewat30` = jumlah pelanggan open dengan umur >= 30 (sumber chip
      `#hutang-lewat` halaman Hutang). Keduanya dihitung dari ledger saat
      baca (prinsip yang sama: tidak ada saldo tersimpan).
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
      Form bayar (modal) mencatat **uang kurang / uang 0 OTOMATIS = HUTANG**
      (putaran 12, 2026-10-06 — tanpa konfirmasi) bila pelanggan terpilih
      bukan bawaan "Pelanggan Umum": setelah penjualan tersimpan,
      client mengirim **`charge` terpisah** ke endpoint ini dengan
      `note:'Nota <invoice_no> — sisa bayar POS'` (lihat `pay()` di
      `apps/web/src/pages/pos.ts`; gagal ledger = penjualan TETAP sukses +
      toast penunjuk halaman Hutang; pelanggan tidak memenuhi syarat =
      penolakan barrier). Jalur **manual** di halaman Hutang
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
* `POST /api/products` `{sku?,name,category_slug,barcode?,unit?,price?,price_grosir?,cost?,markup?,price_dynamic?,stock?,min_stock?,is_active?,units?,image?,discount_type?,discount?,expiry_date?,use_note?}` (upsert by sku, version++)
  - **`price_grosir` (tier pelanggan, 2026-10-11)**: harga per satuan dasar
    untuk pelanggan tier `grosir` (lihat `customers.tier`). 0 = ikut ecer.
    Field BIASA (ikut reset, wajib di `payloadToggleAktif()` + form);
    impor CSV tanpa kolom ini dipertahankan (bendera
    `pertahankanTidakDikirim`); validasi `>= 0` → 400. Pack/dus: eksplisit
    menang; NULL ikut `price_grosir × factor` bila grosir. POS: key baris ikut
    harga bila ≠ ecer standar (anti-gabung ecer+grosir, pola dinamis).
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
* **Login & peran (2026-10-11)** — tabel `users` + `sessions` (db/schema.sql):
  2 role `owner` (semua) | `kasir` (POS + Riwayat + Retur + Pelanggan + Hutang
  + Stok + Shift-sendiri). Hash scrypt node:crypto `salt:hash` (db.ts
  hashPassword/verifyPassword, tanpa dep). Token acak 32 byte di header
  `Authorization: Bearer`, kedaluwarsa 30 hari.
  - **Middleware global `/api/*`**: tanpa token = 401; `must_change=1` mengunci
    SEMUA kecuali `/api/users/password` + `/api/logout` + `/api/me` (403).
    SATU-SATUNYA pengecualian token: `GET /api/products/:id/image` (dimuat
    lewat tag `<img>` yang tak bisa membawa header; thumbnail, bukan data
    sensitif). Print-agent ikut mengizinkan header `authorization` di CORS.
  - `POST /api/login` `{username,password}` -> `{data:{token,user,must_change}}}`;
    username tak ada & sandi salah = PESAN SAMA (401, anti-enumerasi); akun
    nonaktif = 403. `POST /api/logout` (idempotent), `GET /api/me`.
  - `GET/POST/DELETE /api/users` (+`POST /api/users/:id/password`) — SEMUA
    `hanyaOwner` (28 rute dilindungi: master uang/modal/laporan/aturan —
    daftar di index.ts). Update parsial: username TAK bisa diganti; guard 400:
    ubah peran/nonaktifkan diri sendiri, turunkan/nonaktifkan/hapus owner
    aktif terakhir. Reset sandi = must_change 1 + semua sesi target diputus.
    Ganti sandi sendiri (`/api/users/password`) = verifikasi sandi lama,
    membersihkan must_change. Seed: `owner`/`admin123` (name `kasir`,
    role `owner`, must_change 1) HANYA bila tabel kosong.
  - **Profil (2026-10-12)**: `users.avatar` (nama file di img/, pola
    products.image; dataURL <=120KB di-resize client 256px) + `users.email`
    (opsional, validasi format). `POST /api/users/me/avatar` {image} ('' =
    hapus), `GET /api/users/:id/avatar` publik (img tag — pengecualian token
    kedua, whitelist nama file), `POST /api/users/profile` {name,email}.
    Halaman `#/profil` SEMUA peran: avatar opsional (kosong = inisial),
    username READ-ONLY (kunci login), sandi blok kondisional (lama+baru+
    konfirmasi). **Redesign layout 2026-10-16**: grid `lg:grid-cols-3` —
    kartu Identitas `lg:col-span-2` (hero avatar `#pf-avatar-wadah` + nama
    + chip role + @username mono; "Ganti foto" = `label.btn` berisi input
    `#pf-avatar-file` sr-only; `#pf-avatar-hapus` SELALU dirender tapi
    `hidden` saat tanpa avatar) + kartu Keamanan (kolom kanan). Upload/hapus
    avatar TIDAK render ulang (`tampilAvatar()` ganti isi wadah + toggle
    class hidden tombol hapus, `fileEl.value=''` sesudahnya); simpan profil
    render ulang (hero ikut nama baru). SEMUA id `#pf-*` kontrak test tidak
    berubah. Dropdown akun: satu label "Edit Profil"; header avatar+nama
    ikut akun (profilSaya() menyinkronkan setCashier). Blok "Perangkat ini"
    (nama toko struk thermal + tema) PINDAH ke Sistem → kartu "Tampilan
    perangkat ini" (kartuPerangkat di settings.ts, localStorage).
  - Frontend: `ui/auth.ts` (token localStorage, profilSaya() dengan fallback
    offline ke simpanan terakhir), rute `#/login` & `#/ubah-sandi` (render
    tanpa shell lewat SATU kerangka `ui/auth-screen.ts` sejak 2026-10-17 —
    lihat §2), guard `bolehBuka()` per peran (nav difilter `roles` di
    ADMIN_NAV; kasir nyasar = toast + alih ke `#/pos`; **`labels` tidak ada
    di nav** (owner-only lewat `bolehBuka`, dibuka dari tombol Produk), api.ts
    menyuntikkan
    header Bearer ke semua request (termasuk flush outbox), `Pengguna` page
    khusus owner, logout = hapus sesi server + token.
* **Jejak audit (2026-10-16) — `GET /api/audit` -> `{data:[<baris audit_log>], total}`**
  (halaman `#/audit`, menu **Jejak Audit**, `hanyaOwner`; tabel `audit_log`
  di `db/schema.sql`, ditulis `catatAudit(c,…)` di dalam rute — bukan
  middleware, supaya hanya mutasi BERHASIL yang tercatat).
  - Query: `entity` (persis, mis. `product`), `q` (multi-kata — SEMUA kata
    harus cocok di gabungan `username action entity entity_id detail`,
    di-lowercase server), `date` (validasi round-trip seperti sales/expenses
    -> 400 `"date harus format YYYY-MM-DD"`), `limit` default 50 maks 200,
    `offset`. Urutan `id DESC`. `total` = jumlah baris cocok-filter tanpa
    limit.
  - Kolom baris: `id, at, user_id, username, role` (snapshot aktor — tetap
    terbaca walau akun diubah/dihapus), `action`
    (`create|update|delete|restock|opname|import|restore|login|login-gagal`),
    `entity`, `entity_id`, `detail` (JSON/teks ringkas, dipotong 500 char).
  - **Cakupan instrumentasi**: produk (create/update/delete/restock/opname/
    import), kategori, satuan, pelanggan, supplier, hutang (charge/payment/
    hapus baris), user (create/update/reset sandi), settings, pengeluaran,
    retur, pembelian (buat/terima/bayar/batal), backup + restore, dan
    login/login-gagal. Penjualan/topup SENGAJA tidak diaudit per nota
    (sudah punya linimasa Riwayat + laporan) — jangan tambahkan tanpa
    permintaan.
  - Diuji `tests/audit-test.mjs` (24 asersi): pencatatan create/update/delete,
    filter q/tanggal/limit, 401 tanpa token, kasir 403, login-gagal tercatat,
    dan UI `#/audit` (chip jumlah, cari, modal detail, Esc).
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
    `n_expense` (COUNT) / `expense_total` (SUM `jumlah`, Tahap 1 2026-10-11) —
    hanya yang `shift_id`-nya cocok (yang NULL = di luar shift, tak kurangi
    laci mana pun).
    `inv_awal` / `inv_akhir` (MIN/MAX `invoice_no`, rentang nota butir 5
    Z-report), `diskon_total` (transaksi + per baris, rumus SAMA dengan
    `sales.diskon` reports/daily), `hutang_baru` (SUM CASE `sisa_hutang`
    persis GET /api/sales — porsi tunai tak masuk laci), `piutang_bayar`
    (SUM `customer_debts` payment dalam periode opened..closed — ledger tak
    punya shift_id; masuk laci). Semua 2026-10-11, rekap Z-report.
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
    4. Pengeluaran (Tahap 1, 2026-10-11): laci **TURUN** `expense_total`
       (hanya yang terikat shift ini).
    5. Retur (Tahap 2, 2026-10-11, keputusan pemilik (a)): laci **TURUN**
       `retur_total` (uang kembali ke pelanggan; hanya yang terikat shift).
    6. Pembelian (Tahap 3, 2026-10-11, keputusan pemilik (b)): laci **TURUN**
       `purchase_total` (= SUM `terbayar` nota received, bukan total nota —
       sisa hutang tak gerakkan kas; hanya yang terikat shift).
    7. Hutang TERBENTUK (rekap Z-report, 2026-10-11): laci **TIDAK** menerima
       `hutang_baru` — omzet tercatat penuh tapi uangnya kurang, jadi
       dikurangkan (tanpa ini nota kredit selalu membuat selisih minus).
    8. Piutang TERBAYAR (rekap Z-report, 2026-10-11, butir 7-8 "credit
       payments collected"): laci **NAIK** `piutang_bayar`.
    `kas seharusnya = modal_awal + (omzet − hutang_baru) + topup_nominal + topup_admin + piutang_bayar − expense_total − retur_total − purchase_total`
    dan `selisih = modal_akhir − kas seharusnya`. Rumusnya di DUA fungsi
    `kasSeharusnya()` + `hitungSelisih()` (`apps/web/src/pages/shift-tutup.ts`)
    — bila keputusan berubah, ubah di situ; jangan menyebar ke tempat lain.
  - **Rekap cetak tutup shift ala Z-report Aronium (2026-10-11)**:
    dialog tutup = tombol [Thermal] [PDF] rekap SEMENTARA (X, tanpa
    fisik/selisih, tanpa menutup); setelah POST close sukses = dialog rekap
    (Z) [Thermal] [PDF] [Selesai]. Thermal = objek `Struk` dari
    `bangunStrukRekap()` via print-agent 32 kolom (guard autoPrint/pause
    pola `cetak()` POS); PDF = `htmlRekapShift()` + `cetakRekapShift()` di
    `invoice.ts` (window.print browser, pola `cetakInvoice` — kop `store_*`,
    tabel uraian, kotak Kas seharusnya/Modal akhir/Selisih). Gagal cetak
    tak pernah membatalkan tutup shift (toast saja).
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
  - **`note` TINGKAT TRANSAKSI (kolom `sales.note`, sejak 2026-10-10)**:
    teks bebas 0-200 karakter per NOTA dari kolom "Catatan transaksi" di
    modal bayar POS (`#bayar-note`, payment-scoped, ikut outbox offline).
    DI-TRIM + snapshot seperti `customer_name`; `> 200` -> 400 `"catatan
    transaksi terlalu panjang (maks 200 karakter)"`; absen/`''` = tanpa
    catatan (payload lama sah). `GET /api/sales` & `:id` mengembalikannya
    via `s.*`. Tahap 1 = simpan + gema resume; cetak kaki struk = tahap 2.
    Migrasi: kolom BARU (install lama = ALTER manual, lihat §5).
* `GET /api/sales/:id` -> `{data:{sale,items}}` (isi lengkap satu nota)
  - `sale` memuat **`invoice_no`** (`YYMMDD-NNNNNN`, urut harian) sejak
    2026-10-03 — diambil client oleh `cetakInvoice()` untuk dicetak di kop
    invoice A4.
  - `sale` juga memuat **`customer_id`** + **`customer_name`** (snapshot, sejak
    2026-10-04) — sumber baris `Pelanggan:` di struk ulang dan "Bill to"
    invoice A4. Baris lama bernama `''` = tampilkan "Pelanggan Umum".
  - Sejak putaran 13 (2026-10-06) `sale` memuat **`sisa_hutang`** — penanda
    "nota ini berhutang", CASE komputasi **SAMA PERSIS** dengan
    `GET /api/sales` (lihat butir `sisa_hutang` di sana untuk rasional &
    batas maknanya).
  - Sejak 2026-10-18 `sale` juga memuat **`n_retur`** + **`retur_total`** —
    penanda RETUR, subquery komputasi **SAMA PERSIS** dengan `GET /api/sales`
    (lihat butir `n_retur` di sana untuk rasional & batas maknanya).
  - Tiap baris `items` memuat **`base_unit`** (satuan dasar produk lewat
    `LEFT JOIN products`, `NULL` untuk item manual) sejak 2026-10-01 — dipakai
    tombol **Cetak ulang struk** di halaman Riwayat: struk hanya mencetak
    `unit` bila berbeda dari `base_unit` (aturan sama dengan struk POS).
  - Sejak 2026-10-03 tiap baris juga memuat **`note`** (catatan per baris,
    `''` bila tanpa) lewat `SELECT si.*` — dipakai cetak ulang supaya baris
    catatan ikut tercetak persis seperti struk aslinya.
* `GET /api/sales?date=&limit=&offset=`
  -> `{data:[{id,shift_id,created_at,invoice_no,customer_id,customer_name,sisa_hutang,n_retur,retur_total,pay_method,subtotal,discount,total,cash_in,change,cashier,n_items}], total}`
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
  - **`customer_id` + `customer_name`** ikut terbawa otomatis lewat `s.*`
    (snapshot kolom `sales`, lihat POST /api/sales).
  - **`sisa_hutang` (putaran 13, 2026-10-06 — penanda transaksi HUTANG di
    halaman Riwayat)**: **computed per baris, bukan kolom tersimpan** —
    `CASE WHEN pay_method='tunai' AND total > cash_in AND customer_id IS NOT
    NULL AND customer_name <> 'Pelanggan Umum' THEN total - cash_in ELSE 0
    END`. Syaratnya PERSIS kondisi catat-hutang otomatis di POS (putaran 12):
    uang kurang/0 + pelanggan valid -> nota ini berhutang; pelanggan bawaan
    "Pelanggan Umum" / non-tunai / lunas -> 0. **Maknanya = KEJADIAN saat
    nota, bukan saldo ledger live**: sisa di `customer_debts` bisa berubah
    (dibayar/dihapus di halaman Hutang) sedangkan penanda nota tetap —
    saldo aktual selalu dibaca dari halaman Hutang. CASE yang sama juga
    dikirim oleh `GET /api/sales/:id`. Jangan mengganti ini dengan JOIN ke
    ledger: `customer_debts` tidak punya FK/relasi ke `sales` (charge hanya
    di-note `Nota <invoice_no> — sisa bayar POS`).
  - **`n_retur` + `retur_total` (2026-10-18 — penanda RETUR di halaman
    Riwayat)**: **computed per baris, bukan kolom tersimpan** —
    `(SELECT COUNT(*) …)/(SELECT COALESCE(SUM(r.total),0) …)` dari `returns
    r WHERE r.sale_id = s.id` (indeks `idx_returns_sale`). Hanya retur DARI
    nota (`POST /api/returns` dengan `sale_id`) yang terhitung; retur manual
    (`sale_id` NULL) tidak mengattribusi nota mana pun, dan retur yang
    DIBATALKAN (`DELETE /api/returns/:id`) ikut hilang dari penanda — sama
    polanya dengan hutang yang dibayar. Dasar chip amber `Retur RpX` di
    kolom Jenis + kotak `Retur` di kartu Pembayaran `detailJual()` halaman
    Riwayat (bukan omzet baru — uang kembali ke pelanggan). Diuji
    `tests/retur-test.mjs` section D & F (kini 35 asersi).
  - Urutan `created_at DESC, rowid DESC` (yang terbaru di atas).
* `POST /api/topups` `{id?,kind:topup|tarik,provider,nomor?,token?,nominal>0,admin>=0,pay_method?,shift_id?,cashier?,sale_id?}`
  - `provider` = **kode jenis layanan** (bukan brand). Nilai yang digunakan POS:
    `E-WALLET | PULSA | PLN-TOKEN | PLN-BILL` (kind=topup) dan `TARIK-EWALLET | TARIK-BANK` (kind=tarik).
    Kontrak API tidak berubah; kolom tetap TEXT non-kosong. Penambahan brand
    (DANA/OVO/GoPay/BCA) dilakukan sebagai kolom baru jika dibutuhkan, bukan
    dengan mengubah `provider` menjadi opsional.
  - **`nomor` OPSIONAL sejak 2026-10-06 (revisi pemilik)**: e-wallet/pulsa
    "untuk pencatatan saja tidak perlu nomor HP" dan tarik tunai "hanya nominal
    saja dan admin" — client mengirim `''` untuk jenis itu (hanya `provider`
    yang wajib, error `"provider wajib"`). PLN token/tagihan tetap mengisi no
    meter / ID pelanggan. `nomor TEXT NOT NULL DEFAULT ''` di skema.
  - **`token` (baru 2026-10-06, kolom `topup_txns.token`)**: Nomor Token PLN —
    form POS hanya menampilkannya untuk `PLN-TOKEN`, dan **ikut dicetak di
    struk belanja** (baris `Token: <isi>`). Layanan lain mengirim `''`
    (default). `GET /api/topups` & `GET /api/sales`-style `SELECT *`
    otomatis mengembalikannya.
  - **`sale_id` OPSIONAL (baru 2026-10-08, kolom `topup_txns.sale_id`)**:
    relasi lembut dari baris topup ke `sales.id` nota yang menemaninya —
    **dipakai halaman Riwayat** untuk menggabungkan transaksi hibrida jadi
    SATU baris (topup/tarik yang punya `sale_id` cocok dirender sebagai
    **sub-baris di bawah induknya**, pola note-di-bawah-produk; yang null /
    yatim jadi baris linimasa sendiri). **Tanpa FK** (dibuat sengaja):
    `pay()` mengirim topup DULU lalu sale, jadi saat INSERT topup baris
    `sales` belum tentu ada. Client mengirim `null`/absen untuk topup mandiri
    (dialog topup dari keranjang), atau uuid stabil yang sama dengan `id`
    `POST /api/sales` berikutnya untuk hibrida. `GET /api/topups` ikut
    mengembalikannya lewat `SELECT *`.
  - **Kontrak TIDAK berubah sejak Opsi B hybrid (2026-10-07, direvisi
    tarik 2026-10-08)**: POS juga memakai endpoint ini dari keranjang
    Penjualan — baris topup (`kind:'topup'`) maupun tarik (`kind:'tarik'`,
    provider `TARIK-*`) dikirim `pay()` SEBELUM `POST /api/sales` dengan
    `id` uuid stabil (retry aman, `duplicate:true`); orkestrasi + alokasi
    uang ada di client (§2 `pos.ts`).
* `GET /api/topups?date=&limit=&offset=` -> `{data:[<baris topup_txns>], total}`
  - Daftar topup/tarik untuk menu **Riwayat transaksi**; aturan `date`
    (validasi round-trip, default hari UTC, filter `date(created_at)=date(?)`),
    `limit`/`offset`, dan urutan **sama persis** dengan `GET /api/sales`
    di atas, supaya keduanya bisa digabung jadi satu linimasa tanpa tanggal
    yang bertengkar.
  - Baris memuat **`token`** (isi Nomor Token PLN; `''` untuk layanan lain).
    Riwayat menyembunyikan baris nomor bila `''` dan menampilkan baris
    `Token` pada rincian PLN token.
  - Baris juga memuat **`sale_id`** (uuid sale yang menemani, atau null —
    lihat `POST /api/topups`): halaman Riwayat memakainya untuk menentukan
    topup hibrida yang harus jadi sub-baris di bawah induknya.
* `GET /api/topups/suggest-admin?nominal=` (<=0->0, <50rb->3000, <200rb->5000, else 7000)
* `GET /api/reports/daily?date=YYYY-MM-DD`
  -> `{data:{date,sales:{n,omzet,diskon},hpp,laba,byHour,byMethod,topup,topItems,lowStock,expense:{n,total},retur:{n,total},purchase:{n,total},piutang:{baru,bayar}}}`
  - Bentuk dihitung SATU fungsi `laporanRentang(dari,sampai)` (2026-10-11) —
    daily = rentang 1 hari. `piutang` = hutang TERBENTUK (CASE sisa_hutang) +
    TERBAYAR (ledger payment), butir credit Z-report.
  - **`byHour` (2026-10-17)**: array **24 ember 0..23 zero-fill** (jam tanpa
    penjualan = `n:0, omzet:0`), grup `strftime('%H', created_at)` — jam UTC,
    aturan hari sama dengan filter `date(created_at)`. Jam `'00'..'09'` dikirim
    SQL sebagai string lalu `Number()`, jadi JSON berisi angka. Sumber grafik
    per jam halaman Laporan (DIV `[data-jam]`, bukan tabel — urutan tabel
    Harian adalah kontrak test).
* `GET /api/reports/summary?from=&to=` -> `{data:{from,to,...sama dengan daily}}`
  (menu laporan ala Aronium, 2026-10-11). Validasi: format YYYY-MM-DD
  round-trip, `from<=to`, maks 366 hari (selain itu 400). `lowStock` snapshot
  kini (stok = keadaan sekarang, bukan per tanggal).
* `GET /api/reports/profit?from=&to=` -> `{data:{from,to,total:{n,omzet,hpp,laba},
  days:[{date,n,omzet,hpp,laba}],trx:[{id,created_at,invoice_no,cashier,total,
  hpp,laba}]}}` (menu **Laba**, 2026-10-17; validasi rentang = `bacaRentang`
  sama dengan summary, maks 366 hari).
  - HPP per NOTA dihitung **subquery agregat per `s.id` DULU** — join
    `sale_items` langsung ke `sales` menggandakan `s.total` per baris produk
    sehingga omzet per transaksi salah. `days` = hari **BERISI penjualan**
    saja (`GROUP BY date(created_at)`, ASC) — bukan zero-fill seluruh rentang:
    rentang kosong = `days:[]`/`trx:[]` (halaman menampilkan empty-state, bukan
    baris nol); `total` = agregat `days` (angka kartu). `trx` dibatasi **200
    nota terbaru** (urutan `created_at DESC, id DESC`; `total.n` = jumlah nota
    sesungguhnya — penanda "x dari y nota"); arsip penuh tetap menu Riwayat.
* `GET /api/reports/cashiers?from=&to=` -> `{data:{from,to,rows:[{cashier,n,omzet,diskon}],total}}`
  (menu Kasir; diskon = transaksi + per baris, konsisten sales.diskon).
* `GET /api/reports/products?from=&to=&q=&limit=` -> `{data:{from,to,rows:[{name,unit,qty,amount,hpp,laba}],total}}`
  (menu Produk; `q` multi-kata nama, limit 50/200). **`laba` DIHITUNG SERVER
  sejak 2026-10-17** (dulu klien menghitung amount−hpp — dipindah supaya satu
  rumus dengan `topItems` daily/summary): `laba` = `Σ(amount − diskon baris) −
  hpp` (net diskon PER BARIS; diskon transaksi tidak dialokasikan per baris,
  jadi Σ laba baris ≥ laba rekap — catatan tampil di footer tabel halaman).
  - `hpp = ROUND(SUM(sale_items.qty * sale_items.cost))` untuk penjualan hari itu.
  - `laba = sales.omzet - hpp` (omzet sudah **setelah** semua diskon).
  - `expense` (Tahap 1, 2026-10-11) = COUNT + SUM `expenses` hari itu —
    dilaporkan TERPISAH di kartu ke-5 (tidak menggerus laba).
  - `sales.diskon` = **TOTAL diskon hari itu** = `SUM(sales.discount)` (transaksi)
    + `SUM(sale_items.discount)` (per baris). Tanpa penjumlahan ini angka diskon
    akan menyembunyikan diskon per baris padahal omzet sudah menguranginya —
    dan `omzet - diskon != subtotal` jadi tidak terjawab.
  - `topItems` dikelompokkan per `(name, unit)` dan tiap baris memuat `unit` —
    tanpa pemisahan ini penjualan "2 pack" dan "3 btl" produk sama tercampur
    jadi satu baris qty=5 campur satuan. Sejak 2026-10-17 tiap baris juga
    memuat **`hpp` + `laba` DIHITUNG SERVER** — rumus sama persis dengan
    `/api/reports/products` (satu sumber; klien tidak menghitung ulang) dan
    dipakai kolom HPP/Laba tabel "Produk terlaris" kartu Harian.
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
  * **`POST /api/backup/restore` `{nama}` (2026-10-16) -> 200
    `{data:{nama,pengaman}}`** (hanya pemilik; tercatat `restore` di audit).
    Urutan: whitelist nama (basename + pola -> 404 `"file backup tidak ada"`),
    file ada (404), `integrity_check` koneksi readonly terpisah (gagal dibaca
    -> 400 `"file backup tidak bisa dibaca — tidak dipulihkan"`; selain `ok`
    -> 400 `"file backup rusak (integrity check gagal) — tidak dipulihkan"`),
    **backup pengaman otomatis dulu** (gagal -> 500, DB lama TIDAK disentuh),
    baru `pulihkanDari()` (db.ts). SEMUA jalur gagal = DB lama tetap hidup
    utuh. Konsekuensi yang didokumentasikan di dialog UI: sesi login ikut
    kembali ke snapshot (device lain bisa ter-logout) dan proses API TIDAK
    perlu restart sesudahnya. Tombolnya di kartu **Backup data** `#/settings`
    (`[data-restore]` -> swal konfirmasi -> toast hasil).
  * **Restore manual dokumentasi** tetap jalur darurat: matikan API, ganti
    `data.db` dengan file backup, hidupkan lagi.
* Endpoints backup diuji `tests/backup-test.mjs` (27 asersi, terdaftar di
  `tests/run.mjs`): daftar/POST/unduh+integrity/guard 3×404/retensi 16
  dummy/UI kartu. Test MEMINDAHKAN file asli ke snapshot lalu mengembalikan
  file asli di `finally` — jangan menghapus file `backups/` milik pemilik di
  luar test. **Restore diuji `tests/restore-test.mjs` (21 asersi)**: marker
  A -> backup B1 -> marker B -> pulih ke B1 (A kembali, B hilang), guard
  404 (berjalur/pola salah/file hilang), file rusak -> 400 tanpa mengubah DB,
  audit + file pengaman terdaftar, UI `[data-restore]`/Unduh, dan section B2
  anti-regresi: tulis lewat `upsertProduct`/`simpanMutasiHutang`/
  `insertSale`/`simpanRetur` WAJIB hidup sesudah restore tanpa restart
  (bug nyata 2026-10-16 — lihat `transaksi()` di §2).

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
* **DILARANG menyimpan `const tx = db.transaction(...)` di scope modul**
  (index.ts) — `db` di-rebind saat restore (`pulihkanDari`), tx model lama
  mengikat koneksi mati dan mematikan semua tulisan sesudah restore (bug
  nyata 2026-10-16). Selalu bungkus lewat helper **`transaksi(fn)`** dari
  `db.ts`; regresi dijaga section B2 `tests/restore-test.mjs`.
* **Data uji WAJIB nama eksak + self-heal di awal suite.** Cleanup bertipe
  prefix (`name LIKE 'UjiX%'`) pernah menjaring pelanggan durable milik suite
  lain (`UjiHutang%` vs `UjiHutang POS E2E`) dan menyisakan yatim yang
  menggeser baseline test lain (run penuh 2026-10-16). Aturan: hapus pakai
  daftar nama EKSAK milik suite sendiri; di awal suite bersihkan sisa yatim
  (termasuk efek sampingnya — stok/mutasi) supaya suite tetap hijau walau
  run sebelumnya crash; helper `sql()` menyapa `apps/api/data/data.db`
  langsung (CLI `sqlite3` TIDAK menegakkan foreign_keys — jangan andalkan).
* **PWA**: service worker HANYA boleh meng-cache shell + aset statis — data
  `/api/*` TIDAK PERNAH (angka kasir basi > layar error; outbox tetap jalur
  tulis offline). Ubah isi `apps/web/public/sw.js` = NAIKKAN versi
  `ravaa-shell-v1` (cache lama baru dibuang saat activate). Registrasi SW
  tetap `import.meta.env.PROD` (dev jangan di-cache). Uji: `tests/pwa-test.mjs`.
* `apps/web/vite.config.ts` `preview.proxy` (`/api` -> :3001) itu untuk
  uji PWA di port bawaan 4173 — **JANGAN** pindahkan preview ke 5656
  (dipakai dev server) atau hapus proxynya (pwa-test bergantung).
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
  **Migrasi terakhir 2026-10-17 (peran `pemilik` → `owner` + akun seed
  `owner`):** CHECK `users.role` jadi `('owner','kasir')`; akun lama
  berperan `pemilik` DITOLAK guard baru (toast "Halaman ini khusus owner" di
  web + 403 `"khusus owner"` di API), dan `npm run seed` TIDAK memperbaikinya
  (seed user hanya jalan saat tabel `users` kosong). SQLite tak bisa mengubah
  CHECK lewat ALTER → **rebuild tabel `users` in-place** (data/sesi
  dipertahankan), sekalian rename akun `pemilik` → `owner`. Backup dulu
  (`VACUUM INTO`, bukan `cp`):
  ```bash
  sqlite3 apps/api/data/data.db 'PRAGMA wal_checkpoint(TRUNCATE);'
  sqlite3 apps/api/data/data.db "VACUUM INTO 'apps/api/data/data.db.bak.role-owner';"
  sqlite3 apps/api/data/data.db <<'SQL'
  PRAGMA foreign_keys=OFF;
  BEGIN IMMEDIATE;
  CREATE TABLE users_baru (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('owner', 'kasir')),
    avatar        TEXT,
    email         TEXT NOT NULL DEFAULT '',
    is_active     INTEGER NOT NULL DEFAULT 1,
    must_change   INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT INTO users_baru (id, username, name, password_hash, role, avatar, email, is_active, must_change, created_at)
    SELECT id,
           CASE WHEN username = 'pemilik' THEN 'owner' ELSE username END,
           name, password_hash,
           CASE WHEN role = 'pemilik' THEN 'owner' ELSE role END,
           avatar, email, is_active, must_change, created_at
      FROM users;
  DROP TABLE users;
  ALTER TABLE users_baru RENAME TO users;
  COMMIT;
  PRAGMA foreign_keys=ON;
  SQL
  ```
  `foreign_keys=OFF` WAJIB (tabel `sessions` mereferensikan `users` dengan
  ON DELETE CASCADE — tanpa itu DROP TABLE menghapus semua sesi). Seq
  AUTOINCREMENT ikut dijaga manual (`UPDATE sqlite_sequence SET
  seq=<nilai lama> WHERE name='users'`). DB dev repo ini sudah dijalankan
  2026-10-17 (backup `data.db.bak.role-owner`; login tetap `owner`/
  `admin123`, sesi browser lama ikut pulih sendiri — token menunjuk
  `user_id`, bukan username). Install berdata yang TIDAK boleh di-recreate
  (mis. STB native `~/ravaa-data/data.db`) jalankan blok yang sama dengan
  path DB-nya — API boleh hidup (DDL di WAL), tidak perlu restart.
  **Migrasi sebelumnya 2026-10-08 (Riwayat hibrida — relasi topup→sale):**
  kolom **`topup_txns.sale_id`** (`TEXT`, **tanpa FK** — lihat kontrak
  `POST /api/topups`): penanda lembut baris topup/tarik yang dibayar bersama
  satu nota penjualan, dipakai halaman Riwayat menggabungkan transaksi hibrida
  jadi satu baris (topup/tarik = sub-baris di bawah induknya). **ALTER
  in-place di dev (bukan re-create)** — riwayat topup sudah berisi (backup
  `data.db.bak.sale-id`, dibuat DENGAN `PRAGMA wal_checkpoint(TRUNCATE)`
  dulu):
  ```bash
  sqlite3 apps/api/data/data.db 'PRAGMA wal_checkpoint(TRUNCATE);'
  cp apps/api/data/data.db apps/api/data/data.db.bak.sale-id
  sqlite3 apps/api/data/data.db "ALTER TABLE topup_txns ADD COLUMN sale_id TEXT;"
  ```
  Setelah `index.ts` berubah, API via `tsx watch` restart sendiri; kalau DB
  diganti file (bukan ALTER), proses API **wajib di-restart** (pkill pattern
  `[w]atch`). Install yang TIDAK boleh di-recreate: jalankan SQL ALTER yang
  sama. `db/schema.sql` sudah menulis kolom `sale_id` (tanpa FK, dengan
  komentar). Baris lama bernama `sale_id` NULL → tetap baris mandiri di
  Riwayat (perilaku lama dipertahankan).
  **Migrasi sebelumnya 2026-10-06 (Topup/tarik — nomor opsional + token PLN):**
  kolom **`topup_txns.token`** (`TEXT NOT NULL DEFAULT ''`) + kontrak `nomor`
  jadi opsional. **ALTER in-place di dev (bukan re-create)** — riwayat topup
  sudah berisi (backup `data.db.bak.topup-token`, dibuat DENGAN
  `PRAGMA wal_checkpoint(TRUNCATE)` dulu):
  ```bash
  sqlite3 apps/api/data/data.db 'PRAGMA wal_checkpoint(TRUNCATE);'
  cp apps/api/data/data.db apps/api/data/data.db.bak.topup-token
  sqlite3 apps/api/data/data.db "ALTER TABLE topup_txns ADD COLUMN token TEXT NOT NULL DEFAULT '';"
  ```
  Setelah `index.ts` berubah, API via `tsx watch` restart sendiri; kalau DB
  diganti file (bukan ALTER), proses API **wajib di-restart** (pkill pattern
  `[w]atch`). Install yang TIDAK boleh di-recreate: jalankan SQL ALTER yang
  sama. `db/schema.sql` sudah menulis kolom `token` + komentar `nomor` default
  `''`.   Form POS per jenis (e-wallet/pulsa/tarik tanpa nomor, PLN token +
  field Nomor Token) ada di `topupHtml()` `apps/web/src/pages/pos.ts` —
  **urutan card kiri (revisi 2026-10-06)**: Jenis layanan (tiles) → [No meter/
  Nomor Token bila jenis butuh] → Nominal + chip cepat → **Biaya admin
  (input, langsung di bawah nominal — permintaan pemilik "biaya admin itu
  letakkan di bawahnya nominal saja"; form input HANYA di card kiri, topup &
  tarik tampil sama semua)** → paragraf bantuan. Listener `#tp-admin`
  tidak berubah (id sama).
  **Refactor 1 layout desktop (2026-10-07, permintaan pemilik)**: seluruh
  POS = SATU layout — area kiri (scan + keranjang via `cartKiriHtml()`),
  sidebar kanan = `sidebarBayarHtml()` (Aksi cepat → Menu cepat → Diskon
  item → input diskon transaksi → Bayar F10 + Bayar pas F12). Semua bayar
  lewat **MODAL BAYAR bersama** (`bukaBayar()` → `pay()`).
  **Mode Topup/Tarik DIHAPUS 2026-10-08** (keputusan pemilik — detail
  penghapusan lihat §2 `pos.ts`): tidak ada lagi form/kolom `#tp-*`,
  `submitTopup()`, atau cabang mode; layanan hanya lewat keranjang
  (dialog Topup/Tarik).
  **Migrasi sebelumnya 2026-10-04 (Pelanggan toko — nomor urut + alamat +
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
* **500 "database tidak sinkron dengan skema (no such column …)"** (guard
  2026-10-18): DB ketinggalan kolom — `migrate()` hanya `CREATE TABLE IF NOT
  EXISTS`, tabel lama TIDAK pernah ditambah kolom otomatis. Baca blok
  `[SKEMA DB TIDAK SINKRON]` di log saat API start (atau `npm run seed`):
  daftarnya + perintah `ALTER TABLE … ADD COLUMN …` siap tempel ada di sana.
  SENGAJA tanpa auto-ALTER (kebijakan §5: migrasi manual). Endpoint
  yang TIDAK menyentuh kolom hilang tetap jalan; server tidak ikut mati.
  Terjadi nyata di laptop pemilik 2026-10-18 (DB lama era 3-6 Okt).
* **Restore sesudah `POST /api/backup/restore`**: sesi login ikut snapshot
  (device bisa logout — by design, didokumentasikan di dialog), tapi proses
  API TIDAK butuh restart; kalau tiba-tiba semua POST mati
  `The database connection is not open` sesudah restore, ada code path yang
  memakai `db.transaction` lama — pindahkan ke `transaksi()` (§5).
* **Uji PWA** (`tests/pwa-test.mjs`) membangun `dist/` lalu menyalakan
  `vite preview` sendiri di **:4179 `--strictPort`** (proses detached —
  dibunuh `process.kill(-pid)` di `finally`). Port bawaan preview = 4173;
  `--root` BUKAN opsi valid `vite preview`. Saat membunuh proses manual
  jangan `pkill -f "vite preview"` polos (self-match membunuh shell sendiri)
  — pakai pola bracket `pkill -f "[v]ite preview"`.
* Fixture foto test (`/tmp/opencode/foto-uji.jpg`) ditulis ULANG tiap run
  profil-test; jangan kembalikan ke pola `existsSync` — file /tmp lama bisa
  berisi JPEG rusak dan membuat `kecilkanAvatar` onerror tanpa jejak jelas.

## 7. Definisi selesai (Definition of Done)

Fitur dianggap selesai bila: (1) kode + skema konsisten dengan §3,
(2) `npm run build -w apps/web` lolos, (3) endpoint baru diuji dengan `curl` nyata
dan outputnya ditempel di jawaban, (4) tidak ada port/ENV baru yang tak terdokumentasi.
