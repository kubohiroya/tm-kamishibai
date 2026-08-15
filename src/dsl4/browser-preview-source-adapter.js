import {
  dsl4DefaultExternalSourceManifestFilename,
  dsl4ExternalSourceManifestFilenames,
  dsl4ProjectSourceFilenameSuffix,
  Dsl4ExternalSourceManifestError,
  parseDsl4ExternalSourceManifestSource,
  resolveDsl4ExternalSourceManifestContract,
  serializeDsl4ExternalSourceManifestSource,
  validateDsl4ExternalSourceManifestContract,
} from './external-source-manifest.js';
import {resolveDsl4FeatureFlags} from './feature-flags.js';
import {
  createDsl4EmbeddedSourceDescriptor,
  Dsl4SourceDescriptorError,
} from './source-descriptor.js';
import {deepFreeze} from './story-document.js';

const browserSourceGraphDefaultLimits = Object.freeze({
  maxSourceFiles: 64,
  maxTotalSourceBytes: 4 * 1024 * 1024,
  maxIncludeDepth: 32,
});

/** @type {Promise<{createSourceGraph: typeof import('./source-graph.js').createDsl4SourceGraph, SourceGraphError: typeof import('./source-graph.js').Dsl4SourceGraphError, createGeneration: typeof import('./preview-source-graph-generation.js').createDsl4PreviewSourceGraphGeneration}> | null} */
let sourceGraphModulesPromise = null;

function loadSourceGraphModules() {
  sourceGraphModulesPromise ??= Promise.all([
    import('./source-graph.js'),
    import('./preview-source-graph-generation.js'),
  ]).then(([sourceGraph, previewGeneration]) => ({
    createSourceGraph: sourceGraph.createDsl4SourceGraph,
    SourceGraphError: sourceGraph.Dsl4SourceGraphError,
    createGeneration: previewGeneration.createDsl4PreviewSourceGraphGeneration,
  }));
  return sourceGraphModulesPromise;
}

export const dsl4BrowserPreviewSourceDefaults = deepFreeze({
  manifestFilename: dsl4DefaultExternalSourceManifestFilename,
  manifestFilenames: dsl4ExternalSourceManifestFilenames,
  maxManifestBytes: 32 * 1024,
  foregroundIntervalMs: 500,
  backgroundIntervalMs: 5_000,
  quietWindowMs: 100,
  retryIntervalMs: 50,
  stabilityTimeoutMs: 2_000,
  stableReadCount: 2,
});

/** @type {Readonly<Record<string, string>>} */
const diagnosticMessages = Object.freeze({
  'K4-WEB-PREVIEW-UNSUPPORTED': 'This browser cannot open a project directory for preview',
  'K4-WEB-PREVIEW-INSECURE-CONTEXT': 'Web Preview requires a secure top-level browser context',
  'K4-WEB-PREVIEW-PICKER-CANCELLED': 'Project selection was cancelled',
  'K4-WEB-PREVIEW-PERMISSION-DENIED': 'Read access to the selected project was denied',
  'K4-WEB-PREVIEW-PERMISSION-REVOKED': 'Read access to the selected project was revoked',
  'K4-WEB-PREVIEW-BACKGROUND-THROTTLED':
    'The preview page is hidden, so change detection may be delayed',
  'K4-WEB-PREVIEW-MANIFEST-MISSING': 'The selected project has no source manifest',
  'K4-WEB-PREVIEW-MANIFEST-READ-001': 'The project source manifest could not be read',
  'K4-WEB-PREVIEW-MANIFEST-JSON-001':
    'The project source manifest is not a valid UTF-8 JSON object',
  'K4-WEB-PREVIEW-MANIFEST-YAML-001':
    'The project source manifest is not a valid UTF-8 YAML mapping',
  'K4-SOURCE-MANIFEST-001': 'The project source manifest is invalid',
  'K4-SOURCE-PATH-001': 'The project source path is not allowed',
  'K4-SOURCE-AMBIGUOUS': 'The project has multiple possible entry sources',
  'K4-SOURCE-MISSING': 'The DSL 4.0 source is missing',
  'K4-SOURCE-READ-001': 'The DSL 4.0 source could not be read',
  'K4-SOURCE-FILE-001': 'The DSL 4.0 source is not a regular file',
  'K4-SOURCE-SIZE-001': 'The DSL 4.0 source exceeds the configured byte limit',
  'K4-SOURCE-UTF8-001': 'The DSL 4.0 source is not valid UTF-8',
  'K4-PREVIEW-SOURCE-UNSTABLE':
    'The DSL 4.0 source did not become stable before the preview retry limit',
  'K4-ASSET-MISSING': 'A local asset declared by the DSL 4.0 source is missing',
  'K4-ASSET-PATH-001': 'A local asset path is outside the selected project directory',
  'K4-ASSET-PERMISSION-001': 'Read access to a declared local asset was denied or revoked',
  'K4-ASSET-POSE-BUNDLE-001': 'A declared pose model directory is incomplete or invalid',
  'K4-ASSET-PREPARE-001': 'A declared preview asset could not be prepared',
  'K4-ASSET-PROJECT-DIRECTORY-REQUIRED':
    'Local file assets require opening a project directory instead of one story file',
  'K4-ASSET-LIMIT-001': 'Declared preview assets exceed a configured resource limit',
  'K4-ASSET-UNSTABLE-001': 'Declared preview assets did not become stable before the retry limit',
  'K4-INCLUDE-CYCLE': 'The DSL 4.0 source includes contain a cycle',
  'K4-INCLUDE-LIMIT-001': 'The DSL 4.0 source includes exceed a configured limit',
  'K4-INCLUDE-READ-001': 'An included DSL 4.0 source could not be read',
  'K4-INCLUDE-YAML-001': 'An included DSL 4.0 source is not valid YAML',
  'K4-INCLUDE-SOURCE-001': 'An included DSL 4.0 source must be a mapping',
  'K4-DECLARATION-DUPLICATE': 'A DSL 4.0 declaration is duplicated across sources',
});

const sourcePreparationDiagnosticCodes = new Set([
  'K4-ASSET-LIMIT-001',
  'K4-ASSET-MISSING',
  'K4-ASSET-PATH-001',
  'K4-ASSET-PERMISSION-001',
  'K4-ASSET-POSE-BUNDLE-001',
  'K4-ASSET-PREPARE-001',
  'K4-ASSET-PROJECT-DIRECTORY-REQUIRED',
  'K4-ASSET-UNSTABLE-001',
]);

export class Dsl4BrowserPreviewSourceError extends Error {
  /** @param {string} code @param {string} message @param {unknown} [cause] */
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : {cause});
    this.name = 'Dsl4BrowserPreviewSourceError';
    this.code = code;
  }
}

/** @param {string} code @param {unknown} [cause] @returns {never} */
function fail(code, cause) {
  throw new Dsl4BrowserPreviewSourceError(
    code,
    diagnosticMessages[code] ?? 'The Web Preview source adapter failed',
    cause,
  );
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @param {string} name @param {number} minimum */
function finiteMilliseconds(value, name, minimum) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new TypeError(`${name} must be a safe integer >= ${minimum}`);
  }
  return Number(value);
}

/** @param {unknown} value @param {string} name */
function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return Number(value);
}

/** @param {unknown} value @param {string} name @returns {Function | undefined} */
function optionalCallback(value, name) {
  if (value !== undefined && typeof value !== 'function') {
    throw new TypeError(`${name} must be a function`);
  }
  return value;
}

/** @param {unknown} value */
function validateClock(value) {
  if (
    !isRecord(value) ||
    typeof value.now !== 'function' ||
    typeof value.setTimeout !== 'function' ||
    typeof value.clearTimeout !== 'function' ||
    typeof value.sleep !== 'function'
  ) {
    throw new TypeError('clock must provide now, setTimeout, clearTimeout, and sleep');
  }
  return /** @type {{now: Function, setTimeout: Function, clearTimeout: Function, sleep: Function}} */ (
    value
  );
}

const defaultClock = Object.freeze({
  now: () => globalThis.performance.now(),
  /** @param {() => void} callback @param {number} milliseconds */
  setTimeout: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
  /** @param {ReturnType<typeof globalThis.setTimeout>} timer */
  clearTimeout: (timer) => globalThis.clearTimeout(timer),
  /** @param {number} milliseconds */
  sleep: (milliseconds) => new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds)),
});

/** @param {unknown} error */
function errorName(error) {
  return isRecord(error) && typeof error.name === 'string' ? error.name : '';
}

/** @param {unknown} error */
function expectedError(error) {
  return (
    error instanceof Dsl4BrowserPreviewSourceError ||
    (isRecord(error) &&
      typeof error.code === 'string' &&
      sourcePreparationDiagnosticCodes.has(error.code))
  );
}

/**
 * @param {string} code
 * @param {'error' | 'warning'} severity
 * @param {string} sourceId
 * @param {Readonly<Record<string, unknown>>} [details]
 */
function sourceDiagnostic(code, severity, sourceId, details = {}) {
  return deepFreeze({
    version: 1,
    code,
    severity,
    message:
      typeof details.message === 'string'
        ? details.message
        : (diagnosticMessages[code] ?? 'The Web Preview source could not be prepared'),
    sourceId,
    ...(typeof details.displayName === 'string' ? {displayName: details.displayName} : {}),
    range: {
      start: {line: 1, column: 1, offset: 0},
      end: {line: 1, column: 1, offset: 0},
    },
    path: typeof details.path === 'string' ? details.path : '$',
    related: [],
  });
}

/** @param {Readonly<Record<string, unknown>>} diagnostic */
function sourceFailure(diagnostic) {
  const protocolDiagnostic = Object.fromEntries(
    Object.entries(diagnostic).filter(([key]) => key !== 'displayName'),
  );
  return deepFreeze({
    ok: false,
    canonicalSource: '',
    diagnostics: [protocolDiagnostic],
    sourceSnapshot: null,
  });
}

/** @param {unknown} value */
function requireDirectoryHandle(value) {
  if (!isRecord(value) || value.kind !== 'directory' || typeof value.getFileHandle !== 'function') {
    throw new TypeError('project root must be a FileSystemDirectoryHandle');
  }
  if (value.queryPermission !== undefined && typeof value.queryPermission !== 'function') {
    throw new TypeError('project root queryPermission must be a function when present');
  }
  return /** @type {Record<string, any>} */ (value);
}

/** @param {unknown} value */
function requireFileHandle(value) {
  if (!isRecord(value) || value.kind !== 'file' || typeof value.getFile !== 'function') {
    fail('K4-SOURCE-FILE-001');
  }
  return /** @type {Record<string, any>} */ (value);
}

/** @param {Uint8Array} left @param {Uint8Array} right */
function equalBytes(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/** @param {unknown} value @param {number} maximumBytes @param {string} sizeCode @param {string} readCode */
async function readBoundedFile(value, maximumBytes, sizeCode, readCode) {
  const handle = requireFileHandle(value);
  let file;
  try {
    file = await handle.getFile();
  } catch (error) {
    fail(readCode, error);
  }
  if (
    !isRecord(file) ||
    !Number.isSafeInteger(file.size) ||
    Number(file.size) < 0 ||
    typeof file.arrayBuffer !== 'function'
  ) {
    fail(readCode);
  }
  if (Number(file.size) > maximumBytes) fail(sizeCode);
  let buffer;
  try {
    buffer = await file.arrayBuffer();
  } catch (error) {
    fail(readCode, error);
  }
  if (!(buffer instanceof ArrayBuffer)) fail(readCode);
  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength > maximumBytes || bytes.byteLength !== Number(file.size)) fail(sizeCode);
  return bytes;
}

/** @param {Uint8Array} bytes @param {string} code */
function decodeUtf8(bytes, code) {
  try {
    return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  } catch (error) {
    fail(code, error);
  }
}

/** @param {Record<string, any>} root @param {string} sourcePath */
async function resolveSourceHandle(root, sourcePath) {
  const segments = sourcePath.split('/');
  if (
    sourcePath.length === 0 ||
    sourcePath.startsWith('/') ||
    sourcePath.includes('\\') ||
    sourcePath.includes('\0') ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(sourcePath) ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    fail('K4-SOURCE-PATH-001');
  }
  try {
    let parent = root;
    for (const segment of segments.slice(0, -1)) {
      if (typeof parent.getDirectoryHandle !== 'function') fail('K4-SOURCE-PATH-001');
      parent = await parent.getDirectoryHandle(segment);
      if (!isRecord(parent) || parent.kind !== 'directory') fail('K4-SOURCE-PATH-001');
    }
    return requireFileHandle(await parent.getFileHandle(segments.at(-1)));
  } catch (error) {
    if (expectedError(error)) throw error;
    if (errorName(error) === 'TypeMismatchError') fail('K4-SOURCE-FILE-001', error);
    if (errorName(error) === 'NotFoundError') fail('K4-SOURCE-MISSING', error);
    fail('K4-SOURCE-READ-001', error);
  }
}

/** @param {unknown} value */
function validateSourceFrontend(value) {
  if (!isRecord(value) || typeof value.parse !== 'function') {
    throw new TypeError('sourceFrontend must provide parse');
  }
  return /** @type {{parse(source: string, options?: {sourceId?: string}): Readonly<Record<string, any>>}} */ (
    value
  );
}

/** @param {unknown} value */
function validateDocument(value) {
  if (value === undefined || value === null) return null;
  if (
    !isRecord(value) ||
    typeof value.addEventListener !== 'function' ||
    typeof value.removeEventListener !== 'function'
  ) {
    throw new TypeError('document must provide visibility event methods');
  }
  return /** @type {Record<string, any>} */ (value);
}

/**
 * Inspect only stable platform capabilities without reading browser identity or user agent data.
 *
 * @param {object} [options]
 * @param {Record<string, any>} [options.globalObject]
 */
export function inspectDsl4BrowserPreviewSupport({globalObject = globalThis} = {}) {
  if (!isRecord(globalObject)) throw new TypeError('globalObject must be an object');
  if (globalObject.isSecureContext !== true) {
    return deepFreeze({
      supported: false,
      code: 'K4-WEB-PREVIEW-INSECURE-CONTEXT',
      secureContext: false,
      topLevel: false,
      directoryPicker: typeof globalObject.showDirectoryPicker === 'function',
    });
  }
  let topLevel = false;
  try {
    topLevel = globalObject.self === globalObject.top;
  } catch {
    topLevel = false;
  }
  const directoryPicker = typeof globalObject.showDirectoryPicker === 'function';
  const supported = topLevel && directoryPicker;
  return deepFreeze({
    supported,
    code: supported ? null : 'K4-WEB-PREVIEW-UNSUPPORTED',
    secureContext: true,
    topLevel,
    directoryPicker,
  });
}

/**
 * Adapt one File System Access file handle to the project-root contract used by the watched source
 * adapter. The synthetic root deliberately cannot resolve sibling local assets.
 *
 * @param {unknown} fileHandleInput
 */
export function createDsl4BrowserPreviewStoryFileProject(fileHandleInput) {
  const fileHandle = requireFileHandle(fileHandleInput);
  const sourceName = typeof fileHandle.name === 'string' ? fileHandle.name : '';
  const manifest = validateDsl4ExternalSourceManifestContract({
    formatVersion: 1,
    mode: 'external',
    sourceId: 'main',
    path: sourceName,
  });
  const manifestBytes = new TextEncoder().encode(
    serializeDsl4ExternalSourceManifestSource(manifest, {
      filename: dsl4DefaultExternalSourceManifestFilename,
    }),
  );
  const notFound = () => {
    const error = new Error('The requested file does not exist in this source-only project');
    error.name = 'NotFoundError';
    return error;
  };
  const manifestHandle = Object.freeze({
    kind: 'file',
    name: dsl4BrowserPreviewSourceDefaults.manifestFilename,
    async getFile() {
      return {
        name: dsl4BrowserPreviewSourceDefaults.manifestFilename,
        size: manifestBytes.byteLength,
        async arrayBuffer() {
          return manifestBytes.slice().buffer;
        },
      };
    },
  });
  return Object.freeze({
    kind: 'directory',
    name: sourceName,
    dsl4SourceOnly: true,
    async queryPermission(options = {mode: 'read'}) {
      return typeof fileHandle.queryPermission === 'function'
        ? fileHandle.queryPermission(options)
        : 'granted';
    },
    /** @param {string} name */
    async getFileHandle(name) {
      if (name === dsl4BrowserPreviewSourceDefaults.manifestFilename) return manifestHandle;
      if (name === sourceName) return fileHandle;
      throw notFound();
    },
  });
}

/**
 * Watch one user-selected project root without retaining it outside this adapter instance.
 *
 * @param {object} options
 * @param {{parse(source: string, options?: {sourceId?: string}): Readonly<Record<string, any>>}} options.sourceFrontend
 * @param {number} options.maxSourceBytes
 * @param {unknown} [options.featureFlags]
 * @param {number} [options.maxSourceFiles]
 * @param {number} [options.maxTotalSourceBytes]
 * @param {number} [options.maxIncludeDepth]
 * @param {(result: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>} options.onResult
 * @param {(diagnostic: Readonly<Record<string, unknown>> | null) => unknown | Promise<unknown>} [options.onDiagnostic]
 * @param {(state: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>} [options.onStatus]
 * @param {(error: unknown) => unknown} [options.onError]
 * @param {(projectRoot: Record<string, any>) => unknown | Promise<unknown>} [options.onProjectRoot]
 * @param {Record<string, any>} [options.globalObject]
 * @param {Record<string, any>} [options.document]
 * @param {Function} [options.showDirectoryPicker]
 * @param {number} [options.maxManifestBytes]
 * @param {number} [options.foregroundIntervalMs]
 * @param {number} [options.backgroundIntervalMs]
 * @param {number} [options.quietWindowMs]
 * @param {number} [options.retryIntervalMs]
 * @param {number} [options.stabilityTimeoutMs]
 * @param {{digest: Function}} [options.subtleCrypto]
 * @param {{now: Function, setTimeout: Function, clearTimeout: Function, sleep: Function}} [options.clock]
 * @param {(input: unknown) => Readonly<Record<string, any>>} [options.validateManifest]
 * @param {(source: string, options: Record<string, unknown>) => Promise<Readonly<Record<string, any>>>} [options.createSourceDescriptor]
 * @param {typeof import('./source-graph.js').createDsl4SourceGraph} [options.createSourceGraph]
 * @param {typeof import('./preview-source-graph-generation.js').createDsl4PreviewSourceGraphGeneration} [options.createSourceGraphGeneration]
 */
export function createDsl4BrowserPreviewSourceAdapter(options) {
  if (!isRecord(options)) throw new TypeError('browser preview source options must be an object');
  const sourceFrontend = validateSourceFrontend(options.sourceFrontend);
  const maxSourceBytes = positiveInteger(options.maxSourceBytes, 'maxSourceBytes');
  const featureFlags = resolveDsl4FeatureFlags(options.featureFlags ?? {});
  const sourceGraphLimits = featureFlags.dsl4SourceIncludes
    ? {
        maxSourceFiles: positiveInteger(
          options.maxSourceFiles ?? browserSourceGraphDefaultLimits.maxSourceFiles,
          'maxSourceFiles',
        ),
        maxSourceBytes,
        maxTotalSourceBytes: positiveInteger(
          options.maxTotalSourceBytes ?? browserSourceGraphDefaultLimits.maxTotalSourceBytes,
          'maxTotalSourceBytes',
        ),
        maxIncludeDepth: positiveInteger(
          options.maxIncludeDepth ?? browserSourceGraphDefaultLimits.maxIncludeDepth,
          'maxIncludeDepth',
        ),
      }
    : null;
  if (
    sourceGraphLimits &&
    Number(sourceGraphLimits.maxTotalSourceBytes) < Number(sourceGraphLimits.maxSourceBytes)
  ) {
    throw new TypeError('maxTotalSourceBytes must be greater than or equal to maxSourceBytes');
  }
  if (typeof options.onResult !== 'function') throw new TypeError('onResult must be a function');
  const onResult = options.onResult;
  const onDiagnostic = optionalCallback(options.onDiagnostic, 'onDiagnostic');
  const onStatus = optionalCallback(options.onStatus, 'onStatus');
  const onError = optionalCallback(options.onError, 'onError');
  const onProjectRoot = optionalCallback(options.onProjectRoot, 'onProjectRoot');
  const globalObject = /** @type {Record<string, any>} */ (
    isRecord(options.globalObject) ? options.globalObject : globalThis
  );
  const document = validateDocument(options.document ?? globalObject.document);
  const picker = options.showDirectoryPicker ?? globalObject.showDirectoryPicker;
  if (picker !== undefined && typeof picker !== 'function') {
    throw new TypeError('showDirectoryPicker must be a function');
  }
  const maxManifestBytes = positiveInteger(
    options.maxManifestBytes ?? dsl4BrowserPreviewSourceDefaults.maxManifestBytes,
    'maxManifestBytes',
  );
  const foregroundIntervalMs = finiteMilliseconds(
    options.foregroundIntervalMs ?? dsl4BrowserPreviewSourceDefaults.foregroundIntervalMs,
    'foregroundIntervalMs',
    1,
  );
  const backgroundIntervalMs = finiteMilliseconds(
    options.backgroundIntervalMs ?? dsl4BrowserPreviewSourceDefaults.backgroundIntervalMs,
    'backgroundIntervalMs',
    foregroundIntervalMs,
  );
  const quietWindowMs = finiteMilliseconds(
    options.quietWindowMs ?? dsl4BrowserPreviewSourceDefaults.quietWindowMs,
    'quietWindowMs',
    0,
  );
  const retryIntervalMs = finiteMilliseconds(
    options.retryIntervalMs ?? dsl4BrowserPreviewSourceDefaults.retryIntervalMs,
    'retryIntervalMs',
    1,
  );
  const stabilityTimeoutMs = finiteMilliseconds(
    options.stabilityTimeoutMs ?? dsl4BrowserPreviewSourceDefaults.stabilityTimeoutMs,
    'stabilityTimeoutMs',
    retryIntervalMs,
  );
  const maximumAttempts = Math.ceil(stabilityTimeoutMs / retryIntervalMs) + 1;
  const rawSourceLimit = Math.min(Number.MAX_SAFE_INTEGER, maxSourceBytes * 2 + 3);
  const subtleCrypto = options.subtleCrypto ?? globalObject.crypto?.subtle;
  const clock = validateClock(options.clock ?? defaultClock);
  const validateManifest = options.validateManifest ?? validateDsl4ExternalSourceManifestContract;
  const createSourceDescriptor =
    options.createSourceDescriptor ?? createDsl4EmbeddedSourceDescriptor;
  const createSourceGraph = featureFlags.dsl4SourceIncludes ? options.createSourceGraph : null;
  const createSourceGraphGeneration = featureFlags.dsl4SourceIncludes
    ? options.createSourceGraphGeneration
    : null;
  if (typeof validateManifest !== 'function') {
    throw new TypeError('validateManifest must be a function');
  }
  if (typeof createSourceDescriptor !== 'function') {
    throw new TypeError('createSourceDescriptor must be a function');
  }
  if (
    featureFlags.dsl4SourceIncludes &&
    createSourceGraph !== undefined &&
    typeof createSourceGraph !== 'function'
  ) {
    throw new TypeError('createSourceGraph must be a function');
  }
  if (
    featureFlags.dsl4SourceIncludes &&
    createSourceGraphGeneration !== undefined &&
    typeof createSourceGraphGeneration !== 'function'
  ) {
    throw new TypeError('createSourceGraphGeneration must be a function');
  }

  let started = false;
  let disposed = false;
  let hidden = document?.visibilityState === 'hidden' || document?.hidden === true;
  /** @type {'idle' | 'selecting' | 'loading-manifest' | 'stabilizing' | 'watching-visible' | 'background-throttled' | 'diagnostic' | 'disposed'} */
  let status = 'idle';
  let generation = 0;
  let revision = 0;
  let published = 0;
  let activeReads = 0;
  let maximumObservedConcurrentReads = 0;
  /** @type {Record<string, any> | null} */
  let rootHandle = null;
  /** @type {Readonly<Record<string, any>> | null} */
  let manifest = null;
  /** @type {string | null} */
  let activeManifestFilename = null;
  let permissionWasGranted = false;
  let publicationKey = '';
  /** @type {Readonly<Record<string, unknown>> | null} */
  let lastPublication = null;
  /** @type {Readonly<Record<string, unknown>> | null} */
  let currentDiagnostic = null;
  /** @type {any} */
  let pollTimer = null;
  /** @type {Promise<Readonly<Record<string, unknown>>> | null} */
  let cyclePromise = null;
  let rerunRequested = false;
  let listenersAttached = false;

  function snapshot() {
    return deepFreeze({
      version: 1,
      status,
      started,
      disposed,
      hidden,
      generation,
      revision,
      published,
      activeReads,
      maximumObservedConcurrentReads,
      sourceId: manifest?.sourceId ?? null,
      sourceDisplayName: manifest ? manifest.path.split('/').at(-1) : null,
      lastPublication,
      diagnostic: currentDiagnostic,
    });
  }

  /** @param {Function | undefined} observer @param {...unknown} values */
  async function notify(observer, ...values) {
    if (!observer) return;
    try {
      await observer(...values);
    } catch (error) {
      try {
        onError?.(error);
      } catch {
        // Error observers cannot change adapter state.
      }
    }
  }

  async function notifyStatus() {
    await notify(onStatus, snapshot());
  }

  /** @param {string} next */
  async function setStatus(next) {
    status = /** @type {typeof status} */ (next);
    await notifyStatus();
  }

  /** @param {Readonly<Record<string, unknown>> | null} diagnostic */
  async function setDiagnostic(diagnostic) {
    const previousCode = currentDiagnostic?.code ?? null;
    const nextCode = diagnostic?.code ?? null;
    currentDiagnostic = diagnostic;
    if (previousCode !== nextCode) await notify(onDiagnostic, diagnostic);
  }

  /** @param {Readonly<Record<string, any>>} result @param {string} key */
  async function publish(result, key) {
    if (disposed || key === publicationKey) return;
    await onResult(result);
    if (disposed) return;
    publicationKey = key;
    published += 1;
    const diagnostics = /** @type {ReadonlyArray<Record<string, unknown>>} */ (
      result.diagnostics ?? []
    );
    const descriptor = /** @type {Record<string, unknown> | null} */ (
      result.sourceSnapshot ?? null
    );
    lastPublication = deepFreeze(
      descriptor
        ? {
            kind: 'source',
            integrity: descriptor.integrity,
            ok: result.ok,
            diagnosticCount: diagnostics.length,
          }
        : {
            kind: 'diagnostic',
            code: diagnostics[0]?.code ?? 'K4-WEB-PREVIEW-INTERNAL',
            severity: diagnostics[0]?.severity ?? 'error',
          },
    );
  }

  /**
   * @param {string} code
   * @param {'error' | 'warning'} severity
   * @param {boolean} stage
   * @param {unknown} [failure]
   */
  async function publishDiagnostic(code, severity, stage, failure) {
    const manifestFilename = activeManifestFilename;
    const sourceFile = manifest?.path ?? null;
    const manifestDiagnostic = code.includes('MANIFEST');
    const entryResolutionDiagnostic =
      sourceFile === null && ['K4-SOURCE-MISSING', 'K4-SOURCE-AMBIGUOUS'].includes(code);
    const displayName =
      isRecord(failure) && typeof failure.displayName === 'string'
        ? failure.displayName
        : entryResolutionDiagnostic
          ? `*${dsl4ProjectSourceFilenameSuffix}`
          : manifestDiagnostic || sourceFile === null
            ? (manifestFilename ?? dsl4DefaultExternalSourceManifestFilename)
            : sourceFile;
    const missingMessage =
      code === 'K4-WEB-PREVIEW-MANIFEST-MISSING'
        ? `Required project file is missing: ${dsl4ExternalSourceManifestFilenames.join(' or ')}`
        : code === 'K4-SOURCE-MISSING' && sourceFile
          ? `Required story file is missing: ${sourceFile}`
          : entryResolutionDiagnostic
            ? code === 'K4-SOURCE-AMBIGUOUS'
              ? `Project root contains multiple ${dsl4ProjectSourceFilenameSuffix} entry sources; select one explicitly`
              : `Project root contains no ${dsl4ProjectSourceFilenameSuffix} entry source`
            : null;
    const diagnostic = sourceDiagnostic(code, severity, manifest?.sourceId ?? 'main', {
      displayName,
      ...(isRecord(failure) && typeof failure.path === 'string' ? {path: failure.path} : {}),
      ...(isRecord(failure) && typeof failure.message === 'string' && code.startsWith('K4-ASSET-')
        ? {message: failure.message}
        : missingMessage === null
          ? {}
          : {message: missingMessage}),
    });
    await setDiagnostic(diagnostic);
    if (stage) {
      await publish(sourceFailure(diagnostic), `diagnostic:${code}`);
    }
  }

  function cancelPollTimer() {
    if (pollTimer === null) return;
    clock.clearTimeout(pollTimer);
    pollTimer = null;
  }

  function scheduleNextPoll() {
    if (!started || disposed || cyclePromise !== null) return;
    cancelPollTimer();
    pollTimer = clock.setTimeout(
      () => {
        pollTimer = null;
        void requestPoll().catch(() => {});
      },
      hidden ? backgroundIntervalMs : foregroundIntervalMs,
    );
    if (isRecord(pollTimer) && typeof pollTimer.unref === 'function') {
      // Browser timers are numeric; Node preview tests must not keep the process alive by polling.
      pollTimer.unref();
    }
  }

  async function verifyPermission() {
    if (!rootHandle) throw new TypeError('browser preview has no project root');
    if (typeof rootHandle.queryPermission !== 'function') {
      fail(
        permissionWasGranted
          ? 'K4-WEB-PREVIEW-PERMISSION-REVOKED'
          : 'K4-WEB-PREVIEW-PERMISSION-DENIED',
      );
    }
    let permission;
    try {
      permission = await rootHandle.queryPermission({mode: 'read'});
    } catch (error) {
      fail(
        permissionWasGranted
          ? 'K4-WEB-PREVIEW-PERMISSION-REVOKED'
          : 'K4-WEB-PREVIEW-PERMISSION-DENIED',
        error,
      );
    }
    if (permission !== 'granted') {
      fail(
        permissionWasGranted
          ? 'K4-WEB-PREVIEW-PERMISSION-REVOKED'
          : 'K4-WEB-PREVIEW-PERMISSION-DENIED',
      );
    }
    permissionWasGranted = true;
  }

  async function readEntrySourcePaths() {
    if (!rootHandle) throw new TypeError('browser preview has no project root');
    if (typeof rootHandle.entries !== 'function') fail('K4-SOURCE-READ-001');
    const paths = [];
    try {
      for await (const entry of rootHandle.entries()) {
        if (!Array.isArray(entry) || entry.length !== 2) fail('K4-SOURCE-READ-001');
        const [name, handle] = entry;
        if (
          typeof name === 'string' &&
          isRecord(handle) &&
          handle.kind === 'file' &&
          name.endsWith(dsl4ProjectSourceFilenameSuffix)
        ) {
          paths.push(name);
          if (paths.length === 2) break;
        }
      }
    } catch (error) {
      if (expectedError(error)) throw error;
      fail('K4-SOURCE-READ-001', error);
    }
    return paths.sort();
  }

  async function readManifestSnapshot() {
    if (!rootHandle) throw new TypeError('browser preview has no project root');
    let selected = null;
    for (const filename of dsl4ExternalSourceManifestFilenames) {
      let handle;
      try {
        handle = await rootHandle.getFileHandle(filename);
      } catch (error) {
        if (errorName(error) === 'NotFoundError') continue;
        fail('K4-WEB-PREVIEW-MANIFEST-READ-001', error);
      }
      const bytes = await readBoundedFile(
        handle,
        maxManifestBytes,
        'K4-WEB-PREVIEW-MANIFEST-READ-001',
        'K4-WEB-PREVIEW-MANIFEST-READ-001',
      );
      selected = {filename, bytes};
      break;
    }
    /** @type {Record<string, any>} */
    let input = {};
    if (selected !== null) {
      try {
        const syntaxCode = /\.ya?ml$/u.test(selected.filename)
          ? 'K4-WEB-PREVIEW-MANIFEST-YAML-001'
          : 'K4-WEB-PREVIEW-MANIFEST-JSON-001';
        input = parseDsl4ExternalSourceManifestSource(decodeUtf8(selected.bytes, syntaxCode), {
          filename: selected.filename,
        });
      } catch (error) {
        if (expectedError(error)) throw error;
        if (error instanceof Dsl4ExternalSourceManifestError) {
          if (error.code === 'K4-SOURCE-MANIFEST-YAML-001') {
            fail('K4-WEB-PREVIEW-MANIFEST-YAML-001', error);
          }
          if (error.code === 'K4-SOURCE-MANIFEST-JSON-001') {
            fail('K4-WEB-PREVIEW-MANIFEST-JSON-001', error);
          }
          fail(error.code, error);
        }
        throw error;
      }
    }
    const sourcePaths = input.path === undefined ? await readEntrySourcePaths() : [];
    return {
      filename: selected?.filename ?? null,
      bytes: selected?.bytes ?? new Uint8Array(),
      input,
      sourcePaths,
    };
  }

  /** @param {number} requestedGeneration */
  async function loadStableManifest(requestedGeneration) {
    await setStatus('loading-manifest');
    const first = await readManifestSnapshot();
    await clock.sleep(quietWindowMs);
    if (disposed || requestedGeneration !== generation) return null;
    const second = await readManifestSnapshot();
    if (
      first.filename !== second.filename ||
      !equalBytes(first.bytes, second.bytes) ||
      JSON.stringify(first.sourcePaths) !== JSON.stringify(second.sourcePaths)
    ) {
      fail('K4-WEB-PREVIEW-MANIFEST-READ-001');
    }
    activeManifestFilename = second.filename;
    let resolved;
    try {
      resolved = resolveDsl4ExternalSourceManifestContract(second.input, {
        sourcePaths: second.sourcePaths,
      });
    } catch (error) {
      if (expectedError(error)) throw error;
      if (error instanceof Dsl4ExternalSourceManifestError) {
        fail(error.code, error);
      }
      throw error;
    }
    try {
      return validateManifest(resolved);
    } catch (error) {
      if (error instanceof Dsl4ExternalSourceManifestError) fail(error.code, error);
      throw error;
    }
  }

  async function readSourceDescriptor() {
    if (!rootHandle || !manifest) throw new TypeError('browser preview source is not configured');
    const handle = await resolveSourceHandle(rootHandle, manifest.path);
    const bytes = await readBoundedFile(
      handle,
      rawSourceLimit,
      'K4-SOURCE-SIZE-001',
      'K4-SOURCE-READ-001',
    );
    const source = decodeUtf8(bytes, 'K4-SOURCE-UTF8-001');
    try {
      return await createSourceDescriptor(source, {
        sourceId: manifest.sourceId,
        displayName: manifest.path.split('/').at(-1),
        maxSourceBytes,
        ...(manifest.cacheId === undefined
          ? {}
          : {
              cacheIdentity: {
                id: manifest.cacheId,
                label: manifest.path.split('/').at(-1),
                databaseName: manifest.cacheDatabaseName,
              },
            }),
        subtleCrypto,
      });
    } catch (error) {
      if (error instanceof Dsl4SourceDescriptorError) fail(error.code, error);
      throw error;
    }
  }

  /** @param {Record<string, any>} error */
  function graphFailure(error) {
    const range = error.range ?? {
      start: {line: 1, column: 1, offset: 0},
      end: {line: 1, column: 1, offset: 0},
    };
    return deepFreeze({
      ok: false,
      canonicalSource: '',
      diagnostics: [
        {
          version: 1,
          code: error.code,
          severity: 'error',
          message: diagnosticMessages[error.code] ?? 'The Source Graph is invalid',
          sourceId: error.sourceId ?? manifest?.sourceId ?? 'main',
          range,
          path: '$',
          related: (Array.isArray(error.related) ? error.related : []).map((related) => ({
            message: 'Related Source Graph declaration',
            sourceId: related.sourceId,
            range: related.range,
          })),
        },
      ],
      sourceSnapshot: null,
    });
  }

  async function readSourceGraphGeneration() {
    if (!rootHandle || !manifest || !sourceGraphLimits) {
      throw new TypeError('browser preview Source Graph is not configured');
    }
    const projectRoot = rootHandle;
    const graphModules = await loadSourceGraphModules();
    const graphFactory = createSourceGraph ?? graphModules.createSourceGraph;
    const generationFactory = createSourceGraphGeneration ?? graphModules.createGeneration;
    let graph;
    try {
      graph = await graphFactory(manifest.path, {
        limits: sourceGraphLimits,
        async readSource(sourcePath, maximumBytes) {
          try {
            const handle = await resolveSourceHandle(projectRoot, sourcePath);
            return await readBoundedFile(
              handle,
              Math.min(Number.MAX_SAFE_INTEGER, maximumBytes * 2 + 3),
              'K4-SOURCE-SIZE-001',
              'K4-SOURCE-READ-001',
            );
          } catch (error) {
            if (!(error instanceof Dsl4BrowserPreviewSourceError)) throw error;
            throw new graphModules.SourceGraphError(error.code, error.message, {
              sourceId: sourcePath,
              sourcePath,
              cause: error,
            });
          }
        },
      });
    } catch (error) {
      if (!(error instanceof graphModules.SourceGraphError)) throw error;
      if (['K4-SOURCE-MISSING', 'K4-PREVIEW-SOURCE-UNSTABLE'].includes(error.code)) {
        fail(error.code, error);
      }
      return {
        key: `diagnostic:${error.code}:${error.sourceId ?? 'main'}`,
        result: graphFailure(error),
      };
    }
    return generationFactory(graph, {
      sourceFrontend,
      sourceId: manifest.sourceId,
      displayName: manifest.path.split('/').at(-1),
      maxComposedSourceBytes: sourceGraphLimits.maxTotalSourceBytes,
      subtleCrypto,
    });
  }

  /** @param {number} requestedGeneration */
  async function readStableSource(requestedGeneration) {
    const first = await readSourceDescriptor();
    await clock.sleep(quietWindowMs);
    if (disposed || requestedGeneration !== generation) return null;
    const second = await readSourceDescriptor();
    if (first.integrity !== second.integrity) fail('K4-PREVIEW-SOURCE-UNSTABLE');
    return second;
  }

  /** @param {number} requestedGeneration */
  async function readStableSourceGraph(requestedGeneration) {
    const first = await readSourceGraphGeneration();
    await clock.sleep(quietWindowMs);
    if (disposed || requestedGeneration !== generation) return null;
    const second = await readSourceGraphGeneration();
    if (first.key !== second.key) fail('K4-PREVIEW-SOURCE-UNSTABLE');
    return second;
  }

  /** @param {number} requestedGeneration */
  async function runCycle(requestedGeneration) {
    if (disposed || requestedGeneration !== generation) return snapshot();
    revision += 1;
    activeReads += 1;
    maximumObservedConcurrentReads = Math.max(maximumObservedConcurrentReads, activeReads);
    await setStatus('stabilizing');
    try {
      await verifyPermission();
      if (!manifest) {
        manifest = await loadStableManifest(requestedGeneration);
        if (!manifest || disposed || requestedGeneration !== generation) return snapshot();
      }
      const startedAt = Number(clock.now());
      let attempts = 0;
      /** @type {unknown} */
      let lastTransient = null;
      /** @type {Readonly<Record<string, any>> | null} */
      let prepared = null;
      while (!disposed && requestedGeneration === generation) {
        attempts += 1;
        try {
          if (featureFlags.dsl4SourceIncludes) {
            prepared = await readStableSourceGraph(requestedGeneration);
          } else {
            const descriptor = await readStableSource(requestedGeneration);
            if (descriptor) prepared = {key: descriptor.integrity, descriptor};
          }
          break;
        } catch (error) {
          const transientCode = isRecord(error) && typeof error.code === 'string' ? error.code : '';
          if (
            !expectedError(error) ||
            ![
              'K4-ASSET-MISSING',
              'K4-ASSET-UNSTABLE-001',
              'K4-SOURCE-MISSING',
              'K4-PREVIEW-SOURCE-UNSTABLE',
            ].includes(transientCode)
          ) {
            throw error;
          }
          if (
            lastPublication === null &&
            ['K4-ASSET-MISSING', 'K4-SOURCE-MISSING'].includes(transientCode)
          ) {
            throw error;
          }
          lastTransient = error;
        }
        const elapsed = Number(clock.now()) - startedAt;
        if (elapsed >= stabilityTimeoutMs || attempts >= maximumAttempts) throw lastTransient;
        await clock.sleep(Math.min(retryIntervalMs, stabilityTimeoutMs - elapsed));
      }
      if (!prepared || disposed || requestedGeneration !== generation) return snapshot();
      let result;
      if (featureFlags.dsl4SourceIncludes) {
        result = prepared.result;
      } else {
        const descriptor = prepared.descriptor;
        const parsed = sourceFrontend.parse(descriptor.text, {sourceId: manifest.sourceId});
        if (
          !isRecord(parsed) ||
          typeof parsed.ok !== 'boolean' ||
          !Array.isArray(parsed.diagnostics)
        ) {
          throw new TypeError('sourceFrontend returned an invalid result');
        }
        result = deepFreeze({...parsed, sourceSnapshot: descriptor});
      }
      await publish(result, `source:${prepared.key}`);
      if (hidden) {
        await publishDiagnostic('K4-WEB-PREVIEW-BACKGROUND-THROTTLED', 'warning', false);
      } else {
        await setDiagnostic(null);
      }
      if (!disposed && requestedGeneration === generation) {
        await setStatus(hidden ? 'background-throttled' : 'watching-visible');
      }
      return snapshot();
    } catch (error) {
      if (disposed || requestedGeneration !== generation) return snapshot();
      if (!expectedError(error)) throw error;
      const code = isRecord(error) && typeof error.code === 'string' ? error.code : '';
      const severity =
        code === 'K4-PREVIEW-SOURCE-UNSTABLE' || code === 'K4-ASSET-UNSTABLE-001'
          ? 'warning'
          : 'error';
      const stage = ![
        'K4-WEB-PREVIEW-MANIFEST-MISSING',
        'K4-WEB-PREVIEW-MANIFEST-READ-001',
        'K4-WEB-PREVIEW-MANIFEST-JSON-001',
        'K4-WEB-PREVIEW-MANIFEST-YAML-001',
        'K4-SOURCE-MANIFEST-001',
        'K4-SOURCE-PATH-001',
        'K4-WEB-PREVIEW-PERMISSION-DENIED',
      ].includes(code);
      await publishDiagnostic(code, severity, stage, error);
      await setStatus('diagnostic');
      return snapshot();
    } finally {
      activeReads -= 1;
    }
  }

  function requestPoll() {
    if (!started || disposed) throw new TypeError('browser preview source adapter is not active');
    cancelPollTimer();
    if (cyclePromise) {
      rerunRequested = true;
      return cyclePromise;
    }
    const requestedGeneration = generation;
    cyclePromise = (async () => {
      do {
        rerunRequested = false;
        await runCycle(requestedGeneration);
      } while (rerunRequested && !disposed && requestedGeneration === generation);
      return snapshot();
    })();
    cyclePromise = cyclePromise.then(
      async (state) => {
        cyclePromise = null;
        scheduleNextPoll();
        return state;
      },
      async (error) => {
        cyclePromise = null;
        if (!disposed) {
          await setStatus('diagnostic');
          try {
            onError?.(error);
          } catch {
            // Error observers cannot change adapter state.
          }
          scheduleNextPoll();
        }
        throw error;
      },
    );
    return cyclePromise;
  }

  async function onVisibilityChange() {
    if (!started || disposed || !document) return;
    const nextHidden = document.visibilityState === 'hidden' || document.hidden === true;
    if (hidden === nextHidden) return;
    hidden = nextHidden;
    cancelPollTimer();
    if (hidden) {
      await publishDiagnostic('K4-WEB-PREVIEW-BACKGROUND-THROTTLED', 'warning', false);
      await setStatus('background-throttled');
      if (!cyclePromise) scheduleNextPoll();
      return;
    }
    await setDiagnostic(null);
    void requestPoll().catch(() => {});
  }

  function onPageHide() {
    dispose();
  }

  function attachListeners() {
    if (!document || listenersAttached) return;
    document.addEventListener('visibilitychange', onVisibilityChange);
    document.addEventListener('pagehide', onPageHide);
    listenersAttached = true;
  }

  function detachListeners() {
    if (!document || !listenersAttached) return;
    document.removeEventListener('visibilitychange', onVisibilityChange);
    document.removeEventListener('pagehide', onPageHide);
    listenersAttached = false;
  }

  /** @param {unknown} projectRoot */
  async function start(projectRoot) {
    if (started || disposed) {
      throw new TypeError('browser preview source adapter can only start once');
    }
    const selectedRoot = requireDirectoryHandle(projectRoot);
    await onProjectRoot?.(selectedRoot);
    rootHandle = selectedRoot;
    started = true;
    generation += 1;
    attachListeners();
    return requestPoll();
  }

  async function openProject() {
    if (started || disposed) {
      throw new TypeError('browser preview source adapter can only open one project');
    }
    const support = inspectDsl4BrowserPreviewSupport({globalObject});
    if (!support.supported) {
      await publishDiagnostic(/** @type {string} */ (support.code), 'error', false);
      await setStatus('diagnostic');
      return snapshot();
    }
    if (typeof picker !== 'function') {
      await publishDiagnostic('K4-WEB-PREVIEW-UNSUPPORTED', 'error', false);
      await setStatus('diagnostic');
      return snapshot();
    }
    status = 'selecting';
    const selection = (() => {
      try {
        return Promise.resolve(picker.call(globalObject, {mode: 'read'}));
      } catch (error) {
        return Promise.reject(error);
      }
    })();
    await notifyStatus();
    let projectRoot;
    try {
      projectRoot = await selection;
    } catch (error) {
      const name = errorName(error);
      const code =
        name === 'AbortError'
          ? 'K4-WEB-PREVIEW-PICKER-CANCELLED'
          : name === 'SecurityError'
            ? 'K4-WEB-PREVIEW-INSECURE-CONTEXT'
            : 'K4-WEB-PREVIEW-PERMISSION-DENIED';
      await publishDiagnostic(code, code.endsWith('CANCELLED') ? 'warning' : 'error', false);
      await setStatus('diagnostic');
      return snapshot();
    }
    return start(projectRoot);
  }

  function dispose() {
    if (disposed) return snapshot();
    disposed = true;
    generation += 1;
    rerunRequested = false;
    cancelPollTimer();
    detachListeners();
    rootHandle = null;
    manifest = null;
    permissionWasGranted = false;
    currentDiagnostic = null;
    status = 'disposed';
    void notifyStatus();
    return snapshot();
  }

  return Object.freeze({
    openProject,
    start,
    pollNow: requestPoll,
    dispose,
    getState: snapshot,
    async whenIdle() {
      while (cyclePromise) await cyclePromise;
      return snapshot();
    },
  });
}
