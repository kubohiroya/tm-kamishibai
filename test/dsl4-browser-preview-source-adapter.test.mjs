import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import test from 'node:test';

import {
  createDsl4BrowserPreviewSourceAdapter,
  dsl4DefaultExternalSourceManifestFilename,
  dsl4ExternalSourceManifestDefaults,
  dsl4ExternalSourceManifestFilenames,
  dsl4ProjectSourceFilenameSuffix,
  Dsl4ExternalSourceManifestError,
  inspectDsl4BrowserPreviewSupport,
  parseDsl4ExternalSourceManifestSource,
  resolveDsl4ExternalSourceManifestContract,
  serializeDsl4ExternalSourceManifestSource,
  validateDsl4ExternalSourceManifestContract,
} from '../src/dsl4/index.js';
import {createBrowserFileHandleFromBytes} from './helpers/browser-file-system.mjs';

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
  return createBrowserFileHandleFromBytes('fixture', readBytes);
}

function createProject({
  manifest = validManifest,
  source = "kamishibai: '4.0'\nscenes: {}\n",
  permission = 'granted',
} = {}) {
  const sourceFilename = manifest.path ?? 'story.k4.yml';
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
    async *entries() {
      if (!sourceMissing) yield [sourceFilename, await this.getFileHandle(sourceFilename)];
    },
    async getFileHandle(name) {
      if (name === 'project.source.json') {
        return createFileHandle(async () => encoder.encode(manifestValue));
      }
      if (name !== sourceFilename || sourceMissing) {
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

function createIncludedProject() {
  const manifest = {
    formatVersion: 1,
    mode: 'external',
    sourceId: 'main',
    path: 'story.k4.yml',
  };
  const sources = new Map([
    ['story.k4.yml', "include: chapters/scene.k4.yml\nkamishibai: '4.0'\nscenes:\n  opening: []\n"],
    ['chapters/scene.k4.yml', 'scenes:\n  initial: []\n'],
  ]);
  const queuedChildReads = [];

  function directory(prefix = '') {
    return {
      kind: 'directory',
      async getDirectoryHandle(name) {
        const nextPrefix = `${prefix}${name}/`;
        if (![...sources.keys()].some((sourcePath) => sourcePath.startsWith(nextPrefix))) {
          throw domError('NotFoundError');
        }
        return directory(nextPrefix);
      },
      async getFileHandle(name) {
        if (prefix === '' && name === 'project.source.json') {
          return createFileHandle(async () => encoder.encode(JSON.stringify(manifest)));
        }
        const sourcePath = `${prefix}${name}`;
        const source = sources.get(sourcePath);
        if (source === undefined) throw domError('NotFoundError');
        return createFileHandle(async () => {
          const queued =
            sourcePath === 'chapters/scene.k4.yml' ? queuedChildReads.shift() : undefined;
          return encoder.encode(queued ?? source);
        });
      },
    };
  }

  const root = {
    ...directory(),
    async queryPermission() {
      return 'granted';
    },
  };
  return {
    root,
    queueChildReads(...sourcesToRead) {
      queuedChildReads.push(...sourcesToRead);
    },
    setChild(source) {
      if (source === null) sources.delete('chapters/scene.k4.yml');
      else sources.set('chapters/scene.k4.yml', source);
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
        storyDocument: Object.freeze({
          kind: 'StoryDocument',
          version: '4.0',
          metadata: {},
          scenes: [],
          sourceMap: {},
        }),
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
  assert.equal(dsl4ProjectSourceFilenameSuffix, '.k4.yml');
  assert.deepEqual(
    resolveDsl4ExternalSourceManifestContract({}, {sourcePaths: ['opening.k4.yml']}),
    {
      ...dsl4ExternalSourceManifestDefaults,
      path: 'opening.k4.yml',
    },
  );
  assert.deepEqual(
    resolveDsl4ExternalSourceManifestContract(
      {path: 'manifest.k4.yml', sourceId: 'manifest'},
      {
        sourcePaths: ['auto.k4.yml'],
        sourcePath: 'cli.k4.yml',
        sourceId: 'cli',
      },
    ),
    {
      ...dsl4ExternalSourceManifestDefaults,
      sourceId: 'cli',
      path: 'cli.k4.yml',
    },
  );
  assert.deepEqual(validateDsl4ExternalSourceManifestContract({}), {
    ...dsl4ExternalSourceManifestDefaults,
  });
  for (const sourcePaths of [[], ['first.k4.yml', 'second.k4.yml']]) {
    assert.throws(
      () => resolveDsl4ExternalSourceManifestContract({}, {sourcePaths}),
      (error) =>
        error instanceof Dsl4ExternalSourceManifestError &&
        error.code === (sourcePaths.length === 0 ? 'K4-SOURCE-MISSING' : 'K4-SOURCE-AMBIGUOUS'),
    );
  }
  assert.deepEqual(
    validateDsl4ExternalSourceManifestContract({
      path: validManifest.path,
    }),
    validManifest,
  );
  assert.throws(
    () => validateDsl4ExternalSourceManifestContract({...validManifest, cacheId: 'story-cache'}),
    (error) =>
      error instanceof Dsl4ExternalSourceManifestError && error.code === 'K4-SOURCE-MANIFEST-001',
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

test('parses canonical YAML manifests and rejects malformed or duplicate mappings', () => {
  assert.equal(dsl4DefaultExternalSourceManifestFilename, 'project.source.yml');
  assert.deepEqual(dsl4ExternalSourceManifestFilenames, [
    'project.source.yml',
    'project.source.yaml',
    'project.source.json',
  ]);
  for (const filename of ['project.source.yml', 'project.source.yaml']) {
    const source = serializeDsl4ExternalSourceManifestSource(validManifest, {filename});
    assert.match(source, /^formatVersion: 1\nmode: external\n/u);
    assert.deepEqual(parseDsl4ExternalSourceManifestSource(source, {filename}), validManifest);
  }
  for (const invalid of [
    'formatVersion: [\n',
    '- formatVersion: 1\n',
    'formatVersion: 1\nformatVersion: 1\nmode: external\nsourceId: main\n',
    'formatVersion: 1\n---\nmode: external\nsourceId: main\n',
  ]) {
    assert.throws(
      () => parseDsl4ExternalSourceManifestSource(invalid, {filename: 'project.source.yaml'}),
      (error) =>
        error instanceof Dsl4ExternalSourceManifestError &&
        error.code === 'K4-SOURCE-MANIFEST-YAML-001',
    );
  }
});

test('discovers project.source.yml before the YAML and JSON compatibility fallbacks', async () => {
  const requested = [];
  const source = "kamishibai: '4.0'\nscenes: {}\n";
  const root = {
    kind: 'directory',
    async queryPermission() {
      return 'granted';
    },
    async getFileHandle(name) {
      requested.push(name);
      if (name === 'project.source.yml') {
        return createFileHandle(async () =>
          encoder.encode(
            'formatVersion: 1\nmode: external\nsourceId: yml\npath: story.kamishibai.yaml\n',
          ),
        );
      }
      if (name === 'project.source.yaml') {
        return createFileHandle(async () =>
          encoder.encode(
            'formatVersion: 1\nmode: external\nsourceId: yaml\npath: story.kamishibai.yaml\n',
          ),
        );
      }
      if (name === 'project.source.json') {
        return createFileHandle(async () =>
          encoder.encode(JSON.stringify({...validManifest, sourceId: 'json'})),
        );
      }
      if (name === 'story.kamishibai.yaml') {
        return createFileHandle(async () => encoder.encode(source));
      }
      throw domError('NotFoundError');
    },
  };
  const setup = createAdapter({root});
  const state = await setup.adapter.start(root);
  assert.equal(state.sourceId, 'yml');
  assert.equal(requested.includes('project.source.yaml'), false);
  assert.equal(requested.includes('project.source.json'), false);
  setup.adapter.dispose();
});

test('discovers the only root-level .k4.yml source when manifest path is omitted', async () => {
  const project = createProject({
    manifest: {},
  });
  const setup = createAdapter(project);
  const state = await setup.adapter.start(project.root);
  assert.equal(state.sourceDisplayName, 'story.k4.yml');
  assert.equal(state.sourceId, 'main');
  assert.equal(setup.results.length, 1);
  assert.equal(setup.results[0].ok, true, JSON.stringify(setup.results[0].diagnostics));
  setup.adapter.dispose();
});

test('opens a manifest-free single-source project and rejects an ambiguous project', async () => {
  const source = "kamishibai: '4.0'\nscenes: {}\n";
  const rootWith = (names) => ({
    kind: 'directory',
    async queryPermission() {
      return 'granted';
    },
    async *entries() {
      for (const name of names) {
        yield [name, createFileHandle(async () => encoder.encode(source))];
      }
    },
    async getFileHandle(name) {
      if (names.includes(name)) {
        return createFileHandle(async () => encoder.encode(source));
      }
      throw domError('NotFoundError');
    },
  });

  const single = createAdapter({root: rootWith(['opening.k4.yml'])});
  const singleState = await single.adapter.start(single.project.root);
  assert.equal(singleState.sourceDisplayName, 'opening.k4.yml');
  assert.equal(singleState.sourceId, 'main');
  single.adapter.dispose();

  const ambiguous = createAdapter({
    root: rootWith(['opening.k4.yml', 'ending.k4.yml']),
  });
  const ambiguousState = await ambiguous.adapter.start(ambiguous.project.root);
  assert.equal(ambiguousState.status, 'diagnostic');
  assert.equal(ambiguousState.diagnostic.code, 'K4-SOURCE-AMBIGUOUS');
  assert.equal(ambiguousState.diagnostic.displayName, '*.k4.yml');
  assert.match(ambiguousState.diagnostic.message, /multiple \.k4\.yml entry sources/u);
  ambiguous.adapter.dispose();

  const empty = createAdapter({root: rootWith([])});
  const emptyState = await empty.adapter.start(empty.project.root);
  assert.equal(emptyState.status, 'diagnostic');
  assert.equal(emptyState.diagnostic.code, 'K4-SOURCE-MISSING');
  assert.equal(emptyState.diagnostic.displayName, '*.k4.yml');
  assert.match(emptyState.diagnostic.message, /no \.k4\.yml entry source/u);
  empty.adapter.dispose();
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
  assert.deepEqual(
    {
      code: missing.results.at(-1).diagnostics[0].code,
      message: missing.results.at(-1).diagnostics[0].message,
      displayName: missing.diagnostics.find((diagnostic) => diagnostic !== null)?.displayName,
    },
    {
      code: 'K4-SOURCE-MISSING',
      message: 'Required story file is missing: story.kamishibai.yaml',
      displayName: 'story.kamishibai.yaml',
    },
  );
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

test('publishes included browser sources only as one matching graph generation', async () => {
  const project = createIncludedProject();
  project.queueChildReads(
    'scenes:\n  draft: []\n',
    'scenes:\n  saved: []\n',
    'scenes:\n  saved: []\n',
    'scenes:\n  saved: []\n',
  );
  const setup = createAdapter(project, {
    featureFlags: {dsl4Runtime: true, dsl4SourceIncludes: true},
    maxSourceFiles: 8,
    maxTotalSourceBytes: 16 * 1024,
    maxIncludeDepth: 4,
    quietWindowMs: 1,
    stabilityTimeoutMs: 100,
    retryIntervalMs: 10,
  });
  await setup.adapter.start(project.root);

  assert.equal(setup.results.length, 1);
  assert.equal(setup.results[0].ok, true, JSON.stringify(setup.results[0].diagnostics));
  assert.match(setup.results[0].canonicalSource, /saved/u);
  assert.doesNotMatch(setup.results[0].canonicalSource, /draft/u);
  assert.match(setup.results[0].sourceSnapshot.integrity, /^sha256-/u);

  project.setChild(null);
  await setup.adapter.pollNow();
  assert.equal(setup.results.at(-1).ok, false);
  assert.equal(setup.results.at(-1).diagnostics[0].code, 'K4-SOURCE-MISSING');
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

test('hands the selected root to an in-process asset adapter without serializing it into state', async () => {
  const project = createProject();
  const selected = [];
  const setup = createAdapter(project, {onProjectRoot: (root) => selected.push(root)});
  await setup.adapter.start(project.root);
  assert.deepEqual(selected, [project.root]);
  assert.equal(JSON.stringify(setup.adapter.getState()).includes('getFileHandle'), false);
  setup.adapter.dispose();
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
