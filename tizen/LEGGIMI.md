# BunkerPlex sulle TV Samsung

Le Samsung non hanno Android (usano Tizen): l'APK e l'installazione dal server
(`server/tvinstall.py`) lì non funzionano. Ci sono due strade.

## 1. Il browser della TV (consigliata, niente da installare)

1. Sulla TV apri **Internet**.
2. Vai su `bunkerplex-account.bunkerplex.workers.dev` e aggiungilo ai preferiti.
3. Si accende da sola l'interfaccia per il telecomando, e compare un **codice**.
4. Sul telefono: BunkerPlex → **Collega una TV** → scrivi il codice. La TV entra con il tuo account.

Il riconoscimento della TV sta in `server/static/app.js` (`SMART_TV`, `BROWSER_TV`).
Vale anche per LG (webOS), Hisense (VIDAA) e le altre smart TV. L'aspetto da TV si spegne
da Impostazioni → Collegamento e visione.

A casa del server c'è anche **Guarda su** (DLNA, `server/cast.py`): dal telefono si manda
un film alla TV, senza aprire niente sulla TV.

## 2. L'app (icona tra le App della TV)

L'app (`config.xml`, `index.html`, `main.js`, `main.css`) è una cornice a tutto schermo
attorno alla stessa pagina del punto 1. Niente script o stili dentro `index.html`: la CSP di
Tizen li blocca (sulla TV si vedeva solo un riquadro vuoto in alto a sinistra). In più:
- l'icona tra le App;
- **Indietro** dalla Home chiude l'app;
- i tasti play/pausa, avanti e indietro del telecomando arrivano al player.

GitHub la compila e la firma a ogni modifica di `tizen/` (`.github/workflows/app-samsung.yml`)
e la mette nella release `samsung-tv` (`BunkerPlex.wgt`).

### Installare

Sulla TV, una volta: **App** → scrivi `1 2 3 4 5` col telecomando (o premi il tasto 123) →
accendi **Modalità sviluppatore** → come **IP del PC host** scrivi l'indirizzo di chi
installa (telefono o PC) → spegni e riaccendi la TV. La TV accetta l'installazione solo da
quell'indirizzo.

Tre modi, tutti con lo stesso `BunkerPlex.wgt` della release `samsung-tv`:

1. **Dal telefono** (anche a casa di un amico, niente PC): app BunkerPlex per Android →
   Impostazioni → «Installa sulla TV» → scheda **TV Samsung**. Mostra l'IP del telefono da
   scrivere sulla TV, cerca le Samsung nel Wi-Fi e installa; se la TV vuole il certificato
   Samsung lo chiede da solo (vedi sotto) (`android/app/.../SamsungInstaller.kt`).
2. **Dal server di casa** (PWA o browser): Impostazioni → App per TV e telefono →
   **Installa sulla TV Samsung dal PC**. Sulla TV va scritto l'IP del PC del server
   (`server/samsunginstall.py`).
3. **Da un PC con Docker Desktop**: `strumenti/sviluppo/Installa su TV Samsung.bat`. Usa gli
   strumenti Tizen dell'immagine Docker di
   [install-jellyfin-tizen](https://github.com/Georift/install-jellyfin-tizen) e può
   rifirmare l'app con un certificato Samsung (vedi sotto). L'app installata è la nostra
   (`installa.sh`).

Telefono e server parlano da soli il protocollo `sdb` della TV (porta 26101: quello di adb,
senza chiavi): copiano il file (`sync:`), lo installano (`0 vd_appinstall`) e aprono l'app
(`0 was_execute`). Le prove contro una TV finta sono in `server/test_samsung.py`. Prima di
installare chiedono alla TV (porta 8001) se la Modalità sviluppatore è accesa e con quale IP.

### Le TV che vogliono il certificato Samsung (automatico)

Le TV più nuove rifiutano l'app firmata col certificato generico (`Check certificate
error`, `[118,-12]`). Vogliono autore e distributore firmati da Samsung, con il
distributore che elenca le TV (DUID, fino a 50). Si fa da solo:

1. **Chi installa** (telefono o server di casa) prova l'app normale. Se la TV la rifiuta,
   legge il codice della TV (`0 getduid` via sdb) e lo manda al servizio account
   (`POST /samsung/tv`). Poi aspetta con la pagina aperta e, appena il certificato è
   pronto, installa da solo `BunkerPlex-samsung-cert.wgt`. Una TV già nel certificato
   riceve subito quella.
2. **Chi amministra BunkerPlex** deve aver fatto l'accesso al suo account Samsung, dall'app
   Android del telefono: Impostazioni → Collegamento e visione → **Certificato Samsung** →
   Accedi a Samsung (o dal pulsante che compare in «Installa sulla TV» mentre una TV
   aspetta). Si apre la pagina di Samsung, ci si entra; l'app riceve il gettone (come
   Tizen Studio: Samsung rimanda a `http://localhost:4794/signin/callback`, dove ascolta
   l'app) e la PWA lo manda al servizio, dal server di casa con la sua credenziale. La
   richiesta della TV invece non chiede l'account (poche TV nuove al giorno per rete). Il gettone dura un po': finché vale, le TV nuove passano senza
   toccare niente. Quando serve rifarlo, a chi amministra arriva un avviso
   («TV Samsung in attesa» / «Serve un accesso a Samsung»).
3. **GitHub** (`.github/workflows/app-samsung.yml`, lavoro `samsung`, ogni 5 minuti) chiede
   al servizio se c'è una TV nuova (`GET /samsung/job`, con `RELEASE_KEY`). Se sì:
   `certificato_samsung.py` chiede a Samsung il distributore con tutte le TV (l'autore
   resta lo stesso finché vale, un anno), firma l'app, la mette nella release
   `samsung-tv` e lo dice al servizio (`POST /samsung/job`).

I `.p12` li tiene il servizio account, cifrati con `TIZEN_AUTHOR_PASSWORD` (sta solo su
GitHub). Le autorità Samsung che vanno nella firma sono in `tizen/samsung-ca` (Apache-2.0,
da Samsung). Riferimento del protocollo: il Certificate Manager di Samsung in
[Samsung/tizen-agent-skills](https://github.com/Samsung/tizen-agent-skills).

Per far partire GitHub subito invece che entro 5 minuti: al token `GITHUB_TOKEN` del
Worker si aggiunge il permesso **Actions: Read and write** sul repository.

Una TV con BunkerPlex firmata in un altro modo non accetta l'aggiornamento
(`Author certificate not match`, `[118,-11]`): si disinstalla dalla TV e si riprova.

A mano, senza il giro automatico: certificato Samsung da Tizen Studio (Certificate Manager
→ Samsung → TV) o da [tizen-cert](https://github.com/gifflet/tizen-cert-cli), `author.p12` e
`distributor.p12` in `tizen/certificati/` (in `.gitignore`), poi `Installa su TV Samsung.bat`.

### Da sapere

- Il certificato d'autore va tenuto sempre lo stesso, se no la TV non accetta gli
  aggiornamenti. Sta nei segreti di GitHub `TIZEN_AUTHOR_P12_B64` e
  `TIZEN_AUTHOR_PASSWORD`. Senza i segreti il workflow ne crea uno al volo (solo per provare).
- Il certificato d'autore attuale (copia in `Documents/BunkerPlex/tizen-autore` sul PC di
  casa) scade il **2027-01-01**, come la «Tizen Developers CA» che lo firma. Poi va rifatto
  con gli strumenti Tizen che avranno la CA nuova, e aggiornati i due segreti. Non è
  chiaro se l'app già installata continui ad aprirsi dopo quella data.
- La firma su GitHub usa gli strumenti Tizen dell'immagine Docker di install-jellyfin-tizen
  (bloccata a una versione provata): Tizen Studio 5.6 non legge il certificato.
- I contenuti arrivano sempre dalla PWA centrale: l'app si reinstalla solo quando cambia
  `tizen/` (raramente).
- **Provata su una TV Samsung vera** (novembre 2026): installazione dal telefono, app e
  icona. Da vedere ancora le TV che chiedono il certificato Samsung.
