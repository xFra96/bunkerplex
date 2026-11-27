# BunkerPlex — stato del lavoro sulla nuova architettura (25/11/2026)

Riepilogo da passare a chi continua. Il progetto completo è in `docs/architettura.md` (ramo `fase-4`).

## Obiettivo

Niente più «server principale». Il **servizio centrale** (Cloudflare Worker + D1, `cloud/worker.js`) gestisce identità, account, dispositivi, registro dei server, presenza, amici e permessi. I **server** (`server/app.py`) sono risorse dell'account: gestiscono raccolte e video. Le **app** (TV nativa, Android, PWA) entrano con l'account, prendono l'elenco dei server dal servizio e si collegano **direttamente** al server scelto, preferendo la rete di casa. La scelta del server ha la stessa grafica di prima.

## Dove sta il codice

- Rami uno sopra l'altro: `fase-0` → `fase-1` → `fase-2` → `fase-3` → `fase-4` (ognuno contiene i precedenti). **`main` non è toccato.**
- Pull request in bozza **#73** (`fase-4` → `main`), Auto-fix attivo. Compilazione Android (`verifica.yml`, `assembleDebug` di TV e telefono): **riuscita** sul commit `7ab2271`; le due successive (`d28f9d8`, `bf877c6`) erano in corso.
- Tag `pre-pwa`: lo stato prima di togliere l'app iOS.

## Già in produzione

- **Worker** pubblicato su Cloudflare, versione `e2e1b23b` (fasi 0-2 e la PWA servita dal Worker, ma con l'`app.js` di allora, senza la modalità centrale). Per tornare indietro: `npx wrangler@4 rollback 333e1ddd-000b-45ff-9f46-e1f6b881a187`.
- `wrangler` è collegato all'account Cloudflare; si pubblica con `cd cloud` e `npx wrangler@4 deploy` (`cloud/wrangler.toml`: Worker `bunkerplex-account`, D1 `bunkerplex`, file della PWA da `server/static`, variabili del pannello mantenute).

## Cosa è stato fatto

**Fase 0 – sicurezza e robustezza**
- Indirizzo e impronta di un server li scrive solo il PC che li ha registrati (prima bastava un qualsiasi gettone dell'account).
- Tailscale: un amico non può più prendersi il nome del dispositivo di un tuo PC; il limite di 4 dispositivi non si salta più.
- Server: `GET /api/sharing`, `/api/sharing/accounts/{id}`, `POST/DELETE /api/friends`, `/api/friends/quality` solo per proprietario o amministratore.
- `GET /friends` con una query sola (prima si rompeva con ~45 amici); `schema.sql` allineato.
- Tolta l'app iOS (su iPhone e iPad si usa la PWA). L'app Android resta.

**Fase 1 – server come risorsa**
- Credenziale propria per ogni server (`POST /servers/:sid/claim`, poi `POST /server/heartbeat`): il proprietario è registrato nel servizio.
- Presenza (acceso/spento) e `GET /servers` (propri server + quelli condivisi dagli amici, con indirizzi e ruolo).
- Gettoni d'accesso firmati ES256, 12 ore (`POST /servers/:sid/access`, chiave in `GET /keys`); il server li verifica da solo (pacchetto `cryptography`, nuovo in `requirements.txt`) o chiedendo al servizio.
- Dispositivi dell'account con tipo (server/pwa/tv/app/browser), `GET/DELETE /devices`, scadenza dopo 180 giorni senza uso.

**Fase 2 – HTTPS valido nella rete di casa** (spento finché non c'è il dominio)
- Il Worker crea il nome `<ip-con-trattini>.<sid>.<dominio>` → IP di casa e ottiene da Let's Encrypt il certificato `*.<sid>.<dominio>` (verifica DNS-01); la chiave privata resta sul server.
- Server: porta https **32443** (tutto BunkerPlex, solo rete di casa e Tailscale, non si apre sul router), CORS per la PWA, chiavi dei video (`/k/<chiave>/api/...`).

**Fase 3 – PWA centrale**
- Il Worker serve `server/static`; `app.js` in modalità centrale: accesso con l'account, elenco dei server, collegamento diretto, riapertura sull'ultimo server, Esci.
- Server: `POST /api/auth/access` scambia il gettone con una sessione normale (`X-BP-Session`).
- Provata dal vivo in locale (wrangler dev + server).

**Fase 4 – app TV e Android** (la priorità)
- **TV**: accesso con l'account (nome o email e password, oppure Google con indirizzo e codice), elenco dei server dal servizio, ritorno automatico sull'ultimo server, collegamento diretto (nome https di casa → IP di casa sulla 32500 → ultimo indirizzo buono → ricerca in rete) controllando il `sid`. Home, player e «Chi guarda?» invariati.
- **Senza Internet**: nessun pulsante da scegliere; la TV riapre l'ultimo server con la sessione che ha, altrimenti cerca il server in rete; chiede l'IP (già scritto) solo se non lo trova.
- **Android**: senza un server scelto apre la PWA del servizio (la WebView permette l'http verso il server di casa); ricorda l'ultimo server (anche con l'account); senza Internet passa alla ricerca in rete con l'IP già scritto.
- I server degli amici si aprono ancora dal proprio server (serve un tuo server acceso).

**Accesso rifinito** (novembre 2026)
- **Google**: PKCE (S256) e `nonce` controllato nel gettone; l'email già scritta va a Google (`login_hint`); account sbagliato o scelta annullata non bruciano il codice: si riprova sul telefono e la TV legge il motivo (`note` in `/google/poll`); `seen` quando il codice viene aperto. Lo stesso browser che ha chiesto il codice (PWA del servizio) salta la conferma con un cookie `bpg`; a fine giro la finestra si chiude da sola o torna alla PWA (`back`), sul telefono Android c'è «Torna all'app».
- **TV**: QR anche per Google (TV nativa, `remote.html` con zxing nell'app), riga di stato in diretta («In attesa del telefono…», «Codice aperto sul telefono», errori), codice nuovo da solo quando scade, niente stop per un attimo senza rete. Vale anche per «Collega questa TV» (`/api/auth/pair/<codice>/seen`) e per l'accesso dal servizio (`/tv/<codice>/seen`).
- **Impronta e volto (passkey, WebAuthn)**: `/passkeys/*` nel Worker (ES256/RS256, verifica dell'utente obbligatoria, contatore, sfide a uso singolo); nella PWA centrale «Entra con impronta o volto», proposta dal campo email, offerta dopo il primo accesso e pagina `#/passkey` per toglierle.
- **App Android del telefono**: passkey anche dentro l'app (WebView con `androidx.webkit`, `WEB_AUTHENTICATION_SUPPORT_FOR_APP`); il Worker dichiara l'app in `/.well-known/assetlinks.json` solo col segreto `ANDROID_CERT_SHA256` (impronta SHA-256 della chiave di firma: `keytool -list -v -keystore bunkerplex.jks -alias bunkerplex`). Senza il segreto le passkey vanno nel browser ma non nell'app. Dopo Google nel browser, «Torna all'app» riapre l'app.
- **Moduli**: errori scritti sotto i campi, pulsante che gira mentre si entra, occhio per vedere la password, avviso del Bloc Maiusc.

**Sicurezza dell'accesso** (Impostazioni → Account nella PWA del servizio, o `#/sicurezza`)
- **Conferma che sei tu** prima di ogni modifica (password, passkey dell'account o codice 2FA; vale 10 minuti per la sessione, colonna `sessions.reauth`; una sessione aperta da meno di 10 minuti vale già). La impone il Worker (`{reauth: true}`).
- **Passkey**: elenco con data di aggiunta e ultimo uso, rinomina, «Aggiungi questo dispositivo». **Togliere** si conferma con un **codice via email** (`/passkeys/<id>/remove` e `/remove/confirm`, 15 minuti, 5 tentativi); senza email o senza Brevo basta la conferma. Aggiunte e tolte arrivano anche via email. Il vecchio `DELETE /passkeys/<id>` risponde 409.
- **Verifica in due passaggi (TOTP)**, l'alternativa alle passkey per chi entra con la password: QR (generatore QR in `app.js`, provato contro segno) o chiave da scrivere, poi un codice per attivarla; 10 codici di recupero a uso singolo (copia/scarica). Dopo la password (anche link via email e password nuova) il Worker risponde `{need_2fa, ticket}` e il gettone arriva da `/login/2fa`. Google e passkey non la chiedono.
- **Ricorda questo dispositivo** (30 giorni, `totp_trust`): il gettone resta nel browser/app per account; si dimenticano tutti cambiando password, rifacendo i codici, spegnendo la 2FA o con «Dimentica i dispositivi ricordati».
- Il codice si chiede ovunque si scriva la password: PWA del servizio, server di casa (`/api/auth/login/2fa`), telefono che fa entrare la TV (`/api/auth/pair`), app Android (`remote.html`, `Remote.login2fa`). Offline il server di casa accetta ancora l'ultima password usata lì (senza codice), come prima.

## Prove

- `node --test cloud/test_worker.mjs`: 13 passate (D1 finto, Cloudflare e Let's Encrypt finti).
- Server: `python -m unittest test_access test_secure` passate. `test_classify.test_id_imdb_nei_nomi_e_nfo` fallisce già su `main` (non c'entra).
- App Android/TV: compilate da GitHub (vedi sopra). **Non ancora provate su TV e telefono veri.**

## Per andare in produzione (in quest'ordine)

1. Compilazione verde su #73.
2. Ripubblicare il Worker (porta l'`app.js` con la modalità centrale). È compatibile con i server di oggi.
3. Unire #73 in `main`: parte la release del server (si aggiornano da soli; `cryptography` e la porta 32443 richiedono di ricostruire Docker, lo fa l'aiutante) e delle app TV e Android.
4. Prova su TV e telefono veri (anche: la WebView di Android chiede un permesso per la rete di casa?).

## Decisioni aperte

1. **Dominio** su Cloudflare per l'HTTPS di casa (`SERVER_DOMAIN`, `CF_ZONE_ID`, `CF_API_TOKEN`, `ACME_AGREE=yes` nel Worker; provare prima con lo staging di Let's Encrypt in `ACME_DIRECTORY`).
2. Accesso **da fuori casa**: porta sul router + nome DNS, oppure Tailscale Funnel (oggi resta Tailscale dentro l'app).
3. ~~Profili «Chi guarda?» nel servizio o per server.~~ Deciso: nel servizio (vedi `architettura.md` §11).
4. Visti dei contenuti degli amici (proposta: nel servizio per titolo TMDB).
5. Tenere o no la modalità senza account.

## Da fare dopo / limiti noti

- Passkey solo dalla PWA del servizio account (l'indirizzo delle passkey è il suo nome): non sui server di casa né dentro la WebView dell'app Android.
- Server degli amici aperti direttamente (oggi passano dal proprio server).
- Cron settimanale per Brevo spento su Cloudflare (riga commentata in `wrangler.toml`).
- Service worker della PWA da ricontrollare su Chrome.

## Note tecniche per chi continua

- Fine riga: quasi tutto LF (`git ls-files --eol`); gli script `.ps1` sono CRLF. `.gitattributes` non converte niente: modificandoli con script, conservare i fine riga.
- `node --check` su un `.js` con `export` non segnala gli errori: copiare in `.mjs` per controllarlo.
- Prova completa in locale: `cloud/.dev.vars` con `SETUP_KEY`, `npx wrangler@4 d1 execute bunkerplex --local --file schema.sql`, `npx wrangler@4 dev --local --port 8787`; server con `DATA_CHECK=0 SHARE_PORT=0 SECURE_PORT=0 BUNKERPLEX_CLOUD=http://127.0.0.1:8787 uvicorn app:app --port 32500`; `/setup` per l'amministratore, poi accesso dal server e dalla PWA su `http://127.0.0.1:8787`.
