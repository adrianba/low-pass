import { build } from 'vite';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const outDir = resolve(root, 'test-results/formation-preview');
await build({
  configFile: false,
  root,
  publicDir: false,
  build: {
    outDir, emptyOutDir: true, sourcemap: false,
    lib: {
      entry: resolve(root, 'tests/fixtures/formation-preview.ts'),
      name: 'LowPassFormationPreview', formats: ['iife'], fileName: () => 'formation-preview.js',
    },
  },
});
await writeFile(resolve(outDir, 'formation-preview.html'),
  await readFile(resolve(root, 'tests/fixtures/formation-preview.html')));
console.info('Test-only preview: test-results/formation-preview/{formation-preview.html,formation-preview.js}');
console.info('Mount only these two files beside the app index; existing /assets/ files stay unchanged.');
