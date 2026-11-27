// BunkerPlex - account e impostazioni sincronizzate (Cloudflare Worker + D1).
//
// I server BunkerPlex di casa parlano con questo servizio: login, cambio
// password, impostazioni dell'account, visti / punti di ripresa / La mia lista,
// amici (amicizie, indirizzi dei server che condividono, biglietti d'ingresso).
// Le cartelle e i video NON passano di qui: restano su ogni PC.
//
// La password non arriva mai in chiaro: il server di casa manda una "verifica"
// (PBKDF2-SHA256, 200.000 giri, sale = "bunkerplex:" + nome utente). Qui se ne
// salva solo l'impronta con un sale casuale: il lavoro pesante lo fa il PC,
// cosi' il Worker resta dentro i 10 ms di calcolo del piano gratuito.
//
// Collegamenti richiesti: database D1 come "DB". Segreto: SETUP_KEY (serve
// solo per creare il primo amministratore). Facoltativi: TS_OAUTH_ID e
// TS_OAUTH_SECRET (Tailscale dentro BunkerPlex, vedi /tailscale/key; permessi
// «Auth Keys: write» e «Devices: Core» sull'etichetta tag:bunkerplex).
// GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET: «Entra con Google» (vedi /google/start).
// ANDROID_CERT_SHA256: impronte dei certificati dell'APK del telefono, per le passkey
// dentro l'app (vedi /.well-known/assetlinks.json e «Passkey»).
// BREVO_API_KEY (e MAIL_FROM, di base bunkerplex@outlook.it): «Password dimenticata?»
// con un codice via email (vedi /reset/start). Trigger cron settimanale (es.
// «0 6 * * 1»): tiene viva la chiave Brevo (vedi scheduled).
// Notifiche su telefoni e tablet: tabelle e chiavi VAPID (PWA) nel database, da sole.
// FCM_SERVICE_ACCOUNT (facoltativo): chiave JSON dell'account di servizio Firebase,
// per le notifiche istantanee dell'app Android (vedi docs/notifiche-firebase.md e
// «Notifiche sui telefoni e tablet», /notices e /avvisi).
// Server come risorsa (credenziale propria, presenza, GET /servers, gettoni d'accesso
// firmati, chiave in kv): vedi «Server come risorsa» e docs/architettura.md.
// Nomi e certificati dei server (SERVER_DOMAIN, CF_ZONE_ID, CF_API_TOKEN, ACME_AGREE,
// ACME_EMAIL, ACME_DIRECTORY): vedi «Nomi e certificati dei server».
// GITHUB_TOKEN: token di sola lettura (Contents: Read-only) sul repository degli
// aggiornamenti, che e' privato: i PC senza token propri si aggiornano da qui
// (vedi /aggiornamenti/ e /scarica). GITHUB_REPO se diverso da xFra96/bunkerplex.

const MAX_ROWS = 40;          // righe per richiesta (il piano gratuito ha 50 query a chiamata)
const LOCK_FAILS = 5;         // password sbagliate prima del blocco
const LOCK_SECONDS = 300;

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (e) {
      if (e instanceof Reply) return e.response;
      return json({ detail: 'Errore del servizio account' }, 500);
    }
  },
  // Trigger cron (una volta a settimana): Brevo spegne le chiavi API che non
  // usa nessuno per 90 giorni, e le email di recupero possono mancare a lungo.
  async scheduled(event, env) {
    if (resetOn(env)) {
      await fetch('https://api.brevo.com/v3/account', { headers: { 'api-key': env.BREVO_API_KEY, Accept: 'application/json' } });
    }
  }
};

class Reply {
  constructor(response) { this.response = response; }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

function fail(status, detail) {
  throw new Reply(json({ detail }, status));
}

const now = () => Date.now() / 1000;

// La rete da cui arriva una richiesta: l'IPv4 pubblico, o i primi 64 bit dell'IPv6
// (in casa i dispositivi cambiano la seconda meta' dell'indirizzo, non la prima)
function netKey(request) {
  const ip = request.headers.get('CF-Connecting-IP') || '';
  if (!ip.includes(':')) return ip;
  const parts = ip.split(':');
  return parts.length >= 4 && !ip.includes('::') ? parts.slice(0, 4).join(':') + '::/64' : ip;
}

// Le colonne aggiunte dopo alla tabella dei server (lan, friends): si aggiungono
// da sole alla prima chiamata, cosi' il database non va ritoccato a mano.
let serverCols = false;
async function ensureServerCols(env) {
  if (serverCols) return;
  const cols = (await env.DB.prepare('PRAGMA table_info(servers)').all()).results.map((c) => c.name);
  if (!cols.includes('lan')) await env.DB.prepare('ALTER TABLE servers ADD COLUMN lan TEXT').run();
  if (!cols.includes('friends')) await env.DB.prepare('ALTER TABLE servers ADD COLUMN friends INTEGER NOT NULL DEFAULT 1').run();
  if (!cols.includes('token_hash')) await env.DB.prepare('ALTER TABLE servers ADD COLUMN token_hash TEXT').run();
  serverCols = true;
}

// Indirizzo e impronta di un server li scrive solo la sessione del PC che l'ha
// registrato: un altro dispositivo dell'account (un telefono, un gettone rubato)
// non puo' dirottare gli amici verso un indirizzo falso. Passa anche una sessione
// nuova dello stesso PC (stesso nome di dispositivo, dopo un nuovo accesso) o quando
// la sessione di prima non c'e' piu' (password cambiata, uscita).
// Provvisorio: poi il server avra' una credenziale sua (docs/architettura.md).
async function serverWriter(env, user, sid) {
  const cur = await env.DB.prepare('SELECT s.token_hash, ss.device FROM servers s ' +
    'LEFT JOIN sessions ss ON ss.token_hash = s.token_hash WHERE s.user_id = ? AND s.sid = ?').bind(user.id, sid).first();
  if (cur && cur.token_hash && cur.token_hash !== user.token_hash && cur.device != null && cur.device !== user.s_device) {
    fail(403, 'Questo server lo aggiorna solo il PC su cui gira');
  }
}

// ---- Server come risorsa: credenziale propria, presenza, gettoni d'accesso
//
// Ogni server BunkerPlex ha una credenziale sua (server_creds), legata al suo id
// (sid) e all'account del proprietario. La ottiene una volta con il gettone del
// proprietario (POST /servers/:sid/claim) e poi parla da solo: presenza e
// indirizzi (POST /server/heartbeat). Chi vuole entrare in un server chiede qui un
// gettone firmato (POST /servers/:sid/access, ES256, 12 ore) che il server
// verifica da solo con la chiave pubblica (GET /keys) o, se non sa farlo, qui
// (POST /server/verify). Vedi docs/architettura.md.

const SESSION_KINDS = ['server', 'pwa', 'tv', 'app', 'browser'];
const SESSION_IDLE = 180 * 86400;   // una sessione non usata per 180 giorni scade
const ONLINE_SECONDS = 600;         // presenza: acceso se si e' fatto sentire negli ultimi 10 minuti
const ACCESS_TTL = 12 * 3600;       // durata di un gettone d'accesso a un server
const RECLAIM_IDLE = 600;           // ri-presa della credenziale da un'altra sessione: solo se il server tace da 10 minuti

const sessionKind = (k) => (SESSION_KINDS.includes(k) ? k : null);

let sessionCols = false;
async function ensureSessionCols(env) {
  if (sessionCols) return;
  const cols = (await env.DB.prepare('PRAGMA table_info(sessions)').all()).results.map((c) => c.name);
  if (!cols.includes('kind')) await env.DB.prepare('ALTER TABLE sessions ADD COLUMN kind TEXT').run();
  sessionCols = true;
}

let credTable = false;
async function ensureCreds(env) {
  if (credTable) return;
  await ensureServerCols(env);
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS server_creds(sid TEXT PRIMARY KEY, owner_id INTEGER NOT NULL, ' +
      'secret_hash TEXT NOT NULL, name TEXT, version TEXT, created REAL NOT NULL, last_seen REAL NOT NULL DEFAULT 0)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS server_creds_owner ON server_creds(owner_id)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT)')
  ]);
  credTable = true;
}

// La credenziale di un server: "Bearer s_<sid>_<64 hex>"
async function authServer(request, env) {
  const m = /^Bearer s_([0-9a-f]{8})_([0-9a-f]{64})$/.exec(request.headers.get('Authorization') || '');
  if (!m) fail(401, 'Credenziale del server mancante');
  await ensureCreds(env);
  const c = await env.DB.prepare('SELECT * FROM server_creds WHERE sid = ?').bind(m[1]).first();
  if (!c || !sameString(c.secret_hash, await sha256(m[2]))) fail(401, 'Credenziale del server non valida: va ripresa');
  const owner = await env.DB.prepare('SELECT id, username, disabled FROM users WHERE id = ?').bind(c.owner_id).first();
  if (!owner || owner.disabled) fail(403, "L'account del proprietario non è attivo");
  return { ...c, owner };
}

function cleanUrl(raw) {
  const u = String(raw || '');
  if (u && !/^https:\/\/[^\s/]{3,200}$/.test(u)) fail(400, 'Indirizzo non valido');
  return u;
}

// Chiave ES256 per firmare i gettoni d'accesso: creata la prima volta, poi sempre la stessa
async function accessKeys(env) {
  await ensureCreds(env);
  let saved = await env.DB.prepare("SELECT v FROM kv WHERE k = 'access'").first('v');
  if (!saved) {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const pub = await crypto.subtle.exportKey('jwk', kp.publicKey);
    const kid = (await sha256(pub.x + '.' + pub.y)).slice(0, 16);
    const keys = { kid, priv: await crypto.subtle.exportKey('jwk', kp.privateKey),
      pub: { kty: 'EC', crv: 'P-256', x: pub.x, y: pub.y, kid, alg: 'ES256', use: 'sig' } };
    await env.DB.prepare("INSERT OR IGNORE INTO kv(k, v) VALUES('access', ?)").bind(JSON.stringify(keys)).run();
    saved = await env.DB.prepare("SELECT v FROM kv WHERE k = 'access'").first('v');
  }
  return JSON.parse(saved);
}

async function signAccess(env, claims) {
  const keys = await accessKeys(env);
  const head = b64u(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256', kid: keys.kid })));
  const payload = b64u(te.encode(JSON.stringify(claims)));
  const key = await crypto.subtle.importKey('jwk', keys.priv, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te.encode(head + '.' + payload));
  return head + '.' + payload + '.' + b64u(sig);
}

// I dati di un gettone d'accesso, se la firma e' buona e non e' scaduto (altrimenti null)
async function readAccess(env, token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try {
    const keys = await accessKeys(env);
    const head = JSON.parse(new TextDecoder().decode(unb64u(parts[0])));
    if (head.alg !== 'ES256' || head.kid !== keys.kid) return null;
    const key = await crypto.subtle.importKey('jwk', keys.pub, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, unb64u(parts[2]),
      te.encode(parts[0] + '.' + parts[1]));
    if (!ok) return null;
    const c = JSON.parse(new TextDecoder().decode(unb64u(parts[1])));
    return c.iss === 'bunkerplex' && c.exp > now() ? c : null;
  } catch (e) {
    return null;
  }
}

async function areFriends(env, a, b) {
  return !!await env.DB.prepare("SELECT 1 FROM friends WHERE status = 'ok' AND ((a = ? AND b = ?) OR (a = ? AND b = ?))")
    .bind(a, b, b, a).first();
}

// Rotte con la credenziale del server (/server/...) e quelle pubbliche (/keys)
async function serverRoutes(request, env, path, method) {
  if (path === '/keys' && method === 'GET') {
    const keys = await accessKeys(env);
    return json({ keys: [keys.pub] });
  }
  if (!path.startsWith('/server/') && path !== '/server') return null;
  const srv = await authServer(request, env);

  // Chi sono e di chi sono
  if (path === '/server/me' && method === 'GET') {
    return json({ sid: srv.sid, name: srv.name || '', owner: { id: srv.owner.id, username: srv.owner.username },
      domain: certOn(env) ? env.SERVER_DOMAIN : '' });
  }

  // Presenza e indirizzi, ogni pochi minuti. url = indirizzo da fuori casa (vuoto se
  // non c'e' o se il server non si fa raggiungere), lan = nella rete di casa,
  // friends = lo vedono anche gli amici.
  if (path === '/server/heartbeat' && method === 'POST') {
    const b = await body(request);
    const url = cleanUrl(b.url);
    const lan = cleanUrl(b.lan);
    const pub = cleanUrl(b.public);
    const pin = String(b.pin || '');
    if (pin && !/^[0-9a-f]{64}$/.test(pin)) fail(400, 'Impronta non valida');
    const name = String(b.name || '').slice(0, 40);
    const securePort = Number.isInteger(b.secure_port) && b.secure_port > 0 && b.secure_port < 65536 ? b.secure_port : 0;
    const t = now();
    await ensureClaims(env);
    await env.DB.batch([
      env.DB.prepare('UPDATE server_creds SET last_seen = ?, name = ?, version = ?, secure_port = ?, machine = COALESCE(?, machine) WHERE sid = ?')
        .bind(t, name, String(b.version || '').slice(0, 40), securePort, cleanMachine(b.machine) || null, srv.sid),
      env.DB.prepare('INSERT INTO servers(user_id, sid, name, url, lan, public, friends, pin, t, ip, token_hash) VALUES(?,?,?,?,?,?,?,?,?,?,NULL) ' +
        'ON CONFLICT(user_id, sid) DO UPDATE SET name = excluded.name, url = excluded.url, lan = excluded.lan, ' +
        'public = excluded.public, friends = excluded.friends, pin = excluded.pin, t = excluded.t, ip = excluded.ip, token_hash = NULL')
        .bind(srv.owner_id, srv.sid, name, url, lan, pub, b.friends === true ? 1 : 0, pin, t, netKey(request))
    ]);
    // Il nome nella rete di casa (per il certificato valido): dall'indirizzo lan
    const names = await syncServerDns(env, srv.sid, lan ? new URL(lan).hostname : '');
    return json({ ok: true, owner: { id: srv.owner.id, username: srv.owner.username }, online_seconds: ONLINE_SECONDS,
      domain: certOn(env) ? env.SERVER_DOMAIN : '', names });
  }

  // Verifica di un gettone d'accesso, per i server che non sanno controllare la firma.
  // Qui si ricontrolla anche l'amicizia (un amico tolto non entra piu' subito).
  if (path === '/server/verify' && method === 'POST') {
    const c = await readAccess(env, (await body(request)).token);
    // Biglietto di un profilo: vale per i profili del proprietario
    if (c && c.typ === 'profile' && Number(c.sub) === srv.owner_id) return json({ claims: c });
    if (!c || c.typ || c.sid !== srv.sid || c.own !== srv.owner_id) fail(403, 'Gettone non valido');
    if (c.role === 'friend' && !await areFriends(env, Number(c.sub), srv.owner_id)) fail(403, 'Non siete più amici');
    return json({ claims: c });
  }

  // Certificato *.<sid>.<dominio>: si avvia con la CSR, poi si chiede a che punto e'
  if (path === '/server/cert/start' && method === 'POST') {
    return json(await certStart(env, srv, (await body(request)).csr));
  }
  if (path === '/server/cert/poll' && method === 'POST') {
    return json(await certPoll(env, srv));
  }

  // Il server si toglie dall'account (es. il proprietario lo scollega dal PC)
  if (path === '/server' && method === 'DELETE') {
    await dropServerDns(env, srv.sid);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM server_creds WHERE sid = ?').bind(srv.sid),
      env.DB.prepare('DELETE FROM servers WHERE user_id = ? AND sid = ?').bind(srv.owner_id, srv.sid)
    ]);
    return json({ ok: true });
  }
  fail(404, 'Non trovato');
}

// Il server ha gia' la sua credenziale: allora i suoi dati li scrive solo lui
async function hasCredential(env, uid, sid) {
  await ensureCreds(env);
  return !!await env.DB.prepare('SELECT 1 FROM server_creds WHERE sid = ? AND owner_id = ?').bind(sid, uid).first();
}

// ---- Profili dell'account («Chi guarda?», come Netflix)
//
// Un account ha fino a 6 profili: il principale (id 0, l'account stesso) e fino a 5
// aggiunti. Ognuno ha nome, avatar, colore, eventualmente un PIN e il segno «bambini»
// (vede solo le raccolte per bambini e non cambia le impostazioni). Visti, punti di
// ripresa e La mia lista sono del profilo e valgono su tutti i server: il principale
// in `state` (come prima), gli altri in `pstate`.
// Si sceglie un profilo con POST /profiles/:id/open (PIN se c'e'): torna un biglietto
// firmato (ES256, 30 giorni) che il server verifica da solo, come i gettoni d'accesso.

const MAX_PROFILES = 5;            // oltre al principale
const PROFILE_TTL = 30 * 86400;
const PROFILE_AVATARS = ['', 'cat', 'fox', 'panda', 'frog', 'lion', 'penguin', 'octopus', 'unicorn', 'rocket', 'ball', 'game', 'film'];
const PROFILE_COLORS = ['', '#e50914', '#f5a623', '#2ecc71', '#1abc9c', '#3498db', '#9b59b6', '#e84393', '#7f8c8d'];
const PIN_FAILS = 5;
const PIN_LOCK = 300;

let profileTables = false;
async function ensureProfiles(env) {
  if (profileTables) return;
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS profiles(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, ' +
      'main INTEGER NOT NULL DEFAULT 0, name TEXT, avatar TEXT, color TEXT, kids INTEGER NOT NULL DEFAULT 0, ' +
      'pin_hash TEXT, pin_fails INTEGER NOT NULL DEFAULT 0, pin_locked REAL NOT NULL DEFAULT 0, created REAL NOT NULL)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS profiles_user ON profiles(user_id)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS pstate(user_id INTEGER NOT NULL, pid INTEGER NOT NULL, k TEXT NOT NULL, ' +
      'pos REAL NOT NULL DEFAULT 0, w INTEGER NOT NULL DEFAULT 0, fav REAL NOT NULL DEFAULT 0, lp REAL NOT NULL DEFAULT 0, ' +
      't REAL NOT NULL, rev INTEGER NOT NULL, PRIMARY KEY(user_id, pid, k))'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS pstate_rev ON pstate(user_id, pid, rev)')
  ]);
  profileTables = true;
}

function profileJson(user, r) {
  const main = !r || !!r.main;
  return { id: main ? 0 : r.id, name: (r && r.name) || user.username, avatar: (r && r.avatar) || '',
    color: (r && r.color) || '', kids: !main && !!(r && r.kids), pin: !!(r && r.pin_hash), main };
}

async function profileRows(env, user) {
  await ensureProfiles(env);
  return (await env.DB.prepare('SELECT * FROM profiles WHERE user_id = ? ORDER BY main DESC, created, id').bind(user.id).all()).results;
}

async function profilesOf(env, user) {
  const rows = await profileRows(env, user);
  const main = rows.find((r) => r.main);
  return [profileJson(user, main), ...rows.filter((r) => !r.main).map((r) => profileJson(user, r))];
}

// La riga di un profilo dell'account (id 0: il principale, che puo' non avere ancora una riga)
async function profileRow(env, user, id) {
  await ensureProfiles(env);
  if (id === 0) return await env.DB.prepare('SELECT * FROM profiles WHERE user_id = ? AND main = 1').bind(user.id).first();
  const r = await env.DB.prepare('SELECT * FROM profiles WHERE user_id = ? AND id = ? AND main = 0').bind(user.id, id).first();
  if (!r) fail(404, 'Questo profilo non c\'è più');
  return r;
}

function profileName(raw) {
  const name = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  if (!name) fail(400, 'Scrivi un nome');
  if (name.length > 24) fail(400, 'Nome troppo lungo (al massimo 24 caratteri)');
  return name;
}

async function profileNameFree(env, user, name, id) {
  const all = await profilesOf(env, user);
  if (all.some((p) => p.id !== id && p.name.toLowerCase() === name.toLowerCase())) fail(409, 'C\'è già un profilo con questo nome');
}

// I campi che si possono cambiare (quelli che mancano restano come sono)
async function profileFields(b, user, id) {
  const out = {};
  if (b.name !== undefined) out.name = profileName(b.name);
  if (b.avatar !== undefined) {
    if (!PROFILE_AVATARS.includes(String(b.avatar || ''))) fail(400, 'Avatar non valido');
    out.avatar = String(b.avatar || '');
  }
  if (b.color !== undefined) {
    if (!PROFILE_COLORS.includes(String(b.color || ''))) fail(400, 'Colore non valido');
    out.color = String(b.color || '');
  }
  if (b.kids !== undefined && id !== 0) out.kids = b.kids ? 1 : 0;
  if (b.pin !== undefined) {
    const pin = String(b.pin == null ? '' : b.pin);
    if (pin && !/^\d{4}$/.test(pin)) fail(400, 'Il PIN è di 4 cifre');
    out.pin_hash = pin ? await pinHash(user.id, id, pin) : null;
  }
  return out;
}

// Il PIN di un profilo: 4 cifre, impronta legata ad account e profilo; dopo 5 errori 5 minuti di blocco
const pinHash = (uid, pid, pin) => sha256('bunkerplex-pin:' + uid + ':' + pid + ':' + pin);

async function profileTicket(env, user, id) {
  const iat = Math.floor(now());
  return await signAccess(env, { iss: 'bunkerplex', typ: 'profile', sub: String(user.id), pid: id, iat,
    exp: iat + PROFILE_TTL, jti: randomHex(8) });
}

async function profileRoutes(request, env, url, path, method, user) {
  if (path === '/profiles' && method === 'GET') {
    return json({ profiles: await profilesOf(env, user), max: MAX_PROFILES + 1, avatars: PROFILE_AVATARS, colors: PROFILE_COLORS });
  }
  if (path === '/profiles' && method === 'POST') {
    const b = await body(request);
    const rows = await profileRows(env, user);
    if (rows.filter((r) => !r.main).length >= MAX_PROFILES) fail(400, `Al massimo ${MAX_PROFILES + 1} profili per account`);
    const f = await profileFields({ ...b, name: b.name === undefined ? '' : b.name, pin: undefined }, user, -1);
    await profileNameFree(env, user, f.name, -1);
    const res = await env.DB.prepare('INSERT INTO profiles(user_id, main, name, avatar, color, kids, created) VALUES(?,0,?,?,?,?,?)')
      .bind(user.id, f.name, f.avatar || '', f.color || '', f.kids || 0, now()).run();
    const id = res.meta.last_row_id;
    // Il PIN dipende dall'id del profilo: si scrive dopo
    if (b.pin) {
      const pf = await profileFields({ pin: b.pin }, user, id);
      await env.DB.prepare('UPDATE profiles SET pin_hash = ? WHERE id = ?').bind(pf.pin_hash, id).run();
    }
    const profiles = await profilesOf(env, user);
    return json({ ok: true, profile: profiles.find((p) => p.id === id), profiles });
  }
  const pm = /^\/profiles\/(\d{1,12})$/.exec(path);
  if (pm && method === 'PUT') {
    const id = Number(pm[1]);
    const row = await profileRow(env, user, id);
    const f = await profileFields(await body(request), user, id);
    if (f.name) await profileNameFree(env, user, f.name, id);
    if (id === 0 && !row) {
      await env.DB.prepare('INSERT INTO profiles(user_id, main, name, avatar, color, kids, pin_hash, created) VALUES(?,1,?,?,?,0,?,?)')
        .bind(user.id, f.name || null, f.avatar || '', f.color || '', f.pin_hash || null, now()).run();
    } else if (Object.keys(f).length) {
      const cols = Object.keys(f);
      await env.DB.prepare('UPDATE profiles SET ' + cols.map((c) => c + ' = ?').join(', ') +
        (f.pin_hash !== undefined ? ', pin_fails = 0, pin_locked = 0' : '') + ' WHERE id = ?')
        .bind(...cols.map((c) => f[c]), row.id).run();
    }
    const profiles = await profilesOf(env, user);
    return json({ ok: true, profile: profiles.find((p) => p.id === id), profiles });
  }
  if (pm && method === 'DELETE') {
    const id = Number(pm[1]);
    if (id === 0) fail(400, 'Il profilo principale è l\'account: non si toglie');
    const row = await profileRow(env, user, id);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM pstate WHERE user_id = ? AND pid = ?').bind(user.id, row.id),
      env.DB.prepare('DELETE FROM profiles WHERE id = ?').bind(row.id)
    ]);
    return json({ ok: true, profiles: await profilesOf(env, user) });
  }
  // Scegliere un profilo (con il PIN, se ne ha uno): biglietto per i server
  const om = /^\/profiles\/(\d{1,12})\/open$/.exec(path);
  if (om && method === 'POST') {
    const id = Number(om[1]);
    const row = await profileRow(env, user, id);
    if (row && row.pin_hash) {
      if (row.pin_locked > now()) fail(429, 'Troppi PIN sbagliati: riprova tra qualche minuto');
      const pin = String((await body(request)).pin || '');
      if (!sameString(await pinHash(user.id, id, pin), row.pin_hash)) {
        const fails = row.pin_fails + 1;
        const locked = fails >= PIN_FAILS ? now() + PIN_LOCK : 0;
        await env.DB.prepare('UPDATE profiles SET pin_fails = ?, pin_locked = ? WHERE id = ?').bind(locked ? 0 : fails, locked, row.id).run();
        fail(pin ? 401 : 412, pin ? 'PIN sbagliato' : 'Questo profilo ha un PIN');
      }
      if (row.pin_fails) await env.DB.prepare('UPDATE profiles SET pin_fails = 0 WHERE id = ?').bind(row.id).run();
    }
    return json({ ok: true, ticket: await profileTicket(env, user, id), exp: Math.floor(now()) + PROFILE_TTL,
      profile: profileJson(user, row) });
  }
  return null;
}

// Il profilo per visti e ripresa (?profile=<id>): 0 = il principale (tabella state)
async function stateProfile(env, user, url) {
  const id = Number(url.searchParams.get('profile') || 0);
  if (!Number.isInteger(id) || id < 0) fail(400, 'Profilo non valido');
  if (id) await profileRow(env, user, id);
  return id;
}

// ---- Collegamento di un server all'account (come plex.tv/claim)
//
// Un server nuovo non entra da solo nell'account del primo che ci fa login: chiede un
// codice (POST /claim/start, senza account) e lo mostra; il proprietario lo conferma da
// un suo dispositivo (POST /claim/:code) dandogli un nome. Il server intanto chiede
// (POST /claim/poll) e riceve la sua credenziale. machine = impronta della macchina:
// reinstallando BunkerPlex sullo stesso PC si propone di sostituire il server di prima
// (spento), che cosi' tiene nome, aspetto, amici e nome DNS (il server nuovo ne prende il sid).

const CLAIM_TTL = 15 * 60;
const CLAIM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

let claimTable = false;
async function ensureClaims(env) {
  if (claimTable) return;
  await ensureCreds(env);
  await ensureCertTables(env);
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS claims(code TEXT PRIMARY KEY, sid TEXT NOT NULL, machine TEXT, ' +
    'name TEXT, version TEXT, poll_hash TEXT NOT NULL, user_id INTEGER, target TEXT, secret TEXT, exp REAL NOT NULL)').run();
  const cols = (await env.DB.prepare('PRAGMA table_info(server_creds)').all()).results.map((c) => c.name);
  if (!cols.includes('machine')) await env.DB.prepare('ALTER TABLE server_creds ADD COLUMN machine TEXT').run();
  claimTable = true;
}

const cleanMachine = (raw) => (/^[0-9a-f]{16,64}$/.test(String(raw || '')) ? String(raw) : '');

function claimCode() {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return [...a].map((b) => CLAIM_ALPHABET[b % CLAIM_ALPHABET.length]).join('');
}

async function claimRow(env, raw) {
  await ensureClaims(env);
  const code = cleanCode(raw);
  const c = code.length === 8 ? await env.DB.prepare('SELECT * FROM claims WHERE code = ?').bind(code).first() : null;
  if (!c || c.exp < now()) fail(404, 'Codice sbagliato o scaduto: sul server ne compare uno nuovo');
  return c;
}

// I propri server sulla stessa macchina (per proporre la sostituzione)
async function sameMachine(env, user, machine, sid) {
  if (!machine) return [];
  const t = now();
  const rows = await env.DB.prepare('SELECT c.sid, COALESCE(s.name, c.name) AS name, c.last_seen, c.version FROM server_creds c ' +
    'LEFT JOIN servers s ON s.sid = c.sid AND s.user_id = c.owner_id WHERE c.owner_id = ? AND c.machine = ? AND c.sid <> ?')
    .bind(user.id, machine, sid).all();
  return rows.results.map((r) => ({ sid: r.sid, name: r.name || 'PC', seen: r.last_seen || 0, version: r.version || '',
    online: !!r.last_seen && t - r.last_seen < ONLINE_SECONDS }));
}

async function claimPublicRoutes(request, env, path, method) {
  if (path === '/claim/start' && method === 'POST') {
    await ensureClaims(env);
    const b = await body(request);
    const sid = String(b.sid || '');
    if (!/^[0-9a-f]{8}$/.test(sid)) fail(400, 'Server non valido');
    await env.DB.prepare('DELETE FROM claims WHERE exp < ? OR sid = ?').bind(now(), sid).run();
    const poll = randomHex(32);
    const code = claimCode();
    await env.DB.prepare('INSERT INTO claims(code, sid, machine, name, version, poll_hash, exp) VALUES(?,?,?,?,?,?,?)')
      .bind(code, sid, cleanMachine(b.machine) || null, String(b.name || '').slice(0, 40), String(b.version || '').slice(0, 40),
        await sha256(poll), now() + CLAIM_TTL).run();
    return json({ code, poll, exp: Math.floor(now() + CLAIM_TTL) });
  }
  if (path === '/claim/poll' && method === 'POST') {
    await ensureClaims(env);
    const b = await body(request);
    const c = await env.DB.prepare('SELECT * FROM claims WHERE code = ?').bind(cleanCode(b.code)).first();
    if (!c || !sameString(c.poll_hash, await sha256(String(b.poll || '')))) fail(404, 'Codice scaduto');
    if (!c.secret) {
      if (c.exp < now()) fail(404, 'Codice scaduto');
      return json({ status: 'pending', exp: Math.floor(c.exp) });
    }
    await env.DB.prepare('DELETE FROM claims WHERE code = ?').bind(c.code).run();
    const owner = await env.DB.prepare('SELECT id, username FROM users WHERE id = ?').bind(c.user_id).first();
    return json({ status: 'done', credential: 's_' + c.target + '_' + c.secret, sid: c.target, name: c.name,
      owner: { id: owner.id, username: owner.username } });
  }
  return null;
}

async function claimUserRoutes(request, env, path, method, user) {
  const m = /^\/claim\/([A-Za-z0-9-]{8,12})$/.exec(path);
  if (!m) return null;
  const c = await claimRow(env, m[1]);
  const other = await env.DB.prepare('SELECT owner_id FROM server_creds WHERE sid = ?').bind(c.sid).first();
  if (method === 'GET') {
    return json({ code: c.code, sid: c.sid, name: c.name || '', version: c.version || '',
      taken: !!other && other.owner_id !== user.id, mine: !!other && other.owner_id === user.id,
      same_machine: await sameMachine(env, user, c.machine, c.sid) });
  }
  if (method !== 'POST') return null;
  if (c.secret) fail(409, 'Questo codice è già stato usato');
  if (other && other.owner_id !== user.id) fail(409, 'Questo server è già collegato a un altro account');
  const b = await body(request);
  const name = String(b.name || c.name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!name) fail(400, 'Dai un nome al server');
  let target = c.sid;
  if (b.replace) {
    const old = (await sameMachine(env, user, c.machine, c.sid)).find((s) => s.sid === b.replace);
    if (!old) fail(404, 'Il server da sostituire non è sulla stessa macchina');
    if (old.online) fail(409, `«${old.name}» è acceso: spegnilo prima di sostituirlo`);
    target = old.sid;
  }
  const dup = await env.DB.prepare('SELECT 1 FROM servers WHERE user_id = ? AND sid <> ? AND name = ? COLLATE NOCASE')
    .bind(user.id, target, name).first();
  if (dup) fail(409, 'Hai già un server con questo nome');
  const secret = randomHex(32);
  const t = now();
  const stmts = [
    env.DB.prepare('INSERT INTO server_creds(sid, owner_id, secret_hash, name, version, created, last_seen, machine) VALUES(?,?,?,?,?,?,0,?) ' +
      'ON CONFLICT(sid) DO UPDATE SET owner_id = excluded.owner_id, secret_hash = excluded.secret_hash, name = excluded.name, ' +
      'version = excluded.version, last_seen = 0, machine = excluded.machine')
      .bind(target, user.id, await sha256(secret), name, c.version || '', t, c.machine || null),
    env.DB.prepare("INSERT INTO servers(user_id, sid, name, url, pin, t, friends) VALUES(?,?,?,'','',?,0) " +
      'ON CONFLICT(user_id, sid) DO UPDATE SET name = excluded.name').bind(user.id, target, name, t),
    env.DB.prepare('UPDATE claims SET user_id = ?, target = ?, secret = ?, name = ?, exp = ? WHERE code = ?')
      .bind(user.id, target, secret, name, t + CLAIM_TTL, c.code)
  ];
  // Il sid nuovo era gia' stato registrato (vecchio collegamento automatico): sparisce, resta quello sostituito
  if (target !== c.sid && other) stmts.push(env.DB.prepare('DELETE FROM server_creds WHERE sid = ?').bind(c.sid),
    env.DB.prepare('DELETE FROM servers WHERE user_id = ? AND sid = ?').bind(user.id, c.sid));
  await env.DB.batch(stmts);
  return json({ ok: true, sid: target, name, replaced: target !== c.sid });
}

// Con la credenziale del server si leggono e scrivono i dati del proprietario che
// servono al server (impostazioni, visti, profili): cosi' funziona anche quando sul PC
// il proprietario e' entrato solo dalla PWA o dalla TV (gettone d'accesso, nessuna password).
const SERVER_AS_OWNER = [['GET', /^\/me$/], ['GET', /^\/settings$/], ['PUT', /^\/settings$/], ['GET', /^\/state$/],
  ['POST', /^\/state$/], ['GET', /^\/profiles$/], ['POST', /^\/profiles\/\d{1,12}\/open$/]];

async function serverAsOwner(request, env, path, method) {
  if (!/^Bearer s_/.test(request.headers.get('Authorization') || '')) return null;
  if (!SERVER_AS_OWNER.some(([m, re]) => m === method && re.test(path))) fail(403, 'Non permesso alla credenziale del server');
  const srv = await authServer(request, env);
  const u = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(srv.owner_id).first();
  return { ...u, token_hash: 'server:' + srv.sid, s_device: srv.name || '', via_server: srv.sid };
}

// ---- L'aspetto dei server: un'icona tra poche o un'immagine (scelta dal proprietario).
// L'immagine non viaggia negli elenchi: c'e' il suo indirizzo (/servers/<sid>/image?v=...).
const LOOK_ICONS = ['tv', 'film', 'home', 'star', 'heart', 'music', 'game', 'cloud'];
const LOOK_MAX = 150000;        // caratteri del data URL (circa 110 KB di immagine)

let lookTable = false;
async function ensureLook(env) {
  if (lookTable) return;
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS server_look(sid TEXT PRIMARY KEY, owner_id INTEGER NOT NULL, ' +
    'icon TEXT, image TEXT, v REAL NOT NULL)').run();
  lookTable = true;
}

// sid -> {icon, image} per un elenco di server
async function looksFor(env, origin, sids) {
  await ensureLook(env);
  const list = [...new Set(sids)].filter((x) => /^[0-9a-f]{8}$/.test(x));
  const map = new Map();
  if (!list.length) return map;
  const rows = await env.DB.prepare('SELECT sid, icon, v, image IS NOT NULL AS has FROM server_look WHERE sid IN (' +
    list.map(() => '?').join(',') + ')').bind(...list).all();
  for (const r of rows.results) {
    map.set(r.sid, { icon: r.icon || '', image: r.has ? origin + '/servers/' + r.sid + '/image?v=' + Math.floor(r.v) : '' });
  }
  return map;
}

async function ownsServer(env, uid, sid) {
  await ensureCreds(env);
  return !!(await env.DB.prepare('SELECT 1 FROM servers WHERE user_id = ? AND sid = ?').bind(uid, sid).first() ||
    await env.DB.prepare('SELECT 1 FROM server_creds WHERE owner_id = ? AND sid = ?').bind(uid, sid).first());
}

// Rotte dell'utente sui server (dopo il controllo della password provvisoria)
async function userServerRoutes(request, env, path, method, user) {
  const cu = await claimUserRoutes(request, env, path, method, user);
  if (cu) return cu;
  // Un server prende (o riprende) la sua credenziale con il gettone del proprietario
  const cm = /^\/servers\/([0-9a-f]{8})\/claim$/.exec(path);
  if (cm && method === 'POST') {
    await ensureCreds(env);
    await ensureSessionCols(env);
    const sid = cm[1];
    const b = await body(request);
    const c = await env.DB.prepare('SELECT owner_id, last_seen FROM server_creds WHERE sid = ?').bind(sid).first();
    if (c && c.owner_id !== user.id) fail(409, 'Questo server è già collegato a un altro account');
    // Un server nuovo entra nell'account solo con il codice (POST /claim/:code); questa via
    // resta per riprendere la credenziale di un server che l'account ha gia'.
    if (!c && !await env.DB.prepare('SELECT 1 FROM servers WHERE user_id = ? AND sid = ?').bind(user.id, sid).first()) {
      fail(428, 'Per aggiungere questo server al tuo account serve il codice di collegamento');
    }
    if (c) {
      // Riprenderla (il server l'ha persa) la puo' una sessione di un server, o
      // chiunque dell'account se il server tace da un po': un gettone di un telefono
      // non porta via la credenziale a un server acceso.
      const kind = await env.DB.prepare('SELECT kind FROM sessions WHERE token_hash = ?').bind(user.token_hash).first('kind');
      if (kind !== 'server' && now() - c.last_seen < RECLAIM_IDLE) fail(409, 'Questo server è acceso e ha già la sua credenziale');
    }
    const secret = randomHex(32);
    await env.DB.prepare('INSERT INTO server_creds(sid, owner_id, secret_hash, name, created, last_seen) VALUES(?,?,?,?,?,0) ' +
      'ON CONFLICT(sid) DO UPDATE SET secret_hash = excluded.secret_hash, name = excluded.name')
      .bind(sid, user.id, await sha256(secret), String(b.name || '').slice(0, 40), now()).run();
    return json({ credential: 's_' + sid + '_' + secret, owner: { id: user.id, username: user.username } });
  }

  // Tutti i server che si possono usare: i propri e quelli che gli amici condividono.
  // local = la sua presenza arriva dalla stessa rete di chi chiede (e' «in casa»).
  // friends = gli amici e le richieste, per la scelta del server (aggiungi/accetta).
  if (path === '/servers' && method === 'GET') {
    await ensureServerCols(env);
    await ensureCertTables(env);
    const t = now();
    const here = netKey(request);
    const online = (seen) => (seen ? t - seen < ONLINE_SECONDS : null);   // null = non si sa (server di prima)
    const local = (s) => !!here && s.ip === here && online(s.last_seen) !== false;
    await ensureClaims(env);
    const own = await env.DB.prepare('SELECT s.sid, s.name, s.url, s.lan, s.public, s.pin, s.friends, s.t, s.ip, c.last_seen, c.secure_port, c.machine, c.version, ' +
      '(SELECT d.name FROM server_dns d WHERE d.sid = s.sid LIMIT 1) AS dns FROM servers s ' +
      'LEFT JOIN server_creds c ON c.sid = s.sid AND c.owner_id = s.user_id WHERE s.user_id = ?').bind(user.id).all();
    const shared = await env.DB.prepare(
      'SELECT s.user_id, u.username, s.sid, s.name, s.url, s.public, s.pin, s.t, s.ip, c.last_seen, c.secure_port, ' +
      '(SELECT d.name FROM server_dns d WHERE d.sid = s.sid LIMIT 1) AS dns FROM servers s ' +
      "JOIN friends f ON f.status = 'ok' AND ((f.a = ? AND f.b = s.user_id) OR (f.b = ? AND f.a = s.user_id)) " +
      'JOIN users u ON u.id = s.user_id LEFT JOIN server_creds c ON c.sid = s.sid AND c.owner_id = s.user_id ' +
      'WHERE s.friends = 1 AND u.disabled = 0').bind(user.id, user.id).all();
    const servers = [
      ...own.results.map((s) => ({
        sid: s.sid, name: s.name || 'PC', role: 'owner', owner: { id: user.id, username: user.username },
        online: online(s.last_seen), seen: s.last_seen || s.t, shared: !!s.friends, local: local(s),
        machine: s.machine || '', version: s.version || '',
        addresses: { lan: s.lan || '', remote: s.url || '', public: s.public || '',
          secure_lan: s.dns && s.secure_port ? 'https://' + s.dns + ':' + s.secure_port : '' }, pin: s.pin
      })),
      ...shared.results.map((s) => ({
        sid: s.sid, name: s.name || 'PC', role: 'friend', owner: { id: s.user_id, username: s.username },
        online: online(s.last_seen), seen: s.last_seen || s.t, shared: true, local: local(s),
        // Gli amici si collegano direttamente: nome di casa con certificato (se sono li')
        // e indirizzo pubblico (Funnel) da fuori
        addresses: { lan: '', remote: s.url || '', public: s.public || '',
          secure_lan: s.dns && s.secure_port ? 'https://' + s.dns + ':' + s.secure_port : '' }, pin: s.pin
      }))
    ];
    const rel = await env.DB.prepare(
      'SELECT f.a, f.b, f.status, ua.username AS ua, ub.username AS ub FROM friends f ' +
      'JOIN users ua ON ua.id = f.a JOIN users ub ON ub.id = f.b WHERE f.a = ? OR f.b = ?'
    ).bind(user.id, user.id).all();
    const friends = rel.results.map((r) => ({
      id: r.a === user.id ? r.b : r.a, username: r.a === user.id ? r.ub : r.ua,
      status: r.status === 'ok' ? 'ok' : (r.a === user.id ? 'sent' : 'received')
    }));
    const looks = await looksFor(env, new URL(request.url).origin, servers.map((s) => s.sid));
    for (const s of servers) s.look = looks.get(s.sid) || { icon: '', image: '' };
    return json({ me: { id: user.id, username: user.username }, servers, friends });
  }

  // L'aspetto di un proprio server: icon (una di LOOK_ICONS o ''), image (data URL, '' = togli)
  const lm = /^\/servers\/([0-9a-f]{8})\/look$/.exec(path);
  if (lm && method === 'PUT') {
    const sid = lm[1];
    if (!await ownsServer(env, user.id, sid)) fail(404, 'Server non trovato tra i tuoi');
    await ensureLook(env);
    const b = await body(request);
    const old = await env.DB.prepare('SELECT * FROM server_look WHERE sid = ?').bind(sid).first();
    let icon = old ? old.icon : '';
    let image = old ? old.image : null;
    if (b.icon !== undefined) {
      icon = String(b.icon || '');
      if (icon && !LOOK_ICONS.includes(icon)) fail(400, 'Icona non valida');
    }
    if (b.image !== undefined) {
      image = String(b.image || '') || null;
      if (image && (image.length > LOOK_MAX || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(image))) {
        fail(400, 'Immagine non valida o troppo grande');
      }
    }
    await env.DB.prepare('INSERT OR REPLACE INTO server_look(sid, owner_id, icon, image, v) VALUES(?,?,?,?,?)')
      .bind(sid, user.id, icon || null, image, now()).run();
    const looks = await looksFor(env, new URL(request.url).origin, [sid]);
    return json({ ok: true, look: looks.get(sid) || { icon: '', image: '' } });
  }

  // Un gettone per entrare in un server: proprio (owner) o di un amico (friend)
  const am = /^\/servers\/([0-9a-f]{8})\/access$/.exec(path);
  if (am && method === 'POST') {
    await ensureCreds(env);
    const sid = am[1];
    const b = await body(request);
    const ownerId = b.owner === undefined || b.owner === null ? user.id : Number(b.owner);
    let role;
    if (ownerId === user.id) {
      const mine = await env.DB.prepare('SELECT 1 FROM servers WHERE user_id = ? AND sid = ?').bind(user.id, sid).first() ||
        await env.DB.prepare('SELECT 1 FROM server_creds WHERE owner_id = ? AND sid = ?').bind(user.id, sid).first();
      if (!mine) fail(404, 'Server non trovato tra i tuoi');
      role = 'owner';
    } else {
      if (!Number.isInteger(ownerId) || !await areFriends(env, user.id, ownerId)) fail(403, 'Non siete amici');
      const sh = await env.DB.prepare('SELECT 1 FROM servers WHERE user_id = ? AND sid = ? AND friends = 1').bind(ownerId, sid).first();
      if (!sh) fail(404, 'Questo server non condivide');
      role = 'friend';
    }
    const iat = Math.floor(now());
    const claims = { iss: 'bunkerplex', sub: String(user.id), name: user.username, sid, own: ownerId, role,
      iat, exp: iat + ACCESS_TTL, jti: randomHex(8) };
    return json({ token: await signAccess(env, claims), exp: claims.exp, role });
  }

  // Un proprio server non lo si vuole piu' nell'elenco (anche se e' spento)
  const fm = /^\/servers\/([0-9a-f]{8})\/forget$/.exec(path);
  if (fm && method === 'POST') {
    await ensureCreds(env);
    if (await hasCredential(env, user.id, fm[1])) await dropServerDns(env, fm[1]);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM server_creds WHERE sid = ? AND owner_id = ?').bind(fm[1], user.id),
      env.DB.prepare('DELETE FROM servers WHERE user_id = ? AND sid = ?').bind(user.id, fm[1])
    ]);
    return json({ ok: true });
  }
  return null;
}

// I dispositivi entrati nell'account (sessioni): vederli e toglierli
async function deviceRoutes(env, path, method, user) {
  if (path === '/devices' && method === 'GET') {
    await ensureSessionCols(env);
    const rows = await env.DB.prepare('SELECT rowid, token_hash, device, kind, created, last_seen FROM sessions WHERE user_id = ? ' +
      'ORDER BY last_seen DESC').bind(user.id).all();
    return json({ devices: rows.results.map((r) => ({ id: r.rowid, label: r.device || '', kind: r.kind || '',
      created: r.created, seen: r.last_seen, current: r.token_hash === user.token_hash })) });
  }
  const m = /^\/devices\/(\d{1,12})$/.exec(path);
  if (m && method === 'DELETE') {
    const r = await env.DB.prepare('DELETE FROM sessions WHERE rowid = ? AND user_id = ?').bind(Number(m[1]), user.id).run();
    if (!r.meta || !r.meta.changes) fail(404, 'Dispositivo non trovato');
    return json({ ok: true });
  }
  return null;
}

// ---- Nomi e certificati dei server (HTTPS valido nella rete di casa)
//
// Un browser (la PWA) non parla con http://192.168.x.x da una pagina https, e non
// accetta i certificati fatti in casa. Allora ogni server riceve un nome pubblico
// che punta al suo indirizzo di casa, <ip-con-trattini>.<sid>.<SERVER_DOMAIN>
// (es. 192-168-1-5.1234abcd.bpx.esempio.it -> 192.168.1.5), e un certificato vero
// *.<sid>.<SERVER_DOMAIN> da Let's Encrypt (verifica DNS-01, fatta qui).
// La chiave privata del certificato resta sul server: qui arriva solo la richiesta (CSR).
//
// Si accende con: SERVER_DOMAIN (es. bpx.esempio.it, una zona o sottozona su
// Cloudflare), CF_ZONE_ID e CF_API_TOKEN (permesso «Zone: DNS: Edit» su quella zona),
// ACME_AGREE = "yes" (si accettano le condizioni di Let's Encrypt), ACME_EMAIL
// facoltativa. ACME_DIRECTORY cambia autorita' (es. lo staging di Let's Encrypt per le prove).

const ACME_LE = 'https://acme-v02.api.letsencrypt.org/directory';
const ORDER_TTL = 1800;               // un ordine di certificato fermo da 30 minuti si butta

const dnsOn = (env) => !!(env.SERVER_DOMAIN && env.CF_ZONE_ID && env.CF_API_TOKEN);
const certOn = (env) => dnsOn(env) && env.ACME_AGREE === 'yes';
const dashed = (ip) => ip.replace(/\./g, '-');

function privateIPv4(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || ''));
  if (!m || m.slice(1).some((n) => Number(n) > 255)) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

let certTables = false;
async function ensureCertTables(env) {
  if (certTables) return;
  await ensureCreds(env);
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS server_dns(name TEXT PRIMARY KEY, sid TEXT NOT NULL, ip TEXT NOT NULL, ' +
      'record_id TEXT NOT NULL, t REAL NOT NULL)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS server_dns_sid ON server_dns(sid)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS cert_orders(sid TEXT PRIMARY KEY, order_url TEXT NOT NULL, ' +
      'authz_url TEXT NOT NULL, chall_url TEXT, finalize_url TEXT NOT NULL, txt_id TEXT, csr TEXT NOT NULL, ' +
      'status TEXT NOT NULL, triggered REAL NOT NULL DEFAULT 0, created REAL NOT NULL)')
  ]);
  const cols = (await env.DB.prepare('PRAGMA table_info(server_creds)').all()).results.map((c) => c.name);
  if (!cols.includes('secure_port')) await env.DB.prepare('ALTER TABLE server_creds ADD COLUMN secure_port INTEGER NOT NULL DEFAULT 0').run();
  // Indirizzo pubblico del server (Tailscale Funnel): la PWA lo usa fuori casa
  const scols = (await env.DB.prepare('PRAGMA table_info(servers)').all()).results.map((c) => c.name);
  if (!scols.includes('public')) await env.DB.prepare("ALTER TABLE servers ADD COLUMN public TEXT NOT NULL DEFAULT ''").run();
  // Da quale rete (IP pubblico) arriva la presenza: chi apre l'app dalla stessa rete lo ha «in casa»
  if (!scols.includes('ip')) await env.DB.prepare("ALTER TABLE servers ADD COLUMN ip TEXT NOT NULL DEFAULT ''").run();
  certTables = true;
}

async function cfApi(env, method, path, payload) {
  const r = await fetch('https://api.cloudflare.com/client/v4/zones/' + env.CF_ZONE_ID + path, {
    method, headers: { Authorization: 'Bearer ' + env.CF_API_TOKEN, 'Content-Type': 'application/json' },
    body: payload ? JSON.stringify(payload) : undefined
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.success === false) throw new Error('Cloudflare DNS: errore ' + r.status);
  return j.result;
}

// I nomi del server (uno per indirizzo di casa) allineati con quelli voluti.
// Torna { lan: nome } (vuoto se non si puo'); gli errori non fermano la presenza.
async function syncServerDns(env, sid, lanIp) {
  if (!dnsOn(env)) return {};
  await ensureCertTables(env);
  const want = privateIPv4(lanIp) ? dashed(lanIp) + '.' + sid + '.' + env.SERVER_DOMAIN : '';
  const have = (await env.DB.prepare('SELECT name, ip, record_id FROM server_dns WHERE sid = ?').bind(sid).all()).results;
  try {
    for (const h of have) {
      if (h.name === want) continue;
      await cfApi(env, 'DELETE', '/dns_records/' + h.record_id).catch(() => null);
      await env.DB.prepare('DELETE FROM server_dns WHERE name = ?').bind(h.name).run();
    }
    if (want && !have.some((h) => h.name === want)) {
      const rec = await cfApi(env, 'POST', '/dns_records', { type: 'A', name: want, content: lanIp, ttl: 300, proxied: false });
      await env.DB.prepare('INSERT OR REPLACE INTO server_dns(name, sid, ip, record_id, t) VALUES(?,?,?,?,?)')
        .bind(want, sid, lanIp, String(rec.id), now()).run();
    }
  } catch (e) {
    return { error: String(e.message || e) };
  }
  return want ? { lan: want } : {};
}

async function dropServerDns(env, sid) {
  if (!dnsOn(env)) return;
  await ensureCertTables(env);
  const have = (await env.DB.prepare('SELECT name, record_id FROM server_dns WHERE sid = ?').bind(sid).all()).results;
  for (const h of have) await cfApi(env, 'DELETE', '/dns_records/' + h.record_id).catch(() => null);
  await env.DB.prepare('DELETE FROM server_dns WHERE sid = ?').bind(sid).run();
}

// -- ACME (RFC 8555), il minimo per un certificato con verifica DNS-01

let acmeDirCache = null;
async function acmeDir(env) {
  const url = env.ACME_DIRECTORY || ACME_LE;
  if (!acmeDirCache || acmeDirCache.url !== url) {
    const r = await fetch(url);
    if (!r.ok) fail(502, "L'autorità dei certificati non risponde");
    acmeDirCache = { url, dir: await r.json() };
  }
  return acmeDirCache.dir;
}

async function acmeKeys(env) {
  let saved = await env.DB.prepare("SELECT v FROM kv WHERE k = 'acme'").first('v');
  if (!saved) {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const pub = await crypto.subtle.exportKey('jwk', kp.publicKey);
    const keys = { priv: await crypto.subtle.exportKey('jwk', kp.privateKey), pub: { crv: 'P-256', kty: 'EC', x: pub.x, y: pub.y } };
    await env.DB.prepare("INSERT OR IGNORE INTO kv(k, v) VALUES('acme', ?)").bind(JSON.stringify(keys)).run();
    saved = await env.DB.prepare("SELECT v FROM kv WHERE k = 'acme'").first('v');
  }
  return JSON.parse(saved);
}

async function acmeThumbprint(pub) {
  const canon = JSON.stringify({ crv: pub.crv, kty: pub.kty, x: pub.x, y: pub.y });
  return b64u(await crypto.subtle.digest('SHA-256', te.encode(canon)));
}

// POST firmato (payload null = POST-as-GET). Un nonce scaduto si riprova una volta.
async function acmePost(env, url, payload, opts = {}) {
  const dir = await acmeDir(env);
  const keys = await acmeKeys(env);
  const key = await crypto.subtle.importKey('jwk', keys.priv, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  for (let attempt = 0; attempt < 2; attempt++) {
    const nr = await fetch(dir.newNonce, { method: 'HEAD' });
    const prot = { alg: 'ES256', nonce: nr.headers.get('Replay-Nonce'), url };
    if (opts.jwk) prot.jwk = keys.pub;
    else prot.kid = keys.kid;
    const p = b64u(te.encode(JSON.stringify(prot)));
    const pl = payload === null ? '' : b64u(te.encode(JSON.stringify(payload)));
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te.encode(p + '.' + pl));
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/jose+json', Accept: opts.accept || 'application/json' },
      body: JSON.stringify({ protected: p, payload: pl, signature: b64u(sig) })
    });
    if (r.status === 400 && attempt === 0) {
      const j = await r.clone().json().catch(() => ({}));
      if (j.type === 'urn:ietf:params:acme:error:badNonce') continue;
    }
    return r;
  }
}

async function acmeJson(r, what) {
  const j = await r.json().catch(() => ({}));
  if (!r.ok) fail(502, what + ': ' + (j.detail || 'errore ' + r.status));
  return j;
}

// L'account di questo servizio presso l'autorita': si crea una volta (accettando le condizioni)
async function acmeAccount(env) {
  const keys = await acmeKeys(env);
  if (keys.kid) return keys;
  const dir = await acmeDir(env);
  const payload = { termsOfServiceAgreed: true };
  if (env.ACME_EMAIL) payload.contact = ['mailto:' + env.ACME_EMAIL];
  const r = await acmePost(env, dir.newAccount, payload, { jwk: true });
  await acmeJson(r, 'Account per i certificati');
  keys.kid = r.headers.get('Location');
  if (!keys.kid) fail(502, "L'autorità dei certificati non ha dato l'account");
  await env.DB.prepare("UPDATE kv SET v = ? WHERE k = 'acme'").bind(JSON.stringify(keys)).run();
  return keys;
}

async function dropOrder(env, o) {
  if (o.txt_id) await cfApi(env, 'DELETE', '/dns_records/' + o.txt_id).catch(() => null);
  await env.DB.prepare('DELETE FROM cert_orders WHERE sid = ?').bind(o.sid).run();
}

// Avvia la richiesta di *.<sid>.<dominio>: ordine, record TXT della verifica.
async function certStart(env, srv, csr) {
  if (!certOn(env)) fail(404, 'I certificati non sono attivi nel servizio account');
  if (!/^[A-Za-z0-9_-]{100,4000}$/.test(String(csr || ''))) fail(400, 'Richiesta di certificato non valida');
  await ensureCertTables(env);
  const old = await env.DB.prepare('SELECT * FROM cert_orders WHERE sid = ?').bind(srv.sid).first();
  if (old && now() - old.created < ORDER_TTL) return { status: 'pending', retry: 15 };
  if (old) await dropOrder(env, old);
  await acmeAccount(env);
  const dir = await acmeDir(env);
  const name = '*.' + srv.sid + '.' + env.SERVER_DOMAIN;
  const r = await acmePost(env, dir.newOrder, { identifiers: [{ type: 'dns', value: name }] });
  const order = await acmeJson(r, 'Ordine del certificato');
  const orderUrl = r.headers.get('Location');
  const authzUrl = (order.authorizations || [])[0];
  if (!orderUrl || !authzUrl || !order.finalize) fail(502, 'Ordine del certificato incompleto');
  const authz = await acmeJson(await acmePost(env, authzUrl, null), 'Verifica del certificato');
  let challUrl = null;
  let txtId = null;
  if (authz.status !== 'valid') {
    const ch = (authz.challenges || []).find((c) => c.type === 'dns-01');
    if (!ch) fail(502, 'Verifica DNS non offerta');
    const keys = await acmeKeys(env);
    const value = b64u(await crypto.subtle.digest('SHA-256', te.encode(ch.token + '.' + await acmeThumbprint(keys.pub))));
    try {
      const rec = await cfApi(env, 'POST', '/dns_records', {
        type: 'TXT', name: '_acme-challenge.' + srv.sid + '.' + env.SERVER_DOMAIN, content: value, ttl: 60
      });
      txtId = String(rec.id);
    } catch (e) {
      fail(502, String(e.message || e));
    }
    challUrl = ch.url;
  }
  await env.DB.prepare('INSERT OR REPLACE INTO cert_orders(sid, order_url, authz_url, chall_url, finalize_url, txt_id, csr, ' +
    'status, triggered, created) VALUES(?,?,?,?,?,?,?,?,0,?)')
    .bind(srv.sid, orderUrl, authzUrl, challUrl, order.finalize, txtId, csr, challUrl ? 'pending' : 'ready', now()).run();
  return { status: 'pending', retry: 15 };
}

// Un passo avanti: verifica, poi firma, poi il certificato. Il server chiama ogni ~15 s.
async function certPoll(env, srv) {
  if (!certOn(env)) fail(404, 'I certificati non sono attivi nel servizio account');
  await ensureCertTables(env);
  const o = await env.DB.prepare('SELECT * FROM cert_orders WHERE sid = ?').bind(srv.sid).first();
  if (!o) fail(404, 'Nessuna richiesta di certificato in corso');
  const gone = async (error) => { await dropOrder(env, o); return { status: 'invalid', error }; };
  if (now() - o.created > ORDER_TTL) return gone('Richiesta scaduta');
  await acmeAccount(env);
  if (o.status === 'pending') {
    // Il record TXT ha bisogno di qualche secondo per arrivare ai DNS di Cloudflare
    if (!o.triggered) {
      if (now() - o.created < 10) return { status: 'pending', retry: 10 };
      await acmeJson(await acmePost(env, o.chall_url, {}), 'Verifica del certificato');
      await env.DB.prepare('UPDATE cert_orders SET triggered = ? WHERE sid = ?').bind(now(), o.sid).run();
      return { status: 'pending', retry: 10 };
    }
    const authz = await acmeJson(await acmePost(env, o.authz_url, null), 'Verifica del certificato');
    if (authz.status === 'invalid') {
      const ch = (authz.challenges || []).find((c) => c.type === 'dns-01') || {};
      return gone('Verifica non riuscita' + (ch.error && ch.error.detail ? ': ' + ch.error.detail : ''));
    }
    if (authz.status !== 'valid') return { status: 'pending', retry: 10 };
    o.status = 'ready';
  }
  if (o.status === 'ready') {
    const fin = await acmePost(env, o.finalize_url, { csr: o.csr });
    const j = await fin.json().catch(() => ({}));
    if (!fin.ok) return gone('Firma del certificato rifiutata: ' + (j.detail || fin.status));
    await env.DB.prepare("UPDATE cert_orders SET status = 'finalizing' WHERE sid = ?").bind(o.sid).run();
    o.status = 'finalizing';
  }
  const order = await acmeJson(await acmePost(env, o.order_url, null), 'Stato del certificato');
  if (order.status === 'invalid') return gone('Certificato rifiutato');
  if (order.status !== 'valid' || !order.certificate) return { status: 'pending', retry: 5 };
  const cr = await acmePost(env, order.certificate, null, { accept: 'application/pem-certificate-chain' });
  if (!cr.ok) return { status: 'pending', retry: 15 };
  const pem = await cr.text();
  await dropOrder(env, o);
  return { status: 'valid', cert: pem };
}

function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return hex(a);
}

async function sha256(text) {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

function sameString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function cleanName(raw) {
  const name = String(raw || '').trim();
  if (!/^[A-Za-z0-9._-]{2,32}$/.test(name)) {
    fail(400, 'Nome utente: da 2 a 32 caratteri tra lettere, numeri, punto, trattino e trattino basso');
  }
  return name;
}

// Gli account invitati dall'amministratore nascono con un nome provvisorio
// (invito-xxxxxx): al primo accesso la persona sceglie il suo, insieme alla password.
const pendingName = (name) => /^invito-[0-9a-f]{6}$/i.test(String(name || ''));

function cleanVerifier(raw) {
  const v = String(raw || '');
  if (!/^[0-9a-f]{64}$/.test(v)) fail(400, 'Richiesta non valida');
  return v;
}

async function body(request) {
  try {
    const b = await request.json();
    return b && typeof b === 'object' ? b : {};
  } catch (e) {
    return {};
  }
}

function userJson(u) {
  return { id: u.id, username: u.username, admin: !!u.admin, must_change: !!u.must_change,
    google: u.google_sub ? (u.google_email || 'collegato') : '', no_password: !!u.no_password,
    email: u.email || '', needs_name: pendingName(u.username) };
}

// kind: che cosa e' entrato (server, pwa, tv, app, browser; vedi SESSION_KINDS)
async function newSession(env, user, device, kind) {
  if (user.disabled) fail(403, "Questo account è disattivato: chiedi all'amministratore");
  await ensureSessionCols(env);
  const token = randomHex(32);
  const t = now();
  await env.DB.prepare('INSERT INTO sessions(token_hash, user_id, device, created, last_seen, kind) VALUES(?,?,?,?,?,?)')
    .bind(await sha256(token), user.id, String(device || '').slice(0, 80), t, t, sessionKind(kind)).run();
  return token;
}

async function auth(request, env) {
  const m = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.get('Authorization') || '');
  if (!m) fail(401, 'Accesso scaduto: rientra');
  const th = await sha256(m[1]);
  const u = await env.DB.prepare(
    'SELECT u.*, s.token_hash, s.last_seen, s.device AS s_device FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?'
  ).bind(th).first();
  if (!u) fail(401, 'Accesso scaduto: rientra');
  if (u.disabled) fail(403, "Questo account è disattivato: chiedi all'amministratore");
  if (now() - u.last_seen > SESSION_IDLE) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(th).run();
    fail(401, 'Accesso scaduto: rientra');
  }
  if (now() - u.last_seen > 3600) {
    await env.DB.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').bind(now(), th).run();
  }
  return u;
}

async function checkPassword(env, user, verifier) {
  if (user.locked_until > now()) {
    fail(429, 'Troppe password sbagliate: riprova tra qualche minuto');
  }
  const ok = sameString(await sha256(user.salt + verifier), user.hash);
  if (!ok) {
    const fails = user.fails + 1;
    const locked = fails >= LOCK_FAILS ? now() + LOCK_SECONDS : 0;
    await env.DB.prepare('UPDATE users SET fails = ?, locked_until = ? WHERE id = ?')
      .bind(locked ? 0 : fails, locked, user.id).run();
    fail(401, 'Nome utente o password sbagliati');
  }
  if (user.fails || user.locked_until) {
    await env.DB.prepare('UPDATE users SET fails = 0, locked_until = 0 WHERE id = ?').bind(user.id).run();
  }
}

async function passwordFields(verifier) {
  const salt = randomHex(16);
  return { salt, hash: await sha256(salt + verifier) };
}

// ---- Tailscale (rete di BunkerPlex)

const DEVICE_LIMIT = 4;       // dispositivi per account nella rete (100 in tutto nel piano gratuito)

// Tabella dei dispositivi entrati con una chiave di questo servizio: a chi
// appartengono e come si chiamano. Si crea da sola alla prima chiamata.
let devicesTable = false;
async function ensureDevices(env) {
  if (devicesTable) return;
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS ts_devices(host TEXT PRIMARY KEY, user_id INTEGER NOT NULL, ' +
    'label TEXT, kind TEXT, t REAL NOT NULL)').run();
  devicesTable = true;
}

function cleanHost(raw) {
  const h = String(raw || '').toLowerCase();
  return /^[a-z0-9][a-z0-9-]{2,62}$/.test(h) ? h : '';
}

async function tsAccess(env) {
  if (!env.TS_OAUTH_ID || !env.TS_OAUTH_SECRET) fail(404, 'Tailscale non configurato nel servizio account');
  const form = new URLSearchParams({ client_id: env.TS_OAUTH_ID, client_secret: env.TS_OAUTH_SECRET, grant_type: 'client_credentials' });
  const tr = await fetch('https://api.tailscale.com/api/v2/oauth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form
  });
  const access = tr.ok ? (await tr.json()).access_token : '';
  if (!access) fail(502, 'Tailscale non ha accettato le credenziali del servizio account');
  return { access, tag: env.TS_TAG || 'tag:bunkerplex' };
}

// I dispositivi dell'account presenti adesso in Tailscale. null se Tailscale non
// lascia leggere l'elenco (manca il permesso «Devices: Core»): allora niente limite.
async function userDevices(env, ts, uid) {
  const rows = (await env.DB.prepare('SELECT host, label, kind, t FROM ts_devices WHERE user_id = ?').bind(uid).all()).results;
  const r = await fetch('https://api.tailscale.com/api/v2/tailnet/-/devices', {
    headers: { Authorization: 'Bearer ' + ts.access }
  });
  if (!r.ok) return null;
  const list = (await r.json()).devices || [];
  const out = [];
  for (const d of list) {
    const hn = String(d.hostname || '').toLowerCase();
    const row = rows.find((x) => sameHost(hn, x.host));
    if (!row) continue;
    out.push({
      id: String(d.nodeId || d.id), host: row.host, hostname: hn, label: row.label || hn,
      kind: row.kind || 'app', seen: d.lastSeen || '', online: d.connectedToControl === true, os: d.os || ''
    });
  }
  return out;
}

// Tailscale aggiunge "-1", "-2"... se il nome c'e' gia'
function sameHost(hn, host) {
  return hn === host || (hn.startsWith(host + '-') && /^\d+$/.test(hn.slice(host.length + 1)));
}

// true se un dispositivo con quel nome e' adesso nella rete, false se no,
// null se Tailscale non lascia leggere l'elenco.
async function tsHostInUse(ts, host) {
  const r = await fetch('https://api.tailscale.com/api/v2/tailnet/-/devices', {
    headers: { Authorization: 'Bearer ' + ts.access }
  });
  if (!r.ok) return null;
  return ((await r.json()).devices || []).some((d) => sameHost(String(d.hostname || '').toLowerCase(), host));
}

async function tsDeleteDevice(ts, d) {
  const r = await fetch('https://api.tailscale.com/api/v2/device/' + encodeURIComponent(d.id), {
    method: 'DELETE', headers: { Authorization: 'Bearer ' + ts.access }
  });
  if (!r.ok && r.status !== 404) fail(502, 'Tailscale non ha tolto il dispositivo (errore ' + r.status + ')');
}

// ---- Passkey: entrare con impronta, volto o PIN del dispositivo (WebAuthn)
//
// Dalla PWA di questo servizio (l'indirizzo delle passkey e' il suo nome: sui server
// di casa non valgono). Si aggiunge una passkey da Impostazioni → Account (o subito
// dopo essere entrati con la password); poi «Entra con impronta o volto» non chiede
// niente: il dispositivo propone le passkey dell'account e ne controlla l'identita'
// (userVerification: required). Qui resta solo la chiave pubblica.
// /passkeys/login/start e /passkeys/register/start danno una sfida a uso singolo
// (PASSKEY_TTL); /finish controlla firma, sfida, indirizzo e contatore.

const PASSKEY_TTL = 300;
const PASSKEY_MAX = 10;          // passkey per account

let passkeyTables = false;
async function ensurePasskeys(env) {
  if (passkeyTables) return;
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS passkeys(id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, jwk TEXT NOT NULL, ' +
    'alg INTEGER NOT NULL, counter INTEGER NOT NULL DEFAULT 0, label TEXT, created REAL NOT NULL, used REAL)').run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS passkeys_user ON passkeys(user_id)').run();
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS passkey_challenges(hash TEXT PRIMARY KEY, user_id INTEGER, exp REAL NOT NULL)').run();
  passkeyTables = true;
}

// CBOR (RFC 8949), quanto basta per l'oggetto di attestazione e la chiave COSE
function cbor(bytes) {
  let p = 0;
  const len = (info) => {
    if (info < 24) return info;
    let n = 0;
    const size = { 24: 1, 25: 2, 26: 4, 27: 8 }[info];
    if (!size) throw new Error('cbor');
    for (let i = 0; i < size; i++) n = n * 256 + bytes[p++];
    return n;
  };
  const item = () => {
    if (p >= bytes.length) throw new Error('cbor');
    const b = bytes[p++];
    const major = b >> 5;
    const info = b & 31;
    if (major === 7) return { 20: false, 21: true, 22: null }[info];
    const n = len(info);
    if (major === 0) return n;
    if (major === 1) return -1 - n;
    if (major === 2) { const v = bytes.slice(p, p + n); p += n; return v; }
    if (major === 3) { const v = new TextDecoder().decode(bytes.slice(p, p + n)); p += n; return v; }
    if (major === 4) { const a = []; for (let i = 0; i < n; i++) a.push(item()); return a; }
    if (major === 5) { const m = new Map(); for (let i = 0; i < n; i++) { const k = item(); m.set(k, item()); } return m; }
    throw new Error('cbor');
  };
  const v = item();
  return { value: v, end: p };
}

// I dati dell'autenticatore: impronta dell'indirizzo, segnali, contatore (e la chiave, alla creazione)
function authData(bytes) {
  if (bytes.length < 37) throw new Error('authData');
  const flags = bytes[32];
  const out = { rpHash: bytes.slice(0, 32), up: !!(flags & 1), uv: !!(flags & 4),
    counter: ((bytes[33] << 24) >>> 0) + (bytes[34] << 16) + (bytes[35] << 8) + bytes[36] };
  if (flags & 64) {
    const idLen = (bytes[53] << 8) + bytes[54];
    out.credId = bytes.slice(55, 55 + idLen);
    out.cose = cbor(bytes.slice(55 + idLen)).value;
  }
  return out;
}

// Chiave COSE → JWK per WebCrypto: ES256 (-7) o RS256 (-257)
function coseJwk(m) {
  const alg = m.get(3);
  if (alg === -7 && m.get(1) === 2 && m.get(-1) === 1) {
    return { alg, jwk: { kty: 'EC', crv: 'P-256', x: b64url(m.get(-2)), y: b64url(m.get(-3)) } };
  }
  if (alg === -257 && m.get(1) === 3) {
    return { alg, jwk: { kty: 'RSA', n: b64url(m.get(-1)), e: b64url(m.get(-2)) } };
  }
  fail(400, 'Questo dispositivo usa un tipo di passkey che BunkerPlex non conosce');
}

// Firma ECDSA in DER (come la danno gli autenticatori) → r||s (come la vuole WebCrypto)
function derToRaw(der) {
  let p = 2;
  if (der[0] !== 0x30) throw new Error('der');
  if (der[1] & 0x80) p = 2 + (der[1] & 0x7f);
  const int = () => {
    if (der[p++] !== 0x02) throw new Error('der');
    const n = der[p++];
    let v = der.slice(p, p + n);
    p += n;
    while (v.length > 32 && v[0] === 0) v = v.slice(1);
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return out;
  };
  const r = int();
  const s = int();
  const raw = new Uint8Array(64);
  raw.set(r, 0);
  raw.set(s, 32);
  return raw;
}

async function passkeyVerify(row, data, sig) {
  const jwk = JSON.parse(row.jwk);
  if (row.alg === -7) {
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    let raw;
    try { raw = derToRaw(sig); } catch (e) { return false; }
    return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, raw, data);
  }
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, data);
}

async function newChallenge(env, userId) {
  await env.DB.prepare('DELETE FROM passkey_challenges WHERE exp < ?').bind(now()).run();
  // Tante sfide aperte (anche da chi prova a riempire): via le piu' vecchie, mai un rifiuto per tutti
  const n = await env.DB.prepare('SELECT COUNT(*) n FROM passkey_challenges').first('n');
  if (n >= 500) {
    await env.DB.prepare('DELETE FROM passkey_challenges WHERE hash IN (SELECT hash FROM passkey_challenges ORDER BY exp LIMIT ?)')
      .bind(n - 499).run();
  }
  const c = new Uint8Array(32);
  crypto.getRandomValues(c);
  const challenge = b64url(c);
  await env.DB.prepare('INSERT INTO passkey_challenges(hash, user_id, exp) VALUES(?,?,?)')
    .bind(await sha256(challenge), userId || null, now() + PASSKEY_TTL).run();
  return challenge;
}

// clientDataJSON: tipo giusto, la sfida data da qui (una volta sola), questo indirizzo
async function checkClient(env, url, raw, type, userId) {
  let cd = null;
  try { cd = JSON.parse(new TextDecoder().decode(b64urlBytes(raw))); } catch (e) { cd = null; }
  if (!cd || cd.type !== type || cd.origin !== url.origin || typeof cd.challenge !== 'string') fail(400, 'Passkey non valida');
  const h = await sha256(cd.challenge);
  const row = await env.DB.prepare('SELECT * FROM passkey_challenges WHERE hash = ?').bind(h).first();
  // Una volta sola: vale solo per chi la cancella davvero (due richieste insieme: una perde)
  const del = await env.DB.prepare('DELETE FROM passkey_challenges WHERE hash = ?').bind(h).run();
  const gone = del && del.meta && typeof del.meta.changes === 'number' ? del.meta.changes : 1;
  if (!row || gone !== 1 || row.exp < now() || (userId && row.user_id !== userId)) fail(400, 'Tempo scaduto: riprova');
}

const passkeyJson = (r) => ({ id: r.id, label: r.label || 'Passkey', created: r.created, used: r.used || null });

async function passkeyRoutes(request, env, url, path, method) {
  if (!path.startsWith('/passkeys')) return null;
  await ensurePasskeys(env);
  const rpId = url.hostname;

  // Entrare: la sfida (senza account: il dispositivo propone le sue passkey)
  if (path === '/passkeys/login/start' && method === 'POST') {
    return json({ challenge: await newChallenge(env, null), rpId, timeout: PASSKEY_TTL * 1000 });
  }
  if (path === '/passkeys/login/finish' && method === 'POST') {
    const b = await body(request);
    const row = await env.DB.prepare('SELECT * FROM passkeys WHERE id = ?').bind(String(b.id || '').slice(0, 400)).first();
    await checkClient(env, url, b.clientDataJSON, 'webauthn.get', null);
    if (!row) fail(401, 'Questa passkey non è più valida: entra con la password e aggiungila di nuovo');
    let ad;
    try { ad = authData(b64urlBytes(b.authenticatorData)); } catch (e) { fail(400, 'Passkey non valida'); }
    const rpHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rpId)));
    if (b64url(ad.rpHash) !== b64url(rpHash) || !ad.up || !ad.uv) fail(401, 'Il dispositivo non ha confermato che sei tu');
    const cdHash = new Uint8Array(await crypto.subtle.digest('SHA-256', b64urlBytes(b.clientDataJSON)));
    // Firmati: i dati dell'autenticatore seguiti dall'impronta di clientDataJSON
    const adBytes = b64urlBytes(b.authenticatorData);
    const data = new Uint8Array(adBytes.length + 32);
    data.set(adBytes, 0);
    data.set(cdHash, adBytes.length);
    if (!(await passkeyVerify(row, data, b64urlBytes(b.signature)))) fail(401, 'Passkey non valida');
    // Contatore: se il dispositivo lo usa, deve crescere (una copia clonata resta indietro)
    if (row.counter && ad.counter <= row.counter) fail(401, 'Passkey non valida: toglila e aggiungila di nuovo');
    await env.DB.prepare('UPDATE passkeys SET counter = ?, used = ? WHERE id = ?').bind(ad.counter, now(), row.id).run();
    const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(row.user_id).first();
    if (!user) fail(401, 'Account non trovato');
    if (user.disabled) fail(403, "Questo account è disattivato: chiedi all'amministratore");
    if (user.fails || user.locked_until) {
      await env.DB.prepare('UPDATE users SET fails = 0, locked_until = 0 WHERE id = ?').bind(user.id).run();
    }
    return json({ token: await newSession(env, user, b.device, b.kind), user: userJson(user) });
  }

  const u = await auth(request, env);

  if (path === '/passkeys' && method === 'GET') {
    const rows = (await env.DB.prepare('SELECT * FROM passkeys WHERE user_id = ? ORDER BY created').bind(u.id).all()).results;
    return json({ passkeys: rows.map(passkeyJson) });
  }

  // Aggiungere: la sfida, con l'account e le passkey che ha gia' (per non farne due sullo stesso dispositivo)
  if (path === '/passkeys/register/start' && method === 'POST') {
    const rows = (await env.DB.prepare('SELECT id FROM passkeys WHERE user_id = ?').bind(u.id).all()).results;
    if (rows.length >= PASSKEY_MAX) fail(409, 'Hai già ' + PASSKEY_MAX + ' passkey: togline una prima');
    return json({
      challenge: await newChallenge(env, u.id), rp: { id: rpId, name: 'BunkerPlex' },
      user: { id: b64url(new TextEncoder().encode('bp-' + u.id)), name: u.email || u.google_email || u.username, displayName: u.username },
      exclude: rows.map((r) => r.id), timeout: PASSKEY_TTL * 1000
    });
  }
  if (path === '/passkeys/register/finish' && method === 'POST') {
    const b = await body(request);
    await checkClient(env, url, b.clientDataJSON, 'webauthn.create', u.id);
    let att;
    try { att = cbor(b64urlBytes(b.attestationObject)).value; } catch (e) { att = null; }
    if (!(att instanceof Map) || !(att.get('authData') instanceof Uint8Array)) fail(400, 'Passkey non valida');
    let ad;
    try { ad = authData(att.get('authData')); } catch (e) { fail(400, 'Passkey non valida'); }
    const rpHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rpId)));
    if (b64url(ad.rpHash) !== b64url(rpHash) || !ad.up || !ad.uv || !ad.credId || !(ad.cose instanceof Map)) {
      fail(400, 'Il dispositivo non ha confermato che sei tu');
    }
    const key = coseJwk(ad.cose);
    const id = b64url(ad.credId);
    if (id.length > 400) fail(400, 'Passkey non valida');
    const taken = await env.DB.prepare('SELECT user_id FROM passkeys WHERE id = ?').bind(id).first();
    if (taken) fail(409, 'Questa passkey c\'è già');
    const label = String(b.label || '').trim().slice(0, 60) || 'Passkey';
    await env.DB.prepare('INSERT INTO passkeys(id, user_id, jwk, alg, counter, label, created) VALUES(?,?,?,?,?,?,?)')
      .bind(id, u.id, JSON.stringify(key.jwk), key.alg, ad.counter, label, now()).run();
    return json({ ok: true, passkey: passkeyJson({ id, label, created: now() }) });
  }

  const del = /^\/passkeys\/([A-Za-z0-9_-]{1,400})$/.exec(path);
  if (del && method === 'DELETE') {
    await env.DB.prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?').bind(del[1], u.id).run();
    return json({ ok: true });
  }
  return null;
}

// ---- La TV entra dal telefono
//
// Sulla TV non si scrive mai una password. La TV chiede un codice (/tv/start, senza
// account) e mostra un QR con l'indirizzo della PWA (/#/tv/<codice>) e il codice da
// scrivere a mano (/tv sul telefono). Dal telefono si entra nella PWA come sempre
// (password, Google, link via email...) e si conferma (POST /tv/<codice>). La TV,
// che intanto chiede ogni 2-3 secondi con il suo segreto (/tv/poll, che non sta nel
// QR), riceve il gettone dell'account: una sessione nuova di tipo «tv».

const TV_TTL = 600;

let tvTable = false;
async function ensureTvLinks(env) {
  if (tvTable) return;
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS tv_links(code TEXT PRIMARY KEY, poll_hash TEXT NOT NULL, ' +
    'device TEXT, user_id INTEGER, exp REAL NOT NULL)').run();
  // seen: il telefono ha aperto il QR o il codice (la TV lo dice)
  const cols = (await env.DB.prepare('PRAGMA table_info(tv_links)').all()).results.map((c) => c.name);
  if (!cols.includes('seen')) await env.DB.prepare('ALTER TABLE tv_links ADD COLUMN seen INTEGER').run();
  tvTable = true;
}

async function tvLink(env, raw) {
  await ensureTvLinks(env);
  const code = cleanCode(raw);
  const r = code.length === 8 ? await env.DB.prepare('SELECT * FROM tv_links WHERE code = ?').bind(code).first() : null;
  if (!r || r.exp < now()) fail(404, 'Codice sbagliato o scaduto: sulla TV ne compare uno nuovo');
  return r;
}

// Senza account: la TV chiede il codice e poi se e' stato confermato
async function tvPublicRoutes(request, env, url, path, method) {
  if (path === '/tv/start' && method === 'POST') {
    await ensureTvLinks(env);
    const b = await body(request);
    await env.DB.prepare('DELETE FROM tv_links WHERE exp < ?').bind(now()).run();
    const n = await env.DB.prepare('SELECT COUNT(*) n FROM tv_links').first('n');
    if (n > 300) fail(429, 'Troppe TV in attesa: riprova tra qualche minuto');
    const a = new Uint8Array(8);
    crypto.getRandomValues(a);
    const code = [...a].map((x) => CODE_CHARS[x % CODE_CHARS.length]).join('');
    const poll = randomHex(32);
    await env.DB.prepare('INSERT INTO tv_links(code, poll_hash, device, exp) VALUES(?,?,?,?)')
      .bind(code, await sha256(poll), String(b.device || 'TV').slice(0, 80), now() + TV_TTL).run();
    return json({ code, poll, url: url.origin + '/#/tv/' + code, short: url.origin + '/tv', ttl: TV_TTL });
  }
  // Confermato? Il gettone si consegna una volta sola
  if (path === '/tv/poll' && method === 'POST') {
    await ensureTvLinks(env);
    const ph = await sha256(String((await body(request)).poll || ''));
    const r = await env.DB.prepare('SELECT * FROM tv_links WHERE poll_hash = ?').bind(ph).first();
    if (!r || r.exp < now()) fail(404, 'Codice scaduto');
    if (!r.user_id) return json({ done: false, seen: !!r.seen });
    await env.DB.prepare('DELETE FROM tv_links WHERE code = ?').bind(r.code).run();
    const u = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(r.user_id).first();
    if (!u) fail(404, 'Account non trovato');
    return json({ done: true, token: await newSession(env, u, r.device, 'tv'), user: userJson(u) });
  }
  // Il telefono ha aperto il codice (anche prima di entrare): la TV scrive «Continua sul telefono»
  const sm = /^\/tv\/([A-Za-z0-9-]{1,12})\/seen$/.exec(path);
  if (sm && method === 'POST') {
    const r = await tvLink(env, sm[1]);
    if (!r.seen) await env.DB.prepare('UPDATE tv_links SET seen = 1 WHERE code = ?').bind(r.code).run();
    return json({ ok: true });
  }
  // L'indirizzo da scrivere a mano (o quello del QR aperto senza la PWA): la pagina giusta della PWA
  const pm = /^\/tv(?:\/([A-Za-z0-9-]{1,12}))?$/.exec(path);
  if (pm && method === 'GET' && !request.headers.get('Authorization')) {
    return new Response(null, { status: 302, headers: { Location: url.origin + '/#/tv' + (pm[1] ? '/' + cleanCode(pm[1]) : ''),
      'Cache-Control': 'no-store' } });
  }
  return null;
}

// Dal telefono, con l'account: quale TV e' (per mostrarlo prima di confermare) e la conferma
async function tvUserRoutes(request, env, path, method, user) {
  const m = /^\/tv\/([A-Za-z0-9-]{1,12})$/.exec(path);
  if (!m) return null;
  const r = await tvLink(env, m[1]);
  if (method === 'GET') return json({ code: r.code, device: r.device || 'TV', done: r.user_id === user.id, exp: Math.floor(r.exp) });
  if (method !== 'POST') return null;
  if (r.user_id && r.user_id !== user.id) fail(409, 'Questa TV è già stata collegata a un altro account');
  if (user.must_change) fail(409, 'Scegli prima la tua password');
  await env.DB.prepare('UPDATE tv_links SET user_id = ? WHERE code = ?').bind(user.id, r.code).run();
  return json({ ok: true, device: r.device || 'TV', user: userJson(user) });
}

// ---- Entra con Google
//
// Un solo flusso per tutti (browser, PWA, app sul telefono, TV), sul modello del
// «device flow»: chi vuole entrare chiede qui un codice (/google/start) e ha un
// indirizzo da aprire (/g/<codice>), sullo stesso dispositivo o, dalla TV, col QR
// sul telefono. Lì si sceglie l'account Google; Google torna qui (/google/callback),
// e chi aveva chiesto il codice, che intanto domanda ogni 2 secondi (/google/poll
// con il suo segreto, che non sta nel QR), riceve il gettone dell'account.
// Google parla solo con questo servizio: l'indirizzo da registrare è uno
// (https://<servizio>/google/callback), qualunque sia l'indirizzo del PC di casa.
//
// Un account Google entra solo in un account BunkerPlex già esistente: collegato
// da Impostazioni → Account (link) o indicato dall'amministratore con la sua email
// (si lega al primo accesso; se l'account aveva ancora la password provvisoria,
// quella non vale più e l'account entra con Google).

const GOOGLE_TTL = 600;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const googleOn = (env) => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);

let googleCols = false;
async function ensureGoogle(env) {
  if (googleCols) return;
  const cols = (await env.DB.prepare('PRAGMA table_info(users)').all()).results.map((c) => c.name);
  if (!cols.includes('google_sub')) await env.DB.prepare('ALTER TABLE users ADD COLUMN google_sub TEXT').run();
  if (!cols.includes('google_email')) await env.DB.prepare('ALTER TABLE users ADD COLUMN google_email TEXT').run();
  if (!cols.includes('no_password')) await env.DB.prepare('ALTER TABLE users ADD COLUMN no_password INTEGER NOT NULL DEFAULT 0').run();
  if (!cols.includes('email')) await env.DB.prepare('ALTER TABLE users ADD COLUMN email TEXT').run();
  if (!cols.includes('disabled')) await env.DB.prepare('ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0').run();
  await env.DB.prepare('CREATE UNIQUE INDEX IF NOT EXISTS users_google ON users(google_sub)').run();
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS google_flows(code TEXT PRIMARY KEY, poll_hash TEXT NOT NULL, ' +
    'state TEXT, link_user INTEGER, device TEXT, kind TEXT, user_id INTEGER, email TEXT, error TEXT, exp REAL NOT NULL)').run();
  // Proposta di collegamento: Google con la stessa email di un account non ancora collegato
  const fcols = (await env.DB.prepare('PRAGMA table_info(google_flows)').all()).results.map((c) => c.name);
  if (!fcols.includes('offer_user')) await env.DB.prepare('ALTER TABLE google_flows ADD COLUMN offer_user INTEGER').run();
  if (!fcols.includes('offer_sub')) await env.DB.prepare('ALTER TABLE google_flows ADD COLUMN offer_sub TEXT').run();
  if (!fcols.includes('offer_hash')) await env.DB.prepare('ALTER TABLE google_flows ADD COLUMN offer_hash TEXT').run();
  // PKCE e nonce del giro con Google; hint: l'email gia' scritta; back: dove tornare
  // dopo (stesso dispositivo); seen: la pagina del codice e' stata aperta; note:
  // l'ultimo tentativo non riuscito (si puo' riprovare con un altro account Google)
  for (const c of ['pkce TEXT', 'nonce TEXT', 'hint TEXT', 'back TEXT', 'seen INTEGER', 'note TEXT']) {
    if (!fcols.includes(c.split(' ')[0])) await env.DB.prepare('ALTER TABLE google_flows ADD COLUMN ' + c).run();
  }
  googleCols = true;
}

function cleanEmail(raw) {
  const e = String(raw || '').trim().toLowerCase();
  if (!e) return '';
  if (e.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) fail(400, 'Email non valida');
  return e;
}

// Email per entrare con email e password: una sola per account, e non quella di un altro
async function emailFree(env, email, id) {
  const other = await env.DB.prepare('SELECT id FROM users WHERE (email = ? OR google_email = ?) AND id <> ?')
    .bind(email, email, id || 0).first();
  if (other) fail(409, 'Questa email è già di un altro account');
}

// Il nome utente di un'email. L'impronta della password si calcola sul nome utente,
// quindi il server di casa prima chiede questo. Per un'email sconosciuta torna un nome
// finto ma sempre uguale: da fuori non si capisce quali email hanno un account.
async function nameForEmail(env, email) {
  const u = await env.DB.prepare('SELECT username FROM users WHERE email = ?').bind(email).first() ||
    await env.DB.prepare('SELECT username FROM users WHERE google_email = ?').bind(email).first();
  if (u) return u.username;
  return 'x' + (await sha256('bunkerplex-email:' + (env.SETUP_KEY || env.GOOGLE_CLIENT_SECRET || '') + email)).slice(0, 15);
}

function cleanCode(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function page(title, inner, status = 200) {
  const html = '<!doctype html><html lang="it"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(title) + ' · BunkerPlex</title>' +
    '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#060a07;' +
    'color:#f2f5f2;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}main{max-width:26rem;padding:2rem 1.2rem}' +
    'h1{font-size:1.5rem;margin:0 0 .8rem}p{color:#c9d3cc}b{color:#f2f5f2}.code{font:700 1.8rem/1 ui-monospace,monospace;letter-spacing:.15em;margin:1rem 0}' +
    'input{box-sizing:border-box;width:100%;font:700 1.4rem ui-monospace,monospace;letter-spacing:.12em;text-transform:uppercase;' +
    'padding:.7rem;border-radius:.5rem;border:1px solid #2c3a30;background:#0e1510;color:#f2f5f2;margin:.4rem 0 1rem}' +
    '.btn{display:inline-block;border:0;border-radius:.5rem;padding:.8rem 1.3rem;font:600 1rem system-ui,sans-serif;' +
    'background:#1a7f45;color:#fff;text-decoration:none;cursor:pointer}.err{color:#ff8f80}small{color:#9fada3}' +
    '.btn.ghost{background:transparent;border:1px solid #2c3a30;color:#f2f5f2}' +
    '.gbtn{display:flex;align-items:center;justify-content:center;gap:.7rem;width:100%;box-sizing:border-box;border:1px solid #dadce0;' +
    'border-radius:.5rem;padding:.8rem 1.2rem;background:#fff;color:#1f1f1f;font:600 1rem system-ui,sans-serif;cursor:pointer;margin:.4rem 0 1rem}' +
    '.gbtn:hover{background:#f1f3f4}.gbtn svg{width:1.25rem;height:1.25rem}' +
    '.brand{display:flex;align-items:center;gap:.55rem;margin-bottom:1.6rem;font:700 1.1rem system-ui,sans-serif}' +
    '.brand i{width:1.6rem;height:1.6rem;border-radius:.4rem;background:#1a7f45;display:inline-flex;align-items:center;justify-content:center}' +
    '.brand i:after{content:"";border-left:.55rem solid #fff;border-top:.35rem solid transparent;border-bottom:.35rem solid transparent;margin-left:.15rem}' +
    '.ok{width:3rem;height:3rem;border-radius:50%;background:#1a7f45;color:#fff;font:700 1.5rem/3rem system-ui;text-align:center;margin-bottom:1rem}' +
    'button:focus-visible,a:focus-visible,input:focus-visible{outline:3px solid #7fd6a0;outline-offset:2px}</style></head>' +
    '<body><main><div class="brand"><i></i><span>BunkerPlex</span></div>' + inner + '</main></body></html>';
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' } });
}

// Il pulsante di Google come lo vuole Google: bianco, con la «G» a colori
const G_LOGO = '<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>' +
  '<path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>' +
  '<path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>' +
  '<path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';

function gButton(label) {
  return '<button class="gbtn" autofocus>' + G_LOGO + '<span>' + esc(label) + '</span></button>';
}

function b64url(buf) {
  let s = '';
  for (const x of new Uint8Array(buf)) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlBytes(part) {
  const b = atob(String(part || '').replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(part || '').length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

function b64urlJson(part) {
  const b = atob(part.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((part.length + 3) % 4));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(b, (c) => c.charCodeAt(0))));
}

// ---- Password dimenticata: un codice di 6 cifre via email (Brevo)
//
// /reset/start {email} manda il codice all'email dell'account (risponde sempre ok,
// cosi' da fuori non si capisce quali email hanno un account). /reset/finish
// {email, code, verifier} controlla il codice e mette la password nuova: il server
// di casa calcola la verifica sul nome utente, che prima chiede a /resolve.

const RESET_TTL = 900;        // il codice vale 15 minuti
const RESET_TRIES = 5;        // codici sbagliati prima che scada
const RESET_GAP = 60;         // un'email al minuto al massimo per account

const resetOn = (env) => !!env.BREVO_API_KEY;

let resetTable = false;
async function ensureReset(env) {
  if (resetTable) return;
  await ensureGoogle(env);
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS reset_codes(user_id INTEGER PRIMARY KEY, code_hash TEXT NOT NULL, ' +
    'exp REAL NOT NULL, tries INTEGER NOT NULL DEFAULT 0, sent REAL NOT NULL)').run();
  resetTable = true;
}

async function userForEmail(env, email) {
  return await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first() ||
    await env.DB.prepare('SELECT * FROM users WHERE google_email = ?').bind(email).first();
}

async function sendMail(env, to, subject, text, html) {
  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': env.BREVO_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ sender: { name: 'BunkerPlex', email: env.MAIL_FROM || 'bunkerplex@outlook.it' },
      to: [{ email: to }], subject, textContent: text, htmlContent: html })
  });
  if (!r.ok) fail(502, 'Non riesco a mandare l\'email adesso: riprova tra poco');
}

// Il modello delle email: una scheda bianca, il nome in alto e la firma in fondo.
// Tabelle e stili in linea, perche' i programmi di posta ignorano il resto.
function mailPage(preview, inner) {
  const font = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  return '<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="color-scheme" content="light"><title>BunkerPlex</title></head>' +
    '<body style="margin:0;padding:0;background:#eef1ef">' +
    '<div style="display:none;max-height:0;overflow:hidden;opacity:0">' + esc(preview) + '</div>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1ef"><tr><td align="center" style="padding:40px 16px">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px">' +
    '<tr><td style="padding:0 4px 18px;font:700 20px/1 ' + font + ';letter-spacing:-.3px;color:#0f1a13">' +
    '<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:#1a7f45;margin-right:8px;vertical-align:1px"></span>BunkerPlex</td></tr>' +
    '<tr><td style="background:#ffffff;border-radius:14px;border:1px solid #e1e6e2;padding:36px 32px;font:16px/1.55 ' + font + ';color:#1d2420">' +
    inner + '</td></tr>' +
    '<tr><td style="padding:20px 4px 0;font:13px/1.5 ' + font + ';color:#7d8882">' +
    '<b style="color:#4a554f">BunkerPlex</b> · Only for bunkers</td></tr>' +
    '</table></td></tr></table></body></html>';
}

// I link delle email: aprono la PWA alla pagina giusta, con i campi gia' scritti
function mailLink(origin, page, params) {
  return origin + '/#/' + page + '?' + new URLSearchParams(params).toString();
}

function mailButton(href, label) {
  return '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0 0"><tr>' +
    '<td style="border-radius:10px;background:#1a7f45"><a href="' + esc(href) + '" style="display:inline-block;padding:13px 22px;' +
    'font:700 15px/1 -apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;color:#ffffff;text-decoration:none;border-radius:10px">' +
    esc(label) + '</a></td></tr></table>';
}

// Attivazione dall'invito: il link dell'email porta un gettone (valido ACTIVATE_TTL)
// che sostituisce la password provvisoria, cosi' la persona sceglie subito nome e password.
const ACTIVATE_TTL = 14 * 86400;

let activateTable = false;
async function ensureActivate(env) {
  if (activateTable) return;
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS activations(user_id INTEGER PRIMARY KEY, token_hash TEXT NOT NULL, exp REAL NOT NULL)').run();
  activateTable = true;
}

async function newActivation(env, userId) {
  await ensureActivate(env);
  const token = randomHex(24);
  await env.DB.prepare('INSERT OR REPLACE INTO activations(user_id, token_hash, exp) VALUES(?,?,?)')
    .bind(userId, await sha256(token), now() + ACTIVATE_TTL).run();
  return token;
}

// Link per entrare senza password («Mandami un link»): vale MAGIC_TTL e una volta sola.
// A un account ancora da attivare arriva invece il link di attivazione.
const MAGIC_TTL = 900;

let magicTable = false;
async function ensureMagic(env) {
  if (magicTable) return;
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS magic_links(user_id INTEGER PRIMARY KEY, token_hash TEXT NOT NULL, exp REAL NOT NULL, sent REAL NOT NULL)').run();
  magicTable = true;
}

async function magicStart(env, email, origin) {
  await ensureMagic(env);
  const user = await userForEmail(env, email);
  if (!user || user.disabled) return;
  const old = await env.DB.prepare('SELECT sent FROM magic_links WHERE user_id = ?').bind(user.id).first();
  if (old && now() - old.sent < RESET_GAP) return;
  if (user.must_change) {
    await env.DB.prepare('INSERT OR REPLACE INTO magic_links(user_id, token_hash, exp, sent) VALUES(?,?,?,?)')
      .bind(user.id, '-', 0, now()).run();
    const link = mailLink(origin, 'attiva', { email, t: await newActivation(env, user.id) });
    await sendMail(env, email, 'Attiva il tuo account BunkerPlex',
      'Ciao,\n\napri questo link per attivare il tuo account BunkerPlex (vale 14 giorni):\n' + link + '\n\n--\nBunkerPlex · Only for bunkers',
      mailPage('Attiva il tuo account', '<p style="margin:0 0 16px">Ciao,</p>' +
        '<p style="margin:0">tocca il pulsante per attivare il tuo account BunkerPlex: scegli nome e password e sei dentro.</p>' +
        mailButton(link, 'Attiva il tuo account') +
        '<p style="margin:24px 0 0;color:#5b6660;font-size:14px">Vale 14 giorni. Se non l\'hai chiesto tu, ignora questa email.</p>'));
    return;
  }
  const token = randomHex(24);
  await env.DB.prepare('INSERT OR REPLACE INTO magic_links(user_id, token_hash, exp, sent) VALUES(?,?,?,?)')
    .bind(user.id, await sha256(token), now() + MAGIC_TTL, now()).run();
  const link = mailLink(origin, 'entra', { email, t: token });
  await sendMail(env, email, 'Il tuo link per entrare in BunkerPlex',
    'Ciao ' + user.username + ',\n\napri questo link per entrare in BunkerPlex (vale 15 minuti, una volta sola):\n' + link +
    '\n\nSe non l\'hai chiesto tu, ignora questa email.\n\n--\nBunkerPlex · Only for bunkers',
    mailPage('Il tuo link per entrare', '<p style="margin:0 0 16px">Ciao <b>' + esc(user.username) + '</b>,</p>' +
      '<p style="margin:0">tocca il pulsante per entrare in BunkerPlex, senza password.</p>' +
      mailButton(link, 'Entra in BunkerPlex') +
      '<p style="margin:24px 0 0;color:#5b6660;font-size:14px">Vale 15 minuti e una volta sola. Se non l\'hai chiesto tu, ignora questa email.</p>'));
}

async function magicFinish(env, email, token) {
  await ensureMagic(env);
  const bad = () => fail(400, 'Link scaduto o già usato: chiedine uno nuovo');
  const user = await userForEmail(env, email);
  if (!user) bad();
  if (user.disabled) fail(403, "Questo account è disattivato: chiedi all'amministratore");
  const row = await env.DB.prepare('SELECT * FROM magic_links WHERE user_id = ?').bind(user.id).first();
  if (!row || row.exp < now() || !sameString(await sha256(String(token || '')), row.token_hash)) bad();
  await env.DB.prepare('DELETE FROM magic_links WHERE user_id = ?').bind(user.id).run();
  return user;
}

async function resetStart(env, email, origin) {
  await ensureReset(env);
  const user = await userForEmail(env, email);
  if (!user) return;
  const old = await env.DB.prepare('SELECT sent FROM reset_codes WHERE user_id = ?').bind(user.id).first();
  if (old && now() - old.sent < RESET_GAP) return;
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  const code = String(a[0] % 1000000).padStart(6, '0');
  await env.DB.prepare('INSERT OR REPLACE INTO reset_codes(user_id, code_hash, exp, tries, sent) VALUES(?,?,?,0,?)')
    .bind(user.id, await sha256(user.id + ':' + code), now() + RESET_TTL, now()).run();
  const shown = code.slice(0, 3) + ' ' + code.slice(3);
  const link = mailLink(origin, 'reset', { email, code });
  await sendMail(env, email, 'Il tuo codice BunkerPlex: ' + shown,
    'Ciao ' + user.username + ',\n\nper scegliere una password nuova scrivi questo codice in BunkerPlex:\n\n    ' + shown +
    '\n\noppure apri questo link:\n' + link +
    '\n\nVale 15 minuti. Se non l\'hai chiesto tu, ignora questa email: la tua password resta quella di prima.' +
    '\n\n--\nBunkerPlex · Only for bunkers',
    mailPage('Il tuo codice è ' + shown,
      '<p style="margin:0 0 16px">Ciao <b>' + esc(user.username) + '</b>,</p>' +
      '<p style="margin:0 0 24px">per scegliere una password nuova scrivi questo codice in BunkerPlex:</p>' +
      '<div style="background:#f1f6f2;border:1px solid #dce7df;border-radius:10px;padding:18px 0;text-align:center;' +
      'font:700 34px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:8px;color:#0f1a13">' + shown + '</div>' +
      mailButton(link, 'Scegli la password nuova') +
      '<p style="margin:24px 0 0;color:#5b6660;font-size:14px">Vale 15 minuti. Se non l\'hai chiesto tu, ignora questa email: ' +
      'la tua password resta quella di prima.</p>'));
}

// L'invito dell'amministratore: email e password provvisoria per il primo accesso
// origin + userId: il link diretto all'attivazione (email gia' scritta, niente password provvisoria)
async function inviteMail(env, to, from, password, again, origin, userId) {
  const intro = again
    ? 'ecco una nuova password provvisoria per il tuo account BunkerPlex.'
    : (from ? from + ' ti ha invitato su BunkerPlex.' : 'hai un invito per BunkerPlex.');
  const link = mailLink(origin, 'attiva', { email: to, t: await newActivation(env, userId) });
  const label = again ? 'Scegli la tua password' : 'Attiva il tuo account';
  await sendMail(env, to, again ? 'La tua nuova password provvisoria BunkerPlex' : 'Il tuo invito a BunkerPlex',
    'Ciao,\n\n' + intro + '\n\n' + label + ' da qui (vale 14 giorni):\n' + link +
    '\n\nOppure entra con:\n\n    Email: ' + to + '\n    Password provvisoria: ' + password +
    '\n\nAl primo accesso ' + (again ? 'scegli una password tua.' : 'scegli il tuo nome e una password tua, poi crei il tuo profilo.') +
    '\n\n--\nBunkerPlex · Only for bunkers',
    mailPage(again ? 'La tua nuova password provvisoria' : 'Il tuo invito a BunkerPlex',
      '<p style="margin:0 0 16px">Ciao,</p>' +
      '<p style="margin:0">' + esc(intro) + '</p>' +
      mailButton(link, label) +
      '<p style="margin:28px 0 12px;color:#5b6660;font-size:14px">Oppure entra con (anche dalla TV o dal server di casa):</p>' +
      '<div style="background:#f1f6f2;border:1px solid #dce7df;border-radius:10px;padding:16px 18px;font-size:15px;color:#1d2420">' +
      '<div style="color:#5b6660;font-size:13px">Email</div><div style="margin:2px 0 12px"><b>' + esc(to) + '</b></div>' +
      '<div style="color:#5b6660;font-size:13px">Password provvisoria</div>' +
      '<div style="margin-top:4px;font:700 24px/1.2 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:2px;color:#0f1a13">' +
      esc(password) + '</div></div>' +
      '<p style="margin:24px 0 0;color:#5b6660;font-size:14px">Al primo accesso ' +
      (again ? 'scegli una password tua.' : 'scegli il tuo nome e una password tua, poi crei il tuo profilo.') + '</p>'));
}

// La password provvisoria in chiaro arriva solo per metterla nell'email: non si salva
function tempPlain(raw) {
  const p = String(raw || '');
  return p.length >= 8 && p.length <= 64 ? p : '';
}

async function resetFinish(env, email, rawCode, verifier) {
  await ensureReset(env);
  const code = String(rawCode || '').replace(/\D/g, '');
  const bad = () => fail(400, 'Codice sbagliato o scaduto: chiedine uno nuovo');
  const user = await userForEmail(env, email);
  if (!user || code.length !== 6) bad();
  const row = await env.DB.prepare('SELECT * FROM reset_codes WHERE user_id = ?').bind(user.id).first();
  if (!row || row.exp < now() || row.tries >= RESET_TRIES) bad();
  if (!sameString(await sha256(user.id + ':' + code), row.code_hash)) {
    await env.DB.prepare('UPDATE reset_codes SET tries = tries + 1 WHERE user_id = ?').bind(user.id).run();
    bad();
  }
  const pw = await passwordFields(verifier);
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET salt = ?, hash = ?, must_change = 0, fails = 0, locked_until = 0, no_password = 0 WHERE id = ?')
      .bind(pw.salt, pw.hash, user.id),
    // Con la password nuova gli altri server collegati devono rientrare
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM reset_codes WHERE user_id = ?').bind(user.id)
  ]);
  return { ...user, must_change: 0, no_password: 0 };
}

async function flowByCode(env, code) {
  const f = await env.DB.prepare('SELECT * FROM google_flows WHERE code = ?').bind(code).first();
  return f && f.exp > now() ? f : null;
}

async function googleRoutes(request, env, url, path, method) {
  // Informativa sulla privacy (la chiede Google per la schermata di consenso)
  if (path === '/privacy' && method === 'GET') {
    return page('Privacy', '<h1>BunkerPlex · Privacy</h1>' +
      '<p>BunkerPlex è un media server personale. Questo servizio tiene solo ciò che serve agli account: ' +
      'nome utente, un\'impronta della password (mai la password), impostazioni, visti e lista, amici e indirizzi dei propri server.</p>' +
      '<p>Con «Entra con Google» riceve da Google soltanto l\'identificativo dell\'account e l\'indirizzo email, ' +
      'usati unicamente per riconoscerti all\'accesso. Niente viene venduto, condiviso con terzi o usato per pubblicità.</p>' +
      '<p>Con «Entra con impronta o volto» (passkey) tiene solo la chiave pubblica: impronta e volto restano sul tuo dispositivo.</p>' +
      '<p>Per scollegare Google: BunkerPlex → Impostazioni → Account → Scollega Google, oppure da ' +
      '<a href="https://myaccount.google.com/connections" style="color:#7fd6a0">myaccount.google.com</a>. ' +
      'Per cancellare l\'account chiedi all\'amministratore del tuo BunkerPlex.</p>');
  }
  if (!/^\/(google|g)(\/|$)/.test(path)) return null;
  if (!googleOn(env)) {
    if (path.startsWith('/g')) return page('Google', '<h1>Non disponibile</h1><p>Su questo servizio account l\'accesso con Google non è attivo.</p>', 404);
    fail(404, 'Accesso con Google non configurato nel servizio account');
  }
  await ensureGoogle(env);
  const origin = url.origin;
  const redirect = origin + '/google/callback';

  // Dove si vede il codice, in parole (per le pagine)
  const devWord = (f) => ({ tv: 'la TV', phone: 'l\'app sul telefono', browser: 'il browser' }[f.kind] || 'il dispositivo');
  const shownCode = (code) => code.slice(0, 4) + '-' + code.slice(4);
  const expired = (status) => page('Codice scaduto', '<h1>Codice scaduto</h1>' +
    '<p>Il codice vale 10 minuti e una volta sola. Sulla TV o nell\'app ricomincia da «Entra con Google»: compare un codice nuovo.</p>' +
    '<p><a class="btn ghost" href="/g">Scrivi un altro codice</a></p>', status);

  // Porta a Google: PKCE (S256) e nonce legano la risposta di Google a questo giro
  const toGoogle = async (f, code) => {
    const state = code + '.' + randomHex(16);
    const verifier = randomHex(32);
    const nonce = randomHex(16);
    await env.DB.prepare('UPDATE google_flows SET state = ?, pkce = ?, nonce = ?, note = NULL, seen = 1 WHERE code = ?')
      .bind(await sha256(state), verifier, nonce, code).run();
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const q = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirect, response_type: 'code', scope: 'openid email',
      state, nonce, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account'
    });
    if (f.hint) q.set('login_hint', f.hint);
    return new Response(null, { status: 303, headers: { Location: 'https://accounts.google.com/o/oauth2/v2/auth?' + q,
      'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
  };

  // Non riuscito ma si puo' riprovare: il codice resta buono (la TV aspetta ancora)
  // e chi aspetta legge il motivo nella risposta di /google/poll.
  const retry = async (f, code, msg) => {
    await env.DB.prepare('UPDATE google_flows SET note = ?, state = NULL, pkce = NULL, nonce = NULL WHERE code = ?')
      .bind(msg, code).run();
    return page('Non riuscito', '<h1>Non riuscito</h1><p class="err">' + esc(msg) + '</p>' +
      '<form method="post" action="/g/' + code + '">' + gButton('Prova con un altro account Google') + '</form>' +
      '<p><small>Codice <b>' + shownCode(code) + '</b> per ' + esc(devWord(f)) + '. Oppure torna su BunkerPlex ed entra con la password.</small></p>', 403);
  };

  // Fatto: sullo stesso dispositivo la finestra si chiude da sola (o si torna all'app)
  const donePage = (f, head, line) => {
    let after;
    if (f.kind === 'tv') {
      after = '<p>La TV entra da sola tra un attimo.</p><p><small>Puoi chiudere questa pagina.</small></p>';
    } else if (f.kind === 'phone') {
      after = '<p>Torna all\'app BunkerPlex: entra da sola.</p>' +
        (/Android/i.test(request.headers.get('User-Agent') || '')
          ? '<p><a class="btn" href="intent:#Intent;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;package=it.bunkerplex.tv;end">Torna all\'app</a></p>' : '');
    } else {
      let host = '';
      let here = false;
      try {
        const bu = f.back ? new URL(f.back) : null;
        host = bu ? bu.host : '';
        here = !!bu && bu.origin === origin;
      } catch (e) { host = ''; }
      // Finestra aperta dall'app: si chiude. Altrimenti (Google nella stessa scheda della
      // PWA di questo servizio) si torna da soli alla PWA, che riprende e entra.
      after = '<p>Torna su BunkerPlex: entra da solo.</p>' +
        (host ? '<p><a class="btn" href="' + esc(f.back) + '">Torna a BunkerPlex</a></p><p><small>' + esc(host) + '</small></p>' : '<p><small>Puoi chiudere questa pagina.</small></p>') +
        '<script>setTimeout(function(){window.close();' +
        (here ? 'setTimeout(function(){location.replace(' + JSON.stringify(f.back).replace(/</g, '\\u003c') + ')},400);' : '') +
        '},1200)</script>';
    }
    return page('Fatto', '<div class="ok">✓</div><h1>' + head + '</h1><p>' + line + '</p>' + after);
  };

  // Un codice nuovo. link = collega Google all'account che chiede (serve il suo gettone).
  // hint: l'email gia' scritta (Google propone quell'account); back: dove tornare dopo.
  if (path === '/google/start' && method === 'POST') {
    const b = await body(request);
    let link = null;
    if (b.link) link = await auth(request, env);
    await env.DB.prepare('DELETE FROM google_flows WHERE exp < ?').bind(now()).run();
    const n = await env.DB.prepare('SELECT COUNT(*) n FROM google_flows').first('n');
    if (n > 300) fail(429, 'Troppi accessi in corso: riprova tra qualche minuto');
    const a = new Uint8Array(8);
    crypto.getRandomValues(a);
    const code = [...a].map((x) => CODE_CHARS[x % CODE_CHARS.length]).join('');
    const poll = randomHex(32);
    // device: il nome che avrà il gettone (il PC, o il telefono); kind: dove si vede il codice
    const kind = ['tv', 'phone', 'browser'].includes(b.kind) ? b.kind : 'browser';
    const hint = String(b.hint || '').trim().toLowerCase();
    let back = '';
    try {
      const bu = new URL(String(b.back || ''));
      // Solo verso la PWA di questo servizio: niente link verso indirizzi scelti da altri
      if (bu.origin === origin && bu.href.length <= 300) back = bu.href;
    } catch (e) { back = ''; }
    await env.DB.prepare('INSERT INTO google_flows(code, poll_hash, link_user, device, kind, exp, hint, back) VALUES(?,?,?,?,?,?,?,?)')
      .bind(code, await sha256(poll), link ? link.id : null, String(b.device || '').slice(0, 80), kind, now() + GOOGLE_TTL,
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(hint) && hint.length <= 120 ? hint : null, back || null).run();
    const res = json({ code, poll, url: origin + '/g/' + code, short: origin + '/g', ttl: GOOGLE_TTL });
    // Lo stesso browser che ha chiesto il codice (la PWA di questo servizio) salta la
    // conferma del codice: lo prova un cookie che nessun altro può avere.
    if (kind === 'browser') {
      const same = randomHex(16);
      await env.DB.prepare('UPDATE google_flows SET state = ? WHERE code = ?').bind('same:' + await sha256(same), code).run();
      res.headers.append('Set-Cookie', 'bpg=' + code + '.' + same + '; Path=/g; Max-Age=' + GOOGLE_TTL + '; HttpOnly; Secure; SameSite=Lax');
    }
    return res;
  }

  // Chi ha chiesto il codice: finito? Il gettone si consegna una volta sola.
  // Intanto: seen = il codice è stato aperto, note = l'ultimo tentativo non riuscito.
  if (path === '/google/poll' && method === 'POST') {
    const b = await body(request);
    const ph = await sha256(String(b.poll || ''));
    const f = await env.DB.prepare('SELECT * FROM google_flows WHERE poll_hash = ?').bind(ph).first();
    if (!f || f.exp < now()) fail(404, 'Codice scaduto: ricomincia');
    if (!f.user_id && !f.error) return json({ done: false, seen: !!f.seen, note: f.note || '' });
    await env.DB.prepare('DELETE FROM google_flows WHERE code = ?').bind(f.code).run();
    if (f.error) fail(403, f.error);
    const u = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(f.user_id).first();
    if (!u) fail(404, 'Account non trovato');
    if (f.link_user) return json({ done: true, linked: true, user: userJson(u) });
    return json({ done: true, token: await newSession(env, u, f.device, f.kind === 'phone' ? 'app' : f.kind), user: userJson(u) });
  }

  // Toglie il collegamento con Google dall'account che chiede
  if (path === '/google' && method === 'DELETE') {
    const u = await auth(request, env);
    if (u.no_password) fail(409, 'Questo account entra solo con Google: chiedi all\'amministratore una password provvisoria prima di scollegarlo');
    await env.DB.prepare('UPDATE users SET google_sub = NULL, google_email = NULL WHERE id = ?').bind(u.id).run();
    return json({ ok: true });
  }

  // La pagina da aprire: senza codice lo chiede; col codice dice per cosa e porta a Google
  if ((path === '/g' || /^\/g\/[A-Za-z0-9-]{1,12}$/.test(path)) && method === 'GET') {
    const typed = path === '/g' ? url.searchParams.get('c') : null;
    const code = cleanCode(path === '/g' ? typed : path.slice(3));
    if (!code) {
      return page('Entra con Google', '<h1>Entra con Google</h1><p>Scrivi il codice che vedi sulla TV o nell\'app.</p>' +
        '<form method="get" action="/g"><input name="c" id="c" autocomplete="off" autocapitalize="characters" spellcheck="false" ' +
        'inputmode="text" maxlength="9" placeholder="XXXX-XXXX" aria-label="Codice" required autofocus>' +
        '<button class="btn">Continua</button></form>' +
        // Il trattino si mette da solo dopo le prime quattro lettere
        '<script>var c=document.getElementById("c");c.addEventListener("input",function(){var v=c.value.toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,8);' +
        'c.value=v.length>4?v.slice(0,4)+"-"+v.slice(4):v})</script>');
    }
    const f = await flowByCode(env, code);
    if (!f || f.user_id || f.error) {
      return page('Codice scaduto', '<h1>' + (typed ? 'Codice sbagliato o scaduto' : 'Codice scaduto') + '</h1>' +
        '<p>Controlla il codice sulla TV o nell\'app: vale 10 minuti e una volta sola. Se è scaduto ricomincia da «Entra con Google».</p>' +
        '<p><a class="btn ghost" href="/g">Scrivi un altro codice</a></p>', 404);
    }
    // Lo stesso browser che l'ha chiesto: dritto a Google
    const ck = /(?:^|;\s*)bpg=([A-Z0-9]{8})\.([0-9a-f]{32})/.exec(request.headers.get('Cookie') || '');
    if (ck && ck[1] === code && f.state && f.state.startsWith('same:') &&
        sameString('same:' + await sha256(ck[2]), f.state)) {
      return toGoogle(f, code);
    }
    if (!f.seen) await env.DB.prepare('UPDATE google_flows SET seen = 1 WHERE code = ?').bind(code).run();
    let what = 'Entri in BunkerPlex';
    if (f.link_user) {
      const lu = await env.DB.prepare('SELECT username FROM users WHERE id = ?').bind(f.link_user).first();
      what = 'Colleghi Google all\'account BunkerPlex <b>' + esc(lu ? lu.username : '') + '</b>';
    }
    return page('Entra con Google', '<h1>' + (f.link_user ? 'Collega Google' : 'Entra con Google') + '</h1>' +
      '<p>' + what + ' su <b>' + esc(devWord(f)) + '</b> che mostra questo codice:</p><p class="code">' + shownCode(code) + '</p>' +
      (f.note ? '<p class="err">' + esc(f.note) + '</p>' : '') +
      '<form method="post" action="/g/' + code + '">' + gButton('Continua con Google') + '</form>' +
      '<p><small>Se non l\'hai chiesto tu, o il codice non è quello che vedi, chiudi questa pagina.</small></p>');
  }
  const gm = /^\/g\/([A-Za-z0-9-]{1,12})$/.exec(path);
  if (gm && method === 'POST') {
    const code = cleanCode(gm[1]);
    const f = await flowByCode(env, code);
    if (!f || f.user_id || f.error) return expired(404);
    return toGoogle(f, code);
  }

  // «Collega ed entra»: la conferma della proposta fatta dopo Google (vedi sotto)
  const gl = /^\/g\/([A-Za-z0-9-]{1,12})\/collega$/.exec(path);
  if (gl && method === 'POST') {
    const code = cleanCode(gl[1]);
    const f = await flowByCode(env, code);
    const form = await request.formData().catch(() => null);
    const nonce = form ? String(form.get('n') || '') : '';
    if (!f || !f.offer_user || f.user_id || f.error || !f.offer_hash || !sameString(await sha256(nonce), f.offer_hash)) {
      return expired(404);
    }
    const u = await env.DB.prepare('SELECT * FROM users WHERE id = ? AND google_sub IS NULL').bind(f.offer_user).first();
    const taken = await env.DB.prepare('SELECT id FROM users WHERE google_sub = ?').bind(f.offer_sub).first();
    if (!u || taken) {
      await env.DB.prepare('UPDATE google_flows SET offer_hash = NULL WHERE code = ?').bind(code).run();
      return retry(f, code, 'Non riesco a collegare: l\'account è cambiato nel frattempo.');
    }
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET google_sub = ?, google_email = ? WHERE id = ?').bind(f.offer_sub, f.email, u.id),
      env.DB.prepare('UPDATE google_flows SET error = NULL, user_id = ?, offer_hash = NULL, note = NULL WHERE code = ?').bind(u.id, code)
    ]);
    return donePage(f, 'Google collegato', 'Stai entrando come <b>' + esc(u.username) + '</b>.');
  }

  // Google torna qui
  if (path === '/google/callback' && method === 'GET') {
    const state = String(url.searchParams.get('state') || '');
    const code = cleanCode(state.split('.')[0]);
    const f = code ? await flowByCode(env, code) : null;
    if (!f || !f.state || f.state.startsWith('same:') || !sameString(await sha256(state), f.state) || f.user_id || f.error) {
      return expired(400);
    }
    const ok = async (uid, email, head, line) => {
      await env.DB.prepare('UPDATE google_flows SET user_id = ?, email = ?, state = NULL, pkce = NULL, nonce = NULL, note = NULL WHERE code = ?')
        .bind(uid, email || null, code).run();
      return donePage(f, head, line);
    };
    if (url.searchParams.get('error')) return retry(f, code, 'Hai annullato la scelta dell\'account Google.');
    const tr = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(url.searchParams.get('code') || ''), client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: redirect, grant_type: 'authorization_code',
        code_verifier: f.pkce || ''
      })
    });
    const tok = tr.ok ? await tr.json() : null;
    let id = null;
    try { id = b64urlJson(String(tok && tok.id_token || '').split('.')[1] || ''); } catch (e) { id = null; }
    // Il gettone arriva direttamente da Google (HTTPS): basta controllarne i campi
    if (!id || id.aud !== env.GOOGLE_CLIENT_ID || !['accounts.google.com', 'https://accounts.google.com'].includes(id.iss) ||
        !(id.exp > now()) || !id.sub || !f.nonce || !sameString(String(id.nonce || ''), f.nonce)) {
      return retry(f, code, 'Google non ha confermato l\'accesso: riprova.');
    }
    const sub = String(id.sub);
    const email = id.email_verified ? String(id.email || '').toLowerCase() : '';
    const owner = await env.DB.prepare('SELECT * FROM users WHERE google_sub = ?').bind(sub).first();

    if (f.link_user) {
      if (owner && owner.id !== f.link_user) {
        return retry(f, code, 'L\'account Google ' + (email || '') + ' è già collegato all\'account BunkerPlex ' + owner.username + '.');
      }
      await env.DB.prepare('UPDATE users SET google_sub = ?, google_email = ? WHERE id = ?').bind(sub, email || null, f.link_user).run();
      return ok(f.link_user, email, 'Google collegato', 'D\'ora in poi entri con <b>' + esc(email || 'Google') + '</b>, senza password.');
    }
    let u = owner;
    if (!u && email) {
      // Indicato dall'amministratore: si lega adesso
      u = await env.DB.prepare('SELECT * FROM users WHERE google_email = ? AND google_sub IS NULL').bind(email).first();
      if (u) {
        if (u.must_change && pendingName(u.username)) {
          // Invitato: al primo accesso sceglie comunque nome e password (quella provvisoria e' nell'email)
          await env.DB.prepare('UPDATE users SET google_sub = ? WHERE id = ?').bind(sub, u.id).run();
        } else if (u.must_change) {
          // La password provvisoria non serve più (e non deve restare valida): entra con Google
          const pw = await passwordFields(randomHex(32));
          await env.DB.prepare('UPDATE users SET google_sub = ?, salt = ?, hash = ?, must_change = 0, no_password = 1 WHERE id = ?')
            .bind(sub, pw.salt, pw.hash, u.id).run();
        } else {
          await env.DB.prepare('UPDATE users SET google_sub = ? WHERE id = ?').bind(sub, u.id).run();
        }
      }
    }
    if (!u && email) {
      // Un account con la stessa email (confermata da Google) ma senza Google: lo propone
      const same = await env.DB.prepare('SELECT * FROM users WHERE email = ? AND google_sub IS NULL AND disabled = 0').bind(email).first();
      if (same) {
        const nonce = randomHex(16);
        await env.DB.prepare('UPDATE google_flows SET offer_user = ?, offer_sub = ?, offer_hash = ?, email = ?, state = NULL, pkce = NULL, nonce = NULL WHERE code = ?')
          .bind(same.id, sub, await sha256(nonce), email, code).run();
        return page('Collega Google', '<h1>Collega Google</h1>' +
          '<p>C\'è già l\'account BunkerPlex <b>' + esc(same.username) + '</b> con l\'email <b>' + esc(email) + '</b>.</p>' +
          '<p>Lo colleghi a Google? Da ora entri con «Continua con Google», senza scrivere la password.</p>' +
          '<form method="post" action="/g/' + code + '/collega"><input type="hidden" name="n" value="' + nonce + '">' +
          '<button class="btn">Collega ed entra</button></form>' +
          '<p><small>Non sei tu? Chiudi questa pagina: non cambia niente.</small></p>');
      }
    }
    if (!u) {
      return retry(f, code, 'L\'account Google ' + (email || '') + ' non è collegato a nessun account BunkerPlex. ' +
        'Entra una volta con la password e collegalo da Impostazioni → Account, oppure chiedi all\'amministratore di aggiungere questa email.');
    }
    if (u.disabled) return retry(f, code, 'L\'account BunkerPlex ' + u.username + ' è disattivato: chiedi all\'amministratore.');
    if (email && email !== u.google_email) {
      await env.DB.prepare('UPDATE users SET google_email = ? WHERE id = ?').bind(email, u.id).run();
    }
    return ok(u.id, email, 'Fatto', 'Stai entrando come <b>' + esc(u.username) + '</b>.');
  }
  return null;
}

// ---- Notifiche sui telefoni e tablet
//
// Gli avvisi di un account (nuovi film ed episodi, aggiornamenti, amicizie) stanno
// qui, perche' questo servizio si raggiunge da ovunque, anche fuori casa.
// I server di casa li mandano con POST /notices; le richieste di amicizia nascono
// gia' qui. Ogni telefono o tablet ha un suo gettone (notice_devices), creato dal
// server di casa (o dalla PWA) con POST /notices/devices quando si tocca «Attiva le notifiche»:
//   - la PWA di BunkerPlex (iPhone e iPad dalla schermata Home, browser dei PC):
//     il suo service worker (server/static/sw.js) si iscrive alle notifiche push del
//     browser (Web Push con chiavi VAPID, create qui la prima volta e salvate nel
//     database) e manda l'iscrizione a /avvisi/<gettone>/push;
//   - app Android: Firebase Cloud Messaging. L'app manda il suo gettone FCM a
//     /avvisi/<gettone>/fcm e qui si spedisce con l'API HTTP v1 di FCM (segreto
//     FCM_SERVICE_ACCOUNT, la chiave JSON di un account di servizio Firebase).
//     Senza segreto (o con un APK compilato senza Firebase) l'app chiede
//     /avvisi/<gettone>/list ogni 15 minuti circa, come prima;
//   - la vecchia pagina «BP Avvisi» (/avvisi/<gettone>) resta per chi l'aveva gia'.
// Le chiavi VAPID e i gettoni restano nel database D1: per il Web Push non serve
// configurare nulla.

const NOTICE_KEEP = 100;        // avvisi tenuti per account
const NOTICE_DAYS = 30;         // e per quanti giorni al massimo
const NOTICE_RATE = 40;         // avvisi all'ora che un account puo' mandare
const NOTICE_DEVICES = 10;      // telefoni e tablet per account
const NOTICE_KINDS = ['titles', 'friends_titles', 'friends', 'update'];
const ICON_PNG = 'iVBORw0KGgoAAAANSUhEUgAAALQAAAC0CAIAAACyr5FlAAADm0lEQVR42u3czYtVZQDH8fOcc+/cGbkOOeMomArZC7ZoY5ugNi2EpI2zKUHBhQsj99KmRIgW7QoqRi2oZUWrIKQX2qgbN7Y2WrgIxMbxpav33vM8T5s0Ria4KDN453y+f8F5zvPhx11cTth2Ym8hrVTpFQgOwSE4BIfgEByCQ3AIDsEhwSE4BIfgEByCQ3AIDsEhOCQ4BIfgEByCQ3AIDsEhOASHBIfgEByCQ3AIDsEhOASH4BAcEhyCQ3AIDsEhOASH4BAcgkOCQ3AIjhULIYQQ3DEcK8gY1MN+PWiVlWuGY5mMfj3YtXn707Pbr95erMqyNCFw/HuqEO4O+89u3vHD0U8Ovfj6Uu9Wvx6aEDju+yjvDPubpqZPv/nelwff39Kd+at3w4TA8Z+PnPMw1vMvvPrLsVMH9+wzIXAs+/FRlWVMcUt3ZuGNd78yIXA8UFVWOeeY0n4TAocJgcOEwGFC4DAhcJgQOEwIHCYEDhMChwn5nwlp5v9C4BhpQupYN3BC4BhpQqYnu4u9G62yatSEwDHShJx969N9z79y7e+lmGJzJgSOkSbkqZknvz784cfzxydbnet3bjZkQuAYaUJSzimnIy/N//z2qdd2v9yQCYFjtNcUQhnKmOKu2QZNCBwmBA4TAocJgcOEwGFC4DAhcJgQOEzIepkQOEwIHCYEjsd5Qq7eXhzUwzHyAcfaTcgXB05u3ThbxzguPuBY/e5ReG5u51S7k4s0Lg/ecnerV8455tQqq1v93gc/nvns3Detqppqd1LOcDS6mFJVlq1Q/Xr54jvff/Tbn5dnN0wXRTEuMuBY/cH46fOF89+GEOa6m+pYj9dB4FibwQhjJwOONRuMPI4ngsNgwGEw4DAYcBgMOAwGHAYDDoMBh8GAw2Cs18GAw2DAYTDgMBhwGAw4DAYcBgMOgwGHwYDDYMBhMNQ8HAYDDoMBh8GAw2DAsQqDUeQ6xYmqbTDgWFbKKRRhomobDDgekJEn253e8O7JswunL3xnMB6isO3E3nV4qhD6w8Ezczs3tDvn/rg0132iKELKyX1bjiLn3GlP/H7tSsxp68aZOkWDAccyHxOtdihCnaJrhmMFH9lgPEK+CSY4BIfgEByCQ3AIDsEhOASHBIfgEByCQ3AIDsEhOASH4JDgEByCQ3AIDsEhOASH4BAcEhyCQ3AIDsEhOASH4BAcgkNwSHAIDsEhOASH4BAcgkNwCA4JDsGhR+kfx6aAFawJ73gAAAAASUVORK5CYII=';

let noticeTables = false;
async function ensureNotices(env) {
  if (noticeTables) return;
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS notices(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, kind TEXT, ' +
      'title TEXT, body TEXT, t REAL NOT NULL, from_user INTEGER)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS notices_user ON notices(user_id, id)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS notice_devices(token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, ' +
      'label TEXT, kind TEXT, open_url TEXT, endpoint TEXT, p256dh TEXT, auth TEXT, created REAL NOT NULL, last_seen REAL)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS notice_devices_user ON notice_devices(user_id)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS notice_prefs(user_id INTEGER PRIMARY KEY, v TEXT)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT)')
  ]);
  // read: 1 = letto (dalla campanella, da Impostazioni → Notifiche o da BP Avvisi)
  const cols = (await env.DB.prepare('PRAGMA table_info(notices)').all()).results.map((c) => c.name);
  if (!cols.includes('read')) await env.DB.prepare('ALTER TABLE notices ADD COLUMN read INTEGER NOT NULL DEFAULT 0').run();
  // fcm: il gettone di Firebase Cloud Messaging dell'app Android
  const dcols = (await env.DB.prepare('PRAGMA table_info(notice_devices)').all()).results.map((c) => c.name);
  if (!dcols.includes('fcm')) await env.DB.prepare('ALTER TABLE notice_devices ADD COLUMN fcm TEXT').run();
  noticeTables = true;
}

// Segna letti alcuni avvisi (ids) o tutti quelli dell'account
async function markRead(env, uid, b) {
  const ids = Array.isArray(b.ids) ? b.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 100) : [];
  if (b.all) {
    await env.DB.prepare('UPDATE notices SET read = 1 WHERE user_id = ? AND read = 0').bind(uid).run();
  } else if (ids.length) {
    await env.DB.prepare('UPDATE notices SET read = 1 WHERE user_id = ? AND id IN (' + ids.map(() => '?').join(',') + ')')
      .bind(uid, ...ids).run();
  }
  return env.DB.prepare('SELECT COUNT(*) n FROM notices WHERE user_id = ? AND read = 0').bind(uid).first('n');
}

const te = new TextEncoder();
function b64u(buf) {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64u(s) {
  s = String(s || '');
  return Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
}
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
}
async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8));
}

// Le chiavi VAPID di questo servizio: create alla prima notifica, poi sempre le stesse
async function vapidKeys(env) {
  const saved = await env.DB.prepare("SELECT v FROM kv WHERE k = 'vapid'").first('v');
  if (saved) return JSON.parse(saved);
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const keys = { priv: await crypto.subtle.exportKey('jwk', kp.privateKey), pub: b64u(await crypto.subtle.exportKey('raw', kp.publicKey)) };
  await env.DB.prepare("INSERT OR IGNORE INTO kv(k, v) VALUES('vapid', ?)").bind(JSON.stringify(keys)).run();
  return JSON.parse(await env.DB.prepare("SELECT v FROM kv WHERE k = 'vapid'").first('v'));
}

async function vapidHeader(keys, endpoint, contact) {
  const head = b64u(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(te.encode(JSON.stringify({
    aud: new URL(endpoint).origin, exp: Math.floor(now()) + 12 * 3600, sub: 'mailto:' + contact
  })));
  const key = await crypto.subtle.importKey('jwk', keys.priv, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te.encode(head + '.' + claims));
  return 'vapid t=' + head + '.' + claims + '.' + b64u(sig) + ', k=' + keys.pub;
}

// Cifratura del messaggio per il browser (RFC 8291, aes128gcm)
async function encryptPush(p256dh, authSecret, text) {
  const uaPub = unb64u(p256dh);
  const mine = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const myPub = new Uint8Array(await crypto.subtle.exportKey('raw', mine.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, mine.privateKey, 256));
  const ikm = await hkdf(unb64u(authSecret), shared, concat(te.encode('WebPush: info\0'), uaPub, myPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(te.encode(text), new Uint8Array([2]))));
  return concat(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array([myPub.length]), myPub, data);
}

async function sendPush(env, dev, payload) {
  const keys = await vapidKeys(env);
  const res = await fetch(dev.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidHeader(keys, dev.endpoint, env.MAIL_FROM || 'bunkerplex@outlook.it'),
      // high: Android in risparmio energetico (Doze) e iOS consegnano subito invece
      // di aspettare il prossimo risveglio del telefono
      TTL: '86400', Urgency: 'high', 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream'
    },
    body: await encryptPush(dev.p256dh, dev.auth, JSON.stringify(payload))
  });
  // Iscrizione scaduta o tolta dal telefono: non si riprova piu'
  if (res.status === 404 || res.status === 410) {
    await env.DB.prepare('UPDATE notice_devices SET endpoint = NULL, p256dh = NULL, auth = NULL WHERE token_hash = ?')
      .bind(dev.token_hash).run();
  }
  return res.status;
}

// ---- Firebase Cloud Messaging (app Android)
//
// Segreto FCM_SERVICE_ACCOUNT: il file JSON della chiave di un account di servizio
// del progetto Firebase (Impostazioni progetto → Account di servizio → Genera nuova
// chiave privata). Da li' si firma un JWT (RS256) e Google da' un gettone d'accesso
// valido un'ora, tenuto in memoria finche' non sta per scadere.

let fcmAuth = null;   // { key: segreto da cui viene, token, exp }

function fcmAccount(env) {
  const raw = env.FCM_SERVICE_ACCOUNT;
  if (!raw) return null;
  try {
    const sa = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return sa && sa.project_id && sa.client_email && sa.private_key ? sa : null;
  } catch (e) {
    return null;
  }
}

function pemDer(pem) {
  return unb64u(String(pem).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '').replace(/\+/g, '-').replace(/\//g, '_'));
}

async function fcmAccessToken(env, sa) {
  if (fcmAuth && fcmAuth.key === sa.private_key && fcmAuth.exp > now() + 120) return fcmAuth.token;
  const iat = Math.floor(now());
  const head = b64u(te.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claims = b64u(te.encode(JSON.stringify({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: sa.token_uri || 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600
  })));
  const key = await crypto.subtle.importKey('pkcs8', pemDer(sa.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, te.encode(head + '.' + claims));
  const res = await fetch(sa.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') +
      '&assertion=' + head + '.' + claims + '.' + b64u(sig)
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error('Google non da\' il gettone per FCM (' + res.status + ')');
  fcmAuth = { key: sa.private_key, token: j.access_token, exp: iat + Math.min(Number(j.expires_in) || 3600, 3600) };
  return fcmAuth.token;
}

// Un messaggio "data" ad alta priorita': Android sveglia l'app anche in risparmio
// energetico e la notifica la costruisce l'app (canale «avvisi», icona di BunkerPlex).
// Restituisce lo stato HTTP di FCM (0 = FCM non configurato qui).
async function sendFcm(env, dev, payload) {
  const sa = fcmAccount(env);
  if (!sa || !dev.fcm) return 0;
  const data = {};
  for (const [k, v] of Object.entries(payload)) if (v != null) data[k] = String(v);
  const send = async () => fetch('https://fcm.googleapis.com/v1/projects/' + encodeURIComponent(sa.project_id) + '/messages:send', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + await fcmAccessToken(env, sa), 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { token: dev.fcm, data, android: { priority: 'high', ttl: '86400s' } } })
  });
  let res = await send();
  if (res.status === 401) {          // gettone d'accesso revocato o scaduto prima del tempo: uno nuovo
    fcmAuth = null;
    res = await send();
  }
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    const codes = ((j.error && j.error.details) || []).map((d) => d && d.errorCode);
    // App disinstallata, gettone scaduto o di un altro progetto Firebase: non si riprova piu'
    if (res.status === 404 || codes.includes('UNREGISTERED') || codes.includes('SENDER_ID_MISMATCH')) {
      await env.DB.prepare('UPDATE notice_devices SET fcm = NULL WHERE token_hash = ? AND fcm = ?')
        .bind(dev.token_hash, dev.fcm).run();
    }
  }
  return res.status;
}

// Manda un avviso a un dispositivo per tutte le strade che ha (Web Push e/o FCM).
// Restituisce il miglior stato HTTP ottenuto (0 = nessuna strada).
async function pushDevice(env, dev, payload) {
  let best = 0;
  if (dev.fcm) {
    try { const c = await sendFcm(env, dev, payload); if (c && (!best || c < best)) best = c; } catch (e) { best = best || 502; }
  }
  if (dev.endpoint) {
    try { const c = await sendPush(env, dev, payload); if (!best || c < best) best = c; } catch (e) { best = best || 502; }
  }
  return best;
}

async function noticePrefs(env, uid) {
  const v = await env.DB.prepare('SELECT v FROM notice_prefs WHERE user_id = ?').bind(uid).first('v');
  let p = {};
  try { p = JSON.parse(v || '{}') || {}; } catch (e) { p = {}; }
  const out = {};
  for (const k of NOTICE_KINDS) out[k] = p[k] !== false;
  return out;
}

const cleanText = (raw, max) => String(raw || '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, max);

// Un avviso a un account: si salva e parte subito verso i suoi dispositivi iscritti
// (Web Push per la PWA e BP Avvisi, FCM per l'app Android)
async function notify(env, uid, kind, title, text, from) {
  await ensureNotices(env);
  if (!(await noticePrefs(env, uid))[kind]) return 0;
  const t = now();
  const id = (await env.DB.prepare('INSERT INTO notices(user_id, kind, title, body, t, from_user) VALUES(?,?,?,?,?,?)')
    .bind(uid, kind, title, text, t, from || null).run()).meta.last_row_id;
  await env.DB.prepare('DELETE FROM notices WHERE user_id = ? AND (t < ? OR id <= (SELECT id FROM notices WHERE user_id = ? ' +
    'ORDER BY id DESC LIMIT 1 OFFSET ?))').bind(uid, t - NOTICE_DAYS * 86400, uid, NOTICE_KEEP).run();
  const fcm = !!fcmAccount(env);
  const devs = (await env.DB.prepare('SELECT token_hash, endpoint, p256dh, auth, fcm FROM notice_devices ' +
    'WHERE user_id = ? AND (endpoint IS NOT NULL OR fcm IS NOT NULL)').bind(uid).all()).results;
  const payload = { id, title, body: text, kind, tag: 'bp-' + kind + '-' + id, t };
  // In parallelo: un telefono lento non fa aspettare gli altri. Gli errori non contano:
  // il telefono vedra' comunque l'avviso nella lista (campanella, controllo dell'app).
  await Promise.all(devs.filter((d) => d.endpoint || fcm).map((d) => pushDevice(env, d, payload).catch(() => 0)));
  return id;
}

// Un avviso che non deve far fallire la richiesta che lo genera (es. l'amicizia)
async function notifySafe(env, uid, kind, title, text, from) {
  try { await notify(env, uid, kind, title, text, from); } catch (e) { /* niente */ }
}

async function friendIds(env, uid) {
  return (await env.DB.prepare("SELECT CASE WHEN a = ? THEN b ELSE a END AS id FROM friends WHERE status = 'ok' AND (a = ? OR b = ?)")
    .bind(uid, uid, uid).all()).results.map((r) => r.id);
}

function noticeJson(r) {
  return { id: r.id, kind: r.kind, title: r.title, body: r.body, t: r.t, read: !!r.read };
}

async function noticeDevice(env, token) {
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  await ensureNotices(env);
  const d = await env.DB.prepare('SELECT d.*, u.disabled FROM notice_devices d JOIN users u ON u.id = d.user_id WHERE d.token_hash = ?')
    .bind(await sha256(token)).first();
  return d && !d.disabled ? d : null;
}

function avvisiPage(token, dev, keys) {
  const base = '/avvisi/' + token;
  const cfg = JSON.stringify({ base, key: keys.pub, open: dev.open_url || '' }).replace(/</g, '\\u003c');
  const html = '<!doctype html><html lang="it"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
    '<meta name="theme-color" content="#060a07"><title>BunkerPlex Avvisi</title>' +
    '<link rel="manifest" href="' + base + '/manifest.json"><link rel="apple-touch-icon" href="/avvisi/icon.png">' +
    '<meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="BP Avvisi">' +
    '<meta name="apple-mobile-web-app-status-bar-style" content="black">' +
    '<style>body{margin:0;background:#060a07;color:#f2f5f2;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}' +
    'main{max-width:34rem;margin:0 auto;padding:calc(env(safe-area-inset-top) + 1.2rem) 1rem 2rem}h1{font-size:1.4rem;margin:0 0 .3rem}' +
    'h1 b{color:#38c172}p{color:#c9d3cc;margin:.4rem 0}.box{background:#0e1510;border:1px solid #1f2b23;border-radius:.8rem;padding:1rem;margin:1rem 0}' +
    '.btn{display:inline-block;border:0;border-radius:.6rem;padding:.75rem 1.2rem;font:600 1rem system-ui,sans-serif;background:#1a7f45;' +
    'color:#fff;text-decoration:none;cursor:pointer;margin:.3rem .4rem .3rem 0}.btn.alt{background:#1f2b23}' +
    'ol{padding-left:1.2rem;color:#c9d3cc}.n{padding:.7rem 0;border-top:1px solid #1f2b23}.n:first-child{border:0}' +
    '.n b{display:block}.n.new b:before{content:"● ";color:#38c172}.n small{color:#8b9a90}.err{color:#ff8f80}.ok{color:#38c172}</style></head><body><main>' +
    '<h1><b>BunkerPlex</b> Avvisi</h1><p>Le notifiche di BunkerPlex su questo dispositivo.</p>' +
    '<div class="box" id="state"></div><div class="box"><b>Ultimi avvisi</b><div id="list"><p>…</p></div></div>' +
    '</main><script>var C=' + cfg + ';' + AVVISI_JS + '</script></body></html>';
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' } });
}

// Lo script della pagina: chiede il permesso, iscrive il browser e mostra gli ultimi avvisi
const AVVISI_JS = `
var st=document.getElementById('state'),ls=document.getElementById('list');
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function api(p,m,b){return fetch(C.base+p,{method:m||'GET',headers:{'Content-Type':'application/json'},body:b?JSON.stringify(b):undefined}).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.detail||'Errore');return j})})}
function u8(s){s=s.replace(/-/g,'+').replace(/_/g,'/');var b=atob(s+'==='.slice((s.length+3)%4));return Uint8Array.from(b,function(c){return c.charCodeAt(0)})}
var standalone=navigator.standalone||matchMedia('(display-mode: standalone)').matches;
var ios=/iPhone|iPad|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
var open=C.open?'<a class="btn alt" href="'+esc(C.open)+'">Apri BunkerPlex</a>':'';
function show(h){st.innerHTML=h}
function reg(){return navigator.serviceWorker.register('/avvisi/sw.js?b='+encodeURIComponent(C.base),{scope:'/avvisi/'}).then(function(){return navigator.serviceWorker.ready})}
function sub(){return reg().then(function(r){return r.pushManager.getSubscription().then(function(s){return s||r.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:u8(C.key)})})}).then(function(s){return api('/push','POST',s.toJSON())})}
function on(){Notification.requestPermission().then(function(p){if(p!=='granted'){show('<p class="err">Notifiche non permesse. Le riattivi da Impostazioni → Notifiche → BP Avvisi.</p>');return}return sub().then(function(){paint(true)})}).catch(function(e){show('<p class="err">'+esc(e.message)+'</p>')})}
function off(){reg().then(function(r){return r.pushManager.getSubscription()}).then(function(s){return s&&s.unsubscribe()}).then(function(){return api('/push','DELETE')}).then(function(){paint(false)})}
function test(){api('/test','POST').then(function(){},function(e){alert(e.message)})}
function paint(active){
 if(!('serviceWorker' in navigator)||!('PushManager' in window)){
  show(ios&&!standalone?'<p><b>Ultimo passo:</b> aggiungi questa pagina alla schermata Home.</p><ol><li>Tocca <b>Condividi</b> (il quadrato con la freccia) in Safari</li><li>Scegli <b>Aggiungi alla schermata Home</b>, poi <b>Aggiungi</b></li><li>Apri <b>BP Avvisi</b> dalla schermata Home e tocca «Attiva le notifiche»</li></ol><p><small>Serve iOS 16.4 o più recente.</small></p>'
   :'<p class="err">Questo browser non riceve notifiche push.</p>'+open);return}
 if(active){show('<p class="ok">● Notifiche attive su questo dispositivo.</p><button class="btn" id="t">Manda una prova</button><button class="btn alt" id="x">Spegni</button>'+open);
  document.getElementById('t').onclick=test;document.getElementById('x').onclick=off;return}
 show('<p>Ricevi un avviso quando arrivano film ed episodi nuovi, da te o dagli amici, e per amicizie e aggiornamenti.</p><button class="btn" id="a">Attiva le notifiche</button>'+open);
 document.getElementById('a').onclick=on}
function when(t){return new Date(t*1000).toLocaleString('it-IT',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}
api('/list').then(function(j){if(j.notices.some(function(n){return !n.read}))api('/read','POST',{all:true});ls.innerHTML=j.notices.length?j.notices.map(function(n){return '<div class="n'+(n.read?'':' new')+'"><b>'+esc(n.title)+'</b>'+esc(n.body)+'<br><small>'+when(n.t)+'</small></div>'}).join(''):'<p>Ancora nessun avviso.</p>';
 var perm=window.Notification&&Notification.permission==='granted';
 if(perm&&'serviceWorker' in navigator)reg().then(function(r){return r.pushManager.getSubscription()}).then(function(s){if(s&&!j.push)return api('/push','POST',s.toJSON()).then(function(){return s});return s}).then(function(s){paint(!!s)});else paint(false)
},function(e){ls.innerHTML='';show('<p class="err">'+esc(e.message)+'</p>')});
`;

// Il service worker della pagina: mostra la notifica e, toccandola, apre gli avvisi
const AVVISI_SW = `
self.addEventListener('install',function(){self.skipWaiting()});
self.addEventListener('activate',function(e){e.waitUntil(self.clients.claim())});
self.addEventListener('push',function(e){var d={};try{d=e.data.json()}catch(x){d={title:'BunkerPlex',body:e.data?e.data.text():''}}
 e.waitUntil(self.registration.showNotification(d.title||'BunkerPlex',{body:d.body||'',tag:d.tag,icon:'/avvisi/icon.png',badge:'/avvisi/icon.png'}))});
self.addEventListener('notificationclick',function(e){e.notification.close();e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(function(l){for(var i=0;i<l.length;i++){if(l[i].url.indexOf('/avvisi/')>=0&&'focus' in l[i])return l[i].focus()}var b=new URLSearchParams(self.location.search).get('b');return b?self.clients.openWindow(b):null}))});
`;

// Le pagine e le chiamate dei dispositivi (senza account: vale il gettone del dispositivo)
async function noticeRoutes(request, env, url, path, method) {
  if (path === '/avvisi/sw.js' && method === 'GET') {
    return new Response(AVVISI_SW, { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache',
      'Service-Worker-Allowed': '/avvisi/' } });
  }
  if (path === '/avvisi/icon.png' && method === 'GET') {
    return new Response(unb64u(ICON_PNG.replace(/\+/g, '-').replace(/\//g, '_')), {
      headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=604800' } });
  }
  const m = /^\/avvisi\/([0-9a-f]{64})(\/manifest\.json|\/list|\/push|\/fcm|\/test|\/read)?$/.exec(path);
  if (!m) return null;
  // Le chiamate (non la pagina): le usano anche la PWA dei server di casa (altro indirizzo)
  // e l'app Android. Vale solo il gettone nell'indirizzo, niente cookie: CORS aperto.
  if (m[2] && m[2] !== '/manifest.json') {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, DELETE',
      'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' };
    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    let res;
    try {
      res = await noticeDeviceCall(request, env, url, m, method);
    } catch (e) {
      if (!(e instanceof Reply)) throw e;
      res = e.response;
    }
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  }
  return noticeDeviceCall(request, env, url, m, method);
}

async function noticeDeviceCall(request, env, url, m, method) {
  const dev = await noticeDevice(env, m[1]);
  if (!dev) {
    if (!m[2]) return page('Avvisi', '<h1>Collegamento non più valido</h1><p>Apri BunkerPlex e tocca di nuovo «Attiva le notifiche».</p>', 404);
    fail(401, 'Notifiche spente per questo dispositivo: riattivale da BunkerPlex');
  }
  if (!dev.last_seen || now() - dev.last_seen > 600) {
    await env.DB.prepare('UPDATE notice_devices SET last_seen = ? WHERE token_hash = ?').bind(now(), dev.token_hash).run();
  }
  const base = '/avvisi/' + m[1];
  if (!m[2] && method === 'GET') return avvisiPage(m[1], dev, await vapidKeys(env));
  if (m[2] === '/manifest.json' && method === 'GET') {
    return new Response(JSON.stringify({
      name: 'BunkerPlex Avvisi', short_name: 'BP Avvisi', start_url: base, scope: '/avvisi/', id: base, display: 'standalone',
      background_color: '#060a07', theme_color: '#060a07',
      icons: [{ src: '/avvisi/icon.png', sizes: '180x180', type: 'image/png', purpose: 'any' }]
    }), { headers: { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-store' } });
  }
  if (m[2] === '/list' && method === 'GET') {
    const since = Math.max(0, Number(url.searchParams.get('since') || 0) || 0);
    const rows = (await env.DB.prepare('SELECT id, kind, title, body, t, read FROM notices WHERE user_id = ? AND id > ? AND t >= ? ' +
      'ORDER BY id DESC LIMIT 30').bind(dev.user_id, since, dev.created - 60).all()).results;
    return json({ notices: rows.map(noticeJson), push: !!dev.endpoint, fcm: !!(dev.fcm && fcmAccount(env)) });
  }
  if (m[2] === '/push' && method === 'POST') {
    const b = await body(request);
    const ep = String(b.endpoint || '');
    const keys = b.keys && typeof b.keys === 'object' ? b.keys : {};
    if (!/^https:\/\/[^\s]{8,800}$/.test(ep) || !/^[A-Za-z0-9_-]{80,100}$/.test(String(keys.p256dh || '')) ||
        !/^[A-Za-z0-9_-]{16,30}$/.test(String(keys.auth || ''))) fail(400, 'Iscrizione non valida');
    // Lo stesso browser iscritto di nuovo (es. «Attiva» toccato due volte): l'avviso arriva una volta sola
    await env.DB.prepare('UPDATE notice_devices SET endpoint = NULL, p256dh = NULL, auth = NULL WHERE endpoint = ? AND token_hash != ?')
      .bind(ep, dev.token_hash).run();
    await env.DB.prepare('UPDATE notice_devices SET endpoint = ?, p256dh = ?, auth = ? WHERE token_hash = ?')
      .bind(ep, keys.p256dh, keys.auth, dev.token_hash).run();
    return json({ ok: true });
  }
  if (m[2] === '/push' && method === 'DELETE') {
    await env.DB.prepare('UPDATE notice_devices SET endpoint = NULL, p256dh = NULL, auth = NULL WHERE token_hash = ?')
      .bind(dev.token_hash).run();
    return json({ ok: true });
  }
  // L'app Android manda il suo gettone FCM (anche quando Firebase lo cambia).
  // fcm: false = qui FCM non e' configurato, l'app continua a controllare da sola.
  if (m[2] === '/fcm' && method === 'POST') {
    const b = await body(request);
    const tok = String(b.token || '');
    if (!/^[A-Za-z0-9_:.-]{20,1024}$/.test(tok)) fail(400, 'Gettone FCM non valido');
    // Lo stesso telefono iscritto due volte (es. account cambiato): resta solo l'ultimo
    await env.DB.prepare('UPDATE notice_devices SET fcm = NULL WHERE fcm = ? AND token_hash != ?').bind(tok, dev.token_hash).run();
    await env.DB.prepare('UPDATE notice_devices SET fcm = ? WHERE token_hash = ?').bind(tok, dev.token_hash).run();
    return json({ ok: true, fcm: !!fcmAccount(env) });
  }
  if (m[2] === '/fcm' && method === 'DELETE') {
    await env.DB.prepare('UPDATE notice_devices SET fcm = NULL WHERE token_hash = ?').bind(dev.token_hash).run();
    return json({ ok: true });
  }
  if (m[2] === '/read' && method === 'POST') {
    return json({ unread: await markRead(env, dev.user_id, await body(request)) });
  }
  if (m[2] === '/test' && method === 'POST') {
    if (!dev.endpoint && !(dev.fcm && fcmAccount(env))) fail(409, 'Prima attiva le notifiche');
    const code = await pushDevice(env, dev, { title: 'BunkerPlex', body: 'Le notifiche funzionano su questo dispositivo.', tag: 'bp-test' });
    if (!code || code >= 300) fail(502, 'Il servizio di notifiche del telefono ha risposto ' + code);
    return json({ ok: true });
  }
  fail(405, 'Richiesta non valida');
}

// Le chiamate con l'account (dal server di casa)
async function noticeAccountRoutes(request, env, url, path, method, user) {
  if (!path.startsWith('/notices')) return null;
  await ensureNotices(env);
  // Un evento dal server di casa: a te, e (se lo dici) ai tuoi amici
  if (path === '/notices' && method === 'POST') {
    const b = await body(request);
    const kind = b.kind === 'update' ? 'update' : 'titles';
    const title = cleanText(b.title, 80) || fail(400, 'Manca il titolo');
    const text = cleanText(b.body, 240);
    const sent = await env.DB.prepare('SELECT COUNT(*) n FROM notices WHERE from_user = ? AND t > ?').bind(user.id, now() - 3600).first('n');
    if (sent >= NOTICE_RATE) fail(429, 'Troppi avvisi: riprova più tardi');
    const ids = [await notify(env, user.id, kind, title, text, user.id)];
    if (b.friends && kind === 'titles') {
      const ftitle = cleanText(b.friends_title, 80) || title;
      for (const fid of (await friendIds(env, user.id)).slice(0, 30)) {
        ids.push(await notify(env, fid, 'friends_titles', ftitle, cleanText(b.friends_body, 240) || text, user.id));
      }
    }
    return json({ ok: true, sent: ids.filter(Boolean).length });
  }
  if (path === '/notices' && method === 'GET') {
    const rows = (await env.DB.prepare('SELECT id, kind, title, body, t, read FROM notices WHERE user_id = ? ORDER BY id DESC LIMIT 50')
      .bind(user.id).all()).results;
    const unread = await env.DB.prepare('SELECT COUNT(*) n FROM notices WHERE user_id = ? AND read = 0').bind(user.id).first('n');
    return json({ notices: rows.map(noticeJson), unread });
  }
  if (path === '/notices/read' && method === 'POST') {
    return json({ unread: await markRead(env, user.id, await body(request)) });
  }
  if (path === '/notices/prefs' && method === 'GET') return json({ prefs: await noticePrefs(env, user.id) });
  if (path === '/notices/prefs' && method === 'PUT') {
    const b = await body(request);
    const p = await noticePrefs(env, user.id);
    for (const k of NOTICE_KINDS) if (typeof b[k] === 'boolean') p[k] = b[k];
    await env.DB.prepare('INSERT OR REPLACE INTO notice_prefs(user_id, v) VALUES(?, ?)').bind(user.id, JSON.stringify(p)).run();
    return json({ prefs: p });
  }
  // I telefoni e tablet dell'account
  if (path === '/notices/devices' && method === 'GET') {
    // push: arrivano subito (Web Push, o FCM se qui e' configurato); fcm: con Firebase
    const fcm = !!fcmAccount(env);
    const rows = (await env.DB.prepare('SELECT rowid AS id, label, kind, created, last_seen, endpoint IS NOT NULL AS web, ' +
      'fcm IS NOT NULL AS fcm FROM notice_devices WHERE user_id = ? ORDER BY created DESC').bind(user.id).all()).results;
    return json({ devices: rows.map(({ web, fcm: f, ...r }) => ({ ...r, push: !!web || (fcm && !!f), fcm: fcm && !!f })) });
  }
  if (path === '/notices/devices' && method === 'POST') {
    const b = await body(request);
    const kind = ['ios', 'android', 'web'].includes(b.kind) ? b.kind : 'web';
    const open = /^https?:\/\/[^\s"'<>]{3,200}$/.test(String(b.open || '')) ? String(b.open) : '';
    const n = await env.DB.prepare('SELECT COUNT(*) n FROM notice_devices WHERE user_id = ?').bind(user.id).first('n');
    if (n >= NOTICE_DEVICES) {     // al limite si toglie quello sentito meno di recente
      await env.DB.prepare('DELETE FROM notice_devices WHERE token_hash = (SELECT token_hash FROM notice_devices ' +
        'WHERE user_id = ? ORDER BY COALESCE(last_seen, created) LIMIT 1)').bind(user.id).run();
    }
    const token = randomHex(32);
    await env.DB.prepare('INSERT INTO notice_devices(token_hash, user_id, label, kind, open_url, created) VALUES(?,?,?,?,?,?)')
      .bind(await sha256(token), user.id, cleanText(b.label, 60) || 'Dispositivo', kind, open, now()).run();
    // key: la chiave VAPID pubblica, per l'iscrizione Web Push della PWA (service worker suo)
    return json({ token, url: url.origin + '/avvisi/' + token, key: (await vapidKeys(env)).pub });
  }
  const dm = /^\/notices\/devices\/(\d+)$/.exec(path);
  if (dm && method === 'DELETE') {
    await env.DB.prepare('DELETE FROM notice_devices WHERE rowid = ? AND user_id = ?').bind(Number(dm[1]), user.id).run();
    return json({ ok: true });
  }
  fail(404, 'Non trovato');
}

// ---- La PWA: i file dell'interfaccia (server/static, vedi wrangler.toml [assets])
//
// La stessa interfaccia dei server, servita da qui: con <meta name="bp-central">
// sa di essere la PWA centrale (accesso con l'account, scelta del server, poi
// collegamento diretto al server). GET / con Accept: application/json resta lo
// stato del servizio (lo chiedono i server e le app).

const PWA_FILES = /^\/(app\.js|style\.css|sw\.js|manifest\.json|icons\/[A-Za-z0-9._-]+)$/;

async function pwaAsset(request, env, path) {
  if (!env.ASSETS) return null;
  if (path === '/') {
    if ((request.headers.get('Accept') || '').includes('application/json')) return null;
    const res = await env.ASSETS.fetch(new Request(new URL('/', request.url), request));
    if (!res.ok) return res;
    const html = (await res.text()).replace('<head>', '<head>\n<meta name="bp-central" content="1">');
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' } });
  }
  return PWA_FILES.test(path) || path === '/index.html' ? env.ASSETS.fetch(request) : null;
}

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method;

  // L'app Android del telefono e' di questo servizio: le sue passkey valgono qui
  // (impronta e volto dentro la WebView). ANDROID_CERT_SHA256: impronte SHA-256 dei
  // certificati di firma dell'APK, separate da virgole (AA:BB:...).
  if (path === '/.well-known/assetlinks.json' && method === 'GET') {
    const prints = String(env.ANDROID_CERT_SHA256 || '').split(',').map((s) => s.trim().toUpperCase())
      .filter((s) => /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(s));
    if (!prints.length) fail(404, 'Nessuna app dichiarata');
    return new Response(JSON.stringify([{
      relation: ['delegate_permission/common.handle_all_urls', 'delegate_permission/common.get_login_creds'],
      target: { namespace: 'android_app', package_name: 'it.bunkerplex.tv', sha256_cert_fingerprints: prints }
    }]), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' } });
  }

  if (method === 'GET' || method === 'HEAD') {
    const asset = await pwaAsset(request, env, path);
    if (asset) return asset;
  }

  if (path === '/' && method === 'GET') {
    const n = await env.DB.prepare('SELECT COUNT(*) n FROM users').first('n');
    return json({ app: 'bunkerplex-account', version: 1, ready: n > 0, google: googleOn(env), reset: resetOn(env), certs: certOn(env), passkeys: true });
  }

  // L'indirizzo pubblico di chi chiama (lo mostra BunkerPlex in Impostazioni)
  if (path === '/ip' && method === 'GET') {
    return json({ ip: request.headers.get('CF-Connecting-IP') || '' });
  }

  if (path.startsWith('/aggiornamenti/') && method === 'GET') {
    return updates(request, env, url);
  }
  if (path === '/scarica' && method === 'GET') {
    return download(env);
  }

  // Primo amministratore: solo se non c'e' ancora nessun account e con la chiave segreta
  if (path === '/setup' && method === 'POST') {
    const b = await body(request);
    if (!env.SETUP_KEY || !sameString(String(b.setup_key || ''), env.SETUP_KEY)) fail(403, 'Chiave di installazione sbagliata');
    const n = await env.DB.prepare('SELECT COUNT(*) n FROM users').first('n');
    if (n > 0) fail(409, "L'amministratore esiste già");
    const username = cleanName(b.username);
    const pw = await passwordFields(cleanVerifier(b.verifier));
    await env.DB.prepare('INSERT INTO users(username, salt, hash, must_change, admin, created) VALUES(?,?,?,0,1,?)')
      .bind(username, pw.salt, pw.hash, now()).run();
    const user = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
    return json({ token: await newSession(env, user, b.device, b.kind), user: userJson(user) });
  }

  // Entrare con l'email: prima il nome utente (vedi nameForEmail)
  if (path === '/resolve' && method === 'POST') {
    await ensureGoogle(env);
    const b = await body(request);
    return json({ username: await nameForEmail(env, cleanEmail(b.email) || fail(400, 'Scrivi l\'email')) });
  }

  // Accesso a passi: prima l'email. activate: account invitato (o con password
  // provvisoria) da attivare, con needs_name se deve ancora scegliere il nome. Per
  // un'email sconosciuta risponde come per un account normale (nome finto).
  if (path === '/lookup' && method === 'POST') {
    await ensureGoogle(env);
    const email = cleanEmail((await body(request)).email) || fail(400, 'Scrivi l\'email');
    const u = await userForEmail(env, email);
    if (u && u.must_change && !u.disabled) {
      return json({ username: u.username, activate: true, needs_name: pendingName(u.username) });
    }
    return json({ username: await nameForEmail(env, email), activate: false, needs_name: false });
  }

  // «Mandami un link»: entrare senza password (vedi magicStart)
  if (path === '/magic/start' && method === 'POST') {
    if (!resetOn(env)) fail(404, 'L\'accesso con il link non è attivo nel servizio account');
    await ensureGoogle(env);
    await magicStart(env, cleanEmail((await body(request)).email) || fail(400, 'Scrivi l\'email'), url.origin);
    return json({ ok: true });
  }
  if (path === '/magic/finish' && method === 'POST') {
    await ensureGoogle(env);
    const b = await body(request);
    const user = await magicFinish(env, cleanEmail(b.email) || fail(400, 'Scrivi l\'email'), b.token);
    return json({ token: await newSession(env, user, b.device, b.kind), user: userJson(user) });
  }

  // Attivazione dal link dell'invito: email + gettone, poi nome (se serve) e password
  if (path === '/activate' && method === 'POST') {
    await ensureGoogle(env);
    await ensureActivate(env);
    const b = await body(request);
    const bad = () => fail(400, 'Link di attivazione non valido o scaduto: entra con la password provvisoria dell\'email');
    const user = await userForEmail(env, cleanEmail(b.email) || fail(400, 'Scrivi l\'email'));
    if (!user || !user.must_change) bad();
    if (user.disabled) fail(403, "Questo account è disattivato: chiedi all'amministratore");
    const row = await env.DB.prepare('SELECT * FROM activations WHERE user_id = ?').bind(user.id).first();
    if (!row || row.exp < now() || !sameString(await sha256(String(b.token || '')), row.token_hash)) bad();
    let username = user.username;
    if (pendingName(user.username)) {
      username = cleanName(b.new_username);
      if (pendingName(username) || /^invito-/i.test(username)) fail(400, 'Scegli un nome tuo');
      const other = await env.DB.prepare('SELECT id FROM users WHERE username = ? AND id <> ?').bind(username, user.id).first();
      if (other) fail(409, 'Questo nome è già di un altro account: scegline un altro');
    }
    const pw = await passwordFields(cleanVerifier(b.verifier));
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET username = ?, salt = ?, hash = ?, must_change = 0, fails = 0, locked_until = 0 WHERE id = ?')
        .bind(username, pw.salt, pw.hash, user.id),
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
      env.DB.prepare('DELETE FROM activations WHERE user_id = ?').bind(user.id)
    ]);
    const fresh = { ...user, username, must_change: 0 };
    return json({ token: await newSession(env, fresh, b.device, b.kind), user: userJson(fresh) });
  }

  if (path === '/login' && method === 'POST') {
    const b = await body(request);
    const verifier = cleanVerifier(b.verifier);
    const user = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(String(b.username || '').trim()).first();
    if (!user) fail(401, 'Nome utente o password sbagliati');
    await checkPassword(env, user, verifier);
    return json({ token: await newSession(env, user, b.device, b.kind), user: userJson(user) });
  }

  // Password dimenticata (vedi resetStart)
  if (path === '/reset/start' && method === 'POST') {
    if (!resetOn(env)) fail(404, 'Il recupero della password non è attivo nel servizio account');
    await resetStart(env, cleanEmail((await body(request)).email) || fail(400, 'Scrivi l\'email'), url.origin);
    return json({ ok: true });
  }
  if (path === '/reset/finish' && method === 'POST') {
    if (!resetOn(env)) fail(404, 'Il recupero della password non è attivo nel servizio account');
    const b = await body(request);
    const user = await resetFinish(env, cleanEmail(b.email) || fail(400, 'Scrivi l\'email'), b.code, cleanVerifier(b.verifier));
    return json({ token: await newSession(env, user, b.device, b.kind), user: userJson(user) });
  }

  const g = await googleRoutes(request, env, url, path, method);
  if (g) return g;
  const pk = await passkeyRoutes(request, env, url, path, method);
  if (pk) return pk;
  const tp = await tvPublicRoutes(request, env, url, path, method);
  if (tp) return tp;
  const nr = await noticeRoutes(request, env, url, path, method);
  if (nr) return nr;
  // L'immagine di un server (pubblica: e' solo la copertina, l'indirizzo cambia a ogni modifica)
  const im = /^\/servers\/([0-9a-f]{8})\/image$/.exec(path);
  if (im && method === 'GET') {
    await ensureLook(env);
    const r = await env.DB.prepare('SELECT image FROM server_look WHERE sid = ?').bind(im[1]).first();
    const m = r && r.image ? /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(r.image) : null;
    if (!m) fail(404, 'Nessuna immagine');
    const bin = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
    return new Response(bin, { headers: { 'Content-Type': m[1], 'Cache-Control': 'public, max-age=31536000, immutable',
      'Access-Control-Allow-Origin': '*' } });
  }
  const sr = await serverRoutes(request, env, path, method);
  if (sr) return sr;
  const cp = await claimPublicRoutes(request, env, path, method);
  if (cp) return cp;

  const user = (await serverAsOwner(request, env, path, method)) || await auth(request, env);
  const dr = await deviceRoutes(env, path, method, user);
  if (dr) return dr;
  const tu = await tvUserRoutes(request, env, path, method, user);
  if (tu) return tu;
  const na = await noticeAccountRoutes(request, env, url, path, method, user);
  if (na) return na;

  if (path === '/me' && method === 'GET') return json({ user: userJson(user) });

  if (path === '/logout' && method === 'POST') {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(user.token_hash).run();
    return json({ ok: true });
  }

  if (path === '/password' && method === 'POST') {
    const b = await body(request);
    await checkPassword(env, user, cleanVerifier(b.verifier));
    const pw = await passwordFields(cleanVerifier(b.new_verifier));
    // Primo accesso di un invitato: insieme alla password sceglie il suo nome (la verifica
    // nuova il server di casa la calcola gia' su questo nome)
    let username = user.username;
    if (b.new_username !== undefined && b.new_username !== null && b.new_username !== '') {
      if (!user.must_change && !pendingName(user.username)) fail(400, 'Il nome si sceglie solo al primo accesso');
      username = cleanName(b.new_username);
      if (pendingName(username) || /^invito-/i.test(username)) fail(400, 'Scegli un nome tuo');
      const other = await env.DB.prepare('SELECT id FROM users WHERE username = ? AND id <> ?').bind(username, user.id).first();
      if (other) fail(409, 'Questo nome è già di un altro account: scegline un altro');
    } else if (pendingName(user.username)) {
      fail(400, 'Scegli il tuo nome');
    }
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET username = ?, salt = ?, hash = ?, must_change = 0 WHERE id = ?').bind(username, pw.salt, pw.hash, user.id),
      // Gli altri server collegati devono rientrare con la password nuova
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').bind(user.id, user.token_hash)
    ]);
    return json({ ok: true, user: userJson({ ...user, username, must_change: 0 }) });
  }

  // Invitato entrato con Google: sceglie solo il nome. Da qui entra con Google (la
  // password provvisoria smette di valere; una sua la puo' avere con «Password dimenticata?»).
  if (path === '/name' && method === 'POST') {
    if (!user.must_change || !user.google_sub) fail(400, 'Il nome si sceglie solo al primo accesso');
    let username = user.username;
    if (pendingName(user.username)) {
      username = cleanName((await body(request)).username);
      if (pendingName(username) || /^invito-/i.test(username)) fail(400, 'Scegli un nome tuo');
      const other = await env.DB.prepare('SELECT id FROM users WHERE username = ? AND id <> ?').bind(username, user.id).first();
      if (other) fail(409, 'Questo nome è già di un altro account: scegline un altro');
    }
    const pw = await passwordFields(randomHex(32));
    await env.DB.prepare('UPDATE users SET username = ?, salt = ?, hash = ?, must_change = 0, no_password = 1 WHERE id = ?')
      .bind(username, pw.salt, pw.hash, user.id).run();
    return json({ ok: true, user: userJson({ ...user, username, must_change: 0, no_password: 1 }) });
  }

  // L'email con cui l'account entra (vuota: la toglie; resta il nome utente)
  if (path === '/email' && method === 'PUT') {
    await ensureGoogle(env);
    const email = cleanEmail((await body(request)).email);
    if (email) await emailFree(env, email, user.id);
    await env.DB.prepare('UPDATE users SET email = ? WHERE id = ?').bind(email || null, user.id).run();
    return json({ ok: true, user: userJson({ ...user, email }) });
  }

  if (user.must_change) fail(403, 'Prima cambia la password provvisoria');

  const us = await userServerRoutes(request, env, path, method, user);
  if (us) return us;
  const pr = await profileRoutes(request, env, url, path, method, user);
  if (pr) return pr;

  // ---- Impostazioni: {chiave: {v, t}}; vince il valore con t piu' recente
  if (path === '/settings' && method === 'GET') {
    const rows = await env.DB.prepare('SELECT k, v, t FROM settings WHERE user_id = ?').bind(user.id).all();
    const data = {};
    for (const r of rows.results) data[r.k] = { v: JSON.parse(r.v), t: r.t };
    return json({ data });
  }
  if (path === '/settings' && method === 'PUT') {
    const b = await body(request);
    const entries = Object.entries(b.data || {}).slice(0, MAX_ROWS);
    const stmts = [];
    for (const [k, e] of entries) {
      if (!/^[a-z0-9_.]{1,40}$/.test(k) || !e || typeof e.t !== 'number') continue;
      const v = JSON.stringify(e.v === undefined ? null : e.v);
      if (v.length > 20000) continue;
      stmts.push(env.DB.prepare(
        'INSERT INTO settings(user_id, k, v, t) VALUES(?,?,?,?) ' +
        'ON CONFLICT(user_id, k) DO UPDATE SET v = excluded.v, t = excluded.t WHERE excluded.t > settings.t'
      ).bind(user.id, k, v, Math.min(e.t, now() + 60)));
    }
    if (stmts.length) await env.DB.batch(stmts);
    return json({ ok: true, saved: stmts.length });
  }

  // ---- Visti / ripresa / lista. Chiavi: m<tmdb> film, s<tmdb> serie, e<tmdb>:<stagione>:<episodio>
  if (path === '/state' && method === 'GET') {
    const since = Number(url.searchParams.get('since') || 0);
    const pid = await stateProfile(env, user, url);
    const rows = pid ? await env.DB.prepare(
      'SELECT k, pos, w, fav, lp, t, rev FROM pstate WHERE user_id = ? AND pid = ? AND rev > ? ORDER BY rev LIMIT 2000'
    ).bind(user.id, pid, since).all() : await env.DB.prepare(
      'SELECT k, pos, w, fav, lp, t, rev FROM state WHERE user_id = ? AND rev > ? ORDER BY rev LIMIT 2000'
    ).bind(user.id, since).all();
    return json({ rows: rows.results, more: rows.results.length === 2000 });
  }
  if (path === '/state' && method === 'POST') {
    const b = await body(request);
    const rows = Array.isArray(b.rows) ? b.rows.slice(0, MAX_ROWS) : [];
    const rev = Date.now();
    const pid = await stateProfile(env, user, url);
    const stmts = [];
    for (const r of rows) {
      if (!r || !/^(m\d+|s\d+|e\d+:\d+:\d+)$/.test(String(r.k)) || typeof r.t !== 'number') continue;
      if (pid) {
        stmts.push(env.DB.prepare(
          'INSERT INTO pstate(user_id, pid, k, pos, w, fav, lp, t, rev) VALUES(?,?,?,?,?,?,?,?,?) ' +
          'ON CONFLICT(user_id, pid, k) DO UPDATE SET pos = excluded.pos, w = excluded.w, fav = excluded.fav, ' +
          'lp = excluded.lp, t = excluded.t, rev = excluded.rev WHERE excluded.t > pstate.t'
        ).bind(user.id, pid, r.k, Number(r.pos) || 0, r.w ? 1 : 0, Number(r.fav) || 0, Number(r.lp) || 0,
          Math.min(r.t, now() + 60), rev));
        continue;
      }
      stmts.push(env.DB.prepare(
        'INSERT INTO state(user_id, k, pos, w, fav, lp, t, rev) VALUES(?,?,?,?,?,?,?,?) ' +
        'ON CONFLICT(user_id, k) DO UPDATE SET pos = excluded.pos, w = excluded.w, fav = excluded.fav, ' +
        'lp = excluded.lp, t = excluded.t, rev = excluded.rev WHERE excluded.t > state.t'
      ).bind(user.id, r.k, Number(r.pos) || 0, r.w ? 1 : 0, Number(r.fav) || 0, Number(r.lp) || 0,
        Math.min(r.t, now() + 60), rev));
    }
    if (stmts.length) await env.DB.batch(stmts);
    return json({ ok: true, saved: stmts.length, rev });
  }

  // ---- Amici: amicizie tra account, la rubrica dei server, i biglietti d'ingresso.
  // Un'amicizia nasce come richiesta (a -> b, 'pending') e diventa 'ok' quando b accetta.
  // Ogni server che condivide pubblica qui il suo indirizzo e l'impronta del suo
  // certificato: gli amici li leggono da qui (niente indirizzi da dettare, niente
  // fiducia «al primo collegamento»). Per entrare dal server di un amico si chiede
  // qui un biglietto: vale 5 minuti e una volta sola, e quel server lo fa controllare qui.
  if (path === '/friends' && method === 'GET') {
    await ensureServerCols(env);
    const rows = await env.DB.prepare(
      'SELECT f.a, f.b, f.status, f.t, ua.username AS ua, ub.username AS ub FROM friends f ' +
      'JOIN users ua ON ua.id = f.a JOIN users ub ON ub.id = f.b WHERE f.a = ? OR f.b = ?'
    ).bind(user.id, user.id).all();
    // I server condivisi da tutti gli amici in una query sola (una per amico
    // superava il limite di query per richiesta di D1 con ~45 amici)
    const shared = await env.DB.prepare(
      "SELECT s.user_id, s.sid, s.name, s.url, s.pin, s.t FROM servers s JOIN friends f ON f.status = 'ok' AND " +
      "((f.a = ? AND f.b = s.user_id) OR (f.b = ? AND f.a = s.user_id)) WHERE s.friends = 1 AND s.url <> ''"
    ).bind(user.id, user.id).all();
    const byUser = new Map();
    for (const s of shared.results) {
      const { user_id: uid, ...srv } = s;
      if (!byUser.has(uid)) byUser.set(uid, []);
      byUser.get(uid).push(srv);
    }
    const out = [];
    for (const r of rows.results) {
      const other = r.a === user.id ? r.b : r.a;
      const item = {
        id: other, username: r.a === user.id ? r.ub : r.ua, t: r.t,
        status: r.status === 'ok' ? 'ok' : (r.a === user.id ? 'sent' : 'received'), servers: []
      };
      if (item.status === 'ok') item.servers = byUser.get(other) || [];
      out.push(item);
    }
    // I propri server accesi: da ogni PC dell'account si arriva agli altri (anche
    // quelli che non condividono con gli amici). lan = indirizzo nella rete di casa.
    const mine = await env.DB.prepare("SELECT sid, name, url, lan, pin, t FROM servers WHERE user_id = ? AND url <> ''").bind(user.id).all();
    // L'aspetto dei server (anche di quelli spenti o di questo PC: lo chiede il server di casa)
    await ensureCreds(env);
    const own = await env.DB.prepare('SELECT sid FROM servers WHERE user_id = ? UNION SELECT sid FROM server_creds WHERE owner_id = ?')
      .bind(user.id, user.id).all();
    const looks = await looksFor(env, new URL(request.url).origin,
      [...shared.results.map((s) => s.sid), ...own.results.map((s) => s.sid)]);
    const empty = { icon: '', image: '' };
    for (const f of out) for (const s of f.servers) s.look = looks.get(s.sid) || empty;
    for (const s of mine.results) s.look = looks.get(s.sid) || empty;
    const ownLooks = {};
    for (const r of own.results) if (looks.has(r.sid)) ownLooks[r.sid] = looks.get(r.sid);
    return json({ friends: out, me: user.id, mine: mine.results, looks: ownLooks });
  }
  if (path === '/friends' && method === 'POST') {
    const b = await body(request);
    const name = cleanName(b.username);
    const other = await env.DB.prepare('SELECT id, username FROM users WHERE username = ?').bind(name).first();
    if (!other) fail(404, 'Non esiste un account con questo nome');
    if (other.id === user.id) fail(400, 'Questo sei tu');
    const back = await env.DB.prepare('SELECT status FROM friends WHERE a = ? AND b = ?').bind(other.id, user.id).first();
    if (back) {                         // lui l'aveva gia' chiesto a te: siete amici
      await env.DB.prepare("UPDATE friends SET status = 'ok', t = ? WHERE a = ? AND b = ?").bind(now(), other.id, user.id).run();
      await notifySafe(env, other.id, 'friends', 'Nuovo amico', user.username + ' ha accettato la tua richiesta di amicizia.', user.id);
      return json({ ok: true, status: 'ok', username: other.username });
    }
    const n = await env.DB.prepare("SELECT COUNT(*) n FROM friends WHERE a = ? AND status = 'pending'").bind(user.id).first('n');
    if (n >= 20) fail(429, 'Troppe richieste in attesa');
    const added = await env.DB.prepare('INSERT OR IGNORE INTO friends(a, b, status, t) VALUES(?,?,?,?)')
      .bind(user.id, other.id, 'pending', now()).run();
    if (added.meta.changes) {
      await notifySafe(env, other.id, 'friends', 'Richiesta di amicizia', user.username + ' vuole essere tuo amico su BunkerPlex. Rispondi da Impostazioni → Amici.', user.id);
    }
    return json({ ok: true, status: 'sent', username: other.username });
  }
  const fm = /^\/friends\/(\d+)(\/accept)?$/.exec(path);
  if (fm) {
    const other = Number(fm[1]);
    if (fm[2] && method === 'POST') {
      const r = await env.DB.prepare("UPDATE friends SET status = 'ok', t = ? WHERE a = ? AND b = ? AND status = 'pending'")
        .bind(now(), other, user.id).run();
      if (!r.meta.changes) fail(404, 'Richiesta non trovata');
      await notifySafe(env, other, 'friends', 'Nuovo amico', user.username + ' ha accettato la tua richiesta di amicizia.', user.id);
      return json({ ok: true });
    }
    if (!fm[2] && method === 'DELETE') {   // rifiuta, annulla o togli l'amicizia
      await env.DB.prepare('DELETE FROM friends WHERE (a = ? AND b = ?) OR (a = ? AND b = ?)')
        .bind(user.id, other, other, user.id).run();
      return json({ ok: true });
    }
  }
  // Tailscale dentro BunkerPlex: una chiave monouso (10 minuti) per far entrare il
  // dispositivo che la chiede (un PC, o l'app su telefono/TV fuori casa) nella rete
  // Tailscale di BunkerPlex, con l'etichetta tag:bunkerplex. La crea qui il client
  // OAuth dell'amministratore (segreti TS_OAUTH_ID e TS_OAUTH_SECRET, permessi
  // «Auth Keys: write» e «Devices: Core» su quell'etichetta): i dispositivi non
  // vedono mai il segreto. Senza segreti risponde 404 e i PC restano sulla porta
  // aperta sul router.
  //
  // Ogni account ha al massimo DEVICE_LIMIT dispositivi nella rete (il piano gratuito
  // di Tailscale ne conta 100 in tutto). Conta quelli presenti ora in Tailscale: chi
  // ne toglie uno libera subito il posto. Al limite si risponde 409 con l'elenco, e il
  // dispositivo nuovo chiede all'utente quale togliere (replace = id da togliere).
  if (path === '/tailscale/key' && method === 'POST') {
    const b = await body(request);
    const ts = await tsAccess(env);
    const host = cleanHost(b.host);
    const ephemeral = b.ephemeral === true;      // l'app: sparisce da sola quando si spegne
    // Senza nome non si potrebbe contare il dispositivo: il limite si salterebbe
    if (!host) fail(400, 'Manca il nome del dispositivo: aggiorna BunkerPlex');
    {
      await ensureDevices(env);
      // Un nome che e' gia' di un altro account non si prende finche' quel dispositivo
      // e' nella rete (prima l'ultimo che chiedeva diventava il padrone, e poteva
      // togliere il PC di un amico, il cui nome bunkerplex-<sid> e' noto).
      const owner = await env.DB.prepare('SELECT user_id FROM ts_devices WHERE host = ?').bind(host).first();
      if (owner && owner.user_id !== user.id && await tsHostInUse(ts, host) !== false) {
        fail(403, 'Questo nome di dispositivo è di un altro account');
      }
      const mine = await userDevices(env, ts, user.id);
      if (mine) {
        const others = mine.filter((d) => d.host !== host);
        const replace = String(b.replace || '');
        if (replace) {
          const d = others.find((x) => x.id === replace);
          if (!d) fail(404, 'Dispositivo non trovato tra i tuoi');
          await tsDeleteDevice(ts, d);
          await env.DB.prepare('DELETE FROM ts_devices WHERE host = ?').bind(d.host).run();
        } else if (others.length >= DEVICE_LIMIT) {
          throw new Reply(json({
            detail: `Hai già ${DEVICE_LIMIT} dispositivi nella rete di BunkerPlex: togline uno per far entrare questo`,
            limit: DEVICE_LIMIT, devices: others
          }, 409));
        }
      }
      const kind = b.kind === 'pc' ? 'pc' : 'app';
      await env.DB.prepare('INSERT INTO ts_devices(host, user_id, label, kind, t) VALUES(?,?,?,?,?) ' +
        'ON CONFLICT(host) DO UPDATE SET user_id = excluded.user_id, label = excluded.label, kind = excluded.kind, t = excluded.t')
        .bind(host, user.id, String(b.label || '').slice(0, 60), kind, now()).run();
    }
    const kr = await fetch('https://api.tailscale.com/api/v2/tailnet/-/keys', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + ts.access, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        capabilities: { devices: { create: { reusable: false, ephemeral, preauthorized: true, tags: [ts.tag] } } },
        expirySeconds: 600,
        description: 'BunkerPlex'
      })
    });
    const k = kr.ok ? await kr.json() : null;
    if (!k || typeof k.key !== 'string') fail(502, 'Tailscale non ha dato la chiave (errore ' + kr.status + ')');
    return json({ key: k.key, tag: ts.tag, limit: DEVICE_LIMIT });
  }
  // I dispositivi dell'account nella rete di BunkerPlex, e «Togli»
  if (path === '/tailscale/devices' && method === 'GET') {
    await ensureDevices(env);
    const mine = await userDevices(env, await tsAccess(env), user.id);
    if (!mine) fail(503, 'Al servizio account manca il permesso «Devices: Core» di Tailscale');
    return json({ limit: DEVICE_LIMIT, devices: mine });
  }
  const dm = /^\/tailscale\/devices\/([A-Za-z0-9]{1,40})$/.exec(path);
  if (dm && method === 'DELETE') {
    await ensureDevices(env);
    const ts = await tsAccess(env);
    const mine = await userDevices(env, ts, user.id);
    if (!mine) fail(503, 'Al servizio account manca il permesso «Devices: Core» di Tailscale');
    const d = mine.find((x) => x.id === dm[1]);
    if (!d) fail(404, 'Dispositivo non trovato tra i tuoi');
    await tsDeleteDevice(ts, d);
    await env.DB.prepare('DELETE FROM ts_devices WHERE host = ?').bind(d.host).run();
    return json({ ok: true });
  }
  if (path === '/servers' && method === 'PUT') {
    await ensureServerCols(env);
    const b = await body(request);
    const sid = String(b.sid || '');
    const url = String(b.url || '');
    const lan = String(b.lan || '');
    if (!/^[0-9a-f]{8}$/.test(sid) || !/^https:\/\/[^\s/]{3,200}$/.test(url) || !/^[0-9a-f]{64}$/.test(String(b.pin || '')) ||
        (lan && !/^https:\/\/[^\s/]{3,200}$/.test(lan))) {
      fail(400, 'Richiesta non valida');
    }
    if (await hasCredential(env, user.id, sid)) fail(409, 'Questo server si aggiorna da solo con la sua credenziale');
    await serverWriter(env, user, sid);
    await env.DB.prepare('INSERT INTO servers(user_id, sid, name, url, lan, friends, pin, t, token_hash) VALUES(?,?,?,?,?,?,?,?,?) ' +
      'ON CONFLICT(user_id, sid) DO UPDATE SET name = excluded.name, url = excluded.url, lan = excluded.lan, ' +
      'friends = excluded.friends, pin = excluded.pin, t = excluded.t, token_hash = excluded.token_hash')
      .bind(user.id, sid, String(b.name || '').slice(0, 40), url, lan, b.friends === false ? 0 : 1, b.pin, now(), user.token_hash).run();
    return json({ ok: true });
  }
  const sm = /^\/servers\/([0-9a-f]{8})$/.exec(path);
  if (sm && method === 'DELETE') {
    await ensureServerCols(env);
    if (await hasCredential(env, user.id, sm[1])) fail(409, 'Questo server si aggiorna da solo con la sua credenziale');
    await serverWriter(env, user, sm[1]);
    await env.DB.prepare('DELETE FROM servers WHERE user_id = ? AND sid = ?').bind(user.id, sm[1]).run();
    return json({ ok: true });
  }
  if (path === '/tickets' && method === 'POST') {
    const b = await body(request);
    const to = Number(b.to);
    // Verso un altro server del proprio account non serve l'amicizia
    const ok = to === user.id || await env.DB.prepare("SELECT 1 FROM friends WHERE status = 'ok' AND ((a = ? AND b = ?) OR (a = ? AND b = ?))")
      .bind(user.id, to, to, user.id).first();
    if (!ok) fail(403, 'Non siete amici');
    await ensureServerCols(env);
    const server = await env.DB.prepare('SELECT 1 FROM servers WHERE user_id = ? AND sid = ? AND (friends = 1 OR user_id = ?)')
      .bind(to, String(b.sid || ''), user.id).first();
    if (!server) fail(404, 'Questo server non condivide più');
    const ticket = randomHex(32);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM tickets WHERE exp < ?').bind(now()),
      env.DB.prepare('INSERT INTO tickets(hash, from_user, to_user, sid, exp) VALUES(?,?,?,?,?)')
        .bind(await sha256(ticket), user.id, to, String(b.sid), now() + 300)
    ]);
    return json({ ticket });
  }
  if (path === '/tickets/check' && method === 'POST') {
    const b = await body(request);
    const th = await sha256(String(b.ticket || ''));
    const t = await env.DB.prepare('SELECT * FROM tickets WHERE hash = ?').bind(th).first();
    if (!t || t.exp < now() || t.to_user !== user.id || t.sid !== String(b.sid || '')) fail(403, 'Biglietto non valido');
    await env.DB.prepare('DELETE FROM tickets WHERE hash = ?').bind(th).run();
    const ok = t.from_user === user.id || await env.DB.prepare("SELECT 1 FROM friends WHERE status = 'ok' AND ((a = ? AND b = ?) OR (a = ? AND b = ?))")
      .bind(t.from_user, user.id, user.id, t.from_user).first();
    if (!ok) fail(403, 'Non siete amici');
    const from = await env.DB.prepare('SELECT id, username FROM users WHERE id = ?').bind(t.from_user).first();
    return json({ from });
  }

  // ---- Gestione account (solo amministratori)
  if (path.startsWith('/admin/')) {
    if (!user.admin) fail(403, "Solo l'amministratore può gestire gli account");

    await ensureGoogle(env);
    if (path === '/admin/users' && method === 'GET') {
      const rows = await env.DB.prepare(
        'SELECT u.id, u.username, u.admin, u.must_change, u.created, u.google_sub, u.google_email, u.email, u.disabled, ' +
        'MAX(s.last_seen) last_seen, COUNT(s.token_hash) servers ' +
        'FROM users u LEFT JOIN sessions s ON s.user_id = u.id GROUP BY u.id ORDER BY u.username COLLATE NOCASE'
      ).all();
      return json({ users: rows.results.map((r) => {
        const { google_sub, google_email, ...rest } = r;
        return { ...rest, email: r.email || '', admin: !!r.admin, must_change: !!r.must_change, disabled: !!r.disabled,
          role: r.admin ? 'admin' : 'base', google: google_email || '', google_linked: !!google_sub };
      }) });
    }

    if (path === '/admin/users' && method === 'POST') {
      // Invito: gli account li crea solo l'amministratore, con l'email (obbligatoria) e un
      // nome provvisorio; la password provvisoria parte per email e la persona al primo
      // accesso sceglie il suo nome e la sua password.
      const b = await body(request);
      const gmail = cleanEmail(b.email || b.google) || fail(400, 'Scrivi l\'email della persona da invitare');
      const username = cleanName(b.username);
      const pw = await passwordFields(cleanVerifier(b.verifier));
      const exists = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
      if (exists) fail(409, 'Esiste già un account con questo nome');
      await emailFree(env, gmail, 0);
      const admin = b.admin || b.role === 'admin';
      await env.DB.prepare('INSERT INTO users(username, salt, hash, must_change, admin, created, google_email, email) VALUES(?,?,?,1,?,?,?,?)')
        .bind(username, pw.salt, pw.hash, admin ? 1 : 0, now(), gmail, gmail).run();
      const plain = tempPlain(b.password);
      let mailed = false;
      if (plain && resetOn(env)) {
        const created = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
        try { await inviteMail(env, gmail, user.username, plain, false, url.origin, created.id); mailed = true; } catch (e) { mailed = false; }
      }
      return json({ ok: true, mailed });
    }

    // Amministrazione: i numeri di tutta BunkerPlex, i server pubblicati e i dispositivi nella rete
    if (path === '/admin/overview' && method === 'GET') {
      await ensureServerCols(env);
      await ensureDevices(env);
      const one = (sql) => env.DB.prepare(sql).first('n');
      const [users, admins, disabled, temp, sessions, active, friends, pending, servers, devices] = await Promise.all([
        one('SELECT COUNT(*) n FROM users'), one('SELECT COUNT(*) n FROM users WHERE admin = 1'),
        one('SELECT COUNT(*) n FROM users WHERE disabled = 1'), one('SELECT COUNT(*) n FROM users WHERE must_change = 1'),
        one('SELECT COUNT(*) n FROM sessions'), env.DB.prepare('SELECT COUNT(*) n FROM sessions WHERE last_seen > ?').bind(now() - 7 * 86400).first('n'),
        one("SELECT COUNT(*) n FROM friends WHERE status = 'ok'"), one("SELECT COUNT(*) n FROM friends WHERE status = 'pending'"),
        one('SELECT COUNT(*) n FROM servers'), one('SELECT COUNT(*) n FROM ts_devices')
      ]);
      const srv = (await env.DB.prepare(
        'SELECT s.user_id, u.username, s.sid, s.name, s.url, s.lan, s.friends, s.t FROM servers s JOIN users u ON u.id = s.user_id ' +
        'ORDER BY s.t DESC LIMIT 200').all()).results;
      const dev = (await env.DB.prepare(
        'SELECT d.host, d.label, d.kind, d.t, d.user_id, u.username FROM ts_devices d LEFT JOIN users u ON u.id = d.user_id ' +
        'ORDER BY d.t DESC LIMIT 200').all()).results;
      const fr = (await env.DB.prepare(
        'SELECT f.a, f.b, f.status, f.t, ua.username AS ua, ub.username AS ub FROM friends f ' +
        'JOIN users ua ON ua.id = f.a JOIN users ub ON ub.id = f.b ORDER BY f.t DESC LIMIT 200').all()).results;
      return json({
        counts: { users, admins, base: users - admins, disabled, temp, sessions, active, friends, pending, servers, devices },
        servers: srv.map((r) => ({ ...r, friends: !!r.friends })), devices: dev, friendships: fr,
        services: { google: googleOn(env), tailscale: !!(env.TS_OAUTH_ID && env.TS_OAUTH_SECRET) }
      });
    }

    // Accessi (attivazioni): ogni PC, TV o telefono in cui un account e' entrato
    if (path === '/admin/sessions' && method === 'GET') {
      const uid = Number(url.searchParams.get('user') || 0);
      const rows = (await env.DB.prepare(
        'SELECT s.rowid AS id, s.user_id, u.username, s.device, s.created, s.last_seen FROM sessions s ' +
        'JOIN users u ON u.id = s.user_id ' + (uid ? 'WHERE s.user_id = ? ' : '') + 'ORDER BY s.last_seen DESC LIMIT 300'
      ).bind(...(uid ? [uid] : [])).all()).results;
      return json({ sessions: rows });
    }
    const sm2 = /^\/admin\/sessions\/(\d+)$/.exec(path);
    if (sm2 && method === 'DELETE') {
      const r = await env.DB.prepare('SELECT token_hash FROM sessions WHERE rowid = ?').bind(Number(sm2[1])).first();
      if (!r) fail(404, 'Accesso non trovato');
      if (r.token_hash === user.token_hash) fail(400, 'È l\'accesso che stai usando: esci dal tuo account invece');
      await env.DB.prepare('DELETE FROM sessions WHERE rowid = ?').bind(Number(sm2[1])).run();
      return json({ ok: true });
    }

    // Un server pubblicato nella rubrica (per gli amici e i PC dello stesso account)
    const sv = /^\/admin\/servers\/(\d+)\/([A-Za-z0-9_-]{1,64})$/.exec(path);
    if (sv && method === 'DELETE') {
      await env.DB.prepare('DELETE FROM servers WHERE user_id = ? AND sid = ?').bind(Number(sv[1]), sv[2]).run();
      return json({ ok: true });
    }

    // Un'amicizia (o una richiesta) tra due account
    const fv = /^\/admin\/friends\/(\d+)\/(\d+)$/.exec(path);
    if (fv && method === 'DELETE') {
      await env.DB.prepare('DELETE FROM friends WHERE a = ? AND b = ?').bind(Number(fv[1]), Number(fv[2])).run();
      return json({ ok: true });
    }

    const m = /^\/admin\/users\/(\d+)(\/password|\/google|\/email|\/role|\/active|\/link)?$/.exec(path);
    if (m) {
      const id = Number(m[1]);
      const target = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
      if (!target) fail(404, 'Account non trovato');
      // Il link di attivazione da mandare a mano (WhatsApp, messaggio...): l'invito senza email
      if (m[2] === '/link' && method === 'POST') {
        if (!target.must_change) fail(409, 'Questo account è già attivo');
        const to = target.email || target.google_email;
        if (!to) fail(409, 'Prima dai un\'email all\'account');
        return json({ link: mailLink(url.origin, 'attiva', { email: to, t: await newActivation(env, id) }) });
      }
      if (m[2] === '/email' && method === 'PUT') {
        const email = cleanEmail((await body(request)).email);
        if (email) await emailFree(env, email, id);
        await env.DB.prepare('UPDATE users SET email = ? WHERE id = ?').bind(email || null, id).run();
        return json({ ok: true });
      }
      // Ruolo: base (guarda e gestisce le sue cose) o amministratore (gestisce tutta BunkerPlex)
      if (m[2] === '/role' && method === 'PUT') {
        const b = await body(request);
        const admin = b.role === 'admin' || b.admin === true;
        if (!admin && id === user.id) fail(400, 'Non puoi toglierti il ruolo di amministratore da solo');
        if (!admin && target.admin) {
          const n = await env.DB.prepare('SELECT COUNT(*) n FROM users WHERE admin = 1 AND disabled = 0').first('n');
          if (n <= 1) fail(409, 'Serve almeno un amministratore');
        }
        await env.DB.prepare('UPDATE users SET admin = ? WHERE id = ?').bind(admin ? 1 : 0, id).run();
        return json({ ok: true, role: admin ? 'admin' : 'base' });
      }
      // Attivo / disattivato: disattivato non entra piu' da nessuna parte
      if (m[2] === '/active' && method === 'PUT') {
        const on = !!(await body(request)).active;
        if (!on && id === user.id) fail(400, 'Non puoi disattivare il tuo account');
        // Gli accessi restano: i server se ne accorgono alla prossima sincronizzazione
        // (rispondono «disattivato») e lo fanno uscire; riattivato, riparte da dove era.
        await env.DB.prepare('UPDATE users SET disabled = ? WHERE id = ?').bind(on ? 0 : 1, id).run();
        return json({ ok: true, active: on });
      }
      if (m[2] === '/google' && method === 'PUT') {
        // L'email Google con cui l'account potra' entrare (si lega al primo «Entra con Google»).
        // Vuota: toglie anche il collegamento, se l'account ha comunque una password.
        const gmail = cleanEmail((await body(request)).google);
        if (!gmail && target.no_password) fail(409, 'Questo account entra solo con Google: dagli prima una password provvisoria');
        if (gmail) {
          const other = await env.DB.prepare('SELECT id FROM users WHERE google_email = ? AND id <> ?').bind(gmail, id).first();
          if (other) fail(409, 'Questa email Google è già di un altro account');
        }
        await env.DB.prepare('UPDATE users SET google_email = ?, google_sub = CASE WHEN ? = google_email THEN google_sub ELSE NULL END WHERE id = ?')
          .bind(gmail || null, gmail, id).run();
        return json({ ok: true });
      }
      if (m[2] === '/password' && method === 'POST') {
        // Password provvisoria nuova: al prossimo accesso va cambiata; i server collegati escono
        const b = await body(request);
        await ensureReset(env);
        const pw = await passwordFields(cleanVerifier(b.verifier));
        await env.DB.batch([
          env.DB.prepare('UPDATE users SET salt = ?, hash = ?, must_change = 1, fails = 0, locked_until = 0, no_password = 0 WHERE id = ?')
            .bind(pw.salt, pw.hash, id),
          env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id),
          env.DB.prepare('DELETE FROM reset_codes WHERE user_id = ?').bind(id)
        ]);
        // Con l'email dell'account la password provvisoria parte da sola (invito rimandato)
        const to = target.email || target.google_email;
        const plain = tempPlain(b.password);
        let mailed = false;
        if (to && plain && resetOn(env)) {
          try { await inviteMail(env, to, user.username, plain, !pendingName(target.username), url.origin, id); mailed = true; } catch (e) { mailed = false; }
        }
        return json({ ok: true, mailed });
      }
      if (!m[2] && method === 'DELETE') {
        if (id === user.id) fail(400, 'Non puoi eliminare il tuo account');
        await ensureNotices(env);
        await ensureCreds(env);
        await ensureActivate(env);
        await ensureMagic(env);
        await ensureProfiles(env);
        await ensureClaims(env);
        for (const c of (await env.DB.prepare('SELECT sid FROM server_creds WHERE owner_id = ?').bind(id).all()).results) {
          await dropServerDns(env, c.sid);
        }
        await env.DB.batch([
          env.DB.prepare('DELETE FROM activations WHERE user_id = ?').bind(id),
          env.DB.prepare('DELETE FROM magic_links WHERE user_id = ?').bind(id),
          env.DB.prepare('DELETE FROM notices WHERE user_id = ?').bind(id),
          env.DB.prepare('DELETE FROM notice_devices WHERE user_id = ?').bind(id),
          env.DB.prepare('DELETE FROM notice_prefs WHERE user_id = ?').bind(id),
          env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id),
          env.DB.prepare('DELETE FROM settings WHERE user_id = ?').bind(id),
          env.DB.prepare('DELETE FROM state WHERE user_id = ?').bind(id),
          env.DB.prepare('DELETE FROM pstate WHERE user_id = ?').bind(id),
          env.DB.prepare('DELETE FROM profiles WHERE user_id = ?').bind(id),
          env.DB.prepare('DELETE FROM claims WHERE user_id = ?').bind(id),
          env.DB.prepare('DELETE FROM friends WHERE a = ? OR b = ?').bind(id, id),
          env.DB.prepare('DELETE FROM servers WHERE user_id = ?').bind(id),
          env.DB.prepare('DELETE FROM server_creds WHERE owner_id = ?').bind(id),
          env.DB.prepare('DELETE FROM tickets WHERE from_user = ? OR to_user = ?').bind(id, id),
          env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id)
        ]);
        return json({ ok: true });
      }
    }
  }

  fail(404, 'Non trovato');
}

// ------------------------------------------------------------ aggiornamenti
//
// Il repository e' privato: i server BunkerPlex che non hanno un token GitHub
// chiedono qui le stesse cose che chiederebbero a api.github.com/repos/<repo>/.
// Passano solo le letture che servono agli aggiornamenti. Pacchetti e allegati
// non transitano dal Worker: si rimanda all'indirizzo firmato di GitHub.

const GH_PATHS = [
  /^commits\/[A-Za-z0-9._-]{1,100}$/,
  /^compare\/[A-Za-z0-9._-]{1,100}\.\.\.[A-Za-z0-9._-]{1,100}$/,
  /^tags$/,
  /^releases\/tags\/[A-Za-z0-9._-]{1,100}$/,
  /^releases\/assets\/\d{1,15}$/,
  /^zipball\/[0-9a-f]{40}$/
];
const GH_ACCEPT = ['application/vnd.github+json', 'application/vnd.github.sha', 'application/octet-stream'];

function ghRequest(env, path, accept) {
  const repo = env.GITHUB_REPO || 'xFra96/bunkerplex';
  const headers = { 'Accept': accept, 'User-Agent': 'bunkerplex-account', 'X-GitHub-Api-Version': '2022-11-28' };
  if (env.GITHUB_TOKEN) headers['Authorization'] = 'Bearer ' + env.GITHUB_TOKEN;
  return fetch(`https://api.github.com/repos/${repo}/${path}`, { headers, redirect: 'manual' });
}

async function ghPass(r) {
  if ([301, 302, 303, 307, 308].includes(r.status)) {
    const where = r.headers.get('Location') || '';
    if (!/^https:\/\//.test(where)) return json({ detail: 'Risposta di GitHub non valida' }, 502);
    return new Response(null, { status: 302, headers: { 'Location': where, 'Cache-Control': 'no-store' } });
  }
  const headers = { 'Content-Type': r.headers.get('Content-Type') || 'application/json', 'Cache-Control': 'no-store' };
  return new Response(r.body, { status: r.status, headers });
}

async function updates(request, env, url) {
  const path = url.pathname.slice('/aggiornamenti/'.length);
  if (!GH_PATHS.some((re) => re.test(path))) fail(404, 'Non trovato');
  let query = '';
  if (path === 'tags') {
    const q = new URLSearchParams();
    for (const k of ['per_page', 'page']) {
      const v = url.searchParams.get(k);
      if (v && /^\d{1,3}$/.test(v)) q.set(k, v);
    }
    query = q.toString() ? '?' + q : '';
  }
  const want = (request.headers.get('Accept') || '').split(',')[0].trim();
  const accept = GH_ACCEPT.includes(want) ? want : GH_ACCEPT[0];
  return ghPass(await ghRequest(env, path + query, accept));
}

// Link da dare a chi installa BunkerPlex la prima volta: l'ultimo BunkerPlex.zip.
async function download(env) {
  const r = await ghRequest(env, 'releases/latest', GH_ACCEPT[0]);
  if (!r.ok) fail(502, 'Pacchetto non disponibile, riprova tra poco');
  const rel = await r.json();
  const asset = (rel.assets || []).find((a) => a.name === 'BunkerPlex.zip');
  if (!asset) fail(404, 'Pacchetto non disponibile, riprova tra poco');
  return ghPass(await ghRequest(env, `releases/assets/${asset.id}`, 'application/octet-stream'));
}
