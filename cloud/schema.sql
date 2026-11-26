-- Database degli account di BunkerPlex (Cloudflare D1).
-- Si esegue una volta dalla console di D1 (o con: wrangler d1 execute bunkerplex --remote --file schema.sql).

CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE COLLATE NOCASE NOT NULL,
  salt TEXT NOT NULL,
  hash TEXT NOT NULL,
  must_change INTEGER NOT NULL DEFAULT 1,
  admin INTEGER NOT NULL DEFAULT 0,
  created REAL NOT NULL,
  fails INTEGER NOT NULL DEFAULT 0,
  locked_until REAL NOT NULL DEFAULT 0,
  google_sub TEXT,                   -- account Google collegato («Entra con Google»)
  google_email TEXT,                 -- la sua email (o quella indicata dall'amministratore)
  no_password INTEGER NOT NULL DEFAULT 0, -- 1 = entra solo con Google
  email TEXT,                        -- per entrare con email e password (al posto del nome utente)
  disabled INTEGER NOT NULL DEFAULT 0 -- 1 = disattivato dall'amministratore: non entra da nessuna parte
);
CREATE UNIQUE INDEX IF NOT EXISTS users_google ON users(google_sub);

-- Un gettone per ogni server BunkerPlex o app collegati all'account (si salva solo l'impronta).
-- device: nome del dispositivo (il server usa il suo nome, l'app «Telefono ...»).
CREATE TABLE IF NOT EXISTS sessions(
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  device TEXT,
  created REAL NOT NULL,
  last_seen REAL NOT NULL,           -- dopo 180 giorni senza usarla scade
  kind TEXT                          -- server / pwa / tv / app / browser (NULL = di prima)
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

-- Impostazioni dell'account: un valore per chiave, vince il piu' recente.
CREATE TABLE IF NOT EXISTS settings(
  user_id INTEGER NOT NULL,
  k TEXT NOT NULL,
  v TEXT,
  t REAL NOT NULL,
  PRIMARY KEY(user_id, k)
);

-- Visti, punti di ripresa e "La mia lista", per titolo TMDB (uguali su tutti i server).
-- rev: contatore del server, per scaricare solo le novita'.
CREATE TABLE IF NOT EXISTS state(
  user_id INTEGER NOT NULL,
  k TEXT NOT NULL,
  pos REAL NOT NULL DEFAULT 0,
  w INTEGER NOT NULL DEFAULT 0,
  fav REAL NOT NULL DEFAULT 0,
  lp REAL NOT NULL DEFAULT 0,
  t REAL NOT NULL,
  rev INTEGER NOT NULL,
  PRIMARY KEY(user_id, k)
);
CREATE INDEX IF NOT EXISTS state_rev ON state(user_id, rev);

-- Amici: amicizie tra account (a ha chiesto a b; 'pending' finche' b non accetta, poi 'ok').
CREATE TABLE IF NOT EXISTS friends(
  a INTEGER NOT NULL,
  b INTEGER NOT NULL,
  status TEXT NOT NULL,
  t REAL NOT NULL,
  PRIMARY KEY(a, b)
);
CREATE INDEX IF NOT EXISTS friends_b ON friends(b);

-- I server che condividono, per account: indirizzo per gli amici e impronta del certificato.
CREATE TABLE IF NOT EXISTS servers(
  user_id INTEGER NOT NULL,
  sid TEXT NOT NULL,
  name TEXT,
  url TEXT NOT NULL,
  lan TEXT,                          -- indirizzo nella rete di casa (si prova per primo)
  public TEXT NOT NULL DEFAULT '',   -- indirizzo pubblico (Tailscale Funnel), per la PWA fuori casa
  ip TEXT NOT NULL DEFAULT '',       -- rete (IP pubblico) da cui arriva la presenza: «in casa» per chi e' li'
  friends INTEGER NOT NULL DEFAULT 1, -- 0 = solo per gli altri PC dello stesso account
  pin TEXT NOT NULL,
  t REAL NOT NULL,
  token_hash TEXT,                   -- sessione del PC che l'ha registrato: solo lui lo aggiorna
  PRIMARY KEY(user_id, sid)
);

-- Credenziale di ogni server (si salva l'impronta del segreto): con questa il server
-- manda presenza e indirizzi (/server/heartbeat). owner_id = account del proprietario.
CREATE TABLE IF NOT EXISTS server_creds(
  sid TEXT PRIMARY KEY,
  owner_id INTEGER NOT NULL,
  secret_hash TEXT NOT NULL,
  name TEXT,
  version TEXT,
  created REAL NOT NULL,
  last_seen REAL NOT NULL DEFAULT 0, -- ultima presenza: acceso se recente (10 minuti)
  secure_port INTEGER NOT NULL DEFAULT 0, -- porta https con certificato valido (0 = non ancora)
  machine TEXT                       -- impronta della macchina: reinstallando sullo stesso PC si propone di sostituire
);
CREATE INDEX IF NOT EXISTS server_creds_owner ON server_creds(owner_id);

-- Collegamento di un server nuovo all'account con un codice (come plex.tv/claim): 15 minuti.
-- Il server chiede il codice (poll_hash = impronta del suo segreto), il proprietario lo conferma
-- (user_id, target = sid finale, anche quello di un server sostituito), il server prende la credenziale.
CREATE TABLE IF NOT EXISTS claims(
  code TEXT PRIMARY KEY,
  sid TEXT NOT NULL,
  machine TEXT,
  name TEXT,
  version TEXT,
  poll_hash TEXT NOT NULL,
  user_id INTEGER,
  target TEXT,
  secret TEXT,                       -- la credenziale, finche' il server non la ritira
  exp REAL NOT NULL
);

-- Profili dell'account («Chi guarda?»): main = 1 per il principale (id 0 nelle API).
CREATE TABLE IF NOT EXISTS profiles(
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  main INTEGER NOT NULL DEFAULT 0,
  name TEXT,
  avatar TEXT,
  color TEXT,
  kids INTEGER NOT NULL DEFAULT 0,   -- solo raccolte per bambini, niente impostazioni
  pin_hash TEXT,                     -- PIN di 4 cifre (impronta)
  pin_fails INTEGER NOT NULL DEFAULT 0,
  pin_locked REAL NOT NULL DEFAULT 0,
  created REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS profiles_user ON profiles(user_id);

-- Visti, ripresa e lista dei profili aggiunti (il principale resta in state).
CREATE TABLE IF NOT EXISTS pstate(
  user_id INTEGER NOT NULL,
  pid INTEGER NOT NULL,
  k TEXT NOT NULL,
  pos REAL NOT NULL DEFAULT 0,
  w INTEGER NOT NULL DEFAULT 0,
  fav REAL NOT NULL DEFAULT 0,
  lp REAL NOT NULL DEFAULT 0,
  t REAL NOT NULL,
  rev INTEGER NOT NULL,
  PRIMARY KEY(user_id, pid, k)
);
CREATE INDEX IF NOT EXISTS pstate_rev ON pstate(user_id, pid, rev);

-- Nomi DNS dei server: <ip-con-trattini>.<sid>.<SERVER_DOMAIN> -> indirizzo di casa.
CREATE TABLE IF NOT EXISTS server_dns(
  name TEXT PRIMARY KEY,
  sid TEXT NOT NULL,
  ip TEXT NOT NULL,
  record_id TEXT NOT NULL,           -- id del record su Cloudflare
  t REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS server_dns_sid ON server_dns(sid);

-- Richieste di certificato in corso (ACME, verifica DNS-01): una per server, 30 minuti.
CREATE TABLE IF NOT EXISTS cert_orders(
  sid TEXT PRIMARY KEY,
  order_url TEXT NOT NULL,
  authz_url TEXT NOT NULL,
  chall_url TEXT,
  finalize_url TEXT NOT NULL,
  txt_id TEXT,                       -- record TXT _acme-challenge su Cloudflare
  csr TEXT NOT NULL,
  status TEXT NOT NULL,              -- pending / ready / finalizing
  triggered REAL NOT NULL DEFAULT 0,
  created REAL NOT NULL
);

-- Biglietti per entrare dal server di un amico: 5 minuti, una volta sola (si salva l'impronta).
CREATE TABLE IF NOT EXISTS tickets(
  hash TEXT PRIMARY KEY,
  from_user INTEGER NOT NULL,
  to_user INTEGER NOT NULL,
  sid TEXT NOT NULL,
  exp REAL NOT NULL
);

-- Dispositivi nella rete Tailscale di BunkerPlex (al massimo 4 per account): a chi
-- appartengono e come si chiamano. Il Worker la crea anche da solo.
CREATE TABLE IF NOT EXISTS ts_devices(
  host TEXT PRIMARY KEY,             -- nome del dispositivo in Tailscale (bunkerplex-...)
  user_id INTEGER NOT NULL,
  label TEXT,                        -- nome da mostrare (PC, Telefono Pixel 8...)
  kind TEXT,                         -- pc / app
  t REAL NOT NULL
);

-- «Entra con Google» in corso: 10 minuti. code = quello da aprire (/g/<code>), poll_hash =
-- impronta del segreto di chi aspetta. Il Worker la crea anche da solo.
CREATE TABLE IF NOT EXISTS google_flows(
  code TEXT PRIMARY KEY,
  poll_hash TEXT NOT NULL,
  state TEXT,                        -- impronta dello stato mandato a Google
  link_user INTEGER,                 -- collegamento a un account già entrato (NULL = accesso)
  device TEXT,
  kind TEXT,                         -- tv / phone / browser
  user_id INTEGER,                   -- l'account entrato, quando Google ha risposto
  email TEXT,
  error TEXT,
  exp REAL NOT NULL
);

-- «Password dimenticata»: un codice di 6 cifre per email, 15 minuti (si salva l'impronta).
CREATE TABLE IF NOT EXISTS reset_codes(
  user_id INTEGER PRIMARY KEY,
  code_hash TEXT NOT NULL,
  exp REAL NOT NULL,
  tries INTEGER NOT NULL DEFAULT 0,
  sent REAL NOT NULL
);

-- Notifiche (campanella, BP Avvisi, web push).
CREATE TABLE IF NOT EXISTS notices(
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  kind TEXT,
  title TEXT,
  body TEXT,
  t REAL NOT NULL,
  from_user INTEGER,
  read INTEGER NOT NULL DEFAULT 0     -- 1 = letto
);
CREATE INDEX IF NOT EXISTS notices_user ON notices(user_id, id);

-- Dispositivi che ricevono le notifiche (gettone nell'indirizzo, si salva l'impronta).
CREATE TABLE IF NOT EXISTS notice_devices(
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  label TEXT,
  kind TEXT,
  open_url TEXT,
  endpoint TEXT,                     -- web push
  p256dh TEXT,
  auth TEXT,
  created REAL NOT NULL,
  last_seen REAL,
  fcm TEXT                           -- gettone Firebase Cloud Messaging (app Android)
);
CREATE INDEX IF NOT EXISTS notice_devices_user ON notice_devices(user_id);

CREATE TABLE IF NOT EXISTS notice_prefs(
  user_id INTEGER PRIMARY KEY,
  v TEXT
);

-- Valori del servizio (chiavi VAPID delle web push, chiave dei gettoni d'accesso 'access',
-- account presso Let's Encrypt 'acme').
CREATE TABLE IF NOT EXISTS kv(
  k TEXT PRIMARY KEY,
  v TEXT
);

-- L'aspetto dei server (scelto dal proprietario): un'icona tra poche o un'immagine (data URL).
CREATE TABLE IF NOT EXISTS server_look(
  sid TEXT PRIMARY KEY,
  owner_id INTEGER NOT NULL,
  icon TEXT,
  image TEXT,
  v REAL NOT NULL                    -- quando e' cambiato: entra nell'indirizzo dell'immagine
);

-- Attivazione dal link dell'invito e link per entrare senza password (si salva l'impronta).
CREATE TABLE IF NOT EXISTS activations(user_id INTEGER PRIMARY KEY, token_hash TEXT NOT NULL, exp REAL NOT NULL);
CREATE TABLE IF NOT EXISTS magic_links(user_id INTEGER PRIMARY KEY, token_hash TEXT NOT NULL, exp REAL NOT NULL, sent REAL NOT NULL);

-- La TV entra dal telefono: codice (QR) confermato dalla PWA, la TV ritira il gettone con poll.
CREATE TABLE IF NOT EXISTS tv_links(code TEXT PRIMARY KEY, poll_hash TEXT NOT NULL, device TEXT, user_id INTEGER, exp REAL NOT NULL);
