import assert from 'node:assert/strict';
import {createHash, webcrypto} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {test} from 'vitest';
import {fileURLToPath} from 'node:url';

import {strToU8, zipSync} from 'fflate';

import {createDsl4BrowserPreviewAssetAdapter, createDsl4SourceFrontend} from '../src/dsl4/index.js';
import {requireDefined, requireRecord} from './helpers/require-value.ts';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const schema = JSON.parse(
  await readFile(path.join(repositoryRoot, 'schema', 'dsl-4.schema.json'), 'utf8'),
);
const frontend = createDsl4SourceFrontend(schema);
const encoder = new TextEncoder();

function sri(value: string) {
  return `sha256-${createHash('sha256').update(value).digest('base64')}`;
}

function clock() {
  let now = 0;
  let nextTimer = 1;
  const timers = new Map<number, {callback: () => void; delay: number}>();
  return {
    now: () => now,
    sleep(delay: number) {
      now += delay;
      return Promise.resolve();
    },
    setTimeout(callback: () => void, delay: number) {
      const id = nextTimer++;
      timers.set(id, {callback, delay});
      return id;
    },
    clearTimeout(id: number) {
      timers.delete(id);
    },
  };
}

function domError(name: string) {
  return Object.assign(new Error(name), {name});
}

function project(initialFiles: Record<string, Uint8Array>) {
  let permission = 'granted';
  const files = new Map(Object.entries(initialFiles));
  const reads = new Map();

  function fileHandle(fullPath: string) {
    return {
      kind: 'file',
      async getFile() {
        if (!files.has(fullPath)) throw domError('NotFoundError');
        reads.set(fullPath, (reads.get(fullPath) ?? 0) + 1);
        const bytes = requireDefined(files.get(fullPath), `the bytes of ${fullPath}`);
        return {
          size: bytes.length,
          async arrayBuffer() {
            return bytes.slice().buffer;
          },
        };
      },
    };
  }

  function directoryHandle(prefix = '') {
    return {
      kind: 'directory',
      async queryPermission() {
        return permission;
      },
      async getFileHandle(name: string) {
        const fullPath = `${prefix}${name}`;
        if (!files.has(fullPath)) throw domError('NotFoundError');
        return fileHandle(fullPath);
      },
      async getDirectoryHandle(name: string) {
        const childPrefix = `${prefix}${name}/`;
        if (![...files.keys()].some((entry) => entry.startsWith(childPrefix))) {
          throw domError('NotFoundError');
        }
        return directoryHandle(childPrefix);
      },
      async *entries() {
        const directNames = [...files.keys()]
          .filter((entry) => entry.startsWith(prefix) && !entry.slice(prefix.length).includes('/'))
          .map((entry) => entry.slice(prefix.length))
          .sort();
        for (const name of directNames) yield [name, fileHandle(`${prefix}${name}`)];
      },
    };
  }

  return {
    root: directoryHandle(),
    set(filePath: string, bytes: Uint8Array) {
      files.set(filePath, bytes);
    },
    setPermission(value: string) {
      permission = value;
    },
    reads(filePath: string) {
      return reads.get(filePath) ?? 0;
    },
  };
}

function wav(marker = 0) {
  const bytes = new Uint8Array(16);
  bytes.set(encoder.encode('RIFF'), 0);
  bytes.set(encoder.encode('WAVE'), 8);
  bytes[15] = marker;
  return bytes;
}

function source({extra = false, poseFile = 'rescue'} = {}) {
  return `
kamishibai: '4.0'
assets:
  Picture:
    kind: image
    file: picture.svg
  Bell:
    kind: sound
    file: bell.wav
  Rescue:
    kind: recognitionModel
    file: ${poseFile}
  Skin: costume:Hero
${extra ? '  Extra:\n    kind: image\n    file: extra.svg\n' : ''}actors:
  Hero: Skin
scenes:
  opening:
    recognitionModel: Rescue
    actions:
      - Hero.pose:
          steps:
            - pose: help
      - sound: Bell
`;
}

function context(sourceText: string, storyDocument?: Readonly<Record<string, unknown>>) {
  let parsed: {ok: boolean; storyDocument?: unknown; diagnostics?: unknown};
  if (storyDocument) {
    parsed = {ok: true, storyDocument};
  } else {
    parsed = frontend.parse(sourceText, {sourceId: 'browser-preview-asset-adapter-test'});
    assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics));
  }
  return {
    sourceResult: {...parsed, sourceSnapshot: {integrity: sri(sourceText)}},
    structuralFingerprint: sri('stable-structure'),
  };
}

/**
 * Read one candidate event the adapter published.
 *
 * The adapter declares its events as opaque records; every case asserts on the same three members,
 * so this names them once.
 */
function candidateEvent(events: Record<string, unknown>[], index = 0) {
  return requireRecord(events[index], `candidate event ${index}`) as unknown as {
    revision: number;
    classification: {kind: string};
    validations: {assetId: string; kind: string}[];
  } & {classification: {changedAssets?: {id: string; change: string}[]}};
}

/** Read the provider the adapter owns for one candidate. */
function candidateProvider(provider: unknown) {
  return requireRecord(provider, 'the candidate provider') as unknown as {
    providerId: string;
    getFile(assetId: string, file: string): Uint8Array;
    manifest: {assets: {id: string; source: {mode: string}}[]};
  };
}

function fixtureProject() {
  return project({
    'picture.svg': encoder.encode('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    'bell.wav': wav(),
    'rescue/metadata.json': encoder.encode(JSON.stringify({labels: ['help']})),
    'rescue/model.json': encoder.encode(
      JSON.stringify({weightsManifest: [{paths: ['weights.bin']}]}),
    ),
    'rescue/weights.bin': new Uint8Array([1, 2, 3]),
    'ignored.svg': encoder.encode('<svg/>'),
  });
}

function createAdapter(
  events: Record<string, unknown>[],
  diagnostics: unknown[] = [],
  releases: string[] = [],
  fullDiagnostics = false,
) {
  return createDsl4BrowserPreviewAssetAdapter({
    subtleCrypto: webcrypto.subtle,
    inspectImage() {
      return {width: 640, height: 480, release: () => releases.push('image')};
    },
    inspectAudio() {
      return {
        durationSeconds: 1,
        channels: 2,
        sampleRate: 48_000,
        release: () => releases.push('audio'),
      };
    },
    onCandidate: (event: Readonly<Record<string, unknown>>) => events.push(event),
    onDiagnostic: (diagnostic: Readonly<Record<string, unknown>> | null) =>
      diagnostics.push(
        fullDiagnostics ? diagnostic : diagnostic === null ? null : (diagnostic.code ?? null),
      ),
    watchOptions: {clock: clock()},
  });
}

test('reads only allowlisted local assets and owns immutable providers until acknowledgement', async () => {
  const events: Record<string, unknown>[] = [];
  const releases: string[] = [];
  const assets = fixtureProject();
  const adapter = createAdapter(events, [], releases);

  await adapter.start(assets.root, context(source()));
  assert.equal(events.length, 1);
  assert.equal(candidateEvent(events, 0).classification.kind, 'initial');
  assert.deepEqual(
    candidateEvent(events, 0).validations.map((entry) => entry.assetId),
    ['Bell', 'Picture', 'Rescue'],
  );
  assert.equal(assets.reads('ignored.svg'), 0);
  assert.equal(adapter.getState().providerCount, 1);

  const provider = candidateProvider(
    adapter.getCandidateProvider(candidateEvent(events, 0).revision),
  );
  const firstRead = provider.getFile('Bell', 'bell.wav');
  firstRead[0] = 0;
  assert.equal(provider.getFile('Bell', 'bell.wav')[0], 'R'.charCodeAt(0));

  await adapter.accept(candidateEvent(events, 0).revision);
  assert.equal(candidateProvider(adapter.getActiveProvider()).providerId, provider.providerId);
  assert.equal(adapter.getState().providerCount, 1);
  await adapter.dispose();
  assert.equal(adapter.getState().providerCount, 0);
  assert.equal(releases.length > 0, true);
});

test('extracts a local pose zip before publishing the preview asset provider', async () => {
  const events: Record<string, unknown>[] = [];
  const assets = project({
    'picture.svg': encoder.encode('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    'bell.wav': wav(),
    'rescue.ZIP': zipSync({
      'metadata.json': strToU8('{"labels":["help"]}'),
      'model.json': strToU8('{"weightsManifest":[{"paths":["weights.bin"]}]}'),
      'weights.bin': new Uint8Array([1, 2, 3]),
    }),
  });
  const sourceText = source({poseFile: 'rescue.ZIP'});
  const adapter = createAdapter(events);

  await adapter.start(assets.root, context(sourceText));
  const provider = candidateProvider(
    adapter.getCandidateProvider(candidateEvent(events, 0).revision),
  );
  assert.deepEqual(provider.getFile('Rescue', 'weights.bin'), new Uint8Array([1, 2, 3]));
  assert.equal(
    requireDefined(
      provider.manifest.assets.find((asset) => asset.id === 'Rescue'),
      'the Rescue manifest entry',
    ).source.mode,
    'archive',
  );
  await adapter.dispose();
});

test('classifies content changes and releases the old provider only after accept', async () => {
  const events: Record<string, unknown>[] = [];
  const assets = fixtureProject();
  const adapter = createAdapter(events);

  await adapter.start(assets.root, context(source()));
  await adapter.accept(candidateEvent(events, 0).revision);
  const activeProvider = candidateProvider(adapter.getActiveProvider());
  assets.set('bell.wav', wav(1));
  await adapter.pollNow();

  assert.equal(candidateEvent(events, 1).classification.kind, 'asset-live-reload');
  assert.deepEqual(
    requireDefined(
      candidateEvent(events, 1).classification.changedAssets,
      'the changed assets',
    ).map((asset) => asset.id),
    ['Bell'],
  );
  assert.equal(adapter.getState().providerCount, 2);
  assert.equal(adapter.getActiveProvider(), activeProvider);

  await adapter.accept(candidateEvent(events, 1).revision);
  assert.equal(adapter.getState().providerCount, 1);
  assert.notEqual(
    candidateProvider(adapter.getActiveProvider()).providerId,
    activeProvider.providerId,
  );
  await adapter.dispose();
});

test('keeps the active generation through YAML-first missing files and then accepts safe additions', async () => {
  const events: Record<string, unknown>[] = [];
  const diagnostics: unknown[] = [];
  const assets = fixtureProject();
  const adapter = createAdapter(events, diagnostics, [], true);

  await adapter.start(assets.root, context(source()));
  await adapter.accept(candidateEvent(events, 0).revision);
  const activeProvider = candidateProvider(adapter.getActiveProvider());
  await adapter.updateSource(context(source({extra: true})));
  assert.equal(requireRecord(adapter.getState().watch, 'the watch state').status, 'diagnostic');
  assert.equal(
    requireRecord(
      requireRecord(adapter.getState().watch, 'the watch state').diagnostic,
      'its diagnostic',
    ).code,
    'K4-ASSET-MISSING',
  );
  assert.equal(
    requireRecord(
      requireRecord(adapter.getState().watch, 'the watch state').diagnostic,
      'its diagnostic',
    ).message,
    'Referenced asset is missing: extra.svg',
  );
  assert.equal(
    requireRecord(
      requireRecord(adapter.getState().watch, 'the watch state').diagnostic,
      'its diagnostic',
    ).displayName,
    'extra.svg',
  );
  assert.equal(
    requireRecord(
      requireRecord(adapter.getState().watch, 'the watch state').diagnostic,
      'its diagnostic',
    ).path,
    '$.assets["Extra"].file',
  );
  assert.equal(adapter.getActiveProvider(), activeProvider);

  assets.set('extra.svg', encoder.encode('<svg xmlns="http://www.w3.org/2000/svg"/>'));
  await adapter.pollNow();
  assert.equal(candidateEvent(events, 1).classification.kind, 'additive-composite-live-reload');
  assert.deepEqual(
    requireDefined(
      candidateEvent(events, 1).classification.changedAssets,
      'the changed assets',
    ).map((asset) => [asset.id, asset.change]),
    [['Extra', 'added']],
  );
  await adapter.accept(candidateEvent(events, 1).revision);
  assert.deepEqual(
    diagnostics.map((diagnostic) =>
      diagnostic === null ? null : (requireRecord(diagnostic, 'a diagnostic').code ?? null),
    ),
    ['K4-ASSET-MISSING', null],
  );
  await adapter.dispose();
});

test('redacts denied permissions and rejects source paths that escape the selected root', async () => {
  const permissionEvents: Record<string, unknown>[] = [];
  const permissionDiagnostics: unknown[] = [];
  const assets = fixtureProject();
  const adapter = createAdapter(permissionEvents, permissionDiagnostics);
  await adapter.start(assets.root, context(source()));
  await adapter.accept(candidateEvent(permissionEvents, 0).revision);
  assets.setPermission('denied');
  await adapter.pollNow();
  assert.equal(
    requireRecord(
      requireRecord(adapter.getState().watch, 'the watch state').diagnostic,
      'its diagnostic',
    ).code,
    'K4-ASSET-PERMISSION-001',
  );
  assert.equal(JSON.stringify(adapter.getState()).includes(repositoryRoot), false);
  await adapter.dispose();

  const invalidEvents: Record<string, unknown>[] = [];
  assets.setPermission('granted');
  const invalid = createAdapter(invalidEvents);
  // The path escaping the selected root is what this case proves the adapter refuses.
  const invalidStory = requireRecord(
    structuredClone(context(source()).sourceResult.storyDocument),
    'the cloned story document',
  );
  requireRecord(
    requireRecord(invalidStory.assets, 'its assets').Picture,
    'the Picture asset',
  ).file = '../picture.svg';
  await invalid.start(assets.root, context('invalid-source', invalidStory));
  assert.equal(
    requireRecord(
      requireRecord(invalid.getState().watch, 'the watch state').diagnostic,
      'its diagnostic',
    ).code,
    'K4-ASSET-PATH-001',
  );
  assert.deepEqual(invalidEvents, []);
  await invalid.dispose();
});
