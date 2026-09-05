import {defineConfig} from 'vitest/config';

/**
 * The suite mirrors the historical `node --test` layout: unit and preview tests live directly
 * under `test/`, while browser-driven end-to-end tests live under `test/e2e/` and run from
 * `vitest.e2e.config.ts` so they keep their serial execution guarantees.
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['test/*.test.{mjs,ts}'],
    pool: 'forks',
    testTimeout: 120_000,
    hookTimeout: 120_000,
    reporters: ['default'],
  },
});
