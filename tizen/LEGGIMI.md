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

L'app (`config.xml`, `index.html`) è una cornice a tutto schermo attorno alla stessa
pagina del punto 1, più:
- l'icona tra le App;
- **Indietro** dalla Home chiude l'app;
- i tasti play/pausa, avanti e indietro del telecomando arrivano al player.

GitHub la compila e la firma a ogni modifica di `tizen/` (`.github/workflows/app-samsung.yml`)
e la mette nella release `samsung-tv` (`BunkerPlex.wgt`).

### Installare

Serve un PC con **Docker Desktop**, sulla stessa rete della TV.

1. Sulla TV: **App** → scrivi `1 2 3 4 5` col telecomando (o premi il tasto 123) →
   accendi **Modalità sviluppatore** → come **IP del PC host** scrivi l'indirizzo del PC →
   spegni e riaccendi la TV.
2. Sul PC: `strumenti/sviluppo/Installa su TV Samsung.bat` e scrivi l'IP della TV
   (Impostazioni → Generali → Rete → Stato della rete).

Lo script usa l'immagine Docker di
[install-jellyfin-tizen](https://github.com/Georift/install-jellyfin-tizen) solo per i suoi
strumenti Tizen (`sdb`, `tizen`). L'app installata è la nostra (`installa.sh`).

### TV dal 2024 circa: il certificato Samsung

Le TV più nuove rifiutano l'app firmata col certificato generico
(`Check certificate error`, `Invalid certificate chain`). Allora serve un certificato
Samsung fatto per **quella** TV:

1. Installa Tizen Studio con **Samsung Certificate Extension** (Package Manager →
   Extension SDK).
2. Con la TV in Modalità sviluppatore, collegala da **Device Manager** di Tizen Studio.
3. **Certificate Manager** → nuovo certificato → **Samsung** → TV → entra con un account
   Samsung → il DUID della TV si aggiunge da solo. Scegli una password.
4. Copia `author.p12` e `distributor.p12` in `tizen/certificati/` (non va su GitHub, è in
   `.gitignore`).
5. Lancia di nuovo `Installa su TV Samsung.bat`: trova i certificati e chiede la password.

Più TV con lo stesso certificato: in Certificate Manager si aggiungono i DUID di tutte.

Se la TV dice `Author certificate not match`, sulla TV c'è già BunkerPlex firmata in un altro
modo: disinstallala dalla TV e riprova.

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
- **Non ancora provata su una TV Samsung vera.**
