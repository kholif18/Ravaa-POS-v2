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

---

## 2. Fase 2 — Analitik (setelah Fase 1)

| # | Butir | Catatan |
|---|-------|---------|
| 2.1 | **Laporan penjualan per jam** | `GET /api/reports/daily` tambah `byHour` (`strftime('%H', created_at)`, aturan UTC sama) + grafik batang di `#/reports`. Tren 2026: "4 laporan wajib" = per jam salah satunya. Endpoint lama diperluas (bukan baru) — update §3. |
| 2.2 | **Laporan penjualan per kategori** | `byCategory` = `sale_items` -> `products` -> `categories`, grup per kategori (jasa/cetak vs barang fisik terlihat beda sumbangsihnya). |
| 2.3 | **Tahan nota (transaksi tertunda)** | Simpan keranjang sementara (IndexedDB, per device) + tombol Recall; meniru Aronium "named order"/Erzap "F3 pending". Gap: grep `hold\|tunda\|pending` = 0 di `pos.ts`. Tanpa skema baru (belum tentu sinkron antar device — cukup per kasir). |
| 2.4 | **Margin (laba) per produk di laporan** | `topItems` sudah ada qty/amount; tambah `hpp` & `laba` per baris (angka `cost` sudah di-snapshot per baris — cukup `SUM(qty*cost)`). |

## 3. Fase 3 — Fitur relasional (butuh ACC pemilik per butir)

> Tiap butir = tabel/kontrak baru -> migrasi re-create DB (kebijakan
> 2026-09-26 §5 AGENTS) + backup dulu. Jangan dikerjakan berurutan tanpa ACC.

| # | Butir | Sumber ide | Keputusan yang dibutuhkan |
|---|-------|-----------|---------------------------|
| 3.1 | **Pelanggan (tabel `customers`)** — nama/no HP di nota, riwayat belanja | Kasir Pintar "Manajemen Pelanggan" (free), semua app Indonesia | Wajib opsional? integrasi ke struk? |
| 3.2 | **Loyalty poin** | Kasir Pintar (plugin), Moka CRM, tren 2026 | Rumus poin (Rp1000=1pt?) + nilai tukar |
| 3.3 | **Hutang/piutang tempo** | Kasir Pintar free "Hutang/Piutang", Aronium "credit payments" | Siapa yang boleh nyicil (langganan kantor?) |
| 3.4 | **Split payment** (tunai+QRIS satu nota) | Tren 2026, Erzap/Moka | Skema `sale_payments` baru + laporan byMethod |
| 3.5 | **Harga grosir per jumlah** (`min_qty` di `product_units`) | Kasir Pintar "Tipe Harga", Olsera harga grosir | Ambang qty per satuan |
| 3.6 | **Supplier & riwayat pembelian (PO)** | Kasir Pintar free, Loyverse purchase order | Cukup nama supplier di `restock`? |

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
- **Refund/retur jual** — keputusan lama tetap berlaku: riwayat bersifat
  catatan (koreksi = opname + transaksi baru); diagnostik dulu sebelum membuka.

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
