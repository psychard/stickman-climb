/**
 * The Node half of `--set` / `--preset` for the seven headless tools.
 *
 * Split from src/overrides.js because that module must stay browser-loadable (the
 * game and the tuner page both import it) and reading a preset file needs `fs`.
 *
 * **Why this exists at all:** the tuner makes it easy to find a value that feels
 * good, and CLAUDE.md records two cases where the knob that killed a symptom made
 * the mechanic worse -- the foot push at 0.1 stopped the bouncing and left the
 * figure hanging off its arms; the drag at gain 1.0 stopped the ringing and dropped
 * one grab in four. So the loop has to close: feel it on the phone, export the
 * slot, and let `sim`/`jitter`/`ladder` have an opinion before it lands.
 *
 * Two rules here are load-bearing:
 *
 *  - **Call it ABOVE `dayArg`.** All seven tools evaluate
 *    `const DAY = dayArg(process.argv, T.REF_DAY)` at module scope, so anything
 *    overriding a constant that a module-scope const reads has to run first.
 *  - **Shout, in the header and the footer.** These tools' output gets pasted into
 *    tuning.js comments as the justification for a value. A `sim` run at
 *    `--set DRAG_PULL=3.0` that reads like a baseline measurement is precisely the
 *    failure this repo's discipline exists to prevent.
 */

import { readFileSync } from 'node:fs';
import { T } from '../src/tuning.js';
import { applyOverrides, parseSetArgs, describeOverrides, LOCKED } from '../src/overrides.js';

const BANNER = '='.repeat(78);

/**
 * Read `--preset file.json` and `--set PATH=VALUE` off argv, apply them to T, and
 * print a banner. Returns the map applied (empty when there was nothing to do, so
 * the caller can stay quiet on the normal path).
 */
export function applyCliOverrides(argv = process.argv) {
  try {
    return applyOrThrow(argv);
  } catch (err) {
    // A tidy one-liner rather than a stack: this is always a typo in a command, and
    // the stack tells you nothing you want. `applyOrThrow` stays exported so the
    // behaviour is still testable without a subprocess.
    console.error(`\n  ${err.message}\n`);
    process.exit(2);
  }
}

export function applyOrThrow(argv = process.argv) {
  const file = presetPath(argv);
  let values = {};

  if (file) {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    // Accept either a bare map or the tuner's slot export shape.
    values = parsed.values ?? parsed.slots?.[parsed.active ?? 'A'] ?? parsed;
    if (typeof values !== 'object' || values === null) {
      throw new Error(`--preset ${file} does not contain an override map`);
    }
  }

  Object.assign(values, parseSetArgs(argv));
  // A --preset naming an empty map, or a slot saved with nothing set, would
  // otherwise run silently as a baseline while you believed it was overridden.
  if (file && !Object.keys(values).length) {
    throw new Error(`--preset ${file} contains no overrides`);
  }
  if (!Object.keys(values).length) return {};

  for (const path of Object.keys(values)) {
    const locked = LOCKED.get(path.split('.')[0]);
    if (locked) throw new Error(`refusing --set ${path}: ${locked}`);
  }

  const { applied, errors } = applyOverrides(T, values, new Map());
  if (errors.length) {
    throw new Error(errors.map((e) => `refusing --set ${e.path}: ${e.error}`).join('\n  '));
  }

  console.log(`\n${BANNER}`);
  console.log(`  OVERRIDDEN RUN -- these numbers are NOT a baseline`);
  if (file) console.log(`  preset: ${file}`);
  for (const a of applied) console.log(`  ${a.path}: ${a.from} -> ${a.to}`);
  console.log(BANNER);
  return values;
}

/**
 * `--preset FILE` and `--preset=FILE`, matching how parseSetArgs takes `--set`.
 *
 * Only the `=` form used to be recognised, so `npm run sim -- --preset slot-A.json`
 * ran as a clean baseline and said nothing about it -- the tool printing exactly the
 * numbers you would then paste into tuning.js as justification for a value it had
 * never actually applied. A flag that names nothing is an error, not a no-op.
 */
function presetPath(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--preset=')) return arg.slice(9);
    if (arg === '--preset') {
      const next = argv[i + 1];
      if (!next || next.startsWith('-')) throw new Error('--preset wants a file path');
      return next;
    }
  }
  return null;
}

/**
 * The tool's own positional arguments, with the override flags AND the values of
 * their space forms removed. `positionalArgs(process.argv)` -- it slices off the
 * node and script entries itself, the way applyCliOverrides reads the whole argv.
 *
 * This exists because filtering on `startsWith('--')` is not enough, and both
 * tools that take a positional argument had the same hole. In `--set WEDGE_BUDGET=10`
 * the flag is dropped and its VALUE survives the filter, so it lands in argv[0]
 * where the tool is looking for a count:
 *
 *   npm run fuzz -- --set WEDGE_BUDGET=10     -> Number('WEDGE_BUDGET=10') is NaN,
 *                                                Array.from({length: NaN}) is [],
 *                                                "0 runs, 0 settled with problems",
 *                                                exit 0
 *   npm run verify -- --set QUALITY_ROUTE.hard=0.2
 *                                             -> "sweeping NaN days",
 *                                                "All 0 problems climbable", exit 0
 *
 * The override banner printed correctly in both cases, so the run announced that it
 * was overridden and then said nothing about having measured nothing. A gate that
 * exits 0 having done no work is worse than one that is too strict, and `verify` is
 * the climbability proof -- exactly the thing README tells you to re-run under a
 * `--preset` before landing a generation constant. Same lesson as `presetPath`
 * above, one layer out: the space form of a flag is two argv entries, not one.
 */
export function positionalArgs(argv = process.argv) {
  const out = [];
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    // the space forms take the next entry as their value; skip both
    if (arg === '--set' || arg === '--preset') {
      i++;
      continue;
    }
    if (arg.startsWith('-')) continue;
    out.push(arg);
  }
  return out;
}

/** Print the same warning again at the end, where the numbers actually are. */
export function overrideFooter(values) {
  if (!values || !Object.keys(values).length) return;
  console.log(`${BANNER}`);
  console.log(`  OVERRIDDEN RUN -- ${describeOverrides(values)}`);
  console.log(`  do not paste these numbers into tuning.js as measured values`);
  console.log(`${BANNER}\n`);
}
