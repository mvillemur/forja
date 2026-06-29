/* FORJA — Service Worker. Precachea el "app shell" para uso offline.
   Estrategia: cache-first con fallback a red; si la red falla, sirve el shell. */
const CACHE = "forja-v1";
const ASSETS = [
  "./", "./index.html", "./styles.css",
  "./src/engine.js", "./src/app.js", "./src/pwa.js",
  "./manifest.webmanifest", "./assets/icon.svg",
];

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).catch(() => {}));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    caches.match(e.request).then((hit) =>
      hit || fetch(e.request).then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return resp;
      }).catch(() => caches.match("./index.html"))
    )
  );
});
