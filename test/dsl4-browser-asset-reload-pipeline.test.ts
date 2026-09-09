import assert from 'node:assert/strict';
import {createHash, webcrypto} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {test} from 'vitest';
import {fileURLToPath} from 'node:url';

import {createDsl4PreviewReloadSurface} from '../src/builder/index.js';
import {
  createDsl4BrowserAssetReloadPipeline,
  createDsl4SourceFrontend,
  dsl4AssetReloadProtocolCapabilities,
} from '../src/dsl4/index.js';
import {createFakeDocument} from './helpers/fake-dom.ts';
import {requireRecord} from './helpers/require-value.ts';
import {thrown} from './helpers/thrown-error.ts';

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

function project() {
  let bytes = encoder.encode('<svg xmlns="http://www.w3.org/2000/svg"><text>one</text></svg>');
  const root = {
    kind: 'directory',
    queryPermission: async () => 'granted',
    getDirectoryHandle: async () => {
      throw Object.assign(new Error('missing'), {name: 'NotFoundError'});
    },
    async getFileHandle(name: string) {
      if (name !== 'picture.svg')
        throw Object.assign(new Error('missing'), {name: 'NotFoundError'});
      return {
        kind: 'file',
        async getFile() {
          const snapshot = bytes.slice();
          return {size: snapshot.length, arrayBuffer: async () => snapshot.buffer};
        },
      };
    },
  };
  return {
    root,
    update() {
      bytes = encoder.encode('<svg xmlns="http://www.w3.org/2000/svg"><text>two</text></svg>');
    },
  };
}

function context(source = 'initial source') {
  const parsed = frontend.parse(
    `
kamishibai: '4.0'
assets:
  Picture:
    kind: backdrop
    file: picture.svg
scenes:
  opening:
    - stage: Picture
`,
    {sourceId: 'browser-asset-pipeline-test'},
  );
  assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics));
  return {
    sourceResult: {...parsed, sourceSnapshot: {integrity: sri(source)}},
    structuralFingerprint: sri('structure'),
  };
}

type PipelineFactoryOptions = Parameters<typeof createDsl4BrowserAssetReloadPipeline>[0];
type PrepareInput = Parameters<NonNullable<PipelineFactoryOptions['prepareGeneration']>>[0];

/** What one pipeline case varies. */
interface PipelineOptions {
  capabilities?: readonly string[];
  reloadSurface?: PipelineFactoryOptions['reloadSurface'];
  restartGeneration?: PipelineFactoryOptions['restartGeneration'];
}

/**
 * The two members this fixture reads out of a prepare input.
 *
 * The pipeline declares both as opaque records -- it validates them itself -- so this says what the
 * fixture expects of them once, rather than casting inside the callback.
 */
interface PrepareMembers {
  summary: {revision: number};
  provider: {getFile: (assetId: string, file: string) => Uint8Array};
}

function prepareMembers(input: PrepareInput): PrepareMembers {
  return input as unknown as PrepareMembers;
}

function pipeline({
  capabilities = dsl4AssetReloadProtocolCapabilities,
  reloadSurface,
  restartGeneration,
}: PipelineOptions = {}) {
  const events: unknown[] = [];
  const lifecycle: string[] = [];
  const errors: unknown[] = [];
  const instance = createDsl4BrowserAssetReloadPipeline({
    sessionId: 'browser-assets',
    negotiatedCapabilities: capabilities,
    adapterOptions: {
      subtleCrypto: webcrypto.subtle,
      inspectImage() {
        return {width: 640, height: 480};
      },
      inspectAudio() {
        return {durationSeconds: 1, channels: 1, sampleRate: 48_000};
      },
      watchOptions: {clock: clock()},
    },
    prepareGeneration(input: PrepareInput) {
      const {summary, provider} = prepareMembers(input);
      const bytes = provider.getFile('Picture', 'picture.svg');
      lifecycle.push(`prepare:${summary.revision}:${bytes.length}`);
      return {
        activate() {
          lifecycle.push(`activate:${summary.revision}`);
          return {actualAnchor: 'action'};
        },
        rollback(reason: string) {
          lifecycle.push(`rollback:${summary.revision}:${reason}`);
        },
        release(reason: string) {
          lifecycle.push(`release:${summary.revision}:${reason}`);
        },
      };
    },
    onEvent: (event: unknown) => events.push(event),
    // `exactOptionalPropertyTypes` separates an absent option from one passed as `undefined`.
    ...(reloadSurface === undefined ? {} : {reloadSurface}),
    ...(restartGeneration === undefined ? {} : {restartGeneration}),
    onError: (error: unknown) => errors.push(error),
  });
  return {errors, events, instance, lifecycle};
}

test('runs a browser file update through stable read, protocol, prepare, activation, and acknowledgement', async () => {
  const files = project();
  const setup = pipeline();
  const initial = await setup.instance.start(files.root, context());
  assert.equal(initial.transaction.status, 'ready');
  assert.equal(initial.protocol.candidateRevision, 1);
  await setup.instance.commit({requestedPreference: 'action'});
  assert.equal(setup.instance.getState().transaction.generation, 1);

  files.update();
  await setup.instance.pollNow();
  const changed = setup.instance.getState();
  assert.ok(changed.transaction.candidate, JSON.stringify(changed));
  assert.equal(
    requireRecord(
      requireRecord(changed.transaction.candidate, 'the candidate').classification,
      'its classification',
    ).kind,
    'asset-live-reload',
  );
  await setup.instance.commit({requestedPreference: 'action'});
  assert.equal(setup.instance.getState().transaction.generation, 2);
  assert.equal(
    setup.events.filter(
      (event) => requireRecord(event, 'a pipeline event').type === 'preview.asset.committed',
    ).length,
    2,
  );
  assert.equal(
    setup.lifecycle.indexOf('release:1:generation-replaced-after-ack') >
      setup.lifecycle.indexOf('activate:2'),
    true,
  );
  const disposed = await setup.instance.dispose();
  assert.equal(disposed.disposed, true);
  assert.equal(requireRecord(disposed.adapter, 'the disposed adapter').providerCount, 0);
});

test('auto-applies validated asset generations through the shared reload surface', async () => {
  const document = createFakeDocument();
  const restarts: unknown[] = [];
  const surfaceErrors: unknown[] = [];
  const reloadSurface = createDsl4PreviewReloadSurface({
    surface: 'cli',
    environment: 'development',
    document,
    mount: document.body,
    viewport: {width: 640, height: 480},
    onError: (error: unknown) => surfaceErrors.push(error),
  });
  const files = project();
  const setup = pipeline({
    reloadSurface,
    restartGeneration: (request: unknown) => restarts.push(request),
  });

  await setup.instance.start(files.root, context());
  await setup.instance.whenIdle();
  await reloadSurface.whenIdle();
  assert.equal(
    setup.instance.getState().transaction.generation,
    1,
    JSON.stringify({
      errors: setup.errors.map((error) => String(thrown(error).stack ?? error)),
      surfaceErrors: surfaceErrors.map((error) => String(thrown(error).stack ?? error)),
      pipeline: setup.instance.getState(),
      surface: reloadSurface.getSnapshot(),
    }),
  );
  assert.equal(
    requireRecord(reloadSurface.policy.getState().lastSuccess, 'the last success').actualAnchor,
    'scene',
  );

  files.update();
  await setup.instance.pollNow();
  await setup.instance.whenIdle();
  await reloadSurface.whenIdle();
  assert.equal(setup.instance.getState().transaction.generation, 2);
  assert.equal(reloadSurface.getSnapshot().globalRevision, 2);

  await reloadSurface.policy.openDialog();
  await reloadSurface.policy.selectPosition('story');
  await reloadSurface.policy.applyScope('reload-once');
  assert.equal(restarts.length, 1);
  const restart = requireRecord(restarts[0], 'the restart request');
  assert.equal(restart.channel, 'asset');
  assert.equal(restart.actualAnchor, 'story');

  await setup.instance.dispose();
  await reloadSurface.dispose();
});

test('releases the candidate and reports full rebuild when asset capabilities are incomplete', async () => {
  const files = project();
  const setup = pipeline({
    capabilities: dsl4AssetReloadProtocolCapabilities.filter(
      (capability) => capability !== 'asset.commit.v1',
    ),
  });
  const state = await setup.instance.start(files.root, context());
  assert.equal(state.protocol.enabled, false);
  assert.equal(state.transaction.status, 'full-rebuild');
  assert.equal(
    requireRecord(state.transaction.diagnostic, 'the transaction diagnostic').code,
    'K4-ASSET-FULL-REBUILD-REQUIRED',
  );
  assert.equal(state.adapter.providerCount, 0);
  await assert.rejects(setup.instance.commit(), /has no candidate/u);
  await setup.instance.dispose();
});
