/**
 * Climbability check. Run with `npm run verify`.
 *
 * The brief's one hard constraint is that every generated wall must be climbable.
 * The generator enforces that at build time; this re-proves it after the fact,
 * across every problem the menu offers, so that retuning reach lengths or the solver
 * can't silently produce a problem with an impossible move in it.
 *
 * Every problem of every level is swept -- these are the exact walls the player is
 * handed, not a sample of the settings they came from. Harder levels ask the
 * generator for more and get refused more often, which shows up as `backoffs`, but
 * the guarantee is the same everywhere: a hold is only committed if the resulting
 * stance solves.
 *
 * A problem also has to END, which is checked here too. The last two moves are one
 * hand to the finish hold and then the other hand matching it, and both of those
 * stances are proven like any other -- a problem with no legal way to top out would
 * be a puzzle with no solution.
 */

import { T } from '../src/tuning.js';
import { generateProblem, routeStances, moveDistances } from '../src/wall.js';
import { stanceFeasible, solveStatic } from '../src/body.js';

let failures = 0;
let problems = 0;

for (let level = 0; level < T.LEVELS.length; level++) {
  for (let index = 0; index < T.PROBLEMS_PER_LEVEL; index++) {
    problems++;
    const t0 = performance.now();
    const wall = generateProblem(level, index);
    const genMs = performance.now() - t0;

    const stances = routeStances(wall);
    let worst = 0;
    let bad = 0;
    for (const stance of stances) {
      const { violation } = solveStatic(stance);
      if (violation > worst) worst = violation;
      if (!stanceFeasible(stance)) bad++;
    }

    // the top-out itself: the last stance must be both hands on the finish hold
    const final = stances[stances.length - 1];
    const topped = wall.finish && final.LH === wall.finish && final.RH === wall.finish;
    // and the style's required feature, if it has one
    const matches = wall.route.filter((mv) => mv.match).length;
    const wantsMatch = wall.style.feature === 'footmatch';
    const hasFeature = !wantsMatch || wall.stats.matches > 0;

    const dists = moveDistances(wall);
    const avg = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
    const q = wall.holds.filter((h) => h.route).map((h) => h.q);

    const ok = bad === 0 && topped && hasFeature;
    if (!ok) failures++;

    console.log(
      `${ok ? 'PASS' : 'FAIL'} ` +
        `L${level + 1} ${T.LEVELS[level].name.padEnd(8)} ` +
        `${index + 1} ${wall.style.name.padEnd(8)} ` +
        `rise ${wall.stats.rise.toFixed(0).padStart(3)}u  ` +
        `span ${wall.stats.span.toFixed(0).padStart(3)}u  ` +
        `moves ${String(wall.stats.moves).padStart(2)} ` +
        `(${((100 * wall.stats.reused) / Math.max(1, wall.stats.moves)).toFixed(0).padStart(2)}% reused, ` +
        `${matches} matched)  ` +
        `holds ${String(wall.stats.total).padStart(3)}  ` +
        `move ${avg(dists).toFixed(0)}u  ` +
        `q ${avg(q).toFixed(2)}  ` +
        `worstViolation ${worst.toFixed(2)}u  ` +
        `backoffs ${String(wall.stats.shrinks).padStart(2)}  ` +
        `gen ${genMs.toFixed(0).padStart(3)}ms` +
        (bad ? `  <-- ${bad} INFEASIBLE STANCE(S)` : '') +
        (topped ? '' : '  <-- NO TOP-OUT') +
        (hasFeature ? '' : '  <-- MISSING ITS FOOT MATCH'),
    );
  }
}

console.log(
  failures === 0
    ? `\nAll ${problems} problems climbable and toppable (tolerance ${T.GEN_TOLERANCE}u).`
    : `\n${failures}/${problems} problems FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);
