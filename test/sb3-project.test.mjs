import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {strToU8, zipSync} from 'fflate';

import {
  defaultKamishibaiSb3Path,
  loadKamishibaiProject,
  resolveKamishibaiSb3Path,
} from './helpers/sb3-project.mjs';
import {prepareTestSb3} from '../scripts/sb3/prepare-test.mjs';

async function withTemporaryDirectory(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tmpose-sb3-project-test-'));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}

test('uses the generated SB3 by default and preserves the environment override', () => {
  assert.equal(resolveKamishibaiSb3Path({}), defaultKamishibaiSb3Path);
  assert.equal(
    resolveKamishibaiSb3Path({KAMISHIBAI_SB3_PATH: '/custom/project.sb3'}),
    '/custom/project.sb3',
  );
});

test('loads project.json from an SB3 archive', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sb3Path = path.join(directory, 'project.sb3');
    const expectedProject = {targets: [], extensionURLs: {}};
    await writeFile(
      sb3Path,
      zipSync({
        'project.json': strToU8(JSON.stringify(expectedProject)),
      }),
    );

    assert.deepEqual(loadKamishibaiProject(sb3Path), expectedProject);
  });
});

test('bundles Animated Text with every embedded dynamic caller', () => {
  const project = loadKamishibaiProject();
  const memberIds = ['kubohiroyaassetmanager', 'text', 'kubohiroyakamishibairuntime'];
  assert(project.extensions.includes('tmposebundle'));
  assert.equal(
    memberIds.some((memberId) => project.extensions.includes(memberId)),
    false,
  );
  assert.equal(
    memberIds.some((memberId) => Object.hasOwn(project.extensionURLs, memberId)),
    false,
  );

  const bundleUrl = project.extensionURLs.tmposebundle;
  assert.match(bundleUrl, /^data:text\/javascript;base64,/u);
  const bundleSource = Buffer.from(bundleUrl.slice(bundleUrl.indexOf(',') + 1), 'base64').toString(
    'utf8',
  );
  for (const memberId of memberIds) assert(bundleSource.includes(`//   ID: ${memberId}`));
  assert(bundleSource.includes("property === 'getOpcodeFunction'"));

  const opcodes = project.targets.flatMap((target) =>
    Object.values(target.blocks ?? {}).map((block) => block.opcode),
  );
  assert(
    opcodes.includes('tmposebundle_kubohiroyaassetmanager__setThisSpriteSkin'),
    'Asset Manager project blocks must use the bundle namespace.',
  );
  assert(
    opcodes.includes('tmposebundle_text__animateText'),
    'Animated Text project blocks must use the bundle namespace.',
  );
  assert.equal(
    opcodes.some((opcode) =>
      /^(?:kubohiroyaassetmanager|text|kubohiroyakamishibairuntime)_/u.test(opcode),
    ),
    false,
  );
});

test('skips generated output preparation when an SB3 path is configured', async () => {
  let buildCalled = false;
  const result = await prepareTestSb3({
    build: async () => {
      buildCalled = true;
    },
    environment: {KAMISHIBAI_SB3_PATH: '/custom/project.sb3'},
  });

  assert.equal(buildCalled, false);
  assert.deepEqual(result, {
    configured: true,
    outputPath: '/custom/project.sb3',
  });
});

test('prepares the generated default SB3 with explicit replacement authorization', async () => {
  let buildOptions;
  const result = await prepareTestSb3({
    build: async (options) => {
      buildOptions = options;
      return {changed: true, outputPath: '/generated/project.sb3'};
    },
    environment: {},
  });

  assert.deepEqual(buildOptions, {
    environment: {},
    outputPath: defaultKamishibaiSb3Path,
    sourceDirectory: path.resolve('app'),
    yes: true,
  });
  assert.deepEqual(result, {
    changed: true,
    configured: false,
    outputPath: '/generated/project.sb3',
  });
});
