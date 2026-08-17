/**
 * Drive the tune plugin's protocol against a fake Vite dev server.
 *
 * These are the properties a browser cannot easily show you, because they are
 * about what is *absent* from a message: that a broadcast carries the complete
 * desired map rather than a delta, that switching A/B does not silently inherit
 * the other slot's keys, that telemetry stays off until something is listening,
 * and that a mark pins the last sample to the value set that produced it.
 *
 * The A/B one is the whole correctness question for a comparison: inherit a key
 * and you are no longer comparing what the UI says you are.
 *
 * Run via `npm run tune:check`, alongside the schema drift check.
 */
import { climbTune } from './plugin.mjs';

const handlers = new Map();
const sent = [];
const toClient = [];
const client = { send: (event, data) => toClient.push({ event, data }) };

const server = {
  config: { server: { port: 0 }, logger: { warn: (m) => console.log('WARN', m) } },
  middlewares: { use: () => {} },
  transformIndexHtml: async (_u, h) => h,
  httpServer: { once: () => {} },
  hot: {
    on: (event, cb) => handlers.set(event, cb),
    send: (event, data) => sent.push({ event, data }),
  },
};

const plugin = climbTune();
plugin.configureServer(server);

const fire = (event, data) => handlers.get(event)?.(data, client);
const lastOf = (event) => [...sent].reverse().find((m) => m.event === event)?.data;
let failures = 0;
const ok = (label, cond, extra = '') => {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};

// --- complete-map broadcast -------------------------------------------------
fire('climb:set', { path: 'REST_STRAIN', value: 0.45 });
fire('climb:set', { path: 'CAM_LERP', value: 10 });
let a = lastOf('climb:apply');
ok('broadcast carries the whole map, not a delta',
  Object.keys(a.values).length === 2 && a.values.CAM_LERP === 10, JSON.stringify(a.values));
ok('rev advances per change', a.rev === 2, `rev=${a.rev}`);

// --- A/B: a key only A had must be ABSENT from B's map, not inherited -------
fire('climb:slot', { slot: 'B' });
fire('climb:set', { path: 'REST_STRAIN', value: 0.15 });
a = lastOf('climb:apply');
ok('switching slots does not inherit A-only keys',
  a.active === 'B' && !('CAM_LERP' in a.values) && a.values.REST_STRAIN === 0.15,
  JSON.stringify(a.values));

// --- copy seeds a comparison ------------------------------------------------
fire('climb:copy', { from: 'B', to: 'A' });
fire('climb:slot', { slot: 'A' });
a = lastOf('climb:apply');
ok('copy B->A replaces A wholesale',
  !('CAM_LERP' in a.values) && a.values.REST_STRAIN === 0.15, JSON.stringify(a.values));

// --- telemetry is off until a tuner says otherwise --------------------------
ok('no climb:hz broadcast before any tuner watches', !sent.some((m) => m.event === 'climb:hz'));
fire('climb:watch', { hz: 4 });
ok('a watching tuner turns telemetry on', lastOf('climb:hz')?.hz === 4);
fire('climb:watch', { hz: 4 });
ok('a repeated heartbeat does not re-broadcast',
  sent.filter((m) => m.event === 'climb:hz').length === 1);

// --- telemetry is relayed under a different event name ----------------------
const sample = { rev: 5, dist: { n: 1450, p25: 0.24, p50: 0.31, p90: 0.46, resting: 0.34, rest: 0.45 },
                 load: { arms: 0.2, LH: 0.11, RH: 0.09, LF: 0.4, RF: 0.4 } };
fire('climb:telemetry', sample);
ok('relayed as climb:readout, so the phone ignores its own echo',
  lastOf('climb:readout') === sample && !sent.some((m) => m.event === 'climb:telemetry'));

// --- a mark pins the numbers to the value set ------------------------------
fire('climb:mark', { note: 'this is the one' });
const log = lastOf('climb:log').log;
const mark = log.find((e) => e.kind === 'mark');
ok('mark captures the note, the values AND the last telemetry',
  mark.note === 'this is the one' &&
  mark.values.REST_STRAIN === 0.15 &&
  mark.telemetry?.dist?.n === 1450,
  `values=${JSON.stringify(mark.values)} distN=${mark.telemetry?.dist?.n}`);

// --- hello answers that client alone, with the current rate ----------------
toClient.length = 0;
fire('climb:hello', { role: 'game' });
const st = toClient.find((m) => m.event === 'climb:state')?.data;
ok('hello is answered privately, carrying the live rate',
  st && st.telemetryHz === 4 && st.values.REST_STRAIN === 0.15 && st.active === 'A');

// --- reset clears, and still broadcasts a complete (empty) map -------------
fire('climb:reset', {});
a = lastOf('climb:apply');
ok('reset broadcasts an empty complete map', Object.keys(a.values).length === 0);

if (failures) {
  console.error(`\n${failures} protocol check${failures === 1 ? '' : 's'} failed\n`);
  process.exit(1);
}
console.log('\ntune protocol OK.\n');
