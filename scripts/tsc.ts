import {createRequire} from 'node:module';
import path from 'node:path';
import process from 'node:process';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);

/**
 * The TypeScript 7 compiler, installed as `typescript7` (`npm:typescript@7.0.2`). `typescript` stays
 * on 6 because `typescript-eslint` still drives TypeScript's JavaScript API, which TypeScript 7 no
 * longer exports. TypeScript 7 does not export `bin/tsc` either, so resolve it beside its manifest
 * instead of going through `node_modules/.bin`, where both packages offer a `tsc`.
 */
export const tscPath = path.join(
  path.dirname(require.resolve('typescript7/package.json')),
  'bin/tsc',
);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = spawnSync(process.execPath, [tscPath, ...process.argv.slice(2)], {
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
