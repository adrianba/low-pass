import './index.js';
import console from 'node:console';
import { existsSync, unlinkSync } from 'node:fs';
import process from 'node:process';
import { setInterval } from 'node:timers';

// Test-only trigger fails the actual entrypoint once, never its replacement.
setInterval(() => {
  if (!existsSync('/tmp/low-pass-crash-request')) return;
  unlinkSync('/tmp/low-pass-crash-request');
  console.info('Intentional test-only application process exit.');
  process.exit(42);
}, 100).unref();
