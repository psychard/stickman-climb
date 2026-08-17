/**
 * Bootstrap: canvas sizing, safe-area insets, and the frame loop.
 *
 * Sizing is resize-driven rather than CSS-height-driven so Safari's dynamic
 * toolbar showing/hiding just resizes the backing store instead of scrolling
 * the page or stretching the drawing.
 */

import { T } from './tuning.js';
import { createGame, update, render } from './game.js';
import { attachInput } from './input.js';
import { forceInstallHint } from './install.js';
import { registerWorker, checkForUpdate, forceUpdateBand } from './update.js';

const stage = document.getElementById('stage');
const canvas = document.getElementById('view');
const probe = document.getElementById('safe-probe');

const game = createGame(canvas);
attachInput(canvas, game);

// Handy from the Safari/Chrome console while tuning: inspect or poke live state,
// e.g. __game.fig.hip, __game.stam.parts, __game.debug = true. Note that `fig`
// and `wall` are null until a level is picked -- the menu loads first.
window.__game = game;

// The home-screen nudge only draws on iOS in a browser tab, which means it never
// appears on the machine it's developed on. __installHint(true) forces it on (and
// __installHint(null) hands the decision back to the sniff). __updateBand(true)
// does the same for the "new version ready" band, which needs a second build to
// appear honestly.
window.__installHint = forceInstallHint;
window.__updateBand = forceUpdateBand;

// Sliders on a laptop, game on the phone: see src/tune.js. The DEV branch and
// the *dynamic* import are both deliberate -- DEV becomes `false` at build time,
// so the branch is eliminated, the import is unreachable, and no chunk is
// emitted. A static top-level import would ship the rig to players. `resize` is
// handed over rather than exposed on window, since a couple of constants are
// only read there.
if (import.meta.env.DEV) {
  import('./tune.js').then((m) => m.installTuning(game, resize));
}

// Only a built site gets a service worker: one sitting in front of the dev
// server serves you yesterday's bundle and wastes an afternoon. `vite preview`
// is a real build, so the offline path can still be rehearsed locally.
if (import.meta.env.PROD) registerWorker();

function readSafeInsets() {
  const cs = getComputedStyle(probe);
  return {
    top: parseFloat(cs.paddingTop) || 0,
    right: parseFloat(cs.paddingRight) || 0,
    bottom: parseFloat(cs.paddingBottom) || 0,
    left: parseFloat(cs.paddingLeft) || 0,
  };
}

function resize() {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  if (!w || !h) return;

  // cap DPR: a 3x iPhone backing store costs real frame time for no visible win
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  game.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  game.view.w = w;
  game.view.h = h;
  game.view.dpr = dpr;
  // The wall spans the play column, so the game plays identically at any device
  // size; on a wide window the column is centred and the sides are letterboxed.
  game.view.playW = Math.min(w, T.MAX_PLAY_W);
  game.view.ox = Math.round((w - game.view.playW) / 2);
  game.view.scale = game.view.playW / T.WALL_W;
  game.view.safe = readSafeInsets();
}

resize();

new ResizeObserver(resize).observe(stage);
window.addEventListener('orientationchange', () => setTimeout(resize, 120));
if (window.visualViewport) window.visualViewport.addEventListener('resize', resize);

let last = performance.now();
document.addEventListener('visibilitychange', () => {
  last = performance.now(); // don't integrate the time spent backgrounded
  // Coming back to a home-screen app that has been open for days is the case
  // that most needs an update check: iOS keeps the web view alive, so nothing
  // else would ever ask. The same is true of the date -- roll it here so the
  // first frame after resuming is already showing today's set, rather than
  // yesterday's for the second it takes the menu's own check to come round.
  if (!document.hidden) {
    game.rollDay();
    checkForUpdate();
  }
});

function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  if (dt > 0) game.fps += (1 / dt - game.fps) * 0.08;

  const t0 = performance.now();
  update(game, dt);
  const t1 = performance.now();
  render(game);
  const t2 = performance.now();
  // rolling cost, surfaced in the debug panel -- 60fps is a stated target and
  // frame gap alone can't tell you whether you're CPU-bound or just throttled
  game.msUpdate += (t1 - t0 - game.msUpdate) * 0.05;
  game.msRender += (t2 - t1 - game.msRender) * 0.05;

  // Live-tuning telemetry, if the rig is loaded and a tuner is actually open.
  // Deliberately AFTER msRender is taken, so it cannot inflate the numbers it
  // reports -- and timed on its own, because a measurement rig that costs frame
  // time silently is worse than none. Only src/tune.js ever sets `game.sample`, so
  // in a built site this is one property check per frame.
  if (game.sample) {
    const t3 = performance.now();
    game.sample(now);
    game.msTune += (performance.now() - t3 - game.msTune) * 0.05;
  }

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
