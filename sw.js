/* sw.js — Hive Pocket Media Player.
 *
 * THIS ONE DOES CACHE THE APP, and that is the opposite of the Hive service on ROCK, on purpose.
 * That one refuses to cache because it has a live server that ships fixes, and a stale cache
 * fights it — an OBS browser source nobody can hard-refresh once served a fixed bug forever.
 * Here there is no server to outrun: the copy on the phone IS the artifact. Offline is the
 * whole point, so caching is the same lesson applied to the opposite topology.
 *
 * The trap that comes with caching is fighting YOURSELF on the next release. Guarded two ways:
 * the cache name carries a version, so a new build lands in a new cache and old ones are dropped;
 * and the new worker takes over immediately rather than waiting for every tab to close.
 *
 * Nothing about the user's music is cached. Their files are never uploaded, never copied, and
 * never touched by this worker — the app reads them straight off the device.
 */
// Kept in step with VERSION in pocket.js BY HAND — they are separate scripts and cannot
// import from one another. Bump both together; the chip on screen is what a bug report will
// quote, and a cache named after a different build is how a stale file survives a release.
const VERSION = '1.0.1-beta';
const CACHE = 'hive-pocket-' + VERSION;

// The whole app. It is small on purpose, and every one of these must exist or install fails.
const SHELL = [
  './',
  'index.html',
  'pocket.css',
  'pocket.js',
  'eq-render.js',
  'fx-render.js',
  'manifest.json',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      // Only this app's caches, never anything else on the origin.
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith('hive-pocket-') && k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // blob: URLs are the user's own audio, handed to the page by the file picker. They are not
  // ours to intercept and are not fetchable here anyway.
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // CACHE FIRST, because the point is working with no network at all. A new version arrives
  // through the worker update above, not by revalidating each file — which would put this app
  // back to needing a network to start.
  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      // Cache what we fetched, so a page reached by a path not in SHELL still works offline
      // next time. Only same-origin, only successful, basic responses.
      if (res && res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() =>
      // Offline and not cached. For a page load, hand back the app rather than a browser error.
      req.mode === 'navigate' ? caches.match('index.html') : Response.error()
    ))
  );
});
