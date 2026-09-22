import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const image = process.env.LOW_PASS_TEST_IMAGE ?? 'low-pass:node-g0';
const docker = async (...args) => (await execute('docker', args, { timeout: 60_000 })).stdout.trim();
const logs = async id => {
  const result = await execute('docker', ['logs', id], { timeout: 5000 });
  return result.stdout + result.stderr;
};
const startingConnection = error => ['ECONNREFUSED', 'ECONNRESET', 'UND_ERR_SOCKET'].includes(error.cause?.code);

async function until(check, timeout = 15_000) {
  const deadline = performance.now() + timeout;
  do {
    const value = await check();
    if (value) return value;
    await delay(100);
  } while (performance.now() < deadline);
  throw new Error('Container condition did not become true before its deadline.');
}

async function start(t, extra = [], command = []) {
  const id = await docker('create', '--name', `low-pass-test-${randomUUID()}`, '--read-only',
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true', '--stop-timeout', '45',
    '-p', '127.0.0.1::8080', ...extra, image, ...command);
  const child = spawn('docker', ['start', '--attach', id], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const append = chunk => { output = (output + String(chunk)).slice(-32_768); };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  const exited = once(child, 'exit');
  t.after(async () => {
    try {
      await docker('stop', '--timeout', '45', id);
      await exited;
    } finally { await docker('rm', '--force', id); }
  });
  const inspect = async () => JSON.parse(await docker('inspect', '--format', '{{json .}}', id));
  const port = await until(async () => {
    if (child.exitCode !== null) throw new Error(`Container exited during startup:\n${output}`);
    const state = await inspect();
    return state.NetworkSettings.Ports['8080/tcp']?.[0]?.HostPort;
  });
  let origin = `http://127.0.0.1:${port}`;
  const refreshPort = async () => {
    const state = await inspect();
    const port = state.NetworkSettings.Ports['8080/tcp']?.[0]?.HostPort;
    assert.ok(port, 'Restarted container must have a published test port.');
    origin = `http://127.0.0.1:${port}`;
  };
  const response = (path, options) => globalThis.fetch(origin + path, {
    signal: globalThis.AbortSignal.timeout(3000), headers: { Connection: 'close' }, ...options,
  });
  const healthy = async () => {
    try { return (await response('/healthz')).status === 200; }
    catch (error) {
      if (startingConnection(error)) return false;
      throw error;
    }
  };
  await until(healthy);
  return { id, inspect, get origin() { return origin; }, refreshPort, response, healthy, exited };
}

async function serviceReady(container) {
  try { return (await container.response('/api/multiplayer/readyz')).status === 200; }
  catch (error) {
    if (startingConnection(error)) return false;
    throw error;
  }
}

async function assertNodePid1(id) {
  const executable = await docker('exec', id, 'node', '-e',
    'console.log(require("node:fs").readlinkSync("/proc/1/exe"))');
  assert.equal(executable, '/usr/local/bin/node');
  const command = await docker('exec', id, 'node', '-e',
    'console.log(JSON.stringify(require("node:fs").readFileSync("/proc/1/cmdline").toString().split("\\0").filter(Boolean)))');
  assert.deepEqual(JSON.parse(command), ['node', '/opt/low-pass/dist-server/server/index.js']);
}

test('hardened Node PID 1 image preserves static HTTP, readiness, notices and source exclusion', async t => {
  const container = await start(t);
  await until(() => serviceReady(container));
  const state = await container.inspect();
  assert.equal(state.Config.User, '101:101');
  assert.equal(state.Config.StopSignal, 'SIGTERM');
  assert.equal(state.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(state.HostConfig.CapDrop, ['ALL']);
  assert.deepEqual(Object.keys(state.Config.ExposedPorts), ['8080/tcp']);
  assert.match(await docker('exec', container.id, 'node', '--version'), /^v24\./);
  const mounts = await docker('exec', container.id, 'cat', '/proc/mounts');
  assert.match(mounts, /tmpfs \/tmp tmpfs [^\n]*noexec/);
  await assertNodePid1(container.id);
  assert.equal(state.Config.Env.includes('NODE_ENV=production'), true);
  assert.equal(await docker('exec', container.id, 'node', '-e', `
    const fs = require('node:fs');
    for (const path of ['/usr/sbin/nginx', '/bin/s6-svscan', '/opt/low-pass/node_modules/typescript',
      '/opt/low-pass/node_modules/vitest', '/opt/low-pass/node_modules/@playwright/test']) {
      if (fs.existsSync(path)) throw new Error('Unexpected runtime tooling: ' + path);
    }
  `), '');
  await docker('exec', container.id, 'node', '/opt/low-pass/dist-server/server/healthcheck.js');
  const html = await container.response('/');
  assert.equal(html.status, 200);
  assert.equal(html.headers.get('cache-control'), 'no-cache');
  assert.match(html.headers.get('content-security-policy'), /connect-src 'self'/);
  const body = await html.text();
  const asset = body.match(/"(\/assets\/index-[^"]+\.js)"/)?.[1];
  assert.ok(asset, 'HTML must reference a content-hashed application bundle.');
  const script = await container.response(asset);
  assert.equal(script.status, 200);
  assert.match(script.headers.get('cache-control'), /immutable/);
  assert.equal((await container.response('/assets/absent.js')).status, 404);
  assert.equal((await container.response('/assets/kestrel.glb')).headers.get('content-type'), 'model/gltf-binary');
  const model = await container.response('/assets/kestrel.glb');
  const modelBytes = Buffer.from(await model.arrayBuffer());
  const ranged = await container.response('/assets/kestrel.glb', { headers: { Range: 'bytes=0-15' } });
  assert.equal(ranged.status, 206);
  assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), modelBytes.subarray(0, 16));
  const unchanged = await container.response('/assets/kestrel.glb', {
    cache: 'no-cache', headers: { 'If-None-Match': model.headers.get('etag') },
  });
  assert.equal(unchanged.status, 304);
  const head = await container.response('/', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  const compressed = await container.response(asset, { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(compressed.headers.get('content-encoding'), 'gzip');
  assert.equal(await compressed.text(), await (await container.response(asset, { headers: { 'Accept-Encoding': 'identity' } })).text());
  const capabilities = await container.response('/api/multiplayer/capabilities');
  assert.equal(capabilities.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await capabilities.json(), { multiplayer: false, reason: 'not_implemented' });
  assert.equal((await container.response('/api/multiplayer/rooms')).status, 404);
  assert.equal((await container.response('/signal')).status, 404);
  assert.equal((await container.response('/api/multiplayer/capabilities', {
    method: 'POST', body: 'x'.repeat(17 * 1024),
  })).status, 413);
  for (const name of ['low-pass', 'babylonjs-core', 'babylonjs-loaders', 'node',
    'runtime-express-5.2.1', 'runtime-compression-1.8.2', 'runtime-zod-4.6.5']) {
    const license = await container.response(`/licenses/${name}.txt`);
    assert.equal(license.status, 200, name);
    assert.ok((await license.text()).length > 100, name);
  }
  const files = await docker('exec', container.id, 'find', '/opt/low-pass/dist-server', '/opt/low-pass/dist', '-type', 'f');
  assert.doesNotMatch(files, /\/(?:\.env[^/]*|\.npmrc|node_modules|\.git|tests)(?:\/|\n|$)|\.(?:pem|key|p12|pfx|map)\n/);
  assert.equal((await container.response('/server/index.js')).status, 404);
  assert.equal((await container.response('/node_modules/express/package.json')).status, 404);
  assert.equal((await container.response('/dist-server/index.js')).status, 404);
  assert.equal((await container.response('/dist-server/shared/protocol/codec.js')).status, 404);
  for (const name of ['nginx', 's6', 'skalibs', 'execline']) {
    assert.equal((await container.response(`/licenses/${name}.txt`)).status, 404);
  }
});

test('process exit is recovered by Docker restart policy, but manual stop stays stopped', async t => {
  const fixture = fileURLToPath(new globalThis.URL('./fixtures/crash.mjs', import.meta.url));
  const container = await start(t, ['--restart', 'unless-stopped', '--entrypoint', 'node',
    '--mount', `type=bind,src=${fixture},dst=/opt/low-pass/dist-server/server/crash.mjs,readonly`],
  ['/opt/low-pass/dist-server/server/crash.mjs']);
  await delay(10_100);
  await docker('exec', container.id, 'node', '-e',
    'require("node:fs").writeFileSync("/tmp/low-pass-crash-request", "")');
  try {
    await until(async () => {
      const state = await container.inspect();
      return state.RestartCount >= 1 && state.State.Running && !state.State.Restarting;
    });
  } catch (error) {
    const state = await container.inspect();
    throw new Error(`Restart failed: ${JSON.stringify({ state: state.State, restarts: state.RestartCount })}\n${await logs(container.id)}`,
      { cause: error });
  }
  await container.refreshPort();
  await until(container.healthy);
  assert.equal((await container.response('/')).status, 200);
  await docker('stop', '--timeout', '45', container.id);
  await delay(1200);
  assert.equal((await container.inspect()).State.Running, false);
});

test('invalid multiplayer configuration leaves static and application health available', async t => {
  const container = await start(t, ['-e', 'LOW_PASS_MULTIPLAYER_ENABLED=true']);
  await until(async () => (await logs(container.id)).includes('Multiplayer unavailable:'));
  assert.equal((await container.response('/')).status, 200);
  assert.equal((await container.response('/healthz')).status, 200);
  assert.equal((await container.response('/api/multiplayer/readyz')).status, 503);
  assert.deepEqual(await (await container.response('/api/multiplayer/capabilities')).json(),
    { multiplayer: false, reason: 'configuration_error' });
  await delay(2200);
  const output = await logs(container.id);
  assert.equal(output.split('Multiplayer unavailable:').length - 1, 1);
  await docker('exec', container.id, 'node', '/opt/low-pass/dist-server/server/healthcheck.js');
  await assertNodePid1(container.id);
  await docker('restart', '--timeout', '45', container.id);
  await container.refreshPort();
  await until(container.healthy);
  assert.equal((await container.response('/')).status, 200);
});

test('invalid core settings fail startup explicitly without disclosing supplied values', async () => {
  for (const setting of ['LOW_PASS_SERVICE_PORT=private-value', 'LOW_PASS_SERVICE_HOST=private-value',
    'LOW_PASS_STATIC_ROOT=/missing-private-root']) {
    await assert.rejects(docker('run', '--rm', '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges:true', '-e', setting, image),
    error => error.code === 78 && error.stderr.includes('startup failed') &&
      !error.stderr.includes('private-value') && !error.stderr.includes('/missing-private-root'));
  }
});

test('Node PID 1 drains and stops without a forced container kill', async t => {
  const container = await start(t);
  await until(() => serviceReady(container));
  await docker('stop', '--timeout', '45', container.id);
  await container.exited;
  const state = await container.inspect();
  assert.equal(state.State.Running, false);
  assert.equal(state.State.Pid, 0);
  assert.equal(state.State.ExitCode, 0);
  assert.match(await logs(container.id), /Application service stopped/);
});

test('the actual application supports test-only WebSocket frames and bounds upgraded shutdown', async t => {
  const fixture = fileURLToPath(new globalThis.URL('./fixtures/upgrade.mjs', import.meta.url));
  const container = await start(t, ['-e', 'LOW_PASS_SHUTDOWN_TIMEOUT_MS=100',
    '--mount', `type=bind,src=${fixture},dst=/opt/low-pass/dist-server/server/index.js,readonly`]);
  await until(() => serviceReady(container));
  const socket = new globalThis.WebSocket(container.origin.replace('http:', 'ws:') + '/signal');
  t.after(() => socket.close());
  const message = new Promise((resolve, reject) => {
    socket.addEventListener('error', () => reject(new Error('WebSocket proxy failed.')), { once: true });
    socket.addEventListener('open', () => socket.send('probe'), { once: true });
    socket.addEventListener('message', event => resolve(event.data), { once: true });
  });
  assert.equal(await message, 'echo:probe');
  const closed = new Promise(resolve => socket.addEventListener('close', resolve, { once: true }));
  await docker('stop', '--timeout', '45', container.id);
  await closed;
  assert.equal((await container.inspect()).State.ExitCode, 0);
  assert.match(await logs(container.id), /shutdown deadline reached/);
});

test('build context excludes common local secret and artifact paths', async () => {
  const ignore = await readFile(new globalThis.URL('../../.dockerignore', import.meta.url), 'utf8');
  for (const pattern of ['.env', '.env.*', '.npmrc', '*.pem', '*.key', '*.p12', '*.pfx',
    '.git', 'dist-server', 'test-results', 'node_modules']) {
    assert.ok(ignore.split('\n').includes(pattern), pattern);
  }
});

test('unexpected container commands are rejected rather than silently ignored', async () => {
  await assert.rejects(docker('run', '--rm', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true', image, 'unexpected-command'),
  error => error.code === 64 && error.stderr.includes('do not override its command'));
});

test('explicit private-room activation works with a read-only secret mount and trusted proxy chain', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'low-pass-room-container-'));
  const path = join(directory, 'test-code'), code = 'container-only-dummy-code-never-production';
  await writeFile(path, code, { mode: 0o444 });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const gateway = await docker('network', 'inspect', 'bridge', '--format', '{{(index .IPAM.Config 0).Gateway}}');
  const container = await start(t, [
    '-e', 'LOW_PASS_MULTIPLAYER_ENABLED=true', '-e', 'LOW_PASS_PUBLIC_ORIGIN=https://room-test.example',
    '-e', `LOW_PASS_TRUSTED_PROXY_CIDRS=${gateway}/32,173.245.48.0/20`,
    '-e', 'LOW_PASS_HOSTING_CODE_FILE=/run/low-pass-test-code',
    '--mount', `type=bind,src=${path},dst=/run/low-pass-test-code,readonly`,
  ]);
  assert.deepEqual(await (await container.response('/api/multiplayer/capabilities')).json(),
    { multiplayer: false, reason: 'not_implemented', rooms: true, signaling: true });
  const headers = { 'Content-Type': 'application/json', Origin: 'https://room-test.example',
    'X-Forwarded-For': '203.0.113.10,173.245.48.5' };
  const authorized = await container.response('/api/multiplayer/host-authorizations',
    { method: 'POST', headers, body: JSON.stringify({ accessCode: code }) });
  assert.equal(authorized.status, 201);
  const grant = await authorized.json();
  const created = await container.response('/api/multiplayer/rooms',
    { method: 'POST', headers: { ...headers, Authorization: `Bearer ${grant.capability}` }, body: '{}' });
  assert.equal(created.status, 201);
  const room = await created.json();
  assert.match(room.invitation, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  const output = await logs(container.id);
  for (const value of [code, grant.capability, room.capability, room.invitation]) assert.ok(!output.includes(value));
  assert.equal((await container.response('/run/low-pass-test-code')).status, 404);
  await docker('exec', container.id, 'node', '/opt/low-pass/dist-server/server/healthcheck.js');
});
