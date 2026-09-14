import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const image = process.env.LOW_PASS_TEST_IMAGE ?? 'low-pass:multiplayer-g0';
const docker = async (...args) => (await execute('docker', args, { timeout: 60_000 })).stdout.trim();
const logs = async id => {
  const result = await execute('docker', ['logs', id], { timeout: 5000 });
  return result.stdout + result.stderr;
};
const startingConnection = error => ['ECONNREFUSED', 'ECONNRESET', 'UND_ERR_SOCKET'].includes(error.cause?.code);

async function until(check, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  do {
    const value = await check();
    if (value) return value;
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error('Container condition did not become true before its deadline.');
}

async function start(t, extra = []) {
  const id = await docker('create', '--name', `low-pass-test-${randomUUID()}`, '--read-only',
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true', '--stop-timeout', '45',
    '-p', '127.0.0.1::8080', ...extra, image);
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

async function pid(id, name) {
  const value = await docker('exec', id, 's6-svstat', '-o', 'pid', `/tmp/low-pass-services/${name}`);
  assert.match(value, /^-?\d+$/);
  return Number(value);
}

async function serviceReady(container) {
  try { return (await container.response('/api/multiplayer/readyz')).status === 200; }
  catch (error) {
    if (startingConnection(error)) return false;
    throw error;
  }
}

test('hardened image preserves static responses, private readiness, notices and source exclusion', async t => {
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
  assert.equal(await docker('exec', container.id, 'cat', '/proc/1/comm'), 's6-svscan');
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
  const capabilities = await container.response('/api/multiplayer/capabilities');
  assert.equal(capabilities.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await capabilities.json(), { multiplayer: false, reason: 'not_implemented' });
  assert.equal((await container.response('/api/multiplayer/rooms')).status, 404);
  assert.equal((await container.response('/signal')).status, 404);
  assert.equal((await container.response('/api/multiplayer/capabilities', {
    method: 'POST', body: 'x'.repeat(17 * 1024),
  })).status, 413);
  for (const name of ['low-pass', 'babylonjs-core', 'babylonjs-loaders', 'node', 'nginx', 's6', 'skalibs', 'execline']) {
    const license = await container.response(`/licenses/${name}.txt`);
    assert.equal(license.status, 200, name);
    assert.ok((await license.text()).length > 100, name);
  }
  const files = await docker('exec', container.id, 'find', '/opt/low-pass', '/usr/share/nginx/html',
    '/etc/low-pass', '-type', 'f');
  assert.doesNotMatch(files, /\/(?:\.env[^/]*|\.npmrc|node_modules|\.git|tests)(?:\/|\n|$)|\.(?:pem|key|p12|pfx|map)\n/);
  assert.equal((await container.response('/server/index.js')).status, 404);
});

test('Node failure leaves solo online and restarts at a bounded rate', async t => {
  const container = await start(t);
  await until(() => serviceReady(container));
  await docker('exec', container.id, 's6-svc', '-wD', '-T', '10000', '-d', '/tmp/low-pass-services/node');
  assert.equal((await container.response('/')).status, 200);
  assert.equal((await container.response('/healthz')).status, 200);
  assert.equal((await container.response('/api/multiplayer/readyz')).status, 502);
  assert.equal((await container.response('/api/multiplayer/capabilities')).status, 502);
  await docker('exec', container.id, 's6-svc', '-u', '/tmp/low-pass-services/node');
  await until(() => serviceReady(container));
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = await pid(container.id, 'node');
    assert.ok(before > 1);
    const began = Date.now();
    await docker('exec', container.id, 'kill', '-KILL', String(before));
    await until(async () => {
      const after = await pid(container.id, 'node');
      return after > 1 && after !== before && await serviceReady(container);
    });
    assert.ok(Date.now() - began >= 900, 'The supervisor must not busy-loop on crashes.');
    assert.equal((await container.response('/')).status, 200);
  }
});

test('a crashed Nginx master does not strand workers or block restart', async t => {
  const container = await start(t);
  const before = await pid(container.id, 'nginx');
  assert.ok(before > 1);
  await docker('exec', container.id, 'kill', '-KILL', String(before));
  await until(async () => {
    const after = await pid(container.id, 'nginx');
    return after > 1 && after !== before && await container.healthy();
  });
  const groups = JSON.parse(await docker('exec', container.id, 'node', '--input-type=module', '-e', `
    import { readdirSync, readFileSync } from 'node:fs';
    const groups = [];
    for (const entry of readdirSync('/proc').filter(name => /^\\d+$/.test(name))) {
      try {
        const stat = readFileSync('/proc/' + entry + '/stat', 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        groups.push(Number(fields[2]));
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    console.log(JSON.stringify(groups));
  `));
  assert.ok(!groups.includes(before), 'No surviving or zombie process in the crashed master group.');
});

test('invalid configuration disables only Node and does not create a restart loop', async t => {
  const container = await start(t, ['-e', 'LOW_PASS_MULTIPLAYER_ENABLED=true']);
  await until(async () => (await logs(container.id)).includes('disabled after invalid configuration'));
  assert.equal((await container.response('/')).status, 200);
  assert.equal((await container.response('/api/multiplayer/readyz')).status, 502);
  await delay(2200);
  const output = await logs(container.id);
  assert.equal(output.split('startup failed').length - 1, 1);
  assert.equal(await pid(container.id, 'node'), -1);
  await docker('restart', '--timeout', '45', container.id);
  await container.refreshPort();
  await until(container.healthy);
  assert.equal((await container.response('/')).status, 200);
});

test('the container rejects a mismatched private port without taking down static assets', async t => {
  const container = await start(t, ['-e', 'LOW_PASS_SERVICE_PORT=8082']);
  await until(async () => (await logs(container.id)).includes('disabled after invalid configuration'));
  assert.equal((await container.response('/')).status, 200);
  assert.equal((await container.response('/api/multiplayer/readyz')).status, 502);
  assert.equal(await pid(container.id, 'node'), -1);
});

test('PID 1 drains both services and stops without a forced container kill', async t => {
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

test('the internal signal proxy supports actual WebSocket upgrade and bidirectional frames', async t => {
  const fixture = fileURLToPath(new globalThis.URL('./fixtures/upgrade.mjs', import.meta.url));
  const container = await start(t, ['--mount', `type=bind,src=${fixture},dst=/opt/low-pass/server/index.js,readonly`]);
  await until(() => serviceReady(container));
  const socket = new globalThis.WebSocket(container.origin.replace('http:', 'ws:') + '/signal');
  t.after(() => socket.close());
  const message = new Promise((resolve, reject) => {
    socket.addEventListener('error', () => reject(new Error('WebSocket proxy failed.')), { once: true });
    socket.addEventListener('open', () => socket.send('probe'), { once: true });
    socket.addEventListener('message', event => resolve(event.data), { once: true });
  });
  assert.equal(await message, 'echo:probe');
  socket.close();
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
