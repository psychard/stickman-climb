/**
 * Oscillation probe. Run with `npm run jitter`.
 *
 * `sim` measures jitter once, on the start stance, which is the easiest stance on
 * the wall and has always been quiet. The bug reported from play is intermittent:
 * the figure occasionally drops into a bouncing loop that doesn't settle. So this
 * looks for the same thing everywhere it can happen -- after every move of the
 * route, and while a pointer is held still mid-drag -- and reports the worst.
 *
 * The metric that matters is NOT how far the hip moves. A body migrating to a new
 * equilibrium moves a long way and is fine; a body bouncing 2u back and forth
 * forever barely moves and is the bug. So each window reports:
 *
 *   travel   total hip path length over 1s of no input
 *   net      straight-line distance from where it started to where it ended
 *   wander   travel - net: path length that went nowhere. A settled body scores
 *            ~0.3u (solver noise), a converging drift scores near 0 however far
 *            it travels, and a limit cycle scores its entire path length.
 *
 * `wander` is the number to watch. The first version of this tool measured
 * peak-to-peak spread instead, which flagged slow one-way settling just as loudly
 * as a genuine buzz and made a third of the windows look broken.
 */

import { T } from '../src/tuning.js';
import { generateWall, holdsNear } from '../src/wall.js';
import { createFigure, stepFigure, canReach, stanceSolvable, LIMB_IDS } from '../src/body.js';
import { createStamina, updateStamina } from '../src/stamina.js';

const DRAG_STEPS = 22;
const SETTLE_STEPS = 18;
const WINDOW = 120; // substeps of "no input" we watch for a limit cycle -- 1s

/** Hip path length vs net displacement over `n` idle substeps. */
function watchWindow(fig, stam, n = WINDOW) {
  const start = { x: fig.hip.x, y: fig.hip.y };
  let prev = start;
  let travel = 0;
  let reversals = 0;
  let pv = { x: 0, y: 0 };
  for (let i = 0; i < n; i++) {
    stepFigure(fig, T.SUB_DT);
    updateStamina(stam, fig, T.SUB_DT);
    const v = { x: fig.hip.x - prev.x, y: fig.hip.y - prev.y };
    const len = Math.hypot(v.x, v.y);
    travel += len;
    // a direction flip of more than 90 degrees, ignoring sub-noise steps
    if (len > 0.05 && v.x * pv.x + v.y * pv.y < 0) reversals++;
    pv = v;
    prev = { x: fig.hip.x, y: fig.hip.y };
  }
  const net = Math.hypot(fig.hip.x - start.x, fig.hip.y - start.y);
  return { travel, net, wander: travel - net, reversals };
}

/** The stance that would result from `limb` taking `hold`; mirrors game.js. */
function stanceWith(fig, limb, hold) {
  const pts = {};
  for (const id of LIMB_IDS) {
    const other = fig.limbs[id];
    if (other !== limb && other.hold) pts[id] = other.hold;
  }
  pts[limb.id] = hold;
  return pts;
}

/**
 * Walk a level's route, and after every move hold perfectly still for a second
 * and watch. Also holds the pointer still at the end of each drag, before
 * releasing, because a player pausing mid-reach is just as common as a settled
 * stance and the wedge escape is disabled while dragging.
 *
 * Planting goes through the same gate the game applies -- canReach AND
 * stanceSolvable -- and a missed grab is resynced onto the route so the scan keeps
 * following it, exactly as `sim` does. Those windows are marked `synthetic` and
 * excluded from the verdict: the resync can assemble stances the game would refuse
 * outright (a leg 12u inside its minimum, in the case that flushed this out), and a
 * body oscillating in a position it can never be put in measures the harness.
 */
function scan(seed, level, maxMoves) {
  const wall = generateWall(seed, level);
  const fig = createFigure(wall.start);
  const stam = createStamina();
  for (let i = 0; i < 60; i++) stepFigure(fig, T.SUB_DT);

  const settled = [];
  const holding = [];

  let n = 0;
  let synthetic = false;
  for (const mv of wall.route.slice(0, maxMoves)) {
    const limb = fig.limbs[mv.limb];
    const from = { x: limb.pos.x, y: limb.pos.y };
    limb.hold = null;
    limb.drag = { pointerId: 0, target: { ...from } };
    for (let i = 1; i <= DRAG_STEPS; i++) {
      const t = i / DRAG_STEPS;
      limb.drag.target.x = from.x + (mv.hold.x - from.x) * t;
      limb.drag.target.y = from.y + (mv.hold.y - from.y) * t;
      stepFigure(fig, T.SUB_DT);
      updateStamina(stam, fig, T.SUB_DT);
    }

    // pointer parked on the target -- a player lining up a grab
    holding.push({ move: n, synthetic, ...watchWindow(fig, stam) });

    limb.drag = null;
    for (const hold of holdsNear(wall, limb.pos, T.SNAP_RADIUS)) {
      if (canReach(fig, limb, hold) && stanceSolvable(stanceWith(fig, limb, hold))) {
        limb.hold = hold;
        break;
      }
    }
    // A miss taints this window and the next drag, which starts from a stance the
    // figure was placed in rather than one it reached.
    synthetic = limb.hold !== mv.hold;
    limb.hold = mv.hold; // resync to the route, as sim does
    for (let i = 0; i < SETTLE_STEPS; i++) {
      stepFigure(fig, T.SUB_DT);
      updateStamina(stam, fig, T.SUB_DT);
    }

    settled.push({ move: n, synthetic, ...watchWindow(fig, stam) });
    n++;
  }
  return { settled, holding };
}

const worstBy = (rows, key) => rows.reduce((a, b) => (b[key] > a[key] ? b : a), rows[0]);
const pct = (rows, key, p) => {
  const v = rows.map((r) => r[key]).sort((a, b) => a - b);
  return v[Math.min(v.length - 1, Math.floor(v.length * p))];
};

const maxMoves = Number(process.argv[2] || 120);
// Solver noise over a second is a few tenths of a unit. 3u of path that went
// nowhere is something the eye reads as movement, and it is an order of magnitude
// clear of the noise floor either way.
//
// Reversals are required as well as wander, because a body settling along a curved
// path racks up wander honestly and looks fine: it arrives. A limit cycle is by
// definition repeated, so it always reverses -- the ones found here reverse between
// 9 and 119 times a second. Anything under a handful is a settle, not a buzz.
const WANDER_BAD = 3.0;
const REVERSALS_BAD = 4;
// ...and each swing has to be big enough to see. 1 world unit is about 1 css px on a
// phone, so a 0.2u buzz at 15Hz racks up wander honestly and is invisible; the cycles
// that were reported from play swing 2-3u. Without this the tool cannot tell those
// apart and reports solver noise as the bug.
const SWING_BAD = 0.6;
const bouncy = (r) =>
  r.wander > WANDER_BAD &&
  r.reversals >= REVERSALS_BAD &&
  r.travel / r.reversals > SWING_BAD;

// This is a RATE gate, not a zero. Three named oscillators were fixed (see CLAUDE.md)
// and took the overall figure from 11.5% of windows to 1.5%, essentially all of it
// with a pointer held still; settled stances score 0.2%. What is left has not been
// traced to a single mechanism, so the gate sits at a level that a regression in any
// of the three trips immediately -- each of them scored 5-22% per scan -- while the
// known residual passes. Tighten it if you get the rest.
const BOUNCE_BUDGET = 0.05;

console.log(
  `scanning ${maxMoves} moves x ${T.LEVELS.length} levels; ` +
    `wander = idle hip path length that went nowhere, over 1s\n`,
);

let bad = 0;
let totalBouncing = 0;
let totalWindows = 0;
for (let level = 0; level < T.LEVELS.length; level++) {
  const scanned = scan(T.LEVELS[level].seed, level, maxMoves);
  for (const [what, all] of [
    ['settled', scanned.settled],
    ['holding', scanned.holding],
  ]) {
    const rows = all.filter((r) => !r.synthetic);
    const skipped = all.length - rows.length;
    const cycling = rows.filter(bouncy);
    const w = cycling.length ? worstBy(cycling, 'wander') : worstBy(rows, 'wander');
    const nBad = cycling.length;
    // Settled stances have to be clean outright -- a figure bouncing with nobody
    // touching it is the complaint in its purest form -- while a pointer held mid-
    // reach is judged on the rate.
    const ok = what === 'settled' ? nBad === 0 : nBad <= rows.length * BOUNCE_BUDGET;
    if (!ok) bad++;
    totalBouncing += nBad;
    totalWindows += rows.length;
    console.log(
      `${ok ? 'PASS' : 'FAIL'} L${level + 1} ${T.LEVELS[level].name.padEnd(8)} ${what}  ` +
        `wander p50 ${pct(rows, 'wander', 0.5).toFixed(2)}u  ` +
        `p90 ${pct(rows, 'wander', 0.9).toFixed(2)}u  ` +
        `worst ${w.wander.toFixed(1)}u @move ${String(w.move).padStart(3)} ` +
        `(travel ${w.travel.toFixed(0)}u, net ${w.net.toFixed(0)}u, ` +
        `${w.reversals} reversals)  ` +
        `bouncing: ${String(nBad).padStart(3)}/${rows.length}` +
        (skipped ? `  (${skipped} resynced, skipped)` : '') +
        (ok ? '' : '  <-- OSCILLATING'),
    );
  }
}
const rate = ((100 * totalBouncing) / Math.max(1, totalWindows)).toFixed(1);
console.log(
  `\n${totalBouncing}/${totalWindows} windows bouncing (${rate}%)` +
    (bad === 0
      ? ' -- within budget.'
      : `\n${bad} scans over budget (${BOUNCE_BUDGET * 100}% held, 0 settled).`),
);
process.exit(bad === 0 ? 0 : 1);
