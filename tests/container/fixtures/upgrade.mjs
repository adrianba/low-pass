import { Buffer } from 'node:buffer';
import console from 'node:console';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { ApplicationService } from './application.js';
import { readServiceConfig } from './config.js';

const service = new ApplicationService(readServiceConfig(process.env), console.warn);
const server = service.server;
server.on('upgrade', (request, socket) => {
  const key = request.headers['sec-websocket-key'];
  if (request.url !== '/signal' || request.httpVersion !== '1.1' ||
    request.headers.upgrade !== 'websocket' || request.headers.connection?.toLowerCase() !== 'upgrade' ||
    typeof key !== 'string') {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return;
  }
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  let buffered = Buffer.alloc(0);
  socket.on('data', chunk => {
    buffered = Buffer.concat([buffered, chunk]);
    if (buffered.length < 2) return;
    const length = buffered[1] & 127;
    if (length > 125 || !(buffered[1] & 128)) throw new Error('Unexpected test client frame.');
    if (buffered.length < 6 + length) return;
    if ((buffered[0] & 15) === 8) { socket.end(Buffer.from([0x88, 0])); return; }
    const payload = Buffer.from(buffered.subarray(6, 6 + length));
    for (let i = 0; i < length; i++) payload[i] ^= buffered[2 + i % 4];
    if (payload.toString() !== 'probe') throw new Error('Unexpected test client payload.');
    const reply = Buffer.from('echo:probe');
    socket.write(Buffer.concat([Buffer.from([0x81, reply.length]), reply]));
    buffered = buffered.subarray(6 + length);
  });
});
await service.listen();
process.on('SIGTERM', () => {
  void service.close().then(() => console.info('Application service stopped.'));
});
