import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {parseCliArguments, runCli, usage} from '../src/builder/cli.js';
import {
  openDsl4LocalPreviewBrowser,
  runDsl4LocalPreviewCommand,
} from '../src/builder/dsl4-local-preview-command.js';

const limits = Object.freeze({
  maxSourceBytes: 16 * 1024,
  maxAssetFileBytes: 4096,
  maxAssetFiles: 10,
  maxTotalAssetBytes: 16 * 1024,
});

function previewArguments(extra = []) {
  return [
    'preview-dsl4',
    '--watch',
    '--base',
    '/project/base.sb3',
    '--project-root',
    '/project',
    '--source-manifest',
    '/project/project.source.json',
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

function commandOptions(extra = []) {
  return {
    ...parseCliArguments(previewArguments(extra)).options,
    sourceFrontend: {parse() {}},
  };
}

function captureIo() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: {write: (chunk) => (stdout += chunk)},
      stderr: {write: (chunk) => (stderr += chunk)},
    },
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}

function createCommandFixture({onOpen, start} = {}) {
  const signalTarget = new EventEmitter();
  const origin = 'http://127.0.0.1:45123';
  const token = 'A'.repeat(43);
  let hostOptions;
  let runtimeOptions;
  let browserRuntimeReady = false;
  let disposeCount = 0;
  let openCount = 0;
  const dependencies = {
    signalTarget,
    readyTimeoutMs: 100,
    async readFile(filePath) {
      return filePath.endsWith('project.source.json')
        ? Buffer.from(
            JSON.stringify({
              formatVersion: 1,
              mode: 'external',
              sourceId: 'main',
              path: 'story.k4.yml',
            }),
          )
        : Buffer.from('base');
    },
    async buildRuntime(options) {
      runtimeOptions = options;
      return {bytes: Uint8Array.of(1, 2, 3)};
    },
    async buildBrowserBundle() {
      return Uint8Array.of(4, 5, 6);
    },
    createHost(options) {
      hostOptions = options;
      return {
        start: start
          ? () => start(signalTarget)
          : async () => ({origin, browserRuntimeReady: false}),
        getLaunchUrl: () => `${origin}/#${token}`,
        getSnapshot: () => ({origin, browserRuntimeReady}),
        async dispose() {
          disposeCount += 1;
        },
      };
    },
    async openBrowser(launchUrl) {
      openCount += 1;
      assert.equal(launchUrl, `${origin}/#${token}`);
      await onOpen?.({
        emit(event) {
          if (event.type === 'local-preview.runtime-ready') browserRuntimeReady = true;
          if (
            event.type === 'local-preview.full-rebuild-required' ||
            event.type === 'local-preview.transport-disconnected'
          ) {
            browserRuntimeReady = false;
          }
          hostOptions.onEvent(event);
        },
        signalTarget,
      });
    },
  };
  return {
    dependencies,
    signalTarget,
    get disposeCount() {
      return disposeCount;
    },
    get openCount() {
      return openCount;
    },
    get hostOptions() {
      return hostOptions;
    },
    get runtimeOptions() {
      return runtimeOptions;
    },
  };
}

test('parses the bounded preview-dsl4 --watch contract and rejects unsafe arguments', () => {
  const parsed = parseCliArguments(previewArguments(['--port', '0', '--replace-existing']));
  assert.equal(parsed.action, 'preview-dsl4');
  assert.equal(parsed.options.watch, true);
  assert.equal(parsed.options.port, 0);
  assert.equal(parsed.options.replaceExisting, true);
  assert.match(usage(), /preview-dsl4 --watch/u);

  assert.throws(
    () => parseCliArguments(previewArguments().filter((value) => value !== '--watch')),
    /Missing required option: --watch/u,
  );
  assert.throws(() => parseCliArguments(previewArguments(['--port', '65536'])), /0 and 65535/u);
  assert.throws(
    () => parseCliArguments(previewArguments(['--watch'])),
    /Duplicate option: --watch/u,
  );
  const excessiveSource = previewArguments();
  excessiveSource[excessiveSource.indexOf('--max-source-bytes') + 1] = '65537';
  assert.throws(() => parseCliArguments(excessiveSource), /must be <= 65536/u);
  const excessiveFile = previewArguments();
  excessiveFile[excessiveFile.indexOf('--max-asset-file-bytes') + 1] = '20000';
  assert.throws(
    () => parseCliArguments(excessiveFile),
    /max-asset-file-bytes must be <= --max-total-asset-bytes/u,
  );

  const included = parseCliArguments(
    previewArguments([
      '--enable-source-includes',
      '--max-source-files',
      '8',
      '--max-total-source-bytes',
      '32768',
      '--max-include-depth',
      '4',
    ]),
  );
  assert.equal(included.options.featureFlags.dsl4SourceIncludes, true);
  assert.equal(included.options.maxSourceFiles, 8);
  assert.equal(included.options.maxTotalSourceBytes, 32768);
  assert.equal(included.options.maxIncludeDepth, 4);
  assert.throws(
    () => parseCliArguments(previewArguments(['--enable-source-includes'])),
    /Missing required option: --max-source-files/u,
  );
  assert.throws(
    () => parseCliArguments(previewArguments(['--max-source-files', '8'])),
    /requires --enable-source-includes/u,
  );
});

test('runCli delegates preview only with the production frontend and selected IO', async () => {
  const captured = captureIo();
  let delegated;
  const result = await runCli(previewArguments(), captured.io, {
    async runPreview(options, dependencies) {
      delegated = {options, dependencies};
      return {exitCode: 0, reason: 'test'};
    },
  });
  assert.deepEqual(result, {exitCode: 0, reason: 'test'});
  assert.equal(typeof delegated.options.sourceFrontend.parse, 'function');
  assert.equal(delegated.options.watch, true);
  assert.equal(delegated.dependencies.stdout, captured.io.stdout);
  assert.equal(delegated.dependencies.stderr, captured.io.stderr);
});

test('waits for runtime-ready, redacts the token, and cleans up on SIGINT', async () => {
  const captured = captureIo();
  const fixture = createCommandFixture({
    async onOpen({emit, signalTarget}) {
      queueMicrotask(() => emit({type: 'local-preview.runtime-ready'}));
      setImmediate(() => signalTarget.emit('SIGINT'));
    },
  });
  const result = await runDsl4LocalPreviewCommand(commandOptions(), {
    ...fixture.dependencies,
    ...captured.io,
  });
  assert.deepEqual(result, {exitCode: 0, reason: 'signal', signal: 'SIGINT'});
  assert.match(captured.stdout, /Opening DSL 4\.0 preview/u);
  assert.match(captured.stdout, /Preview ready/u);
  assert.match(captured.stdout, /watching story\.k4\.yml/u);
  assert.match(captured.stdout, /Preview stopped by SIGINT/u);
  assert.equal(captured.stdout.includes('A'.repeat(43)), false);
  assert.equal(fixture.disposeCount, 1);
  assert.equal(fixture.signalTarget.listenerCount('SIGINT'), 0);
  assert.equal(fixture.signalTarget.listenerCount('SIGTERM'), 0);
});

test('forwards explicit Source Graph limits to both the initial build and live host', async () => {
  const captured = captureIo();
  const fixture = createCommandFixture({
    async onOpen({emit, signalTarget}) {
      queueMicrotask(() => emit({type: 'local-preview.runtime-ready'}));
      setImmediate(() => signalTarget.emit('SIGINT'));
    },
  });
  const graphArguments = [
    '--enable-source-includes',
    '--max-source-files',
    '8',
    '--max-total-source-bytes',
    '32768',
    '--max-include-depth',
    '4',
  ];
  await runDsl4LocalPreviewCommand(commandOptions(graphArguments), {
    ...fixture.dependencies,
    ...captured.io,
  });

  for (const forwarded of [fixture.runtimeOptions, fixture.hostOptions]) {
    assert.equal(forwarded.featureFlags.dsl4SourceIncludes, true);
    assert.equal(forwarded.maxSourceFiles, 8);
    assert.equal(forwarded.maxTotalSourceBytes, 32768);
    assert.equal(forwarded.maxIncludeDepth, 4);
    assert.equal(forwarded.maxAssetFileBytes, limits.maxAssetFileBytes);
    assert.equal(forwarded.maxAssetFiles, limits.maxAssetFiles);
    assert.equal(forwarded.maxTotalAssetBytes, limits.maxTotalAssetBytes);
  }
});

test('fails closed when the browser never acknowledges runtime readiness', async () => {
  const fixture = createCommandFixture();
  await assert.rejects(
    runDsl4LocalPreviewCommand(commandOptions(), {
      ...fixture.dependencies,
      readyTimeoutMs: 10,
      stdout: {write() {}},
      stderr: {write() {}},
    }),
    (error) => error.code === 'K4-PREVIEW-CLI-RUNTIME-TIMEOUT',
  );
  assert.equal(fixture.disposeCount, 1);
});

test('rejects an oversized source manifest before build or host side effects', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'dsl4-preview-cli-limit-'));
  const baseSb3 = path.join(projectRoot, 'base.sb3');
  const sourceManifest = path.join(projectRoot, 'project.source.json');
  await Promise.all([
    writeFile(baseSb3, 'base'),
    writeFile(sourceManifest, Buffer.alloc(64 * 1024 + 1, 0x20)),
  ]);
  let buildCount = 0;
  try {
    await assert.rejects(
      runDsl4LocalPreviewCommand(
        {...commandOptions(), projectRoot, baseSb3, sourceManifest},
        {
          signalTarget: new EventEmitter(),
          buildRuntime() {
            buildCount += 1;
          },
          buildBrowserBundle() {
            buildCount += 1;
          },
          createHost() {
            throw new Error('host must not be created');
          },
          openBrowser() {
            throw new Error('browser must not be opened');
          },
          stdout: {write() {}},
          stderr: {write() {}},
        },
      ),
      (error) => error.code === 'K4-PREVIEW-CLI-INPUT-LIMIT',
    );
    assert.equal(buildCount, 0);
  } finally {
    await rm(projectRoot, {recursive: true, force: true});
  }
});

test('returns a restart-required failure after a ready runtime observes a full rebuild', async () => {
  const captured = captureIo();
  const fixture = createCommandFixture({
    async onOpen({emit}) {
      queueMicrotask(() => emit({type: 'local-preview.runtime-ready'}));
      setImmediate(() => emit({type: 'local-preview.full-rebuild-required'}));
    },
  });
  const result = await runDsl4LocalPreviewCommand(commandOptions(), {
    ...fixture.dependencies,
    ...captured.io,
  });
  assert.deepEqual(result, {exitCode: 1, reason: 'full-rebuild'});
  assert.match(captured.stderr, /full rebuild is required/u);
  assert.equal(fixture.disposeCount, 1);
});

test('does not open a browser when SIGTERM wins the host startup race', async () => {
  const fixture = createCommandFixture({
    start(signalTarget) {
      queueMicrotask(() => signalTarget.emit('SIGTERM'));
      return new Promise(() => {});
    },
  });
  const result = await runDsl4LocalPreviewCommand(commandOptions(), {
    ...fixture.dependencies,
    stdout: {write() {}},
    stderr: {write() {}},
  });
  assert.deepEqual(result, {exitCode: 0, reason: 'signal', signal: 'SIGTERM'});
  assert.equal(fixture.openCount, 0);
  assert.equal(fixture.disposeCount, 1);
});

test('opens only authenticated loopback URLs with the platform browser launcher', async () => {
  const launchUrl = `http://127.0.0.1:45123/#${'B'.repeat(43)}`;
  for (const [platform, expectedCommand, expectedPrefix] of [
    ['darwin', 'open', []],
    ['linux', 'xdg-open', []],
    ['win32', 'rundll32.exe', ['url.dll,FileProtocolHandler']],
  ]) {
    let invocation;
    let unrefCount = 0;
    await openDsl4LocalPreviewBrowser(launchUrl, {
      platform,
      spawnProcess(command, arguments_, options) {
        invocation = {command, arguments_, options};
        const child = new EventEmitter();
        child.unref = () => {
          unrefCount += 1;
        };
        queueMicrotask(() => child.emit('spawn'));
        return child;
      },
    });
    assert.equal(invocation.command, expectedCommand);
    assert.deepEqual(invocation.arguments_, [...expectedPrefix, launchUrl]);
    assert.deepEqual(invocation.options, {detached: true, stdio: 'ignore'});
    assert.equal(unrefCount, 1);
  }
  await assert.rejects(
    openDsl4LocalPreviewBrowser(`https://example.com/#${'B'.repeat(43)}`),
    (error) => error.code === 'K4-PREVIEW-CLI-BROWSER',
  );
  await assert.rejects(
    openDsl4LocalPreviewBrowser(`http://127.0.0.1:45123/other#${'B'.repeat(43)}`),
    (error) => error.code === 'K4-PREVIEW-CLI-BROWSER',
  );
});
