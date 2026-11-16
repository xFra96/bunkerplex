/* FrenkPlex - interfaccia. Pensata per il telecomando (frecce + OK + Indietro)
   ma funziona anche con mouse e tastiera dal PC. */
(function () {
'use strict';

var view = document.getElementById('view');
var rail = document.getElementById('rail');
var modal = document.getElementById('modal');
var toastEl = document.getElementById('toast');
var TV = !!window.FrancoPlexTV;      // true dentro l'app Android TV
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
var railSignature = '';
var stageMap = null;                 // Home: scheda -> dati per l'anteprima grande
var stageKey = '';
var stageTimer = 0;
var stageFlip = false;
var lastAutoRefresh = Date.now();
var cardData = {};                   // scheda -> dati del titolo (per il menu delle azioni)
var press = null;                    // OK tenuto premuto su una scheda
var MORE = '<span class="more" data-menu title="Azioni">⋯</span>';

if (TV) document.body.classList.add('tv');
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

// ---------------------------------------------------------------- utilita'

function api(path, opt) {
  return fetch('/api' + path, opt).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (j) {
      if (r.status === 503 && j.detail && !api.reloading) { api.reloading = true; location.reload(); }
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
  return null;
}

function initials(name) {
  var words = String(name).trim().split(/\s+/);
  return (words.length > 1 ? words[0].charAt(0) + words[1].charAt(0) : String(name).trim().slice(0, 2)).toUpperCase();
}

function avatar(name) {
  return '<i class="avatar" style="--h:' + hue(name) + '">' + esc(initials(name)) + '</i>';
}

// Ricarica le raccolte e ridisegna la barra laterale (una voce per raccolta)
async function loadLibs(force) {
  if (!force && libsLoadedAt && Date.now() - libsLoadedAt < 15000) return;
  libs = await api('/libraries');
  libsLoadedAt = Date.now();
  var html = libs.map(function (l) {
    return '<a class="f railitem" href="#/lib/' + l.id + '" data-key="nav-lib-' + l.id + '">' +
      avatar(l.name) + '<span>' + esc(l.name) + '</span></a>';
  }).join('');
  if (html !== railSignature) {
    railSignature = html;
    document.getElementById('navlibs').innerHTML = html;
  }
}

function markRail(h) {
  var active = '';
  if (h === '#/home' || h === '#/search') active = h;
  else if (h.indexOf('#/saga') === 0) active = '#/sagas';
  else if (h.indexOf('#/lib/') === 0) active = '#/lib/' + h.slice(6).split('?')[0];
  else if ((h.indexOf('#/item/') === 0 || h.indexOf('#/show/') === 0) && cache.navLib) active = '#/lib/' + cache.navLib;
  else if (h.indexOf('#/newlib') === 0) active = '#/newlib';
  else if (/^#\/(settings|browse|rename|match)/.test(h)) active = '#/settings';
  var links = rail.querySelectorAll('.railitem');
  for (var i = 0; i < links.length; i++) links[i].classList.toggle('on', links[i].getAttribute('href') === active);
}

// ---------------------------------------------------------------- schede

function progressBar(x) {
  if (x.watched || !x.position || !x.duration) return '';
  var pct = Math.max(3, Math.min(100, x.position / x.duration * 100));
  return '<div class="bar"><i style="width:' + pct.toFixed(1) + '%"></i></div>';
}

function stars(x) {
  return x.rating ? '<span class="star">★ ' + x.rating.toFixed(1) + '</span>' : '';
}

function posterCard(x, prefix) {
  cardData[prefix + '-' + x.kind + x.id] = x;
  var isShow = x.kind === 'show';
  var href = isShow ? '#/show/' + x.id : '#/item/' + x.id;
  var img = x.poster || x.thumb;
  var badge = isShow
    ? (x.unwatched ? '<span class="badge">' + x.unwatched + '</span>' : '<span class="badge seen">✓</span>')
    : (x.watched ? '<span class="badge seen">✓</span>' : '');
  var sub = [x.year || '', isShow ? 'Serie' : '', stars(x)].filter(Boolean).join(' · ');
  return '<a class="card poster f" href="' + href + '" data-key="' + prefix + '-' + x.kind + x.id + '">' +
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
      (x.unwatched ? '<span class="badge">' + x.unwatched + '</span>' : '<span class="badge seen">✓</span>') +
    '</div>' +
    '<div class="cap"><b>' + esc(x.title) + '</b><small>' + (sub || '&nbsp;') + '</small></div></a>';
}

function wideCard(x, prefix) {
  cardData[prefix + '-' + x.kind + x.id] = x;
  var isEp = x.kind === 'episode';
  var title = isEp ? (x.show_title || x.title) : x.title;
  var sub = isEp ? 'S' + x.season + ' · E' + x.episode + ' · ' + esc(x.title) : (x.year || '');
  if (x.position && x.duration && !x.watched) sub += ' · mancano ' + fmtDur(x.duration - x.position);
  var img = isEp ? x.thumb : (x.backdrop || x.thumb);
  return '<button class="card wide f" data-act="play" data-arg="' + x.id + '" data-key="' + prefix + '-' + x.kind + x.id + '">' +
    '<div class="art" style="--h:' + hue(title) + '">' +
      (img ? '<img loading="lazy" decoding="async" src="' + img + '" alt="" onerror="this.style.display=\'none\'">' : '') +
      '<span class="playico">▶</span>' + progressBar(x) + MORE +
    '</div>' +
    '<div class="cap"><b>' + esc(title) + '</b><small>' + (sub || '&nbsp;') + '</small></div></button>';
}

function section(title, cards, note) {
  if (!cards.length) return '';
  return '<section class="section"><h2>' + title + (note ? '<small>' + note + '</small>' : '') +
    '</h2><div class="row">' + cards.join('') + '</div></section>';
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

  var map = {};
  function reg(x, prefix, kicker) {
    map[prefix + '-' + x.kind + x.id] = { x: x, kicker: kicker };
    return x;
  }

  var rows =
    section('Continua a guardare', d.continue.map(function (x) { return wideCard(reg(x, 'cont', 'Continua a guardare'), 'cont'); })) +
    section('Prossimi episodi', d.nextup.map(function (x) { return wideCard(reg(x, 'next', 'Prossimo episodio'), 'next'); })) +
    d.libraries.map(function (l) {
      return section(esc(l.name), l.items.map(function (x) { return posterCard(reg(x, 'lib' + l.id, l.name), 'lib' + l.id); }), 'aggiunti di recente');
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
  el.querySelector('.info').innerHTML =
    '<div class="kicker">' + esc(s.kicker) + '</div>' +
    '<h1>' + esc(isEp ? (x.show_title || x.title) : x.title) + '</h1>' +
    metaLine([
      isEp ? 'S' + x.season + ' · E' + x.episode + ' · ' + esc(x.title) : '',
      isSaga ? sagaYears(x) : x.year,
      isShow ? x.seasons_count + (x.seasons_count === 1 ? ' stagione' : ' stagioni')
        : (isSaga ? x.count + ' film' + (x.total > x.count ? ' su ' + x.total : '') : fmtDur(x.duration)),
      stars(x),
      (x.genres || []).slice(0, 3).map(esc).join(', '),
      !isShow && x.position > 20 && !x.watched ? 'mancano ' + fmtDur(x.duration - x.position) : ''
    ]) +
    (x.overview ? '<p class="overview">' + esc(x.overview) + '</p>' : '');

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
      '<p>Se hai appena aggiunto delle cartelle, FrenkPlex le sta leggendo: i titoli compaiono qui tra poco. ' +
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

async function libraryPage(id) {
  var lib = libById(id);
  if (!lib) { await loadLibs(true); lib = libById(id); }
  if (!lib) throw new Error('Questa raccolta non esiste più.');
  var q = parseQuery(location.hash);
  var all = await api('/libraries/' + lib.id + '/items');
  if (!all.length) {
    return '<div class="page"><div class="toolbar"><h1>' + esc(lib.name) + '</h1></div><div class="empty">' +
      (lib.folders.length
        ? '<p>In questa raccolta non c\'è ancora nessun titolo. Se hai appena aggiunto una cartella, aspetta che FrenkPlex finisca di leggerla.</p>'
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
  var html = '<div class="page"><div class="toolbar"><h1>' + esc(lib.name) + '</h1>' +
    '<span class="count">' + list.length + (list.length !== all.length ? ' di ' + all.length : '') +
      (list.length === 1 ? ' titolo' : ' titoli') + '</span></div>' +
    '<div class="filters">' +
    fbtn('sort', 'Ordina', SORTS[q.sort || 'title'], !!q.sort && q.sort !== 'title') +
    (mixed ? fbtn('type', 'Tipo', TYPES[q.type || ''], !!q.type) : '') +
    fbtn('genre', 'Genere', q.genre || 'Tutti', !!q.genre) +
    fbtn('year', 'Anno', yearLabel(q.year), !!q.year) +
    fbtn('director', 'Regia', q.director || 'Tutti', !!q.director) +
    fbtn('actor', 'Attore', q.actor || 'Tutti', !!q.actor) +
    fbtn('state', 'Stato', STATES[q.state || ''], !!q.state) +
    '<button class="filter f" data-act="refreshmenu" data-arg="' + lib.id + '" data-key="lib-refresh"><b>⟳ Aggiorna</b></button>' +
    (hasFilters ? '<button class="filter f" data-act="clearfilters" data-arg="' + lib.id + '" data-key="filter-clear"><b>✕ Azzera filtri</b></button>' : '') +
    '</div>';
  html += list.length
    ? '<div class="grid">' + list.map(function (x, n) {
        return posterCard(x, 'lib').replace('class="card', (n === 0 ? 'data-autofocus ' : '') + 'class="card');
      }).join('') + '</div>'
    : '<div class="empty"><h2>Nessun risultato</h2><p>Nessun titolo corrisponde ai filtri scelti.</p></div>';
  return html + '</div>';
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

async function item(id) {
  var x = await api('/items/' + id);
  cache.navLib = x.library_id;
  var isEp = x.kind === 'episode';
  var resume = x.position > 20 && !x.watched;
  var base = '#/lib/' + x.library_id;
  var tech = [x.filename, fmtSize(x.size), [x.vcodec, x.acodec].filter(Boolean).join(' + ').toUpperCase()].filter(Boolean).join('  ·  ');

  return '<header class="hero">' + heroBg(x) + '<div class="in">' + cover(x) + '<div class="txt">' +
      (isEp ? '<div class="kicker">' + esc(x.show_title || '') + ' · Stagione ' + x.season + ' · Episodio ' + x.episode + '</div>' : '') +
      '<h1>' + esc(x.title) + '</h1>' +
      (x.tagline ? '<div class="tagline">' + esc(x.tagline) + '</div>' : '') +
      metaLine([
        x.year, fmtDur(x.duration), stars(x),
        x.quality ? '<span class="tag">' + x.quality + '</span>' : '',
        x.watched ? '<span class="okdot">✓ Visto</span>' : ''
      ]) +
      '<p class="overview full">' + esc(x.overview || (x.matched || isEp ? '' : 'Nessuna scheda trovata per questo file: prova «Correggi scheda».')) + '</p>' +
      '<div class="actions">' +
        '<button class="btn primary f" data-act="play" data-arg="' + x.id + '" data-key="play"><span class="ico">▶</span>' +
          (resume ? 'Riprendi da ' + fmtTime(x.position) : 'Riproduci') + '</button>' +
        (resume ? '<button class="btn f" data-act="playstart" data-arg="' + x.id + '" data-key="restart">Dall\'inizio</button>' : '') +
        '<button class="btn f" data-act="watched" data-arg="' + x.id + ':' + (x.watched ? 0 : 1) + '" data-key="watched">' +
          (x.watched ? 'Segna come da vedere' : 'Segna come visto') + '</button>' +
        (isEp
          ? '<a class="btn f" href="#/show/' + x.show_id + '" data-key="toshow">Vai alla serie</a>'
          : '<a class="btn f" href="#/match/movie/' + x.id + '" data-key="match">Correggi scheda</a>') +
      '</div>' +
      (!isEp && (x.genres.length || x.director || x.actors.length || x.collection) ? '<div class="credits">' +
        (x.collection ? '<div><b>Saga</b><a class="chip f" href="#/saga/' + x.collection.id + '" data-key="chip-saga">' +
          esc(x.collection.title) + ' · ' + x.collection.count + ' film</a></div>' : '') +
        (x.genres.length ? '<div><b>Genere</b>' + chips(x.genres, base, 'genre') + '</div>' : '') +
        (x.director ? '<div><b>Regia</b>' + chips(directorsOf(x), base, 'director') + '</div>' : '') +
        (x.actors.length ? '<div><b>Cast</b>' + chips(x.actors, base, 'actor') + '</div>' : '') +
      '</div>' : '') +
      '<div class="fine">' + esc(tech) + '</div>' +
    '</div></div></header>';
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

  var tabs = s.seasons.length > 1 ? '<div class="seasons">' + s.seasons.map(function (x) {
    return '<button class="filter f' + (x === season ? ' active' : '') + '" data-act="season" data-arg="' + s.id + ':' + x.season +
      '" data-key="season-' + x.season + '"><b>' + (x.season === 0 ? 'Speciali' : 'Stagione ' + x.season) + '</b></button>';
  }).join('') + '</div>' : '';

  var eps = season ? season.episodes.map(function (e) {
    return '<div class="eprow">' +
      '<button class="ep f" data-act="play" data-arg="' + e.id + '" data-key="ep-' + e.id + '">' +
        '<div class="art" style="--h:' + hue(s.title) + '"><img loading="lazy" decoding="async" src="' + e.thumb + '" alt="" onerror="this.style.display=\'none\'">' + progressBar(e) + '</div>' +
        '<div class="body"><div class="num">EPISODIO ' + e.episode + (e.duration ? ' · ' + fmtDur(e.duration) : '') + '</div>' +
        '<h3>' + esc(e.title) + '</h3><p>' + esc(e.overview || '') + '</p></div>' +
      '</button>' +
      '<button class="seenbtn f' + (e.watched ? ' on' : '') + '" data-act="watched" data-arg="' + e.id + ':' + (e.watched ? 0 : 1) +
        '" data-key="seen-' + e.id + '" title="Visto / da vedere">✓</button>' +
    '</div>';
  }).join('') : '';

  return '<header class="hero short">' + heroBg(s) + '<div class="in">' + cover(s) + '<div class="txt">' +
      '<h1>' + esc(s.title) + '</h1>' +
      metaLine([
        s.year, s.seasons_count + (s.seasons_count === 1 ? ' stagione' : ' stagioni'),
        s.episodes + ' episodi', stars(s),
        s.unwatched ? s.unwatched + ' da vedere' : '<span class="okdot">✓ Vista</span>'
      ]) +
      '<p class="overview">' + esc(s.overview || '') + '</p>' +
      '<div class="actions">' +
        (up ? '<button class="btn primary f" data-act="play" data-arg="' + up.id + '" data-key="play"><span class="ico">▶</span>' +
          (up.position > 20 ? 'Riprendi' : 'Riproduci') + ' S' + up.season + ' · E' + up.episode + '</button>' : '') +
        '<a class="btn f" href="#/match/show/' + s.id + '" data-key="match">Correggi scheda</a>' +
      '</div>' +
      (s.genres.length || s.director || s.actors.length ? '<div class="credits">' +
        (s.genres.length ? '<div><b>Genere</b>' + chips(s.genres, base, 'genre') + '</div>' : '') +
        (s.director ? '<div><b>Creata da</b>' + chips(directorsOf(s), base, 'director') + '</div>' : '') +
        (s.actors.length ? '<div><b>Cast</b>' + chips(s.actors, base, 'actor') + '</div>' : '') +
      '</div>' : '') +
    '</div></div></header>' + tabs + '<div class="eps">' + eps + '</div>';
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
    '<div class="grid">' + all.map(function (x, n) {
      return sagaCard(x, 'sagas').replace('class="card', (n === 0 ? 'data-autofocus ' : '') + 'class="card');
    }).join('') + '</div></div>';
}

async function sagaPage(id) {
  var s = await api('/collections/' + id);
  var up = s.up_next;
  var resume = up && up.position > 20 && !up.watched;
  var missing = (s.missing || []).map(function (m) { return esc(m.title) + (m.year ? ' (' + m.year + ')' : ''); });
  return '<header class="hero short">' + heroBg(s) + '<div class="in">' + cover(s) + '<div class="txt">' +
      '<div class="kicker">Saga</div>' +
      '<h1>' + esc(s.title) + '</h1>' +
      metaLine([
        sagaYears(s), s.count + ' film' + (s.total > s.count ? ' su ' + s.total : ''), stars(s),
        s.unwatched ? s.unwatched + ' da vedere' : '<span class="okdot">✓ Vista</span>'
      ]) +
      '<p class="overview">' + esc(s.overview || '') + '</p>' +
      '<div class="actions">' +
        (up ? '<button class="btn primary f" data-act="play" data-arg="' + up.id + '" data-key="play"><span class="ico">▶</span>' +
          (resume ? 'Riprendi ' : 'Riproduci ') + esc(up.title) + '</button>' : '') +
      '</div>' +
      (missing.length ? '<div class="fine">Ti ' + (missing.length === 1 ? 'manca' : 'mancano') + ': ' + missing.join(' · ') + '</div>' : '') +
    '</div></div></header>' +
    '<div class="grid">' + s.items.map(function (x) { return posterCard(x, 'saga'); }).join('') + '</div>';
}

// ---------------------------------------------------------------- Cerca

async function search() {
  var res = await Promise.all([api('/movies'), api('/shows'), api('/collections')]);
  var all = res[2].concat(res[0], res[1]).map(function (x) {
    return { x: x, hay: norm([x.title, x.original_title, x.year, x.director, (x.actors || []).join(' '), (x.genres || []).join(' ')].join(' ')) };
  });
  return {
    html: '<div class="page"><div class="searchbox"><input class="field f" id="q" data-key="search-input" autocomplete="off" ' +
      'placeholder="Titolo, regista, attore, genere o anno" value="' + esc(cache.searchQuery) + '"></div><div id="results"></div></div>',
    mount: function () {
      var input = document.getElementById('q'), out = document.getElementById('results');
      function run() {
        cache.searchQuery = input.value;
        var terms = norm(input.value).split(/\s+/).filter(Boolean);
        if (!terms.length) {
          out.innerHTML = '<div class="empty"><p>Scrivi qualcosa: puoi cercare un titolo, una saga, un regista, un attore, un genere o un anno, in tutte le raccolte.</p></div>';
          return;
        }
        var found = all.filter(function (e) {
          return terms.every(function (t) { return e.hay.indexOf(t) >= 0; });
        }).slice(0, 120);
        out.innerHTML = found.length
          ? '<div class="grid">' + found.map(function (e) {
              return e.x.kind === 'collection' ? sagaCard(e.x, 'search') : posterCard(e.x, 'search');
            }).join('') + '</div>'
          : '<div class="empty"><p>Nessun risultato per «' + esc(input.value) + '».</p></div>';
      }
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

function scanStatus(i) {
  if (i.scanning) return '⏳ ' + esc(i.message || 'Lettura delle cartelle in corso…');
  if (i.message) return '<span class="nodot">' + esc(i.message) + '</span>';
  if (!i.last_scan) return '';
  var d = new Date(i.last_scan * 1000);
  return 'Ultimo controllo: ' + d.toLocaleDateString('it-IT') + ' alle ' + d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
}

function dot(ok) { return ok ? '<span class="okdot">●</span>' : '<span class="nodot">●</span>'; }

async function settings() {
  var res = await Promise.all([api('/info'), loadLibs(true), api('/update').catch(function () { return null; })]);
  var i = res[0];

  var libsHtml = libs.map(function (l) {
    var what = [l.movies ? l.movies + ' film' : '', l.shows ? l.shows + ' serie' : ''].filter(Boolean).join(' · ') || 'ancora vuota';
    var k = 'lib-' + l.id;
    return '<div class="lib"><div class="head">' + avatar(l.name) +
      '<div class="name"><b>' + esc(l.name) + '</b><small>' + what + '</small></div>' +
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
      }).join('') : '<div class="folder"><div class="where"><small>Nessuna cartella: premi «+ Cartella».</small></div></div>') +
      '</div>';
  }).join('');

  return '<div class="page"><div class="toolbar"><h1>Impostazioni</h1></div>' +
    '<div class="panel"><h2>Le tue raccolte</h2>' +
    '<p>Ogni raccolta è una sezione del tuo cinema, con il nome che scegli tu e una o più cartelle del PC. ' +
    'Film e serie vengono riconosciuti da soli. FrenkPlex legge soltanto: non modifica né cancella mai i tuoi file.</p>' +
    libsHtml +
    '<div class="actions" style="margin-top:.6rem"><a class="btn primary f" href="#/newlib" data-key="new-lib">+ Aggiungi raccolta</a></div>' +
    '</div>' +

    '<div class="panel"><h2>Catalogo</h2><div class="stats">' +
      '<div class="stat"><b>' + i.movies + '</b><span>film</span></div>' +
      '<div class="stat"><b>' + i.shows + '</b><span>serie TV</span></div>' +
      '<div class="stat"><b>' + i.episodes + '</b><span>episodi</span></div>' +
      (i.tmdb && i.unmatched ? '<div class="stat"><b>' + i.unmatched + '</b><span>film senza scheda</span></div>' : '') +
    '</div>' +
    '<p id="scanmsg">' + scanStatus(i) + '</p>' +
    '<div class="actions" style="margin-top:0">' +
      '<button class="btn f" data-act="scan" data-key="scan">Cerca file nuovi</button>' +
      '<button class="btn f" data-act="refreshall" data-key="refreshall">Riscarica tutte le schede</button>' +
    '</div></div>' +

    '<div class="panel"><h2>Locandine e schede automatiche</h2>' +
    '<p>' + dot(i.tmdb) + (i.tmdb
      ? ' Attive (chiave ' + esc(i.tmdb_hint) + '): locandine, trame, anno, regista, cast, generi e voti vengono scaricati da soli.'
      : ' Non attive. Senza chiave i film compaiono con un fotogramma al posto della locandina e senza regista, generi e trama.') + '</p>' +
    '<p>Serve una chiave gratuita di <b>themoviedb.org</b>: crea un account, poi Impostazioni → API → copia la «Chiave API» e incollala qui.' +
      (TV ? ' È più comodo farlo dal PC: apri <b>http://' + esc(location.host) + '</b> nel browser.' : '') + '</p>' +
    '<div class="inline"><input class="field f" id="tmdbkey" data-key="tmdbkey" data-enter="savekey" autocomplete="off" placeholder="' +
      (i.tmdb ? 'Nuova chiave API (per cambiarla)' : 'Chiave API TMDB') + '">' +
    '<button class="btn f" data-act="savekey" data-key="savekey">Salva</button></div></div>' +

    updatePanel(res[2]) +

    '<div class="panel"><h2>Collegamento</h2>' +
    '<p>Indirizzo del server: <b>http://' + esc(location.host) + '</b> · ' + esc(i.name) + ' ' + esc(i.version) + '</p>' +
    (TV ? '<p>App su questa TV: versione ' + esc(tvCall('getVersionName') || 'precedente') +
            (i.apk_version > (+tvCall('getVersion') || 0) ? ' · ' + dot(false) + ' sul PC ce n\'è una più nuova' : (i.apk_version ? ' · ' + dot(true) + ' aggiornata' : '')) + '</p>' +
          '<div class="actions" style="margin-top:0"><button class="btn f" data-act="checkupdate" data-key="checkupdate">Controlla aggiornamenti</button>' +
          '<button class="btn f" data-act="resetserver" data-key="resetserver">Cambia server</button></div>'
        : (i.apk
          ? '<p>App per la TV' + (i.apk_version_name ? ' (versione ' + esc(i.apk_version_name) + ')' : '') + ': la prima volta, sulla TV apri <b>http://' + esc(location.host) + '/FrenkPlex.apk</b> con l\'app «Downloader», oppure scaricala qui e mettila su una chiavetta USB. Poi si aggiorna da sola: quando ricompili l\'APK, la TV lo propone all\'avvio.</p>' +
            '<div class="actions" style="margin-top:0"><a class="btn f" href="/FrenkPlex.apk" download data-key="apk">Scarica FrenkPlex.apk</a></div>'
          : '<p>App per la TV non ancora compilata: avvia <b>Compila APK.bat</b> sul PC.</p>')) +
    '</div></div>';
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
  cache.browse = { lib: lib.id, path: d.path };

  var list = d.dirs.map(function (x, n) {
    return '<button class="result dir f"' + (n === 0 ? ' data-autofocus' : '') + ' data-act="browse" data-arg="' + esc(x.path) + '" data-key="dir-' + n + '">' +
      '<span class="dirico">' + (d.root ? '⛁' : '▸') + '</span><span><b>' + esc(x.name) + '</b></span></button>';
  }).join('');
  if (!list) {
    list = d.root
      ? '<p><b>Non vedo i dischi del PC.</b> Chiudi e riavvia il server con <b>Avvia FrenkPlex.bat</b>: è quel file a collegare i dischi.</p>'
      : '<p>Qui dentro non ci sono altre cartelle.</p>';
  }

  return '<div class="page"><div class="toolbar"><h1>Cartelle di «' + esc(lib.name) + '»</h1></div>' +
    '<div class="panel">' +
    '<p>Entra nella cartella che contiene i video (vanno bene anche le sottocartelle) e premi «Usa questa cartella». ' +
    'Puoi ripetere per aggiungerne altre.</p>' +
    '<p>Sei in: <b>' + esc(d.display) + '</b>' + (d.videos ? ' · ' + d.videos + ' video qui dentro' : '') + '</p>' +
    '<div class="actions" style="margin-top:0">' +
      (d.root ? '' : '<button class="btn primary f" data-act="usefolder" data-key="use">✓ Usa questa cartella</button>') +
      (d.parent ? '<button class="btn f" data-act="browse" data-arg="' + esc(d.parent) + '" data-key="up">↑ Cartella superiore</button>' : '') +
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
  if (TV) { window.FrancoPlexTV.play(JSON.stringify(p)); return; }
  cache.pendingPlay = p;
  location.hash = '#/play/' + id;
}

// Preferenze del player, ricordate su questo dispositivo (volume, sottotitoli, salti…)
function playerPrefs() {
  try { return JSON.parse(localStorage.getItem('fpPlayer')) || {}; } catch (e) { return {}; }
}
function savePlayerPrefs(prefs) {
  try { localStorage.setItem('fpPlayer', JSON.stringify(prefs)); } catch (e) { /* niente */ }
}

var SEEK_STEPS = { short: [5, 10], normal: [10, 30], long: [30, 60] };
var SUB_SIZES = [['s', 'Piccoli'], ['', 'Normali'], ['l', 'Grandi'], ['xl', 'Molto grandi']];
var FITS = [['contain', 'Adatta (tutto il video)'], ['cover', 'Riempi lo schermo (ritaglia i bordi)'], ['fill', 'Allarga (deforma)']];
var SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

async function playRoute(id) {
  var p = cache.pendingPlay && String(cache.pendingPlay.id) === String(id) ? cache.pendingPlay : await api('/play/' + id);
  cache.pendingPlay = null;
  return {
    html: '<div class="player" id="player"><video playsinline></video><div class="note"></div>' +
      '<div class="top"><button class="pbtn" data-p="exit" title="Indietro (Esc)">←</button><b>' + esc(p.title) + '</b><span>' + esc(p.subtitle) + '</span></div>' +
      '<div class="bottom"><input class="seek" type="range" min="0" max="' + Math.max(1, Math.floor(p.duration)) + '" step="1" value="0">' +
      '<div class="ctl"><button class="pbtn" data-p="toggle" title="Play / Pausa (Spazio)">❚❚</button>' +
      '<button class="pbtn wide" data-p="back" title="Indietro (←)"></button><button class="pbtn wide" data-p="fwd" title="Avanti (→)"></button>' +
      (p.next ? '<button class="pbtn wide" data-p="next" title="Episodio successivo (N)">Successivo ⏭</button>' : '') +
      '<button class="pbtn" data-p="mute" title="Audio sì / no (M)">🔊</button>' +
      '<input class="vol" type="range" min="0" max="100" step="5" value="100" title="Volume (↑ ↓)">' +
      (p.subs.length ? '<button class="pbtn wide" data-p="subs" title="Sottotitoli (S)">Sottotitoli</button>' : '') +
      '<button class="pbtn wide" data-p="menu" title="Opzioni (O)">⚙ Opzioni</button>' +
      '<button class="pbtn wide" data-p="fs" title="Schermo intero (F)">Schermo intero</button><span class="time"></span></div></div></div>',
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
  var timeEl = root.querySelector('.time'), note = root.querySelector('.note');
  var toggleBtn = root.querySelector('[data-p=toggle]'), subsBtn = root.querySelector('[data-p=subs]');
  var muteBtn = root.querySelector('[data-p=mute]');
  var prefs = playerPrefs();
  var LOADING = 'Caricamento…', CONVERTING = 'Conversione in corso…';
  var st = {
    id: p.id, v: v, offset: 0, transcoding: !p.browser_direct, loaded: false, dragging: false, sub: -1, done: false,
    audio: 0, audios: [], rate: 1, at: p.start || 0, pending: null, loadId: 0,
    lastT: -1, lastMove: Date.now(), recov: 0, recovAt: 0, fatal: false, endAt: null, sleepAt: 0, sleepEnd: false
  };
  // Se questo dispositivo sa decodificare il video originale (es. H.265), il PC lo
  // copia cosi' com'e' invece di ricodificarlo: quasi nessun lavoro per il processore.
  st.vcopy = canDecode(v, p.vcodec, p.bits);
  document.body.classList.add('playing');

  function pos() { return st.transcoding ? st.offset + v.currentTime : v.currentTime; }
  function dur() { return p.duration || (isFinite(v.duration) ? v.duration : 0); }
  function shown() { return st.dragging ? +seek.value : (st.pending !== null ? st.pending : pos()); }
  function steps() { return SEEK_STEPS[prefs.step] || SEEK_STEPS.normal; }
  function showTime() {
    timeEl.textContent = fmtTime(shown()) + ' / ' + fmtTime(dur()) + (st.rate !== 1 ? '  ·  ' + st.rate + '×' : '');
  }

  function applyLook() {
    root.querySelector('[data-p=back]').textContent = '−' + steps()[0] + ' s';
    root.querySelector('[data-p=fwd]').textContent = '+' + steps()[1] + ' s';
    v.style.objectFit = prefs.fit || 'contain';
    root.className = root.className.replace(/\s*subs-\w+/g, '') + (prefs.subsize ? ' subs-' + prefs.subsize : '');
    v.volume = prefs.volume === undefined ? 1 : prefs.volume;
    v.muted = !!prefs.muted;
    vol.value = Math.round(v.volume * 100);
    muteBtn.textContent = v.muted || !v.volume ? '🔇' : '🔊';
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
      note.textContent = CONVERTING;
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
    if (pr && pr.catch) pr.catch(function () { if (id === st.loadId && v.paused) note.textContent = 'Premi ▶ per avviare'; });
  }

  // Salto: nel file originale subito; in conversione si aspetta che si smetta di
  // premere, altrimenti ogni pressione farebbe ripartire la conversione sul PC.
  function seekTo(t) {
    t = Math.max(0, Math.min(t, Math.max(0, dur() - 3)));
    clearTimeout(st.seekTimer);
    if (!st.transcoding) { load(t); showTime(); return; }
    st.pending = t;
    seek.value = t;
    showTime();
    st.seekTimer = setTimeout(function () { load(t); }, 450);
  }

  // Riapre il video dal punto in cui era: per quando si blocca o cade il collegamento.
  function recover(message) {
    if (st.recov >= 3) {
      st.fatal = true;
      v.pause();
      note.textContent = 'Il video non riparte. Controlla che il PC sia acceso e il disco collegato, poi premi ▶.';
      return;
    }
    st.recov++;
    st.recovAt = Date.now();
    st.loaded = false;
    load(st.at);
    note.textContent = message || 'Riprendo il collegamento…';
  }

  function report(ended) {
    if (st.done || (!ended && pos() < 5)) return;
    post('/progress/' + p.id, { position: pos(), duration: dur(), ended: !!ended }).catch(function () {});
  }

  function wake() {
    root.classList.remove('idle');
    clearTimeout(st.idle);
    st.idle = setTimeout(function () { if (!v.paused && modal.hidden) root.classList.add('idle'); }, 3200);
  }

  function goTo(id) {
    if (!id) return;
    report();
    st.done = true;
    api('/play/' + id).then(function (n) {
      n.start = 0; cache.pendingPlay = n; location.replace('#/play/' + n.id);
    }).catch(function (e) { st.done = false; toast(e.message); });
  }
  function goNext() { goTo(p.next || (p.saga && p.saga.id)); }
  function sagaLabel() { return '«' + p.saga.title + '»' + (p.saga.year ? ' (' + p.saga.year + ')' : ''); }

  function setRate(r) {
    st.rate = r;
    v.defaultPlaybackRate = r;
    v.playbackRate = r;
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

  function choose(title, list, current, fn) {
    openPicker(title, list, current, function (value) { fn(value); wake(); });
  }

  function info() {
    var a = st.audios[st.audio];
    var lines = [
      (v.videoWidth ? v.videoWidth + '×' + v.videoHeight + ' · ' : '') + (p.vcodec || '').toUpperCase(),
      a ? 'Audio: ' + a.label : '',
      !st.transcoding ? 'Riproduzione diretta del file' :
        (st.vcopy || (p.vcodec === 'h264' && p.bits === 8) ? 'Conversione leggera (video originale)' : 'Conversione completa sul PC')
    ].filter(Boolean);
    openPicker(p.title + (p.subtitle ? ' — ' + p.subtitle : '') + ' · ' + lines.join(' · '), [{ value: 'ok', label: 'Chiudi' }], 'ok', wake);
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
        toast(m > 0 ? 'Pausa automatica tra ' + m + ' minuti' : (m ? 'Mi fermo alla fine di questo video' : 'Spegnimento automatico disattivato'));
      });
    });
    add('Ricomincia dall\'inizio', undefined, function () { seekTo(0); });
    if (p.next) add('Vai all\'episodio successivo', undefined, goNext);
    else if (p.saga) add('Film successivo della saga', esc(p.saga.title), goNext);
    if (document.pictureInPictureEnabled && v.requestPictureInPicture) {
      add('Finestra sopra le altre (PiP)', undefined, function () {
        (document.pictureInPictureElement ? document.exitPictureInPicture() : v.requestPictureInPicture())
          .catch(function () { toast('Non disponibile in questo browser'); });
      });
    }
    add('Informazioni sul video', undefined, info);
    openPicker('Opzioni', o, null, function (value) { o[+value].fn(); wake(); });
  }

  function action(name) {
    wake();
    if (name === 'exit') history.back();
    else if (name === 'toggle') {
      if (st.fatal) { st.fatal = false; st.recov = 0; st.loaded = false; load(st.at); }
      else if (v.paused) { st.lastMove = Date.now(); v.play(); } else v.pause();
    }
    else if (name === 'back') seekTo(shown() - steps()[0]);
    else if (name === 'fwd') seekTo(shown() + steps()[1]);
    else if (name === 'next') goNext();
    else if (name === 'menu') menu();
    else if (name === 'mute') { prefs.muted = !v.muted; savePlayerPrefs(prefs); applyLook(); }
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
      note.textContent = 'Impossibile riprodurre questo video.';
    }
  });
  v.addEventListener('playing', function () { note.textContent = ''; toggleBtn.textContent = '❚❚'; wake(); });
  v.addEventListener('canplay', function () {
    if (note.textContent === LOADING || note.textContent === CONVERTING) note.textContent = '';
  });
  v.addEventListener('pause', function () { toggleBtn.textContent = '▶'; root.classList.remove('idle'); report(); });
  v.addEventListener('timeupdate', function () {
    if (v.currentTime > 0 && !v.seeking && st.pending === null) st.at = pos();
    if (!st.dragging && st.pending === null) seek.value = pos();
    if (dur() && +seek.max !== Math.floor(dur())) seek.max = Math.floor(dur());
    showTime();
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
    st.done = true;
    if (p.next && prefs.autoplay !== false && !st.sleepEnd) {
      // Conto alla rovescia: il prossimo episodio parte da solo, ma si puo' fermare
      var left = 10;
      var startNext = function () {
        clearInterval(st.countdown);
        api('/play/' + p.next).then(function (n) {
          n.start = 0; cache.pendingPlay = n; location.replace('#/play/' + n.id);
        }).catch(function () { history.back(); });
      };
      var heading = function () {
        return 'Prossimo episodio tra ' + left + ' s' + (p.next_label ? ' — ' + p.next_label : '');
      };
      openPicker(heading(), [
        { value: 'go', label: '▶  Guarda subito' },
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
        { value: 'go', label: '▶  Guarda ' + sagaLabel() },
        { value: 'no', label: 'Torna alla scheda' }
      ], null, function (answer) {
        if (answer !== 'go') { history.back(); return; }
        api('/play/' + p.saga.id).then(function (n) {
          n.start = 0; cache.pendingPlay = n; location.replace('#/play/' + n.id);
        }).catch(function () { history.back(); });
      });
    } else history.back();
  });
  v.addEventListener('click', function () { action('toggle'); });
  v.addEventListener('dblclick', function () { action('fs'); });
  seek.addEventListener('input', function () { st.dragging = true; showTime(); wake(); });
  seek.addEventListener('change', function () { st.dragging = false; seekTo(+seek.value); });
  vol.addEventListener('input', function () { setVolume(vol.value / 100); wake(); });
  root.addEventListener('mousemove', wake);
  root.addEventListener('click', function (e) {
    var b = e.target.closest('[data-p]');
    if (b) { action(b.getAttribute('data-p')); b.blur(); }
  });

  // Controllo ogni secondo: se il video dovrebbe andare ma e' fermo da troppo
  // (collegamento caduto dopo una pausa lunga, salto rimasto appeso…) lo si riapre.
  st.watch = setInterval(function () {
    var now = Date.now();
    if (st.sleepAt && now >= st.sleepAt) {
      st.sleepAt = 0;
      v.pause();
      toast('Spegnimento automatico: video in pausa');
    }
    if (v.paused || v.ended || st.done || st.fatal || st.pending !== null || st.dragging) {
      st.lastMove = now; st.lastT = v.currentTime;
      return;
    }
    if (v.currentTime !== st.lastT) {
      st.lastT = v.currentTime; st.lastMove = now;
      if (st.recov && now - st.recovAt > 30000) st.recov = 0;
      return;
    }
    if (now - st.lastMove > 3000 && !note.textContent) note.textContent = LOADING;
    if (now - st.lastMove > (st.transcoding ? 25000 : 15000)) recover();
  }, 1000);

  st.timer = setInterval(report, 10000);
  st.report = report;
  st.key = function (key) {
    var k = key.length === 1 ? key.toLowerCase() : key;
    if (k === ' ' || k === 'k' || k === 'Enter') action('toggle');
    else if (k === 'ArrowLeft' || k === 'j') action('back');
    else if (k === 'ArrowRight' || k === 'l') action('fwd');
    else if (k === 'ArrowUp') { setVolume(v.volume + 0.05); wake(); }
    else if (k === 'ArrowDown') { setVolume(v.volume - 0.05); wake(); }
    else if (k === 'm') action('mute');
    else if (k === 'f') action('fs');
    else if (k === 's') action('subs');
    else if (k === 'o') action('menu');
    else if (k === 'n') action('next');
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
  load(p.start || 0);
  wake();
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
  try { st.v.pause(); st.v.removeAttribute('src'); st.v.load(); } catch (e) { /* niente */ }
  if (document.pictureInPictureElement && document.exitPictureInPicture) document.exitPictureInPicture().catch(function () {});
  if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen();
  document.body.classList.remove('playing');
}

// ---------------------------------------------------------------- Finestra di scelta

function openPicker(title, options, current, onPick) {
  modalState = { options: options, onPick: onPick, returnFocus: document.activeElement };
  modal.innerHTML = '<div class="sheet"><h3>' + esc(title) + '</h3><div class="opts">' + options.map(function (o, i) {
    return '<button class="opt f' + (o.value === current ? ' sel' : '') + '" data-act="opt" data-arg="' + i + '">' +
      (o.value === current ? '● ' : '') + esc(o.label) +
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
    add(resume ? '▶  Riprendi da ' + fmtTime(x.position) : '▶  Riproduci', function () { play(x.id, false); });
    if (resume) add('↺  Riproduci dall\'inizio', function () { play(x.id, true); });
  }
  add('Apri la scheda', function () {
    location.hash = isShow ? '#/show/' + x.id : (isEp ? '#/show/' + x.show_id : '#/item/' + x.id);
  });
  add(isShow ? (x.watched ? 'Segna tutta la serie come da vedere' : 'Segna tutta la serie come vista')
             : (x.watched ? 'Segna come da vedere' : 'Segna come visto'), function () {
    post(isShow ? '/shows/' + x.id + '/watched' : '/watched/' + x.id, { watched: !x.watched }).then(render, fail);
  });
  if (!isEp) {
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
  try { return typeof window.FrancoPlexTV[name] === 'function' ? window.FrancoPlexTV[name]() : null; }
  catch (e) { return null; }
}

function startUpdate() {
  openPicker('Scarico l\'aggiornamento… 0%', [{ value: 'bg', label: 'Continua in sottofondo' }], '-', function () {});
  modalState.update = true;
  window.FrancoPlexTV.update();
}

function checkUpdate(manual) {
  if (!TV) return;
  api('/info').then(function (i) {
    if (!i.apk_version) { if (manual) toast('Sul PC non c\'è un APK: avvia «Compila APK.bat»'); return; }
    var mine = +tvCall('getVersion') || 0;
    var canUpdate = typeof window.FrancoPlexTV.update === 'function';
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
      openPicker('C\'è una versione più nuova dell\'app FrenkPlex' + name + '. Quella installata su questa TV non sa ancora aggiornarsi da sola: ' +
        'installa la nuova un\'ultima volta con l\'app «Downloader», aprendo http://' + location.host + '/FrenkPlex.apk. Dalla prossima farà tutto da sé.',
        [{ value: 'ok', label: 'Ho capito' }], 'ok', function () {});
      return;
    }
    openPicker('È disponibile un aggiornamento dell\'app FrenkPlex' + name + '. Vuoi installarlo adesso?',
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
      'Se la TV chiede il permesso di installare app sconosciute, consentilo per FrenkPlex e poi premi «Riprova».',
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

// ---------------------------------------------------------------- Aggiornamento di FrenkPlex (da GitHub)
// Il server sul PC controlla da solo ogni 12 ore. Da qui (PC o TV) si vede
// l'avviso, si controlla a mano e si lancia l'installazione: il server scarica
// i file nuovi e la nuova app per la TV, poi si riavvia.

var serverUpdateLater = '';          // aggiornamento per cui si e' risposto "Più tardi"
var serverUpdating = false;

function updateWhat(u) {
  return u.code && u.apk ? ' (programma e app per la TV)' : (u.apk ? ' (app per la TV)' : '');
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
  else if (u.phase === 'host') state = dot(false) + ' Aggiornamento scaricato: per completarlo rilancia <b>Avvia FrenkPlex.bat</b> sul PC.';
  else if (u.available) state = dot(false) + ' È disponibile un aggiornamento' + updateWhat(u) + '.';
  else if (u.checked_at) state = dot(true) + ' FrenkPlex è aggiornato.';
  else state = 'Il primo controllo parte un paio di minuti dopo l\'avvio.';
  var when = updateTime(u.checked_at);
  var hours = u.check_hours === 24 ? 'una volta al giorno' : 'ogni ' + u.check_hours + ' ore';
  return '<div class="panel"><h2>Aggiornamenti</h2>' +
    '<p>' + state + (when ? ' Ultimo controllo: ' + esc(when) + '.' : '') + '</p>' +
    '<p>Il server controlla da solo ' + hours + (u.auto
      ? ' e installa le novità quando nessuno sta guardando un video.'
      : ': ti avvisa, e decidi tu quando installare.') +
      (u.dev_copy ? ' Questa è la copia di sviluppo: i file del programma li aggiorna git, da qui arriva solo l\'app per la TV.' : '') + '</p>' +
    (u.access === false
      ? (TV ? '<p>Per dare l\'accesso apri <b>http://' + esc(location.host) + '</b> dal PC, Impostazioni → Aggiornamenti, e incolla il token di GitHub.</p>'
            : '<p>Incolla qui un token di GitHub di sola lettura per quel repository (come crearlo: LEGGIMI, capitolo «Aggiornamenti»). Resta salvato sul disco di FrenkPlex.</p>' +
              '<div class="inline" style="margin-bottom:.8rem"><input class="field f" id="ghtoken" data-key="ghtoken" data-enter="updtoken" autocomplete="off" placeholder="Token di GitHub">' +
              '<button class="btn f" data-act="updtoken" data-key="updtoken">Salva</button></div>')
      : '') +
    '<div class="actions" style="margin-top:0">' +
      (u.available && u.phase !== 'host' ? '<button class="btn primary f" data-act="updinstall" data-key="updinstall">Aggiorna ora</button>' : '') +
      '<button class="btn f" data-act="updcheck" data-key="updcheck">Controlla adesso</button>' +
      '<button class="btn f" data-act="updauto" data-arg="' + (u.auto ? '0' : '1') + '" data-key="updauto">Aggiornamento automatico: ' + (u.auto ? 'attivo' : 'spento') + '</button>' +
    '</div></div>';
}

// Segue l'installazione finche' il server non e' tornato su con la versione nuova
function watchServerUpdate() {
  serverUpdating = true;
  var down = false, tries = 0;
  openPicker('Aggiorno FrenkPlex… ci vuole circa un minuto.', [{ value: 'bg', label: 'Continua in sottofondo' }], '-', function () {});
  modalState.serverUpdate = true;
  var timer = setInterval(function () {
    tries++;
    fetch('/api/update', { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('spento');
      return r.json();
    }).then(function (u) {
      if (down) { clearInterval(timer); location.reload(); return; }   // e' ripartito: si ricarica l'interfaccia nuova
      if (u.phase === 'restarting') { down = true; return; }
      if (u.phase === 'installing' || u.phase === 'checking') return;
      clearInterval(timer);
      serverUpdating = false;
      if (modalState && modalState.serverUpdate) closeModal(true);
      if (u.phase === 'host') {
        openPicker('Aggiornamento scaricato. Per completarlo rilancia «Avvia FrenkPlex.bat» sul PC.',
          [{ value: 'ok', label: 'Ho capito' }], 'ok', function () {});
      } else if (u.error) {
        openPicker('Aggiornamento non riuscito: ' + u.error, [{ value: 'ok', label: 'Chiudi' }], 'ok', function () {});
      } else {
        toast('FrenkPlex è aggiornato');
        if (/^#\/settings/.test(location.hash)) render();
        if (TV) setTimeout(checkUpdate, 1500);     // e' arrivata una nuova app per la TV?
      }
    }).catch(function () {
      down = true;
      if (tries > 150) { clearInterval(timer); serverUpdating = false; }
    });
  }, 2000);
}

function startServerUpdate() {
  post('/update/install').then(watchServerUpdate, function (e) { toast(e.message); });
}

function checkServerUpdate() {
  if (serverUpdating) return;
  api('/update').then(function (u) {
    if (!u.enabled || !u.available || u.phase) return;
    var sig = u.remote + (u.apk ? '+tv' : '');
    if (serverUpdateLater === sig) return;
    // Non si sovrappone a un film o a un'altra finestra: riprova tra poco
    if (player || !modal.hidden || /^#\/play/.test(location.hash)) { setTimeout(checkServerUpdate, 60000); return; }
    openPicker('È disponibile un aggiornamento di FrenkPlex' + updateWhat(u) + '. Vuoi installarlo adesso?' +
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
    openPicker(text + ' I titoli restano in catalogo, ma i video non partono finché non colleghi il disco e rilanci «Avvia FrenkPlex.bat».',
      [{ value: 'ok', label: 'Ho capito' }, { value: 'set', label: 'Apri Impostazioni' }], 'ok', function (answer) {
        if (answer === 'set') location.hash = '#/settings';
      });
  }
}

function addFolder(path) {
  return post('/libraries/' + cache.browse.lib + '/folders', { path: path }).then(function (r) {
    return libsChanged(r.added.length ? 'Aggiunta ' + r.added[0] + ': la sto leggendo' : 'Questa cartella c\'era già');
  });
}

var actions = {
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
    post('/scan').then(function () { toast('Controllo le cartelle…'); scanWatch = true; });
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
  resetserver: function () { if (TV) window.FrancoPlexTV.resetServer(); },
  checkupdate: function () { checkUpdate(true); },
  updcheck: function () {
    toast('Controllo su GitHub…');
    post('/update/check').then(function (u) {
      toast(u.access === false ? 'Questo PC non ha l\'accesso al repository' : (u.error || (u.available ? 'C\'è un aggiornamento' + updateWhat(u) : 'FrenkPlex è già aggiornato')));
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

function scrollToEl(el) {
  if (rail.contains(el) || modal.contains(el)) {
    if (modal.contains(el)) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  var row = el.closest('.row');
  if (row) {   // la scheda selezionata resta sempre allineata a sinistra, la fila scorre sotto
    row.scrollTo({ left: Math.max(0, el.offsetLeft - parseFloat(getComputedStyle(row).paddingLeft)), behavior: 'smooth' });
  }
  var rows = el.closest('.rows');
  if (rows) {  // Home: la fila selezionata resta alla stessa altezza, sotto l'anteprima
    var sec = el.closest('.section');
    if (sec) rows.scrollTo({ top: Math.max(0, sec.offsetTop - parseFloat(getComputedStyle(rows).paddingTop)), behavior: 'smooth' });
    return;
  }
  if (el.closest('.hero') || el.closest('.toolbar') || el.closest('.filters')) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
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
  kb = true;

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

document.addEventListener('mousedown', function () { kb = false; });
document.addEventListener('touchstart', function () { kb = false; }, { passive: true });
window.addEventListener('scroll', function () { if (currentHash) scrollMemory[currentHash] = window.pageYOffset; }, { passive: true });

// ---------------------------------------------------------------- Pagine

var routes = [
  [/^#\/home$/, home],
  [/^#\/lib\/(\d+)(?:\?.*)?$/, libraryPage],
  [/^#\/show\/(\d+)(?:\?.*)?$/, show],
  [/^#\/item\/(\d+)$/, item],
  [/^#\/play\/(\d+)$/, playRoute],
  [/^#\/search$/, search],
  [/^#\/sagas$/, sagasPage],
  [/^#\/saga\/(\d+)$/, sagaPage],
  [/^#\/settings$/, settings],
  [/^#\/newlib$/, newLibPage],
  [/^#\/rename\/(\d+)$/, renamePage],
  [/^#\/browse\/(\d+)(?:\?.*)?$/, browsePage],
  [/^#\/match\/(movie|show)\/(\d+)$/, matchPage]
];

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
    await loadLibs();
    cache.navLib = null;
    out = await handler.apply(null, match.slice(1));
  } catch (e) {
    out = '<div class="page"><div class="empty center"><h2>Qualcosa non va</h2><p>' + esc(e.message) +
      '</p><div class="actions"><a class="btn f" href="#/home">Torna alla Home</a></div></div></div>';
  }
  if (token !== renderToken) return;   // nel frattempo si e' cambiata pagina
  if (typeof out === 'string') out = { html: out };
  var samePage = currentHash === h;
  var keepScroll = window.pageYOffset;
  var hadFocusInRail = rail.contains(document.activeElement);
  currentHash = h;
  press = null;
  stageMap = null;
  stageKey = '';
  view.innerHTML = out.html;
  if (out.mount) out.mount();
  markRail(h);
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

// Sulla TV: all'avvio (cioe' appena collegata al server) e poi ogni mezz'ora,
// perche' l'app puo' restare aperta per giorni.
if (TV) {
  setTimeout(checkUpdate, 2500);
  setInterval(checkUpdate, 30 * 60 * 1000);
}

// Su PC e TV: c'e' un aggiornamento di FrenkPlex trovato dal server su GitHub?
setTimeout(checkServerUpdate, 1500);
setInterval(checkServerUpdate, 30 * 60 * 1000);

render();
})();
