import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {createDsl4RuntimeBundleSource} from './sb3/dsl4-downloadable-release.ts';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
/** @type {[string, 'authoring' | 'playback', boolean][]} */
const variants = [
  ['dsl4-playback-runtime-extension.js', 'playback', false],
  ['dsl41-narrative-playback-runtime-extension.js', 'playback', true],
  ['dsl41-narrative-authoring-runtime-extension.js', 'authoring', true],
];
for (const [filename, profile, narrativeControlEnabled] of variants) {
  const outputPath = path.join(repositoryRoot, 'src/builder/generated', filename);
  const source = await createDsl4RuntimeBundleSource({profile, narrativeControlEnabled});
  await mkdir(path.dirname(outputPath), {recursive: true});
  await writeFile(outputPath, source);
}
