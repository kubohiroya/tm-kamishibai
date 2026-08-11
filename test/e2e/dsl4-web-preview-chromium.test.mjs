import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {createHash, webcrypto} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {access, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

import {strToU8, zipSync} from 'fflate';

import {
  createDownloadableReleaseSb3,
  downloadableReleases,
} from '../../scripts/sb3/downloadable-releases.mjs';
import {
  buildDsl4TurboWarpBrowserBundle,
  createDsl4LocalPreviewHost,
  createDsl4ProductionSourceFrontend,
  installDsl4PackagedRuntimeComponent,
  runDsl4LocalPreviewCommand,
} from '../../src/builder/index.js';
import {
  createDsl4EmbeddedAssetBundle,
  createDsl4EmbeddedSourceDescriptor,
  createDsl4LiveReloadSession,
  createDsl4PreviewProtocolSession,
  createDsl4RuntimeArtifactDescriptor,
} from '../../src/dsl4/index.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const TurboWarpPackager = require('@turbowarp/packager');
const dsl4Release = downloadableReleases.find(({series}) => series === '4.0');
assert(dsl4Release, 'The DSL 4.0 downloadable release is unavailable.');

function createPoseFeedbackVariables() {
  return {
    'pose-confidence': ['ポーズ認識', 0],
    'pose-progress': ['チャージ', 0],
  };
}

function createPoseFeedbackMonitors() {
  return [
    {
      id: 'pose-confidence',
      mode: 'slider',
      opcode: 'data_variable',
      params: {VARIABLE: 'ポーズ認識'},
      spriteName: null,
      value: 0,
      width: 0,
      height: 0,
      x: 0,
      y: 0,
      visible: false,
      sliderMin: 0,
      sliderMax: 100,
      isDiscrete: true,
    },
    {
      id: 'pose-progress',
      mode: 'slider',
      opcode: 'data_variable',
      params: {VARIABLE: 'チャージ'},
      spriteName: null,
      value: 0,
      width: 0,
      height: 0,
      x: 343,
      y: 0,
      visible: false,
      sliderMin: 0,
      sliderMax: 100,
      isDiscrete: true,
    },
  ];
}

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

test(
  'opens the non-embedded release title and disabled Reload menu without loading its story bundle',
  {timeout: 30_000},
  async () => {
    const chromeExecutable = await resolveChromeExecutable();
    const profileDirectory = await mkdtemp(path.join(tmpdir(), 'dsl4-release-menu-chromium-'));
    const fixtureDirectory = await mkdtemp(path.join(tmpdir(), 'dsl4-release-menu-package-'));
    const release = await createDownloadableReleaseSb3(dsl4Release);
    const loadedProject = await TurboWarpPackager.loadProject(release.archive);
    const packager = new TurboWarpPackager.Packager();
    packager.project = loadedProject;
    packager.options.autoplay = true;
    packager.options.app.title = 'DSL 4.0 non-embedded release E2E';
    const packaged = await packager.package();
    assert.equal(packaged.type, 'text/html');
    await writeFile(path.join(fixtureDirectory, 'index.html'), packaged.data);
    const {server, url} = await startFixtureServer('/index.html', fixtureDirectory);
    const chrome = spawn(
      chromeExecutable,
      [
        '--headless=new',
        '--disable-background-networking',
        '--disable-dev-shm-usage',
        '--use-angle=swiftshader',
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
      await waitForEvaluation(client, 'Boolean(globalThis.Scratch?.vm)', 'packaged TurboWarp VM');
      assert.equal(
        await client.evaluate(`(() => {
          const vm = globalThis.Scratch.vm;
          const originalToJSON = vm.toJSON.bind(vm);
          vm.toJSON = () => {
            const project = JSON.parse(originalToJSON());
            project.extensionStorage.kubohiroyakamishibai4.components
              .kubohiroyakamishibairuntime4.assets = {formatVersion: 0};
            return JSON.stringify(project);
          };
          vm.greenFlag();
          return true;
        })()`),
        true,
      );
      await waitForEvaluation(
        client,
        `document.querySelector('[data-dsl4-title-controls=true]')?.style.display === 'block'`,
        'localized release title',
      );
      assert.equal(
        await client.evaluate(
          `document.querySelector('[data-dsl4-runtime-error=true]')?.style.display === 'flex'`,
        ),
        false,
      );
      const initialTitleScale = await client.evaluate(`(() => {
        const title = document.querySelector('[data-dsl4-title-controls=true]');
        const website = document.querySelector('[data-dsl4-title-action=website]');
        const icon = website?.querySelector('img');
        const label = website?.querySelector('span');
        return {
          titleWidth: title?.getBoundingClientRect().width ?? 0,
          iconWidth: icon?.getBoundingClientRect().width ?? 0,
          fontSize: label ? Number.parseFloat(getComputedStyle(label).fontSize) : 0
        };
      })()`);
      await client.send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 1080,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await waitForEvaluation(
        client,
        `document.querySelector('[data-dsl4-title-controls=true]').getBoundingClientRect().width > ${initialTitleScale.titleWidth * 1.25}`,
        'scaled release title stage',
      );
      const expandedTitleScale = await client.evaluate(`(() => {
        const title = document.querySelector('[data-dsl4-title-controls=true]');
        const website = document.querySelector('[data-dsl4-title-action=website]');
        const icon = website?.querySelector('img');
        const label = website?.querySelector('span');
        return {
          titleWidth: title?.getBoundingClientRect().width ?? 0,
          iconWidth: icon?.getBoundingClientRect().width ?? 0,
          fontSize: label ? Number.parseFloat(getComputedStyle(label).fontSize) : 0
        };
      })()`);
      assert.ok(
        expandedTitleScale.iconWidth > initialTitleScale.iconWidth * 1.25,
        `title website icon must scale with the Stage: ${JSON.stringify({initialTitleScale, expandedTitleScale})}`,
      );
      assert.ok(
        expandedTitleScale.fontSize > initialTitleScale.fontSize * 1.25,
        `title website label must scale with the Stage: ${JSON.stringify({initialTitleScale, expandedTitleScale})}`,
      );
      assert.ok(
        Math.abs(
          expandedTitleScale.iconWidth / expandedTitleScale.titleWidth -
            initialTitleScale.iconWidth / initialTitleScale.titleWidth,
        ) < 0.002,
      );
      assert.ok(
        Math.abs(
          expandedTitleScale.fontSize / expandedTitleScale.titleWidth -
            initialTitleScale.fontSize / initialTitleScale.titleWidth,
        ) < 0.002,
      );
      await client.send('Emulation.setDeviceMetricsOverride', {
        width: 800,
        height: 600,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await waitForEvaluation(
        client,
        `document.querySelector('[data-dsl4-title-controls=true]').getBoundingClientRect().width < ${expandedTitleScale.titleWidth / 1.25}`,
        'restored release title stage',
      );
      await client.evaluate(
        `document.querySelector('[data-dsl4-title-action=close]').click(); true`,
      );
      await waitForEvaluation(
        client,
        `document.querySelector('[data-dsl4-application-menu=true]')?.style.display === 'block'`,
        'non-embedded application menu',
      );
      const initialMenuScale = await client.evaluate(`(() => {
        const menu = document.querySelector('[data-dsl4-application-menu=true]');
        const open = document.querySelector('[data-dsl4-menu-action=open]');
        const icon = open?.querySelector('img');
        const label = open?.querySelector('span');
        return {
          menuWidth: menu?.getBoundingClientRect().width ?? 0,
          iconWidth: icon?.getBoundingClientRect().width ?? 0,
          fontSize: label ? Number.parseFloat(getComputedStyle(label).fontSize) : 0
        };
      })()`);
      await client.send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 1080,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await waitForEvaluation(
        client,
        `document.querySelector('[data-dsl4-application-menu=true]').getBoundingClientRect().width > ${initialMenuScale.menuWidth * 1.25}`,
        'scaled application menu stage',
      );
      const expandedMenuScale = await client.evaluate(`(() => {
        const menu = document.querySelector('[data-dsl4-application-menu=true]');
        const open = document.querySelector('[data-dsl4-menu-action=open]');
        const icon = open?.querySelector('img');
        const label = open?.querySelector('span');
        return {
          menuWidth: menu?.getBoundingClientRect().width ?? 0,
          iconWidth: icon?.getBoundingClientRect().width ?? 0,
          fontSize: label ? Number.parseFloat(getComputedStyle(label).fontSize) : 0
        };
      })()`);
      assert.ok(
        expandedMenuScale.iconWidth > initialMenuScale.iconWidth * 1.25,
        `menu icon must scale with the Stage: ${JSON.stringify({initialMenuScale, expandedMenuScale})}`,
      );
      assert.ok(
        expandedMenuScale.fontSize > initialMenuScale.fontSize * 1.25,
        `menu label must scale with the Stage: ${JSON.stringify({initialMenuScale, expandedMenuScale})}`,
      );
      assert.ok(
        Math.abs(
          expandedMenuScale.iconWidth / expandedMenuScale.menuWidth -
            initialMenuScale.iconWidth / initialMenuScale.menuWidth,
        ) < 0.002,
      );
      assert.ok(
        Math.abs(
          expandedMenuScale.fontSize / expandedMenuScale.menuWidth -
            initialMenuScale.fontSize / initialMenuScale.menuWidth,
        ) < 0.002,
      );
      await click(client, '[data-dsl4-menu-action=about]');
      await waitForEvaluation(
        client,
        `document.querySelector('[data-dsl4-application-menu=true]')?.style.display === 'none' && document.querySelector('[data-dsl4-title-controls=true]')?.style.display === 'block'`,
        'application information title screen',
      );
      const aboutState = await client.evaluate(`(() => {
        const runtime = globalThis.Scratch.vm.runtime;
        const stage = runtime.getTargetForStage();
        return {
          stageCostume: stage.getCostumes()[stage.currentCostume].name,
          simplifiedDialogCount: document.querySelectorAll('[data-dsl4-title-shell=true]').length
        };
      })()`);
      assert.match(aboutState.stageCostume, /^Title(?:Runtime)?$/u);
      assert.equal(aboutState.simplifiedDialogCount, 0);
      await click(client, '[data-dsl4-title-action=close]');
      await waitForEvaluation(
        client,
        `document.querySelector('[data-dsl4-application-menu=true]')?.style.display === 'block'`,
        'return from application information title',
      );
      const menu = await client.evaluate(`(() => {
        const reload = document.querySelector('[data-dsl4-menu-action=reload]');
        const open = document.querySelector('[data-dsl4-menu-action=open]');
        const icons = [...document.querySelectorAll('[data-dsl4-menu-action] img')];
        const runtime = globalThis.Scratch.vm.runtime;
        const stage = runtime.getTargetForStage();
        open.click();
        const input = document.querySelector('input[type=file]');
        return {
          reloadDisabled: reload?.disabled,
          reloadAriaDisabled: reload?.getAttribute('aria-disabled'),
          reloadCursor: reload ? getComputedStyle(reload).cursor : null,
          inputAccept: input?.accept,
          inputMultiple: input?.multiple,
          inputWebkitDirectory: input?.webkitdirectory,
          iconFilters: icons.map((icon) => getComputedStyle(icon).filter),
          stageCostume: stage.getCostumes()[stage.currentCostume].name,
          errorVisible:
            document.querySelector('[data-dsl4-runtime-error=true]')?.style.display === 'flex',
        };
      })()`);
      assert.equal(menu.reloadDisabled, true);
      assert.equal(menu.reloadAriaDisabled, 'true');
      assert.equal(menu.reloadCursor, 'not-allowed');
      assert.equal(menu.inputAccept, '.yml,.yaml');
      assert.equal(menu.inputMultiple, false);
      assert.equal(menu.inputWebkitDirectory, false);
      assert.equal(menu.iconFilters.length, 4);
      assert.equal(
        menu.iconFilters.every((filter) => filter !== 'none'),
        true,
      );
      assert.match(menu.stageCostume, /^Menu(?:Runtime)?$/u);
      assert.equal(menu.errorVisible, false);
      assert.deepEqual(client.exceptions, []);
    } finally {
      client?.close();
      await stopChrome(chrome);
      await new Promise((resolve) => server.close(resolve));
      await Promise.all([
        rm(profileDirectory, {recursive: true, force: true, maxRetries: 10, retryDelay: 100}),
        rm(fixtureDirectory, {recursive: true, force: true}),
      ]);
    }
  },
);

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
    const fixtureDirectory = await mkdtemp(path.join(tmpdir(), 'dsl4-preview-bundle-'));
    const fixtureHtml = await readFile(
      path.join(repositoryRoot, 'test/fixtures/dsl4/web-preview-browser.html'),
      'utf8',
    );
    const bundle = await buildDsl4TurboWarpBrowserBundle({
      entryPoint: path.join(repositoryRoot, 'test/fixtures/dsl4/web-preview-browser.mjs'),
    });
    await Promise.all([
      writeFile(
        path.join(fixtureDirectory, 'index.html'),
        fixtureHtml.replace('./web-preview-browser.mjs', './bundle.js'),
      ),
      writeFile(path.join(fixtureDirectory, 'bundle.js'), bundle),
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
      await client.send('Page.enable');
      try {
        await waitForEvaluation(
          client,
          "document.querySelector('#fixture-ready')?.textContent === 'Browser fixture ready.'",
          'browser fixture startup',
        );
      } catch (error) {
        throw new Error(`${error.message}\n${JSON.stringify({exceptions: client.exceptions})}`);
      }

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
      await Promise.all([
        rm(profileDirectory, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        }),
        rm(fixtureDirectory, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        }),
      ]);
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

test(
  'runs the browser-owned TurboWarp stage and source reload lifecycle in real Chromium',
  {timeout: 60_000},
  async () => {
    const chromeExecutable = await resolveChromeExecutable();
    const profileDirectory = await mkdtemp(path.join(tmpdir(), 'dsl4-browser-runtime-chromium-'));
    const projectDirectory = await mkdtemp(path.join(tmpdir(), 'dsl4-browser-runtime-project-'));
    const sourceManifestPath = path.join(projectDirectory, 'project.source.json');
    const sourceFilename = 'story.k4.yml';
    const sourcePath = path.join(projectDirectory, sourceFilename);
    const manifest = {formatVersion: 1, mode: 'external', sourceId: 'main', path: sourceFilename};
    const initialSource =
      "kamishibai: '4.0'\ncontrols:\n  keymaps:\n    production:\n      Space: navigation.nextAction\nscenes:\n  opening: []\n";
    await Promise.all([
      writeFile(sourceManifestPath, `${JSON.stringify(manifest)}\n`),
      writeFile(sourcePath, initialSource),
    ]);
    const schema = JSON.parse(
      await readFile(path.join(repositoryRoot, 'schema', 'dsl-4.schema.json'), 'utf8'),
    );
    const sourceFrontend = createDsl4ProductionSourceFrontend(schema);
    const limits = {maxSourceBytes: 64 * 1024, maxAssetFiles: 64, maxAssetBytes: 64 * 1024 * 1024};
    const parsed = sourceFrontend.parse(initialSource, {sourceId: 'main'});
    assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics));
    const sourceDescriptor = await createDsl4EmbeddedSourceDescriptor(initialSource, {
      sourceId: 'main',
      displayName: sourceFilename,
      maxSourceBytes: limits.maxSourceBytes,
      subtleCrypto: webcrypto.subtle,
    });
    const artifact = await createDsl4RuntimeArtifactDescriptor(
      parsed.storyDocument,
      sourceDescriptor,
      'production',
      {maxSourceBytes: limits.maxSourceBytes, subtleCrypto: webcrypto.subtle},
    );
    assert.equal(artifact.ok, true, JSON.stringify(artifact.diagnostics));
    const assets = await createDsl4EmbeddedAssetBundle(
      parsed.storyDocument,
      {manifest: {formatVersion: 1, assets: []}, getFile() {}},
      {
        maxFiles: limits.maxAssetFiles,
        maxTotalBytes: limits.maxAssetBytes,
        subtleCrypto: webcrypto.subtle,
      },
    );
    const backdropAssetId = '00000000000000000000000000000000';
    const backdropFilename = `${backdropAssetId}.svg`;
    const project = await installDsl4PackagedRuntimeComponent(
      {
        extensionStorage: {},
        targets: [
          {
            isStage: true,
            name: 'Stage',
            variables: createPoseFeedbackVariables(),
            lists: {},
            broadcasts: {},
            blocks: {},
            comments: {},
            currentCostume: 0,
            costumes: [
              {
                name: 'backdrop1',
                assetId: backdropAssetId,
                dataFormat: 'svg',
                md5ext: backdropFilename,
                rotationCenterX: 240,
                rotationCenterY: 180,
              },
            ],
            sounds: [],
            volume: 100,
            layerOrder: 0,
            tempo: 60,
            videoTransparency: 50,
            videoState: 'on',
            textToSpeechLanguage: null,
          },
        ],
        monitors: createPoseFeedbackMonitors(),
        extensions: [],
        meta: {semver: '3.0.0'},
      },
      parsed.storyDocument,
      sourceDescriptor,
      artifact.artifact,
      assets,
      {channel: 'unbundled', ...limits, subtleCrypto: webcrypto.subtle},
    );
    const projectBytes = new Uint8Array(
      zipSync({
        'project.json': strToU8(`${JSON.stringify(project)}\n`),
        [backdropFilename]: strToU8(
          '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360"></svg>',
        ),
      }),
    );
    const browserBundleBytes = await buildDsl4TurboWarpBrowserBundle({
      entryPoint: path.join(repositoryRoot, 'src/builder/dsl4-local-preview-browser-entry.js'),
    });
    const hostErrors = [];
    const host = createDsl4LocalPreviewHost({
      projectRoot: projectDirectory,
      sourceManifestPath,
      sourceManifest: manifest,
      sourceFrontend,
      maxSourceBytes: limits.maxSourceBytes,
      runtimeOwner: 'browser',
      projectBytes,
      browserBundleBytes,
      onError: (error) => hostErrors.push(String(error?.stack ?? error)),
    });
    await host.start();
    const url = host.getLaunchUrl();
    const chrome = spawn(
      chromeExecutable,
      [
        '--headless=new',
        '--disable-background-networking',
        '--disable-dev-shm-usage',
        '--use-angle=swiftshader',
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
          "document.querySelector('#dsl4-preview-status')?.dataset.validationStatus === 'valid' && document.querySelector('canvas[data-dsl4-turbo-warp-stage=true]')",
          'browser-owned initial stage activation',
        );
      } catch (error) {
        const page = await client.evaluate(
          `({body: document.body.textContent, html: document.body.innerHTML})`,
        );
        throw new Error(
          `${error.message}\n${JSON.stringify({page, host: host.getSnapshot(), hostErrors, exceptions: client.exceptions})}`,
        );
      }
      assert.equal(host.getSnapshot().status, 'connected');
      assert.equal(host.getSnapshot().browserRuntimeReady, true);
      assert.equal(await client.evaluate('location.hash'), '');
      assert.equal(
        await client.evaluate(
          "document.querySelector('#dsl4-local-preview-runtime > p[role=alert]')?.textContent ?? ''",
        ),
        '',
      );
      assert.equal(
        await client.evaluate(
          "document.querySelectorAll('canvas[data-dsl4-turbo-warp-stage=true]').length",
        ),
        1,
      );
      const initialIntegrity = await client.evaluate(
        "document.querySelector('[data-summary-value=currentIntegrity]')?.textContent",
      );

      await writeFile(
        sourcePath,
        "kamishibai: '4.0'\ncontrols:\n  keymaps:\n    production:\n      Space: navigation.nextAction\nscenes:\n  opening:\n    - wait: 60\n",
      );
      try {
        await waitForEvaluation(
          client,
          `document.querySelector('[data-summary-value=currentIntegrity]')?.textContent !== ${JSON.stringify(initialIntegrity)}`,
          'browser-owned committed reload',
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
          `${error.message}\n${JSON.stringify({page, host: host.getSnapshot(), hostErrors, exceptions: client.exceptions})}`,
        );
      }
      const reloadedIntegrity = await client.evaluate(
        "document.querySelector('[data-summary-value=currentIntegrity]')?.textContent",
      );
      assert.notEqual(reloadedIntegrity, initialIntegrity);

      await writeFile(
        sourcePath,
        "kamishibai: '4.0'\ncontrols:\n  keymaps:\n    production:\n      Space: navigation.nextAction\nscenes: {}\n",
      );
      await waitForEvaluation(
        client,
        "document.querySelector('#dsl4-preview-status')?.dataset.validationStatus === 'invalid'",
        'browser-owned invalid source diagnostic',
      );
      assert.equal(
        await client.evaluate(
          "document.querySelector('[data-summary-value=currentIntegrity]')?.textContent",
        ),
        reloadedIntegrity,
      );

      await writeFile(
        sourcePath,
        "kamishibai: '4.0'\ncontrols:\n  keymaps:\n    production:\n      Space: navigation.nextAction\nscenes:\n  opening:\n    - wait: 30\n",
      );
      await waitForEvaluation(
        client,
        `document.querySelector('[data-summary-value=currentIntegrity]')?.textContent !== ${JSON.stringify(reloadedIntegrity)}`,
        'browser-owned recovery reload',
      );
      assert.deepEqual(client.exceptions, []);

      await client.send('Page.navigate', {url: 'about:blank'});
      const disconnectDeadline = Date.now() + 10_000;
      while (Date.now() < disconnectDeadline && host.getSnapshot().status !== 'listening') {
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      assert.equal(host.getSnapshot().status, 'listening');
      assert.equal(host.getSnapshot().browserRuntimeReady, false);
      assert.deepEqual(hostErrors, []);
    } finally {
      client?.close();
      await stopChrome(chrome);
      await host.dispose();
      await Promise.all([
        rm(profileDirectory, {recursive: true, force: true, maxRetries: 10, retryDelay: 100}),
        rm(projectDirectory, {recursive: true, force: true}),
      ]);
    }
  },
);

test(
  'runs the bundled public preview command through runtime-ready and browser disconnect in real Chromium',
  {timeout: 60_000},
  async () => {
    const chromeExecutable = await resolveChromeExecutable();
    const profileDirectory = await mkdtemp(path.join(tmpdir(), 'dsl4-preview-command-chromium-'));
    const projectDirectory = await mkdtemp(path.join(tmpdir(), 'dsl4-preview-command-project-'));
    const sourceManifestPath = path.join(projectDirectory, 'project.source.json');
    const sourceFilename = 'command.k4.yml';
    const sourcePath = path.join(projectDirectory, sourceFilename);
    const baseSb3Path = path.join(projectDirectory, 'base.sb3');
    const manifest = {formatVersion: 1, mode: 'external', sourceId: 'main', path: sourceFilename};
    const source =
      "kamishibai: '4.0'\ncontrols:\n  keymaps:\n    production:\n      Space: navigation.nextAction\nscenes:\n  opening: []\n";
    const baseRelease = await createDownloadableReleaseSb3(dsl4Release);
    await Promise.all([
      writeFile(sourceManifestPath, `${JSON.stringify(manifest)}\n`),
      writeFile(sourcePath, source),
      writeFile(baseSb3Path, baseRelease.archive),
    ]);
    const schema = JSON.parse(
      await readFile(path.join(repositoryRoot, 'schema', 'dsl-4.schema.json'), 'utf8'),
    );
    const signalTarget = new EventEmitter();
    let stdout = '';
    let stderr = '';
    let chrome = null;
    let client = null;
    let launchUrl = null;
    const commandPromise = runDsl4LocalPreviewCommand(
      {
        watch: true,
        baseSb3: baseSb3Path,
        projectRoot: projectDirectory,
        sourceManifest: sourceManifestPath,
        sourceFrontend: createDsl4ProductionSourceFrontend(schema),
        controlProfile: 'production',
        channel: 'bundled',
        maxSourceBytes: 64 * 1024,
        maxAssetFileBytes: 1024 * 1024,
        maxAssetFiles: 64,
        maxTotalAssetBytes: 64 * 1024 * 1024,
        replaceExisting: true,
        port: 0,
      },
      {
        signalTarget,
        stdout: {write: (chunk) => (stdout += chunk)},
        stderr: {write: (chunk) => (stderr += chunk)},
        async openBrowser(url) {
          launchUrl = url;
          chrome = spawn(
            chromeExecutable,
            [
              '--headless=new',
              '--disable-background-networking',
              '--disable-dev-shm-usage',
              '--use-angle=swiftshader',
              '--no-first-run',
              '--no-sandbox',
              '--remote-debugging-port=0',
              `--user-data-dir=${profileDirectory}`,
              url,
            ],
            {stdio: ['ignore', 'pipe', 'pipe']},
          );
          const browserWebSocketUrl = await waitForDevTools(chrome);
          const pageWebSocketUrl = await waitForPageTarget(browserWebSocketUrl, url);
          client = await CdpClient.connect(pageWebSocketUrl);
          await client.send('Runtime.enable');
        },
      },
    );
    try {
      const readyDeadline = Date.now() + 30_000;
      while (Date.now() < readyDeadline && !stdout.includes('Preview ready at ')) {
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      assert.match(stdout, /Preview ready at .*watching command\.k4\.yml/u, stderr);
      assert.ok(client, 'preview command did not create a Chromium page');
      await waitForEvaluation(
        client,
        "document.querySelector('#dsl4-preview-status')?.dataset.validationStatus === 'valid' && document.querySelector('canvas[data-dsl4-turbo-warp-stage=true]')",
        'public preview command stage activation',
      );
      assert.equal(new URL(launchUrl).hostname, '127.0.0.1');
      assert.equal(stdout.includes(new URL(launchUrl).hash.slice(1)), false);
      try {
        await waitForEvaluation(
          client,
          `(() => {
            const runtime = globalThis.Scratch?.vm?.runtime;
            const stage = runtime?.getTargetForStage?.();
            return /^Menu(?:Runtime)?$/.test(
              stage?.getCostumes?.()[stage.currentCostume]?.name ?? '',
            );
          })()`,
          'external-source story completion menu',
        );
      } catch (error) {
        const page = await client.evaluate(`(() => {
          const runtime = globalThis.Scratch?.vm?.runtime;
          const stage = runtime?.getTargetForStage?.();
          return {
            costume: stage?.getCostumes?.()[stage.currentCostume]?.name,
            status: document.querySelector('#dsl4-preview-status')?.textContent,
            targets: runtime?.targets?.map((target) => ({name: target.getName?.(), visible: target.visible})),
          };
        })()`);
        throw new Error(
          `${error.message}\n${JSON.stringify({page, stderr, exceptions: client.exceptions})}`,
        );
      }
      assert.deepEqual(
        await client.evaluate(
          'globalThis.Scratch.vm.runtime.targets.map((target) => target.getName?.())',
        ),
        ['Stage'],
      );
      assert.deepEqual(client.exceptions, []);

      await client.send('Page.navigate', {url: 'about:blank'});
      const result = await commandPromise;
      assert.deepEqual(result, {exitCode: 0, reason: 'browser-disconnected'});
      assert.match(stdout, /browser disconnected/u);
      assert.equal(stderr, '');
      assert.equal(signalTarget.listenerCount('SIGINT'), 0);
      assert.equal(signalTarget.listenerCount('SIGTERM'), 0);
    } finally {
      signalTarget.emit('SIGTERM');
      await commandPromise.catch(() => {});
      client?.close();
      if (chrome) await stopChrome(chrome);
      await Promise.all([
        rm(profileDirectory, {recursive: true, force: true, maxRetries: 10, retryDelay: 100}),
        rm(projectDirectory, {recursive: true, force: true}),
      ]);
    }
  },
);

test(
  'runs actor, sound, pose, and camera capabilities within bounded browser-preview resources',
  {timeout: 60_000},
  async (testContext) => {
    const chromeExecutable = await resolveChromeExecutable();
    const profileDirectory = await mkdtemp(path.join(tmpdir(), 'dsl4-capability-chromium-'));
    const projectDirectory = await mkdtemp(path.join(tmpdir(), 'dsl4-capability-project-'));
    const sourceManifestPath = path.join(projectDirectory, 'project.source.json');
    const sourceFilename = 'capabilities.k4.yml';
    const sourcePath = path.join(projectDirectory, sourceFilename);
    const manifest = {formatVersion: 1, mode: 'external', sourceId: 'main', path: sourceFilename};
    const source = `kamishibai: '4.0'
assets:
  HeroSkin: costume:Hero
  Cue: sound
  Idle: sound
  Charge: sound
  RescuePose:
    kind: poseModel
    file: pose-models/rescue
actors:
  Hero: HeroSkin
poseRecognition:
  idleSound: Idle
  chargeSound: Charge
  sequence:
    confidenceThreshold: 0.5
    fullConfidenceHoldSeconds: 0.01
    idleChargePerSecond: 0
  navigation:
    allowSkip: true
controls:
  keymaps:
    production:
      Space: rehearsal.skipPose
      ArrowRight: rehearsal.skipAction
      ArrowDown: rehearsal.skipScene
scenes:
  opening:
    poseModel: RescuePose
    actions:
      - Hero.show:
          skin: HeroSkin
          x: 15
          y: -20
          scale: 45
      - sound: Cue
      - Hero.pose:
          steps:
            - pose: help
            - pose: help
      - wait: 60
      - bgm: Cue
      - transition: {effect: fadeOut, seconds: 30}
      - Hero.hide: {}
  ending:
    - wait: 60
`;
    await Promise.all([
      writeFile(sourceManifestPath, `${JSON.stringify(manifest)}\n`),
      writeFile(sourcePath, source),
    ]);
    const schema = JSON.parse(
      await readFile(path.join(repositoryRoot, 'schema', 'dsl-4.schema.json'), 'utf8'),
    );
    const sourceFrontend = createDsl4ProductionSourceFrontend(schema);
    const limits = {maxSourceBytes: 64 * 1024, maxAssetFiles: 64, maxAssetBytes: 64 * 1024 * 1024};
    const parsed = sourceFrontend.parse(source, {sourceId: 'main'});
    assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics));
    const sourceDescriptor = await createDsl4EmbeddedSourceDescriptor(source, {
      sourceId: 'main',
      displayName: sourceFilename,
      maxSourceBytes: limits.maxSourceBytes,
      subtleCrypto: webcrypto.subtle,
    });
    const artifact = await createDsl4RuntimeArtifactDescriptor(
      parsed.storyDocument,
      sourceDescriptor,
      'production',
      {maxSourceBytes: limits.maxSourceBytes, subtleCrypto: webcrypto.subtle},
    );
    assert.equal(artifact.ok, true, JSON.stringify(artifact.diagnostics));
    const poseFiles = new Map([
      [
        'model.json',
        strToU8(
          JSON.stringify({
            modelTopology: {},
            weightsManifest: [{paths: ['weights.bin'], weights: []}],
          }),
        ),
      ],
      ['metadata.json', strToU8(JSON.stringify({labels: ['help']}))],
      ['weights.bin', new Uint8Array([1])],
    ]);
    const poseSourceFiles = [...poseFiles]
      .map(([filePath, bytes]) => ({
        path: filePath,
        size: bytes.byteLength,
        integrity: `sha256-${createHash('sha256').update(bytes).digest('base64')}`,
      }))
      .sort((left, right) => left.path.localeCompare(right.path));
    const snapshotAssets = Object.values(parsed.storyDocument.assets)
      .map((asset) => ({
        id: asset.id,
        kind: asset.kind,
        loading: asset.loading,
        ...(typeof asset.target === 'string' ? {target: asset.target} : {}),
        source:
          asset.kind === 'poseModel'
            ? {
                type: 'file',
                inputPath: asset.file,
                mode: 'directory',
                files: poseSourceFiles,
              }
            : {type: 'project', name: asset.name},
      }))
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    const assets = await createDsl4EmbeddedAssetBundle(
      parsed.storyDocument,
      {
        manifest: {formatVersion: 1, assets: snapshotAssets},
        getFile(assetId, filePath) {
          assert.equal(assetId, 'RescuePose');
          return new Uint8Array(poseFiles.get(filePath));
        },
      },
      {
        maxFiles: limits.maxAssetFiles,
        maxTotalBytes: limits.maxAssetBytes,
        subtleCrypto: webcrypto.subtle,
      },
    );
    const backdropAssetId = '00000000000000000000000000000000';
    const heroAssetId = '11111111111111111111111111111111';
    const soundAssetId = '22222222222222222222222222222222';
    const backdropFilename = `${backdropAssetId}.svg`;
    const heroFilename = `${heroAssetId}.svg`;
    const soundFilename = `${soundAssetId}.wav`;
    const soundBytes = await readFile(
      path.join(repositoryRoot, 'test', 'fixtures', 'assets', 'actor-pop.wav'),
    );
    const sounds = ['Cue', 'Idle', 'Charge'].map((name) => ({
      name,
      assetId: soundAssetId,
      dataFormat: 'wav',
      format: '',
      rate: 44_100,
      sampleCount: 1,
      md5ext: soundFilename,
    }));
    const project = await installDsl4PackagedRuntimeComponent(
      {
        extensionStorage: {},
        targets: [
          {
            isStage: true,
            name: 'Stage',
            variables: createPoseFeedbackVariables(),
            lists: {},
            broadcasts: {},
            blocks: {},
            comments: {},
            currentCostume: 0,
            costumes: [
              {
                name: 'backdrop1',
                assetId: backdropAssetId,
                dataFormat: 'svg',
                md5ext: backdropFilename,
                rotationCenterX: 240,
                rotationCenterY: 180,
              },
            ],
            sounds,
            volume: 100,
            layerOrder: 0,
            tempo: 60,
            videoTransparency: 50,
            videoState: 'on',
            textToSpeechLanguage: null,
          },
          {
            isStage: false,
            name: 'Hero',
            variables: {'actor-name': ['actorName', 'Hero']},
            lists: {},
            broadcasts: {},
            blocks: {},
            comments: {},
            currentCostume: 0,
            costumes: [
              {
                name: 'HeroSkin',
                assetId: heroAssetId,
                dataFormat: 'svg',
                md5ext: heroFilename,
                rotationCenterX: 40,
                rotationCenterY: 40,
              },
            ],
            sounds: [],
            volume: 100,
            layerOrder: 1,
            visible: false,
            x: 0,
            y: 0,
            size: 100,
            direction: 90,
            draggable: false,
            rotationStyle: 'all around',
          },
        ],
        monitors: createPoseFeedbackMonitors(),
        extensions: [],
        meta: {semver: '3.0.0'},
      },
      parsed.storyDocument,
      sourceDescriptor,
      artifact.artifact,
      assets,
      {channel: 'unbundled', ...limits, subtleCrypto: webcrypto.subtle},
    );
    const projectBytes = new Uint8Array(
      zipSync({
        'project.json': strToU8(`${JSON.stringify(project)}\n`),
        [backdropFilename]: strToU8(
          '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360"></svg>',
        ),
        [heroFilename]: strToU8(
          '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#7c3aed"/></svg>',
        ),
        [soundFilename]: soundBytes,
      }),
    );
    const browserBundleBytes = await buildDsl4TurboWarpBrowserBundle({
      entryPoint: path.join(
        repositoryRoot,
        'test',
        'fixtures',
        'dsl4',
        'local-preview-capability-entry.mjs',
      ),
    });
    const hostErrors = [];
    const host = createDsl4LocalPreviewHost({
      projectRoot: projectDirectory,
      sourceManifestPath,
      sourceManifest: manifest,
      sourceFrontend,
      maxSourceBytes: limits.maxSourceBytes,
      runtimeOwner: 'browser',
      projectBytes,
      browserBundleBytes,
      onError: (error) => hostErrors.push(String(error?.stack ?? error)),
    });
    await host.start();
    const url = host.getLaunchUrl();
    const startedAt = Date.now();
    const chrome = spawn(
      chromeExecutable,
      [
        '--headless=new',
        '--autoplay-policy=no-user-gesture-required',
        '--disable-background-networking',
        '--disable-dev-shm-usage',
        '--enable-precise-memory-info',
        '--use-angle=swiftshader',
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
          "globalThis.dsl4LocalPreviewCapabilityFixture?.events.some(({type, actionPath}) => type === 'action.start' && actionPath === '/scenes/opening/actions/2') && globalThis.dsl4LocalPreviewCapabilityFixture?.metrics.predictions > 0",
          'browser-owned first pose step',
        );
        assert.equal(
          await client.evaluate(
            "document.querySelector('canvas')?.focus(); document.activeElement?.tagName",
          ),
          'CANVAS',
        );
        assert.deepEqual(
          await client.evaluate(`(() => {
            const preview = [...document.querySelectorAll('canvas')]
              .find((canvas) => canvas.width === 320 && canvas.height === 240);
            return preview ? {
              display: preview.style.display,
              left: preview.style.left,
              right: preview.style.right,
              top: preview.style.top,
              bottom: preview.style.bottom,
              width: preview.style.width,
              height: preview.style.height,
              objectFit: preview.style.objectFit,
              borderRadius: preview.style.borderRadius,
              opacity: preview.style.opacity
            } : null;
          })()`),
          {
            display: 'block',
            left: '0px',
            right: '',
            top: '0px',
            bottom: '',
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            borderRadius: '0px',
            opacity: '0.2',
          },
          'The active pose preview must cover the complete stage.',
        );
        const hiddenBeforeFirstSkip = await client.evaluate(
          "globalThis.dsl4LocalPreviewCapabilityFixture.metrics.previewVisibilityChanges.filter((display) => display === 'none').length",
        );
        assert.equal(hiddenBeforeFirstSkip, 1, 'Story camera startup must keep preview hidden.');
        await pressKey(client, {key: ' ', code: 'Space', windowsVirtualKeyCode: 32});
        await waitForEvaluation(
          client,
          "globalThis.dsl4LocalPreviewCapabilityFixture?.events.filter(({type}) => type === 'pose.step.skip').length === 1",
          'browser-owned pose-step rehearsal skip',
        );
        assert.equal(
          await client.evaluate(
            "globalThis.dsl4LocalPreviewCapabilityFixture.metrics.previewVisibilityChanges.filter((display) => display === 'none').length",
          ),
          hiddenBeforeFirstSkip,
          'The camera preview must remain visible between pose steps.',
        );
        await pressKey(client, {
          key: 'ArrowRight',
          code: 'ArrowRight',
          windowsVirtualKeyCode: 39,
        });
        await waitForEvaluation(
          client,
          "globalThis.dsl4LocalPreviewCapabilityFixture?.events.some(({type, actionPath}) => type === 'action.start' && actionPath === '/scenes/opening/actions/3')",
          'browser-owned action rehearsal skip',
        );
        await pressKey(client, {
          key: 'ArrowDown',
          code: 'ArrowDown',
          windowsVirtualKeyCode: 40,
        });
        await waitForEvaluation(
          client,
          "globalThis.dsl4LocalPreviewCapabilityFixture?.events.some(({type, actionPath}) => type === 'action.start' && actionPath === '/scenes/ending/actions/0')",
          'browser-owned scene rehearsal skip',
        );
        await pressKey(client, {
          key: 'ArrowRight',
          code: 'ArrowRight',
          windowsVirtualKeyCode: 39,
        });
        await waitForEvaluation(
          client,
          "globalThis.dsl4LocalPreviewCapabilityFixture?.events.some(({type}) => type === 'runtime.finish')",
          'browser-owned representative capability fixture completion',
        );
        await waitForEvaluation(
          client,
          `(() => {
            const menu = document.querySelector('[data-dsl4-application-menu="true"]');
            const buttons = [...(menu?.querySelectorAll('[data-dsl4-menu-action]') ?? [])];
            return document.querySelectorAll('[data-dsl4-application-menu="true"]').length === 1 &&
              menu?.style.display === 'block' &&
              buttons.length === 4 &&
              buttons.every((button) => getComputedStyle(button).cursor === 'pointer') &&
              buttons.every((button) => button.querySelector('img')?.src.startsWith('data:image/svg+xml;base64,'));
          })()`,
          'interactive browser-owned application menu',
        );
        const initialMenuLocale = await client.evaluate(`(() => {
          const open = document.querySelector('[data-dsl4-menu-action="open"]')?.textContent;
          return open === 'ファイルを開く' ? 'ja' : 'en';
        })()`);
        const openClick = await client.evaluate(`(() => {
          document.querySelector('[data-dsl4-menu-action="open"]').click();
          return globalThis.dsl4LocalPreviewCapabilityFixture.applicationOpenRequests;
        })()`);
        assert.equal(openClick, 1);
        const languageClick = await client.evaluate(`(() => {
          const button = document.querySelector('[data-dsl4-menu-action="language"]');
          let observed = false;
          button.addEventListener('click', () => { observed = true; }, {once: true});
          button.click();
          return {
            disabled: button.disabled,
            observed,
            text: button.textContent
          };
        })()`);
        const toggledLocale = initialMenuLocale === 'ja' ? 'en' : 'ja';
        assert.deepEqual(languageClick, {
          disabled: false,
          observed: true,
          text: toggledLocale === 'ja' ? '言語' : 'Language',
        });
        await waitForEvaluation(
          client,
          `(() => {
            return document.querySelector('[data-dsl4-menu-action="open"]')?.textContent === ${JSON.stringify(
              initialMenuLocale === 'ja' ? 'Open' : 'ファイルを開く',
            )};
          })()`,
          'browser-owned toggled application-menu locale',
        );
        await client.evaluate(`document.querySelector('[data-dsl4-menu-action="about"]').click()`);
        await waitForEvaluation(
          client,
          `(() => {
            return document.querySelector('[data-dsl4-application-menu="true"]')?.style.display === 'none' &&
              document.querySelector('[data-dsl4-title-controls="true"]')?.style.display === 'block';
          })()`,
          'browser-owned application information title',
        );
        await client.evaluate(`document.querySelector('[data-dsl4-title-action="close"]').click()`);
        await waitForEvaluation(
          client,
          `document.querySelector('[data-dsl4-application-menu="true"]')?.style.display === 'block' &&
            document.querySelector('[data-dsl4-title-controls="true"]')?.style.display === 'none'`,
          'browser-owned return from application information',
        );
        await client.evaluate(
          `document.querySelector('[data-dsl4-menu-action="language"]').click()`,
        );
        await waitForEvaluation(
          client,
          `(() => {
            return document.querySelector('[data-dsl4-menu-action="open"]')?.textContent === ${JSON.stringify(
              initialMenuLocale === 'ja' ? 'ファイルを開く' : 'Open',
            )};
          })()`,
          'browser-owned restored application-menu locale',
        );
      } catch (error) {
        const page = await client.evaluate(`({
          body: document.body.textContent,
          fixture: globalThis.dsl4LocalPreviewCapabilityFixture,
          applicationMenu: (() => {
            const button = document.querySelector('[data-dsl4-menu-action="language"]');
            const rect = button?.getBoundingClientRect();
            const hit = rect && document.elementFromPoint(
              rect.left + rect.width / 2,
              rect.top + rect.height / 2
            );
            return {
              button: rect ? {left: rect.left, top: rect.top, width: rect.width, height: rect.height} : null,
              display: document.querySelector('[data-dsl4-application-menu="true"]')?.style.display,
              hitAction: hit?.closest?.('[data-dsl4-menu-action]')?.dataset.dsl4MenuAction ?? null,
              hitTag: hit?.tagName ?? null
            };
          })(),
          scratch: globalThis.Scratch?.vm?.runtime?.targets?.map((target) => ({name: target.getName?.(), visible: target.visible}))
        })`);
        throw new Error(
          `${error.message}\n${JSON.stringify({page, host: host.getSnapshot(), hostErrors, exceptions: client.exceptions})}`,
        );
      }
      const startupMilliseconds = Date.now() - startedAt;
      testContext.diagnostic(`representative capability startup: ${startupMilliseconds}ms`);
      assert.ok(startupMilliseconds <= 20_000, `startup took ${startupMilliseconds}ms`);
      const observed = await client.evaluate(`(() => {
        const fixture = globalThis.dsl4LocalPreviewCapabilityFixture;
        const actor = globalThis.Scratch.vm.runtime.targets.find((target) =>
          target.lookupVariableByNameAndType?.('actorName', '')?.value === 'Hero'
        );
        return {
          actor: {
            costume: actor.getCostumes()[actor.currentCostume].name,
            size: actor.size,
            visible: actor.visible,
            x: actor.x,
            y: actor.y
          },
          actionCommits: fixture.events
            .filter(({type}) => type === 'action.commit')
            .map(({actionPath}) => actionPath),
          canvasCount: document.querySelectorAll('canvas').length,
          errors: fixture.errors,
          metrics: fixture.metrics,
          started: fixture.started
        };
      })()`);
      assert.deepEqual(observed.actor, {
        costume: 'HeroSkin',
        size: 45,
        visible: false,
        x: 15,
        y: -20,
      });
      assert.deepEqual(observed.actionCommits, [
        '/scenes/opening/actions/0',
        '/scenes/opening/actions/1',
        '/scenes/opening/actions/4',
        '/scenes/opening/actions/5',
      ]);
      const rehearsalEvents = await client.evaluate(`
        globalThis.dsl4LocalPreviewCapabilityFixture.events
          .filter(({type}) => type === 'pose.step.skip' || type === 'action.cancel' || type === 'action.skip')
          .map(({type, actionPath, details}) => ({type, actionPath, reason: details.reason}))
      `);
      assert.deepEqual(rehearsalEvents, [
        {
          type: 'pose.step.skip',
          actionPath: '/scenes/opening/actions/2',
          reason: 'rehearsal.skipPose',
        },
        {
          type: 'action.cancel',
          actionPath: '/scenes/opening/actions/2',
          reason: 'rehearsal.skipAction',
        },
        {
          type: 'action.cancel',
          actionPath: '/scenes/opening/actions/3',
          reason: 'rehearsal.skipScene',
        },
        {
          type: 'action.skip',
          actionPath: '/scenes/opening/actions/6',
          reason: 'rehearsal.skipScene',
        },
        {
          type: 'action.cancel',
          actionPath: '/scenes/ending/actions/0',
          reason: 'rehearsal.skipAction',
        },
      ]);
      assert.equal(observed.started, true);
      assert.equal(host.getSnapshot().browserRuntimeReady, true);
      assert.equal(observed.metrics.cameraStarts, 1);
      assert.equal(observed.metrics.modelLoads, 1);
      assert.ok(observed.metrics.predictions >= 1);
      assert.ok(observed.metrics.webcamUpdates >= 1);
      assert.deepEqual(observed.metrics.previewVisibilityChanges, ['none', 'block', 'none']);
      assert.equal(observed.canvasCount, 1);
      assert.deepEqual(observed.errors, []);

      await client.send('HeapProfiler.enable');
      await client.send('HeapProfiler.collectGarbage');
      const usedHeapBytes = await client.evaluate('performance.memory.usedJSHeapSize');
      testContext.diagnostic(`representative capability heap after GC: ${usedHeapBytes} bytes`);
      assert.ok(usedHeapBytes <= 192 * 1024 * 1024, `heap used ${usedHeapBytes} bytes`);

      await client.evaluate(`document.querySelector('[data-dsl4-menu-action="reload"]').click()`);
      await waitForEvaluation(
        client,
        `globalThis.dsl4LocalPreviewCapabilityFixture.events
          .filter(({type}) => type === 'runtime.start').length === 2 &&
          document.querySelector('[data-dsl4-application-menu="true"]')?.style.display === 'none'`,
        'browser-owned menu replay',
      );

      const disposed = await client.evaluate(`(async () => {
        const fixture = globalThis.dsl4LocalPreviewCapabilityFixture;
        await fixture.client.dispose();
        return {
          canvasCount: document.querySelectorAll('canvas').length,
          hasScratch: Object.hasOwn(globalThis, 'Scratch'),
          metrics: fixture.metrics,
          status: fixture.client.getState().status
        };
      })()`);
      assert.equal(disposed.status, 'disposed');
      assert.equal(disposed.canvasCount, 0);
      assert.equal(disposed.hasScratch, false);
      assert.equal(disposed.metrics.cameraTrackStops, disposed.metrics.cameraStarts);
      assert.equal(disposed.metrics.classifierDisposals, disposed.metrics.modelLoads);
      assert.equal(disposed.metrics.poseNetDisposals, disposed.metrics.modelLoads);
      await waitForEvaluation(
        client,
        'document.querySelectorAll("canvas").length === 0',
        'capability fixture canvas cleanup',
      );
      const disconnectDeadline = Date.now() + 10_000;
      while (Date.now() < disconnectDeadline && host.getSnapshot().status !== 'listening') {
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      assert.equal(host.getSnapshot().status, 'listening');
      assert.equal(host.getSnapshot().browserRuntimeReady, false);
      assert.deepEqual(hostErrors, []);
      assert.deepEqual(client.exceptions, []);
    } finally {
      client?.close();
      await stopChrome(chrome);
      await host.dispose();
      await Promise.all([
        rm(profileDirectory, {recursive: true, force: true, maxRetries: 10, retryDelay: 100}),
        rm(projectDirectory, {recursive: true, force: true}),
      ]);
    }
  },
);
