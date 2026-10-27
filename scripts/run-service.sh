#!/bin/bash
# Avviato da launchd: attende Docker, avvia PostgreSQL, poi API e portale.
set -uo pipefail
cd "$(dirname "$0")/.."
log() { echo "[$(date '+%F %T')] $*"; }

if ! docker info >/dev/null 2>&1; then
  log "avvio Docker Desktop in background"
  open -gj -a Docker 2>/dev/null || true
fi
for _ in $(seq 1 120); do docker info >/dev/null 2>&1 && break; sleep 5; done
if ! docker info >/dev/null 2>&1; then log "Docker non disponibile dopo 10 minuti"; exit 1; fi

log "avvio database"
docker compose up -d --wait db || { log "database non avviato"; exit 1; }
[ -f web/.next/BUILD_ID ] || npm run build
log "avvio Azzurro su ${PORTAL_URL:-http://localhost:3000}"
# se una delle due parti si ferma (crash, kill) si ferma tutto e launchd riavvia il servizio:
# altrimenti il portale resterebbe su con le API giù e ogni chiamata darebbe 500
exec npx concurrently --kill-others --kill-signal SIGTERM -n api,web -c blue,cyan "npm:start -w server" "npm:serve -w web"
