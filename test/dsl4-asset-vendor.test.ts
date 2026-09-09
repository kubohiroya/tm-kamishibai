import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'vitest';
import {fileURLToPath} from 'node:url';

import {zipSync} from 'fflate';

import {
  createDsl4ProductionSourceFrontend,
  generateDsl4AssetDistributionLock,
  vendorDsl4AssetDistribution,
} from '../src/builder/index.js';
import {requireDefined} from './helpers/require-value.ts';
import {thrown} from './helpers/thrown-error.ts';

/** Read the mirrored file path one vendored asset was locked to. */
function embeddedFile(
  lock: {assets: Record<string, {providers: {embedded?: {file?: string}}}>},
  id: string,
) {
  const asset = requireDefined(lock.assets[id], `the locked asset ${id}`);
  return requireDefined(
    requireDefined(asset.providers.embedded, `the embedded provider of ${id}`).file,
    `the embedded file of ${id}`,
  );
}

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const schema = JSON.parse(
  await readFile(path.join(repositoryRoot, 'schema', 'dsl-4.schema.json'), 'utf8'),
);
const sourceFrontend = createDsl4ProductionSourceFrontend(schema);
const poseFiles = {
  'model.json': Buffer.from('{"model":"rescue"}'),
  'metadata.json': Buffer.from('{"labels":["help"]}'),
  'weights.bin': Buffer.from([1, 2, 3, 4]),
};
const poseArchive = Buffer.from(
  zipSync(
    // The fixtures are already byte arrays; `strToU8` was re-encoding them.
    Object.fromEntries(Object.entries(poseFiles)),
  ),
);
const bytes = {
  logo: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
  narration: Buffer.from('ID3\u0004\u0000\u0000\u0000'),
};
const source = `
kamishibai: '4.0'
assets:
  Logo:
    kind: backdrop
    file: assets/logo.svg
  Narration:
    kind: sound
    file: assets/narration.mp3
  RescuePose:
    kind: recognitionModel
    file: models/rescue
scenes:
  opening:
    recognitionModel: RescuePose
    actions:
      - stage: Logo
      - sound: Narration
`;

function config() {
  return {
    formatVersion: 1,
    profiles: {
      online: {network: 'allowed', defaultDelivery: 'remote'},
      offline: {network: 'forbidden', defaultDelivery: 'embedded'},
    },
    providers: {
      Logo: {remote: {url: 'https://cdn.example.com/logo.svg'}},
      Narration: {remote: {url: 'https://cdn.example.com/narration.mp3'}},
      RescuePose: {remote: {url: 'https://cdn.example.com/rescue.zip'}},
    },
  };
}

async function withProject<T>(callback: (root: string) => Promise<T> | T): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsl4-asset-vendor-'));
  try {
    await mkdir(path.join(root, 'assets'), {recursive: true});
    await mkdir(path.join(root, 'models', 'rescue'), {recursive: true});
    await Promise.all([
      writeFile(path.join(root, 'vendor-story.k4.yml'), source),
      writeFile(
        path.join(root, 'project.source.json'),
        JSON.stringify({formatVersion: 1, mode: 'external', sourceId: 'main'}),
      ),
      writeFile(path.join(root, 'project.assets.json'), JSON.stringify(config())),
      writeFile(path.join(root, 'assets', 'logo.svg'), bytes.logo),
      writeFile(path.join(root, 'assets', 'narration.mp3'), bytes.narration),
      ...Object.entries(poseFiles).map(([name, value]) =>
        writeFile(path.join(root, 'models', 'rescue', name), value),
      ),
    ]);
    return await callback(root);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
}

function lockOptions(root: string, fetchImplementation?: (url: URL) => Promise<Response>) {
  return {
    projectRoot: root,
    sourceManifest: path.join(root, 'project.source.json'),
    assetConfig: path.join(root, 'project.assets.json'),
    sourceFrontend,
    maxSourceBytes: 16 * 1024,
    maxSourceManifestBytes: 4096,
    maxAssetConfigBytes: 16 * 1024,
    maxAssetFileBytes: 16 * 1024,
    maxAssetFiles: 16,
    maxTotalAssetBytes: 128 * 1024,
    timeoutMs: 1000,
    maxRedirects: 2,
    allowedHosts: ['cdn.example.com'],
    subtleCrypto: webcrypto.subtle,
    fetchImplementation,
  };
}

function vendorOptions(root: string, fetchImplementation?: (url: URL) => Promise<Response>) {
  return {
    projectRoot: root,
    assetConfig: path.join(root, 'project.assets.json'),
    assetLock: path.join(root, 'project.assets.lock.json'),
    outputConfig: path.join(root, 'project.assets.offline.json'),
    outputLock: path.join(root, 'project.assets.offline.lock.json'),
    vendorDirectory: '.kamishibai/vendor/dsl4-assets',
    maxAssetConfigBytes: 16 * 1024,
    maxAssetLockBytes: 64 * 1024,
    maxAssetFileBytes: 16 * 1024,
    maxAssetFiles: 16,
    maxTotalAssetBytes: 128 * 1024,
    timeoutMs: 1000,
    maxRedirects: 2,
    allowedHosts: ['cdn.example.com'],
    subtleCrypto: webcrypto.subtle,
    fetchImplementation,
  };
}

function fetchFixture(url: URL) {
  const body = url.pathname.endsWith('logo.svg')
    ? bytes.logo
    : url.pathname.endsWith('narration.mp3')
      ? bytes.narration
      : poseArchive;
  const contentType = url.pathname.endsWith('logo.svg')
    ? 'image/svg+xml'
    : url.pathname.endsWith('narration.mp3')
      ? 'audio/mpeg'
      : 'application/zip';
  return new Response(body, {status: 200, headers: {'content-type': contentType}});
}

test('vendors remote providers into an idempotent content-addressed offline mirror', async () => {
  await withProject(async (root: string) => {
    const fetchImplementation = async (url: URL) => fetchFixture(url);
    const locked = await generateDsl4AssetDistributionLock({
      ...lockOptions(root, fetchImplementation),
    });
    await writeFile(path.join(root, 'project.assets.lock.json'), locked.serialized);
    const result = await vendorDsl4AssetDistribution(vendorOptions(root, fetchImplementation));
    assert.deepEqual(result.vendoredAssets, ['Logo', 'Narration', 'RescuePose']);
    assert.match(
      result.mirrorRelativeRoot,
      /^\.kamishibai\/vendor\/dsl4-assets\/sha256-[0-9a-f]{64}$/u,
    );
    assert.equal(
      requireDefined(result.config.profiles.offline, 'the offline profile').network,
      'forbidden',
    );
    assert.equal(embeddedFile(result.lock, 'RescuePose').includes(result.mirrorRelativeRoot), true);
    assert.equal(
      requireDefined(
        requireDefined(result.config.providers.Logo, 'the Logo provider').embedded,
        'its embedded provider',
      ).file,
      embeddedFile(result.lock, 'Logo'),
    );
    assert.deepEqual(
      await readFile(path.join(root, embeddedFile(result.lock, 'RescuePose'), 'model.json')),
      poseFiles['model.json'],
    );
    await stat(path.join(root, embeddedFile(result.lock, 'Logo')));
    assert.deepEqual(JSON.parse(await readFile(result.outputLock, 'utf8')), result.lock);
    assert.deepEqual(JSON.parse(await readFile(result.outputConfig, 'utf8')), result.config);

    const second = await vendorDsl4AssetDistribution(vendorOptions(root, fetchImplementation));
    assert.equal(second.mirrorRoot, result.mirrorRoot);
  });
});

test('fails before output replacement when a locked remote changes', async () => {
  await withProject(async (root: string) => {
    const lockFetch = async (url: URL) => fetchFixture(url);
    const locked = await generateDsl4AssetDistributionLock(lockOptions(root, lockFetch));
    await writeFile(path.join(root, 'project.assets.lock.json'), locked.serialized);
    const changed = async (url: URL) =>
      new Response(Buffer.from('changed'), {
        status: 200,
        headers: {
          'content-type': url.pathname.endsWith('rescue.zip') ? 'application/zip' : 'image/svg+xml',
        },
      });
    await assert.rejects(
      vendorDsl4AssetDistribution(vendorOptions(root, changed)),
      (error) => thrown(error).code === 'K4-ASSET-VENDOR-INTEGRITY-001',
    );
    assert.equal(
      await stat(path.join(root, 'project.assets.offline.lock.json'))
        .then(() => true)
        .catch(() => false),
      false,
    );
  });
});
