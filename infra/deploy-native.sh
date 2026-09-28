#!/bin/sh
# Deploy native Ravaa POS v2 di home server ARM (Armbian) TANPA Docker.
# Jalankan dari folder repo:  sh infra/deploy-native.sh
# Butuh: curl, xz. Tidak butuh sudo (kecuali untuk Caddy, lihat akhir).
set -eu

cd "$(dirname "$0")/.."
REPO="$PWD"
DATA="$HOME/ravaa-data"
NODE_MIN=20

echo "== 1. cek node =="
MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
echo "node sekarang: $(node --version 2>/dev/null || echo TIDAK-ADA)"
if [ "$MAJOR" -lt "$NODE_MIN" ]; then
  echo "Node < v$NODE_MIN — unduh Node 22 LTS arm64 ke ~/.local ..."
  mkdir -p "$HOME/.local" /tmp/ravaa-node
  cd /tmp/ravaa-node
  BASE="https://nodejs.org/dist/latest-v22.x"
  TARBALL="$(curl -fsSL "$BASE/" | grep -o 'node-v22[^"]*-linux-arm64\.tar\.xz' | head -n 1)"
  echo "mengunduh $BASE/$TARBALL"
  curl -fsSLO "$BASE/$TARBALL"
  rm -rf "$HOME/.local/node-v22-linux-arm64"
  mkdir -p "$HOME/.local/node-v22-linux-arm64"
  tar -xJf "$TARBALL" -C "$HOME/.local/node-v22-linux-arm64" --strip-components=1
  export PATH="$HOME/.local/node-v22-linux-arm64/bin:$PATH"
  grep -q 'node-v22-linux-arm64' "$HOME/.profile" 2>/dev/null || \
    echo 'export PATH="$HOME/.local/node-v22-linux-arm64/bin:$PATH"' >> "$HOME/.profile"
  cd "$REPO"
fi
echo "node aktif: $(node --version)  npm: $(npm --version)"

echo "== 2. install + build web =="
npm install --no-audit --no-fund
npm run build -w apps/web

echo "== 3. siapkan data + seed =="
mkdir -p "$DATA"
DB_PATH="$DATA/data.db" npm run seed -w apps/api

echo "== 4. pasang systemd user service =="
mkdir -p "$HOME/.config/systemd/user"
cp "$REPO/infra/ravaa-api.service" "$HOME/.config/systemd/user/"
loginctl enable-linger "$USER" 2>/dev/null || true
systemctl --user daemon-reload
systemctl --user enable --now ravaa-api
sleep 3
systemctl --user --no-pager status ravaa-api | head -n 8 || true

echo "== 5. cek API =="
curl -fsS localhost:3001/health && echo

LAN="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
echo "SELESAI. API: http://$LAN:3001/health"
echo "Web (butuh Caddy/stub): build ada di apps/web/dist"
echo "Opsional (butuh sudo): sudo apt install -y caddy && sudo cp $REPO/infra/Caddyfile.server /etc/caddy/Caddyfile && sudo systemctl reload caddy"
echo "  lalu buka http://$LAN:5656 dari PC/HP sek jaringan."
echo "Opsional firewall: sudo ufw allow 5656/tcp (bila ufw aktif)"
echo "Backup harian (crontab -e):  0 2 * * * cp $DATA/data.db $DATA/backup-\$(date +\\%F).db"
