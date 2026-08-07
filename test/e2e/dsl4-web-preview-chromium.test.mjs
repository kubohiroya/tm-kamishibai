import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {access, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

import {
  buildDsl4TurboWarpBrowserBundle,
  createDsl4LocalPreviewHost,
  createDsl4ProductionSourceFrontend,
} from '../../src/builder/index.js';
import {
  createDsl4LiveReloadSession,
  createDsl4PreviewProtocolSession,
} from '../../src/dsl4/index.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function resolveChromeExecutable() {
  const candidates = [
    process.env.CHROME_BIN,
    process.env.GOOGLE_CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate)) {
      try {
        await access(candidate);
        return candidate;
      } catch {
        continue;
      }
    }
    const found = spawnSync('which', [candidate], {encoding: 'utf8'});
    if (found.status === 0 && found.stdout.trim()) return found.stdout.trim();
  }
  throw new Error(
    'Chromium E2E requires Chrome or Chromium; set CHROME_BIN when it is not on PATH',
  );
}

function contentType(file) {
  return (
    {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.mjs': 'text/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
    }[path.extname(file)] ?? 'application/octet-stream'
  );
}

async function startFixtureServer(
  fixturePath = '/test/fixtures/dsl4/web-preview-browser.html',
  root = repositoryRoot,
) {
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
      const file = path.resolve(root, `.${pathname}`);
      if (!file.startsWith(`${root}${path.sep}`) || !(await stat(file)).isFile()) {
        response.writeHead(404).end('Not found');
        return;
      }
      response.writeHead(200, {
        'content-type': contentType(file),
        'cache-control': 'no-store',
      });
      response.end(await readFile(file));
    } catch {
      response.writeHead(404).end('Not found');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server did not bind TCP');
  return {
    server,
    url: `http://127.0.0.1:${address.port}${fixturePath}`,
  };
}

test(
  'loads the pinned TurboWarp browser platform bundle in real Chromium',
  {timeout: 30_000},
  async () => {
    const chromeExecutable = await resolveChromeExecutable();
    const profileDirectory = await mkdtemp(path.join(tmpdir(), 'dsl4-turbowarp-chromium-'));
    const fixtureDirectory = await mkdtemp(path.join(tmpdir(), 'dsl4-turbowarp-bundle-'));
    const entryPoint = path.join(fixtureDirectory, 'entry.mjs');
    const bundlePath = path.join(fixtureDirectory, 'bundle.js');
    await writeFile(
      entryPoint,
      `import {loadDsl4BrowserTurboWarpPlatform} from ${JSON.stringify(path.join(repositoryRoot, 'src/dsl4/browser-turbowarp-platform.js'))};
try {
  const platform = await loadDsl4BrowserTurboWarpPlatform();
  globalThis.turbowarpPlatformFixture = {ready: true, ok: true, methods: Object.keys(platform).sort()};
} catch (error) {
  globalThis.turbowarpPlatformFixture = {ready: true, ok: false, error: String(error?.stack ?? error)};
}
`,
    );
    const bundle = await buildDsl4TurboWarpBrowserBundle({entryPoint});
    await Promise.all([
      writeFile(bundlePath, bundle),
      writeFile(
        path.join(fixtureDirectory, 'index.html'),
        '<!doctype html><meta charset="utf-8"><script type="module" src="/bundle.js"></script>',
      ),
    ]);
    const {server, url} = await startFixtureServer('/index.html', fixtureDirectory);
    const chrome = spawn(
      chromeExecutable,
      [
        '--headless=new',
        '--disable-background-networking',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-sandbox',
        '--remote-debugging-port=0',
        `--user-data-dir=${profileDirectory}`,
        url,
      ],
      {stdio: ['ignore', 'pipe', 'pipe']},
    );
    let client = null;
    try {
      const browserWebSocketUrl = await waitForDevTools(chrome);
      const pageWebSocketUrl = await waitForPageTarget(browserWebSocketUrl, url);
      client = await CdpClient.connect(pageWebSocketUrl);
      await client.send('Runtime.enable');
      await waitForEvaluation(
        client,
        'globalThis.turbowarpPlatformFixture?.ready === true',
        'TurboWarp platform package load',
      );
      const fixture = await client.evaluate('globalThis.turbowarpPlatformFixture');
      assert.equal(fixture.ok, true, fixture.error);
      assert.deepEqual(fixture.methods, [
        'createAudioEngine',
        'createBitmapAdapter',
        'createRenderer',
        'createStorage',
        'createVm',
        'disposeAudioEngine',
        'disposeBitmapAdapter',
        'disposeRenderer',
        'disposeStorage',
      ]);
      assert.deepEqual(client.exceptions, []);
    } finally {
      client?.close();
      await stopChrome(chrome);
      await new Promise((resolve) => server.close(resolve));
      await Promise.all([
        rm(profileDirectory, {recursive: true, force: true, maxRetries: 10, retryDelay: 100}),
        rm(fixtureDirectory, {recursive: true, force: true, maxRetries: 10, retryDelay: 100}),
      ]);
    }
  },
);

function waitForDevTools(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(
      () => reject(new Error(`Chrome DevTools timeout\n${output}`)),
      15_000,
    );
    const inspect = (chunk) => {
      output += chunk.toString();
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/u);
      if (!match) return;
      clearTimeout(timeout);
      resolve(match[1]);
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Chrome exited before DevTools was ready (${code})\n${output}`));
    });
  });
}

async function waitForPageTarget(browserWebSocketUrl, fixtureUrl) {
  const endpoint = new URL(browserWebSocketUrl);
  const listUrl = `http://${endpoint.host}/json/list`;
  const expected = new URL(fixtureUrl);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const targets = await fetch(listUrl).then((response) => response.json());
      const page = targets.find((target) => {
        if (target.type !== 'page') return false;
        const actual = new URL(target.url);
        return (
          actual.origin === expected.origin &&
          actual.pathname === expected.pathname &&
          actual.search === expected.search
        );
      });
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      // Chrome may publish the browser endpoint before the initial page target.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Chrome did not expose the Web Preview page target');
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.exceptions = [];
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.method === 'Runtime.exceptionThrown') {
        this.exceptions.push(
          message.params.exceptionDetails.exception?.description ??
            message.params.exceptionDetails.text,
        );
      }
      if (!message.id) return;
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, {once: true});
      socket.addEventListener('error', reject, {once: true});
    });
    return new CdpClient(socket);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {resolve, reject});
      this.socket.send(JSON.stringify({id, method, params}));
    });
  }

  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) {
      throw new Error(
        response.exceptionDetails.exception?.description ?? response.exceptionDetails.text,
      );
    }
    return response.result.value;
  }

  close() {
    this.socket.close();
  }
}

async function waitForEvaluation(client, expression, message) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await client.evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for ${message}`);
}

async function centerOf(client, selector) {
  return client.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    element.scrollIntoView({block: 'center', inline: 'center'});
    const rect = element.getBoundingClientRect();
    return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
  })()`);
}

async function click(client, selector) {
  const point = await centerOf(client, selector);
  assert.ok(point, `Missing browser fixture element: ${selector}`);
  await client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: point.x,
    y: point.y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: point.x,
    y: point.y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  });
}

async function pressKey(client, {key, code, windowsVirtualKeyCode}) {
  const params = {key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode};
  await client.send('Input.dispatchKeyEvent', {type: 'keyDown', ...params});
  await client.send('Input.dispatchKeyEvent', {type: 'keyUp', ...params});
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => finish(true);
    const finish = (exited) => {
      clearTimeout(timeout);
      child.off('exit', onExit);
      resolve(exited);
    };
    const timeout = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
  });
}

async function stopChrome(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  if (await waitForExit(child, 2_000)) return;
  child.kill('SIGKILL');
  await waitForExit(child, 5_000);
}

function createLocalPreviewRuntimeProtocol() {
  const liveReload = createDsl4LiveReloadSession({
    createSession({storyDocument}) {
      const firstAction = storyDocument.scenes[0].actions[0] ?? null;
      let state = {
        status: 'idle',
        sceneId: storyDocument.scenes[0].id,
        actionIndex: 0,
        actionPath: firstAction?.id ?? null,
        variables: storyDocument.variables,
      };
      let quiesceToken = null;
      return {
        start() {
          state = {...state, status: 'running'};
          return Promise.resolve(state);
        },
        stop() {
          state = {...state, status: 'stopped'};
          quiesceToken = null;
        },
        dispose() {},
        getState() {
          return {runtime: state};
        },
        quiesce({candidateId}) {
          quiesceToken = Object.freeze({
            kind: 'Dsl4QuiesceToken',
            version: 1,
            candidateId,
            runtimeGeneration: 1,
            storyPath: firstAction?.id ?? `/scenes/${state.sceneId}`,
            actionSignature: firstAction
              ? {
                  command: firstAction.command,
                  target: firstAction.target,
                  handler: firstAction.handler ?? 'core',
                }
              : null,
            sceneId: state.sceneId,
            actionIndex: 0,
            variables: {...state.variables},
            resumeMode: firstAction ? 'replay-action' : 'finished',
          });
          state = {...state, status: 'paused'};
          return quiesceToken;
        },
        resumeQuiesce(candidateId) {
          if (!quiesceToken || quiesceToken.candidateId !== candidateId) {
            throw new TypeError('stale quiesce candidate');
          }
          quiesceToken = null;
          state = {...state, status: 'running'};
          return state;
        },
      };
    },
  });
  return {
    liveReload,
    protocol: createDsl4PreviewProtocolSession({liveReloadSession: liveReload}),
  };
}

test(
  'runs Web Preview reload UX through real Chromium DOM, pointer, keyboard, and viewport events',
  {timeout: 30_000},
  async () => {
    const chromeExecutable = await resolveChromeExecutable();
    const profileDirectory = await mkdtemp(path.join(tmpdir(), 'dsl4-preview-chromium-'));
    const {server, url} = await startFixtureServer();
    const chrome = spawn(
      chromeExecutable,
      [
        '--headless=new',
        '--disable-background-networking',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-sandbox',
        '--remote-debugging-port=0',
        `--user-data-dir=${profileDirectory}`,
        url,
      ],
      {stdio: ['ignore', 'pipe', 'pipe']},
    );
    let client = null;
    try {
      const browserWebSocketUrl = await waitForDevTools(chrome);
      const pageWebSocketUrl = await waitForPageTarget(browserWebSocketUrl, url);
      client = await CdpClient.connect(pageWebSocketUrl);
      await client.send('Runtime.enable');
      await client.send('Page.enable');
      await waitForEvaluation(
        client,
        "document.querySelector('#fixture-ready')?.textContent === 'Browser fixture ready.'",
        'browser fixture startup',
      );

      await click(client, '#dsl4-web-preview-open-project');
      await waitForEvaluation(
        client,
        "globalThis.webPreviewFixture?.shell.getSnapshot().preview?.phase === 'running'",
        'initial source activation',
      );
      assert.equal(
        await client.evaluate(
          "document.querySelector('#dsl4-preview-reload-overlay')?.dataset.previewSurface",
        ),
        'web',
      );

      const initialIntegrity = await client.evaluate(
        'globalThis.webPreviewFixture.shell.getSnapshot().preview.currentIntegrity',
      );
      await click(client, '#fixture-save-valid');
      try {
        await waitForEvaluation(
          client,
          "globalThis.webPreviewFixture.shell.getSnapshot().reloadOverlay?.overlay.policy.status === 'reloaded'",
          'automatic reload acknowledgement',
        );
      } catch (error) {
        const state = await client.evaluate('globalThis.webPreviewFixture.shell.getSnapshot()');
        throw new Error(
          `${error.message}\n${JSON.stringify({state, exceptions: client.exceptions})}`,
        );
      }
      const reloaded = await client.evaluate('globalThis.webPreviewFixture.shell.getSnapshot()');
      assert.notEqual(reloaded.preview.currentIntegrity, initialIntegrity);
      assert.equal(reloaded.reloadOverlay.globalRevision, 1);
      assert.equal(reloaded.reloadOverlay.overlay.policy.lastSuccess.actualAnchor, 'action');

      const statusPoint = await centerOf(client, '#dsl4-preview-reload-status-button');
      await client.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: statusPoint.x,
        y: statusPoint.y,
        button: 'left',
        buttons: 1,
        clickCount: 1,
      });
      const pointerState = await client.evaluate(`({
      interaction: globalThis.webPreviewFixture.shell.getSnapshot().reloadOverlay.overlay.layout.interaction,
      activeElement: document.activeElement?.id,
      hit: document.elementFromPoint(${statusPoint.x}, ${statusPoint.y})?.id,
      point: ${JSON.stringify(statusPoint)},
      viewport: {width: innerWidth, height: innerHeight},
      rect: (() => { const rect = document.querySelector('#dsl4-preview-reload-status-button').getBoundingClientRect(); return {x: rect.x, y: rect.y, width: rect.width, height: rect.height}; })()
    })`);
      assert.equal(pointerState.interaction.pointerCaptured, true, JSON.stringify(pointerState));
      await client.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: statusPoint.x,
        y: statusPoint.y,
        button: 'left',
        buttons: 0,
        clickCount: 1,
      });
      await waitForEvaluation(
        client,
        'globalThis.webPreviewFixture.shell.getSnapshot().reloadOverlay.overlay.policy.dialog.open',
        'reload dialog opening',
      );
      await pressKey(client, {key: '2', code: 'Digit2', windowsVirtualKeyCode: 50});
      await waitForEvaluation(
        client,
        "globalThis.webPreviewFixture.shell.getSnapshot().reloadOverlay.overlay.policy.dialog.step === 'scope'",
        'keyboard position selection',
      );
      await pressKey(client, {key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27});
      await waitForEvaluation(
        client,
        '!globalThis.webPreviewFixture.shell.getSnapshot().reloadOverlay.overlay.policy.dialog.open',
        'dialog cancellation',
      );

      const initialViewport = await client.evaluate(
        'globalThis.webPreviewFixture.shell.getSnapshot().reloadOverlay.overlay.layout.viewport',
      );
      await client.send('Emulation.setDeviceMetricsOverride', {
        width: 520,
        height: 360,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await waitForEvaluation(client, 'innerWidth === 520', 'Chromium viewport override');
      const resizedViewport = await client.evaluate(`({
        width: document.documentElement.clientWidth,
        height: document.documentElement.clientHeight
      })`);
      assert.ok(resizedViewport.width < initialViewport.width);
      assert.ok(resizedViewport.height < initialViewport.height);
      await client.evaluate("window.dispatchEvent(new Event('resize'))");
      await waitForEvaluation(
        client,
        `(() => {
          const viewport = globalThis.webPreviewFixture.shell.getSnapshot().reloadOverlay.overlay.layout.viewport;
          return viewport.width === ${resizedViewport.width} && viewport.height === ${resizedViewport.height};
        })()`,
        'viewport resize layout',
      );

      const knownGoodIntegrity = reloaded.preview.currentIntegrity;
      await click(client, '#fixture-save-invalid');
      await waitForEvaluation(
        client,
        "globalThis.webPreviewFixture.shell.getSnapshot().reloadOverlay?.overlay.policy.status === 'diagnostic'",
        'invalid source diagnostic',
      );
      const invalid = await client.evaluate('globalThis.webPreviewFixture.shell.getSnapshot()');
      assert.equal(invalid.preview.currentIntegrity, knownGoodIntegrity);
      assert.equal(invalid.preview.validationStatus, 'invalid');

      await click(client, '#fixture-restore-source');
      await waitForEvaluation(
        client,
        "globalThis.webPreviewFixture.shell.getSnapshot().reloadOverlay?.globalRevision === 2 && globalThis.webPreviewFixture.shell.getSnapshot().reloadOverlay.overlay.policy.status === 'reloaded'",
        'valid source recovery reload',
      );
      const touchPoint = await centerOf(client, '#fixture-ready');
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{x: touchPoint.x, y: touchPoint.y, radiusX: 1, radiusY: 1, force: 1}],
      });
      await client.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
      await waitForEvaluation(
        client,
        'globalThis.webPreviewFixture.shell.getSnapshot().reloadOverlay.overlay.policy.lastSuccess.acknowledged',
        'touch acknowledgement',
      );
      assert.deepEqual(client.exceptions, []);
    } finally {
      client?.close();
      await stopChrome(chrome);
      await new Promise((resolve) => server.close(resolve));
      await rm(profileDirectory, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    }
  },
);

test(
  'bounds TMPose classifier, PoseNet, and JavaScript heap across repeated scene retention',
  {timeout: 30_000},
  async () => {
    const chromeExecutable = await resolveChromeExecutable();
    const profileDirectory = await mkdtemp(path.join(tmpdir(), 'dsl4-pose-memory-chromium-'));
    const {server, url} = await startFixtureServer(
      '/test/fixtures/dsl4/browser/pose-memory-retention.html',
    );
    const chrome = spawn(
      chromeExecutable,
      [
        '--headless=new',
        '--disable-background-networking',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--enable-precise-memory-info',
        '--no-first-run',
        '--no-sandbox',
        '--remote-debugging-port=0',
        `--user-data-dir=${profileDirectory}`,
        url,
      ],
      {stdio: ['ignore', 'pipe', 'pipe']},
    );
    let client = null;
    try {
      const browserWebSocketUrl = await waitForDevTools(chrome);
      const pageWebSocketUrl = await waitForPageTarget(browserWebSocketUrl, url);
      client = await CdpClient.connect(pageWebSocketUrl);
      await client.send('Runtime.enable');
      try {
        await waitForEvaluation(
          client,
          'globalThis.poseMemoryFixture !== undefined',
          'pose memory fixture completion',
        );
      } catch (error) {
        const page = await client.evaluate(`({
          status: document.querySelector('#status')?.textContent,
          result: document.querySelector('#result')?.textContent
        })`);
        throw new Error(
          `${error.message}\n${JSON.stringify({page, exceptions: client.exceptions})}`,
        );
      }
      const fixture = await client.evaluate('globalThis.poseMemoryFixture');
      assert.equal(fixture.passed, true, fixture.error);
      const observed = await client.evaluate('globalThis.poseMemoryFixture.observed');
      assert.equal(observed.backend, 'instrumented-disposable-browser-backend');
      assert.equal(observed.visits, 24);
      assert.deepEqual(observed.logicalMemory, {
        numTensors: 0,
        numBytes: 0,
        unreliable: false,
      });
      assert.equal(observed.maximumTensors, 20);
      assert.equal(observed.classifierDisposals, 24);
      assert.equal(observed.poseNetDisposals, 24);

      await client.send('HeapProfiler.enable');
      await client.send('HeapProfiler.collectGarbage');
      const afterGcHeapBytes = await client.evaluate('performance.memory.usedJSHeapSize');
      assert.ok(
        afterGcHeapBytes <= observed.baselineHeapBytes + 8 * 1024 * 1024,
        JSON.stringify({...observed, afterGcHeapBytes}),
      );
      assert.deepEqual(client.exceptions, []);
    } finally {
      client?.close();
      await stopChrome(chrome);
      await new Promise((resolve) => server.close(resolve));
      await rm(profileDirectory, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    }
  },
);

test(
  'runs the loopback CLI preview page through the shared overlay in real Chromium',
  {timeout: 30_000},
  async () => {
    const chromeExecutable = await resolveChromeExecutable();
    const profileDirectory = await mkdtemp(path.join(tmpdir(), 'dsl4-local-preview-chromium-'));
    const projectDirectory = await mkdtemp(path.join(tmpdir(), 'dsl4-local-preview-project-'));
    const sourceManifestPath = path.join(projectDirectory, 'project.source.json');
    const sourceFilename = 'preview.k4.yml';
    const sourcePath = path.join(projectDirectory, sourceFilename);
    const manifest = {formatVersion: 1, mode: 'external', sourceId: 'main', path: sourceFilename};
    await Promise.all([
      writeFile(sourceManifestPath, `${JSON.stringify(manifest)}\n`),
      writeFile(sourcePath, "kamishibai: '4.0'\nscenes:\n  opening: []\n"),
    ]);
    const schema = JSON.parse(
      await readFile(path.join(repositoryRoot, 'schema', 'dsl-4.schema.json'), 'utf8'),
    );
    const runtime = createLocalPreviewRuntimeProtocol();
    const hostEvents = [];
    const host = createDsl4LocalPreviewHost({
      projectRoot: projectDirectory,
      sourceManifestPath,
      sourceManifest: manifest,
      sourceFrontend: createDsl4ProductionSourceFrontend(schema),
      maxSourceBytes: 4096,
      protocolSession: runtime.protocol,
      onEvent: (event) => hostEvents.push(event),
    });
    await host.start();
    const url = host.getLaunchUrl();
    const chrome = spawn(
      chromeExecutable,
      [
        '--headless=new',
        '--disable-background-networking',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-sandbox',
        '--remote-debugging-port=0',
        `--user-data-dir=${profileDirectory}`,
        url,
      ],
      {stdio: ['ignore', 'pipe', 'pipe']},
    );
    let client = null;
    try {
      const browserWebSocketUrl = await waitForDevTools(chrome);
      const pageWebSocketUrl = await waitForPageTarget(browserWebSocketUrl, url);
      client = await CdpClient.connect(pageWebSocketUrl);
      await client.send('Runtime.enable');
      await waitForEvaluation(
        client,
        "document.querySelector('#dsl4-preview-status')?.dataset.validationStatus === 'valid'",
        'local preview initial source activation',
      );
      assert.equal(
        await client.evaluate(
          "document.querySelector('#dsl4-preview-reload-overlay')?.dataset.previewSurface",
        ),
        'cli',
      );
      assert.equal(host.getSnapshot().status, 'connected');
      assert.equal(
        await client.evaluate("document.querySelector('[data-summary-value=source]')?.textContent"),
        sourceFilename,
      );
      const initialIntegrity = await client.evaluate(
        "document.querySelector('[data-summary-value=currentIntegrity]')?.textContent",
      );

      await writeFile(sourcePath, "kamishibai: '4.0'\nscenes:\n  opening:\n    - wait: 60\n");
      try {
        await waitForEvaluation(
          client,
          "document.querySelector('#dsl4-preview-reload-status-button')?.dataset.reloadState === 'reloaded'",
          'local preview automatic reload',
        );
      } catch (error) {
        const page = await client.evaluate(`({
          status: document.querySelector('#dsl4-preview-status')?.textContent,
          current: document.querySelector('[data-summary-value=currentIntegrity]')?.textContent,
          candidate: document.querySelector('[data-summary-value=candidateIntegrity]')?.textContent,
          reload: document.querySelector('#dsl4-preview-reload-status-button')?.dataset.reloadState,
          body: document.body.textContent
        })`);
        throw new Error(
          `${error.message}\n${JSON.stringify({page, host: host.getSnapshot(), hostEvents, exceptions: client.exceptions})}`,
        );
      }
      const reloadedIntegrity = await client.evaluate(
        "document.querySelector('[data-summary-value=currentIntegrity]')?.textContent",
      );
      assert.notEqual(reloadedIntegrity, initialIntegrity);

      await writeFile(sourcePath, "kamishibai: '4.0'\nscenes: {}\n");
      await waitForEvaluation(
        client,
        "document.querySelector('#dsl4-preview-status')?.dataset.validationStatus === 'invalid'",
        'local preview invalid diagnostic',
      );
      assert.equal(
        await client.evaluate(
          "document.querySelector('[data-summary-value=currentIntegrity]')?.textContent",
        ),
        reloadedIntegrity,
      );
      assert.equal(
        await client.evaluate(
          "document.querySelector('#dsl4-preview-reload-status-button')?.dataset.reloadState",
        ),
        'diagnostic',
      );

      await writeFile(sourcePath, "kamishibai: '4.0'\nscenes:\n  opening:\n    - wait: 30\n");
      try {
        await waitForEvaluation(
          client,
          `document.querySelector('[data-summary-value=currentIntegrity]')?.textContent !== ${JSON.stringify(reloadedIntegrity)}`,
          'local preview recovery reload',
        );
      } catch (error) {
        const page = await client.evaluate(`({
          status: document.querySelector('#dsl4-preview-status')?.textContent,
          current: document.querySelector('[data-summary-value=currentIntegrity]')?.textContent,
          candidate: document.querySelector('[data-summary-value=candidateIntegrity]')?.textContent,
          reload: document.querySelector('#dsl4-preview-reload-status-button')?.dataset.reloadState,
          body: document.body.textContent
        })`);
        throw new Error(
          `${error.message}\n${JSON.stringify({page, host: host.getSnapshot(), hostEvents, exceptions: client.exceptions})}`,
        );
      }

      await writeFile(
        sourceManifestPath,
        `${JSON.stringify({...manifest, path: 'alternate.k4.yaml'})}\n`,
      );
      await waitForEvaluation(
        client,
        "document.querySelector('#dsl4-preview-reload-status-button')?.dataset.reloadState === 'diagnostic'",
        'local preview structural rebuild diagnostic',
      );
      await waitForEvaluation(
        client,
        'document.body.textContent.includes("full rebuild")',
        'local preview full rebuild message',
      );
      assert.equal(host.getSnapshot().rebuildRequired, true);
      assert.equal(await client.evaluate('location.hash'), '');
      assert.deepEqual(client.exceptions, []);
    } finally {
      client?.close();
      await stopChrome(chrome);
      await host.dispose();
      await runtime.liveReload.dispose();
      await Promise.all([
        rm(profileDirectory, {recursive: true, force: true, maxRetries: 10, retryDelay: 100}),
        rm(projectDirectory, {recursive: true, force: true}),
      ]);
    }
  },
);
