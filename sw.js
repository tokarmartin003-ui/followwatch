var CACHE = "followwatch-v2";
var OFFLINE = ["/", "/app", "/index.html", "/landing.html"];

self.addEventListener("install", function(e) {
  e.waitUntil(
    caches.open(CACHE).then(function(c) { return c.addAll(OFFLINE); })
  );
  self.skipWaiting();
});

self.addEventListener("activate", function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.filter(function(k) { return k !== CACHE; }).map(function(k) { return caches.delete(k); }));
    })
  );
  self.clients.claim();
});

self.addEventListener("fetch", function(e) {
  if (e.request.url.includes("/api/")) return;
  e.respondWith(
    fetch(e.request).catch(function() {
      return caches.match(e.request).then(function(r) { return r || caches.match("/app"); });
    })
  );
});