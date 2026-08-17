/**
 * Difficulty ladder measurement. Run with `npm run ladder`.
 *
 * The five levels in T.LEVELS are spaced on these numbers rather than by eye, and
 * the table in tuning.js is this tool's output. `verify` and `sim` answer "is it
 * broken?"; `measure` answers "what does the biophysics model do?"; this answers
 * "are the five walls actually five different difficulties?".
 *
 * Rerun it after touching any of: LEVELS, MOVE_DIST, QUALITY_ROUTE, QUALITY_FILL,
 * FILL_DENSITY, DIFF_FULL_HEIGHT, or anything that moves strain -- and update the
 * table in tuning.js with what comes out.
 *
 *   node tools/ladder.mjs [--day=YYYYMMDD|today]
 *
 * The two columns that matter are `climbed` and `moves`: how far the live-solver
 * auto-climber gets before it pumps out. It never rests deliberately and it
 * releases a drag blind after a fixed 0.18s, so a human gets further -- these
 * numbers are for spacing the rungs against each other, not for predicting scores.
 */

import { T } from '../src/tuning.js';
import { dayArg } from '../src/day.js';
import { generateProblem, holdsNear, moveDistances, routeStances } from '../src/wall.js';
import { createFigure, stepFigure, canReach, stanceFeasible, LIMB_IDS } from '../src/body.js';
import { createStamina, updateStamina, computeStrain } from '../src/stamina.js';

const DRAG_STEPS = 22; // same drag/settle cadence as tools/sim-check.mjs
const SETTLE_STEPS = 18;

// One pinned day, so the table in tuning.js is reproducible -- the walls are reseeded
// from the date daily, and a ladder that reshuffles overnight can't justify a floor.
// `--day=today` re-asks the question against a set nobody has tuned against.
import { applyCliOverrides, overrideFooter } from './overrides-cli.mjs';

// MUST precede the DAY line below, which reads T at module scope.
const OVERRIDES = applyCliOverrides();

const DAY = dayArg(process.argv, T.REF_DAY);

const avg = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : 0);

/**
 * How much choice a stance actually offers: for every limb, how many holds on the
 * wall it could legally move up onto right now.
 *
 * This is the number that says whether a wall is a puzzle or a jungle gym. A
 * staircase offers a move for every limb all the time and any order works; a real
 * boulder problem often has exactly one limb that can go anywhere, so you have to
 * find which one. `stuck` counts the limbs with nothing available -- high is good,
 * it means the order is forced.
 */
function stanceChoices(wall, stance) {
  let moves = 0;
  let stuck = 0;
  for (const id of LIMB_IDS) {
    const cur = stance[id];
    const spec = id[1] === 'H' ? T.ARM : T.LEG;
    let n = 0;
    for (const h of holdsNear(wall, cur, spec.max * 1.4)) {
      if (h === cur) continue;
      if (h.y > cur.y - 8) continue; // only count moves that make progress
      if (Object.values(stance).includes(h)) continue;
      if (stanceFeasible({ ...stance, [id]: h })) n++;
    }
    moves += n;
    if (n === 0) stuck++;
  }
  return { moves, stuck };
}

function climb(index, level) {
  const wall = generateProblem(level, index, DAY);
  const fig = createFigure(wall.start);
  const stam = createStamina();
  const st = (n) => {
    for (let i = 0; i < n; i++) {
      stepFigure(fig, T.SUB_DT);
      updateStamina(stam, fig, T.SUB_DT);
    }
  };
  st(60);

  const strains = [];
  let moves = 0;
  let pumped = false;
  let topped = false;

  for (const mv of wall.route) {
    const limb = fig.limbs[mv.limb];
    const target = mv.hold;
    const from = { x: limb.pos.x, y: limb.pos.y };
    limb.hold = null;
    limb.drag = { pointerId: 0, target: { ...from } };
    for (let i = 1; i <= DRAG_STEPS; i++) {
      const t = i / DRAG_STEPS;
      limb.drag.target.x = from.x + (target.x - from.x) * t;
      limb.drag.target.y = from.y + (target.y - from.y) * t;
      st(1);
    }
    limb.drag = null;
    for (const hold of holdsNear(wall, limb.pos, T.SNAP_RADIUS)) {
      if (canReach(fig, limb, hold)) {
        limb.hold = hold;
        break;
      }
    }
    // resync to the route on a miss, same reasoning as sim-check
    if (limb.hold !== target) limb.hold = target;
    st(SETTLE_STEPS);
    strains.push(computeStrain(fig).total);
    moves++;
    if (stam.value <= 0) {
      pumped = true;
      break;
    }
  }
  // The auto-climber never rests, so pumping out before the top is expected on the
  // hard levels -- that is what `rests` is for. Topping without resting at all is
  // the strongest single statement about a problem's length.
  topped = !pumped && moves === wall.route.length;

  // How much choice the wall offers, sampled over the stretch a real attempt
  // sees. Every stance is a full feasibility sweep, so sample sparsely.
  const stances = routeStances(wall).slice(0, 120);
  const choices = [];
  const stucks = [];
  for (let i = 0; i < stances.length; i += 8) {
    const c = stanceChoices(wall, stances[i]);
    choices.push(c.moves);
    stucks.push(c.stuck);
  }

  // hold density and quality over the whole problem -- these are short enough now
  // that every attempt sees all of it
  const span = Math.max(1, wall.stats.rise);
  return {
    density: (100 * wall.holds.length) / span,
    quality: avg(wall.holds.filter((h) => h.route).map((h) => h.q)),
    move: avg(moveDistances(wall)),
    reuse: wall.stats.reused / Math.max(1, wall.stats.moves),
    choices: median(choices),
    stuck: avg(stucks),
    rests: strains.filter((v) => v < T.REST_STRAIN).length / Math.max(1, strains.length),
    strain: avg(strains),
    height: -fig.hip.y,
    moves,
    pumped,
    topped,
  };
}

console.log(`rest threshold ${T.REST_STRAIN}, all ${T.PROBLEMS_PER_LEVEL} problems per level`);
console.log('`choices` is legal moves available per stance, `stuck` limbs with none.\n');
console.log(
  'lvl name      floor  holds/100u  hold q  move  reuse  choices  stuck  rests  climbed  moves  topped',
);
for (let level = 0; level < T.LEVELS.length; level++) {
  const lvl = T.LEVELS[level];
  const runs = Array.from({ length: T.PROBLEMS_PER_LEVEL }, (_, i) => climb(i, level));
  const col = (f, d = 2) => avg(runs.map(f)).toFixed(d);
  console.log(
    ` ${level + 1}  ${lvl.name.padEnd(9)} ${lvl.floor.toFixed(2)}  ` +
      `${col((r) => r.density, 1).padStart(10)}  ` +
      `${col((r) => r.quality).padStart(6)}  ` +
      `${col((r) => r.move, 1).padStart(4)}  ` +
      `${(100 * avg(runs.map((r) => r.reuse))).toFixed(0).padStart(4)}%  ` +
      `${col((r) => r.choices, 1).padStart(7)}  ` +
      `${col((r) => r.stuck, 2).padStart(5)}  ` +
      `${(100 * avg(runs.map((r) => r.rests))).toFixed(0).padStart(4)}%  ` +
      `${col((r) => r.height, 0).padStart(6)}u  ` +
      `${col((r) => r.moves, 0).padStart(5)}  ` +
      `${runs.filter((r) => r.topped).length}/${runs.length}`,
  );
}
overrideFooter(OVERRIDES);
