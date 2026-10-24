#!/usr/bin/env bash
# Install the Deckhand public gateway on the store machine (Linux, systemd, root).
# Runs from the hub's install dir (/opt/deckhand), listens on 127.0.0.1:5990,
# and is published by Tailscale Funnel on https://<this machine>.<tailnet>.ts.net (port 443: some networks allow nothing else).
#
#   sudo bash gateway/install-gateway.sh            install / refresh the unit, start it, enable Funnel
#   sudo node gateway/deckhand-gateway.mjs bootstrap <id>   one-time enrollment token for a client
#   edit /etc/deckhand-gateway/config.json  ->  {"allowFolders": ["FolderA", ...]}  or ["*"] for every folder
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }

HERE="$(cd "$(dirname "$0")" && pwd)"
NODE="$(command -v node)"
DIR=/etc/deckhand-gateway
PORT=5990

install -d -m 700 "$DIR" /var/log/deckhand-gateway
[ -f "$DIR/config.json" ] || { echo '{"allowFolders": []}' > "$DIR/config.json"; chmod 600 "$DIR/config.json"; }

cat > /etc/systemd/system/deckhand-gateway.service <<EOF
[Unit]
Description=Deckhand public gateway (signed, allowlisted; published by Tailscale Funnel)
After=network-online.target deckhand.service
Wants=network-online.target

[Service]
Type=simple
User=root
ExecStart=$NODE $HERE/deckhand-gateway.mjs serve
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$DIR /var/log/deckhand-gateway
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now deckhand-gateway
systemctl restart deckhand-gateway

# public HTTPS with a real certificate; only the gateway port is published
tailscale funnel --bg --https=443 "http://127.0.0.1:$PORT"
tailscale funnel status
