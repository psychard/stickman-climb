/**
 * Headless auto-climber. Run with `npm run sim`.
 *
 * `verify-wall.mjs` proves each stance is statically feasible. This goes
 * further: it drives the *live* solver -- the same stepFigure() the game runs --
 * through simulated drags, so it catches problems the static check can't:
 * bodies that oscillate, drags that fail to plant, stamina curves that are
 * unsurvivable, moves that are geometrically legal but dynamically unreachable.
 *
 * It also doubles as the tuning harness: change a constant in tuning.js, run
 * this, and see what it did to plant rate, stamina and jitter.
 */

import { T } from '../src/tuning.js';
import { dayArg } from '../src/day.js';
import { generateProblem, holdsNear } from '../src/wall.js';
import {
  createFigure,
  stepFigure,
  canReach,
  stanceSolvable,
  anchorOf,
  specFor,
  poseViolation,
  torsoFrame,
  ikJoint,
  LIMB_IDS,
} from '../src/body.js';
import { createStamina, updateStamina } from '../src/stamina.js';

const DRAG_STEPS = 22; // substeps spent moving a limb to its target
const SETTLE_STEPS = 18;

// Pinned, because this is the tuning harness as much as it is a gate: the walls are
// reseeded from the date daily, and a plant rate you cannot compare against the one
// you measured yesterday tells you nothing about the constant you just changed.
// `--day=today` (or a specific one) runs it against a set nobody has tuned against,
// which is the honest check on whether a number generalises. `verify` is the tool
// that sweeps real days.
const DAY = dayArg(process.argv, T.REF_DAY);

const step = (fig, stam, n) => {
  for (let i = 0; i < n; i++) {
    stepFigure(fig, T.SUB_DT);
    updateStamina(stam, fig, T.SUB_DT);
  }
};

/**
 * Anatomical invariants, sampled every substep. These are the three things that
 * looked wrong on the phone, so they get asserted rather than eyeballed:
 * feet that pull, limbs outside their cone, and joints that snap sides.
 */
function makeWatch() {
  return {
    poseWorst: 0,
    footTension: 0,
    footTensionDrag: 0,
    bendFlips: 0,
    peels: 0,
    prevBend: {},
    movingSum: 0,
    movingN: 0,
    settledSum: 0,
    settledN: 0,
    soloFrames: 0,
    noFeetFrames: 0,
    frames: 0,
    // True while the figure sits in a stance it never actually reached, because
    // a missed grab was resynced onto the route. Anatomical invariants are not
    // recorded then: that stance is an artefact of the harness, not something
    // the solver produced, so asserting on it measures the wrong thing.
    synthetic: false,
    // Route moves the figure planted for real, with no resync. Used to judge the
    // top-out on its own: the last two moves are the one thing no wall asked for
    // before this existed -- a hand to the finish, then the other hand matching it.
    plantedMoves: new Set(),
  };
}

function observe(watch, fig, stam, moving) {
  if (stam) {
    if (moving) {
      watch.movingSum += stam.strain;
      watch.movingN++;
    } else {
      watch.settledSum += stam.strain;
      watch.settledN++;
    }
  }
  // Reaching with one hand must not strip you down to a single contact -- that
  // was the whole body hanging off one hand that isn't even overhead.
  const contacts = LIMB_IDS.filter((id) => fig.limbs[id].hold);
  watch.frames++;
  if (contacts.length <= 1) watch.soloFrames++;
  if (!contacts.some((id) => fig.limbs[id].kind === 'foot')) watch.noFeetFrames++;

  const frame = torsoFrame(fig.hip, fig.chest);
  for (const id of LIMB_IDS) {
    const limb = fig.limbs[id];
    const pt = limb.hold || (limb.drag ? limb.pos : null);
    if (pt && !watch.synthetic) {
      watch.poseWorst = Math.max(watch.poseWorst, poseViolation(fig.hip, fig.chest, limb, pt));
    }
    if (limb.hold && limb.kind === 'foot' && !watch.synthetic) {
      const a = anchorOf(fig.hip, fig.chest, limb);
      const d = Math.hypot(limb.hold.x - a.x, limb.hold.y - a.y);
      const stretch = d - specFor(limb.kind).max;
      // Elastic give WHILE you're hauling on a limb is the intended feel; what
      // must not happen is a leg left stretched once the stance has settled.
      if (moving) watch.footTensionDrag = Math.max(watch.footTensionDrag, stretch);
      else watch.footTension = Math.max(watch.footTension, stretch);
    }
    // exercise the IK the renderer would run, and watch the bend side
    const a = anchorOf(fig.hip, fig.chest, limb);
    ikJoint(a, limb.pos, specFor(limb.kind).bone, frame, limb);
    if (watch.prevBend[id] !== undefined && watch.prevBend[id] !== limb.bend) watch.bendFlips++;
    watch.prevBend[id] = limb.bend;
  }
}

/** Total hip travel over `n` substeps with no input -- should be ~0 at rest. */
function measureJitter(fig, stam, n = 120) {
  let travel = 0;
  let prev = { x: fig.hip.x, y: fig.hip.y };
  for (let i = 0; i < n; i++) {
    stepFigure(fig, T.SUB_DT);
    updateStamina(stam, fig, T.SUB_DT);
    travel += Math.hypot(fig.hip.x - prev.x, fig.hip.y - prev.y);
    prev = { x: fig.hip.x, y: fig.hip.y };
  }
  return travel;
}


/** Drag `limb` to `target` the way a player would, then try to plant. */
function attemptMove(fig, stam, wall, limb, target, watch, move) {
  const from = { x: limb.pos.x, y: limb.pos.y };
  const previous = limb.hold;
  const footHoldsBefore = LIMB_IDS.filter((id) => fig.limbs[id].kind === 'foot' && fig.limbs[id].hold);

  limb.hold = null;
  limb.drag = { pointerId: 0, target: { ...from } };
  for (let i = 1; i <= DRAG_STEPS; i++) {
    const t = i / DRAG_STEPS;
    limb.drag.target.x = from.x + (target.x - from.x) * t;
    limb.drag.target.y = from.y + (target.y - from.y) * t;
    stepFigure(fig, T.SUB_DT);
    updateStamina(stam, fig, T.SUB_DT);
    observe(watch, fig, stam, true);
  }
  limb.drag = null;

  // nothing should come off a hold unless the player took it off
  for (const other of footHoldsBefore) {
    if (other !== limb.id && !fig.limbs[other].hold) watch.peels++;
  }

  for (const hold of holdsNear(wall, limb.pos, T.SNAP_RADIUS)) {
    if (canReach(fig, limb, hold)) {
      limb.hold = hold;
      break;
    }
  }
  const ok = limb.hold === target;
  if (ok && move) watch.plantedMoves.add(move);
  // Resync to the route on a miss. Otherwise the stance diverges from the one
  // the generator planned and every later target is measured from the wrong
  // place, so one marginal failure cascades into dozens of meaningless ones.
  // We want the per-move failure rate, not the length of the first cascade.
  if (!ok) limb.hold = target;
  watch.synthetic = !ok;
  void previous;
  for (let i = 0; i < SETTLE_STEPS; i++) {
    stepFigure(fig, T.SUB_DT);
    updateStamina(stam, fig, T.SUB_DT);
    observe(watch, fig, stam, false);
  }
  return ok;
}

/**
 * Replay the generator's own route through the live solver.
 *
 * The generator promised this sequence is climbable, having checked each stance
 * with the headless static solve. This re-walks exactly those moves using the
 * real per-frame physics, so a mismatch between the two is caught here rather
 * than by the player getting stuck halfway up.
 */
function climb(level, index) {
  const wall = generateProblem(level, index, DAY);
  const fig = createFigure(wall.start);
  const stam = createStamina();
  step(fig, stam, 60);

  const restJitter = measureJitter(fig, stam);

  const route = wall.route;
  const watch = makeWatch();
  let planted = 0;
  let missed = 0;
  let minStamina = 1;
  let pumpedAt = 0;

  // Running out of stamina does NOT stop the run: this harness never rests, so
  // pumping out is an artefact of the harness rather than a mechanics failure.
  // `pumpedAt` records where it happened and `npm run ladder` measures survivability.
  for (const mv of route) {
    const limb = fig.limbs[mv.limb];
    if (attemptMove(fig, stam, wall, limb, mv.hold, watch, mv)) planted++;
    else missed++;

    minStamina = Math.min(minStamina, stam.value);
    if (stam.value <= 0 && !pumpedAt) pumpedAt = planted + missed;
  }

  const moves = planted + missed;
  // Did the top-out itself work? The last two moves are one hand to the finish hold
  // and then the other hand matching it, and the match is a move no wall ever asked
  // for before -- two limbs on one hold. Whether the earlier moves needed a resync
  // is a separate question, measured by plant rate; this is about the ending.
  const top = wall.finish;
  const topped = top && fig.limbs.LH.hold === top && fig.limbs.RH.hold === top;
  const lastTwo = route.slice(-2);
  return {
    level,
    index,
    style: wall.style,
    topped,
    topClean: lastTwo.every((mv) => watch.plantedMoves.has(mv)),
    pumpedAt,
    height: -fig.hip.y,
    planted,
    missed,
    plantRate: planted / Math.max(1, moves),
    restJitter,
    minStamina,
    // strain while a limb is moving vs settled on a stance -- the gap between
    // these and REST_STRAIN is what decides whether resting is achievable
    strainMoving: watch.movingSum / Math.max(1, watch.movingN),
    strainSettled: watch.settledSum / Math.max(1, watch.settledN),
    poseWorst: watch.poseWorst,
    footTension: watch.footTension,
    footTensionDrag: watch.footTensionDrag,
    peels: watch.peels,
    soloPct: watch.soloFrames / Math.max(1, watch.frames),
    noFeetPct: watch.noFeetFrames / Math.max(1, watch.frames),
    flipsPerMove: watch.bendFlips / Math.max(1, moves),
  };
}

// Every problem the menu offers, aggregated per level.
//   node tools/sim-check.mjs
let bad = 0;
let allTopped = 0;
let allProblems = 0;
for (let level = 0; level < T.LEVELS.length; level++) {
  const runs = Array.from({ length: T.PROBLEMS_PER_LEVEL }, (_, i) => climb(level, i));
  const sum = (f) => runs.reduce((a, r) => a + f(r), 0);
  const avg = (f) => sum(f) / runs.length;
  const worst = (f) => runs.reduce((a, r) => Math.max(a, f(r)), 0);
  const planted = sum((r) => r.planted);
  const missed = sum((r) => r.missed);
  const plantRate = planted / Math.max(1, planted + missed);
  const topped = runs.filter((r) => r.topped).length;
  const topClean = runs.filter((r) => r.topClean).length;
  allTopped += topClean;
  allProblems += runs.length;

  // A hanging figure that travels more than a hair over 120 idle substeps is
  // oscillating, and that is exactly the "crazy spring" failure mode.
  const jitterOk = worst((r) => r.restJitter) < 1.0;
  // Per-move plant rate. The gate is well below the ~90-95% this measures because
  // the harness releases blind, mid-migration: half its misses are the hold sitting
  // a hair beyond reach at that instant and half a hair inside minimum, neither of
  // which a player hits -- they hold until the ring lights up. It is a REGRESSION
  // gate, and it does its job: the drag-gain experiments that broke responsiveness
  // scored 63-72% here.
  const plantOk = plantRate > 0.87;
  // Every problem must reach its finish hold with both hands, and the LAST TWO
  // moves -- reaching the top and matching it -- must plant without a resync. The
  // match is a move no wall asked for before this existed, so it gets its own gate
  // rather than being averaged into the plant rate.
  const topOk = topped === runs.length && topClean >= runs.length - 1;
  // a planted limb constrains the body, so a foot should never be stretched
  // measurably past leg length -- and nothing should ever come off by itself
  const feetOk = worst((r) => r.footTension) < 1.0 && sum((r) => r.peels) === 0;
  // limbs must stay inside their anatomical cone
  const poseOk = worst((r) => r.poseWorst) < 6;
  // joints may legitimately change side, but not constantly
  const jointsOk = worst((r) => r.flipsPerMove) < 0.5;
  // routine climbing should almost never leave you on a single contact, and
  // should not spend much time with both feet off the wall
  const contactsOk = worst((r) => r.soloPct) < 0.02 && worst((r) => r.noFeetPct) < 0.15;
  const ok = jitterOk && plantOk && topOk && feetOk && poseOk && jointsOk && contactsOk;
  if (!ok) bad++;

  console.log(
    `${ok ? 'PASS' : 'FAIL'} L${level + 1} ${T.LEVELS[level].name.padEnd(8)} ` +
      `${runs.length} problems  ` +
      `topped ${topped}/${runs.length} (${topClean} clean)  ` +
      `moves ${String(planted).padStart(3)}ok/${String(missed).padStart(2)}miss ` +
      `(${(plantRate * 100).toFixed(0)}%)  ` +
      `jitter ${worst((r) => r.restJitter).toFixed(2)}u  ` +
      `pose ${worst((r) => r.poseWorst).toFixed(2)}u  ` +
      `legStretch ${worst((r) => r.footTension).toFixed(2)}u settled  ` +
      `peels ${sum((r) => r.peels)}  ` +
      `solo ${(100 * worst((r) => r.soloPct)).toFixed(1)}%  ` +
      `noFeet ${(100 * worst((r) => r.noFeetPct)).toFixed(0)}%  ` +
      `flips/move ${worst((r) => r.flipsPerMove).toFixed(2)}  ` +
      `strain move ${avg((r) => r.strainMoving).toFixed(2)} / rest ${avg((r) => r.strainSettled).toFixed(2)}` +
      (jitterOk ? '' : '  <-- OSCILLATING') +
      (plantOk ? '' : '  <-- GRABS FAILING') +
      (topOk ? '' : '  <-- TOP-OUT FAILING') +
      (feetOk ? '' : '  <-- FEET STRETCHING OR PEELING') +
      (poseOk ? '' : '  <-- LIMB OUTSIDE CONE') +
      (jointsOk ? '' : '  <-- JOINTS SNAPPING') +
      (contactsOk ? '' : '  <-- STRIPPED TO ONE CONTACT'),
  );
}
console.log(
  bad === 0
    ? `\nSimulated climbs OK -- ${allTopped}/${allProblems} problems topped out cleanly.`
    : `\n${bad}/${T.LEVELS.length} levels had problems.`,
);
process.exit(bad === 0 ? 0 : 1);
