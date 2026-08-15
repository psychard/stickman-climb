/**
 * Climbability check. Run with `npm run verify`.
 *
 * The brief's one hard constraint is that every generated wall must be climbable.
 * The generator enforces that at build time; this re-proves it after the fact,
 * across every problem the menu offers, so that retuning reach lengths or the solver
 * can't silently produce a problem with an impossible move in it.
 *
 * A problem also has to END, which is checked here too. The last two moves are one
 * hand to the finish hold and then the other hand matching it, and both of those
 * stances are proven like any other -- a problem with no legal way to top out would
 * be a puzzle with no solution.
 *
 *   node tools/verify-wall.mjs [days] [--day=YYYYMMDD|today]
 *
 * The set is reseeded from the local date every day, so there is no longer a fixed
 * thirty to check. This one tool therefore sweeps DAYS instead of pinning
 * `T.REF_DAY` the way the measurement tools do: it is the gate in front of a deploy,
 * and what it should be defending is the walls players are about to be handed. It
 * starts at today and walks forward a week -- 210 problems, a few seconds -- which is
 * long enough to catch a constant that has made whole styles unfinishable and short
 * enough to keep a push to main quick. It cannot prove every future day; the
 * guarantee that it doesn't have to is that a hold is only ever committed if the
 * resulting stance solves. What this catches is a systematic break, and a systematic
 * break shows up on the first day it is asked about.
 *
 * The first day is printed problem by problem; later days collapse to a line each,
 * with any failure printed in full wherever it lands.
 */

import { T } from '../src/tuning.js';
import { today, dayArg, shiftDay, dayLabel } from '../src/day.js';
import { generateProblem, routeStances, moveDistances } from '../src/wall.js';
import { stanceFeasible, solveStatic } from '../src/body.js';

const args = process.argv.slice(2);
const days = Number(args.find((a) => !a.startsWith('--')) || 7);
const first = dayArg(args, today());

const avg = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);

/** Prove one problem. Returns the row, whether or not it passed. */
function check(level, index, day) {
  const t0 = performance.now();
  const wall = generateProblem(level, index, day);
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
  const topped = !!wall.finish && final.LH === wall.finish && final.RH === wall.finish;
  // and the style's required feature, if it has one
  const matches = wall.route.filter((mv) => mv.match).length;
  const wantsMatch = wall.style.feature === 'footmatch';
  const hasFeature = !wantsMatch || wall.stats.matches > 0;

  return {
    wall,
    level,
    index,
    genMs,
    worst,
    bad,
    topped,
    matches,
    hasFeature,
    ok: bad === 0 && topped && hasFeature,
  };
}

function line(r) {
  const { wall } = r;
  const dists = moveDistances(wall);
  const q = wall.holds.filter((h) => h.route).map((h) => h.q);
  return (
    `${r.ok ? 'PASS' : 'FAIL'} ` +
    `L${r.level + 1} ${T.LEVELS[r.level].name.padEnd(8)} ` +
    `${r.index + 1} ${wall.style.name.padEnd(8)} ` +
    `rise ${wall.stats.rise.toFixed(0).padStart(3)}u  ` +
    `span ${wall.stats.span.toFixed(0).padStart(3)}u  ` +
    `moves ${String(wall.stats.moves).padStart(2)} ` +
    `(${((100 * wall.stats.reused) / Math.max(1, wall.stats.moves)).toFixed(0).padStart(2)}% reused, ` +
    `${r.matches} matched)  ` +
    `holds ${String(wall.stats.total).padStart(3)}  ` +
    `move ${avg(dists).toFixed(0)}u  ` +
    `q ${avg(q).toFixed(2)}  ` +
    `worstViolation ${r.worst.toFixed(2)}u  ` +
    `backoffs ${String(wall.stats.shrinks).padStart(2)}  ` +
    `gen ${r.genMs.toFixed(0).padStart(3)}ms` +
    (r.bad ? `  <-- ${r.bad} INFEASIBLE STANCE(S)` : '') +
    (r.topped ? '' : '  <-- NO TOP-OUT') +
    (r.hasFeature ? '' : '  <-- MISSING ITS FOOT MATCH')
  );
}

console.log(
  `sweeping ${days} day${days === 1 ? '' : 's'} from ${dayLabel(first)} (${first}), ` +
    `${T.LEVELS.length * T.PROBLEMS_PER_LEVEL} problems each\n`,
);

let failures = 0;
let problems = 0;
for (let d = 0; d < days; d++) {
  const day = shiftDay(first, d);
  const rows = [];
  for (let level = 0; level < T.LEVELS.length; level++) {
    for (let index = 0; index < T.PROBLEMS_PER_LEVEL; index++) {
      const r = check(level, index, day);
      rows.push(r);
      problems++;
      if (!r.ok) failures++;
      // The first day in full -- it is the one people are on right now, and the
      // per-problem columns are what you read when a number looks off. After that,
      // only what went wrong.
      if (d === 0 || !r.ok) console.log(line(r));
    }
  }
  const bad = rows.filter((r) => !r.ok).length;
  console.log(
    `${bad ? 'FAIL' : 'PASS'} ${dayLabel(day)} ${day}  ` +
      `${rows.length - bad}/${rows.length} climbable  ` +
      `moves ${avg(rows.map((r) => r.wall.stats.moves)).toFixed(1)}  ` +
      `holds ${avg(rows.map((r) => r.wall.stats.total)).toFixed(0)}  ` +
      `worstViolation ${Math.max(...rows.map((r) => r.worst)).toFixed(2)}u  ` +
      `gen ${avg(rows.map((r) => r.genMs)).toFixed(0)}ms/problem` +
      (d === 0 ? '\n' : ''),
  );
}

console.log(
  failures === 0
    ? `\nAll ${problems} problems climbable and toppable (tolerance ${T.GEN_TOLERANCE}u).`
    : `\n${failures}/${problems} problems FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);
