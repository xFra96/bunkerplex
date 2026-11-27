// Prove del servizio account con un database D1 finto (SQLite di Node).
// Avvio: node --test cloud/test_worker.mjs   (Node 22.5 o piu' recente)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, createHmac, createPublicKey, createSign, generateKeyPairSync, verify } from 'node:crypto';

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
    run: async () => {
      const r = db.prepare(sql).run(...args);
      return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    }
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
  const call = async (method, path, body, token, ip) => {
    const headers = { 'Content-Type': 'application/json' };
    if (ip) headers['CF-Connecting-IP'] = ip;
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
  // Un server gia' noto all'account (registrato prima dei codici di collegamento):
  // puo' ancora prendere la credenziale con il gettone del proprietario
  const known = (uid, sid = SID) => env.DB.raw.prepare("INSERT OR IGNORE INTO servers(user_id, sid, name, url, pin, t) VALUES(?, ?, 'PC', '', '', 0)").run(uid, sid);
  return { env, call, addUser, login, known };
}

async function twoFriends() {
  const t = setup();
  const anna = t.addUser('anna');
  const bob = t.addUser('bob');
  t.env.DB.raw.prepare("INSERT INTO friends(a, b, status, t) VALUES(?, ?, 'ok', 0)").run(anna, bob);
  t.known(anna);
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
    { name: 'PC Anna', url: 'https://1.2.3.4:32501', lan: 'https://192.168.1.5:32501', pin: PIN, friends: true,
      release: '3.42.1', commit: '50346bb53e58' }, cred);
  assert.equal(hb.status, 200);
  assert.equal(hb.body.owner.username, 'anna');

  const mine = await t.call('GET', '/servers', undefined, await t.login('anna', 'pwa'));
  assert.equal(mine.status, 200);
  assert.equal(mine.body.servers.length, 1);
  const s = mine.body.servers[0];
  assert.deepEqual([s.sid, s.role, s.online, s.addresses.lan], [SID, 'owner', true, 'https://192.168.1.5:32501']);
  assert.equal(s.build, '3.42.1 50346bb53e58');
  // Valori strani non passano
  await t.call('POST', '/server/heartbeat', { name: 'PC Anna', url: 'https://1.2.3.4:32501', lan: 'https://192.168.1.5:32501', pin: PIN, friends: true, release: '<x>', commit: 'zz' }, cred);
  assert.equal((await t.call('GET', '/servers', undefined, await t.login('anna', 'pwa'))).body.servers[0].build, '');

  const theirs = await t.call('GET', '/servers', undefined, await t.login('bob', 'pwa'));
  const f = theirs.body.servers[0];
  assert.deepEqual([f.sid, f.role, f.owner.username, f.addresses.lan], [SID, 'friend', 'anna', '']);

  // Le app di prima leggono ancora GET /friends
  const old = await t.call('GET', '/friends', undefined, await t.login('bob', 'app'));
  assert.equal(old.body.friends[0].servers[0].sid, SID);
});

test('GET /servers dice quale server e in casa (stessa rete) e porta amici e richieste', async () => {
  const t = await twoFriends();
  const carla = t.addUser('carla');
  t.env.DB.raw.prepare("INSERT INTO friends(a, b, status, t) VALUES(?, ?, 'pending', 0)").run(carla, t.anna);
  const cred = (await t.call('POST', `/servers/${SID}/claim`, {}, await t.login('anna', 'server'))).body.credential;
  await t.call('POST', '/server/heartbeat', { name: 'PC', url: '', pin: PIN, friends: true }, cred, '5.6.7.8');
  const tok = await t.login('anna', 'pwa');
  const home = await t.call('GET', '/servers', undefined, tok, '5.6.7.8');
  assert.equal(home.body.servers[0].local, true);
  const away = await t.call('GET', '/servers', undefined, tok, '9.9.9.9');
  assert.equal(away.body.servers[0].local, false);
  const fr = Object.fromEntries(home.body.friends.map((f) => [f.username, f.status]));
  assert.deepEqual(fr, { bob: 'ok', carla: 'received' });
  // IPv6: stessa rete se i primi 64 bit sono uguali
  await t.call('POST', '/server/heartbeat', { name: 'PC', url: '', pin: PIN, friends: true }, cred, '2a01:1:2:3:aaaa:1:1:1');
  const v6 = await t.call('GET', '/servers', undefined, await t.login('bob', 'pwa'), '2a01:1:2:3:bbbb:2:2:2');
  assert.equal(v6.body.servers[0].local, true);
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

// ---- Fase 2: nomi DNS e certificati (Cloudflare e Let's Encrypt finti)

function fakeNet() {
  const dns = new Map();
  const st = { n: 0, authz: 'pending', order: 'pending', jwk: null, triggered: false, finalCsr: null };
  const b64json = (s) => JSON.parse(Buffer.from(s, 'base64url').toString());
  const reply = (body, status = 200, headers = {}) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
  const fetch = async (input, init = {}) => {
    const url = String(input.url || input);
    const method = init.method || 'GET';
    if (url.startsWith('https://api.cloudflare.com/client/v4/zones/Z/dns_records')) {
      if (method === 'POST') {
        const id = 'r' + (++st.n);
        dns.set(id, JSON.parse(init.body));
        return reply({ success: true, result: { id } });
      }
      if (method === 'DELETE') {
        dns.delete(url.split('/').pop());
        return reply({ success: true, result: {} });
      }
    }
    if (url === 'https://acme.test/dir') {
      return reply({ newNonce: 'https://acme.test/nonce', newAccount: 'https://acme.test/acct', newOrder: 'https://acme.test/order' });
    }
    if (url === 'https://acme.test/nonce') return reply('', 200, { 'Replay-Nonce': 'n' + (++st.n) });
    const jws = init.body ? JSON.parse(init.body) : null;
    const prot = jws ? b64json(jws.protected) : {};
    const payload = jws && jws.payload ? b64json(jws.payload) : null;
    if (prot.url !== url || !prot.nonce) return reply({ type: 'urn:ietf:params:acme:error:malformed' }, 400);
    if (url === 'https://acme.test/acct') {
      assert.equal(payload.termsOfServiceAgreed, true);
      st.jwk = prot.jwk;
      return reply({ status: 'valid' }, 201, { Location: 'https://acme.test/acct/1' });
    }
    assert.equal(prot.kid, 'https://acme.test/acct/1');
    if (url === 'https://acme.test/order') {
      st.name = payload.identifiers[0].value;
      return reply({ status: 'pending', authorizations: ['https://acme.test/authz/1'], finalize: 'https://acme.test/fin/1' },
        201, { Location: 'https://acme.test/order/1' });
    }
    if (url === 'https://acme.test/authz/1') {
      return reply({ status: st.authz, challenges: [{ type: 'http-01', url: 'x', token: 'no' },
        { type: 'dns-01', url: 'https://acme.test/chall/1', token: 'tok' }] });
    }
    if (url === 'https://acme.test/chall/1') { st.triggered = true; st.authz = 'valid'; return reply({ status: 'processing' }); }
    if (url === 'https://acme.test/fin/1') { st.finalCsr = payload.csr; st.order = 'valid'; return reply({ status: 'processing' }); }
    if (url === 'https://acme.test/order/1') return reply({ status: st.order, certificate: 'https://acme.test/cert/1' });
    if (url === 'https://acme.test/cert/1') return reply('-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----\n');
    return reply({ detail: 'sconosciuto ' + url }, 404);
  };
  return { dns, st, fetch };
}

async function withNet(net, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = net.fetch;
  try { return await fn(); } finally { globalThis.fetch = real; }
}

function certEnv(t) {
  Object.assign(t.env, { SERVER_DOMAIN: 'bpx.test', CF_ZONE_ID: 'Z', CF_API_TOKEN: 'cf', ACME_AGREE: 'yes',
    ACME_DIRECTORY: 'https://acme.test/dir' });
}

test('nome DNS del server nella rete di casa e indirizzo https in GET /servers', async () => {
  const t = await twoFriends();
  certEnv(t);
  const net = fakeNet();
  await withNet(net, async () => {
    const cred = (await t.call('POST', `/servers/${SID}/claim`, {}, await t.login('anna', 'server'))).body.credential;
    const hb = await t.call('POST', '/server/heartbeat',
      { name: 'PC', lan: 'https://192.168.1.5:32501', pin: PIN, friends: true, secure_port: 32443 }, cred);
    assert.equal(hb.body.names.lan, '192-168-1-5.1234abcd.bpx.test');
    assert.equal(hb.body.domain, 'bpx.test');
    assert.deepEqual([...net.dns.values()].map((r) => [r.type, r.name, r.content]),
      [['A', '192-168-1-5.1234abcd.bpx.test', '192.168.1.5']]);
    const s = (await t.call('GET', '/servers', undefined, await t.login('anna', 'pwa'))).body.servers[0];
    assert.equal(s.addresses.secure_lan, 'https://192-168-1-5.1234abcd.bpx.test:32443');
    const f = (await t.call('GET', '/servers', undefined, await t.login('bob', 'pwa'))).body.servers[0];
    // Anche l'amico lo riceve: si collega direttamente (in casa del proprietario)
    assert.equal(f.addresses.secure_lan, 'https://192-168-1-5.1234abcd.bpx.test:32443');
    // Indirizzo di casa cambiato: nome nuovo, il vecchio sparisce
    await t.call('POST', '/server/heartbeat', { name: 'PC', lan: 'https://10.0.0.7:32501', pin: PIN, secure_port: 32443 }, cred);
    assert.deepEqual([...net.dns.values()].map((r) => r.name), ['10-0-0-7.1234abcd.bpx.test']);
    // Un indirizzo pubblico al posto di quello di casa: nessun nome
    await t.call('POST', '/server/heartbeat', { name: 'PC', lan: 'https://8.8.8.8:32501', pin: PIN }, cred);
    assert.equal(net.dns.size, 0);
    // Il server se ne va: via anche i nomi
    await t.call('POST', '/server/heartbeat', { name: 'PC', lan: 'https://192.168.1.5:32501', pin: PIN }, cred);
    await t.call('DELETE', '/server', undefined, cred);
    assert.equal(net.dns.size, 0);
  });
});

test('certificato *.<sid>.<dominio> con la verifica DNS-01', async () => {
  const t = await twoFriends();
  certEnv(t);
  const net = fakeNet();
  await withNet(net, async () => {
    const cred = (await t.call('POST', `/servers/${SID}/claim`, {}, await t.login('anna', 'server'))).body.credential;
    const csr = 'M'.repeat(300);
    assert.equal((await t.call('POST', '/server/cert/start', { csr: 'corta' }, cred)).status, 400);
    const st = await t.call('POST', '/server/cert/start', { csr }, cred);
    assert.equal(st.body.status, 'pending');
    assert.equal(net.st.name, '*.1234abcd.bpx.test');
    // Record TXT = base64url(sha256(token.impronta della chiave dell'account))
    const txt = [...net.dns.values()].find((r) => r.type === 'TXT');
    assert.equal(txt.name, '_acme-challenge.1234abcd.bpx.test');
    const jwk = net.st.jwk;
    const thumb = createHash('sha256').update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest('base64url');
    assert.equal(txt.content, createHash('sha256').update('tok.' + thumb).digest('base64url'));
    // Troppo presto: il TXT deve arrivare ai DNS
    assert.equal((await t.call('POST', '/server/cert/poll', {}, cred)).body.status, 'pending');
    assert.equal(net.st.triggered, false);
    t.env.DB.raw.prepare('UPDATE cert_orders SET created = created - 20').run();
    assert.equal((await t.call('POST', '/server/cert/poll', {}, cred)).body.status, 'pending');
    assert.equal(net.st.triggered, true);
    const done = await t.call('POST', '/server/cert/poll', {}, cred);
    assert.equal(done.body.status, 'valid');
    assert.match(done.body.cert, /BEGIN CERTIFICATE/);
    assert.equal(net.st.finalCsr, csr);
    assert.equal([...net.dns.values()].filter((r) => r.type === 'TXT').length, 0);
    assert.equal((await t.call('POST', '/server/cert/poll', {}, cred)).status, 404);
  });
});

test('senza dominio configurato niente nomi e niente certificati', async () => {
  const t = await twoFriends();
  const cred = (await t.call('POST', `/servers/${SID}/claim`, {}, await t.login('anna', 'server'))).body.credential;
  const hb = await t.call('POST', '/server/heartbeat',
    { name: 'PC', lan: 'https://192.168.1.5:32501', pin: PIN, secure_port: 32443 }, cred);
  assert.deepEqual([hb.body.names, hb.body.domain], [{}, '']);
  assert.equal((await t.call('POST', '/server/cert/start', { csr: 'M'.repeat(300) }, cred)).status, 404);
  assert.equal((await t.call('GET', '/')).body.certs, false);
});

// ---- Fase 3: la PWA servita dal Worker

test('PWA: GET / da browser e la pagina (con il segno centrale), con JSON e lo stato', async () => {
  const t = setup();
  const files = { '/': '<!doctype html><html><head><title>B</title></head></html>', '/app.js': 'var x;' };
  t.env.ASSETS = { fetch: async (req) => {
    const p = new URL(req.url).pathname;
    return p in files ? new Response(files[p], { status: 200 }) : new Response('no', { status: 404 });
  } };
  const get = (path, accept) => worker.fetch(new Request('https://acc.test' + path, { headers: accept ? { Accept: accept } : {} }), t.env);
  const page = await get('/', 'text/html');
  assert.match(await page.text(), /<head>\n<meta name="bp-central" content="1">/);
  const stato = await get('/', 'application/json');
  assert.equal((await stato.json()).app, 'bunkerplex-account');
  assert.equal(await (await get('/app.js')).text(), 'var x;');
  // Le rotte dell'API non diventano file
  assert.equal((await get('/me', 'application/json')).status, 401);
});

test("aspetto del server: icona e immagine dal proprietario, l'amico le vede, gli altri no", async () => {
  const t = await twoFriends();
  const annaPc = await t.login('anna', 'server', 'PC di Anna');
  await t.call('POST', `/servers/${SID}/claim`, { name: 'PC Anna' }, annaPc);
  t.env.DB.raw.prepare("INSERT OR REPLACE INTO servers(user_id, sid, name, url, pin, t, friends) VALUES(?, ?, 'PC Anna', 'https://x', ?, 0, 1)")
    .run(t.anna, SID, PIN);
  const anna = await t.login('anna', 'pwa');
  const bob = await t.login('bob', 'pwa');
  assert.equal((await t.call('PUT', `/servers/${SID}/look`, { icon: 'film' }, bob)).status, 404);
  assert.equal((await t.call('PUT', `/servers/${SID}/look`, { icon: 'razzo' }, anna)).status, 400);
  assert.equal((await t.call('PUT', `/servers/${SID}/look`, { image: 'data:text/html;base64,AAAA' }, anna)).status, 400);
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgaJgJAAGbAQ5TSSm5AAAAAElFTkSuQmCC';
  const put = await t.call('PUT', `/servers/${SID}/look`, { icon: 'film', image: png }, anna);
  assert.equal(put.status, 200);
  assert.equal(put.body.look.icon, 'film');
  assert.match(put.body.look.image, /^https:\/\/acc\.test\/servers\/1234abcd\/image\?v=\d+$/);
  const seen = await t.call('GET', '/servers', undefined, bob);
  assert.equal(seen.body.servers.find((s) => s.sid === SID).look.icon, 'film');
  const img = await worker.fetch(new Request(`https://acc.test/servers/${SID}/image`), t.env);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('Content-Type'), 'image/png');
  const off = await t.call('PUT', `/servers/${SID}/look`, { image: '' }, anna);
  assert.equal(off.body.look.image, '');
  assert.equal(off.body.look.icon, 'film');
});

// ---- Notifiche: app Android con Firebase Cloud Messaging (Google finto)

function fakeFcm() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sa = { type: 'service_account', project_id: 'bp-test', client_email: 'fcm@bp-test.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: 'https://oauth2.googleapis.com/token' };
  const st = { oauth: 0, sent: [], reply: () => new Response(JSON.stringify({ name: 'projects/bp-test/messages/1' })) };
  const fetch = async (input, init = {}) => {
    const url = String(input.url || input);
    if (url === 'https://oauth2.googleapis.com/token') {
      st.oauth++;
      const form = new URLSearchParams(init.body);
      assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
      const [h, c, sig] = form.get('assertion').split('.');
      assert.ok(verify('sha256', Buffer.from(h + '.' + c), publicKey, Buffer.from(sig, 'base64url')), 'firma JWT');
      const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
      assert.equal(claims.iss, sa.client_email);
      assert.equal(claims.scope, 'https://www.googleapis.com/auth/firebase.messaging');
      return new Response(JSON.stringify({ access_token: 'ya29.finto', expires_in: 3599 }));
    }
    if (url === 'https://fcm.googleapis.com/v1/projects/bp-test/messages:send') {
      assert.equal(init.headers.Authorization, 'Bearer ya29.finto');
      const msg = JSON.parse(init.body).message;
      st.sent.push(msg);
      return st.reply(msg);
    }
    return new Response('{}', { status: 404 });
  };
  return { sa, st, fetch };
}

const FCM_TOK = 'fA1b2C3d4E5:APA91b' + 'x'.repeat(140);

async function noticeDev(t, name, kind = 'android') {
  const tok = await t.login(name, 'app');
  const r = await t.call('POST', '/notices/devices', { kind, label: 'Pixel' }, tok);
  assert.equal(r.status, 200);
  return { acc: tok, dev: r.body.token, key: r.body.key };
}

test("notifiche: l'app Android con FCM riceve subito, ad alta priorita'", async () => {
  const t = await twoFriends();
  const net = fakeFcm();
  t.env.FCM_SERVICE_ACCOUNT = JSON.stringify(net.sa);
  const anna = await noticeDev(t, 'anna');
  assert.match(anna.key, /^[A-Za-z0-9_-]{80,90}$/);      // chiave VAPID per la PWA
  assert.equal((await t.call('POST', `/avvisi/${anna.dev}/fcm`, { token: 'corto' })).status, 400);
  const reg = await t.call('POST', `/avvisi/${anna.dev}/fcm`, { token: FCM_TOK });
  assert.deepEqual(reg.body, { ok: true, fcm: true });

  await withNet(net, async () => {
    const r = await t.call('POST', '/notices', { title: 'Nuovo film', body: 'Dune' }, await t.login('anna', 'server'));
    assert.equal(r.body.sent, 1);
    const r2 = await t.call('POST', '/notices', { kind: 'update', title: 'Aggiornamento', body: 'v2' }, await t.login('anna', 'server'));
    assert.equal(r2.body.sent, 1);
  });
  assert.equal(net.st.oauth, 1, 'il gettone di Google si riusa');
  assert.equal(net.st.sent.length, 2);
  const m = net.st.sent[0];
  assert.equal(m.token, FCM_TOK);
  assert.equal(m.android.priority, 'high');
  assert.equal(m.notification, undefined, "messaggio data: la notifica la fa l'app");
  assert.equal(m.data.title, 'Nuovo film');
  assert.equal(m.data.body, 'Dune');
  assert.equal(m.data.kind, 'titles');
  assert.match(m.data.id, /^\d+$/);
  assert.ok(Object.values(m.data).every((v) => typeof v === 'string'));

  const devs = await t.call('GET', '/notices/devices', undefined, anna.acc);
  assert.deepEqual([devs.body.devices[0].push, devs.body.devices[0].fcm], [true, true]);
  const list = await t.call('GET', `/avvisi/${anna.dev}/list`);
  assert.equal(list.body.fcm, true);
  assert.equal(list.body.notices.length, 2);

  // Prova dalla pagina: passa da FCM
  await withNet(net, async () => assert.equal((await t.call('POST', `/avvisi/${anna.dev}/test`)).status, 200));
  assert.equal(net.st.sent.length, 3);
});

test('notifiche: il gettone FCM che Google rifiuta (app tolta) si dimentica', async () => {
  const t = await twoFriends();
  const net = fakeFcm();
  t.env.FCM_SERVICE_ACCOUNT = JSON.stringify(net.sa);
  const anna = await noticeDev(t, 'anna');
  await t.call('POST', `/avvisi/${anna.dev}/fcm`, { token: FCM_TOK });
  net.st.reply = () => new Response(JSON.stringify({ error: { code: 404, status: 'NOT_FOUND',
    details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }] } }), { status: 404 });
  await withNet(net, () => t.call('POST', '/notices', { title: 'Nuovo film' }, anna.acc));
  assert.equal(t.env.DB.raw.prepare('SELECT fcm FROM notice_devices').get().fcm, null);
  // Un errore qualsiasi (es. 500 di Google) invece non lo toglie
  await t.call('POST', `/avvisi/${anna.dev}/fcm`, { token: FCM_TOK });
  net.st.reply = () => new Response('{"error":{"code":500}}', { status: 500 });
  await withNet(net, () => t.call('POST', '/notices', { title: 'Altro film' }, anna.acc));
  assert.equal(t.env.DB.raw.prepare('SELECT fcm FROM notice_devices').get().fcm, FCM_TOK);
  // Lo stesso telefono iscritto di nuovo (nuovo gettone del dispositivo): l'avviso arriva una volta
  const again = await noticeDev(t, 'anna');
  await t.call('POST', `/avvisi/${again.dev}/fcm`, { token: FCM_TOK });
  assert.equal(t.env.DB.raw.prepare('SELECT COUNT(*) n FROM notice_devices WHERE fcm IS NOT NULL').get().n, 1);
});

test("notifiche: senza FCM_SERVICE_ACCOUNT non si rompe niente (l'app controlla da sola)", async () => {
  const t = await twoFriends();
  const anna = await noticeDev(t, 'anna');
  const reg = await t.call('POST', `/avvisi/${anna.dev}/fcm`, { token: FCM_TOK });
  assert.deepEqual(reg.body, { ok: true, fcm: false });
  let calls = 0;
  await withNet({ fetch: async () => { calls++; return new Response('{}'); } }, async () => {
    assert.equal((await t.call('POST', '/notices', { title: 'Nuovo film' }, anna.acc)).body.sent, 1);
  });
  assert.equal(calls, 0);
  const devs = await t.call('GET', '/notices/devices', undefined, anna.acc);
  assert.deepEqual([devs.body.devices[0].push, devs.body.devices[0].fcm], [false, false]);
  assert.equal((await t.call('GET', `/avvisi/${anna.dev}/list`)).body.notices.length, 1);
  assert.equal((await t.call('POST', `/avvisi/${anna.dev}/test`)).status, 409);
  // Segreto rovinato: come se mancasse
  t.env.FCM_SERVICE_ACCOUNT = '{non json';
  assert.equal((await t.call('POST', `/avvisi/${anna.dev}/fcm`, { token: FCM_TOK })).body.fcm, false);
});

test('notifiche: le chiamate del dispositivo rispondono anche alla PWA di un server di casa (CORS)', async () => {
  const t = await twoFriends();
  const anna = await noticeDev(t, 'anna', 'web');
  const pre = await worker.fetch(new Request(`https://acc.test/avvisi/${anna.dev}/push`, { method: 'OPTIONS',
    headers: { Origin: 'https://192.168.1.5:32501', 'Access-Control-Request-Method': 'POST' } }), t.env);
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('Access-Control-Allow-Origin'), '*');
  const sub = { endpoint: 'https://push.example/abc', keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } };
  const ok = await worker.fetch(new Request(`https://acc.test/avvisi/${anna.dev}/push`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sub) }), t.env);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), '*');
  const bad = await worker.fetch(new Request(`https://acc.test/avvisi/${'0'.repeat(64)}/list`), t.env);
  assert.equal(bad.status, 401);
  assert.equal(bad.headers.get('Access-Control-Allow-Origin'), '*');
  // Stesso browser iscritto con un altro gettone: resta solo l'ultimo
  const again = await noticeDev(t, 'anna', 'web');
  assert.equal((await t.call('POST', `/avvisi/${again.dev}/push`, sub)).status, 200);
  assert.equal(t.env.DB.raw.prepare('SELECT COUNT(*) n FROM notice_devices WHERE endpoint IS NOT NULL').get().n, 1);
});

test('profili: principale + aggiunti, PIN, biglietto firmato, visti separati per profilo', async () => {
  const t = await twoFriends();
  const anna = await t.login('anna', 'pwa');
  let r = await t.call('GET', '/profiles', undefined, anna);
  assert.deepEqual(r.body.profiles.map((p) => [p.id, p.name, p.main]), [[0, 'anna', true]]);
  r = await t.call('POST', '/profiles', { name: 'Leo', avatar: 'fox', color: '#2ecc71', kids: true }, anna);
  assert.equal(r.status, 200);
  const leo = r.body.profile;
  assert.deepEqual([leo.name, leo.avatar, leo.kids, leo.pin], ['Leo', 'fox', true, false]);
  assert.equal((await t.call('POST', '/profiles', { name: 'leo' }, anna)).status, 409);
  assert.equal((await t.call('POST', '/profiles', { name: 'X', avatar: 'drago' }, anna)).status, 400);
  // Il principale si personalizza (anche il PIN)
  r = await t.call('PUT', '/profiles/0', { avatar: 'cat', pin: '1234' }, anna);
  assert.deepEqual([r.body.profile.avatar, r.body.profile.pin, r.body.profile.kids], ['cat', true, false]);
  assert.equal((await t.call('POST', '/profiles/0/open', {}, anna)).status, 412);
  assert.equal((await t.call('POST', '/profiles/0/open', { pin: '0000' }, anna)).status, 401);
  const open = await t.call('POST', '/profiles/0/open', { pin: '1234' }, anna);
  assert.equal(open.status, 200);
  const free = await t.call('POST', `/profiles/${leo.id}/open`, {}, anna);
  assert.equal(free.status, 200);
  const claims = JSON.parse(Buffer.from(free.body.ticket.split('.')[1], 'base64url'));
  assert.deepEqual([claims.typ, claims.sub, claims.pid], ['profile', String(t.anna), leo.id]);
  // Bob non vede ne' apre i profili di Anna
  const bob = await t.login('bob', 'pwa');
  assert.equal((await t.call('POST', `/profiles/${leo.id}/open`, {}, bob)).status, 404);
  assert.equal((await t.call('GET', `/state?profile=${leo.id}`, undefined, bob)).status, 404);
  // Visti: ognuno i suoi
  await t.call('POST', '/state', { rows: [{ k: 'm10', w: 1, t: 5 }] }, anna);
  await t.call('POST', `/state?profile=${leo.id}`, { rows: [{ k: 'm20', pos: 30, t: 5 }] }, anna);
  assert.deepEqual((await t.call('GET', '/state', undefined, anna)).body.rows.map((x) => x.k), ['m10']);
  assert.deepEqual((await t.call('GET', `/state?profile=${leo.id}`, undefined, anna)).body.rows.map((x) => x.k), ['m20']);
  // 5 PIN sbagliati: bloccato
  for (let i = 0; i < 5; i++) await t.call('POST', '/profiles/0/open', { pin: '9999' }, anna);
  assert.equal((await t.call('POST', '/profiles/0/open', { pin: '1234' }, anna)).status, 429);
  // Togliere un profilo toglie i suoi visti; il principale non si toglie
  assert.equal((await t.call('DELETE', '/profiles/0', undefined, anna)).status, 400);
  assert.equal((await t.call('DELETE', `/profiles/${leo.id}`, undefined, anna)).status, 200);
  assert.equal(t.env.DB.raw.prepare('SELECT COUNT(*) n FROM pstate').get().n, 0);
  // Al massimo 6 profili
  for (const n of ['a1', 'a2', 'a3', 'a4', 'a5']) assert.equal((await t.call('POST', '/profiles', { name: n }, anna)).status, 200);
  assert.equal((await t.call('POST', '/profiles', { name: 'a6' }, anna)).status, 400);
});

test('collegamento con il codice: nuovo server, sostituzione sulla stessa macchina, credenziale come proprietario', async () => {
  const t = await twoFriends();
  const anna = await t.login('anna', 'pwa');
  const NEW = 'feedbeef';
  const MACHINE = 'ab'.repeat(16);
  // Senza codice un server nuovo non entra
  assert.equal((await t.call('POST', `/servers/${NEW}/claim`, {}, await t.login('anna', 'server'))).status, 428);
  // Il server vecchio (SID) della stessa macchina
  const old = (await t.call('POST', `/servers/${SID}/claim`, {}, await t.login('anna', 'server'))).body.credential;
  await t.call('POST', '/server/heartbeat', { name: 'Salotto', pin: PIN, friends: true, machine: MACHINE }, old);
  // Reinstallazione: codice dal server nuovo
  const st = await t.call('POST', '/claim/start', { sid: NEW, machine: MACHINE, name: 'PC nuovo', version: '9' });
  assert.match(st.body.code, /^[A-Z2-9]{8}$/);
  assert.equal((await t.call('POST', '/claim/poll', { code: st.body.code, poll: st.body.poll })).body.status, 'pending');
  assert.equal((await t.call('POST', '/claim/poll', { code: st.body.code, poll: 'x' })).status, 404);
  let info = await t.call('GET', `/claim/${st.body.code}`, undefined, anna);
  assert.deepEqual(info.body.same_machine.map((s) => [s.sid, s.online]), [[SID, true]]);
  // Acceso: non si sostituisce
  assert.equal((await t.call('POST', `/claim/${st.body.code}`, { name: 'Salotto', replace: SID }, anna)).status, 409);
  t.env.DB.raw.prepare('UPDATE server_creds SET last_seen = 1 WHERE sid = ?').run(SID);
  // Un altro account non vede le macchine di Anna
  info = await t.call('GET', `/claim/${st.body.code}`, undefined, await t.login('bob', 'pwa'));
  assert.deepEqual(info.body.same_machine, []);
  const ok = await t.call('POST', `/claim/${st.body.code}`, { name: 'Salotto', replace: SID }, anna);
  assert.deepEqual([ok.status, ok.body.sid, ok.body.replaced], [200, SID, true]);
  assert.equal((await t.call('POST', `/claim/${st.body.code}`, { name: 'Salotto' }, anna)).status, 409);
  const done = await t.call('POST', '/claim/poll', { code: st.body.code, poll: st.body.poll });
  assert.deepEqual([done.body.status, done.body.sid, done.body.owner.username, done.body.name], ['done', SID, 'anna', 'Salotto']);
  // La credenziale vecchia non vale piu', la nuova si'
  assert.equal((await t.call('POST', '/server/heartbeat', { name: 'x', pin: PIN }, old)).status, 401);
  const cred = done.body.credential;
  assert.equal((await t.call('POST', '/server/heartbeat', { name: 'Salotto', pin: PIN, friends: true, machine: MACHINE }, cred)).status, 200);
  // Bob (amico) continua a vedere lo stesso server
  const theirs = await t.call('GET', '/servers', undefined, await t.login('bob', 'pwa'));
  assert.deepEqual(theirs.body.servers.map((s) => s.sid), [SID]);
  const mine = await t.call('GET', '/servers', undefined, anna);
  assert.deepEqual(mine.body.servers.map((s) => [s.sid, s.name, s.machine]), [[SID, 'Salotto', MACHINE]]);
  // Seconda installazione sulla stessa macchina, entrambe accese: separate, nome unico
  const st2 = await t.call('POST', '/claim/start', { sid: NEW, machine: MACHINE, name: 'Docker' });
  assert.equal((await t.call('POST', `/claim/${st2.body.code}`, { name: 'salotto' }, anna)).status, 409);
  assert.equal((await t.call('POST', `/claim/${st2.body.code}`, { name: 'Salotto (Docker)' }, anna)).status, 200);
  const c2 = (await t.call('POST', '/claim/poll', { code: st2.body.code, poll: st2.body.poll })).body;
  assert.equal(c2.sid, NEW);
  // Con la credenziale il server legge visti e profili del proprietario, non altro
  await t.call('POST', '/state', { rows: [{ k: 'm1', w: 1, t: 5 }] }, anna);
  assert.deepEqual((await t.call('GET', '/state', undefined, c2.credential)).body.rows.map((x) => x.k), ['m1']);
  assert.equal((await t.call('GET', '/profiles', undefined, c2.credential)).status, 200);
  assert.equal((await t.call('GET', '/devices', undefined, c2.credential)).status, 403);
  assert.equal((await t.call('POST', '/password', {}, c2.credential)).status, 403);
  // Il biglietto di un profilo lo verifica anche il server senza cryptography
  const tk = (await t.call('POST', '/profiles/0/open', {}, c2.credential)).body.ticket;
  assert.equal((await t.call('POST', '/server/verify', { token: tk }, c2.credential)).status, 200);
  const bobTk = (await t.call('POST', '/profiles/0/open', {}, await t.login('bob', 'pwa'))).body.ticket;
  assert.equal((await t.call('POST', '/server/verify', { token: bobTk }, c2.credential)).status, 403);
});

test('la TV entra dal telefono: codice, conferma con l\'account, gettone una volta sola', async () => {
  const t = setup();
  t.addUser('anna');
  t.addUser('bob');
  const start = await t.call('POST', '/tv/start', { device: 'TV Sony' });
  assert.equal(start.status, 200);
  const { code, poll } = start.body;
  assert.match(code, /^[A-Z2-9]{8}$/);
  assert.equal(start.body.url, 'https://acc.test/#/tv/' + code);
  assert.deepEqual((await t.call('POST', '/tv/poll', { poll })).body, { done: false, seen: false });
  // Il telefono apre il QR: la TV lo sa
  assert.equal((await t.call('POST', '/tv/' + code + '/seen', {})).status, 200);
  assert.equal((await t.call('POST', '/tv/poll', { poll })).body.seen, true);
  // Il segreto per ritirare il gettone non e' il codice
  assert.equal((await t.call('POST', '/tv/poll', { poll: code })).status, 404);
  // Senza account non si conferma
  assert.equal((await t.call('POST', '/tv/' + code, {})).status, 401);
  const phone = await t.login('anna', 'pwa');
  const info = await t.call('GET', '/tv/' + code.slice(0, 4) + '-' + code.slice(4).toLowerCase(), undefined, phone);
  assert.equal(info.body.device, 'TV Sony');
  assert.equal((await t.call('POST', '/tv/' + code, {}, phone)).body.ok, true);
  // Un altro account non se la prende
  assert.equal((await t.call('POST', '/tv/' + code, {}, await t.login('bob', 'pwa'))).status, 409);
  const done = await t.call('POST', '/tv/poll', { poll });
  assert.equal(done.body.done, true);
  assert.equal(done.body.user.username, 'anna');
  const me = await t.call('GET', '/me', undefined, done.body.token);
  assert.equal(me.body.user.username, 'anna');
  const devs = await t.call('GET', '/devices', undefined, done.body.token);
  assert.ok(devs.body.devices.some((d) => d.kind === 'tv' && d.label === 'TV Sony' && d.current));
  // Una volta sola
  assert.equal((await t.call('POST', '/tv/poll', { poll })).status, 404);
  assert.equal((await t.call('GET', '/tv/' + code, undefined, phone)).status, 404);
  // Scritto a mano nel browser: alla pagina della PWA
  const r = await worker.fetch(new Request('https://acc.test/tv'), t.env);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('Location'), 'https://acc.test/#/tv');
});

// ---- Entra con Google (Google finto)

function fakeGoogle(env, claims) {
  const st = { form: null };
  const fetch = async (input, init = {}) => {
    const url = String(input.url || input);
    if (url === 'https://oauth2.googleapis.com/token') {
      st.form = new URLSearchParams(init.body);
      const c = typeof claims === 'function' ? claims() : claims;
      const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
      return new Response(JSON.stringify({ id_token: part({ alg: 'RS256' }) + '.' + part({
        iss: 'https://accounts.google.com', aud: env.GOOGLE_CLIENT_ID, exp: Date.now() / 1000 + 600, nonce: st.nonce, ...c
      }) + '.x' }));
    }
    return new Response('{}', { status: 404 });
  };
  return { st, fetch };
}

async function googleGo(t, code, g, cookie) {
  const headers = cookie ? { Cookie: cookie } : {};
  const r = cookie
    ? await worker.fetch(new Request('https://acc.test/g/' + code, { headers }), t.env)
    : await worker.fetch(new Request('https://acc.test/g/' + code, { method: 'POST' }), t.env);
  assert.equal(r.status, 303);
  const to = new URL(r.headers.get('Location'));
  assert.equal(to.host, 'accounts.google.com');
  assert.equal(to.searchParams.get('code_challenge_method'), 'S256');
  g.st.nonce = to.searchParams.get('nonce');
  g.st.challenge = to.searchParams.get('code_challenge');
  return to;
}

async function googleBack(t, to) {
  const r = await worker.fetch(new Request('https://acc.test/google/callback?code=c&state=' + encodeURIComponent(to.searchParams.get('state')),
    { headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14)' } }), t.env);
  return { status: r.status, html: await r.text() };
}

test('google: dalla TV, account sbagliato si riprova, poi entra (PKCE, nonce, stato)', async () => {
  const t = setup();
  t.env.GOOGLE_CLIENT_ID = 'cid';
  t.env.GOOGLE_CLIENT_SECRET = 'sec';
  const anna = t.addUser('anna');
  t.env.DB.raw.prepare('UPDATE users SET google_email = ? WHERE id = ?').run('anna@example.com', anna);
  let who = { sub: 'g-bob', email: 'bob@example.com', email_verified: true };
  const g = fakeGoogle(t.env, () => who);
  const real = globalThis.fetch;
  globalThis.fetch = g.fetch;
  try {
    const start = await t.call('POST', '/google/start', { kind: 'tv', device: 'TV Sony', hint: 'anna@example.com' });
    const { code, poll } = start.body;
    assert.deepEqual((await t.call('POST', '/google/poll', { poll })).body, { done: false, seen: false, note: '' });
    // Il telefono apre il codice: la TV lo sa
    const page = await worker.fetch(new Request('https://acc.test/g/' + code), t.env);
    assert.equal(page.status, 200);
    assert.equal((await t.call('POST', '/google/poll', { poll })).body.seen, true);
    const to = await googleGo(t, code, g);
    assert.equal(to.searchParams.get('login_hint'), 'anna@example.com');
    // Account Google sconosciuto: il codice resta buono e la TV legge il motivo
    const bad = await googleBack(t, to);
    assert.equal(bad.status, 403);
    assert.match(bad.html, /Prova con un altro account Google/);
    const mid = (await t.call('POST', '/google/poll', { poll })).body;
    assert.equal(mid.done, false);
    assert.match(mid.note, /bob@example\.com/);
    // Il vecchio state non vale piu'
    assert.equal((await googleBack(t, to)).status, 400);
    // Con l'account giusto
    who = { sub: 'g-anna', email: 'anna@example.com', email_verified: true };
    const to2 = await googleGo(t, code, g);
    const ok = await googleBack(t, to2);
    assert.equal(ok.status, 200);
    assert.match(ok.html, /La TV entra da sola/);
    const v = g.st.form.get('code_verifier');
    assert.equal(createHash('sha256').update(v).digest('base64url'), g.st.challenge, 'PKCE');
    const done = (await t.call('POST', '/google/poll', { poll })).body;
    assert.equal(done.done, true);
    assert.equal(done.user.username, 'anna');
    assert.equal(done.user.google, 'anna@example.com');
    // Una volta sola
    assert.equal((await t.call('POST', '/google/poll', { poll })).status, 404);
  } finally {
    globalThis.fetch = real;
  }
});

test('google: un nonce diverso non entra; lo stesso browser salta la conferma', async () => {
  const t = setup();
  t.env.GOOGLE_CLIENT_ID = 'cid';
  t.env.GOOGLE_CLIENT_SECRET = 'sec';
  const anna = t.addUser('anna');
  t.env.DB.raw.prepare('UPDATE users SET google_sub = ?, google_email = ? WHERE id = ?').run('g-anna', 'anna@example.com', anna);
  let extra = { nonce: 'altro' };
  const g = fakeGoogle(t.env, () => ({ sub: 'g-anna', email: 'anna@example.com', email_verified: true, ...extra }));
  const real = globalThis.fetch;
  globalThis.fetch = g.fetch;
  try {
    const res = await worker.fetch(new Request('https://acc.test/google/start', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'browser', back: 'https://acc.test/#/home' }) }), t.env);
    const start = await res.json();
    assert.equal(res.status, 200, JSON.stringify(start));
    const cookie = res.headers.get('Set-Cookie').split(';')[0];
    assert.match(cookie, new RegExp('^bpg=' + start.code + '\.'));
    // Senza il cookie: la pagina di conferma
    assert.equal((await worker.fetch(new Request('https://acc.test/g/' + start.code), t.env)).status, 200);
    // Col cookie: dritto a Google
    const to = await googleGo(t, start.code, g, cookie);
    assert.equal((await googleBack(t, to)).status, 403);
    assert.equal((await t.call('POST', '/google/poll', { poll: start.poll })).body.done, false);
    extra = {};
    const ok = await googleBack(t, await googleGo(t, start.code, g));
    assert.equal(ok.status, 200);
    assert.match(ok.html, /window\.close/);
    assert.match(ok.html, /href="https:\/\/acc\.test\/#\/home"/);
    assert.ok((await t.call('POST', '/google/poll', { poll: start.poll })).body.token);
  } finally {
    globalThis.fetch = real;
  }
});

// ---- Passkey (autenticatore finto: chiave P-256 vera, CBOR scritto a mano)

function cborEnc(v) {
  const head = (major, n) => n < 24 ? [major << 5 | n] : n < 256 ? [major << 5 | 24, n] : [major << 5 | 25, n >> 8, n & 255];
  if (typeof v === 'number') return Buffer.from(v >= 0 ? head(0, v) : head(1, -1 - v));
  if (typeof v === 'string') { const b = Buffer.from(v); return Buffer.concat([Buffer.from(head(3, b.length)), b]); }
  if (v instanceof Uint8Array) return Buffer.concat([Buffer.from(head(2, v.length)), v]);
  const entries = [...v.entries()];
  return Buffer.concat([Buffer.from(head(5, entries.length)), ...entries.flatMap(([k, x]) => [cborEnc(k), cborEnc(x)])]);
}

function fakeAuthenticator(origin = 'https://acc.test') {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credId = Buffer.from('cred-' + Math.random().toString(36).slice(2));
  const rpHash = createHash('sha256').update('acc.test').digest();
  let counter = 0;
  const ad = (flags, extra = Buffer.alloc(0)) => {
    const c = Buffer.alloc(4); c.writeUInt32BE(counter);
    return Buffer.concat([rpHash, Buffer.from([flags]), c, extra]);
  };
  const cd = (type, challenge) => Buffer.from(JSON.stringify({ type, challenge, origin }));
  return {
    id: credId.toString('base64url'),
    create(challenge) {
      const cose = new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]);
      const len = Buffer.from([credId.length >> 8, credId.length & 255]);
      const authData = ad(0x45, Buffer.concat([Buffer.alloc(16), len, credId, cborEnc(cose)]));
      return { clientDataJSON: cd('webauthn.create', challenge).toString('base64url'),
        attestationObject: cborEnc(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]])).toString('base64url') };
    },
    get(challenge, flags = 0x05) {
      counter++;
      const authData = ad(flags);
      const client = cd('webauthn.get', challenge);
      const sig = createSign('sha256').update(Buffer.concat([authData, createHash('sha256').update(client).digest()])).sign(privateKey);
      return { id: credId.toString('base64url'), clientDataJSON: client.toString('base64url'),
        authenticatorData: authData.toString('base64url'), signature: sig.toString('base64url') };
    }
  };
}

test('passkey: si aggiunge con l\'account, poi si entra con impronta o volto', async () => {
  const t = setup();
  t.addUser('anna');
  const tok = await t.login('anna', 'pwa');
  const dev = fakeAuthenticator();
  // Senza account non si aggiunge
  assert.equal((await t.call('POST', '/passkeys/register/start', {})).status, 401);
  const rs = (await t.call('POST', '/passkeys/register/start', {}, tok)).body;
  assert.equal(rs.rp.id, 'acc.test');
  const reg = await t.call('POST', '/passkeys/register/finish', { ...dev.create(rs.challenge), label: 'iPhone' }, tok);
  assert.equal(reg.status, 200, JSON.stringify(reg.body));
  // La stessa sfida non vale due volte
  assert.equal((await t.call('POST', '/passkeys/register/finish', { ...dev.create(rs.challenge) }, tok)).status, 400);
  const list = (await t.call('GET', '/passkeys', undefined, tok)).body.passkeys;
  assert.deepEqual(list.map((p) => p.label), ['iPhone']);
  assert.deepEqual((await t.call('POST', '/passkeys/register/start', {}, tok)).body.exclude, [dev.id]);

  const ls = (await t.call('POST', '/passkeys/login/start', {})).body;
  const ok = await t.call('POST', '/passkeys/login/finish', { ...dev.get(ls.challenge), device: 'iPhone', kind: 'pwa' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.user.username, 'anna');
  assert.equal((await t.call('GET', '/me', undefined, ok.body.token)).body.user.username, 'anna');
  // Sfida gia' usata
  assert.equal((await t.call('POST', '/passkeys/login/finish', dev.get(ls.challenge))).status, 400);
  // Senza verifica dell'identita' (UV) non entra
  const ls2 = (await t.call('POST', '/passkeys/login/start', {})).body;
  assert.equal((await t.call('POST', '/passkeys/login/finish', dev.get(ls2.challenge, 0x01))).status, 401);
  // Da un altro indirizzo non vale
  const other = fakeAuthenticator('https://evil.test');
  const ls3 = (await t.call('POST', '/passkeys/login/start', {})).body;
  assert.equal((await t.call('POST', '/passkeys/login/finish', other.get(ls3.challenge))).status, 400);
  // Firma sbagliata
  const ls4 = (await t.call('POST', '/passkeys/login/start', {})).body;
  const bad = dev.get(ls4.challenge);
  bad.signature = fakeAuthenticator().get(ls4.challenge).signature;
  assert.equal((await t.call('POST', '/passkeys/login/finish', bad)).status, 401);
  // Tolta: non entra piu'
  // La via di prima (DELETE) non toglie piu' niente
  assert.equal((await t.call('DELETE', '/passkeys/' + dev.id, undefined, tok)).status, 409);
  // Senza email: sessione appena aperta = gia' verificata, si toglie subito
  assert.equal((await t.call('POST', '/passkeys/' + dev.id + '/remove', {}, tok)).body.removed, true);
  const ls5 = (await t.call('POST', '/passkeys/login/start', {})).body;
  assert.equal((await t.call('POST', '/passkeys/login/finish', dev.get(ls5.challenge))).status, 401);
});

test('assetlinks: l\'app Android dichiarata solo con le impronte giuste', async () => {
  const t = setup();
  assert.equal((await worker.fetch(new Request('https://acc.test/.well-known/assetlinks.json'), t.env)).status, 404);
  const fp = Array.from({ length: 32 }, () => 'ab').join(':');
  t.env.ANDROID_CERT_SHA256 = fp + ', nonvalida';
  const r = await worker.fetch(new Request('https://acc.test/.well-known/assetlinks.json'), t.env);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j[0].target.package_name, 'it.bunkerplex.tv');
  assert.deepEqual(j[0].target.sha256_cert_fingerprints, [fp.toUpperCase()]);
  assert.ok(j[0].relation.includes('delegate_permission/common.get_login_creds'));
});

test('google: «back» solo verso questo servizio; sfide passkey tante: via le vecchie', async () => {
  const t = setup();
  t.env.GOOGLE_CLIENT_ID = 'cid';
  t.env.GOOGLE_CLIENT_SECRET = 'sec';
  await t.call('POST', '/google/start', { kind: 'browser', back: 'https://evil.test/x' });
  await t.call('POST', '/google/start', { kind: 'browser', back: 'https://acc.test/#/home' });
  const backs = t.env.DB.raw.prepare('SELECT back FROM google_flows ORDER BY rowid').all().map((r) => r.back);
  assert.deepEqual(backs, [null, 'https://acc.test/#/home']);
  for (let i = 0; i < 505; i++) assert.equal((await t.call('POST', '/passkeys/login/start', {})).status, 200);
  assert.ok(t.env.DB.raw.prepare('SELECT COUNT(*) n FROM passkey_challenges').get().n <= 500);
});

test('passkey: aggiungere chiede di confermare chi sei; togliere si conferma con un codice via email', async () => {
  const t = setup();
  const anna = t.addUser('anna');
  t.env.DB.raw.prepare('UPDATE users SET email = ? WHERE id = ?').run('anna@example.com', anna);
  t.env.BREVO_API_KEY = 'brevo';
  const mails = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    if (String(input.url || input) === 'https://api.brevo.com/v3/smtp/email') { mails.push(JSON.parse(init.body)); return new Response('{}'); }
    return new Response('{}', { status: 404 });
  };
  try {
    const tok = await t.login('anna', 'pwa');
    // Una sessione vecchia: prima va confermato chi sei
    t.env.DB.raw.prepare('UPDATE sessions SET created = 0').run();
    const no = await t.call('POST', '/passkeys/register/start', {}, tok);
    assert.equal(no.status, 403);
    assert.equal(no.body.reauth, true);
    assert.equal((await t.call('POST', '/passkeys/verify', { verifier: 'b'.repeat(64) }, tok)).status, 401);
    const ok = await t.call('POST', '/passkeys/verify', { verifier: VER }, tok);
    assert.equal(ok.status, 200);
    assert.ok((await t.call('GET', '/passkeys', undefined, tok)).body.verified_until > 0);
    const dev = fakeAuthenticator();
    const rs = (await t.call('POST', '/passkeys/register/start', {}, tok)).body;
    assert.equal((await t.call('POST', '/passkeys/register/finish', { ...dev.create(rs.challenge), label: 'Pixel' }, tok)).status, 200);
    assert.match(mails.at(-1).subject, /Nuova passkey/);
    // Rinominare
    assert.equal((await t.call('PATCH', '/passkeys/' + dev.id, { label: 'Pixel 9' }, tok)).body.passkey.label, 'Pixel 9');
    // Togliere: codice via email
    const rm = await t.call('POST', '/passkeys/' + dev.id + '/remove', {}, tok);
    assert.equal(rm.body.mailed, true);
    assert.equal(rm.body.to, 'an***@example.com');
    const code = /([0-9]{3}) ([0-9]{3})/.exec(mails.at(-1).subject).slice(1).join('');
    // Subito un altro: troppo presto
    assert.equal((await t.call('POST', '/passkeys/' + dev.id + '/remove', {}, tok)).status, 429);
    const wrong = code === '000000' ? '111111' : '000000';
    assert.equal((await t.call('POST', '/passkeys/' + dev.id + '/remove/confirm', { code: wrong }, tok)).status, 400);
    // Un altro account non la tocca
    t.addUser('bob');
    assert.equal((await t.call('POST', '/passkeys/' + dev.id + '/remove/confirm', { code }, await t.login('bob', 'pwa'))).status, 404);
    assert.equal((await t.call('POST', '/passkeys/' + dev.id + '/remove/confirm', { code }, tok)).body.removed, true);
    assert.match(mails.at(-1).subject, /Passkey tolta/);
    assert.equal((await t.call('GET', '/passkeys', undefined, tok)).body.passkeys.length, 0);
  } finally {
    globalThis.fetch = real;
  }
});

// ---- Verifica in due passaggi (TOTP)

function totpCode(secret, offset = 0) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, val = 0;
  const key = [];
  for (const c of secret) { val = (val << 5) | A.indexOf(c); bits += 5; if (bits >= 8) { key.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  const step = Math.floor(Date.now() / 1000 / 30) + offset;
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', Buffer.from(key)).update(msg).digest();
  const o = h[19] & 15;
  return String((((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1000000).padStart(6, '0');
}

test('2FA: si attiva con un codice giusto, poi dopo la password serve il codice (o uno di recupero)', async () => {
  const t = setup();
  t.addUser('anna');
  const tok = await t.login('anna', 'pwa');
  assert.equal((await t.call('GET', '/2fa', undefined, tok)).body.on, false);
  // Sessione vecchia: prima conferma chi sei
  t.env.DB.raw.prepare('UPDATE sessions SET created = 0').run();
  assert.equal((await t.call('POST', '/2fa/setup', {}, tok)).body.reauth, true);
  await t.call('POST', '/passkeys/verify', { verifier: VER }, tok);
  const st = (await t.call('POST', '/2fa/setup', {}, tok)).body;
  assert.match(st.uri, /^otpauth:\/\/totp\/BunkerPlex%3Aanna\?secret=[A-Z2-7]{32}&issuer=BunkerPlex/);
  assert.equal((await t.call('POST', '/2fa/enable', { code: '000000' === totpCode(st.secret) ? '111111' : '000000' }, tok)).status, 400);
  const en = (await t.call('POST', '/2fa/enable', { code: totpCode(st.secret) }, tok)).body;
  assert.equal(en.on, true);
  assert.equal(en.recovery.length, 10);
  assert.match(en.recovery[0], /^[A-Z2-9]{5}-[A-Z2-9]{5}$/);

  // Password giusta: niente gettone, serve il codice
  const first = (await t.call('POST', '/login', { username: 'anna', verifier: VER, device: 'PC', kind: 'pwa' })).body;
  assert.equal(first.need_2fa, true);
  assert.equal(first.token, undefined);
  // Lo stesso codice usato per attivare non vale di nuovo; uno sbagliato conta un tentativo
  assert.equal((await t.call('POST', '/login/2fa', { ticket: first.ticket, code: totpCode(st.secret) })).status, 401);
  const ok = await t.call('POST', '/login/2fa', { ticket: first.ticket, code: totpCode(st.secret, 1) });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.user.totp, true);
  // Il biglietto vale una volta
  assert.equal((await t.call('POST', '/login/2fa', { ticket: first.ticket, code: en.recovery[0] })).status, 401);

  // Codice di recupero: una volta sola
  const second = (await t.call('POST', '/login', { username: 'anna', verifier: VER })).body;
  assert.equal((await t.call('POST', '/login/2fa', { ticket: second.ticket, code: en.recovery[0].toLowerCase() })).status, 200);
  const third = (await t.call('POST', '/login', { username: 'anna', verifier: VER })).body;
  assert.equal((await t.call('POST', '/login/2fa', { ticket: third.ticket, code: en.recovery[0] })).status, 401);
  assert.equal((await t.call('GET', '/2fa', undefined, ok.body.token)).body.recovery_left, 9);

  // Troppi tentativi: il biglietto non vale piu'
  for (let i = 0; i < 5; i++) await t.call('POST', '/login/2fa', { ticket: third.ticket, code: '999999' });
  assert.equal((await t.call('POST', '/login/2fa', { ticket: third.ticket, code: en.recovery[1] })).status, 401);

  // Disattivare: conferma + codice
  const tok2 = ok.body.token;
  assert.equal((await t.call('POST', '/2fa/disable', { code: '123' }, tok2)).status, 400);
  assert.equal((await t.call('POST', '/2fa/disable', { code: en.recovery[2] }, tok2)).body.on, false);
  assert.ok((await t.call('POST', '/login', { username: 'anna', verifier: VER })).body.token);
});

test('passkey: conferma chi sei con una passkey del tuo account (non con quella di un altro)', async () => {
  const t = setup();
  t.addUser('anna');
  t.addUser('bob');
  const tok = await t.login('anna', 'pwa');
  const dev = fakeAuthenticator();
  const rs = (await t.call('POST', '/passkeys/register/start', {}, tok)).body;
  await t.call('POST', '/passkeys/register/finish', dev.create(rs.challenge), tok);
  t.env.DB.raw.prepare('UPDATE sessions SET created = 0').run();
  const vs = (await t.call('POST', '/passkeys/verify/start', {}, tok)).body;
  assert.deepEqual(vs.allow, [dev.id]);
  // Una sfida di login (senza account) non vale per confermare
  const ls = (await t.call('POST', '/passkeys/login/start', {})).body;
  assert.equal((await t.call('POST', '/passkeys/verify', dev.get(ls.challenge), tok)).status, 400);
  assert.equal((await t.call('POST', '/passkeys/verify', dev.get(vs.challenge), tok)).status, 200);
  // Bob non ha passkey
  assert.equal((await t.call('POST', '/passkeys/verify/start', {}, await t.login('bob', 'pwa'))).status, 404);
});

test('2FA: «Ricorda questo dispositivo» salta il codice per quell’account, finche’ non si cambia la password', async () => {
  const t = setup();
  t.addUser('anna');
  t.addUser('bob');
  const tok = await t.login('anna', 'pwa');
  const st = (await t.call('POST', '/2fa/setup', {}, tok)).body;
  await t.call('POST', '/2fa/enable', { code: totpCode(st.secret) }, tok);
  const first = (await t.call('POST', '/login', { username: 'anna', verifier: VER })).body;
  const ok = (await t.call('POST', '/login/2fa', { ticket: first.ticket, code: totpCode(st.secret, 1), remember: true, device: 'Pixel' })).body;
  assert.match(ok.trust, /^[0-9a-f]{64}$/);
  // Con il gettone: niente codice
  assert.ok((await t.call('POST', '/login', { username: 'anna', verifier: VER, trust: ok.trust })).body.token);
  assert.equal((await t.call('GET', '/2fa', undefined, ok.token)).body.trusted, 1);
  // Gettone inventato: serve il codice
  assert.equal((await t.call('POST', '/login', { username: 'anna', verifier: VER, trust: 'f'.repeat(64) })).body.need_2fa, true);
  // Password nuova: il dispositivo non e' piu' ricordato
  assert.equal((await t.call('POST', '/password', { verifier: VER, new_verifier: 'c'.repeat(64) }, ok.token)).status, 200);
  assert.equal((await t.call('POST', '/login', { username: 'anna', verifier: 'c'.repeat(64), trust: ok.trust })).body.need_2fa, true);
});

// ---- Aggiornamento dell'app Android: notifica a tutti i telefoni (topic FCM)

function fakeAppReleases(net) {
  const gh = { tags: ['app-v3.9', 'app-v3.14', 'app-v3.14.1', 'tv-v1.15', 'v3.42'], codes: { 'app-v3.14.1': 29900000, 'app-v3.14': 29890000 },
    noAssets: new Set(), calls: 0 };
  const api = 'https://api.github.com/repos/xFra96/bunkerplex/';
  const fetch = async (input, init = {}) => {
    const url = String(input.url || input);
    if (url.startsWith(api)) {
      gh.calls++;
      const path = url.slice(api.length);
      if (path === 'git/matching-refs/tags/app-v') {
        return new Response(JSON.stringify(gh.tags.filter((t) => t.startsWith('app-v')).map((t) => ({ ref: 'refs/tags/' + t }))));
      }
      let m = path.match(/^releases\/tags\/(.+)$/);
      if (m) {
        const tag = m[1];
        if (!gh.codes[tag]) return new Response('{}', { status: 404 });
        const id = gh.codes[tag];
        const assets = gh.noAssets.has(tag) ? [] : [{ id: id, name: 'BunkerPlex.json' }, { id: id + 1, name: 'BunkerPlex.apk' }];
        return new Response(JSON.stringify({ tag_name: tag, draft: false, prerelease: false, assets }));
      }
      m = path.match(/^releases\/assets\/(\d+)$/);
      if (m) {
        assert.equal(init.headers.Accept, 'application/octet-stream');
        return new Response(null, { status: 302, headers: { Location: 'https://objects.test/asset/' + m[1] } });
      }
      return new Response('{}', { status: 404 });
    }
    let m = url.match(/^https:\/\/objects\.test\/asset\/(\d+)$/);
    if (m) {
      const tag = Object.keys(gh.codes).find((t) => gh.codes[t] === Number(m[1]));
      return new Response(JSON.stringify({ version: tag.slice(5), code: gh.codes[tag], min_server_api: 1 }));
    }
    return net.fetch(input, init);
  };
  return { gh, fetch };
}

test("aggiornamento dell'app: un avviso FCM al topic, una volta per versione", async () => {
  const t = setup();
  const net = fakeFcm();
  const fake = fakeAppReleases(net);
  const again = () => t.env.DB.raw.prepare("UPDATE kv SET v = '0' WHERE k = 'app_update_at'").run();

  // Senza FCM configurato non si chiede niente a GitHub
  const off = await withNet(fake, () => t.call('POST', '/app-update'));
  assert.deepEqual([off.status, off.body.sent, fake.gh.calls], [200, false, 0]);

  t.env.FCM_SERVICE_ACCOUNT = JSON.stringify(net.sa);
  const r = await withNet(fake, () => t.call('POST', '/app-update'));
  assert.deepEqual(r.body, { sent: true, version: '3.14.1', code: 29900000 });
  assert.equal(net.st.sent.length, 1);
  const m = net.st.sent[0];
  assert.equal(m.topic, 'app-update');
  assert.equal(m.token, undefined);
  assert.equal(m.android.priority, 'high');
  assert.equal(m.notification, undefined, "messaggio data: la notifica la fa l'app");
  assert.deepEqual([m.data.kind, m.data.code, m.data.name], ['app_update', '29900000', '3.14.1']);

  // Subito dopo: si aspetta (niente giri su GitHub a raffica)
  const calls = fake.gh.calls;
  const busy = await withNet(fake, () => t.call('POST', '/app-update'));
  assert.equal(busy.body.sent, false);
  assert.equal(fake.gh.calls, calls);

  // Stessa versione: nessun secondo avviso
  again();
  const same = await withNet(fake, () => t.call('POST', '/app-update'));
  assert.deepEqual([same.body.sent, net.st.sent.length], [false, 1]);

  // Release nuova ma senza allegati ancora: resta la precedente, niente avviso
  fake.gh.tags.push('app-v3.15');
  fake.gh.codes['app-v3.15'] = 29950000;
  fake.gh.noAssets.add('app-v3.15');
  again();
  assert.equal((await withNet(fake, () => t.call('POST', '/app-update'))).body.sent, false);

  // FCM non risponde: la versione non si segna, al giro dopo si riprova
  fake.gh.noAssets.delete('app-v3.15');
  net.st.reply = () => new Response('{}', { status: 503 });
  again();
  assert.equal((await withNet(fake, () => t.call('POST', '/app-update'))).body.sent, false);
  net.st.reply = () => new Response(JSON.stringify({ name: 'projects/bp-test/messages/2' }));
  again();
  // Il cron orario (non quello di Brevo) fa lo stesso controllo
  await withNet(fake, () => worker.scheduled({ cron: '17 * * * *' }, t.env));
  const last = net.st.sent[net.st.sent.length - 1];
  assert.deepEqual([last.topic, last.data.code, last.data.name], ['app-update', '29950000', '3.15']);
  assert.equal(t.env.DB.raw.prepare("SELECT v FROM kv WHERE k = 'app_update'").get().v, '29950000');

  // Il cron settimanale di Brevo non manda avvisi
  const before = net.st.sent.length;
  again();
  await withNet(fake, () => worker.scheduled({ cron: '0 6 * * 1' }, t.env));
  assert.equal(net.st.sent.length, before);
});

test('il server collegato con il codice manda gli avvisi al telefono del proprietario', async () => {
  const t = await twoFriends();
  const annaPc = await t.login('anna', 'server', 'PC di Anna');
  const cred = (await t.call('POST', `/servers/${SID}/claim`, { name: 'PC Anna' }, annaPc)).body.credential;
  const net = fakeFcm();
  t.env.FCM_SERVICE_ACCOUNT = JSON.stringify(net.sa);
  const anna = await noticeDev(t, 'anna');
  await t.call('POST', `/avvisi/${anna.dev}/fcm`, { token: FCM_TOK });

  const r = await withNet(net, () => t.call('POST', '/notices',
    { kind: 'update', title: 'BunkerPlex aggiornato', body: 'PC Anna è passato alla versione 3.42.4.' }, cred));
  assert.deepEqual([r.status, r.body.sent], [200, 1]);
  const m = net.st.sent[net.st.sent.length - 1];
  assert.deepEqual([m.token, m.data.title], [FCM_TOK, 'BunkerPlex aggiornato']);
  const list = await t.call('GET', '/notices', undefined, cred);
  assert.equal(list.status, 200);
  assert.equal(list.body.notices[0].title, 'BunkerPlex aggiornato');
  // Il resto dell'account resta fuori dalla credenziale del server
  assert.equal((await t.call('POST', '/notices/devices', { kind: 'android', label: 'x' }, cred)).status, 403);
});

test('la release annunciata da GitHub arriva ai server nella presenza', async () => {
  const t = await twoFriends();
  const cred = (await t.call('POST', `/servers/${SID}/claim`, { name: 'PC' }, await t.login('anna', 'server'))).body.credential;
  const C = 'ab12'.repeat(10);
  // Senza RELEASE_KEY non si annuncia niente
  assert.equal((await t.call('POST', '/release', { commit: C, version: 'v3.43' }, 'x'.repeat(32))).status, 401);
  t.env.RELEASE_KEY = 'r'.repeat(40);
  assert.equal((await t.call('POST', '/release', { commit: C, version: 'v3.43' }, 'x'.repeat(40))).status, 401);
  assert.equal((await t.call('POST', '/release', { commit: C, version: 'v3.43' }, cred)).status, 401);
  assert.equal((await t.call('POST', '/release', { commit: 'zz', version: '3.43' }, t.env.RELEASE_KEY)).status, 400);
  let hb = await t.call('POST', '/server/heartbeat', { name: 'PC', pin: PIN }, cred);
  assert.equal(hb.body.release, null);
  assert.equal((await t.call('POST', '/release', { commit: C, version: 'v3.43' }, t.env.RELEASE_KEY)).status, 200);
  hb = await t.call('POST', '/server/heartbeat', { name: 'PC', pin: PIN }, cred);
  assert.deepEqual([hb.body.release.commit, hb.body.release.version], [C, '3.43']);
  assert.equal((await t.call('GET', '/release')).body.release.commit, C);
});

test('TV Samsung: il DUID aspetta, chi amministra entra in Samsung, GitHub fa il certificato', async () => {
  const t = setup();
  t.env.RELEASE_KEY = 'r'.repeat(32);
  const anna = t.addUser('anna');
  t.addUser('bob');
  t.env.DB.raw.prepare('UPDATE users SET admin = 1 WHERE id = ?').run(anna);
  const gh = (method, b) => t.call(method, '/samsung/job', b, t.env.RELEASE_KEY);
  const DUID = 'ABCDEFGHIJKLMNOP1234';
  assert.deepEqual((await t.call('GET', '/samsung/tv/' + DUID)).body, { state: 'unknown' });
  // Senza account non si aggiunge, con un DUID strano neanche
  assert.equal((await t.call('POST', '/samsung/tv', { duid: DUID })).status, 401);
  const bob = await t.login('bob', 'pwa');
  assert.equal((await t.call('POST', '/samsung/tv', { duid: 'x y' }, bob)).status, 400);
  const add = await t.call('POST', '/samsung/tv', { duid: DUID, model: 'QE55', name: 'Salotto' }, bob);
  assert.equal(add.body.state, 'waiting');
  assert.equal(add.body.login, true);
  // Chi amministra lo sa (avviso), gli altri non vedono il pannello
  const n = t.env.DB.raw.prepare("SELECT COUNT(*) n FROM notices WHERE user_id = ? AND kind = 'samsung'").get(anna).n;
  assert.equal(Number(n), 1);
  assert.equal((await t.call('GET', '/samsung/admin', undefined, bob)).status, 403);
  // GitHub: c'e' da fare ma niente gettone
  assert.equal((await t.call('GET', '/samsung/job')).status, 401);
  let job = (await gh('GET')).body;
  assert.equal(job.need, true);
  assert.equal(job.token, null);
  // Chi amministra entra in Samsung dal telefono
  const admin = await t.login('anna', 'pwa');
  assert.equal((await t.call('POST', '/samsung/login', { code: '{"nope":1}' }, admin)).status, 400);
  const code = JSON.stringify({ access_token: 'tok', userId: 'u1', inputEmailID: 'a%40b.it', access_token_expires_in: '86400' });
  assert.equal((await t.call('POST', '/samsung/login', { code }, admin)).body.ok, true);
  assert.equal((await t.call('POST', '/samsung/login', { code }, bob)).status, 403);
  job = (await gh('GET')).body;
  assert.deepEqual(job.duids, [DUID]);
  assert.deepEqual(job.token, { access_token: 'tok', user_id: 'u1', email: 'a@b.it' });
  // Gettone scaduto per Samsung: si butta e chi amministra viene avvisato
  await gh('POST', { error: 'token', detail: 'expired' });
  assert.equal((await gh('GET')).body.token, null);
  assert.equal((await t.call('GET', '/samsung/admin', undefined, admin)).body.login, null);
  await t.call('POST', '/samsung/login', { code }, admin);
  // Fatto: la TV e' nel certificato, i .p12 restano al servizio
  await gh('POST', { listed: [DUID, 'bad!'], keys: { author: 'QQ==', distributor: 'Qg==' }, version: '1.0.2',
    author_until: 2e9, distributor_until: 1.9e9 });
  assert.deepEqual((await t.call('GET', '/samsung/tv/' + DUID)).body, { state: 'ready', version: '1.0.2' });
  job = (await gh('GET')).body;
  assert.equal(job.need, false);
  assert.equal(job.token, null);
  assert.deepEqual(job.keys, { author: 'QQ==', distributor: 'Qg==' });
  const st = (await t.call('GET', '/samsung/admin', undefined, admin)).body;
  assert.equal(st.cert.tvs, 1);
  assert.equal(st.tvs[0].who, 'bob');
  assert.equal(st.tvs[0].ready, true);
  // Una TV nuova: di nuovo da fare, la prima resta
  await t.call('POST', '/samsung/tv', { duid: 'ZZZZZZZZZZ1111' }, bob);
  job = (await gh('GET')).body;
  assert.equal(job.need, true);
  assert.deepEqual(job.duids, [DUID, 'ZZZZZZZZZZ1111']);
});
