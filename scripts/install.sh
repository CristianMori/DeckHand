#!/usr/bin/env bash
# Deckhand — Linux systemd service installer.
#
#   sudo bash scripts/install-service.sh
#   sudo HUB_PROJECTS_ROOT=/home/me/projects bash scripts/install-service.sh
#   sudo bash scripts/install-service.sh --uninstall
#
# Installs a systemd unit that starts Deckhand at boot and relaunches it on
# failure (which is also how the auto-updater applies releases here).
set -euo pipefail

SERVICE_NAME="${SERVICE_NAME:-deckhand}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT="/etc/systemd/system/${SERVICE_NAME}.service"
PROJECTS_ROOT="${HUB_PROJECTS_ROOT:-/srv/sync}"
RUN_USER="${SUDO_USER:-root}"

[ "$(id -u)" -eq 0 ] || { echo "run with sudo/root" >&2; exit 1; }

if [ "${1:-}" = "--uninstall" ]; then
  systemctl disable --now "$SERVICE_NAME" 2>/dev/null || true
  rm -f "$UNIT"
  systemctl daemon-reload
  echo "== service '$SERVICE_NAME' removed =="
  exit 0
fi

command -v node >/dev/null || { echo "node not found — install Node.js 20+ first" >&2; exit 1; }
NPM="$(command -v npm)"

if [ ! -d "$ROOT/node_modules" ]; then
  echo "== npm install =="
  (cd "$ROOT" && npm install --no-audit --no-fund)
fi

mkdir -p "$PROJECTS_ROOT"

cat > "$UNIT" << EOF
[Unit]
Description=Deckhand (fleet node)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${ROOT}
Environment=HUB_PROJECTS_ROOT=${PROJECTS_ROOT}
Environment=DECKHAND_SERVICE=1
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=${NPM} run start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME"
sleep 3
systemctl --no-pager --lines=0 status "$SERVICE_NAME" || true
echo "== '$SERVICE_NAME' installed: projects root $PROJECTS_ROOT, runs as $RUN_USER =="
