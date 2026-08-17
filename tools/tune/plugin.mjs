/**
 * The live-tuning relay: a dev-server plugin that owns the override set and
 * shuttles it between the /__tune page on a laptop and the game on a phone.
 *
 * Transport is Vite's own HMR websocket, which carries custom events in both
 * directions and which the phone is already connected to over whatever tunnel is
 * serving it the page. So there is no second server, no second port, no CORS
 * story, and no new dependency -- the repo's single dependency is Vite and that
 * is worth keeping.
 *
 * Three things here are load-bearing:
 *
 * - **`apply: 'serve'`.** Together with living under tools/ (so it is neither a
 *   build input nor in public/) and being referenced by nothing in index.html,
 *   that is three independent reasons the tuner cannot reach a built site. A
 *   root tune.html would rest on exactly one -- "Vite's default build input is
 *   index.html" -- which is a default in someone else's package that a future
 *   `build.rollupOptions.input` silently revokes.
 *
 * - **The server owns the truth, not the phone and not the tuner page**, because
 *   both of them reload. Vite's client calls location.reload() when the
 *   websocket drops (client.mjs, the vite:ws:disconnect branch), so a phone
 *   screen-lock or a tunnel hiccup reloads the game mid-climb. Resync is not
 *   polish here, it is the common path.
 *
 * - **`climb:apply` always carries the complete desired map, never a delta.**
 *   See applyOverrides in src/overrides.js for why that one convention settles
 *   reload, slot switching, multiple phones and dropped messages at once.
 *
 * Overrides live only in this process's memory. Quitting the dev server is
 * therefore a full reset, and nothing is persisted on the device -- an override
 * set that survived in localStorage would be a tuned session you could pick up
 * tomorrow without knowing it.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkSchema } from '../tune-check.mjs';
import { buildReport } from './report.mjs';
import { groupFor } from './schema.js';

const PAGE = fileURLToPath(new URL('./index.html', import.meta.url));
const LOG_CAP = 500;

export function climbTune() {
  const state = {
    rev: 0,
    active: 'A',
    slots: { A: {}, B: {} },
    log: [],
  };

  /** The map currently meant to be in force. */
  const values = () => state.slots[state.active];

  /** Most recent telemetry sample, so `mark` can pin numbers to a value set. */
  let last = null;

  function note(entry) {
    state.log.push({ t: Date.now(), ...entry });
    if (state.log.length > LOG_CAP) state.log.splice(0, state.log.length - LOG_CAP);
  }

  return {
    name: 'climb-tune',
    apply: 'serve',

    configureServer(server) {
      const broadcast = (origin) => {
        state.rev++;
        server.hot.send('climb:apply', {
          rev: state.rev,
          active: state.active,
          // Always the COMPLETE desired map, never a delta. See applyOverrides.
          values: values(),
          // Both slots ride along so the tuner can show what differs without
          // asking; the game ignores this field entirely.
          slots: state.slots,
          origin,
        });
      };

      // Does the schema still describe tuning.js? Checked at start-up rather
      // than lazily, so a constant added without being classified surfaces the
      // first time the rig is opened -- which is the first moment it matters.
      const drift = checkSchema();
      if (drift.problems.length) {
        server.config.logger.warn(
          `\n  \x1b[33m[tune] schema drift -- /__tune is disabled\x1b[39m\n` +
            drift.problems.map((p) => `    ✗ ${p}`).join('\n') +
            `\n    run \x1b[1mnpm run tune:check\x1b[22m\n`,
        );
      }

      // Serve the tuner page. transformIndexHtml is what injects @vite/client,
      // which is what gives the page an import.meta.hot to talk over -- without
      // it this is a static file with no way home.
      server.middlewares.use('/__tune', async (req, res, next) => {
        if (req.url !== '/' && req.url !== '') return next();
        if (drift.problems.length) {
          res.statusCode = 503;
          res.setHeader('Content-Type', 'text/plain');
          res.end(
            `tuning schema drift -- refusing to serve a tuner that misdescribes tuning.js\n\n` +
              drift.problems.map((p) => `  ✗ ${p}`).join('\n') +
              `\n\nrun: npm run tune:check\n`,
          );
          return;
        }
        try {
          const html = await server.transformIndexHtml('/__tune', readFileSync(PAGE, 'utf8'));
          res.setHeader('Content-Type', 'text/html');
          res.setHeader('Cache-Control', 'no-store');
          res.end(html);
        } catch (err) {
          next(err);
        }
      });

      // A client announcing itself gets the current state, addressed to it alone.
      // The game sends this on every reconnect, which is the case that matters --
      // it has just reloaded and is holding nothing but the file's defaults.
      server.hot.on('climb:hello', (data, client) => {
        client.send('climb:state', {
          rev: state.rev,
          active: state.active,
          values: values(),
          slots: state.slots,
          log: state.log,
          telemetryHz: hz,
        });
      });

      server.hot.on('climb:set', (data) => {
        const { path, value, slot = state.active, origin } = data ?? {};
        if (typeof path !== 'string') return;
        const target = state.slots[slot];
        if (!target) return;
        const from = target[path];
        if (value === null || value === undefined) delete target[path];
        else target[path] = value;
        note({ kind: 'set', path, from, to: value, slot, origin });
        if (slot === state.active) broadcast(origin);
      });

      // --- telemetry, and who is listening ------------------------------------
      //
      // The game sends nothing at all unless a tuner is open, so the common case
      // (no tuner) costs literally zero frame time on the phone. There is no
      // per-client disconnect event on the hot channel, so presence is a heartbeat:
      // the tuner re-announces every few seconds and goes stale if it stops.
      const WATCH_TTL = 8000;
      let seen = 0;
      let hz = 0;

      const setHz = (next) => {
        if (next === hz) return;
        hz = next;
        server.hot.send('climb:hz', { hz });
      };

      server.hot.on('climb:watch', (data) => {
        seen = Date.now();
        setHz(Math.max(0, Math.min(10, data?.hz ?? 4)));
      });

      // Relayed under a different name than it arrives under, so the phone does not
      // spend anything processing an echo of its own sample.
      server.hot.on('climb:telemetry', (data) => {
        last = data;
        server.hot.send('climb:readout', data);
      });

      const sweep = setInterval(() => {
        if (hz && Date.now() - seen > WATCH_TTL) setHz(0);
      }, 2000);
      sweep.unref?.();
      server.httpServer?.once('close', () => clearInterval(sweep));

      server.hot.on('climb:reset', (data) => {
        const { path, slot = state.active, origin } = data ?? {};
        const target = state.slots[slot];
        if (!target) return;
        if (typeof path === 'string') {
          delete target[path];
          note({ kind: 'reset', path, slot, origin });
        } else {
          state.slots[slot] = {};
          note({ kind: 'reset-all', slot, origin });
        }
        if (slot === state.active) broadcast(origin);
      });

      // --- A/B ----------------------------------------------------------------
      //
      // Switching slots sends the complete map for the target, so a key that only
      // slot A set is RESTORED TO DEFAULT rather than silently inherited by B. That
      // is the entire correctness question for an A/B comparison, and it comes free
      // from climb:apply always being complete -- see applyOverrides.
      server.hot.on('climb:slot', (data) => {
        const slot = data?.slot;
        if (!state.slots[slot] || slot === state.active) return;
        state.active = slot;
        note({ kind: 'slot', slot, origin: data?.origin });
        broadcast(data?.origin);
      });

      server.hot.on('climb:copy', (data) => {
        const { from, to, origin } = data ?? {};
        if (!state.slots[from] || !state.slots[to] || from === to) return;
        state.slots[to] = { ...state.slots[from] };
        note({ kind: 'copy', from, to, origin });
        if (to === state.active) broadcast(origin);
        else server.hot.send('climb:slots', { slots: state.slots, active: state.active });
      });

      // A mark ties "this felt sticky" to numbers: the value set AND the last
      // telemetry sample, together, under a note you typed at the time. That pairing
      // is the raw material a rewritten tuning comment actually needs.
      server.hot.on('climb:mark', (data) => {
        note({
          kind: 'mark',
          note: String(data?.note ?? '').slice(0, 500),
          slot: state.active,
          values: { ...values() },
          telemetry: last,
          origin: data?.origin,
        });
        server.hot.send('climb:log', { log: state.log });
      });

      server.hot.on('climb:log', (data, client) => {
        client.send('climb:log', { log: state.log });
      });

      // What it would take to land these values. Reads src/tuning.js and CLAUDE.md;
      // writes nothing, ever -- see the header of report.mjs for why that is a
      // decision rather than an omission. Notably, this endpoint is reachable by
      // anyone holding the ngrok URL, which is exactly the argument for it staying
      // read-only.
      server.hot.on('climb:report', (data, client) => {
        try {
          client.send('climb:report', buildReport(values(), groupFor));
        } catch (err) {
          client.send('climb:report', { error: String(err?.message ?? err), items: [] });
        }
      });

      server.httpServer?.once('listening', () => {
        const port = server.config.server.port;
        // eslint-disable-next-line no-console
        console.log(
          `\n  \x1b[36m➜\x1b[39m  \x1b[1mtune\x1b[22m:    http://localhost:${port}/__tune` +
            `\n     \x1b[2mediting src/tuning.js reloads the phone and re-bases every override\x1b[22m\n`,
        );
      });
    },
  };
}
