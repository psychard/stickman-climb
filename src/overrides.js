/**
 * Applying tuning overrides to `T`, by dotted path.
 *
 * This lives in `src/` for the same reason `dayArg` does: it is shared by the
 * game (via src/tune.js), by the /__tune dev page, and by the headless tools,
 * and all of them have to agree about what a path means and which paths are
 * refused. It must therefore stay **browser-safe** -- no `node:` imports, no
 * `process`. The Node half of the CLI story (reading a --preset file) lives in
 * tools/overrides-cli.mjs.
 *
 * It is not part of the shipped game: only src/tune.js imports it, and that is
 * reached through a DEV-gated dynamic import.
 *
 * The whole reason any of this works with no refactoring is that `T` is a plain
 * unfrozen object and every one of its ~230 reads across src/ happens inside a
 * function body, at call time. Nothing captures a value at module scope, so a
 * write here is visible on the very next frame.
 */

/**
 * Paths that may never be overridden, each with the reason -- which is shown in
 * the tuner UI and printed by the tools, because "refused" without a reason just
 * reads as a bug in the rig.
 *
 * These are safety properties of the simulation rather than rig metadata, which
 * is why they live here and not in the tuner's schema.
 */
export const LOCKED = new Map([
  [
    'SUB_DT',
    'physics substeps must be whole: the solver derives velocity as delta/dt, so a ' +
      'short timestep turns a rounding-sized position delta into a 2000 unit/s impulse',
  ],
  ['MAX_SUBSTEPS', 'bounds the catch-up loop, not the feel; see SUB_DT'],
  [
    'WALL_W',
    'every measured number in tuning.js is denominated in world units, so moving this ' +
      'invalidates the whole file at once',
  ],
  ['GROUND_Y', 'the origin of the coordinate system, not a knob'],
  ['REF_DAY', 'the harness pins this deliberately; use --day= or __game.setDay()'],
  ['HISTORY_DAYS', 'the shape of stored progress, not the feel of anything'],
  ['PROBLEMS_PER_LEVEL', 'menu layout and the tick key space depend on it'],
]);

/** Split a dotted path, tolerating numeric array indices: `LEVELS.0.floor`. */
function segments(path) {
  return String(path).split('.');
}

/** Read the value at a dotted path, or `undefined` if any segment is missing. */
export function getPath(target, path) {
  let node = target;
  for (const seg of segments(path)) {
    if (node === null || typeof node !== 'object' || !Object.hasOwn(node, seg)) return undefined;
    node = node[seg];
  }
  return node;
}

/**
 * Write one value, refusing anything suspicious rather than coercing it.
 *
 * Returns `{ ok: true, from }` or `{ ok: false, error }`. Four rules, and every
 * one of them is a refusal on purpose -- a typo in a path has to surface as an
 * error on the phone and in the tuner, never as a silent no-op that leaves you
 * wondering why the slider does nothing.
 *
 *   1. Intermediate segments must already exist and be objects. We never create
 *      a key: `T` is the schema.
 *   2. The leaf must already exist and its type must match, and a number must be
 *      finite -- a NaN reaching the solver is unrecoverable and silent.
 *   3. Leaves only. `wall.style` holds a live reference into `T.STYLES`,
 *      `specFor` hands out `T.ARM`/`T.LEG` by reference, and render.js reads
 *      `T.COL.*` every frame; replacing a container would leave those readers
 *      pointed at the old object. `T.ARM.max` works by construction.
 *   4. LOCKED paths are refused outright.
 */
export function setPath(target, path, value) {
  const segs = segments(path);
  const locked = LOCKED.get(segs[0]);
  if (locked) return { ok: false, error: `${segs[0]} is locked: ${locked}` };

  let node = target;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i];
    if (node === null || typeof node !== 'object' || !Object.hasOwn(node, seg)) {
      return { ok: false, error: `no such path: ${path} (stopped at ${seg})` };
    }
    node = node[seg];
  }

  const leaf = segs[segs.length - 1];
  if (node === null || typeof node !== 'object' || !Object.hasOwn(node, leaf)) {
    return { ok: false, error: `no such path: ${path} (no leaf ${leaf})` };
  }
  const from = node[leaf];
  if (from !== null && typeof from === 'object') {
    return { ok: false, error: `${path} is a container, not a leaf` };
  }
  if (typeof value !== typeof from) {
    return { ok: false, error: `${path} is ${typeof from}, got ${typeof value}` };
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return { ok: false, error: `${path} must be finite, got ${value}` };
  }

  node[leaf] = value;
  return { ok: true, from };
}

/**
 * Apply a **complete** desired override map, restoring anything absent from it.
 *
 * `values` is always the whole set the sender wants in force, never a delta.
 * That single convention is what makes a phone reload, an A/B slot switch, a
 * second phone and a dropped message all the same problem: diff against what is
 * currently applied, and put back what is no longer asked for. Anything else
 * silently inherits the previous slot's values, which would make an A/B
 * comparison a lie.
 *
 * `baseline` is a Map of path -> the value read out of the module before it was
 * first touched, so a reset is exact rather than "whatever I think the default
 * was". Entries are dropped as they are restored.
 */
export function applyOverrides(target, values, baseline) {
  const applied = [];
  const errors = [];

  for (const [path, value] of Object.entries(values)) {
    const had = baseline.has(path);
    const before = had ? undefined : getPath(target, path);
    const res = setPath(target, path, value);
    if (!res.ok) {
      errors.push({ path, error: res.error });
      continue;
    }
    if (!had) baseline.set(path, before);
    if (res.from !== value) applied.push({ path, from: res.from, to: value });
  }

  for (const path of [...baseline.keys()]) {
    if (Object.hasOwn(values, path)) continue;
    const res = setPath(target, path, baseline.get(path));
    if (res.ok && res.from !== baseline.get(path)) {
      applied.push({ path, from: res.from, to: baseline.get(path), restored: true });
    }
    baseline.delete(path);
  }

  return { applied, errors };
}

/** One-line summary for a banner: `3 overrides: REST_STRAIN=0.31 CAM_LERP=8 ...`. */
export function describeOverrides(values) {
  const entries = Object.entries(values);
  if (!entries.length) return 'no overrides';
  const parts = entries.map(([path, value]) => `${path}=${value}`);
  return `${entries.length} override${entries.length === 1 ? '' : 's'}: ${parts.join(' ')}`;
}

/**
 * `--set PATH=VALUE` off a command line, repeatable. The dayArg precedent in
 * src/day.js is the model: a CLI concern that lives in src/ because the game, the
 * tuner and all seven tools have to agree what a path means.
 *
 * Values are parsed as JSON first so `--set STYLES.1.pull=0.7` and
 * `--set COL.text='"#fff"'` both work, falling back to the raw string.
 */
export function parseSetArgs(argv) {
  const out = {};
  // Indexed, NOT `for (const arg of argv)` with `argv.indexOf(arg)`. indexOf finds
  // the *first* matching string, so with two space-form flags -- `--set A=1 --set
  // B=2` -- the second lookup returned `A=1` again and B was silently dropped.
  // Silently, which is the failure this whole CLI exists to make impossible.
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--set')) continue;
    // Both `--set K=V` and `--set=K=V` are natural to type.
    const body = arg.startsWith('--set=') ? arg.slice(6) : argv[++i];
    if (!body || !body.includes('=')) {
      throw new Error(`--set wants PATH=VALUE, got "${body ?? ''}"`);
    }
    const eq = body.indexOf('=');
    const path = body.slice(0, eq).trim();
    const raw = body.slice(eq + 1).trim();
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      value = raw;
    }
    out[path] = value;
  }
  return out;
}
