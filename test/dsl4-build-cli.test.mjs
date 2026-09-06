import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'vitest';
import {fileURLToPath} from 'node:url';

import {strToU8, unzipSync, zipSync} from 'fflate';

import {dsl4CliDefaultLimits, parseCliArguments, runCli, usage} from '../src/builder/cli.js';
import {
  createDsl4SourceFrontend,
  dsl4BinaryEntryPrefix,
  loadDsl4BinaryEntryRuntimeComponent,
  loadDsl4RuntimeComponent,
  parseDsl4ExternalSourceManifestSource,
} from '../src/dsl4/index.js';
import {readSb3} from '../src/builder/sb3.js';
import {sha256} from '../src/builder/hash.js';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const schema = JSON.parse(
  await readFile(path.join(repositoryRoot, 'schema', 'dsl-4.schema.json'), 'utf8'),
);
const frontend = createDsl4SourceFrontend(schema);
const limits = Object.freeze({
  maxSourceBytes: 16 * 1024,
  maxAssetFileBytes: 4096,
  maxAssetFiles: 10,
  maxTotalAssetBytes: 16 * 1024,
});
const validSource = `
kamishibai: '4.0'
assets:
  OpeningImage:
    kind: backdrop
    file: opening.svg
    loading: lazy
controls:
  keymaps:
    production:
      Space: navigation.nextAction
scenes:
  opening:
    - stage: OpeningImage
`;

function baseProject() {
  return {
    extensionStorage: {},
    targets: [
      {
        isStage: true,
        name: 'Stage',
        variables: {},
        lists: {},
        broadcasts: {},
        blocks: {start: {opcode: 'event_whenflagclicked', next: null, parent: null}},
      },
    ],
    monitors: [],
  };
}

function baseSb3() {
  return Buffer.from(
    zipSync({
      'project.json': strToU8(`${JSON.stringify(baseProject())}\n`),
      'existing.svg': strToU8('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    }),
  );
}

async function withFixture(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsl4-build-cli-'));
  try {
    const outputDirectory = path.join(directory, 'dist');
    await mkdir(outputDirectory);
    const baseSb3Path = path.join(directory, 'base.sb3');
    const sourcePath = path.join(directory, 'story.k4.yml');
    const sourceManifestPath = path.join(directory, 'project.source.yml');
    await writeFile(baseSb3Path, baseSb3());
    await writeFile(sourcePath, validSource);
    await writeFile(path.join(directory, 'opening.svg'), '<svg/>');
    await writeFile(sourceManifestPath, '');
    return await callback({
      baseSb3Path,
      directory,
      outputDirectory,
      sourceManifestPath,
      sourcePath,
    });
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}

function cliArguments(fixture, outputName = 'story.sb3', extra = []) {
  return [
    'build-dsl4',
    '--base',
    fixture.baseSb3Path,
    '--project-root',
    fixture.directory,
    '--source-manifest',
    fixture.sourceManifestPath,
    '--output',
    path.join(fixture.outputDirectory, outputName),
    '--control-profile',
    'production',
    '--channel',
    'bundled',
    '--max-source-bytes',
    String(limits.maxSourceBytes),
    '--max-asset-file-bytes',
    String(limits.maxAssetFileBytes),
    '--max-asset-files',
    String(limits.maxAssetFiles),
    '--max-total-asset-bytes',
    String(limits.maxTotalAssetBytes),
    ...extra,
  ];
}

function withoutDefaultLimitOptions(arguments_) {
  const options = new Set([
    '--max-source-bytes',
    '--max-asset-file-bytes',
    '--max-asset-files',
    '--max-total-asset-bytes',
  ]);
  const result = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    if (options.has(arguments_[index])) {
      index += 1;
    } else {
      result.push(arguments_[index]);
    }
  }
  return result;
}

test('parses build-dsl4 defaults and rejects incomplete or invalid input', () => {
  const fixture = {
    baseSb3Path: 'base.sb3',
    directory: 'project',
    sourceManifestPath: 'project/project.source.yaml',
    outputDirectory: 'dist',
  };
  const parsed = parseCliArguments(cliArguments(fixture));
  assert.equal(parsed.action, 'build-dsl4');
  assert.equal(parsed.options.channel, 'bundled');
  assert.equal(parsed.options.controlProfile, 'production');
  assert.equal(parsed.options.maxAssetFiles, limits.maxAssetFiles);
  assert.equal(parsed.options.historyNavigationAvailable, false);
  assert.equal(parsed.options.replaceExisting, false);
  assert.match(usage(), /build-dsl4/u);
  assert.match(usage(), /--enable-source-includes/u);
  assert.match(usage(), /--enable-root-binary-entries/u);
  const defaulted = parseCliArguments(withoutDefaultLimitOptions(cliArguments(fixture)));
  assert.deepEqual(
    {
      maxSourceBytes: defaulted.options.maxSourceBytes,
      maxAssetFileBytes: defaulted.options.maxAssetFileBytes,
      maxAssetFiles: defaulted.options.maxAssetFiles,
      maxTotalAssetBytes: defaulted.options.maxTotalAssetBytes,
    },
    dsl4CliDefaultLimits,
  );

  const rootBinary = parseCliArguments(
    cliArguments(fixture, 'story.sb3', ['--enable-root-binary-entries']),
  );
  assert.deepEqual(rootBinary.options.featureFlags, {
    dsl4Runtime: true,
    dsl4RootBinaryEntryPackaging: true,
  });

  const includes = parseCliArguments(
    cliArguments(fixture, 'story.sb3', [
      '--enable-source-includes',
      '--max-source-files',
      '8',
      '--max-total-source-bytes',
      String(limits.maxSourceBytes),
      '--max-include-depth',
      '4',
    ]),
  );
  assert.deepEqual(includes.options.featureFlags, {
    dsl4Runtime: true,
    dsl4SourceIncludes: true,
  });
  assert.equal(includes.options.maxSourceFiles, 8);
  assert.equal(includes.options.maxTotalSourceBytes, limits.maxSourceBytes);
  assert.equal(includes.options.maxIncludeDepth, 4);
  assert.throws(
    () => parseCliArguments([...cliArguments(fixture), '--enable-source-includes']),
    /Missing required option: --max-source-files/u,
  );
  assert.throws(
    () =>
      parseCliArguments(
        cliArguments(fixture, 'story.sb3', [
          '--enable-source-includes',
          '--max-source-files',
          '8',
          '--max-total-source-bytes',
          String(limits.maxSourceBytes - 1),
          '--max-include-depth',
          '4',
        ]),
      ),
    /greater than or equal/u,
  );

  assert.throws(
    () => parseCliArguments(cliArguments(fixture).filter((value) => value !== '--channel')),
    /Unknown option: bundled|Missing required option/u,
  );
  const zeroLimit = cliArguments(fixture);
  zeroLimit[zeroLimit.indexOf('--max-source-bytes') + 1] = '0';
  assert.throws(() => parseCliArguments(zeroLimit), /integer >= 1/u);
  const fractionalLimit = cliArguments(fixture);
  fractionalLimit[fractionalLimit.indexOf('--max-asset-files') + 1] = '1.5';
  assert.throws(() => parseCliArguments(fractionalLimit), /integer >= 1/u);
  const unknownChannel = cliArguments(fixture);
  unknownChannel[unknownChannel.indexOf('--channel') + 1] = 'automatic';
  assert.throws(() => parseCliArguments(unknownChannel), /bundled or unbundled/u);
  assert.throws(
    () => parseCliArguments([...cliArguments(fixture), '--replace-existing', '--replace-existing']),
    /Duplicate option/u,
  );
});

test('builds one deterministic self-contained SB3 and revalidates the installed candidate', async () => {
  await withFixture(async (fixture) => {
    const inputBefore = await Promise.all([
      readFile(fixture.baseSb3Path),
      readFile(fixture.sourceManifestPath),
      readFile(fixture.sourcePath),
    ]);
    let stdout = '';
    const first = await runCli(withoutDefaultLimitOptions(cliArguments(fixture)), {
      stdout: {write: (chunk) => (stdout += chunk)},
    });
    assert(first);
    assert.equal(stdout, 'Built story.sb3\n');
    assert.equal(stdout.includes(fixture.directory), false);

    const firstBytes = await readFile(first.outputPath);
    const {project} = readSb3(firstBytes);
    const loaded = await loadDsl4RuntimeComponent(project, frontend, {
      maxSourceBytes: limits.maxSourceBytes,
      maxAssetFiles: limits.maxAssetFiles,
      maxAssetBytes: limits.maxTotalAssetBytes,
      subtleCrypto: webcrypto.subtle,
    });
    assert.equal(loaded.ok, true, JSON.stringify(loaded.diagnostics));
    assert.equal(loaded.channel, 'bundled');
    const persistedManifest = parseDsl4ExternalSourceManifestSource(
      await readFile(fixture.sourceManifestPath, 'utf8'),
      {filename: path.basename(fixture.sourceManifestPath)},
    );
    assert.equal(persistedManifest.path, 'story.k4.yml');
    assert.match(persistedManifest.cacheId, /^[a-z0-9][a-z0-9_-]{7,63}$/u);
    assert.equal(
      persistedManifest.cacheDatabaseName,
      `tw-kamishibai-assets-v1--story.k4--${persistedManifest.cacheId}`,
    );
    assert.deepEqual(loaded.sourceDescriptor.cacheIdentity, {
      id: persistedManifest.cacheId,
      label: 'story.k4.yml',
      databaseName: persistedManifest.cacheDatabaseName,
    });
    assert.deepEqual(
      loaded.getAssetFile('OpeningImage', 'opening.svg'),
      new TextEncoder().encode('<svg/>'),
    );
    assert.deepEqual(project.targets[0].blocks, baseProject().targets[0].blocks);

    const second = await runCli(
      withoutDefaultLimitOptions(cliArguments(fixture, 'story-second.sb3')),
      {stdout: {write() {}}},
    );
    assert.deepEqual(await readFile(second.outputPath), firstBytes);
    assert.deepEqual(await readFile(fixture.baseSb3Path), inputBefore[0]);
    assert.deepEqual(await readFile(fixture.sourcePath), inputBefore[2]);
    assert.notDeepEqual(await readFile(fixture.sourceManifestPath), inputBefore[1]);
  });
});

test('builds the only root .k4.yml without a manifest and does not create one', async () => {
  await withFixture(async (fixture) => {
    await rm(fixture.sourceManifestPath);
    const arguments_ = cliArguments(fixture, 'manifest-free.sb3');
    arguments_.splice(arguments_.indexOf('--source-manifest'), 2);

    const result = await runCli(arguments_, {stdout: {write() {}}});
    assert.equal(path.basename(result.outputPath), 'manifest-free.sb3');
    assert.equal(
      (await readdir(fixture.directory)).some((name) =>
        /^project\.source\.(?:yml|yaml|json)$/u.test(name),
      ),
      false,
    );
    const {project} = readSb3(await readFile(result.outputPath));
    const loaded = await loadDsl4RuntimeComponent(project, frontend, {
      maxSourceBytes: limits.maxSourceBytes,
      maxAssetFiles: limits.maxAssetFiles,
      maxAssetBytes: limits.maxTotalAssetBytes,
      subtleCrypto: webcrypto.subtle,
    });
    assert.equal(loaded.sourceDescriptor.displayName, 'story.k4.yml');
  });
});

test('keeps explicit project.source.json manifests compatible', async () => {
  await withFixture(async (fixture) => {
    const sourceManifestPath = path.join(fixture.directory, 'project.source.json');
    await writeFile(
      sourceManifestPath,
      `${JSON.stringify({formatVersion: 1, mode: 'external', sourceId: 'main'})}\n`,
    );
    const result = await runCli(cliArguments({...fixture, sourceManifestPath}, 'legacy-json.sb3'), {
      stdout: {write() {}},
    });
    assert.equal(path.basename(result.outputPath), 'legacy-json.sb3');
    const persisted = JSON.parse(await readFile(sourceManifestPath, 'utf8'));
    assert.equal(persisted.path, 'story.k4.yml');
    assert.match(persisted.cacheId, /^[a-z0-9][a-z0-9_-]{7,63}$/u);
  });
});

test('replaces the Standard authoring runtime with the generated playback profile', async () => {
  await withFixture(async (fixture) => {
    const project = baseProject();
    project.extensions = ['kubohiroyakamishibai4'];
    project.extensionURLs = {
      kubohiroyakamishibai4: 'data:text/javascript;base64,YXV0aG9yaW5n',
    };
    await writeFile(
      fixture.baseSb3Path,
      Buffer.from(
        zipSync({
          'project.json': strToU8(`${JSON.stringify(project)}\n`),
          'existing.svg': strToU8('<svg xmlns="http://www.w3.org/2000/svg"/>'),
        }),
      ),
    );
    const result = await runCli(cliArguments(fixture, 'playback.sb3'), {
      stdout: {write() {}},
    });
    const outputProject = readSb3(await readFile(result.outputPath)).project;
    const dataUrl = outputProject.extensionURLs.kubohiroyakamishibai4;
    assert.match(dataUrl, /^data:text\/javascript;base64,/u);
    const source = Buffer.from(dataUrl.split(',', 2)[1], 'base64').toString('utf8');
    assert.doesNotMatch(source, /Authoring module/u);
    assert.doesNotMatch(source, /browser preview/u);
    assert.doesNotMatch(source, /showOpenFilePicker|showDirectoryPicker/u);
    assert.doesNotMatch(source, /buildDistributionSb3|initializeNonEmbeddedPreview/u);
    assert.match(source, /playback runtime cannot open a non-embedded authoring project/u);
  });
});

test('connects an explicit asset distribution profile through build and runtime loading', async () => {
  await withFixture(async (fixture) => {
    const openingBytes = Buffer.from('<svg/>');
    const integrity = `sha256-${sha256(openingBytes)}`;
    const assetConfig = {
      formatVersion: 1,
      profiles: {offline: {network: 'forbidden', defaultDelivery: 'embedded'}},
      providers: {OpeningImage: {remote: {url: 'https://cdn.example.com/opening.svg'}}},
    };
    const assetLock = {
      formatVersion: 1,
      assets: {
        OpeningImage: {
          kind: 'backdrop',
          contentIntegrity: integrity,
          contentType: 'image/svg+xml',
          size: openingBytes.length,
          providers: {
            embedded: {file: 'opening.svg'},
            remote: {
              url: 'https://cdn.example.com/opening.svg',
              transportIntegrity: integrity,
              contentType: 'image/svg+xml',
              size: openingBytes.length,
            },
          },
        },
      },
    };
    const assetConfigPath = path.join(fixture.directory, 'project.assets.json');
    const assetLockPath = path.join(fixture.directory, 'project.assets.lock.json');
    await writeFile(assetConfigPath, `${JSON.stringify(assetConfig)}\n`);
    await writeFile(assetLockPath, `${JSON.stringify(assetLock)}\n`);
    const result = await runCli(
      cliArguments(fixture, 'offline.sb3', [
        '--asset-config',
        assetConfigPath,
        '--asset-lock',
        assetLockPath,
        '--asset-profile',
        'offline',
        '--max-asset-config-bytes',
        '16384',
        '--max-asset-lock-bytes',
        '16384',
      ]),
      {stdout: {write() {}}},
    );
    const {project} = readSb3(await readFile(result.outputPath));
    const loaded = await loadDsl4RuntimeComponent(project, frontend, {
      maxSourceBytes: limits.maxSourceBytes,
      maxAssetFiles: limits.maxAssetFiles,
      maxAssetBytes: limits.maxTotalAssetBytes,
      subtleCrypto: webcrypto.subtle,
    });
    assert.equal(loaded.ok, true, JSON.stringify(loaded.diagnostics));
    assert.equal(loaded.storyDocument.assets.OpeningImage.delivery, 'embedded');
    assert.equal(loaded.storyDocument.assets.OpeningImage.file, 'opening.svg');
  });
});

test('enables root binary entry packaging explicitly from the CLI', async () => {
  await withFixture(async (fixture) => {
    const result = await runCli(
      cliArguments(fixture, 'root.sb3', ['--enable-root-binary-entries']),
      {stdout: {write() {}}},
    );
    const archive = unzipSync(await readFile(result.outputPath));
    const entries = Object.keys(archive).filter((name) => name.startsWith(dsl4BinaryEntryPrefix));
    assert.equal(entries.length, 1);
    assert.match(entries[0], /^k4asset-v1-[0-9a-f]{64}$/u);
  });
});

test('preserves an explicit asset distribution through root binary entry packaging', async () => {
  await withFixture(async (fixture) => {
    const openingBytes = Buffer.from('<svg/>');
    const integrity = 'sha256-' + sha256(openingBytes);
    const assetConfigPath = path.join(fixture.directory, 'project.assets.json');
    const assetLockPath = path.join(fixture.directory, 'project.assets.lock.json');
    await writeFile(
      assetConfigPath,
      JSON.stringify({
        formatVersion: 1,
        profiles: {offline: {network: 'forbidden', defaultDelivery: 'embedded'}},
        providers: {OpeningImage: {remote: {url: 'https://cdn.example.com/opening.svg'}}},
      }) + '\n',
    );
    await writeFile(
      assetLockPath,
      JSON.stringify({
        formatVersion: 1,
        assets: {
          OpeningImage: {
            kind: 'backdrop',
            contentIntegrity: integrity,
            contentType: 'image/svg+xml',
            size: openingBytes.length,
            providers: {
              embedded: {file: 'opening.svg'},
              remote: {
                url: 'https://cdn.example.com/opening.svg',
                transportIntegrity: integrity,
                contentType: 'image/svg+xml',
                size: openingBytes.length,
              },
            },
          },
        },
      }) + '\n',
    );
    const result = await runCli(
      cliArguments(fixture, 'offline-root.sb3', [
        '--asset-config',
        assetConfigPath,
        '--asset-lock',
        assetLockPath,
        '--asset-profile',
        'offline',
        '--max-asset-config-bytes',
        '16384',
        '--max-asset-lock-bytes',
        '16384',
        '--enable-root-binary-entries',
      ]),
      {stdout: {write() {}}},
    );
    const bytes = await readFile(result.outputPath);
    const archive = unzipSync(bytes);
    const entries = Object.keys(archive).filter((name) => name.startsWith(dsl4BinaryEntryPrefix));
    assert.equal(entries.length, 1);

    const {project} = readSb3(bytes);
    const loaded = await loadDsl4BinaryEntryRuntimeComponent(project, frontend, {
      maxSourceBytes: limits.maxSourceBytes,
      maxAssetFiles: limits.maxAssetFiles,
      maxAssetFileBytes: limits.maxAssetFileBytes,
      maxAssetBytes: limits.maxTotalAssetBytes,
      subtleCrypto: webcrypto.subtle,
    });
    assert.equal(loaded.ok, true, JSON.stringify(loaded.diagnostics));
    assert.equal(loaded.storyDocument.assets.OpeningImage.delivery, 'embedded');
    assert.equal(loaded.storyDocument.assets.OpeningImage.file, 'opening.svg');
  });
});

test('builds included sources only with the explicit CLI feature flag and graph limits', async () => {
  await withFixture(async (fixture) => {
    const chapterDirectory = path.join(fixture.directory, 'chapters', 'chapter1');
    await mkdir(path.join(chapterDirectory, 'image'), {recursive: true});
    await writeFile(
      fixture.sourcePath,
      `
include: chapters/chapter1/scenario.k4.yml
kamishibai: '4.0'
controls:
  keymaps:
    production:
      Space: navigation.nextAction
scenes:
  opening:
    - goto: chapter1
`,
    );
    await writeFile(
      path.join(chapterDirectory, 'scenario.k4.yml'),
      `
assets:
  ChapterBackground:
    kind: backdrop
    file: image/background.svg
scenes:
  chapter1:
    - stage: ChapterBackground
`,
    );
    await writeFile(path.join(chapterDirectory, 'image', 'background.svg'), '<svg/>');

    const result = await runCli(
      cliArguments(fixture, 'included.sb3', [
        '--enable-source-includes',
        '--max-source-files',
        '8',
        '--max-total-source-bytes',
        String(limits.maxSourceBytes),
        '--max-include-depth',
        '4',
      ]),
      {stdout: {write() {}}},
    );
    const {project} = readSb3(await readFile(result.outputPath));
    const loaded = await loadDsl4RuntimeComponent(project, frontend, {
      maxSourceBytes: limits.maxSourceBytes,
      maxAssetFiles: limits.maxAssetFiles,
      maxAssetBytes: limits.maxTotalAssetBytes,
      subtleCrypto: webcrypto.subtle,
    });
    assert.equal(loaded.ok, true, JSON.stringify(loaded.diagnostics));
    assert.doesNotMatch(loaded.sourceDescriptor.text, /^include:/mu);
    assert.match(loaded.sourceDescriptor.text, /chapters\/chapter1\/image\/background\.svg/u);
    assert.deepEqual(
      loaded.getAssetFile('ChapterBackground', 'background.svg'),
      new TextEncoder().encode('<svg/>'),
    );
  });
});

test('keeps an existing output and removes candidate state when a rebuild fails', async () => {
  await withFixture(async (fixture) => {
    const first = await runCli(cliArguments(fixture), {stdout: {write() {}}});
    const firstBytes = await readFile(first.outputPath);
    await writeFile(fixture.sourcePath, `${validSource}\n# second valid snapshot\n`);
    const replaced = await runCli(cliArguments(fixture), {stdout: {write() {}}});
    const before = await readFile(replaced.outputPath);
    assert.notDeepEqual(before, firstBytes);
    await writeFile(fixture.sourcePath, 'kamishibai: 4.0\nscenes:\n  opening: []\n');
    await assert.rejects(runCli(cliArguments(fixture), {stdout: {write() {}}}), (error) => {
      assert.equal(error.code, 'K4-VERSION-001');
      assert.equal(error.message.includes(fixture.directory), false);
      return true;
    });
    assert.deepEqual(await readFile(first.outputPath), before);
    assert.deepEqual(await readdir(fixture.outputDirectory), ['story.sb3']);

    await assert.rejects(
      runCli(cliArguments(fixture, 'new-output.sb3'), {stdout: {write() {}}}),
      (error) => error.code === 'K4-VERSION-001',
    );
    assert.deepEqual(await readdir(fixture.outputDirectory), ['story.sb3']);
  });
});

test('rejects a non-SB3 output and malformed source manifest without leaking paths', async () => {
  await withFixture(async (fixture) => {
    await assert.rejects(
      runCli(cliArguments(fixture, 'story.zip'), {stdout: {write() {}}}),
      (error) => error.code === 'K4-BUILD-OUTPUT-001',
    );
    await writeFile(fixture.sourceManifestPath, 'formatVersion: [\n');
    await assert.rejects(runCli(cliArguments(fixture), {stdout: {write() {}}}), (error) => {
      assert.equal(error.code, 'K4-SOURCE-MANIFEST-YAML-001');
      assert.equal(error.message.includes(fixture.directory), false);
      return true;
    });
    assert.deepEqual(await readdir(fixture.outputDirectory), []);
  });
});

test('fails closed for an unknown profile and unavailable history, then permits the explicit gate', async () => {
  await withFixture(async (fixture) => {
    const unknownProfile = cliArguments(fixture);
    unknownProfile[unknownProfile.indexOf('--control-profile') + 1] = 'development';
    await assert.rejects(
      runCli(unknownProfile, {stdout: {write() {}}}),
      (error) => error.code === 'K4-KEYMAP-PROFILE-UNKNOWN',
    );

    await writeFile(
      fixture.sourcePath,
      `
kamishibai: '4.0'
controls:
  keymaps:
    development:
      ArrowLeft: history.previousAction
scenes:
  opening: []
`,
    );
    const historyProfile = cliArguments(fixture, 'history.sb3');
    historyProfile[historyProfile.indexOf('--control-profile') + 1] = 'development';
    await assert.rejects(
      runCli(historyProfile, {stdout: {write() {}}}),
      (error) => error.code === 'K4-KEYMAP-HISTORY-UNAVAILABLE',
    );
    const built = await runCli([...historyProfile, '--history-navigation-available'], {
      stdout: {write() {}},
    });
    assert.equal((await readFile(built.outputPath)).length > 0, true);
  });
});

test('ships the DSL 4.0 implementation and schema required by the installed CLI', async () => {
  const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
  assert.equal(packageJson.files.includes('dist/'), true);
  assert.equal(packageJson.files.includes('schema/dsl-4.schema.json'), true);
});
