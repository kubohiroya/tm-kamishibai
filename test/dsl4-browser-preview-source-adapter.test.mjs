import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import test from 'node:test';

import {
  createDsl4BrowserPreviewSourceAdapter,
  dsl4DefaultExternalSourcePath,
  Dsl4ExternalSourceManifestError,
  inspectDsl4BrowserPreviewSupport,
  validateDsl4ExternalSourceManifestContract,
} from '../src/dsl4/index.js';

const encoder = new TextEncoder();
const validManifest = Object.freeze({
  formatVersion: 1,
  mode: 'external',
  sourceId: 'main',
  path: 'story.kamishibai.yaml',
});

function domError(name) {
  return Object.assign(new Error(name), {name});
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {promise, resolve, reject};
}

function createClock() {
  let now = 0;
  let nextTimer = 1;
  const timers = new Map();
  const scheduledDelays = [];
  return {
    now: () => now,
    sleep(milliseconds) {
      now += milliseconds;
      return Promise.resolve();
    },
    setTimeout(callback, milliseconds) {
      const id = nextTimer++;
      timers.set(id, {callback, milliseconds});
      scheduledDelays.push(milliseconds);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    async runNextTimer() {
      const entry = timers.entries().next().value;
      if (!entry) throw new Error('No timer is scheduled');
      const [id, timer] = entry;
      timers.delete(id);
      now += timer.milliseconds;
      timer.callback();
      await Promise.resolve();
    },
    get scheduledDelays() {
      return [...scheduledDelays];
    },
    get timerCount() {
      return timers.size;
    },
  };
}

function createDocument() {
  const listeners = new Map();
  return {
    visibilityState: 'visible',
    hidden: false,
    addEventListener(type, listener) {
      const entries = listeners.get(type) ?? new Set();
      entries.add(listener);
      listeners.set(type, entries);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    async dispatch(type) {
      await Promise.all([...(listeners.get(type) ?? [])].map((listener) => listener()));
    },
    listenerCount(type) {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

function createFileHandle(readBytes) {
  return {
    kind: 'file',
    async getFile() {
      const bytes = await readBytes();
      return {
        size: bytes.byteLength,
        async arrayBuffer() {
          return bytes.slice().buffer;
        },
      };
    },
  };
}

function createProject({
  manifest = validManifest,
  source = "kamishibai: '4.0'\nscenes: {}\n",
  permission = 'granted',
} = {}) {
  let manifestValue = JSON.stringify(manifest);
  let sourceValue = source;
  let permissionValue = permission;
  let sourceMissing = false;
  let sourceReadGate = null;
  let sourceReadCount = 0;
  let sourceHandleAcquisitionCount = 0;
  const sourceReadQueue = [];

  const root = {
    kind: 'directory',
    async queryPermission() {
      return permissionValue;
    },
    async getDirectoryHandle() {
      throw domError('NotFoundError');
    },
    async getFileHandle(name) {
      if (name === 'project.source.json') {
        return createFileHandle(async () => encoder.encode(manifestValue));
      }
      if (name !== 'story.kamishibai.yaml' || sourceMissing) {
        throw domError('NotFoundError');
      }
      sourceHandleAcquisitionCount += 1;
      return createFileHandle(async () => {
        sourceReadCount += 1;
        if (sourceReadGate) await sourceReadGate.promise;
        const queued = sourceReadQueue.shift();
        return encoder.encode(queued ?? sourceValue);
      });
    },
  };

  return {
    root,
    setManifest(value) {
      manifestValue = typeof value === 'string' ? value : JSON.stringify(value);
    },
    setSource(value) {
      sourceValue = value;
    },
    setMissing(value) {
      sourceMissing = value;
    },
    setPermission(value) {
      permissionValue = value;
    },
    queueSourceReads(...values) {
      sourceReadQueue.push(...values);
    },
    blockSourceReads() {
      sourceReadGate = deferred();
      return sourceReadGate;
    },
    get sourceReadCount() {
      return sourceReadCount;
    },
    get sourceHandleAcquisitionCount() {
      return sourceHandleAcquisitionCount;
    },
  };
}

function createFrontend() {
  return Object.freeze({
    parse(source, {sourceId}) {
      if (source.includes('invalid')) {
        return Object.freeze({
          ok: false,
          canonicalSource: source,
          diagnostics: [
            Object.freeze({
              version: 1,
              code: 'K4-TEST-INVALID',
              severity: 'error',
              message: 'Invalid fixture',
              sourceId,
              range: {
                start: {line: 1, column: 1, offset: 0},
                end: {line: 1, column: 1, offset: 0},
              },
              path: '$',
              related: [],
            }),
          ],
        });
      }
      return Object.freeze({
        ok: true,
        canonicalSource: source,
        diagnostics: [],
        storyDocument: Object.freeze({kind: 'StoryDocument', version: '4.0'}),
      });
    },
  });
}

function createAdapter(project, overrides = {}) {
  const clock = overrides.clock ?? createClock();
  const document = overrides.document ?? createDocument();
  const results = [];
  const diagnostics = [];
  const statuses = [];
  const errors = [];
  const adapter = createDsl4BrowserPreviewSourceAdapter({
    sourceFrontend: createFrontend(),
    maxSourceBytes: 4096,
    subtleCrypto: webcrypto.subtle,
    clock,
    document,
    onResult: (result) => results.push(result),
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    onStatus: (status) => statuses.push(status),
    onError: (error) => errors.push(error),
    ...overrides,
  });
  return {adapter, clock, document, results, diagnostics, statuses, errors, project};
}

test('shares strict browser-safe manifest and POSIX path validation with the Node boundary', () => {
  assert.deepEqual(validateDsl4ExternalSourceManifestContract(validManifest), validManifest);
  assert.equal(dsl4DefaultExternalSourcePath, 'story.kamishibai.yaml');
  assert.deepEqual(
    validateDsl4ExternalSourceManifestContract({
      formatVersion: 1,
      mode: 'external',
      sourceId: 'main',
    }),
    validManifest,
  );
  for (const path of [
    '/story.kamishibai.yaml',
    'C:/story.kamishibai.yaml',
    'https://example.com/story.kamishibai.yaml',
    'scripts/story.kamishibai.yaml',
    'scripts\\story.kamishibai.yaml',
    './story.kamishibai.yaml',
    'scripts/../story.kamishibai.yaml',
    'scripts//story.kamishibai.yaml',
    'story.yaml',
  ]) {
    assert.throws(
      () => validateDsl4ExternalSourceManifestContract({...validManifest, path}),
      (error) =>
        error instanceof Dsl4ExternalSourceManifestError && error.code === 'K4-SOURCE-PATH-001',
      path,
    );
  }
});

test('loads the root-level default source when manifest path is omitted', async () => {
  const project = createProject({
    manifest: {formatVersion: 1, mode: 'external', sourceId: 'main'},
  });
  const setup = createAdapter(project);
  const state = await setup.adapter.start(project.root);
  assert.equal(state.sourceDisplayName, 'story.kamishibai.yaml');
  assert.equal(setup.results.length, 1);
  assert.equal(setup.results[0].ok, true);
  setup.adapter.dispose();
});

test('detects only a secure top-level directory picker without browser sniffing', () => {
  const supported = {};
  supported.self = supported;
  supported.top = supported;
  supported.isSecureContext = true;
  supported.showDirectoryPicker = () => {};
  assert.deepEqual(inspectDsl4BrowserPreviewSupport({globalObject: supported}), {
    supported: true,
    code: null,
    secureContext: true,
    topLevel: true,
    directoryPicker: true,
  });
  assert.equal(
    inspectDsl4BrowserPreviewSupport({
      globalObject: {...supported, isSecureContext: false},
    }).code,
    'K4-WEB-PREVIEW-INSECURE-CONTEXT',
  );
  assert.equal(
    inspectDsl4BrowserPreviewSupport({
      globalObject: {...supported, top: {}},
    }).code,
    'K4-WEB-PREVIEW-UNSUPPORTED',
  );
});

test('opens read-only from a user action and reports cancel or unsupported without reading files', async () => {
  const project = createProject();
  const globalObject = {isSecureContext: true};
  globalObject.self = globalObject;
  globalObject.top = globalObject;
  const pickerCalls = [];
  let directActivation = true;
  globalObject.showDirectoryPicker = async (options) => {
    pickerCalls.push({options, directActivation});
    return project.root;
  };
  const opened = createAdapter(project, {globalObject});
  const opening = opened.adapter.openProject();
  directActivation = false;
  await opening;
  assert.deepEqual(pickerCalls, [{options: {mode: 'read'}, directActivation: true}]);
  assert.equal(opened.results.length, 1);
  assert.equal(opened.results[0].ok, true);
  opened.adapter.dispose();

  const cancelledGlobal = {isSecureContext: true};
  cancelledGlobal.self = cancelledGlobal;
  cancelledGlobal.top = cancelledGlobal;
  cancelledGlobal.showDirectoryPicker = async () => {
    throw domError('AbortError');
  };
  const cancelled = createAdapter(project, {globalObject: cancelledGlobal});
  const cancelledState = await cancelled.adapter.openProject();
  assert.equal(cancelledState.started, false);
  assert.equal(cancelled.results.length, 0);
  assert.equal(cancelled.diagnostics.at(-1).code, 'K4-WEB-PREVIEW-PICKER-CANCELLED');

  const unsupported = createAdapter(project, {
    globalObject: {isSecureContext: false, self: null, top: null},
  });
  await unsupported.adapter.openProject();
  assert.equal(unsupported.results.length, 0);
  assert.equal(unsupported.diagnostics.at(-1).code, 'K4-WEB-PREVIEW-INSECURE-CONTEXT');
});

test('publishes one immutable canonical source only after two stable reads', async () => {
  const project = createProject({source: "\uFEFFkamishibai: '4.0'\r\nscenes: {}\r\n"});
  const setup = createAdapter(project);
  const state = await setup.adapter.start(project.root);
  assert.equal(state.status, 'watching-visible');
  assert.equal(state.published, 1);
  assert.equal(state.maximumObservedConcurrentReads, 1);
  assert.equal(setup.results.length, 1);
  assert.equal(setup.results[0].canonicalSource, "kamishibai: '4.0'\nscenes: {}\n");
  assert.equal(setup.results[0].sourceSnapshot.text.includes('\r'), false);
  assert.match(setup.results[0].sourceSnapshot.integrity, /^sha256-/u);
  assert.equal(project.sourceReadCount, 2);
  assert.equal(project.sourceHandleAcquisitionCount, 2);
  assert.equal(setup.clock.timerCount, 1);
  assert.equal(JSON.stringify(state).includes('scenes'), false);
  assert.equal(JSON.stringify(state).includes('project.source.json'), false);
  setup.adapter.dispose();
});

test('keeps invalid or missing source immutable and recovers on a later poll', async () => {
  const invalidProject = createProject({source: 'invalid\r\n'});
  const invalid = createAdapter(invalidProject);
  await invalid.adapter.start(invalidProject.root);
  assert.equal(invalid.results.length, 1);
  assert.equal(invalid.results[0].ok, false);
  assert.equal(invalid.results[0].sourceSnapshot.text, 'invalid\n');
  invalidProject.setSource("kamishibai: '4.0'\nscenes: {}\n");
  await invalid.adapter.pollNow();
  assert.equal(invalid.results.length, 2);
  assert.equal(invalid.results[1].ok, true);
  assert.equal(invalid.adapter.getState().diagnostic, null);
  invalid.adapter.dispose();

  const missingProject = createProject();
  missingProject.setMissing(true);
  const missing = createAdapter(missingProject, {
    stabilityTimeoutMs: 100,
    retryIntervalMs: 50,
  });
  await missing.adapter.start(missingProject.root);
  assert.equal(missing.results.at(-1).diagnostics[0].code, 'K4-SOURCE-MISSING');
  assert.equal(missing.results.at(-1).sourceSnapshot, null);
  missingProject.setMissing(false);
  await missing.adapter.pollNow();
  assert.equal(missing.results.at(-1).ok, true);
  missing.adapter.dispose();
});

test('reacquires atomic replacements and adopts canonical integrity rather than metadata', async () => {
  const project = createProject({source: "kamishibai: '4.0'\nscenes: {}\n"});
  const setup = createAdapter(project);
  await setup.adapter.start(project.root);
  const firstIntegrity = setup.results[0].sourceSnapshot.integrity;
  project.setSource("kamishibai: '4.0'\r\nscenes: {}\r\n");
  await setup.adapter.pollNow();
  assert.equal(setup.results.length, 1);
  project.setSource("kamishibai: '4.0'\nscenes:\n  opening: []\n");
  await setup.adapter.pollNow();
  assert.equal(setup.results.length, 2);
  assert.notEqual(setup.results[1].sourceSnapshot.integrity, firstIntegrity);
  assert.ok(project.sourceHandleAcquisitionCount >= 6);
  setup.adapter.dispose();
});

test('coalesces overlapping polls and publishes only the latest stable rapid save', async () => {
  const project = createProject();
  const setup = createAdapter(project);
  await setup.adapter.start(project.root);
  const beforeRevision = setup.adapter.getState().revision;
  project.queueSourceReads(
    "kamishibai: '4.0'\nscenes:\n  first: []\n",
    "kamishibai: '4.0'\nscenes:\n  second: []\n",
  );
  project.setSource("kamishibai: '4.0'\nscenes:\n  latest: []\n");
  const firstPoll = setup.adapter.pollNow();
  const secondPoll = setup.adapter.pollNow();
  const thirdPoll = setup.adapter.pollNow();
  await Promise.all([firstPoll, secondPoll, thirdPoll]);
  const state = setup.adapter.getState();
  assert.equal(state.maximumObservedConcurrentReads, 1);
  assert.equal(state.revision, beforeRevision + 2);
  assert.equal(setup.results.at(-1).canonicalSource.includes('latest'), true);
  assert.equal(
    setup.results.some((result) => result.canonicalSource.includes('first')),
    false,
  );
  assert.equal(
    setup.results.some((result) => result.canonicalSource.includes('second')),
    false,
  );
  setup.adapter.dispose();
});

test('reports permission revocation once, preserves the prior source, and recovers', async () => {
  const project = createProject();
  const setup = createAdapter(project);
  await setup.adapter.start(project.root);
  const activeIntegrity = setup.results[0].sourceSnapshot.integrity;
  project.setPermission('denied');
  await setup.adapter.pollNow();
  assert.equal(setup.results.at(-1).diagnostics[0].code, 'K4-WEB-PREVIEW-PERMISSION-REVOKED');
  assert.equal(setup.results.at(-1).sourceSnapshot, null);
  assert.equal(setup.results[0].sourceSnapshot.integrity, activeIntegrity);
  const publications = setup.results.length;
  await setup.adapter.pollNow();
  assert.equal(setup.results.length, publications);
  project.setPermission('granted');
  project.setSource("kamishibai: '4.0'\nscenes:\n  restored: []\n");
  await setup.adapter.pollNow();
  assert.equal(setup.results.at(-1).ok, true);
  assert.equal(setup.diagnostics.at(-1), null);
  setup.adapter.dispose();
});

test('uses bounded background polling and polls immediately when visible again', async () => {
  const project = createProject();
  const setup = createAdapter(project);
  await setup.adapter.start(project.root);
  setup.document.hidden = true;
  setup.document.visibilityState = 'hidden';
  await setup.document.dispatch('visibilitychange');
  assert.equal(setup.adapter.getState().status, 'background-throttled');
  assert.equal(setup.diagnostics.at(-1).code, 'K4-WEB-PREVIEW-BACKGROUND-THROTTLED');
  assert.equal(setup.clock.scheduledDelays.at(-1), 5000);
  project.setSource("kamishibai: '4.0'\nscenes:\n  visible: []\n");
  setup.document.hidden = false;
  setup.document.visibilityState = 'visible';
  await setup.document.dispatch('visibilitychange');
  await setup.adapter.whenIdle();
  assert.equal(setup.results.at(-1).canonicalSource.includes('visible'), true);
  assert.equal(setup.adapter.getState().status, 'watching-visible');
  setup.adapter.dispose();
});

test('invalidates pending reads and removes timers and listeners exactly once on dispose', async () => {
  const project = createProject();
  const gate = project.blockSourceReads();
  const setup = createAdapter(project);
  const start = setup.adapter.start(project.root);
  await Promise.resolve();
  await Promise.resolve();
  const disposed = setup.adapter.dispose();
  assert.equal(disposed.status, 'disposed');
  assert.equal(setup.document.listenerCount('visibilitychange'), 0);
  assert.equal(setup.document.listenerCount('pagehide'), 0);
  assert.equal(setup.clock.timerCount, 0);
  gate.resolve();
  await start;
  await setup.adapter.whenIdle();
  assert.equal(setup.results.length, 0);
  assert.equal(setup.adapter.getState().status, 'disposed');
  assert.deepEqual(setup.adapter.dispose(), setup.adapter.getState());
});

test('rejects unsafe limits and malformed injected platform contracts before side effects', () => {
  const project = createProject();
  const base = {
    sourceFrontend: createFrontend(),
    maxSourceBytes: 4096,
    onResult() {},
    subtleCrypto: webcrypto.subtle,
    document: createDocument(),
    clock: createClock(),
  };
  for (const overrides of [
    {maxSourceBytes: 0},
    {maxManifestBytes: 0},
    {foregroundIntervalMs: 0},
    {backgroundIntervalMs: 100, foregroundIntervalMs: 500},
    {retryIntervalMs: 0},
    {stabilityTimeoutMs: 10, retryIntervalMs: 50},
    {sourceFrontend: {}},
    {onResult: null},
    {clock: {}},
    {document: {}},
  ]) {
    assert.throws(() => createDsl4BrowserPreviewSourceAdapter({...base, ...overrides}));
  }
  const adapter = createDsl4BrowserPreviewSourceAdapter(base);
  assert.rejects(adapter.start({}));
  assert.equal(project.sourceReadCount, 0);
});
