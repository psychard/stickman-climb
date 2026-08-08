/**
 * Stamina.
 *
 * We are deliberately NOT doing biomechanics. The question being approximated
 * is only "would an average human struggle to hold this position?", answered
 * with three cheap signals collapsed into one `strain` scalar:
 *
 *   hold quality  -- a jug costs nothing, a crimp bleeds
 *   extension     -- limbs near max reach strain
 *   centre of mass-- COM outside the span of the planted limbs strains
 *
 * Strain above REST_STRAIN drains; below it, you recover. That single threshold
 * is what creates rest stances, and it's the first knob to reach for if the
 * pacing feels wrong.
 *
 * Load is shared across the planted limbs (feet take less than hands), so
 * hanging off two limbs is automatically harder than standing on four without
 * needing a separate "limb count" term.
 */

import { T, clamp01 } from './tuning.js';
import { plantedLimbs, centerOfMass, extensionOf } from './body.js';

export function createStamina() {
  return { value: 1, strain: 0, smooth: 0, parts: { hold: 0, ext: 0, com: 0 }, planted: 4 };
}

export function computeStrain(fig) {
  const planted = plantedLimbs(fig);
  const parts = { hold: 0, ext: 0, com: 0 };

  if (planted.length === 0) {
    return { total: 2.5, parts, planted: 0 };
  }

  // --- how bodyweight is distributed over the contact points -------------
  const weights = planted.map((l) => (l.kind === 'hand' ? 1 : T.FOOT_LOAD));
  const totalW = weights.reduce((a, b) => a + b, 0) || 1;

  for (let i = 0; i < planted.length; i++) {
    const limb = planted[i];
    const share = weights[i] / totalW;
    const strength = limb.kind === 'foot' ? T.FOOT_STRAIN_MULT : 1;

    // 1. hold quality
    parts.hold += share * strength * Math.pow(1 - limb.hold.q, T.HOLD_EXP);

    // 2. limb extension
    const ext = extensionOf(fig, limb);
    const over = clamp01((ext - T.EXT_FREE) / (1 - T.EXT_FREE));
    parts.ext += share * strength * Math.pow(over, T.EXT_EXP);
  }

  // --- 3. centre of mass vs base of support ------------------------------
  const com = centerOfMass(fig);
  let minX = Infinity;
  let maxX = -Infinity;
  for (const l of planted) {
    if (l.hold.x < minX) minX = l.hold.x;
    if (l.hold.x > maxX) maxX = l.hold.x;
  }
  let outside = 0;
  if (com.x < minX) outside = minX - com.x;
  else if (com.x > maxX) outside = com.x - maxX;
  parts.com = outside / T.COM_SPAN_SCALE;

  // Pressing down on a hand (COM above it) is a mantel -- genuinely strenuous.
  for (let i = 0; i < planted.length; i++) {
    const limb = planted[i];
    if (limb.kind !== 'hand') continue;
    const above = limb.hold.y - com.y;
    if (above > 0) parts.com += (weights[i] / totalW) * T.W_MANTEL * clamp01(above / 40);
  }

  const total = T.W_HOLD * parts.hold + T.W_EXT * parts.ext + T.W_COM * parts.com;
  return { total, parts, planted: planted.length };
}

export function updateStamina(stam, fig, dt) {
  const s = computeStrain(fig);
  stam.parts = s.parts;
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
