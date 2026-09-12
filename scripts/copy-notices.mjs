import { copyFile, mkdir } from 'node:fs/promises';

await mkdir(new URL('../dist/licenses/', import.meta.url), { recursive: true });
await copyFile(new URL('../LICENSE', import.meta.url),
  new URL('../dist/licenses/low-pass.txt', import.meta.url));
for (const name of ['core', 'loaders']) {
  await copyFile(new URL(`../node_modules/@babylonjs/${name}/license.md`, import.meta.url),
    new URL(`../dist/licenses/babylonjs-${name}.txt`, import.meta.url));
}
