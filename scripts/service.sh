#!/bin/bash
# Azzurro come servizio dell'utente su macOS: parte a ogni accesso e si riavvia se si chiude.
#   npm run service:install    copia l'app in ~/Library/Application Support/Azzurro, compila e avvia
#   npm run service:update     ricopia il codice e riavvia (dopo modifiche al progetto)
#   npm run service:uninstall  ferma e rimuove il servizio (i dati nel database restano)
#   npm run service:status | service:logs
set -euo pipefail

LABEL="it.keynet.azzurro"
SRC="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$HOME/Library/Application Support/Azzurro/app"
LOGS="$HOME/Library/Logs/Azzurro"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE_BIN="$(dirname "$(command -v node)")"
DOCKER_BIN="$(dirname "$(command -v docker)")"
PATH_VALUE="$NODE_BIN:$DOCKER_BIN:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# indirizzi dell'app installata: separati da quelli di sviluppo (3000/4000)
HOST="${AZZURRO_HOST:-azzurro.localhost}"
WEB_PORT="${AZZURRO_WEB_PORT:-80}"
API_PORT="${AZZURRO_API_PORT:-4400}"
HTTPS_PORT="${AZZURRO_HTTPS_PORT:-4843}"
PORTAL_URL="http://$HOST$([ "$WEB_PORT" = 80 ] || echo ":$WEB_PORT")"
API_URL="http://localhost:$API_PORT"

copy() {
  mkdir -p "$DEST" "$LOGS"
  # node_modules e .env restano quelli della copia installata (le dipendenze si reinstallano se cambia il lockfile)
  rsync -a --delete \
    --exclude '.git' --exclude 'node_modules' --exclude '.env' --exclude '.azzurro.env' --exclude 'dist' \
    --exclude 'web/.next' --exclude '.impeccable/review' --exclude '*.log' --exclude '.lockhash' \
    "$SRC/" "$DEST/"
  [ -f "$SRC/.env" ] && cp "$SRC/.env" "$DEST/.env"
  [ -f "$DEST/.env" ] || cp "$DEST/.env.example" "$DEST/.env"
  local hash; hash="$(shasum "$DEST/package-lock.json" | cut -d' ' -f1)"
  if [ ! -d "$DEST/node_modules" ] || [ "$(cat "$DEST/.lockhash" 2>/dev/null)" != "$hash" ]; then
    echo "installo le dipendenze (npm ci)…"
    (cd "$DEST" && npm ci --no-audit --no-fund --loglevel=error) && echo "$hash" > "$DEST/.lockhash"
  fi
  echo "compilo il portale…"
  (cd "$DEST" && AZZURRO_API_URL="$API_URL" npm run build >/dev/null)
}

write_plist() {
  mkdir -p "$(dirname "$PLIST")"
  cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$DEST/scripts/run-service.sh</string></array>
  <key>WorkingDirectory</key><string>$DEST</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$PATH_VALUE</string>
    <key>COMPOSE_PROJECT_NAME</key><string>azzurro</string>
    <key>NODE_ENV</key><string>production</string>
    <key>WEB_PORT</key><string>$WEB_PORT</string>
    <key>PORT</key><string>$API_PORT</string>
    <key>HTTPS_PORT</key><string>$HTTPS_PORT</string>
    <key>PORTAL_URL</key><string>$PORTAL_URL</string>
    <key>PUBLIC_URL</key><string>$API_URL</string>
    <key>AZZURRO_API_URL</key><string>$API_URL</string>
    <key>AZZURRO_CONFIG_FILE</key><string>$HOME/Library/Application Support/Azzurro/config.env</string>
    <key>AZZURRO_MS_REDIRECT_BASE</key><string>http://localhost$([ "$WEB_PORT" = 80 ] || echo ":$WEB_PORT")</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$LOGS/azzurro.log</string>
  <key>StandardErrorPath</key><string>$LOGS/azzurro.log</string>
</dict>
</plist>
PL
}

stop() {
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  for _ in $(seq 1 30); do launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || return 0; sleep 1; done
}
start() { launchctl bootstrap "gui/$(id -u)" "$PLIST"; }

case "${1:-}" in
  install)
    stop; copy; write_plist; start
    echo "Azzurro installato: $PORTAL_URL (API $API_URL, log: $LOGS/azzurro.log)";;
  update)
    stop; copy; write_plist; start
    echo "Azzurro aggiornato e riavviato: $PORTAL_URL";;
  uninstall)
    stop; rm -f "$PLIST"
    echo "Servizio rimosso. Copia dell'app in $DEST, dati nel volume Docker azzurro_pgdata.";;
  status)
    launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -E "state|pid|last exit" || echo "non installato";;
  logs)
    tail -n 80 -f "$LOGS/azzurro.log";;
  *)
    echo "uso: $0 install|update|uninstall|status|logs"; exit 2;;
esac
