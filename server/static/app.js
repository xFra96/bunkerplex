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
var APP = !!tvApp;                   // dentro l'app Android (TV o telefono): video col player nativo
// L'app sa dire se gira su un televisore. Una versione vecchia non lo sa: allora vale come TV.
var PHONE_APP = APP && typeof tvApp.isTv === 'function' && !callSafe(function () { return tvApp.isTv(); });
var TV = APP && !PHONE_APP;          // true dentro l'app su Android TV
// Il browser di una smart TV senza Android (Samsung con Tizen, LG con webOS, Hisense con
// VIDAA...): niente app da installare, ma aspetto da TV e accesso dal telefono come nell'app
var SMART_TV = !APP && /Tizen|Web0S|webOS|NetCast|HbbTV|VIDAA|SmartTV|SMART-TV/i.test(navigator.userAgent);
// Dentro l'app per le TV Samsung (tizen/): la pagina sta in una cornice dell'app, che le
// passa i tasti arrivati a lei e si chiude quando qui si preme Indietro dalla Home
var TV_WRAP = window.parent !== window && (SMART_TV || /[?&]app=tizen/.test(location.search));
// Dentro l'app per iPhone e iPad: la pagina e' quella del browser (video in HLS), l'app
// aggiunge solo il cambio di server e Tailscale per fuori casa
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
var okRelease = false;               // OK appena rilasciato dopo una pressione lunga
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
  cast: '<svg class="ic line" viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 8V6.5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H14M3.5 12a8 8 0 0 1 8 8M3.5 15.5A4.5 4.5 0 0 1 8 20M3.5 19.2v.8h.8"/></svg>',
  stop: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>',
  shuffle: '<svg class="ic line" viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7h3.2c2 0 3.4 1 4.6 2.8l1.4 2.4c1.2 1.8 2.6 2.8 4.6 2.8h3.2M3.5 17h3.2c1.4 0 2.5-.5 3.4-1.4M20.5 7h-3.2c-1.4 0-2.5.5-3.4 1.4M18 4.5 20.5 7 18 9.5M18 12.5l2.5 2.5-2.5 2.5"/></svg>',
  disk: '<svg class="ic line" viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="6" width="17" height="12" rx="2"/><path d="M7 14.5h4"/></svg>',
  folder: '<svg class="ic line" viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7v11h17V9h-8l-2-2z"/></svg>',
  bell: '<svg class="ic line" viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 1.5H5zM10 20.5h4"/></svg>'
};
function callSafe(fn) { try { return fn(); } catch (e) { return true; } }
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

// ---------------------------------------------------------------- Account
// Ogni account e' una persona, con la sua collezione: niente profili. Finche' su
// questo PC non e' entrato nessun account c'e' solo l'utente di questo PC, in cui
// si entra da soli, senza password e anche senza Internet. Il primo account che
// entra lo prende con tutto quello che ha. Con piu' account, «Chi guarda?».
// Le preferenze di visione seguono l'account su ogni dispositivo, tranne cio' che
// dipende dal dispositivo stesso (lento o no, aspetto da TV).
var auth = null;                     // {on, cloud, user, profiles, offline, setup}
var LOCAL_ONLY = ['slow', 'tv'];             // dipendono dal dispositivo
var PLAYER_LOCAL = ['volume', 'muted'];      // il volume di una TV non va sul PC
var prefsTimer = 0;
var conflicts = null;                // primo accesso: impostazioni di qui diverse da quelle dell'account

function loadAuth() {
  if (CENTRAL && !C.base) {
    auth = { on: true, cloud: true, central: true, user: null, profiles: [] };
    return Promise.resolve(auth);
  }
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
    // Senza account: valgono le sue, senza domande
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
      return '<div class="folder"><div class="where"><b>' + esc(c.label) + '</b><small>Questo ' + (APP ? 'dispositivo' : 'PC') + ': ' + esc(c.local) +
        '<br>Account: ' + esc(c.cloud) + '</small></div></div>';
    }).join('') + '</div>' +
    '<div class="actions"><button class="btn primary f" data-autofocus data-act="resolve" data-arg="cloud" data-key="keepcloud">Usa quelle dell\'account</button>' +
    '<button class="btn f" data-act="resolve" data-arg="local" data-key="keeplocal">Tieni quelle di qui (sovrascrivi l\'account)</button></div>' +
    '<p style="margin-top:1rem">Le impostazioni che non scegli vengono sostituite.</p></div></div>';
}

function lockScreen(on) {
  document.body.classList.toggle('locked', on);
}

function devName() { return TV ? 'tv' : PHONE_APP ? 'phone' : 'browser'; }

// Il modulo per entrare con un account (o per creare l'amministratore, la prima volta)
function accountForm(name, fixed) {
  if (cache.s2fa) return twoFaForm(cache.s2fa.user, 's2fago', 's2facancel');
  if (auth.setup) {
    return '<p>Sul servizio account non c\'è ancora nessuno: crea l\'account <b>amministratore</b>, è il tuo. ' +
      'Con questo poi crei quelli degli altri, con una password provvisoria da cambiare al primo accesso.</p>' +
      '<input class="field f" style="margin-bottom:.6rem" id="lname" data-key="lname" autocomplete="username" maxlength="32" placeholder="Nome utente (lettere, numeri, . - _)">' +
      '<input class="field f" style="margin-bottom:.6rem" id="lpass" data-key="lpass" type="password" autocomplete="new-password" placeholder="Password (almeno 8 caratteri)">' +
      '<input class="field f" id="lpass2" data-key="lpass2" type="password" autocomplete="new-password" data-enter="setup" placeholder="Ripeti la password">' +
      '<div class="actions"><button class="btn primary f" data-act="setup" data-key="setup">Crea l\'account</button></div>';
  }
  return (fixed ? '<input type="hidden" id="lname" value="' + esc(name) + '">'
      : '<input class="field f" style="margin-bottom:.6rem" id="lname" data-key="lname" autocomplete="username" autocapitalize="none" maxlength="120" placeholder="Nome utente o email" value="' + esc(name || '') + '">') +
    '<input class="field f" id="lpass" data-key="lpass" type="password" autocomplete="current-password" data-enter="login"' + (fixed ? ' data-autofocus' : '') + ' placeholder="Password">' +
    '<div class="actions"><button class="btn primary f" data-act="login" data-key="login">Entra</button>' + googleButton() + '</div>' +
    (auth.reset ? '<p style="margin-top:.8rem"><a class="f" href="#/reset" data-key="forgot">Password dimenticata?</a></p>' : '');
}

// «Password dimenticata?»: un codice all'email dell'account, poi la password nuova
function resetPage() {
  var r = cache.reset || { email: fieldValue('lname').indexOf('@') > 0 ? fieldValue('lname').trim() : '' };
  cache.reset = r;
  var back = auth && auth.user ? '#/settings/account' : '#/home';
  var head = '<div class="page"><div class="panel login"><h1>Password dimenticata</h1>';
  if (!r.sent) {
    return head + '<p>Scrivi l\'email del tuo account: ti mando un codice per scegliere una password nuova.</p>' +
      '<input class="field f" id="remail" data-key="remail" data-autofocus type="email" autocomplete="email" autocapitalize="none" maxlength="120"' +
      ' data-enter="resetsend" placeholder="Email" value="' + esc(r.email || '') + '">' +
      '<div class="actions"><button class="btn primary f" data-act="resetsend" data-key="resetsend">Mandami il codice</button>' +
      '<a class="btn f" href="' + back + '" data-key="resetback">Indietro</a></div>' +
      '<p style="margin-top:1rem"><small>Vale l\'email impostata in Impostazioni → Account (o quella data dall\'amministratore).</small></p></div></div>';
  }
  return head + '<p>Se <b>' + esc(r.email) + '</b> è l\'email di un account, ti è arrivato un codice di 6 cifre (guarda anche nella posta indesiderata). Vale 15 minuti.</p>' +
    '<input class="field f num" style="margin-bottom:.6rem" id="rcode" data-key="rcode" data-autofocus inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="Codice">' +
    '<input class="field f" style="margin-bottom:.6rem" id="pnew" data-key="pnew" type="password" autocomplete="new-password" placeholder="Password nuova (almeno 8 caratteri)">' +
    '<input class="field f" id="pnew2" data-key="pnew2" type="password" autocomplete="new-password" data-enter="resetdone" placeholder="Ripeti la password nuova">' +
    '<div class="actions"><button class="btn primary f" data-act="resetdone" data-key="resetdone">Salva ed entra</button>' +
    '<button class="btn f" data-act="resetagain" data-key="resetagain">Mandalo di nuovo</button>' +
    '<a class="btn f" href="' + back + '" data-key="resetback">Indietro</a></div></div></div>';
}

// «Entra con Google» (se il servizio account lo offre)
function googleButton() {
  return auth && auth.google ? '<button class="btn f" data-act="ggo" data-key="google">' + GOOGLE_G + ' Entra con Google</button>' : '';
}

// «Chi guarda?»: gli account gia' entrati su questo PC. Si entra senza password
// (tranne gli account che l'hanno chiesta); da qui si entra con un altro account.
function profilesPage() {
  var a = auth, mode = cache.whoMode || '';
  var list = (a.profiles || []).map(function (p, n) {
    return '<button class="profile f"' + (n === 0 && !mode ? ' data-autofocus' : '') + ' data-act="profile" data-arg="' + p.id + '" data-key="prof-' + p.id + '">' +
      face(p.name, 'big') + '<span>' + esc(p.name) + '</span></button>';
  }).join('');
  var body = '';
  if (mode === 'login') {
    body = '<h2>Entra con un account</h2><p>Visti, lista, raccolte e impostazioni sono del tuo account e ti seguono su ogni PC e TV.</p>' + accountForm('', false);
  } else if (/^pw:/.test(mode)) {
    var p = (a.profiles || []).filter(function (x) { return String(x.id) === mode.slice(3); })[0];
    if (p) body = '<h2>Password di ' + esc(p.name) + '</h2><p>Questo account si apre con la sua password.</p>' + accountForm(p.name, true);
  }
  var more = '<div class="actions" style="margin-top:1.4rem">' +
    (a.cloud ? (TVLOGIN ? '<a class="btn f" href="#/tvlogin" data-key="who-phone">Entra con un account dal telefono</a>'
      : '<button class="btn f" data-act="whomode" data-arg="login" data-key="who-login">Entra con un account</button>' +
      (mode === 'login' ? '' : googleButton())) : '') +
    (APP ? '<button class="btn f" data-act="resetserver" data-key="resetserver">Cambia server</button>' : '') + '</div>';
  return '<div class="page"><div class="panel login wide"><h1>Chi guarda?</h1>' +
    '<div class="profiles">' + list + '</div>' + (body ? '<div style="margin-top:1.4rem">' + body + '</div>' : '') + more + '</div></div>';
}

// Sulla TV, alla prima configurazione: a sinistra il QR da inquadrare col telefono,
// a destra il codice da scrivere in BunkerPlex sul telefono o sul PC (Collega una TV).
// Intanto la TV chiede al server se qualcuno ha confermato.
async function tvLoginPage() {
  var p = cache.pair;
  if (!p || Date.now() - p.at > (p.ttl - 60) * 1000) {
    p = await post('/auth/pair');
    p.at = Date.now();
    cache.pair = p;
  }
  var here = location.hash;
  clearInterval(cache.pairTimer);
  cache.pairTimer = setInterval(function () {
    if (location.hash !== here || (auth && auth.user)) { clearInterval(cache.pairTimer); return; }
    // Scaduto: un codice nuovo prima che la TV mostri un codice che non vale piu'
    if (Date.now() - p.at > (p.ttl - 60) * 1000) { clearInterval(cache.pairTimer); cache.pair = null; render(); return; }
    api('/auth/pair/' + p.code).then(function (r) {
      if (!r.done) {
        var st = document.getElementById('gstatus');
        if (st && !!r.seen !== st.classList.contains('ok')) {
          st.className = 'gstatus' + (r.seen ? ' ok' : '');
          st.lastChild.textContent = r.seen ? 'Codice aperto sul telefono: accedi lì e la TV entra da sola' : 'In attesa del telefono…';
        }
        return;
      }
      clearInterval(cache.pairTimer);
      cache.pair = null;
      toast('Entrato come ' + r.user.name);
      enterApp(r);
    }, function () { clearInterval(cache.pairTimer); cache.pair = null; render(); });   // scaduto: codice nuovo
  }, 2000);
  var site = p.base ? p.base.replace(/^https?:\/\//, '') + '/#/tv' : '';
  return '<div class="auth"><div class="tvlink">' +
    '<div class="authbrand">' + LOGO + '<span><b>Bunker</b>Plex</span></div>' +
    '<h1>Collega questa TV</h1><p class="authsub">Accedi una volta dal telefono: la TV entra da sola' + (auth.pc ? ' su <b>' + esc(auth.pc) + '</b>' : '') + '.</p>' +
    '<div class="gstatus" id="gstatus"><i></i><span>In attesa del telefono…</span></div>' +
    '<div class="tvcols">' +
      '<div class="tvcol">' + (p.svg ? '<div class="qrtile big" role="img" aria-label="Codice QR per collegare la TV">' + p.svg + '</div>' : '') +
        '<b>Inquadra il QR</b><small>con la fotocamera del telefono, sulla rete di casa</small></div>' +
      '<div class="tvor"><span>oppure</span></div>' +
      '<div class="tvcol"><small class="tvstep">Apri BunkerPlex sul telefono o sul PC, vai in <b>Impostazioni → Collega una TV</b>' + (site ? ' (o su <span class="num">' + esc(site) + '</span>)' : '') + ' e scrivi</small>' +
        '<div class="tvcode num">' + esc(p.code.slice(0, 3)) + '<i></i>' + esc(p.code.slice(3)) + '</div>' +
        '<small>Il codice cambia ogni 10 minuti</small></div>' +
    '</div>' +
    // Sulla TV si entra solo dal telefono (QR o codice): niente password o Google qui
    (APP ? '<div class="tvmore"><button class="btn f" data-act="resetserver" data-key="resetserver">Cambia server</button></div>' : '') +
    '</div></div>';
}

// Le TV senza Android (Samsung, LG...): niente da installare, BunkerPlex si apre nel
// loro browser dalla PWA centrale, con l'aspetto da TV e l'accesso dal telefono
function smartTvHowto(central) {
  if (!central) return '';
  return '<div class="panel"><h2>TV Samsung, LG e altre</h2>' +
    '<p>Non serve installare niente. Sulla TV apri il browser (<b>Internet</b> sulle Samsung), vai su ' +
      '<b class="num">' + esc(central.replace(/^https?:\/\//, '')) + '</b> e aggiungilo ai preferiti: la prossima volta è a un clic.</p>' +
    '<p>La TV mostra un codice: scrivilo qui sopra. Poi si usa col telecomando, come l\'app.</p>' +
    '<p class="kvnote">A casa del server c\'è anche <b>Guarda su</b>: dal telefono mandi un film alla TV, senza aprire niente sulla TV.</p></div>';
}

// «Collega una TV» dal telefono o dal PC gia' entrati: si scrive il codice della TV
function tvCodePage() {
  return settingsShell('account', 'Collega una TV', 'Scrivi il codice che vedi sulla TV: entra con il tuo account, senza password.',
    '<div class="panel"><label class="flabel" for="tvcode">Codice della TV</label>' +
    '<div class="inline"><input class="field f num" id="tvcode" data-key="tvcode" data-autofocus maxlength="9" autocapitalize="characters" autocomplete="off" spellcheck="false" data-enter="tvcodego" placeholder="ABC 123">' +
    '<button class="btn primary f" data-act="tvcodego" data-key="tvcodego">Collega</button></div></div>' + smartTvHowto(auth && auth.central));
}

// «Entra con Google» (link: collega Google all'account). Google si apre nel browser
// (dentro l'app con il browser del telefono: Google non accetta le finestre delle app);
// sulla TV si inquadra il QR col telefono. Intanto si chiede al server se ha finito.
async function googlePage(link) {
  var g = cache.gflow;
  if (!g || g.link !== link || Date.now() - g.at > (g.ttl - 60) * 1000) {
    // hint: l'email gia' scritta (Google propone quell'account); back: dove tornare dopo
    g = await post('/auth/google', { link: link, device: devName(), hint: cache.gHint || '',
      back: location.origin + location.pathname + '#/home' });
    g.at = Date.now();
    g.link = link;
    cache.gflow = g;
  }
  var here = location.hash;
  clearInterval(cache.gTimer);
  cache.gTimer = setInterval(function () {
    if (location.hash !== here) { clearInterval(cache.gTimer); return; }
    // Scaduto: un codice nuovo, da solo
    if (Date.now() - g.at > (g.ttl - 60) * 1000) { clearInterval(cache.gTimer); cache.gflow = null; render(); return; }
    api('/auth/google/' + g.id).then(function (r) {
      if (!r.done) {
        if (r.seen !== g.seen || r.note !== g.note || !!r.offline !== !!g.offline) {
          // L'errore di prima resta finche' il telefono non riapre il codice
          if (r.seen && !g.seen) g.hard = false;
          g.seen = r.seen; g.offline = r.offline;
          if (!g.hard || r.note) g.note = r.note;
          gStatusShow(g);
        }
        return;
      }
      clearInterval(cache.gTimer);
      cache.gflow = null;
      cache.gHint = '';
      if (r.linked) {
        toast('Google collegato: d\'ora in poi puoi entrare con ' + (r.google || 'Google'));
        auth = null;
        location.replace('#/settings/account');
        return;
      }
      toast('Entrato come ' + r.user.name);
      enterApp(r);
    }, function (e) {
      clearInterval(cache.gTimer);
      cache.gflow = null;
      if (e.data && e.data.ask) { cache.ask = e.data.ask; location.replace('#/home'); render(); return; }
      if (location.hash !== here) return;
      if (e.status !== 404) cache.gError = e.message;   // 404: scaduto, solo un codice nuovo
      render();
    });
  }, 2000);
  var err = cache.gError;
  cache.gError = '';
  if (err) { g.note = err; g.hard = true; }
  var canOpen = !APP || (tvApp && typeof tvApp.openUrl === 'function');
  var back = link || (auth && auth.user) ? '#/settings/account' : '#/home';
  var addr = g.short.replace(/^https:\/\//, '');
  var codeHtml = esc(g.code.slice(0, 4)) + '<i></i>' + esc(g.code.slice(5));
  var status = '<div class="gstatus" id="gstatus"><i></i><span></span></div>';
  setTimeout(function () { gStatusShow(g); }, 0);

  // Sulla TV: come «Collega questa TV», il QR da una parte e il codice dall'altra
  if (TV) {
    return '<div class="auth"><div class="tvlink">' +
      '<div class="authbrand">' + LOGO + '<span><b>Bunker</b>Plex</span></div>' +
      '<h1>' + (link ? 'Collega Google' : 'Entra con Google') + '</h1>' +
      '<p class="authsub">' + (link ? 'Scegli dal telefono l\'account Google da collegare' : 'Scegli il tuo account Google dal telefono: la TV entra da sola') + '</p>' +
      status +
      '<div class="tvcols">' +
        '<div class="tvcol">' + (g.svg ? '<div class="qrtile big" role="img" aria-label="Codice QR per entrare con Google">' + g.svg + '</div>' : '') +
          '<b>Inquadra il QR</b><small>con la fotocamera del telefono, anche fuori casa</small></div>' +
        '<div class="tvor"><span>oppure</span></div>' +
        '<div class="tvcol"><small class="tvstep">Dal telefono o dal PC apri <b class="num">' + esc(addr) + '</b> e scrivi</small>' +
          '<div class="tvcode num">' + codeHtml + '</div>' +
          '<small>Il codice cambia da solo ogni 10 minuti</small></div>' +
      '</div>' +
      '<div class="tvmore"><a class="btn f" data-autofocus href="' + back + '" data-key="gback">Indietro</a>' +
      '<button class="btn f" data-act="gnew" data-key="gnew">Codice nuovo</button></div>' +
      '</div></div>';
  }
  var openBtn = canOpen ? '<button class="gbtn f" data-autofocus data-act="gopen" data-arg="' + esc(g.url) + '" data-key="gopen">' + GOOGLE_G +
    '<span>' + (link ? 'Scegli l\'account da collegare' : 'Scegli l\'account Google') + '</span></button>' : '';
  var other = '<div class="gqr">' + (g.svg ? '<div class="qrtile" role="img" aria-label="Codice QR per entrare con Google">' + g.svg + '</div>' : '') +
    '<p>' + (canOpen ? 'Oppure inquadra il QR col telefono, o apri ' : 'Inquadra il QR col telefono, oppure apri ') +
    '<b class="num">' + esc(addr) + '</b> e scrivi</p><div class="tvcode small num">' + codeHtml + '</div></div>';
  if (!link && !(auth && auth.user)) {
    return authShell('<h1>Continua con Google</h1>' +
      '<p class="authsub">Con l\'account Google collegato al tuo BunkerPlex (da Impostazioni → Account) o indicato dall\'amministratore</p>' +
      status + openBtn + (canOpen ? '<div class="author"><span>oppure dal telefono</span></div>' : '') + other +
      '<a class="authlink f"' + (canOpen ? '' : ' data-autofocus') + ' href="#/home" data-key="gback">Torna all\'accesso</a>', false);
  }
  return '<div class="page"><div class="panel login wide"><h1>' + (link ? 'Collega Google' : 'Entra con Google') + '</h1>' +
    '<p>' + (link ? 'Scegli l\'account Google da collegare: poi entri con quello, senza password, su ogni PC, TV e telefono.'
      : 'Scegli il tuo account Google: deve essere già collegato al tuo account BunkerPlex (da Impostazioni → Account) o indicato dall\'amministratore.') + '</p>' +
    status + openBtn + other +
    '<div class="actions"><a class="btn f"' + (canOpen ? '' : ' data-autofocus') + ' href="' + back + '" data-key="gback">Indietro</a></div></div></div>';
}

// La riga di stato di «Entra con Google»: in attesa, aperto, non riuscito (si riprova lì)
function gStatusShow(g) {
  var el = document.getElementById('gstatus');
  if (!el) return;
  var away = TV || !(!APP || (tvApp && typeof tvApp.openUrl === 'function'));
  var text, kind = '';
  if (g.note) { text = (g.hard ? '' : away ? 'Sul telefono: ' : 'Non riuscito: ') + g.note; kind = 'warn'; }
  else if (g.offline) { text = 'Il server non raggiunge il servizio account: riprovo…'; kind = 'warn'; }
  else if (g.seen) { text = away ? 'Codice aperto sul telefono: scegli lì l\'account Google' : 'Scegli l\'account Google nella finestra di Google'; kind = 'ok'; }
  else text = away ? 'In attesa del telefono…' : 'In attesa di Google…';
  el.className = 'gstatus' + (kind ? ' ' + kind : '');
  el.lastChild.textContent = text;
}

// ---------------------------------------------------------------- Accesso
// Ogni volta che si apre BunkerPlex: 1) l'accesso (se e' ancora valido si salta),
// 2) quale server guardare (questo, i tuoi altri PC, quelli degli amici),
// 3) «Chi guarda?» se l'account ha piu' profili.

var LOGO = '<svg viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="14" fill="#1a7f45"/><path d="M25 18l22 14-22 14z" fill="#ffffff"/></svg>';
var GOOGLE_G = '<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';
var SRV_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>';
var FRIEND_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5"/><circle cx="17" cy="9" r="2.6"/><path d="M16.5 14.6c2.6.2 4.4 1.9 5 4.9"/></svg>';
var PLUS_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';

function authShell(inner, wide) {
  // wide: piu' largo; 'grid': largo per la griglia dei server
  return '<div class="auth"><div class="authcard' + (wide ? ' wide' : '') + (wide === 'grid' ? ' grid' : '') + '">' +
    '<div class="authbrand">' + LOGO + '<span><b>Bunker</b>Plex</span></div>' + inner + '</div></div>';
}

// ---- Scelta del server: card in griglia, divise in sezioni, con la ricerca quando sono tante.
// La usano la PWA centrale (cServersPage) e il server di casa (serversPage).
var SRV_FIND_FROM = 7;          // da quante card compare «Cerca»

// Le icone che il proprietario puo' dare al suo server (stessi nomi di LOOK_ICONS nel Worker)
var SRV_LOOK_ICONS = {
  tv: '<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8M12 17v4"/>',
  film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>',
  home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
  star: '<path d="M12 3l2.8 5.8 6.2.9-4.5 4.4 1 6.2L12 17.4 6.5 20.3l1-6.2L3 9.7l6.2-.9z"/>',
  heart: '<path d="M12 20s-7-4.4-9-9a4.8 4.8 0 0 1 9-3 4.8 4.8 0 0 1 9 3c-2 4.6-9 9-9 9z"/>',
  music: '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
  game: '<rect x="2" y="7" width="20" height="11" rx="5"/><path d="M7 11v3M5.5 12.5h3M15 12h.01M18 14h.01"/>',
  cloud: '<path d="M7 18a4.5 4.5 0 0 1-.5-9 6 6 0 0 1 11.4 1.5A4 4 0 0 1 17.5 18z"/>'
};
function srvLookIcon(name) {
  return SRV_LOOK_ICONS[name] ? '<svg viewBox="0 0 24 24" aria-hidden="true">' + SRV_LOOK_ICONS[name] + '</svg>' : '';
}

function srvHue(text) {
  var h = 0;
  String(text || '').split('').forEach(function (c) { h = (h * 31 + c.charCodeAt(0)) % 360; });
  return h;
}

// ---- Locale o online: come arriva QUESTO dispositivo a un server. Ogni dispositivo
// entra nella rete dove si trova e mostra cio' che raggiunge da li': online va bene,
// locale e' meglio (piu' veloce, e va anche senza Internet).
//   'pc'  = localhost: il server e' su questo stesso PC
//   'lan' = stessa rete (IP privato, nome di casa con certificato): niente Internet
//   'net' = via Internet: Tailscale (ts.net, 100.x) o indirizzo pubblico
var REACH = {
  pc: { tag: 'Locale', cls: 'local', how: 'su questo PC', card: 'Server su questo PC',
    note: 'Il server è su questo stesso PC: niente rete e niente Internet.' },
  lan: { tag: 'Locale', cls: 'local', how: 'nella stessa rete', card: 'Server sulla rete locale',
    note: 'Stessa rete del server, senza passare da Internet: più veloce, e funziona anche quando Internet non va.' },
  net: { tag: 'Online', cls: 'net', how: 'via Internet', card: 'Accesso remoto disponibile',
    note: 'Arrivi al server via Internet (Tailscale): funziona da ovunque. Nella stessa rete del server sarebbe locale, e più veloce.' }
};
var PRIVATE_IP = /^(10|127|192\.168|172\.(1[6-9]|2\d|3[01])|169\.254)\.\d+\.\d+/;

function reachOf(url) {
  var host = '';
  if (!url) return '';            // PWA centrale prima di aprire un server
  try { host = new URL(url, location.href).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch (e) { return ''; }
  if (!host) return '';
  if (host === 'localhost' || /\.localhost$/.test(host) || /^127\./.test(host) || host === '::1') return 'pc';
  if (/\.ts\.net$/.test(host) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return 'net';
  // Il nome di casa con certificato e' <ip-con-trattini>.<pc>.<dominio>
  if (PRIVATE_IP.test(host) || PRIVATE_IP.test(host.split('.')[0].replace(/-/g, '.'))) return 'lan';
  if (host.indexOf('.') < 0 || /\.(local|lan|home\.arpa)$/.test(host) || /^f[cde][0-9a-f]{2}:/.test(host)) return 'lan';
  return 'net';
}

// Il server aperto adesso: nella PWA centrale l'indirizzo scelto, se no la pagina stessa
function hereReach() {
  return reachOf(CENTRAL ? C.base : location.href);
}

function reachTag(kind) {
  var r = REACH[kind];
  return r ? '<span class="reach ' + r.cls + '">' + r.tag + '</span>' : '';
}

// Il nome del server aperto (per le impostazioni: sono le sue)
function srvLabel() {
  return (auth && auth.pc) || (CENTRAL && C.name) || 'Questo server';
}

// Sotto il titolo della scelta del server: cosa vogliono dire le due etichette
function reachLegend(kinds) {
  var local = kinds.indexOf('lan') >= 0 || kinds.indexOf('pc') >= 0, net = kinds.indexOf('net') >= 0;
  if (!local && !net) return '';
  return '<p class="srvlegend">' +
    (local ? '<span>' + reachTag('lan') + ' stessa rete o questo PC, senza Internet</span>' : '') +
    (net ? '<span>' + reachTag('net') + ' via Internet</span>' : '') + '</p>';
}

// c: {act, arg, key, name, sub, icon, off, on, first, reach ('pc'|'lan'|'net'), look: {icon, image}, edit}
function srvCard(c) {
  var tag = REACH[c.reach];
  var initial = (String(c.name || '?').trim()[0] || '?').toUpperCase();
  var look = c.look || {};
  var img = /^https?:\/\//.test(look.image || '') ? look.image : '';
  var face = img ? '' : (srvLookIcon(look.icon) ? '<span class="srvini ico">' + srvLookIcon(look.icon) + '</span>'
    : '<span class="srvini">' + esc(initial) + '</span>');
  return '<button class="srv f' + (c.off ? ' off' : '') + (c.on ? ' on' : '') + (c.edit ? ' edit' : '') + '"' + (c.first ? ' data-autofocus' : '') +
    ' data-act="' + c.act + '" data-arg="' + esc(c.arg) + '" data-key="' + esc(c.key) + '"' +
    ' data-find="' + esc((c.name + ' ' + (c.find || '')).toLowerCase()) + '">' +
    '<span class="srvart' + (img ? ' img' : '') + '" style="--h:' + srvHue(c.name) + (img ? ';background-image:url(\'' + esc(img) + '\')' : '') + '">' + face +
      (c.edit ? '<span class="srvpen">Modifica</span>' : '') +
      '<span class="srvbadge">' + c.icon + '</span>' +
      '<i class="srvdot' + (c.off ? '' : ' live') + '" title="' + (c.off ? 'Non raggiungibile' : 'Acceso') + '"></i>' +
      (tag ? '<span class="srvtag ' + tag.cls + '">' + tag.tag + '</span>' : '') + '</span>' +
    '<span class="srvtxt"><b>' + esc(c.name) + '</b><small>' + c.sub + '</small></span></button>';
}

// sections: [{title, cards: [html], extra: html}]; total = numero di card (per la ricerca)
function srvGrid(sections, total) {
  var find = total >= SRV_FIND_FROM
    ? '<input class="field srvfind f" id="srvfind" data-key="srvfind" type="search" autocomplete="off" spellcheck="false" placeholder="Cerca un server o un amico">'
    : '';
  return find + sections.map(function (s) {
    if (!s.cards.length && !s.extra) return '';
    return '<section class="srvsec"><h2>' + esc(s.title) + (s.cards.length ? ' <span>' + s.cards.length + '</span>' : '') + (s.tool || '') + '</h2>' +
      '<div class="srvgrid">' + s.cards.join('') + (s.extra || '') + '</div></section>';
  }).join('') + '<p class="authnote srvnone" hidden>Nessun server o amico con questo nome.</p>';
}

// La ricerca: nasconde le card che non c'entrano (e le sezioni rimaste vuote)
function srvMount() {
  var input = document.getElementById('srvfind');
  if (!input) return;
  function run() {
    var q = input.value.trim().toLowerCase();
    var any = false;
    view.querySelectorAll('.srvsec').forEach(function (sec) {
      var shown = 0;
      sec.querySelectorAll('.srv[data-find]').forEach(function (b) {
        var ok = !q || b.getAttribute('data-find').indexOf(q) >= 0;
        b.hidden = !ok;
        if (ok) shown++;
      });
      sec.querySelectorAll('.srv.add, .srvadd').forEach(function (b) { b.hidden = !!q; });
      sec.hidden = !!q && !shown;
      if (shown) any = true;
    });
    var none = view.querySelector('.srvnone');
    if (none) none.hidden = !q || any;
  }
  input.addEventListener('input', run);
  run();
}

function googleWide() {
  if (!auth || !auth.google) return '';
  return '<div class="author"><span>oppure</span></div>' +
    '<button class="gbtn f" data-act="ggo" data-key="google">' + GOOGLE_G + '<span>Continua con Google</span></button>';
}

// Passo 1: email (o nome) e password, sotto Google. Niente altro.
function loginPage() {
  if (cache.s2fa) return authShell(twoFaForm(cache.s2fa.user, 's2fago', 's2facancel'));
  var where = auth.pc || '';
  return authShell(getAppSlot() + '<h1>Accedi</h1>' +
    '<p class="authsub">' + (where ? 'al server <b>' + esc(where) + '</b>' : 'con il tuo account BunkerPlex') + '</p>' +
    '<input class="field f" id="lname" data-key="lname" data-autofocus type="email" inputmode="email" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="120" placeholder="Email o nome utente" value="' + esc(fieldValue('lname')) + '">' +
    '<input class="field f" id="lpass" data-key="lpass" type="password" autocomplete="current-password" data-enter="login" placeholder="Password">' +
    '<button class="btn primary block f" data-act="login" data-key="login">Entra</button>' +
    (auth.reset ? '<a class="authlink f" href="#/reset" data-key="forgot">Password dimenticata?</a>' : '') +
    googleWide() +
    (TV ? '<a class="authlink f" href="#/home" data-key="who-phone">Entra con il telefono (QR o codice)</a>' : '') +
    (APP ? '<button class="authlink f" data-act="resetserver" data-key="resetserver">Cambia server</button>' : '') +
    claimBox());
}

// Non e' il server del tuo account: lo vedi solo se il proprietario e' tuo amico
function askPage() {
  var a = cache.ask;
  var sent = a.status === 'sent';
  var body;
  if (a.status === 'received') {
    body = '<p><b>' + esc(a.owner) + '</b> ti ha già chiesto l\'amicizia: accettala dal tuo server o dall\'app BunkerPlex, poi torna qui.</p>';
  } else if (sent) {
    body = '<div class="authwait"><i class="spinner"></i><span>Richiesta mandata a <b>' + esc(a.owner) + '</b>. Quando accetta entri da solo.</span></div>';
  } else {
    body = '<p>Per guardare i suoi titoli chiedi l\'amicizia a <b>' + esc(a.owner) + '</b>: quando accetta, entri qui con il tuo account.</p>' +
      '<button class="btn primary block f" data-autofocus data-act="asksend" data-key="asksend">Chiedi l\'amicizia a ' + esc(a.owner) + '</button>';
  }
  if (sent || a.status === 'received') askPoll();
  return authShell('<div class="authico">' + FRIEND_ICON + '</div>' +
    '<h1>Questo server è di ' + esc(a.owner) + '</h1>' +
    '<p class="authsub">' + esc(a.server || '') + (a.user ? ' · sei entrato come <b>' + esc(a.user) + '</b>' : '') + '</p>' + body +
    '<button class="authlink f"' + (sent ? ' data-autofocus' : '') + ' data-act="askback" data-key="askback">Entra con un altro account</button>');
}

function askPoll() {
  clearTimeout(cache.askTimer);
  cache.askTimer = setTimeout(function () {
    var a = cache.ask;
    if (!a || (auth && auth.user)) return;
    api('/auth/ask/' + a.ticket).then(function (r) {
      if (!cache.ask) return;
      if (r.done) { cache.ask = null; toast('Ora siete amici: benvenuto'); enterApp(r); return; }
      if (r.status && r.status !== a.status) { a.status = r.status; render(); return; }
      askPoll();
    }, function () { cache.ask = null; toast('Richiesta scaduta: rientra'); render(); });
  }, 4000);
}

function loginFailed(e) {
  if (e && e.data && e.data.ask) { cache.ask = e.data.ask; render(); return true; }
  if (e && e.data && e.data.need_2fa) { cache.s2fa = { t: e.data.need_2fa, user: e.data.user || '' }; render(); return true; }
  return false;
}

// ---- Verifica in due passaggi all'accesso: il codice dell'app di autenticazione
// (o uno dei codici di recupero). act: l'azione che lo manda; cancel: quella per tornare.
function twoFaForm(user, act, cancel) {
  return '<div class="authico">' + LOCK_ICON + '</div><h1>Verifica in due passaggi</h1>' +
    '<p class="authsub">' + (user ? 'Per <b>' + esc(user) + '</b>: s' : 'S') + 'crivi il codice a 6 cifre dell\'app di autenticazione</p>' +
    '<input class="field f num" id="tfacode" data-key="tfacode" data-autofocus inputmode="numeric" autocomplete="one-time-code" ' +
    'autocapitalize="characters" spellcheck="false" maxlength="11" data-enter="' + act + '" placeholder="123 456">' +
    '<label class="tfarem"><input type="checkbox" id="tfarem" class="f" data-key="tfarem"' + (TV || BROWSER_TV ? '' : ' checked') + '> ' +
      'Ricorda questo dispositivo per 30 giorni</label>' +
    '<button class="btn primary block f" data-act="' + act + '" data-key="' + act + '">Entra</button>' +
    '<p class="authnote">Niente telefono? Scrivi uno dei codici di recupero (es. ABCDE-FGHIJ).</p>' +
    '<button class="authlink f" data-act="' + cancel + '" data-key="' + cancel + '">Annulla</button>';
}

// «Ricorda questo dispositivo»: il gettone del servizio, per account (nome o email scritti)
function trustFor(name) {
  try { return localStorage.getItem('bp-trust:' + String(name || '').trim().toLowerCase()) || ''; } catch (e) { return ''; }
}

function trustSave(names, token) {
  if (!token) return;
  names.forEach(function (n) {
    if (!n) return;
    try { localStorage.setItem('bp-trust:' + String(n).trim().toLowerCase(), token); } catch (e) { /* niente */ }
  });
}

function rememberChecked() {
  var el = document.getElementById('tfarem');
  return !!(el && el.checked);
}

function c2faPage() {
  return authShell(twoFaForm(cache.c2fa.user, 'c2fago', 'c2facancel') + (C.error ? '<p class="authnote">' + esc(C.error) + '</p>' : ''));
}

// Passo 2: quale server. Si chiede a ogni apertura (sessionStorage), per account.
function serverKey() { return 'fpServer:' + (auth && auth.user ? auth.user.id : ''); }
function currentServer() {
  try { return sessionStorage.getItem(serverKey()); } catch (e) { return 'here'; }
}
function setServer(v) {
  try { sessionStorage.setItem(serverKey(), v); } catch (e) { /* niente */ }
}
function needServer() {
  if (CENTRAL) return false;
  var u = auth && auth.user;
  return !!(u && auth.cloud && !u.must_change && currentServer() === null);
}
// Per le API: '' = tutto (prima della scelta), 'here', 'f<n>'
function serverSrc() { return currentServer() || ''; }

async function serversPage() {
  var u = auth.user;
  var data = cache.srvData;
  if (!data || Date.now() - data.at > 20000) {
    data = { at: Date.now(), friends: [], mine: [] };
    if (u.linked && !u.guest) {
      try {
        var r = await Promise.race([api('/account-friends'), new Promise(function (ok, ko) { setTimeout(function () { ko(new Error('lento')); }, 5000); })]);
        data.friends = r.friends || [];
        data.mine = r.mine || [];
        data.hereLook = r.here_look || null;
      } catch (e) { data.error = true; }
    }
    cache.srvData = data;
  }
  var cur = currentServer();
  var kinds = [];
  function card(arg, ico, name, sub, on, first, find, look, reach) {
    var off = on === false;
    if (!off && reach) kinds.push(reach);
    return srvCard({ act: off ? 'srvoff' : 'srvpick', arg: arg, key: 'srv-' + arg, name: name, sub: sub, icon: ico,
      off: off, on: cur === arg, first: first, find: find, look: look, reach: off ? '' : reach });
  }
  // Questo server: come ci arriva il dispositivo. Gli altri si raggiungono passando da lui
  // (la sua strada: rete di casa o Tailscale); gli amici sempre via Internet.
  // Nella sezione dei tuoi server basta da dove si raggiunge
  function how(r, other) { return REACH[r] ? REACH[r].card : other; }
  var here = hereReach();
  var mine = [card('here', SRV_ICON, auth.pc || 'Questo server',
    u.guest ? 'di ' + esc(auth.owner) + ' · sei suo ospite' : how(here, 'Il tuo server'), true, true, '', data.hereLook, here)];
  data.mine.forEach(function (m) {
    if (!m.n) return;
    // Ci si arriva passando da questo server: e' locale solo se lo sono tutti e due i tratti
    var r = !m.route ? '' : m.route === 'lan' && REACH[here] && here !== 'net' ? 'lan' : 'net';
    mine.push(card('f' + m.n, SRV_ICON, m.name || 'Il tuo altro PC', m.online === false ? 'Spento o non raggiungibile' : how(r, 'Il tuo PC'),
      m.online === false ? false : true, false, '', m.look, r));
  });
  var friends = [];
  var waiting = [];
  data.friends.forEach(function (f) {
    if (f.status === 'received') { waiting.push(f); return; }
    if (f.status !== 'ok') return;
    var servers = (f.servers || []).filter(function (s) { return s.n; });
    if (!servers.length) {
      friends.push(card('none', FRIEND_ICON, f.username, 'Nessun server acceso', false));
      return;
    }
    servers.forEach(function (s) {
      friends.push(card('f' + s.n, FRIEND_ICON, servers.length > 1 && s.name ? s.name : f.username,
        (servers.length > 1 ? 'di ' + esc(f.username) : (s.name ? esc(s.name) : 'Amico')) + (s.online === false ? ' · non raggiungibile' : s.online ? ' · via Internet' : ''),
        s.online === false ? false : true, false, f.username + ' ' + (s.name || ''), s.look, s.online ? 'net' : ''));
    });
  });
  var add = '';
  if (u.linked && !u.guest) {
    add = cache.srvAdd
      ? '<div class="srvadd"><input class="field f" id="afname" data-key="afname" data-autofocus maxlength="32" autocapitalize="none" spellcheck="false" data-enter="srvaddsend" placeholder="Nome dell\'account del tuo amico">' +
        '<button class="btn primary f" data-act="srvaddsend" data-key="srvaddsend">Invia</button></div>'
      : '<button class="srv add f" data-act="srvadd" data-key="srvadd"><span class="srvart">' + PLUS_ICON + '</span><span class="srvtxt"><b>Aggiungi un amico</b><small>Con il nome del suo account</small></span></button>';
  }
  var req = waiting.map(function (f) {
    return '<div class="srvreq"><span><b>' + esc(f.username) + '</b> vuole essere tuo amico</span>' +
      '<button class="btn primary f" data-act="srvaccept" data-arg="' + f.id + '" data-key="srvacc-' + f.id + '">Accetta</button></div>';
  }).join('');
  return { html: authShell('<h1>Cosa guardi oggi?</h1><p class="authsub">Scegli il server' + (u.guest ? '' : ': il tuo e quelli dei tuoi amici') + '</p>' +
    reachLegend(kinds) + req + srvGrid([{ title: u.guest ? 'Server' : 'I tuoi server', cards: mine },
      { title: 'Amici', cards: friends, extra: add }], mine.length + friends.length) +
    (data.error ? '<p class="authnote">Amici non raggiungibili ora: riprova tra poco.</p>' : '') +
    '<button class="authlink f" data-act="logout" data-key="srvlogout">Esci da ' + esc(u.name) + '</button>', 'grid'), mount: srvMount };
}

// Sul telefono (o sul PC): la pagina che apre il QR o il codice della TV
async function phonePairPage(code) {
  if (!auth) { try { await loadAuth(); } catch (e) { /* si chiede la password */ } }
  // La TV lo dice subito: «Codice aperto sul telefono»
  if (cache.pairSeen !== code) {
    cache.pairSeen = code;
    post('/auth/pair/' + code + '/seen').catch(function () { /* scaduto: lo dice il passo dopo */ });
  }
  var done = cache.pairDone && cache.pairDone.code === code ? cache.pairDone.name : '';
  if (done) {
    return authShell('<div class="authico">' + SRV_ICON + '</div><h1>Fatto</h1>' +
      '<p class="authsub">La TV sta entrando come <b>' + esc(done) + '</b>. Puoi chiudere questa pagina.</p>' +
      '<a class="btn block f" data-autofocus href="#/home" data-key="pairhome">Apri BunkerPlex qui</a>');
  }
  if (auth && auth.user && cache.pairPw !== code) {
    return authShell('<div class="authico">' + SRV_ICON + '</div><h1>Collega la TV</h1>' +
      '<p class="authsub">Codice <b class="num">' + esc(code.slice(0, 3) + ' ' + code.slice(3)) + '</b></p>' +
      '<p>La TV entra con il tuo account, <b>' + esc(auth.user.name) + '</b>. Poi lì scegli il server e chi guarda.</p>' +
      '<button class="btn primary block f" data-autofocus data-act="pairme" data-arg="' + esc(code) + '" data-key="pairme">Collega come ' + esc(auth.user.name) + '</button>' +
      '<button class="authlink f" data-act="pairother" data-arg="' + esc(code) + '" data-key="pairother">Usa un altro account</button>');
  }
  var needNew = cache.pairNeedNew === code;
  return authShell('<div class="authico">' + SRV_ICON + '</div><h1>Entra sulla TV</h1>' +
    '<p class="authsub">Codice <b class="num">' + esc(code.slice(0, 3) + ' ' + code.slice(3)) + '</b> · accedi qui e la TV entra da sola</p>' +
    '<input class="field f" id="lname" data-key="lname" data-autofocus type="email" inputmode="email" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="120" placeholder="Email o nome utente" value="' + esc(fieldValue('lname')) + '">' +
    '<input class="field f" id="lpass" data-key="lpass" type="password" autocomplete="current-password"' + (needNew ? '' : ' data-enter="pairsend"') + ' placeholder="' + (needNew ? 'Password provvisoria' : 'Password') + '" value="' + esc(fieldValue('lpass')) + '">' +
    (needNew ? '<p class="authsub">La password è provvisoria: scegline una tua, varrà su tutti i PC e le TV.</p>' +
      '<input class="field f" id="pnew" data-key="pnew" type="password" autocomplete="new-password" placeholder="Password nuova (almeno 8 caratteri)">' +
      '<input class="field f" id="pnew2" data-key="pnew2" type="password" autocomplete="new-password" data-enter="pairsend" placeholder="Ripeti la password nuova">' : '') +
    (cache.pair2fa === code ? '<p class="authsub">Verifica in due passaggi: scrivi anche il codice dell\'app di autenticazione (o uno di recupero).</p>' +
      '<input class="field f num" id="pcode" data-key="pcode" data-autofocus inputmode="numeric" autocomplete="one-time-code" maxlength="11" data-enter="pairsend" placeholder="Codice dell\'app">' : '') +
    '<button class="btn primary block f" data-act="pairsend" data-arg="' + esc(code) + '" data-key="pairsend">Entra sulla TV</button>' +
    (auth && auth.google && !CENTRAL ? '<div class="author"><span>oppure</span></div>' +
      '<button class="gbtn f" data-act="pairgoogle" data-arg="' + esc(code) + '" data-key="pairgoogle">' + GOOGLE_G + '<span>Continua con Google</span></button>' : '') +
    '<p class="authnote">Il tuo account è già su questo PC? Allora sulla TV basta sceglierlo in «Chi guarda?».</p>');
}

// Account invitato da Amministrazione: ha ancora il nome provvisorio, al primo accesso sceglie il suo
function needsName() {
  return !!(auth && auth.user && /^invito-[0-9a-f]{6}$/i.test(auth.user.name || ''));
}

function passwordPage(forced) {
  var naming = forced && needsName();
  return '<div class="page"><div class="panel login"><h1>' + (naming ? 'Benvenuto su BunkerPlex' : forced ? 'Scegli la tua password' : 'Cambia password') + '</h1>' +
    (naming ? '<p>Sei entrato con l\'invito. Scegli il tuo nome e una password tua: varranno su tutti i PC, telefoni e TV. Poi crei il tuo profilo.</p>' +
      '<input class="field f" style="margin-bottom:.6rem" id="pname" data-key="pname" data-autofocus maxlength="32" autocomplete="username" autocapitalize="none" placeholder="Il tuo nome (lettere, numeri, punto, trattino)">'
      : forced ? '<p>Il tuo account ha una password provvisoria. Scegline una tua: varrà su tutti i PC e le TV. Finché non lo fai funziona tutto, ma non si sincronizza.</p>'
      : '<p>Gli altri PC dove sei entrato ti chiederanno la password nuova.</p>') +
    '<input class="field f" style="margin-bottom:.6rem" id="pold" data-key="pold"' + (naming ? '' : ' data-autofocus') + ' type="password" autocomplete="current-password" placeholder="' + (naming ? 'Password provvisoria (dall\'email)' : forced ? 'Password provvisoria' : 'Password attuale') + '">' +
    '<input class="field f" style="margin-bottom:.6rem" id="pnew" data-key="pnew" type="password" autocomplete="new-password" placeholder="Password nuova (almeno 8 caratteri)">' +
    '<input class="field f" id="pnew2" data-key="pnew2" type="password" autocomplete="new-password" data-enter="changepw" placeholder="Ripeti la password nuova">' +
    '<div class="actions"><button class="btn primary f" data-act="changepw" data-arg="' + (forced ? '1' : '') + '" data-key="changepw">Salva</button>' +
    (naming ? '<button class="btn f" data-act="logout" data-key="pwlogout">Esci</button>'
      : forced ? '<button class="btn f" data-act="pwlater" data-key="pwlater">Più tardi</button>' : '<button class="btn f" data-act="goback" data-key="cancel">Annulla</button>') +
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

// Segnale fisso in basso: account, ma il servizio non si raggiunge
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
// Chiavette e TV con poca memoria: animazioni ridotte da subito, senza aspettare che
// lo scorrimento perda colpi (si possono riaccendere da Impostazioni)
if (device.slow === undefined && ((navigator.deviceMemory && navigator.deviceMemory <= 1) ||
    (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 2))) device.slow = true;
// Aspetto da TV: dentro l'app, da solo nel browser di una smart TV (si spegne da
// Impostazioni), oppure scelto a mano (o con ?tv=1)
var TVLOOK = TV || device.tv === true || (SMART_TV && device.tv !== false) || /[?&]tv=1/.test(location.search);
// Si entra dal telefono (QR e codice), mai con la password scritta col telecomando:
// nell'app TV e nel browser di una smart TV con l'aspetto da TV
var BROWSER_TV = SMART_TV && TVLOOK;
var TVLOGIN = TV || BROWSER_TV;
var smooth = 'smooth';               // 'auto' quando le animazioni sono ridotte

// Locandine in dissolvenza: un'immagine si mostra quando e' arrivata (html.imgfade in
// style.css). L'evento load non risale, ma si prende in fase di cattura per tutte.
document.addEventListener('load', function (e) {
  if (e.target && e.target.tagName === 'IMG') e.target.classList.add('imgok');
}, true);

function markLoadedImages(root) {
  var imgs = root.getElementsByTagName('img');
  for (var i = 0; i < imgs.length; i++) if (imgs[i].complete) imgs[i].classList.add('imgok');
}

// «La mia lista» e «Visto»: dopo la conferma il pulsante fa un piccolo scatto (.popped)
var popKeys = [];

function applyDevice() {
  var root = document.documentElement;
  var lite = device.anim === 'lite' || (device.anim !== 'full' && !!device.slow);
  smooth = lite ? 'auto' : 'smooth';
  root.classList.toggle('lite', lite);
  root.classList.toggle('imgfade', !lite);      // locandine in dissolvenza (style.css)
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

// ---------------------------------------------------------------- PWA centrale
// La stessa interfaccia, servita dal servizio account (<meta name="bp-central">):
// si entra con l'account (qui, non su un server), si sceglie il server dall'elenco
// del servizio e ci si collega direttamente, prima per la rete di casa (nome https
// con certificato valido), poi su questo PC (localhost). Il server da' una sessione
// in cambio del gettone d'accesso (/api/auth/access, intestazione X-BP-Session);
// video e immagini portano una chiave nel percorso (/k/<chiave>/api/...).
// I server degli amici si aprono dal proprio server, come prima (src = f<n>).
// Vedi docs/architettura.md.
var CENTRAL = !!document.querySelector('meta[name="bp-central"]');
// profiles: i profili dell'account (GET /profiles, null = non ancora letti o servizio
// irraggiungibile); pid: il profilo scelto in «Chi guarda?» su questo dispositivo
var C = { token: '', user: null, sid: '', owner: 0, name: '', role: '', base: '', session: '', mkey: '', mexp: 0, list: null, friends: [], error: '',
  profiles: null, pid: null };
var C_SAVED = ['token', 'user', 'sid', 'owner', 'name', 'role', 'pid'];

function cSave() {
  var o = {};
  C_SAVED.forEach(function (k) { o[k] = C[k]; });
  try { localStorage.setItem('bpCentral', JSON.stringify(o)); } catch (e) { /* niente */ }
}

function cLoad() {
  try {
    var o = JSON.parse(localStorage.getItem('bpCentral')) || {};
    C_SAVED.forEach(function (k) { if (o[k] !== undefined) C[k] = o[k]; });
  } catch (e) { /* niente */ }
}
if (CENTRAL) cLoad();

// Sessione su un server, per non crearne una nuova a ogni apertura
function cSessKey(sid) { return 'bpSess:' + sid; }
function cSessGet(sid) {
  try { return JSON.parse(localStorage.getItem(cSessKey(sid))) || null; } catch (e) { return null; }
}
function cSessSet(sid, v) {
  try { if (v) localStorage.setItem(cSessKey(sid), JSON.stringify(v)); else localStorage.removeItem(cSessKey(sid)); } catch (e) { /* niente */ }
}

// Chiamata al servizio account (stesso indirizzo della pagina)
function cloud(method, path, body) {
  var h = { Accept: 'application/json' };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (C.token) h.Authorization = 'Bearer ' + C.token;
  return fetch(path, { method: method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }).catch(function () {
    cOffline();
    throw new Error('Il servizio account non risponde: controlla la connessione');
  }).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (j) {
      // (un PIN sbagliato e' 401 ma non vuol dire che l'accesso e' scaduto)
      if (r.status === 401 && C.token && !/^\/(login|resolve|lookup|activate|magic|google|reset|profiles\/\d+\/open)/.test(path)) {
        cForget();
        setTimeout(render, 0);
      }
      if (!r.ok) {
        var err = new Error(j.detail || ('Errore ' + r.status));
        err.data = j;
        err.status = r.status;
        throw err;
      }
      return j;
    });
  });
}

// La password non lascia mai il dispositivo: al servizio va l'impronta (come dal server)
async function cVerifier(username, password) {
  var enc = new TextEncoder();
  var key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  var bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', iterations: 200000,
    salt: enc.encode('bunkerplex:' + String(username).trim().toLowerCase()) }, key, 256);
  return Array.prototype.map.call(new Uint8Array(bits), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
}

async function cUsername(name) {
  name = String(name || '').trim();
  return name.indexOf('@') > 0 ? (await cloud('POST', '/resolve', { email: name })).username : name;
}

// offer: dopo password, Google o link si propone una passkey (non dopo una passkey)
function cEntered(r, offer) {
  // Verifica in due passaggi: la password andava bene, ora il codice (vedi c2faPage)
  if (r && r.need_2fa) {
    cache.c2fa = { ticket: r.ticket, user: (r.user && r.user.username) || '', offer: offer };
    C.error = '';
    return;
  }
  if (offer !== false) cache.pkOffer = true;
  C.token = r.token;
  C.user = r.user;
  C.error = '';
  cSave();
}

// Via dal server scelto (non dall'account)
function cDrop() {
  C.base = ''; C.session = ''; C.mkey = ''; C.mexp = 0;
  auth = null;
  conflicts = null;
  dropCached();
  libsLoadedAt = 0;
  railSignature = '';
}

// Via anche dall'account (su questo dispositivo)
function cForget() {
  cDrop();
  C.token = ''; C.user = null; C.sid = ''; C.list = null; C.friends = []; C.profiles = null; C.pid = null;
  cache.pinAsk = null; cache.pEdit = null;
  try { sessionStorage.removeItem('bpWho'); } catch (e) { /* niente */ }
  cSave();
}

// Il biglietto di un profilo (POST /profiles/:id/open, 30 giorni): si tiene per
// profilo e si ripassa a ogni server, cosi' il PIN si chiede solo quando si sceglie
function cTicketKey(pid) { return 'bpTicket:' + (C.user && (C.user.id || C.user.username) || '') + ':' + pid; }
function cTicketGet(pid) {
  if (pid === null || pid === undefined) return '';
  try {
    var t = JSON.parse(localStorage.getItem(cTicketKey(pid)));
    return t && t.ticket && t.exp - Date.now() / 1000 > 300 ? t.ticket : '';
  } catch (e) { return ''; }
}
function cTicketSet(pid, ticket, exp) {
  try {
    if (ticket) localStorage.setItem(cTicketKey(pid), JSON.stringify({ ticket: ticket, exp: exp || 0 }));
    else localStorage.removeItem(cTicketKey(pid));
  } catch (e) { /* niente */ }
}

// I profili dell'account dal servizio: una volta per apertura (e dopo ogni modifica)
async function cProfiles(force) {
  if (C.profiles && !force) return C.profiles;
  // Non riuscito da poco (servizio irraggiungibile o di prima): non si richiede a ogni pagina
  if (!force && Date.now() - (cProfiles.failed || 0) < 60000) return C.profiles;
  try {
    var r = await cloud('GET', '/profiles');
    C.profiles = r.profiles || [];
    if (C.pid !== null && !C.profiles.some(function (p) { return p.id === C.pid; })) { C.pid = null; cSave(); }
  } catch (e) {
    // Servizio irraggiungibile (o di prima, senza profili): C.profiles resta null e
    // «Chi guarda?» lo chiede il server, come prima
    cProfiles.failed = Date.now();
  }
  return C.profiles;
}

// Si chiede «Chi guarda?» (come Netflix): con piu' profili, o con un solo profilo con il PIN.
// A ogni apertura dell'app; il profilo di prima resta proposto per primo.
function cNeedWho() {
  var list = C.profiles || [];
  if (!list.length) return false;
  if (list.length === 1 && !list[0].pin) {
    if (C.pid !== list[0].id) { C.pid = list[0].id; cSave(); }
    return false;
  }
  if (C.pid === null || !profById(C.pid)) return true;
  if ((profById(C.pid) || {}).pin && !cTicketGet(C.pid)) return true;
  try { return sessionStorage.getItem('bpWho') !== '1'; } catch (e) { return false; }
}

// Apre un profilo nel servizio (con il PIN, se ne ha uno): biglietto per i server.
// Se c'e' gia' un tuo server aperto, il profilo cambia anche li'.
async function cWhoOpen(id, pin) {
  var r = await cloud('POST', '/profiles/' + id + '/open', pin ? { pin: pin } : {});
  cTicketSet(id, r.ticket, r.exp);
  C.pid = id;
  cSave();
  if (C.base && C.role === 'owner' && auth && auth.user) {
    try { await post('/profiles/select', { id: id, ticket: r.ticket }); } catch (e) { toast(e.message); }
    await watcherChanged();
  }
}

// Sul tuo server aperto il profilo e' un altro (sessione ripresa): si porta quello scelto
async function cSyncProfile() {
  if (!C.profiles || C.pid === null || C.role !== 'owner' || !auth || !auth.user || auth.user.watcher === C.pid) return;
  var t = cTicketGet(C.pid);
  if (!t && C.pid !== 0) return;
  try {
    await post('/profiles/select', t ? { id: C.pid, ticket: t } : { id: C.pid });
    await loadAuth();
  } catch (e) { /* il server chiedera' lui chi guarda */ }
}

function anyOf(list) {
  return new Promise(function (ok, ko) {
    var left = list.length;
    if (!left) { ko(new Error('nessun indirizzo')); return; }
    list.forEach(function (p) { p.then(ok, function () { if (--left === 0) ko(new Error('non raggiungibile')); }); });
  });
}

// Risponde, ed e' proprio quel server (sid)?
function cProbe(base, sid) {
  var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  var t = setTimeout(function () { if (ctl) ctl.abort(); }, 3500);
  return fetch(base + '/api/info', { cache: 'no-store', signal: ctl ? ctl.signal : undefined })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      clearTimeout(t);
      if (j.app !== 'bunkerplex' || j.sid !== sid) throw new Error('un altro server');
      return base;
    }, function (e) { clearTimeout(t); throw e; });
}

function cCandidates(s) {
  var out = [];
  if (s.addresses && s.addresses.secure_lan) out.push(s.addresses.secure_lan);
  // Indirizzo di casa in http: va nell'app Android (che lo permette); un browser lo blocca subito
  var lan = s.addresses && /^https:\/\/([\d.]+):\d+$/.exec(s.addresses.lan || '');
  if (lan) out.push('http://' + lan[1] + ':32500');
  if (s.role === 'owner') out.push('http://localhost:32500');
  // Fuori casa: l'indirizzo pubblico del server (Tailscale Funnel), se acceso
  if (s.addresses && s.addresses.public) out.push(s.addresses.public);
  return out;
}

async function cMediaKey(force) {
  if (!C.session || (!force && C.mkey && C.mexp - Date.now() / 1000 > 1800)) return;
  var r = await fetch(C.base + '/api/access/media', { method: 'POST', headers: { 'X-BP-Session': C.session } });
  var j = await r.json().catch(function () { return {}; });
  if (r.ok && j.key) { C.mkey = j.key; C.mexp = j.exp; }
}

// Collegamento al server scelto: indirizzo, sessione, chiave dei video.
// Anche il server di un amico si apre direttamente: il servizio da' un gettone
// «friend» e quel server fa entrare l'amico come ospite (le raccolte condivise).
async function cOpen(s) {
  var host = s;
  var base;
  try {
    base = await anyOf(cCandidates(host).map(function (c) { return cProbe(c, host.sid); }));
  } catch (e) {
    var ne = new Error('non raggiungibile');
    ne.net = true;
    throw ne;
  }
  var saved = cSessGet(host.sid);
  var session = saved && saved.base === base ? saved.session : '';
  if (session) {
    var ok = await fetch(base + '/api/auth/state', { headers: { 'X-BP-Session': session } })
      .then(function (r) { return r.json(); }).then(function (j) { return !!(j && j.user); }, function () { return false; });
    if (!ok) session = '';
  }
  if (!session) {
    // Il server di un amico: il servizio deve sapere di chi e' (senza, lo cerca tra i tuoi)
    var a = await cloud('POST', '/servers/' + host.sid + '/access', s.role === 'friend' && s.owner ? { owner: s.owner.id } : {});
    // Il profilo scelto in «Chi guarda?»: sul tuo server la sessione nasce gia' su di lui
    var ab = { token: a.token, device: devName() };
    var ticket = s.role === 'owner' && C.profiles ? cTicketGet(C.pid) : '';
    if (ticket) { ab.profile = C.pid; ab.profile_ticket = ticket; }
    var r = await fetch(base + '/api/auth/access', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ab) });
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok || !j.session) {
      var se = new Error(j.detail || 'Il server non ha accettato l\'accesso');
      // Un server di prima della 3.26 non conosce il gettone degli amici
      if (s.role === 'friend' && r.status === 403 && /Gettone/.test(se.message)) {
        se.message = 'il server di ' + s.owner.username + ' va aggiornato per far entrare gli amici (Impostazioni → Aggiornamenti)';
      }
      throw se;
    }
    session = j.session;
    cSessSet(host.sid, { base: base, session: session });
  }
  C.base = base;
  C.session = session;
  if (APP && tvApp.rememberServer && s.role === 'owner') tvApp.rememberServer(base);     // senza Internet l'app lo ritrova
  await cMediaKey(true);
  auth = null;
  await loadAuth();
  setServer('here');
  C.role = s.role;
  await cSyncProfile();
  if (auth.user && !auth.user.must_change) await afterLogin([]);
}

// L'elenco dei server: prima quello in casa (stessa rete), poi gli accesi, i tuoi
// prima di quelli degli amici, in fondo gli spenti. Con l'elenco arrivano anche gli
// amici e le richieste (per aggiungerli da qui).
async function cServers(force) {
  if (!C.list || force) {
    var r = await cloud('GET', '/servers');
    var list = r.servers || [];
    C.friends = r.friends || [];
    var sorted = C.list = cSort(list);
    // Il servizio riconosce la stessa rete dall'indirizzo pubblico; se non basta
    // (IPv4 e IPv6 diversi) si prova il tuo server sulla rete di casa, senza aspettare
    if (!list.some(function (s) { return s.local; })) {
      cLocalProbe(list).then(function () {
        if (C.list === sorted && list.some(function (s) { return s.local; })) {
          C.list = cSort(C.list);
          if (!C.base) render();
        }
      });
    }
  }
  return C.list;
}

function cSort(list) {
  function rank(s) {
    if (s.local) return 0;
    if (s.online === false) return 4;
    return s.role === 'owner' ? (s.online ? 1 : 3) : (s.online ? 2 : 3);
  }
  return list.map(function (s, i) { return { s: s, i: i }; })
    .sort(function (a, b) { return rank(a.s) - rank(b.s) || a.i - b.i; })
    .map(function (x) { return x.s; });
}

function cLocalProbe(list) {
  var mine = list.filter(function (s) { return s.role === 'owner' && s.online !== false; });
  return Promise.all(mine.map(function (s) {
    var a = s.addresses || {}, c = [];
    if (a.secure_lan) c.push(a.secure_lan);
    var lan = /^https:\/\/([\d.]+):\d+$/.exec(a.lan || '');
    if (lan && APP) c.push('http://' + lan[1] + ':32500');
    if (!c.length) return null;
    return Promise.race([anyOf(c.map(function (b) { return cProbe(b, s.sid); })),
      new Promise(function (ok, ko) { setTimeout(ko, 1500); })])
      .then(function (base) { s.local = true; s.reach = reachOf(base); }, function () { /* non in casa */ });
  }));
}

// Come si arriva da qui a un server dell'elenco: locale (stessa rete o questo PC),
// online (indirizzo pubblico, «Da ovunque») o '' (spento, o acceso ma solo dalla sua rete)
function cReach(s) {
  if (s.online === false) return '';
  if (s.local) return s.reach === 'pc' ? 'pc' : 'lan';
  return s.addresses && s.addresses.public ? 'net' : '';
}

// Il server scelto l'ultima volta (se c'e' ancora), altrimenti l'elenco
async function cResume() {
  if (C.base || !C.sid) return;
  try {
    var list = await cServers(true);
    var s = list.filter(function (x) { return x.sid === C.sid && (x.role === 'owner' ? true : x.owner.id === C.owner); })[0];
    if (!s) { C.sid = ''; cSave(); return; }
    await cOpen(s);
  } catch (e) {
    C.error = (C.name || 'Il server') + ': ' + e.message;
    C.sid = '';
    cDrop();
  }
}

// I parametri dopo «?» nell'indirizzo #/pagina?a=1&b=2 (i link delle email)
function hashParams() {
  var q = location.hash.split('?')[1] || '';
  var out = {};
  q.split('&').forEach(function (kv) {
    if (!kv) return;
    var i = kv.indexOf('=');
    try { out[decodeURIComponent(i < 0 ? kv : kv.slice(0, i))] = decodeURIComponent((i < 0 ? '' : kv.slice(i + 1)).replace(/\+/g, ' ')); } catch (e) {}
  });
  return out;
}

// Accesso a passi: prima l'email (o il nome utente), poi la password; per un account
// invitato (o con password provvisoria) i campi per attivarlo. Google resta com'e'.
function cLoginPage() {
  var L = cache.cLogin;
  var note = C.error ? '<p class="authnote">' + esc(C.error) + '</p>' : '';
  if (!L) {
    setTimeout(pkConditional, 0);        // passkey proposte dal campo email
    return authShell('<h1>Accedi</h1><p class="authsub">' + (cTvPending() !== null ? 'con il tuo account BunkerPlex, poi colleghi la TV' : 'con il tuo account BunkerPlex') + '</p>' +
      '<input class="field f" id="lname" data-key="lname" data-autofocus type="email" inputmode="email" autocomplete="username webauthn" autocapitalize="none" spellcheck="false" maxlength="120" data-enter="cnext" placeholder="Email" value="' + esc(fieldValue('lname')) + '">' +
      '<button class="btn primary block f" data-act="cnext" data-key="cnext">Continua</button>' +
      '<div class="author"><span>oppure</span></div>' +
      (pkOn() ? '<button class="btn block f pkbtn" data-act="pklogin" data-key="pklogin">' + pkIcon() + '<span>Entra con impronta o volto</span></button>' : '') +
      '<button class="gbtn f" data-act="cgoogle" data-key="google"' + (pkOn() ? ' style="margin-top:.7rem"' : '') + '>' + GOOGLE_G + '<span>Continua con Google</span></button>' + note +
      cAppLink());
  }
  var who = '<p class="authsub"><b>' + esc(L.email) + '</b></p>';
  var back = '<button class="authlink f" data-act="cback" data-key="cback">Usa un\'altra email</button>';
  var byMail = L.email.indexOf('@') > 0;
  if (L.sent) {
    return authShell('<h1>Controlla la posta</h1>' + who +
      '<p class="authsub">Ti abbiamo mandato un link: aprilo ' + (L.activate ? 'per attivare l\'account' : 'ed entri') + ', senza password. Se non arriva, guarda nello spam.</p>' +
      '<button class="btn block f" data-act="cmagic" data-key="cmagic" data-autofocus>Mandalo di nuovo</button>' +
      back + note);
  }
  if (L.activate) {
    // Senza il link dell'email: il link si chiede con un tocco; la password provvisoria resta possibile
    if (!L.token && !L.manual) {
      return authShell('<h1>Attiva il tuo account</h1>' + who +
        '<p class="authsub">Ti mandiamo un link: lo apri, scegli nome e password e sei dentro.</p>' +
        '<button class="btn primary block f" data-act="cmagic" data-key="cmagic" data-autofocus>Mandami il link</button>' +
        '<div class="author"><span>oppure</span></div>' +
        '<button class="gbtn f" data-act="cgoogle" data-key="google">' + GOOGLE_G + '<span>Continua con Google</span></button>' +
        '<button class="authlink f" data-act="cmanual" data-key="cmanual">Ho la password provvisoria</button>' +
        back + note);
    }
    return authShell('<h1>' + (L.needs_name ? 'Attiva il tuo account' : 'Scegli la tua password') + '</h1>' + who +
      (L.needs_name ? '<input class="field f" id="cname" data-key="cname" data-autofocus autocapitalize="none" spellcheck="false" maxlength="32" placeholder="Il tuo nome utente">' : '') +
      (L.token ? '' : '<input class="field f" id="cold" data-key="cold" type="password" autocomplete="current-password"' + (L.needs_name ? '' : ' data-autofocus') + ' placeholder="Password provvisoria (dall\'email)">') +
      '<input class="field f" id="cnew" data-key="cnew" type="password" autocomplete="new-password"' + (!L.needs_name && L.token ? ' data-autofocus' : '') + ' placeholder="Password nuova (almeno 8 caratteri)">' +
      '<input class="field f" id="cnew2" data-key="cnew2" type="password" autocomplete="new-password" data-enter="cactivate" placeholder="Ripeti la password">' +
      '<button class="btn primary block f" data-act="cactivate" data-key="cactivate">' + (L.needs_name ? 'Crea il mio account' : 'Salva ed entra') + '</button>' +
      back + note);
  }
  return authShell('<h1>Bentornato</h1>' + who +
    '<input type="email" autocomplete="username" value="' + esc(L.email) + '" hidden>' +
    '<input class="field f" id="lpass" data-key="lpass" data-autofocus type="password" autocomplete="current-password" data-enter="clogin" placeholder="Password">' +
    '<button class="btn primary block f" data-act="clogin" data-key="login">Entra</button>' +
    (byMail ? '<button class="btn block f" data-act="cmagic" data-key="cmagic">Mandami un link per entrare</button>' : '') +
    '<a class="authlink f" href="#/reset" data-key="forgot">Password dimenticata?</a>' +
    back + note);
}

// Invitato entrato con Google: sceglie solo il nome, poi entra sempre con Google
function cNamePage() {
  return authShell('<h1>Come ti chiami?</h1><p class="authsub">Il nome con cui ti vedranno gli amici su BunkerPlex</p>' +
    '<input class="field f" id="cname" data-key="cname" data-autofocus autocapitalize="none" spellcheck="false" maxlength="32" data-enter="cnamesave" placeholder="Il tuo nome utente">' +
    '<button class="btn primary block f" data-act="cnamesave" data-key="cnamesave">Continua</button>' +
    '<button class="authlink f" data-act="logout" data-key="clogout">Esci</button>');
}

function cResetPage() {
  var sent = cache.cReset;
  return authShell('<h1>Password dimenticata</h1>' +
    (sent ? '<p class="authsub">Ti abbiamo scritto a <b>' + esc(sent) + '</b>: scrivi il codice e la password nuova</p>' +
      '<input class="field f" id="rcode" data-key="rcode"' + (cache.cResetCode ? '' : ' data-autofocus') + ' inputmode="numeric" maxlength="6" placeholder="Codice di 6 cifre" value="' + esc(cache.cResetCode || fieldValue('rcode')) + '">' +
      '<input class="field f" id="rpass" data-key="rpass"' + (cache.cResetCode ? ' data-autofocus' : '') + ' type="password" autocomplete="new-password" placeholder="Password nuova (almeno 8 caratteri)">' +
      '<input class="field f" id="rpass2" data-key="rpass2" type="password" autocomplete="new-password" data-enter="cresetdone" placeholder="Ripeti la password">' +
      '<button class="btn primary block f" data-act="cresetdone" data-key="cresetdone">Cambia la password</button>'
      : '<p class="authsub">Ti mandiamo un codice all\'email dell\'account</p>' +
      '<input class="field f" id="remail" data-key="remail" data-autofocus type="email" inputmode="email" autocapitalize="none" maxlength="120" data-enter="cresetgo" placeholder="Email" value="' + esc(fieldValue('remail') || (cache.cLogin && cache.cLogin.email.indexOf('@') > 0 ? cache.cLogin.email : '')) + '">' +
      '<button class="btn primary block f" data-act="cresetgo" data-key="cresetgo">Manda il codice</button>') +
    '<a class="authlink f" href="#/home" data-key="back">Torna all\'accesso</a>');
}

// I link delle email (#/attiva?email=…&t=… e #/reset?email=…&code=…): i dati vanno
// nella pagina e l'indirizzo torna pulito (il gettone non resta nella cronologia)
async function cMailLink() {
  var h = location.hash;
  if (!/^#\/(attiva|reset|entra)\?/.test(h)) return;
  var p = hashParams();
  // Link per entrare: dritti dentro
  if (/^#\/entra/.test(h)) {
    if (p.email && p.t) {
      if (C.token) cForget();
      try {
        cEntered(await cloud('POST', '/magic/finish', { email: p.email, token: p.t, device: devName(), kind: 'pwa' }));
      } catch (e) {
        cache.cLogin = { email: p.email, username: '', activate: false };
        try { cache.cLogin.username = (await cloud('POST', '/lookup', { email: p.email })).username; } catch (e2) {}
        C.error = e.message;
      }
    }
    location.replace('#/home');
    return;
  }
  // I dati prima, poi l'indirizzo pulito: il cambio di indirizzo ridisegna la pagina
  if (/^#\/reset/.test(h)) {
    if (!C.token && p.email) {
      cache.cReset = p.email;
      cache.cResetCode = /^\d{6}$/.test(p.code || '') ? p.code : '';
    }
    location.replace('#/reset');
    return;
  }
  if (p.email) {
    // Un altro account gia' aperto su questo dispositivo: il link e' per qualcun altro
    if (C.token) cForget();
    try {
      var r = await cloud('POST', '/lookup', { email: p.email });
      cache.cLogin = { email: p.email, username: r.username, activate: r.activate, needs_name: r.needs_name, token: r.activate ? (p.t || '') : '' };
      C.error = r.activate ? '' : 'Questo account è già attivo: entra con la tua password';
    } catch (e) {
      cache.cLogin = null;
      C.error = e.message;
    }
  }
  location.replace('#/home');
}

// Password provvisoria (account invitato): si cambia qui, con il nome se serve
function cPasswordPage() {
  var named = C.user && C.user.needs_name;
  return authShell('<h1>Scegli la tua password</h1><p class="authsub">Quella che hai ricevuto è provvisoria</p>' +
    (named ? '<input class="field f" id="cname" data-key="cname" data-autofocus autocapitalize="none" maxlength="32" placeholder="Il tuo nome utente">' : '') +
    '<input class="field f" id="cold" data-key="cold" type="password" autocomplete="current-password"' + (named ? '' : ' data-autofocus') + ' placeholder="Password provvisoria">' +
    '<input class="field f" id="cnew" data-key="cnew" type="password" autocomplete="new-password" placeholder="Password nuova (almeno 8 caratteri)">' +
    '<input class="field f" id="cnew2" data-key="cnew2" type="password" autocomplete="new-password" data-enter="cpwsave" placeholder="Ripeti la password">' +
    '<button class="btn primary block f" data-act="cpwsave" data-key="cpwsave">Salva</button>' +
    '<button class="authlink f" data-act="logout" data-key="clogout">Esci</button>');
}

async function cServersPage() {
  var list;
  try {
    list = await cServers(!C.list);
  } catch (e) {
    return authShell('<h1>Cosa guardi oggi?</h1><p class="authnote">' + esc(e.message) + '</p>' +
      '<button class="btn primary f" data-act="crefresh" data-key="crefresh">Riprova</button>' +
      '<button class="authlink f" data-act="logout" data-key="clogout">Esci</button>', true);
  }
  var mine = [], theirs = [], kinds = [];
  // I tuoi server sulla stessa macchina (stessa impronta): raggruppati, per riconoscere
  // quello vecchio, spento, rimasto da un'installazione di prima
  var machines = {}, groups = {};
  list.forEach(function (s) { if (s.role === 'owner' && s.machine) machines[s.machine] = (machines[s.machine] || 0) + 1; });
  list.forEach(function (s, i) {
    var off = s.online === false;
    var friend = s.role === 'friend';
    var reach = cReach(s);
    if (reach) kinds.push(reach);
    // Nella sezione «I tuoi server» basta da dove si raggiunge; per gli amici anche di chi e'
    var where = off ? 'non raggiungibile' : REACH[reach] ? REACH[reach].how
      // Acceso ma senza indirizzo pubblico («Da ovunque» spento): si apre solo dalla sua rete
      : s.online ? 'acceso, solo dalla sua rete' : '';
    // I tuoi: acceso o spento, e la versione
    var sub = friend ? 'di ' + esc(s.owner.username) + (where ? ' · ' + where : '')
      : (off ? 'Spento' : REACH[reach] ? REACH[reach].card : s.online ? 'Acceso, solo dalla sua rete' : 'Il tuo server') +
        (s.version ? ' · ' + esc(srvVersion(s.version)) : '');
    var edit = !friend && cache.cEdit;
    var card = srvCard({ act: edit ? 'clook' : !friend && off ? 'csrvoff' : 'cpick', arg: edit ? s.sid : i, key: 'csrv-' + s.sid + '-' + (friend ? s.owner.id : 0),
      name: s.name || 'PC', sub: sub, icon: friend ? FRIEND_ICON : SRV_ICON, off: off && !edit, on: C.sid === s.sid,
      first: i === 0, reach: reach, find: friend ? s.owner.username : '', look: s.look, edit: edit });
    if (friend) theirs.push(card);
    else if (s.machine && machines[s.machine] > 1) (groups[s.machine] = groups[s.machine] || []).push(card);
    else mine.push(card);
  });
  var same = Object.keys(groups).map(function (m) {
    return { title: 'Stessa macchina', cards: groups[m] };
  });
  // Un profilo bambini non aggiunge, non personalizza e non toglie server
  var kids = kidsNow();
  var addSrv = cache.cEdit || kids ? '' : '<button class="srv add f" data-act="cclaim" data-key="cclaim"><span class="srvart">' + PLUS_ICON + '</span>' +
    '<span class="srvtxt"><b>Aggiungi un server</b><small>Con il codice che compare sul server</small></span></button>';
  // Gli amici senza server nell'elenco: si vedono lo stesso (non condividono, o sono spenti)
  var friends = C.friends || [];
  friends.forEach(function (f) {
    if (f.status !== 'ok' || list.some(function (s) { return s.role === 'friend' && s.owner.id === f.id; })) return;
    theirs.push(srvCard({ act: 'cnoshare', arg: f.username, key: 'cfr-' + f.id, name: f.username,
      sub: 'Nessun server condiviso acceso', icon: FRIEND_ICON, off: true }));
  });
  var add = cache.cAdd
    ? '<div class="srvadd"><input class="field f" id="afname" data-key="afname" data-autofocus maxlength="32" autocapitalize="none" spellcheck="false" data-enter="caddsend" placeholder="Nome dell\'account del tuo amico">' +
      '<button class="btn primary f" data-act="caddsend" data-key="caddsend">Invia</button></div>'
    : '<button class="srv add f" data-act="cadd" data-key="cadd"><span class="srvart">' + PLUS_ICON + '</span><span class="srvtxt"><b>Aggiungi un amico</b><small>Con il nome del suo account</small></span></button>';
  var req = friends.filter(function (f) { return f.status === 'received'; }).map(function (f) {
    return '<div class="srvreq"><span><b>' + esc(f.username) + '</b> vuole essere tuo amico</span>' +
      '<button class="btn f" data-act="cdecline" data-arg="' + f.id + '" data-key="cdec-' + f.id + '">Rifiuta</button>' +
      '<button class="btn primary f" data-act="caccept" data-arg="' + f.id + '" data-key="cacc-' + f.id + '">Accetta</button></div>';
  }).join('');
  var sent = friends.filter(function (f) { return f.status === 'sent'; }).map(function (f) { return esc(f.username); });
  return { html: authShell('<h1>Cosa guardi oggi?</h1><p class="authsub">Scegli il server: i tuoi e quelli dei tuoi amici</p>' + reachLegend(kinds) +
    (C.error ? '<p class="authnote">' + esc(C.error) + '</p>' : '') + req +
    (list.length ? '' : '<p class="authnote">Nessun server nel tuo account. Installa BunkerPlex su un PC: lì compare un codice da scrivere qui in «Aggiungi un server».</p>') +
    srvGrid([{ title: 'I tuoi server', cards: mine, extra: addSrv,
      tool: !kids && (mine.length || same.length) ? '<button class="srvtool f" data-act="cedit" data-key="cedit">' + (cache.cEdit ? 'Fatto' : 'Personalizza') + '</button>' : '' }]
      .concat(same, [{ title: 'Amici', cards: cache.cEdit ? [] : theirs, extra: cache.cEdit ? '' : add }]),
      mine.length + theirs.length + same.reduce(function (n, g) { return n + g.cards.length; }, 0)) +
    (sent.length ? '<p class="authnote">In attesa di risposta: ' + sent.join(', ') + '</p>' : '') +
    '<div class="srvfoot"><button class="authlink f" data-act="crefresh" data-key="crefresh">Aggiorna l\'elenco</button>' +
    (C.profiles && C.profiles.length > 1 ? '<a class="authlink f" href="#/chi" data-key="cwho">Cambia profilo</a>' : '') + cAppLink() +
    '<a class="authlink f" href="#/sicurezza" data-key="csec">Sicurezza dell\'accesso</a>' +
    '<button class="authlink f" data-act="logout" data-key="clogout">Esci da ' + esc(C.user ? C.user.username : '') + '</button></div>', 'grid'), mount: srvMount };
}

// Le impostazioni dell'app (#/app), dall'accesso e dalla scelta del server: servono
// anche senza un server raggiungibile (fuori casa, server spento o vecchio, solo
// quello di un amico). La pagina arriva dal servizio account, come l'accesso.
function cAppLink() {
  return APP ? '<a class="authlink f" href="#/app" data-key="capp">Impostazioni dell\'app</a>' : '';
}

async function cAppPage() {
  // Solo l'app Android (APK) ha una versione da aggiornare: le pagine arrivano sempre nuove
  var app = appUpdatePanel({});
  var notes = '';
  if (PHONE_APP) {
    if (!C.token) {
      notes = '<div class="panel"><h2>Notifiche</h2><p>Entra con il tuo account per attivare e gestire le notifiche.</p>' +
        '<div class="actions"><a class="btn f" href="#/home" data-key="capplogin">Entra</a></div></div>';
    } else {
      try { notes = '<h2 class="capph">Notifiche</h2>' + noticesPanels(await noticesData(), false); } catch (e) { notes = noticesError(e); }
    }
  }
  return authShell('<a class="authlink f" href="#/home" data-act="cappback" data-key="cappback" data-autofocus>‹ Indietro</a>' +
    '<h1>Impostazioni dell\'app</h1><p class="authsub">Valgono solo su ' + (TV ? 'questa TV' : 'questo dispositivo') +
    ', anche senza entrare in un server. Quelle di un server (raccolte, amici, aggiornamenti del server) stanno nelle sue Impostazioni.</p>' + app + notes, true);
}

// Nell'app Android senza servizio account (niente Internet): la ricerca del server
// sulla rete di casa, con l'indirizzo da scrivere solo se non lo trova
function cOffline() {
  if (APP && tvApp.resetServer && !cOffline.done) { cOffline.done = true; tvApp.resetServer(); }
}

// ---- La TV entra dal telefono
// La TV mostra un QR (#/tv/<codice>) e il codice da scrivere a mano (#/tv). Il codice
// resta da parte mentre qui si entra con l'account (password, Google, link...), poi
// si conferma: la TV riceve il gettone dal servizio (vedi /tv/start nel Worker).
function cTvPending() {
  try { return sessionStorage.getItem('bpTvCode'); } catch (e) { return cache.cTvCode === undefined ? null : cache.cTvCode; }
}

function cTvSet(code) {
  // La TV lo dice subito: «Codice aperto sul telefono» (dal QR o scritto a mano)
  if (code && code !== cache.cTvCode) fetch('/tv/' + code + '/seen', { method: 'POST' }).catch(function () { /* niente */ });
  cache.cTvCode = code;
  try {
    if (code === null) sessionStorage.removeItem('bpTvCode'); else sessionStorage.setItem('bpTvCode', code);
  } catch (e) { /* resta in cache */ }
}

function cTvClean(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

async function cTvPage(code) {
  var who = C.user ? C.user.username : '';
  var cancel = '<button class="authlink f" data-act="ctvclose" data-key="ctvclose">Annulla</button>';
  if (cache.cTvDone) {
    return authShell('<div class="authico">' + SRV_ICON + '</div><h1>Fatto</h1>' +
      '<p class="authsub"><b>' + esc(cache.cTvDone) + '</b> sta entrando come <b>' + esc(who) + '</b>. Lì scegli il server e chi guarda.</p>' +
      '<button class="btn primary block f" data-autofocus data-act="ctvclose" data-key="ctvclose">Apri BunkerPlex qui</button>');
  }
  var err = '';
  if (code) {
    try {
      var r = await cloud('GET', '/tv/' + code);
      if (r.done) { cache.cTvDone = r.device; return cTvPage(code); }
      return authShell('<div class="authico">' + SRV_ICON + '</div><h1>Collega la TV</h1>' +
        '<p class="authsub">Codice <b class="num">' + esc(code.slice(0, 4) + '-' + code.slice(4)) + '</b> · ' + esc(r.device) + '</p>' +
        '<p class="authsub">La TV entra con il tuo account, <b>' + esc(who) + '</b>. Se il codice non è quello che vedi sulla TV, annulla.</p>' +
        '<button class="btn primary block f" data-autofocus data-act="ctvok" data-arg="' + esc(code) + '" data-key="ctvok">Collega come ' + esc(who) + '</button>' +
        '<button class="authlink f" data-act="ctvother" data-key="ctvother">Usa un altro account</button>' + cancel);
    } catch (e) { err = e.message; }
  }
  return authShell('<h1>Collega una TV</h1><p class="authsub">Scrivi il codice che vedi sulla TV</p>' +
    '<input class="field f num" id="ctvcode" data-key="ctvcode" data-autofocus maxlength="9" autocapitalize="characters" autocomplete="off" spellcheck="false" data-enter="ctvgo" placeholder="XXXX-XXXX">' +
    '<button class="btn primary block f" data-act="ctvgo" data-key="ctvgo">Continua</button>' +
    (err ? '<p class="authnote">' + esc(err) + '</p>' : '') +
    // Le TV senza l'app (Samsung, LG...): BunkerPlex si apre nel loro browser, da qui
    '<p class="authsub">TV Samsung, LG o altre? Niente da installare: sulla TV apri il browser (<b>Internet</b> sulle Samsung), ' +
      'vai su <b class="num">' + esc(location.host) + '</b> e aggiungilo ai preferiti. Il codice compare lì.</p>' + cancel);
}

// Il browser di una smart TV (Samsung, LG...) nella PWA centrale: come l'app TV, la TV
// chiede un codice al servizio (/tv/start) e lo si conferma dal telefono (#/tv/<codice>);
// intanto la TV domanda se e' fatto (/tv/poll) e riceve il gettone dell'account.
function smartTvName() {
  var ua = navigator.userAgent;
  return TV ? 'TV Android' : /Tizen/i.test(ua) ? 'TV Samsung' : /Web0S|webOS|NetCast/i.test(ua) ? 'TV LG' : /VIDAA/i.test(ua) ? 'TV Hisense' : 'Smart TV';
}

// La riga di stato della TV: in attesa, codice aperto sul telefono ('ok'), rete assente ('net')
function cTvStatus(kind) {
  var el = document.getElementById('gstatus');
  if (!el) return;
  el.className = 'gstatus' + (kind === 'ok' ? ' ok' : kind === 'net' ? ' warn' : '');
  el.lastChild.textContent = kind === 'ok' ? 'Codice aperto sul telefono: entra lì e la TV entra da sola'
    : kind === 'net' ? 'Rete assente: riprovo…' : 'In attesa del telefono…';
}

async function cTvLoginPage() {
  var t = cache.cTvLogin;
  if (!t || Date.now() - t.at > (t.ttl - 60) * 1000) {
    t = await cloud('POST', '/tv/start', { device: smartTvName() });
    t.at = Date.now();
    cache.cTvLogin = t;
  }
  clearInterval(cache.cTvTimer);
  cache.cTvTimer = setInterval(function () {
    if (C.token || cache.cTvLogin !== t) { clearInterval(cache.cTvTimer); return; }
    // Scaduto: un codice nuovo prima che la TV ne mostri uno che non vale piu'
    if (Date.now() - t.at > (t.ttl - 60) * 1000) { clearInterval(cache.cTvTimer); cache.cTvLogin = null; render(); return; }
    cloud('POST', '/tv/poll', { poll: t.poll }).then(function (r) {
      if (cache.cTvLogin !== t) return;
      if (!r.done) { cTvStatus(r.seen ? 'ok' : ''); return; }
      clearInterval(cache.cTvTimer);
      cache.cTvLogin = null;
      cEntered(r);
      toast('Entrato come ' + r.user.username);
      location.replace('#/home');
      render();
    }, function (e) {
      if (cache.cTvLogin !== t) return;
      if (!e.status) { cTvStatus('net'); return; }           // rete: il codice resta buono, si riprova
      clearInterval(cache.cTvTimer); cache.cTvLogin = null; render();   // scaduto: codice nuovo
    });
  }, 2500);
  var site = t.short.replace(/^https?:\/\//, '');
  if (!t.svg) { try { t.svg = qrSvgRows(qrRows(t.url)); } catch (e) { t.svg = ''; } }
  return '<div class="auth"><div class="tvlink">' +
    '<div class="authbrand">' + LOGO + '<span><b>Bunker</b>Plex</span></div>' +
    '<h1>Collega questa TV</h1><p class="authsub">Accedi una volta dal telefono: la TV entra da sola e la prossima volta si apre già pronta.</p>' +
    '<div class="gstatus" id="gstatus"><i></i><span>In attesa del telefono…</span></div>' +
    '<div class="tvcols">' +
      (t.svg ? '<div class="tvcol"><div class="qrtile big" role="img" aria-label="Codice QR per collegare la TV">' + t.svg + '</div>' +
        '<b>Inquadra il QR</b><small>con la fotocamera del telefono: si apre BunkerPlex, entri e la TV è collegata</small></div>' +
        '<div class="tvor"><span>oppure</span></div>' : '') +
      '<div class="tvcol"><small class="tvstep">Sul telefono apri <span class="num">' + esc(site) + '</span><br>' +
        '(o nell\'app BunkerPlex: <b>Impostazioni → Collega una TV</b>) e scrivi</small>' +
      '<div class="tvcode num">' + esc(t.code.slice(0, 4)) + '<i></i>' + esc(t.code.slice(4)) + '</div>' +
      '<small>Il codice cambia da solo ogni 10 minuti</small></div></div>' +
    // Sulla TV si entra solo dal telefono: niente email, password o Google col telecomando
    (APP ? '<div class="tvmore"><a class="btn f" href="#/app" data-key="capp">Impostazioni dell\'app</a></div>' : '') +
    (C.error ? '<p class="authnote">' + esc(C.error) + '</p>' : '') +
    '</div></div>';
}

// Prima di ogni pagina, nella PWA centrale: account, poi server, poi come sempre
async function cGate() {
  if (APP && !cGate.probed) {
    cGate.probed = true;
    fetch('/', { headers: { Accept: 'application/json' }, cache: 'no-store' }).catch(cOffline);
  }
  var tvm = /^#\/tv(?:\/([A-Za-z0-9-]{1,12}))?$/.exec(location.hash);
  if (tvm) {
    cTvSet(cTvClean(tvm[1]));
    cache.cTvDone = null;
    location.replace('#/home');
  }
  await cMailLink();
  if (APP && location.hash === '#/app') { lockScreen(true); return cAppPage(); }
  if (!C.token) {
    lockScreen(true);
    if (cgLoad()) return cGooglePage(cache.cg);
    if (cache.c2fa) return c2faPage();
    if (location.hash.indexOf('#/reset') === 0) return cResetPage();
    return TVLOGIN ? cTvLoginPage() : cLoginPage();
  }
  if (C.user && C.user.must_change) { lockScreen(true); return C.user.google && C.user.needs_name ? cNamePage() : cPasswordPage(); }
  var tv = cTvPending();
  if (tv !== null) { lockScreen(true); return cTvPage(tv); }
  if (location.hash === '#/passkey' || location.hash === '#/sicurezza') { lockScreen(true); return secPage(); }
  if (await pkShouldOffer()) { lockScreen(true); return pkOfferPage(); }
  // «Chi guarda?» subito dopo l'accesso, con i profili dell'account (come Netflix), poi il server
  await cProfiles(false);
  if (C.profiles) {
    if (location.hash === '#/profili' || location.hash === '#/chi') {
      if (kidsNow() && location.hash === '#/profili') { location.replace('#/chi'); return '<div class="page"></div>'; }
      lockScreen(true);
      return location.hash === '#/profili' ? profilesManagePage() : whoPage();
    }
    if (cNeedWho()) { lockScreen(true); return whoPage(); }
  }
  if (location.hash === '#/server') {
    cDrop();
    C.sid = '';
    cSave();
    location.replace('#/home');
  }
  if (!C.base) await cResume();
  if (!C.base) { lockScreen(true); return cServersPage(); }
  return null;
}

// Personalizza un tuo server: un'icona tra poche, o un'immagine (dal telefono o dal PC)
function cLookSheet(sid) {
  var s = (C.list || []).filter(function (x) { return x.sid === sid && x.role === 'owner'; })[0];
  if (!s) return;
  var look = s.look || {};
  modalState = { options: [], onPick: function () {}, returnFocus: document.activeElement };
  modal.innerHTML = '<div class="sheet srvlook"><h3>' + esc(s.name || 'PC') + '</h3>' +
    '<p class="secretnote">Come lo vedete tu e i tuoi amici quando scegliete il server.</p>' +
    '<div class="lookicons">' +
      '<button class="lookico f' + (!look.icon && !look.image ? ' on' : '') + '" data-act="clookset" data-arg="' + sid + ':" data-key="lk-none"><b>' +
        esc((String(s.name || '?').trim()[0] || '?').toUpperCase()) + '</b></button>' +
      Object.keys(SRV_LOOK_ICONS).map(function (k) {
        return '<button class="lookico f' + (look.icon === k && !look.image ? ' on' : '') + '" data-act="clookset" data-arg="' + sid + ':' + k + '" data-key="lk-' + k + '">' + srvLookIcon(k) + '</button>';
      }).join('') + '</div>' +
    '<div class="actions">' + (TVLOOK ? '' : '<button class="btn primary f" data-act="clookimg" data-arg="' + sid + '" data-key="lk-img">' + (look.image ? 'Cambia immagine' : 'Usa un\'immagine') + '</button>') +
      (look.image ? '<button class="btn f" data-act="clookset" data-arg="' + sid + ':' + (look.icon || '') + ':noimg" data-key="lk-noimg">Togli l\'immagine</button>' : '') +
      '<button class="btn f" data-act="closemodal" data-key="lk-done">Fatto</button></div></div>';
  modal.hidden = false;
  var first = modal.querySelector('.lookico.on') || modal.querySelector('.f');
  if (first) first.focus();
}

async function cLookSave(sid, patch) {
  var r = await cloud('PUT', '/servers/' + sid + '/look', patch);
  (C.list || []).forEach(function (x) { if (x.sid === sid) x.look = r.look; });
  lastHtml = '';
  closeModal(true);
  await render();
  cLookSheet(sid);
}

// L'immagine scelta: si sceglie la parte da vedere (cCropImage), poi 480x270 in JPEG: pochi KB
function cPickImage() {
  return new Promise(function (ok, ko) {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = function () {
      var file = input.files && input.files[0];
      if (!file) { ko(new Error('Nessuna immagine')); return; }
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        cCropImage(img).then(function (data) { URL.revokeObjectURL(url); ok(data); },
          function (e) { URL.revokeObjectURL(url); ko(e); });
      };
      img.onerror = function () { URL.revokeObjectURL(url); ko(new Error('Questo file non è un\'immagine')); };
      img.src = url;
    };
    input.click();
  });
}

// Ritaglio: la cornice e' 16:9 come le schede dei server. L'immagine si sposta col dito
// o col mouse e si ingrandisce col pizzico, la rotella o il cursore (da tastiera: frecce,
// + e -). Lo stato e' il punto dell'immagine al centro della cornice (cx, cy, da 0 a 1)
// e l'ingrandimento z: 1 = l'immagine copre appena la cornice.
function cCropImage(img) {
  return new Promise(function (ok, ko) {
    var OUT_W = 480, OUT_H = 270, ZMAX = 4;
    var iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    var cx = 0.5, cy = 0.5, z = 1, done = false, dragAt = 0;
    var back = modalState && modalState.returnFocus;
    modalState = { options: [], onPick: function () {}, returnFocus: back || document.activeElement };
    modal.innerHTML = '<div class="sheet cropsheet"><h3>Scegli la parte da vedere</h3>' +
      '<p class="secretnote">Trascina per spostare l\'immagine; per ingrandire pizzica, usa la rotella o il cursore.</p>' +
      '<div class="cropbox f" tabindex="0" data-key="crop-box" aria-label="Immagine: frecce per spostare, + e - per ingrandire"></div>' +
      '<input class="cropzoom f" type="range" min="1" max="' + ZMAX + '" step="0.05" value="1" data-key="crop-zoom" aria-label="Ingrandimento">' +
      '<div class="actions"><button class="btn primary f" data-key="crop-ok">Usa questa parte</button>' +
      '<button class="btn f" data-key="crop-no">Annulla</button></div></div>';
    modal.hidden = false;
    var box = modal.querySelector('.cropbox');
    var range = modal.querySelector('.cropzoom');
    var pic = document.createElement('img');
    pic.src = img.src;
    pic.alt = '';
    pic.draggable = false;
    box.appendChild(pic);

    // Misure attuali: cornice (W, H) e immagine a schermo (dw, dh, left, top)
    function frame() {
      var W = box.clientWidth, H = box.clientHeight;
      var s = Math.max(W / iw, H / ih) * z, dw = iw * s, dh = ih * s;
      // Mai un bordo vuoto: il centro resta dove l'immagine copre tutta la cornice
      var hx = W / 2 / dw, hy = H / 2 / dh;
      cx = Math.min(Math.max(cx, hx), 1 - hx);
      cy = Math.min(Math.max(cy, hy), 1 - hy);
      return { W: W, H: H, dw: dw, dh: dh, left: W / 2 - cx * dw, top: H / 2 - cy * dh };
    }
    function draw() {
      if (done) return;
      var f = frame();
      pic.style.width = f.dw + 'px';
      pic.style.height = f.dh + 'px';
      pic.style.transform = 'translate(' + f.left + 'px,' + f.top + 'px)';
      range.value = z;
    }
    function pan(dx, dy) {
      var f = frame();
      cx -= dx / f.dw;
      cy -= dy / f.dh;
      draw();
    }
    // Ingrandisce tenendo fermo il punto (px, py) della cornice (di base il centro)
    function zoomAt(nz, px, py) {
      var f = frame();
      if (px === undefined) { px = f.W / 2; py = f.H / 2; }
      var u = cx + (px - f.W / 2) / f.dw, v = cy + (py - f.H / 2) / f.dh;
      z = Math.min(Math.max(nz, 1), ZMAX);
      var g = frame();
      cx = u - (px - g.W / 2) / g.dw;
      cy = v - (py - g.H / 2) / g.dh;
      draw();
    }

    // Dito o mouse: uno sposta, due ingrandiscono (e spostano col punto di mezzo)
    var pts = {};
    function at(e) { var r = box.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
    function pair() {
      var k = Object.keys(pts);
      if (k.length < 2) return null;
      var a = pts[k[0]], b = pts[k[1]];
      return { d: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
    box.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      box.focus();
      try { box.setPointerCapture(e.pointerId); } catch (x) { /* niente */ }
      pts[e.pointerId] = at(e);
    });
    box.addEventListener('pointermove', function (e) {
      var old = pts[e.pointerId];
      if (!old) return;
      var before = pair();
      pts[e.pointerId] = at(e);
      var now = pair();
      dragAt = Date.now();
      if (before && now) {
        if (before.d > 0) zoomAt(z * now.d / before.d, now.x, now.y);
        pan(now.x - before.x, now.y - before.y);
      } else if (!before) {
        pan(pts[e.pointerId].x - old.x, pts[e.pointerId].y - old.y);
      }
    });
    function lift(e) { delete pts[e.pointerId]; }
    box.addEventListener('pointerup', lift);
    box.addEventListener('pointercancel', lift);
    box.addEventListener('wheel', function (e) {
      e.preventDefault();
      var p = at(e);
      zoomAt(z * Math.exp(-e.deltaY * 0.0015), p.x, p.y);
    }, { passive: false });
    range.addEventListener('input', function () { zoomAt(parseFloat(range.value)); });
    // Le frecce sul cursore lo muovono (non spostano il fuoco)
    range.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') e.stopPropagation();
    });
    box.addEventListener('keydown', function (e) {
      var step = box.clientWidth * 0.05;
      var k = e.key;
      if (k === 'ArrowLeft') pan(step, 0);
      else if (k === 'ArrowRight') pan(-step, 0);
      else if (k === 'ArrowUp') pan(0, step);
      else if (k === 'ArrowDown') pan(0, -step);
      else if (k === '+' || k === '=') zoomAt(z * 1.15);
      else if (k === '-' || k === '_') zoomAt(z / 1.15);
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
    // Un trascinamento finito fuori dalla finestra non la chiude
    function guard(e) { if (e.target === modal && Date.now() - dragAt < 400) e.stopPropagation(); }
    modal.addEventListener('click', guard, true);
    window.addEventListener('resize', draw);

    function finish() {
      done = true;
      window.removeEventListener('resize', draw);
      modal.removeEventListener('click', guard, true);
    }
    modal.querySelector('[data-key="crop-ok"]').addEventListener('click', function () {
      var f = frame(), k = OUT_W / f.W;
      var c = document.createElement('canvas');
      c.width = OUT_W; c.height = OUT_H;
      var ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, f.left * k, f.top * k, f.dw * k, f.dh * k);
      finish();
      closeModal(true);
      ok(c.toDataURL('image/jpeg', 0.82));
    });
    modal.querySelector('[data-key="crop-no"]').addEventListener('click', function () {
      finish();
      closeModal(true);
      ko(new Error('Nessuna immagine'));
    });
    draw();
    box.focus();
  });
}

// «1.2» → «versione 1.2»
function srvVersion(v) {
  v = String(v || '');
  return /^\d/.test(v) ? 'versione ' + v : v;
}

// Un tuo server spento: com'era, chi c'e' sulla stessa macchina, provarlo o toglierlo dall'elenco
function cOffSheet(idx) {
  var s = (C.list || [])[Number(idx)];
  if (!s) return;
  var twins = s.machine ? (C.list || []).filter(function (x) { return x !== s && x.role === 'owner' && x.machine === s.machine; }) : [];
  modalState = { options: [], onPick: function () {}, returnFocus: document.activeElement };
  modal.innerHTML = '<div class="sheet srvlook claimsheet"><h3>' + esc(s.name || 'PC') + '</h3>' +
    '<p class="secretnote">Spento o non raggiungibile' + (s.seen ? ' · visto ' + esc(ago(s.seen)) : '') +
      (s.version ? ' · ' + esc(srvVersion(s.version)) : '') + '.</p>' +
    (twins.length ? '<p class="secretnote">Sulla stessa macchina: ' + twins.map(function (t) {
      return '<b>' + esc(t.name || 'PC') + '</b> (' + (t.online === false ? 'spento' : 'acceso') + ')';
    }).join(', ') + '. Se l\'hai reinstallato, questo è quello di prima: puoi toglierlo.</p>' : '') +
    '<div class="actions"><button class="btn f" data-act="cpick" data-arg="' + esc(idx) + '" data-key="off-try">Prova a collegarti</button>' +
      (kidsNow() ? '' : '<button class="btn danger f" data-act="cforget" data-arg="' + esc(s.sid) + '" data-key="off-forget">Togli dall\'elenco</button>') +
      '<button class="btn f" data-act="closemodal" data-key="off-close">Chiudi</button></div></div>';
  modal.hidden = false;
  var first = modal.querySelector('.f');
  if (first) first.focus();
}

// Server nuovo da aggiungere con il codice (come plex.tv/claim): codice, poi anteprima,
// nome e (se sulla stessa macchina c'e' un tuo server spento) sostituirlo o tenerlo
function cClaimSheet() {
  var st = cache.cClaim || (cache.cClaim = {});
  var info = st.info;
  var body;
  if (!info) {
    body = '<p class="secretnote">Sul PC con BunkerPlex appena installato compare un codice di 8 caratteri ' +
      '(nella pagina di accesso e in Impostazioni → Account). Scrivilo qui: il server entra nel tuo account.</p>' +
      '<input class="field f num claimcode" id="clcode" data-key="clcode" maxlength="9" autocapitalize="characters" autocomplete="off" spellcheck="false" data-enter="cclaimcheck" placeholder="ABCD2345" value="' + esc(st.code || '') + '">' +
      '<div class="actions"><button class="btn primary f" data-act="cclaimcheck" data-key="clcheck">Continua</button>' +
      '<button class="btn f" data-act="closemodal" data-key="clclose">Annulla</button></div>';
  } else if (info.taken || info.mine) {
    body = '<p class="secretnote">' + (info.taken ? 'Questo server è già collegato a un altro account: lo può aggiungere solo il suo proprietario.'
      : '«' + esc(info.name || 'PC') + '» è già tra i tuoi server.') + '</p>' +
      '<div class="actions"><button class="btn f" data-act="closemodal" data-key="clclose">Chiudi</button></div>';
  } else {
    body = '<p class="secretnote">Codice <b class="num">' + esc(info.code) + '</b>' + (info.version ? ' · ' + esc(srvVersion(info.version)) : '') + '</p>' +
      '<label class="flabel" for="clname">Nome del server</label>' +
      '<input class="field f" id="clname" data-key="clname" maxlength="40" autocomplete="off" data-enter="cclaimgo" value="' + esc(st.name) + '">' +
      sameMachineHtml(info.same_machine || [], st.replace, 'cclaimpick') +
      '<div class="actions"><button class="btn primary f" data-act="cclaimgo" data-key="clgo">' + (st.replace ? 'Sostituisci' : 'Aggiungi') + '</button>' +
      '<button class="btn f" data-act="closemodal" data-key="clclose">Annulla</button></div>';
  }
  modalState = { options: [], onPick: function () {}, returnFocus: modalState && modalState.returnFocus || document.activeElement };
  modal.innerHTML = '<div class="sheet srvlook claimsheet"><h3>Aggiungi un server</h3>' + body + '</div>';
  modal.hidden = false;
  var first = modal.querySelector('.f');
  if (first) first.focus();
}

// ---- PWA centrale: «Continua con Google» e passkey (impronta, volto, PIN del dispositivo)

// «Continua con Google» qui: Google in una finestra nuova (o in questa, se il browser
// blocca le finestre: al ritorno si riprende da sessionStorage). Intanto una pagina
// d'attesa dice cosa succede, con «Riapri Google» e «Annulla».
function cgLoad() {
  if (cache.cg !== undefined) return cache.cg;
  cache.cg = null;
  try {
    var s = JSON.parse(sessionStorage.getItem('bp-cg') || 'null');
    if (s && Date.now() - s.at < (s.ttl - 30) * 1000) { cache.cg = s; setTimeout(cgPoll, 500); }
  } catch (e) { /* niente */ }
  return cache.cg;
}

function cgSet(g) {
  cache.cg = g;
  try { if (g) sessionStorage.setItem('bp-cg', JSON.stringify(g)); else sessionStorage.removeItem('bp-cg'); } catch (e) { /* niente */ }
}

function cgPoll() {
  var g = cache.cg;
  if (!g || g.polling) return;
  g.polling = true;
  var step = function () {
    if (cache.cg !== g) return;
    if (Date.now() - g.at > (g.ttl - 30) * 1000) { cgSet(null); C.error = 'Tempo scaduto: riprova «Continua con Google»'; render(); return; }
    cloud('POST', '/google/poll', { poll: g.poll }).then(function (p) {
      if (cache.cg !== g) return;
      if (p.done && p.token) {
        cgSet(null);
        cEntered(p, true);
        cache.cLogin = null;
        location.replace('#/home');
        render();
        return;
      }
      if (p.seen !== g.seen || (p.note || '') !== (g.note || '')) {
        g.seen = p.seen; g.note = p.note || '';
        cgStatus(g);
      }
      setTimeout(step, 2000);
    }, function (e) {
      if (cache.cg !== g) return;
      if (!e.status) { setTimeout(step, 4000); return; }   // rete: si riprova
      cgSet(null);
      C.error = e.message;
      render();
    });
  };
  setTimeout(step, 1500);
}

function cgStatus(g) {
  var el = document.getElementById('gstatus');
  if (!el) return;
  var kind = g.note ? 'warn' : g.seen ? 'ok' : '';
  el.className = 'gstatus' + (kind ? ' ' + kind : '');
  el.lastChild.textContent = g.note ? 'Non riuscito: ' + g.note
    : g.seen ? 'Scegli il tuo account nella finestra di Google' : 'Apro Google…';
}

function cGooglePage(g) {
  setTimeout(function () { cgStatus(g); }, 0);
  return authShell('<h1>Continua con Google</h1>' +
    '<p class="authsub">Scegli il tuo account nella finestra di Google: qui entri da solo</p>' +
    '<div class="gstatus" id="gstatus"><i></i><span></span></div>' +
    '<button class="gbtn f" data-autofocus data-act="cgreopen" data-key="cgreopen">' + GOOGLE_G + '<span>Riapri Google</span></button>' +
    '<button class="authlink f" data-act="cgcancel" data-key="cgcancel">Annulla</button>');
}

// ---- Passkey (WebAuthn). Valgono solo qui (l'indirizzo del servizio account).

function b64uEnc(buf) {
  var s = '', b = new Uint8Array(buf);
  for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64uDec(str) {
  var s = atob(String(str).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(str).length + 3) % 4));
  var b = new Uint8Array(s.length);
  for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b.buffer;
}

function pkOn() { return CENTRAL && !TV && !BROWSER_TV && !!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.create); }

function pkLocal(k, v) {
  try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { /* niente */ }
  return null;
}

// Il nome della passkey nell'elenco: il dispositivo e il browser, in breve
function pkLabel() {
  var ua = navigator.userAgent || '';
  var dev = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iPad'
    : /Android/.test(ua) ? 'Android' : /Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'Chromebook' : /Linux/.test(ua) ? 'Linux' : 'Dispositivo';
  var br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return dev + (br ? ' · ' + br : '');
}

function pkIcon() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 11v3a8 8 0 0 1-1.2 4.2M8.2 6.9A6 6 0 0 1 18 11v1.5M6 11a6 6 0 0 1 .4-2.2M6 14.5c0 1.6-.4 3-1 4.3M15 15.5a12 12 0 0 1-1 4.5M9 11a3 3 0 0 1 6 0v1.5"/></svg>';
}

// Una passkey nuova per l'account entrato (il dispositivo chiede impronta, volto o PIN)
async function pkCreate() {
  var o = await cloud('POST', '/passkeys/register/start', {});
  var cred = await navigator.credentials.create({ publicKey: {
    challenge: b64uDec(o.challenge), rp: o.rp,
    user: { id: b64uDec(o.user.id), name: o.user.name, displayName: o.user.displayName },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
    excludeCredentials: (o.exclude || []).map(function (id) { return { type: 'public-key', id: b64uDec(id) }; }),
    timeout: o.timeout, attestation: 'none'
  } });
  await cloud('POST', '/passkeys/register/finish', { id: cred.id, label: pkLabel(),
    clientDataJSON: b64uEnc(cred.response.clientDataJSON), attestationObject: b64uEnc(cred.response.attestationObject) });
  pkLocal('bp-pk', '1');
}

// Entrare con una passkey. conditional: proposta dal campo email (riempimento automatico)
async function pkLogin(conditional) {
  if (cache.pkAbort) { try { cache.pkAbort.abort(); } catch (e) { /* niente */ } }
  var o = await cloud('POST', '/passkeys/login/start', {});
  var opts = { publicKey: { challenge: b64uDec(o.challenge), rpId: o.rpId, userVerification: 'required', timeout: o.timeout } };
  if (window.AbortController) { cache.pkAbort = new AbortController(); opts.signal = cache.pkAbort.signal; }
  if (conditional) opts.mediation = 'conditional';
  var a = await navigator.credentials.get(opts);
  cache.pkAbort = null;
  if (!a) return;
  var r = await cloud('POST', '/passkeys/login/finish', { id: a.id, device: pkLabel(), kind: 'pwa',
    clientDataJSON: b64uEnc(a.response.clientDataJSON), authenticatorData: b64uEnc(a.response.authenticatorData),
    signature: b64uEnc(a.response.signature) });
  pkLocal('bp-pk', '1');
  cEntered(r, false);
  cache.cLogin = null;
  location.replace('#/home');
  render();
}

// La passkey proposta dal campo email, quando il browser lo sa fare (una sola richiesta per volta)
function pkConditional() {
  if (!pkOn() || cache.pkCond || !PublicKeyCredential.isConditionalMediationAvailable) return;
  cache.pkCond = true;
  PublicKeyCredential.isConditionalMediationAvailable().then(function (ok) {
    if (!ok || C.token) { cache.pkCond = false; return; }
    pkLogin(true).catch(function (e) {
      if (e && e.name !== 'AbortError' && e.name !== 'NotAllowedError' && e.message) authErr(e.message);
    }).then(function () { cache.pkCond = false; });
  }, function () { cache.pkCond = false; });
}

// Dopo l'accesso con password, Google o link: «La prossima volta entra con impronta o volto?»
// (una volta, se il dispositivo ha impronta, volto o PIN e qui non c'e' gia' una passkey)
async function pkShouldOffer() {
  if (!cache.pkOffer || !pkOn() || pkLocal('bp-pk') || pkLocal('bp-pk-no')) return false;
  try {
    return !!(PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable &&
      await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
  } catch (e) { return false; }
}

function pkOfferPage() {
  return authShell('<div class="authico">' + pkIcon() + '</div><h1>Entra più in fretta</h1>' +
    '<p class="authsub">La prossima volta su questo dispositivo entri con impronta, volto o PIN, senza password.</p>' +
    '<button class="btn primary block f" data-autofocus data-act="pkadd" data-arg="offer" data-key="pkadd">Attiva</button>' +
    '<button class="authlink f" data-act="pkskip" data-key="pkskip">Non ora</button>');
}

function cPkActions() {
  return {
    pklogin: function () {
      return pkLogin(false).catch(function (e) {
        if (e && (e.name === 'NotAllowedError' || e.name === 'AbortError')) {
          authErr('Nessuna passkey scelta. Entra con email e password: poi puoi attivare impronta o volto.');
        } else authErr((e && e.message) || 'Accesso non riuscito');
      });
    },
    pkadd: function (arg) {
      return pkCreate().then(function () {
        toast('Fatto: la prossima volta entri con impronta o volto');
        cache.pkOffer = false;
        render();
      }, function (e) {
        if (e && e.name === 'InvalidStateError') {     // gia' una passkey di questo account qui
          pkLocal('bp-pk', '1');
          cache.pkOffer = false;
          toast('Su questo dispositivo c\'è già');
          render();
          return;
        }
        if (e && (e.name === 'NotAllowedError' || e.name === 'AbortError')) return;   // annullato
        authErr((e && e.message) || 'Non riuscito');
      });
    },
    pkskip: function () {
      pkLocal('bp-pk-no', String(Date.now()));
      cache.pkOffer = false;
      render();
    },
    cgreopen: function () {
      var g = cache.cg;
      if (!g) return;
      var w = window.open(g.url, '_blank');
      if (!w) location.href = g.url;
    },
    c2fago: async function () {
      var f = cache.c2fa, code = fieldValue('tfacode').trim();
      if (!f) return;
      if (!code) { authErr('Scrivi il codice dell\'app'); return; }
      try {
        var r = await cloud('POST', '/login/2fa', { ticket: f.ticket, code: code, device: pkLabel(), kind: 'pwa', remember: rememberChecked() });
        cache.c2fa = null;
        trustSave([f.user].concat(f.names || []), r.trust);
        cEntered(r, f.offer);
        cache.cLogin = null;
        location.replace('#/home');
        render();
      } catch (e) {
        if (!/sbagliato/i.test(e.message)) { cache.c2fa = null; C.error = e.message; render(); return; }
        authErr(e.message);
        var el = byKey('tfacode');
        if (el) { el.value = ''; el.focus(); }
      }
    },
    c2facancel: function () { cache.c2fa = null; C.error = ''; render(); },
    cgcancel: function () {
      cgSet(null);
      render();
    }
  };
}

// ---- Sicurezza dell'accesso (Impostazioni → Account): passkey e verifica in due passaggi
//
// Vale nella PWA del servizio account (le passkey sono di quell'indirizzo). Ogni modifica
// passa da «Conferma che sei tu» (password, passkey o codice dell'app) se la sessione non
// l'ha fatto da poco: lo decide il servizio (risposta {reauth}). Togliere una passkey si
// conferma con un codice via email; aggiunte e tolte arrivano anche via email.

// QR (ISO 18004) per l'app di autenticazione: byte, correzione M, versioni 1-10.
// Le righe di 0 e 1 (senza bordo), come il campo "qr" del server.
function qrRows(text, forceVersion, forceMask) {
  var data = Array.prototype.slice.call(new TextEncoder().encode(text));
  // [data codewords per blocco...] e codewords di correzione per blocco, livello M
  var BLOCKS = [null, [[16], 10], [[28], 16], [[44], 26], [[32, 32], 18], [[43, 43], 24], [[27, 27, 27, 27], 16],
    [[31, 31, 31, 31], 18], [[38, 38, 39, 39], 22], [[36, 36, 36, 37, 37], 22], [[43, 43, 43, 43, 44], 26]];
  var ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
  var ver = 0;
  for (var v = 1; v <= 10; v++) {
    var cap = BLOCKS[v][0].reduce(function (a, b) { return a + b; }, 0);
    if (4 + (v < 10 ? 8 : 16) + data.length * 8 <= cap * 8) { ver = v; break; }
  }
  if (forceVersion) ver = forceVersion;
  if (!ver) return [];
  var blocks = BLOCKS[ver][0], ecLen = BLOCKS[ver][1];
  var capBytes = blocks.reduce(function (a, b) { return a + b; }, 0);
  // Bit dei dati: modo byte, lunghezza, dati, terminatore, riempitivo
  var bits = [];
  var put = function (val, n) { for (var i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(4, 4);
  put(data.length, ver < 10 ? 8 : 16);
  data.forEach(function (b) { put(b, 8); });
  put(0, Math.min(4, capBytes * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  var words = [];
  for (var i = 0; i < bits.length; i += 8) words.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (var pad = 0; words.length < capBytes; pad++) words.push(pad % 2 ? 0x11 : 0xEC);
  // Reed-Solomon su GF(256) (polinomio 0x11D)
  var EXP = [], LOG = [];
  for (var e = 0, x = 1; e < 255; e++) { EXP[e] = x; LOG[x] = e; x <<= 1; if (x & 256) x ^= 0x11D; }
  var mul = function (a, b) { return a && b ? EXP[(LOG[a] + LOG[b]) % 255] : 0; };
  var gen = [1];
  for (var d = 0; d < ecLen; d++) {
    var next = new Array(gen.length + 1).fill(0);
    for (var j = 0; j < gen.length; j++) { next[j] ^= gen[j]; next[j + 1] ^= mul(gen[j], EXP[d]); }
    gen = next;
  }
  var dataBlocks = [], ecBlocks = [], off = 0;
  blocks.forEach(function (n) {
    var blk = words.slice(off, off + n);
    off += n;
    var rem = new Array(ecLen).fill(0);
    blk.forEach(function (w) {
      var f = w ^ rem[0];
      rem.shift(); rem.push(0);
      for (var k = 0; k < ecLen; k++) rem[k] ^= mul(gen[k + 1], f);
    });
    dataBlocks.push(blk);
    ecBlocks.push(rem);
  });
  // Intreccio dei blocchi
  var all = [], maxLen = Math.max.apply(null, blocks);
  for (var c = 0; c < maxLen; c++) dataBlocks.forEach(function (b) { if (c < b.length) all.push(b[c]); });
  for (c = 0; c < ecLen; c++) ecBlocks.forEach(function (b) { all.push(b[c]); });

  var size = ver * 4 + 17;
  var m = [], fixed = [];
  for (var r = 0; r < size; r++) { m.push(new Array(size).fill(0)); fixed.push(new Array(size).fill(false)); }
  var set = function (r, c, on) { m[r][c] = on ? 1 : 0; fixed[r][c] = true; };
  // Riconoscimento (tre angoli) con il margine chiaro
  [[0, 0], [0, size - 7], [size - 7, 0]].forEach(function (p) {
    for (var dr = -1; dr <= 7; dr++) for (var dc = -1; dc <= 7; dc++) {
      var rr = p[0] + dr, cc = p[1] + dc;
      if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
      var on = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6 &&
        (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
      set(rr, cc, on);
    }
  });
  // Allineamento
  var al = ALIGN[ver];
  al.forEach(function (ar) {
    al.forEach(function (ac) {
      if (fixed[ar][ac]) return;
      for (var dr = -2; dr <= 2; dr++) for (var dc = -2; dc <= 2; dc++) {
        set(ar + dr, ac + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
      }
    });
  });
  // Righe di temporizzazione
  for (i = 8; i < size - 8; i++) { if (!fixed[6][i]) set(6, i, i % 2 === 0); if (!fixed[i][6]) set(i, 6, i % 2 === 0); }
  // Spazi per formato e versione (si riempiono dopo), poi il modulo scuro
  for (i = 0; i < 9; i++) { if (!fixed[8][i]) set(8, i, false); if (!fixed[i][8]) set(i, 8, false); }
  for (i = 0; i < 8; i++) { set(8, size - 1 - i, false); set(size - 1 - i, 8, false); }
  set(size - 8, 8, true);
  if (ver >= 7) for (i = 0; i < 6; i++) for (j = 0; j < 3; j++) { set(i, size - 11 + j, false); set(size - 11 + j, i, false); }
  // Dati a zig-zag
  var bitAt = 0, total = all.length * 8;
  for (var col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (var cnt = 0; cnt < size; cnt++) {
      var row = ((col + 1) & 2) ? cnt : size - 1 - cnt;
      for (var t = 0; t < 2; t++) {
        var cc2 = col - t;
        if (fixed[row][cc2]) continue;
        m[row][cc2] = bitAt < total ? (all[bitAt >> 3] >>> (7 - (bitAt & 7))) & 1 : 0;
        bitAt++;
      }
    }
  }
  var MASKS = [function (r, c) { return (r + c) % 2 === 0; }, function (r) { return r % 2 === 0; }, function (r, c) { return c % 3 === 0; },
    function (r, c) { return (r + c) % 3 === 0; }, function (r, c) { return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0; },
    function (r, c) { return (r * c) % 2 + (r * c) % 3 === 0; }, function (r, c) { return ((r * c) % 2 + (r * c) % 3) % 2 === 0; },
    function (r, c) { return ((r + c) % 2 + (r * c) % 3) % 2 === 0; }];
  // Codice BCH: il valore seguito dal resto della divisione per poly (grado deg)
  var bch = function (val, poly, deg) {
    var r = val << deg;
    for (var i2 = 31 - Math.clz32(r); i2 >= deg; i2--) if ((r >>> i2) & 1) r ^= poly << (i2 - deg);
    return (val << deg) | r;
  };
  var withMask = function (mask) {
    var g = m.map(function (rr, r) { return rr.map(function (val, c) { return !fixed[r][c] && MASKS[mask](r, c) ? val ^ 1 : val; }); });
    var fmt = bch((0 << 3) | mask, 0x537, 10) ^ 0x5412;      // livello M = 00
    for (var k = 0; k < 15; k++) {
      var on = (fmt >>> k) & 1;
      // Prima copia, attorno all'angolo in alto a sinistra
      if (k <= 5) g[k][8] = on; else if (k === 6) g[7][8] = on; else if (k === 7) g[8][8] = on;
      else if (k === 8) g[8][7] = on; else g[8][14 - k] = on;
      // Seconda copia: in alto a destra (0-7) e in basso a sinistra (8-14)
      if (k < 8) g[8][size - 1 - k] = on; else g[size - 15 + k][8] = on;
    }
    if (ver >= 7) {
      var vi = bch(ver, 0x1F25, 12);
      for (k = 0; k < 18; k++) {
        var b = (vi >>> k) & 1, a = Math.floor(k / 3), bb = size - 11 + (k % 3);
        g[a][bb] = b; g[bb][a] = b;
      }
    }
    return g;
  };
  // Penalita' (per scegliere la maschera migliore)
  var penalty = function (g) {
    var p = 0, n = g.length, dark = 0;
    var lines = function (get) {
      for (var a = 0; a < n; a++) {
        var run = 1, line = [];
        for (var b = 0; b < n; b++) line.push(get(a, b));
        for (b = 1; b <= n; b++) {
          if (b < n && line[b] === line[b - 1]) run++;
          else { if (run >= 5) p += run - 2; run = 1; }
        }
        var s = '0000' + line.join('') + '0000';
        for (var idx = s.indexOf('1011101'); idx >= 0; idx = s.indexOf('1011101', idx + 1)) {
          if (s.substr(idx - 4, 4) === '0000' || s.substr(idx + 7, 4) === '0000') p += 40;
        }
      }
    };
    lines(function (a, b) { return g[a][b]; });
    lines(function (a, b) { return g[b][a]; });
    for (var r = 0; r < n - 1; r++) for (var c = 0; c < n - 1; c++) {
      var v = g[r][c];
      if (v === g[r][c + 1] && v === g[r + 1][c] && v === g[r + 1][c + 1]) p += 3;
    }
    g.forEach(function (rr) { rr.forEach(function (v) { dark += v; }); });
    p += Math.floor(Math.abs(dark * 20 - n * n * 10) / (n * n)) * 10;
    return p;
  };
  var best = null, bestP = Infinity;
  for (var mk = 0; mk < 8; mk++) {
    if (forceMask !== undefined && mk !== forceMask) continue;
    var g = withMask(mk), pp = penalty(g);
    if (pp < bestP) { bestP = pp; best = g; }
  }
  return best.map(function (rr) { return rr.join(''); });
}

function qrSvgRows(rows) {
  if (!rows || !rows.length) return '';
  var n = rows.length + 4, d = '';
  rows.forEach(function (row, y) {
    for (var x = 0; x < row.length; x++) if (row.charAt(x) === '1') d += 'M' + (x + 2) + ' ' + (y + 2) + 'h1v1h-1z';
  });
  return '<svg viewBox="0 0 ' + n + ' ' + n + '" shape-rendering="crispEdges" aria-hidden="true"><rect width="' + n + '" height="' + n +
    '" fill="#f2f5f2"/><path d="' + d + '" fill="#060a07"/></svg>';
}

// Lo stato del pannello: dati dal servizio e il passo in corso
// Dove stanno passkey e 2FA: il servizio account. Dalla PWA centrale ci si parla
// direttamente; dal server di casa (anche nell'app) si passa da /api/auth/sec.
function secDirect() { return !!(CENTRAL && C.token); }

function secApi(method, path, body) {
  if (secDirect()) return cloud(method, path, body);
  return method === 'GET' ? api('/auth/sec' + path) : send(method, '/auth/sec' + path, body);
}

function secState() {
  if (!cache.sec) cache.sec = { mode: '', err: '' };
  return cache.sec;
}

async function secLoad() {
  var st = secState();
  try {
    var r = await Promise.all([secApi('GET', '/passkeys'), secApi('GET', '/2fa')]);
    st.pk = r[0].passkeys || [];
    st.mail = !!r[0].mail;
    st.password = r[0].password !== false;
    st.tfa = r[1];
    st.service = r[0].service || '';
    st.loadErr = '';
  } catch (e) { st.loadErr = e.message; }
  secDraw();
}

function secDraw() {
  var box = document.getElementById('secbox');
  if (!box) return;
  box.innerHTML = secHtml();
  enhancePasswords(box);
  var f = box.querySelector('[data-autofocus]');
  if (f && secState().mode) f.focus();
}

// Il riquadro, per una pagina: nella PWA centrale si riempie da solo
function secBox() {
  if (!secDirect() && !(auth && auth.user && auth.user.linked && auth.cloud)) return '';
  setTimeout(secLoad, 0);
  return '<div id="secbox" class="secbox">' + secWait() + '</div>';
}

function secWait() { return '<div class="secsec"><h2>Impronta e volto (passkey)</h2><p>Un attimo…</p></div>'; }

function secWhen(t) { return t ? whenDate(t) : 'mai'; }

function secHtml() {
  var st = secState();
  var err = st.err ? '<p class="secerr" role="alert">' + esc(st.err) + '</p>' : '';
  if (st.loadErr) return '<div class="secsec"><h2>Sicurezza dell\'accesso</h2><p class="secerr">' + esc(st.loadErr) + '</p></div>';
  if (!st.tfa) return secWait();
  var cancel = '<button class="btn f" data-act="seccancel" data-key="seccancel">Annulla</button>';
  var code = function (id, act) {
    return '<input class="field f num" id="' + id + '" data-key="' + id + '" data-autofocus inputmode="numeric" autocomplete="one-time-code" ' +
      'maxlength="11" data-enter="' + act + '" placeholder="Codice">';
  };

  if (st.mode === 'verify') {
    var tfaOn = st.tfa && st.tfa.on, pks = (st.pk || []).length && pkOn();
    return '<div class="secsec"><h2>Conferma che sei tu</h2><p>Per cambiare passkey e verifica in due passaggi, prima conferma che sei tu.</p>' + err +
      (st.password ? '<input class="field f" id="secpw" data-key="secpw" data-autofocus type="password" autocomplete="current-password" ' +
        'data-enter="secverify" placeholder="La tua password">' : '') +
      (tfaOn ? '<p><small>Oppure il codice dell\'app di autenticazione:</small></p>' + code('seccode', 'secverify').replace(' data-autofocus', st.password ? '' : ' data-autofocus') : '') +
      '<div class="actions">' + (st.password || tfaOn ? '<button class="btn primary f" data-act="secverify" data-key="secverify">Conferma</button>' : '') +
      (pks ? '<button class="btn f pkbtn" data-act="secverifypk" data-key="secverifypk">' + pkIcon() + '<span>Con impronta o volto</span></button>' : '') + cancel + '</div>' +
      (!st.password && !tfaOn && !pks ? '<p><small>Il tuo account entra con Google: esci e rientra con Google, poi hai 10 minuti per le modifiche.</small></p>' : '') +
      '</div>';
  }
  if (st.mode === 'setup' && st.setup) {
    var key = st.setup.secret.replace(/(.{4})/g, '$1 ').trim();
    return '<div class="secsec"><h2>Attiva la verifica in due passaggi</h2>' +
      '<p>1. Apri un\'app di autenticazione (Google Authenticator, Microsoft Authenticator, 1Password…) e aggiungi BunkerPlex:</p>' +
      '<div class="secqr"><div class="qrtile" role="img" aria-label="Codice QR per l\'app di autenticazione">' + qrSvgRows(qrRows(st.setup.uri)) + '</div>' +
      '<div><p><small>Inquadra il QR, oppure scrivi questa chiave:</small></p><p class="seckey">' + esc(key) + '</p>' +
      (PHONE_APP || /Android|iPhone|iPad/.test(navigator.userAgent) ? '<p><a class="btn f" href="' + esc(st.setup.uri) + '" data-key="secotp">Apri nell\'app di autenticazione</a></p>' : '') +
      '</div></div>' +
      '<p>2. Scrivi il codice a 6 cifre che mostra l\'app:</p>' + err + code('secnew', 'tfaenable') +
      '<div class="actions"><button class="btn primary f" data-act="tfaenable" data-key="tfaenable">Attiva</button>' + cancel + '</div></div>';
  }
  if (st.mode === 'codes' && st.codes) {
    return '<div class="secsec"><h2>Codici di recupero</h2>' +
      '<p>Servono se perdi il telefono: ognuno vale <b>una volta sola</b>. Salvali adesso in un posto sicuro (non li vedrai più).</p>' +
      '<div class="reccodes">' + st.codes.map(function (c) { return '<span>' + esc(c) + '</span>'; }).join('') + '</div>' +
      '<div class="actions"><button class="btn f" data-act="seccopy" data-key="seccopy">Copia</button>' +
      '<button class="btn f" data-act="secsave" data-key="secsave">Scarica</button>' +
      '<button class="btn primary f" data-autofocus data-act="secdone" data-key="secdone">Li ho salvati</button></div></div>';
  }
  if (st.mode === 'tfaoff' || st.mode === 'tfanew') {
    return '<div class="secsec"><h2>' + (st.mode === 'tfaoff' ? 'Disattiva la verifica in due passaggi' : 'Nuovi codici di recupero') + '</h2>' +
      '<p>Scrivi il codice dell\'app di autenticazione (o uno di recupero).' + (st.mode === 'tfanew' ? ' I codici di prima non varranno più.' : '') + '</p>' +
      err + code('secoff', st.mode === 'tfaoff' ? 'tfadisable' : 'tfarecovery') +
      '<div class="actions"><button class="btn ' + (st.mode === 'tfaoff' ? 'danger' : 'primary') + ' f" data-act="' + (st.mode === 'tfaoff' ? 'tfadisable' : 'tfarecovery') +
      '" data-key="secoffgo">' + (st.mode === 'tfaoff' ? 'Disattiva' : 'Crea i codici') + '</button>' + cancel + '</div></div>';
  }
  if (st.mode === 'rm' && st.rm) {
    return '<div class="secsec"><h2>Togli «' + esc(st.rm.label) + '»</h2>' +
      '<p>Ti abbiamo scritto a <b>' + esc(st.rm.to) + '</b>: scrivi il codice a 6 cifre dell\'email (vale 15 minuti).</p>' + err +
      code('secrmcode', 'secrmok') +
      '<div class="actions"><button class="btn danger f" data-act="secrmok" data-key="secrmok">Togli la passkey</button>' +
      '<button class="btn f" data-act="secrmagain" data-key="secrmagain">Mandalo di nuovo</button>' + cancel + '</div></div>';
  }
  if (st.mode === 'ren' && st.ren) {
    return '<div class="secsec"><h2>Rinomina la passkey</h2>' + err +
      '<input class="field f" id="secname" data-key="secname" data-autofocus maxlength="60" data-enter="secrenok" value="' + esc(st.ren.label) + '">' +
      '<div class="actions"><button class="btn primary f" data-act="secrenok" data-key="secrenok">Salva</button>' + cancel + '</div></div>';
  }

  // Il riepilogo
  var rows = (st.pk || []).map(function (p, i) {
    return '<div class="secline">' + pkIcon() + '<span><b>' + esc(p.label) + '</b><small>Aggiunta il ' + esc(secWhen(p.created)) +
      ' · usata ' + (p.used ? 'il ' + esc(secWhen(p.used)) : 'mai') + '</small></span>' +
      '<div class="actions"><button class="btn f" data-act="secren" data-arg="' + i + '" data-key="secren-' + i + '">Rinomina</button>' +
      '<button class="btn danger f" data-act="secrm" data-arg="' + i + '" data-key="secrm-' + i + '">Togli</button></div></div>';
  }).join('');
  var t = st.tfa;
  return '<div class="secsec"><h2>Impronta e volto (passkey)</h2>' +
    '<p>Entri con impronta, volto o il PIN del dispositivo, senza password. Aggiungerne una chiede di confermare che sei tu; ' +
    (st.mail ? 'toglierla si conferma con un codice via email.' : 'anche toglierla.') + '</p>' + err +
    (rows ? '<div class="seclist">' + rows + '</div>' : '<p><small>Ancora nessuna passkey.</small></p>') +
    (pkOn() ? '<div class="actions"><button class="btn primary f" data-act="secadd" data-key="secadd">Aggiungi questo dispositivo</button></div>'
      : st.service && window.PublicKeyCredential ? '<div class="actions"><button class="btn primary f" data-act="secaddthere" data-key="secadd">Aggiungi questo dispositivo</button></div>' +
        '<p><small>Si apre la pagina del servizio account: le passkey valgono lì.</small></p>'
      : '<p><small>Questo browser non le supporta.</small></p>') + '</div>' +
    '<div class="secsec"><h2>Verifica in due passaggi</h2>' +
    (t.on ? '<p>' + dot(true) + ' Attiva: dopo la password serve il codice dell\'app di autenticazione. Codici di recupero rimasti: <b>' + t.recovery_left + '</b>' +
        (t.trusted ? '. Dispositivi ricordati: <b>' + t.trusted + '</b>' : '') + '.</p>' +
        '<div class="actions"><button class="btn f" data-act="tfanewask" data-key="tfanewask">Nuovi codici di recupero</button>' +
        (t.trusted ? '<button class="btn f" data-act="tfaforget" data-key="tfaforget">Dimentica i dispositivi ricordati</button>' : '') +
        '<button class="btn danger f" data-act="tfaoffask" data-key="tfaoffask">Disattiva</button></div>'
      : st.password ? '<p>L\'alternativa alle passkey: dopo la password serve anche un codice a 6 cifre da un\'app sul telefono. ' +
        'Chi scopre la tua password non entra lo stesso.</p><div class="actions"><button class="btn primary f" data-act="tfaon" data-key="tfaon">Attiva</button></div>'
      : '<p>Il tuo account entra con Google, che ha già la sua verifica: qui non serve.</p>') +
    (st.mail ? '<p><small>Ogni modifica ti arriva anche via email.</small></p>' : '') + '</div>';
}

// Un'operazione che puo' chiedere «Conferma che sei tu»: dopo la conferma riparte da sola
async function secRun(fn) {
  var st = secState();
  st.err = '';
  try {
    await fn();
  } catch (e) {
    if (e && e.data && e.data.reauth) { st.pending = fn; st.mode = 'verify'; st.err = ''; secDraw(); return; }
    if (e && (e.name === 'NotAllowedError' || e.name === 'AbortError')) { secDraw(); return; }   // annullato sul dispositivo
    st.err = (e && e.message) || 'Non riuscito';
    secDraw();
  }
}

async function secAfterVerify() {
  var st = secState(), fn = st.pending;
  st.pending = null;
  st.mode = '';
  if (fn) await secRun(fn); else { await secLoad(); }
}

function secActions() {
  return {
    seccancel: function () { var st = secState(); st.mode = ''; st.err = ''; st.pending = null; secDraw(); },
    secverify: function () {
      var st = secState(), pw = fieldValue('secpw'), code = fieldValue('seccode').trim();
      if (!pw && !code) { st.err = 'Scrivi la password' + (st.tfa && st.tfa.on ? ' o il codice' : ''); secDraw(); return; }
      return (async function () {
        try {
          if (pw) await secApi('POST', '/passkeys/verify', secDirect() ? { verifier: await cVerifier(C.user.username, pw) } : { password: pw });
          else await secApi('POST', '/passkeys/verify', { code: code });
          await secAfterVerify();
        } catch (e) { st.err = e.message; secDraw(); }
      })();
    },
    secverifypk: function () {
      var st = secState();
      return (async function () {
        try {
          var o = await cloud('POST', '/passkeys/verify/start', {});
          var a = await navigator.credentials.get({ publicKey: { challenge: b64uDec(o.challenge), rpId: o.rpId, userVerification: 'required',
            timeout: o.timeout, allowCredentials: o.allow.map(function (id) { return { type: 'public-key', id: b64uDec(id) }; }) } });
          await secApi('POST', '/passkeys/verify', { id: a.id, clientDataJSON: b64uEnc(a.response.clientDataJSON),
            authenticatorData: b64uEnc(a.response.authenticatorData), signature: b64uEnc(a.response.signature) });
          await secAfterVerify();
        } catch (e) {
          if (e && (e.name === 'NotAllowedError' || e.name === 'AbortError')) return;
          st.err = e.message; secDraw();
        }
      })();
    },
    secadd: function () {
      return secRun(async function () {
        await pkCreate();
        toast('Passkey aggiunta: la prossima volta entri con impronta o volto');
        await secLoad();
      });
    },
    secaddthere: function () {
      var st = secState();
      if (!st.service) return;
      var url = st.service.replace(/\/+$/, '') + '/#/sicurezza';
      if (APP) location.href = url; else window.open(url, '_blank', 'noopener');
    },
    secren: function (i) {
      var st = secState(), p = (st.pk || [])[Number(i)];
      if (!p) return;
      st.ren = p; st.mode = 'ren'; st.err = ''; secDraw();
    },
    secrenok: function () {
      var st = secState(), p = st.ren, name = fieldValue('secname').trim();
      if (!p) return;
      return secRun(async function () {
        await secApi('PATCH', '/passkeys/' + encodeURIComponent(p.id), { label: name });
        st.mode = ''; st.ren = null;
        await secLoad();
      });
    },
    secrm: function (i) {
      var st = secState(), p = (st.pk || [])[Number(i)];
      if (!p) return;
      return secRun(async function () {
        var r = await secApi('POST', '/passkeys/' + encodeURIComponent(p.id) + '/remove', {});
        if (r.removed) { toast('Passkey tolta'); st.mode = ''; await secLoad(); return; }
        st.rm = { id: p.id, label: p.label, to: r.to }; st.mode = 'rm'; secDraw();
      });
    },
    secrmagain: function () {
      var st = secState(), p = st.rm;
      if (!p) return;
      return secRun(async function () {
        var r = await secApi('POST', '/passkeys/' + encodeURIComponent(p.id) + '/remove', {});
        p.to = r.to || p.to;
        toast('Codice mandato di nuovo');
        secDraw();
      });
    },
    secrmok: function () {
      var st = secState(), p = st.rm, code = fieldValue('secrmcode');
      if (!p) return;
      return secRun(async function () {
        await secApi('POST', '/passkeys/' + encodeURIComponent(p.id) + '/remove/confirm', { code: code });
        toast('Passkey tolta');
        st.mode = ''; st.rm = null;
        await secLoad();
      });
    },
    tfaon: function () {
      var st = secState();
      return secRun(async function () {
        st.setup = await secApi('POST', '/2fa/setup', {});
        st.mode = 'setup'; secDraw();
      });
    },
    tfaenable: function () {
      var st = secState(), code = fieldValue('secnew');
      return secRun(async function () {
        var r = await secApi('POST', '/2fa/enable', { code: code });
        st.setup = null; st.codes = r.recovery; st.mode = 'codes';
        if (secDirect() && C.user) { C.user.totp = true; cSave(); }
        secDraw();
      });
    },
    tfaoffask: function () { var st = secState(); st.mode = 'tfaoff'; st.err = ''; secDraw(); },
    tfanewask: function () { var st = secState(); st.mode = 'tfanew'; st.err = ''; secDraw(); },
    tfadisable: function () {
      var st = secState(), code = fieldValue('secoff');
      return secRun(async function () {
        await secApi('POST', '/2fa/disable', { code: code });
        toast('Verifica in due passaggi disattivata');
        if (secDirect() && C.user) { C.user.totp = false; cSave(); }
        st.mode = ''; await secLoad();
      });
    },
    tfarecovery: function () {
      var st = secState(), code = fieldValue('secoff');
      return secRun(async function () {
        var r = await secApi('POST', '/2fa/recovery', { code: code });
        st.codes = r.recovery; st.mode = 'codes'; secDraw();
      });
    },
    tfaforget: function () {
      return secRun(async function () {
        await secApi('DELETE', '/2fa/trust');
        toast('Da tutti i dispositivi servirà di nuovo il codice');
        await secLoad();
      });
    },
    seccopy: function () {
      var st = secState(), text = (st.codes || []).join('\n');
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { toast('Codici copiati'); }, function () { toast('Copia non riuscita: scrivili a mano'); });
    },
    secsave: function () {
      var st = secState();
      var blob = new Blob(['Codici di recupero BunkerPlex (' + (C.user ? C.user.username : '') + ')\nOgnuno vale una volta sola.\n\n' + (st.codes || []).join('\n') + '\n'], { type: 'text/plain' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'bunkerplex-codici-di-recupero.txt';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    },
    secdone: function () { var st = secState(); st.codes = null; st.mode = ''; secLoad(); }
  };
}

// La pagina a se' (#/sicurezza, anche prima di scegliere un server)
function secPage() {
  cache.sec = null;
  return authShell('<div class="authico">' + LOCK_ICON + '</div><h1>Sicurezza dell\'accesso</h1>' +
    '<p class="authsub">Passkey e verifica in due passaggi del tuo account <b>' + esc(C.user ? C.user.username : '') + '</b></p>' +
    '<div class="secpage panel">' + secBox() + '</div>' +
    '<a class="authlink f" href="#/home" data-key="secback">Indietro</a>', true);
}

function cActions() {
  return {
    csrvoff: function (idx) { cOffSheet(idx); },
    cforget: function (sid) {
      var s = (C.list || []).filter(function (x) { return x.sid === sid && x.role === 'owner'; })[0];
      confirmBox('Togliere «' + (s ? s.name || 'PC' : 'il server') + '» dall\'elenco dei tuoi server? Se lo riaccendi andrà ricollegato con il codice.',
        'Sì, togli dall\'elenco', async function () {
          try {
            await cloud('POST', '/servers/' + sid + '/forget', {});
            if (C.sid === sid) { C.sid = ''; cSave(); }
            C.list = null;
            toast('Server tolto dall\'elenco');
            render();
          } catch (e) { toast(e.message); }
        });
    },
    cclaim: function () { cache.cClaim = {}; cClaimSheet(); },
    cclaimcheck: async function () {
      var code = fieldValue('clcode').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (code.length !== 8) { toast('Il codice è di 8 caratteri'); return; }
      try {
        var info = await cloud('GET', '/claim/' + code);
        // Proposta: sostituire il primo tuo server spento sulla stessa macchina (prende il suo nome)
        var old = (info.same_machine || []).filter(function (x) { return !x.online; })[0];
        cache.cClaim = { code: code, info: info, replace: old ? old.sid : '', name: old ? old.name : (info.name || '') };
        cClaimSheet();
      } catch (e) { toast(e.message); }
    },
    cclaimpick: function (sid) {
      var st = cache.cClaim;
      if (!st || !st.info) return;
      st.name = claimPickName(st.info.same_machine || [], st.replace, sid, fieldValue('clname'), st.info.name);
      st.replace = sid || '';
      cClaimSheet();
      var b = modal.querySelector('[data-key="cl-' + (sid || 'new') + '"]');
      if (b) b.focus();
    },
    cclaimgo: async function () {
      var st = cache.cClaim;
      if (!st || !st.info) return;
      var name = fieldValue('clname').trim();
      if (!name) { toast('Dai un nome al server'); return; }
      try {
        var r = await cloud('POST', '/claim/' + st.code, st.replace ? { name: name, replace: st.replace } : { name: name });
        cache.cClaim = null;
        closeModal(true);
        toast(r.replaced ? '«' + r.name + '» ora è il server nuovo: tra poco risulta acceso' : 'Server «' + r.name + '» aggiunto: tra poco risulta acceso');
        C.list = null;
        render();
      } catch (e) { toast(e.message); }
    },
    ctvgo: function () {
      var code = cTvClean(fieldValue('ctvcode'));
      if (code.length !== 8) { toast('Il codice della TV ha 8 caratteri'); return; }
      cTvSet(code);
      render();
    },
    ctvok: async function (code) {
      try {
        var r = await cloud('POST', '/tv/' + code, {});
        cache.cTvDone = r.device;
        lastHtml = '';
        render();
      } catch (e) { toast(e.message); }
    },
    // Un altro account: si esce da questo (qui) e il codice resta per dopo l'accesso
    ctvother: function () { cLogout(); },
    ctvclose: function () {
      cTvSet(null);
      cache.cTvDone = null;
      lastHtml = '';
      location.replace('#/home');
      render();
    },
    cedit: function () { cache.cEdit = !cache.cEdit; lastHtml = ''; render(); },
    clook: function (sid) { cLookSheet(sid); },
    // Dalle impostazioni del server in cui sei: l'elenco serve per il suo aspetto attuale
    cmylook: async function () {
      try { await cServers(); cLookSheet(C.sid); } catch (e) { toast(e.message); }
    },
    clookset: async function (arg) {
      var p = String(arg).split(':');
      var patch = { icon: p[1] || '' };
      if (p[2] === 'noimg' || !p[1]) patch.image = '';
      if (p[1]) patch.image = '';      // un'icona scelta prende il posto dell'immagine
      try { await cLookSave(p[0], patch); } catch (e) { toast(e.message); }
    },
    clookimg: async function (sid) {
      try {
        var data = await cPickImage();
        toast('Salvo l\'immagine…');
        await cLookSave(sid, { image: data });
        toast('Immagine salvata');
      } catch (e) {
        if (e.message !== 'Nessuna immagine') toast(e.message);
        else if (modal.hidden) cLookSheet(sid);   // ritaglio annullato: si torna all'aspetto
      }
    },
    // Primo passo: l'email. Un nome utente (senza @) va dritto alla password.
    cnext: async function () {
      var name = fieldValue('lname').trim();
      if (!name) { authErr('Scrivi l\'email'); return; }
      C.error = '';
      try {
        if (name.indexOf('@') < 0) {
          cache.cLogin = { email: name, username: name, activate: false };
        } else {
          var r = await cloud('POST', '/lookup', { email: name });
          cache.cLogin = { email: name, username: r.username, activate: r.activate, needs_name: r.needs_name, token: '' };
        }
        render();
      } catch (e) { authErr(e.message); }
    },
    cback: function () {
      cache.cLogin = null;
      C.error = '';
      render();
    },
    // «Mandami un link»: per entrare, o per attivare l'account
    cmagic: async function () {
      var L = cache.cLogin;
      if (!L) return;
      try {
        await cloud('POST', '/magic/start', { email: L.email });
        L.sent = true;
        C.error = '';
        render();
      } catch (e) { toast(e.message); }
    },
    cmanual: function () {
      if (cache.cLogin) cache.cLogin.manual = true;
      render();
    },
    cnamesave: async function () {
      var name = fieldValue('cname').trim();
      if (!name) { toast('Scegli il tuo nome utente'); return; }
      try {
        var r = await cloud('POST', '/name', { username: name });
        C.user = r.user || C.user;
        C.user.must_change = false;
        cSave();
        render();
      } catch (e) { toast(e.message); }
    },
    clogin: async function () {
      var L = cache.cLogin, pass = fieldValue('lpass');
      if (!L) return;
      if (!pass) { authErr('Scrivi la password'); return; }
      try {
        cEntered(await cloud('POST', '/login', { username: L.username, verifier: await cVerifier(L.username, pass), device: devName(), kind: 'pwa',
          trust: trustFor(L.username) }));
        if (cache.c2fa) cache.c2fa.names = [L.username, L.email];
        cache.cLogin = null;
        location.replace('#/home');
        render();
      } catch (e) {
        authErr(e.message);
        var pw = byKey('lpass');
        if (pw) { pw.value = ''; pw.focus(); }
      }
    },
    // Attivazione: con il gettone del link basta nome e password; senza, prima la
    // password provvisoria (entra) e poi quella nuova, come prima
    cactivate: async function () {
      var L = cache.cLogin;
      if (!L) return;
      var name = L.needs_name ? fieldValue('cname').trim() : L.username;
      var p1 = fieldValue('cnew'), p2 = fieldValue('cnew2');
      if (L.needs_name && !name) { toast('Scegli il tuo nome utente'); return; }
      if (p1.length < 8 || p1 !== p2) { toast(p1.length < 8 ? 'Almeno 8 caratteri' : 'Le due password non sono uguali'); return; }
      toast('Attivo l\'account…');
      try {
        if (L.token) {
          var body = { email: L.email, token: L.token, verifier: await cVerifier(name, p1), device: devName(), kind: 'pwa' };
          if (L.needs_name) body.new_username = name;
          cEntered(await cloud('POST', '/activate', body));
        } else {
          var old = fieldValue('cold');
          if (!old) { toast('Scrivi la password provvisoria dell\'email'); return; }
          cEntered(await cloud('POST', '/login', { username: L.username, verifier: await cVerifier(L.username, old), device: devName(), kind: 'pwa' }));
          var pb = { verifier: await cVerifier(L.username, old), new_verifier: await cVerifier(name, p1) };
          if (L.needs_name) pb.new_username = name;
          var r = await cloud('POST', '/password', pb);
          C.user = r.user || C.user;
          C.user.must_change = false;
          cSave();
        }
        cache.cLogin = null;
        location.replace('#/home');
        render();
      } catch (e) { toast(e.message); }
    },
    cgoogle: async function () {
      var win = window.open('about:blank', '_blank');
      try {
        var L = cache.cLogin, typed = fieldValue('lname').trim();
        var hint = L && L.email.indexOf('@') > 0 ? L.email : typed.indexOf('@') > 0 ? typed : '';
        var r = await cloud('POST', '/google/start', { device: pkLabel(), kind: 'browser', hint: hint,
          back: location.origin + location.pathname + '#/home' });
        cgSet({ poll: r.poll, url: r.url, at: Date.now(), ttl: r.ttl || 600, seen: false, note: '' });
        C.error = '';
        if (win) win.location.href = r.url;
        else { location.href = r.url; return; }        // finestre bloccate: Google qui, poi si torna
        render();
        cgPoll();
      } catch (e) {
        if (win) win.close();
        authErr(e.message);
      }
    },
    cresetgo: async function () {
      var email = fieldValue('remail').trim();
      if (!email) { toast('Scrivi l\'email'); return; }
      try { await cloud('POST', '/reset/start', { email: email }); cache.cReset = email; render(); } catch (e) { toast(e.message); }
    },
    cresetdone: async function () {
      var code = fieldValue('rcode').trim(), p1 = fieldValue('rpass'), p2 = fieldValue('rpass2');
      if (p1.length < 8 || p1 !== p2) { toast(p1.length < 8 ? 'Almeno 8 caratteri' : 'Le due password non sono uguali'); return; }
      try {
        var u = await cUsername(cache.cReset);
        cEntered(await cloud('POST', '/reset/finish', { email: cache.cReset, code: code, verifier: await cVerifier(u, p1), device: devName(), kind: 'pwa' }));
        cache.cReset = null;
        cache.cResetCode = '';
        cache.cLogin = null;
        location.replace('#/home');
        render();
      } catch (e) { toast(e.message); }
    },
    cpwsave: async function () {
      var name = C.user.needs_name ? fieldValue('cname').trim() : C.user.username;
      var p1 = fieldValue('cnew'), p2 = fieldValue('cnew2');
      if (p1.length < 8 || p1 !== p2) { toast(p1.length < 8 ? 'Almeno 8 caratteri' : 'Le due password non sono uguali'); return; }
      try {
        var body = { verifier: await cVerifier(C.user.username, fieldValue('cold')), new_verifier: await cVerifier(name, p1) };
        if (C.user.needs_name) body.new_username = name;
        var r = await cloud('POST', '/password', body);
        C.user = r.user || C.user;
        C.user.must_change = false;
        cSave();
        render();
      } catch (e) { toast(e.message); }
    },
    cpick: async function (arg) {
      var s = (C.list || [])[Number(arg)];
      if (!s) return;
      toast('Mi collego a ' + (s.name || 'PC') + '…');
      cDrop();
      try {
        await cOpen(s);
        C.sid = s.sid; C.owner = s.owner.id; C.name = s.name || 'PC'; C.role = s.role; C.error = '';
        cSave();
        location.replace('#/home');
        render();
      } catch (e) {
        cDrop();
        // Il consiglio sull'indirizzo pubblico solo se il server non si raggiunge
        C.error = (s.name || 'PC') + ': ' + e.message + (!e.net ? ''
          : s.role === 'owner' ? ' (fuori casa serve l\'indirizzo pubblico acceso sul server: Impostazioni → App → Da ovunque)'
            : ' (fuori casa il server di ' + s.owner.username + ' deve avere l\'indirizzo pubblico acceso)');
        render();
      }
    },
    crefresh: function () { C.list = null; C.error = ''; render(); },
    // Aperte dall'app fuori casa (remote.html, setup.html): si torna li'; se no all'accesso
    cappback: function () {
      if (tvCall('closeAppSettings') === true) return;
      location.hash = '#/home';
    },
    cnoshare: function (name) { toast(name + ' non ha server accesi da condividere: deve accendere la condivisione con gli amici sul suo server'); },
    cadd: function () { cache.cAdd = true; render(); },
    caddsend: async function () {
      var name = fieldValue('afname').trim();
      if (!name) { toast('Scrivi il nome dell\'account del tuo amico'); return; }
      try {
        var r = await cloud('POST', '/friends', { username: name });
        toast(r.status === 'ok' ? 'Ora tu e ' + r.username + ' siete amici' : 'Richiesta mandata a ' + r.username + ': quando accetta, i suoi server compaiono qui');
        cache.cAdd = false;
        C.list = null;
        render();
      } catch (e) { toast(e.message); }
    },
    caccept: async function (id) {
      try {
        await cloud('POST', '/friends/' + id + '/accept', {});
        toast('Ora siete amici: i suoi server compaiono qui');
        C.list = null;
        render();
      } catch (e) { toast(e.message); }
    },
    cdecline: async function (id) {
      try { await cloud('DELETE', '/friends/' + id); C.list = null; render(); } catch (e) { toast(e.message); }
    }
  };
}

function cLogout() {
  var tok = C.token;
  if (C.base && C.session) {
    fetch(C.base + '/api/auth/logout', { method: 'POST', headers: { 'X-BP-Session': C.session } }).catch(function () {});
  }
  try {
    Object.keys(localStorage).forEach(function (k) { if (k.indexOf('bpSess:') === 0 || k.indexOf('bpTicket:') === 0) localStorage.removeItem(k); });
  } catch (e) { /* niente */ }
  if (tok) cloud('POST', '/logout', {}).catch(function () {});
  cForget();
  location.replace('#/home');
  render();
}

// Gli indirizzi del server nelle risposte (/api/...) diventano completi, con la chiave
function cAbs(x) {
  if (typeof x === 'string') return x.indexOf('/api/') === 0 ? C.base + (C.mkey ? '/k/' + C.mkey : '') + x : x;
  if (Array.isArray(x)) { for (var i = 0; i < x.length; i++) x[i] = cAbs(x[i]); return x; }
  if (x && typeof x === 'object') {
    for (var k in x) if (Object.prototype.hasOwnProperty.call(x, k)) x[k] = cAbs(x[k]);
  }
  return x;
}

function apiUrl(path) { return (CENTRAL ? C.base : '') + '/api' + path; }

function apiOpt(opt) {
  if (!CENTRAL || !C.session) return opt;
  var o = {};
  for (var k in (opt || {})) o[k] = opt[k];
  o.headers = {};
  for (var h in ((opt && opt.headers) || {})) o.headers[h] = opt.headers[h];
  o.headers['X-BP-Session'] = C.session;
  return o;
}

// ---------------------------------------------------------------- utilita'

function api(path, opt) {
  if (opt && opt.method && opt.method !== 'GET') dropCached();   // qualcosa cambia: le copie salvate non valgono piu'
  if (CENTRAL && !C.base) return Promise.reject(new Error('Scegli un server'));
  return (CENTRAL ? cMediaKey(false).catch(function () {}) : Promise.resolve()).then(function () {
    return fetch(apiUrl(path), apiOpt(opt));
  }).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (j) {
      if (r.status === 503 && j.detail && !j.login && !/^\/auth\//.test(path) && !api.reloading) { api.reloading = true; location.reload(); }
      // Accesso scaduto (o password provvisoria da cambiare): si torna alla pagina di accesso
      if ((r.status === 401 || r.status === 403) && j.login && auth && auth.user && !/^\/auth\//.test(path)) {
        if (CENTRAL) { cSessSet(C.sid, null); cDrop(); }    // si riprende la sessione dal servizio account
        auth = null;
        setTimeout(render, 0);
      }
      if (CENTRAL && r.ok) j = cAbs(j);
      if (!r.ok) {
        var err = new Error(j.detail || ('Errore ' + r.status));
        err.data = j;   // es. 'missing': il disco scollegato e dove dovrebbe stare il file
        err.status = r.status;   // es. 412/401/429 del PIN di un profilo
        throw err;
      }
      return j;
    });
  });
}

// Pagine gia' viste (Home, raccolte, schede): si mostrano subito con i dati
// dell'ultima volta e intanto si chiedono quelli nuovi al server; se sono cambiati
// la pagina si ridisegna da sola. Tornare indietro col telecomando e' immediato.
var KEEP = /^\/(home(\?src=\w+)?|mylist|movies|shows|collections|libraries\/\d+\/items|items\/\d+|shows\/\d+|collections\/\d+)$/;
var kept = { map: {}, order: [] };
var keptRedraw = 0;

function dropCached() { kept.map = {}; kept.order = []; }

function keepCopy(path, text) {
  if (!kept.map[path]) {
    kept.order.push(path);
    if (kept.order.length > 40) delete kept.map[kept.order.shift()];
  }
  kept.map[path] = { text: text, at: Date.now() };
}

function cached(path) {
  if (!KEEP.test(path)) return api(path);
  var hit = kept.map[path];
  if (hit && Date.now() - hit.at < 3000) return Promise.resolve(JSON.parse(hit.text));
  var token = renderToken, hash = location.hash;
  var req = api(path).then(function (j) {
    var text = JSON.stringify(j);
    var changed = hit && kept.map[path] === hit && hit.text !== text;
    keepCopy(path, text);
    // Dati nuovi per la pagina che si sta guardando: si ridisegna, ma mai sotto le mani
    // (una finestra aperta, il video, un campo in cui si scrive)
    if (changed && token === renderToken && hash === location.hash && !keptRedraw) {
      keptRedraw = setTimeout(function () {
        keptRedraw = 0;
        var a = document.activeElement;
        if (token === renderToken && hash === location.hash && modal.hidden && !player && !press &&
            !(a && a.tagName === 'INPUT')) render();
      }, 50);
    }
    return j;
  });
  if (!hit) return req;
  req.catch(function () {});
  return Promise.resolve(JSON.parse(hit.text));
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

// «di Marco» per un amico, «su Fra Server» per un altro tuo PC
function fromWho(name, mine) {
  return (mine ? 'su ' : 'di ') + esc(name);
}

function libById(id) {
  for (var i = 0; i < libs.length; i++) if (String(libs[i].id) === String(id)) return libs[i];
  // Le raccolte degli amici: si sfogliano come le proprie, ma non si modificano
  for (var a = 0; a < friends.length; a++) {
    var fl = friends[a].libraries;
    for (var b = 0; b < fl.length; b++) {
      if (String(fl[b].id) === String(id)) {
        return { id: fl[b].id, name: fl[b].name, movies: fl[b].movies, shows: fl[b].shows, folders: [],
          friend: friends[a].name, friend_self: !!friends[a].self, offline: friends[a].online === false };
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
  // Il server scelto all'apertura: solo le sue raccolte nel menu
  var src = serverSrc(), only = /^f\d+$/.test(src) ? +src.slice(1) : 0;
  var shownLibs = only ? [] : libs, shownFriends = src === 'here' ? [] : only ? friends.filter(function (fr) { return fr.n === only; }) : friends;
  // Il server scelto non sta tra le raccolte: ha il suo pulsante in alto, accanto agli amici
  // Una raccolta che sta tutta su un altro tuo PC acceso compare sotto quel PC
  var html = shownLibs.filter(function (l) { return !l.remote; }).map(function (l) {
    return '<a class="f railitem" href="#/lib/' + l.id + '" data-key="nav-lib-' + l.id + '">' +
      avatar(l.name) + '<span>' + esc(l.name) + '</span></a>';
  }).join('') + shownFriends.map(function (fr) {
    if (!fr.libraries.length) return '';
    var off = fr.online === false;
    return '<div class="raillabel"><span>' + (fr.self ? 'Tuo PC · ' : '') + esc(fr.name) + (off ? ' · non raggiungibile' : '') + '</span></div>' +
      fr.libraries.map(function (l) {
        return '<a class="f railitem friend' + (off ? ' off' : '') + '" href="#/lib/' + l.id + '" data-key="nav-lib-' + l.id + '">' +
          avatar(l.name) + '<span>' + esc(l.name) + '</span></a>';
      }).join('');
  }).join('');
  if (html !== railSignature) {
    railSignature = html;
    document.getElementById('navlibs').innerHTML = html;
  }
  renderServerButton(document.querySelector('#activity .srvbtn'));   // il nome del server dell'amico arriva con gli amici
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

// Collegamento alla pagina IMDb del titolo, con il voto IMDb se c'e' (solo se la scheda ne ha l'id)
function imdbLink(x) {
  if (!/^tt\d+$/.test(x.imdb || '')) return '';
  var v = x.imdb_rating ? ' ' + x.imdb_rating.toFixed(1).replace('.', ',') : '';
  return '<a class="tag f" href="https://www.imdb.com/title/' + x.imdb +
    '/" target="_blank" rel="noopener" data-key="imdb">IMDb' + v + '</a>';
}

// Badge della qualita' (4K, 1080p, 720p) in alto a sinistra sulla copertina
function qBadge(x) { return x.quality && x.quality !== 'SD' ? '<span class="q">' + x.quality + '</span>' : ''; }

function seenBadge() { return '<span class="badge seen">' + IC.check + '</span>'; }

function posterCard(x, prefix, allQ) {
  cardData[prefix + '-' + x.kind + x.id] = x;
  var isShow = x.kind === 'show';
  var href = isShow ? '#/show/' + x.id : '#/item/' + x.id;
  var img = small(x.poster, 342) || x.thumb;
  var badge = isShow
    ? (x.unwatched ? '<span class="badge">' + x.unwatched + '</span>' : seenBadge())
    : (x.watched ? seenBadge() : '');
  // Le serie hanno "Serie" in piu': il voto va su una riga sua, se no viene tagliato
  var sub = [x.year || '', isShow ? 'Serie' : '', isShow ? '' : stars(x, true)].filter(Boolean).join(' · ');
  var sub2 = isShow && x.rating ? '<small>' + stars(x, true) + '</small>' : '';
  return '<a class="card poster f' + (x.offline ? ' off' : '') + '" href="' + href + '" data-key="' + prefix + '-' + x.kind + x.id + '" aria-label="' + esc(x.title) + '">' +
    '<div class="art" style="--h:' + hue(x.title) + '">' +
      (img ? '<img loading="lazy" decoding="async" src="' + img + '" alt="" onerror="this.style.display=\'none\'">' : '') +
      (x.poster ? '' : '<span class="ph">' + esc(x.title) + '</span>') +
      (x.offline ? offBadge(x) : allQ || x.quality === '4K' ? qBadge(x) : '') +
      badge + progressBar(x) + MORE +
    '</div>' +
    '<div class="cap"><b>' + esc(x.title) + '</b><small>' + (sub || '&nbsp;') + '</small>' + sub2 + '</div></a>';
}

// Immagini nelle griglie: la versione leggera (le TV la decodificano in meta' tempo).
// Solo per le immagini di questo PC; quelle degli amici restano come sono.
function small(url, w) {
  return url && url.indexOf('/api/image/') >= 0 && url.indexOf('?') < 0 ? url + '?size=' + w : url;
}

// Saga: i film della stessa serie cinematografica, riuniti da soli
function sagaYears(x) {
  return x.year ? (x.year_to && x.year_to !== x.year ? x.year + '–' + x.year_to : String(x.year)) : '';
}

function sagaCard(x, prefix) {
  var img = small(x.poster, 342) || x.thumb;
  var sub = [x.count + ' film' + (x.total > x.count ? ' su ' + x.total : ''), sagaYears(x)].filter(Boolean).join(' · ');
  return '<a class="card poster f" href="#/saga/' + x.id + '" data-key="' + prefix + '-collection' + x.id + '">' +
    '<div class="art" style="--h:' + hue(x.title) + '">' +
      (img ? '<img loading="lazy" decoding="async" src="' + img + '" alt="" onerror="this.style.display=\'none\'">' : '') +
      (x.poster ? '' : '<span class="ph">' + esc(x.title) + '</span>') +
      '<span class="q saga">Collezione</span>' +
      (x.unwatched ? '<span class="badge">' + x.unwatched + '</span>' : seenBadge()) +
    '</div>' +
    '<div class="cap"><b>' + esc(x.title) + '</b><small>' + (sub || '&nbsp;') + '</small></div></a>';
}

// Locandina di un video su un disco scollegato: piu' scura, con il nome del disco
function offBadge(x) {
  return x.offline ? '<span class="q offb" title="Dovrebbe trovarsi in ' + esc(x.where || '') + '">' + IC.disk + esc(x.disk || 'Non collegato') + '</span>' : '';
}

function wideCard(x, prefix) {
  cardData[prefix + '-' + x.kind + x.id] = x;
  var isEp = x.kind === 'episode';
  var title = isEp ? (x.show_title || x.title) : x.title;
  var sub = isEp ? 'S' + x.season + ' · E' + x.episode + ' · ' + esc(x.title) : (x.year || '');
  if (x.position && x.duration && !x.watched) sub += ' · mancano ' + fmtDur(x.duration - x.position);
  if (x.friend) sub += ' · ' + fromWho(x.friend, x.friend_self);
  var img = isEp ? x.thumb : (small(x.backdrop, 780) || x.thumb);
  return '<button class="card wide f' + (x.offline ? ' off' : '') + '" data-act="play" data-arg="' + x.id + '" data-key="' + prefix + '-' + x.kind + x.id + '">' +
    '<div class="art" style="--h:' + hue(title) + '">' +
      (img ? '<img loading="lazy" decoding="async" src="' + img + '" alt="" onerror="this.style.display=\'none\'">' : '') +
      (x.offline ? offBadge(x) : qBadge(x)) + '<span class="playico">' + IC.play + '</span>' + progressBar(x) + MORE +
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
var CHUNK = document.documentElement.classList.contains('lite') ? 36 : 60;   // meno alla volta sui dispositivi lenti

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
  var src = serverSrc();
  var d = await cached('/home' + (src ? '?src=' + src : ''));
  var recent = [];
  d.libraries.forEach(function (l) { recent = recent.concat(l.items); });
  if (d.friend && !d.continue.length && !recent.length) {
    return '<div class="page"><div class="empty center"><h2>Niente da vedere qui, per ora</h2>' +
      '<p>Questo server non condivide titoli o non risponde in questo momento.</p>' +
      '<div class="actions"><a class="btn primary f" href="#/server" data-key="to-server">Cambia server</a></div></div></div>';
  }
  if (!d.continue.length && !d.nextup.length && !recent.length && auth.user && auth.user.guest) {
    return '<div class="page"><div class="empty center"><h2>' + esc(auth.owner) + ' non condivide ancora titoli</h2>' +
      '<p>Quando accende la condivisione con gli amici, i suoi film e le sue serie compaiono qui.</p></div></div>';
  }
  if (!d.continue.length && !d.nextup.length && !recent.length) return emptyLibrary(d.has_libraries);
  var mine = d.mylist || [];

  var map = {};
  function reg(x, prefix, kicker) {
    map[prefix + '-' + x.kind + x.id] = { x: x, kicker: kicker };
    return x;
  }

  var parts = [
    section('Continua a guardare', d.continue.map(function (x) { return wideCard(reg(x, 'cont', 'Continua a guardare'), 'cont'); })) +
    section('Prossimi episodi', d.nextup.map(function (x) { return wideCard(reg(x, 'next', 'Prossimo episodio'), 'next'); })) +
    section('La mia lista', mine.map(function (x) { return posterCard(reg(x, 'mine', 'La mia lista'), 'mine', true); })) +
    d.libraries.map(function (l) {
      // Le raccolte degli amici: stessa fila, con il nome dell'amico bene in vista
      var note = l.friend ? fromWho(l.friend, l.friend_self) + (l.offline ? ' · non raggiungibile ora' : '') : 'aggiunti di recente';
      var kicker = l.friend ? l.name + (l.friend_self ? ' · su ' : ' · di ') + l.friend : l.name;
      return section(esc(l.name), l.items.map(function (x) { return posterCard(reg(x, 'lib' + l.id, kicker), 'lib' + l.id, true); }), note);
    }),
    section('Collezioni', (d.collections || []).map(function (x) { return sagaCard(reg(x, 'saga', 'Collezione'), 'saga'); }), 'i film della stessa serie, in ordine'),
    section('I più votati da vedere', d.top_movies.map(function (x) { return posterCard(reg(x, 'top', 'Da non perdere'), 'top', true); }))
  ];
  parts = [].concat.apply([], parts).filter(Boolean);

  // Prima le file in vista (e quella dove si era rimasti), subito dopo le altre:
  // sulle TV lente la Home compare prima, invece di aspettare tutte le locandine
  var first = 3, want = focusMemory['#/home'];
  if (want) parts.forEach(function (html, n) { if (html.indexOf('data-key="' + want + '"') >= 0) first = Math.max(first, n + 1); });
  var later = parts.slice(first).join('');

  return {
    html: '<div class="home"><div class="stage" id="stage"><div class="bg"></div><div class="bg"></div>' +
      '<div class="shade"></div><div class="info"></div></div><div class="rows" id="rows" data-later="' + later.length + ':' + hue(later) + '">' +
      parts.slice(0, first).join('') + '</div></div>',
    mount: function () {
      stageMap = map;
      stageKey = '';
      var box = document.getElementById('rows');
      if (later) {
        requestAnimationFrame(function () {
          setTimeout(function () {
            if (!box.isConnected) return;   // nel frattempo si e' cambiata pagina
            box.insertAdjacentHTML('beforeend', later);
            if (!kb && cache.homeScroll) box.scrollTop = cache.homeScroll;
          }, 0);
        });
      }
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
  // Sui dispositivi lenti lo sfondo grande arriva nella versione leggera: si decodifica in meta' tempo
  var lite = document.documentElement.classList.contains('lite');
  var img = (lite ? small(x.backdrop, 780) : x.backdrop) || x.thumb;
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
  var all = await cached('/libraries/' + lib.id + '/items');
  var owner = [];
  if (lib.friend) {
    owner.push(fromWho(lib.friend, lib.friend_self));
    if (lib.offline) owner.push('<span class="warn">' + dot(false) + ' non raggiungibile: vedi l\'ultimo elenco salvato</span>');
  }
  if (!all.length && lib.friend) {
    return '<div class="page">' + libHeader(lib, owner) + '<div class="empty">' +
      '<p>Questa raccolta ' + fromWho(lib.friend, lib.friend_self) + ' è vuota, oppure il suo elenco non è ancora arrivato.</p></div></div>';
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
    popKeys = ['fav'];
    render();
  }, function (e) { toast(e.message); });
}

async function item(id) {
  var x = await cached('/items/' + id);
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
        x.friend ? '<b class="lead">' + (x.friend_self ? 'Su ' : 'Di ') + esc(x.friend) + '</b>' : '',
        x.year, fmtDur(x.duration), stars(x), imdbLink(x),
        x.quality ? '<span class="tag">' + x.quality + '</span>' : '',
        x.watched ? '<span class="okdot">' + IC.check + ' Visto</span>' : '',
        resume ? 'mancano ' + fmtDur(x.duration - x.position) : ''
      ]) +
      '<p class="overview full">' + esc(x.overview || (x.matched || isEp || x.friend ? '' : 'Nessuna scheda trovata per questo file: prova «Correggi scheda».')) + '</p>' +
      offlineNote(x) +
      '<div class="actions">' +
        '<button class="btn primary f" data-act="play" data-arg="' + x.id + '" data-key="play">' + IC.play +
          (resume ? 'Riprendi da ' + fmtTime(x.position) : 'Riproduci') + '</button>' +
        (resume ? '<button class="btn f" data-act="playstart" data-arg="' + x.id + '" data-key="restart">Dall\'inizio</button>' : '') +
        (x.friend || x.offline ? '' : castBtn(x.id)) +
        (isEp || x.friend ? '' : favButton(x)) +
        '<button class="btn f" data-act="watched" data-arg="' + x.id + ':' + (x.watched ? 0 : 1) + '" data-key="watched">' +
          (x.watched ? 'Segna come da vedere' : 'Segna come visto') + '</button>' +
        (isEp
          ? '<a class="btn f" href="#/show/' + x.show_id + '" data-key="toshow">Vai alla serie</a>'
          : (x.friend ? '' : '<a class="btn f" href="#/match/movie/' + x.id + '" data-key="match">Correggi scheda</a>' +
            (x.matched ? '<a class="btn f" href="#/posters/movie/' + x.id + '" data-key="posters">Cambia locandina</a>' : ''))) +
      '</div>' +
      (!isEp && (x.genres.length || x.director || x.actors.length || x.collection) ? '<div class="credits">' +
        (x.collection ? '<div><b>Collezione</b><a class="chip f" href="#/saga/' + x.collection.id + '" data-key="chip-saga">' +
          esc(x.collection.title) + ' · ' + x.collection.count + ' film</a></div>' : '') +
        (x.genres.length ? '<div><b>Genere</b>' + chips(x.genres, base, 'genre') + '</div>' : '') +
        (x.director ? '<div><b>Regia</b>' + chips(directorsOf(x), base, 'director') + '</div>' : '') +
        (x.actors.length && !faces ? '<div><b>Cast</b>' + chips(x.actors, base, 'actor') + '</div>' : '') +
      '</div>' : '') +
      '<div class="fine">' + esc(tech) + '</div>' +
    '</div></div></header>' + faces;
}

// ---------------------------------------------------------------- Scheda serie

// ---------------------------------------------------------------- Guarda su
// Il video va su una TV di casa senza l'app (DLNA: Samsung, LG...; o Chromecast):
// la apre il lettore della TV, il server la comanda (server/cast.py). Qui si
// sceglie la TV e una barra in basso fa da telecomando finche' trasmette.
// Dentro l'app della TV non serve: si guarda gia' li'.

function canCast() { return !TV && !TVLOOK; }

function castBtn(id) {
  return canCast() && id ? '<button class="btn f" data-act="cast" data-arg="' + id + '" data-key="cast">' + IC.cast + 'Guarda su…</button>' : '';
}

var castState = { sessions: [], timer: 0, dragging: false, had: false };

function castPick(id, at, done) {
  var first = !castPick.known;
  if (first) toast('Cerco le TV nella rete di casa…');
  api('/cast/devices').then(function (r) {
    castPick.known = true;
    castDevicePicker(id, at, done, r);
  }, function (e) { toast(e.message); });
}

function castDevicePicker(id, at, done, r) {
  var devs = r.devices || [];
  var opts = devs.map(function (d) {
    return { value: d.id, label: d.name, count: d.online ? d.label + (d.busy ? ' · sta trasmettendo' : '') : 'spenta o non raggiungibile' };
  });
  opts.push({ value: '__scan', label: devs.length ? 'Cerca di nuovo' : 'Cerca le TV' });
  var title = devs.length ? 'Guarda su' : (r.error || 'Nessuna TV trovata: accendila e controlla che sia nella rete di casa');
  openPicker(title, opts, '', function (dev) {
    if (dev === '__scan') {
      toast('Cerco le TV nella rete di casa…');
      api('/cast/devices?refresh=1').then(function (r2) { castDevicePicker(id, at, done, r2); }, function (e) { toast(e.message); });
      return;
    }
    var d = devs.filter(function (x) { return x.id === dev; })[0];
    toast('Mando il video a ' + (d ? d.name : 'la TV') + '…');
    post('/cast/start', { device: dev, item: +id, at: at === null || at === undefined ? null : at }).then(function (s) {
      castState.sessions = [s];
      castState.had = true;
      renderCastBar();
      castPoll();
      if (done) done();
    }, function (e) { toast(e.message); });
  });
}

function castPoll() {
  clearTimeout(castState.timer);
  if (!canCast()) return;
  api('/cast/status').then(function (r) {
    var was = castState.sessions.length;
    castState.sessions = r.sessions || [];
    if (was && !castState.sessions.length && castState.had) toast('Trasmissione finita');
    castState.had = castState.sessions.length > 0;
    renderCastBar();
    if (castState.sessions.length) castState.timer = setTimeout(castPoll, 2000);
  }, function () {
    if (castState.sessions.length) castState.timer = setTimeout(castPoll, 5000);
  });
}

function castBar() {
  var bar = document.getElementById('castbar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'castbar';
    bar.hidden = true;
    document.body.appendChild(bar);
    bar.addEventListener('click', function (e) {
      var b = e.target.closest('[data-cast]');
      if (b) castControl(b.getAttribute('data-cast'));
    });
    bar.addEventListener('input', function (e) {
      if (!e.target.classList.contains('cseek')) return;
      castState.dragging = true;
      var t = bar.querySelector('.ctime');
      if (t) t.textContent = fmtTime(+e.target.value) + ' / ' + fmtTime(+e.target.max);
    });
    bar.addEventListener('change', function (e) {
      if (!e.target.classList.contains('cseek')) return;
      castState.dragging = false;
      castControl('seek', +e.target.value);
    });
  }
  return bar;
}

function renderCastBar() {
  var s = castState.sessions[0];
  var bar = castBar();
  var hide = !s || /^#\/play\//.test(location.hash);
  bar.hidden = hide;
  document.body.classList.toggle('casting', !hide);
  if (hide || castState.dragging) return;
  var playing = s.state === 'playing';
  var dur = s.duration || 0;
  var state = s.state === 'loading' ? 'si apre sulla TV…' : s.state === 'paused' ? 'in pausa' : 'in onda';
  var html = '<div class="cinfo">' +
      (s.poster ? '<img src="' + esc(small(s.poster, 342)) + '" alt="">' : '<span class="cicon">' + IC.cast + '</span>') +
      '<div class="ctxt"><b>' + esc(s.title) + '</b><span>' + (s.subtitle ? esc(s.subtitle) + ' · ' : '') +
        'su ' + esc(s.device_name) + ' · ' + state + '</span></div></div>' +
    '<div class="cctl">' +
      '<button class="pbtn" data-cast="back" aria-label="Indietro di 30 secondi" title="Indietro di 30 secondi">' + skipIcon('rew') + '</button>' +
      '<button class="pbtn main" data-cast="' + (playing ? 'pause' : 'play') + '" aria-label="' + (playing ? 'Pausa' : 'Riprendi') + '">' + (playing ? IC.pause : IC.play) + '</button>' +
      '<button class="pbtn" data-cast="fwd" aria-label="Avanti di 30 secondi" title="Avanti di 30 secondi">' + skipIcon('fwd') + '</button>' +
      '<button class="pbtn" data-cast="stop" aria-label="Ferma la trasmissione" title="Ferma">' + IC.stop + '</button>' +
    '</div>' +
    '<div class="cline"><input class="cseek" type="range" min="0" max="' + Math.round(dur) + '" step="1" value="' + Math.round(s.position || 0) + '"' +
      (dur ? '' : ' disabled') + ' aria-label="Posizione"><span class="ctime num">' + fmtTime(s.position || 0) + (dur ? ' / ' + fmtTime(dur) : '') + '</span></div>';
  bar.innerHTML = html;
}

function castControl(what, to) {
  var s = castState.sessions[0];
  if (!s) return;
  var body = { device: s.device, action: what };
  if (what === 'back' || what === 'fwd') {
    body.action = 'seek';
    body.to = Math.max(0, (s.position || 0) + (what === 'back' ? -30 : 30));
  } else if (what === 'seek') body.to = to;
  if (body.action === 'seek') s.position = body.to;
  if (what === 'pause') s.state = 'paused';
  if (what === 'play') s.state = 'playing';
  renderCastBar();
  post('/cast/control', body).then(function (r) {
    if (r && r.stopped) { castState.sessions = []; castState.had = false; renderCastBar(); toast('Trasmissione fermata'); }
    else castPoll();
  }, function (e) { toast(e.message); castPoll(); });
}

// La TV con l'app e' a sua volta una destinazione di «Guarda su»: mentre e' aperta
// si fa viva col server ogni paio di secondi e, se dal telefono arriva un titolo,
// lo apre nel player dell'app (che poi prende da solo pausa, salti e stop).
var castId = (function () {
  if (!TV) return '';
  try {
    var k = localStorage.getItem('bp_cast_id');
    if (!k) { k = Math.random().toString(36).slice(2, 10) + Date.now().toString(36); localStorage.setItem('bp_cast_id', k); }
    return k;
  } catch (e) { return ''; }
})();

function tvName() {
  var m = /Android [\d.]+; ([^;)]+)/.exec(navigator.userAgent);
  var model = m ? m[1].replace(/\s*Build\/.*$/, '').trim() : '';
  return 'TV' + (model && !/^(wv|K)$/.test(model) ? ' · ' + model : '');
}

function castListen() {
  if (!castId) return;
  if (document.visibilityState !== 'visible' || !auth || !auth.user) { setTimeout(castListen, 3000); return; }
  post('/cast/app/poll', { id: castId, name: tvName(), source: 'web', state: 'idle' }).then(function (r) {
    (r.commands || []).forEach(function (c) {
      if (c.cmd === 'load') { toast('Arriva dal telefono…'); play(c.item, false, c.at); }
    });
    setTimeout(castListen, 300);
  }, function () { setTimeout(castListen, 5000); });
}
setTimeout(castListen, 2000);

// Episodi tra cui pescare quello a caso: tutte le stagioni tranne gli speciali
// (se la serie ha solo quelli, valgono loro) e niente episodi su dischi scollegati
function shuffleEps(s) {
  var all = [];
  s.seasons.forEach(function (x) {
    x.episodes.forEach(function (e) { if (!e.offline) all.push({ e: e, special: x.season === 0 }); });
  });
  var regular = all.filter(function (o) { return !o.special; });
  return (regular.length ? regular : all).map(function (o) { return o.e; });
}

async function show(id) {
  var s = await cached('/shows/' + id);
  cache.navLib = s.library_id;
  cache.show = s;   // per il menu delle stagioni
  var q = parseQuery(location.hash);
  var up = s.up_next;
  var base = '#/lib/' + s.library_id;
  var current = parseInt(q.season, 10);
  if (isNaN(current)) current = up ? up.season : (s.seasons[0] ? s.seasons[0].season : 1);
  var season = s.seasons.filter(function (x) { return x.season === current; })[0] || s.seasons[0];

  var faces = castRow(s, base);
  var many = s.seasons.length > 1;

  // Episodi come su Netflix: numero grande, miniatura con ▶, titolo e durata, trama sotto.
  // L'episodio da vedere adesso ha il fondo piu' chiaro.
  var eps = season ? season.episodes.map(function (e) {
    var started = e.position > 20 && !e.watched;
    return '<div class="eprow' + (up && up.id === e.id ? ' cur' : '') + (e.watched ? ' seen' : '') + (e.offline ? ' off' : '') + '"' +
        (e.offline ? ' title="Dovrebbe trovarsi in ' + esc(e.where) + '"' : '') + '>' +
      '<button class="ep f" data-act="play" data-arg="' + e.id + '" data-key="ep-' + e.id + '">' +
        '<span class="num">' + e.episode + '</span>' +
        '<div class="art" style="--h:' + hue(s.title) + '"><img loading="lazy" decoding="async" src="' + e.thumb + '" alt="" onerror="this.style.display=\'none\'">' +
          '<span class="playico">' + IC.play + '</span>' + progressBar(e) + '</div>' +
        '<div class="head"><h3><span class="n">' + e.episode + '. </span>' + esc(e.title) + '</h3>' +
          '<span class="dur' + (e.offline ? ' gone' : started ? ' left' : '') + '">' +
            (e.offline ? IC.disk + 'Disco ' + esc(e.disk) + ' non collegato'
              : started ? 'mancano ' + fmtDur(e.duration - e.position) : fmtDur(e.duration)) + '</span></div>' +
        '<p>' + esc(e.overview || '') + '</p>' +
      '</button>' +
      '<button class="seenbtn f' + (e.watched ? ' on' : '') + '" data-act="watched" data-arg="' + e.id + ':' + (e.watched ? 0 : 1) +
        '" data-key="seen-' + e.id + '" title="' + (e.watched ? 'Visto: segna come da vedere' : 'Segna come visto') +
        '" aria-label="' + (e.watched ? 'Segna come da vedere' : 'Segna come visto') + '">' + IC.check + '</button>' +
    '</div>';
  }).join('') : '';

  // Stagioni: un menu a tendina «Stagione 2 ▾»; con una stagione sola basta il titolo
  var seasonName = function (n) { return n === 0 ? 'Speciali' : 'Stagione ' + n; };
  var seasonSeen = season && season.episodes.length && season.episodes.every(function (e) { return e.watched; });
  var left = season ? season.episodes.filter(function (e) { return !e.watched; }).length : 0;
  var epHead = season ? '<div class="ephead">' +
      '<h2>Episodi</h2>' +
      (many ? '<button class="seasonpick f" data-act="seasons" data-arg="' + s.id + ':' + season.season + '" data-key="seasonpick">' +
        seasonName(season.season) + '<svg class="ic line" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9.5 6 6 6-6"/></svg></button>' : '') +
      '<span class="epcount">' + season.episodes.length + (season.episodes.length === 1 ? ' episodio' : ' episodi') +
        (left && left < season.episodes.length ? ' · ' + left + ' da vedere' : '') + '</span>' +
      // Segna come vista solo la stagione aperta (con una stagione sola basta il pulsante della serie)
      (many ? '<button class="btn small f" data-act="seasonwatched" data-arg="' + s.id + ':' + season.season + ':' + (seasonSeen ? 0 : 1) +
        '" data-key="seasonseen">' + IC.check +
        (seasonSeen ? (season.season === 0 ? 'Speciali visti' : 'Stagione vista') : 'Segna ' + (season.season === 0 ? 'come visti' : 'come vista')) +
        '</button>' : '') +
    '</div>' : '';

  return '<header class="hero short">' + heroBg(s) + '<div class="in">' + cover(s) + '<div class="txt">' +
      '<h1>' + esc(s.title) + '</h1>' +
      metaLine([
        s.friend ? '<b class="lead">' + (s.friend_self ? 'Su ' : 'Di ') + esc(s.friend) + '</b>' : '',
        s.year, s.seasons_count + (s.seasons_count === 1 ? ' stagione' : ' stagioni'),
        s.episodes + ' episodi', stars(s), imdbLink(s),
        s.unwatched ? s.unwatched + ' da vedere' : '<span class="okdot">' + IC.check + ' Vista</span>'
      ]) +
      '<p class="overview">' + esc(s.overview || '') + '</p>' +
      '<div class="actions">' +
        (up ? '<button class="btn primary f" data-act="play" data-arg="' + up.id + '" data-key="play">' + IC.play +
          (up.position > 20 ? 'Riprendi' : 'Riproduci') + ' S' + up.season + ' · E' + up.episode + '</button>' : '') +
        (up && !s.friend && !up.offline ? castBtn(up.id) : '') +
        (shuffleEps(s).length > 1 ? '<button class="btn f" data-act="randomep" data-arg="' + s.id + '" data-key="randomep">' + IC.shuffle +
          'Episodio a caso</button>' : '') +
        (s.friend ? '' : favButton(s)) +
        '<button class="btn f" data-act="showwatched" data-arg="' + s.id + ':' + (s.watched ? 0 : 1) + '" data-key="allseen">' +
          (s.watched ? 'Segna tutta come da vedere' : 'Segna tutta come vista') + '</button>' +
        (s.friend ? '' : '<a class="btn f" href="#/match/show/' + s.id + '" data-key="match">Correggi scheda</a>' +
          (s.matched ? '<a class="btn f" href="#/posters/show/' + s.id + '" data-key="posters">Cambia locandina</a>' : '')) +
      '</div>' +
      (s.genres.length || s.director || s.actors.length ? '<div class="credits">' +
        (s.genres.length ? '<div><b>Genere</b>' + chips(s.genres, base, 'genre') + '</div>' : '') +
        (s.director ? '<div><b>Creata da</b>' + chips(directorsOf(s), base, 'director') + '</div>' : '') +
        (s.actors.length && !faces ? '<div><b>Cast</b>' + chips(s.actors, base, 'actor') + '</div>' : '') +
      '</div>' : '') +
    '</div></div></header>' + '<section class="eplist">' + epHead + '<div class="eps">' + eps + '</div></section>' + faces;
}

// ---------------------------------------------------------------- Saghe

async function sagasPage() {
  var res = await Promise.all([cached('/collections'), api('/info')]);
  var all = res[0], i = res[1];
  if (!all.length) {
    return '<div class="page"><div class="toolbar"><h1>Collezioni</h1></div><div class="empty">' +
      '<p>Qui compaiono da sole le collezioni: quando in catalogo hai almeno due film della stessa serie ' +
      '(Harry Potter, Il Signore degli Anelli, Ritorno al futuro…) vengono riuniti e messi in ordine di uscita.</p>' +
      (i.tmdb ? '<p>Per ora nessuna collezione ha due film in catalogo. Dopo un aggiornamento ci vuole qualche minuto perché vengano riconosciute.</p>'
              : '<p>Serve la chiave TMDB: inseriscila in <b>Impostazioni</b>.</p>') +
      '<p id="scanmsg"></p><div class="actions">' +
      (i.tmdb ? '<button class="btn f" data-act="scan" data-key="scan">Aggiorna adesso</button>'
              : '<a class="btn primary f" href="#/settings" data-key="to-settings">Apri Impostazioni</a>') +
      '</div></div></div>';
  }
  return '<div class="page"><div class="toolbar"><h1>Collezioni</h1>' +
    '<span class="count">' + all.length + (all.length === 1 ? ' collezione' : ' collezioni') + '</span></div>' +
    gridHtml(all, 'sagas', focusMemory[location.hash]) + '</div>';
}

// ---------------------------------------------------------------- La mia lista

async function myListPage() {
  var all = await cached('/mylist');
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
  var s = await cached('/collections/' + id);
  var up = s.up_next;
  var resume = up && up.position > 20 && !up.watched;
  var missing = (s.missing || []).map(function (m) { return esc(m.title) + (m.year ? ' (' + m.year + ')' : ''); });
  return '<header class="hero short">' + heroBg(s) + '<div class="in">' + cover(s) + '<div class="txt">' +
      '<h1>' + esc(s.title) + '</h1>' +
      metaLine([
        '<b class="lead">Collezione</b>',
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
  var res = await Promise.all([cached('/movies'), cached('/shows'), cached('/collections')]);
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
            : '<div class="empty"><p>Puoi cercare un titolo, una collezione, un regista, un attore, un genere o un anno, in tutte le raccolte.</p></div>';
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
      // Si cerca quando si smette di scrivere per un attimo, non a ogni lettera:
      // con tutto il catalogo da ridisegnare la tastiera della TV andava a scatti
      var typing = 0;
      input.addEventListener('input', function () { clearTimeout(typing); typing = setTimeout(run, 140); });
      run();
    }
  };
}

// ---------------------------------------------------------------- Correggi scheda

async function matchPage(kind, id) {
  var x = kind === 'movie' ? await api('/items/' + id) : await api('/shows/' + id);
  return {
    html: '<div class="page"><div class="toolbar"><h1>Correggi scheda</h1></div>' +
      '<div class="panel"><p>Scrivi il titolo giusto e scegli il risultato corretto, oppure incolla il link o il codice IMDb (tt…).' +
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

// ---------------------------------------------------------------- Cambia locandina

async function postersPage(kind, id) {
  var list = await api('/posters?kind=' + kind + '&id=' + id);
  var lang = { it: 'italiano', en: 'inglese', '': 'senza scritte' };
  return {
    html: '<div class="page"><div class="toolbar"><h1>Cambia locandina</h1></div>' +
      '<div class="panel"><p>Scegli la locandina da usare: resta anche quando la scheda si aggiorna.</p>' +
      (list.length ? '<div class="pgrid">' + list.map(function (p, i) {
        return '<button class="pick f" data-act="posterpick" data-arg="' + esc(p.path) + '" data-key="poster-' + i + '">' +
          '<img src="' + esc(p.url) + '" alt="" loading="lazy"><span>' + esc(lang[p.lang] || p.lang) +
          (p.votes ? ' · ' + p.votes + (p.votes === 1 ? ' voto' : ' voti') : '') + '</span></button>';
      }).join('') + '</div>' : '<p>TMDB non ha altre locandine per questo titolo.</p>') +
      '</div></div>',
    mount: function () { cache.posters = { kind: kind, id: id }; }
  };
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

// Come sta questo PC rispetto all'account: {state: '' | ok | warn, text}
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

// La voce dell'account nel menu laterale: il volto e il nome di chi sta guardando
function markMe() {
  document.body.classList.toggle('guest', !!(auth && auth.user && auth.user.guest));
  // Profilo bambini: niente impostazioni ne' raccolte nuove nel menu
  document.body.classList.toggle('kids', kidsNow());
  var el = document.getElementById('navme');
  if (!el) return;
  var u = auth && auth.user;
  el.hidden = !u;
  if (!u) return;
  var name = watcherName();
  var p = curProfile();
  // Con piu' profili il volto porta a «Chi guarda?», come su Netflix
  var href = hasWatchers() || kidsNow() ? '#/chi' : '#/settings/account';
  if (el.getAttribute('href') !== href) el.setAttribute('href', href);
  var html = (p ? pface(p) : face(name)) + '<span>' + esc(name) + '</span>';
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
function showSecret(title, name, pass, label) {
  label = label || 'Nome utente';
  cache.secret = label + ': ' + name + '\nPassword provvisoria: ' + pass;
  modalState = { options: [], onPick: function () {}, returnFocus: document.activeElement };
  modal.innerHTML = '<div class="sheet secret"><h3>' + esc(title) + '</h3>' +
    '<div class="secretbody">' + face(name, 'big') +
      '<dl><dt>' + esc(label) + '</dt><dd>' + esc(name) + '</dd><dt>Password provvisoria</dt><dd class="pw num">' + esc(pass) + '</dd></dl></div>' +
    '<p class="secretnote">Comunicala tu. Al primo accesso ' + (label === 'Email' ? 'sceglierà il suo nome e' : esc(name) + ' sceglierà') + ' una password sua.</p>' +
    '<div class="actions"><button class="btn primary f" data-act="copysecret" data-key="copysecret">Copia nome e password</button>' +
    '<button class="btn f" data-act="closemodal" data-key="closesecret">Fatto</button></div></div>';
  modal.hidden = false;
  var first = modal.querySelector('.btn');
  if (first) first.focus();
}

// ---------------------------------------------------------------- Impostazioni: aree
// Ogni area ha la sua vista (#/settings/<area>) con il suo nome come titolo.
// La panoramica (#/settings) dice com'e' messa ogni area e cosa va guardato.

// Le aree nel menu delle impostazioni, in gruppi che non si mescolano, ognuno per
// quello a cui si riferisce:
// - «Il tuo account»: ti segue su ogni server e dispositivo (account, amici,
//   amministrazione di tutta BunkerPlex);
// - «Server · <nome>»: valgono per il server aperto, per chiunque lo usi da qualsiasi
//   dispositivo (raccolte, schede, PC, aggiornamenti del server);
// - «Questo dispositivo» / «Questa TV»: valgono solo qui (collegamento, visione,
//   notifiche e, nell'app Android, l'app con la sua versione);
// - «Altri dispositivi» (solo dal browser): portare l'app su TV e telefoni.
// Poche voci, per il telecomando:
// - Persone (solo amministratore) si apre da Account;
// - Sottotitoli stanno in «Schede e sottotitoli»; sulla TV il QR per il telefono in «Collegamento e visione».
// Le vecchie pagine (#/settings/subtitles, #/settings/apps sulla TV) rimandano a quelle nuove.
// Ogni voce: [area, nome, gruppo]
function settingsAreas() {
  var out = [];
  if (auth && auth.user) out.push(['account', 'Account', 'account']);
  out.push(['friends', 'Amici', 'account']);
  if (adminHere()) out.push(['admin', 'Amministrazione', 'account']);
  out.push(['libraries', 'Raccolte', 'server'], ['catalog', 'Schede e sottotitoli', 'server'],
    ['pcs', 'PC e dispositivi', 'server'], ['updates', 'Aggiorna server', 'server'],
    ['device', 'Collegamento e visione', 'device']);
  if (APP) out.push(['app', appLabel(), 'device']);
  if (noticesLinked() && !TV) out.push(['notices', 'Notifiche', 'device']);
  if (!APP) out.push(['apps', 'App per TV e telefono', 'others']);
  return out;
}

// Aree che si aprono ma non stanno nel menu
var SETTINGS_HIDDEN = ['people'];

// Il gruppo di un'area, e come si chiama
function settingsGroup(area) {
  if (area === 'people') return 'account';
  if (area === 'news') return 'server';
  var a = settingsAreas().filter(function (x) { return x[0] === area; })[0];
  return a ? a[2] : '';
}

function deviceTitle() {
  return TV ? 'Questa TV' : 'Questo dispositivo';
}

// L'app Android installata qui (APK): la sola cosa di questo dispositivo che si aggiorna.
// La PWA (browser o app sulla schermata Home) no: arriva sempre nuova dal server o dal servizio.
// inText: dentro una frase («l'app Android»), se no come nome della voce («App Android»)
function appLabel(inText) {
  var s = TV ? 'App TV' : 'App Android';
  return inText ? 'a' + s.slice(1) : s;
}

// Il titolo di un gruppo: per il server anche come ci arrivi (locale / online).
// mini: per l'elenco a sinistra (stretto)
function groupHead(group, mini) {
  if (group === 'account') {
    return '<span class="sghname">Il tuo account</span>' +
      (mini ? '' : '<small>Ti segue su ogni server e dispositivo</small>');
  }
  if (group === 'others') {
    return '<span class="sghname">Altri dispositivi</span>' +
      (mini ? '' : '<small>Porta BunkerPlex su TV e telefoni</small>');
  }
  if (group === 'server') {
    var k = hereReach();
    return '<span class="sghname">Server · <b>' + esc(srvLabel()) + '</b></span>' + reachTag(k) +
      (mini ? '' : '<small>' + (REACH[k] ? esc(REACH[k].how.charAt(0).toUpperCase() + REACH[k].how.slice(1)) + ' · ' : '') +
        'Valgono per tutti quelli che lo usano, da qualsiasi dispositivo</small>');
  }
  if (group === 'device') {
    return '<span class="sghname">' + deviceTitle() + '</span>' +
      (mini ? '' : '<small>Valgono solo qui: non cambiano il server</small>');
  }
  return '';
}

// Amministrazione: per ogni amministratore, ovunque (browser, telefono, TV)
function adminHere() {
  return !!(auth && auth.user && auth.user.admin);
}

var CHEVRON = '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';
var ICON_FRIENDS = '<svg class="ic line" viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5M15.5 5.6a3.2 3.2 0 0 1 0 6M17.5 14.4c1.6.6 2.7 2.2 3 4.6"/></svg>';

// Un'icona per ogni area delle impostazioni: si riconoscono a colpo d'occhio
var SICON = {
  home: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.2"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.2"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.2"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.2"/>',
  account: '<circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20c.8-3.8 3.8-6 7.5-6s6.7 2.2 7.5 6"/>',
  admin: '<path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.3 7.5 9.5 4.3-1.2 7.5-4.9 7.5-9.5V6z"/><path d="m9 12 2 2 4-4"/>',
  people: '<circle cx="9" cy="8.5" r="3.3"/><path d="M3 19.5c.6-3.3 3-5.3 6-5.3s5.4 2 6 5.3M15.5 5.6a3.3 3.3 0 0 1 0 6.1M17.6 14.6c1.8.7 3 2.4 3.4 4.9"/>',
  libraries: '<path d="M3.5 7v11h17V9h-8l-2-2z"/>',
  catalog: '<rect x="4.5" y="3.5" width="15" height="17" rx="1.8"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  subtitles: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M6.5 12.5h3M11.5 12.5h6M6.5 15.5h7M15.5 15.5h2"/>',
  friends: '<circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="m8.2 10.8 7.6-3.6M8.2 13.2l7.6 3.6"/>',
  notices: '<path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 1.5H5zM10 20.5h4"/>',
  updates: '<path d="M20 11a8 8 0 0 0-14.5-4.5M4 13a8 8 0 0 0 14.5 4.5M5.5 3v3.5H9M18.5 21v-3.5H15"/>',
  device: '<rect x="3" y="4.5" width="18" height="12" rx="1.6"/><path d="M8.5 20h7M12 16.5V20"/>',
  pcs: '<rect x="2.5" y="4" width="13" height="9" rx="1.3"/><path d="M6 16.5h6M9 13v3.5"/><rect x="17" y="8" width="4.5" height="11" rx="1"/>',
  news: '<path d="M12 3.5l2.4 5 5.4.6-4 3.7 1.1 5.3L12 15.4 7.1 18.1l1.1-5.3-4-3.7 5.4-.6z"/>',
  active: '<path d="M3 12h4l2.5-6 5 12 2.5-6h4"/>',
  logout: '<path d="M14 4.5h4.5v15H14M10 8l-4 4 4 4M6 12h10"/>',
  tvlink: '<rect x="3" y="4.5" width="18" height="12" rx="1.6"/><path d="M8.5 20h7M9 10.5h6M12.5 8l2.5 2.5-2.5 2.5"/>',
  apps: '<rect x="2.5" y="5" width="13" height="9" rx="1.4"/><path d="M6 17.5h6"/><rect x="16.5" y="9" width="5" height="10.5" rx="1.2"/><path d="M18.5 17.5h1"/>',
  app: '<rect x="6.5" y="2.5" width="11" height="19" rx="2"/><path d="M12 7v7M9 11l3 3 3-3M10.5 18h3"/>'
};
function sicon(area) {
  return SICON[area] ? '<svg class="sic" viewBox="0 0 24 24" aria-hidden="true">' + SICON[area] + '</svg>' : '';
}

// Il colore della piastrella di ogni area (tonalita'): come nelle impostazioni dei
// telefoni, l'area si riconosce dal colore prima ancora di leggerla
var STINT = { home: 150, account: 150, admin: 4, people: 200, libraries: 210, catalog: 32, subtitles: 32, friends: 280,
  notices: 350, updates: 150, device: 190, apps: 255, app: 120, pcs: 170, news: 45, logout: 0, active: 150, tvlink: 190 };
// Una riga con interruttore (acceso/spento): il nome a sinistra, l'interruttore a destra
// note: una riga piccola sotto il nome (com'e' adesso)
function swRow(label, on, attrs, note) {
  return '<button class="setting swrow f' + (on ? ' on' : '') + '" role="switch" aria-checked="' + (on ? 'true' : 'false') + '" ' + attrs + '>' +
    '<span class="swt"><span>' + esc(label) + '</span>' + (note ? '<em class="swn">' + esc(note) + '</em>' : '') + '</span>' +
    '<i class="swi" aria-hidden="true"></i></button>';
}

function stile(area) {
  return '<span class="stile" style="--h:' + (STINT[area] || 150) + '">' + sicon(area) + '</span>';
}

function settingsShell(area, title, sub, body) {
  var lastGroup = '';
  var nav = settingsAreas().map(function (a) {
    var on = a[0] === area;
    // Il titolo del gruppo (Server · nome / Questo dispositivo) sopra la sua prima voce
    var head = a[2] && a[2] !== lastGroup ? '<p class="snavh">' + groupHead(a[2], true) + '</p>' : '';
    lastGroup = a[2];
    return head + '<a class="snav f' + (on ? ' on' : '') + '"' + (on ? ' aria-current="page"' : '') + ' href="#/settings/' + a[0] + '" data-key="snav-' + a[0] + '">' +
      (a[0] === 'account' && auth && auth.user ? face(auth.user.name) : stile(a[0])) + '<span>' + esc(a[1]) + '</span></a>';
  }).join('');
  // Sopra il titolo dell'area: di chi sono queste impostazioni (del server o di questo dispositivo)
  var group = settingsGroup(area);
  var eyebrow = group ? '<p class="seyebrow ' + group + '">' + groupHead(group, true) + '</p>' : '';
  // TV e PC: due colonne, a sinistra l'elenco delle aree e a destra l'area aperta (il
  // fuoco sta sempre nell'una o nell'altra, vedi settingsMove). Telefono: solo l'area,
  // con «‹ Impostazioni» in alto per tornare all'elenco.
  if (area !== 'people') cache.settingsArea = area;
  return '<div class="page settings"><div class="sgrid">' +
    '<nav class="scol" aria-label="Aree delle impostazioni">' + nav + '</nav>' +
    // Persone si apre da Account: si torna li'
    '<div class="smain"><a class="sup f" href="' + (area === 'people' ? '#/settings/account' : '#/settings') + '" data-key="sup">' + IC.back +
      '<span>' + (area === 'people' ? 'Account' : 'Impostazioni') + '</span></a>' +
    eyebrow + '<h1 class="stitle">' + esc(title) + '</h1>' + (sub ? '<p class="ssub">' + sub + '</p>' : '') + body + '</div></div></div>';
}

function settingsData() {
  return Promise.all([api('/info'), loadLibs(true), api('/update').catch(function () { return null; }),
    api('/sharing').catch(function () { return null; })]);
}

// Versioni: solo di cio' che si aggiorna davvero. Quella del server (il numero della
// release su GitHub, es. 1.2) e, nell'app Android, quella dell'app (APK) su questa TV o
// telefono. La PWA no: dal browser la pagina arriva dal server (o dal servizio account)
// ed e' sempre quella giusta, non c'e' niente da aggiornare.
function serverVer(i) {
  return i.release || (i.commit ? 'commit ' + i.commit : i.version);
}

function appVer() {
  return APP ? (tvCall('getVersionName') || 'precedente') : '';
}

// Ultima versione dell'app: le app nuove la chiedono da sole a GitHub (release
// app-v*), senza il server; quelle di prima si aggiornano ancora dalla copia sul PC.
function selfUpdating() {
  return APP && typeof tvApp.latestApp === 'function';
}

function appLatest(i) {
  if (selfUpdating()) {
    try { return JSON.parse(tvCall('latestApp') || 'null') || {}; } catch (e) { return {}; }
  }
  return { code: i.apk_version || 0, name: i.apk_version_name || '' };
}

function appOld(i) {
  return APP && (appLatest(i).code || 0) > (+tvCall('getVersion') || 0);
}

// Questa app vuole un server piu' nuovo (livello API in /api/info)
function serverTooOld(i) {
  return APP && typeof tvApp.minServerApi === 'function' && (+tvCall('minServerApi') || 1) > (i.api || 1);
}

function appWhere() {
  return selfUpdating() ? 'È uscita la ' : 'Sul PC c\'è la ';
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
      desc: 'Su questo PC, senza account', value: auth.cloud ? 'Entra con un account' : s.text, state: '' });
  }
  // Dal telefono o dal PC: la TV mostra un codice, qui si scrive (anche Samsung e LG)
  if (auth && auth.user && !auth.user.guest && !TVLOGIN) {
    rows.push({ area: 'tvlink', href: '#/tv', label: 'Collega una TV', desc: 'Scrivi il codice che vedi sulla TV, anche Samsung e LG', value: '', state: '' });
  }
  var off = 0, films = 0, series = 0, away = 0;
  libs.forEach(function (l) {
    films += l.movies || 0;
    series += l.shows || 0;
    (l.folders || []).forEach(function (f) { if (!f.online) off++; });
    if (l.mine !== false) away += (l.missing || []).length;
  });
  rows.push({ area: 'libraries', label: 'Raccolte',
    desc: away ? (away === 1 ? 'Una cartella sta su un altro PC' : away + ' cartelle stanno su altri PC') : 'Sezioni del menu e cartelle',
    value: off ? (off === 1 ? 'Una cartella offline' : off + ' cartelle offline')
      : (libs.length ? String(libs.length) : 'Nessuna raccolta'),
    state: off || !libs.length ? 'warn' : '' });
  rows.push({ area: 'catalog', label: 'Schede e sottotitoli',
    desc: films + ' film · ' + series + ' serie · ' + i.episodes + ' episodi',
    value: i.scanning ? 'Lettura…' : (i.tmdb ? 'Attive' : 'Non attive'),
    state: i.scanning ? '' : (i.tmdb ? '' : 'warn') });
  if (sh) {
    var pending = sh.accounts.filter(function (a) { return !a.approved; }).length;
    shareRequests = pending;
    markRequests();
    var asks = pending + (i.friend_requests || 0);
    var online = friends.filter(function (f) { return f.online !== false; }).length;
    rows.push({ area: 'friends', label: 'Amici', desc: 'Le raccolte dei tuoi amici, e le tue per loro',
      value: asks ? (asks === 1 ? '1 richiesta' : asks + ' richieste')
        : friends.length ? online + ' di ' + friends.length + ' online'
        : (sh.on ? 'Attiva' : ''),
      state: asks ? 'warn' : '' });
  }
  rows.push({ area: 'pcs', label: 'PC e dispositivi', desc: 'I tuoi altri PC, i dispositivi e gli indirizzi per fuori casa',
    value: i.devices_full ? 'Troppi dispositivi' : '', state: i.devices_full ? 'warn' : '' });
  if (i.updated) rows.push({ area: 'news', href: '#/news', label: 'Novità', desc: 'Cosa porta l\'ultimo aggiornamento', value: '', state: '' });
  if (auth && auth.cloud && auth.user) rows.push({ area: 'logout', act: 'logout', label: 'Esci', desc: '', value: '', state: '' });
  if (noticesLinked() && !TV) {
    rows.push({ area: 'notices', label: 'Notifiche', desc: 'Avvisi su telefono e tablet', value: '', state: '' });
  }
  if (adminHere()) {
    rows.push({ area: 'admin', label: 'Amministrazione', desc: 'Utenti, accessi, server e rete', value: '', state: '' });
  }
  // Aggiornamenti del server, con la sua versione (l'app Android ha la sua riga, sotto)
  var srvWarn = !!(u && u.enabled && (u.error || u.access === false || u.available || u.phase));
  rows.push({ area: 'updates', label: 'Aggiorna server',
    desc: 'Il server BunkerPlex sul PC · versione ' + serverVer(i),
    value: !(u && u.enabled) ? serverVer(i)
      : u.error || u.access === false ? 'Da controllare' : (u.phase ? 'In corso' : (u.available ? 'Disponibile' : 'Aggiornato')),
    state: srvWarn ? 'warn' : (u && u.enabled ? 'ok' : '') });
  // Questo dispositivo: come arriva al server (locale / online), la visione e l'app
  var k = hereReach();
  rows.push({ area: 'device', label: 'Collegamento e visione',
    desc: (REACH[k] ? 'Server ' + REACH[k].how + ' · ' : '') + 'animazioni e locandine' +
      (TV ? ' · app sul telefono' : phoneTvOk() ? ' · installa sulla TV' : ''),
    value: '', tag: reachTag(k), state: '' });
  if (APP) {
    var tvOld = appOld(i);
    rows.push({ area: 'app', label: appLabel(), desc: 'L\'app installata qui · versione ' + appVer(),
      value: tvOld ? 'Da aggiornare' : (appLatest(i).code ? 'Aggiornata' : ''), state: tvOld ? 'warn' : '' });
  }
  if (!APP) {
    rows.push({ area: 'apps', label: 'App per TV e telefono',
      desc: 'Da questo server: installa sulla TV, app sul telefono', value: '', state: '' });
  }
  return rows;
}

// L'app per la TV (e per i telefoni Android): indirizzo e QR da inquadrare
async function apkPanel(title) {
  var link = await api('/apk-link').catch(function () { return null; });
  if (!link || !link.apk) {
    return '<div class="panel"><h2>' + title + '</h2><p>Sul PC non c\'è ancora l\'app Android: arriva con il prossimo aggiornamento di BunkerPlex.</p></div>';
  }
  if (!link.url) {
    return '<div class="panel"><h2>' + title + '</h2><p>Non conosco ancora l\'indirizzo di questo PC nella rete di casa: rilancia «Installa BunkerPlex» sul computer, oppure apri questa pagina da un altro dispositivo di casa.</p></div>';
  }
  return '<div class="panel"><h2>' + title + '</h2><div class="apkqr">' +
    (link.svg ? '<div class="qrtile" role="img" aria-label="Codice QR per scaricare l\'app">' + link.svg + '</div>' : '') +
    '<div class="apktext"><p>Inquadra il codice con la fotocamera del telefono Android: scarica l\'app da questo PC.' +
      (TV ? '' : ' Per la TV è più comodo «Installa sulla TV dal PC» qui sopra; in alternativa apri lo stesso indirizzo sulla TV con l\'app «Downloader».') + '</p>' +
    '<p class="apkurl num">' + esc(link.url) + '</p>' +
    (APP ? '' : '<div class="actions" style="margin-top:.4rem"><a class="btn f" href="/BunkerPlex.apk" download data-key="apk">Scarica BunkerPlex.apk</a></div>') +
    '</div></div></div>';
}

// ---------------------------------------------------------------- App sulla TV dal PC (adb)
// Il server cerca le TV di casa con il debug acceso, si collega e installa l'app
// con un clic (server/tvinstall.py). Il pannello si aggiorna da solo mentre lavora.
var tvPoll = null;

function tvStateText(d, t) {
  var busy = t.phase && t.target === d.serial;
  if (busy) return '<span class="nodot">' + (t.step === 'confirm' ? 'In attesa di conferma sulla TV…' : t.step === 'install' ? 'Installo l\'app…' : 'Mi collego…') + '</span>';
  if (d.state === 'unauthorized') return '<span class="nodot">In attesa di conferma sulla TV</span>';
  if (d.state === 'offline' || d.state === 'found') return 'Debug acceso, non ancora collegata';
  if (!d.installed) return 'Collegata · BunkerPlex non installata';
  if (t.apk_version && d.installed < t.apk_version) return '<span class="nodot">Collegata · app da aggiornare</span>';
  return '<span class="okdot">Collegata · app aggiornata</span>';
}

function tvDeviceRow(d, t, many) {
  var label = d.name || 'TV o dispositivo Android';
  var btn = '';
  if (!t.phase) {
    var again = d.state === 'device' && d.installed && !(t.apk_version && d.installed < t.apk_version);
    btn = '<button class="btn' + (again ? '' : ' primary') + ' f" data-act="tvinstall" data-arg="' + esc(d.serial) + '" data-key="tvi-' + esc(d.ip) + '">' +
      (again ? 'Reinstalla' : (d.installed ? 'Aggiorna l\'app' : (many && d.state !== 'device' ? 'Installa su questa' : 'Installa l\'app'))) + '</button>';
  }
  return '<dt>' + esc(label) + '<small class="num">' + esc(d.ip) + '</small></dt><dd>' + tvStateText(d, t) +
    (btn ? '<div class="actions" style="justify-content:flex-end;margin-top:.4rem">' + btn + '</div>' : '') + '</dd>';
}

// I passi, con quello di adesso in evidenza
var TV_STEPS = [['debug', 'Debug acceso sulla TV'], ['scan', 'Cerco le TV'], ['choose', 'Scegli la TV'],
  ['confirm', 'Conferma sulla TV'], ['install', 'Installo l\'app'], ['done', 'Fatto']];

function tvSteps(t) {
  var step = t.step || 'debug';
  if (step === 'connect') step = 'confirm';
  var now = TV_STEPS.map(function (x) { return x[0]; }).indexOf(step);
  if (now < 0) now = 0;
  var failed = !!t.error && !t.phase;
  return '<ol class="tvsteps">' + TV_STEPS.map(function (x, n) {
    var cls = n < now || step === 'done' ? 'done' : (n === now ? (failed ? 'now fail' : 'now') : '');
    return '<li class="' + cls + '"><span>' + (n < now || step === 'done' ? '✓' : n + 1) + '</span>' + esc(x[1]) + '</li>';
  }).join('') + '</ol>';
}

// Il racconto di quello che succede. Le righe "dbg" sono i comandi adb con la
// risposta esatta: piccole e grigie, ma visibili, e finiscono in «Copia il log».
function tvLog(t) {
  var log = t.log || [];
  if (!log.length) return '';
  return '<div class="tvlog" role="log" aria-live="polite">' + log.map(function (l) {
    var d = new Date(l.at * 1000);
    var hh = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2);
    if (l.kind === 'sep') return '<div class="sep"><time class="num">' + hh + '</time>' + esc(l.text) + '</div>';
    return '<div class="' + esc(l.kind) + '"><time class="num">' + hh + '</time><span>' + esc(l.text) + '</span></div>';
  }).join('') + (t.phase ? '<div class="wait spin"><time></time>…</div>' : '') + '</div>';
}

// Il riquadro grande: cosa fare adesso
function tvNow(t, devs) {
  var msg = '', cls = '';
  if (t.phase && t.step === 'confirm') {
    cls = 'wait';
    msg = '<b>Guarda la TV</b>: è comparsa la richiesta «Consentire il debug?». Metti la spunta su <b>Consenti sempre da questo computer</b> e premi <b>OK</b> col telecomando.' +
      '<p class="tvnohint"><small><b>Sulla TV non compare niente?</b> Premi il tasto <b>Home</b> del telecomando: su alcune TV (per esempio TCL) la richiesta si vede solo dalla schermata Home. ' +
      'Se ancora niente, premi «Interrompi»; sulla TV, in Opzioni sviluppatore, scegli <b>Revoca autorizzazioni debug USB</b>, spegni e riaccendi <b>Debug USB</b> e riprova, ' +
      'oppure usa <b>Debug wireless</b> con il codice (passi in fondo).</small></p>';
  } else if (t.phase) {
    cls = 'busy';
    msg = esc(t.message || 'Un attimo…');
  } else if (t.error === 'INCOMPATIBILE') {
    cls = 'err';
    msg = 'Sulla TV c\'è una BunkerPlex con una firma diversa (compilata su un altro PC): va tolta prima di mettere questa. Il server della TV andrà riscelto (lo trova da solo).' +
      '<div class="actions"><button class="btn primary f" data-act="tvreplace" data-arg="' + esc(t.target) + '" data-key="tvreplace">Togli quella e installa</button></div>';
  } else if (t.error) {
    cls = 'err';
    msg = esc(t.error);
  } else if (t.step === 'done') {
    cls = 'ok';
    msg = 'Fatto: BunkerPlex è installata e si è aperta sulla TV. Da qui in poi si aggiorna da sola.';
  } else if (t.step === 'choose' && devs.length > 1) {
    cls = 'wait';
    msg = 'Ho trovato <b>' + devs.length + ' TV</b>. Scegli qui sotto su quale installare l\'app: il nome o l\'indirizzo lo trovi sulla TV in Impostazioni → Rete.';
  } else if (t.step === 'install') {
    cls = 'ok';
    msg = 'TV collegata: premi <b>Installa l\'app</b> qui sotto.';
  } else if (t.scanned_at && !devs.length) {
    cls = 'err';
    msg = 'Nessuna TV con il debug acceso. Segui i passi qui sotto, poi premi di nuovo <b>Cerca le TV</b>, oppure scrivi l\'indirizzo della TV.';
  } else {
    msg = 'Accendi il debug sulla TV (passi qui sotto, una volta sola), poi premi <b>Cerca le TV</b>.';
  }
  if (t.phase) {
    msg += '<div class="actions"><button class="btn f" data-act="tvcancel" data-key="tvcancel">Interrompi</button></div>';
  }
  return '<div class="tvnow ' + cls + '">' + msg + '</div>';
}

function tvGuide() {
  return '<details class="tvguide"' + '><summary class="f" data-key="tvguide">Come si accende il debug sulla TV (una volta sola)</summary>' +
    '<ol class="steps">' +
    '<li><b>Google TV / Android TV</b>: Impostazioni → Sistema → Info → premi 7 volte su <b>Build del sistema operativo Android TV</b> (compare «Ora sei uno sviluppatore»)</li>' +
    '<li>torna in Impostazioni → Sistema → <b>Opzioni sviluppatore</b> e attiva <b>Debug USB</b> (se c\'è, anche <b>Debug di rete</b> / <b>ADB in rete</b>)</li>' +
    '<li><b>Fire TV</b>: Impostazioni → La mia Fire TV → Informazioni → premi 7 volte sul nome del dispositivo, poi Opzioni sviluppatore → <b>Debug ADB</b> attivo</li>' +
    '<li>porta la TV sulla <b>schermata Home</b> (su alcune TV la richiesta compare solo lì), premi <b>Cerca le TV</b> qui sotto; quando la TV chiede «Consentire il debug?» metti la spunta su <b>Consenti sempre</b> e premi <b>OK</b></li></ol>' +
    '<p><small>Se la TV ha solo <b>Debug wireless</b> (con codice di associazione): aprilo, scegli «Associa dispositivo con codice» e scrivi qui sotto indirizzo:porta e codice che mostra.</small></p>' +
    '<div class="tvpair"><input class="field f num" id="tvpairaddr" data-key="tvpairaddr" placeholder="192.168.1.180:37123">' +
    '<input class="field f num" id="tvpaircode" data-key="tvpaircode" inputmode="numeric" maxlength="6" placeholder="Codice" data-enter="tvpair">' +
    '<button class="btn f" data-act="tvpair" data-key="tvpair">Associa</button></div>' +
    '<p><small>Dopo l\'associazione scrivi nel campo «Indirizzo della TV» l\'indirizzo:porta di «Debug wireless» (non quello del codice) e premi Collega.</small></p></details>';
}

function tvPanelBody(t) {
  if (!t) return '<p>Il server non risponde in questo momento.</p>';
  if (!t.apk) return '<p>Sul PC non c\'è ancora l\'app da installare: arriva con il prossimo aggiornamento.</p>';
  var devs = t.devices || [];
  var html = '<p>Con il debug acceso sulla TV, il PC installa e aggiorna l\'app da solo: niente Downloader né chiavette.</p>' +
    tvSteps(t) + tvNow(t, devs);
  if (devs.length) {
    html += '<dl class="kv">' + devs.map(function (d) { return tvDeviceRow(d, t, devs.length > 1); }).join('') + '</dl>';
  }
  html += '<div class="actions" style="margin-top:.8rem"><button class="btn' + (devs.length ? '' : ' primary') + ' f" data-act="tvscan" data-key="tvscan"' + (t.phase ? ' disabled' : '') + '>' +
    (t.scanned_at ? 'Cerca di nuovo' : 'Cerca le TV') + '</button>' +
    '<input class="field f num tvaddr" id="tvaddr" data-key="tvaddr" placeholder="Indirizzo della TV, es. 192.168.1.180" data-enter="tvconnect">' +
    '<button class="btn f" data-act="tvconnect" data-key="tvconnect"' + (t.phase ? ' disabled' : '') + '>Collega</button></div>';
  if ((t.log || []).length) {
    html += '<div class="tvlogtitle"><h3>Cosa sta succedendo</h3>' +
      '<button class="btn f" data-act="tvcopylog" data-key="tvcopylog" title="Tutto il registro, con versioni e risposte di adb: incollalo a chi ti aiuta">Copia il log</button></div>' + tvLog(t);
  }
  return html + tvGuide();
}

function tvNeedsPoll(t) {
  return t && (t.phase || (t.devices || []).some(function (d) { return d.state === 'unauthorized'; }));
}

function tvShow(t) {
  var el = document.getElementById('tvpanel');
  if (!el) { clearTimeout(tvPoll); tvPoll = null; return; }
  // Non si perde quello che si sta scrivendo nei campi
  var keep = {};
  ['tvaddr', 'tvpairaddr', 'tvpaircode'].forEach(function (id) { var i = document.getElementById(id); if (i) keep[id] = i.value; });
  var open = !!el.querySelector('details[open]');
  var focused = document.activeElement && document.activeElement.getAttribute('data-key');
  el.innerHTML = '<h2>Installa sulla TV dal PC</h2>' + tvPanelBody(t);
  Object.keys(keep).forEach(function (id) { var i = document.getElementById(id); if (i) i.value = keep[id]; });
  if (open) { var dt = el.querySelector('details'); if (dt) dt.open = true; }
  if (focused) { var f = el.querySelector('[data-key="' + focused + '"]'); if (f && !f.disabled) f.focus(); }
  var lg = el.querySelector('.tvlog'); if (lg) lg.scrollTop = lg.scrollHeight;
  clearTimeout(tvPoll);
  tvPoll = tvNeedsPoll(t) ? setTimeout(tvRefresh, 2000) : null;
}

function tvRefresh() {
  return api('/tv').then(tvShow, function () { tvShow(null); });
}

function tvSend(path, body) {
  return post('/tv/' + path, body).then(tvShow, function (e) { toast(e.message); });
}

async function tvPanel() {
  var t = await api('/tv').catch(function () { return null; });
  setTimeout(function () { if (tvNeedsPoll(t)) tvShow(t); }, 0);
  return '<div class="panel" id="tvpanel"><h2>Installa sulla TV dal PC</h2>' + tvPanelBody(t) + '</div>';
}

// ---------------------------------------------------------------- App sulle TV Samsung dal PC (sdb)
// Le Samsung (Tizen) non prendono l'APK: il server installa l'app Tizen con la
// Modalita' sviluppatore della TV (server/samsunginstall.py). Senza installare
// niente, BunkerPlex si usa comunque dal browser della TV.
var ssPoll = null;

function ssRow(tv, t, pc) {
  var name = tv.name || 'TV Samsung';
  var state, btn = '';
  if (t.phase && t.target === tv.ip) state = '<span class="nodot">' + esc(t.message || 'Un attimo…') + '</span>';
  else if (!tv.dev) state = '<span class="nodot">Modalità sviluppatore spenta</span>';
  else if (pc && tv.dev_ip && tv.dev_ip !== pc) state = '<span class="nodot">IP del PC host sulla TV: <span class="num">' + esc(tv.dev_ip) + '</span>, deve essere <span class="num">' + esc(pc) + '</span></span>';
  else if (tv.installed) state = '<span class="okdot">App installata</span>';
  else state = 'Pronta per l\'app';
  if (!t.phase && tv.dev) {
    btn = '<div class="actions" style="justify-content:flex-end;margin-top:.4rem"><button class="btn' + (tv.installed ? '' : ' primary') +
      ' f" data-act="ssinstall" data-arg="' + esc(tv.ip) + '" data-key="ssi-' + esc(tv.ip) + '">' + (tv.installed ? 'Reinstalla' : 'Installa l\'app') + '</button></div>';
  }
  return '<dt>' + esc(name) + '<small class="num">' + esc((tv.model ? tv.model + ' · ' : '') + tv.ip) + '</small></dt><dd>' + state + btn + '</dd>';
}

function ssBody(t) {
  if (!t) return '<p>Il server non risponde in questo momento.</p>';
  var pc = t.pc || '';
  var tvs = t.tvs || [];
  var html = '<p>Le Samsung non hanno Android. BunkerPlex si usa già dal <b>browser della TV</b> (Internet), senza installare niente; ' +
    'l\'app aggiunge l\'icona tra le App e il PC la installa da qui.</p>' +
    '<ol><li>Sulla TV apri <b>App</b>, scrivi <b>1 2 3 4 5</b> col telecomando e accendi <b>Modalità sviluppatore</b>. ' +
      'Come <b>IP del PC host</b> scrivi <b class="num">' + esc(pc || 'l\'IP di questo PC') + '</b>, poi spegni e riaccendi la TV.</li>' +
    '<li>Cerca la TV qui sotto e premi <b>Installa l\'app</b>.</li></ol>';
  if (t.phase && !t.target) html += '<p class="nodot">' + esc(t.message || 'Cerco…') + '</p>';
  else if (t.error) html += '<p class="nodot">' + esc(t.error) + '</p>';
  else if (t.step === 'done') html += '<p class="okdot">' + esc((t.log || []).slice(-1)[0] ? t.log.slice(-1)[0].text : 'Fatto') + '</p>';
  if (tvs.length) html += '<dl class="kv">' + tvs.map(function (tv) { return ssRow(tv, t, pc); }).join('') + '</dl>';
  else if (t.scanned_at && !t.phase) html += '<p>Nessuna TV Samsung trovata nella rete di casa: controlla che sia accesa e sulla stessa rete del PC.</p>';
  html += '<div class="actions" style="margin-top:.8rem">' +
    (t.phase ? '<button class="btn f" data-act="sscancel" data-key="sscancel">Interrompi</button>'
      : '<button class="btn' + (tvs.length ? '' : ' primary') + ' f" data-act="ssscan" data-key="ssscan">' + (t.scanned_at ? 'Cerca di nuovo' : 'Cerca le TV Samsung') + '</button>' +
        '<input class="field f num tvaddr" id="ssaddr" data-key="ssaddr" placeholder="Indirizzo della TV, es. 192.168.1.180" data-enter="ssaddrgo">' +
        '<button class="btn f" data-act="ssaddrgo" data-key="ssaddrgo">Installa</button>') + '</div>';
  if ((t.log || []).length) html += '<div class="tvlogtitle"><h3>Cosa sta succedendo</h3></div>' + tvLog(t);
  html += '<p class="kvnote">Le TV più nuove (dal 2024 circa) possono rifiutare l\'app: vogliono un certificato Samsung fatto per loro. ' +
    'Il browser della TV va bene con tutte.</p>';
  return html;
}

function ssShow(t) {
  var el = document.getElementById('sspanel');
  if (!el) { clearTimeout(ssPoll); ssPoll = null; return; }
  var addr = document.getElementById('ssaddr');
  var keep = addr ? addr.value : '';
  var focused = document.activeElement && document.activeElement.getAttribute('data-key');
  el.innerHTML = '<h2>Installa sulla TV Samsung dal PC</h2>' + ssBody(t);
  addr = document.getElementById('ssaddr');
  if (addr) addr.value = keep;
  if (focused) { var f = el.querySelector('[data-key="' + focused + '"]'); if (f && !f.disabled) f.focus(); }
  var lg = el.querySelector('.tvlog'); if (lg) lg.scrollTop = lg.scrollHeight;
  clearTimeout(ssPoll);
  ssPoll = t && t.phase ? setTimeout(function () { api('/tv/samsung').then(ssShow, function () { ssShow(null); }); }, 1500) : null;
}

function ssSend(path, body) {
  return post('/tv/samsung/' + path, body).then(ssShow, function (e) { toast(e.message); });
}

async function samsungPanel() {
  var t = await api('/tv/samsung').catch(function () { return null; });
  setTimeout(function () { if (t && t.phase) ssShow(t); }, 0);
  return '<div class="panel" id="sspanel"><h2>Installa sulla TV Samsung dal PC</h2>' + ssBody(t) + '</div>';
}

// Indirizzi del PC, ognuno dove serve: quello di casa in «App per TV e telefono»
// (lo usano TV e telefoni), quelli da fuori casa in «PC e dispositivi»
function lanPanel(n) {
  if (!n) return '';
  return '<div class="panel"><h2>Indirizzo di questo PC</h2><dl class="kv">' +
    '<dt>IP privato ' + reachTag('lan') + '<small>nella rete di casa: lo usano TV e telefoni</small></dt><dd class="num">' +
      (n.private ? esc(n.private) + '<small>porta ' + n.port + '</small>' : '<span class="nodot">non lo conosco ancora</span><small>rilancia «Installa BunkerPlex»</small>') + '</dd>' +
    '</dl></div>';
}

function networkPanel(n) {
  if (!n) return '';
  return '<div class="panel" id="addresses"><h2>Indirizzi per fuori casa ' + reachTag('net') + '</h2><dl class="kv">' +
    '<dt>Per gli amici<small>da fuori casa, solo la porta ' + n.friends_port + '</small></dt><dd class="num">' +
      (n.tailnet ? esc(n.tailnet) + '<small>Tailscale integrato</small>'
        : n.friends_open ? esc(n.public) + '<small>porta aperta sul router</small>'
        : '<span class="nodot">nessun accesso da fuori</span><small>si accende in Amici</small>') + '</dd>' +
    '<dt>Per i tuoi dispositivi fuori casa<small>dal browser, con Tailscale acceso sul dispositivo</small></dt><dd class="num">' +
      (n.tailscale ? esc(n.tailscale) + '<small>porta ' + n.port + '</small>'
        : '<span class="nodot">Tailscale non installato sul computer</span><small>l\'app non ne ha bisogno</small>') + '</dd>' +
    '</dl><p class="kvnote">Non aprire mai la ' + n.port + ' sul router: è solo per la rete di casa e per i tuoi dispositivi su Tailscale. ' +
    'L\'app BunkerPlex fuori casa non ne ha bisogno: raggiunge amici e tuoi PC da sola.</p></div>';
}

// I gruppi della Panoramica, come nelle impostazioni dei telefoni: poche righe per
// gruppo, ognuna con piastrella colorata, nome, una riga di spiegazione e lo stato.
// Gruppi che non si mescolano (vedi settingsAreas): l'account (con amici e
// amministrazione), il server aperto (con locale / online), questo dispositivo e gli altri.
var SGROUPS = [['account', ['account', 'tvlink', 'friends', 'admin']],
  ['server', ['libraries', 'catalog', 'pcs', 'updates', 'news']],
  ['device', ['device', 'app', 'notices']], ['others', ['apps']], ['', ['logout']]];

function srowHtml(r, first) {
  var inner = (r.face ? face(r.face, 'mid') : stile(r.area)) +
    '<span class="stext"><b>' + esc(r.label) + '</b>' + (r.desc ? '<small>' + esc(r.desc) + '</small>' : '') + '</span>' +
    (r.tag ? '<span class="sval">' + r.tag + '</span>'
      : r.value ? '<span class="sval' + (r.state ? ' ' + r.state : '') + '">' + esc(r.value) + '</span>' : '');
  // Una riga che fa qualcosa (Esci) e' un pulsante, senza freccia
  if (r.act) {
    return '<button class="srow f act-' + r.area + '"' + (first ? ' data-autofocus' : '') + ' data-act="' + r.act + '" data-key="srow-' + r.area + '">' + inner + '</button>';
  }
  return '<a class="srow f' + (r.face ? ' lead' : '') + '"' + (first ? ' data-autofocus' : '') + ' href="' + (r.href || '#/settings/' + r.area) + '" data-key="srow-' + r.area + '">' +
    inner + CHEVRON + '</a>';
}

// Telefono: le due colonne non ci stanno, l'elenco e' una pagina a se'
function settingsPhone() {
  return !TVLOOK && !!(window.matchMedia && matchMedia('(max-width: 720px)').matches);
}

async function settings() {
  // TV e PC: niente pagina iniziale, subito le due colonne sull'ultima area aperta
  if (!settingsPhone()) {
    var areas = settingsAreas();
    var last = cache.settingsArea;
    if (!areas.some(function (a) { return a[0] === last; })) last = areas.length ? areas[0][0] : 'device';
    location.replace('#/settings/' + last);
    return '';
  }
  var res = await settingsData();
  var rows = settingsRows(res[0], res[2], res[3]);
  var byArea = {};
  rows.forEach(function (r) { byArea[r.area] = r; });
  // Cosa va sistemato si vede nella sua riga (stato in giallo): niente doppioni in cima
  var acc = byArea.account;
  if (acc) byArea.account = { area: 'account', face: acc.face, label: acc.label,
    desc: acc.desc + (acc.value ? ' · ' + acc.value : ''), value: '', state: acc.state };
  var html = '';
  var first = true;
  SGROUPS.forEach(function (g) {
    var list = g[1].map(function (a) { return byArea[a]; }).filter(Boolean);
    if (!list.length) return;
    html += '<section class="sblock">' + (g[0] ? '<h2 class="shead sgh ' + g[0] + '">' + groupHead(g[0]) + '</h2>' : '') + '<div class="sgroup">' +
      list.map(function (r) { var h = srowHtml(r, first); first = false; return h; }).join('') + '</div></section>';
  });
  return '<div class="page settings"><div class="soverview">' +
    '<h1 class="stitle">Impostazioni</h1>' + html + '</div></div>';
}

// Sottotitoli da internet (OpenSubtitles): un riquadro di «Schede e sottotitoli»
function subsPanel(i, inAccount) {
  return '<div class="panel" id="subtitles"><h2>Sottotitoli da internet</h2>' +
    '<p>' + (i.subs_online
      ? dot(true) + ' Attivi' + (i.subs_user ? ' con l\'account ' + esc(i.subs_user) : ' senza account (pochi download al giorno)') + ': nel film apri Opzioni → «Cerca sottotitoli su internet».'
      : 'Non attivi. Con una chiave gratuita di OpenSubtitles scarichi i sottotitoli in italiano o in altre lingue dalle Opzioni del film.') + '</p>' +
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
    '</div></div>';
}

async function settingsArea(area) {
  if (area === 'people') { cache.adminTab = 'users'; location.replace('#/settings/admin'); return ''; }
  if (area === 'admin') return adminArea();
  // Pagine accorpate: i vecchi indirizzi (link, segnalibri) portano a quelle nuove
  if (area === 'subtitles') { location.replace('#/settings/catalog'); return ''; }
  if (area === 'apps' && TV) { location.replace('#/settings/device'); return ''; }
  var res = await settingsData();
  var i = res[0];
  var inAccount = !!(auth && auth.user && auth.user.linked);
  var manyAccounts = !!(auth && auth.profiles && auth.profiles.length > 1);
  var known = SETTINGS_HIDDEN.indexOf(area) >= 0 || settingsAreas().some(function (a) { return a[0] === area; });
  if (!known) { location.replace('#/settings'); return ''; }

  if (area === 'account') return accountArea(i);
  if (area === 'notices') return noticesArea();

  if (area === 'libraries') {
    var libsHtml = libs.map(function (l) {
      var what = [l.movies ? l.movies + ' film' : '', l.shows ? l.shows + ' serie' : ''].filter(Boolean).join(' · ') || 'ancora vuota';
      var k = 'lib-' + l.id;
      if (l.mine === false) {       // raccolta di un altro account di questo PC, condivisa con te
        return '<div class="lib"><div class="head">' + avatar(l.name) +
          '<div class="name"><b>' + esc(l.name) + '</b><small>' + what + ' · condivisa da un altro account di questo PC</small></div></div></div>';
      }
      return '<div class="lib"><div class="head">' + avatar(l.name) +
        '<div class="name"><b>' + esc(l.name) + '</b><small>' + what + (manyAccounts && l.shared ? ' · la vedono anche gli altri account di questo PC' : '') + '</small></div>' +
        (manyAccounts ? '<button class="btn f" data-act="libshare" data-arg="' + l.id + ':' + (l.shared ? 0 : 1) + '" data-key="' + k + '-share">' + (l.shared ? 'Non condividere' : 'Condividi') + '</button>' : '') +
        '<a class="btn f" href="#/browse/' + l.id + '" data-key="' + k + '-add">+ Cartella</a>' +
        '<button class="btn f" data-act="refreshmenu" data-arg="' + l.id + '" data-key="' + k + '-upd">Aggiorna</button>' +
        '<a class="btn f" href="#/rename/' + l.id + '" data-key="' + k + '-ren">Rinomina</a>' +
        '<button class="btn danger f" data-act="dellib" data-arg="' + l.id + '" data-key="' + k + '-del">Elimina</button></div>' +
        // Per bambini: la vedono anche i profili bambini (che vedono solo queste)
        '<div class="libkids">' + swRow('Per bambini', !!l.kids, 'data-act="libkids" data-arg="' + l.id + ':' + (l.kids ? 0 : 1) + '" data-key="' + k + '-kids"',
          l.kids ? 'La vedono anche i profili bambini' : 'I profili bambini non la vedono') + '</div>' +
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
      'Le voci del menu (Film, Serie TV…) con le cartelle di questo PC. BunkerPlex legge soltanto: non tocca mai i tuoi file.',
      '<div class="panel">' + (libsHtml || '<p>Ancora nessuna raccolta su questo PC.</p>') +
      '<div class="actions" style="margin-top:.6rem"><a class="btn primary f" href="#/newlib" data-key="new-lib">+ Aggiungi raccolta</a></div></div>' +
      accountPanelHtml);
  }

  if (area === 'catalog') {
    return settingsShell('catalog', 'Schede e sottotitoli', i.tmdb
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
      '<button class="btn f" data-act="savekey" data-key="savekey">Salva</button></div></div>' +
      subsPanel(i, inAccount));
  }

  // Amici: chi sono, le richieste, la qualita' dei loro video
  if (area === 'friends') {
    var sh = res[3];
    if (!sh) return settingsShell('friends', 'Amici', '', '<div class="panel"><p>La condivisione con gli amici non risponde in questo momento.</p></div>');
    var af = auth.cloud ? await api('/account-friends').catch(function () { return null; }) : null;
    return settingsShell('friends', 'Amici',
      'Guardi le raccolte dei tuoi amici e loro le tue. Si guarda soltanto: nessuno modifica la libreria dell\'altro.',
      accountFriendsPanel(af, sh) +
      '<div class="panel"><h2>Video degli amici</h2>' +
      '<button class="setting f" data-act="friendquality" data-key="friendquality">Qualità<small>' + esc(labelOf(QUALITIES, friendQuality).split(' (')[0]) + '</small></button>' +
      '<p class="kvnote">Viaggiano sulla linea in caricamento di chi condivide: 720p va bene quasi sempre.</p></div>' +
      friendsPanel(sh, !!auth.cloud));
  }

  // I tuoi PC e dispositivi: gli altri PC dell'account, i posti, fuori casa, gli indirizzi
  if (area === 'pcs') {
    var three = await Promise.all([
      auth.cloud ? api('/account-friends').catch(function () { return null; }) : null,
      auth.cloud ? api('/devices').catch(function () { return null; }) : null,
      api('/network').catch(function () { return null; })]);
    return settingsShell('pcs', 'PC e dispositivi',
      'I tuoi altri PC con BunkerPlex, i dispositivi entrati con il tuo account e come raggiungerli fuori casa.',
      myPcsPanel(three[0]) + devicesPanel(three[1]) + awayPanel() + networkPanel(three[2]));
  }

  // Aggiornamenti del server aperto (BunkerPlex sul PC). L'app Android di questo
  // dispositivo ha la sua area («App Android» / «App TV»); la PWA non si aggiorna.
  if (area === 'updates') {
    var u = res[2];
    return settingsShell('updates', 'Aggiorna server', 'Qui si aggiorna BunkerPlex sul PC <b>' + esc(srvLabel()) + '</b>: ' +
        'versione <b class="num">' + esc(serverVer(i)) + '</b>.' +
        (i.updated ? ' <a class="link f" href="#/news" data-key="upd-news">Novità dell\'ultimo aggiornamento</a>' : ''),
      (APP ? '<p class="snote">L\'' + appLabel(true) + ' di ' + (TV ? 'questa TV' : 'questo dispositivo') + ' si aggiorna a parte: ' +
        '<a class="link f" href="#/settings/app" data-key="upd-app">' + deviceTitle() + ' → ' + appLabel() + '</a>' +
        (appOld(i) ? ' <span class="nodot">(c\'è una versione nuova)</span>' : '') + '.</p>' : '') +
      (u && u.enabled ? updatePanel(u, 'Server · ' + srvLabel()) : '<div class="panel"><p>Gli aggiornamenti automatici del server non sono configurati su questo PC.</p></div>') +
      changelogPanel(u));
  }

  // L'app Android installata qui (APK): versione e aggiornamento
  if (area === 'app') {
    return settingsShell('app', appLabel(), 'L\'app BunkerPlex installata su ' + (TV ? 'questa TV' : 'questo dispositivo') + '.',
      appUpdatePanel(i));
  }

  if (area === 'apps') {
    var net = await api('/network').catch(function () { return null; });
    return settingsShell('apps', 'App per TV e telefono', 'L\'app per TV e telefoni Android arriva da questo PC e poi si aggiorna da sola.',
      await publicPanel() + installPanel() + await tvPanel() + await samsungPanel() + await apkPanel('App Android per il telefono') + lanPanel(net));
  }

  // Questo dispositivo: come arriva al server (locale / online) e preferenze di visione
  // (l'app Android ha la sua area; sulla TV anche il QR per il telefono)
  return settingsShell('device', 'Collegamento e visione', '',
    connectionPanel(i) + devicePanel() +
    (TV ? await apkPanel('App sul telefono') : '') + phoneTvPanel());
}

// Il collegamento di questo dispositivo al server aperto: quale, a che indirizzo,
// e se e' locale (stessa rete o questo PC, senza Internet) o online (via Internet)
function connectionPanel(i) {
  var k = hereReach();
  var base = CENTRAL ? C.base : location.origin;
  var change = APP && !CENTRAL ? '<button class="btn f" data-act="resetserver" data-key="resetserver">Cambia server</button>'
    : CENTRAL || (auth && auth.cloud) ? '<a class="btn f" href="#/server" data-key="dev-server">Cambia server</a>' : '';
  return '<div class="panel"><h2>Collegamento</h2>' +
    '<dl class="kv"><dt>Server</dt><dd><b>' + esc(srvLabel()) + '</b><small class="num">' + esc(String(base).replace(/^https?:\/\//, '')) + '</small></dd>' +
    (REACH[k] ? '<dt>Come ci arrivi</dt><dd>' + reachTag(k) + ' ' + esc(REACH[k].how) + '</dd>' : '') + '</dl>' +
    (REACH[k] ? '<p class="kvnote">' + esc(REACH[k].note) + '</p>' : '') +
    (change ? '<div class="actions">' + change + '</div>' : '') + '</div>';
}

// L'app Android installata qui (APK): la sua versione e il suo aggiornamento. Si usa
// nelle impostazioni del server (area «App Android» / «App TV») e in quelle dell'app
// della PWA centrale (#/app, anche senza un server: i = {}).
function appUpdatePanel(i) {
  var latest = appLatest(i), old = appOld(i);
  var where = TV ? 'questa TV' : 'questo dispositivo';
  var can = old && !OLD_TV_APP && typeof tvApp.update === 'function';
  return '<div class="panel"><h2>' + appLabel() + '<small> · ' + where + '</small></h2>' +
    '<dl class="kv"><dt>Versione installata</dt><dd><b class="num">' + esc(appVer()) + '</b>' +
      (old ? ' · <span class="nodot">' + esc(appWhere().toLowerCase() + (latest.name || 'più nuova')) + '</span>' : (latest.code ? ' · aggiornata' : '')) + '</dd></dl>' +
    '<p class="kvnote">Qui si aggiorna solo l\'app installata su ' + where + ', non il server. ' +
      (selfUpdating() ? 'Le versioni nuove arrivano da sole, anche senza aggiornare il server. ' : 'La versione nuova arriva dal server sul PC. ') +
      'Le pagine di BunkerPlex invece non vanno aggiornate: arrivano sempre nuove.</p>' +
    (i.api && serverTooOld(i) ? '<p class="nodot">Questa app è più nuova del server: aggiorna il server (Server → Aggiornamenti) per usare tutte le funzioni.</p>' : '') +
    '<div class="actions">' + (can ? '<button class="btn primary f" data-act="cappupdate" data-key="cappupdate">Aggiorna l\'app</button>' : '') +
      '<button class="btn' + (old && !can ? ' primary' : '') + ' f" data-act="checkupdate" data-key="checkupdate">Controlla aggiornamenti</button></div></div>';
}

// Dall'app Android sul telefono: installa l'app TV sulle TV di casa con adb,
// senza PC (la pagina e' nell'app, tvinstall.html)
function phoneTvOk() {
  try { return PHONE_APP && typeof tvApp.tvInstallSupported === 'function' && tvApp.tvInstallSupported(); } catch (e) { return false; }
}

function phoneTvPanel() {
  if (!phoneTvOk()) return '';
  return '<div class="panel"><h2>App sulla TV</h2>' +
    '<p>Installa BunkerPlex sulla TV direttamente da questo telefono, anche a casa di un amico: sulle TV Android basta accendere una volta il debug, ' +
      'sulle <b>Samsung</b> la Modalità sviluppatore (scheda «TV Samsung»).</p>' +
    '<div class="actions"><button class="btn primary f" data-act="phonetv" data-key="phonetv">Installa sulla TV</button></div></div>';
}

// ---------------------------------------------------------------- App sul telefono (PWA)
// Dal browser del telefono BunkerPlex si mette sulla schermata Home e si apre a
// tutto schermo, con tutte le funzioni del PC. Il browser lo permette solo da una
// pagina sicura (https, o un indirizzo http segnato a mano come sicuro in Chrome).
var installEvt = null;
var STANDALONE = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
var IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
// Safari (e ogni browser su iPhone, che sotto e' Safari): la conversione arriva in HLS
var HLS = !APP && (IOS || (/Safari\//.test(navigator.userAgent) && !/Chrome|Chromium|CriOS|Android|Edg|OPR|Firefox/.test(navigator.userAgent))) &&
  !!document.createElement('video').canPlayType('application/vnd.apple.mpegurl');
window.addEventListener('beforeinstallprompt', function (e) {
  e.preventDefault();
  installEvt = e;
  if (/^#\/settings\/apps/.test(location.hash)) render();
  getAppRefresh();
});
window.addEventListener('appinstalled', function () {
  installEvt = null;
  getAppStore({ installed: Date.now() });
  toast('BunkerPlex è sulla schermata Home');
  if (/^#\/settings\/apps/.test(location.hash)) render();
  getAppRefresh();
});
if (!APP && window.isSecureContext && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(function () {});
}

// Da ovunque: BunkerPlex su un indirizzo https pubblico (Tailscale Funnel, vedi
// /api/public). Col QR iPhone e iPad (o qualsiasi telefono) lo aprono e lo
// mettono sulla schermata Home: funziona in casa e fuori, sempre con il login.
async function publicPanel() {
  var p = await api('/public').catch(function () { return null; });
  if (!p || !p.available || TVLOOK) return '';
  var manage = auth && auth.user && auth.user.linked && !auth.user.guest;
  var body;
  if (p.on && p.url) {
    body = '<div class="apkqr"><div class="qrtile" role="img" aria-label="Codice QR per aprire BunkerPlex da ovunque">' + p.svg + '</div>' +
      '<div class="apktext"><p>Inquadra il QR con la fotocamera del telefono: si apre BunkerPlex, anche fuori casa. ' +
      (IOS ? 'In Safari tocca <b>Condividi</b> → <b>Aggiungi alla schermata Home</b>' : 'Poi dal menu del browser scegli <b>Installa app</b> o <b>Aggiungi a schermata Home</b>') +
      ': diventa un\'app, con il login del tuo account.</p><p class="apkurl num">' + esc(p.url) + '</p></div></div>';
  } else if (p.wanted) {
    body = '<p>' + (p.error ? '<span class="nodot">●</span> ' + esc(p.error) : 'Preparo l\'indirizzo pubblico…') + '</p>';
    if (!p.error) setTimeout(function () { if (/^#\/settings\/apps/.test(location.hash)) render(); }, 5000);
  } else {
    body = '<p>Accendilo per usare BunkerPlex da qualsiasi telefono o browser, anche fuori casa e su iPhone, senza installare niente: ' +
      'un indirizzo https fisso, con un QR da inquadrare. Si entra sempre con nome e password.</p>';
  }
  return '<div class="panel"><h2>Da ovunque</h2>' + body +
    (manage ? '<div class="actions"><button class="btn' + (p.wanted ? '' : ' primary') + ' f" data-act="publictoggle" data-arg="' + (p.wanted ? 0 : 1) + '" data-key="publictoggle">' +
      (p.wanted ? 'Spegni l\'indirizzo pubblico' : 'Accendi l\'indirizzo pubblico') + '</button></div>' : '') + '</div>';
}

function installPanel() {
  if (APP || TVLOOK || STANDALONE) return '';
  var body;
  if (installEvt) {
    body = '<p>Mettila sulla schermata Home: si apre a tutto schermo, come un\'app, con tutte le funzioni.</p>' +
      '<div class="actions"><button class="btn primary f" data-act="pwainstall" data-key="pwainstall">Installa l\'app</button></div>';
  } else if (IOS) {
    body = '<p>In Safari tocca <b>Condividi</b> e poi <b>Aggiungi alla schermata Home</b>: si apre a tutto schermo, come un\'app.</p>';
  } else if (!window.isSecureContext) {
    body = '<p>Questa pagina arriva in http dalla rete di casa: Chrome la mette sulla schermata Home solo come collegamento, che si apre nel browser.</p>' +
      '<p>Per l\'app vera, a tutto schermo, sul telefono Android (una volta sola):</p>' +
      '<ol class="steps"><li>apri <b class="num">chrome://flags</b> in Chrome</li>' +
      '<li>cerca <b>Insecure origins treated as secure</b>, scrivi <b class="num">' + esc(location.origin) + '</b> e scegli <b>Enabled</b></li>' +
      '<li>tocca <b>Relaunch</b>, torna qui e premi <b>Installa l\'app</b></li></ol>' +
      '<p><small>Con Tailscale (indirizzo https) l\'app funziona anche fuori casa, senza cambiare nulla in Chrome.</small></p>';
  } else {
    body = '<p>Nel menu del browser scegli <b>Installa app</b> o <b>Aggiungi a schermata Home</b>: si apre a tutto schermo, come un\'app.</p>';
  }
  return '<div class="panel"><h2>App sulla schermata Home</h2>' + body + '</div>';
}

// ---- Dall'indirizzo pubblico (*.ts.net): l'app giusta per il dispositivo
// Chi apre il server dal suo indirizzo pubblico (Tailscale Funnel) in un browser:
// - Android (telefono e tablet): solo l'app. Al posto di BunkerPlex c'e' la pagina per
//   scaricare l'APK (la copia che tiene il server, /BunkerPlex.apk, anche prima
//   dell'accesso), sempre, anche nella web app installata da Chrome;
// - TV Android (Google TV, Fire TV, Bravia...) col suo browser: lo stesso, con l'app
//   per la TV (/BunkerPlexTV.apk), che e' un'altra app, fatta per il telecomando;
// - iPhone, iPad e computer: il browser va bene, con l'invito a installare la web app
//   (sulla pagina d'accesso una scheda sopra il modulo, dopo l'accesso una barra in
//   basso). «Continua nel browser» la mette da parte per la visita, «Ce l'ho gia'» per
//   un mese. Le altre TV (Samsung, LG...) restano col browser.
// Mai dentro le app (telefono, TV) e mai nella PWA centrale (che non e' su ts.net). La
// pagina che apre il QR di una TV (#/pair) resta raggiungibile anche da Android.
var PUBLIC_HOST = /\.ts\.net$/i.test(location.hostname);
var TV_ANDROID_UA = /Android ?TV|Google ?TV|BRAVIA|\bAFT[A-Z]|\bMiTV|MIBOX|SHIELD Android TV|Chromecast|\bTV Build\b|SmartTV|SMART-TV/i;
var TV_OTHER_UA = /Tizen|Web0S|webOS|NetCast|HbbTV|VIDAA|Roku|PlayStation|Xbox|CrKey|SmartTV|SMART-TV/i;
var GETAPP_DAYS = 30;
var getApp = { started: false, info: null };
var GA_TEXT = {
  android: {
    ico: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="2.5" width="11" height="19" rx="2.2"/><path d="M10.5 18.5h3"/></svg>',
    title: 'Installa l\'app BunkerPlex', sub: 'Su Android BunkerPlex si usa con la sua app: video col player del telefono, e si aggiorna da sola.',
    file: 'BunkerPlex.apk', btn: 'Scarica l\'app' },
  tv: {
    ico: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="6" width="19" height="13" rx="2"/><path d="M8 2.5l4 3.5 4-3.5"/></svg>',
    title: 'Installa BunkerPlex sulla TV', sub: 'Sulla TV BunkerPlex si usa con la sua app, fatta per il telecomando.',
    file: 'BunkerPlexTV.apk', btn: 'Scarica l\'app per la TV' },
  ios: {
    ico: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5v11M8 7.5l4-4 4 4"/><path d="M8.5 10.5h-2v10h11v-10h-2"/></svg>',
    title: 'Metti BunkerPlex sulla schermata Home', sub: 'Si apre a tutto schermo, come un\'app. Niente da scaricare.',
    bar: 'Mettila sulla Home', barsub: 'Si apre come un\'app', btn: 'Come si fa',
    mini: 'Metti BunkerPlex sulla schermata Home', done: 'L\'ho già fatto' },
  pc: {
    ico: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>',
    title: 'Installa BunkerPlex sul computer', sub: 'Si apre nella sua finestra, come un programma. Niente da scaricare.',
    bar: 'Installa BunkerPlex', barsub: 'Si apre come un programma', btn: 'Installa',
    mini: 'Installa BunkerPlex sul computer', done: 'L\'ho già installata' }
};
var GA_DOWN = '<svg class="ic line" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14"/></svg>';
var GA_X = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';

function getAppKind() {
  if (APP || !PUBLIC_HOST) return '';
  var ua = navigator.userAgent;
  if (/Android/i.test(ua)) return TV_ANDROID_UA.test(ua) ? 'tv' : 'android';
  if (STANDALONE || TVLOOK || TV_OTHER_UA.test(ua)) return '';
  if (IOS) return 'ios';
  return /Mobi/i.test(ua) ? '' : 'pc';
}

// Android e TV Android: dal browser niente BunkerPlex, solo l'app
function getAppOnly() {
  var kind = getAppKind();
  return kind === 'android' || kind === 'tv';
}

function getAppStore(add) {
  var s = {};
  try { s = JSON.parse(localStorage.getItem('fpGetApp')) || {}; } catch (e) { /* niente */ }
  if (add) {
    Object.keys(add).forEach(function (k) { s[k] = add[k]; });
    try { localStorage.setItem('fpGetApp', JSON.stringify(s)); } catch (e) { /* niente */ }
  }
  return s;
}
// Aperta come web app installata: il browser se lo ricorda (sul computer e' lo stesso)
if (!APP && STANDALONE) getAppStore({ installed: Date.now() });

// iPhone e computer: '' = da mostrare, 'later' = messo da parte per la visita, 'done' = c'e' gia'
function getAppState() {
  var s = getAppStore();
  if (s.installed || (s.done && Date.now() - s.done < GETAPP_DAYS * 864e5)) return 'done';
  try { if (sessionStorage.getItem('fpGetApp') === 'later') return 'later'; } catch (e) { /* niente */ }
  return '';
}

function getAppSteps(kind) {
  var ua = navigator.userAgent;
  if (kind === 'android') {
    return ['Tocca <b>Scarica l\'app</b>. Se Chrome chiede conferma, scegli <b>Scarica comunque</b>.',
      'Apri <b>BunkerPlex.apk</b> dalla notifica o da <b>Download</b>. Se Android lo blocca, tocca <b>Impostazioni</b>, ' +
        'accendi <b>Consenti da questa origine</b> e torna indietro: <b>Installa</b>.',
      'Apri <b>BunkerPlex</b>, entra con il tuo account e scegli questo server.'];
  }
  if (kind === 'tv') {
    return ['Premi <b>Scarica l\'app per la TV</b>.',
      'Apri <b>BunkerPlexTV.apk</b> dai download e scegli <b>Installa</b>. Se la TV lo blocca, nelle sue impostazioni ' +
        'consenti a questo browser di installare le <b>app sconosciute</b> e riprova.',
      'Apri <b>BunkerPlex</b> sulla TV e collegala dal telefono: la TV entra da sola.'];
  }
  if (kind === 'ios') {
    var share = '<b>Condividi</b> ' + GA_TEXT.ios.ico;
    return ['Tocca ' + share + (/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua) ? ' nel menu del browser.'
        : ' nella barra di Safari (se non lo vedi, è nel menu <b>⋯</b>).'),
      'Scegli <b>Aggiungi alla schermata Home</b> (scorri l\'elenco se non c\'è), poi <b>Aggiungi</b>.',
      'Apri <b>BunkerPlex</b> dalla schermata Home ed entra con il tuo account.'];
  }
  var first;
  if (/Edg\//.test(ua)) first = 'Nel menu <b>⋯</b> di Edge scegli <b>App</b> → <b>Installa BunkerPlex</b>.';
  else if (/Firefox\//.test(ua)) first = 'Firefox non installa le app: apri questo indirizzo in <b>Chrome</b> o <b>Edge</b> e scegli <b>Installa</b>.';
  else if (/Safari\//.test(ua) && !/Chrome|Chromium|OPR/.test(ua)) first = 'Nel menu <b>File</b> di Safari scegli <b>Aggiungi al Dock</b>.';
  else first = 'Premi l\'icona di installazione a destra nella barra degli indirizzi, o cerca <b>Installa BunkerPlex</b> nel menu <b>⋮</b> del browser.';
  return [first, 'Apri <b>BunkerPlex</b> come un programma ed entra con il tuo account.'];
}

function getAppHead(t) {
  return '<div class="gahead"><span class="gaico">' + t.ico + '</span><div><b>' + t.title + '</b><small>' + t.sub + '</small></div></div>';
}

function getAppList(kind) {
  return '<ol class="gasteps">' + getAppSteps(kind).map(function (s) { return '<li>' + s + '</li>'; }).join('') + '</ol>';
}

// Android e TV Android: la pagina che prende il posto di BunkerPlex
function getAppOnlyCard(kind) {
  var t = GA_TEXT[kind];
  var info = getApp.info || {};
  var missing = kind === 'tv' ? info.tv_apk_version === 0 : info.apk === false;
  var note = getApp.started
    ? '<p class="ganote">Download avviato: ' + (kind === 'tv' ? 'aprilo dai download del browser.' : 'lo trovi nelle notifiche o in <b>Download</b>.') + '</p>'
    : missing ? '<p class="ganote warn">Il server sta ancora prendendo l\'app: se il download non parte, riprova tra qualche minuto.</p>' : '';
  return '<div class="getapp only">' + getAppHead(t) +
    '<a class="btn primary block f" data-autofocus href="/' + t.file + '" download="' + t.file + '" data-apk data-key="gaapk">' + GA_DOWN + t.btn + '</a>' +
    note + getAppList(kind) +
    '<p class="gaafter">' + (kind === 'tv'
      ? 'Se il browser non scarica, usa l\'app <b>Downloader</b> con l\'indirizzo <b class="num">' + esc(location.origin + '/' + t.file) + '</b>'
      : 'Hai già l\'app? Aprila dalle app del telefono: su Android BunkerPlex non si usa dal browser.') + '</p></div>';
}

// iPhone e computer: la scheda (sheet false sulla pagina d'accesso, true nella finestra aperta dalla barra)
function getAppCard(kind, sheet) {
  var t = GA_TEXT[kind];
  var steps = true;
  var main = '';
  if (kind === 'pc' && installEvt) {
    main = '<button class="btn primary block f" data-act="gainstall" data-key="gainstall">Installa l\'app</button>';
    steps = false;
  }
  return '<div class="getapp' + (sheet ? ' insheet' : '') + '">' + getAppHead(t) + main + (steps ? getAppList(kind) : '') +
    '<div class="garow"><button class="galink f" data-act="gadone" data-key="gadone">' + t.done + '</button>' +
    '<button class="galink f" data-act="galater" data-key="galater">Continua nel browser</button></div></div>';
}

// Il posto sulla pagina d'accesso (e sulla pagina dell'app per Android): la scheda, o una riga se messa da parte
function getAppSlot() {
  var kind = getAppKind();
  var inner = '';
  if (getAppOnly()) inner = getAppOnlyCard(kind);
  else if (kind) {
    var st = getAppState();
    inner = st === 'done' ? '' : st === 'later'
      ? '<button class="gamini f" data-act="gashow" data-key="gashow">' + GA_TEXT[kind].ico + '<span>' + GA_TEXT[kind].mini + '</span></button>'
      : getAppCard(kind, false);
  }
  return '<div id="gaslot">' + inner + '</div>';
}

// Al posto di ogni pagina, su Android (la chiama gate)
async function getAppPage() {
  if (!getApp.info) getApp.info = await api('/info').catch(function () { return {}; });
  return authShell(getAppSlot());
}

function getAppSheet() {
  var kind = getAppKind();
  if (!kind || getAppOnly()) return;
  modal.classList.remove('corner', 'friendsnow');
  modalState = { getapp: true, returnFocus: document.activeElement };
  modal.innerHTML = '<div class="sheet gasheet">' + getAppCard(kind, true) + '</div>';
  modal.hidden = false;
  var first = modal.querySelector('.btn') || modal.querySelector('.f');
  if (first) first.focus();
}

// iPhone e computer dopo l'accesso: la barra in basso (nascosta sulle pagine d'accesso e durante i video).
// Chiusa con la X («Non ora») resta solo la sua icona, tonda in basso a destra: un clic e torna la barra.
function markGetApp() {
  if (!currentHash) return;          // prima pagina non ancora disegnata
  var kind = getAppKind();
  var st = kind && !getAppOnly() ? getAppState() : 'done';
  var on = st !== 'done';
  var mini = st === 'later';
  var bar = document.getElementById('getapp');
  document.body.classList.toggle('gaon', on && !mini);
  if (!on) { if (bar) bar.hidden = true; return; }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'getapp';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'App BunkerPlex');
    document.body.appendChild(bar);
  }
  var t = GA_TEXT[kind];
  bar.classList.toggle('mini', mini);
  if (mini) {
    bar.innerHTML = '<button class="gaico gare f" data-act="gashow" data-key="gashow" aria-label="' + esc(t.mini) + '" title="' + esc(t.mini) + '">' + t.ico + '</button>';
    bar.hidden = false;
    return;
  }
  bar.innerHTML = '<span class="gaico">' + t.ico + '</span><span class="gatxt"><b>' + t.bar + '</b><small>' + t.barsub + '</small></span>' +
    '<button class="btn primary small f" data-act="gaopen" data-key="gaopen">' + t.btn + '</button>' +
    '<button class="gax f" data-act="galater" data-key="gax" aria-label="Non ora" title="Non ora">' + GA_X + '</button>';
  bar.hidden = false;
}

function getAppRefresh() {
  var slot = document.getElementById('gaslot');
  if (slot) slot.outerHTML = getAppSlot();
  if (modalState && modalState.getapp) {
    var kind = getAppKind();
    if (!kind || getAppState()) closeModal();
    else modal.firstChild.innerHTML = getAppCard(kind, true);
  }
  markGetApp();
}

// Il pulsante dell'APK scarica da se' (link vero): poi si dice dove trovarlo
document.addEventListener('click', function (e) {
  if (!(e.target.closest && e.target.closest('[data-apk]'))) return;
  setTimeout(function () { getApp.started = true; getAppRefresh(); }, 150);
});

// ---- Notifiche su telefoni e tablet
// Gli avvisi dell'account (nuovi titoli, amici, aggiornamenti) li manda il servizio
// account, e arrivano dentro BunkerPlex: basta permettere le notifiche.
//  - App Android: Firebase Cloud Messaging (l'app chiede il permesso e manda il suo
//    gettone al servizio). APK senza Firebase: l'app controlla ogni 15 minuti circa.
//  - PWA (iPhone e iPad dalla schermata Home, browser dei PC): notifiche push del
//    browser, ricevute dal service worker di BunkerPlex (sw.js).
// La vecchia pagina «BP Avvisi» continua a funzionare per chi l'aveva, ma non si propone piu'.
var NOTICE_KINDS = [['titles', 'Nuovi film ed episodi sui tuoi PC'], ['friends_titles', 'Novità sui PC dei tuoi amici'],
  ['friends', 'Richieste di amicizia'], ['update', 'Aggiornamenti del server']];

function noticeWhen(t) {
  return new Date(t * 1000).toLocaleString('it-IT', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

var NOTICE_INTRO = '<p>Ricevi un avviso appena arrivano film ed episodi nuovi, da te o dagli amici, e per amicizie e aggiornamenti. ' +
  'Funziona anche fuori casa.</p>';

function noticeHereHtml() {
  if (PHONE_APP && typeof tvApp.noticesState === 'function') return noticeAppHtml();
  if (APP) return '<p>Questa versione dell\'app non mostra ancora le notifiche: aggiornala da Impostazioni → Aggiornamenti.</p>';
  return noticePwaHtml();
}

// App Android
function noticeAppHtml() {
  var st = tvCall('noticesState');
  var fresh = typeof tvApp.noticesPush === 'function';   // APK con le notifiche dentro l'app (Firebase)
  var fcm = fresh && tvCall('noticesPush');
  var test = fresh ? '<button class="btn f" data-act="noticetest" data-key="noticetest">Manda una prova</button>' : '';
  var off = '<button class="btn f" data-act="noticeoff" data-key="noticeoff">Spegni su questo dispositivo</button>';
  if (st === 'push') {
    return '<p>' + dot(true) + ' Attive su questo dispositivo: gli avvisi arrivano subito, anche con l\'app chiusa.</p>' +
      '<div class="actions">' + test + off + '</div>';
  }
  if (st === 'denied') {
    return '<p>' + dot(false) + ' Android non permette all\'app di mostrare notifiche.</p>' +
      '<div class="actions"><button class="btn primary f" data-act="noticeperm" data-key="noticeperm">Apri le impostazioni di Android</button>' +
      '<button class="btn f" data-act="noticeoff" data-key="noticeoff">Spegni</button></div>';
  }
  if (st === 'on') {
    return '<p>' + dot(true) + ' Attive su questo dispositivo: per ora l\'app controlla gli avvisi ogni 15 minuti circa, ' +
      'e Android per risparmiare batteria a volte li fa arrivare più tardi.</p>' +
      (fcm ? '<p><small>Diventano istantanee da sole appena il servizio account è pronto.</small></p>'
        : '<p><small>' + (fresh ? 'Questa versione dell\'app è senza notifiche istantanee.' : 'Aggiorna l\'app per riceverli subito.') + '</small></p>') +
      '<div class="actions">' + test + off + '</div>';
  }
  return NOTICE_INTRO +
    '<div class="actions"><button class="btn primary f" data-act="noticeon" data-arg="android" data-key="noticeon">Attiva le notifiche</button></div>';
}

// PWA: il browser riceve le notifiche push nel service worker di BunkerPlex.
// Il suo indirizzo degli avvisi (…/avvisi/<gettone>) e la chiave VAPID restano qui
// (off: spente con «Spegni», si riaccendono con lo stesso dispositivo dell'account).
function pushSaved() {
  try {
    var d = JSON.parse(localStorage.getItem('bpPush'));
    return d && d.url && d.key ? d : null;
  } catch (e) { return null; }
}
function pushSave(d) {
  try { if (d) localStorage.setItem('bpPush', JSON.stringify(d)); else localStorage.removeItem('bpPush'); } catch (e) { /* niente */ }
}
function pushSupported() {
  return !APP && window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}
function pushWhat() {
  if (!IOS) return 'dispositivo';
  return /iPad/.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && !/iPhone/.test(navigator.userAgent)) ? 'iPad' : 'iPhone';
}

function noticePwaHtml() {
  if (!pushSupported()) {
    if (IOS && !STANDALONE) {
      return '<p>Su ' + pushWhat() + ' le notifiche arrivano a BunkerPlex aggiunto alla schermata Home (serve iOS 16.4 o più recente):</p>' +
        '<ol class="steps"><li>In Safari tocca <b>Condividi</b> → <b>Aggiungi alla schermata Home</b></li>' +
        '<li>Apri <b>BunkerPlex</b> dalla schermata Home</li>' +
        '<li>Torna qui e tocca «Attiva le notifiche»</li></ol>';
    }
    return '<p>' + dot(false) + ' Questo browser non riceve notifiche' + (window.isSecureContext ? '' : ' da questo indirizzo (serve https)') + '.</p>' +
      '<p><small>Sul telefono Android le attivi dall\'app BunkerPlex; su iPhone e iPad da BunkerPlex sulla schermata Home.</small></p>';
  }
  var perm = Notification.permission;
  if (perm === 'denied') {
    return '<p>' + dot(false) + ' Il browser blocca le notifiche di BunkerPlex.</p><p><small>' +
      (IOS ? 'Riattivale da Impostazioni → Notifiche → BunkerPlex.' : 'Riattivale dalle impostazioni del sito (il lucchetto accanto all\'indirizzo), poi torna qui.') +
      '</small></p>';
  }
  var dev = pushSaved();
  if (perm === 'granted' && dev && !dev.off) {
    return '<p>' + dot(true) + ' Attive su questo ' + pushWhat() + ': gli avvisi arrivano subito, anche con BunkerPlex chiuso.</p>' +
      '<div class="actions"><button class="btn f" data-act="noticetest" data-key="noticetest">Manda una prova</button>' +
      '<button class="btn f" data-act="noticeoff" data-key="noticeoff">Spegni su questo dispositivo</button></div>';
  }
  return NOTICE_INTRO +
    '<div class="actions"><button class="btn primary f" data-act="noticeon" data-arg="push" data-key="noticeon">Attiva le notifiche</button></div>';
}

// Le chiamate del dispositivo al servizio account (vale il gettone nell'indirizzo)
function pushCall(dev, path, method, body) {
  return fetch(dev.url + path, { method: method, headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined }).catch(function () {
    throw new Error('Il servizio account non risponde: controlla la connessione');
  }).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (j) {
      if (!r.ok) {
        var err = new Error(j.detail || ('Errore ' + r.status));
        err.status = r.status;
        throw err;
      }
      return j;
    });
  });
}

// Il permesso (nelle versioni vecchie di Safari si chiede con una funzione di ritorno)
function pushAsk() {
  return new Promise(function (done) {
    var p = Notification.requestPermission(done);
    if (p && p.then) p.then(done, function () { done('denied'); });
  });
}

function pushKeyBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(s + '==='.slice((s.length + 3) % 4)), function (c) { return c.charCodeAt(0); });
}

// L'iscrizione del browser con la chiave del servizio (una vecchia con un'altra chiave si rifà)
async function pushSubscribe(reg, key) {
  var bytes = pushKeyBytes(key);
  var sub = await reg.pushManager.getSubscription();
  var had = sub && sub.options && sub.options.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null;
  if (sub && had && (had.length !== bytes.length || had.some(function (b, i) { return b !== bytes[i]; }))) {
    await sub.unsubscribe();
    sub = null;
  }
  return sub || reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
}

async function pushNewDevice() {
  var kind = IOS ? 'ios' : 'web';
  var r = await noticeApi('POST', '/notices/devices', { kind: kind, label: noticeLabel(kind), open: location.origin + '/' });
  if (!r.key) throw new Error('Il servizio account va aggiornato per le notifiche dentro BunkerPlex');
  return { url: r.url, key: r.key };
}

async function pushOn() {
  // Il permesso subito, dentro il tocco (Safari lo chiede)
  var perm = await pushAsk();
  if (perm !== 'granted') { render(); return; }
  toast('Attivo le notifiche…');
  await navigator.serviceWorker.register('sw.js');
  var reg = await navigator.serviceWorker.ready;
  var dev = pushSaved();
  dev = dev ? { url: dev.url, key: dev.key } : await pushNewDevice();
  var sub = await pushSubscribe(reg, dev.key);
  try {
    await pushCall(dev, '/push', 'POST', sub.toJSON());
  } catch (e) {
    if (e.status !== 401) throw e;
    dev = await pushNewDevice();             // dispositivo tolto dall'account: uno nuovo
    await pushCall(dev, '/push', 'POST', sub.toJSON());
  }
  pushSave(dev);
  toast('Notifiche attive su questo dispositivo');
  render();
}

async function pushOff() {
  var dev = pushSaved();
  if (dev) pushSave({ url: dev.url, key: dev.key, off: true });
  try {
    var reg = await navigator.serviceWorker.getRegistration();
    var sub = reg && await reg.pushManager.getSubscription();
    if (sub) await sub.unsubscribe();
  } catch (e) { /* niente */ }
  if (dev) await pushCall(dev, '/push', 'DELETE').catch(function () {});
}

// All'apertura: l'iscrizione del browser e' ancora quella che conosce il servizio
// (il browser puo' cambiarla, il servizio la toglie se scade)
function pushSync() {
  var dev = pushSaved();
  if (!dev || dev.off || !pushSupported() || Notification.permission !== 'granted') return;
  navigator.serviceWorker.ready.then(function (reg) { return pushSubscribe(reg, dev.key); })
    .then(function (sub) { return pushCall(dev, '/push', 'POST', sub.toJSON()); })
    .catch(function (e) { if (e && e.status === 401) { pushSave(null); render(); } });
}
if (pushSupported()) setTimeout(pushSync, 5000);

// Prima le notifiche dell'app Android arrivavano dalla pagina «BP Avvisi» aperta in Chrome
// (dispositivo «… · Chrome»): ora arrivano all'app, e quel dispositivo di questo telefono si
// toglie, se no ogni avviso arriverebbe due volte. Solo se ce n'e' uno: non si indovina.
function noticeDropChrome() {
  var had = false;
  try { had = localStorage.getItem('bpChromePush') === '1'; localStorage.removeItem('bpChromePush'); } catch (e) { /* niente */ }
  if (!had) return;
  noticesData().then(function (d) {
    var old = (d.devices || []).filter(function (v) { return v.kind === 'web' && / · Chrome$/.test(v.label || ''); });
    if (old.length === 1) return noticeApi('DELETE', '/notices/devices/' + old[0].id);
  }).catch(function () { /* resta nell'elenco: si toglie a mano */ });
}

// L'app Android avvisa quando cambia lo stato (permesso dato, Firebase pronto) o com'e' andata la prova
window.fpNoticePerm = function () { if (/^#\/(app|settings\/notices)/.test(location.hash)) render(); };
window.fpNoticeTest = function (err) { toast(err || 'Prova partita: tra poco arriva la notifica'); };

// Gli avvisi stanno nel servizio account. Nella PWA centrale (e nell'app, che la usa)
// si chiedono a lui direttamente con il gettone dell'account: funziona anche prima di
// scegliere un server, dentro il server di un amico e con un server di casa vecchio.
// Dal server di casa (browser) passano dal server, come prima.
function noticeApi(method, path, body) {
  if (CENTRAL) return cloud(method, path, body);
  return method === 'GET' ? api(path) : send(method, path, body);
}

function noticesLinked() {
  return CENTRAL ? !!C.token : !!(auth && auth.user && auth.user.linked);
}

async function noticesData() {
  if (!CENTRAL) return api('/notices');
  if (!C.token) return { linked: false };
  var r = await Promise.all([cloud('GET', '/notices/prefs'), cloud('GET', '/notices/devices'),
    cloud('GET', '/notices').catch(function () { return {}; })]);
  return { linked: true, prefs: r[0].prefs || {}, devices: r[1].devices || [], notices: r[2].notices || [] };
}

function noticesError(e) {
  return '<div class="panel"><p>' + dot(false) + ' ' +
    esc(e.status === 404 ? 'Il servizio account non conosce ancora le notifiche: va aggiornato.' : e.message) + '</p></div>';
}

async function noticesArea() {
  var d;
  try { d = await noticesData(); } catch (e) {
    return settingsShell('notices', 'Notifiche', '', noticesError(e));
  }
  if (!d.linked) { location.replace('#/settings/account'); return ''; }
  return settingsShell('notices', 'Notifiche', 'Avvisi sul telefono e sul tablet, anche fuori casa.', noticesPanels(d, true));
}

// I pannelli delle notifiche (full: anche l'elenco degli avvisi)
function noticesPanels(d, full) {
  var prefs = d.prefs || {};
  // Ogni tipo di avviso: una riga con l'interruttore a destra, come nelle app del telefono
  var kinds = NOTICE_KINDS.map(function (k) {
    var on = prefs[k[0]] !== false;
    return swRow(k[1], on, 'data-act="noticepref" data-arg="' + k[0] + ':' + (on ? 0 : 1) + '" data-key="npref-' + k[0] + '"');
  }).join('');
  var devs = (d.devices || []).map(function (v) {
    var what = v.kind === 'android' ? 'App Android' : v.kind === 'ios' ? 'iPhone / iPad' : 'Browser';
    var st = v.kind === 'android' ? (v.fcm ? 'notifiche istantanee' : v.last_seen ? 'controllo ogni 15 minuti circa, ultimo ' + noticeWhen(v.last_seen)
      : 'in attesa del primo controllo') : v.push ? 'notifiche attive' : 'spente';
    return '<div class="lib"><div class="head">' + avatar(v.label || what) + '<div class="name"><b>' + esc(v.label || what) + '</b><small>' +
      esc(what + ' · ' + st) + '</small></div><button class="btn danger f" data-act="noticedel" data-arg="' + v.id + '" data-key="ndel-' + v.id + '">Togli</button></div></div>';
  }).join('');
  var news = d.notices || [];
  var list = noticeRows(news, 'pgn-');
  return '<div class="panel"><h2>Su questo dispositivo</h2>' + noticeHereHtml() + '</div>' +
    '<div class="panel"><h2>Cosa ti avvisa</h2>' + kinds + '</div>' +
    '<div class="panel"><h2>Dispositivi con le notifiche</h2>' + (devs || '<p>Ancora nessuno.</p>') +
      ((d.devices || []).length > 1 ? '<p><small>Se un avviso arriva due volte, togli il dispositivo che non usi più ' +
        '(per esempio la vecchia pagina «BP Avvisi» o Chrome sul telefono).</small></p>' : '') + '</div>' +
    (full ? '<div class="panel"><h2>Avvisi' + (unreadNotices(news) ? ' · ' + unreadNotices(news) + ' da leggere' : '') + '</h2>' +
      (unreadNotices(news) ? '<div class="actions"><button class="btn f" data-act="noticeall" data-key="pgnall">Segna tutte come lette</button></div>' : '') +
      (list ? '<div class="nlist">' + list + '</div>' : '<p>Ancora nessun avviso.</p>') + '</div>' : '');
}

// Il nome del dispositivo nell'elenco delle notifiche (deviceLabel e' quello di Amministrazione)
function noticeLabel(kind) {
  var ua = navigator.userAgent;
  var m = /Android [\d.]+; ([^;)]+?)(?: Build|\))/.exec(ua);
  if (kind === 'android') return m && m[1] !== 'K' ? m[1].trim() : 'Telefono Android';
  if (kind === 'ios') return /iPad/.test(ua) || (navigator.maxTouchPoints > 1 && !/iPhone/.test(ua)) ? 'iPad' : 'iPhone';
  return /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
}

function accountArea(i) {
  var u = auth.user, s = syncState();
  var many = (auth.profiles || []).length > 1;
  var who = claimPanel() + '<div class="panel who">' + face(u.name, 'big') +
    '<div class="whotext"><h2>' + esc(u.name) + '</h2>' +
    '<p>' + (u.linked ? (u.admin ? 'Account amministratore' : 'Account') : 'Su questo PC, senza account') + ' · ' + esc(auth.server || 'BunkerPlex') + '</p>' +
    '<p class="sync ' + s.state + '">' + esc(s.text) + '</p></div></div>';
  // Esci / togli: solo dove c'e' un altro account in cui entrare (o il servizio per entrarci)
  var leave = !auth.cloud ? '' : '<div class="panel"><h2>Su questo dispositivo</h2><div class="actions">' +
      '<button class="btn f" data-act="logout" data-key="logout">' + (many ? 'Cambia account' : 'Esci') + '</button>' +
      (many ? '<button class="btn danger f" data-act="delprofile" data-key="delprofile">Togli l\'account da questo PC</button>' : '') +
    '</div></div>';
  if (!u.linked) {
    var join = !auth.cloud ? '' : '<div class="panel"><h2>Entra con un account</h2>' +
      '<p>Funziona tutto anche senza: il login è facoltativo. Con un account visti, lista e raccolte ti seguono su ogni PC e TV, ' +
      'anche su un\'installazione nuova, e riprendi esattamente da dove eri:</p>' +
      '<dl class="kv"><dt>Impostazioni e chiavi</dt><dd>TMDB, sottotitoli, preferenze di visione</dd>' +
      '<dt>Visti, ripresa e La mia lista</dt><dd>Anche quelli fatti senza Internet, appena torna la rete</dd>' +
      '<dt>Raccolte</dt><dd>Nomi e cartelle, ritrovate da sole sugli altri PC</dd>' +
      '<dt>Amici</dt><dd>La condivisione delle raccolte con gli amici</dd></dl>' +
      '<p class="kvnote">Quello che hai già qui non si perde: si unisce a quello dell\'account, e per ogni voce vince la modifica più recente.</p>' +
      (auth.offline ? '<p><span class="nodot">●</span> Ora il PC non raggiunge il servizio account: per entrare serve Internet.</p>' :
        // Sulla TV la password non si scrive: si entra dal telefono
        (TVLOGIN ? '<div class="actions"><a class="btn primary f" href="#/tvlogin" data-key="tvlogin">Entra dal telefono</a></div>'
          : accountForm('', false))) +
      '</div>';
    return settingsShell('account', 'Account', '', who + watchersPanel(u) + join);
  }

  // Entrati da casa senza Internet non c'e' niente da ridare: si aspetta la rete
  var relogin = u.online || u.home ? '' : '<div class="panel"><h2>Ridai la password</h2>' +
    '<p>L\'account è stato aperto con una password diversa (cambiata su un altro PC, o nuova provvisoria). ' +
    'Qui funziona tutto lo stesso; per riprendere la sincronizzazione ' + (TVLOGIN ? 'rientra dal telefono.</p>' +
      '<div class="actions"><a class="btn primary f" href="#/tvlogin" data-key="tvrelogin">Entra dal telefono</a></div>'
      : 'scrivi la password.</p>' + accountForm(u.name, true)) + '</div>';
  var tvlink = TVLOGIN || u.guest ? '' : '<div class="panel"><h2>Collega una TV</h2><p>Sulla TV compare un codice: scrivilo qui e la TV entra con il tuo account. ' +
    'Anche Samsung, LG e le altre senza Android, dal loro browser: in <b>Collega una TV</b> trovi come.</p>' +
    '<div class="actions"><a class="btn primary f" href="#/tv" data-key="totv">Collega una TV</a></div></div>';
  // Cosa segue l'account (chiavi, preferenze, visti, raccolte) lo dice la riga sotto il
  // nome; Amministrazione sta nella Panoramica: qui solo quello che si fa con l'account
  return settingsShell('account', 'Account', '', who + relogin + watchersPanel(u) + tvlink +
    '<div class="panel"><h2>Accesso</h2>' +
      '<p class="kvnote">Ogni dispositivo (browser, telefono, TV) entra con la sua password. Chiavi, preferenze, visti, La mia lista e raccolte ti seguono su ogni PC.</p>' +
      '<div class="actions">' +
        (TVLOGIN || !u.online ? '' : '<a class="btn f" href="#/password" data-key="pwchange">Cambia password</a>') +
      '</div>' + emailPanel(u) + googlePanel(u) + (u.linked ? secBox() : '') +
      (u.manager && !u.home ? '<h2 style="margin-top:1.2rem">Senza Internet</h2>' +
        swRow('Chi è in casa entra senza password', auth.home_offline !== false,
          'data-act="homeoff" data-arg="' + (auth.home_offline !== false ? 0 : 1) + '" data-key="homeoff"',
          'Solo quando questo PC non raggiunge Internet, solo dalla rete di casa, e senza cambiare le impostazioni') : '') +
      '</div>' + leave);
}

// Email dell'account: per entrare con email e password al posto del nome utente
function emailPanel(u) {
  if (!u.online && !u.email) return '';
  var head = '<h2 style="margin-top:1.2rem">Email</h2>' +
    (u.email ? '<p>Puoi entrare anche con <b>' + esc(u.email) + '</b> e la tua password.</p>'
      : '<p>Aggiungi la tua email: poi su ogni PC, TV e telefono entri con email e password, oltre che col nome utente.</p>');
  if (!u.online || TVLOGIN) return head;
  return head + '<div class="joined"><input class="field f" id="uemail" data-key="uemail" type="email" autocomplete="email" autocapitalize="none" maxlength="120" placeholder="nome@esempio.it" value="' + esc(fieldValue('uemail') || u.email || '') + '">' +
    '<button class="btn f" data-act="emailsave" data-key="emailsave">Salva</button></div>';
}

// Accesso con Google dell'account: collegato o da collegare
function googlePanel(u) {
  if (!auth.google && !u.google) return '';
  if (u.google) {
    return '<h2 style="margin-top:1.2rem">Google</h2><p>Puoi entrare con <b>' + esc(u.google) + '</b>, senza password.</p>' +
      '<div class="actions"><button class="btn f" data-act="gunlink" data-key="gunlink">Scollega Google</button></div>';
  }
  if (!u.online || TVLOGIN) return '';
  return '<h2 style="margin-top:1.2rem">Google</h2><p>Collega il tuo account Google: poi su ogni PC, TV e telefono entri con quello, senza scrivere la password.</p>' +
    '<div class="actions"><a class="btn f" href="#/google/link" data-key="glink">Collega Google</a></div>';
}

// ---------------------------------------------------------------- Amministrazione
// Due ruoli per tutta BunkerPlex: base (guarda e gestisce le sue cose) e
// amministratore (gestisce tutto). Amministrazione ha cinque schede.
var ADMIN_TABS = [['home', 'Riepilogo'], ['users', 'Utenti'], ['access', 'Accessi'], ['net', 'Server e rete'], ['server', 'Questo server']];

function when(sec) {
  return sec ? new Date(sec * 1000).toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
}

function deviceLabel(d) {
  d = String(d || '');
  return { tv: 'TV', browser: 'Browser', phone: 'Telefono', app: 'App' }[d] || d || 'Dispositivo';
}

// Pezzi di Amministrazione: un numero grande con la sua piastrella, una sezione (titolo,
// una riga di spiegazione, elenco), lo stato di un servizio
function akpi(area, value, label, sub) {
  return '<div class="akpi">' + stile(area) + '<b class="num">' + esc(value) + '</b><span>' + esc(label) + '</span>' +
    (sub ? '<small>' + esc(sub) + '</small>' : '') + '</div>';
}

function asection(title, note, rows, empty) {
  return '<div class="panel asec"><h2>' + title + '</h2>' + (note ? '<p class="anote">' + note + '</p>' : '') +
    (rows ? '<div class="accts">' + rows + '</div>' : '<p class="aempty">' + esc(empty || 'Nessuno.') + '</p>') + '</div>';
}

function astate(on, yes, no) {
  return '<span class="achip ' + (on ? 'ok' : 'warn') + '">' + esc(on ? yes : no) + '</span>';
}

// Le azioni su un account, tutte in un menu: la riga resta pulita (e col telecomando
// e' una pressione sola per arrivarci)
function accMenu(id) {
  var a = (cache.accounts || []).filter(function (x) { return String(x.id) === String(id); })[0];
  if (!a) return;
  var isMe = a.username.toLowerCase() === auth.user.name.toLowerCase();
  var invited = /^invito-[0-9a-f]{6}$/i.test(a.username);
  var opts = [];
  if (!isMe) opts.push({ value: 'accrole', label: a.admin ? 'Rendi base' : 'Rendi amministratore' });
  if (!isMe) opts.push({ value: 'accactive', label: a.disabled ? 'Riattiva' : 'Disattiva' });
  opts.push({ value: 'accemail', label: a.email ? 'Cambia email' : 'Aggiungi email' });
  if (a.must_change && (a.email || a.google)) opts.push({ value: 'acclink', label: 'Copia link di attivazione' });
  opts.push({ value: 'accreset', label: invited ? 'Rimanda l\'invito' : 'Nuova password provvisoria' });
  if (!isMe) opts.push({ value: 'accremove', label: invited ? 'Annulla invito' : 'Elimina account' });
  openPicker(invited ? (a.email || a.username) : a.username, opts, null, function (v) { actions[v](a.id); });
}

async function adminArea() {
  if (!adminHere()) { location.replace('#/settings'); return ''; }
  var tab = cache.adminTab || 'home';
  var data, list = null, sess = null, err = '';
  try {
    var calls = [api('/admin/overview')];
    if (tab === 'users') calls.push(api('/accounts'));
    if (tab === 'access') calls.push(api('/admin/sessions').catch(function (e) { return { error: e.message }; }));
    var res = await Promise.all(calls);
    data = res[0];
    if (tab === 'users') list = res[1];
    if (tab === 'access') sess = res[1];
  } catch (e) {
    return settingsShell('admin', 'Amministrazione', '', '<div class="panel"><p>' + dot(false) + ' ' + esc(e.message) + '</p></div>');
  }
  cache.admin = data;
  var c = data.cloud, srv = data.server;
  var tabs = '<div class="atabs" role="tablist">' + ADMIN_TABS.map(function (t) {
    return '<button class="atab f' + (t[0] === tab ? ' on' : '') + '" role="tab" aria-selected="' + (t[0] === tab) + '" data-act="admintab" data-arg="' + t[0] + '" data-key="atab-' + t[0] + '">' + esc(t[1]) + '</button>';
  }).join('') + '</div>';
  var cloudNote = data.cloud_error ? '<div class="panel"><p>' + dot(false) + ' ' + esc(data.cloud_error) + '</p></div>' : '';
  var body = '';

  if (tab === 'home') {
    var n = c ? c.counts : null;
    // Cosa chiede attenzione: righe gialle che portano dove si sistema
    var todo = [];
    if (n && n.temp) todo.push(['users', n.temp === 1 ? 'Un account con la password provvisoria' : n.temp + ' account con la password provvisoria']);
    if (n && n.disabled) todo.push(['users', n.disabled === 1 ? 'Un account disattivato' : n.disabled + ' account disattivati']);
    if (n && n.pending) todo.push(['net', n.pending === 1 ? 'Una richiesta di amicizia in attesa' : n.pending + ' richieste di amicizia in attesa']);
    if (srv.update) todo.push(['upd', 'Aggiornamento del server disponibile']);
    var todoHtml = todo.length ? '<div class="atodo">' + todo.map(function (t, k) {
      return t[0] === 'upd'
        ? '<a class="atodorow f" href="#/settings/updates" data-key="atodo-' + k + '"><span class="salic">!</span><span>' + esc(t[1]) + '</span>' + CHEVRON + '</a>'
        : '<button class="atodorow f" data-act="admintab" data-arg="' + t[0] + '" data-key="atodo-' + k + '"><span class="salic">!</span><span>' + esc(t[1]) + '</span>' + CHEVRON + '</button>';
    }).join('') + '</div>' : '';
    body = (n ? '<div class="akpis">' +
        akpi('people', n.users, 'Account', n.admins + (n.admins === 1 ? ' amministratore' : ' amministratori') + ' · ' + n.base + ' base') +
        akpi('active', n.active, 'Attivi', 'negli ultimi 7 giorni') +
        akpi('pcs', n.servers, 'Server', 'pubblicati') +
        akpi('device', n.devices, 'Dispositivi', 'nella rete') +
      '</div>' + todoHtml +
      '<div class="panel asec"><h2>Servizi</h2><dl class="kv">' +
        '<dt>Entra con Google</dt><dd>' + astate(c.services.google, 'Attivo', 'Non configurato') + '</dd>' +
        '<dt>Rete Tailscale di BunkerPlex</dt><dd>' + astate(c.services.tailscale, 'Attiva', 'Non configurata') + '</dd>' +
        '<dt>Accessi aperti</dt><dd class="num">' + n.sessions + '</dd>' +
        '<dt>Amicizie</dt><dd class="num">' + n.friends + '</dd>' +
      '</dl></div>' : cloudNote) +
      '<div class="panel asec"><h2>Questo server · ' + esc(srv.name) + '</h2><dl class="kv">' +
        '<dt>Versione</dt><dd><span class="num">' + esc(srv.release || '—') + '</span>' + (srv.update ? ' ' + astate(false, '', 'Aggiornamento disponibile') : '') + '</dd>' +
        '<dt>Aggiornamento automatico</dt><dd>' + astate(srv.auto_update, 'Attivo', 'Spento') + '</dd>' +
        '<dt>Condivisione con gli amici</dt><dd>' + astate(srv.share, 'Attiva', 'Spenta') + '</dd>' +
        '<dt>Raccolte</dt><dd class="num">' + srv.libraries + '</dd>' +
        '<dt>Account entrati qui</dt><dd class="num">' + srv.users.length + '</dd>' +
      '</dl></div>' +
      '<div class="actions"><button class="btn primary f" data-act="admintab" data-arg="users" data-key="adm-invite">Invita una persona</button>' +
        '<a class="btn f" href="#/settings/updates" data-key="adm-upd">Aggiornamenti</a></div>';
  }

  if (tab === 'users') {
    cache.accounts = list;
    var me = auth.user.name.toLowerCase();
    var rows = list.map(function (a) {
      var isMe = a.username.toLowerCase() === me;
      var invited = /^invito-[0-9a-f]{6}$/i.test(a.username);
      var title = invited ? (a.email || a.username) : a.username;
      // Lo stato piu' importante in una pastiglia; il resto in una riga piccola
      var status = a.disabled ? '<span class="achip warn">Disattivato</span>'
        : invited ? '<span class="achip warn">Invitato</span>'
        : a.must_change ? '<span class="achip warn">Password provvisoria</span>' : '';
      var meta = [a.last_seen ? 'Ultimo accesso ' + ago(a.last_seen) : (invited ? 'Non ha ancora attivato l\'account' : 'Non è ancora entrato')];
      if (a.email && !invited) meta.push(a.email);
      if (a.google) meta.push(a.google_linked ? 'Google collegato' : 'Google da collegare');
      if (a.servers) meta.push(a.servers + (a.servers === 1 ? ' accesso aperto' : ' accessi aperti'));
      return '<div class="acct urow' + (a.disabled ? ' off' : '') + '">' + face(title, 'mid') +
        '<div class="ptext"><b>' + esc(title) + '</b>' +
          (isMe ? '<span class="achip">Tu</span>' : '') +
          '<span class="achip' + (a.admin ? ' admin' : '') + '">' + (a.admin ? 'Amministratore' : 'Base') + '</span>' + status +
          '<small>' + esc(meta.join(' · ')) + '</small></div>' +
        '<div class="pacts"><button class="btn f" data-act="accmenu" data-arg="' + a.id + '" data-key="accm-' + a.id + '">Gestisci</button></div>' +
        (cache.editEmail === a.id ? '<div class="joined aedit"><input class="field f" id="acmail-' + a.id + '" data-key="acmail-' + a.id + '" type="email" autocapitalize="none" maxlength="120" placeholder="Vuota per toglierla" value="' + esc(a.email || '') + '" data-enter="accemailsave">' +
          '<button class="btn f" data-act="accemailsave" data-arg="' + a.id + '" data-key="acmails-' + a.id + '">Salva</button></div>' : '') +
        '</div>';
    }).join('');
    cache.newAdmin = false;
    body = '<div class="panel asec ainvite"><h2>Invita una persona</h2>' +
        '<p class="anote">' + (auth.reset ? 'Le arriva un link per attivare l\'account' : 'Ti mostro una password provvisoria da comunicare') +
          ': sceglie nome e password (o entra con Google) ed è dentro. Il link puoi anche copiarlo da «Gestisci».</p>' +
        '<div class="inline"><input class="field f" id="agoogle" data-key="agoogle" type="email" autocomplete="off" autocapitalize="none" placeholder="nome@esempio.it" data-enter="acccreate">' +
          '<button class="btn primary f" data-act="acccreate" data-key="acccreate">Manda l\'invito</button></div>' +
        '<button class="setting f" data-act="accadmin" data-key="accadmin">Ruolo<small id="accadminv">Base</small></button></div>' +
      asection(list.length + ' account',
        '<b>Base</b> guarda e gestisce le sue cose; <b>Amministratore</b> gestisce tutta BunkerPlex. Un account disattivato non entra più finché non lo riattivi.',
        rows, 'Nessun account.');
  }

  if (tab === 'access') {
    var rowsA = sess && sess.sessions ? sess.sessions.map(function (x) {
      return '<div class="acct">' + face(x.username, 'mid') + '<div class="ptext"><b>' + esc(x.username) + '</b><span class="pill">' + esc(x.device || 'Server') + '</span>' +
        '<small>Entrato il ' + when(x.created) + ' · ultimo uso ' + ago(x.last_seen) + '</small></div>' +
        '<div class="pacts"><button class="btn danger f" data-act="admsess" data-arg="' + x.id + '" data-key="asess-' + x.id + '">Chiudi</button></div></div>';
    }).join('') : '';
    var rowsL = srv.sessions.map(function (x) {
      return '<div class="acct">' + face(x.name || '?', 'mid') + '<div class="ptext"><b>' + esc(x.name || 'Account tolto') + '</b><span class="pill">' + esc(deviceLabel(x.device)) + '</span>' +
        '<small>Entrato il ' + when(x.created) + ' · ultimo uso ' + ago(x.last_seen) + '</small></div>' +
        '<div class="pacts"><button class="btn danger f" data-act="admlsess" data-arg="' + x.id + '" data-key="alsess-' + x.id + '">Chiudi</button></div></div>';
    }).join('');
    body = (sess && sess.error ? '<div class="panel"><p>' + dot(false) + ' ' + esc(sess.error) + '</p></div>'
        : asection('Server collegati agli account', 'Ogni server in cui un account è entrato. Chiudendolo smette di sincronizzare finché non si rientra con la password.',
          rowsA, 'Nessun accesso aperto.')) +
      asection('Su questo server', 'Browser, TV e telefoni entrati in ' + esc(srv.name) + '. Chiudendone uno, lì si torna a «Chi guarda?».', rowsL, 'Nessun accesso.');
  }

  if (tab === 'net') {
    if (!c) body = cloudNote;
    else {
      var srvRows = c.servers.map(function (x) {
        return '<div class="acct"><div class="ptext"><b>' + esc(x.name || x.sid) + '</b><span class="pill">' + esc(x.username) + '</span>' +
          (x.friends ? '<span class="pill">Condiviso con gli amici</span>' : '<span class="pill">Solo i suoi PC</span>') +
          '<small>' + esc(x.url) + (x.lan ? ' · in casa ' + esc(x.lan) : '') + ' · aggiornato ' + ago(x.t) + '</small></div>' +
          '<div class="pacts"><button class="btn danger f" data-act="admsrv" data-arg="' + x.user_id + ':' + esc(x.sid) + '" data-key="asrv-' + esc(x.sid) + '-' + x.user_id + '">Togli dalla rubrica</button></div></div>';
      }).join('');
      var devRows = c.devices.map(function (x) {
        return '<div class="acct"><div class="ptext"><b>' + esc(x.label || x.host) + '</b><span class="pill">' + esc(x.username || '—') + '</span>' +
          '<span class="pill">' + (x.kind === 'app' ? 'App' : 'PC') + '</span><small>' + esc(x.host) + ' · entrato ' + ago(x.t) + '</small></div></div>';
      }).join('');
      var frRows = c.friendships.map(function (x) {
        return '<div class="acct"><div class="ptext"><b>' + esc(x.ua) + ' ↔ ' + esc(x.ub) + '</b>' +
          (x.status === 'ok' ? '<span class="pill">Amici</span>' : '<span class="pill warn">In attesa</span>') + '<small>' + ago(x.t) + '</small></div>' +
          '<div class="pacts"><button class="btn danger f" data-act="admfr" data-arg="' + x.a + ':' + x.b + '" data-key="afr-' + x.a + '-' + x.b + '">Togli</button></div></div>';
      }).join('');
      body = asection('Server pubblicati', 'I server che si fanno trovare dagli amici o dagli altri PC dello stesso account.', srvRows, 'Nessuno.') +
        asection('Dispositivi nella rete', 'PC e app entrati nella rete Tailscale di BunkerPlex (al massimo 4 per account).', devRows, 'Nessuno.') +
        asection('Amicizie', '', frRows, 'Nessuna.');
    }
  }

  if (tab === 'server') {
    var uRows = srv.users.map(function (x) {
      return '<div class="acct">' + face(x.name, 'mid') + '<div class="ptext"><b>' + esc(x.name) + '</b>' +
        (x.owner ? '<span class="pill">Proprietario</span>' : '') +
        (x.linked ? '<span class="pill">' + (x.admin ? 'Amministratore' : 'Base') + '</span>' : '<span class="pill">Senza account</span>') +
        (x.disabled ? '<span class="pill warn">Disattivato</span>' : x.linked && !x.online ? '<span class="pill warn">Non sincronizza</span>' : '') +
        '<small>Ultimo ingresso ' + ago(x.last_login) + ' · ' + x.sessions + (x.sessions === 1 ? ' accesso' : ' accessi') + '</small></div>' +
        (x.owner || x.id === auth.user.id ? '' : '<div class="pacts"><button class="btn danger f" data-act="admluser" data-arg="' + x.id + '" data-key="aluser-' + x.id + '">Togli da questo server</button></div>') +
        '</div>';
    }).join('');
    var gRows = srv.guests.map(function (x) {
      return '<div class="acct"><div class="ptext"><b>' + esc(x.name) + '</b>' + (x.approved ? '<span class="pill">Accettato</span>' : '<span class="pill warn">Da accettare</span>') +
        '<small>' + (x.last_seen ? 'Ultima visita ' + ago(x.last_seen) : 'Mai entrato') + '</small></div></div>';
    }).join('');
    body = '<div class="panel asec"><h2>' + esc(srv.name) + '</h2><dl class="kv">' +
        '<dt>Versione</dt><dd class="num">' + esc(srv.release || '—') + '</dd>' +
        '<dt>Aggiornamento automatico</dt><dd>' + astate(srv.auto_update, 'Attivo', 'Spento') + '</dd>' +
        '<dt>Condivisione con gli amici</dt><dd>' + astate(srv.share, 'Attiva', 'Spenta') + '</dd></dl>' +
        '<label class="flabel" for="pcname" style="margin-top:1rem">Nome del server</label>' +
        '<div class="joined"><input class="field f" id="pcname" data-key="pcname" maxlength="30" value="' + esc(srv.name) + '">' +
          '<button class="btn f" data-act="admpcname" data-key="admpcname">Salva</button></div>' +
        // Icona o immagine con cui lo vedete tu e i tuoi amici nella scelta del server
        (CENTRAL && C.sid && C.role === 'owner' && !kidsNow()
          ? '<p class="flabel" style="margin-top:1rem">Aspetto nella scelta del server</p>' +
            '<div class="actions"><button class="btn f" data-act="cmylook" data-key="adm-look">Icona o immagine</button></div>' : '') +
        '<div class="actions"><a class="btn f" href="#/settings/updates" data-key="adm-upd2">Aggiornamenti</a>' +
          '<a class="btn f" href="#/settings/libraries" data-key="adm-libs">Raccolte</a>' +
          '<a class="btn f" href="#/settings/catalog" data-key="adm-cat">Schede</a>' +
          '<a class="btn f" href="#/settings/friends" data-key="adm-fr">Amici</a>' +
          '<a class="btn f" href="#/settings/pcs" data-key="adm-pcs">PC e rete</a>' +
          '<button class="btn f" data-act="scan" data-key="adm-scan">Cerca file nuovi</button></div></div>' +
      asection('Account entrati qui', 'Chi togli da qui non perde l\'account: può rientrare. Le sue raccolte passano al proprietario.', uRows, 'Nessuno.') +
      (gRows ? asection('Amici che entrano da fuori', '', gRows) : '');
  }

  return settingsShell('admin', 'Amministrazione', 'Gestisci tutta BunkerPlex. Sei <b>amministratore</b>.', tabs + body);
}

// Amici: due BunkerPlex in case diverse si mostrano a vicenda le raccolte.
// Si manda una richiesta, l'altro la accetta, e da li' in poi fa tutto da solo.
var QUALITIES = [['720', '720p (consigliata: leggera per la linea dell\'amico)'], ['1080', '1080p'], ['orig', 'Originale (serve una linea molto veloce)']];

function whenSeen(sec) {
  if (!sec) return 'mai collegato';
  var d = new Date(sec * 1000);
  return 'ultimo accesso ' + d.toLocaleDateString('it-IT') + ' alle ' + d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
}

// Come si arriva a questo server da fuori casa: di solito il Tailscale dentro
// BunkerPlex; se il servizio account non lo offre, la porta aperta sul router
// I tuoi altri PC (stesso account): le loro raccolte si vedono da qui, prima
// dalla rete di casa e, fuori casa, da Tailscale.
var myPcNames = {};

// Aggiorna un altro tuo PC passando da questo (rete di casa o Tailscale): decide
// quel PC, e lo permette solo se lì il padrone sei tu
function updateMyPc(n) {
  var name = myPcNames[n] || 'il tuo altro PC';
  toast('Controllo gli aggiornamenti di ' + name + '…');
  post('/my-pcs/' + n + '/update/check').then(function (u) {
    if (u.old) { toast(name + ' ha una versione di prima: aggiornalo una volta da lì'); return; }
    if (u.can_update === false) { toast('Solo il proprietario di ' + name + ' può aggiornarlo'); return; }
    if (!u.enabled) { toast('Su ' + name + ' gli aggiornamenti non sono configurati'); return; }
    if (u.phase === 'pc' || u.phase === 'installing' || u.phase === 'restarting') { toast(name + ' si sta già aggiornando'); return; }
    if (u.error) { toast(name + ': ' + u.error); return; }
    if (!u.available) { toast(name + ' è aggiornato' + (u.release ? ' (versione ' + u.release + ')' : '')); return; }
    openPicker('Su ' + name + ' c\'è un aggiornamento' + updateWhat(u) + '. Installarlo adesso? Il server si riaccende da solo: se qualcuno sta guardando un film, si interrompe.',
      [{ value: 'yes', label: 'Aggiorna ora' }, { value: 'no', label: 'Più tardi' }], 'yes', function (answer) {
        if (answer !== 'yes') return;
        post('/my-pcs/' + n + '/update/install').then(function () {
          toast('Aggiornamento avviato su ' + name + ': torna disponibile in qualche minuto');
        }, function (e) { toast(e.message); });
      });
  }, function (e) { toast(e.message); });
}

function myPcsPanel(af) {
  if (!af || !af.linked || af.supported === false || !af.mine) return '';
  var rows = af.mine.map(function (m) {
    var st = m.online === false ? dot(false) + ' ' + esc(m.error || 'spento o non raggiungibile')
      : m.online ? dot(true) + ' collegato' + (m.route === 'lan' ? ' nella stessa rete ' + reachTag('lan')
        : m.route === 'tailscale' ? ' via Internet (Tailscale) ' + reachTag('net') : m.route ? ' via Internet ' + reachTag('net') : '')
        : 'collegamento in corso…';
    myPcNames[m.n] = m.name || 'il tuo altro PC';
    var upd = m.online && m.n != null
      ? '<button class="btn f" data-act="pcupd" data-arg="' + m.n + '" data-key="pcupd-' + m.n + '">Aggiorna il server</button>' : '';
    return '<div class="folder"><div class="where"><b>' + esc(m.name || 'Il tuo altro PC') + '</b><small>' + st + '</small></div>' + upd + '</div>';
  }).join('');
  var state = !af.self_reach ? 'Da qui non vedi le raccolte degli altri tuoi PC, e loro non vedono quelle di qui'
    : af.reachable ? 'Ogni PC dove sei entrato vede le raccolte degli altri accesi'
      : 'Gli altri tuoi PC non raggiungono ancora questo (Tailscale in avvio)';
  return '<div class="panel"><h2>I tuoi PC</h2>' +
    (af.self_reach ? (rows ? '<div class="lib">' + rows + '</div>' : '<p>Nessun altro PC acceso con il tuo account, per ora.</p>') : '') +
    swRow('Raggiungi le tue raccolte dagli altri tuoi PC', !!af.self_reach, 'data-act="afself" data-arg="' + (af.self_reach ? 0 : 1) + '" data-key="afself"', state) +
    '<p class="kvnote">' + reachTag('lan') + ' nella stessa rete: più veloce, anche senza Internet. ' + reachTag('net') +
      ' via Internet con Tailscale, cifrato. Solo i PC dove sei entrato con il tuo account.</p></div>';
}

// I dispositivi dell'account nella rete di BunkerPlex: PC e app fuori casa, al massimo 4.
// Togliere libera subito il posto; se questo PC aspetta un posto, si sceglie chi esce.
function devicesLabel(d) {
  var kind = d.kind === 'pc' ? 'PC' : 'App';
  var st = d.online ? dot(true) + ' collegato' : dot(false) + ' spento';
  return { kind: kind, st: st };
}

function devicesPanel(dv) {
  if (!dv || !dv.devices) return '';
  var rows = dv.devices.map(function (d) {
    var l = devicesLabel(d);
    var btn = d.this ? '' : dv.waiting
      ? '<button class="btn f" data-act="devreplace" data-arg="' + esc(d.id) + '" data-key="dev-' + esc(d.id) + '">Togli e fai entrare questo PC</button>'
      : '<button class="btn danger f" data-act="devdel" data-arg="' + esc(d.id) + '" data-key="dev-' + esc(d.id) + '">Togli</button>';
    return '<div class="folder"><div class="where"><b>' + esc(d.label) + (d.this ? ' · questo PC' : '') + '</b><small>' + l.kind + ' · ' + l.st + '</small></div>' + btn + '</div>';
  }).join('');
  return '<div class="panel"><h2>I tuoi dispositivi<small> · ' + dv.devices.length + ' di ' + (dv.limit || 4) + '</small></h2>' +
    (dv.waiting ? '<p>' + dot(false) + ' Questo PC non è entrato nella rete di BunkerPlex: l\'account ha già ' + (dv.limit || 4) +
      ' dispositivi. Scegli quale togliere.</p>' : '') +
    (rows ? '<div class="lib">' + rows + '</div>' : '<p>Nessun dispositivo nella rete, per ora.</p>') +
    '<p class="kvnote">I PC e le app (telefono, tablet, TV fuori casa) con cui raggiungi amici e tuoi PC. Ogni account ne ha al massimo ' +
    (dv.limit || 4) + ': togline uno per far posto a un altro. Le app si tolgono da sole poco dopo che le chiudi.</p></div>';
}

// Fuori casa: cosa serve, in breve
function awayPanel() {
  return '<div class="panel"><h2>Fuori casa</h2>' +
    '<p><b>Con l\'app</b> (telefono, tablet, TV in un\'altra casa): se in casa non c\'è un server BunkerPlex, l\'app propone gli amici e i tuoi PC accesi. ' +
    'Entri con il tuo account e non serve installare altro: occupa uno dei tuoi posti tra i dispositivi finché è aperta.</p>' +
    '<p><b>Dal browser</b>: serve Tailscale acceso sul dispositivo, con lo stesso account del computer, e l\'indirizzo Tailscale del PC (qui sotto, «Indirizzi per fuori casa»).</p></div>';
}

// Popup quando questo PC non entra nella rete perche' l'account ha gia' 4 dispositivi
function openDevicesPopup() {
  api('/devices').then(function (dv) {
    var opts = (dv.devices || []).filter(function (d) { return !d.this; }).map(function (d) {
      var l = devicesLabel(d);
      return { value: d.id, label: d.label + ' · ' + l.kind + (d.online ? ' · collegato' : ' · spento') };
    });
    opts.push({ value: '', label: 'Non ora' });
    openPicker('Hai già ' + (dv.limit || 4) + ' dispositivi nella rete di BunkerPlex: quale togli per far entrare questo PC?', opts, '', function (id) {
      if (!id) return;
      toast('Tolgo il dispositivo e faccio entrare questo PC…');
      post('/devices/replace', { id: id }).then(function () { toast('Fatto: questo PC è nella rete di BunkerPlex'); render(); },
        function (e) { toast(e.message); });
    });
  }, function () { /* servizio account non raggiungibile: resta la notifica */ });
}

function reachState(sh) {
  var pm = sh.portmap || {}, tn = sh.tailnet || {};
  if (!sh.on) return 'Condivisione spenta: da fuori non entra nessuno.';
  if (sh.manual) return dot(true) + ' Gli amici ti raggiungono a <b>' + esc(sh.address) + '</b> (indirizzo scritto a mano).';
  if (tn.on) return dot(true) + ' Collegato alla rete degli amici con il Tailscale integrato (<b>' + esc(tn.ip) + '</b>): niente porte da aprire sul router.';
  if (tn.running && !tn.error && !(pm.ok && pm.public)) return 'Mi collego alla rete degli amici…';
  if (sh.tailscale) return dot(true) + ' Gli amici ti raggiungono con il Tailscale installato sul computer (<b>' + esc(sh.address) + '</b>).';
  if (pm.ok && pm.public) return dot(true) + ' Tailscale integrato non disponibile: uso la porta aperta sul router (' + esc(pm.method) + '), <b>' + esc(sh.address) + '</b>.';
  if (tn.error && tn.supported !== false) return dot(false) + ' Non riesco a collegarmi alla rete degli amici: ' + esc(tn.error) + '. Riprovo da solo.';
  if (!sh.auto_port) return 'Apertura della porta sul router spenta: scrivi tu il tuo indirizzo quando mandi una richiesta.';
  if (pm.error) return dot(false) + ' Tailscale integrato non disponibile e il router non apre la porta da solo: ' + esc(pm.error) + '.';
  return 'Mi collego alla rete degli amici…';
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
    return head + '<p><span class="nodot">●</span> Il servizio account va aggiornato per gli amici dell\'account.</p></div>';
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
    ? (af.published ? 'I tuoi amici vedono le tue raccolte' : 'Gli amici non ti raggiungono ancora')
    : 'I tuoi amici non vedono le tue raccolte (tu vedi le loro)';
  return head +
    (received ? '<div class="lib"><div class="head"><div class="name"><b>Richieste da accettare</b></div></div>' + received + '</div>' : '') +
    (friends ? '<div class="lib">' + friends + '</div>' : '<p>Ancora nessun amico.</p>') +
    (sent ? '<div class="lib"><div class="head"><div class="name"><b>In attesa</b></div></div>' + sent + '</div>' : '') +
    '<label class="flabel" for="afname">Aggiungi un amico: il nome del suo account BunkerPlex</label>' +
    '<div class="inline"><input class="field f" id="afname" data-key="afname" data-enter="afadd" autocomplete="off" maxlength="32" placeholder="Nome dell\'account">' +
    '<button class="btn primary f" data-act="afadd" data-key="afadd">Manda la richiesta</button></div>' +
    swRow('Condividi le tue raccolte con i tuoi amici', !!af.sharing, 'data-act="afshare" data-arg="' + (af.sharing ? 0 : 1) + '" data-key="afshare"', sharing) +
    (af.sharing && sh ? '<p>' + reachState(sh) + '</p>' : '') +
    (af.sharing ? '<label class="flabel" for="pcname">Nome di questo PC (gli amici lo vedono se condividi da più PC)</label>' +
      '<div class="inline"><input class="field f" id="pcname" data-key="pcname" data-enter="pcname" autocomplete="off" maxlength="30" value="' + esc(af.pc) + '">' +
      '<button class="btn f" data-act="pcname" data-key="pcname-save">Salva</button></div>' : '') +
    swRow('Mostra agli amici cosa stai guardando', af.share_activity !== false,
      'data-act="afactivity" data-arg="' + (af.share_activity !== false ? 0 : 1) + '" data-key="afactivity"',
      af.share_activity !== false ? 'Accanto al tuo nome vedono il titolo che hai in riproduzione' : 'Gli amici vedono solo se sei online') +
    '<p class="kvnote">Gli amici vedono solo le tue raccolte e possono soltanto guardare. Il collegamento è cifrato e il servizio account garantisce che dall\'altra parte ci sia davvero il loro server.</p></div>';
}

// Il sistema di prima, con indirizzo e password: completo solo senza servizio
// account; con il servizio si vedono soltanto i vecchi collegamenti rimasti.
function friendsPanel(sh, cloud) {
  if (!sh) return '';
  var pending = sh.accounts.filter(function (a) { return !a.approved; });
  var guests = sh.accounts.filter(function (a) { return a.approved && a.via !== 'account'; });
  shareRequests = pending.length;
  markRequests();
  var old = friends.filter(function (fr) { return fr.via !== 'account'; });
  if (cloud && !pending.length && !guests.length && !old.length) return '';

  var asks = pending.map(function (a) {
    return '<div class="folder"><div class="where"><b>' + esc(a.name) + ' chiede di condividere le raccolte</b><small>' +
      (a.back_url ? 'Se accetti lui vede le tue e tu vedi le sue (' + esc(a.back_url) + ').' : 'Se accetti lui vede le tue raccolte.') + '</small></div>' +
      '<button class="btn primary f" style="margin-right:.5rem" data-act="accapprove" data-arg="' + a.id + ':1" data-key="acc-ok-' + a.id + '">Accetta</button>' +
      '<button class="btn f" data-act="accdel" data-arg="' + a.id + '" data-key="acc-no-' + a.id + '">Rifiuta</button></div>';
  }).join('');

  var mine = old.map(function (fr) {
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

  var lists = (asks ? '<div class="lib"><div class="head"><div class="name"><b>Richieste da approvare</b></div></div>' + asks + '</div>' : '') +
    (mine ? '<div class="lib"><div class="head"><div class="name"><b>Le raccolte che vedi</b></div></div>' + mine + '</div>' : '') +
    (seen ? '<div class="lib"><div class="head"><div class="name"><b>Chi vede le tue</b></div></div>' + seen + '</div>' : '');
  if (cloud) {
    return '<div class="panel"><h2>Vecchi collegamenti con indirizzo e password</h2>' +
      '<p>Fatti con il sistema di prima: funzionano ancora, e qui li puoi sospendere o togliere. I nuovi amici si aggiungono col nome del loro account, qui sopra.</p>' +
      lists + '</div>';
  }
  return '<div class="panel"><h2>Amici</h2>' +
    '<p>Uno dei due manda la richiesta, l\'altro la accetta: da quel momento, quando il PC dell\'amico è acceso, le sue raccolte compaiono nel menu e nella Home. ' +
    'Si guarda soltanto: nessuno può modificare la libreria dell\'altro.</p>' + lists +
    swRow('Porta per gli amici su questo PC', !!sh.on, 'data-act="sharetoggle" data-arg="' + (sh.on ? 0 : 1) + '" data-key="sharetoggle"',
      sh.on ? 'Aperta' : 'Chiusa: nessun amico può entrare né mandare richieste') +
    swRow('Apri da solo la porta sul router', !!sh.auto_port, 'data-act="shareport" data-arg="' + (sh.auto_port ? 0 : 1) + '" data-key="shareport"',
      sh.auto_port ? '' : 'Scrivi tu il tuo indirizzo, per esempio quello di Tailscale') +
    '<p>' + reachState(sh) + '</p>' +
    // Dalla TV non si scrivono indirizzi e password: la richiesta si manda dal PC
    (TV ? '<p>Per collegare un amico apri <b>http://' + esc(location.host) + '</b> dal browser di un PC: qui sulla TV non serve nessun accesso.</p></div>' :
    '<h2 style="margin-top:1.4rem">Manda una richiesta</h2>' +
    '<p>Fatti dare dall\'amico il suo indirizzo: lo legge in Impostazioni → PC e dispositivi, sul suo BunkerPlex. ' +
    'Il tuo viene trovato da solo quando la porta sul router è aperta; se non ci riesce, usate <b>Tailscale</b> su entrambi i PC e scrivete quegli indirizzi.</p>' +
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
  return '<div class="panel"><h2>Preferenze di visione</h2>' +
    '<p>Animazioni e locandine seguono il tuo ' + (auth && auth.user && auth.user.linked ? 'account' : 'PC') +
      ' su ogni TV, telefono e PC dove entri. Restano di questo dispositivo solo l\'aspetto da TV e il riconoscimento dei dispositivi lenti.</p>' +
    '<button class="setting f" data-act="devanim" data-key="devanim">Animazioni<small>' + labelOf(ANIMS, device.anim) + auto + '</small></button>' +
    '<button class="setting f" data-act="devposters" data-key="devposters">Locandine nelle raccolte<small>' + labelOf(POSTERS, device.posters) + '</small></button>' +
    (TV ? '' : swRow('Aspetto da TV', TVLOOK, 'data-act="devtv" data-key="devtv"',
      SMART_TV ? 'Acceso da solo su questa smart TV' : 'Per il browser di una smart TV')) +
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

async function play(id, fromStart, at) {
  var p;
  try { p = await api('/play/' + id); } catch (e) {
    if (e.data && e.data.missing) missingBox(e.data.missing); else toast(e.message);
    return;
  }
  if (fromStart) p.start = 0;
  if (at > 0) p.start = at;
  // Il player dell'app TV si fa vivo col server con questo nome: dal telefono lo si comanda (Guarda su)
  if (TV && castId) { p.cast_id = castId; p.cast_name = tvName(); }
  if (APP) { if (CENTRAL) p.server_base = C.base; tvApp.play(JSON.stringify(p)); return; }
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
        '<div class="ptitle"><b>' + esc(p.title) + '</b>' + (p.subtitle || p.quality ? '<span>' +
          (p.subtitle ? '<em>' + esc(p.subtitle) + '</em>' : '') + (p.quality ? '<i class="pq">' + esc(p.quality) + '</i>' : '') +
          '</span>' : '') + '</div>' +
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
          (canCast() && !p.friend ? '<button class="pbtn" data-p="cast" data-tip="Guarda su una TV" aria-label="Guarda su una TV">' + IC.cast + '</button>' : '') +
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
    height: 0, bw: 0, stalls: [], qcool: 0, lastLoad: 0,
    lastT: -1, lastMove: Date.now(), recov: 0, recovAt: 0, fatal: false, endAt: null, sleepAt: 0, sleepEnd: false,
    introOn: false, introOff: false, card: false, cardOff: false, cardLeft: 10
  };
  p.intro_start = p.intro_start || 0; p.intro_end = p.intro_end || 0; p.credits = p.credits || 0;
  // Se questo dispositivo sa decodificare il video originale (es. H.265), il PC lo
  // copia cosi' com'e' invece di ricodificarlo: quasi nessun lavoro per il processore.
  st.vcopy = canDecode(v, p.vcodec, p.bits);
  st.hlsId = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
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
    st.lastLoad = Date.now();
    if (st.transcoding) {
      st.offset = at;
      var q = '?start=' + at.toFixed(1) + (st.vcopy ? '&vcopy=1' : '') + (st.audio ? '&audio=' + st.audio : '') +
        (st.height ? '&height=' + st.height : '');
      // Safari (iPhone, iPad, Mac) non legge un MP4 senza lunghezza: lo stesso flusso in HLS
      v.src = HLS ? p.transcode.replace('/api/transcode/', '/api/hls/') + '/' + st.hlsId + '-' + id + '/index.m3u8' + q
        : p.transcode + q;
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
    st.transcoding = index > 0 || !p.browser_direct || st.forced || st.height > 0;
    st.loaded = false;
    load(st.at);
  }

  // ---- Qualita': Auto (segue la banda), Originale, 4K, 1080p, 720p ----------
  // Auto misura la velocita' tra questo dispositivo e il PC e sceglie la qualita' piu'
  // alta che ci sta; se durante la visione il video si ferma spesso, scende di un gradino.
  var QUALITIES_UI = [['auto', 'Automatica (segue la connessione)'], ['orig', 'Originale'],
    ['2160', '4K (2160p)'], ['1080', '1080p'], ['720', '720p']];
  var LADDER = [0, 2160, 1080, 720, 480];                 // 0 = originale
  var RUNG_KBPS = { 2160: 40000, 1080: 16000, 720: 6000, 480: 2500 };    // come i tetti del server
  function qualityPref() { return prefs.quality || 'auto'; }
  function qualityLabel(h) { return h ? (h === 2160 ? '4K' : h + 'p') : 'Originale'; }

  // Mbit/s verso il PC (0 se non riesce): scarica fino a 512 KB, al massimo 2,5 secondi
  function measureBw() {
    return new Promise(function (resolve) {
      if (!window.fetch || !window.AbortController || !window.performance) { resolve(0); return; }
      var ctl = new AbortController(), t0 = performance.now(), got = 0;
      var timer = setTimeout(function () { ctl.abort(); }, 2500);
      function done() {
        clearTimeout(timer);
        var sec = (performance.now() - t0) / 1000;
        resolve(got > 32768 && sec > 0 ? got * 8 / 1e6 / sec : 0);
      }
      fetch(apiUrl('/bwtest?kb=512&r=' + Date.now()), apiOpt({ signal: ctl.signal, cache: 'no-store' })).then(function (r) {
        if (!r.ok || !r.body || !r.body.getReader) return r.arrayBuffer().then(function (b) { got = b.byteLength; done(); });
        var rd = r.body.getReader();
        (function pump() {
          rd.read().then(function (x) {
            if (x.done) { done(); return; }
            got += x.value.length;
            pump();
          }, done);
        })();
      }).catch(done);
    });
  }

  // La qualita' piu' alta che sta nella banda misurata (0 = originale)
  function pickRung(bw) {
    if (!bw) return st.height;
    var usable = bw * 1000 * 0.75;                          // kbit/s, con un po' di margine
    var src = p.size && p.duration ? p.size * 8 / 1000 / p.duration : 0;
    if (src ? src * 1.2 <= usable : usable >= 30000) return 0;
    for (var i = 1; i < LADDER.length; i++) if (RUNG_KBPS[LADDER[i]] <= usable) return LADDER[i];
    return 480;
  }

  // Imposta l'altezza e dice se serve riaprire il video (true)
  function setHeight(h) {
    if (h === st.height) return false;
    st.height = h;
    st.transcoding = h > 0 || st.audio > 0 || !p.browser_direct || st.forced;
    st.loaded = false;
    return true;
  }

  function setQuality(choice) {
    prefs.quality = choice;
    savePlayerPrefs(prefs);
    if (choice === 'auto') {
      toast('Qualità: misuro la connessione…');
      measureBw().then(function (bw) {
        if (player !== st) return;
        st.bw = bw;
        var h = pickRung(bw);
        toast('Qualità automatica: ' + qualityLabel(h) + (bw ? ' (' + bw.toFixed(bw < 10 ? 1 : 0) + ' Mbit/s)' : ''));
        if (setHeight(h)) load(st.at);
      });
      return;
    }
    var changed = setHeight(choice === 'orig' ? 0 : +choice);
    toast('Qualità: ' + qualityLabel(st.height));
    if (changed) load(st.at);
  }

  // Auto: il video si ferma 3 volte in 40 secondi -> si misura di nuovo e si scende
  function noteStall() {
    if (qualityPref() !== 'auto' || p.friend || v.paused || v.seeking || st.pending !== null) return;
    var now = Date.now();
    if (now - st.lastLoad < 10000) return;                  // appena (ri)aperto: normale che aspetti
    st.stalls = st.stalls.filter(function (t) { return now - t < 40000; });
    st.stalls.push(now);
    if (st.stalls.length < 3 || now - st.qcool < 20000) return;
    st.qcool = now;
    st.stalls = [];
    measureBw().then(function (bw) {
      if (player !== st || qualityPref() !== 'auto') return;
      var cur = LADDER.indexOf(st.height);
      var next = Math.min(LADDER.length - 1, Math.max(LADDER.indexOf(pickRung(bw) || 0), cur + 1));
      if (next === cur) return;
      toast('Connessione lenta: qualità ' + qualityLabel(LADDER[next]));
      if (setHeight(LADDER[next])) load(st.at);
    });
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
      !st.transcoding ? 'Riproduzione diretta del file' + (p.friend ? (p.friend_self ? ' da ' : ' dal PC di ') + p.friend : '') :
        p.friend && p.friend_quality !== 'orig' ? 'Convertito a ' + p.friend_quality + 'p ' + (p.friend_self ? 'da ' : 'dal PC di ') + p.friend :
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
    if (!p.friend) {
      add('Qualità', qualityPref() === 'auto' ? 'Auto · ' + qualityLabel(st.height) : qualityLabel(st.height), function () {
        choose('Qualità', QUALITIES_UI.map(function (x) { return { value: x[0], label: x[1] }; }), qualityPref(), setQuality);
      });
    }
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
    else if (p.saga) add('Film successivo della collezione', esc(p.saga.title), goNext);
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
    else if (name === 'cast') {
      // Dal punto in cui sei: il video passa sulla TV e qui il player si chiude
      v.pause();
      castPick(p.id, pos(), function () { history.back(); });
    }
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
      else if (v.webkitEnterFullscreen) v.webkitEnterFullscreen();     // iPhone: solo il video, col player di sistema
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
  v.addEventListener('waiting', function () { st.waiting = true; busy(); noteStall(); });
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
      openPicker('Collezione ' + p.saga.name + ' · film ' + p.saga.number + ' di ' + p.saga.count, [
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
  if (!p.friend && qualityPref() === 'auto') {
    // Auto: prima una misura veloce della banda, poi parte (al massimo 2,5 secondi di attesa)
    setNote(LOADING);
    measureBw().then(function (bw) {
      if (player !== st) return;
      st.bw = bw;
      setHeight(pickRung(bw));
      load(p.start || 0);
    });
  } else {
    if (!p.friend && qualityPref() !== 'orig') setHeight(+qualityPref());
    load(p.start || 0);
  }
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
  modal.classList.remove('corner', 'friendsnow');
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

// Video su un disco scollegato (o spostato): quale disco collegare e dove dovrebbe stare il file
function missingBox(m) {
  openPicker(m.unplugged ? 'Il disco ' + m.disk + ' non è collegato' : 'File non trovato',
    [{ value: 'ok', label: 'OK' }], 'ok', function () {});
  var h = modal.querySelector('.sheet h3');
  if (h) h.insertAdjacentHTML('afterend', '<div class="missing"><p>' +
    (m.unplugged ? 'Collega il disco ' + esc(m.disk) + ' e riprova. Il file dovrebbe trovarsi in:'
                 : 'Il disco c\'è, ma il file non è più al suo posto. Dovrebbe trovarsi in:') +
    '</p><code>' + esc(m.where) + '</code></div>');
}

function offlineNote(x) {
  if (!x.offline) return '';
  return '<div class="offnote">' + IC.disk + '<div><b>' + (x.unplugged === false ? 'File non trovato' : 'Disco ' + esc(x.disk || '') + ' non collegato') +
    '</b><span>Il file dovrebbe trovarsi in <code>' + esc(x.where || '') + '</code></span></div></div>';
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
try { updateLater = +sessionStorage.getItem('fpUpdateLater') || 0; } catch (e) { /* niente */ }

function tvCall(name) {
  try { return typeof tvApp[name] === 'function' ? tvApp[name]() : null; }
  catch (e) { return null; }
}

function startUpdate() {
  openPicker('Scarico l\'aggiornamento dell\'' + appLabel(true) + '… 0%', [{ value: 'bg', label: 'Continua in sottofondo' }], '-', function () {});
  modalState.update = true;
  tvApp.update();
}

function checkUpdate(manual) {
  if (!APP) return;
  if (selfUpdating()) {
    // L'app chiede a GitHub (subito se a mano, se no al massimo ogni 6 ore), poi risponde in fpLatest
    window.fpLatest = function (error) {
      window.fpLatest = null;
      if (error && manual) { toast('Non riesco a controllare gli aggiornamenti: ' + error); return; }
      api('/info').then(function (i) { offerUpdate(i, manual); }).catch(function () { offerUpdate({}, manual); });
    };
    tvApp.checkLatest(!!manual);
    return;
  }
  api('/info').then(function (i) { offerUpdate(i, manual); }).catch(function (e) { if (manual) toast(e.message); });
}

function offerUpdate(i, manual) {
    var latest = appLatest(i);
    if (!latest.code) {
      if (manual) toast(selfUpdating() ? 'Non trovo ancora una versione pubblicata dell\'app' : 'Sul PC non c\'è un APK: avvia strumenti/sviluppo/«Compila APK.bat»');
      return;
    }
    var mine = +tvCall('getVersion') || 0;
    var canUpdate = !OLD_TV_APP && typeof tvApp.update === 'function';
    if (canUpdate && latest.code <= mine) { if (manual) toast('L\'' + appLabel(true) + ' è già aggiornata'); return; }
    if (!manual) {
      if (updateLater === latest.code) return;
      // Non si sovrappone a un film o a un'altra finestra: riprova tra poco
      if (player || !modal.hidden || /^#\/play/.test(location.hash)) { setTimeout(checkUpdate, 20000); return; }
    }
    var name = latest.name ? ' (versione ' + latest.name + ')' : '';
    if (!canUpdate) {
      // App installata prima che esistesse l'aggiornamento automatico: l'ultima volta a mano.
      var told = '';
      try { told = localStorage.getItem('fpOldApp') || ''; } catch (e) {}
      if (!manual && told === String(latest.code)) return;
      try { localStorage.setItem('fpOldApp', String(latest.code)); } catch (e) {}
      openPicker(OLD_TV_APP
        ? 'È arrivata la nuova app BunkerPlex per la TV' + name + ' e sostituisce questa, che non riceverà più aggiornamenti. ' +
          'Installala con l\'app «Downloader», aprendo http://' + location.host + '/BunkerPlex.apk, poi disinstalla questa dalle impostazioni della TV.'
        : 'C\'è una versione più nuova dell\'app BunkerPlex' + name + '. Quella installata su questa TV non sa ancora aggiornarsi da sola: ' +
          'installa la nuova un\'ultima volta con l\'app «Downloader», aprendo http://' + location.host + '/BunkerPlex.apk. Dalla prossima farà tutto da sé.',
        [{ value: 'ok', label: 'Ho capito' }], 'ok', function () {});
      return;
    }
    // Senza un server aperto (impostazioni dell'app dall'accesso) non si sa quale API abbia
    var needs = i.api && (latest.min_api || 1) > i.api ? ' Richiede anche di aggiornare il server.' : '';
    openPicker('È disponibile un aggiornamento dell\'' + appLabel(true) + ' BunkerPlex' + name + ', l\'app installata su ' + (TV ? 'questa TV' : 'questo dispositivo') + '.' + needs + ' Vuoi installarlo adesso?',
      [{ value: 'yes', label: 'Aggiorna ora' }, { value: 'no', label: 'Più tardi' }], 'yes', function (answer) {
        if (answer === 'yes') startUpdate();
        else {
          updateLater = latest.code;
          try { sessionStorage.setItem('fpUpdateLater', String(latest.code)); } catch (e) { /* niente */ }
          toast('Puoi aggiornare l\'' + appLabel(true) + ' quando vuoi da Impostazioni → ' + appLabel());
        }
      });
}

// Notifica «Aggiornamento disponibile» toccata con l'app gia' aperta: si propone subito
window.fpOfferUpdate = function () { checkUpdate(true); };

// L'app Android racconta qui come procede l'aggiornamento
window.fpUpdate = function (state, value) {
  var mine = modalState && modalState.update;
  if (state === 'progress') {
    if (mine) modal.querySelector('h3').textContent = 'Scarico l\'aggiornamento dell\'' + appLabel(true) + '… ' + value + '%';
    return;
  }
  if (mine) closeModal(true);
  var managed = tvCall('installsBySession') === true;   // app che segue da sola permesso e installazione
  if (managed && state === 'install') { toast('Conferma «Installa» o «Aggiorna» nella finestra della TV'); return; }
  if (state === 'cancel') { toast('Aggiornamento annullato: puoi rifarlo da Impostazioni'); return; }
  if (state === 'permission') {
    toast('Consenti a BunkerPlex di installare app, poi torna indietro: l\'aggiornamento riparte da solo');
    return;
  }
  if (!modal.hidden || player) {   // c'e' altro sullo schermo: basta un avviso
    toast(state === 'install' ? 'Aggiornamento pronto: conferma l\'installazione' : 'Aggiornamento non riuscito');
    return;
  }
  if (state === 'denied') {
    openPicker('Per aggiornarsi da sola, BunkerPlex ha bisogno del permesso «Installa app sconosciute» della TV. ' +
      'Premi «Riprova» e attivalo nella schermata che si apre.',
      [{ value: 'retry', label: 'Riprova' }, { value: 'no', label: 'Chiudi' }], 'retry', function (answer) {
        if (answer === 'retry') startUpdate();
      });
    return;
  }
  if (state === 'install') {
    openPicker('Aggiornamento scaricato: conferma «Installa» o «Aggiorna» nella finestra della TV. ' +
      'Se la TV chiede il permesso di installare app sconosciute, consentilo per BunkerPlex e poi premi «Riprova».',
      [{ value: 'ok', label: 'Chiudi' }, { value: 'retry', label: 'Riprova' }], 'ok', function (answer) {
        if (answer === 'retry') startUpdate();
      });
  } else {
    openPicker('Aggiornamento non riuscito: ' + value + '. ' +
      (selfUpdating() ? 'Controlla la connessione a Internet e riprova.' : 'Controlla che il PC sia acceso e riprova.'),
      [{ value: 'retry', label: 'Riprova' }, { value: 'no', label: 'Chiudi' }], 'retry', function (answer) {
        if (answer === 'retry') startUpdate();
      });
  }
};

// ---------------------------------------------------------------- Aggiornamento di BunkerPlex (da GitHub)
// Il server sul PC controlla da solo ogni 12 ore. Da qui (PC o TV) si vede
// l'avviso, si controlla a mano e si lancia l'installazione: il server scarica
// i file nuovi e si riavvia. Le app si aggiornano per conto loro (release su GitHub).

var serverUpdateLater = '';          // aggiornamento per cui si e' risposto "Più tardi"
var serverUpdating = false;

function updateWhat(u) {
  if (u.docker && !u.code) return ' (il server sul PC va riallineato)';
  return '';
}

function updateTime(seconds) {
  if (!seconds) return '';
  try {
    return new Date(seconds * 1000).toLocaleString('it-IT', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  } catch (e) { return ''; }
}

// Le novita' delle ultime 5 release del server, la piu' nuova prima
function changelogPanel(u) {
  var list = (u && u.changelog) || [];
  if (!list.length) return '';
  var rows = list.map(function (r) {
    var here = u.release && r.version === u.release;
    var d = '';
    try { d = r.date ? new Date(r.date + 'T12:00:00').toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' }) : ''; } catch (e) { d = r.date || ''; }
    return '<div class="folder"><div class="where"><b>Versione <span class="num">' + esc(r.version) + '</span>' +
      (here ? ' · installata' : '') + '</b><small>' + esc(d) + '</small>' +
      (r.changes && r.changes.length ? '<ul style="margin:.4rem 0 0 1.1rem;padding:0">' + r.changes.map(function (c) {
        return '<li>' + esc(c) + '</li>';
      }).join('') + '</ul>' : '') + '</div></div>';
  }).join('');
  return '<div class="panel"><h2>Novità delle ultime versioni</h2><div class="lib">' + rows + '</div></div>';
}

function updatePanel(u, title) {
  if (!u || !u.enabled) return '';
  var state;
  if (u.access === false) state = dot(false) + ' Questo PC non ha ancora l\'accesso al repository privato degli aggiornamenti (<b>' + esc(u.repo) + '</b>).';
  else if (u.error) state = dot(false) + ' ' + esc(u.error);
  else if (u.phase === 'pc') state = dot(false) + ' Aggiornamento in corso sul PC: scarico le novità e riallineo Docker…';
  else if (u.phase === 'host') state = dot(false) + ' Aggiornamento scaricato: per completarlo rilancia <b>Installa BunkerPlex</b> sul computer.';
  else if (u.available) state = dot(false) + ' È disponibile un aggiornamento del server' + updateWhat(u) + '.';
  else if (u.checked_at) state = dot(true) + ' Il server è aggiornato.';
  else state = 'Il primo controllo parte un paio di minuti dopo l\'avvio.';
  var when = updateTime(u.checked_at);
  var hours = u.push ? 'appena esce una versione nuova'
    : u.check_hours === 24 ? 'una volta al giorno' : 'ogni ' + u.check_hours + ' ore';
  return '<div class="panel"><h2>' + esc(title || 'Aggiornamenti del server') + '</h2>' +
    '<p>' + state + (when ? ' Ultimo controllo: ' + esc(when) + '.' : '') + '</p>' +
    '<p>Il server controlla da solo ' + hours + (u.auto
      ? ' e installa le novità quando nessuno sta guardando un video.'
      : ': ti avvisa, e decidi tu quando installare.') +
      (u.agent
        ? ' Sul PC è acceso l\'aiutante degli aggiornamenti: da qui, dalla TV o dal telefono si aggiorna tutto il server, Docker e pacchetti compresi' +
          (u.dev_copy ? ' (questa è la copia di sviluppo: il programma lo aggiorna git).' : '.')
        : (u.dev_copy ? ' Questa è la copia di sviluppo e l\'aiutante sul PC è spento: da qui arriva solo l\'app per la TV. Rilancia «Installa BunkerPlex» sul computer per riaccenderlo.'
                      : ' L\'aiutante sul PC è spento: le novità che toccano Docker si completano rilanciando «Installa BunkerPlex».')) + '</p>' +
    (u.can_update === false ? '<p>' + dot(false) + ' Solo il proprietario di questo server può aggiornarlo.</p>' : '') +
    (u.access === false && u.can_update !== false
      ? (TV ? '<p>Per dare l\'accesso apri <b>http://' + esc(location.host) + '</b> dal PC, Impostazioni → Aggiornamenti, e incolla il token di GitHub.</p>'
            : '<p>Incolla qui un token di GitHub di sola lettura per quel repository (su GitHub: Settings → Developer settings → Fine-grained tokens, permesso Contents: Read-only). Resta salvato sul disco di BunkerPlex.</p>' +
              '<div class="inline" style="margin-bottom:.8rem"><input class="field f" id="ghtoken" data-key="ghtoken" data-enter="updtoken" autocomplete="off" placeholder="Token di GitHub">' +
              '<button class="btn f" data-act="updtoken" data-key="updtoken">Salva</button></div>')
      : '') +
    '<div class="actions" style="margin-top:0">' +
      (u.available && !u.phase && u.can_update !== false ? '<button class="btn primary f" data-act="updinstall" data-key="updinstall">Aggiorna ora</button>' : '') +
      '<button class="btn f" data-act="updcheck" data-key="updcheck">Controlla adesso</button>' +
      (u.can_update !== false ? '<button class="btn f" data-act="updauto" data-arg="' + (u.auto ? '0' : '1') + '" data-key="updauto">Aggiornamento automatico: ' + (u.auto ? 'attivo' : 'spento') + '</button>' : '') +
    '</div></div>';
}

// Segue l'installazione finche' il server non e' tornato su con la versione nuova
function watchServerUpdate() {
  serverUpdating = true;
  var down = false, tries = 0;
  openPicker('Aggiorno il server BunkerPlex sul PC… di solito basta un minuto, se c\'è da ricostruire Docker qualcuno in più. Il server si riaccende da solo.',
    [{ value: 'bg', label: 'Continua in sottofondo' }], '-', function () {});
  modalState.serverUpdate = true;
  var timer = setInterval(function () {
    tries++;
    fetch(apiUrl('/update'), apiOpt({ cache: 'no-store' })).then(function (r) {
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
        toast('Il server BunkerPlex è aggiornato');
        if (/^#\/settings/.test(location.hash)) render();
        if (APP && !selfUpdating()) setTimeout(checkUpdate, 1500);     // e' arrivata una nuova app per la TV?
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
    if (!u.enabled || !u.available || u.phase || u.can_update === false) return;
    var sig = u.remote;
    if (serverUpdateLater === sig) return;
    // Non si sovrappone a un film o a un'altra finestra: riprova tra poco
    if (player || !modal.hidden || /^#\/play/.test(location.hash)) { setTimeout(checkServerUpdate, 60000); return; }
    openPicker('È disponibile un aggiornamento del server BunkerPlex' + (auth && auth.pc ? ' «' + auth.pc + '»' : '') + updateWhat(u) + '. Vuoi installarlo adesso?' +
      (TV ? ' Si aggiorna il server sul PC; se c\'è una nuova app, subito dopo la TV propone di installarla.' : ''),
      [{ value: 'yes', label: 'Aggiorna ora' }, { value: 'no', label: 'Più tardi' }], 'yes', function (answer) {
        if (answer === 'yes') startServerUpdate();
        else { serverUpdateLater = sig; toast('Puoi aggiornare il server quando vuoi da Impostazioni → Aggiornamenti'); }
      });
  }).catch(function () {});
}

function closeModal(silent) {
  if (modal.hidden) return false;
  var back = modalState && modalState.returnFocus;
  modal.hidden = true;
  modal.innerHTML = '';
  modal.classList.remove('corner', 'friendsnow');
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

// ---- Accesso: errori scritti sotto i campi (non un avviso che sparisce), il pulsante
// che gira mentre si entra, l'occhio per vedere la password e l'avviso del Bloc Maiusc.

// L'errore resta sulla pagina dov'e' nato, anche se la pagina si ridisegna
function authErr(msg) {
  cache.authErr = { msg: msg, hash: location.hash };
  showAuthErr();
}

function showAuthErr() {
  var a = cache.authErr;
  if (!a) return;
  if (a.hash !== location.hash) { cache.authErr = null; return; }
  var box = view.querySelector('.authcard, .panel.login, .panel');
  if (!box) return;
  var el = box.querySelector('.autherr');
  if (!el) {
    el = document.createElement('p');
    el.className = 'autherr';
    el.setAttribute('role', 'alert');
    var at = box.querySelector('.btn.primary');
    if (at && at.parentNode.classList.contains('actions')) at = at.parentNode;
    if (at) at.parentNode.insertBefore(el, at); else box.appendChild(el);
  }
  el.textContent = a.msg;
}

var EYE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
var EYE_OFF = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18M10.6 5.1A10.8 10.8 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6C3.8 8.5 2 12 2 12s3.6 7 10 7c1.9 0 3.6-.6 5-1.5"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';

// L'occhio accanto ai campi password (non ai PIN), dopo ogni disegno della pagina
function enhancePasswords(root) {
  if (TV) return;                      // sulla TV la password non si scrive
  root.querySelectorAll('input.field[type="password"]').forEach(function (inp) {
    if (inp.closest('.pwwrap') || inp.inputMode === 'numeric' || inp.hasAttribute('data-noeye')) return;
    var wrap = document.createElement('span');
    wrap.className = 'pwwrap';
    wrap.style.marginBottom = inp.style.marginBottom;
    inp.style.marginBottom = '';
    inp.parentNode.insertBefore(wrap, inp);
    wrap.appendChild(inp);
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'pweye';
    b.tabIndex = -1;
    b.setAttribute('data-act', 'pweye');
    b.setAttribute('aria-label', 'Mostra la password');
    b.innerHTML = EYE;
    wrap.appendChild(b);
  });
}

// Bloc Maiusc acceso mentre si scrive una password: lo si dice sotto il campo
function capsCheck(e) {
  var t = e.target;
  if (!t || t.tagName !== 'INPUT' || !(t.type === 'password' || t.getAttribute('data-pw') === '1') || !e.getModifierState) return;
  var on = e.getModifierState('CapsLock');
  var host = t.closest('.pwwrap') || t;
  var note = host.nextElementSibling && host.nextElementSibling.classList.contains('capsnote') ? host.nextElementSibling : null;
  if (on && !note) {
    note = document.createElement('p');
    note.className = 'capsnote';
    note.textContent = 'Bloc Maiusc attivo';
    host.parentNode.insertBefore(note, host.nextSibling);
  } else if (!on && note) note.remove();
}
document.addEventListener('keyup', capsCheck);
document.addEventListener('keydown', capsCheck);

// Un'azione che torna una promessa: il pulsante gira finche' non ha finito
function runAction(name, arg, el) {
  var fn = actions[name];
  if (!fn) return false;
  if (name !== 'pweye') cache.authErr = null;
  var r = fn(arg, el);
  var btn = el && el.classList && el.classList.contains('btn') ? el
    : document.querySelector('.btn[data-act="' + name + '"]');
  if (r && typeof r.then === 'function' && btn) {
    btn.classList.add('busy');
    btn.setAttribute('aria-busy', 'true');
    var done = function () { btn.classList.remove('busy'); btn.removeAttribute('aria-busy'); };
    r.then(done, done);
  }
  return true;
}

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
    else if (wasLocal && auth.user && auth.user.linked) toast('Fatto: sei entrato con il tuo account, sto sincronizzando');
    // Dalle impostazioni si resta li'; da «Chi guarda?» si va alla Home. afterLogin: la
    // pagina da cui si e' partiti (es. il QR della TV aperto sul telefono, poi Google)
    var next = cache.afterLogin;
    cache.afterLogin = '';
    if (next && auth.user) location.replace(next);
    else if (!/^#\/settings/.test(location.hash) || !auth.user) location.replace('#/home');
    render();
  });
}

var actions = {
  // --- account
  login: function () {
    var name = fieldValue('lname').trim(), pass = fieldValue('lpass');
    if (!name || !pass) {
      authErr(!name ? 'Scrivi il nome utente o l\'email' : 'Scrivi la password');
      var miss = byKey(!name ? 'lname' : 'lpass');
      if (miss) miss.focus();
      return;
    }
    cache.loginName = name;
    return post('/auth/login', { username: name, password: pass, device: devName(), trust: trustFor(name) }).then(enterApp, function (e) {
      if (loginFailed(e)) return;
      authErr(e.message);
      return loadAuth().then(render);
    });
  },
  asksend: function () {
    var a = cache.ask;
    if (!a) return;
    post('/auth/ask/' + a.ticket).then(function (r) {
      if (r.done) { cache.ask = null; enterApp(r); return; }
      a.status = r.status || 'sent';
      toast('Richiesta mandata a ' + a.owner);
      render();
    }, function (e) { toast(e.message); });
  },
  askback: function () {
    cache.ask = null;
    clearTimeout(cache.askTimer);
    location.replace('#/home');
    render();
  },
  srvpick: function (v) {
    setServer(v);
    dropCached();
    libsLoadedAt = 0;
    railSignature = '';
    cache.srvAdd = false;
    location.replace('#/home');
    render();
  },
  srvoff: function () { toast('Questo server ora non è raggiungibile: dev\'essere acceso'); },
  srvadd: function () { cache.srvAdd = true; render(); },
  srvaddsend: function () {
    var name = fieldValue('afname').trim();
    if (!name) { toast('Scrivi il nome dell\'account del tuo amico'); return; }
    post('/account-friends', { username: name }).then(function (r) {
      toast(r.status === 'ok' ? 'Ora tu e ' + r.username + ' siete amici' : 'Richiesta mandata a ' + r.username + ': quando accetta, i suoi server compaiono qui');
      cache.srvAdd = false;
      cache.srvData = null;
      render();
    }, function (e) { toast(e.message); });
  },
  srvaccept: function (id) {
    post('/account-friends/' + id + '/accept').then(function () {
      toast('Ora siete amici: i suoi server compaiono tra poco');
      cache.srvData = null;
      libsLoadedAt = 0;
      render();
    }, function (e) { toast(e.message); });
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
      // Sulla TV la password non si scrive: si entra dal telefono
      if (/password/.test(e.message)) { if (TVLOGIN) location.hash = '#/tvlogin'; else { cache.whoMode = 'pw:' + id; render(); } return; }
      toast(e.message);
      loadAuth().then(render);
    });
  },
  // --- «Chi guarda?» e «Gestisci profili» (vedi Profili dell'account)
  watcher: function (id) { whoChoose(+id, ''); },
  pinkey: function (k) {
    var input = document.getElementById('pin');
    if (!input) return;
    if (k === 'del') input.value = input.value.slice(0, -1);
    else if (input.value.length < 4) input.value += k;
    if (input.value.length === 4) actions.pinok();
  },
  pinok: function () {
    var a = cache.pinAsk, pin = fieldValue('pin').replace(/\D/g, '');
    if (!a) return;
    if (pin.length !== 4) { toast('Il PIN è di 4 cifre'); return; }
    whoChoose(a.id, pin);
  },
  pincancel: function () { cache.pinAsk = null; render(); },
  pedit: function (id) {
    var p = profById(+id);
    if (!p) return;
    cache.pEdit = { id: p.id, name: p.name, avatar: p.avatar || '', color: p.color || '', kids: !!p.kids, pin: !!p.pin, main: !!p.main, pinOp: '' };
    render();
  },
  pnew: function () {
    if (profList().length >= MAX_PROFILES) { toast('Al massimo ' + MAX_PROFILES + ' profili per account'); return; }
    cache.pEdit = { id: null, name: '', avatar: '', color: '', kids: false, pin: false, main: false, pinOp: '' };
    render();
  },
  pavatar: function (k) { pEditKeep(); cache.pEdit.avatar = k || ''; render(); },
  pcolor: function (c) { pEditKeep(); cache.pEdit.color = c || ''; render(); },
  pkids: function () { pEditKeep(); cache.pEdit.kids = !cache.pEdit.kids; render(); },
  ppin: function (op) { pEditKeep(); cache.pEdit.pinOp = cache.pEdit.pinOp === op ? '' : op; render(); },
  pcancel: function () { cache.pEdit = null; render(); },
  psave: function () { profileSave(); },
  pdel: function () {
    var ed = cache.pEdit;
    if (!ed || ed.id === null || ed.main) return;
    confirmBox('Togliere il profilo «' + ed.name + '»? Si perdono i suoi visti, la sua ripresa e la sua lista, su ogni server. L\'account e le raccolte non si toccano.',
      'Sì, togli il profilo', function () { profileDelete(ed.id); });
  },
  // --- collegamento di questo server a un account (codice, o direttamente)
  claimcode: function () { claimShowCode(); },
  claimprep: function () { claimPrepare(); },
  claimpick: function (sid) {
    var st = cache.claimPrev;
    if (!st) return;
    st.name = claimPickName(st.same_machine || [], st.replace, sid, fieldValue('claimname'), (auth.claim || {}).name);
    st.replace = sid || '';
    render();
  },
  claimgo: function () { claimConfirm(); },
  claimcancel: function () { cache.claimPrev = null; render(); },
  whomode: function (mode) {
    cache.whoMode = cache.whoMode === mode ? '' : mode;
    render();
  },
  delprofile: function () {
    var u = auth.user, heir = (auth.profiles || []).filter(function (p) { return p.id !== u.id; })[0];
    confirmBox('Togliere l\'account «' + u.name + '» da questo PC? L\'account resta online con visti, ripresa e lista già sincronizzati. ' +
      'Le sue raccolte di qui passano a ' + (heir ? heir.name : 'un altro account') + ': i video non si toccano.',
      'Sì, togli l\'account', function () {
        send('DELETE', '/auth/profile').then(function () {
          try { sessionStorage.setItem('fpNoAuto', '1'); } catch (e) { /* niente */ }
          auth = null;
          conflicts = null;
          toast('Account tolto da questo PC');
          location.replace('#/home');
          render();
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
  pcupd: function (arg) { updateMyPc(+arg); },
  afself: function (arg) {
    toast(arg === '1' ? 'Collego i tuoi PC…' : 'Scollego i tuoi PC…');
    post('/account-friends/self', { on: arg === '1' }).then(function () { libsLoadedAt = 0; render(); }, function (e) { toast(e.message); });
  },
  noticeon: function (arg) {
    if (arg === 'push') {                    // PWA: notifiche push del browser
      pushOn().catch(function (e) { toast(e.message); render(); });
      return;
    }
    // App Android: il dispositivo nell'account, poi l'app chiede il permesso e collega Firebase
    noticeApi('POST', '/notices/devices', { kind: 'android', label: noticeLabel('android'), open: location.origin + '/' }).then(function (r) {
      tvApp.noticesSet(r.url);
      toast('Notifiche attive su questo dispositivo');
      if (typeof tvApp.noticesPush === 'function' && tvCall('noticesPush')) noticeDropChrome();
      setTimeout(render, 1500);
    }, function (e) { toast(e.message); });
  },
  noticetest: function () {
    if (PHONE_APP) {
      if (typeof tvApp.noticesTest === 'function') { toast('Mando una prova…'); tvApp.noticesTest(); }
      return;
    }
    var dev = pushSaved();
    if (!dev || dev.off) return;
    toast('Mando una prova…');
    pushCall(dev, '/test', 'POST').then(function () { window.fpNoticeTest(''); }, function (e) { toast(e.message); });
  },
  noticeread: function (arg) {
    var id = +arg, list = (act.info && act.info.notices) || [];
    var n = list.filter(function (x) { return x.id === id; })[0];
    var shown = document.querySelector('[data-act="noticeread"][data-arg="' + id + '"].unread');
    if (n ? n.read : !shown) return;
    if (n) n.read = true;
    renderActivity();
    markShown(id);
    post('/notices/read', { ids: [id] }).catch(function (e) { if (n) n.read = false; renderActivity(); toast(e.message); });
  },
  noticeall: function () {
    var list = (act.info && act.info.notices) || [];
    var unread = list.some(function (n) { return !n.read; });
    list.forEach(function (n) { n.read = true; });
    activityState().notes.forEach(function (n) { act.seen[n.key] = 1; });
    try { localStorage.setItem('fpSeen', JSON.stringify(act.seen)); } catch (e) { /* niente */ }
    renderActivity();
    document.querySelectorAll('.nlist .unread').forEach(function (el) { el.classList.replace('unread', 'read'); });
    toast('Tutto segnato come letto');
    if (unread || !act.info) post('/notices/read', { all: true }).catch(function (e) { toast(e.message); pollActivity(); });
  },
  duptrash: function (arg) {
    var id = +arg, x = null;
    (cache.dups || []).forEach(function (g) { g.items.forEach(function (y) { if (y.id === id) x = y; }); });
    if (!x) return;
    confirmBox('Spostare nel Cestino di Windows «' + x.path + '»? L\'altra copia resta al suo posto.', 'Sposta nel Cestino', function () {
      toast('Sposto il file nel Cestino…');
      post('/duplicates/trash', { id: id }).then(function () { toast('File spostato nel Cestino'); render(); pollActivity(); },
        function (e) { toast(e.message); });
    });
  },
  dupignore: function (key) {
    post('/duplicates/ignore', { key: key }).then(function () { toast('Non lo segnalo più'); render(); pollActivity(); },
      function (e) { toast(e.message); });
  },
  noteopen: function (key) {
    var n = activityState().notes.filter(function (x) { return x.key === key; })[0];
    act.seen[key] = 1;
    try { localStorage.setItem('fpSeen', JSON.stringify(act.seen)); } catch (e) { /* niente */ }
    renderActivity();
    if (n) actions.actgo(n.href);
  },
  noticeoff: function () {
    var done = function () { toast('Notifiche spente su questo dispositivo'); render(); };
    if (APP) {
      if (typeof tvApp.noticesSet === 'function') tvApp.noticesSet('');
      done();
      return;
    }
    pushOff().then(done, done);
  },
  noticeperm: function () { if (typeof tvApp.noticesSettings === 'function') tvApp.noticesSettings(); },
  noticepref: function (arg) {
    var p = String(arg).split(':'), body = {};
    body[p[0]] = p[1] === '1';
    noticeApi('PUT', '/notices/prefs', body).then(function () { render(); }, function (e) { toast(e.message); });
  },
  noticedel: function (arg) {
    noticeApi('DELETE', '/notices/devices/' + arg).then(function () { toast('Dispositivo tolto'); render(); }, function (e) { toast(e.message); });
  },
  afactivity: function (arg) {
    post('/account-friends/activity', { on: arg === '1' }).then(function () { render(); }, function (e) { toast(e.message); });
  },
  afshare: function (arg) {
    toast(arg === '1' ? 'Apro la porta per gli amici…' : 'Spengo la condivisione…');
    post('/account-friends/share', { on: arg === '1' }).then(function () { render(); }, function (e) { toast(e.message); });
  },
  pwlater: function () {
    try { sessionStorage.setItem('fpPwLater', '1'); } catch (e) { /* niente */ }
    render();
  },
  // L'occhio del campo password: mostra o nasconde quello che si e' scritto
  pweye: function (arg, el) {
    var inp = el && el.parentNode.querySelector('input');
    if (!inp) return;
    var show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    inp.setAttribute('data-pw', '1');
    el.innerHTML = show ? EYE_OFF : EYE;
    el.setAttribute('aria-label', show ? 'Nascondi la password' : 'Mostra la password');
    inp.focus();
  },
  // «Entra con Google» dalla pagina di accesso: l'email gia' scritta va a Google
  ggo: function () {
    var v = fieldValue('lname').trim();
    cache.gHint = v.indexOf('@') > 0 ? v : '';
    location.hash = '#/google';
  },
  gnew: function () { cache.gflow = null; render(); },
  gopen: function (url) {
    if (APP && tvApp.openUrl) tvApp.openUrl(url);
    else window.open(url, '_blank', 'noopener');
  },
  emailsave: function () {
    var email = fieldValue('uemail').trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { toast('Email non valida'); return; }
    send('PUT', '/auth/email', { email: email }).then(function (j) {
      toast(j.email ? 'Ora puoi entrare anche con ' + j.email : 'Email tolta');
      auth = null;
      render();
    }, function (e) { toast(e.message); });
  },
  resetsend: function () {
    var email = (fieldValue('remail') || (cache.reset && cache.reset.email) || '').trim();
    if (email.indexOf('@') < 1) { toast('Scrivi l\'email del tuo account'); return; }
    toast('Mando il codice…');
    post('/auth/reset/start', { email: email }).then(function () {
      cache.reset = { email: email, sent: true };
      toast('Codice mandato: guarda la tua email');
      render();
    }, function (e) { toast(e.message); });
  },
  resetagain: function () {
    cache.reset = { email: cache.reset && cache.reset.email };
    actions.resetsend();
  },
  // Il codice della verifica in due passaggi (server di casa)
  s2fago: function () {
    var f = cache.s2fa, code = fieldValue('tfacode').trim();
    if (!f) return;
    if (!code) { authErr('Scrivi il codice dell\'app'); return; }
    return post('/auth/login/2fa', { t: f.t, code: code, remember: rememberChecked() }).then(function (r) {
      cache.s2fa = null;
      trustSave([f.user, cache.loginName], r.trust);
      return enterApp(r);
    }, function (e) {
      if (!/sbagliato/i.test(e.message)) cache.s2fa = null;   // scaduto: si ricomincia dalla password
      authErr(e.message);
      if (!cache.s2fa) render();
      var el = byKey('tfacode');
      if (el) { el.value = ''; el.focus(); }
    });
  },
  s2facancel: function () { cache.s2fa = null; cache.authErr = null; render(); },
  resetdone: function () {
    var r = cache.reset || {}, code = fieldValue('rcode').replace(/\D/g, ''), pw = fieldValue('pnew');
    if (code.length !== 6) { toast('Il codice ha 6 cifre: lo trovi nell\'email'); return; }
    if (!pw) { toast('Scegli la password nuova'); return; }
    if (pw !== fieldValue('pnew2')) { toast('Le due password nuove non sono uguali'); return; }
    toast('Salvo…');
    post('/auth/reset/finish', { email: r.email, code: code, password: pw, device: devName() }).then(function (res) {
      cache.reset = null;
      toast('Password cambiata: sei entrato');
      return enterApp(res);
    }, function (e) {
      if (loginFailed(e)) { cache.reset = null; location.replace('#/home'); return; }
      toast(e.message);
    });
  },
  gunlink: function () {
    confirmBox('Scollegare Google dal tuo account? Per entrare servirà di nuovo la password.', 'Sì, scollega', function () {
      send('DELETE', '/auth/google').then(function () {
        toast('Google scollegato');
        auth = null;
        render();
      }, function (e) { toast(e.message); });
    });
  },
  pairme: function (code) {
    post('/auth/pair/' + code, { session: 1 }).then(function (r) {
      cache.pairDone = { code: code, name: r.name };
      render();
    }, function (e) { toast(e.message); });
  },
  pairother: function (code) { cache.pairPw = code; render(); },
  homeoff: function (arg) {
    post('/auth/home-offline', { on: arg === '1' }).then(function () {
      toast(arg === '1' ? 'Senza Internet, chi è in casa entra senza password' : 'Anche senza Internet serve il tuo account');
      auth = null;
      render();
    }, function (e) { toast(e.message); });
  },
  tvcodego: function () {
    var code = fieldValue('tvcode').toUpperCase().replace(/[^A-Z0-9]/g, '');
    // 8 caratteri: la TV e' entrata dalla PWA centrale (browser di una Samsung, l'app TV
    // senza il server di casa): si conferma li', con l'account
    if (code.length === 8 && auth && auth.central) { location.href = auth.central + '/tv/' + code; return; }
    if (code.length !== 6) { toast('Il codice della TV ha 6 caratteri (o 8)'); return; }
    location.hash = '#/pair/' + code;
  },
  pairsend: function (code) {
    var name = fieldValue('lname').trim(), pass = fieldValue('lpass'), pw = fieldValue('pnew');
    if (!name || !pass) { authErr(!name ? 'Scrivi l\'email o il nome utente' : 'Scrivi la password'); return; }
    if (cache.pairNeedNew === code) {
      if (!pw) { authErr('Scegli la password nuova'); return; }
      if (pw !== fieldValue('pnew2')) { authErr('Le due password nuove non sono uguali'); return; }
    }
    return post('/auth/pair/' + code, { username: name, password: pass, new: pw, code: fieldValue('pcode').trim() }).then(function (r) {
      cache.pairDone = { code: code, name: r.name };
      render();
    }, function (e) {
      authErr(e.message);
      if (e.data && e.data.need_2fa === 'pair' && cache.pair2fa !== code) { cache.pair2fa = code; render(); return; }
      if (/provvisoria/.test(e.message) && cache.pairNeedNew !== code) { cache.pairNeedNew = code; render(); }
    });
  },
  // Dal QR della TV, senza account qui: si entra con Google e si torna a collegare la TV
  pairgoogle: function (code) {
    cache.afterLogin = '#/pair/' + code;
    location.hash = '#/google';
  },
  changepw: function (forced) {
    var old = fieldValue('pold'), pw = fieldValue('pnew');
    var naming = forced && needsName(), name = naming ? fieldValue('pname').trim() : '';
    if (naming && !name) { toast('Scegli il tuo nome'); return; }
    if (!old || !pw) { toast('Scrivi la password attuale e quella nuova'); return; }
    if (pw !== fieldValue('pnew2')) { toast('Le due password nuove non sono uguali'); return; }
    toast('Salvo…');
    post('/auth/password', naming ? { old: old, new: pw, name: name } : { old: old, new: pw }).then(function (r) {
      toast(naming ? 'Fatto, ' + name + '! Ora crea il tuo profilo' : 'Password cambiata');
      // Invitato: dal nome e dalla password si passa al pannello Profili per creare il suo
      if (naming) location.replace('#/settings/account');
      if (forced) return enterApp(r);
      history.back();
    }, function (e) { toast(e.message); });
  },
  logout: function () {
    if (CENTRAL) { cLogout(); return; }
    var who = auth && auth.user ? auth.user.id : '';
    post('/auth/logout').catch(function () {}).then(function () {
      try {
        sessionStorage.setItem('fpNoAuto', '1');
        sessionStorage.removeItem('fpServer:' + who);
        sessionStorage.removeItem('fpWho:' + who);
      } catch (e) { /* niente */ }
      cache.srvData = null;
      cache.pinAsk = null; cache.pEdit = null; cache.claimPrev = null;
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
  friendsnow: function () { openFriendsNow(); },
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
    if (v) v.textContent = cache.newAdmin ? 'Amministratore' : 'Base';
  },
  admintab: function (tab) { cache.adminTab = tab; render(); },
  accrole: function (id) {
    var a = (cache.accounts || []).filter(function (x) { return String(x.id) === String(id); })[0];
    if (!a) return;
    var to = a.admin ? 'base' : 'admin';
    confirmBox(to === 'admin' ? 'Rendere «' + a.username + '» amministratore? Potrà gestire tutta BunkerPlex.'
      : 'Rendere «' + a.username + '» un utente base? Non potrà più gestire BunkerPlex.', 'Sì, cambia ruolo', function () {
      send('PUT', '/accounts/' + a.id + '/role', { role: to }).then(function () {
        toast(to === 'admin' ? a.username + ' ora è amministratore' : a.username + ' ora è un utente base'); render();
      }, function (e) { toast(e.message); });
    });
  },
  accactive: function (id) {
    var a = (cache.accounts || []).filter(function (x) { return String(x.id) === String(id); })[0];
    if (!a) return;
    var go = function () {
      send('PUT', '/accounts/' + a.id + '/active', { active: !!a.disabled }).then(function () {
        toast(a.disabled ? a.username + ' è di nuovo attivo' : a.username + ' è disattivato'); render();
      }, function (e) { toast(e.message); });
    };
    if (a.disabled) go();
    else confirmBox('Disattivare «' + a.username + '»? Esce da tutti i server e non può rientrare finché non lo riattivi.', 'Sì, disattiva', go);
  },
  accemail: function (id) {
    var a = (cache.accounts || []).filter(function (x) { return String(x.id) === String(id); })[0];
    if (!a) return;
    cache.editEmail = cache.editEmail === a.id ? null : a.id;
    render();
  },
  accemailsave: function (id) {
    id = id || cache.editEmail;
    send('PUT', '/accounts/' + id + '/email', { email: fieldValue('acmail-' + id).trim() }).then(function () {
      cache.editEmail = null; toast('Email salvata'); render();
    }, function (e) { toast(e.message); });
  },
  admsess: function (id) {
    confirmBox('Chiudere questo accesso? Quel server dovrà rientrare con la password.', 'Sì, chiudi', function () {
      api('/admin/sessions/' + id, { method: 'DELETE' }).then(function () { toast('Accesso chiuso'); render(); }, function (e) { toast(e.message); });
    });
  },
  admlsess: function (id) {
    confirmBox('Chiudere questo accesso a questo server?', 'Sì, chiudi', function () {
      api('/admin/local-sessions/' + id, { method: 'DELETE' }).then(function () { toast('Accesso chiuso'); render(); }, function (e) { toast(e.message); });
    });
  },
  admluser: function (id) {
    confirmBox('Togliere questo account da questo server? Potrà rientrare.', 'Sì, togli', function () {
      api('/admin/local-users/' + id, { method: 'DELETE' }).then(function () { toast('Account tolto da questo server'); render(); }, function (e) { toast(e.message); });
    });
  },
  admsrv: function (arg) {
    var p = arg.split(':');
    confirmBox('Togliere questo server dalla rubrica? Se è acceso si ripubblica da solo.', 'Sì, togli', function () {
      api('/admin/servers/' + p[0] + '/' + encodeURIComponent(p[1]), { method: 'DELETE' }).then(function () { toast('Tolto'); render(); }, function (e) { toast(e.message); });
    });
  },
  admfr: function (arg) {
    var p = arg.split(':');
    confirmBox('Togliere questa amicizia?', 'Sì, togli', function () {
      api('/admin/friends/' + p[0] + '/' + p[1], { method: 'DELETE' }).then(function () { toast('Amicizia tolta'); render(); }, function (e) { toast(e.message); });
    });
  },
  admpcname: function () {
    post('/pc-name', { name: fieldValue('pcname') }).then(function () { toast('Nome salvato'); render(); }, function (e) { toast(e.message); });
  },
  acccreate: function () {
    var email = fieldValue('agoogle').trim(), pass = tempPassword();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { toast('Scrivi l\'email della persona da invitare'); return; }
    toast('Mando l\'invito…');
    post('/accounts', { email: email, password: pass, admin: !!cache.newAdmin }).then(function (r) {
      render().then(function () {
        if (r && r.mailed) toast('Invito mandato a ' + email);
        else showSecret('Invito creato', email, pass, 'Email');
      });
    }, function (e) { toast(e.message); });
  },
  accreset: function (id) {
    var a = (cache.accounts || []).filter(function (x) { return String(x.id) === String(id); })[0];
    if (!a) return;
    var invited = /^invito-[0-9a-f]{6}$/i.test(a.username), who = invited ? (a.email || a.username) : a.username;
    confirmBox(invited ? 'Rimandare l\'invito a ' + who + ' con una nuova password provvisoria?'
      : 'Dare a «' + a.username + '» una nuova password provvisoria? Uscirà da tutti i PC.', invited ? 'Sì, rimanda' : 'Sì, nuova password', function () {
      var pass = tempPassword();
      post('/accounts/' + a.id + '/password', { username: a.username, password: pass }).then(function (r) {
        render().then(function () {
          if (r && r.mailed) toast('Password provvisoria mandata a ' + (a.email || a.google));
          else showSecret(invited ? 'Invito' : 'Nuova password provvisoria', invited ? who : a.username, pass, invited ? 'Email' : 'Nome utente');
        });
      }, function (e) { toast(e.message); });
    });
  },
  accmenu: function (id) { accMenu(id); },
  // Il link di attivazione da mandare a mano (WhatsApp, messaggio...)
  acclink: function (id) {
    post('/accounts/' + id + '/link', {}).then(function (r) {
      return copyText(r.link).then(function (ok) {
        toast(ok ? 'Link copiato: mandalo alla persona (vale 14 giorni)' : 'Non riesco a copiare: ' + r.link);
      });
    }, function (e) { toast(e.message); });
  },
  accremove: function (id) {
    var a = (cache.accounts || []).filter(function (x) { return String(x.id) === String(id); })[0];
    if (!a) return;
    confirmBox('Eliminare l\'account «' + a.username + '»? Perde impostazioni, visti e lista su tutti i PC.', 'Sì, elimina', function () {
      api('/accounts/' + a.id, { method: 'DELETE' }).then(function () { toast('Account eliminato'); render(); }, function (e) { toast(e.message); });
    });
  },
  libkids: function (arg) {
    var parts = arg.split(':');
    send('PATCH', '/libraries/' + parts[0], { kids: parts[1] === '1' }).then(function () {
      toast(parts[1] === '1' ? 'Ora la vedono anche i profili bambini' : 'I profili bambini non la vedono più');
      return loadLibs(true).then(render);
    }).catch(function (e) { toast(e.message); });
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
  cast: function (id) { castPick(id, null); },
  // Episodio a caso, dall'inizio; se possibile diverso da quello da vedere adesso
  randomep: function (id) {
    var s = cache.show;
    if (!s || String(s.id) !== String(id)) return;
    var pool = shuffleEps(s), up = s.up_next;
    var others = pool.filter(function (e) { return !up || e.id !== up.id; });
    if (others.length) pool = others;
    if (!pool.length) return;
    play(pool[Math.floor(Math.random() * pool.length)].id, true);
  },
  watched: function (arg) {
    var parts = arg.split(':');
    post('/watched/' + parts[0], { watched: parts[1] === '1' }).then(function () {
      popKeys = ['watched', 'seen-' + parts[0]];
      return render();
    }, function (e) { toast(e.message); });
  },
  filter: openFilter,
  clearfilters: function (libId) {
    var q = parseQuery(location.hash), target = '#/lib/' + libId + buildQuery({ sort: q.sort });
    focusMemory[target] = 'filter-sort';
    location.replace(target);
  },
  season: function (arg) {
    var parts = arg.split(':'), target = '#/show/' + parts[0] + '?season=' + parts[1];
    focusMemory[target] = 'seasonpick';
    if (target !== location.hash) location.replace(target);
  },
  // Menu a tendina delle stagioni, con quanti episodi ha ciascuna e quanti restano da vedere
  seasons: function (arg) {
    var parts = arg.split(':'), id = parts[0], current = +parts[1];
    var s = cache.show;
    if (!s || String(s.id) !== id) return;
    openPicker('Stagioni', s.seasons.map(function (x) {
      var left = x.episodes.filter(function (e) { return !e.watched; }).length;
      return { value: x.season, label: x.season === 0 ? 'Speciali' : 'Stagione ' + x.season,
        count: x.episodes.length + ' ep.' + (left === 0 ? ' · visti' : left < x.episodes.length ? ' · ' + left + ' da vedere' : '') };
    }), current, function (n) { actions.season(id + ':' + n); });
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
  resetserver: function () { if (APP) tvApp.resetServer(); },

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
  devdel: function (id) {
    confirmBox('Togli questo dispositivo dalla rete di BunkerPlex? Per rientrare dovrà avere un posto libero.', 'Togli', function () {
      send('DELETE', '/devices/' + id).then(function () { toast('Dispositivo tolto'); render(); }, function (e) { toast(e.message); });
    });
  },
  devreplace: function (id) {
    toast('Tolgo il dispositivo e faccio entrare questo PC…');
    post('/devices/replace', { id: id }).then(function () { toast('Fatto: questo PC è nella rete di BunkerPlex'); render(); },
      function (e) { toast(e.message); });
  },
  friendquality: function () {
    openPicker('Qualità dei video degli amici', QUALITIES.map(function (q) { return { value: q[0], label: q[1] }; }), friendQuality, function (q) {
      post('/friends/quality', { quality: q }).then(function () { libsLoadedAt = 0; render(); }, function (e) { toast(e.message); });
    });
  },
  publictoggle: function (arg) {
    post('/public', { on: arg === '1' }).then(function () {
      toast(arg === '1' ? 'Accendo l\'indirizzo pubblico…' : 'Indirizzo pubblico spento');
      render();
    }, function (e) { toast(e.message); });
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
  cappupdate: function () { startUpdate(); },
  // Invito a installare dall'indirizzo pubblico (vedi getAppKind)
  gaopen: function () {
    if (getAppKind() === 'pc' && installEvt) { actions.gainstall(); return; }
    getAppSheet();
  },
  gainstall: function () {
    if (!installEvt) { getAppRefresh(); return; }
    var e = installEvt;
    installEvt = null;
    e.prompt();
    (e.userChoice || Promise.resolve()).then(getAppRefresh, getAppRefresh);
  },
  gashow: function () {
    try { sessionStorage.removeItem('fpGetApp'); } catch (e) { /* niente */ }
    getAppRefresh();
  },
  galater: function () {
    try { sessionStorage.setItem('fpGetApp', 'later'); } catch (e) { /* niente */ }
    getAppRefresh();
  },
  gadone: function () {
    getAppStore({ done: Date.now() });
    toast('Va bene: per un mese non te lo ricordo più');
    getAppRefresh();
  },
  pwainstall: function () {
    if (!installEvt) return;
    var e = installEvt;
    installEvt = null;
    e.prompt();
    (e.userChoice || Promise.resolve()).then(function () { render(); });
  },
  updcheck: function () {
    toast('Controllo su GitHub…');
    post('/update/check').then(function (u) {
      toast(u.access === false ? 'Questo PC non ha l\'accesso al repository' : (u.error || (u.available ? 'C\'è un aggiornamento' + updateWhat(u) : 'BunkerPlex è già aggiornato')));
      render();
    }, function (e) { toast(e.message); });
  },
  updinstall: function () { startServerUpdate(); },
  // --- app sulla TV dal PC
  tvscan: function () { tvSend('scan'); },
  ssscan: function () { ssSend('scan'); },
  ssinstall: function (ip) { ssSend('install', { ip: ip }); },
  ssaddrgo: function () {
    var ip = fieldValue('ssaddr').trim();
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) { toast('Scrivi l\'indirizzo della TV, es. 192.168.1.180'); return; }
    ssSend('install', { ip: ip });
  },
  sscancel: function () { ssSend('cancel'); },
  tvconnect: function () {
    var v = (document.getElementById('tvaddr') || {}).value || '';
    if (!v.trim()) { toast('Scrivi l\'indirizzo della TV (Impostazioni → Rete sulla TV)'); return; }
    tvSend('connect', { target: v.trim() });
  },
  tvpair: function () {
    var a = (document.getElementById('tvpairaddr') || {}).value || '', c = (document.getElementById('tvpaircode') || {}).value || '';
    if (!a.trim() || !c.trim()) { toast('Scrivi indirizzo:porta e codice che mostra la TV'); return; }
    tvSend('pair', { target: a.trim(), code: c.trim() });
  },
  tvinstall: function (serial) { tvSend('install', { target: serial }); },
  phonetv: function () { if (phoneTvOk()) tvApp.openTvInstall(); },
  tvcancel: function () { tvSend('cancel'); },
  tvcopylog: function () {
    api('/tv/log').then(function (r) { return copyText(r.text || ''); }).then(function (ok) {
      toast(ok ? 'Log copiato: incollalo in un messaggio a chi ti aiuta' : 'Non riesco a copiare il log');
    }, function (e) { toast(e.message); });
  },
  tvreplace: function (serial) {
    confirmBox('Togliere dalla TV la BunkerPlex che c\'è e mettere questa? Sulla TV andrà rifatto l\'accesso.', 'Sì, sostituiscila', function () {
      tvSend('install', { target: serial, replace: true });
    });
  },
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
  seasonwatched: function (arg) {
    var parts = arg.split(':');
    post('/shows/' + parts[0] + '/watched', { season: +parts[1], watched: parts[2] === '1' })
      .then(render, function (e) { toast(e.message); });
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
    device.tv = !TVLOOK;               // sulla smart TV anche «spento» si ricorda
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
  posterpick: function (arg) {
    toast('Cambio la locandina…');
    post('/poster', { kind: cache.posters.kind, id: +cache.posters.id, path: arg })
      .then(function () { toast('Locandina cambiata'); history.back(); }, function (e) { toast(e.message); });
  },
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
  if (actions[el.getAttribute('data-act')]) { e.preventDefault(); runAction(el.getAttribute('data-act'), el.getAttribute('data-arg'), el); }
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
  // Nelle Impostazioni dalla barra dell'app si arriva sulla voce aperta dell'elenco
  var sc = settingsCols();
  if (sc) { var it = settingsCurrent(sc.col); if (it) { it.focus(); return; } }
  var el = byKey(focusMemory[currentHash]);
  if (!el || !view.contains(el)) el = view.querySelector('[data-autofocus]') || view.querySelector('.f');
  if (el) el.focus();
}

function focusRail() {
  var el = rail.querySelector('.railitem.on') || rail.querySelector('.railitem');
  if (el) el.focus();
}

// ---- Impostazioni a due colonne (TV e PC): il fuoco sta nell'elenco delle aree o
// nell'area aperta. Dall'elenco OK o destra entra nell'area; dall'area sinistra (al
// bordo) o Indietro torna alla voce aperta; dall'elenco sinistra o Indietro va alla
// barra dell'app. Su e giu' restano nella colonna.
var settingsEnter = false;

function settingsCols() {
  var col = view.querySelector('.settings .scol'), main = view.querySelector('.settings .smain');
  return col && main && isVisible(col) ? { col: col, main: main } : null;
}

function settingsFirst(main) {
  var list = main.querySelectorAll('.f:not(.sup)');
  for (var i = 0; i < list.length; i++) if (isVisible(list[i]) && !list[i].disabled) return list[i];
  return null;
}

function settingsCurrent(col) {
  return col.querySelector('.snav.on') || col.querySelector('.snav');
}

// Entra nell'area di una voce dell'elenco: se e' gia' aperta ci va il fuoco, se no si apre
function settingsOpen(item) {
  var c = settingsCols();
  if (!c) return;
  if (item.classList.contains('on')) {
    var f = settingsFirst(c.main);
    if (f) { f.focus(); scrollToEl(f); }
    return;
  }
  settingsEnter = true;
  location.hash = item.getAttribute('href');
}

// La piu' vicina nella direzione, tra quelle di una colonna
function nearestIn(scope, cur, dir) {
  var a = cur.getBoundingClientRect(), best = null, bestD = Infinity;
  Array.prototype.forEach.call(scope.querySelectorAll('.f'), function (el) {
    if (el === cur || !isVisible(el) || el.disabled || el.classList.contains('sup')) return;
    var b = el.getBoundingClientRect();
    var ok = dir === 'up' ? b.bottom <= a.top + 2 : dir === 'down' ? b.top >= a.bottom - 2
      : dir === 'left' ? b.right <= a.left + 2 && b.bottom > a.top && b.top < a.bottom
      : b.left >= a.right - 2 && b.bottom > a.top && b.top < a.bottom;
    if (!ok) return;
    var dx = (b.left + b.width / 2) - (a.left + a.width / 2), dy = (b.top + b.height / 2) - (a.top + a.height / 2);
    var d = (dir === 'up' || dir === 'down') ? Math.abs(dy) * 1000 + Math.abs(dx) : Math.abs(dx) * 1000 + Math.abs(dy);
    if (d < bestD) { bestD = d; best = el; }
  });
  return best;
}

function settingsMove(cur, dir) {
  var c = settingsCols();
  if (!c || !modal.hidden) return false;
  var inCol = c.col.contains(cur), inMain = c.main.contains(cur);
  if (!inCol && !inMain) return false;
  if (inCol) {
    if (dir === 'right') { settingsOpen(cur); return true; }
    if (dir === 'left') { focusRail(); return true; }
  } else if (dir === 'left') {
    var l = nearestIn(c.main, cur, 'left');
    var back = l || settingsCurrent(c.col);
    if (back) back.focus();
    return true;
  }
  var next = nearestIn(inCol ? c.col : c.main, cur, dir);
  if (next) { next.focus(); scrollToEl(next); }
  return true;
}

// Indietro nelle Impostazioni: dall'area all'elenco, dall'elenco alla barra dell'app
function settingsBack() {
  var c = settingsCols();
  var cur = document.activeElement;
  if (!c || !cur || !modal.hidden) return false;
  if (c.main.contains(cur)) { var it = settingsCurrent(c.col); if (it) { it.focus(); return true; } }
  if (c.col.contains(cur)) { focusRail(); return true; }
  return false;
}

function move(dir) {
  var cur = document.activeElement;
  if (cur && settingsMove(cur, dir)) return;
  var inModal = !modal.hidden;
  if (!cur || !cur.classList || !cur.classList.contains('f') || (inModal && !modal.contains(cur))) {
    if (inModal) { var first = modal.querySelector('.f'); if (first) first.focus(); }
    else focusView();
    return;
  }
  var inRail = rail.contains(cur);
  // La campanella in alto sta fuori dalla pagina ma si raggiunge come un suo elemento
  // (con accanto il pulsante degli amici: si passa dall'uno all'altro con le frecce)
  var tops = Array.prototype.filter.call(document.querySelectorAll('#activity:not([hidden]) .actbtn'),
    function (el) { return el.getBoundingClientRect().width; });
  var bell = tops.length ? tops[tops.length - 1] : null;
  if (cur.closest('#activity') && !bell) { focusView(); return; }
  if (inRail && dir === 'right') { focusView(); return; }
  if (inRail && dir === 'left') return;
  // Ogni zona si naviga per conto suo: finestra di scelta, barra laterale, pagina
  var scope = inModal ? modal : (inRail ? rail : view);
  var a = cur.getBoundingClientRect();
  var horizontal = dir === 'left' || dir === 'right';
  var cands = [];
  // A destra e a sinistra dentro una fila (o una griglia) si guardano solo le sue schede:
  // misurare tutte quelle della pagina a ogni pressione rallentava le TV
  var line = horizontal && scope === view && cur.parentNode && cur.parentNode.classList &&
    (cur.parentNode.classList.contains('row') || cur.parentNode.id === 'grid') ? cur.parentNode : null;
  var list = Array.prototype.slice.call((line || scope).querySelectorAll('.f'));
  if (scope === view && !line) list = list.concat(tops);
  // Su e giu' in una griglia lunga: bastano le locandine vicine (qualche riga sopra e
  // sotto) e quello che sta fuori dalla griglia, come i filtri
  var grid = !horizontal && scope === view && cur.parentNode && cur.parentNode.id === 'grid' ? cur.parentNode : null;
  if (grid && grid.children.length > 120) {
    var at = Array.prototype.indexOf.call(grid.children, cur);
    list = Array.prototype.slice.call(grid.children, Math.max(0, at - 40), at + 41)
      .concat(list.filter(function (el) { return el.parentNode !== grid; }));
  }
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
    if (dir === 'up' && scope === view && bell && cur !== bell) { bell.focus(); return; }
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
// Freccia tenuta premuta (telecomando): si salta dritti, senza scorrimento morbido.
// Ogni nuova locandina farebbe ripartire l'animazione dall'inizio: sulle TV lente
// le animazioni si accavallano e il catalogo scatta.
var held = false;
// Sulle TV lente le ripetizioni della freccia tenuta si accodano e il fuoco continua a
// correre dopo che si e' lasciato il tasto: si scartano quelle rimaste in attesa troppo a
// lungo o arrivate troppo ravvicinate, cosi' il fuoco si ferma quando ci si ferma.
var lastMove = 0;
function keyLate(e) {   // da quanto aspetta il tasto (timeStamp: dall'avvio, o in ms dal 1970 sui browser vecchi)
  var t = e.timeStamp;
  if (!t) return 0;
  var now = t > 1e12 ? Date.now() : (window.performance && performance.now ? performance.now() : 0);
  return now ? now - t : 0;
}

function scrollBox(box, pos) {
  pos.behavior = held ? 'auto' : smooth;
  try { box.scrollTo(pos); }
  catch (e) {   // browser vecchi: niente opzioni
    if (pos.left !== undefined) box.scrollLeft = pos.left;
    if (pos.top !== undefined) { if (box === window) window.scrollTo(0, pos.top); else box.scrollTop = pos.top; }
  }
  if (pos.behavior === 'smooth') probeFrames();
}

function scrollToEl(el) {
  if (el.closest('#activity')) return;
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
  el.scrollIntoView({ behavior: held ? 'auto' : smooth, block: 'center', inline: 'nearest' });
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

var KEYCODES = { 37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown', 13: 'Enter', 27: 'Escape', 8: 'Backspace', 32: ' ',
  // telecomando Samsung (Tizen): Indietro e i tasti dei video
  10009: 'Escape', 10252: 'MediaPlayPause', 415: 'MediaPlay', 19: 'MediaPause', 413: 'MediaStop', 417: 'MediaFastForward', 412: 'MediaRewind' };

// I tasti che l'app Samsung ha ricevuto lei (la cornice) arrivano qui come messaggio
if (TV_WRAP) {
  window.addEventListener('message', function (e) {
    if (e.source !== window.parent || !e.data || typeof e.data.bpKey !== 'string') return;
    var el = document.activeElement || document.body;
    var ev;
    try { ev = new KeyboardEvent('keydown', { key: e.data.bpKey, bubbles: true, cancelable: true }); } catch (err) { return; }
    el.dispatchEvent(ev);
  });
}

document.addEventListener('keydown', function (e) {
  var key = e.key;
  // Indietro sul telecomando Samsung: per il browser e' «XF86Back» o niente
  if (e.keyCode === 10009) key = 'Escape';
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
    e.preventDefault();   // anche per le ripetizioni scartate: niente scorrimento del browser
    var now = Date.now();
    // (quelle in ritardo si scartano solo se il fuoco si e' mosso da poco: anche sulla TV
    // piu' lenta, a tasto tenuto, il fuoco avanza almeno ogni 150 ms)
    if (e.repeat && TVLOOK && (now - lastMove < 40 || (keyLate(e) > 40 && now - lastMove < 150))) return;
    lastMove = now;
    held = !!e.repeat;
    move(dir);
    return;
  }
  if (key === 'Enter') {
    // OK ancora tenuto dopo l'apertura del menu: i tasti ripetuti non devono scegliere niente
    if (press) { e.preventDefault(); return; }
    if (typing) {
      // Invio in un campo: come il pulsante con la stessa azione (anche il suo data-arg)
      var en = t.getAttribute('data-enter');
      if (en) {
        var eb = document.querySelector('[data-act="' + en + '"][data-arg]');
        runAction(en, eb ? eb.getAttribute('data-arg') : null, null);
      }
      return;
    }
    var a = document.activeElement;
    // OK su una voce dell'elenco delle Impostazioni: si entra nell'area (fuoco a destra)
    if (a && a.classList && a.classList.contains('snav') && modal.hidden && settingsCols()) {
      e.preventDefault();
      if (!e.repeat) settingsOpen(a);
      return;
    }
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
    if (settingsBack()) return;
    if (rail.contains(document.activeElement) || (document.activeElement && document.activeElement.closest && document.activeElement.closest('#activity'))) { focusView(); return; }
    // Nell'app Samsung, dalla Home o dall'accesso (scelta del server compresa) l'app si chiude
    if (TV_WRAP && (currentHash === '#/home' || currentHash === '#/login')) window.parent.postMessage({ bp: 'exit' }, '*');
    else if (currentHash !== '#/home') history.back();
  }
});

document.addEventListener('keyup', function (e) {
  var key = e.key;
  if (!key || key === 'Unidentified') key = KEYCODES[e.keyCode] || '';
  if (held) {   // freccia rilasciata: l'ultima locandina si porta al suo posto con calma
    held = false;
    var a = document.activeElement;
    if (kb && a && a.classList && a.classList.contains('f') && view.contains(a)) scrollToEl(a);
  }
  if (key !== 'Enter' || !press) return;
  var p = press;
  press = null;
  clearTimeout(p.timer);
  if (!p.done && document.activeElement === p.el) p.el.click();
  // Il rilascio di OK dopo una pressione lunga non deve attivare la voce del menu appena aperto
  if (p.done) { okRelease = true; setTimeout(function () { okRelease = false; }, 300); }
});
document.addEventListener('click', function (e) {
  if (okRelease && e.isTrusted) { e.preventDefault(); e.stopPropagation(); }
}, true);

document.addEventListener('mousedown', function () { setKb(false); });
document.addEventListener('touchstart', function () { setKb(false); }, { passive: true });
// Scorrimento: il lavoro si fa una volta per fotogramma, non a ogni evento. Mentre la
// pagina scorre (rotella, dito) le locandine non reagiscono al passaggio del mouse:
// ingrandimenti e ombre ridisegnati a ogni riga che passa sotto il puntatore sono la
// prima causa degli scatti nello scorrimento veloce.
var scrollTick = false, scrollIdle = 0;
window.addEventListener('scroll', function () {
  if (!kb && !scrollIdle) document.body.classList.add('scrolling');
  clearTimeout(scrollIdle);
  scrollIdle = setTimeout(function () { scrollIdle = 0; document.body.classList.remove('scrolling'); }, 140);
  if (scrollTick) return;
  scrollTick = true;
  requestAnimationFrame(function () {
    scrollTick = false;
    if (currentHash) scrollMemory[currentHash] = window.pageYOffset;
    if (chunk && chunk.shown < chunk.list.length &&
        window.pageYOffset + window.innerHeight * 2.5 > document.documentElement.scrollHeight) growGrid();
  });
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
  [/^#\/posters\/(movie|show)\/(\d+)$/, postersPage],
  [/^#\/settings\/(\w+)$/, settingsArea],
  [/^#\/accounts$/, function () { location.replace('#/settings/people'); return ''; }],
  [/^#\/pair\/([A-Za-z0-9]+)$/, phonePairPage],
  [/^#\/news$/, newsPage],
  [/^#\/notifiche$/, allNoticesPage],
  [/^#\/doppioni$/, duplicatesPage],
  [/^#\/google(\/link)?$/, function (l) {
    if (!auth.google || TVLOGIN) { location.replace('#/settings/account'); return ''; }
    if (l && auth.user.linked) return googlePage(true);
    if (auth.user.linked && auth.user.online) { location.replace('#/settings/account'); return ''; }
    return googlePage(false);
  }],
  [/^#\/reset$/, function () {
    if (!auth.reset) { location.replace('#/settings/account'); return ''; }
    return resetPage();
  }],
  [/^#\/tvlogin$/, function () {
    if (!auth.cloud || auth.user.linked) { location.replace('#/settings/account'); return ''; }
    return tvLoginPage();
  }],
  // «Cambia profilo» e «Gestisci profili»: li mostra gate(); se no si torna alla Home
  [/^#\/(chi|profili)$/, function () { location.replace('#/home'); return ''; }],
  // Accesso e scelta del server: le mostra gate(); qui si arriva solo gia' fatto
  [/^#\/(login|server)$/, function () { location.replace('#/home'); return ''; }],
  // Impronta e volto (passkey): la mostra gate() nella PWA centrale; altrove alla Home
  [/^#\/(passkey|sicurezza)$/, function () { location.replace('#/home'); return ''; }],
  // Impostazioni dell'app: le mostra gate() nella PWA centrale dell'app; altrove alla Home
  [/^#\/app$/, function () { location.replace('#/home'); return ''; }],
  // I link delle email: li legge gate() (vedi cMailLink); qui si arriva solo gia' fatto
  [/^#\/(attiva|reset|entra)\?/, function () { location.replace('#/home'); return ''; }],
  [/^#\/tv$/, tvCodePage],
  // Il QR della TV (nella PWA centrale lo legge gate(); qui il codice e' di un altro tipo)
  [/^#\/tv\/[A-Za-z0-9-]+$/, function () { location.replace('#/tv'); return ''; }],
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

// Prima di ogni pagina: chi guarda? (scelta dell'account, password provvisoria da cambiare,
// impostazioni diverse da confrontare). Mai una pagina che chieda Internet per andare avanti.
async function gate() {
  // Android dall'indirizzo pubblico, nel browser: al posto di BunkerPlex l'app da installare
  if (getAppOnly()) { lockScreen(true); return getAppPage(); }
  if (CENTRAL) {
    var cg = await cGate();
    if (cg) return cg;
  }
  if (!auth) await loadAuth();
  markOffline();
  markMe();
  setTimeout(renderActivity, 0);
  if (!auth.user) {
    // Un solo account che si apre senza password: si entra da soli (non dopo «Esci»)
    var noAuto = false;
    try { noAuto = sessionStorage.getItem('fpNoAuto') === '1'; } catch (e) { /* niente */ }
    var only = auth.profiles && auth.profiles.length === 1 ? auth.profiles[0] : null;
    // Senza Internet, dalla rete di casa: si entra senza password (vedi /api/auth/home)
    if (!noAuto && auth.home && !gate.homeTried) {
      gate.homeTried = true;
      try {
        await post('/auth/home', { device: devName() });
        await loadAuth();
        if (auth.user) { toast('Senza Internet: entrato da casa come ' + auth.user.name); await afterLogin([]); }
      } catch (e) { /* si entra come sempre */ }
    }
    if (!noAuto && !auth.user && only && only.quick && !gate.tried) {
      gate.tried = true;
      try {
        await post('/auth/profile', { id: only.id, device: devName() });
        await loadAuth();
        if (auth.user) await afterLogin([]);
      } catch (e) { /* si mostra «Chi guarda?» */ }
    }
    if (!auth.user) {
      lockScreen(true);
      if (cache.ask) return askPage();
      if (location.hash === '#/google' && auth.google && !TVLOGIN) return googlePage(false);
      if (location.hash === '#/reset' && auth.reset) return resetPage();
      if (!auth.cloud || auth.setup) return profilesPage();
      // La TV entra sempre dal telefono (QR e codice): mai password o Google col telecomando
      if (TVLOGIN) return tvLoginPage();
      return location.hash === '#/tvlogin' ? tvLoginPage() : loginPage();
    }
  }
  cache.ask = null;
  if (auth.user.must_change && (needsName() || !pwLater())) { lockScreen(true); return passwordPage(true); }
  if (conflicts) { lockScreen(true); return conflictsPage(); }
  // Quale server: a ogni apertura (e da «Cambia server»)
  if (needServer() || (location.hash === '#/server' && auth.cloud)) { lockScreen(true); return serversPage(); }
  // «Gestisci profili» e «Chi guarda?» dei profili dell'account: dopo il login, mai al posto
  // della password (nella PWA centrale li mostra cGate, con i profili del servizio)
  var cp = CENTRAL && C.profiles;
  if (!cp && location.hash === '#/profili' && canManageProfiles()) { lockScreen(true); return profilesManagePage(); }
  if (!cp && (needWatcher() || (location.hash === '#/chi' && profList().length))) { lockScreen(true); return whoPage(); }
  // Profilo bambini: niente impostazioni e niente pagine che cambiano le raccolte (il server dice comunque no)
  if (kidsNow() && /^#\/(settings|newlib|rename|browse|match|posters|password|tv$|doppioni|accounts|profili)/.test(location.hash)) {
    location.replace('#/home');
    return '<div class="page"></div>';
  }
  lockScreen(false);
  return null;
}

// ---------------------------------------------------------------- Profili dell'account
// Come Netflix: un account ha fino a 6 profili (il principale, id 0, e fino a 5 aggiunti),
// ognuno con visti, ripresa e La mia lista suoi, avatar, colore, PIN facoltativo e
// «bambini» (solo le raccolte per bambini, niente impostazioni). Con l'account i profili
// stanno nel servizio account e sono gli stessi su ogni server, TV e telefono (stessi id).
// Si sceglie in «Chi guarda?», sempre dopo essere entrati con l'account: nella PWA
// centrale con i profili del servizio (POST /profiles/:id/open da' un biglietto che si
// passa ai server, vedi cWhoOpen), servita dal server con /api/profiles.
// Ogni dispositivo ricorda il suo finche' non si cambia o si esce.
var MAX_PROFILES = 6;
var PROFILE_AVATARS = { cat: '🐱', fox: '🦊', panda: '🐼', frog: '🐸', lion: '🦁', penguin: '🐧', octopus: '🐙',
  unicorn: '🦄', rocket: '🚀', ball: '⚽', game: '🎮', film: '🎬' };
var PROFILE_COLORS = ['#e50914', '#f5a623', '#2ecc71', '#1abc9c', '#3498db', '#9b59b6', '#e84393', '#7f8c8d'];
var LOCK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
var PEN_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg>';

// Il volto di un profilo: l'avatar (emoji) o l'iniziale, sul suo colore o sulla tinta del nome
function pface(p, cls) {
  var emo = PROFILE_AVATARS[p.avatar] || '';
  var col = PROFILE_COLORS.indexOf(p.color) >= 0 ? p.color : '';
  return '<i class="uface' + (cls ? ' ' + cls : '') + (emo ? ' emo' : '') + (col ? ' pc' : '') + '" style="--h:' + hue(p.name) +
    (col ? ';--pc:' + col : '') + '" aria-hidden="true">' + (emo || esc(personInitial(p.name))) + '</i>';
}

// I profili: nella PWA centrale quelli del servizio (se raggiungibile), se no quelli del server
function profList() {
  if (CENTRAL && C.profiles) return C.profiles;
  var u = auth && auth.user;
  return (u && u.watchers) || [];
}

// Il profilo scelto (id; null = ancora da scegliere)
function profCur() {
  if (CENTRAL && C.profiles) return C.pid;
  var u = auth && auth.user;
  return u ? u.watcher : null;
}

function profById(id) {
  if (id === null || id === undefined) return null;
  return profList().filter(function (p) { return String(p.id) === String(id); })[0] || null;
}

function curProfile() { return profById(profCur()); }

// Sta guardando un profilo bambini?
function kidsNow() {
  if (auth && auth.user && auth.user.kids) return true;
  var p = CENTRAL && C.profiles ? curProfile() : null;
  return !!(p && p.kids);
}

function hasWatchers() { return profList().length > 1; }

// Aggiungere, cambiare, togliere profili: mai da un profilo bambini ne' da ospite
function canManageProfiles() {
  if (kidsNow()) return false;
  if (CENTRAL && C.profiles) return true;
  var u = auth && auth.user;
  return !!(u && !u.guest && !u.friend);
}

// «Chi guarda?» gia' risposto in questa apertura dell'app
function whoKey() {
  return CENTRAL && C.profiles ? 'bpWho' : 'fpWho:' + (auth && auth.user ? auth.user.id : '');
}

// Servita dal server: con piu' profili (o uno solo con il PIN) si chiede a ogni apertura
function needWatcher() {
  if (CENTRAL && C.profiles) return false;
  var u = auth && auth.user, list = profList();
  if (!u || !list.length) return false;
  if (list.length === 1 && !list[0].pin) return false;
  if (u.watcher === null || u.watcher === undefined) return true;
  // A ogni apertura si richiede chi guarda (il profilo resta proposto per primo)
  try { return sessionStorage.getItem(whoKey()) !== '1'; } catch (e) { return false; }
}

function watcherName() {
  var p = curProfile();
  if (p) return p.name;
  var u = auth && auth.user;
  return u ? u.name : (C.user && C.user.username) || '';
}

function whoPage() {
  var list = profList(), cur = profCur(), ask = cache.pinAsk;
  var askP = ask ? profById(ask.id) : null;
  if (askP) return pinPage(askP, ask.err);
  cache.pinAsk = null;
  var chosen = !!profById(cur);
  var cards = list.map(function (p, n) {
    var me = chosen && String(p.id) === String(cur);
    return '<button class="profile f' + (me ? ' on' : '') + '"' + (me || (!chosen && n === 0) ? ' data-autofocus' : '') +
      ' data-act="watcher" data-arg="' + p.id + '" data-key="watch-' + p.id + '"' +
      ' aria-label="' + esc(p.name + (p.pin ? ', con PIN' : '') + (p.kids ? ', bambini' : '')) + '">' +
      '<i class="pfwrap">' + pface(p, 'big') + (p.pin ? '<i class="plock">' + LOCK_ICON + '</i>' : '') + '</i>' +
      '<span>' + esc(p.name) + '</span>' + (p.kids ? '<em class="pkids">Bambini</em>' : '') + '</button>';
  }).join('');
  var need = CENTRAL && C.profiles ? cNeedWho() : needWatcher();
  // Nella PWA centrale il server si sceglie dopo il profilo; servita dal server, prima
  var server = CENTRAL ? !need : !!(auth && auth.cloud);
  return authShell('<h1>Chi guarda?</h1><p class="authsub">Ognuno ha i suoi visti, la sua ripresa e la sua lista</p>' +
    '<div class="profiles whopick">' + cards + '</div>' +
    '<div class="authrow">' +
      (canManageProfiles() ? '<a class="authlink f" href="#/profili" data-key="watch-manage">Gestisci profili</a>' : '') +
      (need ? '' : '<a class="authlink f" href="#/home" data-key="watch-back">Indietro</a>') +
      (server ? '<a class="authlink f" href="#/server" data-key="watch-server">Cambia server</a>' : '') +
      '<button class="authlink f" data-act="logout" data-key="watch-logout">Esci</button></div>', 'grid');
}

// Il PIN di un profilo: campo (tastiera del telefono o del PC) e tastierino per il telecomando
function pinPage(p, err) {
  var pad = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'ok'].map(function (k) {
    if (k === 'ok') return '<button class="f pinok" data-act="pinok" data-key="pin-ok">OK</button>';
    if (k === 'del') return '<button class="f" data-act="pinkey" data-arg="del" data-key="pin-del" aria-label="Cancella">⌫</button>';
    return '<button class="f"' + (TVLOOK && k === '1' ? ' data-autofocus' : '') + ' data-act="pinkey" data-arg="' + k + '" data-key="pin-' + k + '">' + k + '</button>';
  }).join('');
  return { html: authShell('<div class="pinhead"><i class="pfwrap">' + pface(p, 'big') + '<i class="plock">' + LOCK_ICON + '</i></i></div>' +
    '<h1>' + esc(p.name) + '</h1>' +
    '<p class="authsub">' + (err ? '<span class="nodot">' + esc(err) + '</span>' : 'Scrivi il PIN del profilo') + '</p>' +
    '<input class="field f num pinfield" id="pin" data-key="pin"' + (TVLOOK ? '' : ' data-autofocus') +
      ' type="password" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" data-enter="pinok" aria-label="PIN di 4 cifre">' +
    '<div class="pinpad">' + pad + '</div>' +
    '<button class="authlink f" data-act="pincancel" data-key="pin-cancel">Annulla</button>'),
    mount: function () {
      var input = document.getElementById('pin');
      if (!input) return;
      input.value = '';
      // Alla quarta cifra si prova da solo
      input.addEventListener('input', function () {
        var v = input.value.replace(/\D/g, '').slice(0, 4);
        if (v !== input.value) input.value = v;
        if (v.length === 4) actions.pinok();
      });
    } };
}

// Sceglie il profilo (con il PIN, se ne ha uno). Errori: 412 serve il PIN, 401 sbagliato,
// 429 troppi tentativi (5 minuti)
function whoChoose(id, pin) {
  var p = profById(id);
  if (!p) return;
  if (p.pin && !pin) { cache.pinAsk = { id: p.id, err: '' }; render(); return; }
  if (whoChoose.busy) return;
  whoChoose.busy = true;
  var cloudSide = CENTRAL && C.profiles;
  var go = cloudSide ? cWhoOpen(p.id, pin)
    : post('/profiles/select', pin ? { id: p.id, pin: pin } : { id: p.id }).then(watcherChanged);
  go.then(function () {
    whoChoose.busy = false;
    cache.pinAsk = null;
    try { sessionStorage.setItem(whoKey(), '1'); } catch (e) { /* niente */ }
    toast('Ciao ' + p.name);
    if (location.hash === '#/home') render(); else location.replace('#/home');
  }, function (e) {
    whoChoose.busy = false;
    if (e.status === 412 || e.status === 401 || e.status === 429) {
      var err = e.status === 412 ? '' : e.status === 429 ? 'Troppi PIN sbagliati: riprova tra qualche minuto' : (e.message || 'PIN sbagliato');
      cache.pinAsk = { id: p.id, err: err };
      if (err) toast(err);
      render().then(function () {
        var i = document.getElementById('pin');
        if (i) { i.value = ''; if (!TVLOOK) i.focus(); }
      });
      return;
    }
    toast(e.message);
    if (!cloudSide) loadAuth().then(render);
  });
}

// «Gestisci profili»: i volti con la matita; uno si apre per cambiarlo
function profilesManagePage() {
  if (cache.pEdit) return profileEditPage(cache.pEdit);
  var list = profList();
  var cards = list.map(function (p, n) {
    return '<button class="profile f"' + (n === 0 ? ' data-autofocus' : '') + ' data-act="pedit" data-arg="' + p.id + '" data-key="pman-' + p.id + '"' +
      ' aria-label="Modifica ' + esc(p.name) + '">' +
      '<i class="pfwrap">' + pface(p, 'big') + '<i class="ppen">' + PEN_ICON + '</i>' + (p.pin ? '<i class="plock">' + LOCK_ICON + '</i>' : '') + '</i>' +
      '<span>' + esc(p.name) + '</span>' + (p.kids ? '<em class="pkids">Bambini</em>' : p.main ? '<em class="pmain">Principale</em>' : '') + '</button>';
  }).join('');
  if (list.length < MAX_PROFILES) {
    cards += '<button class="profile addp f" data-act="pnew" data-key="pman-new"><i class="pfwrap"><i class="uface big">' + PLUS_ICON + '</i></i>' +
      '<span>Aggiungi profilo</span></button>';
  }
  var linked = (CENTRAL && C.profiles) || (auth && auth.user && auth.user.linked);
  return authShell('<h1>Gestisci profili</h1><p class="authsub">' +
      (linked ? 'I profili sono del tuo account: valgono su ogni server, TV e telefono.' : 'Senza account i profili restano su questo PC.') +
      ' Al massimo ' + MAX_PROFILES + '.</p>' +
    '<div class="profiles whopick">' + cards + '</div>' +
    '<div class="authrow"><a class="authlink f" href="' + (hasWatchers() ? '#/chi' : '#/home') + '" data-key="pman-done">Fatto</a></div>', 'grid');
}

// Un profilo da creare (id null) o da cambiare: nome, avatar, colore, bambini, PIN
function profileEditPage(ed) {
  // Il PIN si controlla nel servizio account: senza account non c'e'
  var linked = (CENTRAL && C.profiles) || (auth && auth.user && auth.user.linked);
  var avatars = [''].concat(Object.keys(PROFILE_AVATARS)).map(function (k) {
    return '<button class="pav f' + (ed.avatar === k ? ' on' : '') + '" data-act="pavatar" data-arg="' + k + '" data-key="pav-' + (k || 'none') + '"' +
      ' aria-pressed="' + (ed.avatar === k) + '" aria-label="' + (k ? 'Avatar ' + k : 'Iniziale del nome') + '">' +
      (k ? PROFILE_AVATARS[k] : '<b>' + esc(personInitial(ed.name || '?')) + '</b>') + '</button>';
  }).join('');
  var colors = [''].concat(PROFILE_COLORS).map(function (c) {
    return '<button class="pcol f' + (ed.color === c ? ' on' : '') + '" style="--pc:' + (c || 'hsl(' + hue(ed.name || '?') + ' 26% 30%)') + '"' +
      ' data-act="pcolor" data-arg="' + c + '" data-key="pcol-' + (c ? c.slice(1) : 'auto') + '"' +
      ' aria-pressed="' + (ed.color === c) + '" aria-label="' + (c ? 'Colore ' + c : 'Tinta dal nome') + '"></button>';
  }).join('');
  var pin = '';
  if (linked) {
    pin = '<p class="flabel">PIN</p><p class="pnote">' +
        (ed.pinOp === 'del' ? 'Il PIN si toglie quando salvi.' : ed.pin ? 'Per aprire questo profilo serve un PIN di 4 cifre.'
          : 'Nessun PIN: chi usa l\'account apre il profilo con un tocco.') + '</p>' +
      (ed.pinOp === 'set' ? '<div class="pinnew">' +
        '<input class="field f num" id="pfpin" data-key="pfpin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="new-password" placeholder="PIN nuovo (4 cifre)" value="' + esc(ed.pin1 || '') + '">' +
        '<input class="field f num" id="pfpin2" data-key="pfpin2" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="new-password" data-enter="psave" placeholder="Ripeti il PIN" value="' + esc(ed.pin2 || '') + '"></div>' : '') +
      '<div class="actions">' +
        '<button class="btn f" data-act="ppin" data-arg="set" data-key="ppin-set">' + (ed.pinOp === 'set' ? 'Non cambiare il PIN' : ed.pin ? 'Cambia PIN' : 'Metti un PIN') + '</button>' +
        (ed.pin ? '<button class="btn f" data-act="ppin" data-arg="del" data-key="ppin-del">' + (ed.pinOp === 'del' ? 'Tieni il PIN' : 'Togli il PIN') + '</button>' : '') +
      '</div>';
  }
  return authShell('<h1>' + (ed.id === null ? 'Nuovo profilo' : 'Modifica profilo') + '</h1>' +
    '<div class="pedit"><div class="pedhead">' + pface({ name: ed.name || '?', avatar: ed.avatar, color: ed.color }, 'big') + '</div>' +
    '<label class="flabel" for="pfname">Nome</label>' +
    '<input class="field f" id="pfname" data-key="pfname"' + (ed.id === null ? ' data-autofocus' : '') + ' maxlength="24" autocomplete="off" data-enter="psave" value="' + esc(ed.name) + '">' +
    '<p class="flabel">Avatar</p><div class="pavatars">' + avatars + '</div>' +
    '<p class="flabel">Colore</p><div class="pcolors">' + colors + '</div>' +
    (ed.main ? '<p class="pnote">Profilo principale: è l\'account, non si toglie e non può essere per bambini.</p>'
      : swRow('Profilo per bambini', ed.kids, 'data-act="pkids" data-key="pkids"', ed.kids ? 'Solo le raccolte per bambini, niente impostazioni' : 'Vede tutte le raccolte')) +
    pin +
    '<div class="actions pactions"><button class="btn primary f" data-act="psave" data-key="psave">Salva</button>' +
      '<button class="btn f" data-act="pcancel" data-key="pcancel">Annulla</button>' +
      (ed.id !== null && !ed.main ? '<button class="btn danger f" data-act="pdel" data-key="pdel">Togli il profilo</button>' : '') + '</div></div>', true);
}

// Quello che si sta scrivendo resta quando la pagina si ridisegna (avatar, colore…)
function pEditKeep() {
  var ed = cache.pEdit;
  if (!ed) return;
  var n = document.getElementById('pfname'), a = document.getElementById('pfpin'), b = document.getElementById('pfpin2');
  if (n) ed.name = n.value;
  if (a) ed.pin1 = a.value;
  if (b) ed.pin2 = b.value;
}

async function profileSave() {
  pEditKeep();
  var ed = cache.pEdit;
  if (!ed) return;
  var name = String(ed.name || '').trim();
  if (!name) { toast('Scrivi il nome del profilo'); return; }
  var body = { name: name, avatar: ed.avatar || '', color: ed.color || '' };
  if (!ed.main) body.kids = !!ed.kids;
  if (ed.pinOp === 'set') {
    if (!/^\d{4}$/.test(ed.pin1 || '')) { toast('Il PIN è di 4 cifre'); return; }
    if (ed.pin1 !== ed.pin2) { toast('I due PIN non sono uguali'); return; }
    body.pin = ed.pin1;
  } else if (ed.pinOp === 'del') {
    body.pin = '';
  }
  try {
    if (CENTRAL && C.profiles) {
      // Direttamente nel servizio; poi il tuo server aperto li rilegge
      var r = ed.id === null ? await cloud('POST', '/profiles', body) : await cloud('PUT', '/profiles/' + ed.id, body);
      C.profiles = r.profiles || C.profiles;
      await cServerProfiles();
    } else {
      if (ed.id === null) await post('/profiles', body); else await send('PUT', '/profiles/' + ed.id, body);
      await watcherChanged();
    }
    cache.pEdit = null;
    toast(ed.id === null ? 'Profilo «' + name + '» aggiunto' : 'Profilo salvato');
    render();
  } catch (e) { toast(e.message); }
}

async function profileDelete(id) {
  try {
    if (CENTRAL && C.profiles) {
      var r = await cloud('DELETE', '/profiles/' + id);
      C.profiles = r.profiles || C.profiles;
      cTicketSet(id, '');
      if (C.pid === id) { C.pid = null; cSave(); }
      await cServerProfiles();
    } else {
      await send('DELETE', '/profiles/' + id);
      await watcherChanged();
    }
    cache.pEdit = null;
    toast('Profilo tolto');
    render();
  } catch (e) { toast(e.message); }
}

// Dopo una modifica fatta nel servizio: il tuo server aperto la rilegge subito
async function cServerProfiles() {
  if (!C.base || C.role !== 'owner' || !auth || !auth.user) return;
  await post('/profiles/refresh').catch(function () {});
  await watcherChanged();
}

// Impostazioni → Account: i profili dell'account e i pulsanti per gestirli
function watchersPanel(u) {
  if (!canManageProfiles()) return '';
  var cur = profCur();
  var faces = profList().map(function (p) {
    return '<span class="pmini">' + pface(p, 'mid') + '<b>' + esc(p.name) + '</b>' +
      (p.pin ? '<i class="plock sm" title="Con il PIN">' + LOCK_ICON + '</i>' : '') +
      (p.kids ? '<em class="pkids">Bambini</em>' : '') +
      (cur !== null && cur !== undefined && String(p.id) === String(cur) ? '<small>in uso qui</small>' : '') + '</span>';
  }).join('');
  var linked = (CENTRAL && C.profiles) || u.linked;
  return '<div class="panel"><h2>Profili</h2>' +
    '<p>Chi usa il tuo account può avere il suo profilo, con visti, ripresa e La mia lista suoi, un PIN e, per i più piccoli, solo le raccolte per bambini. ' +
    (linked ? 'I profili sono dell\'account: valgono su ogni server, TV e telefono.' : 'Senza account restano su questo PC.') + '</p>' +
    '<div class="pminis">' + faces + '</div>' +
    '<div class="actions"><a class="btn primary f" href="#/profili" data-key="pmanage">Gestisci profili</a>' +
      (hasWatchers() ? '<a class="btn f" href="#/chi" data-key="watchswitch">Cambia profilo</a>' : '') + '</div></div>';
}

function watcherChanged(r) {
  dropCached();
  libsLoadedAt = 0;
  return loadAuth().then(function () { markMe(); return r; });
}

// ---------------------------------------------------------------- Collegamento all'account
// Un server nuovo entra nell'account solo quando il proprietario lo conferma (come
// plex.tv/claim). Chi e' entrato qui con l'account lo collega con un tocco
// (GET/POST /api/server/claim); altrimenti il server mostra un codice da scrivere in
// BunkerPlex sul telefono (Server → Aggiungi un server) e aspetta da solo la conferma.
function claimOpen() {
  var c = auth && auth.claim;
  return !!(c && !c.claimed);
}

function claimCanLink() {
  var u = auth && auth.user;
  return !!(u && u.linked && !u.guest && !kidsNow());
}

// Il riquadro: nella pagina di accesso e (panel) in Impostazioni → Account
function claimBox(panel) {
  if (!claimOpen() || kidsNow()) return '';
  var c = auth.claim, body;
  if (claimCanLink()) {
    var st = cache.claimPrev;
    if (!st) {
      body = '<p>Collegalo al tuo account: lo ritrovi tra i tuoi server su ogni dispositivo, anche fuori casa.</p>' +
        '<div class="actions"><button class="btn primary f" data-act="claimprep" data-key="claimprep">Collega al mio account</button></div>';
    } else if (st.taken) {
      body = '<p>Questo server risulta già collegato a un altro account.</p>' +
        '<div class="actions"><button class="btn f" data-act="claimcancel" data-key="claimcancel">Chiudi</button></div>';
    } else {
      body = '<label class="flabel" for="claimname">Nome del server</label>' +
        '<input class="field f" id="claimname" data-key="claimname" maxlength="40" autocomplete="off" data-enter="claimgo" value="' + esc(st.name) + '">' +
        sameMachineHtml(st.same_machine || [], st.replace, 'claimpick') +
        '<div class="actions"><button class="btn primary f" data-act="claimgo" data-key="claimgo">' + (st.replace ? 'Sostituisci e collega' : 'Collega') + '</button>' +
        '<button class="btn f" data-act="claimcancel" data-key="claimcancel">Annulla</button></div>';
    }
  } else if (c.code && c.exp * 1000 > Date.now()) {
    claimPoll();
    body = '<p>Apri BunkerPlex sul telefono → <b>Server</b> → <b>Aggiungi un server</b> e scrivi questo codice:</p>' +
      '<div class="tvcode small num claimcode">' + esc(c.code) + '</div>' +
      '<p class="kvnote">Vale 15 minuti. Quando lo confermi, questo server entra nel tuo account da solo.</p>';
  } else {
    // Il servizio ha detto che serve il collegamento: il codice compare da solo
    if (c.need && !cache.claimAsked) { cache.claimAsked = true; setTimeout(claimShowCode, 0); }
    body = '<p>Per vederlo dal telefono e da fuori casa collegalo al tuo account con un codice.</p>' +
      '<div class="actions"><button class="btn primary f" data-act="claimcode" data-key="claimcode">Mostra il codice</button></div>';
  }
  return '<div class="' + (panel ? 'panel ' : '') + 'claimbox"><h2>Questo server non è collegato a un account</h2>' + body + '</div>';
}

function claimPanel() { return claimBox(true); }

// I tuoi server sulla stessa macchina: quelli spenti si possono sostituire, quelli accesi restano a parte
function sameMachineHtml(same, sel, act) {
  var off = same.filter(function (s) { return !s.online; });
  var on = same.filter(function (s) { return s.online; });
  var html = '';
  if (off.length) {
    html += '<p class="flabel">Sulla stessa macchina</p><div class="cpicks">' + off.map(function (s) {
      return '<button class="cpick f' + (sel === s.sid ? ' on' : '') + '" data-act="' + act + '" data-arg="' + esc(s.sid) + '" data-key="cl-' + esc(s.sid) + '" aria-pressed="' + (sel === s.sid) + '">' +
        'Sostituisce «' + esc(s.name) + '» (stessa macchina, spento)<small>Prende il suo posto: nome, aspetto e amici' +
        (s.seen ? ' · visto ' + esc(ago(s.seen)) : '') + (s.version ? ' · ' + esc(srvVersion(s.version)) : '') + '</small></button>';
    }).join('') +
      '<button class="cpick f' + (!sel ? ' on' : '') + '" data-act="' + act + '" data-arg="" data-key="cl-new" aria-pressed="' + !sel + '">Tienilo come nuovo server' +
      '<small>' + (off.length === 1 ? '«' + esc(off[0].name) + '» resta nell\'elenco, spento' : 'Quelli di prima restano nell\'elenco, spenti') + '</small></button></div>';
  }
  return html + on.map(function (s) {
    return '<p class="claimwarn">Sulla stessa macchina c\'è già «' + esc(s.name) + '» acceso: saranno due server separati.</p>';
  }).join('');
}

// Il nome proposto segue la scelta (quello del server sostituito o quello nuovo), se non l'hai cambiato tu
function claimPickName(same, oldSel, newSel, typed, fresh) {
  function def(sid) {
    var s = same.filter(function (x) { return x.sid === sid; })[0];
    return s ? s.name : (fresh || '');
  }
  return typed && typed !== def(oldSel) ? typed : def(newSel);
}

function claimShowCode() {
  post('/auth/claim').then(function (c) {
    if (auth) auth.claim = c;
    if (c.claimed) { auth = null; }
    render();
  }, function (e) { toast(e.message); });
}

// Finche' il codice e' a schermo si chiede ogni 5 secondi se e' stato confermato
function claimPoll() {
  if (cache.claimTimer) return;
  cache.claimTimer = setTimeout(function () {
    cache.claimTimer = 0;
    if (!claimOpen() || !view.querySelector('.claimbox')) return;
    api('/auth/claim').then(function (c) {
      if (!auth) return;
      var was = auth.claim || {};
      auth.claim = c;
      if (c.claimed) {
        toast('Server collegato all\'account' + (c.owner ? ' di ' + c.owner : ''));
        auth = null;
        render();
        return;
      }
      if (c.code !== was.code) { render(); return; }    // scaduto: si ridisegna
      claimPoll();
    }, function () { claimPoll(); });
  }, 5000);
}

function claimPrepare() {
  api('/server/claim').then(function (r) {
    if (r.claimed) { auth = null; render(); return; }
    // Proposta: sostituire il primo tuo server spento sulla stessa macchina (prende il suo nome)
    var old = (r.same_machine || []).filter(function (x) { return !x.online; })[0];
    cache.claimPrev = { same_machine: r.same_machine || [], taken: !!r.taken, replace: old ? old.sid : '', name: old ? old.name : (r.name || '') };
    render();
  }, function (e) { toast(e.message); });
}

function claimConfirm() {
  var st = cache.claimPrev;
  if (!st) return;
  var name = fieldValue('claimname').trim();
  if (!name) { toast('Dai un nome al server'); return; }
  toast('Collego il server…');
  post('/server/claim', st.replace ? { name: name, replace: st.replace } : { name: name }).then(function (c) {
    cache.claimPrev = null;
    toast(c.claimed ? 'Fatto: «' + (c.name || name) + '» è nel tuo account' : 'Collegamento in corso…');
    auth = null;
    render();
  }, function (e) { toast(e.message); });
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

// Sagome grigie al posto della pagina che sta arrivando
function skeleton(h) {
  function boxes(n, cls) { var b = ''; for (var i = 0; i < n; i++) b += '<div class="card ' + cls + '"><div class="art skel"></div></div>'; return b; }
  if (h === '#/home') {
    return '<div class="home"><div class="stage"></div><div class="rows">' +
      [0, 1, 2].map(function () { return '<section class="section"><h2><i class="skel line"></i></h2><div class="row">' + boxes(8, 'poster') + '</div></section>'; }).join('') +
      '</div></div>';
  }
  if (/^#\/(lib\/|sagas|mylist|search)/.test(h)) {
    return '<div class="page"><div class="toolbar"><i class="skel title"></i></div><div class="grid">' + boxes(18, 'poster') + '</div></div>';
  }
  if (/^#\/(show|item|saga)\//.test(h)) {
    return '<header class="hero"><div class="in"><div class="txt"><i class="skel title"></i><i class="skel line"></i><i class="skel line"></i><i class="skel line short"></i></div></div></header>';
  }
  return '';
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

  // Se la pagina tarda (prima volta, rete lenta) si mostra subito la sua sagoma
  var skel = h !== currentHash ? setTimeout(function () {
    if (token !== renderToken) return;
    var shape = skeleton(h);
    if (!shape) return;
    view.classList.remove('enter');
    view.innerHTML = shape;
    lastHtml = '';
  }, 180) : 0;
  var out;
  try {
    // Il telefono che entra per la TV non deve scegliere un account per se'
    var pairing = handler === phonePairPage;
    out = pairing ? null : await gate();
    if (pairing) {
      lockScreen(true);
      out = await phonePairPage(match[1].toUpperCase());
    } else if (out) {
      h = '#/login';
    } else {
      // Il menu delle raccolte si aggiorna in sottofondo: la pagina non lo aspetta
      if (libsLoadedAt) loadLibs().then(function () { markRail(currentHash); }).catch(function () {});
      else await loadLibs();
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
  clearTimeout(skel);
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
  markLoadedImages(view);            // gia' pronte (dalla cache): subito, senza dissolvenza
  popKeys.forEach(function (k) { var p = byKey(k); if (p && view.contains(p)) p.classList.add('popped'); });
  popKeys = [];
  if (!samePage) {   // pagina nuova: entra con un movimento breve (solo opacita' e spostamento)
    void view.offsetWidth;
    view.classList.add('enter');
    clearTimeout(enterTimer);
    enterTimer = setTimeout(function () { view.classList.remove('enter'); }, 500);
  }
  if (out.mount) out.mount();
  enhancePasswords(view);
  showAuthErr();
  markRail(h);
  markGetApp();
  showActiveTab();
  setTimeout(warnPaths, 0);

  var key = focusMemory[h];
  var el = byKey(key);
  if (el && !view.contains(el)) el = null;
  // Nelle Impostazioni il primo fuoco va al contenuto, non al menu laterale ne' a «‹ Impostazioni»
  if (!el && !player) el = view.querySelector('[data-autofocus]') || view.querySelector('.f:not(.sup):not(.snav)') || view.querySelector('.f') || rail.querySelector('.railitem.on');
  // Impostazioni a due colonne: aperta un'area il fuoco resta sull'elenco (sulla sua voce),
  // o va nel contenuto se ci si e' entrati con OK o freccia destra
  var sc = !samePage && !player ? settingsCols() : null;
  if (sc) el = (settingsEnter && settingsFirst(sc.main)) || settingsCurrent(sc.col);
  if (!samePage) settingsEnter = false;
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
// «Guarda su»: se una TV sta gia' trasmettendo (avviata da qui o da un altro dispositivo), la barra-telecomando
window.addEventListener('hashchange', function () { renderCastBar(); });
setTimeout(castPoll, 1500);

// L'app Android chiama queste due funzioni
window.fpBack = function () {
  if (closeModal()) return true;
  if (player && player.leaveRow && player.leaveRow()) return true;   // Indietro esce dai comandi del video
  if (!player && settingsBack()) return true;                         // Impostazioni: area → elenco → barra
  // Dalla Home Indietro chiude l'app: prima si chiede conferma (serve un'app che
  // sappia chiudersi su richiesta; con una versione vecchia si esce come prima)
  if (!player && currentHash === '#/home' && APP && typeof tvApp.exit === 'function') {
    confirmBox('Vuoi uscire da BunkerPlex?', 'Esci', function () { tvApp.exit(); });
    return true;
  }
  if (rail.contains(document.activeElement)) { focusView(); return true; }
  return false;
};
window.fpRefresh = function () { libsLoadedAt = 0; dropCached(); render(); };

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
if (APP) {
  setTimeout(checkUpdate, 2500);
  setInterval(checkUpdate, 30 * 60 * 1000);
}

// Su PC e TV: c'e' un aggiornamento di BunkerPlex trovato dal server su GitHub?
setTimeout(checkServerUpdate, 1500);
setInterval(checkServerUpdate, 30 * 60 * 1000);

// Interfaccia nuova: quando il server si aggiorna da solo (o la PWA centrale cambia)
// le schede gia' aperte tengono in memoria quella vecchia. Ogni 5 minuti, e quando si
// torna sulla scheda, si guarda se app.js e' cambiato (ETag / Last-Modified): se si',
// si ricarica la pagina, ma mai durante un video, con una finestra aperta o mentre si scrive.
var uiStamp = { url: '', first: '', stale: false };
(function () {
  var s = document.currentScript && document.currentScript.src;
  if (s && /^https?:/.test(s)) uiStamp.url = s.split('#')[0];
})();

function uiBusy() {
  var a = document.activeElement;
  // Si sta scrivendo: un campo con dentro qualcosa (il cursore in un campo vuoto non conta)
  var typing = a && (((a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') && a.value) || a.isContentEditable);
  return !!player || serverUpdating || !modal.hidden || typing || document.body.classList.contains('playing');
}

function checkUiStamp() {
  if (!uiStamp.url) return;
  if (uiStamp.stale) { if (!uiBusy()) location.reload(); return; }
  fetch(uiStamp.url, { method: 'HEAD', cache: 'no-store' }).then(function (r) {
    if (!r.ok) return;
    var tag = r.headers.get('ETag') || r.headers.get('Last-Modified') || '';
    if (!tag) return;
    if (!uiStamp.first) { uiStamp.first = tag; return; }
    if (tag !== uiStamp.first) {
      uiStamp.stale = true;
      if (!uiBusy()) location.reload();
    }
  }).catch(function () {});
}
setTimeout(checkUiStamp, 3000);
setInterval(checkUiStamp, 5 * 60 * 1000);
document.addEventListener('visibilitychange', function () { if (!document.hidden) checkUiStamp(); });
// Rimandata (video, finestra aperta...): appena si cambia pagina
window.addEventListener('hashchange', function () { if (uiStamp.stale) setTimeout(checkUiStamp, 0); });

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
  var srv = auth && auth.pc ? ' · ' + auth.pc : '';
  if (u && u.phase === 'pc') {
    ops.push({ key: 'upd', title: 'Aggiornamento del server' + srv, text: 'Scarico le novità e riallineo Docker…', pct: null, href: '#/settings/updates' });
  }
  if (u && u.phase === 'host') {
    notes.push({ key: 'updhost', title: 'Aggiornamento del server da completare', text: 'Rilancia «Installa BunkerPlex» sul computer', href: '#/settings/updates' });
  } else if (i.update && !(u && u.phase)) {
    notes.push({ key: 'upd', title: 'Aggiornamento del server disponibile', text: 'Server' + srv + ': installalo da Impostazioni → Aggiornamenti', href: '#/settings/updates' });
  }
  if (i.updated) {
    var ch = i.updated.changes || [];
    notes.push({ key: 'updated:' + i.updated.to, title: 'Il server' + srv + ' è stato aggiornato', href: '#/news',
      text: ch.length ? ch[0] + (ch.length > 1 ? ' e altre ' + (ch.length - 1) + ' novità' : '') : 'Guarda cosa c\'è di nuovo' });
  }
  if (i.duplicates) {
    notes.push({ key: 'dup:' + i.duplicates, href: '#/doppioni', title: i.duplicates === 1 ? 'Un titolo è doppio' : i.duplicates + ' titoli doppi',
      text: 'Lo stesso film o episodio in più file: scegli quale copia tenere' });
  }
  if (i.devices_full) {
    notes.push({ key: 'devfull', href: '#/settings/pcs', title: 'Troppi dispositivi nell\'account',
      text: 'Questo PC non raggiunge amici e tuoi PC: togli un dispositivo in Impostazioni → PC e dispositivi' });
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
  if (appOld(i)) {
    notes.push({ key: 'tvapp:' + appLatest(i).code, title: 'Nuova versione dell\'' + appLabel(true), text: 'Aggiornala da Impostazioni → ' + appLabel(), href: '#/settings/app' });
  }
  return { ops: ops, notes: notes, news: i.notices || [] };
}

// Gli avvisi dell'account (nuovi titoli, amici, aggiornamenti): letti e non letti.
// Toccandone uno si segna letto; «Segna tutte come lette» li azzera tutti.
function noticeRows(list, prefix) {
  return list.map(function (n) {
    return '<button class="actrow f ' + (n.read ? 'read' : 'unread') + '" data-act="noticeread" data-arg="' + n.id + '" data-key="' + prefix + n.id + '">' +
      '<span class="ndot" aria-hidden="true"></span><span class="acttxt"><b>' + esc(n.title) + '</b><small>' + esc(n.body) +
      '</small><small class="nwhen">' + (n.read ? '' : 'Non letta · ') + esc(noticeWhen(n.t)) + '</small></span></button>';
  }).join('');
}

function markShown(id) {
  document.querySelectorAll('[data-act="noticeread"][data-arg="' + id + '"]').forEach(function (el) {
    el.classList.replace('unread', 'read');
    var w = el.querySelector('.nwhen');
    if (w) w.textContent = w.textContent.replace('Non letta · ', '');
  });
}

function unreadNotices(list) {
  return (list || []).filter(function (n) { return !n.read; }).length;
}

// La campanella mostra solo le attivita' in corso e quello che e' da leggere:
// le segnalazioni non ancora aperte e gli avvisi non letti. Tutto il resto
// (letti compresi) sta nella pagina «Tutte le notifiche» (#/notifiche).
function noteRows(list, prefix) {
  return list.map(function (n) {
    return '<button class="actrow f' + (act.seen[n.key] ? ' read' : ' unread') + '" data-act="noteopen" data-arg="' + esc(n.key) + '" data-key="' + prefix + esc(n.key) + '">' +
      '<span class="ndot" aria-hidden="true"></span><span class="acttxt"><b>' + esc(n.title) + '</b><small>' + esc(n.text) + '</small></span>' + CHEVRON + '</button>';
  }).join('');
}

function opRows(ops) {
  return ops.map(function (op) {
    return '<button class="actrow f" data-act="actgo" data-arg="' + op.href + '" data-key="op-' + esc(op.key) + '">' +
      '<span class="spin" aria-hidden="true"></span><span class="acttxt"><b>' + esc(op.title) + (op.pct === null ? '' : ' · ' + op.pct + '%') + '</b>' +
      '<small>' + esc(op.text) + '</small>' + progressLine(op.pct) + '</span></button>';
  }).join('');
}

function unseenNotes(st) {
  return st.notes.filter(function (n) { return !act.seen[n.key]; });
}

function activityRows(st) {
  var ops = opRows(st.ops);
  var notes = noteRows(unseenNotes(st), 'note-');
  var news = noticeRows(st.news.filter(function (n) { return !n.read; }), 'actn-');
  var todo = notes || news;
  return '<div class="sheet actsheet" role="dialog" aria-label="Attività e notifiche"><h3>Attività</h3>' +
    (ops ? '<div class="actgroup"><h4>In corso</h4>' + ops + '</div>' : '') +
    '<div class="actgroup"><h4>Da leggere</h4>' +
      (todo ? '<button class="actrow f allread" data-act="noticeall" data-key="nall"><span class="acttxt"><b>Segna tutte come lette</b></span></button>' + notes + news
        : '<p class="actempty">Niente da leggere.</p>') + '</div>' +
    '<div class="actgroup"><button class="actrow f" data-act="actgo" data-arg="#/notifiche" data-key="nallpage"><span class="acttxt"><b>Vedi tutte</b>' +
      '<small>Le notifiche lette e non lette</small></span>' + CHEVRON + '</button></div></div>';
}

// I doppioni: lo stesso film o episodio in piu' file. Una copia si sposta nel
// Cestino di Windows (dall'aiutante sul PC), oppure il gruppo si ignora.
async function duplicatesPage() {
  var d;
  try { d = await api('/duplicates'); } catch (e) {
    return '<div class="page"><div class="panel"><h1>Doppioni</h1><p>' + dot(false) + ' ' + esc(e.message) + '</p></div></div>';
  }
  cache.dups = d.groups;
  var groups = d.groups.map(function (g) {
    var best = g.items.slice().sort(function (a, b) { return (b.width || 0) - (a.width || 0) || b.size - a.size; })[0];
    var rows = g.items.map(function (x) {
      var what = [x.width ? x.width + '×' + x.height : '', (x.vcodec || '').toUpperCase(), x.size ? fmtSize(x.size) : '',
        x.duration ? fmtTime(x.duration) : '', x.library].filter(Boolean).join(' · ');
      var btn = !x.exists ? '<small class="nodot">non raggiungibile ora</small>'
        : !x.trash ? '<small>da eliminare a mano</small>'
        : '<button class="btn danger f" data-act="duptrash" data-arg="' + x.id + '" data-key="dupt-' + x.id + '">Sposta nel Cestino</button>';
      return '<div class="lib"><div class="head"><div class="name"><b>' + esc(x.path) + '</b><small>' + esc(what) +
        (x === best ? ' · <span class="okdot">la migliore</span>' : '') + '</small></div>' + btn + '</div></div>';
    }).join('');
    return '<div class="panel"><h2>' + esc(g.title) + '</h2>' + rows +
      '<div class="actions"><button class="btn f" data-act="dupignore" data-arg="' + esc(g.key) + '" data-key="dupi-' + esc(g.key) + '">Non è un doppione: ignora</button></div></div>';
  }).join('');
  return '<div class="page"><div class="panel"><h1>Doppioni</h1><p>Lo stesso film o episodio in più file. Scegli la copia da togliere: ' +
    'va nel Cestino di Windows, da cui puoi sempre recuperarla. L\'altra copia resta al suo posto.</p>' +
    (d.agent ? '' : '<p>' + dot(false) + ' Sul PC non è acceso l\'aiutante di BunkerPlex: rilancia «Installa BunkerPlex» per poter spostare i file nel Cestino da qui.</p>') +
    '</div>' + (groups || '<div class="panel"><p>Nessun doppione: è tutto in ordine.</p></div>') + '</div>';
}

// La pagina con tutte le notifiche: segnalazioni ancora valide e avvisi, letti e non letti
async function allNoticesPage() {
  var i = await api('/info');
  act.info = i;
  var st = activityState();
  var ops = opRows(st.ops), notes = noteRows(st.notes, 'pgnote-'), news = noticeRows(st.news, 'pgn-');
  var unread = unseenNotes(st).length + unreadNotices(st.news);
  return '<div class="page"><div class="panel"><h1>Notifiche</h1>' +
    (unread ? '<div class="actions"><button class="btn f" data-act="noticeall" data-key="pgall">Segna tutte come lette</button></div>' : '<p>Hai letto tutto.</p>') +
    '</div>' +
    (ops ? '<div class="panel"><h2>In corso</h2><div class="nlist">' + ops + '</div></div>' : '') +
    (notes ? '<div class="panel"><h2>Da sistemare</h2><div class="nlist">' + notes + '</div></div>' : '') +
    '<div class="panel"><h2>Avvisi</h2>' + (news ? '<div class="nlist">' + news + '</div>' : '<p>Ancora nessun avviso.</p>') +
    (auth && auth.user && auth.user.linked && !TV ? '<div class="actions"><a class="btn f" href="#/settings/notices" data-key="pgnset">Impostazioni delle notifiche</a></div>' : '') +
    '</div></div>';
}

function activityOpen() { return !modal.hidden && modal.classList.contains('corner'); }

// ---- Amici, accanto alla campanella: chi e' acceso adesso, e le sue raccolte a un clic.
// Ci sono anche i tuoi altri PC e gli amici spenti (con le raccolte, ma senza video).
var accountFriends = [];             // gli amici dell'account (anche quelli che non condividono)
var friendsWatching = {};            // posto dell'amico -> [cosa sta guardando adesso]
var friendsWatchingAt = 0;

function loadFriendsWatching() {
  friendsWatchingAt = Date.now();
  return api('/friends/now').then(function (r) {
    friendsWatching = (r && r.now) || {};
    renderActivity();
  }, function () {});
}

// «Sta guardando Breaking Bad · S1 · E2» (o «ha in pausa ...»), con il titolo da aprire se e' nelle sue raccolte
function watchingRows(fr) {
  return (friendsWatching[fr.n] || []).map(function (w, i) {
    var isEp = w.kind === 'episode';
    var name = isEp && w.show ? w.show : w.title;
    var sub = isEp ? (w.season != null ? 'S' + w.season + ' · E' + w.episode + (w.title ? ' · ' + w.title : '') : w.title)
      : (w.year || '');
    var left = w.duration > 0 ? Math.max(0, Math.round((w.duration - w.position) / 60)) : 0;
    var note = (w.paused ? 'In pausa' : 'Sta guardando') + (left ? ' · mancano ' + left + ' min' : '');
    var body = '<span class="wplay" aria-hidden="true">' + (w.paused ? IC.pause : IC.play) + '</span>' +
      '<span class="acttxt"><small>' + esc(note) + '</small><b>' + esc(name) + '</b>' + (sub ? '<small>' + esc(String(sub)) + '</small>' : '') + '</span>';
    var href = w.show_id ? '#/show/' + w.show_id : w.id ? '#/item/' + w.id : '';
    return href
      ? '<button class="actrow watching f" data-act="actgo" data-arg="' + href + '" data-key="frw-' + fr.n + '-' + i + '">' + body + CHEVRON + '</button>'
      : '<div class="actrow watching">' + body + '</div>';
  }).join('');
}

function friendsNowRows() {
  var on = friends.filter(function (f) { return f.online !== false; });
  var off = friends.filter(function (f) { return f.online === false; });
  // Amici dell'account senza un PC collegato qui: ci sono, ma non condividono
  var names = friends.map(function (f) { return String(f.name).toLowerCase(); });
  var quiet = accountFriends.filter(function (f) {
    return f.status === 'ok' && names.indexOf(String(f.username).toLowerCase()) < 0;
  });
  off = off.concat(quiet.map(function (f) { return { n: 'a' + f.id, name: f.username, libraries: [], quiet: true }; }));
  function rows(list, offline) {
    return list.map(function (fr) {
      var who = (fr.self ? 'Tuo PC · ' : '') + fr.name;
      var libsHtml = fr.libraries.map(function (l) {
        var n = [l.movies ? l.movies + ' film' : '', l.shows ? l.shows + ' serie' : '']
          .filter(Boolean).join(' · ');
        return '<button class="actrow f" data-act="actgo" data-arg="#/lib/' + l.id + '" data-key="frnow-' + fr.n + '-' + l.id + '">' +
          avatar(l.name) + '<span class="acttxt"><b>' + esc(l.name) + '</b><small>' + esc(n || 'raccolta') + '</small></span>' + CHEVRON + '</button>';
      }).join('');
      var now = offline ? '' : watchingRows(fr);
      return '<div class="frnow' + (offline ? ' off' : '') + '"><p class="frwho"><span class="odot' + (offline ? ' off' : '') + '" aria-hidden="true"></span>' +
        esc(who) + '<small>' + (fr.quiet ? 'non condivide' : offline ? 'spento o non raggiungibile' : 'online') + '</small></p>' +
        now + (libsHtml || (fr.quiet ? '' : '<p class="actempty">Nessuna raccolta condivisa.</p>')) + '</div>';
    }).join('');
  }
  return '<div class="sheet actsheet" role="dialog" aria-label="Amici"><h3>Amici</h3>' +
    (on.length ? '<div class="actgroup"><h4>Online</h4>' + rows(on, false) + '</div>' : '') +
    (off.length ? '<div class="actgroup"><h4>Offline</h4>' + rows(off, true) + '</div>' : '') +
    (on.length || off.length ? '' : '<p class="actempty">Nessun amico, per ora. Aggiungine uno per vedere le sue raccolte.</p>') +
    '<div class="actgroup"><button class="actrow f" data-act="actgo" data-arg="#/settings/friends" data-key="frnow-add">' +
    '<span class="acttxt"><b>Aggiungi un amico</b><small>Con il nome del suo account, in Impostazioni → Amici</small></span>' + CHEVRON + '</button></div></div>';
}

// Il server su cui stai guardando: un pulsante a se', accanto agli amici, che porta alla scelta
var ICON_SERVER = '<svg class="ic line" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>';

function serverName() {
  var src = serverSrc(), only = /^f\d+$/.test(src) ? +src.slice(1) : 0;
  if (!only) return auth.pc || 'Questo server';
  for (var i = 0; i < friends.length; i++) if (friends[i].n === only) return friends[i].name;
  return 'Server';
}

function renderServerButton(btn) {
  if (!btn) return;
  var show = !!(auth && auth.cloud && auth.user);
  btn.hidden = !show;
  if (!show) return;
  var name = serverName();
  // Locale / online: come arriva questo dispositivo al server aperto (non a quello di un
  // amico sfogliato da qui, che passa comunque da questo server)
  var k = /^f\d+$/.test(serverSrc()) ? '' : hereReach();
  var html = ICON_SERVER + '<span class="srvname">' + esc(name) + '</span>' + reachTag(k);
  if (btn.getAttribute('data-sig') !== html) {
    btn.innerHTML = html;
    btn.setAttribute('data-sig', html);
  }
  btn.setAttribute('aria-label', 'Server: ' + name + (REACH[k] ? ', ' + REACH[k].tag.toLowerCase() + ' (' + REACH[k].how + ')' : '') + '. Cambia server');
  btn.title = 'Cambia server';
}

function renderFriendsButton(btn) {
  if (!btn) return;
  var on = friends.filter(function (f) { return f.online !== false; }).length;
  var show = friends.length > 0 || !!(auth && auth.cloud);
  btn.hidden = !show;
  var html = ICON_FRIENDS + (on ? '<span class="frcount">' + on + '</span>' : '');
  if (btn.getAttribute('data-sig') !== html) {
    btn.innerHTML = html;
    btn.setAttribute('data-sig', html);
  }
  btn.setAttribute('aria-label', on ? 'Amici, ' + on + ' online' : 'Amici');
}

function openFriendsNow() {
  if (activityOpen() && modal.classList.contains('friendsnow')) { closeModal(); return; }
  closeModal(true);
  modalState = { options: [], onPick: function () {}, returnFocus: document.activeElement };
  modal.classList.add('corner', 'friendsnow');
  modal.innerHTML = friendsNowRows();
  modal.hidden = false;
  var first = modal.querySelector('.f');
  if (first) first.focus();
  // Lo stato degli amici, fresco; e quelli dell'account che non condividono
  Promise.all([loadLibs(true), auth && auth.cloud ? api('/account-friends').then(function (af) {
    accountFriends = (af && af.friends) || [];
  }, function () {}) : null]).then(renderActivity, function () {});
  loadFriendsWatching();
}

// Appena aggiornato: un avviso una volta per dispositivo (poi resta nella campanella)
function announceUpdate(u) {
  if (!u || !u.to || player) return;
  var seen = '';
  try { seen = localStorage.getItem('fpNews') || ''; } catch (e) { /* niente */ }
  if (seen === u.to) return;
  try { localStorage.setItem('fpNews', u.to); } catch (e) { /* niente */ }
  toast('Il server BunkerPlex è stato aggiornato: le novità sono nella campanella in alto');
}

// La pagina delle novita' dell'ultimo aggiornamento
async function newsPage() {
  var i = await api('/info');
  var u = i.updated;
  if (!u) {
    return '<div class="page"><div class="panel"><h1>Novità</h1><p>Nessun aggiornamento negli ultimi giorni. ' +
      'La versione del server e i suoi aggiornamenti sono in Impostazioni → Aggiornamenti.</p>' +
      '<div class="actions"><a class="btn f" href="#/settings/updates" data-key="news-upd">Impostazioni → Aggiornamenti</a></div></div></div>';
  }
  var when = new Date(u.at * 1000).toLocaleDateString('it-IT', { day: 'numeric', month: 'long' });
  var list = (u.changes || []).map(function (c) { return '<li>' + esc(c) + '</li>'; }).join('');
  return '<div class="page"><div class="panel"><h1>Il server è stato aggiornato</h1>' +
    '<p>BunkerPlex sul PC ' + esc(srvLabel()) + ', il ' + esc(when) + ' (versione ' + esc(u.to) + ').</p>' +
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
  renderActivity();
  pollActivity();
}

function renderActivity() {
  var box = document.getElementById('activity');
  if (!box) {
    box = document.createElement('div');
    box.id = 'activity';
    box.innerHTML = '<a class="actbtn srvbtn f" href="#/server" data-key="srvbtn" hidden></a>' +
      '<button class="actbtn friendsbtn f" data-act="friendsnow" data-key="friendsbtn" aria-label="Amici" hidden></button>' +
      '<button class="actbtn f" data-act="activity" data-key="actbtn" aria-label="Attività e notifiche"></button>';
    document.body.appendChild(box);
  }
  var locked = document.body.classList.contains('locked') || (auth && !auth.user);
  box.hidden = !act.info || !!act.info.login || locked;
  if (box.hidden) return;
  var st = activityState();
  var op = st.ops[0];
  var unseen = unseenNotes(st).length + unreadNotices(st.news);
  var html = op
    ? '<span class="spin" aria-hidden="true"></span><span class="acttext">' + esc(op.title) + (op.pct === null ? '' : ' ' + op.pct + '%') + '</span>'
    : IC.bell;
  if (unseen) html += '<span class="actcount">' + unseen + '</span>';
  renderServerButton(box.querySelector('.srvbtn'));
  renderFriendsButton(box.querySelector('.friendsbtn'));
  var btn = box.querySelector('[data-act="activity"]');
  btn.classList.toggle('busy', !!op);
  if (btn.getAttribute('data-sig') !== html) {      // il pulsante resta lo stesso: chi ci sta sopra col telecomando non perde il posto
    btn.innerHTML = html;
    btn.setAttribute('data-sig', html);
  }
  if (activityOpen()) {
    var key = document.activeElement && modal.contains(document.activeElement) ? document.activeElement.getAttribute('data-key') : '';
    var fresh = modal.classList.contains('friendsnow') ? friendsNowRows() : activityRows(st);
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
  if (activityOpen() && modal.classList.contains('friendsnow') && Date.now() - friendsWatchingAt > 15000) loadFriendsWatching();
  api('/info').then(function (i) {
    var wasScanning = act.info && act.info.scanning;
    act.info = i;
    if (i.devices_full && !act.devAsked && modal.hidden) { act.devAsked = true; openDevicesPopup(); }
    if (wasScanning && !i.scanning) libsLoadedAt = 0;      // finita la lettura: raccolte e menu da rileggere
    announceUpdate(i.updated);
    var want = !i.login && (i.update || (act.upd && act.upd.phase)) && Date.now() - act.lastUpd > 15000;
    return want ? api('/update').then(function (u) { act.upd = u; act.lastUpd = Date.now(); }, function () {}) : null;
  }).then(renderActivity, function () { /* server spento un attimo: si riprova */ });
}

if (CENTRAL) Object.assign(actions, cActions(), cPkActions());
Object.assign(actions, secActions());
loadAuth().then(function () {
  if (auth.user && !auth.user.must_change) return afterLogin([]).then(render);
  render();
}).then(function () {
  setTimeout(pollActivity, 600);
  // Nell'app Android (telefono e TV dal browser dell'app): a ogni apertura si controlla
  // se c'e' una versione nuova e la si propone (l'app chiede a GitHub, vedi Releases.check)
  if (APP) setTimeout(checkUpdate, 2500);
});
})();
