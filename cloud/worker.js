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
// BREVO_API_KEY (e MAIL_FROM, di base bunkerplex@outlook.it): «Password dimenticata?»
// con un codice via email (vedi /reset/start). Trigger cron settimanale (es.
// «0 6 * * 1»): tiene viva la chiave Brevo (vedi scheduled).
// Notifiche su telefoni e tablet: tutto da solo, tabelle e chiavi VAPID nel database
// (vedi «BunkerPlex Avvisi», /notices e /avvisi).

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

async function newSession(env, user, device) {
  if (user.disabled) fail(403, "Questo account è disattivato: chiedi all'amministratore");
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
  if (u.disabled) fail(403, "Questo account è disattivato: chiedi all'amministratore");
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
    // Tailscale aggiunge "-1", "-2"... se il nome c'e' gia'
    const row = rows.find((x) => hn === x.host || (hn.startsWith(x.host + '-') && /^\d+$/.test(hn.slice(x.host.length + 1))));
    if (!row) continue;
    out.push({
      id: String(d.nodeId || d.id), host: row.host, hostname: hn, label: row.label || hn,
      kind: row.kind || 'app', seen: d.lastSeen || '', online: d.connectedToControl === true, os: d.os || ''
    });
  }
  return out;
}

async function tsDeleteDevice(ts, d) {
  const r = await fetch('https://api.tailscale.com/api/v2/device/' + encodeURIComponent(d.id), {
    method: 'DELETE', headers: { Authorization: 'Bearer ' + ts.access }
  });
  if (!r.ok && r.status !== 404) fail(502, 'Tailscale non ha tolto il dispositivo (errore ' + r.status + ')');
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
    'background:#1a7f45;color:#fff;text-decoration:none;cursor:pointer}.err{color:#ff8f80}small{color:#9fada3}</style></head>' +
    '<body><main>' + inner + '</main></body></html>';
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' } });
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

async function resetStart(env, email) {
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
  await sendMail(env, email, 'Il tuo codice BunkerPlex: ' + shown,
    'Ciao ' + user.username + ',\n\nper scegliere una password nuova scrivi questo codice in BunkerPlex:\n\n    ' + shown +
    '\n\nVale 15 minuti. Se non l\'hai chiesto tu, ignora questa email: la tua password resta quella di prima.' +
    '\n\n--\nBunkerPlex · Only for bunkers',
    mailPage('Il tuo codice è ' + shown,
      '<p style="margin:0 0 16px">Ciao <b>' + esc(user.username) + '</b>,</p>' +
      '<p style="margin:0 0 24px">per scegliere una password nuova scrivi questo codice in BunkerPlex:</p>' +
      '<div style="background:#f1f6f2;border:1px solid #dce7df;border-radius:10px;padding:18px 0;text-align:center;' +
      'font:700 34px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:8px;color:#0f1a13">' + shown + '</div>' +
      '<p style="margin:24px 0 0;color:#5b6660;font-size:14px">Vale 15 minuti. Se non l\'hai chiesto tu, ignora questa email: ' +
      'la tua password resta quella di prima.</p>'));
}

// L'invito dell'amministratore: email e password provvisoria per il primo accesso
async function inviteMail(env, to, from, password, again) {
  const intro = again
    ? 'ecco una nuova password provvisoria per il tuo account BunkerPlex.'
    : (from ? from + ' ti ha invitato su BunkerPlex.' : 'hai un invito per BunkerPlex.');
  await sendMail(env, to, again ? 'La tua nuova password provvisoria BunkerPlex' : 'Il tuo invito a BunkerPlex',
    'Ciao,\n\n' + intro + ' Entra con:\n\n    Email: ' + to + '\n    Password provvisoria: ' + password +
    '\n\nAl primo accesso ' + (again ? 'scegli una password tua.' : 'scegli il tuo nome e una password tua, poi crei il tuo profilo.') +
    '\n\n--\nBunkerPlex · Only for bunkers',
    mailPage(again ? 'La tua nuova password provvisoria' : 'Il tuo invito a BunkerPlex',
      '<p style="margin:0 0 16px">Ciao,</p>' +
      '<p style="margin:0 0 24px">' + esc(intro) + ' Entra con:</p>' +
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

  // Un codice nuovo. link = collega Google all'account che chiede (serve il suo gettone)
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
    await env.DB.prepare('INSERT INTO google_flows(code, poll_hash, link_user, device, kind, exp) VALUES(?,?,?,?,?,?)')
      .bind(code, await sha256(poll), link ? link.id : null, String(b.device || '').slice(0, 80), kind, now() + GOOGLE_TTL).run();
    return json({ code, poll, url: origin + '/g/' + code, short: origin + '/g', ttl: GOOGLE_TTL });
  }

  // Chi ha chiesto il codice: finito? Il gettone si consegna una volta sola.
  if (path === '/google/poll' && method === 'POST') {
    const b = await body(request);
    const ph = await sha256(String(b.poll || ''));
    const f = await env.DB.prepare('SELECT * FROM google_flows WHERE poll_hash = ?').bind(ph).first();
    if (!f || f.exp < now()) fail(404, 'Codice scaduto: ricomincia');
    if (!f.user_id && !f.error) return json({ done: false });
    await env.DB.prepare('DELETE FROM google_flows WHERE code = ?').bind(f.code).run();
    if (f.error) fail(403, f.error);
    const u = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(f.user_id).first();
    if (!u) fail(404, 'Account non trovato');
    if (f.link_user) return json({ done: true, linked: true, user: userJson(u) });
    return json({ done: true, token: await newSession(env, u, f.device), user: userJson(u) });
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
    const code = cleanCode(path === '/g' ? url.searchParams.get('c') : path.slice(3));
    if (!code) {
      return page('Entra con Google', '<h1>Entra con Google</h1><p>Scrivi il codice che vedi sulla TV o sull\'app.</p>' +
        '<form method="get" action="/g"><input name="c" autocomplete="off" autocapitalize="characters" maxlength="9" placeholder="XXXX-XXXX" autofocus>' +
        '<button class="btn">Continua</button></form>');
    }
    const f = await flowByCode(env, code);
    if (!f || f.user_id || f.error) {
      return page('Codice scaduto', '<h1>Codice scaduto o sbagliato</h1><p>Sulla TV o nell\'app ricomincia da «Entra con Google»: compare un codice nuovo.</p>' +
        '<p><a class="btn" href="/g">Scrivi un altro codice</a></p>', 404);
    }
    let what = 'Entri in BunkerPlex';
    if (f.link_user) {
      const lu = await env.DB.prepare('SELECT username FROM users WHERE id = ?').bind(f.link_user).first();
      what = 'Colleghi Google all\'account BunkerPlex <b>' + esc(lu ? lu.username : '') + '</b>';
    }
    const dev = { tv: 'la TV', phone: 'l\'app sul telefono', browser: 'il browser' }[f.kind] || 'il dispositivo';
    return page('Entra con Google', '<h1>' + (f.link_user ? 'Collega Google' : 'Entra con Google') + '</h1>' +
      '<p>' + what + ' su <b>' + esc(dev) + '</b> che mostra questo codice:</p><p class="code">' + code.slice(0, 4) + '-' + code.slice(4) + '</p>' +
      '<p><small>Se non l\'hai chiesto tu, o il codice non è quello che vedi, chiudi questa pagina.</small></p>' +
      '<form method="post" action="/g/' + code + '"><button class="btn">Continua con Google</button></form>');
  }
  const gm = /^\/g\/([A-Za-z0-9-]{1,12})$/.exec(path);
  if (gm && method === 'POST') {
    const code = cleanCode(gm[1]);
    const f = await flowByCode(env, code);
    if (!f || f.user_id || f.error) return page('Codice scaduto', '<h1>Codice scaduto</h1><p>Ricomincia da «Entra con Google».</p>', 404);
    const state = code + '.' + randomHex(16);
    await env.DB.prepare('UPDATE google_flows SET state = ? WHERE code = ?').bind(await sha256(state), code).run();
    const q = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirect, response_type: 'code',
      scope: 'openid email', state, prompt: 'select_account'
    });
    return Response.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + q, 303);
  }

  // Google torna qui
  if (path === '/google/callback' && method === 'GET') {
    const state = String(url.searchParams.get('state') || '');
    const code = cleanCode(state.split('.')[0]);
    const f = code ? await flowByCode(env, code) : null;
    if (!f || !f.state || !sameString(await sha256(state), f.state) || f.user_id || f.error) {
      return page('Codice scaduto', '<h1>Codice scaduto</h1><p>Ricomincia da «Entra con Google» sulla TV o nell\'app.</p>', 400);
    }
    const end = async (error, uid, email) => {
      await env.DB.prepare('UPDATE google_flows SET error = ?, user_id = ?, email = ?, state = NULL WHERE code = ?')
        .bind(error || null, uid || null, email || null, code).run();
      if (error) return page('Non riuscito', '<h1>Non riuscito</h1><p class="err">' + esc(error) + '</p>', 403);
      return page('Fatto', '<h1>Fatto</h1><p>' + (f.link_user ? 'Google è collegato al tuo account BunkerPlex.'
        : 'Stai entrando come <b>' + esc(f._name || '') + '</b>.') + ' Torna su BunkerPlex: ' +
        (f.kind === 'tv' ? 'la TV entra da sola.' : 'continua da solo.') + '</p><p><small>Puoi chiudere questa pagina.</small></p>');
    };
    if (url.searchParams.get('error')) return end('Accesso a Google annullato');
    const tr = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(url.searchParams.get('code') || ''), client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: redirect, grant_type: 'authorization_code'
      })
    });
    const tok = tr.ok ? await tr.json() : null;
    let id = null;
    try { id = b64urlJson(String(tok && tok.id_token || '').split('.')[1] || ''); } catch (e) { id = null; }
    // Il gettone arriva direttamente da Google (HTTPS): basta controllarne i campi
    if (!id || id.aud !== env.GOOGLE_CLIENT_ID || !['accounts.google.com', 'https://accounts.google.com'].includes(id.iss) ||
        !(id.exp > now()) || !id.sub) {
      return end('Google non ha confermato l\'accesso: riprova');
    }
    const sub = String(id.sub);
    const email = id.email_verified ? String(id.email || '').toLowerCase() : '';
    const owner = await env.DB.prepare('SELECT * FROM users WHERE google_sub = ?').bind(sub).first();

    if (f.link_user) {
      if (owner && owner.id !== f.link_user) return end('Questo account Google è già collegato all\'account BunkerPlex ' + owner.username);
      await env.DB.prepare('UPDATE users SET google_sub = ?, google_email = ? WHERE id = ?').bind(sub, email || null, f.link_user).run();
      return end(null, f.link_user, email);
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
    if (!u) {
      return end('L\'account Google ' + (email || '') + ' non è collegato a nessun account BunkerPlex. ' +
        'Entra una volta con nome e password e collegalo da Impostazioni → Account, oppure chiedi all\'amministratore di aggiungere questa email.');
    }
    if (email && email !== u.google_email) {
      await env.DB.prepare('UPDATE users SET google_email = ? WHERE id = ?').bind(email, u.id).run();
    }
    f._name = u.username;
    return end(null, u.id, email);
  }
  return null;
}

// ---- Notifiche sui telefoni e tablet («BunkerPlex Avvisi»)
//
// Gli avvisi di un account (nuovi film ed episodi, aggiornamenti, amicizie) stanno
// qui, perche' questo servizio si raggiunge da ovunque, anche fuori casa.
// I server di casa li mandano con POST /notices; le richieste di amicizia nascono
// gia' qui. Ogni telefono o tablet ha un suo gettone (notice_devices), creato dal
// server di casa con POST /notices/devices quando si tocca «Attiva le notifiche»:
//   - iPhone e iPad: una piccola web app su questo indirizzo (/avvisi/<gettone>),
//     da aggiungere alla schermata Home; riceve le notifiche push del browser
//     (Web Push con chiavi VAPID, create qui la prima volta e salvate nel database);
//   - app Android: ogni 15 minuti circa chiede /avvisi/<gettone>/list e mostra
//     le notifiche nuove (niente Firebase).
// Le chiavi e i gettoni restano nel database D1: non serve configurare nulla.

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
  noticeTables = true;
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
      TTL: '86400', Urgency: 'normal', 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream'
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

async function noticePrefs(env, uid) {
  const v = await env.DB.prepare('SELECT v FROM notice_prefs WHERE user_id = ?').bind(uid).first('v');
  let p = {};
  try { p = JSON.parse(v || '{}') || {}; } catch (e) { p = {}; }
  const out = {};
  for (const k of NOTICE_KINDS) out[k] = p[k] !== false;
  return out;
}

const cleanText = (raw, max) => String(raw || '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, max);

// Un avviso a un account: si salva e parte subito verso i suoi iPhone/iPad iscritti
async function notify(env, uid, kind, title, text, from) {
  await ensureNotices(env);
  if (!(await noticePrefs(env, uid))[kind]) return 0;
  const t = now();
  const id = (await env.DB.prepare('INSERT INTO notices(user_id, kind, title, body, t, from_user) VALUES(?,?,?,?,?,?)')
    .bind(uid, kind, title, text, t, from || null).run()).meta.last_row_id;
  await env.DB.prepare('DELETE FROM notices WHERE user_id = ? AND (t < ? OR id <= (SELECT id FROM notices WHERE user_id = ? ' +
    'ORDER BY id DESC LIMIT 1 OFFSET ?))').bind(uid, t - NOTICE_DAYS * 86400, uid, NOTICE_KEEP).run();
  const devs = (await env.DB.prepare('SELECT token_hash, endpoint, p256dh, auth FROM notice_devices ' +
    'WHERE user_id = ? AND endpoint IS NOT NULL').bind(uid).all()).results;
  for (const d of devs) {
    try {
      await sendPush(env, d, { id, title, body: text, kind, tag: 'bp-' + kind + '-' + id });
    } catch (e) { /* il telefono la vedra' comunque nella lista degli avvisi */ }
  }
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
  return { id: r.id, kind: r.kind, title: r.title, body: r.body, t: r.t };
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
    '.n b{display:block}.n small{color:#8b9a90}.err{color:#ff8f80}.ok{color:#38c172}</style></head><body><main>' +
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
api('/list').then(function(j){ls.innerHTML=j.notices.length?j.notices.map(function(n){return '<div class="n"><b>'+esc(n.title)+'</b>'+esc(n.body)+'<br><small>'+when(n.t)+'</small></div>'}).join(''):'<p>Ancora nessun avviso.</p>';
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
  const m = /^\/avvisi\/([0-9a-f]{64})(\/manifest\.json|\/list|\/push|\/test)?$/.exec(path);
  if (!m) return null;
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
    const rows = (await env.DB.prepare('SELECT id, kind, title, body, t FROM notices WHERE user_id = ? AND id > ? AND t >= ? ' +
      'ORDER BY id DESC LIMIT 30').bind(dev.user_id, since, dev.created - 60).all()).results;
    return json({ notices: rows.map(noticeJson), push: !!dev.endpoint });
  }
  if (m[2] === '/push' && method === 'POST') {
    const b = await body(request);
    const ep = String(b.endpoint || '');
    const keys = b.keys && typeof b.keys === 'object' ? b.keys : {};
    if (!/^https:\/\/[^\s]{8,800}$/.test(ep) || !/^[A-Za-z0-9_-]{80,100}$/.test(String(keys.p256dh || '')) ||
        !/^[A-Za-z0-9_-]{16,30}$/.test(String(keys.auth || ''))) fail(400, 'Iscrizione non valida');
    await env.DB.prepare('UPDATE notice_devices SET endpoint = ?, p256dh = ?, auth = ? WHERE token_hash = ?')
      .bind(ep, keys.p256dh, keys.auth, dev.token_hash).run();
    return json({ ok: true });
  }
  if (m[2] === '/push' && method === 'DELETE') {
    await env.DB.prepare('UPDATE notice_devices SET endpoint = NULL, p256dh = NULL, auth = NULL WHERE token_hash = ?')
      .bind(dev.token_hash).run();
    return json({ ok: true });
  }
  if (m[2] === '/test' && method === 'POST') {
    if (!dev.endpoint) fail(409, 'Prima attiva le notifiche');
    const code = await sendPush(env, dev, { title: 'BunkerPlex', body: 'Le notifiche funzionano su questo dispositivo.', tag: 'bp-test' });
    if (code >= 300) fail(502, 'Il servizio di notifiche del telefono ha risposto ' + code);
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
    const rows = (await env.DB.prepare('SELECT id, kind, title, body, t FROM notices WHERE user_id = ? ORDER BY id DESC LIMIT 50')
      .bind(user.id).all()).results;
    return json({ notices: rows.map(noticeJson) });
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
    const rows = (await env.DB.prepare('SELECT rowid AS id, label, kind, created, last_seen, endpoint IS NOT NULL AS push ' +
      'FROM notice_devices WHERE user_id = ? ORDER BY created DESC').bind(user.id).all()).results;
    return json({ devices: rows.map((r) => ({ ...r, push: !!r.push })) });
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
    return json({ token, url: url.origin + '/avvisi/' + token });
  }
  const dm = /^\/notices\/devices\/(\d+)$/.exec(path);
  if (dm && method === 'DELETE') {
    await env.DB.prepare('DELETE FROM notice_devices WHERE rowid = ? AND user_id = ?').bind(Number(dm[1]), user.id).run();
    return json({ ok: true });
  }
  fail(404, 'Non trovato');
}

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method;

  if (path === '/' && method === 'GET') {
    const n = await env.DB.prepare('SELECT COUNT(*) n FROM users').first('n');
    return json({ app: 'bunkerplex-account', version: 1, ready: n > 0, google: googleOn(env), reset: resetOn(env) });
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

  // Entrare con l'email: prima il nome utente (vedi nameForEmail)
  if (path === '/resolve' && method === 'POST') {
    await ensureGoogle(env);
    const b = await body(request);
    return json({ username: await nameForEmail(env, cleanEmail(b.email) || fail(400, 'Scrivi l\'email')) });
  }

  if (path === '/login' && method === 'POST') {
    const b = await body(request);
    const verifier = cleanVerifier(b.verifier);
    const user = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(String(b.username || '').trim()).first();
    if (!user) fail(401, 'Nome utente o password sbagliati');
    await checkPassword(env, user, verifier);
    return json({ token: await newSession(env, user, b.device), user: userJson(user) });
  }

  // Password dimenticata (vedi resetStart)
  if (path === '/reset/start' && method === 'POST') {
    if (!resetOn(env)) fail(404, 'Il recupero della password non è attivo nel servizio account');
    await resetStart(env, cleanEmail((await body(request)).email) || fail(400, 'Scrivi l\'email'));
    return json({ ok: true });
  }
  if (path === '/reset/finish' && method === 'POST') {
    if (!resetOn(env)) fail(404, 'Il recupero della password non è attivo nel servizio account');
    const b = await body(request);
    const user = await resetFinish(env, cleanEmail(b.email) || fail(400, 'Scrivi l\'email'), b.code, cleanVerifier(b.verifier));
    return json({ token: await newSession(env, user, b.device), user: userJson(user) });
  }

  const g = await googleRoutes(request, env, url, path, method);
  if (g) return g;
  const nr = await noticeRoutes(request, env, url, path, method);
  if (nr) return nr;

  const user = await auth(request, env);
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

  // L'email con cui l'account entra (vuota: la toglie; resta il nome utente)
  if (path === '/email' && method === 'PUT') {
    await ensureGoogle(env);
    const email = cleanEmail((await body(request)).email);
    if (email) await emailFree(env, email, user.id);
    await env.DB.prepare('UPDATE users SET email = ? WHERE id = ?').bind(email || null, user.id).run();
    return json({ ok: true, user: userJson({ ...user, email }) });
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
    if (host) {
      await ensureDevices(env);
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
        try { await inviteMail(env, gmail, user.username, plain, false); mailed = true; } catch (e) { mailed = false; }
      }
      return json({ ok: true, mailed });
    }

    // Plancia: i numeri di tutta BunkerPlex, i server pubblicati e i dispositivi nella rete
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

    const m = /^\/admin\/users\/(\d+)(\/password|\/google|\/email|\/role|\/active)?$/.exec(path);
    if (m) {
      const id = Number(m[1]);
      const target = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
      if (!target) fail(404, 'Account non trovato');
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
          try { await inviteMail(env, to, user.username, plain, !pendingName(target.username)); mailed = true; } catch (e) { mailed = false; }
        }
        return json({ ok: true, mailed });
      }
      if (!m[2] && method === 'DELETE') {
        if (id === user.id) fail(400, 'Non puoi eliminare il tuo account');
        await ensureNotices(env);
        await env.DB.batch([
          env.DB.prepare('DELETE FROM notices WHERE user_id = ?').bind(id),
          env.DB.prepare('DELETE FROM notice_devices WHERE user_id = ?').bind(id),
          env.DB.prepare('DELETE FROM notice_prefs WHERE user_id = ?').bind(id),
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
