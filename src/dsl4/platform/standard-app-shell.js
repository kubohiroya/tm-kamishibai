import {resolveDsl4FeatureFlags} from '../feature-flags.js';
import {deepFreeze} from '../story-document.js';
import {createDsl4TurboWarpRuntimeHost} from './turbowarp-runtime-host.js';

const optionKeys = new Set([
  'createRuntimeHost',
  'document',
  'featureFlags',
  'mount',
  'poseFeedbackLabels',
  'runtimeHostOptions',
  'surface',
]);
const runtimeHostReservedKeys = new Set(['featureFlags', 'poseFeedbackPresenter']);
const supportedSurfaces = new Set(['webPlayer', 'regularEditor', 'packager', 'developmentPreview']);

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @param {string} name */
function requireElement(value, name) {
  if (!isRecord(value) || typeof value.appendChild !== 'function') {
    throw new TypeError(`${name} must be a DOM element`);
  }
  return /** @type {any} */ (value);
}

/** @param {unknown} value */
function requireDocument(value) {
  if (!isRecord(value) || typeof value.createElement !== 'function') {
    throw new TypeError('document must provide the DOM document contract');
  }
  return /** @type {any} */ (value);
}

/** @param {unknown} value */
function requireSurface(value) {
  if (typeof value !== 'string' || !supportedSurfaces.has(value)) {
    throw new TypeError(`surface must be one of ${[...supportedSurfaces].sort().join(', ')}`);
  }
  return value;
}

/** @param {unknown} value */
function requireRuntimeHostOptions(value) {
  if (!isRecord(value)) throw new TypeError('runtimeHostOptions must be an object');
  const reserved = Object.keys(value).filter((key) => runtimeHostReservedKeys.has(key));
  if (reserved.length > 0) {
    throw new TypeError(
      `runtimeHostOptions cannot override Standard app-shell option: ${reserved.sort().join(', ')}`,
    );
  }
  return value;
}

/** @param {unknown} value */
function isRuntimeHostResult(value) {
  if (
    !isRecord(value) ||
    typeof value.ok !== 'boolean' ||
    value.enabled !== true ||
    !Array.isArray(value.diagnostics)
  ) {
    return false;
  }
  if (!value.ok) return value.host === null || value.host === undefined;
  return isRecord(value.host) && typeof value.host.dispose === 'function';
}

/**
 * Create the shared Standard app-shell composition for production and development surfaces.
 *
 * The pose feedback mount is created lazily. The TurboWarp host only reads the presenter
 * configuration for `feedback.mode: presenter`, so flag-off and Scratch modes do not inspect DOM.
 *
 * @param {object} [options]
 * @param {unknown} [options.featureFlags]
 * @param {'webPlayer' | 'regularEditor' | 'packager' | 'developmentPreview'} [options.surface]
 * @param {unknown} [options.document]
 * @param {unknown} [options.mount]
 * @param {Readonly<Record<string, unknown>>} [options.poseFeedbackLabels]
 * @param {Readonly<Record<string, unknown>>} [options.runtimeHostOptions]
 * @param {(options: Record<string, unknown>) => Promise<Readonly<Record<string, any>>>} [options.createRuntimeHost]
 */
export async function createDsl4StandardAppShell(options = {}) {
  if (!isRecord(options)) throw new TypeError('Standard app-shell options must be an object');
  const unknown = Object.keys(options).filter((key) => !optionKeys.has(key));
  if (unknown.length > 0) {
    throw new TypeError(`Unknown Standard app-shell option: ${unknown.sort().join(', ')}`);
  }
  const featureFlags = resolveDsl4FeatureFlags(options.featureFlags);
  if (!featureFlags.dsl4AppShell) {
    const snapshot = deepFreeze({
      version: 1,
      enabled: false,
      disposed: false,
      surface: null,
      featureFlags,
    });
    return Object.freeze({
      ok: true,
      enabled: false,
      featureFlags,
      surface: null,
      element: null,
      runtimeHost: null,
      diagnostics: [],
      getSnapshot: () => snapshot,
      dispose: async () => snapshot,
    });
  }

  const surface = requireSurface(options.surface);
  const runtimeHostOptions = requireRuntimeHostOptions(options.runtimeHostOptions);
  const createRuntimeHost = options.createRuntimeHost ?? createDsl4TurboWarpRuntimeHost;
  if (typeof createRuntimeHost !== 'function') {
    throw new TypeError('createRuntimeHost must be a function');
  }

  let disposed = false;
  /** @type {any | null} */
  let root = null;
  /** @type {any | null} */
  let poseFeedbackMount = null;
  /** @type {Readonly<Record<string, any>> | null} */
  let runtimeResult = null;
  /** @type {Promise<Readonly<Record<string, unknown>>> | null} */
  let disposePromise = null;

  function ensurePoseFeedbackMount() {
    if (disposed) throw new TypeError('Standard app shell is disposed');
    if (poseFeedbackMount) return poseFeedbackMount;
    const document = requireDocument(options.document);
    const mount = requireElement(options.mount, 'mount');
    root = document.createElement('section');
    root.setAttribute('data-dsl4-app-shell', 'standard');
    root.setAttribute('data-dsl4-surface', surface);
    poseFeedbackMount = document.createElement('div');
    poseFeedbackMount.setAttribute('data-dsl4-pose-feedback-mount', 'true');
    root.appendChild(poseFeedbackMount);
    mount.appendChild(root);
    return poseFeedbackMount;
  }

  const poseFeedbackPresenter = {};
  Object.defineProperty(poseFeedbackPresenter, 'container', {
    enumerable: true,
    get: ensurePoseFeedbackMount,
  });
  if (Object.hasOwn(options, 'poseFeedbackLabels')) {
    Object.defineProperty(poseFeedbackPresenter, 'labels', {
      enumerable: true,
      get() {
        return options.poseFeedbackLabels;
      },
    });
  }

  try {
    runtimeResult = await createRuntimeHost({
      ...runtimeHostOptions,
      featureFlags,
      poseFeedbackPresenter,
    });
  } catch (error) {
    if (typeof root?.remove === 'function') root.remove();
    root = null;
    poseFeedbackMount = null;
    throw error;
  }
  if (!isRuntimeHostResult(runtimeResult)) {
    /** @type {unknown[]} */
    const errors = [
      new TypeError('createRuntimeHost must return a valid enabled runtime host result'),
    ];
    try {
      if (
        isRecord(runtimeResult) &&
        isRecord(runtimeResult.host) &&
        typeof runtimeResult.host.dispose === 'function'
      ) {
        await runtimeResult.host.dispose('invalid-standard-app-shell-result');
      }
    } catch (error) {
      errors.push(error);
    }
    try {
      if (typeof root?.remove === 'function') root.remove();
    } catch (error) {
      errors.push(error);
    }
    root = null;
    poseFeedbackMount = null;
    if (errors.length === 1) throw errors[0];
    throw new AggregateError(errors, 'Invalid Standard app-shell runtime host cleanup failed');
  }

  function snapshot() {
    return deepFreeze({
      version: 1,
      enabled: true,
      disposed,
      surface,
      featureFlags,
      runtimeEnabled: runtimeResult?.enabled === true,
      runtimeOk: runtimeResult?.ok === true,
      poseFeedbackMounted: root !== null,
    });
  }

  async function dispose(reason = 'app-shell-dispose') {
    if (disposePromise) return disposePromise;
    if (typeof reason !== 'string' || reason.length === 0) {
      throw new TypeError('dispose reason must be a non-empty string');
    }
    disposed = true;
    disposePromise = (async () => {
      const errors = [];
      try {
        await runtimeResult?.host?.dispose(reason);
      } catch (error) {
        errors.push(error);
      }
      try {
        if (typeof root?.remove === 'function') root.remove();
      } catch (error) {
        errors.push(error);
      }
      root = null;
      poseFeedbackMount = null;
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, 'Standard app-shell disposal failed');
      }
      return snapshot();
    })();
    return disposePromise;
  }

  return Object.freeze({
    ok: runtimeResult.ok,
    enabled: true,
    featureFlags,
    surface,
    get element() {
      return root;
    },
    runtimeHost: runtimeResult.host ?? null,
    diagnostics: runtimeResult.diagnostics ?? [],
    getSnapshot: snapshot,
    dispose,
  });
}
