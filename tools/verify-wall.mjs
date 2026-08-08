/**
 * Climbability check. Run with `npm run verify`.
 *
 * The brief's one hard constraint is that every generated wall must be
 * climbable. The generator enforces that at build time; this re-proves it after
 * the fact, across many seeds, so that retuning reach lengths or the solver
 * can't silently produce a wall with an impossible move in it.
 *
 *   node tools/verify-wall.mjs [seedCount]
 */

import { T } from '../src/tuning.js';
import { generateWall, routeStances } from '../src/wall.js';
import { stanceFeasible, solveStatic } from '../src/body.js';

const seedCount = Number(process.argv[2] || 12);
const seeds = [T.SEED, ...Array.from({ length: seedCount - 1 }, (_, i) => 1000 + i * 7919)];

let failures = 0;

for (const seed of seeds) {
  const t0 = performance.now();
  const wall = generateWall(seed);
  const genMs = performance.now() - t0;

  const stances = routeStances(wall);
  let worst = 0;
  let bad = 0;
  for (const stance of stances) {
    const { violation } = solveStatic(stance);
    if (violation > worst) worst = violation;
    if (!stanceFeasible(stance)) bad++;
  }

  // move-distance and quality spread, to sanity-check the difficulty ramp
  const route = wall.holds.filter((h) => h.route);
  const dists = [];
  for (let i = 4; i < route.length; i++) {
    const prev = route[i - 4];
    dists.push(Math.hypot(route[i].x - prev.x, route[i].y - prev.y));
  }
  const avg = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  const lowQ = route.slice(0, 40);
  const highQ = route.slice(-40);
  const height = -wall.topY;

  const ok = bad === 0;
  if (!ok) failures++;

  console.log(
    `${ok ? 'PASS' : 'FAIL'} seed ${String(seed).padStart(9)}  ` +
      `height ${height.toFixed(0).padStart(5)}  ` +
      `holds ${String(wall.stats.total).padStart(4)} (${String(wall.stats.route).padStart(4)} route)  ` +
      `move ${avg(dists).toFixed(1)}u  ` +
      `q ${avg(lowQ.map((h) => h.q)).toFixed(2)}->${avg(highQ.map((h) => h.q)).toFixed(2)}  ` +
      `worstViolation ${worst.toFixed(2)}u  ` +
      `backoffs ${wall.stats.shrinks}  ` +
      `gen ${genMs.toFixed(0)}ms` +
      (ok ? '' : `  <-- ${bad} INFEASIBLE STANCE(S)`),
  );
}

console.log(
  failures === 0
    ? `\nAll ${seeds.length} walls climbable (tolerance ${T.GEN_TOLERANCE}u).`
    : `\n${failures}/${seeds.length} walls FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);
