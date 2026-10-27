#!/bin/bash
# Prepara l'app registration "Azzurro" per la modalità Azure reale (da eseguire tu, con az login come amministratore):
#  - multi-tenant, così Azzurro può aprire anche le altre directory a cui hai accesso;
#  - autorizzazioni delegate dichiarate: Azure Service Management (user_impersonation) e Microsoft Graph.
# Il consenso lo dai tu: o qui con --consent (solo per il tuo utente), o dalla pagina Microsoft al primo cambio di directory.
set -euo pipefail
APP_OBJECT_ID="${APP_OBJECT_ID:?imposta APP_OBJECT_ID (Object ID dell'app registration Azzurro)}"
TENANT="${AZZURRO_MS_TENANT_ID:?imposta AZZURRO_MS_TENANT_ID (tenant dell'app)}"
TOKEN=$(az account get-access-token --tenant "$TENANT" --resource-type ms-graph --query accessToken -o tsv)
BODY=$(cat <<'JSON'
{
  "signInAudience": "AzureADMultipleOrgs",
  "requiredResourceAccess": [
    { "resourceAppId": "00000003-0000-0000-c000-000000000000", "resourceAccess": [
      { "id": "37f7f235-527c-4136-accd-4a02d197296e", "type": "Scope" },
      { "id": "14dad69e-099b-42c9-810b-d002981feec1", "type": "Scope" },
      { "id": "64a6cdd6-aab1-4aaf-94b8-3cc8405e90d0", "type": "Scope" },
      { "id": "7427e0e9-2fba-42fe-b0c0-848c9e6a8182", "type": "Scope" },
      { "id": "e1fe6dd8-ba31-4d61-89e7-88639da4683d", "type": "Scope" },
      { "id": "06da0dbc-49e2-44d2-8312-53f166ab848a", "type": "Scope" },
      { "id": "204e0828-b5ca-4ad8-b9f3-f32a958e7cc4", "type": "Scope" },
      { "id": "4e46008b-f24c-477d-8fff-7bb4ec7aafe0", "type": "Scope" },
      { "id": "bdfbf15f-ee85-4955-8675-146e8e5296b5", "type": "Scope" },
      { "id": "e4c9e354-4dc5-45b8-9e7c-e1393b0b1a20", "type": "Scope" },
      { "id": "741c54c3-0c1e-44a1-818b-3f97ab4e8c83", "type": "Scope" }
    ]},
    { "resourceAppId": "797f4846-ba00-4fd7-ba43-dac1f8f63013", "resourceAccess": [
      { "id": "41094075-9dad-400e-a0bd-54e686782033", "type": "Scope" }
    ]}
  ]
}
JSON
)
curl -sf -X PATCH "https://graph.microsoft.com/v1.0/applications/$APP_OBJECT_ID" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data "$BODY"
echo "App aggiornata: multi-tenant, autorizzazioni ARM e Graph dichiarate."
echo "Ora in Azzurro scegli una directory Azure dal selettore in alto e accetta le autorizzazioni nella pagina Microsoft."
