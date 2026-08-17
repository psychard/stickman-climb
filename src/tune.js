/**
 * Live tuning receiver -- DEV ONLY, and structurally so.
 *
 * `main.js` reaches this module through a dynamic import inside an
 * `import.meta.env.DEV` branch. That gate is load-bearing in a way a static
 * import would quietly undo: DEV is replaced with `false` at build time, the
 * branch is eliminated, the import becomes unreachable, and Rollup emits no
 * chunk for any of this. A top-level `import './tune.js'` would sit in the
 * production graph unconditionally -- and `dist/sw.js` precaches `assets/*`, so
 * a leaked chunk would not merely ship, it would be *installed* onto a phone.
 *
 * What it does: applies tuning overrides pushed from the /__tune page on a
 * laptop, over the dev server's own HMR websocket (see tools/tune/plugin.mjs).
 * `T` is a plain object whose values are all read inside function bodies at call
 * time, so writing to it takes effect on the very next frame with nothing to
 * re-initialise.
 */

import { T } from './tuning.js';
import { applyOverrides } from './overrides.js';

/** Paths we have touched, mapped to the value the file shipped with. */
const baseline = new Map();

const state = {
  rev: null,
  active: 'A',
  count: 0,
  errors: [],
  /** 0 disables telemetry entirely; the server raises it only while a tuner is open. */
  hz: 0,
  lastSent: 0,
  frame: 0,
};

/**
 * A streaming histogram of per-frame strain, which is what makes the CALIBRATION
 * sliders honest rather than guesswork.
 *
 * REST_STRAIN is calibrated against the p25/median/p90 spread of real stances --
 * you cannot feel a percentile, and a clean test stance scores 0.12 against a real
 * median of 0.30, so tuning to whichever stance you happen to be standing in is
 * the documented trap. Fixed buckets over 0..2 make each sample one array
 * increment, so this can run every frame without being the thing you are
 * measuring.
 *
 * NOTE this is a DIFFERENT statistic from `npm run measure`, which reports the
 * spread over discrete route stances driven by the auto-climber. This one is
 * weighted by how long you actually dwell in a position. It is arguably closer to
 * what pacing feels like, and the repo has never had it -- but it informs the
 * slider, and `measure` still settles the committed value.
 */
const BUCKETS = 80;
const BUCKET_MAX = 2;
const hist = { counts: new Uint32Array(BUCKETS), n: 0, resting: 0 };

function resetHist() {
  hist.counts.fill(0);
  hist.n = 0;
  hist.resting = 0;
}

function addSample(strain) {
  const i = Math.min(BUCKETS - 1, Math.max(0, Math.floor((strain / BUCKET_MAX) * BUCKETS)));
  hist.counts[i]++;
  hist.n++;
  if (strain < T.REST_STRAIN) hist.resting++;
}

/** Bucket-interpolated quantile. Good to ~0.0125 of strain, which is plenty here. */
function quantile(q) {
  if (!hist.n) return null;
  const want = q * hist.n;
  let seen = 0;
  for (let i = 0; i < BUCKETS; i++) {
    seen += hist.counts[i];
    if (seen >= want) return ((i + 0.5) / BUCKETS) * BUCKET_MAX;
  }
  return BUCKET_MAX;
}

function distribution() {
  return {
    n: hist.n,
    p25: quantile(0.25),
    p50: quantile(0.5),
    p90: quantile(0.9),
    // The number `measure` prints, and the one the whole pacing mechanic turns on.
    resting: hist.n ? hist.resting / hist.n : null,
    rest: T.REST_STRAIN,
  };
}

/** Read a dotted path out of T, for the overlay's list of live overrides. */
function leafOf(path) {
  let node = T;
  for (const seg of path.split('.')) node = node?.[seg];
  return node;
}

/**
 * What the renderer reads off `game.tuned`: a flag, and the debug-overlay lines
 * ready-formatted. render.js spreads `lines` straight into its panel, so the code
 * that builds them does not have to exist in a built site.
 */
function tuneInfo(game) {
  const paths = [...baseline.keys()];
  return {
    on: paths.length > 0,
    rev: state.rev,
    active: state.active,
    count: paths.length,
    paths,
    errors: state.errors,
    // A getter, because msTune moves every frame while this object is rebuilt only
    // when a value lands. It is read only from inside render.js's `if (game.debug)`
    // block, so it costs nothing with the overlay closed.
    get lines() {
      return [
        // `hz 0` means no tuner is listening, which is the first thing to check
        // when a readout looks frozen -- it is the difference between "nothing is
        // being sent" and "what is being sent is wrong".
        `tune ${state.active} rev ${state.rev}  ${state.hz}hz  ${(game.msTune ?? 0).toFixed(2)}ms`,
        // Capped: all 38 knobs could be live at once, and the overlay is a glance
        // on a phone rather than a report.
        ...paths.slice(0, 6).map((p) => `  ${p} ${leafOf(p)}`),
        ...(paths.length > 6 ? [`  +${paths.length - 6} more`] : []),
        ...state.errors.map((e) => `  REFUSED ${e.path}`),
      ];
    },
  };
}

/**
 * "This is not the real game", drawn wherever render.js asks for it.
 *
 * Installed as `game.overlay` so that none of this exists in a built bundle --
 * render.js only carries the two `game.overlay?.()` call sites, which decide the
 * draw order. Returns true when it has taken over the slot it was called in.
 *
 * It draws in the same place on the menu and over a climb, because the point is
 * that you always know where to look to find out whether what you are feeling is
 * the committed game or your own last slider.
 */
function drawBadge(ctx, view, game) {
  if (!baseline.size) return false;

  const n = baseline.size;
  const label =
    `TUNED ${state.active} · ${n} key${n === 1 ? '' : 's'} · rev ${state.rev ?? '–'}` +
    (state.errors.length ? ` · ${state.errors.length} REFUSED` : '');

  ctx.save();
  ctx.font = '600 10px ui-monospace, monospace';
  const w = ctx.measureText(label).width + 18;
  const h = 18;
  const x = view.ox + 8;
  const y = view.h - view.safe.bottom - h - 6;

  ctx.fillStyle = 'rgba(255,209,102,0.16)';
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, h / 2);
  ctx.fill();
  ctx.fillStyle = state.errors.length ? T.COL.stamLo : T.COL.inRange;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(label, x + 9, y + 12);

  // Ticks are suppressed while tuned -- see topOut in game.js. Say so, because a
  // top-out that silently fails to tick reads as a bug in the game.
  ctx.font = '10px ui-monospace, monospace';
  ctx.fillStyle = T.COL.textDim;
  ctx.fillText('NO TICKS', x + w + 8, y + 12);
  ctx.restore();
  return true;
}

/**
 * One telemetry sample: ~20 numbers the game has already computed. Property reads
 * only -- nothing here is new arithmetic, which is what keeps the rig from being
 * the thing you are measuring.
 */
function payload(game) {
  const { stam, fig, wall } = game;
  return {
    rev: state.rev,
    frame: state.frame,
    t: Date.now(),
    state: game.state,
    level: game.level,
    problem: game.problem,
    day: game.day,
    fps: game.fps,
    msUpdate: game.msUpdate,
    msRender: game.msRender,
    msTune: game.msTune,
    // Both are null while the menu is up, which both the update and the draw path
    // already have to tolerate.
    strain: stam
      ? {
          smooth: stam.smooth,
          value: stam.value,
          planted: stam.planted,
          hold: stam.parts.hold,
          flex: stam.parts.flex,
          balance: stam.parts.balance,
          armLoad: stam.parts.armLoad,
        }
      : null,
    load: stam
      ? {
          LH: stam.load.LH ?? 0,
          RH: stam.load.RH ?? 0,
          LF: stam.load.LF ?? 0,
          RF: stam.load.RF ?? 0,
          arms: (stam.load.LH ?? 0) + (stam.load.RH ?? 0),
        }
      : null,
    violation: fig?.violation ?? null,
    topple: fig?.topple ?? null,
    over: fig?.balance?.over ?? null,
    dist: distribution(),
    problemLabel: wall ? `L${wall.level + 1} #${wall.index + 1} ${wall.style.id}` : null,
  };
}

export function installTuning(game, resize) {
  const hot = import.meta.hot;
  if (!hot) return;

  game.overlay = (ctx, view) => drawBadge(ctx, view, game);
  game.msTune = 0;

  /**
   * Called from the tail of main.js's frame(), after msRender has been taken, so
   * it cannot inflate the numbers it reports. Five rules, all about not costing
   * frame time on a phone:
   *
   *  - off entirely unless a tuner is open (state.hz is 0 otherwise, which is the
   *    state most dev sessions are in);
   *  - a wall-clock gate, so the socket sees 4Hz and not 120;
   *  - the histogram still accumulates every frame, because that is one array
   *    increment and a distribution wants the samples;
   *  - drop rather than queue -- a stale sample is worthless and a backlog is a
   *    leak on a phone;
   *  - never called from inside the substep loop.
   *
   * rAF throttles when the tab is backgrounded, so telemetry simply stops. That is
   * correct, but it means silence does not mean disconnected -- hence `t` and
   * `frame` on every sample, so the tuner can grey out a stale readout.
   */
  game.sample = (now) => {
    if (!state.hz) return;
    state.frame++;
    if (game.state === 'climbing' && game.stam) addSample(game.stam.smooth);

    const gap = 1000 / state.hz;
    if (now - state.lastSent < gap) return;
    state.lastSent = now;
    hot.send('climb:telemetry', payload(game));
  };

  hot.on('climb:hz', (msg) => {
    const hz = Math.max(0, Math.min(10, msg?.hz ?? 0));
    if (hz === state.hz) return;
    state.hz = hz;
    if (!hz) game.msTune = 0;
    resetHist();
  });

  /**
   * Apply a complete override map. Anything absent from it is restored to the
   * value read off the module before we first touched it -- see applyOverrides.
   */
  function apply(msg) {
    const values = msg?.values ?? {};
    const { applied, errors } = applyOverrides(T, values, baseline);
    state.rev = msg?.rev ?? state.rev;
    state.active = msg?.active ?? state.active;
    state.count = baseline.size;
    state.errors = errors;

    for (const err of errors) console.warn(`[tune] ${err.path}: ${err.error}`);

    // Published onto `game` rather than imported by the renderer: render.js and
    // game.js both need to know, and importing this dev-only module from either
    // would put the whole rig in the production bundle. In a built game the field
    // is simply never set, so `game.tuned?.on` is falsy and costs nothing.
    game.tuned = baseline.size ? tuneInfo(game) : null;

    // A strain weight that just moved makes every sample already in the histogram
    // a measurement of a different model, so the population is thrown away rather
    // than averaged with the new one. The cost is that dragging a slider keeps the
    // distribution near-empty until you let go -- which is honest, and why the
    // sample count is reported alongside the percentiles.
    if (applied.length) resetHist();

    // A fresh connection learns the rate from the state message; after that the
    // server pushes changes as tuners come and go.
    if (typeof msg?.telemetryHz === 'number') state.hz = msg.telemetryHz;

    // v1's constants are all read per-frame, so the overwhelmingly common case
    // is that there is nothing to do. The two exceptions are declared by the
    // server rather than guessed at here, so growing the exposed set later is a
    // schema edit and not a change to this file.
    const after = new Set(msg?.after ?? []);
    if (after.has('resize')) resize();
    if (after.has('rebuild') && game.wall && game.state === 'climbing') {
      game.startProblem(game.level, game.problem);
    }

    if (applied.length) {
      const summary = applied
        .map((a) => `${a.path} ${a.from}→${a.to}${a.restored ? ' (restored)' : ''}`)
        .join(', ');
      console.log(`[tune] rev ${state.rev}: ${summary}`);
    }
  }

  hot.on('climb:state', apply);
  hot.on('climb:apply', apply);

  // Announce on every reconnect, not only at load. Vite's client reloads the
  // page when the socket drops, but it also recovers without reloading in some
  // cases -- and either way this handler firing again is the moment we are
  // holding nothing but the file's defaults and need the server to tell us what
  // is actually in force.
  hot.on('vite:ws:connect', () => hot.send('climb:hello', { role: 'game' }));
  hot.send('climb:hello', { role: 'game' });
}
