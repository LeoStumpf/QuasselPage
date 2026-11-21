#!/usr/bin/env bash
# Adds QuasselPage to the application menu (~/.local/share/applications).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p ~/.local/share/applications
sed "s|@REPO@|$REPO|" "$REPO/scripts/quasselpage.desktop" > ~/.local/share/applications/quasselpage.desktop
echo "Startmenü-Eintrag angelegt."
