# Allineamento delle app (analisi del 27/11/2026)

Principio: **l'interfaccia è una sola, la PWA** (`server/static/app.js`: centrale dal servizio
account, la stessa dal server di casa). Le app native usano parti native solo dove servono:
Android = player video, installazione sulla TV, notifiche, aggiornamento dell'APK; Samsung =
cornice, tasti del telecomando, uscita. Tutto il resto deve essere identico.

Un server entra in un account quando lo si crea (si entra sul server con l'account e lo si
collega); dopo si può solo togliere.

## Decisioni (27/11/2026)

- **App TV nativa tolta** (`android/tv`, `BunkerPlexTV.apk`): sulle TV Android c'è l'app BunkerPlex,
  la stessa del telefono (PWA centrale con l'aspetto da TV, player nativo). «Installa sulla TV» dal
  telefono mette `BunkerPlex.apk` e toglie la vecchia app nativa se c'è.
- **`remote.html` tolta**, e con lei Tailscale dentro l'app (`android/tsnet`, `bpnet.aar`): fuori casa
  la TV vede i server come il telefono e la Samsung (quelli con «Da ovunque»).
- **Senza Internet** l'app tiene la ricerca del server in casa e l'indirizzo scritto a mano
  (`setup.html`): solo lì, perché la PWA centrale non si apre.
- **«Aggiungi un server» tolto ovunque**: un server si collega quando lo si crea, entrando su di lui
  con l'account («Collega al mio account»). Dopo si può solo togliere («Togli dall'elenco»).

Tutte le righe delle tabelle qui sotto sono sistemate nella PR «Un'interfaccia sola», tranne la
sezione E (note).

## Le superfici prima dell'allineamento

| Dove | Cosa mostra oggi | Cosa dovrebbe mostrare |
|---|---|---|
| Browser (telefono, PC, iPhone) | PWA centrale | uguale |
| App Android sul **telefono** | PWA centrale (WebView) + player, notifiche, installa sulla TV | uguale |
| App Android (`it.bunkerplex.tv`) su una **TV** | con un server salvato apre **direttamente il server di casa**, non la PWA centrale (`MainActivity.kt:246-248`); fuori casa la vista ridotta **`remote.html`**; senza server la ricerca in casa e **l'indirizzo scritto a mano** (`setup.html`) | PWA centrale come il telefono, aspetto da TV |
| **App TV nativa** `BunkerPlexTV.apk` (`it.bunkerplex.atv`, `android/tv`) | **un secondo BunkerPlex completo rifatto in Compose**: accesso, scelta del server, Home, schede, ricerca, raccolte, sottotitoli, amici, dispositivi, profili, aggiornamenti… È **quella che «Installa sulla TV» del telefono mette sulle TV Android** (`TvInstaller.kt:17-19`) | non dovrebbe esistere: al suo posto l'app Android con la PWA |
| Samsung (app e browser) | PWA centrale con aspetto da TV | uguale, ma senza le cose da telefono (sotto) |

## Disallineamenti trovati

### A. Server (il caso segnalato)

| # | Cosa | Dove | Correzione |
|---|---|---|---|
| A1 | «**Aggiungi un server** · Con il codice che compare sul server» nella scelta dei server, **anche su TV e Samsung** (codice da scrivere col telecomando) | `app.js:1469-1470`, foglio `cClaimSheet` `app.js:1922-1949`, azioni `app.js:2699-2733` | Tolto da tutte le app: il server si collega solo quando lo si crea, entrando sul server con l'account («Collega al mio account», `app.js:9921-9935`) |
| A2 | Il server non collegato mostra un **codice da scrivere «sul telefono → Server → Aggiungi un server»** (voce che non esiste con quel nome) | `app.js:9936-9950` | Tolto il codice: sul server si entra con l'account e si collega con un tocco |
| A3 | L'app TV nativa scopre un server nuovo in casa e mostra il codice «Sul telefono: BunkerPlex → Server → Aggiungi un server» | `Access.kt:514-559, 800-841` | Sparisce con l'app nativa |
| A4 | **Server aggiunto a un account senza codice**: `PUT /servers` (vecchia presenza) crea la riga per qualsiasi sid, poi `POST /servers/:sid/claim` dà la credenziale perché «l'account ha già quel server» | `worker.js:3870-3887`, `693-718` | `PUT /servers` aggiorna solo server già nell'account, non ne crea di nuovi |
| A5 | **Indirizzo del server scritto a mano**: «Scrivi l'indirizzo» / «Collega» | `setup.html:43-56`, `remote.html:657`, app nativa `MainActivity.kt:376-393` | Resta solo in `setup.html`, cioè senza Internet (ricerca in casa, poi indirizzo) |
| A6 | «**Cambia server**» in 7 punti dell'app nativa e nella PWA dentro l'app: ricerca nativa del server invece della scelta della PWA | `app.js:5188-5189, 285, 335, 638`, nativa (vari) | Ovunque la scelta dei server della PWA (`#/server`) |
| A7 | Scelta dei server **dal server di casa** diversa da quella centrale: niente «Rifiuta» sulle richieste, niente «Togli dall'elenco», server spento = solo un avviso | `app.js:734-803` | Stesse azioni della centrale |
| A8 | Sulla TV (anche Samsung) «Aggiungi un amico» (nome da scrivere col telecomando) e «Sicurezza dell'accesso» (passkey e 2FA, che sulla TV non si usano) | `app.js` scelta dei server, Amici, Account | Tolti dalla TV: si fanno dal telefono o dal PC, come password, email e Google |

### B. App e vie doppie

| # | Cosa | Dove | Correzione |
|---|---|---|---|
| B1 | App Android su TV apre il server di casa invece della PWA centrale | `MainActivity.kt:246-248, 252-299` | PWA centrale come sul telefono |
| B2 | **`remote.html`**: seconda interfaccia (accesso, scelta server, raccolte, schede, riproduzione a 720p via Tailscale nell'app, dispositivi) solo sulle TV | `android/comune/assets/remote.html` | Tolta, con Tailscale dentro l'app |
| B3 | **App TV nativa** (`android/tv`) con tutto rifatto a mano | `android/tv/**`, `app-tv-nativa.yml`, `server/updater.py:866`, `server/app.py:11465-11473`, `TvInstaller.kt:17-19`, `app.js:5308-5391` | Tolta: «Installa sulla TV» mette l'app BunkerPlex (PWA) e toglie quella vecchia |
| B4 | Il server di casa installa sulle TV un APK diverso da quello del telefono (`BunkerPlex.apk` contro `BunkerPlexTV.apk`) | `server/app.py:123, 11548` vs `TvInstaller.kt:19` | Un solo APK: `BunkerPlex.apk` |
| B5 | Samsung con `?app=tizen` ma browser che non si dichiara Tizen: niente aspetto da TV e pagina di accesso con email e password | `app.js:21-24` | `?app=tizen` vale sempre come TV |

### C. Testi che portano dove non c'è niente

| # | Testo | Dove | Correzione |
|---|---|---|---|
| C1 | «Impostazioni → Collega una TV»: nel menu a due colonne (TV, PC) la voce non c'è | `app.js:330, 1637`; `settingsAreas` `app.js:4421-4433` | Voce «Collega una TV» anche nel menu |
| C2 | «Impostazioni → App → Da ovunque»: il riquadro sta in «App per TV e telefono», nascosto nell'app e sulla TV | `app.js:2940` | Testo giusto |
| C3 | «Impostazioni → Aggiornamenti» / «Server → Aggiornamenti»: la voce si chiama «Aggiorna server» | `app.js:5210, 7827, 10593-10594` | Testo giusto |

### D. Codice morto da togliere

- `loginPage` «Entra con il telefono (QR o codice)» sulla TV: mai raggiunto (`app.js:637`).
- `googlePage` ramo TV: mai raggiunto (`app.js:419-436`).
- Redirect `apps && TV` (`app.js:5039`): non scatta mai.
- Nell'app nativa: `PairScreen`, `WebActivity`, `CloudTv.reachable`, `Update.serverTooOld` (spariscono con l'app).

### E. Note (non cambiano adesso)

- Due «Chi guarda?»: `profilesPage` (account sul PC, senza servizio) e `whoPage` (profili dell'account).
  Il primo serve solo al server senza servizio account.
- Due abbinamenti della TV: `/api/auth/pair` (6 caratteri, server di casa) e `/tv/start` (8, servizio).
  Con le TV sempre sulla PWA centrale, il primo resta solo per il server senza Internet.
- Amici «vecchio stile» con indirizzo e password (`app.js:6333-6343`): solo senza servizio account,
  da togliere con la fase 5 di `docs/architettura.md`.
- `docs/architettura.md` dice ancora «l'app TV nativa resta» e descrive la registrazione con `PUT /servers`.
