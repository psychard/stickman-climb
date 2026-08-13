/**
 * Offline shell for Stickman Climb.
 *
 * The game needs the network for nothing once it has loaded -- walls are
 * generated from seeds, ticks live in localStorage, no asset is fetched while
 * you climb -- so caching the shell is the whole of offline support.
 *
 * Two placeholders are filled in at build time by the `climb-service-worker`
 * plugin in vite.config.js, and this file is NOT valid on its own: the copy in
 * `public/` is a template, and only `dist/sw.js` is real. The build id is a hash
 * of everything the build emitted, so a deploy is a new cache and the old one is
 * dropped on activate.
 *
 * The split between the two strategies below is the important part:
 *
 *  - **Navigations are network-first.** Cache-first HTML is how a service worker
 *    pins people to a build forever, which is a far worse failure than the ten
 *    minutes of staleness GitHub Pages' `max-age=600` can cause on its own. The
 *    cache is the fallback for when the network isn't there.
 *  - **Everything else is cache-first.** Vite content-hashes the bundle, so those
 *    URLs are immutable by construction; the icons and manifest are cached the
 *    first time they're asked for rather than precached, because Android's 512px
 *    icons are three times the size of the game and are never wanted on iOS.
 */

const BUILD = '__CLIMB_BUILD__';
const SHELL = __CLIMB_SHELL__;

const CACHE = `climb-${BUILD}`;
const INDEX = '/index.html';

/**
 * `ignoreVary` is not optional, and the bug it fixes is silent.
 *
 * The Cache API honours a response's `Vary` header, so an entry is only returned
 * to a request whose listed headers match the one that stored it. A module
 * script is fetched with CORS mode and therefore carries an `Origin` header,
 * while the same file precached here by URL does not -- so under a server that
 * says `Vary: Origin` (`vite preview`) or `Vary: Accept-Encoding` (GitHub Pages)
 * the precached bundle is there, and the page still fails to load offline.
 * Nothing here varies by request header: every URL is a static file, and the
 * bundle's name is its content hash.
 */
const MATCH = { ignoreVary: true };

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // One missing file must not fail the install and leave the app with no
      // worker at all; a miss just means that URL is fetched when it's wanted.
      await Promise.all(SHELL.map((url) => cache.add(url).catch(() => {})));
      // Deliberately no skipWaiting: a new build waits until the player taps the
      // band on the menu. Swapping it in underneath someone mid-problem would
      // reload the page and cost them the attempt.
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => n.startsWith('climb-') && n !== CACHE).map((n) => caches.delete(n)),
      );
      // Take control of the page that registered us, so the very first visit is
      // already cached rather than needing a second load.
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  const type = event.data && event.data.type;
  if (type === 'SKIP_WAITING') self.skipWaiting();
  // A waiting worker is asked what it holds, so the page can tell whether it is
  // actually running something older -- see `stale` in update.js.
  if (type === 'SHELL' && event.ports[0]) event.ports[0].postMessage(SHELL);
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          return await fetch(req);
        } catch {
          // Deliberately NOT the last HTML seen on the network: the cached copy
          // is the one precached at install, alongside the bundle it names, so
          // the offline shell is always internally consistent. Caching a fresh
          // index.html here would pair it with a bundle that hasn't been fetched
          // if the network dies in between, and offline would then be broken
          // rather than merely one build behind.
          const cache = await caches.open(CACHE);
          return (await cache.match(INDEX, MATCH)) || Response.error();
        }
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req, MATCH);
      if (hit) return hit;
      const res = await fetch(req);
      if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    })(),
  );
});
