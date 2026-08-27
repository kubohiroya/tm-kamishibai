import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {webcrypto} from 'node:crypto';
import {access, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

import {strToU8, zipSync} from 'fflate';

import {buildDsl4RuntimeComponent} from '../../src/builder/dsl4-build.js';
import {sha256} from '../../src/builder/hash.js';
import {createDsl4SourceFrontend} from '../../src/dsl4/index.js';
import {buildDsl4TurboWarpBrowserBundle} from '../../src/builder/dsl4-turbowarp-browser-bundle.js';
import {readSb3} from '../../src/builder/sb3.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const schema = JSON.parse(
  await readFile(path.join(repositoryRoot, 'schema/dsl-4.schema.json'), 'utf8'),
);
const sourceFrontend = createDsl4SourceFrontend(schema);
const source = `kamishibai: '4.0'
assets:
  OpeningImage:
    kind: backdrop
    file: opening.svg
scenes:
  opening:
    - stage: OpeningImage
controls:
  keymaps:
    production:
      Space: navigation.nextAction
`;
const openingBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
const openingIntegrity = `sha256-${sha256(openingBytes)}`;
const chromeResultTimeoutMs = 60_000;

async function chromeExecutable() {
  const candidates = [
    process.env.CHROME_BIN,
    process.env.GOOGLE_CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'google-chrome',
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
    const result = spawnSync('which', [candidate], {encoding: 'utf8'});
    if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  }
  throw new Error('Offline browser smoke requires Chrome or Chromium');
}

function baseSb3() {
  return Buffer.from(
    zipSync({
      'project.json': strToU8(JSON.stringify({extensionStorage: {}, targets: [], monitors: []})),
    }),
  );
}

async function startServer(directory) {
  const server = createServer(async (request, response) => {
    try {
      const requested = path.resolve(
        directory,
        `.${new URL(request.url ?? '/', 'http://localhost').pathname}`,
      );
      if (!requested.startsWith(`${directory}${path.sep}`) || !(await stat(requested)).isFile()) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        'content-type': path.extname(requested) === '.js' ? 'text/javascript' : 'text/html',
      });
      response.end(await readFile(requested));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Offline smoke server did not bind');
  return {server, url: `http://127.0.0.1:${address.port}/index.html`};
}

async function runChrome(executable, url, profileDirectory) {
  const child = spawn(
    executable,
    [
      '--headless=new',
      '--disable-background-networking',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-sandbox',
      '--dump-dom',
      '--virtual-time-budget=5000',
      `--user-data-dir=${profileDirectory}`,
      url,
    ],
    {stdio: ['ignore', 'pipe', 'pipe']},
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
  child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(
        new Error(
          `Chrome did not produce the smoke result within ${chromeResultTimeoutMs}ms: stdout=${stdout.slice(-2000)} stderr=${stderr.slice(-4000)}`,
        ),
      );
    }, chromeResultTimeoutMs);
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      resolve(stdout);
    };
    child.stdout.on('data', () => {
      if (stdout.includes('dsl4-smoke-result:') || stdout.includes('dsl4-smoke-error:')) finish();
    });
    child.once('error', (error) => {
      if (!settled) {
        clearTimeout(timer);
        reject(error);
      }
    });
    child.once('exit', (code) => {
      if (!settled) {
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else reject(new Error(`Chrome exited with ${code}: ${stderr}`));
      }
    });
  });
}

test(
  'loads an offline asset-distribution SB3 in real Chromium without remote fetches',
  {timeout: 90_000},
  async () => {
    const executable = await chromeExecutable();
    const projectDirectory = await mkdtemp(path.join(tmpdir(), 'dsl4-asset-offline-project-'));
    const browserDirectory = await mkdtemp(path.join(tmpdir(), 'dsl4-asset-offline-browser-'));
    const profileDirectory = await mkdtemp(path.join(tmpdir(), 'dsl4-asset-offline-chrome-'));
    let server;
    try {
      await Promise.all([
        writeFile(path.join(projectDirectory, 'story.k4.yml'), source),
        writeFile(path.join(projectDirectory, 'opening.svg'), openingBytes),
      ]);
      const config = {
        formatVersion: 1,
        profiles: {offline: {network: 'forbidden', defaultDelivery: 'embedded'}},
        providers: {OpeningImage: {remote: {url: 'https://cdn.example.com/opening.svg'}}},
      };
      const lock = {
        formatVersion: 1,
        assets: {
          OpeningImage: {
            kind: 'backdrop',
            contentIntegrity: openingIntegrity,
            contentType: 'image/svg+xml',
            size: openingBytes.length,
            providers: {
              embedded: {file: 'opening.svg'},
              remote: {
                url: 'https://cdn.example.com/opening.svg',
                transportIntegrity: openingIntegrity,
                contentType: 'image/svg+xml',
                size: openingBytes.length,
              },
            },
          },
        },
      };
      const built = await buildDsl4RuntimeComponent({
        baseSb3Bytes: baseSb3(),
        projectRoot: projectDirectory,
        sourceManifest: {
          formatVersion: 1,
          mode: 'external',
          sourceId: 'main',
          path: 'story.k4.yml',
        },
        sourceFrontend,
        controlProfile: 'production',
        channel: 'bundled',
        maxSourceBytes: 16 * 1024,
        maxAssetFileBytes: 4096,
        maxAssetFiles: 8,
        maxTotalAssetBytes: 16 * 1024,
        assetConfig: await (async () => {
          const file = path.join(projectDirectory, 'assets.json');
          await writeFile(file, JSON.stringify(config));
          return file;
        })(),
        assetLock: await (async () => {
          const file = path.join(projectDirectory, 'assets.lock.json');
          await writeFile(file, JSON.stringify(lock));
          return file;
        })(),
        assetProfile: 'offline',
        maxAssetConfigBytes: 16 * 1024,
        maxAssetLockBytes: 16 * 1024,
        subtleCrypto: webcrypto.subtle,
      });
      const {project} = readSb3(built.bytes);
      const sourcePath = path.join(repositoryRoot, 'src/dsl4/source-frontend.js');
      const loaderPath = path.join(repositoryRoot, 'src/dsl4/runtime-artifact-loader.js');
      const entry = `import {createDsl4SourceFrontend} from ${JSON.stringify(sourcePath)};
import {loadDsl4RuntimeComponent} from ${JSON.stringify(loaderPath)};
const schema = ${JSON.stringify(schema)};
const project = ${JSON.stringify(project)};
const reportError = (error) => {
  const value = error instanceof Error ? {name: error.name, message: error.message, stack: error.stack} : error;
  document.body.textContent = 'dsl4-smoke-error:' + JSON.stringify(value);
};
globalThis.addEventListener('error', (event) => reportError(event.error ?? event.message));
globalThis.addEventListener('unhandledrejection', (event) => reportError(event.reason));
try {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = (...args) => { fetchCount += 1; return originalFetch(...args); };
  await Promise.race([
    new Promise((resolve) => {
      const request = indexedDB.deleteDatabase('tw-kamishibai-assets-v1--story--offline-smoke');
      request.onsuccess = request.onerror = request.onblocked = resolve;
    }),
    new Promise((resolve) => setTimeout(resolve, 250)),
  ]);
  const loaded = await loadDsl4RuntimeComponent(project, createDsl4SourceFrontend(schema), {maxSourceBytes: 16384, maxAssetFiles: 8, maxAssetBytes: 16384});
  const result = loaded.ok ? {ok: true, fetchCount, delivery: loaded.storyDocument.assets.OpeningImage.delivery, file: loaded.storyDocument.assets.OpeningImage.file, bytes: Array.from(loaded.getAssetFile('OpeningImage', 'opening.svg'))} : {ok: false, fetchCount, diagnostics: loaded.diagnostics};
  document.body.textContent = 'dsl4-smoke-result:' + JSON.stringify(result);
} catch (error) {
  reportError(error);
}
`;
      await writeFile(path.join(browserDirectory, 'entry.mjs'), entry);
      const browserBundle = await buildDsl4TurboWarpBrowserBundle({
        entryPoint: path.join(browserDirectory, 'entry.mjs'),
        minify: true,
      });
      await Promise.all([
        writeFile(path.join(browserDirectory, 'bundle.js'), browserBundle),
        writeFile(
          path.join(browserDirectory, 'index.html'),
          '<!doctype html><meta charset="utf-8"><body><script type="module" src="/bundle.js"></script>',
        ),
      ]);
      const started = await startServer(browserDirectory);
      server = started.server;
      const serverUrl = started.url;
      const dom = await runChrome(executable, serverUrl, profileDirectory);
      const body = dom.match(/<body>([\s\S]*?)<\/body>/u)?.[1] ?? '';
      const result = JSON.parse(body.replace(/^dsl4-smoke-result:/u, ''));
      assert.deepEqual(result, {
        ok: true,
        fetchCount: 0,
        delivery: 'embedded',
        file: 'opening.svg',
        bytes: [...openingBytes],
      });
    } finally {
      await new Promise((resolve) => server?.close(resolve));
      await Promise.all([
        rm(projectDirectory, {recursive: true, force: true}),
        rm(browserDirectory, {recursive: true, force: true}),
        rm(profileDirectory, {recursive: true, force: true, maxRetries: 10, retryDelay: 100}),
      ]);
    }
  },
);
