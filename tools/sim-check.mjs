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
import { generateWall, holdsNear } from '../src/wall.js';
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
function attemptMove(fig, stam, wall, limb, target, watch) {
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
function climb(seed, level, maxMoves = 400) {
  const wall = generateWall(seed, level);
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

  // Running out of stamina does NOT stop the run. It used to, and that capped
  // coverage at move 44 on level 5 -- far too few moves for a 90% plant-rate
  // assertion, since a single extra miss moves it 2%, and it hid a solver wedge
  // that only appeared deeper in. This harness never rests, so pumping out is an
  // artefact of the harness rather than a mechanics failure; `pumpedAt` records
  // where it happened and `npm run ladder` is what measures survivability.
  for (const mv of route.slice(0, maxMoves)) {
    const limb = fig.limbs[mv.limb];
    if (attemptMove(fig, stam, wall, limb, mv.hold, watch)) planted++;
    else missed++;

    minStamina = Math.min(minStamina, stam.value);
    if (stam.value <= 0 && !pumpedAt) pumpedAt = planted + missed;
  }

  const moves = planted + missed;
  return {
    seed,
    level,
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

// Every level, on the seed the menu actually serves for it.
//   node tools/sim-check.mjs [maxMoves]
const maxMoves = Number(process.argv[2] || 400);
const runs = T.LEVELS.map((lvl, level) => ({ level, seed: lvl.seed }));
let bad = 0;
for (const { level, seed } of runs) {
  const r = climb(seed, level, maxMoves);
  // A hanging figure that travels more than a hair over 120 idle substeps is
  // oscillating, and that is exactly the "crazy spring" failure mode.
  const jitterOk = r.restJitter < 1.0;
  const plantOk = r.plantRate > 0.9;
  // a planted limb constrains the body, so a foot should never be stretched
  // measurably past leg length -- and nothing should ever come off by itself
  const feetOk = r.footTension < 1.0 && r.peels === 0;
  // limbs must stay inside their anatomical cone
  const poseOk = r.poseWorst < 6;
  // joints may legitimately change side, but not constantly
  const jointsOk = r.flipsPerMove < 0.5;
  // routine climbing should almost never leave you on a single contact, and
  // should not spend much time with both feet off the wall
  const contactsOk = r.soloPct < 0.02 && r.noFeetPct < 0.15;
  const ok = jitterOk && plantOk && feetOk && poseOk && jointsOk && contactsOk;
  if (!ok) bad++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'} L${level + 1} ${T.LEVELS[level].name.padEnd(8)} ` +
      `climbed ${r.height.toFixed(0).padStart(5)}u  ` +
      `moves ${String(r.planted).padStart(3)}ok/${String(r.missed).padStart(2)}miss ` +
      `(${(r.plantRate * 100).toFixed(0)}%)  ` +
      `jitter ${r.restJitter.toFixed(2)}u  ` +
      `pose ${r.poseWorst.toFixed(2)}u  ` +
      `legStretch ${r.footTension.toFixed(2)}u settled / ${r.footTensionDrag.toFixed(2)}u pulling  ` +
      `peels ${r.peels}  ` +
      `solo ${(r.soloPct * 100).toFixed(1)}%  noFeet ${(r.noFeetPct * 100).toFixed(0)}%  ` +
      `flips/move ${r.flipsPerMove.toFixed(2)}  ` +
      `pumpedAt ${r.pumpedAt ? `move ${String(r.pumpedAt).padStart(3)}` : '   never'}  ` +
      `strain move ${r.strainMoving.toFixed(2)} / rest ${r.strainSettled.toFixed(2)}` +
      (jitterOk ? '' : '  <-- OSCILLATING') +
      (plantOk ? '' : '  <-- GRABS FAILING') +
      (feetOk ? '' : '  <-- FEET STRETCHING OR PEELING') +
      (poseOk ? '' : '  <-- LIMB OUTSIDE CONE') +
      (jointsOk ? '' : '  <-- JOINTS SNAPPING') +
      (contactsOk ? '' : '  <-- STRIPPED TO ONE CONTACT'),
  );
}
console.log(bad === 0 ? '\nSimulated climbs OK.' : `\n${bad}/${runs.length} runs had problems.`);
process.exit(bad === 0 ? 0 : 1);
