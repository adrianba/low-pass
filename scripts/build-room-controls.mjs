import { build } from 'vite';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { identityPlugin } from './build-identity.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const outDir = resolve(root, 'test-results/room-controls');
await build({ configFile: false, root, publicDir: false, plugins: [identityPlugin(root)],
  build: { outDir, emptyOutDir: true, sourcemap: false,
    lib: { entry: resolve(root, 'tests/fixtures/room-controls.ts'), name: 'LowPassRoomControls',
      formats: ['iife'], fileName: () => 'room-controls.js' } } });
await writeFile(resolve(outDir, 'room-controls.html'), await readFile(resolve(root, 'tests/fixtures/room-controls.html')));
console.info('Built the local-only room controls preview; no credentials are embedded.');
