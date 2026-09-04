const CACHE = 'tfh-v33';
const ASSETS = ['./', './index.html', './firebase-sync.js', './admin-editor.js', './admin-editor.css', './manifest.json', './icon.svg', './icon-maskable.svg'];

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
  // Network-first for everything that IS the app: the page itself, and its scripts and
  // styles. Falls back to cache when offline, so the PWA still works on a bus.
  //
  // These used to be stale-while-revalidate, which meant a returning user ran the
  // PREVIOUS version of the app on every visit and only picked up a fix on the visit
  // after. That is why bumping CACHE by hand was required on every single deploy, and
  // why a just-shipped fix appeared not to work: the browser was still executing the old
  // index.html and the old firebase-sync.js. For an app whose logic lives in two files
  // that change often, serving them stale is the wrong trade.
  const isAppShell =
    e.request.mode === 'navigate' ||
    e.request.destination === 'script' ||
    e.request.destination === 'style' ||
    url.pathname.indexOf('/decks/') !== -1 ||
    /\.(html|js|css)$/.test(url.pathname) ||
    url.pathname === '/' || url.pathname.endsWith('/');

  if (isAppShell) {
    // `cache: 'no-cache'` forces a revalidation against the server instead of letting the
    // browser's own HTTP cache answer. Without it "network-first" was a lie: GitHub Pages
    // serves these files with `Cache-Control: max-age=600`, so fetch() returned a cached
    // copy for ten minutes and a freshly deployed fix simply did not run. no-cache still
    // gets a cheap 304 when nothing changed, so this costs a round trip, not a download.
    const revalidate = new Request(e.request, { cache: 'no-cache' });
    e.respondWith(
      fetch(revalidate).then(res => {
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => caches.match(e.request).then(c => c || Response.error()))
    );
    return;
  }

  // Static assets that rarely change (icons, manifest, images): cache-first is fine.
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
