import {defineConfig} from 'vitest/config';

/** Chromium-driven end-to-end tests share a single browser download and must not run in parallel. */
export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    globalSetup: ['test/e2e/global-setup.ts'],
    globals: false,
    include: ['test/e2e/*.test.{mjs,ts}'],
    pool: 'forks',
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
