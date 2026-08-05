// Minimal service worker: caches the app shell (HTML/CSS/JS) so the app opens
// instantly and still loads its interface with no signal — matching the
// "power outage mode" idea from the product brief. API calls (/api/...) are
// intentionally NOT cached here, since served-stale business data is worse
// than a clear "you're offline" state. This is deliberately simple; a fuller
// offline mode (queueing writes made while offline, syncing when back online)
// is real additional engineering — see README "Making offline mode real".
//
// IMPORTANT: bump this version string every time app.html changes and you
// deploy. Whatever is cached under the OLD name gets deleted automatically
// on the next visit (see 'activate' below) — forgetting to bump this is
// exactly what caused a real incident: a broken version of app.html got
// cached on first visit and kept being served on every device, through
// multiple redeploys, because the cache-first strategy below never checked
// the network again. Fixed by switching the page itself to network-first.
const CACHE_NAME = 'roms-ghana-shell-v2';
const SHELL_FILES = ['/', '/app.html', '/manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never cache API calls or auth — always go to the network for real data.
  if (url.pathname.startsWith('/api/')) return;

  // The HTML page itself (navigation requests, and app.html directly) uses
  // NETWORK-FIRST: always try to fetch the current version; only fall back
  // to the cached copy if the network genuinely fails (offline). This is
  // the fix — it means a new deploy is visible on the very next reload,
  // with the cache purely as an offline safety net, never as the default.
  const isPageRequest = event.request.mode === 'navigate' || url.pathname === '/app.html' || url.pathname === '/';
  if (isPageRequest) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Static assets (icons, manifest) can stay cache-first — they rarely change
  // and it's fine if they lag a version behind.
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
