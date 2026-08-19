/**
 * Stamina.
 *
 * We are deliberately NOT doing biomechanics. The question being approximated
 * is only "would an average human struggle to hold this position?", answered
 * with three cheap signals collapsed into one `strain` scalar:
 *
 *   hold quality  -- a jug costs nothing, a crimp bleeds
 *   flexion       -- bent arms and deeply bent legs burn; straight ones don't
 *   balance       -- barn-dooring off the line of your contacts burns
 *
 * Strain above REST_STRAIN drains; below it, you recover. That single threshold
 * is what creates rest stances, and it's the first knob to reach for if the
 * pacing feels wrong.
 *
 * Two of these departed from the original brief on purpose:
 *
 * FLEXION, NOT EXTENSION. The brief said strain rises as a limb approaches max
 * reach. That's backwards. A straight arm hangs off bone and connective tissue
 * and is the classic rest position; the bent, locked-off arm is what pumps you
 * out. Legs work the same way -- a straight leg is nearly free, a deep high step
 * is brutal. So cost rises with flexion for both.
 *
 * LOAD IS GEOMETRIC. Each contact's share of bodyweight comes from how well it
 * opposes gravity and how near the centre of mass sits to it, not from a fixed
 * per-limb-type constant. This is what makes moving your hips over your feet
 * actually unload your arms, which is the single most important technique in
 * climbing and previously did nothing at all.
 */

import { T, clamp01 } from './tuning.js';
import {
  plantedLimbs,
  centerOfMass,
  extensionOf,
  anchorOf,
  solveStatic,
  stanceShapeOk,
  LIMB_DEFS,
  LIMB_IDS,
} from './body.js';

export function createStamina() {
  return {
    value: 1,
    strain: 0,
    smooth: 0,
    parts: { hold: 0, flex: 0, balance: 0, armLoad: 0 },
    load: {}, // per-limb share of bodyweight, for the debug overlay
    planted: 4,
  };
}

/**
 * Share of bodyweight carried by each planted limb.
 *
 * A contact only helps if it opposes gravity: a hand pulls the body toward its
 * hold, so it supports when the hold is above the shoulder; a foot pushes the
 * body away, so it supports when the hip is above the foot. That support is
 * then weighted by how close the centre of mass is to the contact horizontally
 * -- weight goes where the body is.
 *
 * This is a heuristic, not statics. Solving the real indeterminate force
 * balance every frame would be more correct and would not feel any different.
 */
function loadShares(fig, planted, com) {
  // Per-contact capacity: can this limb bear weight from where it is?
  const caps = planted.map((limb) => {
    const a = anchorOf(fig.hip, fig.chest, limb);
    const dy = limb.hold.y - a.y;
    const len = Math.hypot(limb.hold.x - a.x, dy) || 1e-6;
    // weight goes where the body is
    const near = Math.exp(-Math.abs(com.x - limb.hold.x) / T.LOAD_FALLOFF);

    if (limb.kind === 'foot') {
      const push = Math.max(0, dy / len); // hip above the foot => the leg pushes up
      // ...and you can only stand on a foothold that's actually beneath you.
      // y grows downward, so "COM above the foot" is hold.y - com.y.
      const standing = clamp01((limb.hold.y - com.y) / T.LOAD_STAND_SPAN);
      return push * near * standing;
    }
    const pull = Math.max(0, -dy / len); // hold above the shoulder => the arm pulls up
    return Math.max(T.LOAD_FLOOR, pull * near);
  });

  const feet = [];
  const hands = [];
  planted.forEach((l, i) => (l.kind === 'foot' ? feet : hands).push(i));

  // Legs are far stronger than arms, so a climber puts weight through the feet
  // whenever the feet can take it and the arms carry the remainder. Splitting
  // evenly by "is this contact supporting?" was the bug: standing on your feet
  // and hanging off your arms both scored the same, so moving your hips over
  // your feet -- the single most important technique in climbing -- did nothing.
  let feetTotal;
  if (!hands.length) feetTotal = 1;
  else if (!feet.length) feetTotal = 0;
  else {
    const feetCap = feet.reduce((s, i) => s + caps[i], 0);
    feetTotal = clamp01(feetCap) * (1 - T.HAND_HANG_BIAS);
  }

  const out = new Array(planted.length).fill(0);
  const spread = (idx, total) => {
    const sum = idx.reduce((s, i) => s + caps[i], 0);
    for (const i of idx) out[i] = sum > 1e-6 ? (total * caps[i]) / sum : total / idx.length;
  };
  spread(feet, feetTotal);
  spread(hands, 1 - feetTotal);
  return out;
}

/**
 * How much of your bodyweight a stance would put on your arms, 0..1 -- or null if
 * no body can hold it at all.
 *
 * This is the generator's measure of whether a stance is GOOD, next to
 * `stanceFeasible`'s measure of whether it is possible. For most of this
 * prototype's life only the second question was asked, and the answer showed:
 * the routes averaged 29% of bodyweight on the arms at level 1 and 43% at level
 * 5, because a stance with your feet dangling uselessly beneath you is perfectly
 * feasible and got committed as readily as a good one.
 *
 * ARM LOAD AND NOT STRAIN, deliberately. Strain includes hold quality, which IS
 * the difficulty ramp -- a generator that preferred low-strain stances would
 * quietly refuse to build a hard level, since the only way to lower that term is
 * to place better holds. Arm load is pure geometry: are your feet under you.
 * So it measures technique and leaves difficulty entirely alone.
 *
 * It lives here rather than in wall.js or body.js because the load model is
 * here, and a second copy of "which contact carries what" is exactly the kind of
 * duplicate source of truth this repo keeps stamping out.
 */
export function stanceArmLoad(pts) {
  if (!stanceShapeOk(pts)) return null;
  const solved = solveStatic(pts);
  if (solved.violation > T.GEN_TOLERANCE) return null;

  // A figure-shaped view of the solved stance, enough for the load model. `pos`
  // is the hold itself: nothing is dangling or mid-drag in a stance the
  // generator is weighing, so endpoint and hold coincide.
  const limbs = {};
  for (const id of LIMB_IDS) {
    limbs[id] = { ...LIMB_DEFS[id], id, hold: pts[id] || null, pos: pts[id] || solved.hip, drag: null };
  }
  const fig = { hip: solved.hip, chest: solved.chest, limbs };

  const planted = plantedLimbs(fig);
  if (!planted.length) return null;
  const shares = loadShares(fig, planted, centerOfMass(fig));
  let arms = 0;
  for (let i = 0; i < planted.length; i++) {
    if (planted[i].kind === 'hand') arms += shares[i];
  }
  return arms;
}

/** 0 when the limb is straight, 1 when fully folded. */
function flexionCost(fig, limb) {
  const curve = limb.kind === 'hand' ? T.FLEX.ARM : T.FLEX.LEG;
  const ext = extensionOf(fig, limb);
  const t = clamp01((curve.straight - ext) / (curve.straight - curve.folded));
  return Math.pow(t, T.FLEX_EXP);
}

/**
 * Balance: how far the centre of mass sits sideways of the contacts actually
 * carrying it, amplified when those contacts give you a narrow base.
 *
 * A note on what this is and isn't. Real barn-dooring is the body rotating
 * about the line joining two contacts and swinging OUT OF the wall plane. We
 * deliberately don't model depth, so that rotation has nowhere to happen and
 * cannot be represented. This is its in-plane shadow: hanging or standing
 * off-line from your support, which is the part that does live in 2D.
 *
 * Measuring perpendicular distance from the principal axis of the contacts --
 * the obvious way to write "barn door" -- gets the most common position on the
 * wall exactly backwards. Hanging straight down from two hands puts the COM far
 * off a horizontal contact axis, and scores as maximally unstable, when a dead
 * hang is in fact the most stable thing you can do. Gravity only destabilises
 * you *sideways*; vertically it just hangs you plumb.
 */
function balanceCost(planted, shares, com) {
  if (!planted.length) return 2.5;

  // support centre, weighted by what each contact is actually carrying
  let sx = 0;
  let w = 0;
  for (let i = 0; i < planted.length; i++) {
    sx += planted[i].hold.x * shares[i];
    w += shares[i];
  }
  sx /= w || 1;

  // a contact bearing nothing doesn't widen your base
  let minX = Infinity;
  let maxX = -Infinity;
  for (let i = 0; i < planted.length; i++) {
    if (shares[i] < T.BALANCE_MIN_SHARE) continue;
    minX = Math.min(minX, planted[i].hold.x);
    maxX = Math.max(maxX, planted[i].hold.x);
  }
  const spread = maxX > minX ? maxX - minX : 0;

  const offset = Math.abs(com.x - sx);
  const narrow = 1 + T.BALANCE_NARROW * clamp01(1 - spread / T.BALANCE_BASE_SPAN);
  return (offset / T.BALANCE_SCALE) * narrow;
}

export function computeStrain(fig) {
  const planted = plantedLimbs(fig);
  const parts = { hold: 0, flex: 0, balance: 0, armLoad: 0 };
  const load = {};

  if (planted.length === 0) return { total: 2.5, parts, load, planted: 0 };

  const com = centerOfMass(fig);
  const shares = loadShares(fig, planted, com);

  // WITH NO HAND ON THE WALL A FOOTHOLD IS NOT A DISCOUNT. FOOT_STRAIN_MULT says
  // legs are stronger than arms, which is true of the muscular cost and stays true
  // here -- but the `hold` term is not muscular, it is the cost of staying on a
  // poor edge, and with your hands on the wall you can be sloppy about that because
  // your hands keep you in contact. Let both hands go and that edge is the only
  // thing between you and the ground, so it costs what it costs. See
  // NOHANDS_FOOT_GRIP: this is the whole reason letting go is no longer a free rest.
  const handsOn = planted.some((l) => l.kind === 'hand');

  for (let i = 0; i < planted.length; i++) {
    const limb = planted[i];
    const share = shares[i];
    const strength = limb.kind === 'foot' ? T.FOOT_STRAIN_MULT : 1;
    const grip = limb.kind === 'foot' && !handsOn ? T.NOHANDS_FOOT_GRIP : strength;
    load[limb.id] = share;

    parts.hold += share * grip * Math.pow(1 - limb.hold.q, T.HOLD_EXP);
    parts.flex += share * strength * flexionCost(fig, limb);
    // Arms tire from carrying weight at all, regardless of how good the hold
    // is. Without this a dead hang off two jugs scores as a perfect rest, when
    // hanging off your arms is precisely what you're trying to avoid.
    if (limb.kind === 'hand') parts.armLoad += share;
  }

  parts.balance = balanceCost(planted, shares, com);

  // Pressing down on a hand (COM above it) is a mantel -- genuinely strenuous.
  for (let i = 0; i < planted.length; i++) {
    const limb = planted[i];
    if (limb.kind !== 'hand') continue;
    const above = limb.hold.y - com.y;
    if (above > 0) parts.balance += shares[i] * T.W_MANTEL * clamp01(above / 40);
  }

  const total =
    T.W_HOLD * parts.hold +
    T.W_FLEX * parts.flex +
    T.W_BALANCE * parts.balance +
    T.W_ARMLOAD * parts.armLoad;
  return { total, parts, load, planted: planted.length };
}

export function updateStamina(stam, fig, dt) {
  const s = computeStrain(fig);
  stam.parts = s.parts;
  stam.load = s.load;
  stam.planted = s.planted;
  stam.strain = s.total;

  // low-pass, otherwise the bar jitters while a limb is mid-drag
  const k = 1 - Math.exp(-T.STAMINA_SMOOTH * dt);
  stam.smooth += (s.total - stam.smooth) * k;

  const net = stam.smooth - T.REST_STRAIN;
  const rate = net > 0 ? -net * T.DRAIN_RATE : -net * T.RECOVER_RATE;
  stam.value = Math.max(0, Math.min(1, stam.value + rate * dt));
  return stam;
}
