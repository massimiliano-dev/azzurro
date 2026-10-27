#!/bin/bash
# Installa Azzurro su questo Mac: Homebrew, Node.js, Docker Desktop, database PostgreSQL in Docker
# e il servizio che tiene Azzurro sempre attivo su http://azzurro.localhost (AZZURRO_WEB_PORT per un'altra porta).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
APP_SRC="$HERE/app"
SUPPORT="$HOME/Library/Application Support/Azzurro"
DEST="$SUPPORT/app"
NODE_MIN=24
WEB_PORT="${AZZURRO_WEB_PORT:-80}"
URL="http://azzurro.localhost$([ "$WEB_PORT" = 80 ] || echo ":$WEB_PORT")"

blue() { printf '\033[34m%s\033[0m\n' "$*"; }
step() { printf '\n\033[1;34m◆ %s\033[0m\n' "$*"; }
fail() { printf '\n\033[31m✖ %s\033[0m\n' "$*" >&2; read -r -p "Premi Invio per chiudere." _; exit 1; }
ask() { local a; read -r -p "$1 [s/N] " a; [[ "$a" =~ ^[sSyY] ]]; }

clear
blue "  ◆ Azzurro — installazione"
echo "  Emulatore locale di Azure con portale web. Servono circa 5 GB liberi e la connessione a internet."
echo "  Verranno installati, se mancano: Homebrew, Node.js e Docker Desktop."
[ -d "$APP_SRC" ] || fail "Cartella 'app' non trovata accanto a questo file: estrai di nuovo lo zip."
[ "$(uname)" = Darwin ] || fail "Questo installer è per macOS."

step "Homebrew"
if ! command -v brew >/dev/null 2>&1; then
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && eval "$("$b" shellenv)"; done
fi
if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew non è installato. L'installer ufficiale chiederà la password del Mac."
  ask "Installo Homebrew?" || fail "Homebrew è necessario per installare Node.js e Docker."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && eval "$("$b" shellenv)"; done
fi
command -v brew >/dev/null 2>&1 || fail "Homebrew non disponibile."
echo "ok: $(brew --version | head -1)"

step "Node.js"
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if [ "$(node_major)" -lt "$NODE_MIN" ]; then
  echo "Serve Node.js $NODE_MIN o più recente: lo installo con Homebrew."
  brew install node || brew upgrade node
  hash -r
fi
[ "$(node_major)" -ge "$NODE_MIN" ] || fail "Node.js $NODE_MIN+ non disponibile (trovato $(node -v 2>/dev/null || echo nessuno))."
echo "ok: node $(node -v), npm $(npm -v)"

step "Docker Desktop"
if ! command -v docker >/dev/null 2>&1 && [ ! -d /Applications/Docker.app ]; then
  echo "Docker Desktop ospita il database PostgreSQL di Azzurro."
  brew install --cask docker
fi
[ -d /Applications/Docker.app ] && export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"
if ! docker info >/dev/null 2>&1; then
  echo "Avvio Docker Desktop… (al primo avvio accetta le condizioni nella finestra di Docker)"
  open -a Docker || true
  for i in $(seq 1 120); do docker info >/dev/null 2>&1 && break; sleep 3; [ $((i % 10)) -eq 0 ] && echo "  attendo Docker…"; done
fi
docker info >/dev/null 2>&1 || fail "Docker non risponde. Apri Docker Desktop, completa la configurazione e rilancia l'installer."
echo "ok: $(docker --version)"

step "Database PostgreSQL"
DB_EXISTED=0; docker volume inspect azzurro_pgdata >/dev/null 2>&1 && DB_EXISTED=1
(cd "$APP_SRC" && docker compose up -d --wait db) || fail "Il database non è partito (docker compose up)."
echo "ok: container azzurro-db-1 attivo, dati nel volume azzurro_pgdata"

step "Configurazione"
mkdir -p "$DEST"
if [ ! -f "$DEST/.env" ] && [ "$DB_EXISTED" = 1 ]; then
  cp "$APP_SRC/.env.example" "$DEST/.env"
  echo "Database esistente trovato: accedi con le credenziali di prima."
elif [ ! -f "$DEST/.env" ]; then
  cp "$APP_SRC/.env.example" "$DEST/.env"
  PW="Az-$(LC_ALL=C tr -dc 'A-HJ-NP-Za-km-z2-9' </dev/urandom | head -c 14)!"
  sed -i '' "s|^AZZURRO_ADMIN_PASSWORD=.*|AZZURRO_ADMIN_PASSWORD=$PW|" "$DEST/.env"
  chmod 600 "$DEST/.env"
  printf 'Azzurro — primo accesso\n  indirizzo: %s\n  utente:    admin@azzurro.local\n  password:  %s\n' "$URL" "$PW" > "$SUPPORT/primo-accesso.txt"
  chmod 600 "$SUPPORT/primo-accesso.txt"
  NEW_PW="$PW"
else
  echo "Configurazione esistente mantenuta ($DEST/.env)."
fi
echo "Chiavi AI e app Microsoft si impostano dal portale: Impostazioni → Configurazione del server."

step "Assistente AI locale (facoltativo)"
if command -v ollama >/dev/null 2>&1; then
  echo "Ollama è già installato."
elif ask "Installo Ollama per usare l'assistente con un modello locale (senza chiavi API)?"; then
  brew install --cask ollama
  open -a Ollama || true
  echo "Per scaricare un modello: ollama pull qwen3.8:27b (circa 17 GB), oppure uno più piccolo da impostare nel portale."
fi

step "Installazione del servizio"
echo "Copio Azzurro in $DEST, installo le dipendenze e compilo il portale (qualche minuto)…"
bash "$APP_SRC/scripts/service.sh" install || fail "Installazione del servizio non riuscita: vedi ~/Library/Logs/Azzurro/azzurro.log"

step "Attendo che Azzurro risponda"
for _ in $(seq 1 90); do curl -fsS -o /dev/null "$URL/login" 2>/dev/null && break; sleep 2; done
if curl -fsS -o /dev/null "$URL/login" 2>/dev/null; then
  blue "
  ✔ Azzurro è installato e partirà da solo a ogni accesso al Mac.
    Portale:  $URL"
  [ -n "${NEW_PW:-}" ] && echo "    Accesso:  admin@azzurro.local  /  $NEW_PW   (salvato in $SUPPORT/primo-accesso.txt)"
  echo "    Log:      ~/Library/Logs/Azzurro/azzurro.log"
  open "$URL"
else
  echo "Il servizio è installato ma il portale non risponde ancora: controlla ~/Library/Logs/Azzurro/azzurro.log"
fi
read -r -p "Premi Invio per chiudere." _
