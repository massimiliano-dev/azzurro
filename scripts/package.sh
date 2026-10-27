#!/bin/bash
# Crea il pacchetto di installazione per macOS: dist/Azzurro-<versione>-macOS.zip
#   npm run package
# Contiene il codice (senza dipendenze, build, .env né segreti), "Installa Azzurro.command",
# "Disinstalla Azzurro.command" e LEGGIMI.txt.
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(node -p "require('$SRC/package.json').version")"
NAME="Azzurro-$VERSION-macOS"
OUT="$SRC/dist"
TMPROOT="$(mktemp -d)"
trap 'rm -rf "${TMPROOT:?}"' EXIT
STAGE="$TMPROOT/Azzurro"
SECRETS='(sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,}|AZZURRO_MS_CLIENT_SECRET=[A-Za-z0-9~._-]{20,})'

mkdir -p "$STAGE/app" "$OUT"
rsync -a \
  --exclude '.git' --exclude 'node_modules' --exclude '.env' --exclude '.env.local' --exclude '.azzurro.env' \
  --exclude 'dist' --exclude 'web/.next' --exclude 'certs' --exclude '.impeccable/review' --exclude '*.log' \
  --exclude '.DS_Store' --exclude '.lockhash' --exclude 'test-results' \
  "$SRC/" "$STAGE/app/"
cp "$SRC/scripts/installer/install.command" "$STAGE/Installa Azzurro.command"
cp "$SRC/scripts/installer/uninstall.command" "$STAGE/Disinstalla Azzurro.command"
cp "$SRC/scripts/installer/LEGGIMI.txt" "$STAGE/LEGGIMI.txt"
chmod +x "$STAGE"/*.command "$STAGE/app/scripts/"*.sh

# nessun segreto nel pacchetto
if grep -rIlE "$SECRETS" "$STAGE" >/dev/null; then
  echo "✖ trovato un possibile segreto nel pacchetto:" >&2
  grep -rIlE "$SECRETS" "$STAGE" >&2
  exit 1
fi

rm -f "${OUT:?}/${NAME:?}.zip"
ditto -c -k --norsrc --keepParent "$STAGE" "$OUT/$NAME.zip"
echo "Pacchetto creato: $OUT/$NAME.zip ($(du -h "$OUT/$NAME.zip" | cut -f1))"
