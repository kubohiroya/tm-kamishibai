import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'vitest';
import {fileURLToPath} from 'node:url';

import {zipSync} from 'fflate';

import {
  createDsl4ProductionSourceFrontend,
  generateDsl4AssetDistributionLock,
  generateDsl4AssetDistributionLockFile,
} from '../src/builder/index.js';
import {requireDefined} from './helpers/require-value.ts';
import {thrown} from './helpers/thrown-error.ts';

type AssetLockResult = Awaited<ReturnType<typeof generateDsl4AssetDistributionLock>>;

/** Read one asset the lock is expected to carry. */
function lockedAsset(result: AssetLockResult, id: string) {
  return requireDefined(result.lock.assets[id], `the locked asset ${id}`);
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
    // The fixtures are already byte arrays; `strToU8` was re-encoding them, which is a no-op for
    // this ASCII content and wrong for anything else.
    Object.fromEntries(Object.entries(poseFiles)),
  ),
);
const localBytes = {
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
    profiles: {online: {network: 'allowed', defaultDelivery: 'remote'}},
    providers: {
      Logo: {remote: {url: 'https://cdn.example.com/logo.svg'}},
      Narration: {remote: {url: 'https://cdn.example.com/narration.mp3'}},
      RescuePose: {remote: {url: 'https://cdn.example.com/rescue.zip'}},
    },
  };
}

async function withProject<T>(callback: (root: string) => Promise<T> | T): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsl4-asset-lock-'));
  try {
    await mkdir(path.join(root, 'assets'), {recursive: true});
    await mkdir(path.join(root, 'models', 'rescue'), {recursive: true});
    await Promise.all([
      writeFile(path.join(root, 'story.k4.yml'), source),
      writeFile(
        path.join(root, 'project.source.yaml'),
        'formatVersion: 1\nmode: external\nsourceId: main\n',
      ),
      writeFile(path.join(root, 'project.assets.json'), JSON.stringify(config())),
      writeFile(path.join(root, 'assets', 'logo.svg'), localBytes.logo),
      writeFile(path.join(root, 'assets', 'narration.mp3'), localBytes.narration),
      ...Object.entries(poseFiles).map(([name, bytes]) =>
        writeFile(path.join(root, 'models', 'rescue', name), bytes),
      ),
      writeFile(path.join(root, 'models', 'rescue.zip'), poseArchive),
    ]);
    return await callback(root);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
}

function options(root: string, fetchImplementation?: (url: URL) => Promise<Response>) {
  return {
    projectRoot: root,
    sourceManifest: path.join(root, 'project.source.yaml'),
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

test('generates a canonical lock from stable local and allowlisted remote providers', async () => {
  await withProject(async (root: string) => {
    const calls: string[] = [];
    const fetchImplementation = async (url: URL) => {
      calls.push(String(url));
      const body = url.pathname.endsWith('logo.svg')
        ? localBytes.logo
        : url.pathname.endsWith('narration.mp3')
          ? localBytes.narration
          : poseArchive;
      const contentType = url.pathname.endsWith('logo.svg')
        ? 'image/svg+xml'
        : url.pathname.endsWith('narration.mp3')
          ? 'audio/mpeg'
          : 'application/zip';
      return new Response(body, {status: 200, headers: {'content-type': contentType}});
    };
    const result = await generateDsl4AssetDistributionLock(options(root, fetchImplementation));
    assert.deepEqual(calls, [
      'https://cdn.example.com/logo.svg',
      'https://cdn.example.com/narration.mp3',
      'https://cdn.example.com/rescue.zip',
    ]);
    assert.deepEqual(Object.keys(result.lock.assets), ['Logo', 'Narration', 'RescuePose']);
    assert.equal(lockedAsset(result, 'Logo').contentType, 'image/svg+xml');
    assert.equal(lockedAsset(result, 'Narration').contentType, 'audio/mpeg');
    assert.equal(lockedAsset(result, 'RescuePose').contentType, 'application/vnd.tm.pose-model');
    assert.equal(
      requireDefined(lockedAsset(result, 'RescuePose').providers.remote, 'the remote provider')
        .contentType,
      'application/zip',
    );
    assert.equal(
      lockedAsset(result, 'RescuePose').contentIntegrity,
      lockedAsset(result, 'RescuePose').contentIntegrity.toLowerCase(),
    );
    assert.equal(result.serialized.endsWith('\n'), true);
    assert.equal(result.serialized.includes(root), false);

    const output = path.join(root, 'project.assets.lock.json');
    const written = await generateDsl4AssetDistributionLockFile({
      ...options(root, fetchImplementation),
      output,
    });
    assert.equal(written.outputPath, output);
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), written.lock);
  });
});

test('fails closed for unallowlisted hosts, redirects, and local/remote mismatches', async () => {
  await withProject(async (root: string) => {
    const base = options(
      root,
      async () =>
        new Response(localBytes.logo, {status: 200, headers: {'content-type': 'image/svg+xml'}}),
    );
    await assert.rejects(
      generateDsl4AssetDistributionLock({
        ...base,
        allowedHosts: ['other.example.com'],
      }),
      (error) => thrown(error).code === 'K4-ASSET-REMOTE-HOST-001',
    );
    await assert.rejects(
      generateDsl4AssetDistributionLock({
        ...base,
        fetchImplementation: async () =>
          new Response(null, {
            status: 302,
            headers: {location: 'https://other.example.com/logo.svg'},
          }),
      }),
      (error) => thrown(error).code === 'K4-ASSET-REMOTE-HOST-001',
    );
    await assert.rejects(
      generateDsl4AssetDistributionLock({
        ...base,
        fetchImplementation: async (url: URL) =>
          new Response(
            url.pathname.endsWith('rescue.zip') ? poseArchive : Buffer.from('different'),
            {
              status: 200,
              headers: {
                'content-type': url.pathname.endsWith('rescue.zip')
                  ? 'application/zip'
                  : 'image/svg+xml',
              },
            },
          ),
      }),
      (error) => thrown(error).code === 'K4-ASSET-CONTENT-MISMATCH-001',
    );
  });
});

test('locks a local pose archive against the same remote archive content', async () => {
  await withProject(async (root: string) => {
    await writeFile(
      path.join(root, 'story.k4.yml'),
      source.replace('file: models/rescue', 'file: models/rescue.zip'),
    );
    const result = await generateDsl4AssetDistributionLock(
      options(root, async (url: URL) => {
        const body = url.pathname.endsWith('logo.svg')
          ? localBytes.logo
          : url.pathname.endsWith('narration.mp3')
            ? localBytes.narration
            : poseArchive;
        const contentType = url.pathname.endsWith('logo.svg')
          ? 'image/svg+xml'
          : url.pathname.endsWith('narration.mp3')
            ? 'audio/mpeg'
            : 'application/zip';
        return new Response(body, {status: 200, headers: {'content-type': contentType}});
      }),
    );
    assert.equal(
      requireDefined(lockedAsset(result, 'RescuePose').providers.embedded, 'the embedded provider')
        .file,
      'models/rescue.zip',
    );
    assert.equal(
      requireDefined(
        lockedAsset(result, 'RescuePose').providers.remote,
        'the remote provider',
      ).url.endsWith('rescue.zip'),
      true,
    );
  });
});
