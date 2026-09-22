import { defineConfig } from 'vitest/config';
import { identityPlugin } from './scripts/build-identity.mjs';

export default defineConfig({
  plugins: [identityPlugin()],
  test: { include: ['tests/unit/**/*.test.ts', 'tests/server/**/*.test.ts'] },
});
