// TőzsdeRadar service worker: telepíthetővé teszi az oldalt, és kapcsolat nélkül
// a legutóbb betöltött kiadást mutatja. Mindig a hálózat az első, hogy a hírek és az árak frissek legyenek.
const CACHE = "tozsderadar-v1";
const SHELL = ["./", "index.html", "icon.svg", "icon-192.png", "manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== self.location.origin) return;
  // a lekérdezés-paraméter nélküli címen tároljuk (data.json?t=... → data.json)
  const key = new Request(u.origin + u.pathname);
  e.respondWith(
    fetch(e.request)
      .then((r) => { if (r.ok) { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(key, cp)); } return r; })
      .catch(() => caches.match(key).then((r) => r || (e.request.mode === "navigate" ? caches.match("index.html") : Response.error())))
  );
});
