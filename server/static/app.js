/* BunkerPlex - interfaccia. Pensata per il telecomando (frecce + OK + Indietro)
   ma funziona anche con mouse e tastiera dal PC. */
(function () {
'use strict';

var view = document.getElementById('view');
var rail = document.getElementById('rail');
var modal = document.getElementById('modal');
var toastEl = document.getElementById('toast');
// L'app Android TV. Quella installata prima del cambio di nome in BunkerPlex
// (un'altra app per Android) si presenta col nome vecchio: funziona ancora, ma
// non puo' aggiornarsi da sola alla nuova e le si chiede di sostituirla.
var tvApp = window.BunkerPlexTV || window.FrancoPlexTV || null;
var OLD_TV_APP = !!tvApp && !window.BunkerPlexTV;
var TV = !!tvApp;                    // true dentro l'app Android TV
var kb = TV;                         // l'ultimo comando e' arrivato da tasti/telecomando
var focusMemory = {};                // pagina -> ultimo elemento selezionato
var scrollMemory = {};
var currentHash = '';
var renderToken = 0;
var player = null;
var modalState = null;
var cache = { pendingPlay: null, searchQuery: '', homeScroll: 0, navLib: null };
var scanWatch = true;
var libs = [];                       // le raccolte: [{id, name, movies, shows, folders}]
var libsLoadedAt = 0;
var friends = [];                    // gli amici collegati: [{n, name, online, error, libraries}]
var friendQuality = '720';           // come arrivano i video degli amici: 720, 1080, orig
var shareRequests = 0;               // richieste di condivisione ancora da guardare
var railSignature = '';
var stageMap = null;                 // Home: scheda -> dati per l'anteprima grande
var stageKey = '';
var stageTimer = 0;
var stageFlip = false;
var lastAutoRefresh = Date.now();
var cardData = {};                   // scheda -> dati del titolo (per il menu delle azioni)
var press = null;                    // OK tenuto premuto su una scheda
var chunk = null;                    // griglia lunga: le locandine si aggiungono un po' alla volta
var lastHtml = '';                   // l'ultima pagina disegnata
var enterTimer = 0;

// Icone disegnate (non caratteri speciali: su certe TV diventano emoji colorate)
var IC = {
  play: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.2v15.6L20.5 12z"/></svg>',
  pause: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4.5h4.2v15H6zM13.8 4.5H18v15h-4.2z"/></svg>',
  check: '<svg class="ic line" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  plus: '<svg class="ic line" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  dots: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
  back: '<svg class="ic line" viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5M11 6l-6 6 6 6"/></svg>',
  next: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4.5v15l10.5-7.5zM17 4.5h2.5v15H17z"/></svg>',
  vol: '<svg class="ic line" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5zM16 9a4.2 4.2 0 0 1 0 6M18.6 6.4a8 8 0 0 1 0 11.2"/></svg>',
  mute: '<svg class="ic line" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5zM16 9.5l5 5M21 9.5l-5 5"/></svg>',
  disk: '<svg class="ic line" viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="6" width="17" height="12" rx="2"/><path d="M7 14.5h4"/></svg>',
  folder: '<svg class="ic line" viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7v11h17V9h-8l-2-2z"/></svg>',
  bell: '<svg class="ic line" viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 1.5H5zM10 20.5h4"/></svg>'
};
var MORE = '<span class="more" data-menu title="Azioni">' + IC.dots + '</span>';
var HINT = 'OK apre · tieni premuto OK per le altre azioni · freccia sinistra per il menu';

// Preferenze di questo dispositivo (TV, telefono, PC): ognuno ha le sue
function devicePrefs() {
  try { return JSON.parse(localStorage.getItem('fpDevice')) || {}; } catch (e) { return {}; }
}
function saveDevicePrefs(p) {
  try { localStorage.setItem('fpDevice', JSON.stringify(p)); } catch (e) { /* niente */ }
  pushPrefs();
}

// ---------------------------------------------------------------- Profili e account
// Si entra in un profilo di questo PC («Chi guarda?»; con un solo profilo si entra
// da soli), senza password e anche senza Internet. Il login e' facoltativo: collega
// il profilo a un account, che lo porta su ogni PC e sblocca la condivisione.
// Le preferenze di visione seguono il profilo su ogni dispositivo, tranne cio' che
// dipende dal dispositivo stesso (lento o no, aspetto da TV).
var auth = null;                     // {on, cloud, user, profiles, offline, setup}
var LOCAL_ONLY = ['slow', 'tv'];             // dipendono dal dispositivo
var PLAYER_LOCAL = ['volume', 'muted'];      // il volume di una TV non va sul PC
var prefsTimer = 0;
var conflicts = null;                // primo accesso: impostazioni di qui diverse da quelle dell'account

function loadAuth() {
  return api('/auth/state').then(function (a) { auth = a; return a; }, function () { auth = { on: false }; return auth; });
}

function without(obj, keys) {
  var out = {};
  Object.keys(obj || {}).forEach(function (k) { if (keys.indexOf(k) < 0 && obj[k] !== undefined && obj[k] !== '') out[k] = obj[k]; });
  return out;
}

function sharedPrefs() {
  return { device: without(device, LOCAL_ONLY), player: without(playerPrefs(), PLAYER_LOCAL) };
}

function sendPrefs() {
  return post('/me/prefs', sharedPrefs()).catch(function () {});
}

function pushPrefs() {
  if (!auth || !auth.user || conflicts) return;
  clearTimeout(prefsTimer);
  prefsTimer = setTimeout(sendPrefs, 1200);
}

// Le preferenze dell'account prendono il posto di quelle di questo dispositivo
function applyPrefs(p) {
  if (p.device && Object.keys(p.device).length) {
    var dev = without(p.device, LOCAL_ONLY);
    LOCAL_ONLY.forEach(function (k) { if (device[k] !== undefined) dev[k] = device[k]; });
    device = dev;
    try { localStorage.setItem('fpDevice', JSON.stringify(device)); } catch (e) { /* niente */ }
    applyDevice();
  }
  if (p.player && Object.keys(p.player).length) {
    var pl = without(p.player, PLAYER_LOCAL), mine = playerPrefs();
    PLAYER_LOCAL.forEach(function (k) { if (mine[k] !== undefined) pl[k] = mine[k]; });
    try { localStorage.setItem('fpPlayer', JSON.stringify(pl)); } catch (e) { /* niente */ }
  }
}

function pullPrefs() {
  return api('/me/prefs').then(applyPrefs).catch(function () {});
}

function sorted(o) {
  return JSON.stringify(Object.keys(o || {}).sort().map(function (k) { return [k, o[k]]; }));
}

var PREF_LABELS = { anim: 'animazioni', posters: 'locandine', subsize: 'sottotitoli', fit: 'formato', step: 'salti', autoplay: 'episodio successivo', oslang: 'lingua dei sottotitoli' };
function prefsSummary(p) {
  var parts = [];
  [p.device || {}, p.player || {}].forEach(function (o) {
    Object.keys(o).sort().forEach(function (k) {
      var v = o[k];
      if (k === 'anim') v = labelOf(ANIMS, v);
      else if (k === 'posters') v = labelOf(POSTERS, v);
      else if (k === 'subsize') v = labelOf(SUB_SIZES, v);
      else if (k === 'fit') v = labelOf(FITS, v).split(' (')[0];
      else if (typeof v === 'boolean') v = v ? 'sì' : 'no';
      parts.push((PREF_LABELS[k] || k) + ' ' + String(v).toLowerCase());
    });
  });
  return parts.join(', ') || 'nessuna';
}

function seenAccount() {
  try { return localStorage.getItem('fpAccount') || ''; } catch (e) { return ''; }
}
function markAccount() {
  try { localStorage.setItem('fpAccount', String(auth.user.id)); } catch (e) { /* niente */ }
}

// Al primo accesso da questo dispositivo: se le sue preferenze sono diverse da quelle
// dell'account si chiede quali tenere; altrimenti valgono quelle dell'account.
function checkPrefs() {
  return api('/me/prefs').then(function (remote) {
    remote = { device: without(remote.device, LOCAL_ONLY), player: without(remote.player, PLAYER_LOCAL) };
    var local = sharedPrefs();
    var localEmpty = !Object.keys(local.device).length && !Object.keys(local.player).length;
    var remoteEmpty = !Object.keys(remote.device).length && !Object.keys(remote.player).length;
    var first = seenAccount() !== String(auth.user.id);
    if (remoteEmpty) { markAccount(); if (!localEmpty) sendPrefs(); return null; }
    // Profilo senza account: valgono le sue, senza domande
    if (!first || localEmpty || !auth.user.linked) { applyPrefs(remote); markAccount(); return null; }
    if (sorted(local.device) === sorted(remote.device) && sorted(local.player) === sorted(remote.player)) { markAccount(); return null; }
    cache.remotePrefs = remote;
    return { key: 'prefs', label: 'Preferenze di visione (animazioni, locandine, player)',
      local: prefsSummary(local), cloud: prefsSummary(remote) };
  }).catch(function () { return null; });
}

// Dopo l'accesso: impostazioni del server da confrontare (r.conflicts) e preferenze di questo dispositivo
function afterLogin(serverConflicts) {
  return checkPrefs().then(function (pref) {
    var list = (serverConflicts || []).slice();
    if (pref) list.push(pref);
    conflicts = list.length ? list : null;
  });
}

function conflictsPage() {
  return '<div class="page"><div class="panel login wide"><h1>Impostazioni diverse</h1>' +
    '<p>Qui ci sono impostazioni diverse da quelle salvate nel tuo account. Quali vuoi tenere?</p>' +
    '<div class="lib">' + conflicts.map(function (c) {
      return '<div class="folder"><div class="where"><b>' + esc(c.label) + '</b><small>Questo ' + (TV ? 'dispositivo' : 'PC') + ': ' + esc(c.local) +
        '<br>Account: ' + esc(c.cloud) + '</small></div></div>';
    }).join('') + '</div>' +
    '<div class="actions"><button class="btn primary f" data-autofocus data-act="resolve" data-arg="cloud" data-key="keepcloud">Usa quelle dell\'account</button>' +
    '<button class="btn f" data-act="resolve" data-arg="local" data-key="keeplocal">Tieni quelle di qui (sovrascrivi l\'account)</button></div>' +
    '<p style="margin-top:1rem">Le impostazioni che non scegli vengono sostituite.</p></div></div>';
}

function lockScreen(on) {
  document.body.classList.toggle('locked', on);
}

function devName() { return TV ? 'tv' : 'browser'; }

// Il modulo per entrare con un account (o per creare l'amministratore, la prima volta)
function accountForm(name, fixed) {
  if (auth.setup) {
    return '<p>Sul servizio account non c\'è ancora nessuno: crea l\'account <b>amministratore</b>, è il tuo. ' +
      'Con questo poi crei quelli degli altri, con una password provvisoria da cambiare al primo accesso.</p>' +
      '<input class="field f" style="margin-bottom:.6rem" id="lname" data-key="lname" autocomplete="username" maxlength="32" placeholder="Nome utente (lettere, numeri, . - _)">' +
      '<input class="field f" style="margin-bottom:.6rem" id="lpass" data-key="lpass" type="password" autocomplete="new-password" placeholder="Password (almeno 8 caratteri)">' +
      '<input class="field f" id="lpass2" data-key="lpass2" type="password" autocomplete="new-password" data-enter="setup" placeholder="Ripeti la password">' +
      '<div class="actions"><button class="btn primary f" data-act="setup" data-key="setup">Crea l\'account</button></div>';
  }
  return (fixed ? '<input type="hidden" id="lname" value="' + esc(name) + '">'
      : '<input class="field f" style="margin-bottom:.6rem" id="lname" data-key="lname" autocomplete="username" maxlength="32" placeholder="Nome utente" value="' + esc(name || '') + '">') +
    '<input class="field f" id="lpass" data-key="lpass" type="password" autocomplete="current-password" data-enter="login"' + (fixed ? ' data-autofocus' : '') + ' placeholder="Password">' +
    '<div class="actions"><button class="btn primary f" data-act="login" data-key="login">Entra</button></div>';
}

// «Chi guarda?»: i profili di questo PC. Si entra senza password (tranne gli account
// che l'hanno chiesta); da qui si crea un profilo nuovo o si entra con un account.
function profilesPage() {
  var a = auth, mode = cache.whoMode || '';
  var list = (a.profiles || []).map(function (p, n) {
    return '<button class="profile f"' + (n === 0 && !mode ? ' data-autofocus' : '') + ' data-act="profile" data-arg="' + p.id + '" data-key="prof-' + p.id + '">' +
      face(p.name, 'big') + '<span>' + esc(p.name) + '</span></button>';
  }).join('');
  var body = '';
  if (mode === 'new') {
    body = '<h2>Nuovo profilo</h2><p>Visti, punti di ripresa, lista e raccolte suoi. Niente password, niente Internet: ' +
      'se poi vuoi, lo colleghi a un account da Impostazioni → Account.</p>' +
      '<div class="inline"><input class="field f" id="pname" data-key="pname" data-autofocus data-enter="newprofile" autocomplete="off" maxlength="24" placeholder="Il nome">' +
      '<button class="btn primary f" data-act="newprofile" data-key="newprofile">Crea ed entra</button></div>';
  } else if (mode === 'login') {
    body = '<h2>Entra con un account</h2><p>Impostazioni, chiavi, visti e lista ti seguono su ogni PC e TV. ' +
      'Se l\'account su questo PC non c\'è ancora, nasce un profilo nuovo.</p>' + accountForm('', false);
  } else if (/^pw:/.test(mode)) {
    var p = (a.profiles || []).filter(function (x) { return String(x.id) === mode.slice(3); })[0];
    if (p) body = '<h2>Password di ' + esc(p.name) + '</h2><p>Questo profilo si apre con la password del suo account.</p>' + accountForm(p.name, true);
  }
  var more = '<div class="actions" style="margin-top:1.4rem">' +
    '<button class="btn f" data-act="whomode" data-arg="new" data-key="who-new">Nuovo profilo</button>' +
    (a.cloud ? (TV ? '<a class="btn f" href="#/tvlogin" data-key="who-phone">Entra con un account dal telefono</a>' : '') +
      '<button class="btn f" data-act="whomode" data-arg="login" data-key="who-login">' + (TV ? 'Scrivi nome e password' : 'Entra con un account') + '</button>' : '') +
    (TV ? '<button class="btn f" data-act="resetserver" data-key="resetserver">Cambia server</button>' : '') + '</div>';
  return '<div class="page"><div class="panel login wide"><h1>Chi guarda?</h1>' +
    '<div class="profiles">' + list + '</div>' + (body ? '<div style="margin-top:1.4rem">' + body + '</div>' : '') + more + '</div></div>';
}

// Sulla TV: si entra con un account scrivendo nome e password sul telefono.
// La TV mostra un codice (e il suo QR) e intanto chiede al server se il telefono ha finito.
async function tvLoginPage() {
  var p = cache.pair;
  if (!p || Date.now() - p.at > (p.ttl - 60) * 1000) {
    p = await post('/auth/pair');
    p.at = Date.now();
    cache.pair = p;
  }
  clearInterval(cache.pairTimer);
  cache.pairTimer = setInterval(function () {
    if (location.hash !== '#/tvlogin') { clearInterval(cache.pairTimer); return; }
    api('/auth/pair/' + p.code).then(function (r) {
      if (!r.done) return;
      clearInterval(cache.pairTimer);
      cache.pair = null;
      toast('Entrato come ' + r.user.name);
      enterApp(r);
    }, function () { clearInterval(cache.pairTimer); cache.pair = null; render(); });   // scaduto: codice nuovo
  }, 2000);
  var inside = auth && auth.user;
  var where = p.url ? '<p>Oppure apri dal telefono questo indirizzo:</p><p class="apkurl num">' + esc(p.url) + '</p>' : '';
  return '<div class="page"><div class="panel login wide"><h1>Entra dal telefono</h1>' +
    '<div class="apkqr">' + (p.svg ? '<div class="qrtile" role="img" aria-label="Codice QR per entrare dal telefono">' + p.svg + '</div>' : '') +
    '<div class="apktext"><p>Inquadra il QR con la fotocamera del telefono (collegato alla rete di casa) e scrivi lì nome e password del tuo account: la TV entra da sola.</p>' + where +
    '<p style="margin-bottom:0"><small>Codice della TV, lo ritrovi sul telefono:</small></p>' +
    '<p class="paircode num">' + esc(p.code.slice(0, 3) + ' ' + p.code.slice(3)) + '</p>' +
    '<p><small>' + (inside ? 'Questo profilo diventa il tuo account: visti, lista e raccolte di qui si uniscono a quelli dell\'account.'
      : 'Se hai già usato il tuo account su questo PC non serve: torna indietro e scegli il tuo nome in «Chi guarda?».') + '</small></p>' +
    '<div class="actions"><a class="btn f" data-autofocus href="' + (inside ? '#/settings/account' : '#/home') + '" data-key="pairback">Indietro</a></div></div></div></div></div>';
}

// Sul telefono: la pagina che apre il QR della TV
function phonePairPage(code) {
  var done = cache.pairDone && cache.pairDone.code === code ? cache.pairDone.name : '';
  if (done) {
    return '<div class="page"><div class="panel login"><h1>Fatto</h1><p>La TV sta entrando come <b>' + esc(done) + '</b>. Puoi chiudere questa pagina.</p>' +
      '<div class="actions"><a class="btn f" href="#/home" data-key="pairhome">Apri BunkerPlex qui</a></div></div></div>';
  }
  var needNew = cache.pairNeedNew === code;
  return '<div class="page"><div class="panel login"><h1>Entra sulla TV</h1>' +
    '<p>Scrivi nome e password del tuo account: la TV entra da sola. Codice della TV: <b class="num">' + esc(code) + '</b></p>' +
    '<input class="field f" style="margin-bottom:.6rem" id="lname" data-key="lname" data-autofocus autocomplete="username" maxlength="32" placeholder="Nome utente" value="' + esc(fieldValue('lname')) + '">' +
    '<input class="field f" style="margin-bottom:.6rem" id="lpass" data-key="lpass" type="password" autocomplete="current-password"' + (needNew ? '' : ' data-enter="pairsend"') + ' placeholder="' + (needNew ? 'Password provvisoria' : 'Password') + '" value="' + esc(fieldValue('lpass')) + '">' +
    (needNew ? '<p>La password è provvisoria: scegline una tua, varrà su tutti i PC e le TV.</p>' +
      '<input class="field f" style="margin-bottom:.6rem" id="pnew" data-key="pnew" type="password" autocomplete="new-password" placeholder="Password nuova (almeno 8 caratteri)">' +
      '<input class="field f" id="pnew2" data-key="pnew2" type="password" autocomplete="new-password" data-enter="pairsend" placeholder="Ripeti la password nuova">' : '') +
    '<div class="actions"><button class="btn primary f" data-act="pairsend" data-arg="' + esc(code) + '" data-key="pairsend">Entra sulla TV</button></div>' +
    '<p style="margin-top:1rem"><small>Il tuo account è già su questo PC? Allora sulla TV basta sceglierlo in «Chi guarda?».</small></p></div></div>';
}

function passwordPage(forced) {
  return '<div class="page"><div class="panel login"><h1>' + (forced ? 'Scegli la tua password' : 'Cambia password') + '</h1>' +
    (forced ? '<p>Il tuo account ha una password provvisoria. Scegline una tua: varrà su tutti i PC e le TV. Finché non lo fai il profilo funziona, ma non si sincronizza.</p>'
      : '<p>Gli altri PC dove sei entrato ti chiederanno la password nuova.</p>') +
    '<input class="field f" style="margin-bottom:.6rem" id="pold" data-key="pold" data-autofocus type="password" autocomplete="current-password" placeholder="' + (forced ? 'Password provvisoria' : 'Password attuale') + '">' +
    '<input class="field f" style="margin-bottom:.6rem" id="pnew" data-key="pnew" type="password" autocomplete="new-password" placeholder="Password nuova (almeno 8 caratteri)">' +
    '<input class="field f" id="pnew2" data-key="pnew2" type="password" autocomplete="new-password" data-enter="changepw" placeholder="Ripeti la password nuova">' +
    '<div class="actions"><button class="btn primary f" data-act="changepw" data-arg="' + (forced ? '1' : '') + '" data-key="changepw">Salva</button>' +
    (forced ? '<button class="btn f" data-act="pwlater" data-key="pwlater">Più tardi</button>' : '<button class="btn f" data-act="goback" data-key="cancel">Annulla</button>') +
    '</div></div></div>';
}

function pwLater() {
  try { return sessionStorage.getItem('fpPwLater') === '1'; } catch (e) { return false; }
}

function whenDate(sec) {
  if (!sec) return 'mai';
  var d = new Date(sec * 1000);
  return d.toLocaleDateString('it-IT') + ' alle ' + d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
}

// Segnale fisso in basso: profilo con account, ma il servizio non si raggiunge
function markOffline() {
  var on = !!(auth && auth.user && auth.user.linked && auth.offline);
  var el = document.getElementById('offpill');
  if (on && !el) {
    el = document.createElement('div');
    el.id = 'offpill';
    document.body.appendChild(el);
  }
  if (el) {
    el.hidden = !on;
    el.textContent = 'Offline · si sincronizza quando torna la rete';
  }
}

var device = devicePrefs();
// Aspetto da TV: dentro l'app, oppure scelto a mano per il browser di una smart TV (o con ?tv=1)
var TVLOOK = TV || device.tv === true || /[?&]tv=1/.test(location.search);
var smooth = 'smooth';               // 'auto' quando le animazioni sono ridotte

function applyDevice() {
  var root = document.documentElement;
  var lite = device.anim === 'lite' || (device.anim !== 'full' && !!device.slow);
  smooth = lite ? 'auto' : 'smooth';
  root.classList.toggle('lite', lite);
  root.classList.toggle('tv', TVLOOK);
  root.classList.toggle('bigposters', device.posters === 'big');
  document.body.classList.toggle('tv', TVLOOK);
}

function setKb(on) {
  if (kb === on && document.body.classList.contains('kb') === on) return;
  kb = on;
  document.body.classList.toggle('kb', on);
}

applyDevice();
setKb(TVLOOK);
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

// ---------------------------------------------------------------- utilita'

function api(path, opt) {
  return fetch('/api' + path, opt).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (j) {
      if (r.status === 503 && j.detail && !j.login && !/^\/auth\//.test(path) && !api.reloading) { api.reloading = true; location.reload(); }
      // Accesso scaduto (o password provvisoria da cambiare): si torna alla pagina di accesso
      if ((r.status === 401 || r.status === 403) && j.login && auth && auth.user && !/^\/auth\//.test(path)) {
        auth = null;
        setTimeout(render, 0);
      }
      if (!r.ok) throw new Error(j.detail || ('Errore ' + r.status));
      return j;
    });
  });
}

function send(method, path, body) {
  return api(path, {
    method: method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
}

function post(path, body) { return send('POST', path, body); }

function esc(s) {
  return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function hue(s) {
  var h = 0;
  s = String(s || '');
  for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

function fmtDur(sec) {
  if (!sec) return '';
  var h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  if (m === 60) { h++; m = 0; }
  return h ? h + ' h ' + (m ? m + ' min' : '') : Math.max(1, m) + ' min';
}

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (s < 10 ? '0' : '') + s;
}

function fmtSize(bytes) {
  if (!bytes) return '';
  var gb = bytes / 1073741824;
  return gb >= 1 ? gb.toFixed(1).replace('.', ',') + ' GB' : Math.round(bytes / 1048576) + ' MB';
}

function norm(s) {
  s = String(s || '').toLowerCase();
  return s.normalize ? s.normalize('NFD').replace(/[\u0300-\u036f]/g, '') : s;
}

var toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 2800);
}

function parseQuery(h) {
  var o = {}, i = h.indexOf('?');
  if (i < 0) return o;
  h.slice(i + 1).split('&').forEach(function (p) {
    var kv = p.split('=');
    if (kv[0]) o[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || '');
  });
  return o;
}

function buildQuery(o) {
  var s = Object.keys(o).filter(function (k) { return o[k]; }).map(function (k) {
    return encodeURIComponent(k) + '=' + encodeURIComponent(o[k]);
  }).join('&');
  return s ? '?' + s : '';
}

// ---------------------------------------------------------------- raccolte

function libById(id) {
  for (var i = 0; i < libs.length; i++) if (String(libs[i].id) === String(id)) return libs[i];
  // Le raccolte degli amici: si sfogliano come le proprie, ma non si modificano
  for (var a = 0; a < friends.length; a++) {
    var fl = friends[a].libraries;
    for (var b = 0; b < fl.length; b++) {
      if (String(fl[b].id) === String(id)) {
        return { id: fl[b].id, name: fl[b].name, movies: fl[b].movies, shows: fl[b].shows, folders: [],
          friend: friends[a].name, offline: friends[a].online === false };
      }
    }
  }
  return null;
}

function initials(name) {
  var words = String(name).trim().split(/\s+/);
  return (words.length > 1 ? words[0].charAt(0) + words[1].charAt(0) : String(name).trim().slice(0, 2)).toUpperCase();
}

function avatar(name) {
  return '<i class="avatar">' + esc(initials(name)) + '</i>';
}

// Ricarica le raccolte e ridisegna la barra laterale (una voce per raccolta)
async function loadLibs(force) {
  if (!force && libsLoadedAt && Date.now() - libsLoadedAt < 15000) return;
  // Gli amici non devono mai fermare il menu: se la richiesta fallisce si va avanti senza
  var res = await Promise.all([api('/libraries'), api('/friends').catch(function () { return {}; })]);
  libs = res[0];
  friends = res[1].friends || [];
  friendQuality = res[1].quality || '720';
  libsLoadedAt = Date.now();
  var html = libs.map(function (l) {
    return '<a class="f railitem" href="#/lib/' + l.id + '" data-key="nav-lib-' + l.id + '">' +
      avatar(l.name) + '<span>' + esc(l.name) + '</span></a>';
  }).join('') + friends.map(function (fr) {
    if (!fr.libraries.length) return '';
    var off = fr.online === false;
    return '<div class="raillabel"><span>' + esc(fr.name) + (off ? ' · non raggiungibile' : '') + '</span></div>' +
      fr.libraries.map(function (l) {
        return '<a class="f railitem friend' + (off ? ' off' : '') + '" href="#/lib/' + l.id + '" data-key="nav-lib-' + l.id + '">' +
          avatar(l.name) + '<span>' + esc(l.name) + '</span></a>';
      }).join('');
  }).join('');
  if (html !== railSignature) {
    railSignature = html;
    document.getElementById('navlibs').innerHTML = html;
  }
}

function markRail(h) {
  var active = '';
  if (h === '#/home' || h === '#/search' || h === '#/mylist') active = h;
  else if (h.indexOf('#/saga') === 0) active = '#/sagas';
  else if (h.indexOf('#/lib/') === 0) active = '#/lib/' + h.slice(6).split('?')[0];
  else if ((h.indexOf('#/item/') === 0 || h.indexOf('#/show/') === 0) && cache.navLib) active = '#/lib/' + cache.navLib;
  else if (h.indexOf('#/newlib') === 0) active = '#/newlib';
  else if (h === '#/settings/account' || h === '#/password') active = '#/settings/account';
  else if (/^#\/(settings|browse|rename|match|accounts)/.test(h)) active = '#/settings';
  var links = rail.querySelectorAll('.railitem');
  for (var i = 0; i < links.length; i++) links[i].classList.toggle('on', links[i].getAttribute('href') === active);
}

// ---------------------------------------------------------------- schede

function progressBar(x) {
  if (x.watched || !x.position || !x.duration) return '';
  var pct = Math.max(3, Math.min(100, x.position / x.duration * 100));
  return '<div class="bar"><i style="width:' + pct.toFixed(1) + '%"></i></div>';
}

function stars(x, short) {
  if (!x.rating) return '';
  var n = x.rating.toFixed(1).replace('.', ',');
  return short ? 'voto ' + n : '<span class="star">' + n + ' su 10</span>';
}

function seenBadge() { return '<span class="badge seen">' + IC.check + '</span>'; }

function posterCard(x, prefix) {
  cardData[prefix + '-' + x.kind + x.id] = x;
  var isShow = x.kind === 'show';
  var href = isShow ? '#/show/' + x.id : '#/item/' + x.id;
  var img = x.poster || x.thumb;
  var badge = isShow
    ? (x.unwatched ? '<span class="badge">' + x.unwatched + '</span>' : seenBadge())
    : (x.watched ? seenBadge() : '');
  var sub = [x.year || '', isShow ? 'Serie' : '', stars(x, true)].filter(Boolean).join(' · ');
  return '<a class="card poster f" href="' + href + '" data-key="' + prefix + '-' + x.kind + x.id + '" aria-label="' + esc(x.title) + '">' +
    '<div class="art" style="--h:' + hue(x.title) + '">' +
      (img ? '<img loading="lazy" decoding="async" src="' + img + '" alt="" onerror="this.style.display=\'none\'">' : '') +
      (x.poster ? '' : '<span class="ph">' + esc(x.title) + '</span>') +
      (x.quality === '4K' ? '<span class="q">4K</span>' : '') +
      badge + progressBar(x) + MORE +
    '</div>' +
    '<div class="cap"><b>' + esc(x.title) + '</b><small>' + (sub || '&nbsp;') + '</small></div></a>';
}

// Saga: i film della stessa serie cinematografica, riuniti da soli
function sagaYears(x) {
  return x.year ? (x.year_to && x.year_to !== x.year ? x.year + '–' + x.year_to : String(x.year)) : '';
}

function sagaCard(x, prefix) {
  var img = x.poster || x.thumb;
  var sub = [x.count + ' film' + (x.total > x.count ? ' su ' + x.total : ''), sagaYears(x)].filter(Boolean).join(' · ');
  return '<a class="card poster f" href="#/saga/' + x.id + '" data-key="' + prefix + '-collection' + x.id + '">' +
    '<div class="art" style="--h:' + hue(x.title) + '">' +
      (img ? '<img loading="lazy" decoding="async" src="' + img + '" alt="" onerror="this.style.display=\'none\'">' : '') +
      (x.poster ? '' : '<span class="ph">' + esc(x.title) + '</span>') +
      '<span class="q saga">Saga</span>' +
      (x.unwatched ? '<span class="badge">' + x.unwatched + '</span>' : seenBadge()) +
    '</div>' +
    '<div class="cap"><b>' + esc(x.title) + '</b><small>' + (sub || '&nbsp;') + '</small></div></a>';
}

function wideCard(x, prefix) {
  cardData[prefix + '-' + x.kind + x.id] = x;
  var isEp = x.kind === 'episode';
  var title = isEp ? (x.show_title || x.title) : x.title;
  var sub = isEp ? 'S' + x.season + ' · E' + x.episode + ' · ' + esc(x.title) : (x.year || '');
  if (x.position && x.duration && !x.watched) sub += ' · mancano ' + fmtDur(x.duration - x.position);
  if (x.friend) sub += ' · di ' + esc(x.friend);
  var img = isEp ? x.thumb : (x.backdrop || x.thumb);
  return '<button class="card wide f" data-act="play" data-arg="' + x.id + '" data-key="' + prefix + '-' + x.kind + x.id + '">' +
    '<div class="art" style="--h:' + hue(title) + '">' +
      (img ? '<img loading="lazy" decoding="async" src="' + img + '" alt="" onerror="this.style.display=\'none\'">' : '') +
      '<span class="playico">' + IC.play + '</span>' + progressBar(x) + MORE +
    '</div>' +
    '<div class="cap"><b>' + esc(title) + '</b><small>' + (sub || '&nbsp;') + '</small></div></button>';
}

function section(title, cards, note) {
  if (!cards.length) return '';
  return '<section class="section"><h2>' + title + (note ? '<small>' + note + '</small>' : '') +
    '</h2><div class="row">' + cards.join('') + '</div></section>';
}

// Griglia lunga: si disegnano le prime locandine e le altre arrivano man mano che
// si scende. Con mille titoli la pagina resta leggera anche sulle TV piu' lente.
var CHUNK = 60;

function cardKey(x, prefix) { return prefix + '-' + x.kind + x.id; }

function gridCard(x, n) {
  var html = x.kind === 'collection' ? sagaCard(x, chunk.prefix) : posterCard(x, chunk.prefix);
  return n === 0 ? html.replace('class="card', 'data-autofocus class="card') : html;
}

function gridHtml(list, prefix, wantKey) {
  var first = Math.max(CHUNK, cache.keepShown || 0);
  if (wantKey) {   // la locandina su cui si era rimasti deve esserci subito
    for (var i = 0; i < list.length; i++) if (cardKey(list[i], prefix) === wantKey) { first = Math.max(first, i + 14); break; }
  }
  chunk = { list: list, prefix: prefix, shown: Math.min(first, list.length) };
  return '<div class="grid" id="grid">' + list.slice(0, chunk.shown).map(gridCard).join('') + '</div>';
}

function growGrid(upTo) {
  var el = document.getElementById('grid');
  if (!chunk || !el || chunk.shown >= chunk.list.length) return;
  var from = chunk.shown, to = Math.min(chunk.list.length, Math.max(from + CHUNK, upTo || 0));
  el.insertAdjacentHTML('beforeend', chunk.list.slice(from, to).map(function (x, n) { return gridCard(x, from + n); }).join(''));
  chunk.shown = to;
}

function chips(list, base, key) {
  return list.map(function (name) {
    var q = {}; q[key] = name;
    return '<a class="chip f" href="' + base + buildQuery(q) + '" data-key="chip-' + key + '-' + esc(name) + '">' + esc(name) + '</a>';
  }).join('');
}

function metaLine(parts) {
  return '<div class="meta">' + parts.filter(Boolean).map(function (p) {
    return '<span>' + p + '</span>';
  }).join('') + '</div>';
}

function heroBg(x) {
  var img = x.backdrop || x.thumb;
  return '<div class="bg"' + (img ? ' style="background-image:url(\'' + img + '\')"' : '') + '></div>';
}

function cover(x) {
  if (!x.poster) return '';
  return '<div class="cover"><div class="art"><img src="' + x.poster + '" alt=""></div></div>';
}

// ---------------------------------------------------------------- Home

async function home() {
  var d = await api('/home');
  var recent = [];
  d.libraries.forEach(function (l) { recent = recent.concat(l.items); });
  if (!d.continue.length && !d.nextup.length && !recent.length) return emptyLibrary(d.has_libraries);
  var mine = d.mylist || [];

  var map = {};
  function reg(x, prefix, kicker) {
    map[prefix + '-' + x.kind + x.id] = { x: x, kicker: kicker };
    return x;
  }

  var rows =
    section('Continua a guardare', d.continue.map(function (x) { return wideCard(reg(x, 'cont', 'Continua a guardare'), 'cont'); })) +
    section('Prossimi episodi', d.nextup.map(function (x) { return wideCard(reg(x, 'next', 'Prossimo episodio'), 'next'); })) +
    section('La mia lista', mine.map(function (x) { return posterCard(reg(x, 'mine', 'La mia lista'), 'mine'); })) +
    d.libraries.map(function (l) {
      // Le raccolte degli amici: stessa fila, con il nome dell'amico bene in vista
      var note = l.friend ? 'di ' + esc(l.friend) + (l.offline ? ' · non raggiungibile ora' : '') : 'aggiunti di recente';
      var kicker = l.friend ? l.name + ' · di ' + l.friend : l.name;
      return section(esc(l.name), l.items.map(function (x) { return posterCard(reg(x, 'lib' + l.id, kicker), 'lib' + l.id); }), note);
    }).join('') +
    section('Saghe', (d.collections || []).map(function (x) { return sagaCard(reg(x, 'saga', 'Saga'), 'saga'); }), 'i film della stessa serie, in ordine') +
    section('I più votati da vedere', d.top_movies.map(function (x) { return posterCard(reg(x, 'top', 'Da non perdere'), 'top'); }));

  return {
    html: '<div class="home"><div class="stage" id="stage"><div class="bg"></div><div class="bg"></div>' +
      '<div class="shade"></div><div class="info"></div></div><div class="rows" id="rows">' + rows + '</div></div>',
    mount: function () {
      stageMap = map;
      stageKey = '';
      var box = document.getElementById('rows');
      if (!kb && cache.homeScroll) box.scrollTop = cache.homeScroll;
      box.addEventListener('scroll', function () { cache.homeScroll = box.scrollTop; }, { passive: true });
    }
  };
}

// Anteprima grande in alto: segue la scheda selezionata (o sotto il mouse)
function setStage(key) {
  if (!stageMap || !stageMap[key] || key === stageKey) return;
  stageKey = key;
  clearTimeout(stageTimer);
  stageTimer = setTimeout(function () { paintStage(key); }, 130);
}

function paintStage(key) {
  var s = stageMap && stageMap[key], el = document.getElementById('stage');
  if (!s || !el || key !== stageKey) return;
  var x = s.x, isEp = x.kind === 'episode', isShow = x.kind === 'show', isSaga = x.kind === 'collection';
  var info = el.querySelector('.info');
  info.classList.remove('in');
  void info.offsetWidth;               // fa ripartire l'animazione del testo
  info.classList.add('in');
  info.innerHTML =
    '<h1>' + esc(isEp ? (x.show_title || x.title) : x.title) + '</h1>' +
    metaLine([
      '<b class="lead">' + esc(s.kicker) + '</b>',
      isEp ? 'S' + x.season + ' · E' + x.episode + ' · ' + esc(x.title) : '',
      isSaga ? sagaYears(x) : x.year,
      isShow ? x.seasons_count + (x.seasons_count === 1 ? ' stagione' : ' stagioni')
        : (isSaga ? x.count + ' film' + (x.total > x.count ? ' su ' + x.total : '') : fmtDur(x.duration)),
      stars(x),
      (x.genres || []).slice(0, 3).map(esc).join(', '),
      !isShow && x.position > 20 && !x.watched ? 'mancano ' + fmtDur(x.duration - x.position) : ''
    ]) +
    (x.overview ? '<p class="overview">' + esc(x.overview) + '</p>' : '') +
    '<p class="hint">' + HINT + '</p>';

  var layers = el.querySelectorAll('.bg');
  var next = layers[stageFlip ? 0 : 1], prev = layers[stageFlip ? 1 : 0];
  var img = x.backdrop || x.thumb;
  if (!img) { next.classList.remove('on'); prev.classList.remove('on'); return; }
  var pre = new Image();
  pre.onload = function () {
    if (key !== stageKey) return;
    next.style.backgroundImage = 'url("' + img + '")';
    next.classList.add('on');
    prev.classList.remove('on');
    stageFlip = !stageFlip;
  };
  pre.onerror = function () { if (key === stageKey) { next.classList.remove('on'); prev.classList.remove('on'); } };
  pre.src = img;
}

function emptyLibrary(hasLibraries) {
  if (hasLibraries) {
    return '<div class="page"><div class="empty center"><h2>Le raccolte sono ancora vuote</h2>' +
      '<p>Se hai appena aggiunto delle cartelle, BunkerPlex le sta leggendo: i titoli compaiono qui tra poco. ' +
      'Altrimenti controlla le cartelle in <b>Impostazioni</b>.</p>' +
      '<p id="scanmsg"></p>' +
      '<div class="actions"><a class="btn primary f" href="#/settings" data-key="to-settings">Apri Impostazioni</a>' +
      '<button class="btn f" data-act="scan" data-key="scan">Aggiorna adesso</button></div></div></div>';
  }
  return '<div class="page"><div class="empty center"><h2>Crea la tua prima raccolta</h2>' +
    '<p>Una raccolta è una sezione del tuo cinema: le dai il nome che vuoi (Film, Cartoni, Serie, Documentari…) ' +
    'e le indichi una o più cartelle del PC. Film e serie vengono riconosciuti da soli.</p>' +
    '<div class="actions"><a class="btn primary f" href="#/newlib" data-key="new-lib">+ Aggiungi raccolta</a></div></div></div>';
}

// ---------------------------------------------------------------- Pagina di una raccolta, con filtri

var SORTS = {
  title: 'Titolo (A–Z)',
  added: 'Aggiunti di recente',
  year_desc: 'Anno, dal più recente',
  year_asc: 'Anno, dal più vecchio',
  rating: 'Voto più alto',
  duration: 'Durata, dal più breve'
};
var STATES = { '': 'Tutti', unwatched: 'Da vedere', started: 'Iniziati', watched: 'Già visti' };
var TYPES = { '': 'Tutto', movie: 'Film', show: 'Serie TV' };

function countBy(list, getValues) {
  var map = {};
  list.forEach(function (x) {
    getValues(x).forEach(function (v) { if (v) map[v] = (map[v] || 0) + 1; });
  });
  return map;
}

function directorsOf(x) {
  return (x.director || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
}

function yearLabel(v) {
  if (!v) return 'Tutti';
  return v.charAt(0) === 'd' ? 'Anni ' + v.slice(1) : v;
}

function libraryFilter(list, q) {
  return list.filter(function (x) {
    var isShow = x.kind === 'show';
    if (q.type && q.type !== x.kind) return false;
    if (q.genre && (x.genres || []).indexOf(q.genre) < 0) return false;
    if (q.director && directorsOf(x).indexOf(q.director) < 0) return false;
    if (q.actor && (x.actors || []).indexOf(q.actor) < 0) return false;
    if (q.year) {
      if (!x.year) return false;
      if (q.year.charAt(0) === 'd') {
        var d = parseInt(q.year.slice(1), 10);
        if (x.year < d || x.year > d + 9) return false;
      } else if (String(x.year) !== q.year) return false;
    }
    if (q.state === 'watched' && !x.watched) return false;
    if (q.state === 'unwatched' && x.watched) return false;
    if (q.state === 'started') {
      if (isShow ? !(x.unwatched > 0 && x.unwatched < x.episodes) : !(x.position > 20 && !x.watched)) return false;
    }
    return true;
  });
}

function librarySort(list, sort) {
  var byTitle = function (a, b) { return norm(a.title).localeCompare(norm(b.title)); };
  var when = function (x) { return x.latest || x.added_at || 0; };
  var cmp = {
    title: byTitle,
    added: function (a, b) { return when(b) - when(a); },
    year_desc: function (a, b) { return (b.year || 0) - (a.year || 0) || byTitle(a, b); },
    year_asc: function (a, b) { return (a.year || 9999) - (b.year || 9999) || byTitle(a, b); },
    rating: function (a, b) { return (b.rating || 0) - (a.rating || 0) || byTitle(a, b); },
    duration: function (a, b) { return (a.duration || 1e9) - (b.duration || 1e9) || byTitle(a, b); }
  }[sort] || byTitle;
  return list.slice().sort(cmp);
}

// Intestazione della raccolta aperta: lo stesso quadratino del menu, il nome
// e sotto un riassunto (di chi è, quanti titoli, quanti ancora da vedere)
function libHeader(lib, parts, hint) {
  return '<div class="toolbar libhead"><i class="avatar' + (lib.friend ? ' friend' : '') + '" aria-hidden="true">' +
    esc(initials(lib.name)) + '</i><div class="libtitle"><h1>' + esc(lib.name) + '</h1>' +
    (parts.length ? '<p class="libmeta">' + parts.join('<i class="sep">·</i>') + '</p>' : '') +
    (hint ? '<p class="hint">' + HINT + '</p>' : '') + '</div></div>';
}

function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

async function libraryPage(id) {
  var lib = libById(id);
  if (!lib) { await loadLibs(true); lib = libById(id); }
  if (!lib) throw new Error('Questa raccolta non esiste più.');
  var q = parseQuery(location.hash);
  var all = await api('/libraries/' + lib.id + '/items');
  var owner = [];
  if (lib.friend) {
    owner.push('di ' + esc(lib.friend));
    if (lib.offline) owner.push('<span class="warn">' + dot(false) + ' non raggiungibile: vedi l\'ultimo elenco salvato</span>');
  }
  if (!all.length && lib.friend) {
    return '<div class="page">' + libHeader(lib, owner) + '<div class="empty">' +
      '<p>Questa raccolta di ' + esc(lib.friend) + ' è vuota, oppure il suo elenco non è ancora arrivato.</p></div></div>';
  }
  if (!all.length) {
    return '<div class="page">' + libHeader(lib, owner.concat(lib.folders.length ? [] : ['nessuna cartella'])) + '<div class="empty">' +
      (lib.folders.length
        ? '<p>In questa raccolta non c\'è ancora nessun titolo. Se hai appena aggiunto una cartella, aspetta che BunkerPlex finisca di leggerla.</p>'
        : '<p>Questa raccolta non ha ancora cartelle: aggiungine una per riempirla.</p>') +
      '<p id="scanmsg"></p><div class="actions">' +
      '<a class="btn primary f" href="#/browse/' + lib.id + '" data-key="add-folder">+ Aggiungi una cartella</a>' +
      '<button class="btn f" data-act="scan" data-key="scan">Aggiorna adesso</button></div></div></div>';
  }
  cache['lib' + lib.id] = all;
  var list = librarySort(libraryFilter(all, q), q.sort || 'title');
  var mixed = all.some(function (x) { return x.kind === 'show'; }) && all.some(function (x) { return x.kind === 'movie'; });

  function fbtn(key, label, value, active) {
    return '<button class="filter f' + (active ? ' active' : '') + '" data-act="filter" data-arg="' + lib.id + ':' + key +
      '" data-key="filter-' + key + '"><span>' + label + '</span><b>' + esc(value) + '</b></button>';
  }

  var hasFilters = q.type || q.genre || q.director || q.actor || q.year || q.state;
  var byTitle = !q.sort || q.sort === 'title';
  cache.libView = { id: lib.id, list: list };
  // Riassunto: con i filtri attivi prima quanti ne restano, poi il totale diviso per tipo
  var nMovies = 0, nShows = 0, nTodo = 0;
  all.forEach(function (x) {
    if (x.kind === 'show') nShows++; else nMovies++;
    if (!x.watched) nTodo++;
  });
  var parts = owner.slice();
  if (list.length !== all.length) parts.push('<b>' + plural(list.length, 'titolo', 'titoli') + ' coi filtri</b> su ' + all.length);
  else if (!mixed) parts.push(nShows ? plural(nShows, 'serie TV', 'serie TV') : plural(nMovies, 'film', 'film'));
  if (mixed && list.length === all.length) parts.push(plural(nMovies, 'film', 'film'), plural(nShows, 'serie TV', 'serie TV'));
  if (nTodo && nTodo < all.length) parts.push(nTodo + ' da vedere');
  else if (!nTodo) parts.push('tutto già visto');
  var html = '<div class="page">' + libHeader(lib, parts, true) +
    '<div class="filters">' +
    fbtn('sort', 'Ordina', SORTS[q.sort || 'title'], !!q.sort && q.sort !== 'title') +
    (byTitle && list.length > 30 ? '<button class="filter f" data-act="letters" data-key="lib-letters"><b>Vai alla lettera</b></button>' : '') +
    (mixed ? fbtn('type', 'Tipo', TYPES[q.type || ''], !!q.type) : '') +
    fbtn('genre', 'Genere', q.genre || 'Tutti', !!q.genre) +
    fbtn('year', 'Anno', yearLabel(q.year), !!q.year) +
    fbtn('director', 'Regia', q.director || 'Tutti', !!q.director) +
    fbtn('actor', 'Attore', q.actor || 'Tutti', !!q.actor) +
    fbtn('state', 'Stato', STATES[q.state || ''], !!q.state) +
    (hasFilters ? '<button class="filter f" data-act="clearfilters" data-arg="' + lib.id + '" data-key="filter-clear"><b>Azzera filtri</b></button>' : '') +
    (list.length > 1 ? '<button class="filter f" data-act="lucky" data-key="lib-lucky"><b>Scegli tu</b></button>' : '') +
    (lib.friend ? '' : '<button class="filter f" data-act="refreshmenu" data-arg="' + lib.id + '" data-key="lib-refresh"><b>Aggiorna</b></button>') +
    '</div>';
  html += list.length
    ? gridHtml(list, 'lib', focusMemory[location.hash])
    : '<div class="empty"><h2>Nessun risultato</h2><p>Nessun titolo corrisponde ai filtri scelti.</p></div>';
  return html + '</div>';
}

// "Vai alla lettera": con mille titoli, dal telecomando si arriva subito alla R
function openLetters() {
  var v = cache.libView;
  if (!v) return;
  var firstAt = {};
  v.list.forEach(function (x, n) {
    var c = norm(x.title).replace(/^[^a-z0-9]+/, '').charAt(0).toUpperCase();
    if (c >= '0' && c <= '9') c = '#';
    if (c && firstAt[c] === undefined) firstAt[c] = n;
  });
  modalState = { options: [], onPick: function () {}, returnFocus: document.activeElement };
  modal.innerHTML = '<div class="sheet"><h3>Vai alla lettera</h3><div class="letters">' +
    '#ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(function (c) {
      return '<button class="letter' + (firstAt[c] === undefined ? '" disabled' : ' f" data-act="letter" data-arg="' + firstAt[c] + '"') + '>' + c + '</button>';
    }).join('') + '</div></div>';
  modal.hidden = false;
  var first = modal.querySelector('.f');
  if (first) first.focus();
}

// Porta a una locandina della griglia, anche se non e' ancora stata disegnata
function goToCard(index) {
  if (!chunk || !chunk.list[index]) return;
  growGrid(index + 14);
  var el = byKey(cardKey(chunk.list[index], chunk.prefix));
  if (!el) return;
  setKb(true);
  el.focus();
}

// "Scegli tu": un titolo a caso tra quelli a schermo, preferendo i non visti
function lucky() {
  var v = cache.libView;
  if (!v || !v.list.length) return;
  var pool = v.list.filter(function (x) { return !x.watched; });
  if (!pool.length) pool = v.list;
  var x = pool[Math.floor(Math.random() * pool.length)];
  location.hash = x.kind === 'show' ? '#/show/' + x.id : '#/item/' + x.id;
}

function openFilter(arg) {
  var parts = arg.split(':'), libId = parts[0], key = parts[1];
  var q = parseQuery(location.hash);
  var all = cache['lib' + libId] || [];
  // I conteggi tengono conto degli altri filtri gia' attivi
  var others = {};
  Object.keys(q).forEach(function (k) { if (k !== key) others[k] = q[k]; });
  var pool = libraryFilter(all, others);
  var opts = [], title = '';

  function fromCounts(map, sorter) {
    return Object.keys(map).sort(sorter).map(function (v) { return { value: v, label: v, count: map[v] }; });
  }
  var alpha = function (a, b) { return norm(a).localeCompare(norm(b)); };

  if (key === 'sort') {
    title = 'Ordina per';
    opts = Object.keys(SORTS).map(function (k) { return { value: k === 'title' ? '' : k, label: SORTS[k] }; });
  } else if (key === 'state') {
    title = 'Stato';
    opts = Object.keys(STATES).map(function (k) { return { value: k, label: STATES[k] }; });
  } else if (key === 'type') {
    title = 'Tipo';
    var tm = countBy(pool, function (x) { return [x.kind]; });
    opts = Object.keys(TYPES).map(function (k) { return { value: k, label: TYPES[k], count: k ? (tm[k] || 0) : pool.length }; });
  } else if (key === 'genre') {
    title = 'Genere';
    opts = fromCounts(countBy(pool, function (x) { return x.genres || []; }), alpha);
  } else if (key === 'director') {
    title = 'Regia';
    var dm = countBy(pool, directorsOf);
    opts = fromCounts(dm, function (a, b) { return dm[b] - dm[a] || alpha(a, b); });
  } else if (key === 'actor') {
    title = 'Attore';
    var am = countBy(pool, function (x) { return x.actors || []; });
    opts = fromCounts(am, function (a, b) { return am[b] - am[a] || alpha(a, b); }).slice(0, 300);
  } else if (key === 'year') {
    title = 'Anno';
    var ym = countBy(pool, function (x) { return x.year ? [String(x.year)] : []; });
    var dec = countBy(pool, function (x) { return x.year ? ['d' + Math.floor(x.year / 10) * 10] : []; });
    opts = Object.keys(dec).sort().reverse().map(function (v) { return { value: v, label: yearLabel(v), count: dec[v] }; })
      .concat(Object.keys(ym).sort().reverse().map(function (v) { return { value: v, label: v, count: ym[v] }; }));
  }
  if (key === 'genre' || key === 'director' || key === 'actor' || key === 'year') {
    opts.unshift({ value: '', label: 'Tutti', count: pool.length });
  }

  openPicker(title, opts, q[key] || '', function (value) {
    q[key] = value;
    var target = '#/lib/' + libId + buildQuery(q);
    focusMemory[target] = 'filter-' + key;
    if (target === location.hash) render(); else location.replace(target);
  });
}

// ---------------------------------------------------------------- Scheda film / episodio

// Cast con le foto: una fila di volti; OK su un attore mostra i suoi titoli nella raccolta
function castRow(x, base) {
  var list = x.cast || [];
  if (!list.length) return '';
  return '<section class="section people"><h2>Cast</h2><div class="row">' + list.map(function (p, n) {
    return '<a class="person f" href="' + base + buildQuery({ actor: p.name }) + '" data-key="cast-' + n + '">' +
      '<span class="face">' + (p.photo
        ? '<img loading="lazy" decoding="async" src="' + p.photo + '" alt="" onerror="this.style.display=\'none\'">' : '') +
        '<i>' + esc(initials(p.name)) + '</i></span>' +
      '<b>' + esc(p.name) + '</b><small>' + (esc(p.role) || '&nbsp;') + '</small></a>';
  }).join('') + '</div></section>';
}

// "La mia lista": i titoli messi da parte per dopo (film e serie)
function favButton(x) {
  return '<button class="btn f' + (x.fav ? ' on' : '') + '" data-act="fav" data-arg="' + x.kind + ':' + x.id + ':' + (x.fav ? 0 : 1) + '" data-key="fav">' +
    (x.fav ? IC.check + 'Nella mia lista' : IC.plus + 'La mia lista') + '</button>';
}

function setFav(kind, id, on) {
  return post('/fav', { kind: kind, id: +id, fav: !!on }).then(function () {
    toast(on ? 'Aggiunto alla tua lista' : 'Tolto dalla tua lista');
    render();
  }, function (e) { toast(e.message); });
}

async function item(id) {
  var x = await api('/items/' + id);
  cache.navLib = x.library_id;
  var isEp = x.kind === 'episode';
  var resume = x.position > 20 && !x.watched;
  var base = '#/lib/' + x.library_id;
  var tech = [x.filename, fmtSize(x.size), [x.vcodec, x.acodec].filter(Boolean).join(' + ').toUpperCase()].filter(Boolean).join('  ·  ');

  var faces = isEp ? '' : castRow(x, base);
  return '<header class="hero' + (faces ? ' more' : '') + '">' + heroBg(x) + '<div class="in">' + cover(x) + '<div class="txt">' +
      '<h1>' + esc(x.title) + '</h1>' +
      (x.tagline ? '<div class="tagline">' + esc(x.tagline) + '</div>' : '') +
      metaLine([
        isEp ? '<b class="lead">' + esc(x.show_title || '') + ' · Stagione ' + x.season + ' · Episodio ' + x.episode + '</b>' : '',
        x.friend ? '<b class="lead">Di ' + esc(x.friend) + '</b>' : '',
        x.year, fmtDur(x.duration), stars(x),
        x.quality ? '<span class="tag">' + x.quality + '</span>' : '',
        x.watched ? '<span class="okdot">' + IC.check + ' Visto</span>' : '',
        resume ? 'mancano ' + fmtDur(x.duration - x.position) : ''
      ]) +
      '<p class="overview full">' + esc(x.overview || (x.matched || isEp || x.friend ? '' : 'Nessuna scheda trovata per questo file: prova «Correggi scheda».')) + '</p>' +
      '<div class="actions">' +
        '<button class="btn primary f" data-act="play" data-arg="' + x.id + '" data-key="play">' + IC.play +
          (resume ? 'Riprendi da ' + fmtTime(x.position) : 'Riproduci') + '</button>' +
        (resume ? '<button class="btn f" data-act="playstart" data-arg="' + x.id + '" data-key="restart">Dall\'inizio</button>' : '') +
        (isEp || x.friend ? '' : favButton(x)) +
        '<button class="btn f" data-act="watched" data-arg="' + x.id + ':' + (x.watched ? 0 : 1) + '" data-key="watched">' +
          (x.watched ? 'Segna come da vedere' : 'Segna come visto') + '</button>' +
        (isEp
          ? '<a class="btn f" href="#/show/' + x.show_id + '" data-key="toshow">Vai alla serie</a>'
          : (x.friend ? '' : '<a class="btn f" href="#/match/movie/' + x.id + '" data-key="match">Correggi scheda</a>')) +
      '</div>' +
      (!isEp && (x.genres.length || x.director || x.actors.length || x.collection) ? '<div class="credits">' +
        (x.collection ? '<div><b>Saga</b><a class="chip f" href="#/saga/' + x.collection.id + '" data-key="chip-saga">' +
          esc(x.collection.title) + ' · ' + x.collection.count + ' film</a></div>' : '') +
        (x.genres.length ? '<div><b>Genere</b>' + chips(x.genres, base, 'genre') + '</div>' : '') +
        (x.director ? '<div><b>Regia</b>' + chips(directorsOf(x), base, 'director') + '</div>' : '') +
        (x.actors.length && !faces ? '<div><b>Cast</b>' + chips(x.actors, base, 'actor') + '</div>' : '') +
      '</div>' : '') +
      '<div class="fine">' + esc(tech) + '</div>' +
    '</div></div></header>' + faces;
}

// ---------------------------------------------------------------- Scheda serie

async function show(id) {
  var s = await api('/shows/' + id);
  cache.navLib = s.library_id;
  var q = parseQuery(location.hash);
  var up = s.up_next;
  var base = '#/lib/' + s.library_id;
  var current = parseInt(q.season, 10);
  if (isNaN(current)) current = up ? up.season : (s.seasons[0] ? s.seasons[0].season : 1);
  var season = s.seasons.filter(function (x) { return x.season === current; })[0] || s.seasons[0];

  var faces = castRow(s, base);
  var tabs = s.seasons.length > 1 ? '<div class="seasons">' + s.seasons.map(function (x) {
    return '<button class="filter f' + (x === season ? ' active' : '') + '" data-act="season" data-arg="' + s.id + ':' + x.season +
      '" data-key="season-' + x.season + '"><b>' + (x.season === 0 ? 'Speciali' : 'Stagione ' + x.season) + '</b></button>';
  }).join('') + '</div>' : '';

  var eps = season ? season.episodes.map(function (e) {
    return '<div class="eprow">' +
      '<button class="ep f" data-act="play" data-arg="' + e.id + '" data-key="ep-' + e.id + '">' +
        '<div class="art" style="--h:' + hue(s.title) + '"><img loading="lazy" decoding="async" src="' + e.thumb + '" alt="" onerror="this.style.display=\'none\'">' + progressBar(e) + '</div>' +
        '<div class="body"><div class="num">Episodio ' + e.episode + (e.duration ? ' · ' + fmtDur(e.duration) : '') +
          (e.position > 20 && !e.watched ? ' · mancano ' + fmtDur(e.duration - e.position) : '') + '</div>' +
        '<h3>' + esc(e.title) + '</h3><p>' + esc(e.overview || '') + '</p></div>' +
      '</button>' +
      '<button class="seenbtn f' + (e.watched ? ' on' : '') + '" data-act="watched" data-arg="' + e.id + ':' + (e.watched ? 0 : 1) +
        '" data-key="seen-' + e.id + '" title="Visto / da vedere" aria-label="' + (e.watched ? 'Segna come da vedere' : 'Segna come visto') + '">' + IC.check + '</button>' +
    '</div>';
  }).join('') : '';

  return '<header class="hero short">' + heroBg(s) + '<div class="in">' + cover(s) + '<div class="txt">' +
      '<h1>' + esc(s.title) + '</h1>' +
      metaLine([
        s.friend ? '<b class="lead">Di ' + esc(s.friend) + '</b>' : '',
        s.year, s.seasons_count + (s.seasons_count === 1 ? ' stagione' : ' stagioni'),
        s.episodes + ' episodi', stars(s),
        s.unwatched ? s.unwatched + ' da vedere' : '<span class="okdot">' + IC.check + ' Vista</span>'
      ]) +
      '<p class="overview">' + esc(s.overview || '') + '</p>' +
      '<div class="actions">' +
        (up ? '<button class="btn primary f" data-act="play" data-arg="' + up.id + '" data-key="play">' + IC.play +
          (up.position > 20 ? 'Riprendi' : 'Riproduci') + ' S' + up.season + ' · E' + up.episode + '</button>' : '') +
        (s.friend ? '' : favButton(s)) +
        '<button class="btn f" data-act="showwatched" data-arg="' + s.id + ':' + (s.watched ? 0 : 1) + '" data-key="allseen">' +
          (s.watched ? 'Segna tutta come da vedere' : 'Segna tutta come vista') + '</button>' +
        (s.friend ? '' : '<a class="btn f" href="#/match/show/' + s.id + '" data-key="match">Correggi scheda</a>') +
      '</div>' +
      (s.genres.length || s.director || s.actors.length ? '<div class="credits">' +
        (s.genres.length ? '<div><b>Genere</b>' + chips(s.genres, base, 'genre') + '</div>' : '') +
        (s.director ? '<div><b>Creata da</b>' + chips(directorsOf(s), base, 'director') + '</div>' : '') +
        (s.actors.length && !faces ? '<div><b>Cast</b>' + chips(s.actors, base, 'actor') + '</div>' : '') +
      '</div>' : '') +
    '</div></div></header>' + tabs + '<div class="eps">' + eps + '</div>' + faces;
}

// ---------------------------------------------------------------- Saghe

async function sagasPage() {
  var res = await Promise.all([api('/collections'), api('/info')]);
  var all = res[0], i = res[1];
  if (!all.length) {
    return '<div class="page"><div class="toolbar"><h1>Saghe</h1></div><div class="empty">' +
      '<p>Qui compaiono da sole le saghe: quando in catalogo hai almeno due film della stessa serie ' +
      '(Harry Potter, Il Signore degli Anelli, Ritorno al futuro…) vengono riuniti e messi in ordine di uscita.</p>' +
      (i.tmdb ? '<p>Per ora nessuna saga ha due film in catalogo. Dopo un aggiornamento ci vuole qualche minuto perché vengano riconosciute.</p>'
              : '<p>Serve la chiave TMDB: inseriscila in <b>Impostazioni</b>.</p>') +
      '<p id="scanmsg"></p><div class="actions">' +
      (i.tmdb ? '<button class="btn f" data-act="scan" data-key="scan">Aggiorna adesso</button>'
              : '<a class="btn primary f" href="#/settings" data-key="to-settings">Apri Impostazioni</a>') +
      '</div></div></div>';
  }
  return '<div class="page"><div class="toolbar"><h1>Saghe</h1>' +
    '<span class="count">' + all.length + (all.length === 1 ? ' saga' : ' saghe') + '</span></div>' +
    gridHtml(all, 'sagas', focusMemory[location.hash]) + '</div>';
}

// ---------------------------------------------------------------- La mia lista

async function myListPage() {
  var all = await api('/mylist');
  if (!all.length) {
    return '<div class="page"><div class="toolbar"><h1>La mia lista</h1></div><div class="empty">' +
      '<p>Qui trovi i film e le serie che metti da parte per dopo. Per aggiungerne uno apri la sua scheda e premi <b>La mia lista</b>' +
      (TVLOOK ? ', oppure tieni premuto OK sulla locandina.' : ', oppure usa il menu della locandina.') + '</p>' +
      '<div class="actions"><a class="btn primary f" href="#/home" data-key="to-home">Torna alla Home</a></div></div></div>';
  }
  return '<div class="page"><div class="toolbar"><h1>La mia lista</h1>' +
    '<span class="count">' + all.length + (all.length === 1 ? ' titolo' : ' titoli') + '</span></div>' +
    gridHtml(all, 'mine', focusMemory[location.hash]) + '</div>';
}

async function sagaPage(id) {
  var s = await api('/collections/' + id);
  var up = s.up_next;
  var resume = up && up.position > 20 && !up.watched;
  var missing = (s.missing || []).map(function (m) { return esc(m.title) + (m.year ? ' (' + m.year + ')' : ''); });
  return '<header class="hero short">' + heroBg(s) + '<div class="in">' + cover(s) + '<div class="txt">' +
      '<h1>' + esc(s.title) + '</h1>' +
      metaLine([
        '<b class="lead">Saga</b>',
        sagaYears(s), s.count + ' film' + (s.total > s.count ? ' su ' + s.total : ''), stars(s),
        s.unwatched ? s.unwatched + ' da vedere' : '<span class="okdot">' + IC.check + ' Vista</span>'
      ]) +
      '<p class="overview">' + esc(s.overview || '') + '</p>' +
      '<div class="actions">' +
        (up ? '<button class="btn primary f" data-act="play" data-arg="' + up.id + '" data-key="play">' + IC.play +
          (resume ? 'Riprendi ' : 'Riproduci ') + esc(up.title) + '</button>' : '') +
      '</div>' +
      (missing.length ? '<div class="fine">Ti ' + (missing.length === 1 ? 'manca' : 'mancano') + ': ' + missing.join(' · ') + '</div>' : '') +
    '</div></div></header>' +
    '<div class="grid">' + s.items.map(function (x) { return posterCard(x, 'saga'); }).join('') + '</div>';
}

// Generi piu' presenti in catalogo: sulla TV si sfoglia senza scrivere
function topGenres(all) {
  var map = countBy(all.map(function (e) { return e.x; }), function (x) { return x.genres || []; });
  return Object.keys(map).sort(function (a, b) { return map[b] - map[a] || norm(a).localeCompare(norm(b)); }).slice(0, 18);
}

// ---------------------------------------------------------------- Cerca

async function search() {
  var res = await Promise.all([api('/movies'), api('/shows'), api('/collections')]);
  var all = res[2].concat(res[0], res[1]).map(function (x) {
    return { x: x, hay: norm([x.title, x.original_title, x.year, x.director, (x.actors || []).join(' '), (x.genres || []).join(' ')].join(' ')) };
  });
  return {
    html: '<div class="page"><div class="toolbar"><h1>Cerca</h1></div>' +
      '<div class="searchbox" style="margin-top:1rem"><input class="field f" id="q" data-key="search-input" autocomplete="off" aria-label="Cerca" ' +
      'placeholder="Titolo, regista, attore, genere o anno" value="' + esc(cache.searchQuery) + '"></div><div id="results"></div></div>',
    mount: function () {
      var input = document.getElementById('q'), out = document.getElementById('results');
      function run() {
        cache.searchQuery = input.value;
        var terms = norm(input.value).split(/\s+/).filter(Boolean);
        if (!terms.length) {
          var genres = topGenres(all);
          chunk = null;
          out.innerHTML = genres.length
            ? '<div class="browse"><h2>Oppure sfoglia per genere</h2>' + genres.map(function (g) {
                return '<button class="chip f" data-act="searchfor" data-arg="' + esc(g) + '" data-key="sg-' + esc(g) + '">' + esc(g) + '</button>';
              }).join('') + '</div>'
            : '<div class="empty"><p>Puoi cercare un titolo, una saga, un regista, un attore, un genere o un anno, in tutte le raccolte.</p></div>';
          return;
        }
        var found = all.filter(function (e) {
          return terms.every(function (t) { return e.hay.indexOf(t) >= 0; });
        }).map(function (e) { return e.x; });
        out.innerHTML = found.length
          ? gridHtml(found, 'search', focusMemory[location.hash]).replace(' data-autofocus', '')
          : '<div class="empty"><p>Nessun risultato per «' + esc(input.value) + '».</p></div>';
      }
      cache.searchRun = function (text) { input.value = text; run(); };
      input.addEventListener('input', run);
      run();
    }
  };
}

// ---------------------------------------------------------------- Correggi scheda

async function matchPage(kind, id) {
  var x = kind === 'movie' ? await api('/items/' + id) : await api('/shows/' + id);
  return {
    html: '<div class="page"><div class="toolbar"><h1>Correggi scheda</h1></div>' +
      '<div class="panel"><p>Scrivi il titolo giusto e scegli il risultato corretto.' +
      (x.filename ? ' File: <code>' + esc(x.filename) + '</code>' : '') + '</p>' +
      '<div class="inline"><input class="field f" id="mq" data-key="match-input" data-enter="matchsearch" autocomplete="off" value="' + esc(x.title) + '">' +
      '<button class="btn primary f" data-act="matchsearch" data-key="match-go">Cerca</button></div>' +
      '<div id="mres" style="margin-top:1.2rem"></div></div></div>',
    mount: function () {
      cache.match = { kind: kind, id: id };
      matchSearch();
    }
  };
}

async function matchSearch() {
  var input = document.getElementById('mq'), out = document.getElementById('mres');
  if (!input || !input.value.trim()) return;
  out.innerHTML = '<p>Cerco…</p>';
  try {
    var res = await api('/tmdb/search?kind=' + cache.match.kind + '&q=' + encodeURIComponent(input.value.trim()));
    out.innerHTML = res.length ? res.map(function (r) {
      return '<button class="result f" data-act="matchpick" data-arg="' + r.tmdb_id + '" data-key="res-' + r.tmdb_id + '">' +
        (r.poster ? '<img src="' + r.poster + '" alt="">' : '<span class="noimg"></span>') +
        '<span><b>' + esc(r.title) + '</b>' + (r.year ? ' (' + r.year + ')' : '') + '<p>' + esc(r.overview) + '</p></span></button>';
    }).join('') : '<p>Nessun risultato.</p>';
  } catch (e) {
    out.innerHTML = '<p>' + esc(e.message) + (/(chiave)/i.test(e.message) ? ' Vai in <b>Impostazioni</b> per inserirla.' : '') + '</p>';
  }
}

// ---------------------------------------------------------------- Impostazioni

// "Scarico locandine e schede dei film... 12 di 340" -> 4 (per cento); null se non si sa
function scanProgress(msg) {
  var m = /(\d+) di (\d+)/.exec(msg || '');
  return m && +m[2] ? Math.min(100, Math.round(+m[1] * 100 / +m[2])) : null;
}
function scanLabel(msg) {
  return String(msg || 'Leggo le cartelle').replace(/\.\.\.\s*/, '… ').trim();
}
function progressLine(pct) {
  return '<span class="actbar' + (pct === null ? ' indet' : '') + '"><i' + (pct === null ? '' : ' style="width:' + pct + '%"') + '></i></span>';
}

function scanStatus(i) {
  if (i.scanning) {
    var pct = scanProgress(i.message);
    return '<span class="scanline"><span class="spin" aria-hidden="true"></span>' + esc(scanLabel(i.message)) +
      (pct === null ? '' : ' · ' + pct + '%') + '</span>' + progressLine(pct);
  }
  if (i.message) return '<span class="nodot">' + esc(i.message) + '</span>';
  if (!i.last_scan) return '';
  var d = new Date(i.last_scan * 1000);
  return 'Ultimo controllo: ' + d.toLocaleDateString('it-IT') + ' alle ' + d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
}

function dot(ok) { return ok ? '<span class="okdot">●</span>' : '<span class="nodot">●</span>'; }

// ---------------------------------------------------------------- Persone e account
// Ogni persona ha un volto fisso: la sua iniziale su una tinta tenue tutta sua
// (dal nome), uguale nel menu, nelle impostazioni e nella scelta dalla TV.

function personInitial(name) {
  var s = String(name || '?').trim();
  return (s.charAt(0) || '?').toUpperCase();
}

function face(name, cls) {
  return '<i class="uface' + (cls ? ' ' + cls : '') + '" style="--h:' + hue(name) + '" aria-hidden="true">' + esc(personInitial(name)) + '</i>';
}

function ago(sec) {
  if (!sec) return 'mai';
  var s = Date.now() / 1000 - sec;
  if (s < 60) return 'adesso';
  if (s < 3600) { var m = Math.round(s / 60); return m + (m === 1 ? ' minuto fa' : ' minuti fa'); }
  if (s < 86400) { var h = Math.round(s / 3600); return h + (h === 1 ? ' ora fa' : ' ore fa'); }
  var d = Math.floor(s / 86400);
  if (d === 1) return 'ieri';
  if (d < 7) return d + ' giorni fa';
  return new Date(sec * 1000).toLocaleDateString('it-IT', { day: 'numeric', month: 'long' });
}

// Impostazioni → Catalogo: le schede si aggiornano da sole, e qui si vede come procede
function refreshPanel(i) {
  var c = i.catalog || {};
  var day = function (sec) { return sec ? new Date(sec * 1000).toLocaleDateString('it-IT', { day: 'numeric', month: 'long' }) : ''; };
  var nomatch = (i.unmatched || 0) + (c.unmatched_shows || 0);
  var ep = c.next_episode;
  return '<div class="panel"><h2>Aggiornamento automatico</h2>' +
    '<p>Le schede si ricontrollano da sole, poche alla volta e mai mentre qualcuno guarda: i titoli cambiati su TMDB, ' +
    'le serie in corso il giorno dopo ogni nuovo episodio, i titoli recenti ogni settimana, quelli degli ultimi due anni ogni mese, gli altri ogni sei mesi. ' +
    'Le correzioni fatte con «Correggi scheda» e le locandine tue (poster.jpg) restano.</p>' +
    '<dl class="kv">' +
      '<dt>Novità da TMDB</dt><dd>' + (c.changes_at ? 'Controllate ' + ago(c.changes_at) : 'Non ancora controllate') + '</dd>' +
      '<dt>Schede scaricate o aggiornate</dt><dd>' + (c.refreshed || 0) + ' negli ultimi 7 giorni' + (c.waiting ? ' · ' + c.waiting + ' in attesa del loro turno' : '') + '</dd>' +
      '<dt>Serie in corso</dt><dd>' + (c.ongoing ? c.ongoing + (ep ? ' · prossimo episodio: ' + esc(ep.title) + ' il ' + esc(day(Date.parse(ep.date) / 1000)) : '') : 'Nessuna') + '</dd>' +
      '<dt>Titoli senza scheda</dt><dd>' + (nomatch ? nomatch + ' · riprovo da solo' + (c.next_retry ? ' (prossimo tentativo ' + (c.next_retry * 1000 <= Date.now() ? 'al prossimo giro' : 'il ' + day(c.next_retry)) + ')' : '') +
        ' · se sono sbagliati, menu della locandina → «Correggi scheda»' : 'Nessuno') + '</dd>' +
    '</dl></div>';
}

// Come sta il profilo rispetto all'account: {state: '' | ok | warn, text}
function syncState() {
  var u = auth && auth.user;
  if (!u) return null;
  if (!u.linked) return { state: 'local', text: 'Solo su questo PC' };
  if (u.must_change) return { state: 'warn', text: 'Scegli la tua password per sincronizzare' };
  if (!u.online) return { state: 'warn', text: 'Ridai la password per sincronizzare' };
  if (auth.offline) {
    return { state: 'warn', text: 'Offline · si sincronizza quando torna la rete' + (u.last_sync ? ' (ultima volta ' + whenDate(u.last_sync) + ')' : '') };
  }
  if (u.pending) return { state: 'ok', text: 'Sincronizzazione in corso' };
  return { state: 'ok', text: u.last_sync ? 'Sincronizzato ' + ago(u.last_sync) : 'Sincronizzazione in corso' };
}

// La voce del profilo nel menu laterale: il volto e il nome di chi sta guardando
function markMe() {
  var el = document.getElementById('navme');
  if (!el) return;
  var u = auth && auth.user;
  el.hidden = !u;
  if (!u) return;
  var html = face(u.name) + '<span>' + esc(u.name) + '</span>';
  if (el.getAttribute('data-sig') !== html) {
    el.innerHTML = html;
    el.setAttribute('data-sig', html);
  }
}

// Password provvisoria facile da dettare: tre gruppi di lettere e numeri
function tempPassword() {
  var chars = 'abcdefghjkmnpqrstuvwxyz23456789', out = [];
  var rnd = new Uint32Array(12);
  (window.crypto || window.msCrypto).getRandomValues(rnd);
  for (var i = 0; i < 12; i++) out.push(chars[rnd[i] % chars.length]);
  return out.slice(0, 4).join('') + '-' + out.slice(4, 8).join('') + '-' + out.slice(8).join('');
}

// Copia negli appunti anche dove il browser non lo permette (indirizzo di casa senza https)
function copyText(text) {
  function fallback() {
    var t = document.createElement('textarea');
    t.value = text;
    t.setAttribute('readonly', '');
    t.style.position = 'fixed';
    t.style.opacity = '0';
    document.body.appendChild(t);
    t.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { /* niente */ }
    document.body.removeChild(t);
    return ok;
  }
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text).then(function () { return true; }, fallback);
  }
  return Promise.resolve(fallback());
}

// Dopo aver creato un account (o dato una nuova password): nome e password da comunicare
function showSecret(title, name, pass) {
  cache.secret = 'Nome utente: ' + name + '\nPassword provvisoria: ' + pass;
  modalState = { options: [], onPick: function () {}, returnFocus: document.activeElement };
  modal.innerHTML = '<div class="sheet secret"><h3>' + esc(title) + '</h3>' +
    '<div class="secretbody">' + face(name, 'big') +
      '<dl><dt>Nome utente</dt><dd>' + esc(name) + '</dd><dt>Password provvisoria</dt><dd class="pw num">' + esc(pass) + '</dd></dl></div>' +
    '<p class="secretnote">Comunicala tu. Al primo accesso ' + esc(name) + ' sceglierà una password sua.</p>' +
    '<div class="actions"><button class="btn primary f" data-act="copysecret" data-key="copysecret">Copia nome e password</button>' +
    '<button class="btn f" data-act="closemodal" data-key="closesecret">Fatto</button></div></div>';
  modal.hidden = false;
  var first = modal.querySelector('.btn');
  if (first) first.focus();
}

// ---------------------------------------------------------------- Impostazioni: aree
// Ogni area ha la sua vista (#/settings/<area>) con il suo nome come titolo.
// La panoramica (#/settings) dice com'e' messa ogni area e cosa va guardato.

function settingsAreas() {
  var out = [];
  if (auth && auth.user) out.push(['account', 'Account']);
  if (auth && auth.user && auth.user.admin && !TV) out.push(['people', 'Persone']);
  out.push(['libraries', 'Raccolte'], ['catalog', 'Catalogo e schede'], ['subtitles', 'Sottotitoli'],
    ['friends', 'Amici'], ['updates', 'Aggiornamenti'], ['device', TV ? 'Questa TV' : 'Questo dispositivo']);
  return out;
}

var CHEVRON = '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';

// Un'icona per ogni area delle impostazioni: si riconoscono a colpo d'occhio
var SICON = {
  home: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.2"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.2"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.2"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.2"/>',
  account: '<circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20c.8-3.8 3.8-6 7.5-6s6.7 2.2 7.5 6"/>',
  people: '<circle cx="9" cy="8.5" r="3.3"/><path d="M3 19.5c.6-3.3 3-5.3 6-5.3s5.4 2 6 5.3M15.5 5.6a3.3 3.3 0 0 1 0 6.1M17.6 14.6c1.8.7 3 2.4 3.4 4.9"/>',
  libraries: '<path d="M3.5 7v11h17V9h-8l-2-2z"/>',
  catalog: '<rect x="4.5" y="3.5" width="15" height="17" rx="1.8"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  subtitles: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M6.5 12.5h3M11.5 12.5h6M6.5 15.5h7M15.5 15.5h2"/>',
  friends: '<circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="m8.2 10.8 7.6-3.6M8.2 13.2l7.6 3.6"/>',
  updates: '<path d="M20 11a8 8 0 0 0-14.5-4.5M4 13a8 8 0 0 0 14.5 4.5M5.5 3v3.5H9M18.5 21v-3.5H15"/>',
  device: '<rect x="3" y="4.5" width="18" height="12" rx="1.6"/><path d="M8.5 20h7M12 16.5V20"/>'
};
function sicon(area) {
  return SICON[area] ? '<svg class="sic" viewBox="0 0 24 24" aria-hidden="true">' + SICON[area] + '</svg>' : '';
}

function settingsShell(area, title, sub, body) {
  var nav = settingsAreas().map(function (a) {
    var on = a[0] === area;
    return '<a class="snav f' + (on ? ' on' : '') + '"' + (on ? ' aria-current="page"' : '') + ' href="#/settings/' + a[0] + '" data-key="snav-' + a[0] + '">' +
      (a[0] === 'account' && auth && auth.user ? face(auth.user.name) : sicon(a[0])) + '<span>' + esc(a[1]) + '</span></a>';
  }).join('');
  return '<div class="page settings"><div class="sgrid">' +
    '<nav class="scol" aria-label="Aree delle impostazioni"><a class="snav home f" href="#/settings" data-key="snav-home">' + sicon('home') + '<span>Panoramica</span></a>' + nav + '</nav>' +
    '<div class="smain"><a class="sup f" href="#/settings" data-key="sup">' + IC.back + 'Impostazioni</a>' +
    '<h1 class="stitle">' + esc(title) + '</h1>' + (sub ? '<p class="ssub">' + sub + '</p>' : '') + body + '</div></div></div>';
}

function settingsData() {
  return Promise.all([api('/info'), loadLibs(true), api('/update').catch(function () { return null; }),
    api('/sharing').catch(function () { return null; })]);
}

// Una riga della panoramica: area, nome, a cosa serve, com'e' adesso
function settingsRows(i, u, sh) {
  var rows = [];
  var s = syncState();
  if (auth && auth.user && auth.user.linked) {
    rows.push({ area: 'account', face: auth.user.name, label: auth.user.name,
      desc: auth.user.admin ? 'Il tuo account · amministratore' : 'Il tuo account', value: s.text, state: s.state });
  } else if (auth && auth.user) {
    rows.push({ area: 'account', face: auth.user.name, label: auth.user.name,
      desc: 'Profilo di questo PC, senza account', value: auth.cloud ? 'Entra con un account' : s.text, state: '' });
  }
  if (auth && auth.user && auth.user.admin && !TV) {
    rows.push({ area: 'people', label: 'Persone', desc: 'Chi può entrare, password provvisorie', value: 'Gestisci', state: '' });
  }
  var off = 0, films = 0, series = 0, away = 0;
  libs.forEach(function (l) {
    films += l.movies || 0;
    series += l.shows || 0;
    (l.folders || []).forEach(function (f) { if (!f.online) off++; });
    if (l.mine !== false) away += (l.missing || []).length;
  });
  rows.push({ area: 'libraries', label: 'Raccolte',
    desc: away ? (away === 1 ? 'Una cartella sta su un altro PC' : away + ' cartelle stanno su altri PC') : 'Le cartelle dei video di questo PC',
    value: off ? (off === 1 ? 'Una cartella non raggiungibile' : off + ' cartelle non raggiungibili')
      : (libs.length ? libs.length + (libs.length === 1 ? ' raccolta' : ' raccolte') : 'Nessuna raccolta'),
    state: off || !libs.length ? 'warn' : 'ok' });
  rows.push({ area: 'catalog', label: 'Catalogo e schede',
    desc: films + ' film · ' + series + ' serie · ' + i.episodes + ' episodi',
    value: i.scanning ? 'Lettura in corso…' : (i.tmdb ? 'Schede attive' : 'Schede non attive'),
    state: i.scanning ? '' : (i.tmdb ? 'ok' : 'warn') });
  rows.push({ area: 'subtitles', label: 'Sottotitoli', desc: 'Da internet, con OpenSubtitles',
    value: i.subs_online ? 'Attivi' : 'Non attivi', state: i.subs_online ? 'ok' : '' });
  if (sh) {
    var pending = sh.accounts.filter(function (a) { return !a.approved; }).length;
    shareRequests = pending;
    markRequests();
    rows.push({ area: 'friends', label: 'Amici', desc: 'Raccolte condivise con altre case',
      value: !sh.on ? 'Spenta' : (pending ? (pending === 1 ? 'Una richiesta da approvare' : pending + ' richieste da approvare')
        : (friends.length ? friends.length + (friends.length === 1 ? ' amico collegato' : ' amici collegati') : 'Attiva')),
      state: pending ? 'warn' : (sh.on ? 'ok' : '') });
  }
  if (u && u.enabled) {
    rows.push({ area: 'updates', label: 'Aggiornamenti', desc: 'BunkerPlex ' + i.version,
      value: u.error || u.access === false ? 'Da controllare' : (u.phase ? 'In corso' : (u.available ? 'Aggiornamento disponibile' : 'Aggiornato')),
      state: u.error || u.access === false || u.available || u.phase ? 'warn' : 'ok' });
  }
  var tvOld = TV && i.apk_version > (+tvCall('getVersion') || 0);
  rows.push({ area: 'device', label: TV ? 'Questa TV' : 'Questo dispositivo', desc: 'Animazioni, locandine, collegamento',
    value: tvOld ? 'App da aggiornare' : 'Animazioni ' + labelOf(ANIMS, device.anim).toLowerCase(), state: tvOld ? 'warn' : '' });
  return rows;
}

// L'app per la TV (e per i telefoni Android): indirizzo e QR da inquadrare
async function apkPanel(title) {
  var link = await api('/apk-link').catch(function () { return null; });
  if (!link || !link.apk) {
    return '<div class="panel"><h2>' + title + '</h2><p>App non ancora compilata: avvia <b>Compila APK.bat</b> sul PC.</p></div>';
  }
  if (!link.url) {
    return '<div class="panel"><h2>' + title + '</h2><p>Non conosco ancora l\'indirizzo di questo PC nella rete di casa: rilancia «Installa BunkerPlex» sul computer, oppure apri questa pagina da un altro dispositivo di casa.</p></div>';
  }
  return '<div class="panel"><h2>' + title + '</h2><div class="apkqr">' +
    (link.svg ? '<div class="qrtile" role="img" aria-label="Codice QR per scaricare l\'app">' + link.svg + '</div>' : '') +
    '<div class="apktext"><p>Inquadra il codice con la fotocamera del telefono: scarica l\'app da questo PC. Sulla TV invece apri lo stesso indirizzo con l\'app «Downloader».</p>' +
    '<p class="apkurl num">' + esc(link.url) + '</p>' +
    (TV ? '' : '<div class="actions" style="margin-top:.4rem"><a class="btn f" href="/BunkerPlex.apk" download data-key="apk">Scarica BunkerPlex.apk</a></div>') +
    '</div></div></div>';
}

function networkPanel(n) {
  if (!n) return '';
  return '<div class="panel"><h2>Indirizzi di questo PC</h2><dl class="kv">' +
    '<dt>IP privato<small>nella rete di casa: lo usano TV e telefoni</small></dt><dd class="num">' +
      (n.private ? esc(n.private) + '<small>porta ' + n.port + '</small>' : '<span class="nodot">non lo conosco ancora</span><small>rilancia «Installa BunkerPlex»</small>') + '</dd>' +
    '<dt>IP pubblico<small>su Internet: lo usano solo gli amici</small></dt><dd class="num">' +
      (n.public ? esc(n.public) + '<small>' + (n.public_source === 'router' ? 'dal router' : 'dal servizio account') + (n.friends_open ? ' · porta amici ' + n.friends_port + ' aperta' : '') + '</small>'
        : '<span class="nodot">non raggiungibile</span><small>niente Internet?</small>') + '</dd>' +
    '</dl><p class="kvnote">Da fuori casa si entra solo dalla porta degli amici: non aprire mai la ' + n.port + ' sul router.</p></div>';
}

async function settings() {
  var res = await Promise.all([settingsData(), api('/network').catch(function () { return null; })]);
  var net = res[1];
  res = res[0];
  var rows = settingsRows(res[0], res[2], res[3]);
  var warn = rows.filter(function (r) { return r.state === 'warn'; });
  var s = syncState();
  var finding = warn.length
    ? (warn.length === 1 ? 'Da guardare: ' : warn.length + ' cose da guardare · prima: ') + esc(warn[0].label) + ', ' + esc(warn[0].value.charAt(0).toLowerCase() + warn[0].value.slice(1))
    : 'Tutto in ordine' + (s && s.state === 'ok' ? ' · ' + esc(s.text.charAt(0).toLowerCase() + s.text.slice(1)) : '');
  return '<div class="page settings"><div class="soverview">' +
    '<h1 class="stitle">Impostazioni</h1><p class="ssub' + (warn.length ? ' warn' : '') + '">' + finding + '</p>' +
    '<div class="slist">' + rows.map(function (r, n) {
      return '<a class="srow f"' + (n === 0 ? ' data-autofocus' : '') + ' href="#/settings/' + r.area + '" data-key="srow-' + r.area + '">' +
        (r.face ? face(r.face, 'mid') : '') +
        '<span class="stext"><b>' + esc(r.label) + '</b><small>' + esc(r.desc) + '</small></span>' +
        '<span class="sval' + (r.state ? ' ' + r.state : '') + '">' + esc(r.value) + '</span>' + CHEVRON + '</a>';
    }).join('') + '</div>' + networkPanel(net) + '</div></div>';
}

async function settingsArea(area) {
  if (area === 'people') return peopleArea();
  var res = await settingsData();
  var i = res[0];
  var inAccount = !!(auth && auth.user && auth.user.linked);
  var manyProfiles = !!(auth && auth.profiles && auth.profiles.length > 1);
  var known = settingsAreas().some(function (a) { return a[0] === area; });
  if (!known) { location.replace('#/settings'); return ''; }

  if (area === 'account') return accountArea(i);

  if (area === 'libraries') {
    var libsHtml = libs.map(function (l) {
      var what = [l.movies ? l.movies + ' film' : '', l.shows ? l.shows + ' serie' : ''].filter(Boolean).join(' · ') || 'ancora vuota';
      var k = 'lib-' + l.id;
      if (l.mine === false) {       // raccolta di un altro account di questo PC, condivisa con te
        return '<div class="lib"><div class="head">' + avatar(l.name) +
          '<div class="name"><b>' + esc(l.name) + '</b><small>' + what + ' · condivisa da un altro account di questo PC</small></div></div></div>';
      }
      return '<div class="lib"><div class="head">' + avatar(l.name) +
        '<div class="name"><b>' + esc(l.name) + '</b><small>' + what + (manyProfiles && l.shared ? ' · la vedono anche gli altri profili di questo PC' : '') + '</small></div>' +
        (manyProfiles ? '<button class="btn f" data-act="libshare" data-arg="' + l.id + ':' + (l.shared ? 0 : 1) + '" data-key="' + k + '-share">' + (l.shared ? 'Non condividere' : 'Condividi') + '</button>' : '') +
        '<a class="btn f" href="#/browse/' + l.id + '" data-key="' + k + '-add">+ Cartella</a>' +
        '<button class="btn f" data-act="refreshmenu" data-arg="' + l.id + '" data-key="' + k + '-upd">Aggiorna</button>' +
        '<a class="btn f" href="#/rename/' + l.id + '" data-key="' + k + '-ren">Rinomina</a>' +
        '<button class="btn danger f" data-act="dellib" data-arg="' + l.id + '" data-key="' + k + '-del">Elimina</button></div>' +
        (l.folders.length ? l.folders.map(function (f, n) {
          return '<div class="folder"><div class="where"><b>' + esc(f.display) + '</b><small>' +
            (f.online ? dot(true) + ' ' + f.count + ' video'
              : dot(false) + (f.moved_to ? ' il percorso è cambiato: ora la cartella è in <b>' + esc(f.moved_display) + '</b>' : ' non raggiungibile (disco scollegato?)') +
                ' · ' + f.count + ' video in catalogo') +
            '</small></div>' +
            (f.moved_to ? '<button class="btn primary f" style="margin-right:.5rem" data-act="relocate" data-arg="' + l.id + ':' + n + '" data-key="' + k + '-m' + n + '">Usa il nuovo percorso</button>' : '') +
            '<button class="btn f" data-act="delfolder" data-arg="' + l.id + ':' + n + '" data-key="' + k + '-f' + n + '">Togli</button></div>';
        }).join('') : (l.missing && l.missing.length ? '' : '<div class="folder"><div class="where"><small>Nessuna cartella: premi «+ Cartella».</small></div></div>')) +
        // Cartelle della raccolta che stanno su un altro PC dell'account
        (l.missing || []).map(function (m, n) {
          return '<div class="folder elsewhere"><div class="where"><b>' + esc(m) + '</b><small>Su un altro PC del tuo account: qui non la trovo</small></div>' +
            '<a class="btn f" style="margin-right:.5rem" href="#/browse/' + l.id + '?replace=' + encodeURIComponent(m) + '" data-key="' + k + '-x' + n + '">Scegli dove sta qui</a>' +
            '<button class="btn f" data-act="dropmissing" data-arg="' + l.id + ':' + n + '" data-key="' + k + '-y' + n + '">Togli dall\'account</button></div>';
        }).join('') +
        '</div>';
    }).join('');
    var elsewhere = libs.reduce(function (sum, l) { return sum + (l.mine === false ? 0 : (l.missing || []).length); }, 0);
    var accountPanelHtml = inAccount
      ? '<div class="panel"><h2>Raccolte nel tuo account</h2>' +
        '<p>Nomi e cartelle delle tue raccolte seguono il tuo account: sugli altri PC le ritrovi già create, e le cartelle con lo stesso percorso (anche su un disco con un\'altra lettera) si collegano da sole.' +
        (elsewhere ? ' Qui ' + (elsewhere === 1 ? 'manca una cartella che sta' : 'mancano ' + elsewhere + ' cartelle che stanno') + ' su altri PC.' : '') + '</p>' +
        '<p>Se l\'elenco online non ti torna, puoi rimetterlo uguale a quello di questo PC. Visti, punti di ripresa e La mia lista non cambiano.</p>' +
        '<div class="actions" style="margin-top:.4rem"><button class="btn danger f" data-act="pushlocal" data-key="pushlocal">Sovrascrivi l\'account con le raccolte di questo PC</button></div></div>'
      : '';
    return settingsShell('libraries', 'Raccolte',
      'Ogni raccolta è una sezione del tuo cinema, con una o più cartelle di questo PC. BunkerPlex legge soltanto: non modifica né cancella mai i tuoi file.',
      '<div class="panel">' + (libsHtml || '<p>Ancora nessuna raccolta su questo PC.</p>') +
      '<div class="actions" style="margin-top:.6rem"><a class="btn primary f" href="#/newlib" data-key="new-lib">+ Aggiungi raccolta</a></div></div>' +
      accountPanelHtml);
  }

  if (area === 'catalog') {
    return settingsShell('catalog', 'Catalogo e schede', i.tmdb
      ? dot(true) + ' Locandine, trame, cast, generi e voti si scaricano da soli' + (i.tmdb_hint ? ' (chiave ' + esc(i.tmdb_hint) + ')' : '') + '.'
      : dot(false) + ' Schede non attive: i film compaiono con un fotogramma, senza trama né cast.',
      '<div class="panel"><div class="stats">' +
        '<div class="stat"><b class="num">' + i.movies + '</b><span>film</span></div>' +
        '<div class="stat"><b class="num">' + i.shows + '</b><span>serie TV</span></div>' +
        '<div class="stat"><b class="num">' + i.episodes + '</b><span>episodi</span></div>' +
        (i.tmdb && i.unmatched ? '<div class="stat"><b class="num">' + i.unmatched + '</b><span>film senza scheda</span></div>' : '') +
      '</div>' +
      '<p id="scanmsg">' + scanStatus(i) + '</p>' +
      '<div class="actions" style="margin-top:0">' +
        '<button class="btn f" data-act="scan" data-key="scan">Cerca file nuovi</button>' +
        '<button class="btn f" data-act="refreshall" data-key="refreshall">Riscarica tutte le schede</button>' +
      '</div></div>' + (i.tmdb ? refreshPanel(i) : '') +
      '<div class="panel"><h2>Chiave TMDB</h2>' +
      '<p>Serve una chiave gratuita di <b>themoviedb.org</b>: crea un account, poi Impostazioni → API → copia la «Chiave API» e incollala qui.' +
        (inAccount ? ' Resta nel tuo account: sugli altri PC dove entri non va rimessa.' : '') +
        (TV ? ' È più comodo farlo dal PC: apri <b>http://' + esc(location.host) + '</b> nel browser.' : '') + '</p>' +
      '<div class="inline"><input class="field f" id="tmdbkey" data-key="tmdbkey" data-enter="savekey" autocomplete="off" placeholder="' +
        (i.tmdb ? 'Nuova chiave API (per cambiarla)' : 'Chiave API TMDB') + '">' +
      '<button class="btn f" data-act="savekey" data-key="savekey">Salva</button></div></div>');
  }

  if (area === 'subtitles') {
    return settingsShell('subtitles', 'Sottotitoli', i.subs_online
      ? dot(true) + ' Attivi' + (i.subs_user ? ' con l\'account ' + esc(i.subs_user) : ' senza account (pochi download al giorno)') + ': nel film apri Opzioni → «Cerca sottotitoli su internet».'
      : 'Non attivi. Con una chiave gratuita di OpenSubtitles scarichi i sottotitoli in italiano o in altre lingue dalle Opzioni del film.',
      '<div class="panel"><h2>OpenSubtitles</h2>' +
      '<p>Crea un account su <b>opensubtitles.com</b>, poi Profilo → «API consumers» → crea una chiave e incollala qui. ' +
        'Nome utente e password sono facoltativi ma alzano il limite di download giornaliero. ' +
        (inAccount ? 'Restano nel tuo account: li ritrovi su ogni PC dove entri.' : 'Restano solo su questo PC.') +
        (TV ? ' È più comodo farlo dal PC: apri <b>http://' + esc(location.host) + '</b> nel browser.' : '') + '</p>' +
      '<label class="flabel" for="oskey">Chiave API</label>' +
      '<input class="field f" style="margin-bottom:1rem" id="oskey" data-key="oskey" autocomplete="off" placeholder="' +
        (i.subs_online ? 'Lascia vuoto per tenere quella di adesso' : 'Chiave API OpenSubtitles') + '">' +
      '<label class="flabel" for="osuser">Nome utente (facoltativo)</label>' +
      '<input class="field f" style="margin-bottom:1rem" id="osuser" data-key="osuser" autocomplete="off" value="' + esc(i.subs_user || '') + '">' +
      '<label class="flabel" for="ospass">Password (facoltativa)</label>' +
      '<input class="field f" id="ospass" data-key="ospass" type="password" autocomplete="new-password" data-enter="saveos" placeholder="' +
        (i.subs_user ? 'Lascia vuoto per tenere quella di adesso' : '') + '">' +
      '<div class="actions"><button class="btn primary f" data-act="saveos" data-key="saveos">Salva</button>' +
        (i.subs_online ? '<button class="btn danger f" data-act="saveos" data-arg="remove" data-key="osremove">Disattiva</button>' : '') +
      '</div></div>');
  }

  if (area === 'friends') {
    var sh = res[3];
    if (!sh) return settingsShell('friends', 'Amici', '', '<div class="panel"><p>La condivisione con gli amici non risponde in questo momento.</p></div>');
    var af = auth.cloud ? await api('/account-friends').catch(function () { return null; }) : null;
    var legacy = friendsPanel(sh)
      .replace('<h2>Amici</h2>', '<h2>' + (af && af.linked ? 'Collegamenti con indirizzo e password' : 'Amici') + '</h2>')
      .replace(/<p>Tu e un amico con BunkerPlex[\s\S]*?<\/p>/, af && af.linked
        ? '<p>Il sistema di prima, per chi non ha un account sul tuo servizio o se usate Tailscale: si scrive l\'indirizzo dell\'amico e ci si registra da lui. ' +
          'L\'interruttore qui sotto apre o chiude la porta per gli amici di tutto il PC.</p>' : '');
    return settingsShell('friends', 'Amici',
      'Tu e un amico con BunkerPlex guardate ciascuno le raccolte dell\'altro, anche da case diverse. Si guarda soltanto.',
      accountFriendsPanel(af, sh) + legacy);
  }

  if (area === 'updates') {
    var u = res[2];
    return settingsShell('updates', 'Aggiornamenti', 'BunkerPlex ' + esc(i.version) + ' su questo PC.' +
        (i.updated ? ' <a class="link f" href="#/news" data-key="upd-news">Novità dell\'ultimo aggiornamento</a>' : ''),
      (u && u.enabled ? updatePanel(u).replace('<h2>Aggiornamenti</h2>', '') : '<div class="panel"><p>Gli aggiornamenti automatici non sono configurati su questo PC.</p></div>') +
      (TV ? '' : await apkPanel('App per la TV e per il telefono')));
  }

  // Questo dispositivo: preferenze di visione e collegamento al server
  return settingsShell('device', TV ? 'Questa TV' : 'Questo dispositivo', '',
    devicePanel().replace(/<h2>Questo dispositivo<\/h2>/, '<h2>Preferenze di visione</h2>') +
    '<div class="panel"><h2>Collegamento</h2>' +
    '<dl class="kv"><dt>Server</dt><dd>http://' + esc(location.host) + '</dd><dt>Programma</dt><dd>' + esc(i.name) + ' ' + esc(i.version) + '</dd>' +
    (TV ? '<dt>App su questa TV</dt><dd>' + esc(tvCall('getVersionName') || 'precedente') +
      (i.apk_version > (+tvCall('getVersion') || 0) ? ' · <span class="nodot">sul PC ce n\'è una più nuova</span>' : (i.apk_version ? ' · aggiornata' : '')) + '</dd>' : '') +
    '</dl>' +
    (TV ? '<div class="actions"><button class="btn f" data-act="checkupdate" data-key="checkupdate">Controlla aggiornamenti</button>' +
      '<button class="btn f" data-act="resetserver" data-key="resetserver">Cambia server</button></div>' : '') +
    '</div>' + (TV ? await apkPanel('L\'app sul telefono') : ''));
}

function accountArea(i) {
  var u = auth.user, s = syncState();
  var prefs = prefsSummary(sharedPrefs());
  var many = (auth.profiles || []).length > 1;
  var who = '<div class="panel who">' + face(u.name, 'big') +
    '<div class="whotext"><h2>' + esc(u.name) + '</h2>' +
    '<p>' + (u.linked ? (u.admin ? 'Account amministratore' : 'Account') : 'Profilo di questo PC') + ' · ' + esc(auth.server || 'BunkerPlex') + '</p>' +
    '<p class="sync ' + s.state + '">' + esc(s.text) + '</p></div></div>';
  var profile = '<div class="panel"><h2>Profilo</h2>' +
    (u.linked ? '' : '<label class="flabel" for="pname">Nome</label>' +
      '<div class="inline"><input class="field f" id="pname" data-key="pname" data-enter="renameprofile" autocomplete="off" maxlength="24" value="' + esc(u.name) + '">' +
      '<button class="btn f" data-act="renameprofile" data-key="renameprofile">Rinomina</button></div>') +
    '<div class="actions">' +
      '<button class="btn f" data-act="logout" data-key="logout">Cambia profilo</button>' +
      (many ? '<button class="btn danger f" data-act="delprofile" data-key="delprofile">Togli questo profilo da qui</button>' : '') +
    '</div></div>';

  if (!u.linked) {
    var join = !auth.cloud ? '' : '<div class="panel"><h2>Entra con un account</h2>' +
      '<p>Funziona tutto anche senza: il login è facoltativo. Con un account questo profilo ti segue su ogni PC e TV, ' +
      'anche su un\'installazione nuova, e riprendi esattamente da dove eri:</p>' +
      '<dl class="kv"><dt>Impostazioni e chiavi</dt><dd>TMDB, sottotitoli, preferenze di visione</dd>' +
      '<dt>Visti, ripresa e La mia lista</dt><dd>Anche quelli fatti senza Internet, appena torna la rete</dd>' +
      '<dt>Raccolte</dt><dd>Nomi e cartelle, ritrovate da sole sugli altri PC</dd>' +
      '<dt>Amici</dt><dd>La condivisione delle raccolte con gli amici</dd></dl>' +
      '<p class="kvnote">Quello che hai già qui non si perde: si unisce a quello dell\'account, e per ogni voce vince la modifica più recente.</p>' +
      (auth.offline ? '<p><span class="nodot">●</span> Ora il PC non raggiunge il servizio account: per entrare serve Internet.</p>' :
        (TV ? '<div class="actions"><a class="btn primary f" href="#/tvlogin" data-key="tvlogin">Entra dal telefono</a></div>' +
          '<h2 style="margin-top:1.2rem">Oppure scrivi qui nome e password</h2>' : '') + accountForm('', false)) +
      '</div>';
    return settingsShell('account', 'Account', '', who + join + profile);
  }

  var relogin = u.online ? '' : '<div class="panel"><h2>Ridai la password</h2>' +
    '<p>L\'account è stato aperto con una password diversa (cambiata su un altro PC, o nuova provvisoria). ' +
    'Il profilo funziona lo stesso; per riprendere la sincronizzazione scrivi la password.</p>' + accountForm(u.name, true) + '</div>';
  return settingsShell('account', 'Account', '', who + relogin +
    '<div class="panel"><h2>Ti segue su ogni PC</h2>' +
      '<dl class="kv">' +
        '<dt>Chiave TMDB</dt><dd>' + (i.tmdb ? 'Attiva · ' + esc(i.tmdb_hint) : '<a class="link f" href="#/settings/catalog" data-key="kv-tmdb">Non impostata</a>') + '</dd>' +
        '<dt>Sottotitoli da internet</dt><dd>' + (i.subs_online ? 'Attivi' + (i.subs_user ? ' · ' + esc(i.subs_user) : '') : 'Non attivi') + '</dd>' +
        '<dt>Preferenze di visione</dt><dd>' + esc(prefs.charAt(0).toUpperCase() + prefs.slice(1)) + '</dd>' +
        '<dt>Visti, ripresa e La mia lista</dt><dd>' + (s.state === 'warn' ? 'Su questo PC, partono appena si può' : 'Sincronizzati') + '</dd>' +
        '<dt>Raccolte</dt><dd>Nomi e cartelle</dd>' +
      '</dl>' +
      '<p class="kvnote">Senza Internet si continua come sempre: le modifiche si uniscono da sole al ritorno della rete.</p></div>' +
    '<div class="panel"><h2>Accesso</h2>' +
      '<button class="setting f" data-act="tvquick" data-arg="' + (u.tv_quick ? 0 : 1) + '" data-key="tvquick">In «Chi guarda?» si entra scegliendo il tuo nome<small>' +
        (u.tv_quick ? 'Sì, senza password' : 'No, serve la password') + '</small></button>' +
      '<div class="actions">' +
        (TV || !u.online ? '' : '<a class="btn f" href="#/password" data-key="pwchange">Cambia password</a>') +
        '<button class="btn f" data-act="unlink" data-key="unlink">Scollega l\'account</button>' +
      '</div></div>' + profile);
}

async function peopleArea() {
  if (!auth || !auth.user || !auth.user.admin) throw new Error('Solo l\'amministratore può gestire gli account.');
  var list;
  try { list = await api('/accounts'); } catch (e) {
    return settingsShell('people', 'Persone', '', '<div class="panel"><p><span class="nodot">●</span> ' + esc(e.message) + '</p></div>');
  }
  cache.accounts = list;
  var me = auth.user.name.toLowerCase();
  var waiting = list.filter(function (a) { return a.must_change; }).length;
  var rows = list.map(function (a) {
    var isMe = a.username.toLowerCase() === me;
    return '<div class="acct">' + face(a.username, 'mid') +
      '<div class="ptext"><b>' + esc(a.username) + '</b>' +
        (isMe ? '<span class="pill">Tu</span>' : '') +
        (a.admin ? '<span class="pill">Amministratore</span>' : '') +
        (a.must_change ? '<span class="pill warn">Password provvisoria</span>' : '') +
        '<small>' + (a.last_seen ? 'Ultimo accesso ' + ago(a.last_seen) : 'Non è ancora entrato') + ' · ' +
          a.servers + (a.servers === 1 ? ' PC collegato' : ' PC collegati') + '</small></div>' +
      '<div class="pacts"><button class="btn f" data-act="accreset" data-arg="' + a.id + '" data-key="accr-' + a.id + '">Nuova password provvisoria</button>' +
        (isMe ? '' : '<button class="btn danger f" data-act="accremove" data-arg="' + a.id + '" data-key="accd-' + a.id + '">Elimina</button>') +
      '</div></div>';
  }).join('');
  cache.newAdmin = false;
  return settingsShell('people', 'Persone',
    list.length + (list.length === 1 ? ' account' : ' account') + (waiting ? ' · ' + waiting + (waiting === 1 ? ' deve ancora scegliere la sua password' : ' devono ancora scegliere la loro password') : '') +
      '. Ognuno ha le sue raccolte, impostazioni, visti e lista.',
    '<div class="panel accts">' + rows + '</div>' +
    '<div class="panel"><h2>Nuovo account</h2>' +
      '<label class="flabel" for="aname">Nome utente</label>' +
      '<input class="field f" style="margin-bottom:1rem" id="aname" data-key="aname" autocomplete="off" maxlength="32" placeholder="Lettere, numeri, punto, trattino">' +
      '<label class="flabel" for="apass">Password provvisoria</label>' +
      '<div class="joined"><input class="field f num" id="apass" data-key="apass" autocomplete="off" value="' + tempPassword() + '">' +
        '<button class="btn f" data-act="regenpass" data-key="regenpass">Un\'altra</button></div>' +
      '<p class="kvnote">Al primo accesso la cambierà con una sua.</p>' +
      '<button class="setting f" data-act="accadmin" data-key="accadmin">Può gestire gli account (amministratore)<small id="accadminv">No</small></button>' +
      '<div class="actions"><button class="btn primary f" data-act="acccreate" data-key="acccreate">Crea account</button></div></div>');
}

// Amici: due BunkerPlex in case diverse si mostrano a vicenda le raccolte.
// Si manda una richiesta, l'altro la accetta, e da li' in poi fa tutto da solo.
var QUALITIES = [['720', '720p (consigliata: leggera per la linea dell\'amico)'], ['1080', '1080p'], ['orig', 'Originale (serve una linea molto veloce)']];

function whenSeen(sec) {
  if (!sec) return 'mai collegato';
  var d = new Date(sec * 1000);
  return 'ultimo accesso ' + d.toLocaleDateString('it-IT') + ' alle ' + d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
}

// Come si arriva a questo server da fuori casa: la porta aperta sul router, oppure no
function reachState(sh) {
  var pm = sh.portmap || {};
  if (!sh.on) return 'La condivisione è spenta: da fuori non entra nessuno.';
  if (sh.manual) return dot(true) + ' Gli amici ti raggiungono a <b>' + esc(sh.address) + '</b> (indirizzo scritto da te).';
  if (!sh.auto_port) return 'Apertura automatica spenta: scrivi tu il tuo indirizzo (per esempio quello di Tailscale) quando mandi una richiesta.';
  if (pm.ok && pm.public) {
    return dot(true) + ' Porta aperta sul router (' + esc(pm.method) + '). Gli amici ti raggiungono a <b>' + esc(sh.address) + '</b>' +
      (sh.tls ? ', con collegamento cifrato.' : '. Attenzione: collegamento non cifrato.');
  }
  if (pm.error) return dot(false) + ' Non riesco ad aprire la porta da solo: ' + esc(pm.error) + '.';
  return 'Sto chiedendo al router di aprire la porta…';
}

// Gli amici dell'account: si aggiungono col nome del loro account, accettano da un
// loro PC, e da li' in poi le loro raccolte compaiono da sole (anche se cambia l'indirizzo)
function accountFriendsPanel(af, sh) {
  if (!af) return '';
  var head = '<div class="panel"><h2>I tuoi amici</h2>';
  if (!af.linked) {
    return head + '<p>Con un account aggiungi gli amici scrivendo il nome del loro account: niente indirizzi né password da scambiarsi, ' +
      'e le loro raccolte si ritrovano da sole anche quando cambia l\'indirizzo di casa.</p>' +
      '<div class="actions"><a class="btn f" href="#/settings/account" data-key="af-login">Entra con un account</a></div></div>';
  }
  if (af.supported === false) {
    return head + '<p><span class="nodot">●</span> Il servizio account va aggiornato per gli amici dell\'account (vedi README → Servizio account).</p></div>';
  }
  var list = af.friends || [];
  var row = function (f, right, small) {
    return '<div class="folder"><div class="where"><b>' + esc(f.username) + '</b><small>' + small + '</small></div>' + right + '</div>';
  };
  var received = list.filter(function (f) { return f.status === 'received'; }).map(function (f) {
    return row(f, '<button class="btn primary f" style="margin-right:.5rem" data-act="afaccept" data-arg="' + f.id + '" data-key="af-ok-' + f.id + '">Accetta</button>' +
      '<button class="btn f" data-act="afremove" data-arg="' + f.id + ':no" data-key="af-no-' + f.id + '">Rifiuta</button>', 'vuole essere tuo amico');
  }).join('');
  var friends = list.filter(function (f) { return f.status === 'ok'; }).map(function (f) {
    var s = f.servers.length ? f.servers.map(function (x) {
      var where = x.name || 'il suo PC';
      return x.online === false ? dot(false) + ' ' + esc(where) + ': ' + esc(x.error || 'non raggiungibile')
        : x.online ? dot(true) + ' ' + esc(where) + ': collegato' : esc(where) + ': collegamento in corso…';
    }).join(' · ') : 'non condivide le sue raccolte';
    return row(f, '<button class="btn danger f" data-act="afremove" data-arg="' + f.id + ':' + esc(f.username) + '" data-key="af-del-' + f.id + '">Togli</button>', s);
  }).join('');
  var sent = list.filter(function (f) { return f.status === 'sent'; }).map(function (f) {
    return row(f, '<button class="btn f" data-act="afremove" data-arg="' + f.id + ':no" data-key="af-undo-' + f.id + '">Annulla</button>', 'richiesta mandata: aspetta che accetti');
  }).join('');
  var sharing = af.sharing
    ? (af.published ? 'Attiva: i tuoi amici vedono le raccolte del tuo profilo' : 'Attiva, ma il tuo indirizzo non è ancora pubblicato: ' + reachState(sh).replace(/<[^>]+>/g, ''))
    : 'Spenta: i tuoi amici non vedono le tue raccolte (tu vedi le loro)';
  return head +
    (received ? '<div class="lib"><div class="head"><div class="name"><b>Richieste da accettare</b></div></div>' + received + '</div>' : '') +
    (friends ? '<div class="lib">' + friends + '</div>' : '<p>Ancora nessun amico.</p>') +
    (sent ? '<div class="lib"><div class="head"><div class="name"><b>In attesa</b></div></div>' + sent + '</div>' : '') +
    '<label class="flabel" for="afname">Aggiungi un amico: il nome del suo account BunkerPlex</label>' +
    '<div class="inline"><input class="field f" id="afname" data-key="afname" data-enter="afadd" autocomplete="off" maxlength="32" placeholder="Nome dell\'account">' +
    '<button class="btn primary f" data-act="afadd" data-key="afadd">Manda la richiesta</button></div>' +
    '<button class="setting f" data-act="afshare" data-arg="' + (af.sharing ? 0 : 1) + '" data-key="afshare">Condividi le tue raccolte con i tuoi amici<small>' + esc(sharing) + '</small></button>' +
    (af.sharing ? '<label class="flabel" for="pcname">Nome di questo PC (gli amici lo vedono se condividi da più PC)</label>' +
      '<div class="inline"><input class="field f" id="pcname" data-key="pcname" data-enter="pcname" autocomplete="off" maxlength="30" value="' + esc(af.pc) + '">' +
      '<button class="btn f" data-act="pcname" data-key="pcname-save">Salva</button></div>' : '') +
    '<p class="kvnote">Gli amici vedono solo le raccolte del tuo profilo e possono soltanto guardare. Il collegamento è cifrato e il servizio account garantisce che dall\'altra parte ci sia davvero il loro server.</p></div>';
}

function friendsPanel(sh) {
  if (!sh) return '';
  var pending = sh.accounts.filter(function (a) { return !a.approved; });
  var guests = sh.accounts.filter(function (a) { return a.approved; });
  shareRequests = pending.length;
  markRequests();

  var asks = pending.map(function (a) {
    return '<div class="folder"><div class="where"><b>' + esc(a.name) + ' chiede di condividere le raccolte</b><small>' +
      (a.back_url ? 'Se accetti lui vede le tue e tu vedi le sue (' + esc(a.back_url) + ').' : 'Se accetti lui vede le tue raccolte.') + '</small></div>' +
      '<button class="btn primary f" style="margin-right:.5rem" data-act="accapprove" data-arg="' + a.id + ':1" data-key="acc-ok-' + a.id + '">Accetta</button>' +
      '<button class="btn f" data-act="accdel" data-arg="' + a.id + '" data-key="acc-no-' + a.id + '">Rifiuta</button></div>';
  }).join('');

  var mine = friends.map(function (fr) {
    var n = fr.libraries.length;
    var state = fr.online === false
      ? dot(false) + ' ' + esc(fr.error || 'non raggiungibile') + (n ? ' · resta sfogliabile l\'ultimo elenco salvato' : '')
      : (fr.online ? dot(true) + ' collegato' : 'collegamento in corso…');
    return '<div class="folder"><div class="where"><b>' + esc(fr.name) + '</b><small>' + state + ' · ' +
      (n ? n + (n === 1 ? ' raccolta' : ' raccolte') : 'nessuna raccolta ancora') + ' · ' + esc(fr.url) + '</small></div>' +
      '<button class="btn f" style="margin-right:.5rem" data-act="friendretry" data-arg="' + fr.n + '" data-key="fr-retry-' + fr.n + '">Riprova</button>' +
      '<button class="btn danger f" data-act="frienddel" data-arg="' + fr.n + '" data-key="fr-del-' + fr.n + '">Togli</button></div>';
  }).join('');

  var seen = guests.map(function (a) {
    return '<div class="folder"><div class="where"><b>' + esc(a.name) + '</b><small>può vedere le tue raccolte · ' + whenSeen(a.last_seen) + '</small></div>' +
      '<button class="btn f" style="margin-right:.5rem" data-act="accapprove" data-arg="' + a.id + ':0" data-key="acc-stop-' + a.id + '">Sospendi</button>' +
      '<button class="btn danger f" data-act="accdel" data-arg="' + a.id + '" data-key="acc-del-' + a.id + '">Togli</button></div>';
  }).join('');

  return '<div class="panel"><h2>Amici</h2>' +
    '<p>Tu e un amico con BunkerPlex potete guardare ciascuno le raccolte dell\'altro, anche da case diverse. ' +
    'Uno dei due manda la richiesta, l\'altro la accetta: da quel momento, quando il PC dell\'amico è acceso, le sue raccolte compaiono nel menu e nella Home. ' +
    'Si guarda soltanto: nessuno può modificare la libreria dell\'altro.</p>' +
    (asks ? '<div class="lib"><div class="head"><div class="name"><b>Richieste da approvare</b></div></div>' + asks + '</div>' : '') +
    (mine ? '<div class="lib"><div class="head"><div class="name"><b>Le raccolte che vedi</b></div></div>' + mine + '</div>' : '') +
    (seen ? '<div class="lib"><div class="head"><div class="name"><b>Chi vede le tue</b></div></div>' + seen + '</div>' : '') +
    (!sh.on && auth.cloud && !auth.user.linked
      ? '<p><b>Per condividere serve un account.</b> Tutto il resto funziona senza. <a class="link f" href="#/settings/account" data-key="share-login">Entra con un account</a></p>'
      : '<button class="setting f" data-act="sharetoggle" data-arg="' + (sh.on ? 0 : 1) + '" data-key="sharetoggle">Porta per gli amici su questo PC<small>' +
        (sh.on ? 'Aperta' : 'Chiusa: nessun amico può entrare né mandare richieste') + '</small></button>') +
    '<button class="setting f" data-act="shareport" data-arg="' + (sh.auto_port ? 0 : 1) + '" data-key="shareport">Apri da solo la porta sul router<small>' +
      (sh.auto_port ? 'Sì' : 'No') + '</small></button>' +
    '<p>' + reachState(sh) + '</p>' +
    '<button class="setting f" data-act="friendquality" data-key="friendquality">Qualità dei video degli amici<small>' + esc(labelOf(QUALITIES, friendQuality).split(' (')[0]) + '</small></button>' +
    // Dalla TV non si scrivono indirizzi e password: la richiesta si manda dal PC
    (TV ? '<p>Per collegare un amico apri <b>http://' + esc(location.host) + '</b> dal browser di un PC: qui sulla TV non serve nessun accesso.</p></div>' :
    '<h2 style="margin-top:1.4rem">Manda una richiesta</h2>' +
    '<p>Fatti dare dall\'amico il suo indirizzo: lo legge qui in Impostazioni → Amici, sul suo BunkerPlex. ' +
    'Il tuo viene trovato da solo quando la porta sul router è aperta; se non ci riesce, usate <b>Tailscale</b> su entrambi i PC e scrivete quegli indirizzi (vedi README).</p>' +
    '<input class="field f" style="margin-bottom:.6rem" id="fname" data-key="fname" autocomplete="off" maxlength="30" placeholder="Nome dell\'amico (come lo vedrai nel menu)">' +
    '<input class="field f" style="margin-bottom:.6rem" id="furl" data-key="furl" autocomplete="off" placeholder="Indirizzo dell\'amico (es. 93.45.12.7:' + sh.port + ')">' +
    '<input class="field f" style="margin-bottom:.6rem" id="fmy" data-key="fmy" autocomplete="off" value="' + esc(sh.address) + '" placeholder="Il tuo indirizzo (si riempie da solo se la porta è aperta)">' +
    '<input class="field f" style="margin-bottom:.6rem" id="fuser" data-key="fuser" autocomplete="off" maxlength="30" placeholder="Il nome con cui ti presenti da lui">' +
    '<input class="field f" id="fpass" data-key="fpass" type="password" autocomplete="new-password" placeholder="Una password per il tuo account da lui (almeno 8 caratteri)">' +
    '<div class="actions"><button class="btn primary f" data-act="friendadd" data-arg="1" data-key="friendadd">Manda la richiesta</button>' +
    '<button class="btn f" data-act="friendadd" data-arg="0" data-key="friendlogin">Ho già un account da lui: accedi</button></div>' +
    '</div>');
}

// Un segno sulla voce Impostazioni quando c'e' una richiesta da guardare
function markRequests() {
  var el = rail.querySelector('[data-key=nav-settings]');
  if (el) el.classList.toggle('alert', shareRequests > 0);
}

// Regolazioni che valgono solo per il dispositivo da cui si guarda
var ANIMS = [['', 'Automatiche'], ['full', 'Complete'], ['lite', 'Ridotte']];
var POSTERS = [['', 'Normali'], ['big', 'Grandi']];

function labelOf(list, key) {
  for (var i = 0; i < list.length; i++) if (list[i][0] === (key || '')) return list[i][1];
  return list[0][1];
}

function devicePanel() {
  var auto = !device.anim && device.slow ? ' (ridotte: questo dispositivo è lento)' : '';
  return '<div class="panel"><h2>Questo dispositivo</h2>' +
    (auth && auth.user && auth.user.linked
      ? '<p>Restano nel tuo account e valgono su ogni dispositivo dove entri (il riconoscimento dei dispositivi lenti resta di ognuno).</p>'
      : '<p>Restano nel tuo profilo e valgono su ogni TV, telefono e PC di casa dove entri (il riconoscimento dei dispositivi lenti resta di ognuno).</p>') +
    '<button class="setting f" data-act="devanim" data-key="devanim">Animazioni<small>' + labelOf(ANIMS, device.anim) + auto + '</small></button>' +
    '<button class="setting f" data-act="devposters" data-key="devposters">Locandine nelle raccolte<small>' + labelOf(POSTERS, device.posters) + '</small></button>' +
    (TV ? '' : '<button class="setting f" data-act="devtv" data-key="devtv">Aspetto da TV (per il browser di una smart TV)<small>' + (device.tv ? 'Attivo' : 'Spento') + '</small></button>') +
    '</div>';
}

// ---------------------------------------------------------------- Nuova raccolta / rinomina

function newLibPage() {
  var ideas = ['Film', 'Serie TV', 'Cartoni', 'Documentari', 'Anime', 'Concerti'].filter(function (n) {
    return !libs.some(function (l) { return norm(l.name) === norm(n); });
  });
  return '<div class="page"><div class="toolbar"><h1>Nuova raccolta</h1></div><div class="panel">' +
    '<p>Dai un nome alla raccolta: sarà la voce che vedi nel menu. Subito dopo scegli le cartelle da cui prendere i video.</p>' +
    '<div class="inline"><input class="field f" id="libname" data-key="libname" data-enter="createlib" data-autofocus autocomplete="off" maxlength="40" placeholder="Il nome che vuoi">' +
    '<button class="btn primary f" data-act="createlib" data-key="createlib">Crea e scegli le cartelle</button></div>' +
    (ideas.length ? '<p style="margin:1.2rem 0 .5rem">Oppure parti da un\'idea:</p><div>' + ideas.map(function (n) {
      return '<button class="chip f" data-act="idea" data-arg="' + esc(n) + '" data-key="idea-' + esc(n) + '">' + esc(n) + '</button>';
    }).join('') + '</div>' : '') +
    '<div class="actions"><button class="btn f" data-act="goback" data-key="cancel">Annulla</button></div></div></div>';
}

function renamePage(id) {
  var lib = libById(id);
  if (!lib) throw new Error('Questa raccolta non esiste più.');
  cache.rename = lib.id;
  return '<div class="page"><div class="toolbar"><h1>Rinomina raccolta</h1></div><div class="panel">' +
    '<p>Il nuovo nome compare subito nel menu e nella Home.</p>' +
    '<div class="inline"><input class="field f" id="libname" data-key="libname" data-enter="renamelib" data-autofocus autocomplete="off" maxlength="40" value="' + esc(lib.name) + '">' +
    '<button class="btn primary f" data-act="renamelib" data-key="renamelib">Salva</button></div>' +
    '<div class="actions"><button class="btn f" data-act="goback" data-key="cancel">Annulla</button></div></div></div>';
}

// ---------------------------------------------------------------- Scelta di una cartella del PC

async function browsePage(id) {
  var lib = libById(id);
  if (!lib) { await loadLibs(true); lib = libById(id); }
  if (!lib) throw new Error('Questa raccolta non esiste più.');
  var q = parseQuery(location.hash);
  var d = await api('/browse?path=' + encodeURIComponent(q.path || ''));
  if (q.replace) cache.browseReplace = { lib: lib.id, display: q.replace };
  else if (!cache.browseReplace || cache.browseReplace.lib !== lib.id) cache.browseReplace = null;
  cache.browse = { lib: lib.id, path: d.path };

  var list = d.dirs.map(function (x, n) {
    return '<button class="result dir f"' + (n === 0 ? ' data-autofocus' : '') + ' data-act="browse" data-arg="' + esc(x.path) + '" data-key="dir-' + n + '">' +
      '<span class="dirico">' + (d.root ? IC.disk : IC.folder) + '</span><span><b>' + esc(x.name) + '</b></span></button>';
  }).join('');
  if (!list) {
    list = d.root
      ? '<p><b>Non vedo i dischi del computer.</b> Rilancia <b>Installa BunkerPlex</b>: è lui a collegarli a Docker, una volta per tutte.</p>'
      : '<p>Qui dentro non ci sono altre cartelle.</p>';
  }

  return '<div class="page"><div class="toolbar"><h1>Cartelle di «' + esc(lib.name) + '»</h1></div>' +
    '<div class="panel">' +
    (cache.browseReplace && cache.browseReplace.lib === lib.id
      ? '<p>Sugli altri PC questa raccolta usa <b>' + esc(cache.browseReplace.display) + '</b>. Scegli dove stanno qui gli stessi video.</p>' : '') +
    '<p>Entra nella cartella che contiene i video (vanno bene anche le sottocartelle) e premi «Usa questa cartella». ' +
    'Puoi ripetere per aggiungerne altre.</p>' +
    '<p>Sei in: <b>' + esc(d.display) + '</b>' + (d.videos ? ' · ' + d.videos + ' video qui dentro' : '') + '</p>' +
    '<div class="actions" style="margin-top:0">' +
      (d.root ? '' : '<button class="btn primary f" data-act="usefolder" data-key="use">' + IC.check + 'Usa questa cartella</button>') +
      (d.parent ? '<button class="btn f" data-act="browse" data-arg="' + esc(d.parent) + '" data-key="up">Cartella superiore</button>' : '') +
      '<button class="btn f" data-act="goback" data-key="cancel">Fine</button>' +
    '</div>' +
    '<div style="margin-top:1rem">' + list + '</div></div>' +
    (TV ? '' : '<div class="panel"><h2>Oppure incolla il percorso</h2>' +
      '<p>In Esplora risorse apri la cartella, fai clic sulla barra dell\'indirizzo, copia il percorso e incollalo qui:</p>' +
      '<div class="inline"><input class="field f" id="pastepath" data-key="pastepath" data-enter="pastefolder" autocomplete="off" placeholder="Es. G:\\Video\\Film">' +
      '<button class="btn f" data-act="pastefolder" data-key="pastego">Aggiungi</button></div></div>') +
    '</div>';
}

// ---------------------------------------------------------------- Riproduzione

async function play(id, fromStart) {
  var p;
  try { p = await api('/play/' + id); } catch (e) { toast(e.message); return; }
  if (fromStart) p.start = 0;
  if (TV) { tvApp.play(JSON.stringify(p)); return; }
  cache.pendingPlay = p;
  location.hash = '#/play/' + id;
}

// I sottotitoli partono spenti; solo quelli forzati (cartelli e frasi in un'altra
// lingua) si accendono da soli: prima gli italiani, poi quelli senza lingua.
function forcedSub(subs) {
  var best = -1;
  (subs || []).forEach(function (s, i) {
    if (!s.forced) return;
    if (s.lang === 'it' && (best < 0 || subs[best].lang !== 'it')) best = i;
    else if (!s.lang && best < 0) best = i;
  });
  return best;
}

// Preferenze del player, ricordate su questo dispositivo (volume, sottotitoli, salti…)
function playerPrefs() {
  try { return JSON.parse(localStorage.getItem('fpPlayer')) || {}; } catch (e) { return {}; }
}
function savePlayerPrefs(prefs) {
  try { localStorage.setItem('fpPlayer', JSON.stringify(prefs)); } catch (e) { /* niente */ }
  pushPrefs();
}

var SEEK_STEPS = { short: [5, 10], normal: [10, 30], long: [30, 60] };
var SUB_SIZES = [['s', 'Piccoli'], ['', 'Normali'], ['l', 'Grandi'], ['xl', 'Molto grandi']];
var FITS = [['contain', 'Adatta (tutto il video)'], ['cover', 'Riempi lo schermo (ritaglia i bordi)'], ['fill', 'Allarga (deforma)']];
var SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

// Icone del player: a linee come quelle del menu; piene solo Play, Pausa e Successivo
var PIC = {
  rew: '<svg class="ic line" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5.5a7.5 7.5 0 1 1-7.5 7.5M14.5 3 12 5.5 14.5 8"/></svg>',
  fwd: '<svg class="ic line" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5.5a7.5 7.5 0 1 0 7.5 7.5M9.5 3 12 5.5 9.5 8"/></svg>',
  subs: '<svg class="ic line" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M7 12h2.5M12.5 12H17M7 15.5h6M15.5 15.5H17"/></svg>',
  opts: '<svg class="ic line" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h8M16 8h4M4 16h3M11 16h9"/><circle cx="14" cy="8" r="2"/><circle cx="9" cy="16" r="2"/></svg>',
  fsOn: '<svg class="ic line" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/></svg>',
  fsOff: '<svg class="ic line" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4v5H4M15 4v5h5M15 20v-5h5M9 20v-5H4"/></svg>',
  pip: '<svg class="ic line" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M12.5 12H18v4h-5.5z"/></svg>'
};
var SUBS_BTN = '<button class="pbtn" data-p="subs" data-tip="Sottotitoli (S)" aria-label="Sottotitoli">' + PIC.subs + '</button>';
function skipIcon(kind) { return '<span class="sk">' + PIC[kind] + '<b></b></span>'; }

async function playRoute(id) {
  var p = cache.pendingPlay && String(cache.pendingPlay.id) === String(id) ? cache.pendingPlay : await api('/play/' + id);
  cache.pendingPlay = null;
  var pip = !!(document.pictureInPictureEnabled && HTMLVideoElement.prototype.requestPictureInPicture);
  return {
    // Sulla TV i salti si fanno con ← → del telecomando e il volume con i suoi tasti:
    // quei bottoni ('pc') restano solo su PC e telefono. Sul telefono Play e salti
    // stanno al centro, a portata di pollice (.pmid).
    html: '<div class="player" id="player"><video playsinline></video>' +
      '<div class="pspin" aria-hidden="true"></div><div class="note" role="status"></div>' +
      '<div class="skipfx" aria-hidden="true"></div><div class="pflash" aria-hidden="true"></div>' +
      '<div class="top"><button class="pbtn" data-p="exit" data-tip="Indietro (Esc)" aria-label="Indietro">' + IC.back + '</button>' +
        '<div class="ptitle"><b>' + esc(p.title) + '</b>' + (p.subtitle ? '<span>' + esc(p.subtitle) + '</span>' : '') + '</div>' +
        '<span class="pends"></span></div>' +
      '<div class="pmid">' +
        '<button class="pbtn" data-p="back">' + skipIcon('rew') + '</button>' +
        '<button class="pbtn main" data-p="toggle" aria-label="Play o pausa">' + IC.pause + '</button>' +
        '<button class="pbtn" data-p="fwd">' + skipIcon('fwd') + '</button></div>' +
      '<button class="pskip" data-p="intro" hidden>Salta intro</button>' +
      (p.next ? '<div class="pcard" hidden><small>Prossimo episodio</small><b>' + esc(p.next_label || '') + '</b>' +
        '<div class="pcard-b"><button class="pcb" data-p="credits">Guarda i titoli di coda</button>' +
        '<button class="pcb go" data-p="next"><i></i><span>Episodio successivo</span></button></div></div>' : '') +
      '<div class="bottom">' +
        '<div class="pbar"><span class="ptime cur">0:00</span>' +
          '<div class="ptrack"><input class="seek" type="range" min="0" max="' + Math.max(1, Math.floor(p.duration)) + '" step="1" value="0" aria-label="Posizione nel video">' +
            '<div class="rail"><i class="buf"></i><i class="fill"></i></div><i class="knob"></i><span class="ptip"></span></div>' +
          '<button class="ptime end" data-p="remain" title="Durata o tempo che manca"></button></div>' +
        '<div class="ctl">' +
          '<button class="pbtn main" data-p="toggle" data-tip="Play / Pausa (Spazio)" aria-label="Play o pausa">' + IC.pause + '</button>' +
          '<button class="pbtn pc" data-p="back">' + skipIcon('rew') + '</button>' +
          '<button class="pbtn pc" data-p="fwd">' + skipIcon('fwd') + '</button>' +
          '<div class="pvol pc"><button class="pbtn" data-p="mute" data-tip="Audio sì / no (M)" aria-label="Audio sì o no">' + IC.vol + '</button>' +
            '<input class="vol" type="range" min="0" max="100" step="5" value="100" aria-label="Volume"></div>' +
          '<span class="prate" hidden></span>' +
          '<span class="phint">← → salta · ↓ comandi</span><span class="grow"></span>' +
          (p.next ? '<button class="pbtn wide" data-p="next" data-tip="Episodio successivo (N)" aria-label="Episodio successivo">' + IC.next + '<span>Successivo</span></button>' : '') +
          (p.subs.length ? SUBS_BTN : '') +
          '<button class="pbtn" data-p="menu" data-tip="Opzioni (O)" aria-label="Opzioni">' + PIC.opts + '</button>' +
          (pip ? '<button class="pbtn pc" data-p="pip" data-tip="Finestra sopra le altre" aria-label="Finestra sopra le altre">' + PIC.pip + '</button>' : '') +
          '<button class="pbtn pc" data-p="fs" data-tip="Schermo intero (F)" aria-label="Schermo intero">' + PIC.fsOn + '</button>' +
        '</div></div></div>',
    mount: function () { startPlayer(p); }
  };
}

function canDecode(v, codec, bits) {
  var type = codec === 'hevc' ? (bits === 10 ? 'hvc1.2.4.L153.B0' : 'hvc1.1.6.L123.B0') : '';
  if (!type) return false;
  type = 'video/mp4; codecs="' + type + '"';
  try {
    if (window.MediaSource && MediaSource.isTypeSupported && !MediaSource.isTypeSupported(type)) return false;
    return v.canPlayType(type) === 'probably';
  } catch (e) { return false; }
}

function startPlayer(p) {
  var root = document.getElementById('player');
  var v = root.querySelector('video'), seek = root.querySelector('.seek'), vol = root.querySelector('.vol');
  var note = root.querySelector('.note'), track = root.querySelector('.ptrack');
  var fillEl = track.querySelector('.fill'), bufEl = track.querySelector('.buf'), railEl = track.querySelector('.rail');
  var knob = track.querySelector('.knob'), tipEl = track.querySelector('.ptip');
  var curEl = root.querySelector('.ptime.cur'), endEl = root.querySelector('.ptime.end'), endsEl = root.querySelector('.pends');
  var rateEl = root.querySelector('.prate'), flashEl = root.querySelector('.pflash');
  var introBtn = root.querySelector('.pskip'), card = root.querySelector('.pcard');
  var cardFill = card && card.querySelector('.go i');
  var subsBtn = root.querySelector('.ctl [data-p=subs]'), muteBtn = root.querySelector('[data-p=mute]');
  var fsBtn = root.querySelector('[data-p=fs]');
  var all = function (sel) { return Array.prototype.slice.call(root.querySelectorAll(sel)); };
  var prefs = playerPrefs();
  var LOADING = 'Caricamento…', CONVERTING = 'Conversione in corso…', RECONNECT = 'Riprendo il collegamento…';
  var st = {
    id: p.id, v: v, offset: 0, transcoding: !p.browser_direct, loaded: false, dragging: false, sub: forcedSub(p.subs), done: false,
    audio: 0, audios: [], rate: 1, at: p.start || 0, pending: null, loadId: 0,
    lastT: -1, lastMove: Date.now(), recov: 0, recovAt: 0, fatal: false, endAt: null, sleepAt: 0, sleepEnd: false,
    introOn: false, introOff: false, card: false, cardOff: false, cardLeft: 10
  };
  p.intro_start = p.intro_start || 0; p.intro_end = p.intro_end || 0; p.credits = p.credits || 0;
  // Se questo dispositivo sa decodificare il video originale (es. H.265), il PC lo
  // copia cosi' com'e' invece di ricodificarlo: quasi nessun lavoro per il processore.
  st.vcopy = canDecode(v, p.vcodec, p.bits);
  document.body.classList.add('playing');

  function pos() { return st.transcoding ? st.offset + v.currentTime : v.currentTime; }
  function dur() { return p.duration || (isFinite(v.duration) ? v.duration : 0); }
  function shown() { return st.dragging ? +seek.value : (st.pending !== null ? st.pending : pos()); }
  function steps() { return SEEK_STEPS[prefs.step] || SEEK_STEPS.normal; }
  function two(n) { return (n < 10 ? '0' : '') + n; }

  function showTime() {
    var t = shown(), d = dur();
    var pct = d ? Math.max(0, Math.min(100, t / d * 100)) : 0;
    curEl.textContent = fmtTime(t);
    endEl.textContent = prefs.remain && d ? '−' + fmtTime(d - t) : fmtTime(d);
    fillEl.style.width = pct + '%';
    knob.style.left = pct + '%';
    if (d) {   // a che ora finisce, alla velocita' scelta
      var end = new Date(Date.now() + Math.max(0, d - t) / st.rate * 1000);
      var h = end.getHours();
      endsEl.textContent = (h === 1 ? 'Finisce all\'' : 'Finisce alle ') + h + ':' + two(end.getMinutes());
    }
  }

  // Quanto video e' gia' arrivato: la parte piu' chiara della barra
  function showBuffer() {
    var b = v.buffered, ct = v.currentTime, end = 0, d = dur();
    if (!d) return;
    for (var i = 0; i < b.length; i++) if (b.start(i) <= ct + 1 && b.end(i) > end) end = b.end(i);
    bufEl.style.width = Math.min(100, ((st.transcoding ? st.offset : 0) + end) / d * 100) + '%';
  }

  // Tacche sulla barra: inizio e fine della sigla, inizio dei titoli di coda
  function drawMarks() {
    all('.rail .cut').forEach(function (c) { c.parentNode.removeChild(c); });
    var d = dur();
    if (!d) return;
    [p.intro_end > 0 && p.intro_start > 1 ? p.intro_start : 0, p.intro_end, p.credits].forEach(function (t) {
      if (t > 0 && t < d) railEl.insertAdjacentHTML('beforeend', '<i class="cut" style="left:' + (t / d * 100) + '%"></i>');
    });
  }
  function partName(t) {
    if (p.intro_end > 0 && t >= p.intro_start && t < p.intro_end) return 'Sigla';
    if (p.credits > 0 && t >= p.credits) return 'Titoli di coda';
    return '';
  }
  function showTip(f) {
    var w = track.clientWidth, t = f * dur(), name = partName(t);
    tipEl.innerHTML = esc(fmtTime(t)) + (name ? '<small>' + name + '</small>' : '');
    var half = tipEl.offsetWidth / 2;
    tipEl.style.left = Math.max(half, Math.min(w - half, f * w)) + 'px';
    track.classList.add('hover');
  }

  function applyLook() {
    var s = steps();
    all('[data-p=back]').forEach(function (b) {
      b.querySelector('b').textContent = s[0];
      b.setAttribute('aria-label', 'Indietro di ' + s[0] + ' secondi');
      b.setAttribute('data-tip', 'Indietro ' + s[0] + ' s (←)');
    });
    all('[data-p=fwd]').forEach(function (b) {
      b.querySelector('b').textContent = s[1];
      b.setAttribute('aria-label', 'Avanti di ' + s[1] + ' secondi');
      b.setAttribute('data-tip', 'Avanti ' + s[1] + ' s (→)');
    });
    all('.pmid [data-tip]').forEach(function (b) { b.removeAttribute('data-tip'); });
    v.style.objectFit = prefs.fit || 'contain';
    root.className = root.className.replace(/\s*subs-\w+/g, '') + (prefs.subsize ? ' subs-' + prefs.subsize : '');
    v.volume = prefs.volume === undefined ? 1 : prefs.volume;
    v.muted = !!prefs.muted;
    vol.value = v.muted ? 0 : Math.round(v.volume * 100);
    vol.style.setProperty('--v', vol.value + '%');
    muteBtn.innerHTML = v.muted || !v.volume ? IC.mute : IC.vol;
    showTime();
  }

  function setToggle(paused) {
    all('[data-p=toggle]').forEach(function (b) { b.innerHTML = paused ? IC.play : IC.pause; });
    root.classList.toggle('paused', paused);
  }

  // Segnale al centro dopo un comando (Play, Pausa, volume): compare e svanisce
  function flash(html) {
    flashEl.innerHTML = html;
    flashEl.classList.remove('show');
    void flashEl.offsetWidth;
    flashEl.classList.add('show');
  }

  // La rotella gira mentre il video si carica o si converte
  function setNote(text) { note.textContent = text; busy(); }
  function busy() {
    var t = note.textContent;
    root.classList.toggle('busy', !st.fatal && (st.waiting || t === LOADING || t === CONVERTING || t === RECONNECT));
  }

  function showSubs() {
    for (var i = 0; i < v.textTracks.length; i++) v.textTracks[i].mode = i === st.sub ? 'showing' : 'disabled';
    if (subsBtn) subsBtn.classList.toggle('on', st.sub >= 0);
  }

  function tracks() {
    Array.prototype.slice.call(v.querySelectorAll('track')).forEach(function (t) { v.removeChild(t); });
    p.subs.forEach(function (s, i) {
      var t = document.createElement('track');
      t.kind = 'subtitles'; t.label = s.label; if (s.lang) t.srclang = s.lang;
      t.src = s.url + (st.transcoding ? '?offset=' + st.offset.toFixed(1) : '');
      if (i === st.sub) t.default = true;
      v.appendChild(t);
    });
    setTimeout(showSubs, 0);
  }

  // Apre (o riapre) il video al secondo 'at'. Nel file originale basta spostarsi;
  // in conversione il flusso riparte da li'.
  function load(at) {
    at = Math.max(0, Math.min(at, Math.max(0, dur() - 3)));
    clearTimeout(st.seekTimer);
    st.pending = null;
    st.at = at;
    st.lastMove = Date.now();
    var id = ++st.loadId;
    if (st.transcoding) {
      st.offset = at;
      v.src = p.transcode + '?start=' + at.toFixed(1) + (st.vcopy ? '&vcopy=1' : '') + (st.audio ? '&audio=' + st.audio : '');
      tracks();
      setNote(CONVERTING);
    } else if (!st.loaded) {
      v.src = p.url;
      tracks();
      v.addEventListener('loadedmetadata', function once() {
        v.removeEventListener('loadedmetadata', once);
        if (id === st.loadId && at > 1 && !st.transcoding) v.currentTime = at;
      });
    } else {
      v.currentTime = at;
    }
    st.loaded = true;
    v.defaultPlaybackRate = st.rate;
    v.playbackRate = st.rate;
    var pr = v.play();
    if (pr && pr.catch) pr.catch(function () { if (id === st.loadId && v.paused) setNote('Premi Play per avviare'); });
  }

  // Salto: nel file originale subito; in conversione si aspetta che si smetta di
  // premere, altrimenti ogni pressione farebbe ripartire la conversione sul PC.
  function seekTo(t) {
    t = Math.max(0, Math.min(t, Math.max(0, dur() - 3)));
    clearTimeout(st.seekTimer);
    if (!st.transcoding) { load(t); showTime(); checkMarks(t); return; }
    st.pending = t;
    seek.value = t;
    showTime();
    checkMarks(t);
    st.seekTimer = setTimeout(function () { load(t); }, 450);
  }

  // Riapre il video dal punto in cui era: per quando si blocca o cade il collegamento.
  function recover(message) {
    if (st.recov >= 3) {
      st.fatal = true;
      v.pause();
      setNote('Il video non riparte. Controlla che il PC sia acceso e il disco collegato, poi premi Play.');
      return;
    }
    st.recov++;
    st.recovAt = Date.now();
    st.loaded = false;
    load(st.at);
    setNote(message || RECONNECT);
  }

  function report(ended) {
    if (st.done || (!ended && pos() < 5)) return;
    post('/progress/' + p.id, { position: pos(), duration: dur(), ended: !!ended }).catch(function () {});
  }

  function wake() {
    root.classList.remove('idle');
    clearTimeout(st.idle);
    // Mentre si sceglie un bottone col telecomando, o il mouse e' sopra i comandi, restano visibili
    st.idle = setTimeout(function () { if (!v.paused && modal.hidden && !st.nav && !st.over) root.classList.add('idle'); }, 3200);
  }

  // ---- Sigla e titoli di coda (le trova il PC; vedi /api/marks)
  // «Salta intro» dall'inizio della sigla fino a poco prima della fine; chiuso con
  // Indietro torna solo se si esce dalla sigla e ci si rientra.
  function setIntro(on) {
    if (on === st.introOn) return;
    st.introOn = on;
    introBtn.hidden = !on;
    if (!on && document.activeElement === introBtn) introBtn.blur();
  }
  function closeIntro() { st.introOff = true; setIntro(false); wake(); }

  // Scheda dei titoli di coda: «Guarda i titoli» o «Episodio successivo», che parte
  // da solo dopo 10 s di video (solo con l'autoplay acceso)
  function showCard() {
    st.card = true;
    st.cardLeft = 10;
    card.hidden = false;
    card.classList.toggle('auto', prefs.autoplay !== false && !st.sleepEnd);
    cardFill.style.transform = 'scaleX(0)';
    if (st.nav) leaveRow();
    card.querySelector('.go').focus();
  }
  function hideCard() {
    st.card = false;
    card.hidden = true;
    if (card.contains(document.activeElement)) document.activeElement.blur();
  }
  function watchCredits() { st.cardOff = true; hideCard(); wake(); }
  function moveCard(step) {
    var b = card.querySelectorAll('.pcb'), i = Array.prototype.indexOf.call(b, document.activeElement);
    b[Math.max(0, Math.min(b.length - 1, (i < 0 ? 1 : i) + step))].focus();
  }

  function checkMarks(t) {
    if (t === undefined) t = pos();
    var inIntro = p.intro_end > 0 && t >= p.intro_start && t < p.intro_end - 1.5;
    if (!inIntro) st.introOff = false;
    setIntro(inIntro && !st.introOff && !st.done);
    if (card && p.credits > 0 && !st.done) {
      if (t < p.credits - 2) { st.cardOff = false; if (st.card) hideCard(); }
      else if (t >= p.credits && !st.card && !st.cardOff) showCard();
    }
  }

  // Sigle non ancora trovate: il PC le cerca adesso, si richiedono ogni 10 s
  function fetchMarks(n) {
    st.marksTimer = setTimeout(function () {
      if (player !== st) return;
      api('/marks/' + p.id).then(function (m) {
        if (player !== st) return;
        p.intro_start = m.intro_start || 0; p.intro_end = m.intro_end || 0; p.credits = m.credits || 0;
        drawMarks();
        checkMarks();
        if (m.marks_pending && n < 6) fetchMarks(n + 1);
      }, function () { if (n < 6) fetchMarks(n + 1); });
    }, 10000);
  }

  // ---- Fila dei bottoni col telecomando: ↓ ci entra, ← → si sposta, OK sceglie,
  // ↑ o Indietro esce. Fuori dalla fila ← → fanno i salti.
  function rowButtons() {
    return Array.prototype.filter.call(root.querySelectorAll('.ctl .pbtn'), function (b) {
      return b.offsetParent !== null;     // solo quelli visibili (sulla TV alcuni sono nascosti)
    });
  }
  var hintEl = root.querySelector('.phint');
  function enterRow() {
    var list = rowButtons();
    if (!list.length) return;
    st.nav = true;
    root.classList.add('nav');
    hintEl.textContent = '← → scegli · OK conferma · ↑ indietro';
    var b = list[Math.min(st.navAt || 0, list.length - 1)];
    b.focus();
    wake();
  }
  function moveRow(step) {
    var list = rowButtons();
    var i = list.indexOf(document.activeElement);
    if (i < 0) i = Math.min(st.navAt || 0, list.length - 1);
    else i = Math.max(0, Math.min(list.length - 1, i + step));
    st.navAt = i;
    list[i].focus();
    wake();
  }
  function leaveRow() {
    if (!st.nav) return false;
    var list = rowButtons();
    var i = list.indexOf(document.activeElement);
    if (i >= 0) st.navAt = i;
    st.nav = false;
    root.classList.remove('nav');
    hintEl.textContent = '← → salta · ↓ comandi';
    if (root.contains(document.activeElement)) document.activeElement.blur();
    wake();
    return true;
  }
  // Indietro del telecomando: esce dalla fila, poi chiude la scheda o «Salta intro»
  st.leaveRow = function () {
    if (leaveRow()) return true;
    if (st.card) { watchCredits(); return true; }
    if (st.introOn) { closeIntro(); return true; }
    return false;
  };

  // Salto con indicatore a schermo: pressioni ravvicinate si sommano ("+90 s")
  var skipEl = root.querySelector('.skipfx');
  function skip(dir) {
    var size = dir < 0 ? steps()[0] : steps()[1];
    if (st.skipDir !== dir) st.skipSum = 0;
    st.skipDir = dir;
    st.skipSum = (st.skipSum || 0) + size;
    seekTo(shown() + dir * size);
    skipEl.innerHTML = (dir < 0 ? PIC.rew : '') + '<b>' + (dir < 0 ? '−' : '+') + fmtSkip(st.skipSum) + '</b>' + (dir < 0 ? '' : PIC.fwd);
    skipEl.className = 'skipfx show ' + (dir < 0 ? 'left' : 'right');
    clearTimeout(st.skipTimer);
    st.skipTimer = setTimeout(function () { skipEl.className = 'skipfx'; st.skipSum = 0; st.skipDir = 0; }, 900);
  }
  function fmtSkip(s) {
    if (s < 60) return s + ' s';
    var m = Math.floor(s / 60), r = s % 60;
    return m + ' min' + (r ? ' ' + r + ' s' : '');
  }

  function openNext(id) {
    return api('/play/' + id).then(function (n) {
      n.start = 0; cache.pendingPlay = n; location.replace('#/play/' + n.id);
    });
  }
  function goTo(id) {
    if (!id) return;
    report();
    st.done = true;
    if (st.card) hideCard();
    setIntro(false);
    openNext(id).catch(function (e) { st.done = false; toast(e.message); });
  }
  function goNext() { goTo(p.next || (p.saga && p.saga.id)); }
  function sagaLabel() { return '«' + p.saga.title + '»' + (p.saga.year ? ' (' + p.saga.year + ')' : ''); }

  function setRate(r) {
    st.rate = r;
    v.defaultPlaybackRate = r;
    v.playbackRate = r;
    rateEl.hidden = r === 1;
    rateEl.textContent = r + '×';
    showTime();
    toast('Velocità ' + r + '×');
  }

  function setVolume(value) {
    prefs.volume = Math.max(0, Math.min(1, value));
    prefs.muted = false;
    savePlayerPrefs(prefs);
    applyLook();
  }

  function setAudio(index) {
    if (index === st.audio) return;
    st.audio = index;
    // La prima lingua si puo' leggere dal file originale; le altre le prepara il PC
    st.transcoding = index > 0 || !p.browser_direct || st.forced;
    st.loaded = false;
    load(st.at);
  }

  function togglePip() {
    (document.pictureInPictureElement ? document.exitPictureInPicture() : v.requestPictureInPicture())
      .catch(function () { toast('Non disponibile in questo browser'); });
  }

  function choose(title, list, current, fn) {
    openPicker(title, list, current, function (value) { fn(value); wake(); });
  }

  function info() {
    var a = st.audios[st.audio];
    var lines = [
      (v.videoWidth ? v.videoWidth + '×' + v.videoHeight + ' · ' : '') + (p.vcodec || '').toUpperCase(),
      a ? 'Audio: ' + a.label : '',
      !st.transcoding ? 'Riproduzione diretta del file' + (p.friend ? ' dal PC di ' + p.friend : '') :
        p.friend && p.friend_quality !== 'orig' ? 'Convertito a ' + p.friend_quality + 'p dal PC di ' + p.friend :
        (st.vcopy || (p.vcodec === 'h264' && p.bits === 8) ? 'Conversione leggera (video originale)' : 'Conversione completa sul PC')
    ].filter(Boolean);
    openPicker(p.title + (p.subtitle ? ' — ' + p.subtitle : '') + ' · ' + lines.join(' · '), [{ value: 'ok', label: 'Chiudi' }], 'ok', wake);
  }

  // Sottotitoli da internet: lingua → elenco di OpenSubtitles → si scarica e si accende
  var ONLINE_LANGS = [['it', 'Italiano'], ['en', 'English'], ['es', 'Español'], ['fr', 'Français'], ['de', 'Deutsch']];
  function findSubs() {
    choose('Cerca sottotitoli in…', ONLINE_LANGS.map(function (l) { return { value: l[0], label: l[1] }; }),
      prefs.oslang || 'it', function (lang) {
        prefs.oslang = lang;
        savePlayerPrefs(prefs);
        toast('Cerco i sottotitoli…');
        api('/subs-online/' + p.id + '?langs=' + lang).then(function (r) {
          if (player !== st) return;
          if (!r.ok) { toast(r.error); return; }
          if (!r.results.length) { toast('Nessun sottotitolo trovato in questa lingua'); return; }
          choose('Scegli i sottotitoli', r.results.map(function (s, i) {
            var notes = [s.match ? '✓ fatti per questo file' : '', s.hi ? 'per non udenti' : '',
              s.machine ? 'tradotti in automatico' : '', s.downloads ? s.downloads.toLocaleString('it-IT') + ' download' : ''];
            return { value: i, label: s.release || s.language, count: esc(notes.filter(Boolean).join(' · ')) };
          }), null, function (i) { getSubs(r.results[i]); });
        }, function (e) { toast(e.message); });
      });
  }

  function getSubs(s) {
    toast('Scarico i sottotitoli…');
    post('/subs-online/' + p.id, { file_id: s.file_id, lang: s.lang }).then(function (r) {
      if (player !== st) return;
      if (!r.ok) { toast(r.error); return; }
      p.subs = r.subs;
      st.sub = r.index;
      if (!subsBtn) {   // prima non c'erano sottotitoli: compare il bottone
        root.querySelector('.ctl [data-p=menu]').insertAdjacentHTML('beforebegin', SUBS_BTN);
        subsBtn = root.querySelector('.ctl [data-p=subs]');
      }
      tracks();
      toast('Sottotitoli: ' + p.subs[st.sub].label +
        (typeof r.remaining === 'number' ? ' · ne puoi scaricare ancora ' + r.remaining + ' oggi' : ''));
    }, function (e) { toast(e.message); });
  }

  function menu() {
    var o = [];
    function add(label, value, fn) { o.push({ value: String(o.length), label: label, count: value, fn: fn }); }
    function named(list, key) {
      for (var i = 0; i < list.length; i++) if (list[i][0] === key) return list[i][1];
      return '';
    }
    add('Velocità', st.rate + '×', function () {
      choose('Velocità', SPEEDS.map(function (s) { return { value: s, label: s === 1 ? 'Normale' : s + '×' }; }), st.rate, setRate);
    });
    if (st.audios.length > 1) {
      add('Lingua audio', esc(st.audios[st.audio] ? st.audios[st.audio].label : ''), function () {
        choose('Lingua audio', st.audios.map(function (a) {
          return { value: a.index, label: a.label + (a.title ? ' (' + a.title + ')' : '') };
        }), st.audio, setAudio);
      });
    }
    if (p.subs.length) {
      add('Sottotitoli', st.sub >= 0 ? esc(p.subs[st.sub].label) : 'No', function () {
        choose('Sottotitoli', [{ value: -1, label: 'Nessuno' }].concat(p.subs.map(function (s, i) {
          return { value: i, label: s.label };
        })), st.sub, function (i) { st.sub = i; showSubs(); });
      });
      add('Dimensione dei sottotitoli', named(SUB_SIZES, prefs.subsize || ''), function () {
        choose('Dimensione dei sottotitoli', SUB_SIZES.map(function (s) { return { value: s[0], label: s[1] }; }),
          prefs.subsize || '', function (s) { prefs.subsize = s; savePlayerPrefs(prefs); applyLook(); });
      });
    }
    if (p.subs_online && !p.friend) add('Cerca sottotitoli su internet', undefined, findSubs);
    add('Formato immagine', named(FITS, prefs.fit || 'contain').split(' (')[0], function () {
      choose('Formato immagine', FITS.map(function (f) { return { value: f[0], label: f[1] }; }),
        prefs.fit || 'contain', function (f) { prefs.fit = f; savePlayerPrefs(prefs); applyLook(); });
    });
    add('Durata dei salti', '−' + steps()[0] + ' s / +' + steps()[1] + ' s', function () {
      choose('Durata dei salti (frecce ← →)', Object.keys(SEEK_STEPS).map(function (k) {
        return { value: k, label: 'Indietro ' + SEEK_STEPS[k][0] + ' s · avanti ' + SEEK_STEPS[k][1] + ' s' };
      }), prefs.step || 'normal', function (k) { prefs.step = k; savePlayerPrefs(prefs); applyLook(); });
    });
    if (p.next) {
      add('Episodio successivo da solo', prefs.autoplay === false ? 'No' : 'Sì', function () {
        prefs.autoplay = prefs.autoplay === false;
        savePlayerPrefs(prefs);
        if (card) card.classList.toggle('auto', prefs.autoplay && !st.sleepEnd);
        toast(prefs.autoplay ? 'A fine episodio parte il successivo' : 'A fine episodio si torna alla scheda');
      });
    }
    var left = st.sleepAt ? Math.max(1, Math.round((st.sleepAt - Date.now()) / 60000)) + ' min' : (st.sleepEnd ? 'a fine video' : 'No');
    add('Spegnimento automatico', left, function () {
      choose('Metti in pausa da solo dopo…', [{ value: 0, label: 'Mai' }].concat([15, 30, 45, 60, 90].map(function (m) {
        return { value: m, label: m + ' minuti' };
      })).concat([{ value: -1, label: 'Alla fine di questo video' }]), st.sleepEnd ? -1 : 0, function (m) {
        st.sleepEnd = m === -1;
        st.sleepAt = m > 0 ? Date.now() + m * 60000 : 0;
        if (card) card.classList.toggle('auto', prefs.autoplay !== false && !st.sleepEnd);
        toast(m > 0 ? 'Pausa automatica tra ' + m + ' minuti' : (m ? 'Mi fermo alla fine di questo video' : 'Spegnimento automatico disattivato'));
      });
    });
    add('Tempo a destra della barra', prefs.remain ? 'Quanto manca' : 'Durata', function () { action('remain'); });
    add('Ricomincia dall\'inizio', undefined, function () { seekTo(0); });
    if (p.next) add('Vai all\'episodio successivo', undefined, goNext);
    else if (p.saga) add('Film successivo della saga', esc(p.saga.title), goNext);
    if (document.pictureInPictureEnabled && v.requestPictureInPicture) add('Finestra sopra le altre (PiP)', undefined, togglePip);
    add('Informazioni sul video', undefined, info);
    openPicker('Opzioni', o, null, function (value) { o[+value].fn(); wake(); });
  }

  function action(name) {
    wake();
    if (name === 'exit') history.back();
    else if (name === 'toggle') {
      if (st.fatal) { st.fatal = false; st.recov = 0; st.loaded = false; load(st.at); flash(IC.play); }
      else if (v.paused) { st.lastMove = Date.now(); v.play(); flash(IC.play); } else { v.pause(); flash(IC.pause); }
    }
    else if (name === 'back') skip(-1);
    else if (name === 'fwd') skip(1);
    else if (name === 'next') goNext();
    else if (name === 'menu') menu();
    else if (name === 'mute') { prefs.muted = !v.muted; savePlayerPrefs(prefs); applyLook(); }
    else if (name === 'pip') togglePip();
    else if (name === 'intro') { if (st.introOn) { setIntro(false); seekTo(p.intro_end); } }
    else if (name === 'credits') watchCredits();
    else if (name === 'remain') {
      prefs.remain = !prefs.remain;
      savePlayerPrefs(prefs);
      showTime();
    }
    else if (name === 'fs') {
      // Schermo intero su tutta la pagina: cosi' restano visibili menu e avvisi
      if (document.fullscreenElement) document.exitFullscreen();
      else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen();
    } else if (name === 'subs' && p.subs.length) {
      st.sub = st.sub + 1 >= p.subs.length ? -1 : st.sub + 1;
      showSubs();
      toast(st.sub >= 0 ? 'Sottotitoli: ' + p.subs[st.sub].label : 'Sottotitoli disattivati');
    }
  }

  v.addEventListener('error', function () {
    if (player !== st || !v.getAttribute('src')) return;
    var code = v.error ? v.error.code : 0;
    var early = v.currentTime < 1;
    if (code === 2 || (!early && st.recov < 2)) {
      // Collegamento caduto (o intoppo a meta' video): si riprova dallo stesso punto
      setTimeout(function () { if (player === st) recover(); }, 800);
    } else if (!st.transcoding) {     // il browser non legge il file: si passa alla conversione
      st.transcoding = true;
      st.forced = true;
      load(st.at);
    } else if (st.vcopy) {            // la copia del video non va: conversione completa
      st.vcopy = false;
      load(st.at);
    } else {
      st.fatal = true;
      setNote('Impossibile riprodurre questo video.');
    }
  });
  v.addEventListener('playing', function () { st.waiting = false; setNote(''); setToggle(false); wake(); });
  v.addEventListener('waiting', function () { st.waiting = true; busy(); });
  v.addEventListener('canplay', function () {
    st.waiting = false;
    var t = note.textContent;
    if (t === LOADING || t === CONVERTING) setNote(''); else busy();
  });
  v.addEventListener('pause', function () { setToggle(true); root.classList.remove('idle'); report(); });
  v.addEventListener('progress', showBuffer);
  v.addEventListener('loadedmetadata', drawMarks);
  v.addEventListener('timeupdate', function () {
    if (v.currentTime > 0 && !v.seeking && st.pending === null) st.at = pos();
    if (!st.dragging && st.pending === null) seek.value = pos();
    if (dur() && +seek.max !== Math.floor(dur())) seek.max = Math.floor(dur());
    showTime();
    showBuffer();
    if (st.pending === null && !st.dragging) checkMarks();
  });
  v.addEventListener('ended', function () {
    // Un flusso convertito che si interrompe a meta' non e' la fine del film:
    // si riprende da li'. (Se riprovando finisce di nuovo nello stesso punto, e' davvero finito.)
    if (st.transcoding && dur() && pos() < dur() - 45 && (st.endAt === null || Math.abs(st.endAt - pos()) > 2)) {
      st.endAt = pos();
      st.at = pos();
      recover();
      return;
    }
    report(true);
    // Scheda dei titoli di coda ancora aperta: si va dritti al prossimo episodio
    if (st.card && p.next && !st.sleepEnd) {
      st.done = true;
      hideCard();
      openNext(p.next).catch(function () { history.back(); });
      return;
    }
    st.done = true;
    setIntro(false);
    if (st.card) hideCard();
    if (p.next && prefs.autoplay !== false && !st.sleepEnd) {
      // Conto alla rovescia: il prossimo episodio parte da solo, ma si puo' fermare
      var left = 10;
      var startNext = function () {
        clearInterval(st.countdown);
        openNext(p.next).catch(function () { history.back(); });
      };
      var heading = function () {
        return 'Prossimo episodio tra ' + left + ' s' + (p.next_label ? ' — ' + p.next_label : '');
      };
      openPicker(heading(), [
        { value: 'go', label: 'Guarda subito' },
        { value: 'stay', label: 'Annulla (resta qui)' },
        { value: 'no', label: 'Torna alla scheda' }
      ], null, function (answer) {
        clearInterval(st.countdown);
        if (answer === 'go') startNext(); else if (answer === 'no') history.back();
      });
      modalState.countdown = true;
      st.countdown = setInterval(function () {
        // Finestra chiusa (Esc) o sostituita da un'altra: il conto si ferma
        if (player !== st || modal.hidden || !modalState || !modalState.countdown) { clearInterval(st.countdown); return; }
        left--;
        if (left <= 0) { closeModal(true); startNext(); return; }
        modal.querySelector('h3').textContent = heading();
      }, 1000);
    } else if (p.saga && !p.next && !st.sleepEnd) {
      // Fine di un film di una saga: il successivo si propone, non parte da solo
      openPicker('Saga ' + p.saga.name + ' · film ' + p.saga.number + ' di ' + p.saga.count, [
        { value: 'go', label: 'Guarda ' + sagaLabel() },
        { value: 'no', label: 'Torna alla scheda' }
      ], null, function (answer) {
        if (answer !== 'go') { history.back(); return; }
        openNext(p.saga.id).catch(function () { history.back(); });
      });
    } else history.back();
  });

  // Col mouse un clic mette in pausa e il doppio clic va a schermo intero. Col dito
  // un tocco mostra o nasconde i comandi e due tocchi ai lati saltano.
  var tap = { at: 0, timer: 0 };
  v.addEventListener('pointerdown', function (e) { st.touch = e.pointerType === 'touch'; });
  v.addEventListener('click', function (e) {
    if (!st.touch) { action('toggle'); return; }
    var now = Date.now(), x = e.clientX / (root.clientWidth || 1);
    var side = x < 0.38 ? -1 : (x > 0.62 ? 1 : 0);
    clearTimeout(tap.timer);
    if (side && now - tap.at < 320) { tap.at = now; action(side < 0 ? 'back' : 'fwd'); return; }
    tap.at = now;
    tap.timer = setTimeout(function () {
      if (root.classList.contains('idle') || v.paused) wake();
      else { clearTimeout(st.idle); root.classList.add('idle'); }
    }, side ? 300 : 0);
  });
  v.addEventListener('dblclick', function () { if (!st.touch) action('fs'); });

  seek.addEventListener('input', function () {
    st.dragging = true;
    root.classList.add('drag');
    showTime();
    if (dur()) showTip(+seek.value / dur());
    wake();
  });
  seek.addEventListener('change', function () {
    st.dragging = false;
    root.classList.remove('drag');
    track.classList.remove('hover');
    seekTo(+seek.value);
  });
  track.addEventListener('pointermove', function (e) {
    if (e.pointerType !== 'mouse' || !dur()) return;
    var r = track.getBoundingClientRect();
    showTip(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)));
  });
  track.addEventListener('pointerleave', function () { if (!st.dragging) track.classList.remove('hover'); });

  vol.addEventListener('input', function () { setVolume(vol.value / 100); wake(); });
  root.querySelector('.pvol').addEventListener('wheel', function (e) {
    e.preventDefault();
    setVolume((v.muted ? 0 : v.volume) + (e.deltaY < 0 ? 0.05 : -0.05));
    flash((v.volume ? IC.vol : IC.mute) + '<b>' + Math.round(v.volume * 100) + '%</b>');
    wake();
  }, { passive: false });

  if (window.PointerEvent) root.addEventListener('pointermove', function (e) { if (e.pointerType === 'mouse') wake(); });
  else root.addEventListener('mousemove', wake);
  all('.top, .bottom').forEach(function (el) {
    el.addEventListener('mouseenter', function () { st.over = true; });
    el.addEventListener('mouseleave', function () { st.over = false; wake(); });
  });
  root.addEventListener('click', function (e) {
    var b = e.target.closest('[data-p]');
    if (!b) return;
    action(b.getAttribute('data-p'));
    // Col mouse il bottone non resta acceso; col telecomando si resta nella fila
    if (!st.nav) b.blur();
  });

  st.onfs = function () {
    if (!fsBtn) return;
    var on = !!document.fullscreenElement;
    fsBtn.innerHTML = on ? PIC.fsOff : PIC.fsOn;
    fsBtn.setAttribute('data-tip', on ? 'Esci dallo schermo intero (F)' : 'Schermo intero (F)');
  };
  document.addEventListener('fullscreenchange', st.onfs);

  // Controllo ogni secondo: se il video dovrebbe andare ma e' fermo da troppo
  // (collegamento caduto dopo una pausa lunga, salto rimasto appeso…) lo si riapre.
  st.watch = setInterval(function () {
    var now = Date.now();
    if (st.sleepAt && now >= st.sleepAt) {
      st.sleepAt = 0;
      v.pause();
      toast('Spegnimento automatico: video in pausa');
    }
    // Scheda dei titoli di coda: il riempimento conta solo mentre il video va
    if (st.card && !st.done && !v.paused && modal.hidden && prefs.autoplay !== false && !st.sleepEnd) {
      st.cardLeft--;
      cardFill.style.transform = 'scaleX(' + (10 - st.cardLeft) / 10 + ')';
      if (st.cardLeft <= 0) goNext();
    }
    if (v.paused || v.ended || st.done || st.fatal || st.pending !== null || st.dragging) {
      if (v.paused && !st.dragging) showTime();    // in pausa l'ora di fine si sposta in avanti
      st.lastMove = now; st.lastT = v.currentTime;
      return;
    }
    if (v.currentTime !== st.lastT) {
      st.lastT = v.currentTime; st.lastMove = now;
      if (st.recov && now - st.recovAt > 30000) st.recov = 0;
      return;
    }
    if (now - st.lastMove > 3000 && !note.textContent) setNote(LOADING);
    if (now - st.lastMove > (st.transcoding ? 25000 : 15000)) recover();
  }, 1000);

  st.timer = setInterval(report, 10000);
  st.report = report;
  st.key = function (key) {
    var k = key.length === 1 ? key.toLowerCase() : key;
    if (st.nav) {
      // Nella fila dei bottoni: OK lo lascia al bottone (vedi il keydown generale)
      if (k === 'ArrowLeft') moveRow(-1);
      else if (k === 'ArrowRight') moveRow(1);
      else if (k === 'ArrowUp' || k === 'Escape' || k === 'Backspace') leaveRow();
      else if (k === 'ArrowDown') wake();
      else if (k === 'MediaPlayPause') action('toggle');
      else if (k === 'Enter' && !root.querySelector('.ctl').contains(document.activeElement)) enterRow();
      else return false;     // OK e Spazio: li riceve il bottone acceso
      return true;
    }
    if (st.card) {
      // Scheda dei titoli di coda: ← → tra i due bottoni, Indietro guarda i titoli
      if (k === 'ArrowLeft' || k === 'ArrowRight') { moveCard(k === 'ArrowLeft' ? -1 : 1); wake(); return true; }
      if (k === 'Escape' || k === 'Backspace') { watchCredits(); return true; }
      if (k === 'Enter' && !card.contains(document.activeElement)) { card.querySelector('.go').focus(); return true; }
    }
    if (st.introOn) {
      // «Salta intro» a schermo: OK lo preme, Indietro lo chiude
      if (k === 'Enter') { action('intro'); return true; }
      if (k === 'Escape' || k === 'Backspace') { closeIntro(); return true; }
    }
    if (k === ' ' || k === 'k' || k === 'Enter' || k === 'MediaPlayPause') action('toggle');
    else if (k === 'MediaPlay') { if (v.paused) action('toggle'); else wake(); }
    else if (k === 'MediaPause') { if (!v.paused) action('toggle'); else wake(); }
    else if (k === 'ArrowLeft' || k === 'j' || k === 'MediaRewind') action('back');
    else if (k === 'ArrowRight' || k === 'l' || k === 'MediaFastForward') action('fwd');
    else if (k === 'ArrowDown') enterRow();
    else if (k === 'ArrowUp') wake();        // mostra solo i comandi
    else if (k === 'MediaTrackNext') action('next');
    else if (k === 'm') action('mute');
    else if (k === 'f') action('fs');
    else if (k === 's') action('subs');
    else if (k === 'o') action('menu');
    else if (k === 'n') action('next');
    else if (k === 'i' && p.intro_end > 0) { seekTo(p.intro_end); wake(); }
    else if (k === '>' || k === '.') { setRate(SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(st.rate) + 1)]); wake(); }
    else if (k === '<' || k === ',') { setRate(SPEEDS[Math.max(0, SPEEDS.indexOf(st.rate) - 1)]); wake(); }
    else if (k >= '0' && k <= '9' && k.length === 1 && dur()) { seekTo(dur() * +k / 10); wake(); }
    else if (k === 'Home') { seekTo(0); wake(); }
    else if (k === 'Escape' || k === 'Backspace') action('exit');
    else return false;
    return true;
  };
  player = st;
  applyLook();
  setToggle(false);
  drawMarks();
  load(p.start || 0);
  wake();
  if (p.marks_pending && !p.friend) fetchMarks(1);
  // Le lingue disponibili: servono solo al menu, quindi si chiedono senza far aspettare il video
  api('/tracks/' + p.id).then(function (t) { if (player === st) st.audios = t.audio || []; }).catch(function () {});
}

function stopPlayer() {
  if (!player) return;
  var st = player;
  player = null;
  st.report();
  clearInterval(st.timer);
  clearInterval(st.watch);
  clearInterval(st.countdown);
  clearTimeout(st.idle);
  clearTimeout(st.seekTimer);
  clearTimeout(st.marksTimer);
  document.removeEventListener('fullscreenchange', st.onfs);
  try { st.v.pause(); st.v.removeAttribute('src'); st.v.load(); } catch (e) { /* niente */ }
  if (document.pictureInPictureElement && document.exitPictureInPicture) document.exitPictureInPicture().catch(function () {});
  if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen();
  document.body.classList.remove('playing');
}

// ---------------------------------------------------------------- Finestra di scelta

function openPicker(title, options, current, onPick) {
  modal.classList.remove('corner');
  modalState = { options: options, onPick: onPick, returnFocus: document.activeElement };
  modal.innerHTML = '<div class="sheet"><h3>' + esc(title) + '</h3><div class="opts">' + options.map(function (o, i) {
    return '<button class="opt f' + (o.value === current ? ' sel' : '') + '" data-act="opt" data-arg="' + i + '">' +
      (o.value === current ? '<span class="mark">' + IC.check + '</span>' : '') + esc(o.label) +
      (o.count !== undefined ? '<small>' + o.count + '</small>' : '') + '</button>';
  }).join('') + '</div></div>';
  modal.hidden = false;
  var first = modal.querySelector('.sel') || modal.querySelector('.opt');
  if (first) first.focus();
}

function confirmBox(question, yesLabel, onYes) {
  openPicker(question, [{ value: 'no', label: 'Annulla' }, { value: 'yes', label: yesLabel }], 'no', function (answer) {
    if (answer === 'yes') onYes();
  });
}

// Menu delle azioni di una scheda: clic su ⋯, tasto destro, oppure OK tenuto premuto
function openCardMenu(key) {
  var x = cardData[key];
  if (!x) return;
  var isShow = x.kind === 'show', isEp = x.kind === 'episode';
  var resume = !isShow && x.position > 20 && !x.watched;
  var opts = [];
  function add(label, fn) { opts.push({ value: String(opts.length), label: label, fn: fn }); }
  function fail(e) { toast(e.message); }

  if (!isShow) {
    add(resume ? 'Riprendi da ' + fmtTime(x.position) : 'Riproduci', function () { play(x.id, false); });
    if (resume) add('Riproduci dall\'inizio', function () { play(x.id, true); });
  }
  add('Apri la scheda', function () {
    location.hash = isShow ? '#/show/' + x.id : (isEp ? '#/show/' + x.show_id : '#/item/' + x.id);
  });
  add(isShow ? (x.watched ? 'Segna tutta la serie come da vedere' : 'Segna tutta la serie come vista')
             : (x.watched ? 'Segna come da vedere' : 'Segna come visto'), function () {
    post(isShow ? '/shows/' + x.id + '/watched' : '/watched/' + x.id, { watched: !x.watched }).then(render, fail);
  });
  if (!isEp && !x.friend) {
    add(x.fav ? 'Togli dalla mia lista' : 'Aggiungi alla mia lista', function () { setFav(x.kind, x.id, !x.fav); });
  }
  if (!isEp && !x.friend) {       // la scheda di un titolo di un amico la cura lui
    add('Correggi scheda (titolo sbagliato)', function () {
      location.hash = '#/match/' + (isShow ? 'show' : 'movie') + '/' + x.id;
    });
    add('Riscarica locandina e scheda', function () {
      toast('Aggiorno la scheda…');
      post('/refresh', isShow ? { show: x.id } : { item: x.id }).then(function () { toast('Scheda aggiornata'); render(); }, fail);
    });
  }
  openPicker(isEp ? (x.show_title || x.title) : x.title, opts, '-', function (v) { opts[+v].fn(); });
}

// Aggiorna una raccolta (o tutto): cerca file nuovi oppure riscarica le schede
function refreshMenu(libId) {
  var lib = libById(libId);
  if (!lib) return;
  openPicker('Aggiorna «' + lib.name + '»', [
    { value: 'scan', label: 'Cerca file nuovi o tolti' },
    { value: 'meta', label: 'Riscarica locandine e schede (forzato)' }
  ], '-', function (v) {
    if (v === 'scan') actions.scan();
    else forceRefresh({ library: lib.id });
  });
}

function forceRefresh(body) {
  post('/refresh', body).then(function () {
    toast('Riscarico le schede: ci vuole qualche minuto');
    scanWatch = true;
  }, function (e) { toast(e.message); });
}

// ---------------------------------------------------------------- Aggiornamento dell'app per la TV
// L'APK nuovo sta sul PC: l'app sulla TV confronta la propria versione con
// quella del server e, se e' piu' vecchia, propone di aggiornarsi da sola.

var updateLater = 0;                 // versione per cui si e' risposto "Più tardi" (fino al prossimo avvio)

function tvCall(name) {
  try { return typeof tvApp[name] === 'function' ? tvApp[name]() : null; }
  catch (e) { return null; }
}

function startUpdate() {
  openPicker('Scarico l\'aggiornamento… 0%', [{ value: 'bg', label: 'Continua in sottofondo' }], '-', function () {});
  modalState.update = true;
  tvApp.update();
}

function checkUpdate(manual) {
  if (!TV) return;
  api('/info').then(function (i) {
    if (!i.apk_version) { if (manual) toast('Sul PC non c\'è un APK: avvia strumenti/sviluppo/«Compila APK.bat»'); return; }
    var mine = +tvCall('getVersion') || 0;
    var canUpdate = !OLD_TV_APP && typeof tvApp.update === 'function';
    if (canUpdate && i.apk_version <= mine) { if (manual) toast('L\'app è già aggiornata'); return; }
    if (!manual) {
      if (updateLater === i.apk_version) return;
      // Non si sovrappone a un film o a un'altra finestra: riprova tra poco
      if (player || !modal.hidden || /^#\/play/.test(location.hash)) { setTimeout(checkUpdate, 20000); return; }
    }
    var name = i.apk_version_name ? ' (versione ' + i.apk_version_name + ')' : '';
    if (!canUpdate) {
      // App installata prima che esistesse l'aggiornamento automatico: l'ultima volta a mano.
      var told = '';
      try { told = localStorage.getItem('fpOldApp') || ''; } catch (e) {}
      if (!manual && told === String(i.apk_version)) return;
      try { localStorage.setItem('fpOldApp', String(i.apk_version)); } catch (e) {}
      openPicker(OLD_TV_APP
        ? 'È arrivata la nuova app BunkerPlex per la TV' + name + ' e sostituisce questa, che non riceverà più aggiornamenti. ' +
          'Installala con l\'app «Downloader», aprendo http://' + location.host + '/BunkerPlex.apk, poi disinstalla questa dalle impostazioni della TV.'
        : 'C\'è una versione più nuova dell\'app BunkerPlex' + name + '. Quella installata su questa TV non sa ancora aggiornarsi da sola: ' +
          'installa la nuova un\'ultima volta con l\'app «Downloader», aprendo http://' + location.host + '/BunkerPlex.apk. Dalla prossima farà tutto da sé.',
        [{ value: 'ok', label: 'Ho capito' }], 'ok', function () {});
      return;
    }
    openPicker('È disponibile un aggiornamento dell\'app BunkerPlex' + name + '. Vuoi installarlo adesso?',
      [{ value: 'yes', label: 'Aggiorna ora' }, { value: 'no', label: 'Più tardi' }], 'yes', function (answer) {
        if (answer === 'yes') startUpdate();
        else { updateLater = i.apk_version; toast('Puoi aggiornare quando vuoi da Impostazioni'); }
      });
  }).catch(function (e) { if (manual) toast(e.message); });
}

// L'app Android racconta qui come procede l'aggiornamento
window.fpUpdate = function (state, value) {
  var mine = modalState && modalState.update;
  if (state === 'progress') {
    if (mine) modal.querySelector('h3').textContent = 'Scarico l\'aggiornamento… ' + value + '%';
    return;
  }
  if (mine) closeModal(true);
  if (!modal.hidden || player) {   // c'e' altro sullo schermo: basta un avviso
    toast(state === 'install' ? 'Aggiornamento pronto: conferma l\'installazione' : 'Aggiornamento non riuscito');
    return;
  }
  if (state === 'install') {
    openPicker('Aggiornamento scaricato: conferma «Installa» o «Aggiorna» nella finestra della TV. ' +
      'Se la TV chiede il permesso di installare app sconosciute, consentilo per BunkerPlex e poi premi «Riprova».',
      [{ value: 'ok', label: 'Chiudi' }, { value: 'retry', label: 'Riprova' }], 'ok', function (answer) {
        if (answer === 'retry') startUpdate();
      });
  } else {
    openPicker('Aggiornamento non riuscito: ' + value + '. Controlla che il PC sia acceso e riprova.',
      [{ value: 'retry', label: 'Riprova' }, { value: 'no', label: 'Chiudi' }], 'retry', function (answer) {
        if (answer === 'retry') startUpdate();
      });
  }
};

// ---------------------------------------------------------------- Aggiornamento di BunkerPlex (da GitHub)
// Il server sul PC controlla da solo ogni 12 ore. Da qui (PC o TV) si vede
// l'avviso, si controlla a mano e si lancia l'installazione: il server scarica
// i file nuovi e la nuova app per la TV, poi si riavvia.

var serverUpdateLater = '';          // aggiornamento per cui si e' risposto "Più tardi"
var serverUpdating = false;

function updateWhat(u) {
  if (u.code && u.apk) return ' (programma e app per la TV)';
  if (u.apk) return ' (app per la TV)';
  if (u.docker && !u.code) return ' (il server sul PC va riallineato)';
  return '';
}

function updateTime(seconds) {
  if (!seconds) return '';
  try {
    return new Date(seconds * 1000).toLocaleString('it-IT', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  } catch (e) { return ''; }
}

function updatePanel(u) {
  if (!u || !u.enabled) return '';
  var state;
  if (u.access === false) state = dot(false) + ' Questo PC non ha ancora l\'accesso al repository privato degli aggiornamenti (<b>' + esc(u.repo) + '</b>).';
  else if (u.error) state = dot(false) + ' ' + esc(u.error);
  else if (u.phase === 'pc') state = dot(false) + ' Aggiornamento in corso sul PC: scarico le novità e riallineo Docker…';
  else if (u.phase === 'host') state = dot(false) + ' Aggiornamento scaricato: per completarlo rilancia <b>Installa BunkerPlex</b> sul computer.';
  else if (u.available) state = dot(false) + ' È disponibile un aggiornamento' + updateWhat(u) + '.';
  else if (u.checked_at) state = dot(true) + ' BunkerPlex è aggiornato.';
  else state = 'Il primo controllo parte un paio di minuti dopo l\'avvio.';
  var when = updateTime(u.checked_at);
  var hours = u.check_hours === 24 ? 'una volta al giorno' : 'ogni ' + u.check_hours + ' ore';
  return '<div class="panel"><h2>Aggiornamenti</h2>' +
    '<p>' + state + (when ? ' Ultimo controllo: ' + esc(when) + '.' : '') + '</p>' +
    '<p>Il server controlla da solo ' + hours + (u.auto
      ? ' e installa le novità quando nessuno sta guardando un video.'
      : ': ti avvisa, e decidi tu quando installare.') +
      (u.agent
        ? ' Sul PC è acceso l\'aiutante degli aggiornamenti: da qui, dalla TV o dal telefono si aggiorna tutto, Docker e pacchetti compresi' +
          (u.dev_copy ? ' (questa è la copia di sviluppo: il programma lo aggiorna git).' : '.')
        : (u.dev_copy ? ' Questa è la copia di sviluppo e l\'aiutante sul PC è spento: da qui arriva solo l\'app per la TV. Rilancia «Installa BunkerPlex» sul computer per riaccenderlo.'
                      : ' L\'aiutante sul PC è spento: le novità che toccano Docker si completano rilanciando «Installa BunkerPlex».')) + '</p>' +
    (u.access === false
      ? (TV ? '<p>Per dare l\'accesso apri <b>http://' + esc(location.host) + '</b> dal PC, Impostazioni → Aggiornamenti, e incolla il token di GitHub.</p>'
            : '<p>Incolla qui un token di GitHub di sola lettura per quel repository (come crearlo: README, «Per chi lo modifica»). Resta salvato sul disco di BunkerPlex.</p>' +
              '<div class="inline" style="margin-bottom:.8rem"><input class="field f" id="ghtoken" data-key="ghtoken" data-enter="updtoken" autocomplete="off" placeholder="Token di GitHub">' +
              '<button class="btn f" data-act="updtoken" data-key="updtoken">Salva</button></div>')
      : '') +
    '<div class="actions" style="margin-top:0">' +
      (u.available && !u.phase ? '<button class="btn primary f" data-act="updinstall" data-key="updinstall">Aggiorna ora</button>' : '') +
      '<button class="btn f" data-act="updcheck" data-key="updcheck">Controlla adesso</button>' +
      '<button class="btn f" data-act="updauto" data-arg="' + (u.auto ? '0' : '1') + '" data-key="updauto">Aggiornamento automatico: ' + (u.auto ? 'attivo' : 'spento') + '</button>' +
    '</div></div>';
}

// Segue l'installazione finche' il server non e' tornato su con la versione nuova
function watchServerUpdate() {
  serverUpdating = true;
  var down = false, tries = 0;
  openPicker('Aggiorno BunkerPlex… di solito basta un minuto, se c\'è da ricostruire Docker qualcuno in più. Il server si riaccende da solo.',
    [{ value: 'bg', label: 'Continua in sottofondo' }], '-', function () {});
  modalState.serverUpdate = true;
  var timer = setInterval(function () {
    tries++;
    fetch('/api/update', { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('spento');
      return r.json();
    }).then(function (u) {
      if (down) { clearInterval(timer); location.reload(); return; }   // e' ripartito: si ricarica l'interfaccia nuova
      if (u.phase === 'restarting') { down = true; return; }
      if (u.phase === 'installing' || u.phase === 'checking' || u.phase === 'pc') return;
      clearInterval(timer);
      serverUpdating = false;
      if (modalState && modalState.serverUpdate) closeModal(true);
      if (u.phase === 'host') {
        openPicker('Aggiornamento scaricato. Per completarlo rilancia «Installa BunkerPlex» sul computer.',
          [{ value: 'ok', label: 'Ho capito' }], 'ok', function () {});
      } else if (u.error) {
        openPicker('Aggiornamento non riuscito: ' + u.error, [{ value: 'ok', label: 'Chiudi' }], 'ok', function () {});
      } else {
        toast('BunkerPlex è aggiornato');
        if (/^#\/settings/.test(location.hash)) render();
        if (TV) setTimeout(checkUpdate, 1500);     // e' arrivata una nuova app per la TV?
      }
    }).catch(function () {
      down = true;
      // Una ricostruzione di Docker da zero puo' tenere spento il server per diversi minuti
      if (tries > 600) { clearInterval(timer); serverUpdating = false; }
    });
  }, 2000);
}

function startServerUpdate() {
  post('/update/install').then(watchServerUpdate, function (e) { toast(e.message); });
}

function checkServerUpdate() {
  if (serverUpdating) return;
  api('/update').then(function (u) {
    // Aggiornamento gia' in corso (partito da un altro dispositivo, o il server si
    // e' appena riacceso a meta' lavoro): si segue fino alla fine
    if (u.phase === 'pc' && !player && modal.hidden && !/^#\/play/.test(location.hash)) { watchServerUpdate(); return; }
    if (!u.enabled || !u.available || u.phase) return;
    var sig = u.remote + (u.apk ? '+tv' : '');
    if (serverUpdateLater === sig) return;
    // Non si sovrappone a un film o a un'altra finestra: riprova tra poco
    if (player || !modal.hidden || /^#\/play/.test(location.hash)) { setTimeout(checkServerUpdate, 60000); return; }
    openPicker('È disponibile un aggiornamento di BunkerPlex' + updateWhat(u) + '. Vuoi installarlo adesso?' +
      (TV ? ' Si aggiorna il server sul PC; se c\'è una nuova app, subito dopo la TV propone di installarla.' : ''),
      [{ value: 'yes', label: 'Aggiorna ora' }, { value: 'no', label: 'Più tardi' }], 'yes', function (answer) {
        if (answer === 'yes') startServerUpdate();
        else { serverUpdateLater = sig; toast('Puoi aggiornare quando vuoi da Impostazioni'); }
      });
  }).catch(function () {});
}

function closeModal(silent) {
  if (modal.hidden) return false;
  var back = modalState && modalState.returnFocus;
  modal.hidden = true;
  modal.innerHTML = '';
  modal.classList.remove('corner');
  modalState = null;
  if (!silent && back && document.body.contains(back)) back.focus();
  return true;
}

// ---------------------------------------------------------------- Azioni (click / OK)

function libsChanged(message) {
  if (message) toast(message);
  scanWatch = true;
  return loadLibs(true);
}

function relocateFolder(lib, folder) {
  return post('/libraries/' + lib.id + '/folders/relocate', { path: folder.path, to: folder.moved_to }).then(function (r) {
    return libsChanged('Percorso aggiornato: ' + r.display);
  }, function (e) { toast(e.message); });
}

// Segnala (una volta per ogni situazione nuova) le cartelle che su questo PC
// non sono dove erano state scelte: disco scollegato o con un'altra lettera.
var pathWarned = '';
function warnPaths() {
  var bad = [];
  libs.forEach(function (l) {
    l.folders.forEach(function (f) { if (!f.online) bad.push({ lib: l, f: f }); });
  });
  var sig = bad.map(function (b) { return b.f.path + '>' + (b.f.moved_to || ''); }).join('|');
  if (sig === pathWarned) return;
  if (!sig) { pathWarned = ''; return; }
  if (player || !modal.hidden || /^#\/(settings|browse|play)/.test(location.hash)) return;
  pathWarned = sig;
  var moved = bad.filter(function (b) { return b.f.moved_to; });
  var text = 'Su questo PC ' + (bad.length === 1 ? 'una cartella non è' : bad.length + ' cartelle non sono') + ' dove me le aspettavo: ' +
    bad.map(function (b) {
      return b.f.display + (b.f.moved_to ? ' (ora è in ' + b.f.moved_display + ')' : ' (non raggiungibile: disco scollegato?)');
    }).join(', ') + '.';
  if (moved.length) {
    openPicker(text, [{ value: 'no', label: 'Non ora' }, { value: 'yes', label: 'Usa i nuovi percorsi' }], 'yes', function (answer) {
      if (answer !== 'yes') return;
      moved.reduce(function (p, b) { return p.then(function () { return relocateFolder(b.lib, b.f); }); }, Promise.resolve()).then(render);
    });
  } else {
    openPicker(text + ' I titoli restano in catalogo, ma i video non partono finché non colleghi il disco: appena lo colleghi tornano da soli.',
      [{ value: 'ok', label: 'Ho capito' }, { value: 'set', label: 'Apri Impostazioni' }], 'ok', function (answer) {
        if (answer === 'set') location.hash = '#/settings/libraries';
      });
  }
}

function addFolder(path) {
  var rep = cache.browseReplace && cache.browseReplace.lib === cache.browse.lib ? cache.browseReplace.display : '';
  cache.browseReplace = null;
  return post('/libraries/' + cache.browse.lib + '/folders', { path: path, replace: rep }).then(function (r) {
    return libsChanged(r.added.length ? 'Aggiunta ' + r.added[0] + ': la sto leggendo' : 'Questa cartella c\'era già');
  });
}

function fieldValue(id) { var el = document.getElementById(id); return el ? el.value : ''; }

function enterApp(r) {
  try { sessionStorage.removeItem('fpNoAuto'); sessionStorage.removeItem('fpPwLater'); } catch (e) { /* niente */ }
  var wasLocal = !!(auth && auth.user && !auth.user.linked);
  auth = null;
  cache.whoMode = '';
  libsLoadedAt = 0;
  return loadAuth().then(function () {
    if (auth.user && !auth.user.must_change) return afterLogin(r && r.conflicts);
  }).then(function () {
    if (r && r.offline) toast('Entrato senza Internet: si sincronizza appena torna la rete');
    else if (r && r.switched) toast('Questo account aveva già il suo profilo su questo PC: sei entrato in quello');
    else if (wasLocal && auth.user && auth.user.linked) toast('Fatto: il profilo ora è il tuo account, sto sincronizzando');
    // Dalle impostazioni si resta li'; dalla scelta del profilo si va alla Home
    if (!/^#\/settings/.test(location.hash) || !auth.user) location.replace('#/home');
    render();
  });
}

var actions = {
  // --- profili e account
  login: function () {
    var name = fieldValue('lname').trim(), pass = fieldValue('lpass');
    if (!name || !pass) { toast('Scrivi nome utente e password'); return; }
    toast('Entro…');
    post('/auth/login', { username: name, password: pass, device: devName() }).then(enterApp, function (e) {
      toast(e.message);
      loadAuth().then(render);
    });
  },
  setup: function () {
    var name = fieldValue('lname').trim(), pass = fieldValue('lpass');
    if (!name || !pass) { toast('Scrivi nome utente e password'); return; }
    if (pass !== fieldValue('lpass2')) { toast('Le due password non sono uguali'); return; }
    toast('Creo l\'account…');
    post('/auth/setup', { username: name, password: pass, device: devName() }).then(enterApp, function (e) { toast(e.message); });
  },
  profile: function (id) {
    post('/auth/profile', { id: +id, device: devName() }).then(enterApp, function (e) {
      if (/password/.test(e.message)) { cache.whoMode = 'pw:' + id; render(); return; }
      toast(e.message);
      loadAuth().then(render);
    });
  },
  whomode: function (mode) {
    cache.whoMode = cache.whoMode === mode ? '' : mode;
    render();
  },
  newprofile: function () {
    var name = fieldValue('pname').trim();
    if (!name) { toast('Scrivi un nome'); return; }
    post('/auth/profiles', { name: name, device: devName() }).then(enterApp, function (e) { toast(e.message); });
  },
  renameprofile: function () {
    var name = fieldValue('pname').trim();
    if (!name) { toast('Scrivi un nome'); return; }
    post('/auth/rename', { name: name }).then(function () {
      toast('Fatto');
      return loadAuth().then(render);
    }, function (e) { toast(e.message); });
  },
  delprofile: function () {
    var u = auth.user, heir = (auth.profiles || []).filter(function (p) { return p.id !== u.id; })[0];
    confirmBox('Togliere il profilo «' + u.name + '» da questo PC? Visti, punti di ripresa e lista di qui si perdono' +
      (u.linked ? ' (quelli già nell\'account restano online)' : '') + '. Le sue raccolte passano a ' + (heir ? heir.name : 'un altro profilo') + ': i video non si toccano.',
      'Sì, togli il profilo', function () {
        send('DELETE', '/auth/profile').then(function () {
          try { sessionStorage.setItem('fpNoAuto', '1'); } catch (e) { /* niente */ }
          auth = null;
          conflicts = null;
          toast('Profilo tolto');
          location.replace('#/home');
          render();
        }, function (e) { toast(e.message); });
      });
  },
  unlink: function () {
    confirmBox('Scollegare l\'account da questo profilo? Il profilo resta qui con tutto quello che ha, ma smette di sincronizzarsi. ' +
      'L\'account resta online e lo ritrovi entrando di nuovo. La condivisione con gli amici già attiva resta com\'è.',
      'Sì, scollega', function () {
        post('/auth/unlink').then(function () {
          toast('Account scollegato: il profilo ora è solo di questo PC');
          return loadAuth().then(render);
        }, function (e) { toast(e.message); });
      });
  },
  pcname: function () {
    post('/pc-name', { name: fieldValue('pcname') }).then(function (r) {
      toast('Questo PC ora si chiama «' + r.pc + '»');
      render();
    }, function (e) { toast(e.message); });
  },
  // --- amici dell'account
  afadd: function () {
    var name = fieldValue('afname').trim();
    if (!name) { toast('Scrivi il nome dell\'account del tuo amico'); return; }
    post('/account-friends', { username: name }).then(function (r) {
      toast(r.status === 'ok' ? 'Ora tu e ' + r.username + ' siete amici' : 'Richiesta mandata a ' + r.username + ': aspetta che accetti');
      render();
    }, function (e) { toast(e.message); });
  },
  afaccept: function (id) {
    post('/account-friends/' + id + '/accept').then(function () {
      toast('Ora siete amici: le sue raccolte compaiono tra poco');
      libsLoadedAt = 0;
      render();
    }, function (e) { toast(e.message); });
  },
  afremove: function (arg) {
    var parts = arg.split(':'), id = parts[0], name = parts.slice(1).join(':');
    var go = function () {
      send('DELETE', '/account-friends/' + id).then(function () { libsLoadedAt = 0; render(); }, function (e) { toast(e.message); });
    };
    if (name === 'no') { go(); return; }
    confirmBox('Togliere ' + name + ' dai tuoi amici? Non vedrete più le raccolte l\'uno dell\'altro.', 'Sì, togli', go);
  },
  afshare: function (arg) {
    toast(arg === '1' ? 'Apro la porta per gli amici…' : 'Spengo la condivisione…');
    post('/account-friends/share', { on: arg === '1' }).then(function () { render(); }, function (e) { toast(e.message); });
  },
  pwlater: function () {
    try { sessionStorage.setItem('fpPwLater', '1'); } catch (e) { /* niente */ }
    render();
  },
  pairsend: function (code) {
    var name = fieldValue('lname').trim(), pass = fieldValue('lpass'), pw = fieldValue('pnew');
    if (!name || !pass) { toast('Scrivi nome utente e password'); return; }
    if (cache.pairNeedNew === code) {
      if (!pw) { toast('Scegli la password nuova'); return; }
      if (pw !== fieldValue('pnew2')) { toast('Le due password nuove non sono uguali'); return; }
    }
    toast('Entro…');
    post('/auth/pair/' + code, { username: name, password: pass, new: pw }).then(function (r) {
      cache.pairDone = { code: code, name: r.name };
      render();
    }, function (e) {
      if (/provvisoria/.test(e.message) && cache.pairNeedNew !== code) { cache.pairNeedNew = code; render(); }
      toast(e.message);
    });
  },
  changepw: function (forced) {
    var old = fieldValue('pold'), pw = fieldValue('pnew');
    if (!old || !pw) { toast('Scrivi la password attuale e quella nuova'); return; }
    if (pw !== fieldValue('pnew2')) { toast('Le due password nuove non sono uguali'); return; }
    toast('Salvo…');
    post('/auth/password', { old: old, new: pw }).then(function (r) {
      toast('Password cambiata');
      if (forced) return enterApp(r);
      history.back();
    }, function (e) { toast(e.message); });
  },
  logout: function () {
    post('/auth/logout').catch(function () {}).then(function () {
      try { sessionStorage.setItem('fpNoAuto', '1'); } catch (e) { /* niente */ }
      auth = null;
      conflicts = null;
      location.replace('#/home');
      render();
    });
  },
  resolve: function (keep) {
    var list = conflicts || [];
    var hasServer = list.some(function (c) { return c.key !== 'prefs'; });
    var hasPrefs = list.some(function (c) { return c.key === 'prefs'; });
    (hasServer ? post('/auth/resolve', { keep: keep }) : Promise.resolve()).then(function () {
      if (hasPrefs) {
        if (keep === 'local') return sendPrefs();
        applyPrefs(cache.remotePrefs || {});
      }
    }).then(function () {
      conflicts = null;
      markAccount();
      toast(keep === 'local' ? 'Fatto: l\'account ora ha le impostazioni di qui' : 'Fatto: usi le impostazioni dell\'account');
      location.replace('#/home');
      render();
    }, function (e) { toast(e.message); });
  },
  tvquick: function (arg) {
    post('/auth/options', { tv_quick: arg === '1' }).then(function () { return loadAuth(); }).then(render, function (e) { toast(e.message); });
  },
  dropmissing: function (arg) {
    var parts = arg.split(':'), lib = libById(parts[0]);
    var m = lib && lib.missing && lib.missing[+parts[1]];
    if (!m) return;
    confirmBox('Togliere ' + m + ' dalla raccolta «' + lib.name + '» su tutti i PC del tuo account? I file non si toccano.', 'Sì, toglila dall\'account', function () {
      post('/libraries/' + lib.id + '/missing/remove', { display: m }).then(function () {
        return libsChanged('Cartella tolta dall\'account').then(render);
      }).catch(function (e) { toast(e.message); });
    });
  },
  pushlocal: function () {
    var away = 0, onlyAway = 0;
    libs.forEach(function (l) {
      if (l.mine === false) return;
      var n = (l.missing || []).length;
      if (n && !(l.folders || []).length) onlyAway++;
      else away += n;
    });
    var what = away || onlyAway
      ? ' Dall\'account (e dagli altri PC) ' + (away + onlyAway === 1 ? 'esce ' : 'escono ') + [away ? (away === 1 ? 'una cartella che qui non c\'è' : away + ' cartelle che qui non ci sono') : '',
          onlyAway ? (onlyAway === 1 ? 'una raccolta che qui non ha cartelle' : onlyAway + ' raccolte che qui non hanno cartelle') : ''].filter(Boolean).join(' e ') + '.'
      : ' Adesso l\'account e questo PC hanno già le stesse raccolte.';
    confirmBox('Le raccolte del tuo account diventano quelle di questo PC.' + what + ' Visti, punti di ripresa e La mia lista non cambiano.',
      'Sì, sovrascrivi l\'account', function () {
        post('/libraries/push-local').then(function () {
          return libsChanged('Fatto: l\'account ha le raccolte di questo PC').then(render);
        }).catch(function (e) { toast(e.message); });
      });
  },
  activity: function () { openActivity(); },
  actgo: function (href) {
    closeModal(true);
    if (location.hash === href) render(); else location.hash = href;
  },
  copysecret: function () {
    copyText(cache.secret || '').then(function (ok) { toast(ok ? 'Copiati negli appunti' : 'Non riesco a copiare: scrivili a mano'); });
  },
  closemodal: function () { closeModal(); },
  regenpass: function () {
    var input = document.getElementById('apass');
    if (input) input.value = tempPassword();
  },
  accadmin: function () {
    cache.newAdmin = !cache.newAdmin;
    var v = document.getElementById('accadminv');
    if (v) v.textContent = cache.newAdmin ? 'Sì' : 'No';
  },
  acccreate: function () {
    var name = fieldValue('aname').trim(), pass = fieldValue('apass').trim();
    if (!name || !pass) { toast('Scrivi nome utente e password provvisoria'); return; }
    post('/accounts', { username: name, password: pass, admin: !!cache.newAdmin }).then(function () {
      render().then(function () { showSecret('Account creato', name, pass); });
    }, function (e) { toast(e.message); });
  },
  accreset: function (id) {
    var a = (cache.accounts || []).filter(function (x) { return String(x.id) === String(id); })[0];
    if (!a) return;
    confirmBox('Dare a «' + a.username + '» una nuova password provvisoria? Uscirà da tutti i PC.', 'Sì, nuova password', function () {
      var pass = tempPassword();
      post('/accounts/' + a.id + '/password', { username: a.username, password: pass }).then(function () {
        render().then(function () { showSecret('Nuova password provvisoria', a.username, pass); });
      }, function (e) { toast(e.message); });
    });
  },
  accremove: function (id) {
    var a = (cache.accounts || []).filter(function (x) { return String(x.id) === String(id); })[0];
    if (!a) return;
    confirmBox('Eliminare l\'account «' + a.username + '»? Perde impostazioni, visti e lista su tutti i PC.', 'Sì, elimina', function () {
      api('/accounts/' + a.id, { method: 'DELETE' }).then(function () { toast('Account eliminato'); render(); }, function (e) { toast(e.message); });
    });
  },
  libshare: function (arg) {
    var parts = arg.split(':');
    send('PATCH', '/libraries/' + parts[0], { shared: parts[1] === '1' }).then(function () {
      toast(parts[1] === '1' ? 'Ora la vedono anche gli altri account di questo PC' : 'Ora la vedi solo tu');
      return loadLibs(true).then(render);
    }).catch(function (e) { toast(e.message); });
  },

  play: function (arg) { play(arg, false); },
  playstart: function (arg) { play(arg, true); },
  watched: function (arg) {
    var parts = arg.split(':');
    post('/watched/' + parts[0], { watched: parts[1] === '1' }).then(render, function (e) { toast(e.message); });
  },
  filter: openFilter,
  clearfilters: function (libId) {
    var q = parseQuery(location.hash), target = '#/lib/' + libId + buildQuery({ sort: q.sort });
    focusMemory[target] = 'filter-sort';
    location.replace(target);
  },
  season: function (arg) {
    var parts = arg.split(':'), target = '#/show/' + parts[0] + '?season=' + parts[1];
    focusMemory[target] = 'season-' + parts[1];
    if (target !== location.hash) location.replace(target);
  },
  opt: function (arg) {
    var st = modalState;
    if (!st) return;
    var o = st.options[+arg];
    closeModal();
    st.onPick(o.value);
  },
  scan: function () {
    post('/scan').then(function () { toast('Controllo le cartelle…'); scanWatch = true; setTimeout(pollActivity, 400); });
  },
  savekey: function () {
    var input = document.getElementById('tmdbkey');
    if (!input || !input.value.trim()) { toast('Incolla prima la chiave'); return; }
    toast('Verifico la chiave…');
    post('/settings', { tmdb_key: input.value.trim() }).then(function () {
      toast('Chiave salvata: scarico le schede');
      scanWatch = true;
      render();
    }, function (e) { toast(e.message); });
  },
  saveos: function (arg) {
    function val(id) { var el = document.getElementById(id); return el ? el.value : ''; }
    var body = arg === 'remove' ? { remove: true }
      : { key: val('oskey').trim(), user: val('osuser').trim(), password: val('ospass') };
    toast(arg === 'remove' ? 'Disattivo…' : 'Provo la chiave su OpenSubtitles…');
    post('/settings/opensubtitles', body).then(function () {
      toast(arg === 'remove' ? 'Sottotitoli da internet disattivati' : 'Fatto: ora puoi cercare i sottotitoli dai film');
      render();
    }, function (e) { toast(e.message); });
  },
  resetserver: function () { if (TV) tvApp.resetServer(); },

  // --- amici
  friendadd: function (arg) {
    function val(id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; }
    var body = { name: val('fname'), url: val('furl'), my_url: val('fmy'), user: val('fuser'),
      password: (document.getElementById('fpass') || {}).value || '', register: arg === '1' };
    if (!body.url || !body.user || !body.password) { toast('Scrivi indirizzo, nome e password'); return; }
    toast('Contatto il server dell\'amico…');
    post('/friends', body).then(function (r) {
      toast(r.approved ? 'Collegato: le sue raccolte arrivano tra poco' : 'Richiesta inviata: ora deve accettarla lui');
      libsLoadedAt = 0;
      setTimeout(render, 2500);
    }, function (e) { toast(e.message); });
  },
  frienddel: function (n) {
    confirmBox('Togliere questo amico? Non vedrai più le sue raccolte e lui non vedrà più le tue.', 'Sì, toglilo', function () {
      api('/friends/' + n, { method: 'DELETE' }).then(function () {
        return libsChanged('Amico tolto').then(render);
      }).catch(function (e) { toast(e.message); });
    });
  },
  friendretry: function (n) {
    toast('Riprovo il collegamento…');
    post('/friends/' + n + '/refresh').then(function () {
      setTimeout(function () { libsLoadedAt = 0; render(); }, 3000);
    }, function (e) { toast(e.message); });
  },
  friendquality: function () {
    openPicker('Qualità dei video degli amici', QUALITIES.map(function (q) { return { value: q[0], label: q[1] }; }), friendQuality, function (q) {
      post('/friends/quality', { quality: q }).then(function () { libsLoadedAt = 0; render(); }, function (e) { toast(e.message); });
    });
  },
  sharetoggle: function (arg) {
    post('/sharing', { on: arg === '1' }).then(function () {
      toast(arg === '1' ? 'Condivisione attiva: chiedo al router di aprire la porta…' : 'Condivisione spenta');
      render();
      if (arg === '1') setTimeout(render, 4000);     // il tempo di parlare con il router
    }, function (e) { toast(e.message); });
  },
  shareport: function (arg) {
    post('/sharing', { auto_port: arg === '1' }).then(function () {
      toast(arg === '1' ? 'Chiedo al router di aprire la porta…' : 'Porta richiusa sul router');
      setTimeout(render, arg === '1' ? 4000 : 1500);
    }, function (e) { toast(e.message); });
  },
  accapprove: function (arg) {
    var parts = arg.split(':');
    post('/sharing/accounts/' + parts[0], { approved: parts[1] === '1' }).then(function (r) {
      toast(parts[1] !== '1' ? 'Sospeso: non può più entrare' : (r.linked ? 'Accettato: ora vi vedete a vicenda' : 'Accettato'));
      libsLoadedAt = 0;
      setTimeout(render, r.linked ? 2500 : 0);
    }, function (e) { toast(e.message); });
  },
  accdel: function (id) {
    confirmBox('Togliere questo amico? Non potrà più vedere le tue raccolte, e le sue spariscono da qui.', 'Sì, toglilo', function () {
      api('/sharing/accounts/' + id, { method: 'DELETE' }).then(function () {
        return libsChanged('Fatto').then(render);
      }).catch(function (e) { toast(e.message); });
    });
  },
  checkupdate: function () { checkUpdate(true); },
  updcheck: function () {
    toast('Controllo su GitHub…');
    post('/update/check').then(function (u) {
      toast(u.access === false ? 'Questo PC non ha l\'accesso al repository' : (u.error || (u.available ? 'C\'è un aggiornamento' + updateWhat(u) : 'BunkerPlex è già aggiornato')));
      render();
    }, function (e) { toast(e.message); });
  },
  updinstall: function () { startServerUpdate(); },
  updauto: function (arg) {
    post('/update/auto', { auto: arg === '1' }).then(render, function (e) { toast(e.message); });
  },
  updtoken: function () {
    var input = document.getElementById('ghtoken');
    if (!input || !input.value.trim()) { toast('Incolla prima il token'); return; }
    toast('Verifico il token…');
    post('/update/token', { token: input.value.trim() }).then(function () {
      toast('Token salvato');
      render();
    }, function (e) { toast(e.message); });
  },
  goback: function () { history.back(); },
  refreshmenu: refreshMenu,

  // --- lista, lettere, scelta a caso
  fav: function (arg) {
    var parts = arg.split(':');
    setFav(parts[0], parts[1], parts[2] === '1');
  },
  showwatched: function (arg) {
    var parts = arg.split(':');
    post('/shows/' + parts[0] + '/watched', { watched: parts[1] === '1' }).then(render, function (e) { toast(e.message); });
  },
  letters: openLetters,
  letter: function (arg) { closeModal(true); goToCard(+arg); },
  lucky: lucky,
  searchfor: function (text) {
    if (!cache.searchRun) return;
    cache.searchRun(text);
    var first = view.querySelector('#grid .card');
    if (first && kb) first.focus();
  },

  // --- questo dispositivo
  devanim: function () {
    openPicker('Animazioni', ANIMS.map(function (a) {
      return { value: a[0], label: a[1] + (a[0] === '' ? ' (si riducono da sole se il dispositivo è lento)' : '') };
    }), device.anim || '', function (value) {
      device.anim = value;
      if (value === 'full') device.slow = false;
      saveDevicePrefs(device); applyDevice(); render();
    });
  },
  devposters: function () {
    openPicker('Locandine nelle raccolte', POSTERS.map(function (a) { return { value: a[0], label: a[1] }; }), device.posters || '', function (value) {
      device.posters = value;
      saveDevicePrefs(device); applyDevice(); render();
    });
  },
  devtv: function () {
    device.tv = !device.tv;
    saveDevicePrefs(device);
    location.replace(location.pathname + '#/settings/device');
    location.reload();
  },
  refreshall: function () {
    confirmBox('Riscaricare locandine e schede di tutto il catalogo?', 'Sì, riscarica tutto', function () { forceRefresh({ all: true }); });
  },

  // --- raccolte
  idea: function (name) {
    var input = document.getElementById('libname');
    input.value = name;
    var go = view.querySelector('[data-act=createlib]');
    if (go) go.focus();
  },
  createlib: function () {
    var input = document.getElementById('libname');
    if (!input || !input.value.trim()) { toast('Scrivi un nome per la raccolta'); if (input) input.focus(); return; }
    post('/libraries', { name: input.value.trim() }).then(function (r) {
      return libsChanged('Raccolta creata: ora scegli le cartelle').then(function () {
        location.replace('#/browse/' + r.id);
      });
    }).catch(function (e) { toast(e.message); });
  },
  renamelib: function () {
    var input = document.getElementById('libname');
    if (!input || !input.value.trim()) { toast('Scrivi un nome'); return; }
    send('PATCH', '/libraries/' + cache.rename, { name: input.value.trim() }).then(function () {
      return loadLibs(true).then(function () { toast('Nome cambiato'); history.back(); });
    }).catch(function (e) { toast(e.message); });
  },
  dellib: function (id) {
    var lib = libById(id);
    confirmBox('Eliminare la raccolta «' + (lib ? lib.name : '') + '»?', 'Sì, elimina (i file restano sul PC)', function () {
      api('/libraries/' + id, { method: 'DELETE' }).then(function () {
        return libsChanged('Raccolta eliminata').then(render);
      }).catch(function (e) { toast(e.message); });
    });
  },
  relocate: function (arg) {
    var parts = arg.split(':'), lib = libById(parts[0]);
    var folder = lib && lib.folders[+parts[1]];
    if (folder) relocateFolder(lib, folder).then(render);
  },
  delfolder: function (arg) {
    var parts = arg.split(':'), lib = libById(parts[0]);
    var folder = lib && lib.folders[+parts[1]];
    if (!folder) return;
    confirmBox('Togliere ' + folder.display + ' dalla raccolta?', 'Sì, toglila (i file restano sul PC)', function () {
      post('/libraries/' + lib.id + '/folders/remove', { path: folder.path }).then(function () {
        return libsChanged('Cartella tolta').then(render);
      }).catch(function (e) { toast(e.message); });
    });
  },
  browse: function (path) {
    var target = '#/browse/' + cache.browse.lib + '?path=' + encodeURIComponent(path);
    location.replace(target);
  },
  usefolder: function () {
    addFolder(cache.browse.path).then(function () { history.back(); }, function (e) { toast(e.message); });
  },
  pastefolder: function () {
    var input = document.getElementById('pastepath');
    if (!input || !input.value.trim()) { toast('Incolla prima il percorso'); return; }
    addFolder(input.value.trim()).then(function () { history.back(); }, function (e) { toast(e.message); });
  },

  matchsearch: matchSearch,
  matchpick: function (arg) {
    toast('Aggiorno la scheda…');
    post('/match', { kind: cache.match.kind, id: +cache.match.id, tmdb_id: +arg })
      .then(function () { toast('Scheda aggiornata'); history.back(); }, function (e) { toast(e.message); });
  }
};

document.addEventListener('click', function (e) {
  if (e.target === modal) { closeModal(); return; }
  var more = e.target.closest ? e.target.closest('[data-menu]') : null;
  if (more) {
    e.preventDefault();
    var owner = more.closest('.card');
    if (owner) openCardMenu(owner.getAttribute('data-key'));
    return;
  }
  var el = e.target.closest ? e.target.closest('[data-act]') : null;
  if (!el) return;
  var fn = actions[el.getAttribute('data-act')];
  if (fn) { e.preventDefault(); fn(el.getAttribute('data-arg')); }
});

// ---------------------------------------------------------------- Navigazione con le frecce

function isVisible(el) {
  var r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function byKey(key) {
  if (!key) return null;
  var all = document.querySelectorAll('[data-key]');
  for (var i = 0; i < all.length; i++) if (all[i].getAttribute('data-key') === key) return all[i];
  return null;
}

function focusView() {
  var el = byKey(focusMemory[currentHash]);
  if (!el || !view.contains(el)) el = view.querySelector('[data-autofocus]') || view.querySelector('.f');
  if (el) el.focus();
}

function focusRail() {
  var el = rail.querySelector('.railitem.on') || rail.querySelector('.railitem');
  if (el) el.focus();
}

function move(dir) {
  var cur = document.activeElement;
  var inModal = !modal.hidden;
  if (!cur || !cur.classList || !cur.classList.contains('f') || (inModal && !modal.contains(cur))) {
    if (inModal) { var first = modal.querySelector('.f'); if (first) first.focus(); }
    else focusView();
    return;
  }
  var inRail = rail.contains(cur);
  if (inRail && dir === 'right') { focusView(); return; }
  if (inRail && dir === 'left') return;
  // Ogni zona si naviga per conto suo: finestra di scelta, barra laterale, pagina
  var scope = inModal ? modal : (inRail ? rail : view);
  var a = cur.getBoundingClientRect();
  var horizontal = dir === 'left' || dir === 'right';
  var cands = [];
  var list = scope.querySelectorAll('.f');
  for (var i = 0; i < list.length; i++) {
    var el = list[i];
    if (el === cur) continue;
    var b = el.getBoundingClientRect();
    if (!b.width || !b.height) continue;
    var main, cross;
    if (horizontal) {
      if (Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) <= Math.min(a.height, b.height) * 0.25) continue;
      main = dir === 'right' ? b.left - a.right : a.left - b.right;
      if (main < -4) continue;
      cross = Math.abs((b.top + b.bottom) / 2 - (a.top + a.bottom) / 2);
    } else {
      main = dir === 'down' ? b.top - a.bottom : a.top - b.bottom;
      if (main < -4) continue;
      var overlap = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      cross = overlap > 0
        ? Math.abs((b.left + b.right) / 2 - (a.left + a.right) / 2) / 1000
        : Math.min(Math.abs(b.left - a.right), Math.abs(a.left - b.right)) + 1;
    }
    cands.push({ el: el, main: Math.max(0, main), cross: cross });
  }
  if (!cands.length) {
    if (dir === 'left' && !inRail && !inModal) focusRail();   // dal bordo sinistro si entra nel menu
    return;
  }
  // Prima la riga/colonna piu' vicina, poi l'elemento piu' allineato
  var nearest = Math.min.apply(null, cands.map(function (c) { return c.main; }));
  var tol = horizontal ? 8 : Math.max(24, a.height * 0.4);
  var best = null;
  cands.forEach(function (c) {
    if (c.main > nearest + tol) return;
    if (!best || c.cross < best.cross || (c.cross === best.cross && c.main < best.main)) best = c;
  });
  var target = best.el;
  if (!horizontal) {   // entrando in una fila si torna dove si era rimasti
    var row = target.closest('.row');
    if (row && row !== cur.closest('.row') && row._last && row.contains(row._last) && isVisible(row._last)) target = row._last;
  }
  target.focus();
}

// Scorrimento: morbido dove il dispositivo regge, immediato con le animazioni ridotte
function scrollBox(box, pos) {
  pos.behavior = smooth;
  try { box.scrollTo(pos); }
  catch (e) {   // browser vecchi: niente opzioni
    if (pos.left !== undefined) box.scrollLeft = pos.left;
    if (pos.top !== undefined) { if (box === window) window.scrollTo(0, pos.top); else box.scrollTop = pos.top; }
  }
  if (smooth === 'smooth') probeFrames();
}

function scrollToEl(el) {
  if (rail.contains(el) || modal.contains(el)) {
    if (modal.contains(el)) el.scrollIntoView({ behavior: smooth, block: 'center' });
    return;
  }
  var row = el.closest('.row');
  if (row) {   // la scheda selezionata resta sempre allineata a sinistra, la fila scorre sotto
    scrollBox(row, { left: Math.max(0, el.offsetLeft - parseFloat(getComputedStyle(row).paddingLeft)) });
  }
  var rows = el.closest('.rows');
  if (rows) {  // Home: la fila selezionata resta alla stessa altezza, sotto l'anteprima
    var sec = el.closest('.section');
    if (sec) scrollBox(rows, { top: Math.max(0, sec.offsetTop) });
    return;
  }
  if (el.closest('.toolbar') || el.closest('.filters')) { scrollBox(window, { top: 0 }); return; }
  // Scheda: si resta in cima finche' l'elemento ci sta; i dettagli piu' in basso si vanno a prendere
  if (el.closest('.hero') && el.getBoundingClientRect().bottom + window.pageYOffset <= window.innerHeight - 8) { scrollBox(window, { top: 0 }); return; }
  var grid = el.parentNode;   // prima riga di una griglia: si rivedono titolo e filtri
  if (grid && grid.id === 'grid' && grid.firstElementChild && el.offsetTop === grid.firstElementChild.offsetTop &&
      grid.getBoundingClientRect().top + window.pageYOffset < window.innerHeight * 0.5) { scrollBox(window, { top: 0 }); return; }
  el.scrollIntoView({ behavior: smooth, block: 'center', inline: 'nearest' });
}

// Misura quanto e' fluido lo scorrimento. Se il dispositivo perde troppi fotogrammi,
// le animazioni si riducono da sole (e la scelta resta, finche' non la si cambia).
var probe = { busy: false, runs: 0, slow: 0 };
function probeFrames() {
  if (probe.busy || device.anim || device.slow || probe.runs >= 12 || !window.requestAnimationFrame) return;
  probe.busy = true;
  var last = 0, n = 0, late = 0;
  function tick(t) {
    if (last && t - last > 40) late++;
    last = t;
    if (++n < 14) { requestAnimationFrame(tick); return; }
    probe.busy = false;
    probe.runs++;
    if (late >= 5) probe.slow++;
    if (probe.runs >= 6 && probe.slow >= probe.runs * 0.6) {
      device.slow = true;
      saveDevicePrefs(device);
      applyDevice();
    }
  }
  requestAnimationFrame(tick);
}

document.addEventListener('focusin', function (e) {
  var el = e.target;
  if (!el.classList || !el.classList.contains('f')) return;
  var key = el.getAttribute('data-key');
  if (view.contains(el)) {
    if (modal.hidden && currentHash && key) focusMemory[currentHash] = key;
    var row = el.closest('.row');
    if (row) row._last = el;
    if (key) setStage(key);
    // Verso il fondo di una griglia lunga: si preparano le locandine successive
    if (chunk && chunk.shown < chunk.list.length && el.parentNode && el.parentNode.id === 'grid') {
      var kids = el.parentNode.children, at = Array.prototype.indexOf.call(kids, el);
      if (at >= kids.length - 16) growGrid();
    }
  }
  if (kb) scrollToEl(el);
});

view.addEventListener('mouseover', function (e) {
  if (!stageMap || !e.target.closest) return;
  var card = e.target.closest('.card');
  if (card) setStage(card.getAttribute('data-key'));
});

document.addEventListener('contextmenu', function (e) {
  var card = e.target.closest ? e.target.closest('.card') : null;
  if (card && cardData[card.getAttribute('data-key')]) {
    e.preventDefault();
    openCardMenu(card.getAttribute('data-key'));
  }
});

var KEYCODES = { 37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown', 13: 'Enter', 27: 'Escape', 8: 'Backspace', 32: ' ' };

document.addEventListener('keydown', function (e) {
  var key = e.key;
  if (!key || key === 'Unidentified') key = KEYCODES[e.keyCode] || '';
  var t = e.target;
  var typing = t.tagName === 'INPUT' && t.type !== 'range';
  setKb(true);

  if (player && modal.hidden) {   // con il menu Opzioni aperto i tasti servono al menu
    if (key === 'Enter' && t.tagName === 'BUTTON') return;
    if (player.key(key)) e.preventDefault();
    return;
  }

  var dir = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }[key];
  if (dir) {
    if (typing && (dir === 'left' || dir === 'right') && t.value) return;
    e.preventDefault();
    move(dir);
    return;
  }
  if (key === 'Enter') {
    if (typing) {
      var fn = actions[t.getAttribute('data-enter')];
      if (fn) fn();
      return;
    }
    var a = document.activeElement;
    if (a && a.classList && a.classList.contains('f')) {
      e.preventDefault();
      if (modal.hidden && a.classList.contains('card') && cardData[a.getAttribute('data-key')]) {
        // Sulle schede: OK breve apre, OK tenuto premuto mostra le azioni
        if (!e.repeat && !press) {
          var p = { el: a, done: false };
          p.timer = setTimeout(function () { p.done = true; openCardMenu(a.getAttribute('data-key')); }, 550);
          press = p;
        }
        return;
      }
      if (!e.repeat) a.click();
    }
    return;
  }
  if (key === 'ContextMenu' && !typing) {
    var c = document.activeElement;
    if (c && c.classList && c.classList.contains('card')) { e.preventDefault(); openCardMenu(c.getAttribute('data-key')); }
    return;
  }
  if (key === 'Escape' || (key === 'Backspace' && !typing)) {
    e.preventDefault();
    if (closeModal()) return;
    if (rail.contains(document.activeElement)) { focusView(); return; }
    if (currentHash !== '#/home') history.back();
  }
});

document.addEventListener('keyup', function (e) {
  var key = e.key;
  if (!key || key === 'Unidentified') key = KEYCODES[e.keyCode] || '';
  if (key !== 'Enter' || !press) return;
  var p = press;
  press = null;
  clearTimeout(p.timer);
  if (!p.done && document.activeElement === p.el) p.el.click();
});

document.addEventListener('mousedown', function () { setKb(false); });
document.addEventListener('touchstart', function () { setKb(false); }, { passive: true });
window.addEventListener('scroll', function () {
  if (currentHash) scrollMemory[currentHash] = window.pageYOffset;
  if (chunk && chunk.shown < chunk.list.length &&
      window.pageYOffset + window.innerHeight * 2.5 > document.documentElement.scrollHeight) growGrid();
}, { passive: true });

// Orologio in alto a destra (solo con l'aspetto da TV)
var clockEl = document.getElementById('clock');
function tickClock() {
  var d = new Date(), m = d.getMinutes();
  clockEl.textContent = d.getHours() + ':' + (m < 10 ? '0' : '') + m;
}
if (TVLOOK && clockEl) { tickClock(); setInterval(tickClock, 20000); }

// ---------------------------------------------------------------- Pagine

var routes = [
  [/^#\/home$/, home],
  [/^#\/lib\/(\d+)(?:\?.*)?$/, libraryPage],
  [/^#\/show\/(\d+)(?:\?.*)?$/, show],
  [/^#\/item\/(\d+)$/, item],
  [/^#\/play\/(\d+)$/, playRoute],
  [/^#\/search$/, search],
  [/^#\/sagas$/, sagasPage],
  [/^#\/mylist$/, myListPage],
  [/^#\/saga\/(\d+)$/, sagaPage],
  [/^#\/settings$/, settings],
  [/^#\/newlib$/, newLibPage],
  [/^#\/rename\/(\d+)$/, renamePage],
  [/^#\/browse\/(\d+)(?:\?.*)?$/, browsePage],
  [/^#\/match\/(movie|show)\/(\d+)$/, matchPage],
  [/^#\/settings\/(\w+)$/, settingsArea],
  [/^#\/accounts$/, function () { location.replace('#/settings/people'); return ''; }],
  [/^#\/pair\/([A-Za-z0-9]+)$/, phonePairPage],
  [/^#\/news$/, newsPage],
  [/^#\/tvlogin$/, function () {
    if (!auth.cloud || auth.user.linked) { location.replace('#/settings/account'); return ''; }
    return tvLoginPage();
  }],
  [/^#\/password$/, function () {
    return settingsShell('account', 'Cambia password', 'Gli altri PC dove sei entrato ti chiederanno la password nuova.',
      '<div class="panel">' +
      '<label class="flabel" for="pold">Password attuale</label>' +
      '<input class="field f" style="margin-bottom:1rem" id="pold" data-key="pold" data-autofocus type="password" autocomplete="current-password">' +
      '<label class="flabel" for="pnew">Password nuova (almeno 8 caratteri)</label>' +
      '<input class="field f" style="margin-bottom:1rem" id="pnew" data-key="pnew" type="password" autocomplete="new-password">' +
      '<label class="flabel" for="pnew2">Ripeti la password nuova</label>' +
      '<input class="field f" id="pnew2" data-key="pnew2" type="password" autocomplete="new-password" data-enter="changepw">' +
      '<div class="actions"><button class="btn primary f" data-act="changepw" data-arg="" data-key="changepw">Salva</button>' +
      '<button class="btn f" data-act="goback" data-key="cancel">Annulla</button></div></div>');
  }]
];

// Prima di ogni pagina: chi guarda? (scelta del profilo, password provvisoria da cambiare,
// impostazioni diverse da confrontare). Mai una pagina che chieda Internet per andare avanti.
async function gate() {
  if (!auth) await loadAuth();
  markOffline();
  markMe();
  setTimeout(renderActivity, 0);
  if (!auth.user) {
    // Un solo profilo che si apre senza password: si entra da soli (non dopo «Cambia profilo»)
    var noAuto = false;
    try { noAuto = sessionStorage.getItem('fpNoAuto') === '1'; } catch (e) { /* niente */ }
    var only = auth.profiles && auth.profiles.length === 1 ? auth.profiles[0] : null;
    if (!noAuto && only && only.quick && !gate.tried) {
      gate.tried = true;
      try {
        await post('/auth/profile', { id: only.id, device: devName() });
        await loadAuth();
        if (auth.user) await afterLogin([]);
      } catch (e) { /* si mostra «Chi guarda?» */ }
    }
    if (!auth.user) {
      lockScreen(true);
      return location.hash === '#/tvlogin' && auth.cloud ? tvLoginPage() : profilesPage();
    }
  }
  if (auth.user.must_change && !pwLater()) { lockScreen(true); return passwordPage(true); }
  if (conflicts) { lockScreen(true); return conflictsPage(); }
  lockScreen(false);
  return null;
}

// Sullo schermo stretto le aree delle impostazioni sono una fila di schede che
// scorre: quella aperta va portata in vista (solo la fila, la pagina resta ferma)
function showActiveTab() {
  var on = view.querySelector('.scol .snav.on');
  if (!on) return;
  var row = on.parentNode;
  if (row.scrollWidth <= row.clientWidth) return;
  var gap = on.getBoundingClientRect().left - row.getBoundingClientRect().left;
  row.scrollLeft += gap - (row.clientWidth - on.offsetWidth) / 2;
}

async function render() {
  var token = ++renderToken;
  var h = location.hash;
  if (!h || h === '#' || h === '#/') h = '#/home';
  closeModal(true);
  stopPlayer();

  var match = null, handler = null;
  for (var i = 0; i < routes.length; i++) {
    match = h.match(routes[i][0]);
    if (match) { handler = routes[i][1]; break; }
  }
  if (!handler) { location.replace('#/home'); return; }

  var out;
  try {
    // Il telefono che entra per la TV non deve scegliere un profilo per se'
    var pairing = handler === phonePairPage;
    out = pairing ? null : await gate();
    if (pairing) {
      lockScreen(true);
      out = phonePairPage(match[1].toUpperCase());
    } else if (out) {
      h = '#/login';
    } else {
      await loadLibs();
      cache.navLib = null;
      // Stessa pagina che si ridisegna: restano a schermo tante locandine quante ce n'erano
      cache.keepShown = chunk && currentHash === h ? chunk.shown : 0;
      chunk = null;
      out = await handler.apply(null, match.slice(1));
    }
  } catch (e) {
    out = '<div class="page"><div class="empty center"><h2>Qualcosa non va</h2><p>' + esc(e.message) +
      '</p><div class="actions"><a class="btn f" href="#/home">Torna alla Home</a></div></div></div>';
  }
  if (token !== renderToken) return;   // nel frattempo si e' cambiata pagina
  if (typeof out === 'string') out = { html: out };
  var samePage = currentHash === h;
  // Aggiornamento in sottofondo senza novita': la pagina resta com'e', senza sfarfallii
  if (samePage && out.html === lastHtml && view.firstChild) return;
  lastHtml = out.html;
  var keepScroll = window.pageYOffset;
  var hadFocusInRail = rail.contains(document.activeElement);
  currentHash = h;
  press = null;
  stageMap = null;
  stageKey = '';
  view.classList.remove('enter');
  view.innerHTML = out.html;
  if (!samePage) {   // pagina nuova: entra con un movimento breve (solo opacita' e spostamento)
    void view.offsetWidth;
    view.classList.add('enter');
    clearTimeout(enterTimer);
    enterTimer = setTimeout(function () { view.classList.remove('enter'); }, 900);
  }
  if (out.mount) out.mount();
  markRail(h);
  showActiveTab();
  setTimeout(warnPaths, 0);

  var key = focusMemory[h];
  var el = byKey(key);
  if (el && !view.contains(el)) el = null;
  if (!el && !player) el = view.querySelector('[data-autofocus]') || view.querySelector('.f') || rail.querySelector('.railitem.on');
  if (samePage && hadFocusInRail) el = null;   // un aggiornamento in sottofondo non sposta chi sta usando il menu
  if (kb) {
    if (!key && !samePage) window.scrollTo(0, 0);
    if (el) el.focus();
  } else {
    if (el) { try { el.focus({ preventScroll: true }); } catch (err) { el.focus(); } }
    window.scrollTo(0, samePage ? keepScroll : (scrollMemory[h] || 0));
  }
  // L'anteprima della Home parte subito, anche se la finestra non ha ancora il fuoco
  if (stageMap) setStage((el && el.getAttribute('data-key')) || Object.keys(stageMap)[0]);
}

window.addEventListener('hashchange', render);

// L'app Android chiama queste due funzioni
window.fpBack = function () {
  if (closeModal()) return true;
  if (player && player.leaveRow && player.leaveRow()) return true;   // Indietro esce dai comandi del video
  // Dalla Home Indietro chiude l'app: prima si chiede conferma (serve un'app che
  // sappia chiudersi su richiesta; con una versione vecchia si esce come prima)
  if (!player && currentHash === '#/home' && TV && typeof tvApp.exit === 'function') {
    confirmBox('Vuoi uscire da BunkerPlex?', 'Esci', function () { tvApp.exit(); });
    return true;
  }
  if (rail.contains(document.activeElement)) { focusView(); return true; }
  return false;
};
window.fpRefresh = function () { libsLoadedAt = 0; render(); };

// Mentre il server legge le cartelle la pagina si aggiorna da sola quando ha finito
setInterval(function () {
  if (!scanWatch || player) return;
  api('/info').then(function (i) {
    var msg = document.getElementById('scanmsg');
    if (msg) msg.innerHTML = scanStatus(i);
    var idle = !(document.activeElement && document.activeElement.tagName === 'INPUT') && modal.hidden;
    if (i.scanning && idle && /^#\/(home|lib\/|sagas)/.test(currentHash) && Date.now() - lastAutoRefresh > 30000) {
      lastAutoRefresh = Date.now();
      libsLoadedAt = 0;
      render();
    }
    if (!i.scanning) {
      scanWatch = false;
      var a = document.activeElement;
      if (!(a && a.tagName === 'INPUT') && modal.hidden) { libsLoadedAt = 0; render(); }
    }
  }).catch(function () {});
}, 3000);

// Amici: ogni minuto si guarda se e' arrivata una richiesta di condivisione e
// se le raccolte di un amico sono comparse (o lui si e' spento). Tutto in locale.
function watchFriends() {
  if (player) return;
  api('/info').then(function (i) {
    var n = i.share_requests || 0;
    if (n > shareRequests) toast(n === 1 ? 'Un amico chiede di condividere le raccolte: apri Impostazioni' : n + ' richieste di condivisione: apri Impostazioni');
    shareRequests = n;
    markRequests();
    if (friends.length) loadLibs(true).then(function () { markRail(location.hash); }).catch(function () {});
  }).catch(function () {});
}
setTimeout(watchFriends, 4000);
setInterval(watchFriends, 60000);

// Ogni mezzo minuto: e' andata via (o tornata) la rete? Si aggiorna il segnale «Offline»
// e, se e' cambiato qualcosa (account collegato, password da ridare...), la pagina
setInterval(function () {
  if (!auth || player) return;
  var sig = function () { var u = auth.user; return JSON.stringify([auth.offline, !!u, u && u.linked, u && u.online, u && u.must_change]); };
  var before = sig();
  loadAuth().then(function () {
    markOffline();
    markMe();
    var after = sig();
    var typing = document.activeElement && document.activeElement.tagName === 'INPUT';
    if (after !== before && !typing && modal.hidden) render();
  });
}, 30000);

// Sulla TV: all'avvio (cioe' appena collegata al server) e poi ogni mezz'ora,
// perche' l'app puo' restare aperta per giorni.
if (TV) {
  setTimeout(checkUpdate, 2500);
  setInterval(checkUpdate, 30 * 60 * 1000);
}

// Su PC e TV: c'e' un aggiornamento di BunkerPlex trovato dal server su GitHub?
setTimeout(checkServerUpdate, 1500);
setInterval(checkServerUpdate, 30 * 60 * 1000);

// ---------------------------------------------------------------- Attivita' (in alto a destra)
// Un solo posto per sapere cosa sta facendo il server e cosa va guardato: la
// lettura dei titoli in corso (con la sua percentuale), un aggiornamento, e le
// notifiche (richieste degli amici, cartelle non raggiungibili, account offline...).
// Ogni notifica porta all'area delle impostazioni che la risolve.

var act = { info: null, upd: null, lastUpd: 0, timer: 0, seen: {} };
try { act.seen = JSON.parse(localStorage.getItem('fpSeen')) || {}; } catch (e) { act.seen = {}; }

function activityState() {
  var i = act.info, u = act.upd, ops = [], notes = [];
  if (!i || i.login) return { ops: ops, notes: notes };
  if (i.scanning) {
    ops.push({ key: 'scan', title: 'Lettura dei titoli', text: scanLabel(i.message), pct: scanProgress(i.message), href: '#/settings/catalog' });
  }
  if (u && u.phase === 'pc') {
    ops.push({ key: 'upd', title: 'Aggiornamento di BunkerPlex', text: 'Scarico le novità e riallineo Docker…', pct: null, href: '#/settings/updates' });
  }
  if (u && u.phase === 'host') {
    notes.push({ key: 'updhost', title: 'Aggiornamento da completare', text: 'Rilancia «Installa BunkerPlex» sul computer', href: '#/settings/updates' });
  } else if (i.update && !(u && u.phase)) {
    notes.push({ key: 'upd', title: 'Aggiornamento disponibile', text: 'Installalo da Impostazioni → Aggiornamenti', href: '#/settings/updates' });
  }
  if (i.updated) {
    var ch = i.updated.changes || [];
    notes.push({ key: 'updated:' + i.updated.to, title: 'BunkerPlex è stato aggiornato', href: '#/news',
      text: ch.length ? ch[0] + (ch.length > 1 ? ' e altre ' + (ch.length - 1) + ' novità' : '') : 'Guarda cosa c\'è di nuovo' });
  }
  if (i.friend_requests) {
    notes.push({ key: 'freq' + i.friend_requests, href: '#/settings/friends', text: 'Accetta o rifiuta in Impostazioni → Amici',
      title: i.friend_requests === 1 ? 'Qualcuno vuole essere tuo amico' : i.friend_requests + ' richieste di amicizia' });
  }
  if (i.share_requests) {
    notes.push({ key: 'share' + i.share_requests, href: '#/settings/friends', text: 'Accetta o rifiuta in Impostazioni → Amici',
      title: i.share_requests === 1 ? 'Un amico chiede di condividere le raccolte' : i.share_requests + ' richieste di condivisione' });
  }
  libs.forEach(function (l) {
    (l.folders || []).forEach(function (f) {
      if (f.online) return;
      notes.push({ key: 'off:' + f.path, href: '#/settings/libraries', text: f.moved_to ? 'Ora sta in ' + f.moved_display : f.display + ' · disco scollegato?',
        title: f.moved_to ? 'Una cartella ha cambiato percorso' : 'Cartella non raggiungibile' });
    });
    if (l.mine !== false && (l.missing || []).length) {
      notes.push({ key: 'away:' + l.id + ':' + l.missing.length, href: '#/settings/libraries', title: '«' + l.name + '»: cartelle su altri PC',
        text: l.missing.length === 1 ? 'Scegli dove sta qui, o lasciala sull\'altro PC' : 'Scegli dove stanno qui, o lasciale sugli altri PC' });
    }
  });
  if (!i.scanning && i.message) notes.push({ key: 'scanmsg:' + i.message, title: 'Lettura dei titoli', text: i.message, href: '#/settings/catalog' });
  if (!i.tmdb && libs.length) notes.push({ key: 'tmdb', title: 'Locandine e schede non attive', text: 'Serve la chiave TMDB', href: '#/settings/catalog' });
  var s = syncState();
  if (s && s.state === 'warn') notes.push({ key: 'sync:' + s.text, title: 'Account', text: s.text, href: '#/settings/account' });
  if (TV && i.apk_version > (+tvCall('getVersion') || 0)) {
    notes.push({ key: 'tvapp:' + i.apk_version, title: 'Nuova versione dell\'app per la TV', text: 'Aggiornala da Impostazioni → Questa TV', href: '#/settings/device' });
  }
  return { ops: ops, notes: notes };
}

function activityRows(st) {
  var ops = st.ops.map(function (op) {
    return '<button class="actrow f" data-act="actgo" data-arg="' + op.href + '" data-key="op-' + esc(op.key) + '">' +
      '<span class="spin" aria-hidden="true"></span><span class="acttxt"><b>' + esc(op.title) + (op.pct === null ? '' : ' · ' + op.pct + '%') + '</b>' +
      '<small>' + esc(op.text) + '</small>' + progressLine(op.pct) + '</span></button>';
  }).join('');
  var notes = st.notes.map(function (n) {
    return '<button class="actrow f" data-act="actgo" data-arg="' + n.href + '" data-key="note-' + esc(n.key) + '">' +
      '<span class="ndot" aria-hidden="true"></span><span class="acttxt"><b>' + esc(n.title) + '</b><small>' + esc(n.text) + '</small></span>' + CHEVRON + '</button>';
  }).join('');
  return '<div class="sheet actsheet" role="dialog" aria-label="Attività e notifiche"><h3>Attività</h3>' +
    (ops ? '<div class="actgroup"><h4>In corso</h4>' + ops + '</div>' : '') +
    '<div class="actgroup"><h4>Notifiche</h4>' + (notes || '<p class="actempty">Niente da segnalare: è tutto in ordine.</p>') + '</div></div>';
}

function activityOpen() { return !modal.hidden && modal.classList.contains('corner'); }

// Appena aggiornato: un avviso una volta per dispositivo (poi resta nella campanella)
function announceUpdate(u) {
  if (!u || !u.to || player) return;
  var seen = '';
  try { seen = localStorage.getItem('fpNews') || ''; } catch (e) { /* niente */ }
  if (seen === u.to) return;
  try { localStorage.setItem('fpNews', u.to); } catch (e) { /* niente */ }
  toast('BunkerPlex è stato aggiornato: le novità sono nella campanella in alto');
}

// La pagina delle novita' dell'ultimo aggiornamento
async function newsPage() {
  var i = await api('/info');
  var u = i.updated;
  if (!u) {
    return '<div class="page"><div class="panel"><h1>Novità</h1><p>Nessun aggiornamento negli ultimi giorni. ' +
      'La versione installata e gli aggiornamenti sono in Impostazioni → Aggiornamenti.</p>' +
      '<div class="actions"><a class="btn f" href="#/settings/updates" data-key="news-upd">Impostazioni → Aggiornamenti</a></div></div></div>';
  }
  var when = new Date(u.at * 1000).toLocaleDateString('it-IT', { day: 'numeric', month: 'long' });
  var list = (u.changes || []).map(function (c) { return '<li>' + esc(c) + '</li>'; }).join('');
  return '<div class="page"><div class="panel"><h1>BunkerPlex è stato aggiornato</h1>' +
    '<p>Il ' + esc(when) + ' (versione ' + esc(u.to) + ').</p>' +
    (list ? '<h2>Novità</h2><ul class="news">' + list + '</ul>' : '<p>L\'elenco delle novità non è ancora arrivato da GitHub: riprova tra qualche minuto.</p>') +
    '<div class="actions"><a class="btn primary f" data-autofocus href="#/home" data-key="news-home">Torna alla Home</a></div></div></div>';
}

function openActivity() {
  if (activityOpen()) { closeModal(); return; }
  closeModal(true);
  modalState = { options: [], onPick: function () {}, returnFocus: document.activeElement };
  modal.classList.add('corner');
  modal.innerHTML = activityRows(activityState());
  modal.hidden = false;
  var first = modal.querySelector('.f');
  if (first) first.focus();
  // Aprire il riquadro vuol dire averle viste: il numero sul pulsante si azzera
  activityState().notes.forEach(function (n) { act.seen[n.key] = 1; });
  try { localStorage.setItem('fpSeen', JSON.stringify(act.seen)); } catch (e) { /* niente */ }
  renderActivity();
  pollActivity();
}

function renderActivity() {
  var box = document.getElementById('activity');
  if (!box) {
    box = document.createElement('div');
    box.id = 'activity';
    box.innerHTML = '<button class="actbtn f" data-act="activity" data-key="actbtn" aria-label="Attività e notifiche"></button>';
    document.body.appendChild(box);
  }
  var locked = document.body.classList.contains('locked') || (auth && !auth.user);
  box.hidden = !act.info || !!act.info.login || locked;
  if (box.hidden) return;
  var st = activityState();
  var op = st.ops[0];
  var unseen = st.notes.filter(function (n) { return !act.seen[n.key]; }).length;
  var html = op
    ? '<span class="spin" aria-hidden="true"></span><span class="acttext">' + esc(op.title) + (op.pct === null ? '' : ' ' + op.pct + '%') + '</span>'
    : IC.bell;
  if (unseen) html += '<span class="actcount">' + unseen + '</span>';
  var btn = box.firstChild;
  btn.classList.toggle('busy', !!op);
  if (btn.getAttribute('data-sig') !== html) {      // il pulsante resta lo stesso: chi ci sta sopra col telecomando non perde il posto
    btn.innerHTML = html;
    btn.setAttribute('data-sig', html);
  }
  if (activityOpen()) {
    var key = document.activeElement && modal.contains(document.activeElement) ? document.activeElement.getAttribute('data-key') : '';
    var fresh = activityRows(st);
    if (modal.getAttribute('data-sig') !== fresh) {
      modal.innerHTML = fresh;
      modal.setAttribute('data-sig', fresh);
      var el = key && byKey(key);
      (el && modal.contains(el) ? el : modal.querySelector('.f') || modal).focus();
    }
  }
}

// Si chiede al server ogni 3 secondi mentre lavora (o il riquadro e' aperto), ogni 20 se no
function pollActivity() {
  clearTimeout(act.timer);
  var busy = (act.info && act.info.scanning) || (act.upd && act.upd.phase) || activityOpen();
  act.timer = setTimeout(pollActivity, busy ? 3000 : 20000);
  if (player) return;
  api('/info').then(function (i) {
    var wasScanning = act.info && act.info.scanning;
    act.info = i;
    if (wasScanning && !i.scanning) libsLoadedAt = 0;      // finita la lettura: raccolte e menu da rileggere
    announceUpdate(i.updated);
    var want = !i.login && (i.update || (act.upd && act.upd.phase)) && Date.now() - act.lastUpd > 15000;
    return want ? api('/update').then(function (u) { act.upd = u; act.lastUpd = Date.now(); }, function () {}) : null;
  }).then(renderActivity, function () { /* server spento un attimo: si riprova */ });
}

loadAuth().then(function () {
  if (auth.user && !auth.user.must_change) return afterLogin([]).then(render);
  render();
}).then(function () { setTimeout(pollActivity, 600); });
})();
