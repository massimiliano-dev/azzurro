#!/bin/bash
# Rimuove il servizio Azzurro. I dati (database) restano a meno che tu non scelga di cancellarli.
set -uo pipefail
SUPPORT="$HOME/Library/Application Support/Azzurro"
DEST="$SUPPORT/app"
LOGS="$HOME/Library/Logs/Azzurro"
LABEL="it.keynet.azzurro"
ask() { local a; read -r -p "$1 [s/N] " a; [[ "$a" =~ ^[sSyY] ]]; }
[ -d /Applications/Docker.app ] && export PATH="/Applications/Docker.app/Contents/Resources/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

printf '\033[34m  ◆ Azzurro — disinstallazione\033[0m\n\n'
if [ -x "$DEST/scripts/service.sh" ]; then
  bash "$DEST/scripts/service.sh" uninstall
else
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null; rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
  echo "Servizio rimosso."
fi
if [ -d "$DEST" ] && ask "Fermo il database (i dati restano nel volume Docker)?"; then
  (cd "$DEST" && docker compose stop db) || true
fi
if ask "Cancello DEFINITIVAMENTE il database di Azzurro (risorse, utenti, conversazioni)?"; then
  if ask "Confermi? I dati non si possono recuperare."; then
    if [ -d "$DEST" ]; then (cd "$DEST" && docker compose down -v); else docker volume rm azzurro_pgdata; fi
    echo "Database cancellato."
  fi
fi
if ask "Rimuovo anche la copia dell'app, la configurazione e i log?"; then
  rm -rf "${SUPPORT:?}" "${LOGS:?}"
  echo "File rimossi."
fi
echo "Fatto. Node.js, Docker Desktop e Homebrew restano installati."
read -r -p "Premi Invio per chiudere." _
