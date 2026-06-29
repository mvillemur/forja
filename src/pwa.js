/* FORJA — Registro del Service Worker.
   Solo se registra bajo http/https (no en file://). Falla en silencio si el
   entorno no lo permite; la app funciona igual porque no depende de la red. */
(function () {
  try {
    if ("serviceWorker" in navigator && location.protocol.indexOf("http") === 0) {
      navigator.serviceWorker.register("sw.js").catch(function () {});
    }
  } catch (e) { /* noop */ }
})();
