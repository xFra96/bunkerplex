// Prove del servizio account con un database D1 finto (SQLite di Node).
// Avvio: node --test cloud/test_worker.mjs   (Node 22.5 o piu' recente)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';

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
  t.env.DB.raw.prepare("INSERT INTO servers(user_id, sid, name, url, pin, t, friends) VALUES(?, ?, 'PC Anna', 'https://x', ?, 0, 1)")
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

test('la TV entra dal telefono: codice, conferma con l\'account, gettone una volta sola', async () => {
  const t = setup();
  t.addUser('anna');
  t.addUser('bob');
  const start = await t.call('POST', '/tv/start', { device: 'TV Sony' });
  assert.equal(start.status, 200);
  const { code, poll } = start.body;
  assert.match(code, /^[A-Z2-9]{8}$/);
  assert.equal(start.body.url, 'https://acc.test/#/tv/' + code);
  assert.deepEqual((await t.call('POST', '/tv/poll', { poll })).body, { done: false });
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
