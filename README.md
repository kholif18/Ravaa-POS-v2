# Ravaa POS v2

**Kasir self-hosted untuk toko ritel & jasa** — ATK, Cetak, Desain, Jasa ketik &
service Laptop/PC, Topup e-wallet / Tarik tunai, Es krim, Minuman, Snack, Rokok.

Berjalan di **home server sendiri** (LAN, tanpa cloud): 1–2 kasir bersamaan
(umumnya 1 aktif) + fallback HP Android, database SQLite terpusat, antarmuka web
cepat (SPA + PWA), struk thermal 58mm ESC/POS via print-agent, dokumen A4 lewat
cetak browser.

→ Panduan instalasi lengkap: **[INSTALL.md](INSTALL.md)**

## Fitur

**Kasir (POS)**
- Scan barcode USB / kamera HP (kamera butuh HTTPS LAN), cari produk multi-kata
- Multi-satuan (pcs/pak/dus), harga borongan bertingkat per qty, harga dinamis
- Diskon per baris + diskon transaksi, catatan per baris & per nota
- Keranjang persisten + transaksi tertahan (hold) per device
- Topup & tarik tunai dalam SATU transaksi bersama produk, potongan bank (`bank_fee`)
- Split payment 2 metode (tunai + QRIS/transfer), bayar pas (F12), hutang otomatis
- Pintasan keyboard penuh (F1–F12, Alt+N), tampilan desktop & mobile terpisah
- Offline: transaksi mengantre (outbox) dan terkirim otomatis saat online

**Operasional toko**
- Pesanan jasa: DP → dikerjakan → serah (nota penjualan) / batal (refund DP)
- Hutang/piutang: otomatis dari POS + manual, bukti pembayaran thermal/A4, aging 30 hari
- Pembelian: PO → terima bertahap (sebagian) → cicil bayar; retur ke supplier
- Retur penjualan dari nota (stok masuk, uang kembali ke pelanggan)
- Pengeluaran & kas masuk non-penjualan; tutup shift dengan rekap Z (thermal/PDF)
- Stok: restock (rata-rata modal tertimbang), opname, mutasi stok, kadaluarsa

**Laporan & data**
- 8 menu laporan: Harian, Laba, Kasir, Produk, Kategori, Piutang, Stok, Analitik
- Semua laporan + dokumen A4 (invoice, nota PO, ledger hutang) dicetak sebagai PDF
- Label harga + barcode lembar A4 (EAN-13/EAN-8/Code 128)
- Backup otomatis harian + restore dari UI; jejak audit
- Hak akses granular: 36 izin operasional, PIN 6 digit + auto-lock layar

## Struktur

```
apps/api/          # API Hono + SQLite :3001 — satu-satunya yang menulis DB
apps/web/          # SPA kasir Vite+TS + PWA :5656
apps/print-agent/  # HTTP → printer USB 58mm :9100 (tanpa dependensi)
db/                # schema.sql + seed.sql (sumber kebenaran skema & master)
infra/             # Docker, Caddy, deploy native, gen-cert.sh (HTTPS LAN)
docs/              # perbandingan dengan kompetitor
tests/             # regresi penuh (`npm test`)
```

## Mulai cepat (dev)

```bash
npm install
npm run seed   # buat DB + data master
npm run dev    # api :3001 + web :5656 sekaligus
```

Buka `http://localhost:5656`, login **owner / admin1234** (wajib ganti sandi saat
login pertama). Lengkapnya — server produksi, Docker, native STB/ARM,
print-agent, HTTPS LAN, backup — di **[INSTALL.md](INSTALL.md)**.

## Dokumentasi lain

- `INSTALL.md` — penginstalan lengkap & operasional harian
- `ROADMAP.md` — rencana & status pengembangan
- `docs/perbandingan-pos.md` — perbandingan fitur dengan kompetitor
- `.opencode/agents/AGENTS.md` — kontrak teknis untuk AI agent
