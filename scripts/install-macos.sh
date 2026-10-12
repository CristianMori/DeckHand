#!/usr/bin/env bash
# Deckhand — macOS launchd installer (per-user LaunchAgent).
#
#   bash scripts/install-macos.sh
#   HUB_PROJECTS_ROOT=/Users/me/Projects bash scripts/install-macos.sh
#   bash scripts/install-macos.sh --uninstall
#
# Installs a LaunchAgent that starts Deckhand when you log in, keeps it alive
# (which is also how the auto-updater applies releases: the hub exits and
# launchd relaunches it), and logs to data/hub.log. A LaunchAgent runs in your
# login session, so Claude Code and Codex find your keychain, your PATH and
# your sign-ins — the same reason the Windows installer recommends "startup".
# Tip: System Settings → Energy → turn off "Put hard disks to sleep" and keep
# the Mac awake, or the fleet loses this node while it naps.
set -euo pipefail

LABEL="${LABEL:-com.deckhand.hub}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
PROJECTS_ROOT="${HUB_PROJECTS_ROOT:-$HOME/Projects}"
UID_NUM="$(id -u)"

if [ "${1:-}" = "--uninstall" ]; then
  launchctl bootout "gui/${UID_NUM}" "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "== '$LABEL' removed =="
  exit 0
fi

command -v node >/dev/null || { echo "node not found — brew install node (20+) first" >&2; exit 1; }
NODE_BIN="$(dirname "$(command -v node)")"
command -v claude >/dev/null || echo "note: 'claude' is not on PATH — install Claude Code and sign in, or sessions won't start" >&2

if [ ! -d "$ROOT/node_modules" ]; then
  echo "== npm install =="
  (cd "$ROOT" && npm install --no-audit --no-fund)
fi

mkdir -p "$PROJECTS_ROOT" "$ROOT/data" "$HOME/Library/LaunchAgents"
chmod +x "$ROOT/start-hub.sh"

# PATH for a launchd job is minimal; give it the places node, claude and codex live
PATH_LINE="${NODE_BIN}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${HOME}/.local/bin:${HOME}/.npm-global/bin"

cat > "$PLIST" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${ROOT}/start-hub.sh</string>
  </array>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${PATH_LINE}</string>
    <key>HOME</key><string>${HOME}</string>
    <key>HUB_PROJECTS_ROOT</key><string>${PROJECTS_ROOT}</string>
    <key>DECKHAND_SERVICE</key><string>1</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
EOF

launchctl bootout "gui/${UID_NUM}" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/${UID_NUM}" "$PLIST"
launchctl kickstart -k "gui/${UID_NUM}/${LABEL}"
sleep 3
if curl -fs "http://127.0.0.1:${HUB_PORT:-5959}/api/hub-info" >/dev/null 2>&1; then
  echo "== '$LABEL' installed and answering on port ${HUB_PORT:-5959}: projects root $PROJECTS_ROOT =="
else
  echo "== '$LABEL' installed; hub not answering yet — see $ROOT/data/hub.log =="
fi
