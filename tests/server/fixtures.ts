import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const script = 'const value = "compressible fixture";\n'.repeat(4096);
export const model = Buffer.from(Array.from({ length: 256 }, (_, index) => index));

export async function assetFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'low-pass-assets-'));
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'index.html'), '<!doctype html><title>Low Pass fixture</title>');
  await writeFile(join(root, 'assets/index-12345678.js'), script);
  await writeFile(join(root, 'assets/model.glb'), model);
  await writeFile(join(root, '.private'), 'private fixture');
  return root;
}
