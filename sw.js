// Straßenjagd – Service Worker: App offline verfügbar, Kartenkacheln zwischenspeichern
const SHELL = 'shell-v2';
const LIBS = 'libs-v1';
const TILES = 'tiles-v2';
const SHELL_FILES = ['./', './index.html', './core.js', './manifest.webmanifest', './icon-192.png', './icon-512.png'];
const MAX_TILES = 4000;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => ![SHELL, LIBS, TILES].includes(k)).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

async function trimTiles() {
  const c = await caches.open(TILES); const keys = await c.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await c.delete(keys[i]);
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return; // Overpass-Abfragen (POST) gehen direkt ans Netz
  const url = new URL(req.url);

  // Eigene Dateien: erst Netz (damit Updates ankommen), sonst Cache
  if (url.origin === location.origin) {
    e.respondWith(fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(SHELL).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('./index.html'))));
    return;
  }
  // Bibliotheken und Schriften: Cache zuerst
  if (/cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com/.test(url.host)) {
    e.respondWith(caches.open(LIBS).then(c => c.match(req).then(hit => hit || fetch(req).then(res => { if (res.ok || res.type === 'opaque') c.put(req, res.clone()); return res; }))));
    return;
  }
  // Kartenkacheln (OpenStreetMap): einmal geladen, aus dem Cache – schont die OSM-Server
  if (url.host === 'tile.openstreetmap.org') {
    e.respondWith(caches.open(TILES).then(c => c.match(req.url).then(hit => hit ||
      fetch(req.url, { mode: 'cors', credentials: 'omit' }).then(res => {
        if (res.ok) { c.put(req.url, res.clone()); if (Math.random() < 0.02) trimTiles(); }
        return res;
      }).catch(() => fetch(req))
    )));
  }
});
