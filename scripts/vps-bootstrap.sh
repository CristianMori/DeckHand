#!/usr/bin/env bash
# ClaudeHub night-shift node bootstrap — Ubuntu 24.04
# Usage: TS_AUTHKEY=tskey-auth-... bash vps-bootstrap.sh
# After it finishes, the box is tailnet-only: all public inbound ports closed.
set -euo pipefail

if [[ -z "${TS_AUTHKEY:-}" ]]; then
  echo "Set TS_AUTHKEY first:  TS_AUTHKEY=tskey-auth-... bash $0" >&2
  exit 1
fi

echo "== system update =="
export DEBIAN_FRONTEND=noninteractive
apt-get update -y && apt-get upgrade -y
apt-get install -y curl git ufw ca-certificates gnupg

echo "== tailscale =="
curl -fsSL https://tailscale.com/install.sh | sh
# --ssh: tailnet identity becomes SSH auth; no keys or passwords to manage
tailscale up --authkey "${TS_AUTHKEY}" --ssh --hostname vps-node

echo "== node.js LTS =="
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

echo "== claude code =="
curl -fsSL https://claude.ai/install.sh | bash || echo "claude install failed - run manually later"

echo "== git remote area =="
mkdir -p /srv/git

echo "== firewall: tailnet-only =="
ufw default deny incoming
ufw default allow outgoing
ufw allow in on tailscale0
# keep 22 open until you confirm tailnet SSH works, then: ufw delete allow 22/tcp
ufw allow 22/tcp
ufw --force enable

echo
echo "Done. Next steps:"
echo "  1. From another tailnet device:  ssh root@vps-node   (via Tailscale SSH)"
echo "  2. Once that works, close public SSH:  ufw delete allow 22/tcp"
echo "  3. Authenticate Claude Code:  claude  (follow login flow)"
tailscale ip -4
