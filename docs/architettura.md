# BunkerPlex — nuova architettura (proposta)

Stato: **fatte le fasi 0-3 e la fase 4 (TV e telefono)** (vedi §5, §7-§10).
Decisioni già prese:
- il servizio centrale diventa una **PWA universale** (telefono, tablet, PC, iPhone/iPad);
- l'**app TV nativa resta**;
- l'**app Android per telefono resta per ora** (si decide dopo);
- l'**app iOS è stata tolta** (fase 0): su iPhone e iPad si usa la PWA. Il codice resta nel tag `pre-pwa`.

---

## 1. Com'è oggi

### 1.1 I pezzi

| Pezzo | Dove | Cosa fa |
|---|---|---|
| Servizio account | `cloud/worker.js` + D1 (`cloud/schema.sql`) | Utenti, login (password, Google, reset), impostazioni e visti sincronizzati, amici, registro dei server (`servers`), biglietti per entrare nei server degli amici, chiavi Tailscale, notifiche, amministrazione |
| Server | `server/app.py` (FastAPI, ~10.000 righe) | Raccolte, scansione, TMDB, streaming/transcodifica, sottotitoli, sigle, cast, aggiornamenti, installazione TV. **Inoltre**: proxy del login verso il cloud, sessioni locali, proxy di tutto il contenuto di amici e altri PC |
| Interfaccia web | `server/static/app.js` | Servita da ogni server; parla **solo** col server che l'ha servita (`fetch('/api' + path)`, `app.js:658`). Ha già `manifest.json` e `sw.js` |
| App telefono Android | `android/app` | WebView dell'interfaccia del server + `setup.html` (scansione LAN) + modalità remota `remote.html` |
| ~~App iOS~~ | ~~`ios/`~~ | Tolta in fase 0 (tag `pre-pwa`) |
| App TV | `android/tv` | Nativa (Compose, telecomando, player Media3). Parla solo col server di casa |
| Comune Android | `android/comune`, `android/tsnet` | Player, rete, Tailscale dentro l'app (`bpnet`), `remote.html` |

### 1.2 Dove sta il "server principale"

Il cloud **non** ha un server principale: ogni PC si registra da solo (`PUT /servers`). Il server principale nasce **nei client e nel server**:

1. **Le app partono da un solo indirizzo salvato** (`server` nelle preferenze) e da lì caricano tutto. Se quel server è spento, si cade nella modalità remota ridotta (`remote.html`: 720p, niente ripresa, niente cast).
2. **Il login passa dal server.** La password arriva in chiaro al server (`app.js:4826` → `app.py:3796`), che calcola il verificatore, entra nel cloud con `device = SERVER_NAME` e tiene il gettone cloud in `users.token`. Ai dispositivi dà una sessione **locale** (`bp_session`).
3. **Il server che apri fa da centro (hub).** Catalogo, immagini e video di amici e degli altri propri PC passano tutti dal server aperto (`friend_json`, `friend_pipe`), con id virtuali `FRIEND_BASE = 1e9` e un massimo di 20 amici per stare negli interi a 32 bit della TV (`app.py:7125-7127`). Lo stato "visto" dei contenuti degli amici resta su quel server (`friend_state`), non per utente e non sincronizzato.
4. **La scelta del server è un filtro sull'hub.** `serversPage` (`app.js:480-537`) prende la lista da `/api/account-friends` del server aperto; scegliere un server imposta `src=f<n>` e l'hub risponde dalla sua copia. Si possono scegliere solo i server che l'hub ha già collegato.
5. **Il proprietario è implicito e locale**: è il primo account cloud registrato nel database del PC (`OWNER_SQL`, `app.py:3064`). Il cloud non lo sa.

### 1.3 Cosa esiste già e va nella direzione giusta

- Il cloud ha già: registro dei server per account con indirizzo remoto **e** di casa (`servers.url`, `servers.lan`), impronta del certificato (`pin`), amici, biglietti a uso singolo, login Google per TV/telefono senza server (`/google/start` con `kind`).
- La **modalità remota** delle app (`remote.html`, `Remote.kt`) è già il modello finale in piccolo: login sul cloud → lista server da `GET /friends` → biglietto → gettone del server → contenuto direttamente dal server scelto.
- Il server si collega agli altri PC provando prima la rete di casa e poi l'indirizzo remoto (`app.py:8452-8473`): stessa logica da portare nei client.
- `app.js` è già una PWA (manifest, service worker) e ha già il player HLS per Safari e la qualità adattiva.
- Il Worker ha già le notifiche web push (`/avvisi`).

### 1.4 Problemi trovati durante l'analisi (da sistemare comunque)

Sicurezza:
- **Chiunque abbia un gettone dell'account** (anche un telefono) può riscrivere `url` e `pin` di un server dell'account (`worker.js:1298-1313`): nessuna prova che a scrivere sia quel PC. Con `url`/`pin` falsi si può intercettare il biglietto di un amico e usarlo entro 5 minuti.
- **Dispositivi Tailscale**: l'upsert su `ts_devices` assegna il dispositivo a chi chiama (`worker.js:1262-1264`). Un amico, che conosce il `sid`, può prendersi `bunkerplex-<sid>` e poi cancellare il nodo del PC. Senza `host` il limite di 4 dispositivi non si applica (`worker.js:1243`).
- **Controlli mancanti sul server**: `/api/sharing/accounts/{account}`, `GET /api/sharing`, `POST /api/friends`, `/api/friends/quality` non verificano che chi chiama sia il proprietario o un amministratore (anche un ospite può chiamarli).
- Le sessioni cloud non scadono mai; un utente non può vedere né revocare i propri dispositivi; cambiare password scollega anche tutti i PC.

Robustezza:
- `GET /friends` fa una query per amico: con ~45 amici supera il limite di query di D1 per richiesta.
- `rev = Date.now()` nella sincronizzazione dei visti non è monotòno tra istanze del Worker: si possono perdere righe.
- `schema.sql` non contiene tabelle e colonne create dal Worker al volo (`ts_devices`, `google_flows`, `reset_codes`, `notices`, `kv`, `servers.lan`, `servers.friends`).

---

## 2. Architettura proposta

```
                    ┌─────────────────────────────────────────┐
                    │ Servizio centrale (Cloudflare Worker+D1)│
                    │  • account, login, dispositivi          │
                    │  • registro server + presenza           │
                    │  • amici e condivisioni                 │
                    │  • gettoni d'accesso firmati            │
                    │  • nomi DNS e certificati dei server    │
                    │  • ospita la PWA                        │
                    └───────▲───────────────▲──────────▲──────┘
          login, lista      │               │          │ registrazione,
          server, gettoni   │               │          │ presenza, certificato
                    ┌───────┴──────┐ ┌──────┴─────┐ ┌──┴────────────────┐
                    │ PWA          │ │ App TV     │ │ Server (1..n)     │
                    │ tel/PC/iOS   │ │ nativa     │ │ raccolte, video   │
                    └───────┬──────┘ └──────┬─────┘ └──▲────────────────┘
                            │  collegamento diretto    │
                            └──────────────┴───────────┘
                      1° rete di casa · 2° remoto (pubblico / Tailscale)
```

Principio: **il cloud sa chi sei e dove sono i server; i dati non passano mai dal cloud né da un altro server.** Ogni client parla direttamente con il server scelto.

### 2.1 Servizio centrale (`cloud/`)

Resta Cloudflare Worker + D1. Si aggiunge, non si riscrive.

**Dispositivi e sessioni**
- `sessions` riceve `kind` (`pwa`, `tv`, `server`), `label`, scadenza con rinnovo.
- Nuove rotte utente: `GET /devices`, `DELETE /devices/:id` (oggi solo l'amministratore lo può fare).
- Cambio password: chiude le sessioni dei dispositivi, **non** le credenziali dei server (che diventano separate, sotto).

**Server come risorsa con identità propria**
- Nuova credenziale **del server**, distinta da quella dell'utente: il server si associa all'account con un codice (mostrato a `localhost:32500` o come QR) che l'utente conferma dalla PWA. Il cloud registra `servers.owner_id` → il proprietario non è più "il primo utente nel database del PC".
- Solo la credenziale di quel server può scrivere i propri indirizzi, il proprio `pin` e il proprio certificato. Il telefono non può più riscriverli.
- **Presenza**: `POST /servers/:sid/heartbeat` ogni 1-2 minuti con gli indirizzi attuali (rete di casa, remoto). Il cloud tiene `last_seen`; la lista server mostra acceso/spento senza sondare ogni PC.
- `GET /servers`: un'unica lista per l'utente con i propri server e quelli condivisi dagli amici (`owner`, `name`, `online`, indirizzi, `role`). Sostituisce l'uso di `GET /friends` come lista server e risolve il limite di query (una JOIN sola).

**Gettoni d'accesso firmati (al posto di biglietto + gettone locale)**
- `POST /servers/:sid/access` → il cloud restituisce un gettone breve (es. 12 ore) **firmato** (ES256) con `user`, `sid`, `role` (`owner` / `friend`), scadenza.
- Il server lo verifica **da solo** con la chiave pubblica del cloud (scaricata e tenuta in cache). Non deve più chiamare `/tickets/check` né conservare il gettone cloud di un utente.
- Revoca: se l'amicizia finisce, il cloud non emette più gettoni; quelli già emessi scadono entro poche ore. La credenziale del server permette anche di scaricare una lista di revoche.

**Nomi e certificati per i server** (prerequisito della PWA, vedi §3)
- Dominio dedicato su Cloudflare, es. `bpx.<dominio>`.
- Il Worker crea, su richiesta del server autenticato, i record DNS `<ip-con-trattini>.<sid>.bpx.<dominio>` → IP di casa / IP pubblico, e il record TXT `_acme-challenge` per il certificato.
- Il server ottiene da Let's Encrypt un certificato `*.<sid>.bpx.<dominio>` (verifica DNS-01) e lo rinnova da solo.

**Amici e condivisioni**: restano come sono (`friends`, `servers.friends`), con la presenza e i ruoli dentro `GET /servers`. Il livello "per raccolta" si può aggiungere dopo (oggi il flag `shared` per raccolta è di fatto inutilizzato).

**PWA**: servita dal Worker stesso (Workers Static Assets), sullo stesso dominio dell'API → niente CORS verso il cloud.

**Amministrazione**: le pagine admin chiamano il cloud direttamente dalla PWA, non più tramite un server (`app.py:4255-4437`).

### 2.2 Server (`server/`)

Resta responsabile di raccolte e contenuti. **Non si tocca**: scansione, TMDB, raccolte, streaming e transcodifica, qualità adattiva, HLS, sottotitoli, sigle, cast, aggiornamenti, installazione TV, sincronizzazione impostazioni e raccolte.

Cambia:
- **Un solo ingresso HTTPS con certificato valido** che espone l'API completa, filtrata per ruolo: `owner` vede e gestisce tutto, `friend` ha l'accesso in sola lettura che oggi dà `/api/share/*`. La porta 32500 in HTTP resta per `localhost`, per la configurazione iniziale e per le app TV già installate.
- **Autenticazione**: accetta `Authorization: Bearer <gettone firmato dal cloud>`. Per `<video>`/`<img>`, che non possono mandare intestazioni, URL firmati a breve scadenza (lo schema esiste già per il cast, `app.py:9858+`).
- **CORS** aperto solo all'origine della PWA.
- **Presenza** con la propria credenziale di server (heartbeat), non più con il gettone dell'utente.
- **Proprietario** letto dal cloud, non dedotto dal database locale.
- **Modalità senza cloud** mantenuta: se il cloud non risponde, l'interfaccia servita dal server stesso (`localhost:32500` o IP di casa) continua a funzionare con le sessioni locali di oggi. Nessuna perdita rispetto a oggi.

Da togliere **alla fine** (fase 5), quando PWA e TV non li usano più:
- proxy del login, abbinamento TV via server, flussi Google lato server (`app.py:3778-4195`);
- hub degli amici: `friend_json`, `friend_pipe`, copie in `data/friends/`, id virtuali `FRIEND_BASE`, limite di 20 amici, `friend_state`;
- amici "vecchio stile" con nome e password (`/api/share/register`, `/api/share/login`, tabella `accounts`), che oggi vedono **tutte** le raccolte del PC;
- proxy dell'amministrazione.

### 2.3 PWA (da `server/static/app.js`)

Un solo codice, due modi:
- **Centrale** (dal Worker): login sul cloud → `GET /servers` → scelta del server → collegamento diretto.
- **Locale** (dal server, come oggi): stesso codice, `api()` punta allo stesso server. Serve per la prima configurazione e quando il cloud è irraggiungibile.

Cambia:
- `api(path)` usa la base del server scelto invece di `'/api'` fisso, con gettone in intestazione invece del cookie.
- Login: direttamente sul cloud (la password non passa più da un server).
- **Selezione server: l'interfaccia attuale resta così com'è** (`serversPage`, pulsante in alto, richiesta all'apertura). Cambia solo la fonte della lista (cloud invece di `/api/account-friends`) e cosa succede alla scelta (cambia server di destinazione invece di filtrare sull'hub). In più mostra acceso/spento dalla presenza.
- Visti e punti di ripresa: inviati al server che riproduce (come oggi) e, per i titoli con TMDB, anche al cloud (`POST /state`), così valgono su tutti i server, compresi quelli degli amici.
- Notifiche: le web push del Worker (`/avvisi`) diventano quelle della PWA.

### 2.4 App TV (`android/tv`)

Resta nativa. Cambia:
- Login direttamente sul cloud: codice/QR da confermare sulla PWA del telefono (il flusso `/google/start` con `kind: tv` e la pagina `/g/<codice>` esistono già; si estende al login con password confermato dal telefono).
- Lista server da `GET /servers`; schermata di scelta attuale (`Access.kt` `ServersScreen`) mantenuta, cambia solo la fonte.
- `Api.base` diventa il server scelto, con lo stesso ordine di collegamento della PWA. Niente più id virtuali degli amici.
- Fuori casa può continuare a usare Tailscale dentro l'app (`android/tsnet`) finché serve.

### 2.5 Collegamento intelligente (PWA e TV)

Per il server scelto, candidati in ordine:

1. **Stesso PC**: `http://localhost:32500` (Chrome e Firefox lo permettono anche da una pagina HTTPS).
2. **Rete di casa**: `https://<ip-di-casa>.<sid>.bpx.<dominio>` (certificato valido).
3. **Remoto**: indirizzo pubblico (porta aperta con UPnP/NAT-PMP, che esiste già) con lo stesso schema di nomi; in alternativa Tailscale Funnel (esiste già, porta 32502) o Tailscale nell'app TV.

Si provano in parallelo con un piccolo vantaggio ai locali (~300 ms); vince il primo che risponde **e** dichiara il `sid` giusto in `/api/info`. L'ultima strada buona si ricorda per rete; si riprova al cambio di rete o al primo errore.

---

## 3. Prerequisito: HTTPS valido sui server

Senza questo la PWA non può collegarsi alla rete di casa:
- una pagina HTTPS non può chiamare `http://192.168.x.x` (contenuto misto);
- il browser rifiuta il certificato autofirmato della 32501 e non permette di confrontare l'impronta come fanno le app;
- Chrome chiede inoltre un permesso per gli IP privati.

La soluzione (la stessa di Plex con `*.plex.direct`) è descritta in §2.1. Rischi noti:
- **Protezione dal DNS rebinding** di alcuni router (Fritz!Box, pfSense, dnsmasq): bloccano nomi pubblici che puntano a IP di casa. In quel caso si passa al remoto; va documentato come aggiungere l'eccezione.
- **Limiti di Let's Encrypt** (certificati nuovi per dominio registrato a settimana): con molti server nuovi si superano. Rimedi: iscrivere `bpx.<dominio>` alla Public Suffix List, oppure una seconda autorità ACME.

---

## 4. Contro della PWA (accettati, da gestire)

- **Formati video**: i browser (soprattutto Safari) non leggono MKV, HEVC, AC3/DTS e sottotitoli ASS → il server transcodifica di più. La TV nativa non ne risente.
- **Chromecast** non funziona da Safari (AirPlay sì).
- **iOS**: Safari può svuotare la memoria delle PWA poco usate (si perde il login, non i dati); le notifiche funzionano solo se la PWA è installata sulla schermata Home.
- **Niente Tailscale nel browser**: fuori casa serve un indirizzo pubblico (§2.5).
- **Niente scansione della rete di casa**: non serve più, i server sono noti dal cloud.

---

## 5. Piano a fasi

Ogni fase lascia tutto funzionante; le app esistenti continuano a lavorare fino alla fase 5.

| Fase | Contenuto | Tocca |
|---|---|---|
| 0 ✅ | Correzioni subito: scrittura dei server solo dal server stesso (anche in forma provvisoria), furto dei dispositivi Tailscale, controlli mancanti sul server, `GET /friends` con una sola query, `schema.sql` allineato. Tag `pre-pwa`. App iOS tolta. | `cloud/`, `server/` |
| 1 ✅ | Cloud: credenziale del server (associazione con codice rimandata alla fase 3, oggi la prende il server con il gettone del proprietario), presenza, `GET /servers`, gettoni firmati, dispositivi e scadenze. Server: accetta i gettoni firmati **accanto** alle sessioni di oggi, heartbeat. | `cloud/`, `server/` |
| 2 ✅ | Dominio, DNS e certificati (manca solo il dominio vero: §8); ingresso HTTPS unico con API completa per ruolo; CORS; URL firmati per i media. Prova da browser. | `cloud/`, `server/` |
| 3 | PWA: `app.js` nei due modi, login sul cloud, lista dal cloud, collegamento diretto, selezione server invariata, admin e notifiche dalla PWA. Pubblicata dal Worker. | `server/static/`, `cloud/` |
| 4 | App TV: login sul cloud, lista dal cloud, collegamento diretto. | `android/tv`, `android/comune` |
| 5 | Rimozioni: `android/app` e `setup.html` (se si decide di togliere anche l'app telefono), workflow `app-android.yml`; nel server proxy del login, hub degli amici, amici vecchio stile, proxy admin. Avviso a chi usa le app telefono (non ricevono più aggiornamenti). | tutto |

---

## 6. Decisioni aperte

1. **Dominio** per PWA e nomi dei server (necessario per la fase 2).
2. **Accesso da fuori casa** predefinito: porta aperta sul router + nome DNS, oppure Tailscale Funnel (ha limiti di banda), oppure entrambi.
3. **Profili "Chi guarda?"**: oggi solo locali al PC; portarli nel cloud (uguali ovunque) o lasciarli per server.
4. **Visti dei contenuti degli amici**: solo nel cloud per titolo TMDB (proposta) o anche sul server dell'amico.
5. **Modalità senza account** (utente "Casa" senza cloud): mantenerla o richiedere sempre l'account.

---

## 7. Fatto nella fase 1 (ramo `fase-1`)

Nessun cambiamento visibile: le app e il sito di oggi funzionano come prima. Il nuovo serve a PWA e TV (fasi 3 e 4).

### Servizio account (`cloud/worker.js`, prove in `cloud/test_worker.mjs`)

| Rotta | Chi | Cosa fa |
|---|---|---|
| `POST /servers/:sid/claim` | sessione del proprietario | Il server prende la sua credenziale (`s_<sid>_<segreto>`). Riprenderla quando c'è già: solo una sessione di tipo `server`, o se il server tace da 10 minuti. Un altro account: mai (409). |
| `POST /server/heartbeat` | credenziale del server | Presenza e indirizzi (`url` da fuori, `lan` di casa, `pin`, `friends`, `version`). Scrive la riga di `servers`. |
| `GET /server/me` | credenziale del server | Sid e proprietario. |
| `POST /server/verify` | credenziale del server | Verifica un gettone d'accesso (per i server senza `cryptography`); ricontrolla l'amicizia. |
| `DELETE /server` | credenziale del server | Il server esce dall'account. |
| `GET /servers` | sessione | Propri server e quelli condivisi dagli amici: `online` (presenza negli ultimi 10 minuti, `null` = server di prima), `role`, `owner`, `addresses` (`lan` solo per i propri), `pin`. |
| `POST /servers/:sid/access` | sessione | Gettone d'accesso ES256, 12 ore: `{sub, name, sid, own, role: owner/friend, exp, jti}`. Per un server di un amico si passa `owner`. |
| `POST /servers/:sid/forget` | sessione | Toglie un proprio server dall'elenco (anche spento). |
| `GET /keys` | nessuna | Chiave pubblica (JWK) per verificare i gettoni. |
| `GET /devices`, `DELETE /devices/:id` | sessione | Dispositivi dell'account con il tipo (`server`, `pwa`, `tv`, `app`, `browser`); togliere uno. |

Inoltre:
- `kind` nelle sessioni (da `/login`, `/setup`, `/reset/finish`, Google); una sessione non usata per 180 giorni scade.
- Con la credenziale, `PUT /servers` e `DELETE /servers/:sid` con il gettone di un utente rispondono 409: i dati del server li scrive solo lui.
- `GET /friends` (app di prima) mostra solo i server con un indirizzo da fuori.
- Nuova tabella `server_creds`; chiave dei gettoni in `kv` (`access`). Il Worker le crea da solo.

### Server (`server/app.py`, prove in `server/test_access.py`)

- Entra nel servizio account come sessione di tipo `server`.
- Presenza (`presence_v2`): prende la credenziale con il gettone del proprietario, manda la presenza a ogni giro di sincronizzazione (3 minuti), la riprende se non vale più, esce dall'account se cambia proprietario o se il proprietario viene tolto dal PC. Con il servizio account di prima (404) resta `PUT /servers`.
- Gettoni d'accesso (`access_claims`): verifica la firma con `GET /keys` se c'è `cryptography` (aggiunto a `requirements.txt`: serve ricostruire Docker), altrimenti `POST /server/verify`.
  - `Authorization: Bearer <gettone>` con `role: owner` → API complete come il proprietario (`AuthGate`).
  - `POST /api/share/access {token}` → ingresso per amici (e altri dispositivi dello stesso account) come `/api/share/ticket`, senza biglietto.

### Pubblicazione

1. Prima il Worker su Cloudflare (le tabelle nuove si creano da sole).
2. Poi il ramo su `main`: i server si aggiornano da soli; dove l'aiutante ricostruisce Docker arriva anche `cryptography`.

---

## 8. Fatto nella fase 2 (ramo `fase-2`)

Spento finché non si configura il dominio: senza, tutto funziona come prima.

### Servizio account (`cloud/worker.js`, sezione «Nomi e certificati dei server»)

- **Nome nella rete di casa**: a ogni presenza il Worker allinea un record DNS
  `<ip-con-trattini>.<sid>.<SERVER_DOMAIN>` → IP di casa (solo IP privati 10/8, 172.16/12, 192.168/16).
  Cambia l'IP: nome nuovo, il vecchio si cancella. Il server se ne va: via anche i nomi.
- **Certificato** `*.<sid>.<SERVER_DOMAIN>` da Let's Encrypt con la verifica DNS-01, fatta dal Worker:
  - `POST /server/cert/start {csr}` (credenziale del server): ordine e record TXT `_acme-challenge`;
  - `POST /server/cert/poll` (ogni ~15 s): verifica, firma, certificato. Il TXT si cancella alla fine.
  - La chiave privata del certificato non lascia mai il server: al Worker arriva solo la CSR.
- `GET /servers` → `addresses.secure_lan` = `https://<nome>:<porta>` per i propri server con il certificato.
- `GET /` → `certs: true/false`.
- Prove: `node --test cloud/test_worker.mjs` (Cloudflare e Let's Encrypt finti).

**Configurazione del Worker** (segreti/variabili):

| Nome | Valore |
|---|---|
| `SERVER_DOMAIN` | es. `bpx.<dominio>`: una zona (o sottodominio di una zona) su Cloudflare |
| `CF_ZONE_ID` | id della zona |
| `CF_API_TOKEN` | token con permesso «Zone → DNS → Edit» solo su quella zona |
| `ACME_AGREE` | `yes`: accetta le condizioni di Let's Encrypt (decisione di chi gestisce il servizio) |
| `ACME_EMAIL` | facoltativa, avvisi di Let's Encrypt |
| `ACME_DIRECTORY` | facoltativa: per le prove lo staging `https://acme-staging-v02.api.letsencrypt.org/directory` |

### Server (`server/app.py`, prove in `server/test_secure.py`)

- **Certificato** (`secure_check`, ogni 6 ore): dal dominio ricevuto con la presenza chiede il certificato,
  lo salva in `data/tls/`, lo rinnova a 30 giorni dalla scadenza o se cambia il dominio.
- **Porta https `SECURE_PORT` (32443)**: tutto BunkerPlex come la 32500, con il certificato valido; il
  certificato rinnovato si usa senza riaccendere. Risponde solo con gli account attivi. **Non si apre sul
  router**: rete di casa e Tailscale (firewall di Windows come la 32500).
- **CORS**: le risposte si possono leggere solo dall'indirizzo della PWA (quello del servizio account, più
  `BUNKERPLEX_PWA_ORIGINS`), con l'intestazione per gli IP privati di Chrome. Niente cookie tra siti.
- **Chiavi dei video**: `POST /api/access/media` → chiave di 6 ore (firmata con un segreto del PC) da
  aggiungere come `?bpk=` a video e immagini (solo GET), perché `<video>` non manda `Authorization`.
- `docker-compose.yml`: porta 32443 (serve ricostruire il contenitore, lo fa l'aiutante).

### Da fare per accenderla

1. Scegliere il dominio (decisione aperta n. 1) e metterlo su Cloudflare.
2. Configurare il Worker come sopra, prima con lo staging di Let's Encrypt.
3. Rischi già noti (§3): protezione DNS rebinding di alcuni router; limite di Let's Encrypt sui certificati
   nuovi per dominio (con molti server: Public Suffix List).

---

## 9. Fase 3: PWA centrale (ramo `fase-3`)

- Il Worker serve `server/static` (`wrangler.toml`, `[assets]`): `GET /` da browser = la PWA con
  `<meta name="bp-central">`; con `Accept: application/json` resta lo stato per server e app.
- `app.js` in modalità centrale (sezione «PWA centrale»): accesso con l'account sul servizio (password con
  la stessa impronta PBKDF2 dei server, Google, password dimenticata, password provvisoria), elenco da
  `GET /servers` con la stessa grafica della scelta del server, collegamento diretto (nome https di casa,
  poi `http://localhost:32500`), riapertura sull'ultimo server, Esci.
- Server: `POST /api/auth/access {token}` → sessione (`X-BP-Session`), così «Chi guarda?», Esci e il resto
  funzionano come sempre; chiave dei video nel percorso `/k/<chiave>/api/...` (vale anche per i segmenti
  HLS); `sid` in `/api/info` e in `/api/account-friends`.
- I server degli amici si aprono dal proprio server acceso (come prima, `src = f<n>`).
- Provato dal vivo in locale (wrangler dev + server): accesso, elenco, collegamento, Home, riapertura,
  cambio server, chiave dei video, Esci.
- Da pubblicare: il Worker (porta con sé la PWA aggiornata). Il service worker non si registra nel browser
  integrato di prova: da ricontrollare su Chrome.

---

## 10. Fase 4: app TV e app Android (ramo `fase-4`)

**App TV** (`android/tv`, `Access.kt` sezione «Con l'account»):
- All'apertura: con l'account → elenco dei server del servizio (e si torna da soli sul server di prima);
  senza → «Entra con il tuo account» (nome o email e password, oppure Google con indirizzo e codice da
  aprire sul telefono) o «Collega un server senza account» (la ricerca di prima). Chi aveva già un server
  scelto a mano continua come prima. (Il pulsante «Collega un server senza account» non c'è più: vedi
  «Senza Internet».)
- Collegamento: nome https di casa, `http://<IP di casa>:32500` (dall'indirizzo che il server dà al
  servizio), l'ultimo che ha funzionato, poi la ricerca sulla rete; sempre controllando il `sid`.
- Sessione: gettone d'accesso → `/api/auth/access` → `X-BP-Session`. Home, player, «Chi guarda?» e il
  resto non cambiano. I server degli amici si aprono dal tuo server (src `f<n>`).
- «Esci dall'account», «Aggiorna», «Amici e tuoi PC fuori casa» (Tailscale dentro l'app, come prima).
- **Senza Internet** (servizio account che non risponde): niente pulsante da scegliere, la TV va da sola
  sull'ultimo server usato con la sessione che ha già; se non basta, cerca il server sulla rete di casa;
  solo se non lo trova chiede l'indirizzo, già scritto con l'ultimo IP conosciuto. Lo stesso nell'app
  Android (ricerca di `setup.html`).

**App Android** (`android/app`): senza un server scelto a mano apre la PWA del servizio account
(accesso, elenco, collegamento diretto anche in http nella rete di casa: la WebView lo permette); il player
nativo riceve il server scelto (`server_base`). Dalla ricerca del server: «Entra con l'account».

**Da verificare**: compilazione (qui manca l'SDK Android: la fa `verifica.yml` su una pull request) e prova
su TV e telefono veri. Perché funzioni in produzione servono il server aggiornato (rami fino a `fase-3`
su `main`) e il Worker ripubblicato (porta l'`app.js` nuovo).
