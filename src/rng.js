/**
 * Fold two numbers into one 32-bit seed.
 *
 * A problem's seed is now made of two independent things -- which problem it is, and
 * what day it is -- and they cannot simply be added: the level seeds are themselves
 * date-like numbers, so `20260808 + day` and `41773 + otherDay` would collide freely
 * and two levels would hand out the same wall. Avalanching both inputs makes the
 * whole (level, index, day) space distinct, and makes consecutive days unrelated
 * rather than adjacent.
 */
export function hashSeed(a, b) {
  let h = Math.imul((a >>> 0) ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  h = (h ^ Math.imul(((b >>> 0) + 0x165667b1) >>> 0, 0xc2b2ae35)) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0x2545f491) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** Deterministic PRNG so a seed always rebuilds the identical wall. */
export function makeRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.range = (lo, hi) => lo + next() * (hi - lo);
  next.int = (lo, hi) => Math.floor(next.range(lo, hi + 1));
  next.pick = (arr) => arr[Math.floor(next() * arr.length)];
  return next;
}
