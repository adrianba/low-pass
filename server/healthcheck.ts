import { readServiceConfig } from './config.js';

try {
  const config = readServiceConfig(process.env);
  const host = config.host === '0.0.0.0' ? '127.0.0.1' : config.host === '::' ? '::1' : config.host;
  const authority = host.includes(':') ? `[${host}]` : host;
  const response = await fetch(`http://${authority}:${config.port}/healthz`, { signal: AbortSignal.timeout(2000) });
  if (response.status !== 200 || await response.text() !== 'ok\n') throw new Error('Unexpected health response.');
} catch {
  console.error('Application health check failed.');
  process.exitCode = 1;
}
