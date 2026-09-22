import { build } from 'vite';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const outDir = resolve(root, 'test-results/connectivity-preview');
await build({ configFile: false, root, publicDir: false,
  build: { outDir, emptyOutDir: true, sourcemap: false,
    lib: { entry: resolve(root, 'tests/fixtures/connectivity.ts'), name: 'LowPassConnectivity',
      formats: ['iife'], fileName: () => 'connectivity.js' } } });
await writeFile(resolve(outDir, 'connectivity.html'), await readFile(resolve(root, 'tests/fixtures/connectivity.html')));
console.info('Built the local-only connectivity diagnostic; no credentials are embedded.');
