---
name: ravaa-pos
description: Domain Ravaa POS v2 — alur kasir, kontrak API, skema DB, struk ESC/POS 58mm, dan perintah run/test. Muat sebelum mengerjakan repo ravaaposv2.
---

# ravaa-pos — skill domain kasir

## Kapan dipakai

Setiap tugas menyentuh `~/Projects/ravaaposv2/`: tambah produk, ubah harga/stok,
alur bayar, topup/tarik, shift, laporan, struk, print-agent, docker home server.

## Referensi wajib (baca sesuai kebutuhan, JANGAN mengarang isinya)

* Kontrak & aturan: `.opencode/agents/AGENTS.md`
* Skema: `db/schema.sql` — sumber kebenaran tabel/kolom
* API: `apps/api/src/index.ts` — endpoint eksak + validasi + kode error
* UI: `apps/web/src/main.ts`, cache `apps/web/src/store.ts`, offline `apps/web/src/api.ts`
* Struk: `apps/web/src/escpos.ts` (32 kolom, INIT `1b 40`, CUT `1d 56 00`)
* Printer: `apps/print-agent/server.js` (`POST /print {data_base64}`, `GET /health`)

## Alur kerja standar

1. Baca `AGENTS.md` §3 (kontrak) sebelum usul endpoint — endpoint di luar daftar = tidak ada.
2. Perubahan data: cek `categories.track_stock` dulu. Jasa/cetak/desain/topup TIDAK boleh
   mengurangi stok, TIDAK boleh masuk `stock_moves` kecuali `reason='sale'` dari barang fisik.
3. Uang: integer rupiah, `total = subtotal - discount`, `change = max(0, cash_in - total)`,
   topup `total = nominal + admin`. Jangan pakai float.
4. Struk: tiap baris `<= 32` char ASCII (fungsi `clean()` di escpos.ts melucuti non-ASCII).
   Setelah ubah builder, buktikan dengan menjalankan potongan kode dan ukur panjang baris.
5. Uji API dengan curl nyata, contoh:
   ```bash
   curl -s localhost:3001/health
   curl -s 'localhost:3001/api/products?since=0' | head -c 500
   curl -s -X POST localhost:3001/api/sales -H 'content-type: application/json' \
     -d '{"shift_id":null,"items":[{"product_id":1,"qty":1}],"pay_method":"tunai"}'
   ```
   Tempel output persis di jawaban. Bila server belum jalan/mati, katakan begitu —
   jangan karang respons JSON.
6. Offline & 2 kasir: sales/topup memakai `id` uuid client (idempotent antar-device).
   Shift: 1 open per kasir (`idx_shifts_open_cashier`); jangan gabungkan/berbagi shift
   antar device. Stok: cek-kurang atomic di dalam transaction single-proses — jangan
   pecah jadi SELECT lalu UPDATE terpisah.

## Larangan domain

* Jangan satukan nominal+admin topup jadi satu angka di laporan — keduanya dilaporkan terpisah.
* Jangan gabung SKU rokok bungkus & ketengan.
* Jangan kunci harga produk `price_dynamic=1` dari master — harganya dari transaksi.
* Jangan ubah port 3000/3001/9100 tanpa update vite.config + infra + README serentak.
