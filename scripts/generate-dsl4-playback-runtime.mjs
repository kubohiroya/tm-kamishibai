import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {createDsl4RuntimeBundleSource} from './sb3/dsl4-downloadable-release.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const outputPath = path.join(
  repositoryRoot,
  'src/builder/generated/dsl4-playback-runtime-extension.js',
);
const source = await createDsl4RuntimeBundleSource({profile: 'playback'});

await mkdir(path.dirname(outputPath), {recursive: true});
await writeFile(outputPath, source);
