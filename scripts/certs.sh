#!/usr/bin/env bash
# Genera il certificato TLS per https://localhost:4443 (richiesto da MSAL, Azure CLI, Terraform).
# Con mkcert il certificato è subito attendibile; altrimenti viene creato un self-signed
# da rendere attendibile a mano (vedi README).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p certs
if command -v mkcert >/dev/null 2>&1; then
  mkcert -cert-file certs/azzurro.pem -key-file certs/azzurro-key.pem localhost 127.0.0.1 ::1 azzurro.local
  echo "✔ Certificato creato con mkcert (CA locale: $(mkcert -CAROOT)/rootCA.pem)"
  echo "  Se non l'hai già fatto, esegui una volta: mkcert -install"
else
  openssl req -x509 -newkey rsa:2048 -sha256 -days 825 -nodes \
    -keyout certs/azzurro-key.pem -out certs/azzurro.pem \
    -subj "/CN=localhost/O=Azzurro" \
    -addext "subjectAltName=DNS:localhost,DNS:azzurro.local,IP:127.0.0.1,IP:::1" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign" \
    -addext "extendedKeyUsage=serverAuth" >/dev/null 2>&1
  echo "✔ Certificato self-signed creato in certs/azzurro.pem"
  echo "  Rendilo attendibile per gli strumenti che userai:"
  echo "    Node/SDK JS:   export NODE_EXTRA_CA_CERTS=$PWD/certs/azzurro.pem"
  echo "    Python/az CLI: export REQUESTS_CA_BUNDLE=$PWD/certs/azzurro.pem"
  echo "    macOS:         sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain certs/azzurro.pem"
fi
