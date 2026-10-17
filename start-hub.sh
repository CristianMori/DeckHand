#!/usr/bin/env bash
# Deckhand launcher for macOS/Linux (the Unix twin of start-hub.cmd).
# Runs from wherever it lives; optional per-machine overrides in hub-env.sh
# next to it (e.g. export HUB_PROJECTS_ROOT=/Users/me/Projects). Keeps the
# previous run's log so a crash's last lines survive the restart.
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1
[ -f hub-env.sh ] && . ./hub-env.sh
mkdir -p data
[ -f data/hub.prev.log ] && rm -f data/hub.prev.log
[ -f data/hub.log ] && mv -f data/hub.log data/hub.prev.log
exec npm run start >> data/hub.log 2>&1
