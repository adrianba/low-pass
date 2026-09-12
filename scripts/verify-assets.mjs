import { createHash } from 'node:crypto';
import { readFile, writeFile, stat } from 'node:fs/promises';

const original = ['kestrel.glb', 'practice-bomb.glb'];
const terrain = ['Ground037', 'Rock030'].flatMap(id => ['Color', 'NormalGL', 'Roughness'].map(map => ({
  file: `terrain/${id}_1K-JPG_${map}.jpg`,
  source: `https://ambientcg.com/a/${id}`,
  download: `https://ambientcg.com/get?file=${id}_1K-JPG.zip`,
  creator: 'ambientCG / Lennart Demes',
  license: 'CC0-1.0',
  licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
  modifications: 'Resized to at most 1024px and JPEG-encoded at quality 90 using scripts/optimize-textures.py; tinted and blended in-game.',
})));
const assets = [
  ...original.map(file => ({
    file, source: 'scripts/build-aircraft.py', creator: 'Low Pass project',
    license: 'MIT', licenseUrl: 'https://github.com/adrianba/low-pass/blob/main/LICENSE',
    modifications: 'Original Blender generation, GLB export.',
  })),
  ...terrain,
];
const manifestPath = new URL('../public/assets/manifest.json', import.meta.url);
if (process.argv.includes('--write')) {
  for (const asset of assets) {
    const bytes = await readFile(new URL(`../public/assets/${asset.file}`, import.meta.url));
    asset.sha256 = createHash('sha256').update(bytes).digest('hex');
    asset.bytes = bytes.length;
  }
  await writeFile(manifestPath, JSON.stringify({ version: 1, assets }, null, 2) + '\n');
}
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
for (const asset of manifest.assets) {
  const bytes = await readFile(new URL(`../public/assets/${asset.file}`, import.meta.url));
  if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error(`Asset checksum mismatch: ${asset.file}`);
  if (!asset.source || !asset.creator || !asset.license) throw new Error(`Incomplete attribution: ${asset.file}`);
}
for (const name of original) {
  const buffer = await readFile(new URL(`../public/assets/${name}`, import.meta.url));
  if (buffer.readUInt32LE(0) !== 0x46546c67 || buffer.readUInt32LE(4) !== 2) throw new Error(`Invalid GLB: ${name}`);
  const gltf = JSON.parse(buffer.subarray(20, 20 + buffer.readUInt32LE(12)).toString());
  const triangles = gltf.meshes.reduce((n, mesh) => n + mesh.primitives.reduce((m, p) => m + gltf.accessors[p.indices].count / 3, 0), 0);
  if (triangles > 60_000) throw new Error(`${name} exceeds triangle budget.`);
  console.log(`${name}: ${triangles} triangles; ${buffer.length} bytes`);
}
await stat(new URL('../art/kestrel.blend', import.meta.url));
console.log(`Verified ${manifest.assets.length} licensed/source-tracked assets.`);
