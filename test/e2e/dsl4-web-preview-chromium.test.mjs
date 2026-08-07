import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {access, mkdtemp, readFile, rm, stat} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

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

async function startFixtureServer() {
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
      const file = path.resolve(repositoryRoot, `.${pathname}`);
      if (!file.startsWith(`${repositoryRoot}${path.sep}`) || !(await stat(file)).isFile()) {
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
    url: `http://127.0.0.1:${address.port}/test/fixtures/dsl4/web-preview-browser.html`,
  };
}

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
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const targets = await fetch(listUrl).then((response) => response.json());
      const page = targets.find((target) => target.type === 'page' && target.url === fixtureUrl);
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
        this.exceptions.push(message.params.exceptionDetails.text);
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

async function stopChrome(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
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

      await client.send('Emulation.setDeviceMetricsOverride', {
        width: 520,
        height: 360,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await waitForEvaluation(
        client,
        'globalThis.webPreviewFixture.shell.getSnapshot().reloadOverlay.overlay.layout.viewport.width === 520',
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
      await rm(profileDirectory, {recursive: true, force: true});
    }
  },
);
