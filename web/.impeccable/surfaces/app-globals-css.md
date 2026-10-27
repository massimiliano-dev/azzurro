---
version: 1
slug: "app-globals-css"
primary_target: "app/globals.css"
related_targets: ["components/shell.tsx"]
---

# Portale Azzurro — superficie console

Scope: tutto il portale autenticato (shell, home, elenchi, dettagli, form, Entra, costi, listino, assistente, notifiche) e la pagina di login. Mode: Operate.
Audience e job: sviluppatori e DevOps giovani del team su schermi larghi accanto a terminale e IDE; ispezionano e modificano l'ambiente Azure emulato o reale.
Vincoli: blu identitario; bilingue IT/EN; tema chiaro e scuro; tutta la larghezza; controlli web standard. Da tenere (utente): numeri grandi in home, logo attuale. Riferimenti dell'utente: Arc, Notion, Figma; animazione molto espressiva.
Momento memorabile: le richieste ARM e Graph che passano in diretta nel ticker in basso, e i numeri che salgono come un tabellone.
Decisioni aperte: nessuna.

## Direction contract

THESIS: Azzurro come gli Azzurri: la console racconta il tuo cloud in diretta con la grammatica delle grafiche TV delle partite, tabellone, sovrimpressioni e ticker. Rifiuta il clone grigio Fluent del portale Azure e la console scura al neon.

OWN-WORLD: Shell blu notte #0b1d51 (rail, testata, ticker) con il blu Azzurri #2f5bff come colore d'azione e di squadra; fondo ghiaccio chiaro, pannelli bianchi a raggio morbido 14px. Cartellini: rosso #ff3b4e per distruttivo ed errori, giallo #ffcc00 per attesa e avvisi, verde campo #19b36b per riuscito, oro #f6c344 per evidenza e scritture. Ogni categoria di risorsa ha la sua fascia colore di squadra. Saira variabile: corsivo condensato pesante per tabellone, numeri, score bug e sovrimpressioni; larghezza normale per l'interfaccia. Martian Mono per ID, percorsi, metodi e tempi. Tagli diagonali solo su score bug, tabellone, sovrimpressioni ed etichetta del ticker.

STORY: Lo sviluppatore apre Azzurro e vede subito il punteggio del suo ambiente: quante risorse, cosa è cambiato, quanto costa. Lavora con controlli normali; ogni modifica entra come una sovrimpressione e ogni richiesta API passa nel ticker, apribile per leggerne il JSON.

FIRST VIEWPORT: Rail blu notte a sinistra con marchio e menu standard; testata con ricerca, score bug della directory attiva (EMULATORE o AZURE) e orologio. In home: saluto in Saira corsivo condensato, poi il tabellone a tutta larghezza, numeri giganti che salgono a contatore con una tendina diagonale e una fascia colore per voce. Sotto, risorse recenti in tabella e attività come pila di sovrimpressioni. In basso il ticker DIRETTA delle richieste.

FORM: Grafiche TV delle partite della Nazionale, posizione 5 della lista ordinata del secondo giro; seed key a9d89751. Signature interaction: tendine e ticker, i cambiamenti entrano con una tendina diagonale, notifiche e toast come sovrimpressioni, le richieste come ticker in diretta con durata proporzionale. Motion: tendina diagonale 420ms in uscita esponenziale per pannelli e tabellone, contatori che salgono, sovrimpressioni che scorrono da sinistra con la fascia colore davanti, transizioni di pagina a tendina azzurra; con movimento ridotto tutto istantaneo.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
