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

-- Un gettone per ogni server BunkerPlex collegato all'account (si salva solo l'impronta).
CREATE TABLE IF NOT EXISTS sessions(
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  device TEXT,
  created REAL NOT NULL,
  last_seen REAL NOT NULL
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
  friends INTEGER NOT NULL DEFAULT 1, -- 0 = solo per gli altri PC dello stesso account
  pin TEXT NOT NULL,
  t REAL NOT NULL,
  PRIMARY KEY(user_id, sid)
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
