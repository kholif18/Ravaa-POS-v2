# Perbandingan Fitur POS & Kebutuhan Pasar

> **KulaPOS · Aronium · Kasir Pintar · Olsera · Loyverse · Ravaa POS v2**

**v1 disusun 2026-10-06** (KulaPOS · Aronium · Kasir Pintar).
**v2 direvisi besar 2026-10-19** — menambah **Olsera** & **Loyverse**,
mengoreksi status Ravaa yang sudah usang di v1 (dulu masih "✗" untuk login,
PO supplier, retur, dan backup — semuanya kini ada), menyegarkan harga pasar,
serta menambahkan catatan kebijakan **MDR QRIS 0%** (efektif 1 Okt 2026).
Riwayat v1 utuh tersimpan di git log dokumen ini.

**Keputusan kandidat §4 (pemilik, 19 Okt 2026):** 7 butir disetujui untuk
dikerjakan, 5 ditolak, 2 belum dibahas — rincian di §0 dan §4–§5.

Dokumen ini bahan referensi pengembangan: memetakan **fitur yang dipakai
banyak orang** di aplikasi POS populer, lalu memisahkan mana yang sudah
setara, mana kandidat terbuka, dan mana yang **sudah diputuskan pemilik
untuk tidak dikerjakan**.

**Cara membaca (batas bukti):**

* **RavaaPOS v2** — tiap butir diverifikasi dari kode repo ini (kontrak
  `.opencode/agents/AGENTS.md` §3 + file yang disebut), status 2026-10-19.
  Bukan ingatan, bukan asumsi.
* **Kompetitor** — materi publik; tanggal akses dicantumkan di bagian
  Sumber. Fitur & harga kompetitor dapat berubah sewaktu-waktu.
* Harga = snapshot halaman resmi. Angka bertanda *(riset v1)* belum
  diverifikasi ulang pada 2026-10-19.
* Tabel: `✓` ada · `~` parsial/terbatas · `✗` tidak (Ravaa: "sengaja" =
  keputusan §5) · `⟳` Ravaa = disetujui pemilik 19 Okt 2026, dijadwalkan
  dikerjakan · `·` tidak muncul di sumber yang dibaca — **bukan** berarti
  fiturnya tidak ada.

---

## 0. Ringkas

**Sudah tertutup sejak v1** (dulu "✗"/gap, sekarang ada — semua terverifikasi
kode): login + peran (2026-10-11) · PO supplier + hutang supplier + aging
(Tahap 3, 2026-10-11) · retur penjualan (Tahap 2, 2026-10-11) · pengeluaran
kas (Tahap 1, 2026-10-11) · hutang pelanggan otomatis dari POS + aging +
cetak A4 · harga borongan per qty (butir 3.5, 2026-10-19) · rekap X/Z tutup
shift (2026-10-11) · 7 menu laporan + laba per nota/kategori + per jam + CSV +
cetak (2026-10-17/18) · backup otomatis + manual + restore + jejak audit ·
label harga barcode EAN/Code 128 A4/Folio (2026-10-17) · tampilan mobile POS
(2026-10-17).

**Keputusan pemilik 2026-10-19 atas kandidat §4 — dikerjakan (7):** scan
barcode pakai kamera HP · kas masuk · cetak/ekspor nota PO · logo di struk
thermal · split payment (§3.4) · pesanan jasa + DP/status · analitik
lanjutan (valuasi stok/dead stock). **Ditolak (5):** metode e-wallet + MDR
(tanpa payment gateway — QRIS/transfer manual cukup) · price list per
pelanggan · bundling/paket · varian produk · akses dari luar LAN
(Tailscale/tunnel). **Belum dibahas:** pengingat hutang via WA · absensi
staf. Status per baris di §4; antrian eksekusi di `ROADMAP.md` §1.6.

**Sengaja tidak dikerjakan (keputusan tercatat — §5):** poin loyalitas
(2026-10-18) · PPN/voucher (2026-10-06) · customer display (2026-10-06) ·
share/rekap WhatsApp (2026-10-01) · email laporan terjadwal · multi-outlet +
transfer stok · PPOB terintegrasi · fitur F&B (meja/kitchen/self-order) ·
AI forecasting.

---

## 1. Peta harga pasar (dicek 2026-10-19)

| Aplikasi | Platform | Harga publik | Catatan |
|---|---|---|---|
| KulaPOS | cloud, multi-outlet | · (situs demo berbasis JS — tidak bisa di-fetch) | riset v1 dari video demo + screenshot |
| Aronium | Windows, desktop lokal | Lite gratis; Pro berlangganan *(riset v1: ±US$10/bln)* + plugin terpisah | help center aktif (artikel lisensi dibarui 17 Okt 2026) |
| Kasir Pintar | Android/iOS/Desktop + plugin offline | Free; **Pro Rp666.000/thn** (mulai ±Rp56 rb/bln); bundel Pro+Business **Rp1.133.000/thn**; Pro+Business+Desktop **Rp1.499.000/thn** | halaman /harga, 19 Okt 2026 |
| Olsera | Android/Windows (iOS di Premium) | **Basic Rp1.288.000/thn** · Premium Rp1.988.000 · Pro Rp2.688.000 *(harga promo; sebelum PPN)* | 85.000+ usaha; ISO 27001 & 27701 |
| Loyverse | HP/tablet + back office browser | **Free** (inti) + add-on: riwayat penjualan US$9/bln/store · karyawan US$5/bln/karyawan · inventory lanjutan US$25/bln/store | halaman /pricing, 19 Okt 2026 |
| **Ravaa POS v2** | self-hosted (LAN toko) | **tanpa biaya lisensi** | biaya = server sendiri + listrik; cetak via print-agent/browser |

> Merek populer lain (Moka, Pawoon, Majoo, dsb.) belum dicek ulang untuk v2 —
> tambahkan bila memang diperlukan perbandingannya.

---

## 2. Profil per aplikasi

### 2.1 KulaPOS (sistem multi-outlet)

> Sumber: riset lokal 2026-10-06 — transcript demo + screenshot `kula-01` …
> `kula-12` (artefak tidak disimpan di repo; situs berbasis JS tidak bisa
> di-fetch ulang).

* **Akun & role**: login berjenjang Owner / Manajer (mengawasi beberapa toko)
  / Kasir; manajemen karyawan; shift kasir.
* **Dashboard**: penjualan hari ini, estimasi laba kotor & laba bersih,
  pengeluaran, jumlah transaksi.
* **Transaksi/POS**: multi-outlet, pajak (PPN) + service charge, promo, poin
  loyalitas pelanggan, retur ke pelanggan, laba per transaksi.
* **Produk**: master + kategori, multi-kemasan, lacak serial number, minimum
  stok, kadaluarsa + peringatan.
* **Stok**: penyesuaian fisik, transfer stok antar cabang, restock, gudang.
* **Pembelian**: PO ke supplier, faktur supplier, status barang masuk,
  pembelian langsung.
* **Supplier & pelanggan**: database + poin, piutang, hutang supplier, share
  bukti pembayaran via WhatsApp.
* **Retur & garansi**: retur ke pelanggan & ke supplier, klaim garansi.
* **Lain-lain**: cetak barcode & label, master outlet, pengaturan printer,
  daftar transaksi, laporan.

### 2.2 Aronium (POS Windows desktop — Lite gratis / Pro berlangganan)

> Sumber: help.aronium.com (dicek ulang 2026-10-19) + situs resmi & release
> notes pada riset v1 2026-10-06 (situs utama berbasis JS — tidak bisa
> di-fetch ulang; harga spesifik bertanda *(riset v1)*).

* **Kasir**: unlimited produk/dokumen/pelanggan/user; layout standar & touch
  screen; metode bayar kustom; barcode & weight barcode; diskon; promotions &
  happy hour; pajak & tax-exempt sale; credit payments (hutang); struk cetak &
  elektronik; custom receipts (logo/header/footer/terjemahan); catatan;
  takeaway/dine-in (plugin); Z report; pembulatan kustom.
* **Inventori**: stok, inventory count (opname), kelompok produk, cari
  barcode/SKU/nama, product history, stock control.
* **Pelanggan**: loyalty cards; price lists berbeda per kasir/pelanggan
  (retail/grosir — plugin, *(riset v1)* ±US$5/bln).
* **Laporan**: dashboard real-time, best sellers, pelanggan, diskon, purchase
  invoice list, riwayat transaksi, return stock report.
* **Platform**: multi-komputer satu database (Pro), backup otomatis
  terjadwal, merge duplikat produk, floor plan (resto), user/permission.
* **Plugin**: kedaluwarsa (gratis), dual currency, e-invoice regional
  (KSA/Fatoora/Vanuatu/Fiji), print stations dapur/bar, MRP, logo login.
  Lisensi lewat my.aronium.com.

### 2.3 Kasir Pintar (POS Indonesia — Android/iOS/Desktop/offline)

> Sumber: kasirpintar.co.id (home, /harga, /bengkel) + blog resmi — diakses
> 2026-10-19; detail varian & bundling paket dari riset v1 2026-10-06.
> Harga promo dapat berubah.

* **Free**: transaksi tak terbatas (tampil 1.000 data terbaru), 1.000 item,
  3 laporan standar, struk berwatermark, single user.
* **Pro (Rp666.000/thn, mulai ±Rp56 rb/bln)**: 10.000 item, 10+ laporan,
  struk tanpa watermark, multi-user s.d. 5 akun staff (tambah staff
  berbayar); kapasitas penyimpanan gambar bisa di-upgrade.
* **Plugin Business** (bundel Pro+Business Rp1.133.000/thn): metode bayar
  kustom (GoPay/OVO/GrabFood dll) + **hitung MDR otomatis**, IMEI,
  multi-satuan, varian produk, bundling paket, poin loyalitas, split
  bill/join, POS iOS, import 3.000 barang.
* **Plugin lain**: Desktop (PC, hutang-piutang), POS Offline (server multi-PC),
  StaffPlus (absensi selfie/jadwal), Food Menu & Bahan Baku (FnB), Olshopin
  (toko online), Linkpintar.
* **Layanan**: PPOB (pulsa/listrik/BPJS/PDAM), QRIS, laporan usaha, manajemen
  pelanggan, catat aktivitas keuangan.
* **Vertical Bengkel** (analog usaha jasa servis): pisahkan sparepart vs jasa
  servis, cetak nota servis, riwayat servis kendaraan per pelanggan, add-on
  jasa tambahan, PPN otomatis, struk via WhatsApp.
* **Konteks QRIS (blog resmi 13 Okt 2026)**: kebijakan Bank Indonesia —
  **MDR QRIS 0% untuk transaksi ≤ Rp100.000 berlaku efektif 1 Oktober
  2026**; mitra QRIS (Winpay) menyesuaikan skema layanannya.

### 2.4 Olsera (Indonesia — retail/FnB/jasa, cloud)

> Sumber: olsera.com/en + olsera.com/en/pricing, diakses 2026-10-19.

* **Profil**: 85.000+ wirausaha di 500+ kota; fokus retail, F&B, dan jasa
  (penjadwalan/reservasi lewat Zenwel by Olsera); bersertifikasi ISO 27001 &
  27701.
* **Harga (promo 19 Okt 2026, sebelum PPN)**: Basic Rp1.288.000/thn (dari
  Rp1.888.000) · Premium Rp1.988.000/thn (dari Rp2.888.000) · Pro
  Rp2.688.000/thn (dari Rp3.888.000).
* **Basic**: POS Android & Windows, app back-office, laporan profesional,
  integrasi GrabFood, manajemen inventori, absensi PIN; 3 perangkat;
  pemilik + 2 staff.
* **Premium**: + POS iOS, katalog website bisnis, integrasi software
  akunting, staff & perangkat tanpa batas.
* **Pro**: + self order, integrasi marketplace (Tokopedia/Shopee/Blibli/
  Lazada), dashboard monitoring & franchise, absensi wajah, kurir.
* **Fitur lintas paket** (tabel resmi): transfer stok antar toko, produk
  varian, pembelian & supplier, catat pendapatan & pengeluaran, struk digital
  (email/WA) & cetak struk, cetak label sticker, promo (produk/pelanggan/
  kupon diskon), program loyalitas, metode bayar (tunai/OVO/DANA/GoPay/
  LinkAja/ShopeePay/QRIS), export laporan ke Excel, email laporan.
* **F&B**: split bill/join bill, dine-in/takeaway/reservasi (Pro), manajemen
  meja & resep, buku menu digital QR.

### 2.5 Loyverse (global — cloud, gratis + add-on)

> Sumber: loyverse.com/pricing + loyverse.com/features + help.loyverse.com,
> diakses 2026-10-19.

* **Gratis (inti)**: POS dari HP/tablet, analitik penjualan 31 hari,
  inventory esensial + alert stok menipis, program loyalitas, customer
  display, kitchen display, multi-store, integrasi; dukung hardware umum
  (printer struk, scanner barcode, laci, printer label).
* **Add-on berbayar** (per toko/karyawan; ada trial 14 hari): riwayat
  penjualan tanpa batas US$9/bln/store · manajemen karyawan
  US$5/bln/karyawan · inventory lanjutan (purchase order, transfer stok,
  insight) US$25/bln/store.
* **Back office** diakses lewat browser.

### 2.6 Ravaa POS v2 — status 2026-10-19 (repo ini)

**Arsitektur & platform**

* Web PWA **self-hosted di server toko** (LAN): API Hono + better-sqlite3
  (SQLite WAL; API satu-satunya penulis DB) · web vanilla-TS + Tailwind v4
  (tanpa framework) · print-agent nol-dependensi di PC kasir.
* **Offline-first**: outbox tulis (id uuid idempoten) + delta sync IndexedDB
  + tombstone; penjualan tetap tercatat saat jaringan putus.
* 1–2 kasir per device, masing-masing nama kasir + shift sendiri (tanpa
  multi-outlet — batas sadar skala; lihat §5).

**Fitur (semua terverifikasi kode)**

* **Login & peran** (2026-10-11): owner | kasir; sesi bearer 30 hari;
  halaman Pengguna khusus owner; wajib ganti sandi; nav + rute disaring per
  peran; login (dan login gagal) masuk jejak audit.
* **POS**: satu mode jual + baris Topup/Tarik di dalam keranjang (satu nota
  hybrid); scan `Qty*Kode`, pintasan F1–F12, multi-satuan, diskon baris +
  transaksi, catatan per baris & per nota, harga dinamis editable inline,
  item manual, keranjang persisten, pending/hold, pelanggan + tier grosir,
  **potongan borongan per qty otomatis** (3.5), **tampilan mobile** +
  lapisan bayar fullscreen; fallback HP.
* **Bayar**: tunai/QRIS/transfer; F12 bayar pas; **uang kurang → hutang
  otomatis** (syarat: pelanggan terpilih bukan "Pelanggan Umum"); modal
  resume pasca-bayar + cetak Thermal/A4; kick laci otomatis untuk tunai.
  *(Split payment belum ada — ACC 19 Okt 2026, dijadwalkan.)*
* **Master**: produk (foto, diskon, kadaluarsa, catatan, harga dinamis,
  grosir, borongan, multi-satuan, tombstone), kategori (`track_stock` /
  `use_expiry`), satuan, pelanggan (+tier, +umur hutang), supplier.
* **Stok & pembelian**: restock dengan HPP rata-rata tertimbang, opname,
  riwayat stok ber-referensi nomor nota; **PO supplier**: buat → terima
  (stok masuk + `avg_cost`) → bayar bertahap / batal, hutang supplier +
  aging; rekap pembelian harian; cetak nota PO A4 (§1.6.3, 2026-10-19).
* **Retur & kas**: retur penjualan dari nota / manual + pembatalan (stok
  kembali, uang kembali); pengeluaran kas (terikat shift atau di luar shift);
  kas masuk non-penjualan (§1.6.2, 2026-10-19); pembayaran piutang.
* **Shift**: buka/tutup dengan rumus expected-cash lengkap (topup, QRIS/
  transfer, retur, pembelian, hutang baru, piutang bayar, kas masuk); rekap
  X/Z (thermal + PDF).
* **Laporan** (7 menu): Harian (grafik per jam) · Laba (per hari + per
  nota) · Kasir · Produk · Kategori · Piutang · Stok; tiap menu CSV +
  cetak/PDF; dashboard.
* **Cetak**: struk ESC/POS 32 kolom (thermal) & 64 kolom (A4) — penjualan
  memakai invoice A4 browser; label harga A4/Folio dengan barcode
  EAN-13/EAN-8/Code 128; jeda cetak terpusat.
* **Data & keamanan**: backup harian + manual (retensi 14) + **restore dari
  UI** (backup pengaman otomatis) + jejak audit + guard skema saat boot +
  idempotensi uuid (retry offline aman).

**Keputusan pemilik 19 Okt 2026 (§4):** dikerjakan — scan kamera HP · kas
masuk · cetak/ekspor PO · logo struk · split payment · pesanan jasa + DP ·
analitik lanjutan; ditolak — e-wallet+MDR · price list · bundling · varian ·
akses dari luar LAN; belum dibahas — pengingat hutang WA · absensi staf.
**Sengaja tidak (§5):** PPN · loyalitas · customer display · WA ·
multi-outlet · PPOB integrasi · F&B · email laporan · AI forecasting.

---

## 3. Tabel perbandingan

### 3.1 Transaksi & pembayaran

| Fitur | KulaPOS | Aronium | Kasir Pintar | Olsera | Loyverse | RavaaPOS v2 |
|---|---|---|---|---|---|---|
| Login multi-user + peran | ✓ | ✓ | ✓ | ✓ | ~ | **✓** (owner/kasir) |
| Multi-outlet + transfer stok | ✓ | · | ✓ | ✓ | ✓ | ✗ sengaja (§5) |
| Split payment / split bill | · | · | ✓ | ✓ | · | **✓** (2 metode, atribusi `sale_payments`) |
| Metode bayar kustom / e-wallet (+MDR) | · | ✓ | ✓ | ✓ | ✓ | ✗ ditolak 19 Okt 2026 (4.2; kini 3 metode) |
| Hutang/piutang pelanggan | ✓ | ✓ | ✓ | · | · | **✓** (+aging, +cetak A4) |
| Diskon baris & transaksi | ✓ | ✓ | ✓ | ✓ | · | **✓** (+borongan qty) |
| Pajak (PPN) / service charge | ✓ | ✓ | ✓ | · | · | ✗ sengaja (§5) |
| Laba per transaksi | ✓ | ✓ | ✓ | · | · | **✓** |
| Z-report / rekap tutup shift | ~ | ✓ | ~ | ~ | · | **✓** (X/Z thermal+PDF) |
| Struk thermal + A4/invoice | ✓ | ✓ | ✓ | ✓ | ✓ | **✓** |
| Share struk via WA/email | ✓ | · | ✓ | ✓ | · | ✗ sengaja (§5) |

### 3.2 Stok, harga, pembelian

| Fitur | KulaPOS | Aronium | Kasir Pintar | Olsera | Loyverse | RavaaPOS v2 |
|---|---|---|---|---|---|---|
| Multi-satuan jual (pack/dus) | ~ | · | ✓ | · | · | **✓** |
| Varian produk | · | · | ✓ | ✓ | ✓ | ~ (duplikat SKU manual; 4.9 ditolak 19 Okt 2026) |
| Harga bertingkat per qty / grosir | · | ~ | ✓ | ✓ | · | **✓** (borongan + tier grosir) |
| Price list khusus per pelanggan | · | ✓ (plugin) | ✓ | · | · | ✗ ditolak 19 Okt 2026 (4.7; kini tier saja) |
| Kadaluarsa + peringatan | ✓ | ✓ (plugin) | ~ | · | · | **✓** (per kategori) |
| Restock + HPP rata-rata tertimbang | ✓ | ✓ | ✓ | ✓ | ✓ | **✓** |
| Opname / hitung fisik | ✓ | ✓ | ✓ | · | ✓ | **✓** |
| PO supplier + penerimaan barang | ✓ | ~ | ✓ | ✓ | ✓ (add-on) | **✓** |
| Hutang supplier + aging | ✓ | · | · | · | · | **✓** |
| Retur pelanggan | ✓ | ~ | · | · | · | **✓** |
| Retur/batal ke supplier | ✓ | · | · | · | · | ~ (PO batal saja) |
| Cetak label/barcode | ✓ | · | · | ✓ | ✓ | **✓** (EAN/Code 128) |
| Bundling / paket produk | · | · | ✓ | · | · | ✗ ditolak 19 Okt 2026 (4.8) |

### 3.3 Pelanggan, kas, laporan, platform

| Fitur | KulaPOS | Aronium | Kasir Pintar | Olsera | Loyverse | RavaaPOS v2 |
|---|---|---|---|---|---|---|
| Manajemen pelanggan + riwayat | ✓ | ✓ | ✓ | ✓ | ✓ | **✓** |
| Loyalitas / poin | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ sengaja (§5) |
| Kas masuk & keluar (non-penjualan) | · | · | ✓ | ✓ | · | **✓** (keluar + masuk, 19 Okt 2026) |
| Absensi karyawan | · | · | ✓ | ✓ | ✓ (add-on) | ✗ kandidat 4.14 (belum dibahas) |
| Laporan + export (CSV/Excel) | ✓ | ✓ | ✓ | ✓ | ✓ | **✓** (7 menu) |
| Laporan terjadwal email/WA | · | ✓ (berbayar) | · | ✓ | · | ✗ sengaja (§5) |
| Analitik lanjutan (valuasi/dead stock) | ~ | ✓ | ~ | ✓ | ~ | ✓ selesai 19 Okt 2026 (4.10) |
| Offline-first | · | ✓ (lokal) | ✓ (plugin) | · | ~ | **✓** |
| Tanpa langganan (server sendiri) | ✗ | ✓ (Lite) | ✗ | ✗ | ~ (inti gratis) | **✓** |
| Scan barcode kamera HP | · | · | · | · | ✓ | **✓** (selesai 19 Okt 2026; 4.4) |
| Customer display | · | · | ✓ | · | ✓ (gratis) | ✗ sengaja (§5) |
| Aplikasi HP untuk kasir | · | ✗ | ✓ | ✓ | ✓ | **✓** (PWA mobile view) |

> `Kandidat n` = butir daftar §4; status keputusan (19 Okt 2026) per baris di
> §4. `⟳` = ACC pemilik — dijadwalkan dikerjakan. `Sengaja` = keputusan
> pemilik tercatat di §5. Sel Ravaa yang **tebal** = ada di kode sekarang.

---

## 4. Gap terbuka RavaaPOS (keputusan pemilik 19 Okt 2026)

| # | Kandidat | Keputusan 19 Okt 2026 | Referensi pasar | Catatan (biaya/risiko) |
|---|---|---|---|---|
| 4.1 | **Split payment** (tunai+QRIS satu nota) | **✅ selesai 2026-10-19** — §1.6.5 | Kasir Pintar (split bill/join), Olsera (F&B) | Tabel `sale_payments` (Σ = total) + laporan byMethod + modal 2 metode lebar `wider` |
| 4.2 | **Metode bayar e-wallet + opsi MDR** | **❌ tidak perlu** — tanpa payment gateway; QRIS/transfer manual cukup | KP/Olsera/Loyverse | Konteks: MDR QRIS ≤Rp100 rb = 0% sejak 1 Okt 2026 (BI) |
| 4.3 | **Pesanan jasa + status/DP** | **✅ selesai 2026-10-19** — §1.6.6 | KP vertical Bengkel | Order → dikerjakan → diambil; DP; domain cetak/servis laptop; omzet saat serah, item tanpa potong stok |
| 4.4 | **Scan barcode kamera HP** | **✅ selesai 2026-10-19** — §1.6.1 | Loyverse | API browser (`BarcodeDetector`) tanpa dependensi; butuh konteks aman (HTTPS/localhost) |
| 4.5 | **Kas masuk (di luar penjualan)** | **✅ selesai 2026-10-19** — §1.6.2 | KP, Olsera | Pasangan Pengeluaran; laci/expected-cash + laporan |
| 4.6 | **Cetak/ekspor nota PO** | **✅ selesai 2026-10-19** — §1.6.3 | KP (nota pembelian), Loyverse | Pola dokumen A4 + tombol di sub-halaman PO |
| 4.7 | **Price list per pelanggan** | **❌ tidak perlu** ("sepertinya tidak butuh") | Aronium (plugin) | Tier ecer/grosir + borongan qty dianggap cukup |
| 4.8 | **Bundling / paket produk** | **❌ tidak perlu** ("sepertinya tidak butuh") | Kasir Pintar (paket/bahan baku) | — |
| 4.9 | **Varian produk** | **❌ tidak perlu** | KP, Olsera, Loyverse | Pola SKU terpisah (bungkus/ketengan) dipertahankan |
| 4.10 | **Analitik lanjutan** (valuasi stok, dead stock) | **✅ selesai 2026-10-19** — §1.6.7 | Olsera "Analisa Bisnis", Loyverse add-on | Menu laporan Analitik + endpoint `GET /api/reports/analytics` (valuasi per kategori + tidak laku dalam rentang; CSV/Cetak) |
| 4.11 | **Logo di struk thermal** | **✅ selesai 2026-10-19** — §1.6.4 | KP iOS, Aronium custom receipts | Raster ESC/POS (`GS v 0`) — uji kertas oleh pemilik |
| 4.12 | **Pengingat hutang via WA** | **— belum dibahas** | kebiasaan pasar | Use-case beda dari WA rekap yang dicoret 2026-10-01 |
| 4.13 | **Akses dari luar LAN** | **❌ tidak perlu** | semua cloud | Opsi Tailscale/tunnel ditolak; tetap self-hosted LAN |
| 4.14 | **Absensi staf** | **— belum dibahas** | KP StaffPlus, Olsera, Loyverse | Prioritas rendah di skala 1–2 kasir; login + shift sudah ada |

---

## 5. Sengaja tidak dikerjakan (keputusan tercatat)

* **Poin loyalitas** — dibatalkan pemilik 2026-10-18 ("tidak butuh").
* **PPN/pajak & voucher biaya tambahan** — ditutup permanen 2026-10-06
  (tidak pernah terpakai; jangan diusulkan lagi).
* **Customer display** — pemilik tidak punya display; perintah eksplisit
  jangan dikerjakan (2026-10-06).
* **Share struk/rekap WhatsApp** — dicoret pemilik 2026-10-01 (toko kecil
  tidak perlu notif/rekap WA).
* **Email laporan terjadwal** — tidak diusulkan (butuh SMTP; jalur WA saja
  sudah dicoret).
* **Multi-outlet + transfer stok antar cabang** — di luar domain 1–2 kasir;
  skala >5 device baru pertimbangkan Postgres (AGENTS §1).
* **PPOB terintegrasi (batch provider)** — butuh API partner + saldo
  deposit; topup manual `nominal+admin` sudah mencakup use-case toko ini.
* **Fitur F&B** (kitchen printer, manajemen meja, QR self-order) — bukan
  domain ATK/cetak/jasa.
* **AI forecasting** — versi cukup = alert `min_stock` + laporan per jam
  (dua-duanya sudah ada).
* **Metode bayar e-wallet (OVO/GoPay/DANA/ShopeePay) + jejak MDR** — ditolak
  pemilik 2026-10-19: toko pribadi, tidak ada payment gateway; QRIS/transfer
  manual ("klik konfirmasi") sudah cukup.
* **Price list khusus per pelanggan** — ditolak 2026-10-19 ("sepertinya tidak
  butuh"); tier ecer/grosir + harga borongan per qty sudah menutup kebutuhan.
* **Bundling/paket produk** — ditolak 2026-10-19 ("sepertinya tidak butuh").
* **Varian produk (ukuran/warna)** — ditolak 2026-10-19 ("tidak perlu");
  konflik sadar dengan pola SKU terpisah bungkus/ketengan (AGENTS §1).
* **Akses dari luar LAN (Tailscale/tunnel)** — ditolak 2026-10-19 ("tidak
  perlu"); Ravaa tetap self-hosted LAN.

---

## 6. Koreksi v1 → v2 (agar tidak menyesatkan)

* v1: "Role/login ✗ (belum)" → **✓** sejak 2026-10-11 (owner/kasir);
  catatan "tanpa login (gap diketahui)" di bagian arsitektur dihapus.
* v1: "Pembelian/PO supplier ✗" → **✓** Tahap 3 (2026-10-11), termasuk
  hutang supplier + aging.
* v1: "Retur ✗" → **✓** retur penjualan Tahap 2 (2026-10-11); retur ke
  **supplier** masih belum (PO batal saja).
* v1: "Ravaa hanya restock manual" → sudah ada opname, riwayat stok
  ber-referensi nota, dan PO supplier.
* v1: "hutang manual saja" → + otomatis dari POS (uang kurang), aging FIFO,
  cetak A4.
* v1: "Laporan harian + dashboard 7 hari" → 7 menu laporan + laba per
  nota/kategori + grafik per jam + CSV + cetak.
* v1: "Backup harian (retensi 14)" → + restore dari UI (backup pengaman
  otomatis) + jejak audit + guard skema.
* v1 harga Kasir Pintar: "Pro Rp666.000/thn; +Plugin Business
  Rp1.499.000/thn" → dikoreksi: Rp1.499.000 = bundel **"Heboh"**
  (Pro+Business+Desktop); bundel Pro+Business = **Rp1.133.000/thn**; Pro
  mulai **Rp56.000/bln** (halaman resmi 19 Okt 2026).
* Tambahan v2: **Olsera** & **Loyverse** (§2.4–2.5) + catatan MDR QRIS 0%
  ≤Rp100 rb efektif 1 Okt 2026 (§2.3).

---

## 7. Catatan praktis (dari pengalaman repo)

* **Cetak dari HP**: saat print-agent tidak ada, web menampilkan modal struk
  (tombol Cetak browser / Share); cetak langsung dari HP = printer combo
  USB+Bluetooth + aplikasi RawBT (`apps/print-agent/README.md:15-17`).
* **Struktur biaya**: Ravaa tanpa langganan (server sendiri); yang
  berlangganan membayar lisensi + beberapa menambahkan biaya per toko/
  karyawan (Loyverse) atau per paket (Olsera/Kasir Pintar).
* **Akses dari luar toko**: kompetitor cloud bisa dibuka dari mana saja;
  Ravaa saat ini LAN (Caddy) — opsi VPN/tunnel **ditolak pemilik 19 Okt
  2026** (4.13); tetap self-hosted LAN.

---

## Sumber & tanggal akses

**Diambil langsung 2026-10-19:**

* Kasir Pintar: <https://kasirpintar.co.id/> ·
  <https://kasirpintar.co.id/harga> · <https://kasirpintar.co.id/bengkel> ·
  blog "Pemberitahuan Kebijakan MDR QRIS 0% dan Evaluasi Skema Layanan
  Winpay" (13 Okt 2026).
* Olsera: <https://www.olsera.com/en> · <https://www.olsera.com/en/pricing>
* Loyverse: <https://loyverse.com/pricing> · <https://loyverse.com/features>
  · help.loyverse.com — "Barcodes Scanning by Built-in Device Camera"
* Aronium: <https://help.aronium.com/> — artikel "How to buy a license"
  (dibarui 17 Okt 2026).

**Dari riset v1 2026-10-06** (situs berbasis JS — tidak bisa di-fetch ulang):

* Aronium: aronium.com/en/features, /en/download, release notes, help center.
* KulaPOS: transcript demo + screenshot lokal (`kula-01` … `kula-12`).
* Tren pasar/harga umum: panduan pembeli & blog pembanding (founderplus.id
  dsb.).

**RavaaPOS v2:** kode repo ini — `AGENTS.md` §1–§3, `db/schema.sql`,
`apps/web/src` (pos.ts, pos-mobile.ts, reports.ts, purchases.ts, returns.ts,
expenses.ts, debts.ts, audit.ts, users.ts, labelsheet.ts, escpos.ts,
invoice.ts, ui/auth.ts), `apps/api/src/index.ts`, `tests/` — dicek
2026-10-19.
