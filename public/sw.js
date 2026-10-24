// Service worker: makes the app open instantly and show its screens offline.
// It caches ONLY our own static files. API calls and anything with personal data always go to the network.
const CACHE = 'eod-shell-v1';
const SHELL = ['/', '/index.html', '/style.css', '/config.js', '/js/main.js', '/js/core.js', '/js/auth.js', '/js/menu.js', '/js/entrepreneur.js', '/js/professional.js', '/js/deals.js', '/js/contacts.js', '/js/admin.js', '/manifest.webmanifest', '/icons/icon-192.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || !SHELL.includes(url.pathname)) return;   // never touch API traffic
  // stale-while-revalidate: instant from cache, refreshed in the background
  e.respondWith(caches.open(CACHE).then(async (c) => {
    const hit = await c.match(e.request);
    const net = fetch(e.request).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => hit);
    return hit || net;
  }));
});
