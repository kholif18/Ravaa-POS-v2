#!/usr/bin/env bash
# Pasang Ravaa POS v2 di server. Jalankan dari folder repo:
#
#   ./install.sh               # interaktif: pilih Docker atau native
#   ./install.sh docker        # Docker: API + web/Caddy di kontainer
#   ./install.sh native        # systemd user service + Caddy host (STB/ARM)
#   ./install.sh docker --cert # + generate cert HTTPS LAN
#
# Mode native mendelegasikan seluruh instalasi ke infra/deploy-native.sh
# (satu sumber kebenaran — jangan duplikasi langkahnya di sini).
set -euo pipefail
cd "$(dirname "$0")"
REPO="$PWD"

MODE=""
WITH_CERT=0
for a in "$@"; do
  case "$a" in
    docker|native) MODE="$a" ;;
    --cert) WITH_CERT=1 ;;
    *) echo "argumen tidak dikenal: $a" >&2; echo "pemakaian: ./install.sh [docker|native] [--cert]" >&2; exit 1 ;;
  esac
done

if [ -z "$MODE" ]; then
  echo "== Pasang Ravaa POS v2 =="
  echo "  1) docker  — kontainer API + web/Caddy (butuh Docker; lebih mudah)"
  echo "  2) native  — systemd user service + Caddy host (hemat RAM, STB/ARM)"
  read -r -p "Pilih mode [docker/native]: " MODE
fi
case "$MODE" in
  docker|native) ;;
  *) echo "mode tidak dikenal: '$MODE' (gunakan docker atau native)" >&2; exit 1 ;;
esac

lan_ip() { hostname -I 2>/dev/null | awk '{print $1}'; }

if [ "$MODE" = "docker" ]; then
  echo "== mode DOCKER =="
  command -v docker >/dev/null || { echo "Docker tidak ada — install dulu: curl -fsSL https://get.docker.com | sh"; exit 1; }
  docker compose version >/dev/null 2>&1 || { echo "compose plugin tidak ada — pasang docker-compose-plugin"; exit 1; }

  if [ "$WITH_CERT" = 1 ] || [ ! -f infra/certs/ravaa-selfsigned.crt ]; then
    command -v openssl >/dev/null || { echo "openssl tidak ada — butuh itu untuk cert HTTPS LAN"; exit 1; }
    echo "-- generate cert HTTPS LAN (SAN: localhost + IP LAN) …"
    bash infra/gen-cert.sh
  fi

  echo "-- build + start kontainer (api + web/Caddy) …"
  docker compose -f infra/docker-compose.yml up -d --build

  echo "-- tunggu API …"
  for i in $(seq 1 30); do
    curl -fsS localhost:3001/health >/dev/null 2>&1 && break
    sleep 1
  done
  curl -fsS localhost:3001/health || { echo "API tidak sehat — lihat: docker compose -f infra/docker-compose.yml logs api"; exit 1; }
  echo
  LAN="$(lan_ip)"
  echo "SELESAI."
  echo "  Web : https://${LAN:-<ip-server>}:5656  (HTTPS LAN; peringatan cert di HP tap 'Lanjutkan ke situs')"
  echo "  API : http://${LAN:-<ip-server>}:3001/health"
  echo "  Login pertama: owner / admin1234 (wajib ganti sandi)."
  echo "  Seed jalan otomatis tiap start kontainer; buka shift pertama dari menu Shift Kasir."
else
  echo "== mode NATIVE =="
  sh infra/deploy-native.sh

  # deploy-native.sh menulis service dengan WorkingDirectory %h/ravaaposv2 —
  # bila repo tidak di sana, ganti path-nya agar service tidak mati.
  SVC="$HOME/.config/systemd/user/ravaa-api.service"
  if [ "$REPO" != "$HOME/ravaaposv2" ] && [ -f "$SVC" ] && grep -q "$HOME/ravaaposv2" "$SVC"; then
    echo "-- repo di $REPO (bukan ~/ravaaposv2) — patch path service …"
    sed -i "s|$HOME/ravaaposv2|$REPO|g" "$SVC"
    systemctl --user daemon-reload
    systemctl --user restart ravaa-api
    sleep 2
  fi

  curl -fsS localhost:3001/health || { echo "API tidak sehat — lihat: journalctl --user -u ravaa-api -e"; exit 1; }
  echo
  LAN="$(lan_ip)"
  echo "SELESAI. API: http://localhost:3001/health  (LAN: http://${LAN:-<ip>}:3001)"
  echo
  echo "Terakhir (butuh sudo): melayani web dari Caddy host —"
  echo "  sudo apt install -y caddy"
  echo "  sudo cp $REPO/infra/Caddyfile.server /etc/caddy/Caddyfile"
  if [ "$WITH_CERT" = 1 ]; then
    bash infra/gen-cert.sh
    echo "  sudo mkdir -p /etc/caddy/certs && sudo cp $REPO/infra/certs/ravaa-selfsigned.* /etc/caddy/certs/"
  else
    echo "  # HTTPS LAN (wajib untuk scan kamera): bash $REPO/infra/gen-cert.sh, lalu salin certs ke /etc/caddy/certs/"
  fi
  echo "  sudo systemctl reload caddy"
  echo "  lalu buka https://${LAN:-<ip-server>}:5656 dari PC/HP sek jaringan."
  echo
  echo "Login pertama: owner / admin1234 (wajib ganti sandi). Buka shift pertama dari menu Shift Kasir."
fi
