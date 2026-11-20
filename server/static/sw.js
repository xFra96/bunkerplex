/* BunkerPlex - service worker dell'app sulla schermata Home.
   Il server e' in casa e cambia a ogni aggiornamento: l'interfaccia si prende
   sempre dalla rete e la copia salvata serve solo quando il PC non risponde.
   Video, locandine e /api non passano mai di qui. */
var CACHE = 'bunkerplex-ui-1';
var SHELL = ['/', 'index.html', 'app.js', 'style.css', 'manifest.json', 'icons/icon-192.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).catch(function () {}));
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== location.origin) return;
  var page = req.mode === 'navigate';
  var path = url.pathname.replace(/^\//, '');
  if (!page && SHELL.indexOf(path) < 0) return;          // tutto il resto va dritto al server
  e.respondWith(fetch(req).then(function (res) {
    if (res.ok) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put(page ? '/' : req, copy); });
    }
    return res;
  }).catch(function () {
    return caches.match(page ? '/' : req).then(function (hit) {
      return hit || new Response('BunkerPlex non raggiungibile', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    });
  }));
});
