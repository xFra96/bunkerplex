// BunkerPlex - account e impostazioni sincronizzate (Cloudflare Worker + D1).
//
// I server BunkerPlex di casa parlano con questo servizio: login, cambio
// password, impostazioni dell'account, visti / punti di ripresa / La mia lista,
// copia del catalogo (l'elenco dei file con la loro scheda: i video non passano mai di qui).
//
// La password non arriva mai in chiaro: il server di casa manda una "verifica"
// (PBKDF2-SHA256, 200.000 giri, sale = "bunkerplex:" + nome utente). Qui se ne
// salva solo l'impronta con un sale casuale: il lavoro pesante lo fa il PC,
// cosi' il Worker resta dentro i 10 ms di calcolo del piano gratuito.
//
// Collegamenti richiesti: database D1 come "DB". Segreto: SETUP_KEY (serve
// solo per creare il primo amministratore).

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

  // ---- Copia del catalogo: un file per riga, chiave "<impronta>@<PC>"; vince t piu' recente.
  //      v = null: il file non c'e' piu' (resta come riga vuota, cosi' lo sanno anche gli altri PC)
  if (path === '/catalog' && method === 'GET') {
    const since = Number(url.searchParams.get('since') || 0);
    const rows = await env.DB.prepare(
      'SELECT k, v, t, rev FROM catalog WHERE user_id = ? AND rev > ? ORDER BY rev LIMIT 2000'
    ).bind(user.id, since).all();
    return json({ rows: rows.results.map((r) => ({ ...r, v: JSON.parse(r.v) })), more: rows.results.length === 2000 });
  }
  if (path === '/catalog' && method === 'POST') {
    const b = await body(request);
    const rows = Array.isArray(b.rows) ? b.rows.slice(0, MAX_ROWS) : [];
    const rev = Date.now();
    const stmts = [];
    for (const r of rows) {
      if (!r || !/^[0-9a-f]{16}@[0-9a-z]{4,16}$/.test(String(r.k)) || typeof r.t !== 'number') continue;
      const v = JSON.stringify(r.v === undefined ? null : r.v);
      if (v.length > 2000) continue;
      stmts.push(env.DB.prepare(
        'INSERT INTO catalog(user_id, k, v, t, rev) VALUES(?,?,?,?,?) ' +
        'ON CONFLICT(user_id, k) DO UPDATE SET v = excluded.v, t = excluded.t, rev = excluded.rev WHERE excluded.t > catalog.t'
      ).bind(user.id, r.k, v, Math.min(r.t, now() + 60), rev));
    }
    if (stmts.length) await env.DB.batch(stmts);
    return json({ ok: true, saved: stmts.length, rev });
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
          env.DB.prepare('DELETE FROM catalog WHERE user_id = ?').bind(id),
          env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id)
        ]);
        return json({ ok: true });
      }
    }
  }

  fail(404, 'Non trovato');
}
