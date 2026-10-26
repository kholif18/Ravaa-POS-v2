#!/usr/bin/env bash
# Generate sertifikat self-signed untuk HTTPS LAN (ROADMAP 1.7 — kamera scan
# butuh konteks aman; ACME/Let's Encrypt mustahil untuk IP LAN tanpa domain).
#
# Dipanggil SEKALI per server (lalu lagi hanya bila IP LAN berubah / cert hampir
# kedaluwarsa). Hasilnya dibaca compose lewat infra/certs/*.crt|*.key
# (di-mount read-only ke container web — lihat infra/docker-compose.yml).
#
# Pemakaian:
#   bash infra/gen-cert.sh              # IP otomatis dari `hostname -I`
#   bash infra/gen-cert.sh 192.168.1.5  # IP eksplisit
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/certs"
mkdir -p "$DIR"

IP="${1:-$(hostname -I | awk '{print $1}')}"
if [[ -z "$IP" ]]; then
  echo "Gagal membaca IP LAN — jalankan: bash infra/gen-cert.sh <ip-lan>" >&2
  exit 1
fi

DAYS=3650
CRT="$DIR/ravaa-selfsigned.crt"
KEY="$DIR/ravaa-selfsigned.key"

echo "Generate sertifikat self-signed (SAN: localhost, ravaa-pos, 127.0.0.1, $IP) …"
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days "$DAYS" \
  -keyout "$KEY" -out "$CRT" \
  -subj "/CN=ravaa-pos" \
  -addext "subjectAltName=DNS:localhost,DNS:ravaa-pos,IP:127.0.0.1,IP:$IP" \
  >/dev/null 2>&1

chmod 600 "$KEY"
echo "Selesai → $CRT (berlaku $DAYS hari, IP LAN: $IP)"
openssl x509 -in "$CRT" -noout -subject -ext subjectAltName
