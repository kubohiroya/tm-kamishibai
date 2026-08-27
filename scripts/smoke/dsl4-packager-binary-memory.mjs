import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {access, mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

import {createDeterministicSb3, importSb3} from '@kubohiroya/sb3-toolchain';
import {strFromU8, unzipSync} from 'fflate';

import {createKamishibaiSb3} from '../sb3/build.mjs';
import {createDsl4ReleaseSourceFiles} from '../sb3/dsl4-downloadable-release.mjs';
import {
  createDsl4ProductionSourceFrontend,
  dsl4PackagerCompatibility,
  packageDsl4WithTurboWarpPackager,
} from '../../src/builder/index.js';
import {loadDsl4BinaryEntryRuntimeComponent} from '../../src/dsl4/runtime-artifact-loader.js';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const defaultSamplesRoot = path.resolve(repositoryRoot, '../tm-kamishibai-samples');
const runtimeLimits = Object.freeze({
  maxSourceBytes: 1024 * 1024,
  maxAssetFileBytes: 8 * 1024 * 1024,
  maxAssetFiles: 128,
  maxAssetBytes: 64 * 1024 * 1024,
});
const packagerLimits = Object.freeze({
  maxArchiveBytes: 1024 * 1024 * 1024,
  maxArchiveEntries: 16_384,
  maxArchiveEntryBytes: 512 * 1024 * 1024,
  maxArchiveExpandedBytes: 1024 * 1024 * 1024,
  ...runtimeLimits,
  maxCompressionRatio: 200,
});
const targetNames = new Set([
  'html',
  'zip',
  'zip-one-asset',
  'electron-linux64',
  'electron-macos',
  'electron-win32',
]);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseArguments(arguments_) {
  let samplesRoot = defaultSamplesRoot;
  let outputDirectory = null;
  let measureBrowser = false;
  const targets = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--samples-root') {
      samplesRoot = path.resolve(arguments_[++index] ?? '');
    } else if (argument === '--output-directory') {
      outputDirectory = path.resolve(arguments_[++index] ?? '');
    } else if (argument === '--target') {
      const target = arguments_[++index] ?? '';
      if (!targetNames.has(target)) throw new Error(`Unsupported Packager target: ${target}`);
      targets.push(target);
    } else if (argument === '--measure-browser') {
      measureBrowser = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!outputDirectory) throw new Error('--output-directory is required');
  const selectedTargets =
    targets.length > 0 ? [...new Set(targets)] : ['html', 'zip', 'zip-one-asset'];
  if (measureBrowser && (!selectedTargets.includes('html') || !selectedTargets.includes('zip'))) {
    throw new Error('--measure-browser requires both --target html and --target zip');
  }
  return {
    measureBrowser,
    outputDirectory,
    samplesRoot,
    targets: selectedTargets,
  };
}

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {encoding: 'utf8', ...options});
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Command failed (${result.status}): ${command} ${arguments_.join(' ')}\n${result.stdout}${result.stderr}`,
    );
  }
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

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
  throw new Error('Browser measurement requires Chrome or Chromium; set CHROME_BIN');
}

function contentType(filename) {
  return (
    {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
    }[path.extname(filename)] ?? 'application/octet-stream'
  );
}

async function startArtifactServer(root) {
  const requests = [];
  const server = createServer(async (request, response) => {
    try {
      const requested = new URL(request.url ?? '/', 'http://localhost');
      const pathname = decodeURIComponent(requested.pathname);
      const filename = path.resolve(root, `.${pathname}`);
      if (
        !filename.startsWith(`${path.resolve(root)}${path.sep}`) ||
        !(await stat(filename)).isFile()
      ) {
        response.writeHead(404).end('Not found');
        return;
      }
      requests.push(pathname);
      let body = await readFile(filename);
      if (requested.searchParams.get('indexeddb') === 'disabled' && filename.endsWith('.html')) {
        const html = body.toString('utf8');
        body = Buffer.from(
          html.replace(
            '<head>',
            '<head><script>Object.defineProperty(globalThis, "indexedDB", {configurable: true, value: undefined});</script>',
          ),
        );
      }
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': contentType(filename),
      });
      response.end(body);
    } catch {
      response.writeHead(404).end('Not found');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Artifact server did not bind TCP');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
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

async function waitForPageTarget(browserWebSocketUrl) {
  const endpoint = new URL(browserWebSocketUrl);
  const listUrl = `http://${endpoint.host}/json/list`;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const targets = await fetch(listUrl).then((response) => response.json());
      const page = targets.find((target) => target.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      // Chrome may publish the browser endpoint before its first page target.
    }
    await sleep(50);
  }
  throw new Error('Chrome did not expose a page target');
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.exceptions = [];
    this.networkUrls = new Set();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.method === 'Runtime.exceptionThrown') {
        this.exceptions.push(
          message.params.exceptionDetails.exception?.description ??
            message.params.exceptionDetails.text,
        );
      }
      if (message.method === 'Network.requestWillBeSent') {
        this.networkUrls.add(message.params.request.url);
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

function waitForExit(child, timeoutMilliseconds) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (exited) => {
      clearTimeout(timeout);
      child.off('exit', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timeout = setTimeout(() => finish(false), timeoutMilliseconds);
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

const runtimeDiagnosticsExpression = `(() => {
  const runtime = globalThis.vm?.runtime;
  if (!runtime?._primitives) return null;
  const key = Object.keys(runtime._primitives).find((name) => name.endsWith('_runtimeDiagnosticsReporter'));
  if (!key) return null;
  const value = runtime._primitives[key]({}, {runtime, target: runtime.getTargetForStage?.()});
  return typeof value === 'string' ? JSON.parse(value) : value;
})()`;

async function collectStartupMeasurement(client, expectedMode) {
  const startedAt = Date.now();
  const deadline = startedAt + 120_000;
  let startupPeakBytes = 0;
  let diagnostics = null;
  while (Date.now() < deadline) {
    try {
      const sample = await client.evaluate(`({
        heap: performance.memory?.usedJSHeapSize ?? 0,
        diagnostics: ${runtimeDiagnosticsExpression},
        errorMessage: document.querySelector('#error-message')?.textContent?.trim() ?? '',
        errorStack: document.querySelector('#error-stack')?.textContent?.trim() ?? '',
        readyState: document.readyState
      })`);
      startupPeakBytes = Math.max(startupPeakBytes, Number(sample.heap) || 0);
      diagnostics = sample.diagnostics;
      if (sample.errorMessage) {
        throw new Error(
          `Packager startup failed (${sample.readyState}): ${sample.errorMessage}\n${sample.errorStack}`,
        );
      }
      if (diagnostics?.status === 'title' && diagnostics.backing?.state === 'ready') break;
    } catch (error) {
      // Navigation replaces the execution context while the first samples are collected.
      if (String(error).includes('Packager startup failed')) throw error;
    }
    await sleep(25);
  }
  assert.equal(
    diagnostics?.status,
    'title',
    JSON.stringify({diagnostics, exceptions: client.exceptions}),
  );
  assert.equal(diagnostics.backing.mode, expectedMode, JSON.stringify(diagnostics));
  await client.send('HeapProfiler.enable');
  await client.send('HeapProfiler.collectGarbage');
  const titleHeapAfterGcBytes = await client.evaluate('performance.memory?.usedJSHeapSize ?? 0');
  return {
    diagnostics,
    startupMilliseconds: Date.now() - startedAt,
    startupPeakBytes,
    titleHeapAfterGcBytes,
  };
}

async function clickStage(client) {
  const point = await client.evaluate(`(() => {
    const canvas = document.querySelector('.sc-canvas');
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return {x: rect.left + Math.min(24, rect.width / 4), y: rect.top + rect.height / 2};
  })()`);
  assert.ok(point, 'Packager stage canvas is unavailable');
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

async function pressKey(client, key, code, keyCode) {
  const parameters = {
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
  };
  await client.send('Input.dispatchKeyEvent', {type: 'keyDown', ...parameters});
  await client.send('Input.dispatchKeyEvent', {type: 'keyUp', ...parameters});
}

async function waitForRuntimeCondition(client, predicate, label, timeoutMilliseconds = 30_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const diagnostics = await client.evaluate(runtimeDiagnosticsExpression);
    if (diagnostics && predicate(diagnostics)) return diagnostics;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function poseFeedbackIsVisible(client) {
  return client.evaluate(`(() => {
    const text = [...document.querySelectorAll('.sc-monitor-root')]
      .filter((element) => getComputedStyle(element).display !== 'none')
      .map((element) => element.textContent ?? '')
      .join('\\n');
    return text.includes('ポーズ認識') && text.includes('チャージ');
  })()`);
}

async function advanceToPose(client, poseLocation) {
  await clickStage(client);
  await waitForRuntimeCondition(
    client,
    (diagnostics) => diagnostics.runtime?.status === 'running',
    'story start',
  );
  await pressKey(client, 'ArrowDown', 'ArrowDown', 40);
  await sleep(250);
  let diagnostics = null;
  for (let index = 0; index < 48; index += 1) {
    diagnostics = await client.evaluate(runtimeDiagnosticsExpression);
    if (
      diagnostics?.runtime?.sceneId === poseLocation.sceneId &&
      diagnostics?.runtime?.actionIndex === poseLocation.actionIndex
    ) {
      break;
    }
    await pressKey(client, 'ArrowRight', 'ArrowRight', 39);
    await sleep(150);
  }
  diagnostics = await waitForRuntimeCondition(
    client,
    (candidate) =>
      candidate.resources?.activePoseModelCount === 1 &&
      candidate.resources?.registeredPoseModelCount >= 1 &&
      candidate.runtime?.sceneId === poseLocation.sceneId &&
      candidate.runtime?.actionIndex === poseLocation.actionIndex,
    'active pose action',
    60_000,
  );
  const feedbackDeadline = Date.now() + 10_000;
  let monitorsVisible = false;
  while (!monitorsVisible && Date.now() < feedbackDeadline) {
    monitorsVisible = await poseFeedbackIsVisible(client);
    if (!monitorsVisible) await sleep(50);
  }
  assert.equal(monitorsVisible, true, JSON.stringify(diagnostics));
  await client.send('HeapProfiler.collectGarbage');
  const poseHeapAfterGcBytes = await client.evaluate('performance.memory?.usedJSHeapSize ?? 0');
  return {diagnostics, monitorsVisible, poseHeapAfterGcBytes};
}

async function measurePackagerBrowserScenario({
  chromeExecutable,
  profileDirectory,
  url,
  expectedMode,
  label,
  poseLocation,
}) {
  const chrome = spawn(
    chromeExecutable,
    [
      '--headless=new',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-networking',
      '--disable-dev-shm-usage',
      '--enable-precise-memory-info',
      '--host-resolver-rules=MAP * 127.0.0.1, EXCLUDE 127.0.0.1',
      '--no-first-run',
      '--no-sandbox',
      '--remote-debugging-port=0',
      '--use-angle=swiftshader',
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--user-data-dir=${profileDirectory}`,
      'about:blank',
    ],
    {stdio: ['ignore', 'pipe', 'pipe']},
  );
  let client = null;
  try {
    const browserWebSocketUrl = await waitForDevTools(chrome);
    const pageWebSocketUrl = await waitForPageTarget(browserWebSocketUrl);
    client = await CdpClient.connect(pageWebSocketUrl);
    await Promise.all([
      client.send('Page.enable'),
      client.send('Runtime.enable'),
      client.send('Network.enable'),
    ]);
    await client.send('Page.navigate', {url});
    const startup = await collectStartupMeasurement(client, expectedMode);
    const pose = await advanceToPose(client, poseLocation);
    const unexpectedNetworkUrls = [...client.networkUrls].filter((candidate) => {
      const parsed = new URL(candidate);
      return (
        parsed.protocol !== 'data:' &&
        parsed.protocol !== 'blob:' &&
        parsed.origin !== new URL(url).origin
      );
    });
    assert.deepEqual(unexpectedNetworkUrls, [], JSON.stringify(unexpectedNetworkUrls));
    assert.deepEqual(client.exceptions, [], JSON.stringify(client.exceptions));
    return {
      label,
      backingMode: startup.diagnostics.backing.mode,
      providerRetained: startup.diagnostics.backing.providerRetained,
      warningCode: startup.diagnostics.backing.warning?.code ?? null,
      startupMilliseconds: startup.startupMilliseconds,
      startupPeakBytes: startup.startupPeakBytes,
      titleHeapAfterGcBytes: startup.titleHeapAfterGcBytes,
      poseHeapAfterGcBytes: pose.poseHeapAfterGcBytes,
      registeredPoseModelCount: pose.diagnostics.resources.registeredPoseModelCount,
      activePoseModelCount: pose.diagnostics.resources.activePoseModelCount,
      poseFeedbackVisible: pose.monitorsVisible,
      offlineNetworkEnforced: true,
      unexpectedNetworkUrls,
    };
  } finally {
    client?.close();
    await stopChrome(chrome);
  }
}

async function measurePackagerBrowserArtifacts(outputDirectory, poseLocation) {
  const chromeExecutable = await resolveChromeExecutable();
  const server = await startArtifactServer(outputDirectory);
  const measurements = [];
  try {
    const scenarios = [
      {
        expectedMode: 'session',
        label: 'plain-html-session',
        pathname: '/urashima-html.html',
      },
      {
        expectedMode: 'direct',
        label: 'plain-html-direct-fallback',
        pathname: '/urashima-html.html?indexeddb=disabled',
      },
      {
        expectedMode: 'direct',
        label: 'zip-direct',
        pathname: '/urashima-zip/index.html',
      },
    ];
    for (const scenario of scenarios) {
      const profileDirectory = await mkdtemp(path.join(tmpdir(), 'dsl4-packager-chromium-'));
      try {
        measurements.push(
          await measurePackagerBrowserScenario({
            chromeExecutable,
            expectedMode: scenario.expectedMode,
            label: scenario.label,
            poseLocation,
            profileDirectory,
            url: `${server.origin}${scenario.pathname}`,
          }),
        );
      } finally {
        await rm(profileDirectory, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        });
      }
    }
  } finally {
    await server.close();
  }
  return Object.freeze({
    chromeExecutable,
    measurements: Object.freeze(measurements),
    servedRequestCount: server.requests.length,
  });
}

async function writeArchiveDirectory(archive, directory) {
  for (const [name, bytes] of Object.entries(archive)) {
    if (name.endsWith('/')) continue;
    const output = path.resolve(directory, name);
    assert(
      output.startsWith(`${path.resolve(directory)}${path.sep}`),
      `Unsafe generated archive path: ${name}`,
    );
    await mkdir(path.dirname(output), {recursive: true});
    await writeFile(output, bytes);
  }
}

function verifyPackagedLogicalEntries(target, data, rootArchive, rootEntries) {
  if (target === 'html') {
    const html = Buffer.from(data).toString('utf8');
    assert.match(html, /dsl4-packager-entry-source v1/u);
    assert(rootEntries.every((entry) => html.includes(entry)));
    return {entrySourceMode: 'archive', logicalEntryCount: rootEntries.length};
  }
  const packagedArchive = unzipSync(data);
  if (target === 'zip-one-asset') {
    assert(packagedArchive['project.zip'] instanceof Uint8Array);
    const projectArchive = unzipSync(packagedArchive['project.zip']);
    for (const entry of rootEntries) {
      assert.deepEqual(projectArchive[entry], rootArchive[entry]);
    }
    const html = strFromU8(packagedArchive['index.html']);
    assert.match(html, /"surface":"zip-one-asset"/u);
    return {entrySourceMode: 'archive', logicalEntryCount: rootEntries.length};
  }
  const assetPrefix = target === 'zip' ? 'assets/' : 'packaged-project/resources/app/assets/';
  for (const entry of rootEntries) {
    assert.deepEqual(packagedArchive[`${assetPrefix}${entry}`], rootArchive[entry]);
  }
  const indexName = target === 'zip' ? 'index.html' : 'packaged-project/resources/app/index.html';
  const html = strFromU8(packagedArchive[indexName]);
  assert.match(html, new RegExp(`"surface":"${target === 'zip' ? 'zip' : 'electron'}"`, 'u'));
  return {entrySourceMode: 'direct', logicalEntryCount: rootEntries.length};
}

async function createRootEntryUrashima(samplesRoot, temporaryDirectory) {
  const storyDirectory = path.join(samplesRoot, 'stories/urashima');
  const basePath = path.join(temporaryDirectory, 'kamishibai-4.0-current.sb3');
  const actorBasePath = path.join(temporaryDirectory, 'urashima-actor-base.sb3');
  const rootEntryPath = path.join(temporaryDirectory, 'urashima-root-entry.sb3');
  const releaseSourceDirectory = path.join(temporaryDirectory, 'current-release-source');
  for (const [relativePath, contents] of await createDsl4ReleaseSourceFiles()) {
    const outputPath = path.join(releaseSourceDirectory, relativePath);
    await mkdir(path.dirname(outputPath), {recursive: true});
    await writeFile(outputPath, contents);
  }
  const release = await createKamishibaiSb3({
    sourceDirectory: releaseSourceDirectory,
    version: '4.0.0-rc.11',
    buildDate: '2026-08-16',
    faviconPath: path.join(repositoryRoot, 'site/favicon.png'),
  });
  await writeFile(basePath, release.archive);

  const baseSourceDirectory = path.join(temporaryDirectory, 'base-source');
  await importSb3({inputPath: basePath, outputDirectory: baseSourceDirectory});
  const actorBase = await createDeterministicSb3(baseSourceDirectory, {
    allowedAssetRoots: [storyDirectory],
    projectAssetsPath: path.join(storyDirectory, 'project-assets-dsl4.yml'),
  });
  await writeFile(actorBasePath, actorBase.archive);
  run(
    process.execPath,
    [
      path.join(repositoryRoot, 'bin/tm-kamishibai.mjs'),
      'build-dsl4',
      '--base',
      actorBasePath,
      '--project-root',
      storyDirectory,
      '--source-manifest',
      path.join(storyDirectory, 'project.source.json'),
      '--output',
      rootEntryPath,
      '--control-profile',
      'production',
      '--channel',
      'bundled',
      '--max-source-bytes',
      String(runtimeLimits.maxSourceBytes),
      '--max-asset-file-bytes',
      String(runtimeLimits.maxAssetFileBytes),
      '--max-asset-files',
      String(runtimeLimits.maxAssetFiles),
      '--max-total-asset-bytes',
      String(runtimeLimits.maxAssetBytes),
      '--enable-root-binary-entries',
      '--replace-existing',
    ],
    {cwd: repositoryRoot},
  );
  const bytes = await readFile(rootEntryPath);
  return {bytes, path: rootEntryPath};
}

function configurePackager(TurboWarpPackager, loadedProject, target) {
  const packager = new TurboWarpPackager.Packager();
  packager.project = loadedProject;
  packager.options.target = target;
  packager.options.autoplay = true;
  packager.options.cloudVariables.mode = 'disabled';
  packager.options.bakeExtensions = false;
  return packager;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const storyDirectory = path.join(options.samplesRoot, 'stories/urashima');
  const [schema, source] = await Promise.all([
    readFile(path.join(repositoryRoot, 'schema/dsl-4.schema.json'), 'utf8').then(JSON.parse),
    readFile(path.join(storyDirectory, 'urashima.k4.yml'), 'utf8'),
  ]);
  assert.match(source, /file:\s+pose-models\/1and2/u);
  assert.match(source, /file:\s+pose-models\/3and4/u);
  assert.match(source, /file:\s+pose-models\/6and7/u);
  await mkdir(options.outputDirectory, {recursive: true});
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'dsl4-packager-smoke-'));
  try {
    const rootEntry = await createRootEntryUrashima(options.samplesRoot, temporaryDirectory);
    const archive = unzipSync(rootEntry.bytes);
    const project = JSON.parse(strFromU8(archive['project.json']));
    const frontend = createDsl4ProductionSourceFrontend(schema);
    const component = await loadDsl4BinaryEntryRuntimeComponent(project, frontend, runtimeLimits);
    assert.equal(component.ok, true, JSON.stringify(component.diagnostics));
    const rootEntries = Object.keys(archive)
      .filter((name) => name.startsWith('k4asset-v1-'))
      .sort();
    assert(rootEntries.length > 0);
    assert(rootEntries.every((name) => !name.includes('/')));
    assert.equal(component.assetBundle.files.length, 55);
    for (const model of ['PoseModel1', 'PoseModel2', 'PoseModel3']) {
      assert.equal(component.assetBundle.files.filter(({assetId}) => assetId === model).length, 3);
    }
    const poseSceneId = 'beach';
    const poseActions = component.storyDocument.scenes?.find(
      (scene) => scene.id === poseSceneId,
    )?.actions;
    assert(Array.isArray(poseActions), `Missing ${poseSceneId} scene actions`);
    const poseActionIndex = poseActions.findIndex(
      (action) =>
        typeof action?.command === 'string' &&
        (action.command === 'pose' || action.command.endsWith('.pose')),
    );
    assert.notEqual(poseActionIndex, -1, `Missing pose action in ${poseSceneId}`);
    const poseLocation = Object.freeze({sceneId: poseSceneId, actionIndex: poseActionIndex});
    const rootOutput = path.join(options.outputDirectory, 'urashima-root-entry.sb3');
    await writeFile(rootOutput, rootEntry.bytes);

    const require = createRequire(import.meta.url);
    const TurboWarpPackager = require('@turbowarp/packager');
    const packagerPackage = require('@turbowarp/packager/package.json');
    assert.equal(packagerPackage.name, dsl4PackagerCompatibility.package);
    assert.equal(packagerPackage.version, dsl4PackagerCompatibility.version);
    const loadedProject = await TurboWarpPackager.loadProject(rootEntry.bytes);
    const artifacts = [];
    for (const target of options.targets) {
      const packager = configurePackager(TurboWarpPackager, loadedProject, target);
      const result = await packageDsl4WithTurboWarpPackager({
        packager,
        packagerPackage,
        storyDocument: component.storyDocument,
        descriptor: component.assetBundle,
        limits: packagerLimits,
      });
      const extension = result.type === 'text/html' ? '.html' : '.zip';
      const filename = `urashima-${target}${extension}`;
      const output = path.join(options.outputDirectory, filename);
      await writeFile(output, result.data);
      const logicalEntries = verifyPackagedLogicalEntries(
        target,
        result.data,
        archive,
        rootEntries,
      );
      if (target === 'zip') {
        await writeArchiveDirectory(
          unzipSync(result.data),
          path.join(options.outputDirectory, 'urashima-zip'),
        );
      }
      if (target === 'zip-one-asset') {
        await writeArchiveDirectory(
          unzipSync(result.data),
          path.join(options.outputDirectory, 'urashima-zip-one-asset'),
        );
      }
      artifacts.push({
        target,
        filename,
        ...logicalEntries,
        mediaType: result.type,
        size: result.data.byteLength,
        sha256: sha256(result.data),
      });
    }
    const browser = options.measureBrowser
      ? await measurePackagerBrowserArtifacts(options.outputDirectory, poseLocation)
      : null;
    const report = {
      formatVersion: 1,
      runtimeRevision: spawnSync('git', ['rev-parse', 'HEAD'], {
        cwd: repositoryRoot,
        encoding: 'utf8',
      }).stdout.trim(),
      runtimeWorkingTreeDirty:
        spawnSync('git', ['status', '--short'], {
          cwd: repositoryRoot,
          encoding: 'utf8',
        }).stdout.trim().length > 0,
      samplesCommit: spawnSync('git', ['rev-parse', 'HEAD'], {
        cwd: options.samplesRoot,
        encoding: 'utf8',
      }).stdout.trim(),
      rootEntrySb3: {
        filename: path.basename(rootOutput),
        size: rootEntry.bytes.byteLength,
        sha256: sha256(rootEntry.bytes),
        rootEntryCount: rootEntries.length,
        logicalFileCount: component.assetBundle.files.length,
        poseModels: 3,
        poseModelFiles: 9,
      },
      artifacts,
      browser,
    };
    const reportPath = path.join(options.outputDirectory, 'report.json');
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({...report, reportPath}, null, 2)}\n`);
  } finally {
    await rm(temporaryDirectory, {recursive: true, force: true});
  }
}

main().catch((error) => {
  console.error(error.stack ?? error);
  process.exitCode = 1;
});
