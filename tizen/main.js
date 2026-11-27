// BunkerPlex per le TV Samsung: la PWA centrale in una cornice a tutto schermo.
// - I tasti del telecomando arrivano alla cornice o all'app: quelli che arrivano qui
//   (play/pausa...) passano alla pagina con postMessage, che li tratta come suoi.
// - «Indietro» dalla Home: la pagina lo dice con {bp: 'exit'} e l'app si chiude.
(function () {
  var CENTRAL = 'https://bunkerplex-account.bunkerplex.workers.dev/';
  var frame = document.getElementById('bp'), off = document.getElementById('off');
  var MEDIA = ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop', 'MediaFastForward',
    'MediaRewind', 'MediaTrackPrevious', 'MediaTrackNext'];
  var KEYS = { 10009: 'Escape', 10252: 'MediaPlayPause', 415: 'MediaPlay', 19: 'MediaPause',
    413: 'MediaStop', 417: 'MediaFastForward', 412: 'MediaRewind', 13: 'Enter',
    37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown' };

  function exit() {
    try { tizen.application.getCurrentApplication().exit(); } catch (e) { window.close(); }
  }

  try {
    MEDIA.forEach(function (k) {
      try { tizen.tvinputdevice.registerKey(k); } catch (e) { /* tasto che questa TV non ha */ }
    });
  } catch (e) { /* fuori da una TV Samsung (prove nel browser) */ }

  function load() {
    if (!navigator.onLine) { off.className = 'on'; return; }
    off.className = '';
    frame.src = CENTRAL + '?app=tizen';
  }
  frame.addEventListener('load', function () { frame.focus(); });
  window.addEventListener('online', load);
  window.addEventListener('offline', function () { off.className = 'on'; });
  window.addEventListener('message', function (e) {
    if (e.source !== frame.contentWindow || !e.data) return;
    if (e.data.bp === 'exit') exit();
  });
  // I tasti arrivati alla cornice invece che alla pagina
  document.addEventListener('keydown', function (e) {
    var key = KEYS[e.keyCode] || e.key;
    if (off.className === 'on') {
      if (key === 'Escape') exit();
      else if (key === 'Enter') load();
      return;
    }
    e.preventDefault();
    try { frame.contentWindow.postMessage({ bpKey: key }, '*'); } catch (err) { /* niente */ }
    frame.focus();
  });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) frame.focus();
  });
  load();
})();
