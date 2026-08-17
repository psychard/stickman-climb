/**
 * The tuner UI. Runs on a laptop; the game it drives runs on a phone.
 *
 * It imports src/tuning.js purely to read the **committed defaults** -- what a
 * slider's range is derived from, what "changed" is measured against, and what a
 * reset returns to. It never treats itself as the source of truth for what is
 * currently in force: that is the dev server, because this page and the phone
 * both reload and the server does not.
 */

import { T } from '/src/tuning.js';
import { getPath, LOCKED } from '/src/overrides.js';
import { GROUPS, SPAN, UNIT, DESC } from './schema.js';

// ------------------------------------------------------------------- transport

const hot = import.meta.hot;
const origin = `tuner-${Math.random().toString(36).slice(2, 8)}`;

/** What the server says is in force. Mirrored, never authoritative. */
let live = { rev: null, active: 'A', values: {}, slots: { A: {}, B: {} } };
let sessionLog = [];
/** Paths whose slider is under the pointer right now; server echoes are ignored. */
const holding = new Set();

/** Last telemetry sample from the game, and when it landed here. */
let lastReadout = null;
let lastReadoutAt = 0;
let lastReport = null;

const els = new Map();
const $ = (id) => document.getElementById(id);

function send(event, data) {
  hot?.send(event, { ...data, origin });
}

function setConn(text, cls) {
  const el = $('conn');
  el.textContent = text;
  el.className = `pill ${cls}`;
}

if (hot) {
  const adopt = (s) => {
    live = {
      rev: s.rev,
      active: s.active ?? live.active,
      values: s.values ?? {},
      slots: s.slots ?? live.slots,
    };
    if (s.log) sessionLog = s.log;
    syncAll();
  };
  hot.on('climb:state', adopt);
  hot.on('climb:apply', adopt);
  hot.on('climb:slots', (s) => adopt({ ...live, ...s }));
  hot.on('climb:log', (s) => {
    sessionLog = s.log ?? [];
  });
  hot.on('climb:report', (s) => {
    lastReport = s;
    $('report').hidden = false;
    $('report-body').textContent = s.error
      ? `could not build the report: ${s.error}`
      : (s.markdown || 'nothing is overridden — nothing to land.');
  });
  // Re-announce on every reconnect, not just at load: this handler fires again
  // when the socket comes back, which is exactly when we are out of date.
  hot.on('vite:ws:connect', () => {
    setConn('connected', 'live');
    send('climb:hello', { role: 'tuner' });
  });
  hot.on('vite:ws:disconnect', () => setConn('disconnected', 'stale'));
  hot.on('climb:readout', (d) => {
    lastReadout = d;
    lastReadoutAt = performance.now();
  });
  send('climb:hello', { role: 'tuner' });

  // Presence heartbeat. The game sends no telemetry at all until it is told to, and
  // there is no per-client disconnect event on the hot channel -- so "a tuner is
  // open" is this message arriving, and closing the tab is it stopping.
  const beat = () => send('climb:watch', { hz: 4 });
  beat();
  setInterval(beat, 3000);
  // Browsers throttle setInterval hard in a background tab -- past the server's
  // staleness window -- so a backgrounded tuner correctly stops telemetry and saves
  // the phone the work. Beat immediately on coming back, or returning to this tab
  // would sit on a dead readout waiting for the next tick.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) beat();
  });
} else {
  setConn('no hmr channel', 'stale');
}

// ------------------------------------------------------------------ the ranges

function niceStep(span) {
  const raw = span / 200;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const snapped = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return snapped * mag;
}

function rangeFor(path, def) {
  // Ranges are always derived, never stored -- see the header of schema.js. A
  // UNIT constant is a 0..1 fraction by meaning, which stays true however its
  // value moves; SPAN holds multipliers of whatever the file currently says.
  const mult = SPAN[path];
  let lo = mult ? def * mult[0] : 0;
  let hi = mult ? def * mult[1] : def * 2;
  if (UNIT.has(path)) {
    lo = 0;
    hi = 1;
  }
  if (def === 0 && hi === 0) {
    lo = 0;
    hi = 1;
  }
  if (hi <= lo) [lo, hi] = [hi, lo];

  // Anchor the ladder of steps ON the default, rather than on the low end. A
  // range input snaps to `min + n*step`, so a min derived from a multiplier
  // generally puts the committed value between two rungs -- the slider then
  // reads 0.259 for a default of 0.26, and dragging can never get back to the
  // number that is actually in the file.
  const step = niceStep(hi - lo);
  lo = def - Math.ceil((def - lo) / step) * step;
  hi = def + Math.ceil((hi - def) / step) * step;
  return { lo: round(lo, step), hi: round(hi, step), step };
}

/** Trim the float noise that `def - n*step` leaves behind (0.10400000000000001). */
function round(v, step) {
  const dp = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  return Number(v.toFixed(dp));
}

// ---------------------------------------------------------------------- render

function buildRow(group, path) {
  const def = getPath(T, path);
  if (typeof def !== 'number') {
    return { error: `${path}: not a numeric leaf in T (got ${typeof def})` };
  }
  const locked = LOCKED.get(path.split('.')[0]);
  if (locked) return { error: `${path}: locked — ${locked}` };

  const { lo, hi, step } = rangeFor(path, def);

  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `
    <span class="name">${path} <span class="from">${def}</span></span>
    <input type="range" min="${lo}" max="${hi}" step="${step}" value="${def}" />
    <input type="number" step="${step}" value="${def}" />
    <button class="reset" title="back to ${def}">↺</button>
    <span class="desc">${DESC[path] ?? ''}</span>`;

  const [range, num] = row.querySelectorAll('input');
  const reset = row.querySelector('.reset');

  const push = (v) => {
    const value = Number(v);
    if (!Number.isFinite(value)) return;
    range.value = value;
    num.value = value;
    row.classList.toggle('changed', value !== def);
    send('climb:set', { path, value: value === def ? null : value });
  };

  range.addEventListener('pointerdown', () => holding.add(path));
  range.addEventListener('pointerup', () => holding.delete(path));
  range.addEventListener('pointercancel', () => holding.delete(path));
  range.addEventListener('input', () => push(range.value));
  num.addEventListener('change', () => push(num.value));
  reset.addEventListener('click', () => push(def));

  els.set(path, { row, range, num, def, group });
  return { row };
}

function render() {
  const host = $('controls');
  const errors = [];
  for (const group of GROUPS) {
    const head = document.createElement('div');
    head.className = 'group';
    const tool = group.invalidates.length
      ? `<span class="tool">re-run: ${group.invalidates.map((t) => `npm run ${t}`).join(', ')}</span>`
      : '';
    head.innerHTML = `<span>${group.class}</span>${tool}<span>${group.note ?? ''}</span>`;
    host.appendChild(head);
    for (const path of group.keys) {
      const { row, error } = buildRow(group, path);
      if (error) {
        errors.push(error);
        continue;
      }
      host.appendChild(row);
      // The measured spread lives directly under the threshold it calibrates, so
      // the percentiles and the slider are in the same glance. Reading one without
      // the other is the trap this whole readout exists to close.
      if (path === 'REST_STRAIN') {
        const dist = document.createElement('div');
        dist.className = 'dist';
        host.appendChild(dist);
      }
    }
  }
  if (errors.length) $('errors').textContent = errors.join('\n');
}

/** Pull every control back in line with what the server says is in force. */
function syncAll() {
  $('rev').textContent = `rev ${live.rev ?? '–'}`;
  const n = Object.keys(live.values).length;
  $('count').textContent = `${n} changed`;
  $('slot-A').className = `slot${live.active === 'A' ? ' on' : ''}`;
  $('slot-B').className = `slot${live.active === 'B' ? ' on' : ''}`;
  $('copy-ab').textContent = `copy ${live.active}→${live.active === 'A' ? 'B' : 'A'}`;

  const A = live.slots?.A ?? {};
  const B = live.slots?.B ?? {};
  for (const [path, el] of els) {
    if (!holding.has(path)) {
      const value = Object.hasOwn(live.values, path) ? live.values[path] : el.def;
      el.range.value = value;
      el.num.value = value;
      el.row.classList.toggle('changed', value !== el.def);
    }
    // Mark the paths the two slots disagree about, so a blind A/B tells you what
    // you are actually comparing rather than just which letter you are in.
    const a = Object.hasOwn(A, path) ? A[path] : el.def;
    const b = Object.hasOwn(B, path) ? B[path] : el.def;
    el.row.classList.toggle('differs', a !== b);
  }
}

/** The session log as markdown, ready to paste next to a rewritten comment. */
function logMarkdown() {
  const lines = ['# tuning session', ''];
  for (const e of sessionLog) {
    const t = new Date(e.t).toISOString().slice(11, 19);
    if (e.kind === 'mark') {
      const d = e.telemetry?.dist;
      lines.push(`## ${t} MARK (slot ${e.slot}) — ${e.note || '(no note)'}`);
      const set = Object.entries(e.values);
      lines.push(set.length ? `values: ${set.map(([k, v]) => `${k}=${v}`).join(' ')}` : 'values: (defaults)');
      if (d?.n) {
        lines.push(
          `strain over ${d.n} frames: p25 ${d.p25?.toFixed(2)} median ${d.p50?.toFixed(2)} ` +
            `p90 ${d.p90?.toFixed(2)}, recovering ${Math.round(d.resting * 100)}% (rest ${d.rest})`,
        );
      }
      if (e.telemetry?.load) {
        lines.push(`arms ${Math.round(e.telemetry.load.arms * 100)}% of bodyweight`);
      }
      lines.push('');
    } else if (e.kind === 'set') {
      lines.push(`- ${t} ${e.path} ${e.from ?? '(default)'} → ${e.to ?? '(default)'} [${e.slot}]`);
    } else {
      lines.push(`- ${t} ${e.kind}${e.slot ? ` ${e.slot}` : ''}${e.path ? ` ${e.path}` : ''}`);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- the readout

const pct = (v) => (v == null ? '–' : `${Math.round(v * 100)}%`);
const num = (v, d = 2) => (v == null ? '–' : v.toFixed(d));

/**
 * Draw the live numbers from the phone.
 *
 * rAF throttles when the game's tab is backgrounded, so telemetry stops arriving
 * without anything being wrong. Greying out past a couple of seconds is what keeps
 * that from reading as a live number that happens to be frozen.
 */
function paintReadout() {
  const el = $('readout');
  const d = lastReadout;
  const age = performance.now() - lastReadoutAt;

  if (!d) {
    el.className = 'stale';
    el.textContent = hot ? 'waiting for the game — open it in another tab or on a phone' : '';
  } else {
    el.className = age > 2000 ? 'stale' : '';
    const s = d.strain;
    const l = d.load;
    el.innerHTML = [
      `<span>${d.problemLabel ?? d.state}</span>`,
      s ? `<span>strain <b>${num(s.smooth)}</b> ${s.smooth < d.dist.rest ? '▲' : '▼'}</span>` : '',
      s ? `<span>stam <b>${num(s.value)}</b></span>` : '',
      s
        ? `<span>hold ${num(s.hold)} flex ${num(s.flex)} bal ${num(s.balance)} arms ${num(s.armLoad)}</span>`
        : '',
      l ? `<span>arms <b>${pct(l.arms)}</b> feet ${pct(l.LF + l.RF)}</span>` : '',
      `<span>fps ${num(d.fps, 0)} · upd ${num(d.msUpdate)} ren ${num(d.msRender)} tune <b>${num(d.msTune)}</b>ms</span>`,
      `<span>rev ${d.rev ?? '–'}</span>`,
    ]
      .filter(Boolean)
      .join('');
  }

  // The distribution, beside the constant it exists to justify.
  const host = document.querySelector('.dist');
  if (host) {
    const dist = d?.dist;
    if (!dist || !dist.n) {
      host.innerHTML = `<span class="thin">no samples yet — climb for a few seconds</span>`;
    } else {
      const thin = dist.n < 240 ? ' class="thin"' : '';
      host.innerHTML =
        `strain over ${dist.n} frames of play: ` +
        `p25 <b>${num(dist.p25)}</b> · median <b>${num(dist.p50)}</b> · p90 <b>${num(dist.p90)}</b> · ` +
        `recovering <b>${pct(dist.resting)}</b>` +
        `<span${thin}>${dist.n < 240 ? ' (thin sample)' : ''}</span>` +
        ` — time-weighted over frames, <em>not</em> the per-stance spread <code>npm run measure</code> reports`;
    }
  }
}

$('reset-all').addEventListener('click', () => send('climb:reset', {}));
$('slot-A').addEventListener('click', () => send('climb:slot', { slot: 'A' }));
$('slot-B').addEventListener('click', () => send('climb:slot', { slot: 'B' }));
$('copy-ab').addEventListener('click', () =>
  send('climb:copy', { from: live.active, to: live.active === 'A' ? 'B' : 'A' }),
);
$('mark').addEventListener('click', () => {
  send('climb:mark', { note: $('note').value });
  $('note').value = '';
});
$('note').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('mark').click();
});
$('copy-log').addEventListener('click', async () => {
  const md = logMarkdown();
  try {
    await navigator.clipboard.writeText(md);
    flash($('copy-log'), 'copied');
  } catch {
    // Clipboard needs a secure context, which http://<lan-ip> is not -- so fall
    // back to something you can still select by hand rather than failing silently.
    const w = window.open('', '_blank');
    if (w) w.document.write(`<pre>${md.replace(/</g, '&lt;')}</pre>`);
  }
});

/**
 * Write the active slot out as the JSON `--preset` reads, which is what closes the
 * loop this rig exists inside: feel it on the phone, then let the tool that owns
 * that class of constant have an opinion before the value lands.
 *
 * A download rather than a clipboard copy, because the thing on the other end is a
 * file path on a command line -- and unlike the clipboard it works over plain http
 * on a LAN address, which is not a secure context.
 */
$('save-preset').addEventListener('click', () => {
  const values = live.values ?? {};
  if (!Object.keys(values).length) {
    flash($('save-preset'), 'nothing set');
    return;
  }
  const blob = new Blob([`${JSON.stringify(values, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `slot-${live.active}.json`;
  a.click();
  URL.revokeObjectURL(url);
  flash($('save-preset'), `slot-${live.active}.json`);
});

$('commit').addEventListener('click', () => send('climb:report', {}));
$('close-report').addEventListener('click', () => ($('report').hidden = true));
$('copy-report').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(lastReport?.markdown ?? '');
    flash($('copy-report'), 'copied');
  } catch {
    flash($('copy-report'), 'select it by hand');
  }
});

function flash(btn, text) {
  const was = btn.textContent;
  btn.textContent = text;
  setTimeout(() => (btn.textContent = was), 900);
}

render();
syncAll();
paintReadout();
setInterval(paintReadout, 250);
