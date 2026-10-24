import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'vitest';

import {fromByteArray, toByteArray} from 'base64-js';
import {strFromU8, strToU8, unzipSync, zipSync} from 'fflate';

import {buildDsl4RuntimeComponent} from '../src/builder/index.js';
import {parseCliArguments} from '../src/builder/cli.js';
import {
  createDsl4SourceFrontend,
  Dsl4SealedStoryError,
  loadDsl4RuntimeComponent,
  openDsl4SealedStoryArtifact,
} from '../src/dsl4/index.js';
import {createDsl4RuntimeStartup} from '../src/dsl4/runtime-startup.js';
import {requireRecord} from './helpers/require-value.ts';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const schema = JSON.parse(
  await readFile(path.join(repositoryRoot, 'schema', 'dsl-4.schema.json'), 'utf8'),
);
const frontend = createDsl4SourceFrontend(schema);
const subtleCrypto = webcrypto.subtle;
// The fewest iterations the reader accepts, so the suite stays quick.
const iterations = 100_000;
const password = 'correct horse battery staple';
const lineMarker = 'sealed-line-41c2';
const assetMarker = 'sealed-asset-9b7e';
const source = `
kamishibai: '4.0'
assets:
  Opening:
    kind: backdrop
    file: assets/opening.svg
variables:
  ${lineMarker}: 0
controls:
  keymaps:
    production:
      Space: navigation.nextAction
scenes:
  opening:
    actions:
      - stage: Opening
      - wait: 1
`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg"><title>${assetMarker}</title></svg>`;

function baseSb3() {
  const project = {
    extensionStorage: {},
    targets: [{isStage: true, name: 'Stage', variables: {}, lists: {}, broadcasts: {}, blocks: {}}],
    monitors: [],
  };
  return Buffer.from(zipSync({'project.json': strToU8(JSON.stringify(project))}));
}

async function withProject<T>(callback: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsl4-sealed-artifact-'));
  try {
    await mkdir(path.join(directory, 'assets'));
    await writeFile(path.join(directory, 'story.kamishibai.yaml'), source);
    await writeFile(path.join(directory, 'assets', 'opening.svg'), svg);
    return await callback(directory);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}

function build(directory: string, channel: 'bundled' | 'unbundled', extra = {}) {
  return buildDsl4RuntimeComponent({
    baseSb3Bytes: baseSb3(),
    projectRoot: directory,
    sourceManifest: {
      formatVersion: 1,
      mode: 'external',
      sourceId: 'main',
      path: 'story.kamishibai.yaml',
    },
    sourceFrontend: frontend,
    controlProfile: 'production',
    channel,
    maxSourceBytes: 16 * 1024,
    maxAssetFileBytes: 4096,
    maxAssetFiles: 10,
    maxTotalAssetBytes: 16 * 1024,
    subtleCrypto,
    distributionProfile: 'sealed',
    sealedPassword: password,
    sealedIterations: iterations,
    ...extra,
  });
}

function runtimeStorage(project: unknown, channel: 'bundled' | 'unbundled') {
  const storage = requireRecord(requireRecord(project, 'project').extensionStorage, 'storage');
  if (channel === 'unbundled')
    return requireRecord(storage.kubohiroyakamishibairuntime4, 'runtime');
  return requireRecord(
    requireRecord(requireRecord(storage.kubohiroyakamishibai4, 'bundle').components, 'components')
      .kubohiroyakamishibairuntime4,
    'runtime',
  );
}

const loadOptions = {
  maxSourceBytes: 16 * 1024,
  maxAssetFiles: 10,
  maxTotalAssetBytes: 16 * 1024,
  subtleCrypto,
};

async function loadCode(project: unknown, unlock?: (request: never) => string | null) {
  const result = requireRecord(
    await loadDsl4RuntimeComponent(project, frontend, {
      ...loadOptions,
      ...(unlock ? {unlockSealedStory: unlock} : {}),
    }),
    'result',
  );
  if (result.ok === true) return 'ok';
  return (result.diagnostics as {code: string}[])[0]!.code;
}

test('seals the story and its assets so neither is readable in the SB3', async () => {
  await withProject(async (directory) => {
    for (const channel of ['unbundled', 'bundled'] as const) {
      const built = await build(directory, channel);
      const text = Object.values(unzipSync(built.bytes))
        .map((entry) => strFromU8(entry, true))
        .join('\n');
      for (const leak of [lineMarker, assetMarker, 'opening.svg', 'kamishibai: ', '"scenes"']) {
        assert.equal(text.includes(leak), false, `sealed SB3 leaks ${leak}`);
      }
      const storage = runtimeStorage(built.project, channel);
      for (const key of ['source', 'compiled', 'assets'])
        assert.equal(storage[key], undefined, `sealed component keeps ${key}`);
      const sealed = requireRecord(storage.sealed, 'sealed');
      assert.equal(sealed.profile, 'sealed');
      assert.deepEqual(requireRecord(sealed.keyDerivation, 'kdf').iterations, iterations);

      const component = requireRecord(built.runtimeComponent, 'component');
      assert.equal(component.ok, true);
      assert.equal(component.distributionProfile, 'sealed');
      const story = requireRecord(component.storyDocument, 'story');
      assert.deepEqual(Object.keys(requireRecord(story.variables, 'variables')), [lineMarker]);
      const getAssetFile = component.getAssetFile as (id: string, file: string) => Uint8Array;
      assert.equal(new TextDecoder().decode(getAssetFile('Opening', 'opening.svg')), svg);
    }
  });
});

test('refuses a sealed story without a password, with a wrong one, or once changed', async () => {
  await withProject(async (directory) => {
    const built = await build(directory, 'bundled');
    const project = () => structuredClone(built.project) as Record<string, unknown>;
    assert.equal(await loadCode(project(), () => password), 'ok');
    assert.equal(await loadCode(project()), 'K4-SEALED-KEY-REQUIRED');
    assert.equal(await loadCode(project(), () => 'not the password'), 'K4-SEALED-AUTH-001');

    // The header is authenticated: any change fails exactly like a wrong password.
    for (const change of [
      (sealed: Record<string, unknown>) => {
        sealed.sourceIntegrity = `sha256-${'A'.repeat(43)}=`;
      },
      (sealed: Record<string, unknown>) => {
        requireRecord(sealed.keyDerivation, 'kdf').iterations = iterations + 1;
      },
      (sealed: Record<string, unknown>) => {
        const bytes = toByteArray(String(sealed.ciphertext));
        bytes[0] = bytes[0]! ^ 0xff;
        sealed.ciphertext = fromByteArray(bytes);
      },
    ]) {
      const changed = project();
      change(runtimeStorage(changed, 'bundled').sealed as Record<string, unknown>);
      assert.equal(await loadCode(changed, () => password), 'K4-SEALED-AUTH-001');
    }

    const beside = project();
    runtimeStorage(beside, 'bundled').assets = {formatVersion: 1};
    assert.equal(await loadCode(beside, () => password), 'K4-SEALED-STORY-001');

    const unknownKey = project();
    (runtimeStorage(unknownKey, 'bundled').sealed as Record<string, unknown>).plaintext = 'x';
    assert.equal(await loadCode(unknownKey, () => password), 'K4-FORMAT-UNKNOWN-KEY-001');
  });
});

test('seals with a fresh salt and IV every time', async () => {
  await withProject(async (directory) => {
    const [first, second] = [await build(directory, 'bundled'), await build(directory, 'bundled')];
    const sealedOf = (built: {project: unknown}) =>
      requireRecord(runtimeStorage(built.project, 'bundled').sealed, 'sealed');
    assert.notEqual(sealedOf(first).ciphertext, sealedOf(second).ciphertext);
    assert.notDeepEqual(sealedOf(first).cipher, sealedOf(second).cipher);
    const opened = await openDsl4SealedStoryArtifact(sealedOf(second), password);
    assert.equal(opened.compiled.profile, 'compiled');
  });
});

test('refuses to seal assets kept outside project.json or without a password', async () => {
  await withProject(async (directory) => {
    await assert.rejects(
      build(directory, 'bundled', {
        featureFlags: {dsl4Runtime: true, dsl4RootBinaryEntryPackaging: true},
      }),
      (error: unknown) => (error as {code?: string}).code === 'K4-SEALED-ASSETS-001',
    );
    await assert.rejects(
      build(directory, 'bundled', {sealedPassword: undefined}),
      /sealedPassword is required/,
    );
    await assert.rejects(
      openDsl4SealedStoryArtifact({formatVersion: 1}, password),
      (error: unknown) => error instanceof Dsl4SealedStoryError,
    );
  });
});

test('build-dsl4 reads the sealed password from a named environment variable', () => {
  const required = [
    'build-dsl4',
    '--base',
    'base.sb3',
    '--project-root',
    '.',
    '--output',
    'out.sb3',
    '--control-profile',
    'production',
    '--channel',
    'bundled',
  ];
  const optionsOf = (parsed: unknown) =>
    requireRecord(requireRecord(parsed, 'parsed').options, 'options');
  process.env.DSL4_SEALED_TEST_PASSWORD = password;
  try {
    const options = optionsOf(
      parseCliArguments([
        ...required,
        '--distribution-profile',
        'sealed',
        '--sealed-password-env',
        'DSL4_SEALED_TEST_PASSWORD',
      ]),
    );
    assert.equal(options.distributionProfile, 'sealed');
    assert.equal(options.sealedPassword, password);
    assert.throws(
      () => parseCliArguments([...required, '--distribution-profile', 'sealed']),
      /--sealed-password-env is required/,
    );
    assert.throws(
      () =>
        parseCliArguments([
          ...required,
          '--distribution-profile',
          'sealed',
          '--sealed-password-env',
          'DSL4_SEALED_TEST_MISSING',
        ]),
      /must hold the password/,
    );
  } finally {
    delete process.env.DSL4_SEALED_TEST_PASSWORD;
  }
});

test('asks again after a wrong password and stops when the viewer declines', async () => {
  await withProject(async (directory) => {
    const built = await build(directory, 'bundled');
    const project = () => structuredClone(built.project) as Record<string, unknown>;
    const asked: unknown[] = [];
    const answers = (sequence: (string | null)[]) => (request: unknown) => {
      asked.push(request);
      return sequence.shift() ?? null;
    };

    assert.equal(await loadCode(project(), answers(['wrong', password]) as never), 'ok');
    assert.deepEqual(
      asked.map((request) => {
        const {attempt, previousAttemptFailed} = request as Record<string, unknown>;
        return [attempt, previousAttemptFailed];
      }),
      [
        [1, false],
        [2, true],
      ],
    );

    asked.length = 0;
    assert.equal(
      await loadCode(project(), answers(['wrong', null]) as never),
      'K4-SEALED-KEY-REQUIRED',
    );
    assert.equal(asked.length, 2);

    asked.length = 0;
    assert.equal(
      await loadCode(project(), answers(Array(10).fill('wrong')) as never),
      'K4-SEALED-AUTH-001',
    );
    assert.equal(asked.length, 5, 'one load asks at most five times');
  });
});

test('runtime startup passes the unlock callback through to the loader', async () => {
  await withProject(async (directory) => {
    const built = await build(directory, 'bundled');
    const start = (unlockSealedStory?: () => string) =>
      createDsl4RuntimeStartup({
        featureFlags: {dsl4Runtime: true},
        project: structuredClone(built.project),
        sourceFrontend: frontend,
        ...loadOptions,
        ...(unlockSealedStory ? {unlockSealedStory} : {}),
        createRuntimeEnvironment: () => ({port: {}, dispose() {}}),
      });
    const refused = requireRecord(await start(), 'refused startup');
    assert.equal(refused.ok, false);
    assert.equal((refused.diagnostics as {code: string}[])[0]!.code, 'K4-SEALED-KEY-REQUIRED');
    const opened = requireRecord(await start(() => password), 'opened startup');
    assert.equal(opened.ok, true);
    await (opened.session as {dispose(): Promise<unknown>}).dispose();
  });
});
