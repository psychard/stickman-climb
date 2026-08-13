import { defineConfig } from 'vite';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Stamp `dist/sw.js` with what this build actually contains.
 *
 * `public/sw.js` is a template with two placeholders; it is copied verbatim by
 * Vite and rewritten here, so the deployed worker knows its own build id and the
 * list of files to precache. Doing it at build time is what makes the update
 * prompt work at all: the browser only looks for a new worker when the bytes of
 * sw.js change, so the id has to move whenever anything else does.
 *
 * The id hashes *everything* emitted (icons included) while the precache list is
 * only the HTML and the bundle -- an icon change should invalidate the cache
 * without adding 100KB of Android launcher icons to the first load.
 */
function serviceWorker() {
  return {
    name: 'climb-service-worker',
    apply: 'build',
    // closeBundle, not writeBundle: the public/ files (this template among them)
    // are copied after the bundle is written, and hashing has to see all of it.
    closeBundle() {
      const dir = 'dist';
      const files = walk(dir, '').filter((f) => f !== 'sw.js');
      const path = join(dir, 'sw.js');
      const template = readFileSync(path, 'utf8');

      const hash = createHash('sha256');
      for (const f of files.sort()) hash.update(f).update(readFileSync(join(dir, f)));
      // The worker's own logic counts as part of the build, hashed before it is
      // stamped to keep that from being circular. Without this a fix to the
      // worker inherits the previous build's cache, which is where a fix to how
      // the cache is read would be least welcome.
      hash.update(template);
      const build = hash.digest('hex').slice(0, 12);
      const shell = ['/index.html', ...files.filter((f) => f.startsWith('assets/')).map((f) => `/${f}`)];

      const src = template
        .replace("'__CLIMB_BUILD__'", JSON.stringify(build))
        .replace('__CLIMB_SHELL__', JSON.stringify(shell));
      writeFileSync(path, src);
      this.info(`service worker: build ${build}, ${shell.length} files precached`);
    },
  };
}

function walk(dir, prefix) {
  return readdirSync(join(dir, prefix)).flatMap((name) => {
    const rel = prefix ? `${prefix}/${name}` : name;
    return statSync(join(dir, rel)).isDirectory() ? walk(dir, rel) : [rel];
  });
}

// No `base`. The site is served at the root of climb.psychard.com, not under a
// /<repo>/ path, so dev, preview and the deployed build all agree on '/'. If it
// ever moves back to a bare github.io project URL, base has to become
// '/stickman-climb/' for the build *and* for preview — `vite preview` reports
// command 'serve' exactly like the dev server, so a plain build check misses it.
export default defineConfig({
  plugins: [serviceWorker()],
  server: {
    // 0.0.0.0 so the phone / ngrok can reach it.
    host: true,
    port: 5173,
    strictPort: true,
    // Vite blocks requests with unknown Host headers; ngrok rewrites Host to its
    // own domain, so the tunnel 502s without this.
    allowedHosts: [
      '.ngrok-free.app',
      '.ngrok-free.dev',
      '.ngrok.app',
      '.ngrok.io',
      '.ngrok.dev',
    ],
  },
});
