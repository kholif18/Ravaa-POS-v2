#!/usr/bin/env bash
# Perbarui Ravaa POS v2 dari repo. Jalankan dari folder repo (server):
#
#   ./update.sh            # deteksi mode (docker/native) otomatis
#   ./update.sh docker
#   ./update.sh native
#
# Urutan: backup DB -> git pull -> npm install -> build -> restart -> cek health.
# Skema DB TIDAK di-ALTER otomatis (kebijakan migrasi manual) — bila log API
# menampilkan [SKEMA DB TIDAK SINKRON], jalankan ALTER yang tercetak di sana.
set -euo pipefail
cd "$(dirname "$0")"
REPO="$PWD"
# compose file WAJIB disebut eksplisit (-f) di SEMUA perintah docker compose:
# script ini cd ke root repo (bukan infra/), jadi tanpa -f compose mencari
# docker-compose.yml di cwd dan gagal "no configuration file provided"
# (bug nyata 2026-11-01 pada langkah backup).
COMPOSE_FILE="$REPO/infra/docker-compose.yml"

MODE="${1:-}"
case "$MODE" in
  ""|docker|native) ;;
  *) echo "pemakaian: ./update.sh [docker|native]" >&2; exit 1 ;;
esac

if [ -z "$MODE" ]; then
  SvcDocker=""
  if command -v docker >/dev/null 2>&1; then
    # ditangkap ke variabel dulu (bukan pipe ke grep -q) supaya pipefail/ SIGPIPE
    # tidak membuat deteksi mode salah baca.
    SvcDocker="$(docker compose -f "$COMPOSE_FILE" ps --services 2>/dev/null || true)"
  fi
  if [ -n "$SvcDocker" ]; then
    MODE=docker
  elif systemctl --user list-unit-files 2>/dev/null | grep -q '^ravaa-api'; then
    MODE=native
  else
    echo "tidak bisa mendeteksi mode (docker tidak jalan & service ravaa-api tidak ada)." >&2
    echo "jalankan eksplisit: ./update.sh docker   atau   ./update.sh native" >&2
    exit 1
  fi
fi
echo "== update Ravaa POS v2 — mode $MODE =="

sudut_utc() { date -u +%F; }
jam_utc()   { date -u +%H%M%S; }

if [ "$MODE" = "docker" ]; then
  # --- Docker: backup via kontainer api (better-sqlite3 .backup) ---
  BA=""
  # Hasil ps ditangkap dulu (bukan `… | grep -q`): grep -q menutup pipe lebih
  # awal → dengan pipefail bisa kena SIGPIPE dan statusnya salah baca.
  PS_API="$(docker compose -f "$COMPOSE_FILE" ps api 2>/dev/null || true)"
  if printf '%s' "$PS_API" | grep -qi "running\|Up"; then
    echo "-- backup DB (dalam volume api-data) …"
    # Catatan: db.backup() mengembalikan Promise — tanpa di-await lalu db.close()
    # dipanggil duluan, muncul "The database connection is not open" dan file
    # backup bisa gagal setengah jadi (bug nyata 2026-11-01). async IIFE +
    # await menunggu backup benar-benar selesai sebelum exit (non-0 = gagal →
    # set -e MEMBATALKAN update, pola integrity check mode native).
    # Tulis ke /data/backups/ (BUKAN /data/ root) — folder yang sama dengan
  # POST /api/backup: supaya file ikut tampil di daftar backup UI DAN ikut
  # retensi KEEP=14 (dijalankan buatBackup berikutnya). Sebelum 2026-11-01
  # file update.sh jatuh di root /data: tidak terbaca daftarBackup() dan
  # tidak pernah dibuang — tiap update +1 file permanen (klaim komentar
  # lama "muncul juga di daftar backup UI" ternyata keliru).
  if ! BA="$(docker compose -f "$COMPOSE_FILE" exec -T api node -e '
(async () => {
  const bs = require("better-sqlite3");
  const fs = require("fs");
  const db = new bs(process.env.DB_PATH || "/data/data.db");
  const d = new Date(), p = n => String(n).padStart(2, "0");
  const name = "data-" + d.getUTCFullYear() + "-" + p(d.getUTCMonth()+1) + "-" + p(d.getUTCDate())
    + "-" + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + ".db";
  fs.mkdirSync("/data/backups", { recursive: true });
  await db.backup("/data/backups/" + name);
  db.close();
  console.log(name);
})().catch((e) => { console.error(e); process.exit(1); });
')"; then
      echo "!! backup DB GAGAL — update DIBATALKAN (data tidak disentuh)" >&2
      exit 1
    fi
    [ -n "$BA" ] || { echo "!! backup DB gagal (nama kosong) — update DIBATALKAN" >&2; exit 1; }
    echo "   backup: $BA (muncul juga di daftar backup UI)"
  else
    echo "!! kontainer api tidak jalan — backup dilewati (volume tetap utuh)"
  fi

  echo "-- git pull …"
  git -C "$REPO" pull --ff-only

  echo "-- rebuild + start kontainer …"
  docker compose -f "$COMPOSE_FILE" up -d --build

  echo "-- cek health …"
  for i in $(seq 1 30); do curl -fsS localhost:3001/health >/dev/null 2>&1 && break; sleep 1; done
  curl -fsS localhost:3001/health || { echo "API tidak sehat — docker compose -f $COMPOSE_FILE logs api" >&2; exit 1; }
  echo "SELESAI. Web: https://$(hostname -I 2>/dev/null | awk '{print $1}'):5656"
else
  # --- Native: systemd user service ---
  if ! systemctl --user cat ravaa-api >/dev/null 2>&1; then
    echo "service ravaa-api tidak terpasang — jalankan ./install.sh native dulu" >&2
    exit 1
  fi

  # DB native konvensi ~/ravaa-data/data.db; jatuh ke default repo bila tidak ada
  if [ -f "$HOME/ravaa-data/data.db" ]; then DB="$HOME/ravaa-data/data.db"; else DB="apps/api/data/data.db"; fi
  BAK_DIR="$(dirname "$DB")/backups"
  mkdir -p "$BAK_DIR"
  NAME="data-$(sudut_utc)-$(jam_utc).db"
  BAK="$BAK_DIR/$NAME"
  STOPPED=0

  echo "-- backup DB: $BAK"
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$DB" 'PRAGMA wal_checkpoint(TRUNCATE);'
    sqlite3 "$DB" "VACUUM INTO '$BAK'"
    CHK="$(sqlite3 "$BAK" 'PRAGMA integrity_check;')"
    [ "$CHK" = "ok" ] || { echo "backup gagal integrity check ($CHK) — BATALKAN update" >&2; exit 1; }
  else
    echo "   sqlite3 tidak ada — backup dengan menghentikan service dulu …"
    systemctl --user stop ravaa-api || true
    STOPPED=1
    cp "$DB" "$BAK"
  fi

  if [ -n "$(git status --porcelain)" ]; then
    echo "!! working tree tidak bersih — pull bisa saja konflik (perubahan lokal dipertahankan)"
  fi
  echo "-- git pull …"
  git pull --ff-only

  echo "-- npm install + build web …"
  npm install --no-audit --no-fund
  npm run build -w apps/web

  echo "-- restart service …"
  if [ "$STOPPED" = 1 ]; then systemctl --user start ravaa-api; else systemctl --user restart ravaa-api; fi

  echo "-- cek health …"
  for i in $(seq 1 20); do curl -fsS localhost:3001/health >/dev/null 2>&1 && break; sleep 1; done
  curl -fsS localhost:3001/health || {
    echo "API tidak sehat — log:"
    journalctl --user -u ravaa-api -n 30 --no-pager || true
    exit 1
  }

  if journalctl --user -u ravaa-api -n 40 --no-pager 2>/dev/null | grep -q "SKEMA DB TIDAK SINKRON"; then
    echo
    echo "!! PERINGATAN SKEMA: log API memuat blok [SKEMA DB TIDAK SINKRON]."
    echo "   Jalankan perintah ALTER TABLE yang tercetak di log (backup: $BAK),"
    echo "   lalu restart:  systemctl --user restart ravaa-api"
  fi
  echo
  echo "SELESAI. Backup: $BAK — Web: https://$(hostname -I 2>/dev/null | awk '{print $1}'):5656"
fi
