/**
 * Is a mid-fall catch achievable, and what does one buy? Run with `npm run catch`.
 *
 * Coming off the wall no longer ends the attempt -- a hand dragged onto a hold in
 * mid-air latches it and puts you back into climbing (see `catchHold` in game.js and
 * "Coming off the wall is not the end of the attempt" in CLAUDE.md). That is a
 * mechanic with two questions nothing else can answer, and both are quoted in the
 * docs, so both need to be re-runnable:
 *
 *   1. CATCHABILITY -- how long the fall lasts, and on how many of its frames some
 *      hand could take some hold. This is what says whether the mechanic is a
 *      reaction test or an aiming test, and it moves with GRAVITY, the reach
 *      constants, the pose cones and every generation constant that changes how
 *      thickly the wall is held.
 *
 *   2. WHAT A CATCH BUYS -- seconds until the bar is empty again, starting from
 *      CATCH_STAMINA, on the three stances a catch actually leads to. Nearly every
 *      catch is a catch from PUMPED OUT, so if this is shorter than the ~1.83s a
 *      human move takes, the refund is a formality and the save is undone. It moves
 *      with every stamina constant.
 *
 * The catch gate here is `canReach` + `stanceSolvable`, which is what refreshTargets
 * asks. The snap radius is not tested separately because it is satisfied for free
 * once canReach is: placeEndpoints clamps the dragged endpoint onto the hold itself,
 * so the distance from endpoint to hold is zero. What that means for the player is
 * that a touch has to land near a hold near the body -- a touch in the corner of the
 * screen extends the nearest hand toward it and finds nothing. This tool measures the
 * envelope, not the aim.
 */

import { T } from '../src/tuning.js';
import { dayArg } from '../src/day.js';
import { generateProblem, routeStances, holdsInRange } from '../src/wall.js';
import {
  createFigure,
  stepFigure,
  anchorOf,
  specFor,
  canReach,
  stanceSolvable,
  LIMB_IDS,
} from '../src/body.js';
import { createStamina, updateStamina } from '../src/stamina.js';
import { applyCliOverrides, overrideFooter } from './overrides-cli.mjs';

// MUST precede the DAY line below, which reads T at module scope.
const OVERRIDES = applyCliOverrides();

// Pinned like the rest of the tuning harness: a day's walls move how thickly the
// fall line is held, and a catchability figure you can't compare to yesterday's says
// nothing about the constant you just changed. `--day=YYYYMMDD` or `--day=today`.
const DAY = dayArg(process.argv, T.REF_DAY);

const FPS = 60;
const HANDS = LIMB_IDS.filter((id) => id.endsWith('H'));

/** One display frame of physics, in whole substeps, the way the game runs it. */
function frame(fig) {
  let acc = 1 / FPS;
  while (acc >= T.SUB_DT) {
    stepFigure(fig, T.SUB_DT);
    acc -= T.SUB_DT;
  }
}

/** Take the figure off the wall exactly as beginFall does. */
function comeOff(fig) {
  for (const id of LIMB_IDS) {
    fig.limbs[id].hold = null;
    fig.limbs[id].drag = null;
  }
  fig.falling = true;
  fig.grounded = false;
  fig.balance = null;
}

/**
 * How many holds either hand could take right now -- the same two questions
 * `refreshTargets` asks, and split the same way for the same reason.
 *
 * `stanceSolvable` is memoised because it does not depend on the body at all:
 * `solveStatic` seeds from the hold centroids, and with nothing else planted a
 * one-hand stance is a pure function of (limb, hold). It is also the expensive half
 * -- ~105us a call -- so without the memo this tool spends most of its time re-asking
 * whether you can hang off a hold it has already hung off.
 */
function catchesAvailable(fig, wall, solvable) {
  let n = 0;
  for (const id of HANDS) {
    const limb = fig.limbs[id];
    const a = anchorOf(fig.hip, fig.chest, limb);
    const max = specFor(limb.kind).max;
    for (const hold of holdsInRange(wall, a.y - max, a.y + max)) {
      if (!canReach(fig, limb, hold)) continue;
      const key = `${id}:${hold.x},${hold.y}`;
      let ok = solvable.get(key);
      if (ok === undefined) solvable.set(key, (ok = stanceSolvable({ [id]: hold })));
      if (ok) n++;
    }
  }
  return n;
}

/** Drop off `stance` and watch the whole fall. */
function fall(wall, stance, solvable) {
  const fig = createFigure(stance);
  comeOff(fig);
  let frames = 0;
  let open = 0;
  let holds = 0;
  // The 4s ceiling is a guard, not a limit: stepFigure stops the figure on the floor.
  while (!fig.grounded && frames < 4 * FPS) {
    frame(fig);
    frames++;
    const n = catchesAvailable(fig, wall, solvable);
    if (n) {
      holds += n;
      open++;
    }
  }
  return { dur: frames / FPS, open: open / FPS, holds: holds / (open || 1) };
}

const SURVIVE_CAP = 15;

/**
 * Enter `stance` holding `v0` of the bar and do nothing. Returns null if it recovers,
 * or the seconds until empty if it doesn't.
 *
 * **Report the recovering FRACTION, not a median of this.** The distribution is
 * bimodal -- a stance either sits above REST_STRAIN and empties in seconds, or sits
 * below it and fills back to full -- so a median lands wherever the mode boundary
 * happens to fall and swings by 6s when the sample changes. The recovering fraction
 * is the same statistic `measure` reports for route stances, and it is stable.
 */
function survive(stance, v0) {
  const fig = createFigure(stance);
  const stam = createStamina();
  stam.value = v0;
  // Seed the low-pass at this stance's own strain rather than at zero, or the first
  // second is free while the filter climbs -- which is most of what is being measured.
  updateStamina(stam, fig, 0);
  stam.smooth = stam.strain;
  let t = 0;
  while (stam.value > 0 && t < SURVIVE_CAP) {
    frame(fig);
    updateStamina(stam, fig, 1 / FPS);
    t += 1 / FPS;
    // Called early once the body has settled and the bar is demonstrably climbing:
    // there is no input, so nothing is going to make this stance harder later, and
    // simulating the remaining thirteen seconds of a recovery is all this tool's
    // runtime. The 1.5s floor is what makes it "settled" rather than "the filter has
    // not caught up yet".
    if (t > 1.5 && stam.smooth < T.REST_STRAIN && stam.value > v0 + 0.05) return null;
  }
  return t;
}

const p50 = (a) => (a.length ? a.slice().sort((x, y) => x - y)[a.length >> 1] : NaN);

console.log(`\nmid-fall catches, day ${DAY}\n`);
console.log('  1. CATCHABILITY -- can you get back on, and for how long is the door open?\n');
console.log(
  '     level          falls  fall lasts (p50, and the range)  catchable  window  holds/frame',
);

const buys = [];
for (let level = 0; level < T.LEVELS.length; level++) {
  const falls = [];
  const one = [];
  const two = [];
  const all = [];

  for (let index = 0; index < T.PROBLEMS_PER_LEVEL; index++) {
    const wall = generateProblem(level, index, DAY);
    const stances = routeStances(wall);
    const solvable = new Map(); // per wall: see catchesAvailable
    // Every third stance: enough of the wall to be a spread, cheap enough to run.
    for (let i = 0; i < stances.length; i += 3) {
      const st = stances[i];
      if (!st.LH || !st.RH || !st.LF || !st.RF) continue;
      falls.push(fall(wall, st, solvable));
      // The three stances a catch leads to: latched and hanging, one foot recovered,
      // and the whole stance re-made. A human move is ~1.83s, so the gap between the
      // first two rows is what says whether the first foot is affordable.
      //
      // Sampled half as often as the falls, and that is where this tool's runtime
      // lives: a stance that recovers is simulated for the whole SURVIVE_CAP, three
      // times over, and these are medians -- another 200 samples moves none of them.
      one.push(survive({ RH: st.RH }, T.CATCH_STAMINA));
      two.push(survive({ RH: st.RH, RF: st.RF }, T.CATCH_STAMINA));
      all.push(survive(st, T.CATCH_STAMINA));
    }
  }

  const open = falls.filter((f) => f.open > 0);
  const name = T.LEVELS[level].name;
  const durs = falls.map((f) => f.dur);
  // The range matters as much as the median: a fall low on the wall is a fraction of
  // one off the top, and it is the SHORT end that says whether this is playable.
  const range = `(${Math.min(...durs).toFixed(2)}-${Math.max(...durs).toFixed(2)}s)`;
  console.log(
    `     L${level + 1} ${name.padEnd(9)} ${String(falls.length).padStart(6)}  ` +
      `${(p50(durs).toFixed(2) + 's').padStart(10)} ${range.padStart(17)}  ` +
      `${((100 * open.length / falls.length).toFixed(0) + '%').padStart(9)}  ` +
      // An override can close the door completely -- a heavier GRAVITY, a shorter
      // arm -- and "no catchable frames at all" is a result, not a crash.
      `${(open.length ? p50(open.map((f) => f.open)).toFixed(2) + 's' : '-').padStart(6)}  ` +
      `${(open.length ? p50(open.map((f) => f.holds)).toFixed(1) : '-').padStart(11)}`,
  );
  buys.push([level + 1, name, one, two, all]);
}

console.log(`\n  2. WHAT A CATCH BUYS -- entering a stance with CATCH_STAMINA ${T.CATCH_STAMINA} and`);
console.log('     doing nothing: does it recover, and if not how long have you got?');
console.log('     (a human move is ~1.83s, so the first foot is one move and the stance is three)\n');
console.log(`     ("% last" = still on the wall after ${SURVIVE_CAP}s; the time is the median of the rest)`);
console.log('\n     level           latched (1 hand)          +1 foot            stance re-made');

/**
 * "62% last, else 3.4s" -- the fraction first, since that is the stable half.
 *
 * "Lasted" folds together the stances that demonstrably recover and the ones still
 * hanging on when SURVIVE_CAP expires. They differ (one is filling, one is bleeding
 * slowly) but not in a way that matters here, and separating them would put the cap
 * in the table dressed up as a drain time -- which reads as a measurement and isn't.
 */
function buy(list) {
  const empty = list.filter((v) => v !== null && v < SURVIVE_CAP);
  const pct = Math.round((100 * (list.length - empty.length)) / list.length);
  return empty.length ? `${pct}% last, ${p50(empty).toFixed(1)}s` : `${pct}% last`;
}

for (const [l, name, a, b, c] of buys) {
  console.log(
    `     L${l} ${name.padEnd(9)} ${buy(a).padStart(18)} ${buy(b).padStart(18)} ${buy(c).padStart(18)}`,
  );
}

// A catch that hands back nothing is undone on the next frame. That is a coherent
// setting of the knob -- a CAME OFF or OFF BALANCE fall still has bar left and is
// still catchable -- so it is named rather than warned about.
if (T.CATCH_STAMINA <= 0) {
  console.log('\n  CATCH_STAMINA is 0: a PUMPED OUT catch re-drops you immediately, by design.');
} else if (buys.some(([, , a]) => a.every((v) => v !== null && v < 1.83))) {
  console.log('\n  WARNING: on some level a latched stance always empties inside one human move.');
  console.log('  The refund is a formality there -- the catch cannot be converted into a stance.');
}

overrideFooter(OVERRIDES);
