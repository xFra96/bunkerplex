# Notifiche istantanee: configurare Firebase

Le notifiche di BunkerPlex arrivano dentro BunkerPlex, senza installare altro:

| Dove | Come arrivano | Da configurare |
|---|---|---|
| App Android (telefono e tablet) | Firebase Cloud Messaging (FCM) | **questa guida, una volta sola** |
| iPhone e iPad (BunkerPlex sulla schermata Home, iOS 16.4+) | Web Push del browser | niente |
| PC (browser o BunkerPlex installato come app) | Web Push del browser | niente |
| TV | nessuna notifica | — |

Finché Firebase non è configurato l'app Android funziona lo stesso: controlla gli avvisi da sola ogni
15 minuti circa (Android a volte li fa arrivare più tardi). Con Firebase arrivano subito.

Servono due file del progetto Firebase:

- **`google-services.json`**: dice all'app a quale progetto Firebase appartiene. Va nel segreto GitHub
  `GOOGLE_SERVICES_JSON` (la compilazione dell'APK lo mette nell'app).
- **la chiave dell'account di servizio** (un altro file `.json`): permette al servizio account (il Worker
  su Cloudflare) di spedire le notifiche. Va nel segreto del Worker `FCM_SERVICE_ACCOUNT`.
  **È una chiave privata**: non va mai nel codice, in chat o per email.

Firebase e FCM sono gratuiti (piano Spark): non serve una carta di credito.

## 1. Account Google con l'indirizzo Outlook (senza Gmail)

1. Apri <https://accounts.google.com/signup> e scegli **Crea account → Per uso personale**.
2. Scrivi nome e data di nascita.
3. Nella pagina «Scegli il tuo indirizzo Gmail» tocca **Usa il tuo indirizzo email esistente** e scrivi
   `bunkerplex@outlook.it`.
4. Google manda un codice a quella casella Outlook: copialo nella pagina.
5. Scegli la password (la tieni tu: non serve a BunkerPlex) e finisci.

Se `bunkerplex@outlook.it` ha già un account Google, basta entrare con quello.

## 2. Progetto Firebase

1. Apri <https://console.firebase.google.com> con l'account del punto 1.
2. **Crea un progetto** (o «Inizia con un progetto Firebase»), nome per esempio `BunkerPlex`.
3. Google Analytics: **non serve**, puoi spegnerlo. Poi **Crea progetto**.

## 3. App Android nel progetto → `google-services.json`

1. Nella pagina del progetto tocca l'icona **Android** («Aggiungi app»).
2. **Nome del pacchetto Android: `it.bunkerplex.tv`** (esattamente questo: è l'`applicationId` dell'app in
   `android/app/build.gradle.kts`; con un altro nome la compilazione si ferma).
3. Nickname a piacere (es. `BunkerPlex Android`). Il certificato SHA-1 non serve. **Registra app**.
4. **Scarica `google-services.json`**. I passi successivi della procedura guidata («Aggiungi l'SDK
   Firebase»…) saltali: nel codice c'è già tutto.

## 4. Chiave dell'account di servizio (per il Worker)

1. In Firebase: ingranaggio ⚙ → **Impostazioni progetto** → scheda **Cloud Messaging**: controlla che
   **API Firebase Cloud Messaging (V1)** sia «Attivata» (nei progetti nuovi lo è già).
2. Scheda **Account di servizio** → **Firebase Admin SDK** → **Genera nuova chiave privata** → **Genera
   chiave**. Si scarica un file `.json` (contiene `"type": "service_account"` e `"private_key"`).

## 5. Dove mettere i due file

### `google-services.json` → segreto GitHub `GOOGLE_SERVICES_JSON`

Sul repository GitHub: **Settings → Secrets and variables → Actions → New repository secret**

- Name: `GOOGLE_SERVICES_JSON`
- Secret: tutto il contenuto del file `google-services.json` (aprilo con il Blocco note, copia e incolla)

Oppure dal PC, con GitHub CLI, nella cartella dove hai scaricato il file:

```powershell
Get-Content -Raw google-services.json | gh secret set GOOGLE_SERVICES_JSON --repo xFra96/bunkerplex
```

### Chiave dell'account di servizio → segreto del Worker `FCM_SERVICE_ACCOUNT`

Dalla cartella `cloud` del repository (serve aver fatto una volta `npx wrangler login` con l'account
Cloudflare di bunkerplex@outlook.it), cambiando il nome del file con quello scaricato:

```powershell
Get-Content -Raw "$HOME\Downloads\bunkerplex-firebase-adminsdk.json" | npx wrangler secret put FCM_SERVICE_ACCOUNT
```

In alternativa dal pannello di Cloudflare: **Workers e Pages → bunkerplex-account → Impostazioni →
Variabili e segreti → Aggiungi → Segreto**, nome `FCM_SERVICE_ACCOUNT`, valore: tutto il contenuto del file.

Il segreto vale subito, senza ripubblicare il Worker, e le pubblicazioni successive non lo cancellano.

Poi **cancella la chiave dalla cartella Download** (o tienila in un posto sicuro): se qualcuno la prende può
mandare notifiche ai tuoi telefoni. Se pensi che sia finita in mani sbagliate: Firebase → Impostazioni
progetto → Account di servizio → «Gestisci le autorizzazioni dell'account di servizio» → chiavi → elimina,
poi generane una nuova e rifai questo passo.

## 6. APK nuovo e prova

1. L'APK con Firebase si compila alla prossima pubblicazione dell'app Android (push su `main` che tocca
   `android/`), oppure a mano: GitHub → **Actions → «Pubblica l'app Android» → Run workflow**.
   Se il segreto `GOOGLE_SERVICES_JSON` manca, la compilazione lo segnala con un avviso giallo e l'APK
   resta senza notifiche istantanee.
2. Sul telefono: aggiorna l'app (Impostazioni dell'app → Aggiorna l'app).
3. **Impostazioni dell'app → Notifiche → Attiva le notifiche** → Android chiede il permesso → **Consenti**.
4. Dopo qualche secondo la pagina dice «gli avvisi arrivano subito, anche con l'app chiusa». Tocca
   **Manda una prova**: arriva la notifica.

Se resta «per ora l'app controlla gli avvisi ogni 15 minuti circa»: il segreto `FCM_SERVICE_ACCOUNT` manca
o è sbagliato, oppure il telefono non ha Google Play. Appena il segreto c'è, l'app passa da sola alle
notifiche istantanee (al primo controllo o alla prossima apertura).

## Come funziona (per chi tocca il codice)

- App (`android/app`, `Notices.kt`): «Attiva le notifiche» nella pagina crea il dispositivo nell'account
  (`POST /notices/devices`), l'app chiede il permesso `POST_NOTIFICATIONS`, prende il gettone FCM e lo manda
  a `POST /avvisi/<gettone>/fcm`. `NoticePush` (un `FirebaseMessagingService`) mostra gli avvisi sul canale
  «avvisi» e, toccandoli, apre l'app; `onNewToken` rimanda il gettone quando Firebase lo cambia.
  Senza `google-services.json` il plugin `com.google.gms.google-services` non si applica, Firebase resta
  spento e resta il controllo periodico (`NoticeJob`).
- Worker (`cloud/worker.js`): `notify()` manda a ogni dispositivo Web Push e/o FCM (API HTTP v1, messaggio
  «data» con `android.priority: high`). Il gettone d'accesso di Google (JWT firmato con la chiave
  dell'account di servizio) resta in memoria per un'ora. I gettoni che FCM rifiuta (`UNREGISTERED`, 404)
  si cancellano. Senza segreto: nessuna chiamata a Google, `POST …/fcm` risponde `fcm: false`.
- PWA (`server/static/app.js`, `sw.js`): «Attiva le notifiche» chiede il permesso, il service worker di
  BunkerPlex si iscrive con la chiave VAPID del servizio (data da `POST /notices/devices`) e manda
  l'iscrizione a `POST /avvisi/<gettone>/push` (CORS aperto: lo fa anche la PWA servita dal server di casa).
- Prove: `node --test cloud/test_worker.mjs`.
