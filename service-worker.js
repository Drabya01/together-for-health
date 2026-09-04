const CACHE = 'tfh-v19';
const ASSETS = ['./', './index.html', './admin-editor.js', './admin-editor.css', './manifest.json', './icon.svg', './icon-maskable.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // NEVER cache cross-origin requests. The club's sync layer reads api.github.com with a plain
  // GET, so without this the stale-while-revalidate branch below served a cached copy of the
  // Gist: every approval check after the first page load compared against a one-load-old blob,
  // decided the cloud was not newer, and left an already-approved member stuck on the pending
  // screen. It also meant the club's whole dataset was written durably into Cache Storage.
  if (url.origin !== self.location.origin) return;
  // Lesson decks change often and are large — always serve the freshest copy
  // (network-first), falling back to cache only when offline. This prevents
  // members from getting a stale deck after it's been updated.
  if (url.pathname.indexOf('/decks/') !== -1) {
    e.respondWith(
      fetch(e.request).then(res => {
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => caches.match(e.request))
    );
    return;
  }
  // Everything else: stale-while-revalidate
  e.respondWith(
    caches.match(e.request).then(cached => {
      const network = fetch(e.request).then(res => {
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
