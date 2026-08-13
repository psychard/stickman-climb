/**
 * The figure and its constraint solver.
 *
 * The body is just two points -- `hip` and `chest` -- held apart by a fixed
 * torso length. Everything else (shoulder positions, hip sockets) is derived
 * from those two points, so the torso leaning and rotating falls out for free.
 *
 * Each substep applies the external inputs ONCE -- gravity sag, the drag lunge,
 * and the wedge escape -- and then relaxes a small set of positional constraints
 * (Gauss-Seidel, so later constraints win):
 *
 *   1. planted feet PUSH the body up off their hold (legs are struts, one-sided)
 *   2. planted limbs CLAMP the body inside their reach envelope
 *   3. POSE CONES keep each limb anatomically plausible against the torso
 *   4. the torso keeps its length and stays within TORSO_TILT_MAX of vertical
 *   5. a weak bias keeps the chest above the hip
 *
 * ...then projectReach() enforces reach + pose + torso strictly, and finishes with
 * reach-only sweeps so the envelope genuinely gets the last word. See CLAUDE.md
 * for why the drag must not live inside the relaxation loop, why reach and pose
 * must be projected together, and why every external input has to be bounded.
 *
 * A dragged limb never stretches past its max reach: the pointer pulls the body,
 * and if the body can't get there the grab just fails. Nothing is ever peeled
 * off a hold automatically -- a planted limb limits you, and the player taps it
 * to let go. And a grab is refused outright if the resulting four-hold stance has
 * no solution (stanceSolvable), because otherwise the solver is asked for a body
 * position that does not exist and returns something visibly broken.
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
    // Worst constraint violation left standing at the END of the last substep.
    // escapeWedge triggers on this rather than re-measuring mid-substep; see there.
    violation: 0,
    // Seconds escapeWedge has spent trying to fix the CURRENT set of holds, and
    // what that set was, so a new stance gets a fresh budget. See escapeWedge.
    wedgeSpent: 0,
    wedgeHolds: [null, null, null, null],
    // Seconds the violation has been catastrophic. A stance no body can hold is not
    // a stance; the game reads this and drops you. See T.FALL_VIOLATION.
    lostFor: 0,
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
      bend: undefined, // sticky elbow/knee side, owned by ikJoint
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
  fig.violation = 0;
  fig.lostFor = 0;

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

// --------------------------------------------------------------------------
// anatomical pose limits
// --------------------------------------------------------------------------

/**
 * Decompose a socket->endpoint offset into the torso frame.
 *
 * `up` is positive toward the head, `out` is positive on the limb's own side.
 * A limb is a pure distance constraint otherwise, which is why without this a
 * foot is legal anywhere on a ring around the hip -- including above the chest.
 */
export function limbPose(hip, chest, limb, pt) {
  const f = torsoFrame(hip, chest);
  const a = anchorOf(hip, chest, limb);
  const vx = pt.x - a.x;
  const vy = pt.y - a.y;
  return {
    // f.u points hip->chest, so a positive dot means "toward the head"
    up: vx * f.ux + vy * f.uy,
    out: (vx * f.rx + vy * f.ry) * limb.side,
  };
}

/**
 * Project a point into the limb's anatomical cone. Used on the dragged endpoint
 * so you cannot even visually put a foot above your own chest.
 * (u, r) is orthonormal, so the offset rebuilds as up*u + out*side*r.
 */
export function clampToPose(hip, chest, limb, pt) {
  const f = torsoFrame(hip, chest);
  const a = anchorOf(hip, chest, limb);
  const P = T.POSE;
  let { up, out } = limbPose(hip, chest, limb, pt);
  if (limb.kind === 'foot') up = Math.min(up, P.FOOT_RISE);
  else up = Math.max(up, -P.HAND_DROP);
  out = Math.max(out, -(limb.kind === 'foot' ? P.FOOT_CROSS : P.HAND_CROSS));
  const o = out * limb.side;
  return { x: a.x + f.ux * up + f.rx * o, y: a.y + f.uy * up + f.ry * o };
}

/** World-space anchor correction that brings a limb back inside its cone. */
function poseCorrection(state, limb, pt) {
  const f = torsoFrame(state.hip, state.chest);
  const P = T.POSE;
  const { up, out } = limbPose(state.hip, state.chest, limb, pt);
  let cx = 0;
  let cy = 0;

  // Moving the anchor along +u reduces `up` by the same amount, and along
  // -r*side increases `out`.
  if (limb.kind === 'foot') {
    const over = up - P.FOOT_RISE; // foot climbing above hip level
    if (over > 0) {
      cx += f.ux * over;
      cy += f.uy * over;
    }
  } else {
    const under = -up - P.HAND_DROP; // hand dropped below hip level
    if (under > 0) {
      cx -= f.ux * under;
      cy -= f.uy * under;
    }
  }
  const cross = -out - (limb.kind === 'foot' ? P.FOOT_CROSS : P.HAND_CROSS);
  if (cross > 0) {
    cx -= f.rx * limb.side * cross;
    cy -= f.ry * limb.side * cross;
  }
  return { x: cx, y: cy };
}

/** How far outside its anatomical cone a limb pose is, in world units (0 = fine). */
export function poseViolation(hip, chest, limb, pt) {
  const { up, out } = limbPose(hip, chest, limb, pt);
  const P = T.POSE;
  const riseCap = limb.kind === 'foot' ? P.FOOT_RISE : Infinity;
  const dropCap = limb.kind === 'foot' ? Infinity : P.HAND_DROP;
  const crossCap = limb.kind === 'foot' ? P.FOOT_CROSS : P.HAND_CROSS;
  return Math.max(
    0,
    up - riseCap, // foot lifted above hip level / hand above nothing
    -up - dropCap, // hand dropped below hip level
    -out - crossCap, // limb reaching too far across the body
  );
}

export const poseOk = (hip, chest, limb, pt) => poseViolation(hip, chest, limb, pt) < 1;

/**
 * Worst constraint violation of a body sitting on a set of holds, world units.
 *
 * The same measure `solveStatic` reports, so the two are comparable -- which is
 * the whole basis of the wedge escape: "is the global answer better than the one
 * we are sitting in?" is only a meaningful question if both are scored the same
 * way. Dragged limbs are excluded: a limb being hauled is *supposed* to be
 * somewhere its socket can't reach.
 */
export function bodyViolation(state, limbs) {
  let worst = 0;
  for (const limb of limbs) {
    if (!limb.hold || limb.drag) continue;
    const a = anchorOf(state.hip, state.chest, limb);
    const spec = specFor(limb.kind);
    const d = Math.hypot(limb.hold.x - a.x, limb.hold.y - a.y);
    worst = Math.max(
      worst,
      d - spec.max,
      spec.min - d,
      poseViolation(state.hip, state.chest, limb, limb.hold),
    );
  }
  return worst;
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

/**
 * The point the pose cone should be measured against.
 *
 * For a planted limb that's the hold. For a dragged one it is NOT the raw pointer
 * position: the correction is proportional to how far outside the cone the point
 * sits, so a pointer flung 300u across the wall shoves the body by 300u at full
 * strength, every pass, and the reach clamps cannot win against it. The direction
 * is what carries the intent -- pointing across your body should still rotate the
 * torso -- so keep that and limit the distance to somewhere the limb could
 * plausibly reach.
 */
function poseTarget(state, limb) {
  if (!limb.drag) return limb.hold;
  const a = anchorOf(state.hip, state.chest, limb);
  const spec = specFor(limb.kind);
  const dx = limb.drag.target.x - a.x;
  const dy = limb.drag.target.y - a.y;
  const d = Math.hypot(dx, dy);
  const cap = spec.max + T.REACH_STRETCH;
  if (d <= cap || d < 1e-6) return limb.drag.target;
  return { x: a.x + (dx / d) * cap, y: a.y + (dy / d) * cap };
}

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

/**
 * Strict projection of the planted limbs' reach envelopes, run after the soft
 * relaxation has finished.
 *
 * Inside relaxOnce the drag pull and the reach clamps fight each other every
 * pass and settle at whatever stretch balances them -- measured at 8 units of
 * over-extended leg, regardless of how long the drag lasts, because it's an
 * equilibrium rather than a transient. The torso and pose passes that follow the
 * clamps then undo part of the correction as well.
 *
 * So the envelope gets the last word. This is what makes a planted limb actually
 * limit the body: reaching too far stops, instead of stretching.
 */
function projectReach(state, limbs, passes = T.PROJECT_PASSES) {
  for (let i = 0; i < passes; i++) {
    for (const limb of limbs) {
      if (!limb.hold || limb.drag) continue;
      const a = anchorOf(state.hip, state.chest, limb);
      const spec = specFor(limb.kind);
      const dx = limb.hold.x - a.x;
      const dy = limb.hold.y - a.y;
      const d = Math.hypot(dx, dy) || 1e-6;
      let move = 0;
      if (d > spec.max) move = d - spec.max;
      else if (d < spec.min) move = d - spec.min;
      if (move !== 0) pushAnchor(state, limb, (dx / d) * move, (dy / d) * move);
    }
    // Pose has to be projected alongside reach, not left to the soft pass.
    // Enforcing reach on its own can shove the body back out of a limb's cone,
    // and the two then trade the violation back and forth forever -- measured as
    // a settled 10.7u pose violation that was completely independent of how hard
    // the drag was pulling.
    for (const limb of limbs) {
      const pt = poseTarget(state, limb);
      if (!pt) continue;
      const c = poseCorrection(state, limb, pt);
      if (c.x !== 0 || c.y !== 0) pushAnchor(state, limb, c.x, c.y);
    }
    enforceTorso(state);
    enforceTilt(state);
  }

  // ...and then reach genuinely gets the last word. Every pass above ends with
  // pose, torso and tilt, all of which move the body AFTER the clamps ran, so the
  // loop alone can leave a planted limb over-stretched however many passes it
  // gets -- which is a rubber limb, drawn straight from socket to hold. These
  // final sweeps re-close the envelope with only the torso kept valid alongside
  // it. Pose has already had its passes; over-stretch is the violation that reads
  // as the game being broken, so it wins the tie.
  for (let i = 0; i < T.REACH_FINAL_PASSES; i++) {
    for (const limb of limbs) {
      if (!limb.hold || limb.drag) continue;
      const a = anchorOf(state.hip, state.chest, limb);
      const spec = specFor(limb.kind);
      const dx = limb.hold.x - a.x;
      const dy = limb.hold.y - a.y;
      const d = Math.hypot(dx, dy) || 1e-6;
      if (d > spec.max) {
        const move = d - spec.max;
        pushAnchor(state, limb, (dx / d) * move, (dy / d) * move);
      }
    }
    enforceTorso(state);
    enforceTilt(state);
  }
}

/**
 * Keep the torso within TORSO_TILT_MAX of vertical, rotating about its midpoint
 * so the body doesn't translate.
 *
 * This is a hard constraint and not decoration. The pose cones are defined in the
 * torso frame, so if the chest passes under the hip every anatomical limit
 * mirrors: a foot "below the hip" in torso space is above it in the world, and
 * the cones start actively holding the figure in impossible shapes instead of out
 * of them. UPRIGHT_STIFF is a 0.012 bias and a hard drag overwhelms it easily.
 * Only used on the wall -- a falling figure is free to tumble.
 */
function enforceTilt(state) {
  const dx = state.chest.x - state.hip.x;
  const dy = state.chest.y - state.hip.y;
  const len = Math.hypot(dx, dy) || 1e-6;
  const maxTilt = (T.TORSO_TILT_MAX * Math.PI) / 180;
  // signed angle of hip->chest away from straight up; y grows downward
  const ang = Math.atan2(dx, -dy);
  if (Math.abs(ang) <= maxTilt) return;
  const a = clamp(ang, -maxTilt, maxTilt);
  const mx = (state.hip.x + state.chest.x) / 2;
  const my = (state.hip.y + state.chest.y) / 2;
  const hx = (Math.sin(a) * len) / 2;
  const hy = (-Math.cos(a) * len) / 2;
  state.hip.x = mx - hx;
  state.hip.y = my - hy;
  state.chest.x = mx + hx;
  state.chest.y = my + hy;
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

/**
 * The lunge: dragged limbs pull the body toward the pointer.
 *
 * Applied ONCE per substep, as an external displacement alongside gravity --
 * NOT inside the relaxation loop. A soft constraint re-applied on every
 * iteration always beats a hard one it opposes: the drag kept re-injecting the
 * violation that the reach clamps were trying to remove, and the two settled at
 * a permanent ~8 units of over-extended leg. Applying it once and then letting
 * the constraints project it is what makes a planted limb genuinely limit you.
 *
 * Only the shortfall past LUNGE_START moves the body: reaching for something the
 * limb can comfortably touch must not haul the body along. And the upward component
 * is damped separately -- leaning sideways is nearly free, hauling yourself
 * upward is muscular work.
 *
 * HOW DEEP THE PULL AIMS DEPENDS ON WHETHER THE POINTER IS MOVING, and that is what
 * reconciles the two things the lunge has to do.
 *
 * A pull that aims deeper than the threshold that armed it is a bang-bang
 * controller. Aiming at LUNGE_SETTLE (0.84 of max) from a threshold at max reach
 * meant a pointer one unit out of reach asked for six units of body travel; the body
 * arrived four units INSIDE the dead zone where the pull is zero, gravity walked it
 * back out, and it fired again -- a period-2 limit cycle at 60Hz, on a fifth of the
 * stances tried, whenever a pointer was held still near full stretch. That is one of
 * the three oscillators behind the reported jitter.
 *
 * But aiming at the threshold and nothing deeper costs grabs. At release the limb is
 * drawn on the hold (the last few units are REACH_STRETCH, which is cosmetic) while
 * the socket is a hair beyond max reach, so `canReach` refuses -- measured as ~50% of
 * all missed grabs, with the endpoint a median 0.0u from the hold it just failed to
 * take. That is exactly the knife edge LUNGE_SETTLE was introduced to avoid.
 *
 * The two failures live in different regimes: the ringing needs a pointer holding
 * still, the knife edge needs one being hauled. So the aim interpolates on pointer
 * speed. Hauling commits to LUNGE_SETTLE and the body comes deep inside reach;
 * holding still relaxes the aim back to LUNGE_START, where the pull has a genuine
 * equilibrium against the gravity sag and cannot ring. Fast attack and slow release
 * on that estimate, so a moment's hesitation mid-reach doesn't drop the body back
 * out from under the grab.
 *
 * DRAG_PULL is then bounded by stability: the pull moves the body by gain x
 * shortfall, the anchor takes about three quarters of it, and past an effective gain
 * of ~2 the body overshoots the threshold by more than it was short. Measured over
 * 200 moves x 5 levels, plant rate plateaus at gain 2 and the only thing higher
 * values buy is chatter -- 0 bouncing windows at 2.0, 53 at 6.0.
 */
/**
 * How committed the player is to this drag, 0..1, from how fast their pointer is
 * travelling. Kept on the drag object, so it starts fresh with every grab.
 *
 * Attack is fast and release is slow on purpose: the moment you start hauling, the
 * body should commit; when you stop, it should relax back to the stable aim over a
 * few tenths of a second rather than dropping out from under a grab you are still
 * lining up. Pointer updates arrive once a frame and the solver runs at 120Hz, so
 * half the substeps see no movement at all -- hence smoothing rather than the raw
 * per-substep delta.
 */
function trackCommit(drag, dt) {
  const prev = drag.prev;
  const step = prev ? Math.hypot(drag.target.x - prev.x, drag.target.y - prev.y) : 0;
  drag.prev = { x: drag.target.x, y: drag.target.y };
  const speed = step / dt;
  const now = drag.speed || 0;
  const tau = speed > now ? T.LUNGE_SPEED_ATTACK : T.LUNGE_SPEED_RELEASE;
  drag.speed = now + (speed - now) * Math.min(1, dt / tau);
  return Math.min(1, drag.speed / T.LUNGE_COMMIT_SPEED);
}

function applyDragPull(state, limbs, dt) {
  // The shortfall is unbounded -- a pointer dragged to three times a limb's reach
  // asks for hundreds of units of body travel in a single 1/120s substep (measured
  // 555u), which hands the solver a wrecked configuration to recover from, and
  // from some of them it cannot. That is what let a planted limb sit 200u past its
  // length and the torso invert.
  //
  // The cap is on the BODY, not on each pointer: there is one body and it has one
  // speed limit, so three fingers cannot haul it three times as fast. Contributions
  // are gathered, then scaled down together if they add up to more than one
  // substep's worth of travel. Normal play peaks at 66u, so this never binds
  // during ordinary climbing.
  const pulls = [];
  let total = 0;
  for (const limb of limbs) {
    if (!limb.drag) continue;
    const a = anchorOf(state.hip, state.chest, limb);
    const spec = specFor(limb.kind);
    const dx = limb.drag.target.x - a.x;
    const dy = limb.drag.target.y - a.y;
    const d = Math.hypot(dx, dy);
    const commit = trackCommit(limb.drag, dt);
    // ONE line, both armed and aimed at: the pull is off inside it and pulls to it
    // from outside, so it always has an equilibrium and can never overshoot into its
    // own dead zone. All that varies is how deep the line sits.
    const aim = spec.max * (T.LUNGE_START + (T.LUNGE_SETTLE - T.LUNGE_START) * commit);
    if (d <= aim || d <= 1e-6) continue;
    const move = (d - aim) * T.DRAG_PULL;
    const cy = (dy / d) * move;
    const pull = { limb, x: (dx / d) * move, y: cy < 0 ? cy * T.DRAG_LIFT : cy };
    total += Math.hypot(pull.x, pull.y);
    pulls.push(pull);
  }
  const scale = total > T.DRAG_MAX_STEP ? T.DRAG_MAX_STEP / total : 1;
  for (const p of pulls) pushAnchor(state, p.limb, p.x * scale, p.y * scale);
}

/**
 * Planted feet press the body up off their hold -- legs are struts, and this is
 * what makes the figure stand rather than hang. One-sided: a leg pushes when it is
 * compressed below its preferred length and never pulls you back down.
 *
 * Applied ONCE per substep, as an external input alongside gravity and the drag,
 * and for exactly the same reason: it is a soft displacement that the hard reach
 * clamps have to be able to arrest. Re-applying it on every relaxation pass made it
 * beat them -- 10 passes of it against 10 of the clamps, with the push re-injecting
 * each time precisely what the clamp had just removed. On a stance with one leg at
 * full extension and the other deeply folded (which is an ordinary high step) the
 * two never reconciled: measured 60u of push against 60u of clamp every substep,
 * for as long as you cared to watch, and a hip skittering 0.3-11u a substep. That
 * is the third of the three oscillators behind the reported jitter, and the one
 * that survived fixing the other two.
 *
 * `solveStatic` applies it the same way -- once per iteration, before the
 * relaxation -- which is exactly what it did when this lived inside relaxOnce, so
 * the generator's idea of a feasible stance is unchanged by the move.
 *
 * The press is also SATURATED at FOOT_PUSH_RATE. Proportional all the way down, a
 * leg folded up under the hip (an ordinary high step, 14u on a leg whose preferred
 * length is 60) asks to shove the body 10u in a single 1/120s substep, which no
 * clamp reconciles and which alternated. Ordinary standing corrections are ~3u and
 * are untouched by the cap, so this bounds the pathological end without weakening
 * the mechanic -- lowering the stiffness instead did weaken it, and cost 0.1 of
 * strain at rest because the figure hung off its arms rather than standing up.
 */
function applyFootPush(state, limbs, dt) {
  const cap = T.FOOT_PUSH_RATE * dt;
  for (const limb of limbs) {
    if (!limb.hold || limb.drag || limb.kind !== 'foot') continue;
    const a = anchorOf(state.hip, state.chest, limb);
    const spec = specFor(limb.kind);
    const dx = limb.hold.x - a.x;
    const dy = limb.hold.y - a.y;
    const d = Math.hypot(dx, dy) || 1e-6;
    // Press toward slightly STRAIGHTER than the relaxed length, not to it. A
    // one-shot press settles a few units short of its own target, because that is
    // where it balances the gravity sag -- and those few units are the difference
    // between standing on your feet and hanging off your arms. Measured: pressing
    // to pref left 36% of bodyweight on the arms where the old (unstable) version
    // managed 29%; pressing past it recovers that without a bigger shove per
    // substep, which is what actually caused the oscillation.
    const target = spec.pref * T.FOOT_PUSH_REACH;
    if (d < target) {
      // negative => push away from the hold
      const move = -Math.min((target - d) * T.FOOT_PUSH_STIFF, cap);
      pushAnchor(state, limb, (dx / d) * move, (dy / d) * move);
    }
  }
}

/** One relaxation pass over all constraints. Mutates state.hip / state.chest. */
function relaxOnce(state, limbs) {
  // 3. planted limbs clamp the body inside their reach envelope.
  //
  //    A limb is a strut of fixed maximum length, so a planted one LIMITS how
  //    far the body can travel. For a foot that limit is kinematic, not the foot
  //    bearing tension: your leg is only so long, so reaching too far simply
  //    doesn't happen rather than ripping your foot off the hold. If you want
  //    the extra reach, take the foot off deliberately (tap it) and pay for it
  //    by supporting yourself on what's left.
  //
  //    This is safe to apply to feet only because the pose cones exist. On their
  //    own, max-reach clamps on feet let you dangle below a foothold -- hanging
  //    from your feet. The cone caps a foot at POSE.FOOT_RISE above the hip, so
  //    that geometry is forbidden outright, and gravity can only ever compress a
  //    leg whose foot is beneath you. Extension is always voluntary.
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

  // 4. anatomical pose limits -- keep each limb inside its cone relative to the
  //    torso, so feet can't end up above the chest and limbs can't wrap across
  //    the body. Acts on the body, since the hold itself is fixed.
  for (const limb of limbs) {
    const pt = poseTarget(state, limb);
    if (!pt) continue;
    const c = poseCorrection(state, limb, pt);
    if (c.x !== 0 || c.y !== 0) {
      pushAnchor(state, limb, c.x * T.POSE_STIFF, c.y * T.POSE_STIFF);
    }
  }

  // 5. torso keeps its length, and its orientation stays interpretable
  enforceTorso(state);
  enforceTilt(state);

  // 6. weak upright bias so the figure reads as a person, not a ragdoll
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

  // external inputs first, then let the constraints resolve them
  applyFootPush(fig, limbs, dt);
  applyDragPull(fig, limbs, dt);
  escapeWedge(fig, limbs, dt);
  for (let i = 0; i < T.ITERATIONS; i++) relaxOnce(fig, limbs);
  projectReach(fig, limbs);

  // Only a fraction of the solved motion becomes momentum. At equilibrium the
  // sag is cancelled by the tethers, the delta is ~0, and the body goes still.
  const f = T.VEL_FEEDBACK / dt;
  fig.hipV.x = (fig.hip.x - prevHip.x) * f;
  fig.hipV.y = (fig.hip.y - prevHip.y) * f;
  fig.chestV.x = (fig.chest.x - prevChest.x) * f;
  fig.chestV.y = (fig.chest.y - prevChest.y) * f;

  // What the solver could NOT resolve, recorded where it actually stopped. This
  // is the only honest place to judge whether the body is wedged, so it is what
  // the next substep's escapeWedge triggers on.
  fig.violation = bodyViolation(fig, limbs);
  // ...and how long it has been catastrophic, which is the game's cue that you are
  // no longer on the wall at all. See T.FALL_VIOLATION.
  fig.lostFor = fig.violation > T.FALL_VIOLATION ? fig.lostFor + dt : 0;

  placeEndpoints(fig, limbs);
}

/**
 * Escape a wedged stance.
 *
 * The relaxation is local and path-dependent, so it has more than one stable
 * answer for the same set of holds and can settle in a bad one -- most visibly a
 * torso leaning the wrong way, which reads every pose cone mirrored and leaves a
 * foot apparently up by the head. It is a fixed point, not slow convergence:
 * measured unchanged after 1.33s of settling, and more projection passes don't
 * touch it.
 *
 * But `solveStatic` seeds from the hold centroids rather than from the current
 * body, so it finds the *global* answer -- on the repro above it returned a 0.00u
 * solution while the live body sat wedged at a 61u pose violation. So when we are
 * demonstrably stuck and a genuinely better answer exists, migrate toward it.
 *
 * Only runs with nothing being dragged: mid-drag the body is supposed to be
 * hauled somewhere awkward, and this would fight the player.
 *
 * TRIGGER ON THE SETTLED VIOLATION, not a fresh mid-substep measurement. A wedge
 * is by definition a fixed point of the solver, so the only place it can honestly
 * be observed is where the solver stopped -- at the end of the previous substep,
 * after projectReach. Measuring here instead means measuring a body that has just
 * had momentum and a gravity sag added and has had no chance to resolve either,
 * and that transient regularly clears WEDGE_TRIGGER on a stance whose settled
 * violation is 0.00u. The cost was a limit cycle: the escape fired, threw the body
 * 18u toward an answer it did not need, the legs pressed it back over the next six
 * substeps, and it fired again -- a 12Hz bounce, on ~6% of route stances, which is
 * exactly the intermittent jitter reported from play.
 *
 * Migration is bounded as a SPEED (WEDGE_RECOVER world units/s, WEDGE_TURN deg/s)
 * rather than as a fraction of the distance remaining. `min(1, 90 * dt)` reads like
 * a rate limit but is 75% of the way there per substep at 120Hz -- i.e. a teleport,
 * and a teleport is what made the false positives so violent. Bounding the speed
 * makes a false positive cost sub-unit motion instead of tens of units.
 *
 * Applied as an external displacement BEFORE the relaxation, alongside gravity and
 * the drag -- not after it. Nudging the body after the constraints have run just
 * gets undone by the next substep's solve, which pulls straight back into the same
 * wedge; moving first lets the solver resolve from the better basin, and leaves it
 * to restore the torso length rather than breaking it.
 */
function escapeWedge(fig, limbs, dt) {
  // A new set of holds is a new problem, so it gets a fresh budget.
  if (limbs.some((l, i) => l.hold !== fig.wedgeHolds[i])) {
    for (let i = 0; i < limbs.length; i++) fig.wedgeHolds[i] = limbs[i].hold;
    fig.wedgeSpent = 0;
  }
  // The player hauling the body about hands control back to them, so the budget
  // resets outright.
  if (limbs.some((l) => l.drag)) {
    fig.wedgeSpent = 0;
    return;
  }
  // Nothing to fix. The budget re-arms, but at a FRACTION of the rate it burns:
  // resetting it outright the moment the violation cleared let the cycle refill it
  // every time round, which is how a stance kept twitching through a budget meant
  // to stop exactly that. Burning faster than it re-arms means a cycle always runs
  // itself out, while a stance that is genuinely quiet for a second or so gets its
  // escape back.
  if (fig.violation < T.WEDGE_TRIGGER) {
    fig.wedgeSpent = Math.max(0, fig.wedgeSpent - dt * T.WEDGE_REARM);
    return;
  }
  // Tried this stance and got nowhere. Two solvers disagreeing forever is its own
  // oscillator: the escape migrates toward the global answer, the local relaxation
  // walks straight back, and the figure twitches at ~9Hz indefinitely. Sitting
  // still in a slightly wrong pose looks far better than that, so the escape gets a
  // bounded amount of time per stance and then leaves the body alone.
  if (fig.wedgeSpent >= T.WEDGE_BUDGET) return;

  const pts = {};
  let n = 0;
  for (const limb of limbs) {
    if (!limb.hold) continue;
    pts[limb.id] = limb.hold;
    n++;
  }
  if (n === 0) return;

  const sol = solveStatic(pts);
  // only move if the global answer is meaningfully better than where we are
  if (sol.violation > fig.violation - T.WEDGE_TRIGGER) return;
  fig.wedgeSpent += dt;

  // Move the midpoint, but ROTATE the torso rather than interpolating its two
  // ends. The wedged answer and the good one are usually mirrored -- the chest
  // sits the opposite side of the hip -- and lerping the endpoints between those
  // passes through a zero-length torso, which enforceTorso then re-expands in
  // whichever direction it likes, normally straight back into the wedge. Turning
  // the torso through the intervening angle is the motion that actually gets
  // there, and it looks like the figure rolling over rather than collapsing.
  const mid = { x: (fig.hip.x + fig.chest.x) / 2, y: (fig.hip.y + fig.chest.y) / 2 };
  const solMid = { x: (sol.hip.x + sol.chest.x) / 2, y: (sol.hip.y + sol.chest.y) / 2 };
  const ang = Math.atan2(fig.chest.x - fig.hip.x, -(fig.chest.y - fig.hip.y));
  const solAng = Math.atan2(sol.chest.x - sol.hip.x, -(sol.chest.y - sol.hip.y));
  let dAng = solAng - ang;
  while (dAng > Math.PI) dAng -= Math.PI * 2; // shortest way round
  while (dAng < -Math.PI) dAng += Math.PI * 2;

  // How fast to migrate scales with how bad the wedge is, measured FROM THE TRIGGER
  // rather than from zero. A mirrored torso at 60u of violation is a catastrophe and
  // wants reorganising now; a hair over the trigger is cosmetic, and correcting that
  // at any real speed is a jolt the local solver simply undoes -- a sawtooth, which
  // is what the drag lunge taught: a correction that switches on at full strength at
  // its own threshold will always ring there. Starting the ramp at the trigger means
  // the escape fades in, and the last settled limit cycle on the wall (a 1u buzz on a
  // stance sitting 2.3u out, against a 2.0u trigger) went with it.
  const urgency = clamp(
    (fig.violation - T.WEDGE_TRIGGER) / T.WEDGE_REF,
    0,
    T.WEDGE_URGENCY_MAX,
  );

  // Bound translation and rotation independently, then take the tighter of the
  // two: a mirrored torso can need a big turn with almost no travel, and lerping
  // that in one substep is the snap this is supposed to avoid.
  const dist = Math.hypot(solMid.x - mid.x, solMid.y - mid.y);
  const turn = Math.abs(dAng);
  const budget = T.WEDGE_RECOVER * urgency * dt;
  const turnBudget = ((T.WEDGE_TURN * urgency * Math.PI) / 180) * dt;
  const k = Math.min(
    1,
    dist > 1e-6 ? budget / dist : Infinity,
    turn > 1e-6 ? turnBudget / turn : Infinity,
  );

  const nx = mid.x + (solMid.x - mid.x) * k;
  const ny = mid.y + (solMid.y - mid.y) * k;
  const na = ang + dAng * k;
  const hx = (Math.sin(na) * T.TORSO_LEN) / 2;
  const hy = (-Math.cos(na) * T.TORSO_LEN) / 2;
  fig.hip.x = nx - hx;
  fig.hip.y = ny - hy;
  fig.chest.x = nx + hx;
  fig.chest.y = ny + hy;
}

/** Position the visible limb endpoints from the solved body. */
function placeEndpoints(fig, limbs) {
  for (const limb of limbs) {
    if (limb.hold && !limb.drag) {
      limb.pos.x = limb.hold.x;
      limb.pos.y = limb.hold.y;
    } else if (limb.drag) {
      // clamp into the anatomical cone first, then to reach
      const goal = clampToPose(fig.hip, fig.chest, limb, limb.drag.target);
      const a = anchorOf(fig.hip, fig.chest, limb);
      const spec = specFor(limb.kind);
      const dx = goal.x - a.x;
      const dy = goal.y - a.y;
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

/**
 * Can this limb actually take `pt` from where the body currently is? Both the
 * reach envelope and the anatomical cone have to allow it -- a foothold level
 * with your shoulder is in range of the leg but is not a position a body gets
 * into, so it isn't offered.
 */
export function canReach(fig, limb, pt) {
  const a = anchorOf(fig.hip, fig.chest, limb);
  const spec = specFor(limb.kind);
  const d = Math.hypot(pt.x - a.x, pt.y - a.y);
  if (d > spec.max * T.PLANT_TOLERANCE || d < spec.min * 0.55) return false;
  return poseOk(fig.hip, fig.chest, limb, pt);
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

  // Nothing planted is vacuously solvable -- there are no constraints to satisfy.
  // Callers reach this when asking whether an empty stance holds; falling on no
  // contacts is a separate, earlier rule.
  if (!limbs.length) {
    const hip = { x: T.WALL_W / 2, y: 0 };
    return { hip, chest: { x: hip.x, y: hip.y - T.TORSO_LEN }, violation: 0 };
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
    // external inputs then relaxation, the same order the live substep uses
    applyFootPush(state, limbs, T.SUB_DT);
    relaxOnce(state, limbs);
  }
  // same projection the live solver applies, so the generator's idea of a
  // reachable stance matches what the game will actually allow
  projectReach(state, limbs);

  // Same measure the live body reports, so the wedge escape can compare the two.
  // Includes feet, so a stance that would need a foot in tension is rejected.
  return { hip: state.hip, chest: state.chest, violation: bodyViolation(state, limbs) };
}

/**
 * Is this four-point stance one the figure can actually hold? Used by the
 * generator to guarantee every wall it emits is climbable.
 */
/**
 * Is there ANY body position that holds this set of holds?
 *
 * `canReach` only asks whether one limb can get to one hold from where the body
 * is now. That is not enough to keep the figure coherent: plant four limbs one at
 * a time, each legal when it was taken, and the body can move between grabs until
 * the combination is one no body can hold. The solver then does the best possible
 * and the best possible is visibly broken -- a leg drawn 99u long, a foot up by
 * the head. Measured: `solveStatic` returned an 84.7u violation on a stance a
 * player reached by dragging, and its answer was identical to the live body's, so
 * there was nothing left to fix downstream.
 *
 * So the game gates planting on this, the same way the generator gates placing a
 * hold. It keeps the invariant that the current stance is always solvable, which
 * holds inductively: releasing a limb only removes constraints, and dragging moves
 * the body but not the holds.
 *
 * Unlike `stanceFeasible` this asks only whether the stance is *possible*, not
 * whether it looks sensible -- the crossed-limb and hands-above-feet rules are
 * the generator's taste and shouldn't veto what a player does deliberately.
 */
export function stanceSolvable(pts) {
  return solveStatic(pts).violation <= T.PLANT_MAX_VIOLATION;
}

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
 * Joint position for a two-bone limb from `a` to `b`, with the elbow or knee
 * flared outboard the way a climber's does.
 *
 * Two things here are easy to get wrong and both looked awful:
 *
 * Normalise by the TRUE distance, not a clamped one. Clamping first and then
 * dividing leaves a direction vector longer than unit whenever the limb is at
 * or past full extension, which puts the joint in the wrong place exactly when
 * you're reaching hardest. With half = dist/2 the degenerate case handles
 * itself: past full extension the square root goes to zero and the joint sits
 * on the midpoint of a straight limb.
 *
 * And the bend side has to be sticky. Choosing it by a dot product against the
 * torso's right vector passes through zero whenever the limb points sideways,
 * so the knee snaps between the two IK solutions mid-move. `limb.bend` persists
 * the choice and only changes when the preference is unambiguous.
 */
export function ikJoint(a, b, boneLen, frame, limb) {
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  const dist = Math.hypot(dx, dy) || 1e-6;
  dx /= dist;
  dy /= dist;

  const half = dist / 2;
  const h = Math.sqrt(Math.max(0, boneLen * boneLen - half * half));
  const px = -dy;
  const py = dx;

  // >0 means the +perp solution is the outboard one for this limb's side
  const outboard = (px * frame.rx + py * frame.ry) * limb.side;
  if (limb.bend === undefined) limb.bend = outboard >= 0 ? 1 : -1;
  else if (Math.abs(outboard) > T.BEND_HYSTERESIS) limb.bend = outboard > 0 ? 1 : -1;

  return {
    x: a.x + dx * half + px * h * limb.bend,
    y: a.y + dy * half + py * h * limb.bend,
  };
}
