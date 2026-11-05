#!/bin/bash
# ============================================================================
# Deckhand - macOS installer, downloaded from a fleet hub's /install page.
#
# Gatekeeper blocks double-clicked unsigned downloads: right-click the file
# -> Open -> Open, or run it from Terminal:
#     bash ~/Downloads/deckhand-install.command
# Dry run (prints every step, changes nothing):
#     bash ~/Downloads/deckhand-install.command --dry-run
# ============================================================================
set -u

BASE="__DECKHAND_BASE_URL__"
LABEL="com.deckhand.hub"
DRY=0
case "${1:-}" in --dry-run|--dryrun|-DryRun) DRY=1 ;; esac

LOG="$HOME/Library/Logs/deckhand-install.log"
mkdir -p "$(dirname "$LOG")" 2>/dev/null || LOG="/tmp/deckhand-install.log"
exec > >(tee -a "$LOG") 2>&1

say()    { printf '\n== %s ==\n' "$*"; }
step()   { printf '>> %s\n' "$*"; }
finish() { printf '\nLog of this run: %s\n' "$LOG"; read -r -p 'Press Enter to close this window... ' _ || true; exit "${1:-0}"; }
fail()   { printf '\nINSTALL FAILED: %s\n' "$*"; finish 1; }

echo "Deckhand installer - release shelf: $BASE"
[ "$DRY" = 1 ] && echo 'DRY RUN: every step is printed, nothing is changed.'
case "$BASE" in __*) fail "this file must be downloaded from a hub's /install page (no shelf URL is embedded)";; esac

# -- never clobber a running hub ---------------------------------------------
if [ -f "$HOME/Library/LaunchAgents/$LABEL.plist" ]; then
  echo "Not installing: the LaunchAgent $LABEL is already installed."
  echo "A running hub updates itself: dashboard -> ADMIN -> UPDATE."
  echo "To remove it first: bash <install dir>/scripts/install-macos.sh --uninstall"
  finish 1
fi
if curl -fsS --max-time 3 "http://127.0.0.1:5959/api/hub-info" >/dev/null 2>&1; then
  echo "Not installing: something already answers on http://127.0.0.1:5959."
  finish 1
fi

# -- the shelf must answer before anything is touched -------------------------
say "release on the shelf"
if ! VERSION_JSON="$(curl -fsSL --max-time 10 "$BASE/version.json")"; then
  fail "cannot read $BASE/version.json - is this Mac on the tailnet (Tailscale signed in)?"
fi
echo "$VERSION_JSON"

# -- prerequisites ------------------------------------------------------------
say "checking Tailscale"
if [ -d /Applications/Tailscale.app ] || command -v tailscale >/dev/null 2>&1; then
  echo "Tailscale: found"
else
  echo "Tailscale was NOT found. The fleet needs every machine on the tailnet."
  echo "Install it from https://tailscale.com/download and sign in, then re-run this installer."
  if [ "$DRY" = 0 ]; then
    read -r -p "Continue without Tailscale (single-machine dashboard only)? [y/N] " go
    case "$go" in y|Y) ;; *) finish 1 ;; esac
  fi
fi

say "checking Node.js (20+ required)"
node_major() {
  command -v node >/dev/null 2>&1 || { echo 0; return; }
  node --version | sed 's/^v\([0-9]*\).*/\1/'
}
MAJOR="$(node_major)"
if [ "${MAJOR:-0}" -ge 20 ] 2>/dev/null; then
  echo "Node.js: $(node --version)"
else
  if [ "${MAJOR:-0}" != "0" ]; then echo "Node.js $(node --version) is too old (20+ needed)."; else echo "Node.js was not found."; fi
  if command -v brew >/dev/null 2>&1; then
    if [ "$DRY" = 1 ]; then
      step "would offer: brew install node"
    else
      read -r -p "Install Node.js now with Homebrew (brew install node)? [Y/n] " go
      case "$go" in n|N) echo "Install Node.js 20+ yourself, then re-run this installer."; finish 1 ;; esac
      brew install node || fail "brew install node failed"
      MAJOR="$(node_major)"
      [ "${MAJOR:-0}" -ge 20 ] 2>/dev/null || fail "node is still not 20+ after the install"
      echo "Node.js: $(node --version)"
    fi
  else
    fail "install Node.js 20+ first (brew install node, or https://nodejs.org), then re-run this installer"
  fi
fi
command -v claude >/dev/null 2>&1 || echo "note: 'claude' is not on PATH - install Claude Code and sign in, or agent sessions won't start on this Mac."

# -- where --------------------------------------------------------------------
say "where to install"
DEFAULT_DIR="$HOME/Deckhand"
DEFAULT_PROJECTS="$HOME/Projects"
if [ "$DRY" = 1 ]; then
  INSTALL_DIR="$DEFAULT_DIR"; PROJECTS_ROOT="$DEFAULT_PROJECTS"
  step "would ask for the install folder (default $DEFAULT_DIR) and the projects root (default $DEFAULT_PROJECTS)"
else
  read -r -p "Install folder [$DEFAULT_DIR]: " INSTALL_DIR
  INSTALL_DIR="${INSTALL_DIR:-$DEFAULT_DIR}"
  read -r -p "Projects root - where your project folders live [$DEFAULT_PROJECTS]: " PROJECTS_ROOT
  PROJECTS_ROOT="${PROJECTS_ROOT:-$DEFAULT_PROJECTS}"
fi
[ -f "$INSTALL_DIR/package.json" ] && echo "note: $INSTALL_DIR already holds files - they will be updated in place."

# -- download, extract, install -----------------------------------------------
say "downloading and extracting the release"
TGZ="${TMPDIR:-/tmp}/deckhand-release.$$.tgz"
step "download $BASE/release.tgz"
if [ "$DRY" = 0 ]; then
  curl -fL --progress-bar "$BASE/release.tgz" -o "$TGZ" || fail "download failed"
fi
step "extract into $INSTALL_DIR"
if [ "$DRY" = 0 ]; then
  mkdir -p "$INSTALL_DIR" "$PROJECTS_ROOT" || fail "cannot create $INSTALL_DIR / $PROJECTS_ROOT"
  tar -xzf "$TGZ" -C "$INSTALL_DIR" || fail "extract failed"
  rm -f "$TGZ"
fi

say "npm install (a few minutes on first run)"
step "npm install in $INSTALL_DIR"
if [ "$DRY" = 0 ]; then
  (cd "$INSTALL_DIR" && npm install --no-audit --no-fund) || fail "npm install failed"
fi

step "write hub-env.sh (HUB_PROJECTS_ROOT=$PROJECTS_ROOT)"
if [ "$DRY" = 0 ]; then
  printf 'export HUB_PROJECTS_ROOT="%s"\n' "$PROJECTS_ROOT" > "$INSTALL_DIR/hub-env.sh"
fi

say "installing the LaunchAgent (starts at login, kept alive)"
step "HUB_PROJECTS_ROOT=$PROJECTS_ROOT bash $INSTALL_DIR/scripts/install-macos.sh"
if [ "$DRY" = 0 ]; then
  HUB_PROJECTS_ROOT="$PROJECTS_ROOT" bash "$INSTALL_DIR/scripts/install-macos.sh" || fail "install-macos.sh failed"
fi

say "waiting for the hub on http://127.0.0.1:5959"
if [ "$DRY" = 1 ]; then
  step "would wait up to 60 s for /api/hub-info"
else
  UP=0
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    if curl -fsS --max-time 3 "http://127.0.0.1:5959/api/hub-info" >/dev/null 2>&1; then UP=1; break; fi
    sleep 3
  done
  if [ "$UP" = 1 ]; then echo "The hub is up: http://127.0.0.1:5959"; else echo "Not answering yet - see $INSTALL_DIR/data/hub.log"; fi
fi

say "notes for an always-on Mac (from the README)"
cat <<'NOTES'
- The hub runs as a per-user LaunchAgent: it starts when YOU log in. For a
  Mac that should rejoin the fleet after a reboot unattended, turn on
  automatic login (System Settings -> Users & Groups) - which requires
  FileVault to be OFF.
- Keep the Mac awake: System Settings -> Energy -> prevent sleeping, and
  turn off "Put hard disks to sleep", or the fleet loses this node when it
  naps.
- Claude Code must be installed and signed in on this Mac for agent
  sessions; the hub itself runs without it (terminal cards only).
NOTES
echo "Dashboard: http://127.0.0.1:5959"
finish 0
