import { build } from 'vite';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const outDir = resolve(root, 'test-results/combat-preview');
await build({
  configFile: false, root, publicDir: false,
  build: { outDir, emptyOutDir: true, sourcemap: false,
    lib: { entry: resolve(root, 'tests/fixtures/combat-preview.ts'),
      name: 'LowPassCombatPreview', formats: ['iife'], fileName: () => 'combat-preview.js' } },
});
await writeFile(resolve(outDir, 'combat-preview.html'), await readFile(resolve(root, 'tests/fixtures/combat-preview.html')));
console.info('Test-only preview: test-results/combat-preview/{combat-preview.html,combat-preview.js}');
