/**
 * The figure and its constraint solver.
 *
 * The body is just two points -- `hip` and `chest` -- held apart by a fixed
 * torso length. Everything else (shoulder positions, hip sockets) is derived
 * from those two points, so the torso leaning and rotating falls out for free.
 *
 * Each frame we integrate gravity onto those two points, then relax a small set
 * of positional constraints (Gauss-Seidel, so later constraints win):
 *
 *   1. dragged limbs PULL the body toward the pointer (soft -- this is the lunge)
 *   2. planted feet PUSH the body up off their hold (legs are struts)
 *   3. planted limbs HARD CLAMP the body inside their reach envelope (tethers)
 *   4. the torso keeps its length
 *   5. a weak bias keeps the chest above the hip
 *
 * A dragged limb never stretches past its max reach: the pointer pulls the body,
 * and if the body can't get there the grab just fails.
 */

import { T, clamp } from './tuning.js';

export const LIMB_IDS = ['LH', 'RH', 'LF', 'RF'];

export const LIMB_DEFS = {
  LH: { kind: 'hand', side: -1, name: 'left hand' },
  RH: { kind: 'hand', side: 1, name: 'right hand' },
  LF: { kind: 'foot', side: -1, name: 'left foot' },
  RF: { kind: 'foot', side: 1, name: 'right foot' },
};

export const specFor = (kind) => (kind === 'hand' ? T.ARM : T.LEG);

// --------------------------------------------------------------------------
// construction
// --------------------------------------------------------------------------

export function createFigure(stance) {
  const fig = {
    hip: { x: 0, y: 0 },
    chest: { x: 0, y: 0 },
    hipV: { x: 0, y: 0 },
    chestV: { x: 0, y: 0 },
    limbs: {},
    falling: false,
  };
  for (const id of LIMB_IDS) {
    const def = LIMB_DEFS[id];
    fig.limbs[id] = {
      id,
      kind: def.kind,
      side: def.side,
      hold: null, // the hold object this limb is planted on, or null
      pos: { x: 0, y: 0 }, // rendered endpoint
      drag: null, // { pointerId, target:{x,y} } while being dragged
    };
  }
  resetToStance(fig, stance);
  return fig;
}

/** Snap the figure onto a 4-hold stance and settle it there. */
export function resetToStance(fig, stance) {
  for (const id of LIMB_IDS) {
    const limb = fig.limbs[id];
    limb.hold = stance[id] || null;
    limb.drag = null;
    if (limb.hold) limb.pos = { x: limb.hold.x, y: limb.hold.y };
  }
  fig.falling = false;
  fig.hipV = { x: 0, y: 0 };
  fig.chestV = { x: 0, y: 0 };

  const pts = {};
  for (const id of LIMB_IDS) pts[id] = fig.limbs[id].hold;
  const solved = solveStatic(pts);
  fig.hip = { x: solved.hip.x, y: solved.hip.y };
  fig.chest = { x: solved.chest.x, y: solved.chest.y };
  for (const id of LIMB_IDS) {
    const limb = fig.limbs[id];
    if (!limb.hold) limb.pos = dangleTarget(fig, limb);
  }
}

// --------------------------------------------------------------------------
// derived geometry
// --------------------------------------------------------------------------

/** Torso frame: `up` points hip->chest, `right` is its perpendicular. */
export function torsoFrame(hip, chest) {
  let ux = chest.x - hip.x;
  let uy = chest.y - hip.y;
  const len = Math.hypot(ux, uy) || 1;
  ux /= len;
  uy /= len;
  // perp(u); with the figure upright (u = 0,-1) this points +x, i.e. screen right
  return { ux, uy, rx: -uy, ry: ux };
}

/** Where a limb attaches to the body, in world space. */
export function anchorOf(hip, chest, limb) {
  const f = torsoFrame(hip, chest);
  const base = limb.kind === 'hand' ? chest : hip;
  const half = (limb.kind === 'hand' ? T.SHOULDER_HALF : T.HIP_HALF) * limb.side;
  return { x: base.x + f.rx * half, y: base.y + f.ry * half };
}

export function centerOfMass(fig) {
  let x = fig.hip.x * 0.4 + fig.chest.x * 0.3;
  let y = fig.hip.y * 0.4 + fig.chest.y * 0.3;
  for (const id of LIMB_IDS) {
    x += fig.limbs[id].pos.x * 0.075;
    y += fig.limbs[id].pos.y * 0.075;
  }
  return { x, y };
}

export function plantedLimbs(fig) {
  return LIMB_IDS.map((id) => fig.limbs[id]).filter((l) => l.hold && !l.drag);
}

/** Where an unplanted limb hangs when nothing is holding it. */
function dangleTarget(fig, limb) {
  const a = anchorOf(fig.hip, fig.chest, limb);
  const spec = specFor(limb.kind);
  return { x: a.x + limb.side * 9, y: a.y + spec.pref * 0.9 };
}

/**
 * Bounded elasticity: identical to `d` inside max reach, then asymptotically
 * approaches max + REACH_STRETCH. You feel the limit instead of hitting a wall.
 */
export function softReach(d, max) {
  if (d <= max) return d;
  const s = T.REACH_STRETCH;
  return max + s * (1 - Math.exp(-(d - max) / s));
}

// --------------------------------------------------------------------------
// the solver
// --------------------------------------------------------------------------

/** Move a limb's anchor by (dx,dy), distributing it across hip and chest. */
function pushAnchor(state, limb, dx, dy) {
  const near = T.ANCHOR_SPLIT_NEAR;
  const far = 1 - near;
  if (limb.kind === 'hand') {
    state.chest.x += dx * near;
    state.chest.y += dy * near;
    state.hip.x += dx * far;
    state.hip.y += dy * far;
  } else {
    state.hip.x += dx * near;
    state.hip.y += dy * near;
    state.chest.x += dx * far;
    state.chest.y += dy * far;
  }
}

function enforceTorso(state) {
  const dx = state.chest.x - state.hip.x;
  const dy = state.chest.y - state.hip.y;
  const d = Math.hypot(dx, dy) || 1e-6;
  const corr = (d - T.TORSO_LEN) / d / 2;
  state.hip.x += dx * corr;
  state.hip.y += dy * corr;
  state.chest.x -= dx * corr;
  state.chest.y -= dy * corr;
}

/** One relaxation pass over all constraints. Mutates state.hip / state.chest. */
function relaxOnce(state, limbs) {
  // 1. dragged limbs pull the body (the lunge)
  for (const limb of limbs) {
    if (!limb.drag) continue;
    const a = anchorOf(state.hip, state.chest, limb);
    const spec = specFor(limb.kind);
    const dx = limb.drag.target.x - a.x;
    const dy = limb.drag.target.y - a.y;
    const d = Math.hypot(dx, dy);
    if (d > spec.pref && d > 1e-6) {
      const move = (d - spec.pref) * T.DRAG_PULL;
      pushAnchor(state, limb, (dx / d) * move, (dy / d) * move);
    }
  }

  // 2. planted feet push the body up off the hold (one-sided: legs press, they
  //    never pull you back down)
  for (const limb of limbs) {
    if (!limb.hold || limb.drag || limb.kind !== 'foot') continue;
    const a = anchorOf(state.hip, state.chest, limb);
    const spec = specFor(limb.kind);
    const dx = limb.hold.x - a.x;
    const dy = limb.hold.y - a.y;
    const d = Math.hypot(dx, dy) || 1e-6;
    if (d < spec.pref) {
      const move = (d - spec.pref) * T.FOOT_PUSH_STIFF; // negative => push away
      pushAnchor(state, limb, (dx / d) * move, (dy / d) * move);
    }
  }

  // 3. planted limbs hard-clamp the body inside their reach envelope
  for (const limb of limbs) {
    if (!limb.hold || limb.drag) continue;
    const a = anchorOf(state.hip, state.chest, limb);
    const spec = specFor(limb.kind);
    const dx = limb.hold.x - a.x;
    const dy = limb.hold.y - a.y;
    const d = Math.hypot(dx, dy) || 1e-6;
    let move = 0;
    if (d > spec.max) move = (d - spec.max) * T.CLAMP_STIFF;
    else if (d < spec.min) move = (d - spec.min) * T.CLAMP_STIFF;
    if (move !== 0) pushAnchor(state, limb, (dx / d) * move, (dy / d) * move);
  }

  // 4. torso keeps its length
  enforceTorso(state);

  // 5. weak upright bias so the figure reads as a person, not a ragdoll
  {
    const tx = state.hip.x;
    const ty = state.hip.y - T.TORSO_LEN;
    state.chest.x += (tx - state.chest.x) * T.UPRIGHT_STIFF;
    state.chest.y += (ty - state.chest.y) * T.UPRIGHT_STIFF;
  }
}

/** Advance the figure by one fixed substep. */
export function stepFigure(fig, dt) {
  const limbs = LIMB_IDS.map((id) => fig.limbs[id]);

  if (fig.falling) {
    // off the wall: real ballistic dynamics, torso length still enforced
    fig.hipV.y += T.GRAVITY * dt;
    fig.chestV.y += T.GRAVITY * dt;
    fig.hip.x += fig.hipV.x * dt;
    fig.hip.y += fig.hipV.y * dt;
    fig.chest.x += fig.chestV.x * dt;
    fig.chest.y += fig.chestV.y * dt;
    enforceTorso(fig);
    placeEndpoints(fig, limbs);
    return;
  }

  const prevHip = { x: fig.hip.x, y: fig.hip.y };
  const prevChest = { x: fig.chest.x, y: fig.chest.y };

  // carried momentum, heavily damped -- this is what gives the body weight
  const damp = Math.pow(T.DAMPING, dt * 120);
  fig.hipV.x *= damp;
  fig.hipV.y *= damp;
  fig.chestV.x *= damp;
  fig.chestV.y *= damp;
  fig.hip.x += fig.hipV.x * dt;
  fig.hip.y += fig.hipV.y * dt;
  fig.chest.x += fig.chestV.x * dt;
  fig.chest.y += fig.chestV.y * dt;

  // gravity as positional sag, not acceleration (see GRAVITY_SAG in tuning.js)
  const sag = T.GRAVITY_SAG * dt;
  fig.hip.y += sag;
  fig.chest.y += sag;

  for (let i = 0; i < T.ITERATIONS; i++) relaxOnce(fig, limbs);

  // Only a fraction of the solved motion becomes momentum. At equilibrium the
  // sag is cancelled by the tethers, the delta is ~0, and the body goes still.
  const f = T.VEL_FEEDBACK / dt;
  fig.hipV.x = (fig.hip.x - prevHip.x) * f;
  fig.hipV.y = (fig.hip.y - prevHip.y) * f;
  fig.chestV.x = (fig.chest.x - prevChest.x) * f;
  fig.chestV.y = (fig.chest.y - prevChest.y) * f;

  placeEndpoints(fig, limbs);
}

/** Position the visible limb endpoints from the solved body. */
function placeEndpoints(fig, limbs) {
  for (const limb of limbs) {
    if (limb.hold && !limb.drag) {
      limb.pos.x = limb.hold.x;
      limb.pos.y = limb.hold.y;
    } else if (limb.drag) {
      const a = anchorOf(fig.hip, fig.chest, limb);
      const spec = specFor(limb.kind);
      const dx = limb.drag.target.x - a.x;
      const dy = limb.drag.target.y - a.y;
      const d = Math.hypot(dx, dy) || 1e-6;
      const e = softReach(d, spec.max);
      limb.pos.x = a.x + (dx / d) * e;
      limb.pos.y = a.y + (dy / d) * e;
    } else {
      const t = dangleTarget(fig, limb);
      limb.pos.x += (t.x - limb.pos.x) * T.DANGLE_LERP;
      limb.pos.y += (t.y - limb.pos.y) * T.DANGLE_LERP;
    }
  }
}

/** True reach usage of a limb, 0..1+ (1 == fully extended). */
export function extensionOf(fig, limb) {
  const a = anchorOf(fig.hip, fig.chest, limb);
  const spec = specFor(limb.kind);
  const p = limb.hold || limb.pos;
  return Math.hypot(p.x - a.x, p.y - a.y) / spec.max;
}

/** Can this limb actually reach `pt` from where the body currently is? */
export function canReach(fig, limb, pt) {
  const a = anchorOf(fig.hip, fig.chest, limb);
  const spec = specFor(limb.kind);
  const d = Math.hypot(pt.x - a.x, pt.y - a.y);
  return d <= spec.max * T.PLANT_TOLERANCE && d >= spec.min * 0.55;
}

// --------------------------------------------------------------------------
// headless solve -- used by the wall generator to prove a stance is reachable
// --------------------------------------------------------------------------

/**
 * Relax a body into a stance of up to four hold positions, with no dynamics.
 * Returns the resolved hip/chest and the worst remaining reach violation, so
 * the generator can reject stances the figure physically cannot hold.
 *
 * @param {{LH?:{x,y}, RH?:{x,y}, LF?:{x,y}, RF?:{x,y}}} pts
 */
export function solveStatic(pts, iters = T.GEN_SOLVE_ITERS) {
  const limbs = [];
  for (const id of LIMB_IDS) {
    const p = pts[id];
    if (!p) continue;
    limbs.push({ ...LIMB_DEFS[id], id, hold: p, drag: null });
  }

  // seed from the hold centroids: chest below the hands, hip above the feet
  const hands = limbs.filter((l) => l.kind === 'hand');
  const feet = limbs.filter((l) => l.kind === 'foot');
  const avg = (arr, k) => arr.reduce((s, l) => s + l.hold[k], 0) / (arr.length || 1);

  let chest, hip;
  if (hands.length) {
    chest = { x: avg(hands, 'x'), y: avg(hands, 'y') + T.ARM.pref };
  }
  if (feet.length) {
    hip = { x: avg(feet, 'x'), y: avg(feet, 'y') - T.LEG.pref };
  }
  if (!chest) chest = { x: hip.x, y: hip.y - T.TORSO_LEN };
  if (!hip) hip = { x: chest.x, y: chest.y + T.TORSO_LEN };

  const state = { hip, chest };
  for (let i = 0; i < iters; i++) {
    // A downward nudge each pass settles us into the hanging equilibrium rather
    // than an arbitrary feasible point. It has to decay to zero, though: a
    // constant bias fights the clamps forever and leaves a residual violation
    // proportional to the nudge, which reads as "infeasible" when it isn't.
    const nudge = 1.2 * (1 - i / iters);
    state.hip.y += nudge;
    state.chest.y += nudge;
    relaxOnce(state, limbs);
  }

  let violation = 0;
  for (const limb of limbs) {
    const a = anchorOf(state.hip, state.chest, limb);
    const spec = specFor(limb.kind);
    const d = Math.hypot(limb.hold.x - a.x, limb.hold.y - a.y);
    violation = Math.max(violation, d - spec.max, spec.min - d);
  }
  return { hip: state.hip, chest: state.chest, violation };
}

/**
 * Is this four-point stance one the figure can actually hold? Used by the
 * generator to guarantee every wall it emits is climbable.
 */
export function stanceFeasible(pts) {
  // no crossed limbs, and hands must stay above feet -- geometrically possible
  // stances that read as absurd are still rejected
  if (pts.LH && pts.RH && pts.LH.x > pts.RH.x + T.SHOULDER_HALF) return false;
  if (pts.LF && pts.RF && pts.LF.x > pts.RF.x + T.HIP_HALF) return false;
  const lowHand = Math.max(pts.LH?.y ?? -Infinity, pts.RH?.y ?? -Infinity);
  const highFoot = Math.min(pts.LF?.y ?? Infinity, pts.RF?.y ?? Infinity);
  if (lowHand > highFoot - T.TORSO_LEN * 0.35) return false;

  const { violation } = solveStatic(pts);
  return violation <= T.GEN_TOLERANCE;
}

// --------------------------------------------------------------------------
// two-bone IK, for drawing elbows and knees
// --------------------------------------------------------------------------

/**
 * Joint position for a two-bone limb from `a` to `b`. Picks whichever of the
 * two solutions bends away from the body's midline, so elbows and knees flare
 * outward the way a climber's do.
 */
export function ikJoint(a, b, boneLen, frame, side) {
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  let d = Math.hypot(dx, dy);
  const reach = boneLen * 2;
  d = clamp(d, 1e-3, reach * 0.999);
  dx /= d || 1;
  dy /= d || 1;
  const half = d / 2;
  const h = Math.sqrt(Math.max(0, boneLen * boneLen - half * half));
  const px = -dy;
  const py = dx;
  // choose the side that lies outboard along the torso's right vector
  const sign = px * frame.rx + py * frame.ry > 0 ? side : -side;
  return {
    x: a.x + dx * half + px * h * sign,
    y: a.y + dy * half + py * h * sign,
  };
}
