/**
 * Procedural wall generation.
 *
 * Hard requirement from the brief: every wall must be climbable. We don't
 * scatter holds and hope. The generator walks a virtual climber up the wall one
 * limb at a time, and a candidate hold is only committed if `stanceFeasible()`
 * -- which runs the *actual* body solver headlessly -- says the resulting
 * four-point stance is one the figure can hold. The route holds are therefore a
 * proven-climbable ladder by construction.
 *
 * Filler holds are scattered around the route afterwards so the wall reads like
 * a wall rather than a staircase. They're decoration and alternates; the route
 * is the guarantee.
 */

import { T, difficultyAt, levelAt, lerp, clamp, clamp01 } from './tuning.js';
import { makeRng } from './rng.js';
import { stanceFeasible } from './body.js';
import { LIMB_IDS } from './body.js';

const BAND = 200; // spatial index bucket height, world units
const EDGE_MARGIN = 26;

/**
 * Which limb to move next, best first.
 *
 * Alternate hands and feet (that's how people climb), and within a pair always
 * move the one that's lagging lowest. A fixed round-robin looks right but
 * strands the generator: random move sizes let one limb drift ahead until no
 * legal stance remains and the route dead-ends. Moving the lagging limb is
 * self-correcting. The remaining limbs are returned as fallbacks so a single
 * awkward position can't end the route.
 */
function limbPriority(stance, step) {
  const lower = (a, b) => (stance[a].y > stance[b].y ? [a, b] : [b, a]);
  const hands = lower('LH', 'RH');
  const feet = lower('LF', 'RF');
  return step % 2 === 0 ? [...hands, ...feet] : [...feet, ...hands];
}

export const radiusForQuality = (q) => lerp(T.HOLD_R_MIN, T.HOLD_R_MAX, clamp01(q));

/**
 * Which silhouette this hold is drawn as. Cosmetic only -- see T.HOLD_KINDS.
 *
 * Deterministic from the hold's own position rather than drawn from the generator's
 * rng, deliberately: consuming rng here would shift every subsequent sample and
 * reshuffle the whole wall, so a purely visual change would move route geometry and
 * invalidate every measured number in the repo. This way the walls are bit-identical
 * to the ones before holds had shapes.
 */
function kindForHold(x, y, q) {
  const kinds = T.HOLD_KINDS.filter((k) => q >= k.from && q < k.to);
  if (!kinds.length) return T.HOLD_KINDS[T.HOLD_KINDS.length - 1];
  // cheap integer hash of the position, stable across runs and platforms
  const h = Math.abs(Math.round(x * 73856093) ^ Math.round(y * 19349663));
  return kinds[h % kinds.length];
}

function makeHold(x, y, q, route) {
  const quality = clamp01(q);
  return {
    x,
    y,
    q: quality,
    r: radiusForQuality(quality),
    route,
    kind: kindForHold(x, y, quality),
  };
}

/**
 * Four jugs, positioned so the figure starts in a relaxed, readable pose: arms
 * close to their preferred length (a hands-low start bends them past 90 degrees
 * and the IK flares both elbows out sideways) and legs comfortably bent.
 */
function startStance() {
  const cx = T.WALL_W / 2;
  return {
    LH: makeHold(cx - 26, -232, 1.0, true),
    RH: makeHold(cx + 26, -232, 1.0, true),
    LF: makeHold(cx - 24, -55, 1.0, true),
    RF: makeHold(cx + 24, -55, 1.0, true),
  };
}

/**
 * `level` is an index into T.LEVELS; it only enters through `difficultyAt`, as a
 * floor under the same scalar the height ramp drives. Nothing about the
 * climbability guarantee changes with it -- a harder level makes the generator
 * ask for more and get refused more often (watch `rejected` and `shrinks`), but
 * a hold is still only committed if the resulting stance solves.
 */
export function generateWall(seed = T.SEED, level = 0, moves = T.ROUTE_MOVES) {
  const { floor } = levelAt(level);
  const rng = makeRng(seed);
  const holds = [];
  const stance = startStance();
  for (const id of LIMB_IDS) holds.push(stance[id]);
  // Snapshot the *same* hold objects now, before the move loop reassigns them.
  // Rebuilding the start stance later would hand the figure holds that aren't
  // in `holds`, so they'd be neither drawn nor findable when regrabbing.
  const start = { ...stance };
  // The route is the ordered list of moves, NOT the holds array: with reuse, one
  // hold serves several moves and a hold no longer belongs to a single limb.
  const route = [];

  let rejected = 0;
  let shrinks = 0;
  let reused = 0;

  for (let step = 0; step < moves; step++) {
    let placed = null;
    let placedId = null;
    let isNew = false;

    for (const id of limbPriority(stance, step)) {
      const cur = stance[id];
      const diff = difficultyAt(-cur.y, floor);
      const baseDist = lerp(T.MOVE_DIST.easy, T.MOVE_DIST.hard, diff);
      // where the route "wants" to be at this height -- a slow sine traverse
      const drift =
        T.WALL_W / 2 +
        Math.sin(-cur.y / T.MOVE_DRIFT.period) * T.WALL_W * T.MOVE_DRIFT.amp;
      const bias = (drift - cur.x) * T.MOVE_DRIFT.pull;

      // Try to move onto a hold that is already on the wall before inventing a
      // new one. This is the only lever that genuinely thins the wall: a hold
      // placed for a hand is at foot height a body-length later, so a foot can
      // step onto it and the move costs nothing. Reuse rises with difficulty,
      // which is what turns a staircase into a sequence you have to solve.
      const reuse = lerp(T.REUSE.easy, T.REUSE.hard, diff);
      if (reuse > 0 && rng() < reuse) {
        placed = pickReusable(holds, stance, id, cur, baseDist, bias);
        if (placed) {
          placedId = id;
          reused++;
          break;
        }
      }

      // Ask for a big move first; if the body can't hold the resulting stance,
      // back off and ask for less. This is what keeps hard sections climbable.
      for (let shrink = 0; shrink < 4 && !placed; shrink++) {
        const dist = baseDist * Math.pow(0.72, shrink);
        if (shrink > 0) shrinks++;

        for (let attempt = 0; attempt < T.GEN_CANDIDATES; attempt++) {
          const dx = bias + rng.range(-T.MOVE_SPREAD, T.MOVE_SPREAD);
          const dy = -rng.range(dist * 0.45, dist * 1.1);
          const x = clamp(cur.x + dx, EDGE_MARGIN, T.WALL_W - EDGE_MARGIN);
          const cand = { x, y: cur.y + dy };

          if (nearestHold(holds, cand, T.FILL_MIN_GAP * 0.7)) {
            rejected++;
            continue;
          }
          if (!stanceFeasible({ ...stance, [id]: cand })) {
            rejected++;
            continue;
          }

          const q = clamp01(
            lerp(T.QUALITY_ROUTE.easy, T.QUALITY_ROUTE.hard, diff) +
              rng.range(-T.QUALITY_JITTER, T.QUALITY_JITTER),
          );
          placed = makeHold(cand.x, cand.y, q, true);
          placedId = id;
          isNew = true;
          break;
        }
      }
      if (placed) break;
    }

    // No limb could move anywhere legal. Stop rather than emit a wall with an
    // impossible move in it -- the climbability guarantee is the whole point.
    if (!placed) break;

    stance[placedId] = placed;
    route.push({ limb: placedId, hold: placed });
    if (isNew) holds.push(placed);
  }

  const topY = holds.reduce((m, h) => Math.min(m, h.y), 0);
  addFiller(holds, rng, topY, floor);

  const wall = {
    seed,
    level,
    holds,
    start,
    route,
    topY,
    bands: new Map(),
    stats: {
      route: holds.filter((h) => h.route).length,
      total: holds.length,
      moves: route.length,
      reused,
      rejected,
      shrinks,
    },
  };
  indexHolds(wall);
  return wall;
}

/**
 * An existing hold this limb could move onto, or null.
 *
 * Two rules keep reuse from degenerating. A hold already under another limb is
 * out -- matching two limbs on one hold is real climbing but isn't modelled. And
 * the hold has to be meaningfully higher than where the limb is now: without a
 * minimum gain the generator happily shuffles a foot between two adjacent holds
 * forever and the route stops rising.
 */
function pickReusable(holds, stance, id, cur, dist, bias) {
  // Only feet ever find anything here, and that is structural rather than a
  // tuning failure: the hands are the top of the route, so nothing exists above
  // them to move onto and a hand's candidate pool is empty on 100% of attempts.
  // Letting a hand MATCH onto the other hand's hold was tried to fix that and
  // made everything worse -- hanging both hands on one hold leaves an awkward
  // stance, so the next move backs off (backoffs 5 -> 99), climbs less per move,
  // and the wall ends up with MORE holds, not fewer.
  const taken = new Set(LIMB_IDS.map((k) => stance[k]));
  // Rank by nearness to the move the sampler would have asked for, NOT by height.
  // Highest-first looks right and is badly wrong for feet: the highest holds in
  // range sit above the hip, which POSE.FOOT_RISE forbids outright, so every one
  // of the tries got spent on stances that could never solve.
  const ideal = { x: cur.x + bias, y: cur.y - dist * 0.75 };
  const near = [];
  for (const h of holds) {
    if (taken.has(h)) continue;
    if (h.y > cur.y - dist * T.REUSE_GAIN) continue;
    if (Math.hypot(h.x - cur.x, h.y - cur.y) > dist * T.REUSE_RANGE) continue;
    near.push({ h, d: Math.hypot(h.x - ideal.x, h.y - ideal.y) });
  }
  near.sort((a, b) => a.d - b.d);
  for (const { h } of near.slice(0, T.REUSE_TRIES)) {
    if (stanceFeasible({ ...stance, [id]: h })) return h;
  }
  return null;
}

/**
 * How far each limb actually travelled, move by move. Has to walk the route
 * rather than diff the holds array: a reused hold appears once but is moved to
 * several times, from a different place each time.
 */
export function moveDistances(wall) {
  const at = { ...wall.start };
  const out = [];
  for (const mv of wall.route) {
    const from = at[mv.limb];
    out.push(Math.hypot(mv.hold.x - from.x, mv.hold.y - from.y));
    at[mv.limb] = mv.hold;
  }
  return out;
}

/**
 * Replay the generated route as the sequence of four-point stances a climber
 * would pass through. `tools/verify-wall.mjs` re-checks each of these against
 * the solver, so if anyone retunes the reach constants and quietly breaks the
 * climbability guarantee, the check catches it.
 */
export function routeStances(wall) {
  const stance = { ...wall.start };
  const out = [{ ...stance }];
  for (const mv of wall.route) {
    stance[mv.limb] = mv.hold;
    out.push({ ...stance });
  }
  return out;
}

/** Scatter non-route holds so the wall reads as a wall. Density falls with height. */
function addFiller(holds, rng, topY, floor) {
  const route = holds.filter((h) => h.route);
  for (const h of route) {
    const diff = difficultyAt(-h.y, floor);
    const density = lerp(T.FILL_DENSITY.easy, T.FILL_DENSITY.hard, diff);
    const n = Math.floor(density) + (rng() < density % 1 ? 1 : 0);
    for (let i = 0; i < n; i++) {
      const x = clamp(
        h.x + rng.range(-90, 90),
        EDGE_MARGIN,
        T.WALL_W - EDGE_MARGIN,
      );
      const y = clamp(h.y + rng.range(-70, 70), topY, -20);
      if (nearestHold(holds, { x, y }, T.FILL_MIN_GAP)) continue;
      const q = clamp01(
        lerp(T.QUALITY_FILL.easy, T.QUALITY_FILL.hard, diff) +
          rng.range(-T.QUALITY_JITTER, T.QUALITY_JITTER),
      );
      holds.push(makeHold(x, y, q, false));
    }
  }
}

// --------------------------------------------------------------------------
// spatial index -- holds are queried every frame for rendering and snapping
// --------------------------------------------------------------------------

function bandKey(y) {
  return Math.floor(y / BAND);
}

function indexHolds(wall) {
  wall.bands.clear();
  for (const h of wall.holds) {
    const k = bandKey(h.y);
    let arr = wall.bands.get(k);
    if (!arr) wall.bands.set(k, (arr = []));
    arr.push(h);
  }
}

/** Holds whose centres fall in the vertical range [yTop, yBottom]. */
export function holdsInRange(wall, yTop, yBottom) {
  const out = [];
  for (let k = bandKey(yTop) - 1; k <= bandKey(yBottom) + 1; k++) {
    const arr = wall.bands.get(k);
    if (arr) out.push(...arr);
  }
  return out;
}

/** All holds within `radius` of `pt`, nearest first. */
export function holdsNear(wall, pt, radius) {
  return holdsInRange(wall, pt.y - radius, pt.y + radius)
    .map((h) => ({ h, d: Math.hypot(h.x - pt.x, h.y - pt.y) }))
    .filter((e) => e.d <= radius)
    .sort((a, b) => a.d - b.d)
    .map((e) => e.h);
}

/** Nearest hold to `pt` within `radius`, or null. Accepts a wall or a raw array. */
export function nearestHold(wallOrArray, pt, radius) {
  const list = Array.isArray(wallOrArray)
    ? wallOrArray
    : holdsInRange(wallOrArray, pt.y - radius - BAND, pt.y + radius + BAND);
  let best = null;
  let bestD = radius;
  for (const h of list) {
    const d = Math.hypot(h.x - pt.x, h.y - pt.y);
    if (d < bestD) {
      bestD = d;
      best = h;
    }
  }
  return best;
}
