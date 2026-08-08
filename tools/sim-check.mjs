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
import { createFigure, stepFigure, canReach } from '../src/body.js';
import { createStamina, updateStamina } from '../src/stamina.js';

const DRAG_STEPS = 22; // substeps spent moving a limb to its target
const SETTLE_STEPS = 18;

const step = (fig, stam, n) => {
  for (let i = 0; i < n; i++) {
    stepFigure(fig, T.SUB_DT);
    updateStamina(stam, fig, T.SUB_DT);
  }
};

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
function attemptMove(fig, stam, wall, limb, target) {
  const from = { x: limb.pos.x, y: limb.pos.y };
  const previous = limb.hold;

  limb.hold = null;
  limb.drag = { pointerId: 0, target: { ...from } };
  for (let i = 1; i <= DRAG_STEPS; i++) {
    const t = i / DRAG_STEPS;
    limb.drag.target.x = from.x + (target.x - from.x) * t;
    limb.drag.target.y = from.y + (target.y - from.y) * t;
    stepFigure(fig, T.SUB_DT);
    updateStamina(stam, fig, T.SUB_DT);
  }
  limb.drag = null;

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
  void previous;
  step(fig, stam, SETTLE_STEPS);
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
function climb(seed, maxMoves = 400) {
  const wall = generateWall(seed);
  const fig = createFigure(wall.start);
  const stam = createStamina();
  step(fig, stam, 60);

  const restJitter = measureJitter(fig, stam);

  const route = wall.holds.filter((h) => h.route).slice(4);
  let planted = 0;
  let missed = 0;
  let minStamina = 1;
  let maxStrain = 0;

  for (const target of route.slice(0, maxMoves)) {
    const limb = fig.limbs[target.limb];
    if (attemptMove(fig, stam, wall, limb, target)) planted++;
    else missed++;

    minStamina = Math.min(minStamina, stam.value);
    maxStrain = Math.max(maxStrain, stam.smooth);
    if (stam.value <= 0) break;
  }

  return {
    seed,
    height: -fig.hip.y,
    planted,
    missed,
    plantRate: planted / Math.max(1, planted + missed),
    restJitter,
    minStamina,
    maxStrain,
    finalStamina: stam.value,
  };
}

const seeds = [T.SEED, 1000, 8919, 24757];
let bad = 0;
for (const seed of seeds) {
  const r = climb(seed);
  // A hanging figure that travels more than a hair over 120 idle substeps is
  // oscillating, and that is exactly the "crazy spring" failure mode.
  const jitterOk = r.restJitter < 1.0;
  const plantOk = r.plantRate > 0.9;
  if (!jitterOk || !plantOk) bad++;
  console.log(
    `${jitterOk && plantOk ? 'PASS' : 'FAIL'} seed ${String(r.seed).padStart(9)}  ` +
      `climbed ${r.height.toFixed(0).padStart(5)}u  ` +
      `moves ${String(r.planted).padStart(3)}ok/${String(r.missed).padStart(2)}miss ` +
      `(${(r.plantRate * 100).toFixed(0)}%)  ` +
      `restJitter ${r.restJitter.toFixed(3)}u  ` +
      `stamina min ${r.minStamina.toFixed(2)} end ${r.finalStamina.toFixed(2)}  ` +
      `peakStrain ${r.maxStrain.toFixed(2)}` +
      (jitterOk ? '' : '  <-- OSCILLATING') +
      (plantOk ? '' : '  <-- GRABS FAILING'),
  );
}
console.log(bad === 0 ? '\nSimulated climbs OK.' : `\n${bad}/${seeds.length} runs had problems.`);
process.exit(bad === 0 ? 0 : 1);
