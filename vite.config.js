import { defineConfig } from 'vite';

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
