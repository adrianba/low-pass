import { spawn, execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
if (!process.getuid || process.getuid() === 0) throw new Error('Run this local harness as a non-root Unix user.');
const port = process.env.CONNECTIVITY_BACKEND_PORT ?? '';
if (port && (!/^[0-9]+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) throw new Error('Invalid backend port.');
const directory = resolve(root, process.env.CONNECTIVITY_FIXTURE_DIR ?? 'test-results/connectivity-preview');
const gateway = execFileSync('docker', ['network', 'inspect', 'bridge', '--format', '{{(index .IPAM.Config 0).Gateway}}'], { encoding: 'utf8' }).trim();
const args = ['run', '--rm', '--name', 'low-pass-connectivity-local',
  '--user', `${process.getuid()}:${process.getgid()}`, '-p', `127.0.0.1:${port}:8080`,
  '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', '--cap-drop', 'ALL',
  '--security-opt', 'no-new-privileges:true', '--stop-timeout', '45',
  '-e', 'LOW_PASS_MULTIPLAYER_ENABLED=true', '-e', 'LOW_PASS_PUBLIC_ORIGIN=http://localhost:8080',
  '-e', `LOW_PASS_TRUSTED_PROXY_CIDRS=${gateway}/32`,
  '-e', 'LOW_PASS_HOSTING_CODE_FILE=/run/secrets/low-pass-hosting-code',
  '-e', 'LOW_PASS_TURN_SECRET_FILE=/run/secrets/low-pass-turn-secret',
  '-e', 'LOW_PASS_TURN_URLS=turn:turn.low-pass.biggsea.us:3478?transport=udp,turn:turn.low-pass.biggsea.us:3478?transport=tcp,turns:turn.low-pass.biggsea.us:5349?transport=tcp'];
function mount(source, destination) {
  if (!statSync(source).isFile()) throw new Error('A required local diagnostic file is missing.');
  args.push('--mount', `type=bind,src=${source},dst=${destination},readonly`);
}
mount(resolve(root, '.secret/turn-secret'), '/run/secrets/low-pass-turn-secret');
mount(resolve(root, '.secret/hosting-code'), '/run/secrets/low-pass-hosting-code');
for (const file of ['connectivity.html', 'connectivity.js']) mount(resolve(directory, file), `/opt/low-pass/dist/${file}`);
if (process.env.MULTIPLAYER_PREVIEW_FILE) {
  mount(resolve(root, process.env.MULTIPLAYER_PREVIEW_FILE), '/opt/low-pass/dist/multiplayer.html');
}
const controls = resolve(root, process.env.ROOM_CONTROLS_DIR ?? 'test-results/room-controls');
if (existsSync(controls)) for (const extension of ['html', 'js']) {
  mount(resolve(controls, `room-controls.${extension}`), `/opt/low-pass/dist/room-controls.${extension}`);
}
for (const name of ['formation-preview', 'combat-preview']) for (const extension of ['html', 'js']) {
  const source = resolve(root, `test-results/${name}/${name}.${extension}`);
  if (existsSync(source)) mount(source, `/opt/low-pass/dist/${name}.${extension}`);
}
args.push(process.env.CONNECTIVITY_IMAGE ?? 'low-pass:connectivity-checkpoint');
const child = spawn('docker', args, { stdio: 'inherit' });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('error', () => { console.error('Could not start the local diagnostic container.'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
