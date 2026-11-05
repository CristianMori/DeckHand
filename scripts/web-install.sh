#!/bin/bash
# ============================================================================
# Deckhand - Linux installer (systemd), downloaded from a fleet hub's
# install page.
#
#   bash deckhand-install.sh            # install
#   bash deckhand-install.sh --dry-run  # print every step, change nothing
#
# Run it as the user whose sign-ins the sessions should use; it uses sudo
# only for the systemd service itself.
# ============================================================================
set -u

BASE="__DECKHAND_BASE_URL__"
SERVICE="deckhand"
DRY=0
case "${1:-}" in --dry-run|--dryrun) DRY=1 ;; esac

LOG="/tmp/deckhand-install.log"
exec > >(tee -a "$LOG") 2>&1

say()  { printf '\n== %s ==\n' "$*"; }
step() { printf '>> %s\n' "$*"; }
fail() { printf '\nINSTALL FAILED: %s\nLog of this run: %s\n' "$*" "$LOG"; exit 1; }
# prompt when interactive; take the default when piped or in a dry run
ask()  {
  local prompt="$1" def="$2" ans=""
  if [ -t 0 ] && [ "$DRY" = 0 ]; then read -r -p "$prompt [$def]: " ans; fi
  printf '%s' "${ans:-$def}"
}

echo "Deckhand installer - install base: $BASE"
[ "$DRY" = 1 ] && echo 'DRY RUN: every step is printed, nothing is changed.'
case "$BASE" in __*) fail "this file must be downloaded from a hub's install page (no base URL is embedded)";; esac

# -- never clobber a running hub ---------------------------------------------
if systemctl list-unit-files 2>/dev/null | grep -q "^${SERVICE}\.service"; then
  echo "Not installing: the systemd service '${SERVICE}' already exists."
  echo "A running hub updates itself: dashboard -> ADMIN -> UPDATE."
  echo "To remove it first: sudo bash <install dir>/scripts/install.sh --uninstall"
  exit 1
fi
if curl -fsS --max-time 3 "http://127.0.0.1:5959/api/hub-info" >/dev/null 2>&1; then
  echo "Not installing: something already answers on http://127.0.0.1:5959."
  exit 1
fi

# -- the shelf must answer before anything is touched -------------------------
say "release on the shelf"
if ! VERSION_JSON="$(curl -fsSL --max-time 10 "$BASE/version.json")"; then
  fail "cannot read $BASE/version.json - is this machine on the tailnet (Tailscale signed in)?"
fi
echo "$VERSION_JSON"

# -- prerequisites ------------------------------------------------------------
say "checking Tailscale"
if command -v tailscale >/dev/null 2>&1; then
  echo "Tailscale: found"
else
  echo "warning: Tailscale was NOT found. The fleet needs every machine on the tailnet"
  echo "(https://tailscale.com/download). Continuing: a single machine still works alone."
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
  fail "Node.js 20+ is required - install it from your distro or https://nodejs.org, then re-run"
fi
command -v claude >/dev/null 2>&1 || echo "note: 'claude' is not on PATH - install Claude Code and sign in, or agent sessions won't start here."

# -- where --------------------------------------------------------------------
say "where to install"
if [ "$(id -u)" -eq 0 ]; then DEFAULT_DIR="/opt/deckhand"; else DEFAULT_DIR="$HOME/deckhand"; fi
DEFAULT_PROJECTS="/srv/sync"
INSTALL_DIR="$(ask 'Install folder' "$DEFAULT_DIR")"
PROJECTS_ROOT="$(ask 'Projects root - where your project folders live' "$DEFAULT_PROJECTS")"
echo "install folder: $INSTALL_DIR   projects root: $PROJECTS_ROOT"
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
  mkdir -p "$INSTALL_DIR" || fail "cannot create $INSTALL_DIR"
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

say "installing the systemd service (starts at boot, restarts on failure)"
SUDO=""
[ "$(id -u)" -ne 0 ] && SUDO="sudo"
step "$SUDO HUB_PROJECTS_ROOT=$PROJECTS_ROOT bash $INSTALL_DIR/scripts/install.sh"
if [ "$DRY" = 0 ]; then
  $SUDO HUB_PROJECTS_ROOT="$PROJECTS_ROOT" bash "$INSTALL_DIR/scripts/install.sh" || fail "install.sh failed"
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

echo
echo "Dashboard: http://127.0.0.1:5959"
echo "The service runs as the user who invoked sudo, so your Claude Code"
echo "sign-in is already the one the sessions will use."
echo "Log of this run: $LOG"
