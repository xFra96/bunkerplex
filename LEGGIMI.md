# FrenkPlex

Il tuo cinema di casa: il PC tiene i video, la TV li guarda.

- **Server** (sul PC, dentro Docker): cataloga film e serie, scarica locandine e schede, manda i video in streaming.
- **App per la TV** (`apk/FrenkPlex.apk`): per Android TV / Google TV / Fire TV. Si usa col telecomando.
- Funziona anche dal browser di qualsiasi PC, tablet o telefono di casa: `http://INDIRIZZO-DEL-PC:32500`.

Il **catalogo** (elenco dei film, schede, locandine, cosa hai già visto) sta in una cartella sola e viaggia sul disco esterno insieme ai video: su qualsiasi PC ritrovi la stessa libreria.

## Usarlo su più PC

Tieni **tutta questa cartella sul disco esterno**, insieme ai video. Su ogni PC con Docker Desktop installato fai doppio clic su `Avvia FrenkPlex.bat`: fa tutto da solo.

- Se Docker Desktop è spento lo accende e aspetta che sia pronto (se non è installato, propone di installarlo).
- Trova il catalogo nella cartella `data` qui accanto, qualunque lettera abbia il disco su quel PC.
- Collega al server tutti i dischi del PC, anche quelli USB, e controlla che si vedano davvero: se un disco esterno risulta vuoto lo ricollega e, se non basta, riavvia Docker.
- Se su quel PC il disco ha un'altra lettera (da `F:` a `E:`), le cartelle delle raccolte vengono ritrovate e aggiornate da sole: schede, visti e punti di ripresa restano.

La prima volta su un PC nuovo serve Internet e qualche minuto: Docker deve preparare il server.

In alternativa puoi tenere FrenkPlex sul PC e solo il catalogo sul disco: scrivi il percorso in `DATA_PATH` nel file `.env`. Anche in questo caso, se la lettera cambia, viene cercato da solo sugli altri dischi.

Quando copi questa cartella sopra una copia che esiste già, **non sovrascrivere la sua cartella `data`**: lì dentro c'è il catalogo.

Prima di staccare il disco usa `Ferma FrenkPlex.bat`.

## 1. Avviare

Doppio clic su **`Avvia FrenkPlex.bat`**.

**Va rilanciato ogni volta che riaccendi il PC o ricolleghi un disco esterno**: Docker da solo vede soltanto i dischi interni, quindi senza questo passaggio un disco USB risulta «non raggiungibile» (il catalogo non si perde, ma i video non partono).

Per spegnere: `Ferma FrenkPlex.bat`.

## 2. Creare le raccolte

Una raccolta è una sezione del tuo cinema: le dai il nome che vuoi (Film, Serie TV, Cartoni…) e le indichi una o più cartelle.

1. Nel menu a sinistra premi **Aggiungi raccolta** e scrivi il nome.
2. Scegli la cartella: sfogliando i dischi, oppure incollando il percorso copiato da Esplora risorse (es. `G:\Plex\Film`).
3. Per aggiungere altre cartelle, rinominare o eliminare: **Impostazioni → Le tue raccolte**.

Non devi dire se una raccolta contiene film o serie: viene capito da solo.
FrenkPlex legge soltanto: non modifica né cancella mai i tuoi file.

### Come vengono riconosciuti i file

| Cosa | Esempi che funzionano |
| --- | --- |
| Film | `Il Padrino (1972).mkv`, `Il.Padrino.1972.1080p.mkv`, `Il Padrino (1972)/qualsiasi-nome.mkv` |
| Episodi | `Breaking.Bad.S01E01.mkv`, `Breaking Bad 1x01.mkv`, qualsiasi file dentro `Stagione 1` / `Season 1` |
| Serie numerate | `Dragon Ball 001 Il mistero.avi`, `Naruto - 02.mkv` (almeno 3 file numerati nella stessa cartella) |
| Sottotitoli | stesso nome del video: `Il Padrino (1972).it.srt` |
| Locandina tua | `poster.jpg` nella cartella del film |
| Ignorati | cartelle `Extra`, `Trailer`, `Sample` e file che iniziano con `EXTRA -` o `Trailer -` |

L'anno nel nome aiuta molto a trovare il film giusto.

## 3. Locandine e schede automatiche

Serve una chiave gratuita di [themoviedb.org](https://www.themoviedb.org/) (account → Impostazioni → API), da incollare in **Impostazioni**. Da lì ogni titolo riceve locandina, sfondo, trama, anno, regista, cast, generi e voto.

In ogni raccolta puoi ordinare e filtrare per tipo, genere, anno, regia, attore e visto/da vedere. La ricerca guarda anche regista e attori.

### Saghe

I film della stessa serie cinematografica (Harry Potter, Il Signore degli Anelli, Ritorno al futuro…) vengono riuniti da soli nella voce **Saghe** del menu, appena in catalogo ce ne sono almeno due. Ogni saga ha la sua pagina con i film in ordine di uscita, il tasto per riprendere dal primo non visto e l'elenco di quelli che ti mancano. Le trovi anche nella Home, nella ricerca e nella scheda di ogni film che ne fa parte.

Non c'è niente da impostare: serve solo la chiave TMDB. Per i film già in catalogo le saghe compaiono dopo il primo aggiornamento (qualche minuto).

## 4. Azioni rapide sulle locandine

Su qualsiasi locandina (Home, raccolte, ricerca) si apre un menu con: riproduci, segna come visto, **correggi scheda**, **riscarica locandina e scheda**.

| Dove | Come si apre |
| --- | --- |
| PC | clic su **⋯** sulla locandina, oppure tasto destro |
| TV | tieni premuto **OK** sul telecomando |

## 5. Aggiornare il catalogo

Il server ricontrolla le cartelle da solo ogni 30 minuti. Per farlo subito:

- **⟳ Aggiorna** nella pagina di una raccolta (o in Impostazioni, accanto alla raccolta):
  - *Cerca file nuovi o tolti*: rilegge le cartelle;
  - *Riscarica locandine e schede (forzato)*: riscarica tutto da capo per quella raccolta.
- **Impostazioni → Catalogo**: gli stessi due comandi per tutto il catalogo.

## 6. Mettere l'app sulla TV

L'APK è in `apk/FrenkPlex.apk`. Tre modi:

- **Downloader** (il più semplice): sulla TV installa l'app «Downloader» dal Play Store e aprici `http://INDIRIZZO-DEL-PC:32500/FrenkPlex.apk`.
- **Chiavetta USB**: copia l'APK sulla chiavetta e aprilo dalla TV con un gestore file.
- **Dal PC**: `Installa su TV.bat` (richiede il «Debug di rete» attivo sulla TV).

La TV chiederà di consentire l'installazione da «origini sconosciute»: è normale per le app non prese dal Play Store.
Al primo avvio l'app cerca il server sulla rete di casa e si collega da sola; se non lo trova, scrivi l'indirizzo che compare nella finestra di `Avvia FrenkPlex.bat`.

### Aggiornare l'app sulla TV

Dopo la prima installazione non serve più rifare questi passaggi: l'app si aggiorna da sola.

1. Sul PC lanci `Compila APK.bat` (ogni compilazione è automaticamente «più nuova» della precedente).
2. All'avvio l'app sulla TV si collega al server, vede che sul PC c'è un APK più nuovo e mostra **«È disponibile un aggiornamento»**.
3. Scegli **Aggiorna ora**: l'APK viene scaricato dal PC e la TV apre la sua finestra di installazione, dove confermi.

La prima volta la TV chiede di consentire a FrenkPlex di «installare app sconosciute»: consentilo e premi **Riprova**.
Con **Più tardi** l'avviso torna al prossimo avvio; in ogni momento c'è **Impostazioni → Collegamento → Controlla aggiornamenti**.

Le app installate prima della versione 1.3 non sanno ancora aggiornarsi: vanno sostituite un'ultima volta a mano con uno dei tre modi qui sopra.

### Chromecast e Fire TV Stick

È la stessa app, con lo stesso APK:

- **Chromecast con Google TV / Google TV Streamer**: come sulla TV, con «Downloader» o una chiavetta. Prima attiva le opzioni sviluppatore (Impostazioni → Sistema → Informazioni → premi 7 volte su «Build Android TV») e consenti a Downloader di installare app sconosciute.
- **Fire TV Stick (Fire OS)**: installa «Downloader» dall'Appstore Amazon. In Impostazioni → La mia Fire TV → Opzioni sviluppatore attiva «Installa app sconosciute» per Downloader (se la voce non c'è: Informazioni → premi 7 volte sul nome del dispositivo). Poi apri `http://INDIRIZZO-DEL-PC:32500/FrenkPlex.apk`.
- **Non adatti**: i Chromecast vecchi senza telecomando (non installano app: lì si può solo trasmettere una scheda di Chrome dal PC) e i Fire TV Stick con Vega OS, come il 4K Select (non eseguono app Android).

Gli aggiornamenti arrivano come sulla TV: l'app li prende dal PC.

### Telecomando

| Tasto | Cosa fa |
| --- | --- |
| Frecce | si muovono tra le locandine; a sinistra del bordo si apre il menu |
| OK | apre · tenuto premuto: menu delle azioni |
| Durante il film: OK | pausa / riprendi e mostra i comandi |
| Durante il film: ◀ ▶ | indietro 10 s / avanti 30 s (premendo più volte i salti si sommano) |
| Durante il film: ▲ (o tasto Menu) | **Opzioni**: lingua audio, sottotitoli e loro dimensione, velocità, formato immagine, durata dei salti, episodio successivo, spegnimento automatico, audio compatibile |
| Indietro | torna indietro; nel film nasconde i comandi, poi esce salvando il punto |

Dal browser le stesse opzioni sono nel tasto **⚙ Opzioni** del player (tasto `O`). Altri tasti: `Spazio` pausa, `← →` salti, `↑ ↓` volume, `M` muto, `S` sottotitoli, `N` episodio successivo, `F` schermo intero, `0`–`9` salta a quel punto del video, `<` `>` velocità.

## Aggiornamenti (da GitHub)

FrenkPlex si aggiorna dal repository privato indicato in `strumenti/aggiornamenti.json`.

- **All'avvio**: `Avvia FrenkPlex.bat` controlla se c'è una versione nuova e chiede se installarla. Senza Internet parte comunque con quella che c'è.
- **Quando vuoi**: doppio clic su `Aggiorna FrenkPlex.bat`.

Arrivano sia il programma (server e script) sia l'app per la TV già compilata: la TV poi la prende dal PC come sempre. Non vengono mai toccati il catalogo (`data`), il file `.env`, la chiave di firma e l'APK compilato da te più di recente. Non serve installare git.

### Dare l'accesso a un PC

Il repository è privato, quindi ogni PC deve farsi riconoscere. Due modi, basta uno:

1. **Token sul disco** (vale per tutti i PC a cui colleghi il disco). Su github.com: Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token. Scegli *Only select repositories* → il repository di FrenkPlex, e in *Repository permissions* metti **Contents: Read-only**. Lancia `Aggiorna FrenkPlex.bat` e incolla il token quando lo chiede: resta in `strumenti/github-token.txt`, che non viene mai pubblicato. Il token permette solo di leggere quel repository; alla scadenza se ne crea uno nuovo allo stesso modo.
2. **Accesso del PC**: installa [GitHub CLI](https://cli.github.com) ed esegui una volta `gh auth login`. Sul disco non resta nessuna credenziale.

### Pubblicare una modifica (PC di sviluppo)

Serve solo sul PC dove modifichi FrenkPlex, con git e GitHub CLI:

1. se hai toccato l'app per la TV, `Compila APK.bat`;
2. `Pubblica aggiornamento.bat`: salva le modifiche, le manda su GitHub e, se l'APK è cambiato, lo allega alla release `app-tv`.

Su GitHub non finiscono mai catalogo, `.env`, chiave di firma e token (elenco in `.gitignore`). La chiave di firma (`android/keystore`) resta quindi solo sul disco: tienine una copia.

### Installare su un disco nuovo

Scarica il repository da GitHub (Code → Download ZIP), scompattalo e lancia `Aggiorna FrenkPlex.bat` (scarica anche l'app per la TV), poi `Avvia FrenkPlex.bat`.

## Se qualcosa non va

- **Sulla TV il video resta fermo dopo una pausa o un salto**: il player prova da solo a ripartire dallo stesso punto. Se capita spesso, attiva **Opzioni → Audio compatibile**.

- **Cartella «non raggiungibile»**: collega il disco e rilancia `Avvia FrenkPlex.bat`.
- **Su un altro PC un disco non si vede**: `Avvia FrenkPlex.bat` lo segnala alla fine. Scollega e ricollega il disco e rilancialo. Se Docker Desktop non usa WSL 2, aggiungi i dischi in Docker → Settings → Resources → File sharing.
- **La TV non trova il server**: PC e TV devono essere sulla stessa rete. Se dal browser del telefono `http://INDIRIZZO-DEL-PC:32500` non si apre, è il firewall di Windows: consenti Docker, oppure imposta la rete di casa come «Privata».
- **Titolo riconosciuto male**: menu della locandina → *Correggi scheda*.
- **Avviso di conversione**: l'app per la TV legge da sola qualsiasi audio (AC3, DTS, TrueHD…), quindi i film partono diretti, 4K HDR compresi, senza far lavorare il PC. La conversione scatta solo se la TV non sa decodificare il *video*: è l'unico caso pesante. Per i film HDR il PC corregge anche i colori, a 1080p se è potente e a 720p se è medio; su un PC con 4 processori o meno riduce a 720p senza correggerli.
- **Serie numerate di fila** (`Dragon Ball Z 001`…`291`): vengono divise da sole nelle stagioni di TMDB.
- **Indirizzo del PC che cambia**: nel router assegna al PC un indirizzo fisso.
- **Chi è sulla tua rete di casa** può aprire FrenkPlex senza password e, dalla scelta cartelle, vedere i nomi delle cartelle del PC. Non esporlo su Internet.

## Ricompilare l'app

`Compila APK.bat` ricrea l'APK dentro Docker (non serve installare Java o Android Studio).
La cartella `android/keystore` contiene la chiave con cui è firmata l'app: conservala, altrimenti per aggiornare dovrai prima disinstallare la versione sulla TV.
