import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { assetFixture } from './fixtures.js';

interface ProcessUnderTest {
  child: ChildProcessWithoutNullStreams;
  output: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

let outputDirectory: string;
let staticRoot: string;
const processes: ProcessUnderTest[] = [];

beforeAll(async () => {
  outputDirectory = await mkdtemp(join(tmpdir(), 'low-pass-service-'));
  staticRoot = await assetFixture();
  await promisify(execFile)(process.execPath, [
    'node_modules/typescript/bin/tsc', '-p', 'tsconfig.server.json', '--outDir', outputDirectory,
  ]);
  await writeFile(join(outputDirectory, 'package.json'), '{"type":"module"}');
  await symlink(resolve('node_modules'), join(outputDirectory, 'node_modules'), 'junction');
}, 20_000);

afterEach(async () => {
  for (const process of processes.splice(0)) {
    if (process.child.exitCode === null && process.child.signalCode === null) process.child.kill('SIGKILL');
    await process.exited;
  }
});
afterAll(async () => {
  if (outputDirectory) await rm(outputDirectory, { recursive: true, force: true });
  if (staticRoot) await rm(staticRoot, { recursive: true, force: true });
});

function launch(env: NodeJS.ProcessEnv): ProcessUnderTest {
  const child = spawn(process.execPath, [join(outputDirectory, 'index.js')], {
    env: { ...process.env, LOW_PASS_STATIC_ROOT: staticRoot, ...env },
    cwd: outputDirectory, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += String(chunk); });
  child.stderr.on('data', chunk => { output += String(chunk); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const running = { child, output: () => output, exited };
  processes.push(running);
  return running;
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); });
  if (!address || typeof address === 'string') throw new Error('Missing test listener address.');
  return address.port;
}

function ready(running: ProcessUnderTest): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = () => {
      if (running.output().includes('Application service ready')) {
        cleanup();
        resolve();
      }
    };
    const ended = () => { cleanup(); reject(new Error(running.output())); };
    const deadline = setTimeout(() => {
      cleanup();
      reject(new Error('Compiled application did not become ready: ' + running.output()));
    }, 5000);
    const cleanup = () => {
      clearTimeout(deadline);
      running.child.stdout.off('data', check);
      running.child.off('exit', ended);
    };
    running.child.stdout.on('data', check);
    running.child.once('exit', ended);
    check();
  });
}

describe('compiled Node entrypoint', () => {
  it.skipIf(process.platform === 'win32').each(['SIGTERM', 'SIGINT'] as const)('serves HTTP and exits cleanly on %s', async signal => {
    const port = await unusedPort();
    const running = launch({ LOW_PASS_SERVICE_PORT: String(port) });
    await ready(running);
    const response = await fetch(`http://127.0.0.1:${port}/api/multiplayer/capabilities`);
    expect(await response.json()).toEqual({ multiplayer: false, reason: 'not_implemented' });
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toContain('Low Pass fixture');
    running.child.kill(signal);
    expect(await running.exited).toEqual({ code: 0, signal: null });
    expect(running.output()).toContain('Application service stopped.');
  });

  it('keeps HTTP healthy while reporting invalid multiplayer configuration without its value', async () => {
    const port = await unusedPort();
    const running = launch({ LOW_PASS_SERVICE_PORT: String(port), LOW_PASS_MULTIPLAYER_ENABLED: 'private-invalid-value' });
    await ready(running);
    expect((await fetch(`http://127.0.0.1:${port}/readyz`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${port}/api/multiplayer/readyz`)).status).toBe(503);
    expect(running.output()).toContain('Multiplayer unavailable:');
    expect(running.output()).not.toContain('private-invalid-value');
  });

  it('fails explicitly when the build root is missing', async () => {
    const running = launch({ LOW_PASS_STATIC_ROOT: join(staticRoot, 'missing') });
    expect(await running.exited).toEqual({ code: 78, signal: null });
    expect(running.output()).toContain('Static build output is missing or unreadable');
    expect(running.output()).not.toContain(staticRoot);
  });

  it('exits unsuccessfully on invalid core configuration without exposing its value', async () => {
    const running = launch({ LOW_PASS_SERVICE_PORT: 'private-invalid-value' });
    expect(await running.exited).toEqual({ code: 78, signal: null });
    expect(running.output()).toContain('startup failed');
    expect(running.output()).toContain('LOW_PASS_SERVICE_PORT');
    expect(running.output()).not.toContain('private-invalid-value');
  });
});
