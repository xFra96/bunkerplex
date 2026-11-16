# BunkerPlex

Il tuo cinema di casa: il computer tiene i video, la TV li guarda.

- **Server** sul computer (dentro Docker): cataloga film e serie, scarica locandine, trame e foto del cast, manda i video in streaming.
- **App per la TV**: Android TV, Google TV, Fire TV. Si usa col telecomando.
- **Dal browser** di qualsiasi PC, tablet o telefono di casa: `http://INDIRIZZO-DEL-COMPUTER:32500`.

Funziona senza Internet. La rete serve solo per scaricare le schede dei titoli, per gli aggiornamenti e, se vuoi, per condividere le raccolte con un amico.

## Installazione

Serve [Docker Desktop](https://www.docker.com/products/docker-desktop/) (gratuito). La prima volta ci vogliono Internet e qualche minuto.

### Windows

1. Installa Docker Desktop e aprilo una volta.
2. Scarica **[BunkerPlex.zip](https://github.com/xFra96/bunkerplex/releases/download/app-tv/BunkerPlex.zip)** (sempre l'ultima versione, con dentro anche l'app per la TV), poi scompatta la cartella dove vuoi (anche su un disco esterno, accanto ai video).
3. Doppio clic su **`Avvia BunkerPlex.bat`**. Alla fine si apre il browser e la finestra mostra l'indirizzo da usare su TV e telefono.

### Mac

1. Installa Docker Desktop e aprilo una volta.
2. Scarica **[BunkerPlex.zip](https://github.com/xFra96/bunkerplex/releases/download/app-tv/BunkerPlex.zip)**, poi scompatta la cartella dove vuoi.
3. Doppio clic su **`Avvia BunkerPlex.command`**. La prima volta macOS può bloccarlo: clic destro sul file → **Apri** → **Apri**.
4. Si apre il browser; la finestra mostra l'indirizzo da usare su TV e telefono.

Va bene anche **Code → Download ZIP** o lo zip «Source code» della release: al primo avvio BunkerPlex si porta da solo all'ultima versione e scarica l'app per la TV.

Se un disco esterno non compare nella scelta delle cartelle: Docker Desktop → Settings → Resources → File sharing, aggiungi `/Volumes` e rilancia il file.

Gli script per Mac sono nuovi e non ancora provati su molte macchine: se qualcosa non va, apri una segnalazione.

### Spegnere e riaccendere

- Per spegnere: `Ferma BunkerPlex.bat` (Windows) o `Ferma BunkerPlex.command` (Mac). Fallo prima di staccare un disco esterno.
- **Rilancia «Avvia» ogni volta che riaccendi il computer o ricolleghi un disco esterno**: senza, i dischi USB risultano «non raggiungibili» (il catalogo non si perde, ma i video non partono).

## Primi passi

1. **Crea una raccolta**: nel menu a sinistra **Aggiungi raccolta**, dai un nome (Film, Serie TV, Cartoni…) e scegli la cartella dei video. Film e serie vengono riconosciuti da soli. BunkerPlex legge soltanto: non modifica né cancella mai i tuoi file.
2. **Attiva locandine e schede**: crea un account gratuito su [themoviedb.org](https://www.themoviedb.org/), copia la chiave da *Impostazioni → API* e incollala in **Impostazioni** di BunkerPlex.
3. **Metti l'app sulla TV**: sulla TV installa l'app «Downloader» e aprici `http://INDIRIZZO-DEL-COMPUTER:32500/BunkerPlex.apk`. Al primo avvio l'app trova il server da sola. Poi si aggiorna da sé.

Nomi dei file che funzionano meglio:

| Cosa | Esempi |
| --- | --- |
| Film | `Il Padrino (1972).mkv`, `Il.Padrino.1972.1080p.mkv` |
| Episodi | `Breaking.Bad.S01E01.mkv`, `Breaking Bad 1x01.mkv`, file dentro `Stagione 1` |
| Sottotitoli | stesso nome del video: `Il Padrino (1972).it.srt` |
| Locandina tua | `poster.jpg` nella cartella del film |

## Cosa puoi fare

- **Home**: continua a guardare, prossimi episodi, ultimi arrivi per raccolta.
- **La mia lista**: i titoli da tenere da parte, uguale su TV, telefono e PC.
- **Saghe**: i film della stessa serie riuniti da soli, in ordine di uscita.
- **Cerca** per titolo, regista, attore, genere o anno; oppure sfoglia per genere senza scrivere.
- **Nelle raccolte**: filtri, ordinamento, **Vai alla lettera** e **Scegli tu** (un titolo a caso tra i non visti).
- **Cast con le foto** nella scheda: premi su un volto per vedere gli altri suoi titoli.
- **Menu della locandina** (clic su ⋯ o tasto destro; sulla TV tieni premuto OK): riproduci, segna come visto, aggiungi alla lista, correggi scheda.
- **Impostazioni → Questo dispositivo**: animazioni (si riducono da sole sui dispositivi lenti), locandine grandi, aspetto da TV per il browser di una smart TV.

### Telecomando

| Tasto | Cosa fa |
| --- | --- |
| Frecce | si muovono tra le locandine; a sinistra del bordo si apre il menu |
| OK | apre · tenuto premuto: menu delle azioni |
| Nel film: OK | pausa / riprendi |
| Nel film: ◀ ▶ | indietro 10 s / avanti 30 s |
| Nel film: ▲ ▼ | mostrano i comandi; con le frecce si sceglie un bottone, l'ingranaggio apre le opzioni (audio, sottotitoli, velocità, formato, spegnimento automatico) |
| Nel film: Menu / Info | opzioni, se il telecomando ha il tasto |
| Indietro | torna indietro; nel film esce salvando il punto |

Dal browser: `Spazio` pausa, `← →` salti, `↓` comandi (poi `← →` per scegliere un bottone), `M` muto, `S` sottotitoli, `N` episodio successivo, `F` schermo intero, `O` opzioni.

### Sottotitoli da internet

Nel film: Opzioni → **Cerca sottotitoli su internet** → scegli la lingua e poi il sottotitolo (quelli con «✓ fatti per questo file» vanno a tempo di sicuro). Li prende il PC da **OpenSubtitles.com** e li salva in `data/subs`, quindi poi ci sono su tutti i dispositivi. Per attivarli serve una chiave gratuita: crea un account su opensubtitles.com, Profilo → «API consumers» → nuova chiave, e incollala in Impostazioni → *Sottotitoli da internet*. Nome utente e password dell'account sono facoltativi ma alzano il limite di download giornaliero. Restano solo su questo PC.

### TV e chiavette adatte

Android TV, Google TV, Chromecast con Google TV, Fire TV Stick (Fire OS). Su Chromecast e Fire TV attiva prima le opzioni sviluppatore e consenti a «Downloader» di installare app sconosciute. Non adatti: Chromecast vecchi senza telecomando e Fire TV con Vega OS.

## Amici: condividere le raccolte via Internet

Due BunkerPlex in case diverse possono mostrarsi a vicenda le raccolte. **Si guarda soltanto**: nessuno tocca impostazioni, file o «visto» dell'altro. Tutto il resto continua a funzionare offline.

1. Entrambi accendete **Impostazioni → Amici → Condivisione con gli amici**. BunkerPlex chiede da solo al router di casa di aprire la porta per gli amici (la `32501`, e solo quella) e ti mostra **il tuo indirizzo**: è quello da dare all'amico.
2. Uno dei due apre **Manda una richiesta** (dal browser di un computer, non dalla TV) e scrive l'indirizzo dell'amico, un nome e una password a scelta.
3. L'amico preme **Accetta** in *Impostazioni → Amici*.

Da lì è automatico: il collegamento è cifrato, la porta sul router viene tenuta aperta finché la condivisione è accesa, e se il tuo indirizzo di casa cambia BunkerPlex lo comunica da solo agli amici (se cambiano entrambi nello stesso momento, uno dei due rimanda la richiesta).

**Se la porta non si apre da sola** — in *Impostazioni → Amici* lo leggi chiaramente. Capita quando nel router UPnP (o NAT-PMP) è spento: accendilo. Oppure quando l'operatore non ti dà un indirizzo pubblico (frequente con le linee radio e mobili): in quel caso installate [Tailscale](https://tailscale.com) (gratuito) su entrambi i computer, uno condivide il suo computer con l'altro dal sito di Tailscale (*Machines → Share*), e nella richiesta scrivete gli indirizzi Tailscale (quelli che cominciano per `100.`), il proprio compreso. Se preferisci Tailscale comunque, spegni **Apri da solo la porta sul router**.

Dentro Docker BunkerPlex non vede la rete di casa: per trovare il router gli serve che l'app sia stata aperta almeno una volta da un altro dispositivo di casa (la TV o il telefono). Quando l'amico è spento le sue raccolte restano sfogliabili ma i video non partono. I video arrivano convertiti a 720p (si cambia in *Impostazioni → Amici*), perché viaggiano sulla linea in caricamento di chi condivide.

**Sicurezza**

- La porta **32500** è senza password: non farla mai raggiungere da fuori casa. Agli amici serve solo la **32501**, che risponde soltanto agli amici approvati.
- Con Tailscale l'amico raggiunge il tuo computer su tutte le porte: condividi solo con chi ti fidi, oppure limita l'accesso alla `32501` nelle *Access controls* di Tailscale.
- La porta 32501 è **cifrata** (HTTPS) con un certificato creato dal tuo server: l'amico ne ricorda l'impronta alla prima richiesta e da lì in poi accetta solo quello. Il punto debole è quel primo collegamento: per sicurezza piena, la prima richiesta fatela sapendo che l'indirizzo è davvero quello dell'amico.
- Con la porta aperta sul router, la 32501 è visibile da Internet: risponde solo alla registrazione (che resta ferma finché non la approvi) e agli amici approvati. Dopo 5 password sbagliate l'accesso si blocca per un po'.
- Non inoltrare mai a mano altre porte, e mai la 32500.

## Aggiornamenti

BunkerPlex si aggiorna da questo repository, senza account né password.

- **Da solo**: il server controlla ogni 12 ore e installa quando nessuno sta guardando. Anche «Avvia» installa da solo le novità che trova. Si può spegnere in *Impostazioni → Aggiornamenti*.
- **Da qualsiasi dispositivo** (TV, telefono, browser di un altro PC): compare l'avviso, scegli **Aggiorna ora**, oppure *Impostazioni → Aggiornamenti*.
- **Dal PC del server**: `Aggiorna BunkerPlex.bat`, oppure **Aggiorna ora** da `http://localhost:32500`.

Ogni aggiornamento riallinea anche Docker: se sono cambiati codice, `Dockerfile`, pacchetti (`requirements.txt`) o `docker-compose.yml`, l'immagine viene ricostruita (scaricando anche la versione più recente dell'immagine di base) e il server si riaccende da solo. Lo stesso succede se il server sta girando con file più vecchi di quelli nella cartella, per esempio dopo un `git pull` fatto a mano.

Su Windows il lavoro sul PC lo fa un **aiutante** nascosto (`strumenti\Agente.ps1`): lo accende «Avvia» e riparte da solo a ogni accesso a Windows (collegamento *BunkerPlex aggiornamenti* nella cartella Esecuzione automatica). È lui che permette alla TV di aggiornare tutto, compresa la copia di sviluppo con git. Com'è andato l'ultimo aggiornamento: `strumenti\aggiornamento.log`. Se l'aiutante è spento il server si aggiorna lo stesso, ma per le novità che toccano Docker chiede di rilanciare «Avvia».

Non vengono mai toccati il catalogo (cartella `data`), il file `.env` e la chiave di firma dell'app. Se copi la cartella sopra una copia esistente, **non sovrascrivere `data`**.

Per usare lo stesso catalogo su più computer tieni tutta la cartella di BunkerPlex sul disco esterno insieme ai video: su ogni computer basta lanciare «Avvia».

## Se qualcosa non va

- **Cartella «non raggiungibile»**: collega il disco e rilancia «Avvia».
- **Docker Desktop non parte** con *«The file cannot be accessed by the system»* su un file `.sock`: lancia «Avvia», che a Docker spento toglie da solo quei file rimasti bloccati.
- **La TV non trova il server**: computer e TV devono essere sulla stessa rete. Se dal telefono `http://INDIRIZZO-DEL-COMPUTER:32500` non si apre, è il firewall: consenti Docker o imposta la rete come «Privata».
- **Titolo riconosciuto male**: menu della locandina → *Correggi scheda*.
- **Il video si ferma dopo una pausa**: nelle opzioni del player attiva *Audio compatibile*.
- **L'indirizzo del computer cambia**: nel router assegnagli un indirizzo fisso.
- **Chi è sulla tua rete di casa** apre BunkerPlex senza password: non esporlo su Internet.

## Per chi lo modifica

- `Compila APK.bat` ricrea l'app per la TV dentro Docker (niente Java o Android Studio). L'APK finisce in `apk/FrenkPlex.apk`: il file tiene il nome di prima perché lo cercano le copie già installate.
- `Pubblica aggiornamento.bat` manda le modifiche su GitHub (serve git).
- **Release compilata da GitHub**: a ogni push su `main` l'Action *Pubblica la release* (`.github/workflows/apk.yml`) aggiorna la release `app-tv`: sposta il tag sull'ultimo commit, allega `BunkerPlex.zip` (programma + APK + `strumenti/versione.json`) e, se da `apk-build` è cambiato qualcosa in `android/`, ricompila e allega `FrenkPlex.apk`. Da lì i server scaricano gli aggiornamenti e le TV li propongono da sole. Si può lanciare anche a mano: *Actions → Pubblica la release → Run workflow* (ricompila sempre l'APK). Va preparata una volta: su GitHub, *Settings → Secrets and variables → Actions → New repository secret*, nome `ANDROID_KEYSTORE_B64`, valore il contenuto di `android/keystore/SEGRETO-per-GitHub.txt` (è la chiave di firma in base64). Se manca, lo zip si pubblica lo stesso con l'APK di prima e il giro finisce in errore: mai una firma diversa, che le TV rifiuterebbero. Per rifare quel file: `base64 -w0 android/keystore/francoplex.jks`.
- `Installa su TV.bat` installa l'APK via adb.
- La cartella `android/keystore` contiene la chiave di firma dell'app: non finisce su GitHub, tienine una copia.
- Frequenza del controllo aggiornamenti: `UPDATE_CHECK_HOURS` tra le voci `environment` di `docker-compose.yml`.
- Se il repository diventa privato serve un token di sola lettura (*Contents: Read-only*) da incollare in *Impostazioni → Aggiornamenti*.
