import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';

function files(root, directory) {
  if (!lstatSync(resolve(root, directory)).isDirectory()) throw new Error('Invalid build identity directory.');
  const result = [];
  for (const entry of readdirSync(resolve(root, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error('Build identity inputs must not be symbolic links.');
    if (entry.isDirectory()) result.push(...files(root, path));
    else if (entry.isFile()) result.push(path);
    else throw new Error('Invalid build identity input.');
  }
  return result.sort();
}
function digest(root, paths) {
  const hash = createHash('sha256');
  for (const path of [...new Set(paths)].sort()) {
    if (!lstatSync(resolve(root, path)).isFile()) throw new Error('Build identity input must be a regular file.');
    const bytes = readFileSync(resolve(root, path));
    hash.update(`${path}\0${bytes.length}\0`); hash.update(bytes);
  }
  return hash.digest('hex');
}
export function identityDigests(root) {
  const source = files(root, 'src'), shared = files(root, 'shared'), assets = files(root, 'public/assets');
  const builders = files(root, 'scripts').filter(path => /^scripts\/build-.*\.mjs$/.test(path));
  const rules = source.filter(path => /^src\/(?:config|game|simulation|terrain)\//.test(path));
  const generator = source.filter(path => /^src\/(?:config|simulation|terrain|game)\//.test(path));
  return {
    build: digest(root, [...source, ...shared, ...assets, ...builders, 'package.json', 'package-lock.json', 'index.html', 'tsconfig.json', 'vite.config.ts']),
    assets: digest(root, assets), rules: digest(root, [...rules, ...shared]), generator: digest(root, generator),
  };
}
export function identityPlugin(root = process.cwd()) {
  const id = '\0low-pass:build-identity';
  let identity;
  return {
    name: 'low-pass-build-identity',
    resolveId(source) { if (source === 'virtual:low-pass-identity') return id; },
    load(source) {
      if (source !== id) return;
      identity ??= identityDigests(root);
      return `export default Object.freeze(${JSON.stringify(identity)});`;
    },
    handleHotUpdate(context) {
      if (!identity) return;
      const path = relative(root, context.file).replaceAll('\\', '/');
      if (/^(?:src\/|shared\/|public\/assets\/|scripts\/build-|package(?:-lock)?\.json$|index\.html$|tsconfig\.json$|vite\.config\.ts$)/.test(path)) {
        identity = undefined;
        const module = context.server.moduleGraph.getModuleById(id);
        if (module) context.server.moduleGraph.invalidateModule(module);
        context.server.ws.send({ type: 'full-reload' }); return [];
      }
    },
    generateBundle() {
      if (identity && JSON.stringify(identityDigests(root)) !== JSON.stringify(identity)) {
        throw new Error('Build identity inputs changed while bundling. Build again from a stable source tree.');
      }
    },
  };
}
