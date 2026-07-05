/* FORJA — Service Worker. Pre-caches the "app shell" for offline use.
   Strategy: network-first with cache fallback. Cache-first (the old strategy)
   froze users on the first version they ever installed — new deploys never
   showed up. Network-first serves the freshest app whenever online and only
   falls back to the cached shell offline. */
const CACHE = "forja-v3";
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
      // Only cache good same-origin responses: a transient 404/500 written
      // into the cache would keep being served as the offline fallback.
      if (resp.ok && resp.type === "basic") {
        const copy = resp.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
      }
      return resp;
    }).catch(() =>
      caches.match(e.request).then((hit) => {
        if (hit) return hit;
        // The app-shell fallback only makes sense for page navigations;
        // serving HTML for a missed script/image corrupts the consumer.
        if (e.request.mode === "navigate") return caches.match("./index.html");
        return Response.error();
      })
    )
  );
});
