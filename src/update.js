/**
 * The service worker: registering it, and noticing when a new build is waiting.
 *
 * Registered only from a production build (see main.js). A worker intercepting
 * every request is exactly what you don't want in front of a dev server, and
 * `vite preview` is a real build, so the rehearsal is still available.
 *
 * The update flow is deliberately player-driven. A new worker installs itself in
 * the background and then *waits*; the menu grows a band saying so, and only a
 * tap activates it and reloads. The alternative -- skipWaiting on install -- swaps
 * the build out from under whoever is climbing and reloads the page mid-problem.
 *
 * Everything here fails soft. No service worker support, a registration blocked
 * by private mode, a worker that never answers: the game plays as it always did,
 * just without offline or an update prompt.
 */

let reg = null;
let waiting = null; // a new worker, installed and ready, once one exists
let applying = false; // we asked for the swap, so the reload that follows is ours
let reloading = false;
let lastCheck = 0;
let forced = null; // dev override, exposed as window.__updateBand (see main.js)

/** Is there a new build sitting ready behind the one that's running? */
export function updateReady() {
  if (forced !== null) return forced;
  return waiting !== null;
}

/** Force the update band on or off; `null` hands the answer back to the worker. */
export function forceUpdateBand(value) {
  forced = value;
}

export function registerWorker() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  // After load: the first paint matters more than being cached a second sooner.
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then(watch, () => {});
  });

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // A controller arrives on the very first install too, and reloading *that*
    // would bounce every new player's first visit. Only our own swap reloads.
    if (!applying || reloading) return;
    reloading = true;
    window.location.reload();
  });
}

function watch(registration) {
  reg = registration;
  note(reg.waiting); // installed during an earlier session and never applied
  reg.addEventListener('updatefound', () => {
    const sw = reg.installing;
    if (!sw) return;
    sw.addEventListener('statechange', () => {
      if (sw.state === 'installed') note(sw);
    });
  });
}

async function note(sw) {
  // Nothing in control means this is the first install, which is not news -- it
  // is just the game becoming offline-capable, with no reason to interrupt.
  if (!sw || !navigator.serviceWorker.controller) return;
  if (await stale(sw)) waiting = sw;
}

/**
 * Is the page actually running something older than the worker that's waiting?
 *
 * Usually it isn't, and that's the whole point of asking. Navigations are
 * network-first, so a launch with signal loads the newest HTML and its bundle
 * immediately, while the *worker* update lands a moment later and waits. Without
 * this check the band would fire on that launch and offer to reload a page onto
 * the code it is already running -- a prompt for nothing, on the common path.
 *
 * The waiting worker knows which files it precached, and Vite content-hashes the
 * bundle, so the question is just whether this page's own script is in that list.
 * If the worker doesn't answer, assume stale: a spurious band is a smaller cost
 * than silently sitting on an old build.
 */
async function stale(sw) {
  const shell = await new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(null), 500);
    channel.port1.onmessage = (e) => {
      clearTimeout(timer);
      resolve(e.data);
    };
    try {
      sw.postMessage({ type: 'SHELL' }, [channel.port2]);
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
  if (!Array.isArray(shell)) return true;
  return !shell.includes(new URL(import.meta.url).pathname);
}

/**
 * Ask the browser whether a new build has been deployed. Cheap (a conditional
 * request for sw.js) but not free, so it's throttled and only called from the
 * menu and on returning to the tab.
 */
export function checkForUpdate(minGapMs = 60000) {
  if (!reg || waiting) return;
  const now = Date.now();
  if (now - lastCheck < minGapMs) return;
  lastCheck = now;
  reg.update().catch(() => {});
}

/** Take the waiting build: activate it, then reload onto it. */
export function applyUpdate() {
  if (!waiting || reloading) return;
  applying = true;
  waiting.postMessage({ type: 'SKIP_WAITING' });
  // If the worker never answers, reload anyway rather than leaving a band that
  // does nothing when tapped. The new HTML is what the player asked for.
  setTimeout(() => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  }, 1500);
}
