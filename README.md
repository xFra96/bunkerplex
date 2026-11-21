# BunkerPlex

Il tuo cinema di casa: il computer tiene i video, la TV li guarda.

- **Server** sul computer (dentro Docker): cataloga film e serie, scarica locandine, trame e foto del cast, manda i video in streaming.
- **App per la TV**: Android TV, Google TV, Fire TV. Si usa col telecomando.
- **Dal browser** di qualsiasi PC, tablet o telefono di casa: `http://INDIRIZZO-DEL-COMPUTER:32500`.
- **Su un'altra rete** (telefono in giro, TV o tablet in un'altra casa), con l'app: se in casa non c'è un server BunkerPlex, l'app chiede se vuoi vedere i server condivisi dagli amici e i tuoi PC accesi. Entri con il tuo account e li vedi tutti, online e offline. Scegli di chi aprire le raccolte, sfogli e fai partire i video; da lì aggiungi anche amici nuovi. Non serve installare niente: l'app porta con sé Tailscale (vedi [Amici](#amici-condividere-le-raccolte-via-internet)). Da un browser fuori casa, invece, serve Tailscale sul dispositivo: `http://100.x.y.z:32500` del PC.

Funziona sempre, anche senza Internet e senza account: a casa, con il disco collegato, vedi tutto. Ogni account è una persona, con la sua collezione (visti, lista, raccolte).

Il login è facoltativo: un account porta la tua collezione su ogni PC e TV (impostazioni, chiavi, visti, lista, raccolte) e sblocca la condivisione con gli amici. La rete serve anche per scaricare le schede dei titoli e gli aggiornamenti, con o senza account.

## Installazione

Serve [Docker Desktop](https://www.docker.com/products/docker-desktop/) (gratuito). La prima volta ci vogliono Internet e qualche minuto.

Si installa con **un solo file**, uno per sistema operativo, e si lancia **una volta sola**. Da lì in poi BunkerPlex lo gestisce Docker: si accende con il computer, si riaccende da solo se si ferma, si aggiorna da solo, e segue i dischi che colleghi e stacchi.

```
BunkerPlex/
├─ Windows/   Installa BunkerPlex.bat
├─ macOS/     Installa BunkerPlex.command
└─ strumenti/ gli strumenti che l'installazione usa (non serve aprirli);
              in strumenti/sviluppo quelli per chi modifica BunkerPlex
```

### Windows

1. Scarica **[BunkerPlex.zip](https://github.com/xFra96/bunkerplex/releases/download/app-tv/BunkerPlex.zip)** (sempre l'ultima versione, con dentro anche l'app per la TV), poi scompatta la cartella dove vuoi (anche su un disco esterno, accanto ai video).
2. Apri la cartella **`Windows`** e fai doppio clic su **`Installa BunkerPlex.bat`**. Se Docker Desktop manca te lo propone (poi riavvia il PC, aprilo una volta e rilancia il file). Alla fine si apre il browser e la finestra mostra l'indirizzo da usare su TV e telefono.

L'installazione fa partire Docker Desktop a ogni accesso a Windows e lascia acceso un piccolo **aiutante** nascosto (`strumenti\Agente.ps1`, anche lui parte da solo all'accesso): collega a Docker in pochi secondi ogni disco che attacchi (anche USB) e completa gli aggiornamenti che toccano Docker.

### Mac

Serve macOS 13 o più recente (lo chiede Docker Desktop), va bene sia Apple Silicon (M1, M2…) sia Intel.

1. Installa [Docker Desktop](https://www.docker.com/products/docker-desktop/) scegliendo la versione giusta (**Apple Silicon** o **Intel**: menu Mela → *Informazioni su questo Mac* → *Chip*). Aprilo una volta, accetta le condizioni e aspetta che in basso dica *Engine running*.
2. Scarica **[BunkerPlex.zip](https://github.com/xFra96/bunkerplex/releases/download/app-tv/BunkerPlex.zip)**, poi scompatta la cartella dove vuoi.
3. Apri la cartella **`macOS`** e fai doppio clic su **`Installa BunkerPlex.command`**. Se chiede di lasciar controllare «System Events», consenti: serve a far partire Docker all'accesso. Se Docker chiede di accedere a una cartella (Download, Documenti, Scrivania, dischi esterni), consenti.

   La prima volta macOS lo blocca con «non è stato aperto» o «Apple non è in grado di verificare…», perché il file non è firmato da uno sviluppatore registrato da Apple. Premi **Fine** (non «Sposta nel Cestino»), poi una delle due:
   - **Impostazioni di Sistema → Privacy e sicurezza**: in fondo, accanto a «Installa BunkerPlex.command è stato bloccato», premi **Apri comunque** e scrivi la password del Mac. Rilancia il file e scegli di nuovo **Apri comunque**. Il pulsante compare solo per circa un'ora dopo il tentativo: se non c'è, fai di nuovo doppio clic sul file e torna lì.
   - **Terminale**: scrivi `xattr -dr com.apple.quarantine ` (con lo spazio finale), trascina nella finestra la cartella **BunkerPlex** e premi Invio. Sblocca tutta la cartella in un colpo; poi doppio clic sul file come al solito.

   Sui macOS più vecchi di Sequoia (15) basta anche clic destro sul file → **Apri** → **Apri**.
4. Si apre il browser; la finestra mostra l'indirizzo da usare su TV e telefono.

**Se ancora non parte** (anche «non hai i permessi necessari»): apri il **Terminale** (Applicazioni → Utility), scrivi `bash ` (con lo spazio dopo), trascina dentro la finestra il file `Installa BunkerPlex.command` e premi INVIO. Così parte sempre, senza passare dai controlli del Finder; dalla volta dopo funziona anche il doppio clic.

Se un disco esterno non compare nella scelta delle cartelle: Docker Desktop → Settings → Resources → File sharing, aggiungi `/Volumes` e rilancia il file; e in Impostazioni di Sistema → Privacy e sicurezza → *Accesso completo al disco* attiva Docker. Sul Mac gli aggiornamenti che toccano Docker (rari) chiedono di rilanciare «Installa».

Va bene anche **Code → Download ZIP** o lo zip «Source code» della release: BunkerPlex si porta da solo all'ultima versione e scarica l'app per la TV.

### Dopo l'installazione

- **Non c'è niente da lanciare**: BunkerPlex parte con Docker Desktop, che parte con il computer.
- **Dischi**: tutti i dischi del computer sono collegati, anche quelli esterni e quelli che colleghi dopo; quando ne stacchi uno le sue raccolte risultano «non raggiungibili» e tornano da sole quando lo ricolleghi. Se un disco torna con un'altra lettera (o su un altro computer, anche Mac ↔ Windows) le cartelle con lo stesso percorso vengono ritrovate da sole.
- **Spegnere**: Docker Desktop → *Containers* → `bunkerplex` → *Stop* (e *Start* per riaccenderlo). Chiudere Docker Desktop spegne anche BunkerPlex.
- **Qualcosa non torna**: rilancia «Installa BunkerPlex»: rimette a posto quello che manca, senza toccare catalogo e impostazioni.

Se arrivi da una versione precedente: «Avvia», «Ferma» e «Aggiorna» non ci sono più, al loro posto c'è solo «Installa BunkerPlex». Lancialo una volta.

L'app per la TV è nuova (versione 2.0, il nome interno è cambiato con BunkerPlex): quella di prima non può aggiornarsi da sola alla nuova. Te lo ricorda lei stessa: installa la nuova con «Downloader» da `http://INDIRIZZO-DEL-COMPUTER:32500/BunkerPlex.apk`, poi disinstalla la vecchia dalle impostazioni della TV. Il server della TV va reimpostato una volta (lo trova da solo).

## Primi passi

1. **Apri BunkerPlex**: al primo avvio si entra da soli, senza password e senza Internet. Quando entri con un account, quello che hai fatto fin lì passa a lui (vedi [Account](#account)).
2. **Crea una raccolta**: nel menu a sinistra **Aggiungi raccolta**, dai un nome (Film, Serie TV, Cartoni…) e scegli la cartella dei video. Film e serie vengono riconosciuti da soli. BunkerPlex legge soltanto: non modifica né cancella mai i tuoi file.
3. **Attiva locandine e schede**: crea un account gratuito su [themoviedb.org](https://www.themoviedb.org/), copia la chiave da *Impostazioni → API* e incollala in **Impostazioni** di BunkerPlex. Resta su questo PC; se entri con un account, anche sugli altri PC non va rimessa.
4. **Metti l'app sulla TV**: il modo più semplice è dal PC. Sulla TV accendi una volta il debug (*Impostazioni → Sistema → Info*, premi 7 volte su *Build*, poi *Opzioni sviluppatore → Debug USB*; su Fire TV *Debug ADB*), poi nel browser del PC apri *Impostazioni → App per TV e telefono → Installa sulla TV dal PC* e premi **Cerca le TV**: BunkerPlex trova le TV di casa, sulla TV premi «Consenti» (con «Consenti sempre») e poi **Installa l'app**. L'app si apre da sola e trova il server. In alternativa, sulla TV installa l'app «Downloader» e aprici `http://INDIRIZZO-DEL-COMPUTER:32500/BunkerPlex.apk` (l'indirizzo giusto è nella stessa pagina, con un QR da inquadrare col telefono per scaricarla lì). Poi l'app si aggiorna da sé.
5. **Se vuoi, entra con un account** (*Impostazioni → Account*): è facoltativo, vedi sotto.

Nomi dei file che funzionano meglio:

| Cosa | Esempi |
| --- | --- |
| Film | `Il Padrino (1972).mkv`, `Il.Padrino.1972.1080p.mkv` |
| Episodi | `Breaking.Bad.S01E01.mkv`, `Breaking Bad 1x01.mkv`, file dentro `Stagione 1` |
| Sottotitoli | stesso nome del video: `Il Padrino (1972).it.srt` |
| Locandina tua | `poster.jpg` nella cartella del film |

## Account

Niente profili: **ogni account è una persona** e ha la sua collezione: visti, punti di ripresa, «La mia lista», raccolte, chiavi API e preferenze di visione.

- **Senza account** si usa BunkerPlex lo stesso: c'è un solo utente, quello del PC, e si entra da soli. Funziona sempre, con o senza Internet.
- **Il primo account che entra** su un PC prende tutto quello che c'era (visti, lista, raccolte, chiavi): non si perde niente.
- **Più account sullo stesso PC**: ognuno entra con il suo; all'apertura «Chi guarda?» mostra gli account già entrati su quel PC. Da *Impostazioni → Account* si cambia account o si toglie il proprio da quel PC (l'account resta online; le sue raccolte di lì passano a un altro account, i video non si toccano).
- **Raccolte condivise**: con più account sullo stesso PC una raccolta si può condividere con gli altri (*Impostazioni → Raccolte → Condividi*). Ognuno conserva i suoi visti.
- **Arrivando dalla versione con i profili**: i profili senza account si uniscono da soli all'account principale del PC (l'amministratore, o il primo entrato), voce per voce, senza perdere visti, lista e raccolte. Se sul PC non c'era nessun account, si uniscono al primo profilo. Gli account restano com'erano, ognuno con la sua collezione.

### Entrare con un account (facoltativo)

*Impostazioni → Account → Entra con un account*, oppure da «Chi guarda?». La prima volta su un PC, quello che c'era già (senza account) si unisce all'account, voce per voce, e vince la modifica più recente. Con l'account:

- **Ti segue ovunque**: impostazioni, chiavi (TMDB, OpenSubtitles), preferenze di visione, visti, punti di ripresa e lista li ritrovi su ogni PC e TV dove entri, anche su un'installazione nuova, e riprendi esattamente da dove eri.
- **Raccolte su ogni PC**: nomi e cartelle delle tue raccolte seguono l'account. Su un altro PC le raccolte compaiono già create; le cartelle che lì esistono con lo stesso percorso (anche su un disco con un'altra lettera) si collegano da sole, e una raccolta di quel PC con le stesse cartelle diventa la stessa (niente doppioni). Le altre restano «su un altro PC»: in *Impostazioni → Raccolte* scegli dove stanno su quel PC, oppure le togli dall'account. Se l'elenco online non ti torna, *Sovrascrivi l'account con le raccolte di questo PC* (chiede conferma) lo rimette uguale a quello del PC dove sei.
- **Le tue raccolte da ogni tuo PC**: ogni PC dove sei entrato con l'account vede le raccolte degli altri tuoi PC accesi, compaiono nel menu sotto «Tuo PC · nome». Se sei nella stessa casa passa dalla rete di casa (più veloce, anche senza Internet), altrimenti da Tailscale, cifrato; non serve condividere con gli amici. Una raccolta che c'è anche sul PC dove sei, con le cartelle collegate, si guarda da lì. Lo stato è in *Impostazioni → Amici e dispositivi → I tuoi PC*, dove si può anche spegnere. I visti dei titoli presi da un altro PC per ora restano su questo PC.
- **Amici**: gli amici sono quelli dell'account (si aggiungono col nome del loro account) e vedono solo le tue raccolte: vedi [Amici](#amici-condividere-le-raccolte-via-internet).
- **Senza Internet** (o con il servizio account fermo) non cambia niente: si continua come prima, e in basso compare «Offline · si sincronizza quando torna la rete». Le modifiche fatte intanto partono da sole appena il servizio risponde e si uniscono a quelle fatte sugli altri PC: per ogni titolo e ogni impostazione vince la modifica più recente. Non c'è niente da scegliere.
- **Chiavi API diverse**: al primo accesso, se le chiavi o le preferenze di visione di questo PC sono diverse da quelle dell'account, BunkerPlex mostra le differenze e chiede quali tenere. Se l'account non le ha ancora, prende quelle di qui senza chiedere. Volume e audio muto restano di ogni dispositivo.
- **Password dalla TV**: in «Chi guarda?» (o *Impostazioni → Account*) scegli **Entra con un account dal telefono**. La TV mostra un QR e un codice: inquadralo col telefono di casa, scrivi lì nome e password e la TV entra da sola. Se l'account ha una password provvisoria, il telefono chiede subito quella nuova. Serve solo per gli account che su quel PC non ci sono ancora: quelli già entrati dal PC si scelgono in «Chi guarda?».
- **Senza password in «Chi guarda?»**: un account già entrato su quel PC si apre scegliendo il nome; si può spegnere per il proprio account (*Impostazioni → Account → Accesso*), e allora serve la password.

### Gli account

- **Primo account**: sul PC dove è stato preparato il servizio, *Impostazioni → Account* propone «Crea l'account amministratore». Quello è il tuo.
- **Altri account**: *Impostazioni → Persone*. Scegli il nome; BunkerPlex propone una password provvisoria da comunicare. Al primo accesso va cambiata (finché non lo fai funziona tutto, ma non si sincronizza). «Nuova password provvisoria» scollega l'account da tutti i PC.
- **Cambio password**: *Impostazioni → Account → Cambia password*. Sugli altri PC l'account continua a funzionare; per riprendere la sincronizzazione chiede la password nuova.
- **Password dimenticata**: l'amministratore dà una *Nuova password provvisoria* da *Impostazioni → Persone*.
- **Senza Internet** si può aprire un account anche scrivendo l'ultima password usata su quel PC.

Gli account stanno in un piccolo servizio gratuito su Cloudflare (vedi [Servizio account](#servizio-account) più sotto). Le password non lasciano mai il PC: al servizio arriva solo un'impronta.

## Cosa puoi fare

- **Home**: continua a guardare, prossimi episodi, ultimi arrivi per raccolta.
- **In alto a destra**: quando il server legge le cartelle o scarica le schede compare l'avanzamento («Lettura dei titoli 38%»); il resto del tempo una campanella con le notifiche (aggiornamento disponibile, richieste degli amici, cartelle non raggiungibili, account offline). Ogni notifica porta all'impostazione che la risolve.
- **Impostazioni**: una panoramica con lo stato di ogni area e, in fondo, l'IP privato del PC (per TV e telefoni di casa) e quello pubblico (per gli amici). Il tuo account è anche in basso nel menu laterale.
- **La mia lista**: i titoli da tenere da parte, uguale su TV, telefono e PC.
- **Collezioni**: i film della stessa serie riuniti da soli, in ordine di uscita.
- **Cerca** per titolo, regista, attore, genere o anno; oppure sfoglia per genere senza scrivere.
- **Nelle raccolte**: filtri, ordinamento, **Vai alla lettera** e **Scegli tu** (un titolo a caso tra i non visti).
- **Cast con le foto** nella scheda: premi su un volto per vedere gli altri suoi titoli.
- **Menu della locandina** (clic su ⋯ o tasto destro; sulla TV tieni premuto OK): riproduci, segna come visto, aggiungi alla lista, correggi scheda.
- **Impostazioni → Questo dispositivo**: preferenze di visione (animazioni, che si riducono da sole sui dispositivi lenti, e locandine grandi), aspetto da TV per il browser di una smart TV, collegamento al server.
- **Impostazioni → App per TV e telefono**: installa l'app sulla TV dal PC, QR per scaricarla sul telefono Android, «Installa l'app» per metterla sulla schermata Home dal browser del telefono. Animazioni, locandine e regolazioni del player seguono il tuo account; aspetto da TV, riconoscimento dei dispositivi lenti e volume restano di ogni dispositivo.

### Telecomando

| Tasto | Cosa fa |
| --- | --- |
| Frecce | si muovono tra le locandine; a sinistra del bordo si apre il menu |
| OK | apre · tenuto premuto: menu delle azioni |
| Nel film: OK | pausa / riprendi (e mostra i comandi) |
| Nel film: ◀ ▶ | indietro 10 s / avanti 30 s; tenuti premuti scorrono il video, sempre più veloce |
| Nel film: ▲ ▼ | mostrano i comandi: la barra del video e sotto i bottoni (Audio e sottotitoli, Velocità, Prossimo episodio, Ricomincia, Altre opzioni). ▼ scende ai bottoni, ▲ torna alla barra |
| Nel film: Menu / Info | opzioni, se il telecomando ha il tasto |
| Indietro | torna indietro; nel film nasconde i comandi, poi esce salvando il punto; nella Home chiede se uscire dall'app |

Negli episodi delle serie compare **Salta intro** durante la sigla iniziale e, appena partono i titoli di coda, la scheda **Prossimo episodio** (parte da sola dopo 10 secondi, oppure **Guarda i titoli di coda**): basta OK. Le sigle le trova il server da solo, dai capitoli del file o confrontando l'audio degli episodi della stessa stagione; lo fa in sottofondo quando nessuno guarda, e subito per l'episodio che fai partire. Se in una serie i titoli di coda cambiano ogni volta, la scheda compare alla fine dell'episodio.

Dal browser: `Spazio` pausa, `← →` salti, `↓` comandi (poi `← →` per scegliere un bottone), `M` muto, `S` sottotitoli, `N` episodio successivo, `F` schermo intero, `O` opzioni.

### Schede sempre aggiornate

Le schede (trama, locandina, cast, voti, episodi) non si scaricano una volta per sempre: il server le ricontrolla da solo, poche alla volta (al massimo 40 ogni mezz'ora) e mai mentre qualcuno guarda.

| Cosa | Quando si ricontrolla |
| --- | --- |
| Titoli cambiati su TMDB | una volta al giorno il server legge l'elenco delle novità di TMDB; un titolo cambiato si aggiorna al massimo una volta a settimana |
| Serie in corso | il giorno dopo l'uscita di ogni episodio, altrimenti ogni settimana |
| Usciti da meno di 6 mesi | ogni settimana |
| Usciti da meno di 2 anni | ogni mese |
| Più vecchi, serie finite | ogni 6 mesi |
| Titoli non riconosciuti, episodi che TMDB non ha ancora | si riprova dopo 1, 3 e 7 giorni, poi ogni mese |

Le correzioni fatte con *Correggi scheda* restano (l'aggiornamento riusa la stessa scheda), le locandine tue (`poster.jpg`) non vengono toccate e un'immagine si riscarica solo se su TMDB è cambiata. Senza Internet resta tutto com'è. Se cambi la lingua delle schede (`TMDB_LANG`) si riscaricano tutte, un po' alla volta. Come procede: *Impostazioni → Catalogo e schede → Aggiornamento automatico*. **Riscarica tutte le schede** le rifà subito tutte.

### Sottotitoli da internet

Nel film: Opzioni → **Cerca sottotitoli su internet** → scegli la lingua e poi il sottotitolo (quelli con «✓ fatti per questo file» vanno a tempo di sicuro). Li prende il PC da **OpenSubtitles.com** e li salva in `data/subs`, quindi poi ci sono su tutti i dispositivi. Per attivarli serve una chiave gratuita: crea un account su opensubtitles.com, Profilo → «API consumers» → nuova chiave, e incollala in Impostazioni → *Sottotitoli da internet*. Nome utente e password dell'account sono facoltativi ma alzano il limite di download giornaliero. Restano nel tuo account BunkerPlex: li ritrovi su ogni PC dove entri.

### TV e chiavette adatte

Android TV, Google TV, Chromecast con Google TV, Fire TV Stick (Fire OS). Su Chromecast e Fire TV attiva prima le opzioni sviluppatore e consenti a «Downloader» di installare app sconosciute. Non adatti: Chromecast vecchi senza telecomando e Fire TV con Vega OS.

## Amici: condividere le raccolte via Internet

Due BunkerPlex in case diverse possono mostrarsi a vicenda le raccolte. **Si guarda soltanto**: nessuno tocca impostazioni, file o «visto» dell'altro. Tutto il resto continua a funzionare offline.

### Con l'account (consigliato)

Se sei entrato con un account, gli amici sono quelli dell'account: niente indirizzi né password da scambiarsi.

1. In *Impostazioni → Amici e dispositivi → I tuoi amici* scrivi il nome dell'account BunkerPlex dell'amico e premi **Manda la richiesta**.
2. L'amico la trova nella campanella e in *Impostazioni → Amici e dispositivi*, su qualsiasi suo PC (anche dalla TV), e preme **Accetta**.
3. Chi vuole far vedere le sue raccolte accende **Condividi le tue raccolte con i tuoi amici**. Basta che lo faccia uno dei due: l'altro vede le sue raccolte senza accendere niente.

Non c'è altro da installare né da configurare: niente porte sul router, niente firewall. BunkerPlex porta con sé **Tailscale**: quando serve (il PC condivide, oppure ha amici dell'account) lo scarica da solo dal sito ufficiale, lo accende dentro Docker ed entra nella rete di BunkerPlex con una chiave che gli dà il servizio account. Il collegamento parte dal PC verso l'esterno, quindi funziona anche dietro il firewall di Windows, con due router in fila o con un operatore che non dà un indirizzo pubblico. Se il servizio account non ha Tailscale configurato (vedi [Servizio account](#servizio-account)), BunkerPlex prova come prima ad aprire da solo la porta `32501` sul router. Lo stato è in *Impostazioni → Amici e dispositivi*.

Da lì le raccolte dell'amico compaiono da sole nel menu e nella Home, di ogni suo PC che condivide (se sono più di uno, col nome che gli ha dato). Se cambia l'indirizzo di casa non devi fare niente: il servizio account fa da rubrica. L'amico vede **solo le tue raccolte**, non quelle degli altri account del PC, e solo quando lo hai tra gli amici: se lo togli, sparisce da entrambe le parti. Ogni volta che il suo server entra dal tuo usa un «biglietto» del servizio account, valido pochi minuti e una volta sola; l'impronta del certificato del tuo server arriva dal servizio, quindi anche il primo collegamento è sicuro.

### Con indirizzo e password (senza servizio account)

Il sistema di prima, che compare in *Impostazioni → Amici e dispositivi* solo se BunkerPlex non ha un servizio account. Con il servizio account restano visibili soltanto i vecchi collegamenti già fatti, per sospenderli o toglierli. Qui la condivisione è del PC: l'amico vede tutte le raccolte di quel PC, e le sue le vedono tutti gli account del PC.

1. Entrambi accendete **Impostazioni → Amici e dispositivi → Porta per gli amici su questo PC**. BunkerPlex chiede da solo al router di casa di aprire la porta per gli amici (la `32501`, e solo quella) e ti mostra **il tuo indirizzo**: è quello da dare all'amico.
2. Uno dei due apre **Manda una richiesta** (dal browser di un computer, non dalla TV) e scrive l'indirizzo dell'amico, un nome e una password a scelta.
3. L'amico preme **Accetta** in *Impostazioni → Amici e dispositivi*.

Se nel router UPnP (o NAT-PMP) è spento, o l'operatore non dà un indirizzo pubblico, installate [Tailscale](https://tailscale.com) su entrambi i computer, condividete il computer dal sito di Tailscale (*Machines → Share*), spegnete **Apri da solo la porta sul router** e nella richiesta scrivete gli indirizzi `100.…`. Un Tailscale installato sul PC BunkerPlex lo trova anche da solo, e allora agli amici dà quell'indirizzo e non apre porte sul router.

Dentro Docker BunkerPlex non vede la rete di casa: per trovare il router gli serve che l'app sia stata aperta almeno una volta da un altro dispositivo di casa (la TV o il telefono). Quando l'amico è spento le sue raccolte restano sfogliabili ma i video non partono. I video arrivano convertiti a 720p (si cambia in *Impostazioni → Amici e dispositivi → Video degli amici*), perché viaggiano sulla linea in caricamento di chi condivide.

**Sicurezza**

- La porta **32500** è pensata per la rete di casa (le TV entrano scegliendo il nome): non farla mai raggiungere da fuori casa (tranne che da Tailscale con il tuo account: lì ci sono solo i tuoi dispositivi). Agli amici serve solo la **32501**, che risponde soltanto agli amici approvati.
- Con il Tailscale dentro BunkerPlex ogni PC entra nella rete di BunkerPlex con l'etichetta `tag:bunkerplex` e le regole della rete lasciano passare solo la `32501` tra un BunkerPlex e l'altro: nessuno vede il resto del tuo computer, che anzi non si accorge di niente (Tailscale gira dentro Docker). In più il server rifiuta chi prova la 32500 passando da lì. Sopra Tailscale la 32501 resta in HTTPS con l'impronta del certificato, che arriva dal servizio account.
- L'app su telefono, tablet o TV, quando non c'è un server in casa, entra nella stessa rete come dispositivo **temporaneo** (`bunkerplex-tel-…`, con la stessa etichetta): parla solo con la `32501` dei PC, controlla l'impronta del certificato e sparisce da *Machines* poco dopo che chiudi l'app. Per i dispositivi temporanei serve il `cloud/worker.js` di questa versione; con quello vecchio l'app funziona lo stesso, ma i telefoni restano in *Machines*.
- Con un Tailscale installato a mano sul computer l'amico raggiunge il tuo computer su tutte le porte: condividi solo con chi ti fidi, oppure limita l'accesso alla `32501` nelle *Access controls* di Tailscale.
- La porta 32501 è **cifrata** (HTTPS) con un certificato creato dal tuo server: l'amico ne ricorda l'impronta alla prima richiesta e da lì in poi accetta solo quello. Il punto debole è quel primo collegamento: per sicurezza piena, la prima richiesta fatela sapendo che l'indirizzo è davvero quello dell'amico.
- Con la porta aperta sul router, la 32501 è visibile da Internet: risponde solo alla registrazione (che resta ferma finché non la approvi) e agli amici approvati. Dopo 5 password sbagliate l'accesso si blocca per un po'.
- Non inoltrare mai a mano altre porte, e mai la 32500.

## Aggiornamenti

BunkerPlex si aggiorna da questo repository, senza account né password.

- **Da solo**: il server controlla ogni 12 ore e installa quando nessuno sta guardando. Anche «Installa» installa da solo le novità che trova. Si può spegnere in *Impostazioni → Aggiornamenti*.
- **Da qualsiasi dispositivo** (TV, telefono, browser di un altro PC): compare l'avviso, scegli **Aggiorna ora**, oppure *Impostazioni → Aggiornamenti*.
- **Dal PC del server**: **Aggiorna ora** da `http://localhost:32500`.
- **Dopo un aggiornamento** ogni TV, telefono e browser mostra una volta l'avviso «BunkerPlex è stato aggiornato»; nella campanella in alto, per una settimana, c'è la notifica che porta all'elenco delle novità (anche da *Impostazioni → Aggiornamenti*).

Ogni aggiornamento riallinea anche Docker: se sono cambiati codice, `Dockerfile`, pacchetti (`requirements.txt`) o `docker-compose.yml`, l'immagine viene ricostruita (scaricando anche la versione più recente dell'immagine di base) e il server si riaccende da solo. Lo stesso succede se il server sta girando con file più vecchi di quelli nella cartella, per esempio dopo un `git pull` fatto a mano.

Su Windows il lavoro sul PC lo fa un **aiutante** nascosto (`strumenti\Agente.ps1`): lo accende «Installa» e riparte da solo a ogni accesso a Windows (collegamento *BunkerPlex aggiornamenti* nella cartella Esecuzione automatica). È lui che permette alla TV di aggiornare tutto, compresa la copia di sviluppo con git. Com'è andato l'ultimo aggiornamento: `strumenti\aggiornamento.log`. Se l'aiutante è spento il server si aggiorna lo stesso, ma per le novità che toccano Docker chiede di rilanciare «Installa».

Non vengono mai toccati il catalogo (cartella `data`), il file `.env` e la chiave di firma dell'app. Se copi la cartella sopra una copia esistente, **non sovrascrivere `data`**.

Per usare lo stesso catalogo su più computer tieni tutta la cartella di BunkerPlex sul disco esterno insieme ai video: su ogni computer basta lanciare «Installa» una volta. Anche con installazioni separate, impostazioni, chiavi, visti e lista ti seguono comunque grazie all'account; restano diverse solo le raccolte.

## Se qualcosa non va

- **Cartella «non raggiungibile»**: collega il disco; torna da sola in pochi secondi. Se non succede, rilancia «Installa».
- **Docker Desktop non parte** con *«The file cannot be accessed by the system»* su un file `.sock`: lancia «Installa», che a Docker spento toglie da solo quei file rimasti bloccati.
- **La TV non trova il server** (o Downloader resta su *Connecting…*): computer e TV devono essere sulla stessa rete. Il firewall lo sistema «Installa»: su Windows apre le porte `32500` (solo dalla rete di casa) e `32501` chiedendo una volta il consenso di Windows, e spegne le regole che bloccano Docker rimaste da un «Annulla» di Windows; su Mac, se il firewall è acceso, consente le connessioni in entrata a Docker chiedendo la password del Mac. Se hai risposto no, rilancia «Installa». Su Mac con *Blocca tutte le connessioni in entrata* attivo non c'è modo di entrare: va tolto da *Impostazioni di Sistema → Rete → Firewall → Opzioni*. Su Linux Docker apre da sé le porte pubblicate, anche con `ufw`.
- **Fuori casa il telefono non arriva al PC**: Tailscale dev'essere acceso sul telefono, con lo stesso account del PC. Su Windows «Installa» apre la `32500` anche ai tuoi dispositivi su Tailscale (`100.64.0.0/10`, non a Internet): se l'hai installato prima di questa versione, rilancia «Installa».
- **Titolo riconosciuto male**: menu della locandina → *Correggi scheda*.
- **Il video si ferma dopo una pausa**: nelle opzioni del player attiva *Audio compatibile*.
- **L'indirizzo del computer cambia**: nel router assegnagli un indirizzo fisso.
- **Chi è sulla tua rete di casa** può entrare in un account già entrato sul PC scegliendo il nome (si può chiedere la password: *Impostazioni → Account*): non esporre BunkerPlex su Internet.
- **«Nome utente o password sbagliati»** dopo un cambio di password fatto su un altro PC: usa la password nuova. Dopo 5 tentativi sbagliati l'account si blocca per 5 minuti.
- **«Offline · si sincronizza quando torna la rete»**: il PC non raggiunge il servizio account. Non serve fare niente: si continua come prima e, quando la rete torna, BunkerPlex se ne accorge entro un minuto e sincronizza da solo.
- **Sulla TV il punto di ripresa non si salva**: aggiorna l'app della TV quando lo propone (serve la versione 1.4 o successiva).

## Per chi lo modifica

- `strumenti\sviluppo\Compila APK.bat` ricrea l'app per la TV dentro Docker (niente Java o Android Studio). L'APK finisce in `apk/BunkerPlex.apk`.
- `strumenti\sviluppo\Pubblica aggiornamento.bat` manda le modifiche su GitHub (serve git, e la cartella deve essere una copia del repository con `.git`; una cartella scaricata come zip non lo è).
- **Release compilata da GitHub**: a ogni push su `main` l'Action *Pubblica la release* (`.github/workflows/apk.yml`) crea una versione nuova, con tag `vAAAA.MM.GG` (`.2`, `.3`... se ce n'è più d'una nello stesso giorno), che resta nella pagina *Releases* come storico, con le novità divise per parte del programma; poi ricrea la release `app-tv` sull'ultima versione (il tag fisso da cui leggono server e TV). Entrambe allegano `BunkerPlex.zip` (programma + APK + `strumenti/versione.json`) e, se da `apk-build` è cambiato qualcosa in `android/`, ricompila e allega `BunkerPlex.apk`. Da lì i server scaricano gli aggiornamenti e le TV li propongono da sole. Si può lanciare anche a mano: *Actions → Pubblica la release → Run workflow* (ricompila sempre l'APK). Va preparata una volta: su GitHub, *Settings → Secrets and variables → Actions → New repository secret*, nome `ANDROID_KEYSTORE_B64`, valore il contenuto di `android/keystore/SEGRETO-per-GitHub.txt` (è la chiave di firma in base64). Se manca, lo zip si pubblica lo stesso con l'APK di prima e il giro finisce in errore: mai una firma diversa, che le TV rifiuterebbero. Per rifare quel file: `base64 -w0 android/keystore/bunkerplex.jks`.
- `strumenti\sviluppo\Installa su TV.bat` installa l'APK via adb. Lo stesso lo fa il server da *Impostazioni → App per TV e telefono → Installa sulla TV dal PC* (`server/tvinstall.py`): cerca nella rete del PC le TV con la porta 5555 aperta, si collega con l'adb del contenitore (chiavi in `data/adb`, così la TV chiede il permesso una volta sola), installa `apk/BunkerPlex.apk` e apre l'app. Supporta anche il *Debug wireless* con codice di associazione.
- La cartella `android/keystore` contiene la chiave di firma dell'app: non finisce su GitHub, tienine una copia.
- Frequenza del controllo aggiornamenti: `UPDATE_CHECK_HOURS` tra le voci `environment` di `docker-compose.yml`.
- Se il repository diventa privato serve un token di sola lettura (*Contents: Read-only*) da incollare in *Impostazioni → Aggiornamenti*.

### Servizio account

Gli account stanno in un Worker di Cloudflare con un database D1, nel piano gratuito (niente carta di credito, non va in pausa). Il codice è nella cartella `cloud/`:

- `cloud/worker.js`: il servizio (login, cambio password, gestione account, impostazioni, visti e lista, amici).
- `cloud/schema.sql`: le tabelle del database D1 `bunkerplex`.

Sul Cloudflare dell'amministratore è pubblicato come `bunkerplex-account` all'indirizzo scritto in `server/cloud.json`. Quel file arriva a tutte le installazioni con gli aggiornamenti. Senza quel file (e senza la voce `BUNKERPLEX_CLOUD` in `.env`) BunkerPlex funziona come prima, senza login.

- **Cambiare il servizio**: Cloudflare → *Workers & Pages → bunkerplex-account → Edit code*, incolla `cloud/worker.js` e salva. Se cambi le tabelle, esegui lo stesso SQL in *Storage & databases → D1 → bunkerplex → Console*.
- **I tuoi PC** (le raccolte da un altro PC dello stesso account) richiedono il `cloud/worker.js` di questa versione: le colonne nuove della tabella `servers` (`lan`, `friends`) il Worker le aggiunge da solo.
- **Amici dell'account**: richiedono il servizio aggiornato (`cloud/worker.js` di questa versione e le tabelle `friends`, `servers`, `tickets` di `cloud/schema.sql`). Finché non lo è, *Impostazioni → Amici e dispositivi* lo dice e resta solo il collegamento con indirizzo e password.
- **Tailscale per gli amici** (facoltativo, una volta sola): serve un account [Tailscale](https://tailscale.com) gratuito, meglio uno dedicato a BunkerPlex (il piano gratuito arriva a 100 dispositivi).
  1. *Access controls*: incolla queste regole (tolgono anche la regola «tutti vedono tutto» di partenza):
     ```json
     {
       "tagOwners": { "tag:bunkerplex": ["autogroup:admin"] },
       "grants": [ { "src": ["tag:bunkerplex"], "dst": ["tag:bunkerplex"], "ip": ["tcp:32501"] } ]
     }
     ```
  2. *Settings → OAuth clients → Generate OAuth client*: permesso **Auth Keys → Write**, etichetta `tag:bunkerplex`.
  3. Nel Worker `bunkerplex-account` (*Settings → Variables and Secrets*) aggiungi i segreti `TS_OAUTH_ID` e `TS_OAUTH_SECRET` con i due valori del client.

  Da lì ogni BunkerPlex con un account entra da solo nella rete quando serve: il servizio gli dà una chiave che vale una volta e 10 minuti, il segreto resta nel Worker. I PC compaiono in *Machines* come `bunkerplex-…`: quelli che non usi più si tolgono da lì. Se lo togli a un PC che c'è ancora, rientra da solo.
- **Primo amministratore**: il Worker ha il segreto `SETUP_KEY`. La stessa chiave sta in `data/cloud-setup.json` del PC dove è stato preparato il servizio: solo lì compare «Crea l'account amministratore», e solo finché nel database non c'è nessun account. Dopo la creazione il file viene cancellato.
- **Un servizio tuo** (per esempio per provare): crea un altro Worker e un altro database con gli stessi file, poi scrivi il suo indirizzo in `.env` alla voce `BUNKERPLEX_CLOUD`.
- **Password**: il PC calcola un'impronta lenta (PBKDF2-SHA256, 200.000 giri) e al servizio manda solo quella; il servizio ne conserva un'altra impronta con un sale casuale.
- **Chiavi API**: sono salvate nel database del servizio, protette dalla cifratura di Cloudflare ma non cifrate con la password dell'account.
- **Limiti del piano gratuito**: 100.000 righe scritte e 5 milioni lette al giorno, database fino a 500 MB, 10 ms di calcolo per richiesta. Per una famiglia sono molto più del necessario.
