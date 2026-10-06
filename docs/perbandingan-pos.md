# Perbandingan Fitur POS: KulaPOS · Aronium · Kasir Pintar · RavaaPOS

> Disusun 2026-10-06 sebagai bahan referensi pengembangan Ravaa POS v2.
>
> **Sumber:**
> * **KulaPOS** — riset lokal: transcript demo video + screenshot
>   `~/tmp opencode/kulapos-transcript.txt`, `kula-01-dashboard.png` …
>   `kula-12-pos-laporan.png` (fitur = apa yang terlihat/disebut di demo).
> * **Aronium** — situs resmi `aronium.com/en/features`,
>   `aronium.com/en/download`, release notes (diakses 2026-10-06).
> * **Kasir Pintar** — situs resmi `kasirpintar.co.id`,
>   `help.kasirpintar.co.id`, `kasirpintar.org` (diakses 2026-10-06).
> * **RavaaPOS v2** — repo ini (`AGENTS.md` §1–§3 + kode
>   `apps/web`, `apps/api`) — semua butir terverifikasi di kode.

---

## 1. KulaPOS (demo — sistem multi-outlet)

* **Akun & role**: login berjenjang **Owner / Manajer (mengawasi beberapa
  toko) / Kasir**; manajemen karyawan (`kula-06-management-kasir.png`);
  shift kasir.
* **Dashboard**: penjualan hari ini, **estimasi laba kotor & laba bersih**,
  pengeluaran, jumlah transaksi.
* **Transaksi/POS** (`kula-02`, `kula-07`): multi-outlet, **pajak (PPN) +
  service charge**, promo, **poin loyalitas** pelanggan, retur ke pelanggan
  (uang kembali), laba per transaksi.
* **Produk** (`kula-08`): master produk + kategori, **multi-kemasan/ukuran
  per produk**, lacak **serial number** (produk tertentu), batas minimum
  stok, **expired date** + peringatan.
* **Stok & mutasi**: penyesuaian stok fisik, **transfer stok antar cabang**,
  shortcut restock, gudang.
* **Pembelian** (`kula-10`): PO ke supplier, **faktur supplier**, status
  barang masuk (belum otomatis menambah stok), pembelian langsung.
* **Supplier** & **pelanggan** (`kula-11`): database pelanggan + poin,
  **piutang bers tempo**, **hutang** ke supplier, share bukti pembayaran
  via **WhatsApp**.
* **Retur & garansi**: retur ke pelanggan & ke supplier, klaim garansi.
* **Cetak barcode & label**: label harga / stiker / label lembar + cetak
  barcode produk.
* **Lain-lain**: master outlet (`kula-03`, `kula-09`), pengaturan printer
  (`kula-04`), daftar transaksi (`kula-05`), laporan (`kula-12`).

## 2. Aronium (POS Windows — Lite gratis / Pro $10 per bulan)

* **Kasir**: unlimited produk/dokumen/pelanggan/user; **layout standar &
  touch screen**; metode bayar kustom; barcode & **weight barcode**; diskon;
  **promotions & happy hour**; pajak & **tax exempt sale**;
  **credit payments (hutang)**; struk cetak & elektronik; **custom
  receipts** (logo/header/footer/terjemahan); catatan (notes);
  **takeaway/dine-in** (plugin); **Z report** akhir hari; custom rounding.
* **Inventori**: stok sederhana + **inventory count (opname)**, kelompok
  produk, cari by barcode/SKU/nama, **product history**, stock control.
* **Pelanggan**: **loyalty cards**; **price lists** berbeda per
  kasir/pelanggan (retail/grosir — plugin $5/bulan).
* **Laporan/analytics dashboard**: penjualan real-time, best sellers,
  pelanggan, diskon, purchase invoice list, transaction history, return
  stock report.
* **Multi-komputer satu database** (Pro); **backup otomatis terjadwal**;
  merge duplikat produk; floor plans (resto); keamanan user/permission.
* **Plugin eksternal**: **kedaluarsa (gratis)**, dual currency, e-invoice
  wilayah (KSA/Fatoora/Vanuatu/Fiji), print stations dapur/bar, MRP,
  logo login.

## 3. Kasir Pintar (POS Indonesia — Android/iOS/Desktop, cloud, berbayar)

* **Kasir**: scan barcode, **tunai/non-tunai + QRIS** (+ notifikasi suara
  QRIS), **Mode Nominal**, struk thermal/A4 + **share via WhatsApp/Email**,
  diskon & pajak per transaksi (diskon khusus pelanggan saat itu),
  **ubah harga sementara**, tipe harga per pelanggan.
* **Barang**: **auto-input SKU**, multi satuan (pcs/lusin/kodi),
  **varian (warna/ukuran/rasa)**, **bundling/paket**, IMEI, bahan baku
  (F&B), import sampai 3000 barang (plugin).
* **Keuangan**: **piutang & hutang (kasbon)**, laba rugi, arus kas, laporan
  penjualan/pembelian harian & bulanan.
* **Pembelian**: catat ke supplier, **draft pembelian**, sinkronisasi awal
  barang/pelanggan/supplier.
* **PPOB**: pulsa, listrik, BPJS, PDAM (diklaim "POS pertama dengan PPOB").
* **Loyalitas**: poin otomatis per transaksi + tambah poin manual +
  import poin.
* **Metode bayar kustom** + **MDR otomatis** (GoPay/OVO/GrabFood),
  **split bill/join**.
* **Operasional**: **absensi staf** (radius, selfie), shift,
  **log owner/staf**, **customer display**, **QR Order & QR Meja**
  (self-order), **toko online (Olshopin)**, sinkronisasi cloud,
  **POS offline desktop/server**, iOS POS, hardware resmi.
* **Harga**: Pro **Rp666.000/tahun**; +Plugin Business
  **Rp1.499.000/tahun** (sumber: kasirpintar.org).

## 4. RavaaPOS v2 (repo ini — self-hosted, toko ATK/cetak/jasa)

* **Kasir**: tab 7+ kategori, search multi-kata, scan bar `Qty*Kode`,
  pintasan **F1–F12**, **multi-satuan jual (pack/dus)**, **diskon per baris
  + transaksi**, **catatan per baris (`use_note`)**, **harga khusus edit
  inline** (key baris `<id>:<unit>:<harga>` — beda harga = baris baru),
  item manual, **keranjang persisten** (selamat refresh/pindah halaman),
  **Pending/hold (modal split antrian + preview)**, pilih pelanggan (F9)
  inline.
* **Bayar**: modal 2-panel tunai/QRIS/transfer, chip pecahan +
  **uang pas (F12)**, **uang kurang → hutang otomatis** (ledger per
  pelanggan), **modal resume + pilihan Thermal/A4** setiap penjualan.
* **Cetak**: struk ESC/POS **32 kolom thermal** + 64 kolom A4, **invoice
  A4** (kop toko `store_*`), label harga, print-agent nol-dependensi,
  preferensi per-device.
* **Topup/tarik**: nominal bebas + **admin editable** (mutasi modal vs
  pendapatan jasa terpisah), suggest admin.
* **Master**: produk (foto, kadaluarsa per kategori `use_expiry`,
  soft-delete tombstone), satuan, kategori (`track_stock`/`use_expiry`),
  **pelanggan + hutang/piutang ledger** (manual + otomatis dari POS).
* **Stok**: restock + **`avg_cost` (HPP rata-rata tertimbang)**, **opname**,
  riwayat stok + referensi nomor nota, saklar **"stok boleh minus"** &
  **"tolak jual kadaluarsa"**.
* **Shift**: buka/tutup + **selisih expected-cash**; **riwayat transaksi**
  + **cetak ulang struk**.
* **Laporan**: harian (omzet/HPP/laba/diskon/metode bayar/top item/stok
  menipis + CSV), dashboard 7 hari, **backup harian + manual (retensi 14)**.
* **Arsitektur**: **offline-first** (outbox + delta sync IndexedDB,
  tombstone perubahan), SQLite WAL, 1–2 kasir/device, tanpa login (gap
  diketahui), tanpa kerangka/framework (vanilla TS + Tailwind build-time).

---

## 5. Ringkasan perbandingan (✓ ada, ✗ tidak ada, ~ parsial)

| Domain | KulaPOS | Aronium | Kasir Pintar | RavaaPOS |
|---|---|---|---|---|
| Role/login multi-user | ✓ | ✓ | ✓ | ✗ (belum) |
| Multi-outlet + transfer antar cabang | ✓ | ✓ (Pro) | ✓ | ✗ |
| Pembelian/PO supplier + faktur | ✓ | ~ (documents) | ✓ | ✗ |
| Retur (ke pelanggan & supplier) | ✓ | ~ | ✓ | ✗ |
| PPN/pajak transaksi | ✓ | ✓ | ✓ | ✗ |
| Poin loyalitas | ✓ | ✓ | ✓ | ✗ |
| PPOB | ✗ | ✗ | ✓ | ✗ (topup manual saja) |
| Hutang/piutang per pelanggan | ✓ | ✓ | ✓ | ✓ |
| HPP/laba per item | ~ (estimasi) | ✓ | ✓ | ✓ |
| Kadaluarsa / expiry | ✓ | ✓ (plugin) | ~ | ✓ (per kategori) |
| Multi-satuan jual | ~ | ~ | ✓ | ✓ |
| Harga khusus per transaksi | ~ | ~ | ✓ (ubah harga sementara) | ✓ (inline) |
| Struk thermal + A4/invoice | ✓ | ✓ | ✓ | ✓ |
| Barcode + label harga | ✓ | ✓ | ✓ | ✓ |
| Opname/inventory count | ✓ | ✓ | ✓ | ✓ |
| **Offline-first jual tanpa internet** | ✗ | ✓ (lokal Windows) | ✓ (mode offline) | **✓** |
| Cetak struk dari server sendiri (nol cloud) | ~ | ✓ | ~ | **✓** (print-agent) |
| Gratis biaya lisensi | ✗ | ✓ (Lite) | ✗ (berbayar/thn) | **✓** (self-hosted) |

## 6. Celah RavaaPOS vs lain (urutan saran prioritas)

1. **Login/akun kasir + role** — ketiga kompetitor punya; Ravaa sengaja
   belum (catatan: jangan diusulkan sembarangan, sudah ada keputusan
   pemilik soal batas ini).
2. **Pajak (PPN) + service charge** — KulaPOS/Aronium/Kasir Pintar semua
   punya; Ravaa belum ada kolom pajak sama sekali.
3. **Pembelian/PO supplier + retur** — untuk toko dengan barang masal
   (ATK/snack) ini inti stok; Ravaa hanya restock manual.
4. **Loyalitas/poin pelanggan** — sudah ada master pelanggan + hutang;
   poin adalah perpanjangan natural.
5. **Multi-outlet** — hanya relevan bila toko berkembang; pertimbangkan
   di akhir (skala 1–2 kasir saat ini belum butuh).

*Referensi adaptasi UI sudah berjalan sejak awal: layout POS Ravaa memakai
KulaPOS sebagai acuan urutan atas-ke-bawah (info bar → scan bar → tabel +
sidebar bayar), modal bayar/pending memakai RavaaPOS v1, dan payment screen
memakai pola Aronium F10 — lihat `AGENTS.md` §2.*
