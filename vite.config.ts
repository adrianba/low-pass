import { defineConfig } from 'vite';
import type { ViteDevServer } from 'vite';
import { identityPlugin } from './scripts/build-identity.mjs';

// Vite serves standalone solo builds; private rooms require the Node application.
function soloCapabilities(server: Pick<ViteDevServer, 'middlewares'>): void {
  server.middlewares.use('/api/multiplayer/capabilities', (_request, response) => {
    response.setHeader('Content-Type', 'application/json'); response.setHeader('Cache-Control', 'no-store');
    response.end(JSON.stringify({ multiplayer: false, reason: 'not_implemented' }));
  });
}

export default defineConfig({
  plugins: [identityPlugin(), { name: 'solo-capabilities', configureServer: soloCapabilities, configurePreviewServer: soloCapabilities }],
  build: {
    target: 'es2022',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('@babylonjs')) return 'engine';
        },
      },
    },
  },
});
