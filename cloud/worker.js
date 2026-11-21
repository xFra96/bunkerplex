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
// TS_OAUTH_SECRET (Tailscale dentro BunkerPlex, vedi /tailscale/key).

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

// Le colonne aggiunte dopo alla tabella dei server (lan, friends): si aggiungono
// da sole alla prima chiamata, cosi' il database non va ritoccato a mano.
let serverCols = false;
async function ensureServerCols(env) {
  if (serverCols) return;
  const cols = (await env.DB.prepare('PRAGMA table_info(servers)').all()).results.map((c) => c.name);
  if (!cols.includes('lan')) await env.DB.prepare('ALTER TABLE servers ADD COLUMN lan TEXT').run();
  if (!cols.includes('friends')) await env.DB.prepare('ALTER TABLE servers ADD COLUMN friends INTEGER NOT NULL DEFAULT 1').run();
  serverCols = true;
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
  return { id: u.id, username: u.username, admin: !!u.admin, must_change: !!u.must_change };
}

async function newSession(env, user, device) {
  const token = randomHex(32);
  const t = now();
  await env.DB.prepare('INSERT INTO sessions(token_hash, user_id, device, created, last_seen) VALUES(?,?,?,?,?)')
    .bind(await sha256(token), user.id, String(device || '').slice(0, 80), t, t).run();
  return token;
}

async function auth(request, env) {
  const m = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.get('Authorization') || '');
  if (!m) fail(401, 'Accesso scaduto: rientra');
  const th = await sha256(m[1]);
  const u = await env.DB.prepare(
    'SELECT u.*, s.token_hash, s.last_seen FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?'
  ).bind(th).first();
  if (!u) fail(401, 'Accesso scaduto: rientra');
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

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method;

  if (path === '/' && method === 'GET') {
    const n = await env.DB.prepare('SELECT COUNT(*) n FROM users').first('n');
    return json({ app: 'bunkerplex-account', version: 1, ready: n > 0 });
  }

  // L'indirizzo pubblico di chi chiama (lo mostra BunkerPlex in Impostazioni)
  if (path === '/ip' && method === 'GET') {
    return json({ ip: request.headers.get('CF-Connecting-IP') || '' });
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
    return json({ token: await newSession(env, user, b.device), user: userJson(user) });
  }

  if (path === '/login' && method === 'POST') {
    const b = await body(request);
    const verifier = cleanVerifier(b.verifier);
    const user = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(String(b.username || '').trim()).first();
    if (!user) fail(401, 'Nome utente o password sbagliati');
    await checkPassword(env, user, verifier);
    return json({ token: await newSession(env, user, b.device), user: userJson(user) });
  }

  const user = await auth(request, env);

  if (path === '/me' && method === 'GET') return json({ user: userJson(user) });

  if (path === '/logout' && method === 'POST') {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(user.token_hash).run();
    return json({ ok: true });
  }

  if (path === '/password' && method === 'POST') {
    const b = await body(request);
    await checkPassword(env, user, cleanVerifier(b.verifier));
    const pw = await passwordFields(cleanVerifier(b.new_verifier));
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET salt = ?, hash = ?, must_change = 0 WHERE id = ?').bind(pw.salt, pw.hash, user.id),
      // Gli altri server collegati devono rientrare con la password nuova
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').bind(user.id, user.token_hash)
    ]);
    return json({ ok: true, user: userJson({ ...user, must_change: 0 }) });
  }

  if (user.must_change) fail(403, 'Prima cambia la password provvisoria');

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
    const rows = await env.DB.prepare(
      'SELECT k, pos, w, fav, lp, t, rev FROM state WHERE user_id = ? AND rev > ? ORDER BY rev LIMIT 2000'
    ).bind(user.id, since).all();
    return json({ rows: rows.results, more: rows.results.length === 2000 });
  }
  if (path === '/state' && method === 'POST') {
    const b = await body(request);
    const rows = Array.isArray(b.rows) ? b.rows.slice(0, MAX_ROWS) : [];
    const rev = Date.now();
    const stmts = [];
    for (const r of rows) {
      if (!r || !/^(m\d+|s\d+|e\d+:\d+:\d+)$/.test(String(r.k)) || typeof r.t !== 'number') continue;
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
    const out = [];
    for (const r of rows.results) {
      const other = r.a === user.id ? r.b : r.a;
      const item = {
        id: other, username: r.a === user.id ? r.ub : r.ua, t: r.t,
        status: r.status === 'ok' ? 'ok' : (r.a === user.id ? 'sent' : 'received'), servers: []
      };
      if (item.status === 'ok') {
        const s = await env.DB.prepare('SELECT sid, name, url, pin, t FROM servers WHERE user_id = ? AND friends = 1').bind(other).all();
        item.servers = s.results;
      }
      out.push(item);
    }
    // I propri server accesi: da ogni PC dell'account si arriva agli altri (anche
    // quelli che non condividono con gli amici). lan = indirizzo nella rete di casa.
    const mine = await env.DB.prepare('SELECT sid, name, url, lan, pin, t FROM servers WHERE user_id = ?').bind(user.id).all();
    return json({ friends: out, me: user.id, mine: mine.results });
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
      return json({ ok: true, status: 'ok', username: other.username });
    }
    const n = await env.DB.prepare("SELECT COUNT(*) n FROM friends WHERE a = ? AND status = 'pending'").bind(user.id).first('n');
    if (n >= 20) fail(429, 'Troppe richieste in attesa');
    await env.DB.prepare('INSERT OR IGNORE INTO friends(a, b, status, t) VALUES(?,?,?,?)')
      .bind(user.id, other.id, 'pending', now()).run();
    return json({ ok: true, status: 'sent', username: other.username });
  }
  const fm = /^\/friends\/(\d+)(\/accept)?$/.exec(path);
  if (fm) {
    const other = Number(fm[1]);
    if (fm[2] && method === 'POST') {
      const r = await env.DB.prepare("UPDATE friends SET status = 'ok', t = ? WHERE a = ? AND b = ? AND status = 'pending'")
        .bind(now(), other, user.id).run();
      if (!r.meta.changes) fail(404, 'Richiesta non trovata');
      return json({ ok: true });
    }
    if (!fm[2] && method === 'DELETE') {   // rifiuta, annulla o togli l'amicizia
      await env.DB.prepare('DELETE FROM friends WHERE (a = ? AND b = ?) OR (a = ? AND b = ?)')
        .bind(user.id, other, other, user.id).run();
      return json({ ok: true });
    }
  }
  // Tailscale dentro BunkerPlex: una chiave monouso (10 minuti) per far entrare il
  // server che la chiede nella rete Tailscale di BunkerPlex, con l'etichetta
  // tag:bunkerplex. La crea qui il client OAuth dell'amministratore (segreti
  // TS_OAUTH_ID e TS_OAUTH_SECRET, permesso «Auth Keys: write» su quell'etichetta):
  // i PC non vedono mai il segreto. Senza segreti risponde 404 e i PC restano
  // sulla porta aperta sul router.
  if (path === '/tailscale/key' && method === 'POST') {
    if (!env.TS_OAUTH_ID || !env.TS_OAUTH_SECRET) fail(404, 'Tailscale non configurato nel servizio account');
    const tag = env.TS_TAG || 'tag:bunkerplex';
    const form = new URLSearchParams({ client_id: env.TS_OAUTH_ID, client_secret: env.TS_OAUTH_SECRET, grant_type: 'client_credentials' });
    const tr = await fetch('https://api.tailscale.com/api/v2/oauth/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form
    });
    const access = tr.ok ? (await tr.json()).access_token : '';
    if (!access) fail(502, 'Tailscale non ha accettato le credenziali del servizio account');
    const kr = await fetch('https://api.tailscale.com/api/v2/tailnet/-/keys', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + access, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        capabilities: { devices: { create: { reusable: false, ephemeral: false, preauthorized: true, tags: [tag] } } },
        expirySeconds: 600,
        description: 'BunkerPlex'
      })
    });
    const k = kr.ok ? await kr.json() : null;
    if (!k || typeof k.key !== 'string') fail(502, 'Tailscale non ha dato la chiave (errore ' + kr.status + ')');
    return json({ key: k.key, tag });
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
    await env.DB.prepare('INSERT INTO servers(user_id, sid, name, url, lan, friends, pin, t) VALUES(?,?,?,?,?,?,?,?) ' +
      'ON CONFLICT(user_id, sid) DO UPDATE SET name = excluded.name, url = excluded.url, lan = excluded.lan, ' +
      'friends = excluded.friends, pin = excluded.pin, t = excluded.t')
      .bind(user.id, sid, String(b.name || '').slice(0, 40), url, lan, b.friends === false ? 0 : 1, b.pin, now()).run();
    return json({ ok: true });
  }
  const sm = /^\/servers\/([0-9a-f]{8})$/.exec(path);
  if (sm && method === 'DELETE') {
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

    if (path === '/admin/users' && method === 'GET') {
      const rows = await env.DB.prepare(
        'SELECT u.id, u.username, u.admin, u.must_change, u.created, MAX(s.last_seen) last_seen, COUNT(s.token_hash) servers ' +
        'FROM users u LEFT JOIN sessions s ON s.user_id = u.id GROUP BY u.id ORDER BY u.username COLLATE NOCASE'
      ).all();
      return json({ users: rows.results.map((r) => ({ ...r, admin: !!r.admin, must_change: !!r.must_change })) });
    }

    if (path === '/admin/users' && method === 'POST') {
      const b = await body(request);
      const username = cleanName(b.username);
      const pw = await passwordFields(cleanVerifier(b.verifier));
      const exists = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
      if (exists) fail(409, 'Esiste già un account con questo nome');
      await env.DB.prepare('INSERT INTO users(username, salt, hash, must_change, admin, created) VALUES(?,?,?,1,?,?)')
        .bind(username, pw.salt, pw.hash, b.admin ? 1 : 0, now()).run();
      return json({ ok: true });
    }

    const m = /^\/admin\/users\/(\d+)(\/password)?$/.exec(path);
    if (m) {
      const id = Number(m[1]);
      const target = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
      if (!target) fail(404, 'Account non trovato');
      if (m[2] && method === 'POST') {
        // Password provvisoria nuova: al prossimo accesso va cambiata; i server collegati escono
        const b = await body(request);
        const pw = await passwordFields(cleanVerifier(b.verifier));
        await env.DB.batch([
          env.DB.prepare('UPDATE users SET salt = ?, hash = ?, must_change = 1, fails = 0, locked_until = 0 WHERE id = ?')
            .bind(pw.salt, pw.hash, id),
          env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id)
        ]);
        return json({ ok: true });
      }
      if (!m[2] && method === 'DELETE') {
        if (id === user.id) fail(400, 'Non puoi eliminare il tuo account');
        await env.DB.batch([
          env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id),
          env.DB.prepare('DELETE FROM settings WHERE user_id = ?').bind(id),
          env.DB.prepare('DELETE FROM state WHERE user_id = ?').bind(id),
          env.DB.prepare('DELETE FROM friends WHERE a = ? OR b = ?').bind(id, id),
          env.DB.prepare('DELETE FROM servers WHERE user_id = ?').bind(id),
          env.DB.prepare('DELETE FROM tickets WHERE from_user = ? OR to_user = ?').bind(id, id),
          env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id)
        ]);
        return json({ ok: true });
      }
    }
  }

  fail(404, 'Non trovato');
}
