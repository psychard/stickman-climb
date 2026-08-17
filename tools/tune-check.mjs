/**
 * Does the tuner's schema still describe src/tuning.js?
 *
 * Two directions, and the second is the one that matters. Checking that every
 * schema path exists catches a renamed or deleted constant, which you would find
 * anyway the first time you opened the tuner and saw an error. Checking that
 * every leaf in T is *accounted for* catches a constant somebody added and nobody
 * classified -- which nothing else would ever surface, and which is how a
 * classification file quietly stops being true.
 *
 * The tune plugin runs this on dev-server start and refuses to serve /__tune if
 * it fails, so you find out at the first moment it matters. It is deliberately
 * NOT part of `npm run verify`: verify's job is proving walls climbable in front
 * of a deploy, and drift in a file that is not in the build is no reason to block
 * shipping the game.
 */

import { T } from '../src/tuning.js';
import { LOCKED } from '../src/overrides.js';
import { GROUPS, UNTUNED, DESC, tunedPaths, untunedFor, matchesPattern } from './tune/schema.js';

/** Every leaf path in an object, with its type. */
export function leaves(node, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object') out.push(...leaves(v, path));
    else out.push({ path, type: typeof v, value: v });
  }
  return out;
}

export function checkSchema() {
  const problems = [];
  const all = leaves(T);
  const byPath = new Map(all.map((l) => [l.path, l]));
  const tuned = tunedPaths();

  // --- direction 1: the schema describes things that exist and can be tuned ---
  for (const path of tuned) {
    const leaf = byPath.get(path);
    if (!leaf) {
      problems.push(`exposed but missing from T: ${path}`);
      continue;
    }
    if (leaf.type !== 'number') {
      problems.push(`exposed but not numeric: ${path} is ${leaf.type}`);
    }
    const locked = LOCKED.get(path.split('.')[0]);
    if (locked) problems.push(`exposed but LOCKED: ${path} (${locked})`);
  }

  const dupes = tuned.filter((p, i) => tuned.indexOf(p) !== i);
  for (const p of new Set(dupes)) problems.push(`exposed twice: ${p}`);

  // A slider whose meaning you cannot read is one you tune by watching the figure
  // twitch, so a knob may not be exposed without a line saying what it does.
  for (const path of tuned) {
    if (!DESC[path]) problems.push(`exposed but undescribed: ${path} -- add it to DESC`);
  }
  for (const path of Object.keys(DESC)) {
    if (!tuned.includes(path)) problems.push(`DESC describes something not exposed: ${path}`);
  }

  for (const path of tuned) {
    const u = untunedFor(path);
    if (u) problems.push(`both exposed and UNTUNED (${u.why}): ${path}`);
  }

  // --- direction 2: every leaf in T is accounted for by one list or the other ---
  for (const { path } of all) {
    if (tuned.includes(path)) continue;
    if (untunedFor(path)) continue;
    problems.push(
      `unclassified: ${path} -- add it to a GROUP in tools/tune/schema.js, or to UNTUNED with a reason`,
    );
  }

  // --- and every pattern earns its keep, so deletions surface too ---
  for (const group of UNTUNED) {
    for (const pattern of group.keys) {
      const hit = all.some((l) => matchesPattern(l.path, pattern));
      if (!hit) problems.push(`UNTUNED pattern matches nothing (${group.why}): ${pattern}`);
    }
  }

  // LOCKED is the simulation's own safety list; it should be a real path too.
  for (const key of LOCKED.keys()) {
    if (!byPath.has(key)) problems.push(`LOCKED names a path not in T: ${key}`);
  }

  return { problems, counts: counts(all, tuned) };
}

function counts(all, tuned) {
  const byWhy = new Map();
  for (const { path } of all) {
    if (tuned.includes(path)) continue;
    const u = untunedFor(path);
    const why = u ? u.why : 'UNCLASSIFIED';
    byWhy.set(why, (byWhy.get(why) ?? 0) + 1);
  }
  return {
    leaves: all.length,
    numbers: all.filter((l) => l.type === 'number').length,
    exposed: tuned.length,
    byWhy: [...byWhy.entries()].sort((a, b) => b[1] - a[1]),
  };
}

// --------------------------------------------------------------------- as a CLI

const main = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (main) {
  const { problems, counts: c } = checkSchema();

  console.log(`\ntuning.js: ${c.leaves} leaves (${c.numbers} numeric)`);
  for (const group of GROUPS) {
    console.log(`  ${group.class.padEnd(12)} ${String(group.keys.length).padStart(3)} exposed` +
      (group.invalidates.length ? `   re-run: ${group.invalidates.join(', ')}` : ''));
  }
  console.log(`  ${'—'.repeat(12)} ${String(c.exposed).padStart(3)} exposed in total`);
  for (const [why, n] of c.byWhy) {
    console.log(`  ${why.padEnd(12)} ${String(n).padStart(3)} not exposed`);
  }

  if (problems.length) {
    console.error(`\n${problems.length} problem${problems.length === 1 ? '' : 's'}:`);
    for (const p of problems) console.error(`  ✗ ${p}`);
    console.error('');
    process.exit(1);
  }
  console.log('\nschema describes tuning.js exactly.\n');
}
