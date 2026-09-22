import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { identityDigests } from '../../scripts/build-identity.mjs';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'low-pass-identity-')); roots.push(root);
  const write = (path: string, value: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), value); };
  for (const path of ['src/config/game.ts', 'src/terrain/surface.ts', 'src/ui/ui.ts', 'shared/protocol/limits.ts',
    'public/assets/manifest.json', 'public/assets/plane.glb', 'scripts/build-identity.mjs', 'package.json', 'package-lock.json',
    'index.html', 'tsconfig.json', 'vite.config.ts']) write(path, `fixture:${path}`);
  return { root, write };
}
describe('portable build-input identities', () => {
  it('is independent of absolute paths and excludes secrets, server configuration and repository metadata', () => {
    const a = fixture(), b = fixture(), before = identityDigests(a.root);
    a.write('.secret/turn-secret', 'dummy-private-fixture-value');
    a.write('server/config.ts', 'server-only');
    a.write('.git/HEAD', 'not-a-real-repository');
    expect(identityDigests(a.root)).toEqual(before); expect(identityDigests(b.root)).toEqual(before);
    for (const value of Object.values(before)) expect(value).toMatch(/^[a-f0-9]{64}$/);
  });
  it('changes the appropriate hashes for assets, physics/generator inputs and UI/build inputs', () => {
    const { root, write } = fixture(), initial = identityDigests(root);
    write('public/assets/plane.glb', 'changed asset');
    const asset = identityDigests(root);
    expect(asset.assets).not.toBe(initial.assets); expect(asset.build).not.toBe(initial.build);
    expect(asset.rules).toBe(initial.rules);
    write('src/terrain/surface.ts', 'changed surface');
    const terrain = identityDigests(root);
    expect(terrain.rules).not.toBe(asset.rules); expect(terrain.generator).not.toBe(asset.generator);
    write('src/ui/ui.ts', 'changed ui');
    const ui = identityDigests(root);
    expect(ui.build).not.toBe(terrain.build); expect(ui.generator).toBe(terrain.generator);
    write('src/simulation/math.ts', 'changed shared math');
    const math = identityDigests(root);
    expect(math.generator).not.toBe(ui.generator);
    write('scripts/build-preview.mjs', 'changed build');
    expect(identityDigests(root).build).not.toBe(math.build);
  });
  it('refuses symlink inputs rather than hashing data outside the declared source trees', () => {
    const { root, write } = fixture();
    write('.secret/example', 'dummy-private-fixture-value');
    symlinkSync(join(root, '.secret/example'), join(root, 'src/linked.ts'));
    expect(() => identityDigests(root)).toThrow('symbolic links');
  });
});
