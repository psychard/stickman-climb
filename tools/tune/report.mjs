/**
 * The commit report: what it would take to land a value you liked.
 *
 * **This module reads files and never writes one.** That is a decision, not an
 * omission, and there are three reasons for it:
 *
 *  - The comments in src/tuning.js *are* most of its value -- they carry the
 *    measured numbers that justify each constant. The only mechanical rule that
 *    reliably prevents a lying file is "refuse to auto-write any key whose comment
 *    block contains a digit", and applying that rule to tuning.js disqualifies
 *    nearly every constant worth tuning. An edit that lands a new value and leaves
 *    the prose above it saying "Measured at 0.95: no bouncing left in `npm run
 *    jitter`" is worse than no edit, because now the file is wrong and committed.
 *  - Writing tuning.js triggers a Vite full reload, so the act of committing a
 *    value would interrupt the session you were measuring in -- and drop the climb.
 *  - The dev server is routinely on a public ngrok tunnel. A write endpoint on it
 *    is a remote arbitrary-write primitive on a source file. Not building one is
 *    the cheapest possible mitigation.
 *
 * So the job here is to produce a *review artifact*: the exact line to change, and
 * -- the part that matters -- every piece of prose that just became a lie, in both
 * tuning.js and CLAUDE.md. A cross-file stale-comment report is a genuinely useful
 * thing that a line editor is not.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const TUNING = fileURLToPath(new URL('../../src/tuning.js', import.meta.url));
const CLAUDE = fileURLToPath(new URL('../../CLAUDE.md', import.meta.url));

/**
 * Map every dotted path in a nested object literal to the line it is defined on.
 *
 * A character scan rather than a line scan, because tuning.js is not one key per
 * line: `ARM: { max: 68, pref: 50, min: 22, bone: 34 }` holds four leaves on one,
 * and a line-based version silently found none of them (83 of the 224 leaves).
 * Comments and string bodies are skipped, since both contain braces of their own --
 * `'rgba(255,209,102,0.16)'`, and half the prose in that file.
 *
 * Array elements are numbered as they open, so LEVELS.0.floor and STYLES.1.cross
 * resolve too. A ternary's colon can register a spurious path (`lo`, `hi` in the
 * clamp helpers), which is harmless: nothing looks up a path that isn't in T.
 */
export function locate(source) {
  const at = new Map();
  /** Frames: `name` is the path segment (null for a bare block), plus array state. */
  const stack = [];
  let pending = null;
  let line = 1;

  const prefix = () =>
    stack
      .map((f) => f.name)
      .filter((n) => n !== null)
      .join('.');

  for (let i = 0; i < source.length; i++) {
    const c = source[i];

    if (c === '\n') {
      line++;
      continue;
    }

    // line comment
    if (c === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      i--;
      continue;
    }
    // block comment
    if (c === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') line++;
        i++;
      }
      i++;
      continue;
    }
    // string of any flavour
    if (c === '"' || c === "'" || c === '`') {
      i++;
      while (i < source.length && source[i] !== c) {
        if (source[i] === '\\') i++;
        else if (source[i] === '\n') line++;
        i++;
      }
      continue;
    }

    if (c === '{' || c === '[') {
      let name = pending;
      const parent = stack[stack.length - 1];
      // An unnamed `{` directly inside an array is that array's next element.
      if (name === null && parent?.isArray) name = String(parent.nextIndex++);
      stack.push({ name, isArray: c === '[', nextIndex: 0 });
      pending = null;
      continue;
    }
    if (c === '}' || c === ']') {
      stack.pop();
      pending = null;
      continue;
    }
    if (c === ',') {
      pending = null;
      continue;
    }

    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < source.length && /[\w$]/.test(source[j])) j++;
      // Look ahead on THIS line only -- a key and its colon are never split here,
      // and scanning past a newline would double-count it.
      let k = j;
      while (k < source.length && (source[k] === ' ' || source[k] === '\t')) k++;
      if (source[k] === ':') {
        const ident = source.slice(i, j);
        at.set(prefix() ? `${prefix()}.${ident}` : ident, line);
        pending = ident;
        i = k;
        continue;
      }
      i = j - 1;
      continue;
    }
  }

  return at;
}

/**
 * The contiguous run of comment lines immediately above a definition -- `//` lines
 * or a `/** *\/` block. This is the deliverable: it is the prose that has to be
 * re-read, and possibly re-measured, before the new value can honestly land.
 */
export function commentAbove(lines, lineNo) {
  const out = [];
  for (let i = lineNo - 2; i >= 0; i--) {
    const t = lines[i].trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/**') || t.startsWith('*/')) {
      // A section divider (`// ------ camera ---`) is a heading, not a claim about
      // the constant below it, and reporting it as suspect is noise.
      if (/^\/\/\s*-{4,}/.test(t)) break;
      out.unshift(lines[i]);
      if (t.startsWith('/**')) break;
      continue;
    }
    break;
  }
  return out;
}

/**
 * Swap one numeric literal on a definition line, keeping everything else -- the
 * indentation, any sibling keys, any trailing comment -- byte-identical.
 *
 * It has to target the named key rather than the line's first one, because a line
 * is not always one key: `ARM: { straight: 0.92, folded: 0.42 },` holds two, and
 * anchoring on the first would either fail or rewrite the wrong number.
 */
export function proposeLine(line, key, value) {
  const re = new RegExp(`(\\b${key}\\s*:\\s*)(-?[\\d.]+(?:e-?\\d+)?)`);
  if (!re.test(line)) return null;
  return line.replace(re, `$1${value}`);
}

/** Lines mentioning `name`, as `file:line` plus the text, excluding its own definition. */
function mentions(source, file, name, skipLine) {
  const out = [];
  source.split('\n').forEach((line, i) => {
    if (i + 1 === skipLine) return;
    if (!line.includes(name)) return;
    out.push({ file, line: i + 1, text: line.trim() });
  });
  return out;
}

/** Does a comment block cite a number? If so, moving the value makes it suspect. */
export function citesNumbers(comment) {
  return comment.some((l) => /\d/.test(l.replace(/^\s*\/?\*+\s?/, '')));
}

/**
 * Build the report for one changed path.
 *
 * `invalidates` comes from the tuner's schema (which npm tool settles this class of
 * constant). `ladder` gets an extra nudge because the table it prints lives in
 * tuning.js as a comment, so its output is literally part of the file being changed.
 */
export function reportFor(path, value, invalidates = []) {
  const tuning = readFileSync(TUNING, 'utf8');
  const claude = readFileSync(CLAUDE, 'utf8');
  const lines = tuning.split('\n');

  const at = locate(tuning);
  const lineNo = at.get(path);
  if (!lineNo) return { path, value, error: `could not locate ${path} in src/tuning.js` };

  const current = lines[lineNo - 1];
  const segs = path.split('.');
  const leaf = segs[segs.length - 1];
  const name = segs[0];

  // A nested leaf usually has no comment of its own -- `FLEX.ARM.folded` sits on
  // `ARM: { straight: 0.92, folded: 0.42 },` with `FLEX: {` directly above it. The
  // prose that justifies it is on the nearest ancestor that has any, so walk out
  // until something is found, and say which key it was attached to.
  let comment = commentAbove(lines, lineNo);
  let commentFor = path;
  for (let n = segs.length - 1; n > 0 && !comment.length; n--) {
    const ancestor = segs.slice(0, n).join('.');
    const ancestorLine = at.get(ancestor);
    if (!ancestorLine) continue;
    comment = commentAbove(lines, ancestorLine);
    commentFor = ancestor;
  }

  const tools = [...invalidates];
  const notes = [];
  if (tools.includes('ladder')) {
    notes.push('the LEVELS table in tuning.js is `ladder`’s own output — regenerate it');
  }
  if (citesNumbers(comment)) {
    notes.push('the comment above this key cites numbers, so it is now suspect');
  }

  return {
    path,
    value,
    lineNo,
    current,
    proposed: proposeLine(current, leaf, value),
    comment,
    commentFor,
    commentSuspect: citesNumbers(comment),
    invalidates: tools,
    notes,
    // Every other place the constant is named. CLAUDE.md carries measured numbers
    // too -- the ladder table, "about the best 35% recover", "92-96% plant rate" --
    // and the standing rule is to update what you invalidated "here and in the
    // tuning comments".
    mentions: [
      ...mentions(tuning, 'src/tuning.js', name, lineNo),
      ...mentions(claude, 'CLAUDE.md', name, null),
    ],
  };
}

/** The whole report, plus a markdown rendering ready to paste into a commit. */
export function buildReport(values, groupFor) {
  const items = Object.entries(values).map(([path, value]) =>
    reportFor(path, value, groupFor?.(path)?.invalidates ?? []),
  );
  const tools = [...new Set(items.flatMap((i) => i.invalidates ?? []))];
  return { items, tools, markdown: markdown(items, tools) };
}

function markdown(items, tools) {
  const out = ['# tuning changes to land', ''];
  for (const it of items) {
    if (it.error) {
      out.push(`## ${it.path}`, `ERROR: ${it.error}`, '');
      continue;
    }
    out.push(`## ${it.path} → ${it.value}`, '');
    out.push('```diff');
    out.push(`--- src/tuning.js:${it.lineNo}`);
    out.push(`- ${it.current.trim()}`);
    out.push(`+ ${it.proposed?.trim() ?? '(could not rewrite this line automatically)'}`);
    out.push('```', '');
    if (it.comment.length) {
      const whose = it.commentFor === it.path ? '' : ` (attached to \`${it.commentFor}\`)`;
      out.push(
        it.commentSuspect
          ? `**Comment above${whose} — NOW SUSPECT:**`
          : `Comment above${whose}:`,
      );
      out.push('```js', ...it.comment, '```', '');
    }
    if (it.mentions.length) {
      out.push('Also mentioned at:');
      for (const m of it.mentions.slice(0, 12)) {
        out.push(`- \`${m.file}:${m.line}\` ${m.text.slice(0, 150)}`);
      }
      if (it.mentions.length > 12) out.push(`- …and ${it.mentions.length - 12} more`);
      out.push('');
    }
    for (const n of it.notes) out.push(`> ${n}`);
    if (it.notes.length) out.push('');
  }
  if (tools.length) {
    out.push('## re-run before committing', '', '```bash');
    for (const t of tools) out.push(`npm run ${t}`);
    out.push('```', '');
  }
  return out.join('\n');
}
