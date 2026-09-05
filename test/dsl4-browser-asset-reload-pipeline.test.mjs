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
import {createFakeDocument} from './helpers/fake-dom.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const schema = JSON.parse(
  await readFile(path.join(repositoryRoot, 'schema', 'dsl-4.schema.json'), 'utf8'),
);
const frontend = createDsl4SourceFrontend(schema);
const encoder = new TextEncoder();

function sri(value) {
  return `sha256-${createHash('sha256').update(value).digest('base64')}`;
}

function clock() {
  let now = 0;
  let nextTimer = 1;
  const timers = new Map();
  return {
    now: () => now,
    sleep(delay) {
      now += delay;
      return Promise.resolve();
    },
    setTimeout(callback, delay) {
      const id = nextTimer++;
      timers.set(id, {callback, delay});
      return id;
    },
    clearTimeout(id) {
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
    async getFileHandle(name) {
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

function pipeline({
  capabilities = dsl4AssetReloadProtocolCapabilities,
  reloadSurface,
  restartGeneration,
} = {}) {
  const events = [];
  const lifecycle = [];
  const errors = [];
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
    prepareGeneration({summary, provider}) {
      const bytes = provider.getFile('Picture', 'picture.svg');
      lifecycle.push(`prepare:${summary.revision}:${bytes.length}`);
      return {
        activate() {
          lifecycle.push(`activate:${summary.revision}`);
          return {actualAnchor: 'action'};
        },
        rollback(reason) {
          lifecycle.push(`rollback:${summary.revision}:${reason}`);
        },
        release(reason) {
          lifecycle.push(`release:${summary.revision}:${reason}`);
        },
      };
    },
    onEvent: (event) => events.push(event),
    reloadSurface,
    restartGeneration,
    onError: (error) => errors.push(error),
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
  assert.equal(changed.transaction.candidate.classification.kind, 'asset-live-reload');
  await setup.instance.commit({requestedPreference: 'action'});
  assert.equal(setup.instance.getState().transaction.generation, 2);
  assert.equal(setup.events.filter(({type}) => type === 'preview.asset.committed').length, 2);
  assert.equal(
    setup.lifecycle.indexOf('release:1:generation-replaced-after-ack') >
      setup.lifecycle.indexOf('activate:2'),
    true,
  );
  const disposed = await setup.instance.dispose();
  assert.equal(disposed.disposed, true);
  assert.equal(disposed.adapter.providerCount, 0);
});

test('auto-applies validated asset generations through the shared reload surface', async () => {
  const document = createFakeDocument();
  const restarts = [];
  const surfaceErrors = [];
  const reloadSurface = createDsl4PreviewReloadSurface({
    surface: 'cli',
    environment: 'development',
    document,
    mount: document.body,
    viewport: {width: 640, height: 480},
    onError: (error) => surfaceErrors.push(error),
  });
  const files = project();
  const setup = pipeline({
    reloadSurface,
    restartGeneration: (request) => restarts.push(request),
  });

  await setup.instance.start(files.root, context());
  await setup.instance.whenIdle();
  await reloadSurface.whenIdle();
  assert.equal(
    setup.instance.getState().transaction.generation,
    1,
    JSON.stringify({
      errors: setup.errors.map((error) => String(error?.stack ?? error)),
      surfaceErrors: surfaceErrors.map((error) => String(error?.stack ?? error)),
      pipeline: setup.instance.getState(),
      surface: reloadSurface.getSnapshot(),
    }),
  );
  assert.equal(reloadSurface.policy.getState().lastSuccess.actualAnchor, 'scene');

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
  assert.equal(restarts[0].channel, 'asset');
  assert.equal(restarts[0].actualAnchor, 'story');

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
  assert.equal(state.transaction.diagnostic.code, 'K4-ASSET-FULL-REBUILD-REQUIRED');
  assert.equal(state.adapter.providerCount, 0);
  await assert.rejects(setup.instance.commit(), /has no candidate/u);
  await setup.instance.dispose();
});
