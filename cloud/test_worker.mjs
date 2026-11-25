// Prove del servizio account con un database D1 finto (SQLite di Node).
// Avvio: node --test cloud/test_worker.mjs   (Node 22.5 o piu' recente)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, createPublicKey, verify } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
// Il Worker e' un modulo ES in un file .js: se ne fa una copia .mjs da importare
const copy = join(mkdtempSync(join(tmpdir(), 'bpw-')), 'worker.mjs');
writeFileSync(copy, readFileSync(join(here, 'worker.js')));
const worker = (await import(pathToFileURL(copy).href)).default;

// D1 finto: prepare/bind/first/all/run e batch, sopra node:sqlite
function fakeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async (col) => {
      const r = db.prepare(sql).get(...args);
      if (!r) return null;
      return col ? r[col] : { ...r };
    },
    all: async () => ({ results: db.prepare(sql).all(...args).map((r) => ({ ...r })) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } })
  });
  return {
    raw: db,
    prepare: (sql) => stmt(sql),
    batch: async (list) => { const out = []; for (const s of list) out.push(await s.run()); return out; }
  };
}

const sha = (t) => createHash('sha256').update(t).digest('hex');
const VER = 'a'.repeat(64);

function setup() {
  const env = { DB: fakeD1(), SETUP_KEY: 'k' };
  const call = async (method, path, body, token) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    const res = await worker.fetch(new Request('https://acc.test' + path,
      { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
    return { status: res.status, body: await res.json() };
  };
  const addUser = (name) => {
    const salt = 'ab'.repeat(8);
    env.DB.raw.prepare('INSERT INTO users(username, salt, hash, must_change, created) VALUES(?,?,?,0,0)')
      .run(name, salt, sha(salt + VER));
    return Number(env.DB.raw.prepare('SELECT id FROM users WHERE username = ?').get(name).id);
  };
  const login = async (name, kind, device = name + '-dev') =>
    (await call('POST', '/login', { username: name, verifier: VER, device, kind })).body.token;
  return { env, call, addUser, login };
}

async function twoFriends() {
  const t = setup();
  const anna = t.addUser('anna');
  const bob = t.addUser('bob');
  t.env.DB.raw.prepare("INSERT INTO friends(a, b, status, t) VALUES(?, ?, 'ok', 0)").run(anna, bob);
  return { ...t, anna, bob };
}

const SID = '1234abcd';
const PIN = 'c'.repeat(64);

test('un server prende la credenziale, manda la presenza e compare in GET /servers', async () => {
  const t = await twoFriends();
  const annaPc = await t.login('anna', 'server', 'PC di Anna');
  const claim = await t.call('POST', `/servers/${SID}/claim`, { name: 'PC Anna' }, annaPc);
  assert.equal(claim.status, 200);
  assert.match(claim.body.credential, /^s_1234abcd_[0-9a-f]{64}$/);
  const cred = claim.body.credential;

  const hb = await t.call('POST', '/server/heartbeat',
    { name: 'PC Anna', url: 'https://1.2.3.4:32501', lan: 'https://192.168.1.5:32501', pin: PIN, friends: true }, cred);
  assert.equal(hb.status, 200);
  assert.equal(hb.body.owner.username, 'anna');

  const mine = await t.call('GET', '/servers', undefined, await t.login('anna', 'pwa'));
  assert.equal(mine.status, 200);
  assert.equal(mine.body.servers.length, 1);
  const s = mine.body.servers[0];
  assert.deepEqual([s.sid, s.role, s.online, s.addresses.lan], [SID, 'owner', true, 'https://192.168.1.5:32501']);

  const theirs = await t.call('GET', '/servers', undefined, await t.login('bob', 'pwa'));
  const f = theirs.body.servers[0];
  assert.deepEqual([f.sid, f.role, f.owner.username, f.addresses.lan], [SID, 'friend', 'anna', '']);

  // Le app di prima leggono ancora GET /friends
  const old = await t.call('GET', '/friends', undefined, await t.login('bob', 'app'));
  assert.equal(old.body.friends[0].servers[0].sid, SID);
});

test('un server solo in casa (senza indirizzo da fuori) non va alle app di prima', async () => {
  const t = await twoFriends();
  const cred = (await t.call('POST', `/servers/${SID}/claim`, {}, await t.login('anna', 'server'))).body.credential;
  await t.call('POST', '/server/heartbeat', { name: 'PC', url: '', lan: 'https://192.168.1.5:32501', pin: PIN, friends: true }, cred);
  const old = await t.call('GET', '/friends', undefined, await t.login('anna', 'app'));
  assert.equal(old.body.mine.length, 0);
  const now = await t.call('GET', '/servers', undefined, await t.login('anna', 'pwa'));
  assert.equal(now.body.servers.length, 1);
});

test('la credenziale non la porta via un telefono mentre il server e acceso', async () => {
  const t = await twoFriends();
  const cred = (await t.call('POST', `/servers/${SID}/claim`, {}, await t.login('anna', 'server'))).body.credential;
  await t.call('POST', '/server/heartbeat', { name: 'PC', pin: PIN }, cred);
  const phone = await t.login('anna', 'app');
  assert.equal((await t.call('POST', `/servers/${SID}/claim`, {}, phone)).status, 409);
  // Un altro account non la prende mai
  assert.equal((await t.call('POST', `/servers/${SID}/claim`, {}, await t.login('bob', 'server'))).status, 409);
  // Il server stesso (sessione di tipo server) si', e la vecchia smette di valere
  const again = await t.call('POST', `/servers/${SID}/claim`, {}, await t.login('anna', 'server'));
  assert.equal(again.status, 200);
  assert.equal((await t.call('POST', '/server/heartbeat', { pin: PIN }, cred)).status, 401);
  assert.equal((await t.call('POST', '/server/heartbeat', { pin: PIN }, again.body.credential)).status, 200);
});

test('con la credenziale, i dati del server non si scrivono piu con il gettone di un utente', async () => {
  const t = await twoFriends();
  const pc = await t.login('anna', 'server');
  const put = { sid: SID, name: 'x', url: 'https://evil.example', pin: PIN, friends: true };
  assert.equal((await t.call('PUT', '/servers', put, pc)).status, 200);      // server di prima: va ancora
  await t.call('POST', `/servers/${SID}/claim`, {}, pc);
  assert.equal((await t.call('PUT', '/servers', put, await t.login('anna', 'app'))).status, 409);
  assert.equal((await t.call('DELETE', `/servers/${SID}`, undefined, pc)).status, 409);
});

test('gettoni d\'accesso: firmati, verificabili con /keys, ruoli giusti', async () => {
  const t = await twoFriends();
  const cred = (await t.call('POST', `/servers/${SID}/claim`, {}, await t.login('anna', 'server'))).body.credential;
  await t.call('POST', '/server/heartbeat', { name: 'PC', url: 'https://1.2.3.4:32501', pin: PIN, friends: true }, cred);

  const own = await t.call('POST', `/servers/${SID}/access`, {}, await t.login('anna', 'pwa'));
  assert.equal(own.status, 200);
  assert.equal(own.body.role, 'owner');
  const bobTok = await t.login('bob', 'pwa');
  const fr = await t.call('POST', `/servers/${SID}/access`, { owner: t.anna }, bobTok);
  assert.equal(fr.body.role, 'friend');

  // La firma si verifica con la chiave pubblica di /keys (come fara' il server)
  const jwk = (await t.call('GET', '/keys')).body.keys[0];
  const [h, p, sig] = fr.body.token.split('.');
  const ok = verify('sha256', Buffer.from(h + '.' + p), { key: createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
    Buffer.from(sig, 'base64url'));
  assert.ok(ok);
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  assert.deepEqual([claims.sub, claims.sid, claims.own, claims.role], [String(t.bob), SID, t.anna, 'friend']);

  // Verifica dal server (per chi non ha la libreria): buona, poi non piu' amici
  assert.equal((await t.call('POST', '/server/verify', { token: fr.body.token }, cred)).status, 200);
  t.env.DB.raw.prepare('DELETE FROM friends').run();
  assert.equal((await t.call('POST', '/server/verify', { token: fr.body.token }, cred)).status, 403);
  assert.equal((await t.call('POST', `/servers/${SID}/access`, { owner: t.anna }, bobTok)).status, 403);
  // Un gettone ritoccato non vale
  const bad = own.body.token.slice(0, -4) + 'AAAA';
  assert.equal((await t.call('POST', '/server/verify', { token: bad }, cred)).status, 403);
});

test('un server che non condivide non da gettoni agli amici', async () => {
  const t = await twoFriends();
  const cred = (await t.call('POST', `/servers/${SID}/claim`, {}, await t.login('anna', 'server'))).body.credential;
  await t.call('POST', '/server/heartbeat', { name: 'PC', url: 'https://1.2.3.4:32501', pin: PIN, friends: false }, cred);
  assert.equal((await t.call('POST', `/servers/${SID}/access`, { owner: t.anna }, await t.login('bob', 'pwa'))).status, 404);
  assert.equal((await t.call('GET', '/servers', undefined, await t.login('bob', 'pwa'))).body.servers.length, 0);
});

test('dispositivi: elenco con il tipo, togliere uno, scadenza dopo 180 giorni', async () => {
  const t = await twoFriends();
  const a = await t.login('anna', 'tv', 'TV sala');
  const b = await t.login('anna', 'pwa', 'Telefono');
  const list = await t.call('GET', '/devices', undefined, b);
  assert.equal(list.body.devices.length, 2);
  const tv = list.body.devices.find((d) => d.label === 'TV sala');
  assert.equal(tv.kind, 'tv');
  assert.equal(list.body.devices.find((d) => d.current).label, 'Telefono');
  assert.equal((await t.call('DELETE', `/devices/${tv.id}`, undefined, b)).status, 200);
  assert.equal((await t.call('GET', '/me', undefined, a)).status, 401);
  // Bob non toglie i dispositivi di Anna
  const mine = (await t.call('GET', '/devices', undefined, b)).body.devices[0];
  assert.equal((await t.call('DELETE', `/devices/${mine.id}`, undefined, await t.login('bob', 'pwa'))).status, 404);
  // Una sessione ferma da piu' di 180 giorni non vale piu'
  t.env.DB.raw.prepare('UPDATE sessions SET last_seen = 0').run();
  assert.equal((await t.call('GET', '/me', undefined, b)).status, 401);
});

test('il server si toglie dall\'account con la sua credenziale', async () => {
  const t = await twoFriends();
  const cred = (await t.call('POST', `/servers/${SID}/claim`, {}, await t.login('anna', 'server'))).body.credential;
  await t.call('POST', '/server/heartbeat', { name: 'PC', pin: PIN }, cred);
  assert.equal((await t.call('GET', '/server/me', undefined, cred)).body.owner.username, 'anna');
  assert.equal((await t.call('DELETE', '/server', undefined, cred)).status, 200);
  assert.equal((await t.call('GET', '/server/me', undefined, cred)).status, 401);
  assert.equal((await t.call('GET', '/servers', undefined, await t.login('anna', 'pwa'))).body.servers.length, 0);
});

test('fase 0: Tailscale senza nome rifiutato, GET /friends con piu amici', async () => {
  const t = await twoFriends();
  const carla = t.addUser('carla');
  t.env.DB.raw.prepare("INSERT INTO friends(a, b, status, t) VALUES(?, ?, 'ok', 0)").run(carla, t.anna);
  for (const [who, sid] of [['bob', 'bbbbbbbb'], ['carla', 'cccccccc']]) {
    await t.call('PUT', '/servers', { sid, name: who, url: 'https://' + who + '.example', pin: PIN, friends: true }, await t.login(who, 'server'));
  }
  const fr = (await t.call('GET', '/friends', undefined, await t.login('anna', 'app'))).body.friends;
  assert.deepEqual(fr.map((f) => f.servers.map((s) => s.sid)).flat().sort(), ['bbbbbbbb', 'cccccccc']);
  t.env.TS_OAUTH_ID = 'x';
  t.env.TS_OAUTH_SECRET = 'y';
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ access_token: 't' }));
  try {
    assert.equal((await t.call('POST', '/tailscale/key', {}, await t.login('anna', 'app'))).status, 400);
  } finally {
    globalThis.fetch = realFetch;
  }
});
