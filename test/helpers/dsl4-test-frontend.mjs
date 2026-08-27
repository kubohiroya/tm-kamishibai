import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

import {createDsl4ProductionSourceFrontend} from '../../src/builder/index.js';
import {createDsl4SourceFrontend} from '../../src/dsl4/index.js';

export const dsl4TestProjectRoot = fileURLToPath(new URL('../../', import.meta.url));
export const dsl4TestSchema = JSON.parse(
  await readFile(new URL('../../schema/dsl-4.schema.json', import.meta.url), 'utf8'),
);

export function createDsl4TestSourceFrontend(options) {
  return createDsl4SourceFrontend(dsl4TestSchema, options);
}

export function createDsl4TestProductionSourceFrontend(options) {
  return createDsl4ProductionSourceFrontend(dsl4TestSchema, options);
}

export const dsl4TestSourceFrontend = createDsl4TestSourceFrontend();
export const dsl4TestProductionSourceFrontend = createDsl4TestProductionSourceFrontend();
