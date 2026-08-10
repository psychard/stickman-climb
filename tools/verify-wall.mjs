/**
 * Climbability check. Run with `npm run verify`.
 *
 * The brief's one hard constraint is that every generated wall must be
 * climbable. The generator enforces that at build time; this re-proves it after
 * the fact, across many seeds, so that retuning reach lengths or the solver
 * can't silently produce a wall with an impossible move in it.
 *
 * Every difficulty level is swept, and each level's own seed goes first -- so the
 * five walls the menu actually hands the player are proven, not just the settings
 * they were generated from. Harder levels ask the generator for more and get
 * refused more often, which shows up as `backoffs`, but the guarantee is the same
 * at every level: a hold is only committed if the resulting stance solves.
 *
 *   node tools/verify-wall.mjs [seedsPerLevel]
 */

import { T } from '../src/tuning.js';
import { generateWall, routeStances, moveDistances } from '../src/wall.js';
import { stanceFeasible, solveStatic } from '../src/body.js';

const perLevel = Number(process.argv[2] || 3);
const walls = T.LEVELS.flatMap((lvl, level) => [
  { level, seed: lvl.seed },
  ...Array.from({ length: perLevel - 1 }, (_, i) => ({ level, seed: 1000 + i * 7919 })),
]);

let failures = 0;

for (const { level, seed } of walls) {
  const t0 = performance.now();
  const wall = generateWall(seed, level);
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
  const dists = moveDistances(wall);
  const avg = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  const lowQ = route.slice(0, 40);
  const highQ = route.slice(-40);
  const height = -wall.topY;

  const ok = bad === 0;
  if (!ok) failures++;

  console.log(
    `${ok ? 'PASS' : 'FAIL'} ` +
      `L${level + 1} ${T.LEVELS[level].name.padEnd(8)} ` +
      `seed ${String(seed).padStart(9)}  ` +
      `height ${height.toFixed(0).padStart(5)}  ` +
      `holds ${String(wall.stats.total).padStart(4)} (${String(wall.stats.route).padStart(4)} route)  ` +
      `moves ${String(wall.stats.moves).padStart(3)} (${((100 * wall.stats.reused) / Math.max(1, wall.stats.moves)).toFixed(0).padStart(2)}% reused)  ` +
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
    ? `\nAll ${walls.length} walls climbable across ${T.LEVELS.length} levels ` +
        `(tolerance ${T.GEN_TOLERANCE}u).`
    : `\n${failures}/${walls.length} walls FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);
