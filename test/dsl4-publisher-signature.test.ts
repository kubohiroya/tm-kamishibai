import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'vitest';

import {strFromU8, strToU8, unzipSync, zipSync} from 'fflate';

import {buildDsl4RuntimeComponent} from '../src/builder/index.js';
import {runCli} from '../src/builder/cli.js';
import {
  createDsl4SourceFrontend,
  generateDsl4SigningKeyPair,
  importDsl4SigningKey,
  loadDsl4RuntimeComponent,
} from '../src/dsl4/index.js';
import {createDsl4PublisherBadge} from '../src/dsl4/platform/publisher-badge.js';
import {captureWrites, cliResult} from './helpers/cli-command.ts';
import {createFakeDocument, requireByAttribute} from './helpers/fake-dom.ts';
import {requireRecord} from './helpers/require-value.ts';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const schema = JSON.parse(
  await readFile(path.join(repositoryRoot, 'schema', 'dsl-4.schema.json'), 'utf8'),
);
const frontend = createDsl4SourceFrontend(schema);
const subtleCrypto = webcrypto.subtle;
const password = 'signed and sealed';
const source = `
kamishibai: '4.0'
assets:
  Opening:
    kind: backdrop
    file: assets/opening.svg
variables:
  signedMarker: 0
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

function baseSb3() {
  const project = {
    extensionStorage: {},
    targets: [{isStage: true, name: 'Stage', variables: {}, lists: {}, broadcasts: {}, blocks: {}}],
    monitors: [],
  };
  return Buffer.from(zipSync({'project.json': strToU8(JSON.stringify(project))}));
}

async function withProject<T>(callback: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsl4-publisher-signature-'));
  try {
    await mkdir(path.join(directory, 'assets'));
    await writeFile(path.join(directory, 'story.kamishibai.yaml'), source);
    await writeFile(path.join(directory, 'assets', 'opening.svg'), '<svg/>');
    return await callback(directory);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}

function build(directory: string, extra: Record<string, unknown>) {
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
    channel: 'bundled',
    maxSourceBytes: 16 * 1024,
    maxAssetFileBytes: 4096,
    maxAssetFiles: 10,
    maxTotalAssetBytes: 16 * 1024,
    subtleCrypto,
    ...extra,
  });
}

function component(project: unknown) {
  const storage = requireRecord(requireRecord(project, 'project').extensionStorage, 'storage');
  return requireRecord(
    requireRecord(requireRecord(storage.kubohiroyakamishibai4, 'bundle').components, 'components')
      .kubohiroyakamishibairuntime4,
    'component',
  );
}

async function load(project: unknown) {
  return requireRecord(
    await loadDsl4RuntimeComponent(structuredClone(project), frontend, {
      maxSourceBytes: 16 * 1024,
      maxAssetFiles: 10,
      maxTotalAssetBytes: 16 * 1024,
      subtleCrypto,
      unlockSealedStory: () => password,
    }),
    'load',
  );
}

const codeOf = (result: Record<string, unknown>) =>
  result.ok === true ? 'ok' : (result.diagnostics as {code: string}[])[0]!.code;

test('signs every profile and reports the publisher fingerprint', async () => {
  const keys = await generateDsl4SigningKeyPair();
  assert.match(keys.fingerprint, /^SHA256:([0-9A-F]{2}:){31}[0-9A-F]{2}$/u);
  const signingKey = await importDsl4SigningKey(keys.privateKeyPem);
  await withProject(async (directory) => {
    for (const profile of [
      {},
      {distributionProfile: 'compiled'},
      {
        distributionProfile: 'sealed',
        sealedPassword: password,
        sealedIterations: 100_000,
      },
    ]) {
      const built = await build(directory, {...profile, signingKey});
      const runtime = requireRecord(built.runtimeComponent, 'runtime');
      assert.equal(runtime.ok, true);
      assert.deepEqual(runtime.publisher, {
        algorithm: 'ecdsa-p256-sha256',
        fingerprint: keys.fingerprint,
      });
      const loaded = await load(built.project);
      assert.equal(requireRecord(loaded.publisher, 'publisher').fingerprint, keys.fingerprint);
    }
    const unsigned = await build(directory, {});
    assert.equal(requireRecord(unsigned.runtimeComponent, 'runtime').publisher, null);
  });
});

test('refuses a signed story once anything in its component changes', async () => {
  const signingKey = await importDsl4SigningKey((await generateDsl4SigningKeyPair()).privateKeyPem);
  const otherKey = await generateDsl4SigningKeyPair();
  await withProject(async (directory) => {
    const built = await build(directory, {distributionProfile: 'compiled', signingKey});
    const changed = (change: (target: Record<string, unknown>) => void) => {
      const project = structuredClone(built.project) as Record<string, unknown>;
      change(component(project));
      return load(project);
    };
    assert.equal(codeOf(await load(built.project)), 'ok');
    assert.equal(
      codeOf(
        await changed((target) => {
          requireRecord(target.artifact, 'artifact').controlProfile = 'other';
        }),
      ),
      'K4-SIGNATURE-INVALID-001',
    );
    assert.equal(
      codeOf(
        await changed((target) => {
          const assets = requireRecord(target.assets, 'assets');
          const [file] = assets.files as Record<string, unknown>[];
          file!.data = Buffer.from('<svg>changed</svg>').toString('base64');
        }),
      ),
      'K4-SIGNATURE-INVALID-001',
    );
    // Swapping in another publisher's key without that key's signature fails too.
    const forged = await changed((target) => {
      requireRecord(target.signature, 'signature').publicKey = otherKey.publicKeyPem.replace(
        /-----[A-Z ]+-----|\s/gu,
        '',
      );
    });
    assert.equal(codeOf(forged), 'K4-SIGNATURE-INVALID-001');
    assert.equal(
      codeOf(
        await changed((target) => {
          requireRecord(target.signature, 'signature').algorithm = 'rsa';
        }),
      ),
      'K4-SIGNATURE-001',
    );
  });
});

test('the CLI generates a key once and signs a build with it', async () => {
  await withProject(async (directory) => {
    const keysDirectory = path.join(directory, 'keys');
    const generated = cliResult(
      await runCli(['generate-dsl4-signing-key', '--output-dir', keysDirectory], {
        stdout: captureWrites(),
        stderr: captureWrites(),
      }),
      'generated',
    );
    const privatePath = String(generated.privatePath);
    assert.equal((await stat(privatePath)).mode & 0o777, 0o600);
    await assert.rejects(
      runCli(['generate-dsl4-signing-key', '--output-dir', keysDirectory], {
        stdout: captureWrites(),
        stderr: captureWrites(),
      }),
      /EEXIST/,
    );
    await writeFile(path.join(directory, 'base.sb3'), baseSb3());
    const output = path.join(directory, 'out', 'story.sb3');
    await runCli(
      [
        'build-dsl4',
        '--base',
        path.join(directory, 'base.sb3'),
        '--project-root',
        directory,
        '--source',
        'story.kamishibai.yaml',
        '--output',
        output,
        '--control-profile',
        'production',
        '--channel',
        'bundled',
        '--distribution-profile',
        'compiled',
        '--signing-key',
        privatePath,
      ],
      {stdout: captureWrites(), stderr: captureWrites()},
    );
    const project = JSON.parse(strFromU8(unzipSync(await readFile(output))['project.json']!));
    const loaded = await load(project);
    assert.equal(requireRecord(loaded.publisher, 'publisher').fingerprint, generated.fingerprint);
  });
});

test('the badge shows the full fingerprint for a signed story and nothing otherwise', () => {
  const document = createFakeDocument();
  const badge = createDsl4PublisherBadge({document, mount: document.body});
  const element = requireByAttribute(document.body, 'data-dsl4-publisher', 'true');
  assert.equal(element.hidden, true);
  const fingerprint = `SHA256:${Array(32).fill('AB').join(':')}`;
  badge.show({fingerprint}, 'ja');
  assert.equal(element.hidden, false);
  assert.equal(element.textContent, `署名者: ${fingerprint}`);
  badge.show(null, 'en');
  assert.equal(element.hidden, true);
  badge.dispose();
  assert.equal(document.body.children.length, 0);
});
