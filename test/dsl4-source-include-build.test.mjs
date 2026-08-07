import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {strToU8, zipSync} from 'fflate';

import {buildDsl4RuntimeComponent, Dsl4BuildError} from '../src/builder/dsl4-build.js';
import {Sb3BuilderError} from '../src/builder/errors.js';
import {readSb3} from '../src/builder/sb3.js';
import {loadDsl4RuntimeComponent} from '../src/dsl4/runtime-artifact-loader.js';
import {createDsl4RuntimeStartup} from '../src/dsl4/runtime-startup.js';
import {createDsl4SourceFrontend} from '../src/dsl4/source-frontend.js';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const schema = JSON.parse(
  await readFile(path.join(repositoryRoot, 'schema', 'dsl-4.schema.json'), 'utf8'),
);
const frontend = createDsl4SourceFrontend(schema);
const subtleCrypto = webcrypto.subtle;
const sourceManifest = Object.freeze({
  formatVersion: 1,
  mode: 'external',
  sourceId: 'main',
  path: 'story.k4.yml',
});
const rootSource = `
include: chapters/chapter1/scenario.k4.yml
kamishibai: '4.0'
controls:
  keymaps:
    production:
      Space: navigation.nextAction
scenes:
  opening:
    - goto: chapter1
`;
const chapterSource = `
assets:
  ChapterBackground:
    kind: backdrop
    file: image/background.svg
scenes:
  chapter1:
    - stage: ChapterBackground
`;

function baseSb3() {
  const project = {
    targets: [
      {
        isStage: true,
        name: 'Stage',
        variables: {},
        lists: {},
        broadcasts: {},
        blocks: {},
      },
    ],
    monitors: [],
  };
  return Buffer.from(zipSync({'project.json': strToU8(`${JSON.stringify(project)}\n`)}));
}

function buildOptions(projectRoot, extra = {}) {
  return {
    baseSb3Bytes: baseSb3(),
    projectRoot,
    sourceManifest,
    sourceFrontend: frontend,
    controlProfile: 'production',
    channel: 'unbundled',
    maxSourceBytes: 16 * 1024,
    maxSourceFiles: 8,
    maxTotalSourceBytes: 16 * 1024,
    maxIncludeDepth: 4,
    maxAssetFileBytes: 4096,
    maxAssetFiles: 10,
    maxTotalAssetBytes: 16 * 1024,
    subtleCrypto,
    ...extra,
  };
}

async function createIncludedProject() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsl4-source-include-build-'));
  const chapterDirectory = path.join(directory, 'chapters', 'chapter1');
  await mkdir(path.join(chapterDirectory, 'image'), {recursive: true});
  await writeFile(path.join(directory, 'story.k4.yml'), rootSource);
  await writeFile(path.join(chapterDirectory, 'scenario.k4.yml'), chapterSource);
  await writeFile(path.join(chapterDirectory, 'image', 'background.svg'), '<svg/>');
  return directory;
}

test('builds a self-contained component with declaring-source-relative assets', async () => {
  const directory = await createIncludedProject();
  try {
    const built = await buildDsl4RuntimeComponent(
      buildOptions(directory, {
        featureFlags: {dsl4Runtime: true, dsl4SourceIncludes: true},
      }),
    );

    assert.equal(built.runtimeComponent.ok, true);
    assert.equal(built.runtimeComponent.sourceDescriptor.sourceId, 'main');
    assert.doesNotMatch(built.runtimeComponent.sourceDescriptor.text, /^include:/mu);
    assert.match(
      built.runtimeComponent.sourceDescriptor.text,
      /chapters\/chapter1\/image\/background\.svg/u,
    );
    assert.deepEqual(
      built.runtimeComponent.storyDocument.scenes.map(({id}) => id),
      ['opening', 'chapter1'],
    );
    assert.deepEqual(
      built.runtimeComponent.getAssetFile('ChapterBackground', 'background.svg'),
      new TextEncoder().encode('<svg/>'),
    );
    const actionPath = '/scenes/chapter1/actions/0';
    const memoryOrigin = built.runtimeComponent.storyDocument.sourceOrigins[actionPath];
    assert.equal(memoryOrigin.sourceId, 'chapters/chapter1/scenario.k4.yml');
    assert.deepEqual(
      built.runtimeComponent.storyDocument.scenes[1].actions[0].sourceRange,
      memoryOrigin.range,
    );

    const persisted = readSb3(built.bytes).project;
    const reloaded = await loadDsl4RuntimeComponent(persisted, frontend, {
      maxSourceBytes: 16 * 1024,
      maxAssetFiles: 10,
      maxAssetBytes: 16 * 1024,
      subtleCrypto,
    });
    assert.equal(reloaded.ok, true);
    assert.deepEqual(reloaded.storyDocument.sourceOrigins[actionPath], memoryOrigin);
    assert.deepEqual(reloaded.storyDocument.scenes[1].actions[0].sourceRange, memoryOrigin.range);

    let startupOrigin = null;
    const startup = await createDsl4RuntimeStartup({
      featureFlags: {dsl4Runtime: true, dsl4SourceIncludes: true},
      project: persisted,
      sourceFrontend: frontend,
      maxSourceBytes: 16 * 1024,
      maxAssetFiles: 10,
      maxAssetBytes: 16 * 1024,
      subtleCrypto,
      createRuntimeEnvironment(component) {
        startupOrigin = component.storyDocument.sourceOrigins[actionPath];
        return {port: {}, dispose() {}};
      },
    });
    assert.equal(startup.ok, true);
    assert.deepEqual(startupOrigin, memoryOrigin);
    await startup.session.dispose();

    const missingOrigin = structuredClone(persisted);
    const storedSource = missingOrigin.extensionStorage.kubohiroyakamishibairuntime4.source;
    storedSource.sourceOrigins.entries = storedSource.sourceOrigins.entries.filter(
      ({storyPath}) => storyPath !== actionPath,
    );
    const rejected = await loadDsl4RuntimeComponent(missingOrigin, frontend, {
      maxSourceBytes: 16 * 1024,
      maxAssetFiles: 10,
      maxAssetBytes: 16 * 1024,
      subtleCrypto,
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.diagnostics[0].code, 'K4-SOURCE-ORIGIN-COVERAGE-001');
    assert.equal(rejected.diagnostics[0].path, '$.source.sourceOrigins');
    assert.equal(JSON.stringify(built).includes(directory), false);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('keeps include disabled unless the startup-fixed feature flag is enabled', async () => {
  const directory = await createIncludedProject();
  try {
    await assert.rejects(
      buildDsl4RuntimeComponent(buildOptions(directory)),
      (error) =>
        error instanceof Dsl4BuildError &&
        error.stage === 'dsl4-parse' &&
        error.code === 'K4-SCHEMA-UNKNOWN-KEY',
    );
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('rejects an included source symlink which escapes the project root', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsl4-source-include-root-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'dsl4-source-include-outside-'));
  try {
    await mkdir(path.join(directory, 'chapters'));
    await writeFile(
      path.join(directory, 'story.k4.yml'),
      rootSource.replace('chapters/chapter1/scenario.k4.yml', 'chapters/escape.k4.yml'),
    );
    const outsideSource = path.join(outside, 'escape.k4.yml');
    await writeFile(outsideSource, chapterSource);
    await symlink(outsideSource, path.join(directory, 'chapters', 'escape.k4.yml'));

    await assert.rejects(
      buildDsl4RuntimeComponent(
        buildOptions(directory, {
          featureFlags: {dsl4Runtime: true, dsl4SourceIncludes: true},
        }),
      ),
      (error) =>
        error instanceof Sb3BuilderError &&
        error.stage === 'dsl4-source-graph' &&
        error.code === 'K4-SOURCE-PATH-001' &&
        !error.message.includes(outside),
    );
  } finally {
    await rm(directory, {recursive: true, force: true});
    await rm(outside, {recursive: true, force: true});
  }
});
