import { defineConfig } from 'vite';
import { identityPlugin } from './scripts/build-identity.mjs';

export default defineConfig({
  plugins: [identityPlugin()],
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
