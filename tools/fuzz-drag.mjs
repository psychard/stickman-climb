/**
 * Adversarial drag fuzzer. Run with `npm run fuzz`.
 *
 * `sim` drags one limb at a time to targets the generator already proved
 * feasible, which is how a cooperative player behaves. This does the opposite:
 * it grabs up to three limbs at once and hauls them to arbitrary points, far
 * out of reach, in conflicting directions -- what a player does when poking at
 * the toy. That regime was completely unmeasured, and it turns out to reach body
 * configurations the settled invariants never see.
 *
 * It asserts the things that must hold no matter what the pointer does:
 *
 *   stretch  a planted limb is a strut -- its hold cannot be further from the
 *            socket than the limb is long. Note the renderer draws a planted
 *            limb straight to its hold, so any violation here is visible as a
 *            rubber limb.
 *   torso    hip->chest keeps its length, and does not invert. Everything
 *            derived from the torso frame (sockets, pose cones) is mirrored if
 *            the chest passes under the hip, so the anatomy limits stop meaning
 *            anything at all.
 *   pose     limbs stay inside their anatomical cones.
 *
 * Failures print a seed; pass it as the second argument to replay just that case.
 */

import { T } from '../src/tuning.js';
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
  LIMB_IDS,
} from '../src/body.js';
import { createStamina, updateStamina } from '../src/stamina.js';
import { makeRng } from '../src/rng.js';
import { dayArg } from '../src/day.js';

const SETTLE_LEAD = 45; // substeps allowed for the body to recover before judging
const SETTLE_JUDGED = 30; // substeps that actually count as "settled"

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const rounds = Number(args[0] || 300);
const onlySeed = args[1] ? Number(args[1]) : null;
// Pinned, and it has to be: a failure prints its seed so the case can be replayed,
// and a replay against a wall that changed overnight replays something else. `--day=`
// moves it for both the run and the replay.
const DAY = dayArg(process.argv, T.REF_DAY);

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

/** Mirrors game.js's `supported`: no hand planted means the feet must do it alone. */
function supported(fig) {
  const planted = LIMB_IDS.map((id) => fig.limbs[id]).filter((l) => l.hold);
  if (!planted.length) return true; // handled by the "nothing planted" check below
  if (planted.some((l) => l.kind === 'hand')) return true;
  const pts = {};
  for (const l of planted) pts[l.id] = l.hold;
  return stanceSolvable(pts);
}

function worstOf(fig) {
  const out = { stretch: 0, torso: 0, invert: 0, pose: 0 };
  const frame = torsoFrame(fig.hip, fig.chest);
  // uy is the hip->chest direction; upright is -1, so anything >= 0 is inverted
  out.invert = Math.max(0, frame.uy);
  out.torso = Math.abs(Math.hypot(fig.chest.x - fig.hip.x, fig.chest.y - fig.hip.y) - T.TORSO_LEN);
  for (const id of LIMB_IDS) {
    const limb = fig.limbs[id];
    if (limb.hold && !limb.drag) {
      const a = anchorOf(fig.hip, fig.chest, limb);
      const d = Math.hypot(limb.hold.x - a.x, limb.hold.y - a.y);
      out.stretch = Math.max(out.stretch, d - specFor(limb.kind).max);
    }
    const pt = limb.hold || (limb.drag ? limb.pos : null);
    if (pt) out.pose = Math.max(out.pose, poseViolation(fig.hip, fig.chest, limb, pt));
  }
  return out;
}

/**
 * One fuzz run: a sequence of multi-limb drags to arbitrary points.
 *
 * Violations are tracked separately while a pointer is hauling and once the
 * stance has settled, the same distinction sim makes for leg stretch. Give under
 * load is the intended feel and a body mid-yank is allowed to look strained; a
 * figure left bent into an impossible shape after you let go is the bug.
 */
function fuzz(seed, wall, moves = 40) {
  const rng = makeRng(seed);
  const fig = createFigure(wall.start);
  const stam = createStamina();
  let hauling = false;
  let lost = false;
  const step = (n) => {
    for (let i = 0; i < n; i++) {
      stepFigure(fig, T.SUB_DT);
      updateStamina(stam, fig, T.SUB_DT);
      // Stop measuring once the game would have dropped you. A violation this bad
      // for this long is a stance no body can hold -- typically both hands gone and
      // the body hanging from two feet, which POSE.FOOT_RISE forbids outright -- and
      // game.js falls on it (T.FALL_VIOLATION). The shape is real and it IS ugly,
      // which is why the game ends the attempt rather than drawing it; recording it
      // past that point measures a state no player sees.
      if (fig.lostFor > T.FALL_VIOLATION_TIME) {
        lost = true;
        return;
      }
      const w = worstOf(fig);
      const into = hauling ? worst.pulling : worst; // 'recovering' also counts as pulling
      for (const k in w) if (w[k] > into[k]) into[k] = w[k];
    }
  };
  const worst = {
    stretch: 0,
    torso: 0,
    invert: 0,
    pose: 0,
    pulling: { stretch: 0, torso: 0, invert: 0, pose: 0 },
  };
  step(60);

  for (let m = 0; m < moves; m++) {
    // grab 1..3 limbs at once; all four would be a fall in the real game
    const ids = [...LIMB_IDS].sort(() => rng() - 0.5).slice(0, 1 + Math.floor(rng() * 3));
    const dragged = [];
    for (const id of ids) {
      const limb = fig.limbs[id];
      limb.hold = null; // starting a drag unplants, exactly as game.js does
      limb.drag = { pointerId: dragged.length, target: { x: limb.pos.x, y: limb.pos.y } };
      // somewhere absurd: up to ~3x max reach away, any direction
      const ang = rng() * Math.PI * 2;
      const far = specFor(limb.kind).max * (0.5 + rng() * 2.5);
      dragged.push({
        limb,
        from: { x: limb.pos.x, y: limb.pos.y },
        to: { x: limb.pos.x + Math.cos(ang) * far, y: limb.pos.y + Math.sin(ang) * far },
      });
    }

    const steps = 10 + Math.floor(rng() * 30);
    hauling = true;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      for (const d of dragged) {
        d.limb.drag.target.x = d.from.x + (d.to.x - d.from.x) * t;
        d.limb.drag.target.y = d.from.y + (d.to.y - d.from.y) * t;
      }
      step(1);
    }

    hauling = 'recovering';
    // release: plant whatever is actually in range, like pointerUp
    for (const d of dragged) {
      d.limb.drag = null;
      for (const hold of holdsNear(wall, d.limb.pos, T.SNAP_RADIUS)) {
        if (canReach(fig, d.limb, hold) && stanceSolvable(stanceWith(fig, d.limb, hold))) {
          d.limb.hold = hold;
          break;
        }
      }
    }
    // Mirror game.js: with no hand on the wall, the feet have to hold you by
    // themselves, and two footholds a body-width apart cannot. The game falls right
    // there, so the run is over -- measuring the shape the solver draws for an
    // impossible stance would be measuring something no player is left looking at.
    if (!supported(fig)) return worst;

    step(SETTLE_LEAD); // recovery from a wedge is allowed to take a moment...
    hauling = false;
    step(SETTLE_JUDGED); // ...but by here the figure must be legal again
    if (lost) return worst; // the game dropped you; the run is over

    // a real game would have ended here; re-plant so the run keeps exploring
    if (!LIMB_IDS.some((id) => fig.limbs[id].hold)) return worst;
  }
  return worst;
}

// Any problem serves as scenery -- the fuzzer hauls limbs to arbitrary points and
// mostly misses the holds entirely. Level 3's first problem is a middling wall.
const wall = generateProblem(2, 0, DAY);
const seeds = onlySeed !== null ? [onlySeed] : Array.from({ length: rounds }, (_, i) => 9000 + i * 13);

const agg = { stretch: 0, torso: 0, invert: 0, pose: 0 };
const aggPull = { stretch: 0, torso: 0, invert: 0, pose: 0 };
const blame = {};
let bad = 0;
for (const seed of seeds) {
  const w = fuzz(seed, wall);
  const fails = [];
  if (w.stretch > 2) fails.push(`stretch ${w.stretch.toFixed(1)}u`);
  if (w.torso > 1) fails.push(`torso ${w.torso.toFixed(1)}u`);
  if (w.invert > 0) fails.push('INVERTED TORSO');
  if (w.pose > 8) fails.push(`pose ${w.pose.toFixed(1)}u`);
  for (const k in agg) {
    if (w[k] > agg[k]) {
      agg[k] = w[k];
      blame[k] = seed;
    }
    if (w.pulling[k] > aggPull[k]) aggPull[k] = w.pulling[k];
  }
  if (fails.length) {
    bad++;
    if (bad <= 8) console.log(`  seed ${seed}: ${fails.join('  ')}`);
  }
}

console.log(
  `\n${seeds.length} runs, ${bad} settled with problems\n` +
    `                 settled        while hauling\n` +
    `  stretch  ${agg.stretch.toFixed(1).padStart(8)}u      ${aggPull.stretch.toFixed(1).padStart(6)}u   (seed ${blame.stretch})\n` +
    `  torso    ${agg.torso.toFixed(1).padStart(8)}u      ${aggPull.torso.toFixed(1).padStart(6)}u\n` +
    `  invert   ${agg.invert.toFixed(2).padStart(8)}       ${aggPull.invert.toFixed(2).padStart(6)}\n` +
    `  pose     ${agg.pose.toFixed(1).padStart(8)}u      ${aggPull.pose.toFixed(1).padStart(6)}u   (seed ${blame.pose})`,
);
process.exit(bad === 0 ? 0 : 1);
