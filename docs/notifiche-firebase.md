# Notifiche istantanee: Firebase

Le notifiche di BunkerPlex arrivano dentro BunkerPlex, senza installare altro:

| Dove | Come arrivano | Da configurare |
|---|---|---|
| App Android (telefono e tablet) | Firebase Cloud Messaging (FCM) | progetto Firebase (**fatto**, vedi sotto) |
| iPhone e iPad (BunkerPlex sulla schermata Home, iOS 16.4+) | Web Push del browser | niente |
| PC (browser o BunkerPlex installato come app) | Web Push del browser | niente |
| TV | nessuna notifica | — |

Senza Firebase l'app Android funziona lo stesso: controlla gli avvisi da sola ogni 15 minuti circa
(Android a volte li fa arrivare più tardi). Con Firebase arrivano subito.

## Stato: configurato

| Cosa | Valore |
|---|---|
| Progetto Firebase | `bunkerplex-d4e2a` (Gemini e Google Analytics spenti) |
| App Android nel progetto | pacchetto `it.bunkerplex.tv` (l'`applicationId` di `android/app/build.gradle.kts`) |
| Segreto GitHub `GOOGLE_SERVICES_JSON` | il file `google-services.json` dell'app: lo usa `.github/workflows/app-android.yml` per compilare l'APK con Firebase |
| Segreto del Worker `FCM_SERVICE_ACCOUNT` | la chiave JSON dell'account di servizio `firebase-adminsdk`: la usa `cloud/worker.js` per spedire le notifiche |
| Segreto GitHub `FCM_SERVICE_ACCOUNT` | copia della stessa chiave; oggi nessun workflow la usa (il Worker ha la sua, salvata con `wrangler secret put`) |

I file scaricati sono stati cancellati dal PC: **`google-services.json` e la chiave non vanno mai nel codice**
(`android/app/google-services.json` è in `.gitignore`; la compilazione lo scrive dal segreto e lo cancella).

Cosa serve perché arrivino sul telefono:

1. Unire la PR: si pubblicano il Worker nuovo (che usa `FCM_SERVICE_ACCOUNT`) e l'APK nuovo (compilato con
   `GOOGLE_SERVICES_JSON`). Nel registro di «Pubblica l'app Android» non deve comparire l'avviso giallo
   «Manca il segreto GOOGLE_SERVICES_JSON».
2. Sul telefono: aggiornare l'app (Impostazioni dell'app → Aggiorna l'app).
3. **Impostazioni dell'app → Notifiche → Attiva le notifiche** → Android chiede il permesso → **Consenti**.
4. Dopo qualche secondo la pagina dice «gli avvisi arrivano subito, anche con l'app chiusa».
   **Manda una prova**: arriva la notifica.

Se resta «per ora l'app controlla gli avvisi ogni 15 minuti circa»: il segreto del Worker manca o è sbagliato,
oppure il telefono non ha Google Play. Appena il segreto è giusto l'app passa da sola alle notifiche istantanee
(al primo controllo o alla prossima apertura).

## Aggiornamenti dell'app

Indipendente dagli avvisi dell'account e da Firebase: l'app Android (telefono e tablet, non TV) controlla da
sola ogni 6 ore circa, anche chiusa, l'ultima release `app-v*` su GitHub (`AppUpdates.kt`, `AppUpdateJob`).
Se è più nuova di quella installata mostra **«Aggiornamento di BunkerPlex disponibile»** sul canale
«Aggiornamenti dell'app», una volta per versione; toccandola si apre l'app, che propone «Aggiorna ora».
Con l'app aperta non si notifica (lo propone già la pagina). Serve il permesso delle notifiche: da Android 13
l'app lo chiede una volta sola al primo avvio (preferenza `notify_asked`); chi dice di no può darlo dopo con
«Attiva le notifiche» o dalle impostazioni di Android.

## Privacy: nessun indirizzo personale

Il progetto è stato creato con un account Google personale, ma quell'indirizzo non compare da nessuna parte:

- nell'APK c'è solo `google-services.json`: id del progetto (`bunkerplex-d4e2a`), numero del progetto, id
  dell'app e chiave API pubblica di Firebase. Nessuna email;
- il Worker si presenta a Google con l'account di servizio (`firebase-adminsdk-…@bunkerplex-d4e2a.iam.gserviceaccount.com`),
  solo nella richiesta del gettone d'accesso. Non finisce in nessuna risposta, notifica o pagina;
- le notifiche contengono solo titolo e testo dell'avviso; quelle del browser (PWA) usano come contatto VAPID
  `bunkerplex@outlook.it` (`MAIL_FROM`).

## Facoltativo: un altro proprietario del progetto

Se un giorno ci sarà un account Google dedicato a BunkerPlex, il progetto può passare a lui senza rifare
niente (stessi file, stessi segreti):

1. Firebase → ingranaggio ⚙ → **Utenti e autorizzazioni** → **Aggiungi membro** → email del nuovo account →
   ruolo **Proprietario** (oppure Google Cloud → IAM e amministrazione → IAM → Concedi l'accesso → ruolo
   Proprietario).
2. Il nuovo account accetta l'invito dall'email.
3. Se vuoi, poi togli l'account personale dallo stesso elenco.

## Cambiare la chiave dell'account di servizio

Da fare se la chiave finisce in mani sbagliate (con la chiave si possono mandare notifiche ai telefoni):

1. Firebase → Impostazioni progetto → **Account di servizio** → **Genera nuova chiave privata**.
2. Dalla cartella `cloud` (con `npx wrangler login` fatto una volta con l'account Cloudflare di
   bunkerplex@outlook.it), cambiando il nome del file:

   ```powershell
   Get-Content -Raw "$HOME\Downloads\bunkerplex-d4e2a-firebase-adminsdk.json" | npx wrangler secret put FCM_SERVICE_ACCOUNT
   ```

   Vale subito, senza ripubblicare il Worker. Aggiorna anche il segreto GitHub `FCM_SERVICE_ACCOUNT`.
3. Elimina la chiave vecchia: «Gestisci le autorizzazioni dell'account di servizio» (porta a Google Cloud) →
   account `firebase-adminsdk` → **Chiavi** → elimina quella vecchia. Poi cancella il file dalla cartella Download.

`google-services.json` invece non è segreto (sta dentro ogni APK): cambia solo se si rifà l'app nel progetto.
In quel caso si aggiorna il segreto GitHub `GOOGLE_SERVICES_JSON`:

```powershell
Get-Content -Raw google-services.json | gh secret set GOOGLE_SERVICES_JSON --repo xFra96/bunkerplex
```

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
