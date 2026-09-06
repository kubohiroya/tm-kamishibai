import {spawnSync} from 'node:child_process';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Browser-driven suites load modules from `dist/` over HTTP, because a browser cannot execute
 * TypeScript sources. Building here keeps a direct `vitest run --config vitest.e2e.config.ts`
 * from silently testing a stale compiled package.
 */
export default function setup() {
  const result = spawnSync(process.execPath, ['scripts/build-lib.mjs'], {
    cwd: projectRoot,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('scripts/build-lib.mjs failed before the E2E suites');
}
