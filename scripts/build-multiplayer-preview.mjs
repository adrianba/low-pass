import { copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';

await copyFile(resolve('dist/index.html'), resolve('dist/multiplayer.html'));
console.info('Added the opt-in local multiplayer application entry to the existing build. Do not publish this development preview.');
