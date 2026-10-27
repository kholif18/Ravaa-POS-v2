# Instalasi Ravaa POS v2

Panduan lengkap: dari laptop dev sampai home server produksi (Docker maupun
native), plus operasional dasar.

## Prasyarat

| Kebutuhan | Ket |
|---|---|
| Node.js ≥ 20 + npm | semua mesin; mode native memasang Node 22 arm64 otomatis bila kurang |
| Docker + compose plugin | hanya mode Docker |
| Caddy | mode native, melayani web di :5656 (`sudo apt install caddy`) |
| openssl | generate cert HTTPS LAN |
| sqlite3 CLI | opsional — update.sh memakainya untuk backup tanpa henti |
| printer thermal 58mm USB | di PC kasir; butuh grup `lp` di Linux |
| jaringan LAN | server, PC kasir & HP harus satu jaringan |

**Port (jangan diubah tanpa menyentuh `apps/web/vite.config.ts` + `infra/*` sekaligus):**

- `5656` — web kasir (HTTPS saat pakai cert LAN)
- `3001` — API
- `9100` — print-agent (di PC kasir saja)

---

## 1. Dev di laptop

```bash
git clone github.com:kholif18/Ravaa-POS-v2.git && cd Ravaa-POS-v2
npm install          # better-sqlite3 dikompilasi (butuh gcc/python3/make)
npm run seed         # buat apps/api/data/data.db + data master awal
npm run dev          # api :3001 + web :5656 sekaligus
```

Terpisah bila perlu: `npm run dev:api` · `npm run dev:web` · di PC kasir
`npm run dev:agent` (struk USB, :9100). Regresi penuh: `npm test` (butuh API
:3001 hidup).

Login awal: **owner / admin1234** — akun seed wajib ganti sandi saat login
pertama; sandi minimal 8 karakter.

> **Data master** (kategori/produk/satuan/harga awal) dituang di `db/seed.sql`.
> Perubahan master dari UI di dev wajib ikut ditambahkan ke seed agar server
> baru mulai dari master yang sama. **Data transaksi dev** (`apps/api/data/`)
> jangan disalin ke server produksi kecuali memang disengaja.

---

## 2. Pasang di server — script `install.sh`

Dari folder repo di server:

```bash
./install.sh               # interaktif: pilih Docker atau native
./install.sh docker        # Docker (API + web/Caddy di kontainer)
./install.sh native        # systemd user service + Caddy host (hemat RAM, STB/ARM)
./install.sh docker --cert # + generate cert HTTPS LAN
```

Yang dilakukannya:

- cek prasyarat (node ≥ 20; docker bila mode Docker)
- `npm install` + build web
- seed DB — **bila DB lama ada, dibackup dulu** (`data.db.bak.install`)
- mode **docker**: generate cert HTTPS LAN bila belum ada, lalu
  `docker compose up -d --build`
- mode **native**: delegasi ke `infra/deploy-native.sh` (Node otomatis →
  build → seed → systemd user service `ravaa-api`, DB `~/ravaa-data/data.db`),
  lalu menyesuaikan path service bila repo tidak di `~/ravaaposv2`

Selesai mode native, pasang Caddy (sekali, butuh sudo):

```bash
sudo apt install -y caddy
sudo cp infra/Caddyfile.server /etc/caddy/Caddyfile
sudo mkdir -p /etc/caddy/certs
sudo cp infra/certs/ravaa-selfsigned.* /etc/caddy/certs/   # bila pakai HTTPS LAN
sudo systemctl reload caddy
```

Setelah instalasi bersih, **buka shift pertama** dari menu *Shift Kasir* (POS
membutuhkan shift terbuka).

---

## 3. Mode Docker (manual)

```bash
cd infra
bash gen-cert.sh            # HTTPS LAN — cert self-signed, SEKALI
docker compose up -d --build
```

- Web: `https://<ip-server>:5656` — peringatan sertifikat muncul sekali per
  perangkat, tap **Lanjutkan ke situs**.
- API: `http://<ip-server>:3001/health`
- Seed jalan otomatis tiap start kontainer (idempoten). Data SQLite di volume
  Docker `api-data`.
- IP LAN berubah / cert hampir kedaluwarsa: jalankan ulang `bash gen-cert.sh
  <ip>` lalu `docker compose restart web`.

---

## 4. Mode native STB/ARM (tanpa Docker, manual)

```bash
sh infra/deploy-native.sh
```

Skrip: install Node 22 arm64 bila perlu → npm install → build web → seed
(DB di `~/ravaa-data/data.db`) → pasang systemd **user** service
(`ravaa-api`, auto-restart) → cek health. Lalu Caddy seperti di atas.

Operasional service:

```bash
systemctl --user status ravaa-api
journalctl --user -u ravaa-api -f
systemctl --user restart ravaa-api
```

---

## 5. PC kasir & print-agent (struk USB)

Print-agent jalan di PC yang tersambung printer thermal — bukan di server:

```bash
cd apps/print-agent
npm start          # :9100
```

- Menulis struk ke `PRINTER_PATH` bila di-set, lalu `/dev/usb/lp0`, lalu file
  fallback `out/`.
- Butuh grup `lp`: `sudo usermod -aG lp $USER` (login ulang).
- Di web kasir: **Sistem → Cetak struk** → alamat agent
  (`http://<pc-kasir>:9100`), kick laci bisa diatur byte-nya.
- Dokumen A4 & label tidak lewat print-agent — dicetak lewat browser
  (`window.print()`), pas untuk printer inkjet (mis. Epson L3110/L1210).

---

## 6. HTTPS LAN (wajib untuk scan kamera)

Pemindai barcode kamera HP (`getUserMedia`) hanya jalan di **konteks aman**
(HTTPS atau localhost). Tanpa domain publik, solusinya sertifikat
self-signed:

```bash
bash infra/gen-cert.sh              # IP otomatis dari hostname -I
bash infra/gen-cert.sh 192.168.1.5  # atau IP eksplisit
```

- Hasil: `infra/certs/ravaa-selfsigned.{crt,key}` — di-gitignore, key rahasia.
- Docker: mount otomatis lewat compose. Native: salin ke `/etc/caddy/certs/`
  (Caddyfile.server sudah menunjuk ke situ).
- Berlaku 3650 hari; jalankan ulang bila IP LAN berubah.
- HP: peringatan "tidak aman" muncul sekali → tap **Lanjutkan ke situs** →
  kamera + PWA aktif.

---

## 7. PWA di HP kasir

Buka `https://<ip-server>:5656` → pasang sebagai aplikasi (menu browser →
**Tambahkan ke layar utama**). Service worker hanya meng-cache shell — data
API selalu dari jaringan; transaksi offline mengantre di outbox dan terkirim
otomatis begitu server terjangkau lagi.

---

## 8. Login & peran

- Akun pertama: **owner / admin1234** (wajib ganti sandi).
- Peran: `owner` (semua menu) / `kasir` (POS + Riwayat + Retur + Pelanggan +
  Hutang + Stok + shift-sendiri).
- Hak granular di halaman **Pengguna**: 36 izin operasional, preset
  Standar/Ketat, PIN 6 digit + auto-lock layar per device.
- Tiap device kasir WAJIB nama kasir berbeda + shift sendiri.

---

## 9. Backup & restore

- **Otomatis**: API membuat backup sekali saat hidup lalu cek tiap jam
  (idempoten per hari UTC). File di `apps/api/data/backups/` (native:
  `~/ravaa-data/backups/`), retensi 14 terbaru.
- **Restore dari UI**: Sistem → Backup data → tombol **Pulihkan** per file.
  Server memverifikasi integritas, membuat backup pengaman otomatis, dan
  memulihkan **tanpa restart API** (sesi login ikut kembali ke snapshot —
  device lain bisa ter-logout).
- **Restore manual (darurat)**:

  ```bash
  systemctl --user stop ravaa-api
  cp ~/ravaa-data/backups/data-2026-10-02-140135.db ~/ravaa-data/data.db
  systemctl --user start ravaa-api
  ```

---

## 10. Update dari repo

```bash
./update.sh            # deteksi mode (docker/native) otomatis
./update.sh docker
./update.sh native
```

Urutan: **backup DB → git pull → npm install → build → restart service → cek
health**. Mode Docker: backup lewat kontainer API lalu rebuild.

**Skema DB tidak di-ALTER otomatis** (kebijakan migrasi manual). Bila log API
menampilkan blok `[SKEMA DB TIDAK SINKRON]` saat start, jalankan perintah
`ALTER TABLE …` yang tercetak di sana — backup dulu.

---

## 11. ENV API

| Variabel | Ket |
|---|---|
| `DB_PATH` | lokasi SQLite (default `apps/api/data/data.db`; native: `~/ravaa-data/data.db`; Docker: `/data/data.db`) |
| `PORT` | port API (default 3001) |
| `CORS_ORIGIN` | **default kosong = same-origin saja** (aman). Isi CSV origin asli HANYA bila ada host lintas-origin nyata. Nilai `*` TIDAK didukung. |
| `CASHIER_DEFAULT` | nama kasir bawaan (default `kasir`) |

Semua deploy Docker/native memakai Caddy proxy `/api` → :3001 same-origin,
jadi `CORS_ORIGIN` tidak perlu diisi.

---

## 12. Masalah umum

- **`npm install` gagal build better-sqlite3** → butuh gcc/python3/make
  (node-gyp). Baca error persisnya, jangan menebak.
- **Kamera di HP tidak bisa dibuka** → belum HTTPS. Pasang cert LAN (seksi 6).
- **500 "database tidak sinkron dengan skema (no such column …)"** → DB
  ketinggalan kolom. Baca blok `[SKEMA DB TIDAK SINKRON]` di log saat API
  start — daftar kolom + perintah `ALTER TABLE … ADD COLUMN` siap tempel ada
  di sana.
- **Sesi login hilang setelah restore** → by design (sesi ikut snapshot DB).
- **Port bentrok** → pastikan 5656/3001/9100 bebas di mesin masing-masing.
- **Backup harian tambahan (opsional)**: `crontab -e` →
  `0 2 * * * cp ~/ravaa-data/data.db ~/ravaa-data/backup-$(date +\%F).db`
