import path from 'node:path';
import {defineConfig} from 'vitest/config';

// Select an unpublished dependency only for the cross-repository contract test.
const source = process.env.KVS_CLEANUP_SOURCE;
if (!source) throw new Error('KVS_CLEANUP_SOURCE must point to session-binary-backing.ts');
export default defineConfig({
  resolve: {alias: {'@kubohiroya/turbowarp-kvs/session-binary-backing': path.resolve(source)}},
  test: {
    environment: 'node',
    pool: 'forks',
    include: ['test/dsl4-binary-store-product-wiring.test.ts'],
    testNamePattern: /patched KVS cleanup retries/,
  },
});
