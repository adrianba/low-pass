import './index.js';
import process from 'node:process';
import { setTimeout } from 'node:timers';

// Establish Docker's restart policy, then fail the actual application process.
setTimeout(() => process.exit(42), 11_000);
