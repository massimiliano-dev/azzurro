# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Sviluppatori e DevOps del team aziendale che sviluppano e testano applicazioni, infrastruttura come codice (ARM, Bicep, Terraform) e pipeline contro un Azure locale invece del cloud reale. Usano il portale accanto al terminale e all'editor: controllano cosa hanno creato via CLI o SDK, registrano app, assegnano ruoli, leggono deployment e log.

## Product Purpose

Azzurro è un emulatore locale di Azure che espone le stesse API di Azure Resource Manager, Microsoft Graph e Microsoft Entra ID. Il portale web è il modo visivo di gestire e ispezionare quell'ambiente: sottoscrizioni, gruppi di risorse, risorse, distribuzioni, IAM, utenti, gruppi, registrazioni app, log. Successo: il team lavora come su Azure, senza costi né rischi, e capisce cosa succede.

## Positioning

Trasparenza. A differenza del portale Azure, Azzurro mostra cosa succede sotto: le richieste ARM e Graph, i corpi JSON, i token, gli ID, le operazioni di distribuzione e l'activity log sono in primo piano, non nascosti. È uno strumento per capire Azure oltre che per usarlo.

## Operating Context

- Accesso con login aziendale obbligatorio (utenti del tenant Entra emulato).
- Usato su desktop con schermi larghi, spesso affiancato a terminale e IDE; anche installabile come PWA e consultabile da mobile per le notifiche push.
- Bilingue italiano e inglese; tema chiaro e scuro.
- Dati sensibili di sviluppo (segreti client, chiavi di accesso, token) mostrati con conferma e mascheramento.

## Capabilities and Constraints

- Next.js 16 (App Router) in `web/`, API Node/Hono in `server/`, PostgreSQL in Docker.
- Il portale chiama direttamente le API emulate tramite `/api/arm`, `/api/graph`, `/api/portal`.
- Funzioni: home, sottoscrizioni, gruppi di risorse, risorse con chiavi e figli, creazione da catalogo, distribuzioni con what-if, IAM, activity log, Entra (utenti, gruppi, app, applicazioni aziendali, ruoli, log), notifiche, connessione strumenti, impostazioni.
- Terminologia Azure ufficiale in italiano e inglese (es. «Gruppo di risorse», «Registrazioni app»).
- Layout: sfruttare tutta la larghezza dello schermo; niente contenitori stretti centrati.

## Brand Commitments

- Nome: Azzurro.
- Il blu/azzurro resta il colore identitario; palette, tipografia e logo possono evolvere.

## Evidence on Hand

Nessuna testimonianza, cliente o metrica reale: non inventarne.

## Product Principles

1. Mostrare il meccanismo: richieste, JSON e ID sono contenuto di prima classe.
2. Densità al servizio del lavoro: molta informazione leggibile, sfruttando lo spazio.
3. Fedeltà ad Azure nei concetti e nei nomi, semplicità nell'interfaccia.
4. Ogni azione distruttiva è chiara e confermata.
