#!/bin/bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this on the Hetzner server as root."
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

npm install --omit=dev

if ! command -v caddy >/dev/null 2>&1; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi

install -m 644 deploy/Caddyfile /etc/caddy/Caddyfile

cat > /etc/systemd/system/wedding-photos.service <<EOF
[Unit]
Description=Edis and Nina wedding album
After=network.target

[Service]
WorkingDirectory=${ROOT}
Environment=PORT=8787
Environment=PUBLIC_URL=https://edisandnina.pics
ExecStart=$(command -v node) server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now wedding-photos
systemctl reload caddy || systemctl restart caddy

echo
echo "Album service: $(systemctl is-active wedding-photos)"
echo "When DNS for edisandnina.pics points at this server, open https://edisandnina.pics"
