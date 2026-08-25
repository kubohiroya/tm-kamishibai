import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';

import {
  createDsl4SourceFrontend,
  Dsl4AssetDistributionError,
  resolveDsl4AssetDistributionProfile,
  serializeDsl4AssetDistributionLock,
  validateDsl4AssetDistributionConfig,
  validateDsl4AssetDistributionLock,
  validateDsl4AssetDistributionResolution,
} from '../src/dsl4/index.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const storySchema = JSON.parse(
  await readFile(path.join(projectRoot, 'schema', 'dsl-4.schema.json'), 'utf8'),
);
const configSchema = JSON.parse(
  await readFile(path.join(projectRoot, 'schema', 'dsl-4-asset-config.schema.json'), 'utf8'),
);
const lockSchema = JSON.parse(
  await readFile(path.join(projectRoot, 'schema', 'dsl-4-asset-lock.schema.json'), 'utf8'),
);
const frontend = createDsl4SourceFrontend(storySchema);
const AjvConstructor = /** @type {any} */ (Ajv2020);
const ajv = new AjvConstructor({allErrors: true, strict: true});
const validateConfigSchema = ajv.compile(configSchema);
const validateLockSchema = ajv.compile(lockSchema);

const hash = (digit) => `sha256-${digit.repeat(64)}`;

function story() {
  const result = frontend.parse(
    [
      "kamishibai: '4.0'",
      'assets:',
      '  Logo: backdrop',
      '  Narration:',
      '    kind: sound',
      '    file: assets/narration.mp3',
      '    loading: lazy',
      '  RescuePose:',
      '    kind: poseModel',
      '    file: models/rescue',
      'scenes:',
      '  opening:',
      '    poseModel: RescuePose',
      '    actions: []',
    ].join('\n'),
    {sourceId: 'asset-distribution-test'},
  );
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  return result.storyDocument;
}

function config() {
  return {
    formatVersion: 1,
    profiles: {
      offline: {network: 'forbidden', defaultDelivery: 'embedded'},
      online: {
        network: 'allowed',
        defaultDelivery: 'remote',
        kinds: {backdrop: 'embedded'},
        assets: {Narration: 'embedded'},
      },
      sourceDefault: {network: 'allowed'},
      missingRemote: {network: 'allowed', assets: {Logo: 'remote'}},
    },
    providers: {
      RescuePose: {remote: {url: 'https://cdn.example.com/models/rescue.zip'}},
      Narration: {remote: {url: 'https://cdn.example.com/audio/narration.mp3'}},
    },
  };
}

function lock() {
  return {
    formatVersion: 1,
    assets: {
      RescuePose: {
        kind: 'poseModel',
        contentIntegrity: hash('3'),
        contentType: 'application/vnd.tm.pose-model',
        size: 1000,
        providers: {
          embedded: {file: 'models/rescue'},
          remote: {
            url: 'https://cdn.example.com/models/rescue.zip',
            transportIntegrity: hash('4'),
            contentType: 'application/zip',
            size: 700,
          },
        },
      },
      Narration: {
        kind: 'sound',
        contentIntegrity: hash('2'),
        contentType: 'audio/mpeg',
        size: 400,
        providers: {
          embedded: {file: 'assets/narration.mp3'},
          remote: {
            url: 'https://cdn.example.com/audio/narration.mp3',
            transportIntegrity: hash('2'),
            contentType: 'audio/mpeg',
            size: 400,
          },
        },
      },
      Logo: {
        kind: 'backdrop',
        contentIntegrity: hash('1'),
        contentType: 'image/svg+xml',
        size: 100,
        providers: {embedded: {name: 'Logo'}},
      },
    },
  };
}

function assertDeepFrozen(value) {
  if (typeof value !== 'object' || value === null) return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child);
}

function rejectsCode(callback, code) {
  assert.throws(callback, (error) => {
    assert.equal(error instanceof Dsl4AssetDistributionError, true);
    assert.equal(error.code, code);
    return true;
  });
}

test('publishes strict machine-readable config and lock schemas', () => {
  assert.equal(validateConfigSchema(config()), true, JSON.stringify(validateConfigSchema.errors));
  assert.equal(validateLockSchema(lock()), true, JSON.stringify(validateLockSchema.errors));

  const invalidConfig = structuredClone(config());
  invalidConfig.profiles.online.extra = true;
  assert.equal(validateConfigSchema(invalidConfig), false);
  const invalidLock = structuredClone(lock());
  invalidLock.assets.Narration.providers.remote.transportIntegrity = 'sha256-invalid';
  assert.equal(validateLockSchema(invalidLock), false);
});

test('normalizes config and lock records into deterministic immutable order', () => {
  const normalizedConfig = validateDsl4AssetDistributionConfig(config());
  const normalizedLock = validateDsl4AssetDistributionLock(lock());
  assert.deepEqual(Object.keys(normalizedConfig.profiles), [
    'missingRemote',
    'offline',
    'online',
    'sourceDefault',
  ]);
  assert.deepEqual(Object.keys(normalizedConfig.providers), ['Narration', 'RescuePose']);
  assert.deepEqual(Object.keys(normalizedLock.assets), ['Logo', 'Narration', 'RescuePose']);
  assertDeepFrozen(normalizedConfig);
  assertDeepFrozen(normalizedLock);

  const serialized = serializeDsl4AssetDistributionLock(lock());
  assert.equal(serialized.endsWith('\n'), true);
  assert.equal(serialized.indexOf('"Logo"') < serialized.indexOf('"Narration"'), true);
  assert.equal(serialized.includes(projectRoot), false);
});

test('resolves explicit asset, kind, default, and source delivery in fixed precedence order', () => {
  const sourceStory = story();
  const result = resolveDsl4AssetDistributionProfile(sourceStory, config(), lock(), 'online');
  assert.deepEqual(
    result.assets.map(({id, delivery}) => [id, delivery]),
    [
      ['Logo', 'embedded'],
      ['Narration', 'embedded'],
      ['RescuePose', 'remote'],
    ],
  );
  assert.deepEqual(result.storyDocument.assets.Logo, sourceStory.assets.Logo);
  assert.equal(result.storyDocument.assets.Narration.file, 'assets/narration.mp3');
  assert.equal(result.storyDocument.assets.Narration.source, undefined);
  assert.equal(result.storyDocument.assets.RescuePose.file, undefined);
  assert.deepEqual(result.storyDocument.assets.RescuePose.source, {
    url: 'https://cdn.example.com/models/rescue.zip',
    integrity: hash('4'),
    contentType: 'application/zip',
    size: 700,
  });
  assert.equal(sourceStory.assets.RescuePose.delivery, 'embedded');
  assert.equal(sourceStory.assets.RescuePose.file, 'models/rescue');
  assert.equal(result.storyDocument.assets.RescuePose.loading, 'eager');
  assert.equal(result.storyDocument.assets.RescuePose.retention, 'scene');
  assert.match(result.canonicalResolution, /"profile":"online"/u);
  assertDeepFrozen(result);
  assert.deepEqual(validateDsl4AssetDistributionResolution(sourceStory, result), result);

  const sourceDefault = resolveDsl4AssetDistributionProfile(
    sourceStory,
    config(),
    lock(),
    'sourceDefault',
  );
  assert.equal(
    sourceDefault.assets.every(({delivery}) => delivery === 'embedded'),
    true,
  );
});

test('creates a cold-offline resolution containing embedded providers only', () => {
  const result = resolveDsl4AssetDistributionProfile(story(), config(), lock(), 'offline');
  assert.equal(result.network, 'forbidden');
  assert.equal(
    result.assets.every(({delivery}) => delivery === 'embedded'),
    true,
  );
  assert.equal(
    Object.values(result.storyDocument.assets).some((asset) => asset.source !== undefined),
    false,
  );
  assert.equal(result.storyDocument.assets.Logo.name, 'Logo');
  assert.equal(result.storyDocument.assets.Narration.file, 'assets/narration.mp3');
  assert.equal(result.storyDocument.assets.RescuePose.file, 'models/rescue');
});

test('rejects unsafe or ambiguous author configuration', () => {
  const cases = [];
  const unknown = structuredClone(config());
  unknown.extra = true;
  cases.push(unknown);
  const unknownProfileKey = structuredClone(config());
  unknownProfileKey.profiles.online.extra = true;
  cases.push(unknownProfileKey);
  const unknownKind = structuredClone(config());
  unknownKind.profiles.online.kinds.video = 'remote';
  cases.push(unknownKind);
  const invalidProfileName = structuredClone(config());
  invalidProfileName.profiles['../online'] = invalidProfileName.profiles.online;
  cases.push(invalidProfileName);
  for (const candidate of cases) {
    rejectsCode(() => validateDsl4AssetDistributionConfig(candidate), 'K4-ASSET-PROFILE-001');
  }

  for (const invalidPath of [
    '/assets/narration.mp3',
    '../assets/narration.mp3',
    './assets/narration.mp3',
    'assets//narration.mp3',
    'C:/assets/narration.mp3',
    'https://example.com/narration.mp3',
    'assets\\narration.mp3',
  ]) {
    const candidate = structuredClone(config());
    candidate.providers.Narration.embedded = {file: invalidPath};
    rejectsCode(() => validateDsl4AssetDistributionConfig(candidate), 'K4-ASSET-PROVIDER-001');
  }
  for (const invalidUrl of [
    'http://cdn.example.com/narration.mp3',
    'https://user@cdn.example.com/narration.mp3',
    'https://cdn.example.com/narration.mp3#fragment',
    '/narration.mp3',
  ]) {
    const candidate = structuredClone(config());
    candidate.providers.Narration.remote.url = invalidUrl;
    rejectsCode(() => validateDsl4AssetDistributionConfig(candidate), 'K4-ASSET-PROVIDER-001');
  }
});

test('rejects malformed locks and single-file content mismatches', () => {
  const unknown = structuredClone(lock());
  unknown.extra = true;
  rejectsCode(() => validateDsl4AssetDistributionLock(unknown), 'K4-ASSET-LOCK-001');

  const invalidIntegrity = structuredClone(lock());
  invalidIntegrity.assets.Logo.contentIntegrity = `sha256-${'A'.repeat(64)}`;
  rejectsCode(() => validateDsl4AssetDistributionLock(invalidIntegrity), 'K4-ASSET-LOCK-001');

  const mismatch = structuredClone(lock());
  mismatch.assets.Narration.providers.remote.size += 1;
  rejectsCode(() => validateDsl4AssetDistributionLock(mismatch), 'K4-ASSET-CONTENT-MISMATCH-001');

  const poseTransportDiffers = structuredClone(lock());
  poseTransportDiffers.assets.RescuePose.providers.remote.size += 1;
  assert.equal(
    validateDsl4AssetDistributionLock(poseTransportDiffers).assets.RescuePose.size,
    1000,
  );
});

test('binds every lock provider to StoryDocument and config declarations', () => {
  const missing = structuredClone(lock());
  delete missing.assets.Logo;
  rejectsCode(
    () => resolveDsl4AssetDistributionProfile(story(), config(), missing, 'online'),
    'K4-ASSET-LOCK-001',
  );

  const stalePath = structuredClone(lock());
  stalePath.assets.Narration.providers.embedded.file = 'assets/old.mp3';
  rejectsCode(
    () => resolveDsl4AssetDistributionProfile(story(), config(), stalePath, 'online'),
    'K4-ASSET-LOCK-001',
  );

  const conflicting = structuredClone(config());
  conflicting.providers.Narration.embedded = {file: 'assets/alternate.mp3'};
  rejectsCode(
    () => resolveDsl4AssetDistributionProfile(story(), conflicting, lock(), 'online'),
    'K4-ASSET-PROVIDER-001',
  );

  const unknownProvider = structuredClone(config());
  unknownProvider.providers.Unknown = {embedded: {file: 'assets/unknown.svg'}};
  rejectsCode(
    () => resolveDsl4AssetDistributionProfile(story(), unknownProvider, lock(), 'online'),
    'K4-ASSET-PROVIDER-001',
  );
});

test('fails closed for offline remote selection, missing providers, and unknown assets', () => {
  const offlineRemote = structuredClone(config());
  offlineRemote.profiles.offline.assets = {RescuePose: 'remote'};
  rejectsCode(
    () => resolveDsl4AssetDistributionProfile(story(), offlineRemote, lock(), 'offline'),
    'K4-ASSET-OFFLINE-001',
  );

  rejectsCode(
    () => resolveDsl4AssetDistributionProfile(story(), config(), lock(), 'missingRemote'),
    'K4-ASSET-PROVIDER-001',
  );

  const unknownAsset = structuredClone(config());
  unknownAsset.profiles.online.assets.Unknown = 'embedded';
  rejectsCode(
    () => resolveDsl4AssetDistributionProfile(story(), unknownAsset, lock(), 'online'),
    'K4-ASSET-PROFILE-001',
  );

  rejectsCode(
    () => resolveDsl4AssetDistributionProfile(story(), config(), lock(), 'unknown'),
    'K4-ASSET-PROFILE-001',
  );
});
