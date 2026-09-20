import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';

await mkdir(new URL('../dist/licenses/', import.meta.url), { recursive: true });
await copyFile(new URL('../LICENSE', import.meta.url),
  new URL('../dist/licenses/low-pass.txt', import.meta.url));
for (const name of ['core', 'loaders']) {
  await copyFile(new URL(`../node_modules/@babylonjs/${name}/license.md`, import.meta.url),
    new URL(`../dist/licenses/babylonjs-${name}.txt`, import.meta.url));
}
const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
for (const [path, metadata] of Object.entries(lock.packages)) {
  if (!path || metadata.dev || metadata.devOptional) continue;
  const directory = new URL(`../${path}/`, import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('package.json', directory), 'utf8'));
  const notices = (await readdir(directory)).filter(name => /^(licen[cs]e|copying|notice)(\.|$)/i.test(name));
  if (!notices.length) throw new Error(`Missing runtime dependency license: ${manifest.name}`);
  const text = await Promise.all(notices.sort().map(async name =>
    `${name}\n\n${await readFile(new URL(name, directory), 'utf8')}`));
  await writeFile(new URL(`../dist/licenses/runtime-${manifest.name.replaceAll('/', '-')}-${manifest.version}.txt`, import.meta.url),
    `${manifest.name} ${manifest.version}\nLicense: ${manifest.license}\n\n${text.join('\n\n')}`);
}
