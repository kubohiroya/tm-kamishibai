import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import {watch} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  resolveServedBrowserModulePath,
  resolveServedBrowserVendorModulePath,
  rewriteServedBrowserModuleSource,
} from '@kubohiroya/turbowarp-local-preview';

import {createDsl4PreviewSourceProtocolPort} from '../dsl4/preview-source-protocol-port.js';
import {dsl4BrowserPreviewArtifactLimits} from '../dsl4/browser-preview-artifact-limits.js';
import {
  createDsl4PreviewSourceGenerationWire,
  dsl4PreviewSourceGenerationWireDefaults,
  dsl4PreviewSourceGenerationWireMaximumMessageBytes,
} from '../dsl4/preview-source-generation-wire.js';
import {deepFreeze} from '../dsl4/story-document.js';
import {
  dsl4BrowserTurboWarpStageDefaults,
  dsl4BrowserTurboWarpStageMaximumProjectBytes,
} from '../dsl4/browser-turbowarp-stage.js';
import {resolveDsl4FeatureFlags} from '../dsl4/feature-flags.js';
import {dsl4ExternalSourceManifestFilenames} from '../dsl4/external-source-manifest.js';
import {Sb3BuilderError} from './errors.js';
import {
  parseDsl4ExternalSourceManifest,
  validateDsl4ExternalSourceManifest,
} from './dsl4-external-source.js';
import {createDsl4PreviewTransportPolicy} from './dsl4-preview-transport-policy.js';
import {createDsl4PreviewSourceWatcher} from './dsl4-preview-watch.js';
import {
  dsl4TurboWarpBrowserBundleDefaults,
  dsl4TurboWarpBrowserBundleMaximumBytes,
} from './dsl4-turbowarp-browser-bundle.js';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const allowedModuleDirectories = ['builder', 'dsl4'];
const browserVendorModules = new Map([
  [
    '/vendor/turbowarp-preview-runtime.js',
    fileURLToPath(import.meta.resolve('@kubohiroya/turbowarp-preview-runtime')),
  ],
]);
const browserModuleSpecifierReplacements = new Map([
  ['@kubohiroya/turbowarp-preview-runtime', '/vendor/turbowarp-preview-runtime.js'],
]);
const restartChoices = new Set(['storyStart', 'currentScene', 'currentAction']);
const runtimeOwners = new Set(['protocol', 'browser']);
const maximumRequestBytes = 4 * 1024;
const maximumEventRecords = 64;

export const dsl4LocalPreviewHostDefaults = deepFreeze({
  bindHost: '127.0.0.1',
  port: 0,
  tokenTtlMs: 2 * 60 * 1_000,
  maxTokenRecords: 4,
  maxGenerationMessageBytes: dsl4PreviewSourceGenerationWireDefaults.maxMessageBytes,
  maxProjectBytes: dsl4BrowserTurboWarpStageDefaults.maxProjectBytes,
  maxBrowserBundleBytes: dsl4TurboWarpBrowserBundleDefaults.maxBundleBytes,
});

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {string} message @param {string} code @param {unknown} [cause] @returns {never} */
function fail(message, code, cause) {
  throw new Sb3BuilderError(message, {stage: 'dsl4-local-preview-host', code, cause});
}

/** @param {unknown} value @param {string} name */
function normalizedAbsolutePath(value, name) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    path.parse(value).root === value
  ) {
    throw new TypeError(`${name} must be a normalized absolute non-root path`);
  }
  return value;
}

/** @param {unknown} value @param {string} name @param {number} minimum */
function safeInteger(value, name, minimum) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new TypeError(`${name} must be a safe integer >= ${minimum}`);
  }
  return Number(value);
}

/** @param {unknown} value @param {string} name @param {number} maximum */
function boundedBytes(value, name, maximum) {
  if (!(value instanceof Uint8Array)) throw new TypeError(`${name} must be a Uint8Array`);
  if (value.byteLength < 1 || value.byteLength > maximum) {
    throw new TypeError(`${name} must contain 1-${maximum} bytes`);
  }
  return Buffer.from(value);
}

/** @param {unknown} value */
function validateProtocolSession(value) {
  if (!isRecord(value)) throw new TypeError('protocolSession must be an object');
  for (const method of [
    'handshake',
    'stage',
    'defer',
    'commit',
    'disconnect',
    'getState',
    'whenIdle',
  ]) {
    if (typeof value[method] !== 'function') {
      throw new TypeError(`protocolSession.${method} must be a function`);
    }
  }
  return /** @type {Record<string, Function>} */ (value);
}

/** @param {unknown} value */
function validateFrontend(value) {
  if (!isRecord(value) || typeof value.parse !== 'function') {
    throw new TypeError('sourceFrontend must provide parse');
  }
  return /** @type {{parse(source: string, options?: {sourceId?: string}): any}} */ (value);
}

/** @param {unknown} value */
function validateBindHost(value) {
  if (value !== '127.0.0.1' && value !== '::1') {
    throw new TypeError('bindHost must be the literal 127.0.0.1 or ::1');
  }
  return value;
}

/** @param {string} host @param {number} port */
function originFor(host, port) {
  return `http://${host === '::1' ? `[${host}]` : host}:${port}`;
}

/** @param {unknown} error */
function safeError(error) {
  const code =
    error instanceof Sb3BuilderError && /^K4-[A-Z0-9-]+$/u.test(error.code)
      ? error.code
      : 'K4-PREVIEW-HOST-INTERNAL';
  return deepFreeze({
    code,
    message:
      code === 'K4-PREVIEW-HOST-INTERNAL'
        ? 'The local preview host could not complete the request'
        : 'The local preview host rejected the request',
  });
}

/** @param {string} token */
function tokenDigest(token) {
  return createHash('sha256').update(token, 'utf8').digest();
}

/** @param {Buffer | null} expected @param {unknown} authorization */
function matchesBearer(expected, authorization) {
  if (!expected || typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
    return false;
  }
  const candidate = tokenDigest(authorization.slice('Bearer '.length));
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

/** @param {import('node:http').IncomingMessage} request */
async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > maximumRequestBytes) {
      fail('Preview request body exceeds the fixed limit', 'K4-PREVIEW-HOST-REQUEST-LIMIT');
    }
    chunks.push(bytes);
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    fail('Preview request body must be valid JSON', 'K4-PREVIEW-HOST-REQUEST', error);
  }
  if (!isRecord(parsed)) {
    fail('Preview request body must be an object', 'K4-PREVIEW-HOST-REQUEST');
  }
  return parsed;
}

/** @param {import('node:http').ServerResponse} response @param {number} status @param {unknown} value */
function writeJson(response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

/** @param {unknown} input */
function safeSourceSummary(input) {
  if (!isRecord(input) || typeof input.ok !== 'boolean' || !Array.isArray(input.diagnostics)) {
    throw new TypeError('watcher result is invalid');
  }
  const storyDocument = isRecord(input.storyDocument) ? input.storyDocument : null;
  const scenes = Array.isArray(storyDocument?.scenes) ? storyDocument.scenes : [];
  const actionCount = scenes.reduce(
    (count, scene) =>
      count + (isRecord(scene) && Array.isArray(scene.actions) ? scene.actions.length : 0),
    0,
  );
  const assetReferences = Array.isArray(storyDocument?.assetReferences)
    ? storyDocument.assetReferences
    : [];
  const sourceSnapshot = isRecord(input.sourceSnapshot) ? input.sourceSnapshot : null;
  return deepFreeze({
    ok: input.ok,
    integrity:
      sourceSnapshot && typeof sourceSnapshot.integrity === 'string'
        ? sourceSnapshot.integrity
        : null,
    diagnostics: input.diagnostics,
    counts: input.ok
      ? {scenes: scenes.length, actions: actionCount, assets: assetReferences.length}
      : null,
  });
}

/** @param {string} requestPath */
function modulePath(requestPath) {
  return resolveServedBrowserModulePath({
    requestPath,
    sourceRoot,
    allowedDirectories: allowedModuleDirectories,
  });
}

/** @param {string} requestPath */
function vendorModulePath(requestPath) {
  return resolveServedBrowserVendorModulePath({
    requestPath,
    vendorModules: browserVendorModules,
  });
}

/** @param {string} source */
function rewriteServedModuleSource(source) {
  return rewriteServedBrowserModuleSource(source, browserModuleSpecifierReplacements);
}

/**
 * @param {string} sourceDisplayName
 * @param {'protocol' | 'browser'} runtimeOwner
 * @param {{maxProjectBytes: number, maxProjectJsonBytes: number, maxAssetFiles: number, maxAssetBytes: number}} runtimeLimits
 */
function previewHtml(sourceDisplayName, runtimeOwner, runtimeLimits) {
  const safeName = sourceDisplayName.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
  const runtimeDescription =
    runtimeOwner === 'browser'
      ? 'The project runtime is owned by this authenticated browser page.'
      : 'The project runtime is connected through the shared preview protocol.';
  const clientPath =
    runtimeOwner === 'browser'
      ? '/runtime/browser.js'
      : '/modules/builder/dsl4-local-preview-client.js';
  return `<!doctype html>
<html lang="en" data-dsl4-max-project-bytes="${runtimeLimits.maxProjectBytes}" data-dsl4-max-project-json-bytes="${runtimeLimits.maxProjectJsonBytes}" data-dsl4-max-asset-files="${runtimeLimits.maxAssetFiles}" data-dsl4-max-asset-bytes="${runtimeLimits.maxAssetBytes}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="referrer" content="no-referrer">
    <title>DSL 4.0 local preview</title>
    <style>
      :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
      body { margin: 0; min-height: 100vh; }
      main { box-sizing: border-box; min-height: 100vh; padding: 1rem; }
      #dsl4-local-preview-runtime { min-height: 18rem; border: 1px solid currentColor; border-radius: .5rem; padding: 1rem; }
      [data-dsl4-development-only="true"] { margin-top: 1rem; }
      button { min-height: 44px; min-width: 44px; }
    </style>
  </head>
  <body>
    <main id="dsl4-local-preview-mount">
      <h1>DSL 4.0 local preview</h1>
      <p>Watching <strong id="dsl4-local-preview-source-name">${safeName}</strong>. ${runtimeDescription}</p>
      <section id="dsl4-local-preview-runtime" aria-label="Project preview runtime"></section>
    </main>
    <script type="module" src="${clientPath}"></script>
  </body>
</html>\n`;
}

/**
 * Start one loopback-only adapter between the Node source watcher and an injected runtime protocol.
 * The runtime remains owned by the caller; this host owns only transport, watch, and browser UI.
 *
 * @param {object} options
 * @param {string} options.projectRoot
 * @param {string} options.sourceManifestPath
 * @param {unknown} options.sourceManifest
 * @param {{parse: Function}} options.sourceFrontend
 * @param {number} options.maxSourceBytes
 * @param {unknown} [options.featureFlags]
 * @param {number} [options.maxSourceFiles]
 * @param {number} [options.maxTotalSourceBytes]
 * @param {number} [options.maxIncludeDepth]
 * @param {number} [options.maxAssetFileBytes]
 * @param {number} [options.maxAssetFiles]
 * @param {number} [options.maxTotalAssetBytes]
 * @param {Record<string, Function>} [options.protocolSession]
 * @param {'protocol' | 'browser'} [options.runtimeOwner]
 * @param {'127.0.0.1' | '::1'} [options.bindHost]
 * @param {number} [options.port]
 * @param {number} [options.tokenTtlMs]
 * @param {number} [options.maxTokenRecords]
 * @param {number} [options.maxGenerationMessageBytes]
 * @param {Uint8Array} [options.projectBytes]
 * @param {Uint8Array} [options.browserBundleBytes]
 * @param {number} [options.maxProjectBytes]
 * @param {number} [options.maxProjectJsonBytes]
 * @param {number} [options.maxBrowserBundleBytes]
 * @param {(directory: string, listener: (eventType: string, filename: string | Buffer | null) => void) => {close: Function, on: Function}} [options.structureWatchFactory]
 * @param {Record<string, unknown>} [options.watcherOptions]
 * @param {(event: Readonly<Record<string, unknown>>) => unknown} [options.onEvent]
 * @param {(error: unknown) => unknown} [options.onError]
 * @param {() => number} [options.now]
 * @param {(size: number) => Uint8Array} [options.randomBytes]
 */
export function createDsl4LocalPreviewHost(options) {
  if (!isRecord(options)) throw new TypeError('local preview host options are required');
  const projectRoot = normalizedAbsolutePath(options.projectRoot, 'projectRoot');
  const sourceManifestPath =
    options.sourceManifestPath === null || options.sourceManifestPath === undefined
      ? null
      : normalizedAbsolutePath(options.sourceManifestPath, 'sourceManifestPath');
  if (
    sourceManifestPath !== null &&
    (path.dirname(sourceManifestPath) !== projectRoot ||
      !dsl4ExternalSourceManifestFilenames.includes(path.basename(sourceManifestPath)))
  ) {
    throw new TypeError(
      `sourceManifestPath must use one of: ${dsl4ExternalSourceManifestFilenames.join(', ')}`,
    );
  }
  const sourceManifest = validateDsl4ExternalSourceManifest(options.sourceManifest);
  if (typeof sourceManifest.path !== 'string') {
    throw new TypeError('sourceManifest.path must be resolved');
  }
  const sourceFrontend = validateFrontend(options.sourceFrontend);
  const maxSourceBytes = safeInteger(options.maxSourceBytes, 'maxSourceBytes', 1);
  const featureFlags = resolveDsl4FeatureFlags(options.featureFlags ?? {});
  const graphOptions = featureFlags.dsl4SourceIncludes
    ? {
        maxSourceFiles: safeInteger(options.maxSourceFiles, 'maxSourceFiles', 1),
        maxTotalSourceBytes: safeInteger(
          options.maxTotalSourceBytes,
          'maxTotalSourceBytes',
          maxSourceBytes,
        ),
        maxIncludeDepth: safeInteger(options.maxIncludeDepth, 'maxIncludeDepth', 1),
        maxAssetFileBytes: safeInteger(options.maxAssetFileBytes, 'maxAssetFileBytes', 1),
        maxAssetFiles: safeInteger(options.maxAssetFiles, 'maxAssetFiles', 1),
        maxTotalAssetBytes: safeInteger(options.maxTotalAssetBytes, 'maxTotalAssetBytes', 1),
      }
    : {};
  if (
    featureFlags.dsl4SourceIncludes &&
    Number(graphOptions.maxAssetFileBytes) > Number(graphOptions.maxTotalAssetBytes)
  ) {
    throw new TypeError('maxAssetFileBytes must be less than or equal to maxTotalAssetBytes');
  }
  const runtimeOwner = options.runtimeOwner ?? 'protocol';
  if (typeof runtimeOwner !== 'string' || !runtimeOwners.has(runtimeOwner)) {
    throw new TypeError('runtimeOwner must be protocol or browser');
  }
  const protocolSession =
    runtimeOwner === 'protocol' ? validateProtocolSession(options.protocolSession) : null;
  if (runtimeOwner === 'browser' && options.protocolSession !== undefined) {
    throw new TypeError('protocolSession must be omitted when runtimeOwner is browser');
  }
  const bindHost = validateBindHost(options.bindHost ?? dsl4LocalPreviewHostDefaults.bindHost);
  const requestedPort = safeInteger(options.port ?? dsl4LocalPreviewHostDefaults.port, 'port', 0);
  if (requestedPort > 65_535) throw new TypeError('port must be <= 65535');
  const tokenTtlMs = safeInteger(
    options.tokenTtlMs ?? dsl4LocalPreviewHostDefaults.tokenTtlMs,
    'tokenTtlMs',
    1,
  );
  const maxTokenRecords = safeInteger(
    options.maxTokenRecords ?? dsl4LocalPreviewHostDefaults.maxTokenRecords,
    'maxTokenRecords',
    1,
  );
  const maxGenerationMessageBytes = safeInteger(
    options.maxGenerationMessageBytes ?? dsl4LocalPreviewHostDefaults.maxGenerationMessageBytes,
    'maxGenerationMessageBytes',
    1,
  );
  if (maxGenerationMessageBytes > dsl4PreviewSourceGenerationWireMaximumMessageBytes) {
    throw new TypeError(
      `maxGenerationMessageBytes must be <= ${dsl4PreviewSourceGenerationWireMaximumMessageBytes}`,
    );
  }
  const maxProjectBytes = safeInteger(
    options.maxProjectBytes ?? dsl4LocalPreviewHostDefaults.maxProjectBytes,
    'maxProjectBytes',
    1,
  );
  if (maxProjectBytes > dsl4BrowserTurboWarpStageMaximumProjectBytes) {
    throw new TypeError(
      `maxProjectBytes must be <= ${dsl4BrowserTurboWarpStageMaximumProjectBytes}`,
    );
  }
  const maxProjectJsonBytes = safeInteger(
    options.maxProjectJsonBytes ?? dsl4BrowserPreviewArtifactLimits.defaults.maxProjectJsonBytes,
    'maxProjectJsonBytes',
    1,
  );
  if (maxProjectJsonBytes > dsl4BrowserPreviewArtifactLimits.absoluteMaximums.maxProjectJsonBytes) {
    throw new TypeError(
      `maxProjectJsonBytes must be <= ${dsl4BrowserPreviewArtifactLimits.absoluteMaximums.maxProjectJsonBytes}`,
    );
  }
  const runtimeMaxAssetFiles = safeInteger(options.maxAssetFiles ?? 64, 'maxAssetFiles', 1);
  const runtimeMaxAssetBytes = safeInteger(
    options.maxTotalAssetBytes ?? dsl4BrowserPreviewArtifactLimits.defaults.maxAssetBytes,
    'maxTotalAssetBytes',
    1,
  );
  if (runtimeMaxAssetBytes > dsl4BrowserPreviewArtifactLimits.absoluteMaximums.maxAssetBytes) {
    throw new TypeError(
      `maxTotalAssetBytes must be <= ${dsl4BrowserPreviewArtifactLimits.absoluteMaximums.maxAssetBytes}`,
    );
  }
  const maxBrowserBundleBytes = safeInteger(
    options.maxBrowserBundleBytes ?? dsl4LocalPreviewHostDefaults.maxBrowserBundleBytes,
    'maxBrowserBundleBytes',
    1,
  );
  if (maxBrowserBundleBytes > dsl4TurboWarpBrowserBundleMaximumBytes) {
    throw new TypeError(
      `maxBrowserBundleBytes must be <= ${dsl4TurboWarpBrowserBundleMaximumBytes}`,
    );
  }
  if ((options.projectBytes === undefined) !== (options.browserBundleBytes === undefined)) {
    throw new TypeError('projectBytes and browserBundleBytes must be provided together');
  }
  /** @type {Buffer | null} */
  let projectArtifactBytes =
    options.projectBytes === undefined
      ? null
      : boundedBytes(options.projectBytes, 'projectBytes', maxProjectBytes);
  /** @type {Buffer | null} */
  let browserRuntimeBundleBytes =
    options.browserBundleBytes === undefined
      ? null
      : boundedBytes(options.browserBundleBytes, 'browserBundleBytes', maxBrowserBundleBytes);
  if (runtimeOwner === 'browser' && (!projectArtifactBytes || !browserRuntimeBundleBytes)) {
    throw new TypeError('browser runtime owner requires projectBytes and browserBundleBytes');
  }
  const structureWatchFactory =
    /** @type {(directory: string, listener: (eventType: string, filename: string | Buffer | null) => void) => {close: Function, on: Function}} */ (
      options.structureWatchFactory ??
        ((directory, listener) => watch(directory, {persistent: true}, listener))
    );
  if (typeof structureWatchFactory !== 'function') {
    throw new TypeError('structureWatchFactory must be a function');
  }
  if (options.watcherOptions !== undefined && !isRecord(options.watcherOptions)) {
    throw new TypeError('watcherOptions must be an object');
  }
  if (options.onEvent !== undefined && typeof options.onEvent !== 'function') {
    throw new TypeError('onEvent must be a function');
  }
  if (options.onError !== undefined && typeof options.onError !== 'function') {
    throw new TypeError('onError must be a function');
  }
  const now = /** @type {() => number} */ (options.now ?? Date.now);
  const secureRandomBytes = /** @type {(size: number) => Uint8Array} */ (
    options.randomBytes ?? randomBytes
  );
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  if (typeof secureRandomBytes !== 'function')
    throw new TypeError('randomBytes must be a function');

  /** @type {'idle' | 'listening' | 'connected' | 'rebuild-required' | 'failed' | 'disposed'} */
  let status = 'idle';
  let disposed = false;
  let stopping = false;
  let browserRuntimeReady = false;
  let sequence = 0;
  let generationRevision = 0;
  /** @type {string | null} */
  let origin = null;
  /** @type {Buffer | null} */
  let activeTokenDigest = null;
  /** @type {string | null} */
  let launchToken = null;
  /** @type {import('node:http').ServerResponse | null} */
  let activeResponse = null;
  /** @type {ReturnType<typeof createDsl4PreviewTransportPolicy> | null} */
  let transportPolicy = null;
  /** @type {ReturnType<ReturnType<typeof createDsl4PreviewTransportPolicy>['connect']> | null} */
  let transportConnection = null;
  /** @type {ReturnType<typeof createDsl4PreviewSourceProtocolPort> | null} */
  let sourcePort = null;
  /** @type {ReturnType<typeof createDsl4PreviewSourceWatcher> | null} */
  let sourceWatcher = null;
  /** @type {{close: Function, on: Function} | null} */
  let structureWatcher = null;
  /** @type {Readonly<Record<string, any>> | null} */
  let currentSourceSummary = null;
  /** @type {Readonly<Record<string, any>> | null} */
  let latestValidSourceResult = null;
  /** @type {Promise<Readonly<Record<string, unknown>>> | null} */
  let startPromise = null;
  /** @type {Promise<Readonly<Record<string, unknown>>> | null} */
  let disposePromise = null;
  let structuralOperation = Promise.resolve();
  /** @type {Readonly<Record<string, unknown>>[]} */
  const events = [];
  /** @type {Readonly<Record<string, unknown>> | null} */
  let latestGenerationRecord = null;

  function snapshot() {
    return deepFreeze({
      version: 1,
      runtimeOwner,
      status,
      disposed,
      origin,
      connected: transportConnection !== null,
      browserRuntimeReady: runtimeOwner === 'browser' ? browserRuntimeReady : null,
      rebuildRequired: status === 'rebuild-required',
      latestSequence: sequence,
      retainedEvents: events.length + (latestGenerationRecord ? 1 : 0),
      source: currentSourceSummary,
      runtimeArtifacts:
        projectArtifactBytes && browserRuntimeBundleBytes
          ? {
              available: true,
              projectBytes: projectArtifactBytes.byteLength,
              browserBundleBytes: browserRuntimeBundleBytes.byteLength,
            }
          : null,
    });
  }

  /** @param {unknown} error */
  function reportError(error) {
    if (!disposed && status !== 'rebuild-required') status = 'failed';
    try {
      options.onError?.(error);
    } catch {
      // Error observers cannot change host lifecycle.
    }
  }

  /** @param {Readonly<Record<string, unknown>>} event */
  function publish(event) {
    const record = deepFreeze({sequence: ++sequence, ...event});
    events.push(record);
    if (events.length > maximumEventRecords) events.shift();
    writeActiveRecord(record);
    notifyEventObserver(record);
    return record;
  }

  /** @param {Readonly<Record<string, unknown>>} record */
  function writeActiveRecord(record) {
    if (activeResponse && !activeResponse.destroyed) {
      activeResponse.write(`${JSON.stringify(record)}\n`);
    }
  }

  /** @param {Readonly<Record<string, unknown>>} record */
  function notifyEventObserver(record) {
    try {
      options.onEvent?.(record);
    } catch (error) {
      try {
        options.onError?.(error);
      } catch {
        // Observers cannot change transport or watch state.
      }
    }
  }

  /** @param {Readonly<Record<string, unknown>>} result */
  function publishGeneration(result) {
    const revision = generationRevision + 1;
    const generation = createDsl4PreviewSourceGenerationWire({
      revision,
      result,
      maxMessageBytes: maxGenerationMessageBytes,
    });
    generationRevision = revision;
    const record = deepFreeze({
      sequence: ++sequence,
      type: 'local-preview.generation',
      generation,
    });
    latestGenerationRecord = record;
    writeActiveRecord(record);
    return record;
  }

  /** @param {number} after */
  function retainedRecords(after) {
    return [...events, ...(latestGenerationRecord ? [latestGenerationRecord] : [])]
      .filter((event) => Number(event.sequence) > after)
      .sort((left, right) => Number(left.sequence) - Number(right.sequence));
  }

  async function disconnectProtocol() {
    const port = sourcePort;
    sourcePort = null;
    if (port) await port.dispose();
  }

  async function stopWatcher() {
    const watcher = sourceWatcher;
    sourceWatcher = null;
    if (watcher) await watcher.dispose();
  }

  function stopStructureWatcher() {
    const watcher = structureWatcher;
    structureWatcher = null;
    watcher?.close();
  }

  /** @param {string} code @param {string} message */
  async function requireFullRebuild(code, message) {
    if (disposed || status === 'rebuild-required') return snapshot();
    status = 'rebuild-required';
    browserRuntimeReady = false;
    const connection = transportConnection;
    transportConnection = null;
    stopStructureWatcher();
    await stopWatcher();
    await disconnectProtocol();
    latestGenerationRecord = null;
    projectArtifactBytes = null;
    browserRuntimeBundleBytes = null;
    publish({
      type: 'local-preview.full-rebuild-required',
      diagnostic: {version: 1, code, severity: 'error', message},
    });
    if (connection) await connection.disconnect('graceful-stop');
    return snapshot();
  }

  async function inspectManifestChange() {
    if (sourceManifestPath === null) {
      await requireFullRebuild(
        'K4-PREVIEW-STRUCTURE-CHANGED',
        'Project entry sources changed; restart preview so source discovery can run again',
      );
      return;
    }
    let parsed;
    try {
      const source = new TextDecoder('utf-8', {fatal: true}).decode(
        await readFile(sourceManifestPath),
      );
      parsed = parseDsl4ExternalSourceManifest(source, {
        filename: path.basename(sourceManifestPath),
      });
    } catch {
      await requireFullRebuild(
        'K4-PREVIEW-STRUCTURE-MANIFEST',
        'The source manifest changed or became unreadable; restart preview after a full rebuild',
      );
      return;
    }
    let nextManifest;
    try {
      nextManifest = validateDsl4ExternalSourceManifest(parsed);
    } catch {
      await requireFullRebuild(
        'K4-PREVIEW-STRUCTURE-MANIFEST',
        'The source manifest became invalid; restart preview after correcting it and rebuilding',
      );
      return;
    }
    if (JSON.stringify(nextManifest) !== JSON.stringify(sourceManifest)) {
      await requireFullRebuild(
        'K4-PREVIEW-STRUCTURE-CHANGED',
        'The source path or identity changed; a full rebuild and a new preview session are required',
      );
    }
  }

  function startStructureWatcher() {
    const watcher = structureWatchFactory(projectRoot, (_eventType, filename) => {
      if (disposed || status === 'rebuild-required') return;
      if (filename !== null) {
        const changed = String(filename);
        if (sourceManifestPath === null) {
          if (
            changed === sourceManifest.path ||
            (!changed.endsWith('.k4.yml') && !dsl4ExternalSourceManifestFilenames.includes(changed))
          ) {
            return;
          }
        } else if (changed !== path.basename(sourceManifestPath)) {
          return;
        }
      }
      structuralOperation = structuralOperation
        .then(inspectManifestChange)
        .catch((error) => reportError(error));
    });
    if (
      !isRecord(watcher) ||
      typeof watcher.close !== 'function' ||
      typeof watcher.on !== 'function'
    ) {
      try {
        watcher?.close?.();
      } catch {
        // Invalid structural watcher cleanup is best-effort.
      }
      throw new TypeError('structureWatchFactory must return close and on methods');
    }
    structureWatcher = /** @type {{close: Function, on: Function}} */ (watcher);
    structureWatcher.on('error', reportError);
  }

  /** @param {Readonly<Record<string, unknown>>} event */
  function observeProtocolEvent(event) {
    if (event.type === 'preview.source.staged') return;
    publish({type: 'local-preview.protocol', event});
  }

  /** @param {import('node:http').IncomingMessage} request @param {Record<string, unknown>} body */
  async function connectRuntime(request, body) {
    if (!transportPolicy || !origin || !launchToken || !activeTokenDigest) {
      fail('Preview host is not ready', 'K4-PREVIEW-HOST-NOT-READY');
    }
    if (transportConnection) {
      fail('Preview host already has an active client', 'K4-PREVIEW-HOST-ACTIVE');
    }
    if (
      typeof body.token !== 'string' ||
      tokenDigest(body.token).length !== activeTokenDigest.length
    ) {
      fail('Preview session token is invalid', 'K4-PREVIEW-TRANSPORT-TOKEN');
    }
    const remoteAddress = request.socket.remoteAddress ?? '';
    const connection = transportPolicy.connect({
      origin: request.headers.origin,
      remoteAddress,
      token: body.token,
    });
    connection.authorizeSourceRead(sourceManifest.path);
    activeTokenDigest = tokenDigest(body.token);
    launchToken = null;
    transportConnection = connection;
    browserRuntimeReady = false;
    const sessionId = `local-${Buffer.from(secureRandomBytes(12)).toString('base64url')}`;
    /** @type {ReturnType<typeof createDsl4PreviewSourceProtocolPort> | null} */
    let port = null;
    /** @type {ReturnType<typeof createDsl4PreviewSourceWatcher> | null} */
    let watcher = null;
    try {
      const activePort =
        runtimeOwner === 'protocol'
          ? createDsl4PreviewSourceProtocolPort({
              protocolSession: /** @type {Record<string, Function>} */ (protocolSession),
              sessionId,
              onEvent: observeProtocolEvent,
              onError: reportError,
            })
          : null;
      port = activePort;
      sourcePort = activePort;
      const activeWatcher = createDsl4PreviewSourceWatcher({
        ...options.watcherOptions,
        projectRoot,
        manifest: sourceManifest,
        sourceFrontend,
        maxSourceBytes,
        featureFlags,
        ...graphOptions,
        async onResult(result) {
          if (
            transportConnection !== connection ||
            sourceWatcher !== activeWatcher ||
            (runtimeOwner === 'protocol' && sourcePort !== activePort)
          ) {
            return;
          }
          const generationRecord = publishGeneration(result);
          const summary = safeSourceSummary(result);
          currentSourceSummary = summary;
          const generationRevision = generationRecord.generation.revision;
          if (runtimeOwner === 'browser') {
            publish({type: 'local-preview.source', generationRevision, source: summary});
            return;
          }
          if (!activePort) {
            fail('Preview protocol is unavailable', 'K4-PREVIEW-HOST-RUNTIME-OWNER');
          }
          if (result.ok === true) latestValidSourceResult = result;
          const acknowledgement = await activePort.stage(result);
          publish({
            type: 'local-preview.source',
            generationRevision,
            source: summary,
            acknowledgement,
          });
        },
        onError: reportError,
      });
      watcher = activeWatcher;
      sourceWatcher = activeWatcher;
      await activePort?.connect();
      if (
        disposed ||
        transportConnection !== connection ||
        (runtimeOwner === 'protocol' && sourcePort !== activePort)
      ) {
        throw new TypeError('local preview host was disposed while connecting');
      }
      await activeWatcher.start();
      if (
        disposed ||
        transportConnection !== connection ||
        sourcePort !== activePort ||
        sourceWatcher !== activeWatcher
      ) {
        throw new TypeError('local preview host was disposed while connecting');
      }
      startStructureWatcher();
      if (disposed || transportConnection !== connection) {
        stopStructureWatcher();
        throw new TypeError('local preview host was disposed while connecting');
      }
      status = 'connected';
      return {snapshot: snapshot(), events: retainedRecords(0)};
    } catch (error) {
      if (sourceWatcher === watcher) await stopWatcher();
      else await watcher?.dispose();
      if (sourcePort === port) await disconnectProtocol();
      else await port?.dispose();
      await connection.disconnect('host-crash');
      if (transportConnection === connection) transportConnection = null;
      browserRuntimeReady = false;
      throw error;
    }
  }

  /** @param {import('node:http').IncomingMessage} request */
  function requireActiveRequest(request) {
    if (!origin || request.headers.origin !== origin) {
      fail('Preview request Origin is not allowed', 'K4-PREVIEW-TRANSPORT-ORIGIN');
    }
    if (!matchesBearer(activeTokenDigest, request.headers.authorization)) {
      fail('Preview bearer session is invalid', 'K4-PREVIEW-TRANSPORT-TOKEN');
    }
    if (
      !transportConnection ||
      (runtimeOwner === 'protocol' && !sourcePort) ||
      status === 'rebuild-required'
    ) {
      fail('Preview session is disconnected', 'K4-PREVIEW-TRANSPORT-DISCONNECTED');
    }
  }

  function requireProtocolPort() {
    if (runtimeOwner !== 'protocol') {
      fail('Preview runtime operations are browser-owned', 'K4-PREVIEW-HOST-RUNTIME-OWNER');
    }
    if (!sourcePort) {
      fail('Preview session is disconnected', 'K4-PREVIEW-TRANSPORT-DISCONNECTED');
    }
    return sourcePort;
  }

  /** @param {import('node:http').IncomingMessage} request @param {import('node:http').ServerResponse} response */
  async function handleApi(request, response) {
    if (request.method !== 'POST') {
      writeJson(response, 405, {error: {code: 'K4-PREVIEW-HOST-METHOD'}});
      return;
    }
    const requestUrl = new URL(request.url ?? '/', origin ?? 'http://127.0.0.1');
    if (requestUrl.pathname === '/api/connect') {
      const result = await connectRuntime(request, await readJsonBody(request));
      writeJson(response, 200, result);
      return;
    }
    requireActiveRequest(request);
    if (requestUrl.pathname === '/api/events') {
      if (activeResponse) {
        fail('Preview event stream is already open', 'K4-PREVIEW-HOST-STREAM-ACTIVE');
      }
      const body = await readJsonBody(request);
      const after = safeInteger(body.after ?? 0, 'after', 0);
      response.writeHead(200, {
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'content-type': 'application/x-ndjson; charset=utf-8',
        'x-accel-buffering': 'no',
        'x-content-type-options': 'nosniff',
      });
      response.flushHeaders();
      for (const event of retainedRecords(after)) {
        response.write(`${JSON.stringify(event)}\n`);
      }
      activeResponse = response;
      response.on('close', () => {
        if (activeResponse === response) activeResponse = null;
        if (!stopping && transportConnection) {
          void teardownConnection('transport-close').catch(reportError);
        }
      });
      return;
    }
    if (requestUrl.pathname === '/api/runtime-project') {
      const body = await readJsonBody(request);
      if (Object.keys(body).length !== 0) {
        fail('Runtime project request body must be empty', 'K4-PREVIEW-HOST-REQUEST');
      }
      if (!projectArtifactBytes) {
        writeJson(response, 404, {error: {code: 'K4-PREVIEW-HOST-NOT-FOUND'}});
        return;
      }
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-length': projectArtifactBytes.byteLength,
        'content-type': 'application/octet-stream',
        'cross-origin-resource-policy': 'same-origin',
        'x-content-type-options': 'nosniff',
      });
      response.end(projectArtifactBytes);
      return;
    }
    if (requestUrl.pathname === '/api/runtime-ready') {
      if (runtimeOwner !== 'browser') {
        fail('Preview runtime operations are protocol-owned', 'K4-PREVIEW-HOST-RUNTIME-OWNER');
      }
      const body = await readJsonBody(request);
      if (Object.keys(body).length !== 1 || body.version !== 1) {
        fail('Browser runtime ready acknowledgement is invalid', 'K4-PREVIEW-HOST-REQUEST');
      }
      if (!browserRuntimeReady) {
        browserRuntimeReady = true;
        publish({type: 'local-preview.runtime-ready'});
      }
      writeJson(response, 200, {snapshot: snapshot()});
      return;
    }
    if (requestUrl.pathname === '/api/commit') {
      const activePort = requireProtocolPort();
      const body = await readJsonBody(request);
      if (typeof body.choice !== 'string' || !restartChoices.has(body.choice)) {
        fail('Preview restart choice is invalid', 'K4-PREVIEW-HOST-REQUEST');
      }
      const acknowledgement = await activePort.commit(
        /** @type {'storyStart' | 'currentScene' | 'currentAction'} */ (body.choice),
      );
      writeJson(response, 200, {acknowledgement});
      return;
    }
    if (requestUrl.pathname === '/api/restart') {
      const activePort = requireProtocolPort();
      const body = await readJsonBody(request);
      if (typeof body.choice !== 'string' || !restartChoices.has(body.choice)) {
        fail('Preview restart choice is invalid', 'K4-PREVIEW-HOST-REQUEST');
      }
      if (!latestValidSourceResult) {
        fail('Preview has no validated source generation', 'K4-PREVIEW-HOST-NO-SOURCE');
      }
      await activePort.stage(latestValidSourceResult);
      await activePort.whenIdle();
      const acknowledgement = await activePort.commit(
        /** @type {'storyStart' | 'currentScene' | 'currentAction'} */ (body.choice),
      );
      writeJson(response, 200, {acknowledgement});
      return;
    }
    if (requestUrl.pathname === '/api/defer') {
      const activePort = requireProtocolPort();
      const acknowledgement = await activePort.defer();
      writeJson(response, 200, {acknowledgement});
      return;
    }
    if (requestUrl.pathname === '/api/disconnect') {
      await teardownConnection('graceful-stop');
      writeJson(response, 200, {snapshot: snapshot()});
      return;
    }
    writeJson(response, 404, {error: {code: 'K4-PREVIEW-HOST-NOT-FOUND'}});
  }

  /** @param {'graceful-stop' | 'host-crash' | 'transport-close'} reason */
  async function teardownConnection(reason) {
    const connection = transportConnection;
    transportConnection = null;
    browserRuntimeReady = false;
    const response = activeResponse;
    activeResponse = null;
    response?.end();
    stopStructureWatcher();
    await stopWatcher();
    await disconnectProtocol();
    latestGenerationRecord = null;
    if (connection) await connection.disconnect(reason);
    if (!disposed && status !== 'rebuild-required') status = 'listening';
  }

  const server = createServer((request, response) => {
    void (async () => {
      const requestUrl = new URL(request.url ?? '/', origin ?? 'http://127.0.0.1');
      if (requestUrl.pathname.startsWith('/api/')) {
        await handleApi(request, response);
        return;
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        writeJson(response, 405, {error: {code: 'K4-PREVIEW-HOST-METHOD'}});
        return;
      }
      if (requestUrl.pathname === '/') {
        const body = previewHtml(
          /** @type {string} */ (sourceManifest.path),
          /** @type {'protocol' | 'browser'} */ (runtimeOwner),
          {
            maxProjectBytes,
            maxProjectJsonBytes,
            maxAssetFiles: runtimeMaxAssetFiles,
            maxAssetBytes: runtimeMaxAssetBytes,
          },
        );
        const browserRuntimeSources =
          runtimeOwner === 'browser' ? "; worker-src 'self' blob:; font-src 'self' data:" : '';
        const mediaSources = runtimeOwner === 'browser' ? "'self' blob:" : "'self'";
        response.writeHead(200, {
          'cache-control': 'no-store',
          'content-length': Buffer.byteLength(body),
          'content-security-policy': `default-src 'none'; script-src 'self'${runtimeOwner === 'browser' ? " 'unsafe-eval'" : ''}${browserRuntimeSources}; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; media-src ${mediaSources}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
          'content-type': 'text/html; charset=utf-8',
          'referrer-policy': 'no-referrer',
          'x-content-type-options': 'nosniff',
          'x-frame-options': 'DENY',
        });
        if (request.method === 'HEAD') response.end();
        else response.end(body);
        return;
      }
      if (requestUrl.pathname === '/runtime/browser.js') {
        if (!browserRuntimeBundleBytes) {
          writeJson(response, 404, {error: {code: 'K4-PREVIEW-HOST-NOT-FOUND'}});
          return;
        }
        response.writeHead(200, {
          'cache-control': 'no-store',
          'content-length': browserRuntimeBundleBytes.byteLength,
          'content-type': 'text/javascript; charset=utf-8',
          'cross-origin-resource-policy': 'same-origin',
          'x-content-type-options': 'nosniff',
        });
        if (request.method === 'HEAD') response.end();
        else response.end(browserRuntimeBundleBytes);
        return;
      }
      const requestedModule =
        modulePath(requestUrl.pathname) ?? vendorModulePath(requestUrl.pathname);
      if (!requestedModule) {
        writeJson(response, 404, {error: {code: 'K4-PREVIEW-HOST-NOT-FOUND'}});
        return;
      }
      let body;
      try {
        const source = await readFile(requestedModule, 'utf8');
        body = Buffer.from(
          requestUrl.pathname.startsWith('/modules/') ? rewriteServedModuleSource(source) : source,
          'utf8',
        );
      } catch {
        writeJson(response, 404, {error: {code: 'K4-PREVIEW-HOST-NOT-FOUND'}});
        return;
      }
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-length': body.length,
        'content-type': 'text/javascript; charset=utf-8',
        'x-content-type-options': 'nosniff',
      });
      if (request.method === 'HEAD') response.end();
      else response.end(body);
    })().catch((error) => {
      if (!(error instanceof Sb3BuilderError) || !/^K4-[A-Z0-9-]+$/u.test(error.code)) {
        reportError(error);
      }
      if (!response.headersSent) writeJson(response, 400, {error: safeError(error)});
      else response.destroy();
    });
  });
  server.on('clientError', (error, socket) => {
    try {
      options.onError?.(error);
    } catch {
      // A malformed client cannot change host lifecycle through an observer.
    }
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  function start() {
    if (disposed) throw new TypeError('local preview host is disposed');
    if (startPromise) return startPromise;
    startPromise = new Promise((resolve, reject) => {
      /** @param {Error} error */
      const handleError = (error) => {
        server.off('listening', handleListening);
        status = disposed ? 'disposed' : 'failed';
        reject(error);
      };
      const handleListening = () => {
        server.off('error', handleError);
        if (disposed) {
          reject(new TypeError('local preview host was disposed while starting'));
          return;
        }
        const address = server.address();
        if (!isRecord(address) || !Number.isSafeInteger(address.port)) {
          reject(new TypeError('local preview server did not publish a TCP address'));
          return;
        }
        const port = Number(address.port);
        origin = originFor(bindHost, port);
        transportPolicy = createDsl4PreviewTransportPolicy({
          bindHost,
          port,
          origin,
          projectRoot,
          sourceManifest,
          tokenTtlMs,
          maxTokenRecords,
          async onDisconnect(event) {
            publish({type: 'local-preview.transport-disconnected', event});
          },
          randomBytes: secureRandomBytes,
          now,
        });
        const issued = transportPolicy.issueToken();
        launchToken = issued.token;
        activeTokenDigest = tokenDigest(issued.token);
        status = 'listening';
        resolve(snapshot());
      };
      server.once('error', handleError);
      server.once('listening', handleListening);
      server.listen({host: bindHost, port: requestedPort});
    });
    return startPromise;
  }

  function getLaunchUrl() {
    if (disposed || !origin || !launchToken || status !== 'listening') {
      throw new TypeError('local preview launch URL is unavailable');
    }
    return `${origin}/#${launchToken}`;
  }

  function dispose() {
    if (disposePromise) return disposePromise;
    disposed = true;
    stopping = true;
    disposePromise = (async () => {
      const errors = [];
      try {
        await startPromise;
      } catch {
        // A failed or cancelled start still needs the shared server cleanup below.
      }
      activeResponse?.end();
      activeResponse = null;
      try {
        stopStructureWatcher();
      } catch (error) {
        errors.push(error);
      }
      try {
        await structuralOperation;
      } catch (error) {
        errors.push(error);
      }
      try {
        await teardownConnection('graceful-stop');
      } catch (error) {
        errors.push(error);
      }
      try {
        await transportPolicy?.dispose();
      } catch (error) {
        errors.push(error);
      }
      transportPolicy = null;
      browserRuntimeReady = false;
      activeTokenDigest = null;
      launchToken = null;
      projectArtifactBytes = null;
      browserRuntimeBundleBytes = null;
      try {
        await new Promise((resolve, reject) => {
          if (!server.listening) {
            resolve(undefined);
            return;
          }
          server.close((error) => (error ? reject(error) : resolve(undefined)));
        });
      } catch (error) {
        errors.push(error);
      }
      status = 'disposed';
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, 'Local preview host cleanup failed');
      }
      return snapshot();
    })();
    return disposePromise;
  }

  return Object.freeze({start, getLaunchUrl, dispose, getSnapshot: snapshot});
}
