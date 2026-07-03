/* FORJA — Service Worker. Pre-caches the "app shell" for offline use.
   Strategy: network-first with cache fallback. Cache-first (the old strategy)
   froze users on the first version they ever installed — new deploys never
   showed up. Network-first serves the freshest app whenever online and only
   falls back to the cached shell offline. */
const CACHE = "forja-v2";
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
    fetch(e.request).then((resp) => {
      const copy = resp.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
      return resp;
    }).catch(() =>
      caches.match(e.request).then((hit) => hit || caches.match("./index.html"))
    )
  );
});
