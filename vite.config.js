import { defineConfig } from 'vite';

// No `base`. The site is served at the root of climb.psychard.com, not under a
// /<repo>/ path, so dev, preview and the deployed build all agree on '/'. If it
// ever moves back to a bare github.io project URL, base has to become
// '/stickman-climb/' for the build *and* for preview — `vite preview` reports
// command 'serve' exactly like the dev server, so a plain build check misses it.
export default defineConfig({
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
