import { defineConfig } from 'vite';

export default defineConfig(({ command, isPreview }) => ({
  // GitHub Pages serves a project site under /<repo>/, so built asset URLs need
  // that prefix. Dev stays at / — otherwise localhost and the ngrok tunnel would
  // both need the subpath too. `vite preview` reports command 'serve' like the
  // dev server does, so it needs isPreview as well or it serves the built HTML
  // at / while that HTML asks for /stickman-climb/assets, and every asset 404s.
  base: command === 'build' || isPreview ? '/stickman-climb/' : '/',
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
}));
