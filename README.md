# Azzurro

Emulatore locale di Azure con un portale web più semplice di quello ufficiale. Espone **le stesse API** di Azure Resource Manager (ARM), Microsoft Graph e Microsoft Entra ID, quindi Azure CLI, gli SDK, Terraform e le tue applicazioni possono puntarci senza modifiche al codice.

- **API server** (`server/`): Node 25 + Hono + PostgreSQL. Porta 4000 (HTTP) e 4443 (HTTPS, opzionale).
- **Portale** (`web/`): Next.js 16, bilingue italiano/inglese, tema chiaro/scuro, PWA installabile con notifiche push. Porta 3000.
- **Database**: PostgreSQL 17 in Docker (porta host 5433, per non entrare in conflitto con un PostgreSQL locale).

## Avvio rapido

Prerequisiti: Node 25 o superiore, Docker.

```bash
npm install
npm run db:up          # PostgreSQL in Docker
npm run build          # build del portale
npm start              # API su :4000 e portale su :3000
```

Per lo sviluppo con ricaricamento automatico usa `npm run dev`.

Apri http://localhost:3000 e accedi con il tuo account di lavoro Microsoft.

### Accesso con Microsoft

Il portale usa l'app registration **Azzurro** del tenant aziendale (variabili `AZZURRO_MS_TENANT_ID`, `AZZURRO_MS_CLIENT_ID`, `AZZURRO_MS_CLIENT_SECRET` in `.env`). Possono entrare solo gli utenti o i gruppi assegnati all'app in **Microsoft Entra ID › Applicazioni aziendali › Azzurro › Utenti e gruppi**, e il ruolo assegnato decide cosa possono fare:

| Ruolo dell'app | In Azzurro |
|---|---|
| `Azzurro.Owner` | Owner su tutte le sottoscrizioni, Amministratore globale della directory emulata |
| `Azzurro.Contributor` | Contributor su tutte le sottoscrizioni, Sviluppatore applicazioni |
| `Azzurro.Reader` | Reader su tutte le sottoscrizioni, Lettore globale |

Al primo accesso l'utente viene copiato nella directory emulata; ruoli e profilo si riallineano a ogni accesso.

Senza le variabili Microsoft il portale torna all'accesso con utente e password della directory emulata (`admin@azzurro.local` / `Azzurro123!`, modificabili in `.env` prima del primo avvio). Lo stesso account resta valido per Azure CLI, SDK e Terraform, che usano gli endpoint token emulati. Per ripartire da zero: `npm run db:reset`.

## Cosa è emulato

**Microsoft Entra ID (login)**
- Discovery OpenID (`/{tenant}/v2.0/.well-known/openid-configuration`), chiavi JWKS, `userinfo`.
- Endpoint token v1 e v2 con: client credentials (segreto, certificato, credenziali federate), password, authorization code con PKCE, refresh token, device code, on-behalf-of.
- Pagine di login e device code bilingui, cambio password obbligatorio al primo accesso, log di accesso.
- Managed Identity: endpoint IMDS (`/metadata/identity/oauth2/token`) e stile App Service (`/msi/token`).

**Microsoft Graph** (`/v1.0` e `/beta`)
- Registrazioni app: CRUD, segreti (`addPassword`/`removePassword`), certificati, credenziali federate, proprietari, ruoli app, ambiti esposti.
- Service principal, assegnazioni di ruoli app, consensi delegati (`oauth2PermissionGrants`).
- Utenti, gruppi, appartenenze, ruoli di directory, domini, organizzazione, elementi eliminati con ripristino.
- Log di audit e di accesso, `$filter`, `$select`, `$orderby`, `$top`, `$count`, `$search`, `$expand`, `$batch`.

**Azure Resource Manager**
- Tenant, sottoscrizioni (creazione via `Microsoft.Subscription/aliases`, rinomina, annullamento), aree geografiche, provider e registrazioni.
- Gruppi di risorse, risorse generiche e figlie, risorse di estensione, tag, spostamento, esportazione modello.
- Oltre 150 tipi di risorsa con proprietà calcolate (endpoint, FQDN, chiavi) e azioni (`listKeys`, `listConnectionStrings`, `regenerateKey`, `start`/`stop`, …).
- Effetti collaterali realistici: identità gestite che creano service principal, disco del sistema operativo delle VM, node resource group di AKS, regole SAS dei namespace, database `master` dei server SQL.
- Azure RBAC applicato (ruoli predefiniti con GUID reali, ruoli personalizzati, ereditarietà di scope), blocchi `CanNotDelete` e `ReadOnly`, activity log.
- Distribuzioni di modelli ARM (anche Bicep compilato): funzioni del linguaggio, cicli `copy`, condizioni, dipendenze, moduli annidati, languageVersion 2.0, validazione, what-if, annullamento, operazioni asincrone con `Azure-AsyncOperation`.
- Metadati del cloud (`/metadata/endpoints`) per Azure CLI e Terraform.

## Directory Azure reali

Dal selettore **Directory attiva** in alto puoi passare dall'emulatore ai dati veri delle tue directory Microsoft Entra. In modalità reale il portale manda le chiamate ARM e Graph a `management.azure.com` e `graph.microsoft.com` con il tuo account e i tuoi permessi: Azure applica il tuo RBAC, i costi sono quelli di Cost Management e una riga rossa sotto la barra in alto ricorda che le modifiche sono vere. L'assistente in modalità reale chiede sempre conferma prima di ogni modifica. Azure CLI, SDK e Terraform restano sull'emulatore.

1. Esegui una volta `bash scripts/azure-app-setup.sh` (con `az login` da amministratore): rende l'app multi-tenant e dichiara le autorizzazioni per Azure Resource Manager e Microsoft Graph.
2. Esci e rientra con Microsoft, poi scegli la directory: la prima volta Microsoft chiede di accettare le autorizzazioni.
3. Per le pagine di Entra ID usa **Autorizza Microsoft Graph** nel selettore. Le autorizzazioni di scrittura su utenti, gruppi e app richiedono il consenso di un amministratore della directory.

Il portale ricorda l'ultima directory scelta. Il refresh token è cifrato nel database con una chiave generata al primo avvio.

## Pacchetto di installazione (macOS)

```bash
npm run package            # crea dist/Azzurro-<versione>-macOS.zip
```

Lo zip contiene il codice (senza dipendenze, build, `.env` né segreti: il pacchetto non viene creato se ne trova uno), `Installa Azzurro.command`, `Disinstalla Azzurro.command` e `LEGGIMI.txt`. Sul Mac di destinazione l'installer installa se mancano Homebrew, Node.js e Docker Desktop, avvia PostgreSQL in Docker, genera una password per l'amministratore locale (salvata in `~/Library/Application Support/Azzurro/primo-accesso.txt`), propone Ollama per l'assistente locale e registra il servizio descritto sotto. Rilanciarlo aggiorna l'app e mantiene configurazione e database; il disinstallatore chiede separatamente se fermare o cancellare il database.

## Avvio automatico (macOS)

```bash
npm run service:install    # copia in ~/Library/Application Support/Azzurro, compila e avvia a ogni accesso
npm run service:update     # dopo aver modificato il progetto
npm run service:status
npm run service:logs
npm run service:uninstall
```

L'app installata risponde su **http://azzurro.localhost** (API su `http://localhost:4400`), così le porte 3000 e 4000 restano libere per lo sviluppo. Indirizzo e porte si cambiano con `AZZURRO_HOST`, `AZZURRO_WEB_PORT` e `AZZURRO_API_PORT` prima di `service:install`; il nuovo indirizzo va aggiunto agli URI di reindirizzamento dell'app Entra. Il servizio parte a ogni accesso, si riavvia se si chiude, apre Docker Desktop in background se non è avviato, attende PostgreSQL e poi avvia API e portale. Gira da una copia dell'app perché macOS non lascia ai servizi in background leggere la cartella Scrivania.

## Assistente con l'account Claude Code del Mac

Invece di una chiave API, l'assistente può usare l'account Claude Code già collegato su questo Mac (abbonamento Pro/Max). Si attiva in **Impostazioni → Configurazione del server → «Usa il mio account Claude Code»**: vale solo per l'amministratore che lo attiva, perché i termini di Anthropic non permettono di usare un abbonamento per conto di altri utenti. Funziona tramite Claude Agent SDK, che esegue il binario ufficiale di Claude Code: login e token restano a Claude Code, Azzurro non li legge né li conserva. Gli strumenti di Claude Code (terminale, file, web) e le impostazioni personali (`~/.claude`, CLAUDE.md) sono esclusi: l'assistente ha solo gli strumenti di Azzurro, con le stesse conferme. Consuma i limiti del piano; le sessioni finiscono in `~/Library/Application Support/Azzurro/claude-code`. Se Claude Code non è collegato: `claude` nel Terminale e accedi.

## Assistente con un modello locale

Se Ollama (o LM Studio) è in esecuzione, l'assistente usa per primo il modello locale: niente chiavi e niente dati fuori dal computer. Il default è `qwen3.8:27b` su `http://localhost:11434/v1`; si cambia con `AZZURRO_LOCAL_MODEL` e `AZZURRO_LOCAL_AI_URL`. Serve un modello che supporti gli strumenti. Claude e GPT restano selezionabili se imposti `ANTHROPIC_API_KEY` o `OPENAI_API_KEY`.

## HTTPS per CLI, SDK e Terraform

Le librerie MSAL richiedono HTTPS. Genera un certificato e riavvia il server:

```bash
npm run certs   # usa mkcert se presente, altrimenti un certificato self-signed
```

Il server ascolta anche su https://localhost:4443. Con il certificato self-signed indica agli strumenti dove trovarlo:

```bash
export NODE_EXTRA_CA_CERTS=$PWD/certs/azzurro.pem      # SDK JavaScript
export REQUESTS_CA_BUNDLE=$PWD/certs/azzurro.pem       # Python e Azure CLI
export SSL_CERT_FILE=$PWD/certs/azzurro.pem            # Terraform
```

## Azure CLI

```bash
az config set core.instance_discovery=false
az cloud register -n Azzurro --endpoint-resource-manager https://localhost:4443/
az cloud set -n Azzurro
az login --tenant <tenant-id>                    # browser
az login --tenant <tenant-id> --use-device-code  # device code
```

L'ID del tenant e gli snippet pronti per SDK JavaScript, Python, .NET e Terraform sono nella pagina **Connetti strumenti** del portale.

## Il portale

- **Risorse**: sottoscrizioni, gruppi di risorse, tutte le risorse, creazione guidata da catalogo, distribuzioni con what-if, controllo di accesso (IAM), log attività.
- **Identità**: panoramica Entra, utenti, gruppi, registrazioni app (autenticazione, segreti, certificati, credenziali federate, autorizzazioni API con consenso amministratore, API esposte, ruoli app, manifesto), applicazioni aziendali, ruoli di directory, log.
- **Nastro «Richieste»**: in fondo a ogni pagina mostra le chiamate ARM e Graph fatte dal portale, con metodo, esito e tempi; aprilo (o premi `` ` ``) per leggere richiesta, risposta JSON e copiare il comando `curl`.
- **Gestione costi**: spesa del mese, previsione a fine mese, costo giornaliero, ripartizione per servizio, gruppo di risorse e risorsa, budget con avvisi push. I dati arrivano dalle API `Microsoft.CostManagement/query` e `/forecast` e da `Microsoft.Consumption/budgets`, emulate con le stesse forme di Azure.
- **Listino prezzi**: piani, specifiche e tariffe indicative (EUR, West Europe) di ogni tipo di risorsa; la scheda **Costi e piano** di ogni risorsa mostra le voci di costo e confronta i piani; il modulo di creazione mostra la stima mensile.
- **Assistente**: chat con Claude (`claude-opus-5-5`, API Anthropic) o GPT (API OpenAI) che legge e crea risorse, gruppi, app registration e risponde su utilizzi e costi. Usa le API ARM e Graph con i permessi dell'utente; le modifiche si possono far confermare, le eliminazioni chiedono sempre conferma; chiavi e segreti vengono nascosti prima dell'invio al provider. Serve un modello locale, `ANTHROPIC_API_KEY` o `OPENAI_API_KEY` (in `.env` o da Impostazioni). È disponibile in ogni pagina (pulsante **Assistente** in basso a destra o ⌘J): sa quale pagina e quale risorsa stai guardando, così «questa risorsa» o «qui» si riferiscono a quella.
- **Notifiche push**: attivale da *Notifiche* su ogni dispositivo. Arrivano per distribuzioni completate o non riuscite, risorse create o eliminate, assegnazioni di ruolo, segreti in scadenza, accessi non riusciti. Su iPhone e iPad installa prima l'app nella schermata Home.

## Test

```bash
npm run db:up
npm test        # unit e integrazione, su uno schema PostgreSQL separato
npm run check   # type check di server e portale
```

## Configurazione

Tutte le variabili sono documentate in `.env.example`. Le principali:

| Variabile | Default | Uso |
|---|---|---|
| `DATABASE_URL` | `postgres://azzurro:azzurro@localhost:5433/azzurro` | Connessione al database |
| `PUBLIC_URL` | `http://localhost:4000` | URL pubblico delle API |
| `AZZURRO_ADMIN_PASSWORD` | `Azzurro123!` | Password dell'amministratore al primo avvio |
| `AZZURRO_AUTH` | `strict` | `lax` accetta richieste anonime come amministratore |
| `AZZURRO_RBAC` | `on` | `off` disattiva i controlli RBAC su ARM |

Chiavi dell'assistente, app Microsoft e login locale si cambiano anche dal portale, senza riavviare: **Impostazioni → Configurazione del server** (solo amministratori globali, cioè `Azzurro.Owner`). I valori vanno in un file a parte, leggibile solo dall'utente, che prevale su `.env`: `~/Library/Application Support/Azzurro/config.env` per il servizio, `.azzurro.env` nella cartella del progetto in sviluppo, oppure il percorso in `AZZURRO_CONFIG_FILE`. I segreti non vengono mai rimostrati. Il login locale non si può spegnere finché Microsoft non è configurato.

Per avviare tutto in container: `docker compose --profile full up --build`.

## Come vengono stimati i costi

Azzurro non fattura nulla: i costi sono stime didattiche. Per ogni risorsa si prende la tariffa indicativa del piano attuale (SKU, dimensione VM, livello) e la si moltiplica per le ore in cui la risorsa è esistita nel periodo; per i contatori a consumo (operazioni, GB, token) si usa un consumo tipico simulato, perché l'emulatore non ha traffico reale. Le VM deallocate non pagano il calcolo, i dischi sì. Le risorse eliminate restano nel conto fino al momento dell'eliminazione. I prezzi non includono IVA, sconti, prenotazioni né licenze Windows o SQL Server.

## Limiti

- Azure AI Foundry si crea dal catalogo (risorsa Foundry con progetti, oppure hub classico); modelli e agenti non vengono eseguiti.
- Solo il piano di controllo: i dati dei servizi (BLOB, segreti di Key Vault via data plane, code, database) non sono emulati. Per lo storage puoi affiancare Azurite.
- I file Bicep vanno compilati in JSON con `az bicep build` prima del deployment.
- Non sono supportati i gruppi di gestione.
- `uniqueString()` e `guid()` sono deterministici ma non producono gli stessi valori di Azure.
- Il consenso utente alle autorizzazioni delegate viene concesso automaticamente.
