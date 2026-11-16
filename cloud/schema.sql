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
  locked_until REAL NOT NULL DEFAULT 0
);

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
