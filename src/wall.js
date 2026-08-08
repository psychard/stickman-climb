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

import { T, difficultyAt, lerp, clamp, clamp01 } from './tuning.js';
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

function makeHold(x, y, q, route) {
  return { x, y, q: clamp01(q), r: radiusForQuality(q), route };
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

export function generateWall(seed = T.SEED, moves = T.ROUTE_MOVES) {
  const rng = makeRng(seed);
  const holds = [];
  const stance = startStance();
  for (const id of LIMB_IDS) holds.push(stance[id]);
  // Snapshot the *same* hold objects now, before the move loop reassigns them.
  // Rebuilding the start stance later would hand the figure holds that aren't
  // in `holds`, so they'd be neither drawn nor findable when regrabbing.
  const start = { ...stance };

  let rejected = 0;
  let shrinks = 0;

  for (let step = 0; step < moves; step++) {
    let placed = null;
    let placedId = null;

    for (const id of limbPriority(stance, step)) {
      const cur = stance[id];
      const diff = difficultyAt(-cur.y);
      const baseDist = lerp(T.MOVE_DIST.easy, T.MOVE_DIST.hard, diff);

      // Ask for a big move first; if the body can't hold the resulting stance,
      // back off and ask for less. This is what keeps hard sections climbable.
      for (let shrink = 0; shrink < 4 && !placed; shrink++) {
        const dist = baseDist * Math.pow(0.72, shrink);
        if (shrink > 0) shrinks++;
        // where the route "wants" to be at this height -- a slow sine traverse
        const drift =
          T.WALL_W / 2 +
          Math.sin(-cur.y / T.MOVE_DRIFT.period) * T.WALL_W * T.MOVE_DRIFT.amp;

        for (let attempt = 0; attempt < T.GEN_CANDIDATES; attempt++) {
          const bias = (drift - cur.x) * T.MOVE_DRIFT.pull;
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
          break;
        }
      }
      if (placed) break;
    }

    // No limb could move anywhere legal. Stop rather than emit a wall with an
    // impossible move in it -- the climbability guarantee is the whole point.
    if (!placed) break;

    placed.limb = placedId;
    stance[placedId] = placed;
    holds.push(placed);
  }

  const topY = holds.reduce((m, h) => Math.min(m, h.y), 0);
  addFiller(holds, rng, topY);

  const wall = {
    seed,
    holds,
    start,
    topY,
    bands: new Map(),
    stats: { route: holds.filter((h) => h.route).length, total: holds.length, rejected, shrinks },
  };
  indexHolds(wall);
  return wall;
}

/**
 * Replay the generated route as the sequence of four-point stances a climber
 * would pass through. `tools/verify-wall.mjs` re-checks each of these against
 * the solver, so if anyone retunes the reach constants and quietly breaks the
 * climbability guarantee, the check catches it.
 */
export function routeStances(wall) {
  const route = wall.holds.filter((h) => h.route);
  const stance = { LH: route[0], RH: route[1], LF: route[2], RF: route[3] };
  const out = [{ ...stance }];
  for (let i = 4; i < route.length; i++) {
    stance[route[i].limb] = route[i];
    out.push({ ...stance });
  }
  return out;
}

/** Scatter non-route holds so the wall reads as a wall. Density falls with height. */
function addFiller(holds, rng, topY) {
  const route = holds.filter((h) => h.route);
  for (const h of route) {
    const diff = difficultyAt(-h.y);
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
