import {createSvgTextComposition} from '@kubohiroya/turbowarp-svg-text/composition';

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {string} code @param {string} message */
function platformError(code, message) {
  const error = new Error(message);
  Object.defineProperty(error, 'code', {value: code});
  return error;
}

/** @param {unknown} [cause] */
function abortError(cause) {
  const error = new Error('DSL 4.0 SVG text action was cancelled');
  error.name = 'AbortError';
  if (cause !== undefined) Object.defineProperty(error, 'cause', {value: cause});
  return error;
}

/** @param {unknown} value @param {string[]} keys @param {string} label */
function validateExactKeys(value, keys, label) {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw platformError('K4-SVG-TEXT-001', `${label} must provide exactly ${keys.join(', ')}`);
  }
  return value;
}

/** @param {unknown} value @param {string} label */
function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw platformError('K4-SVG-TEXT-001', `${label} must be a non-empty string`);
  }
  return value;
}

/** @param {unknown} value */
function validateSignal(value) {
  if (
    !isRecord(value) ||
    typeof value.aborted !== 'boolean' ||
    typeof value.addEventListener !== 'function' ||
    typeof value.removeEventListener !== 'function'
  ) {
    throw platformError('K4-SVG-TEXT-001', 'setText context must provide an AbortSignal');
  }
  return /** @type {AbortSignal} */ (/** @type {unknown} */ (value));
}

/** @param {unknown} value @param {string} actorId */
function validateActor(value, actorId) {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    value.isStage !== false ||
    !Number.isInteger(value.drawableID) ||
    /** @type {number} */ (value.drawableID) < 0
  ) {
    throw platformError('K4-SVG-TEXT-003', `SVG text actor target is unavailable: ${actorId}`);
  }
  return /** @type {Readonly<{id: string, isStage: false, drawableID: number}>} */ (
    /** @type {unknown} */ (value)
  );
}

/** @param {unknown} value */
function validateComposition(value) {
  const methods = ['defineStyle', 'setText', 'releaseTarget', 'releaseAll'];
  if (!isRecord(value) || methods.some((method) => typeof value[method] !== 'function')) {
    throw new TypeError(`SVG Text composition must provide ${methods.join(', ')}`);
  }
  return /** @type {Record<string, Function>} */ (value);
}

/**
 * Race actor resolution with action cancellation and contain stale settlement.
 *
 * @template T
 * @param {() => T | Promise<T>} start
 * @param {AbortSignal} signal
 */
async function runCancellable(start, signal) {
  if (signal.aborted) throw abortError();
  /** @type {(error: Error) => void} */
  let rejectAbort = () => {};
  const aborted = new Promise((_resolve, reject) => {
    rejectAbort = reject;
  });
  const handleAbort = () => rejectAbort(abortError());
  signal.addEventListener('abort', handleAbort, {once: true});
  if (signal.aborted) {
    signal.removeEventListener('abort', handleAbort);
    throw abortError();
  }
  let operation;
  try {
    operation = Promise.resolve(start());
  } catch (error) {
    signal.removeEventListener('abort', handleAbort);
    throw error;
  }
  void operation.catch(() => {});
  try {
    return await /** @type {Promise<T>} */ (Promise.race([operation, aborted]));
  } finally {
    signal.removeEventListener('abort', handleAbort);
  }
}

/** @param {unknown} value */
function validateStoryDocument(value) {
  if (!isRecord(value) || value.kind !== 'StoryDocument' || value.version !== '4.0') {
    throw new TypeError('SVG text platform requires a validated DSL 4.0 StoryDocument');
  }
  if (!isRecord(value.textStyles)) {
    throw new TypeError('DSL 4.0 StoryDocument textStyles must be an object');
  }
  return value;
}

/** @param {unknown} value @param {string} name */
function mapTextStyle(value, name) {
  if (!isRecord(value)) {
    throw platformError('K4-SVG-TEXT-002', `SVG text style is invalid: ${name}`);
  }
  const allowed = new Set(['background', 'color', 'font', 'size', 'align', 'direction']);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw platformError('K4-SVG-TEXT-002', `SVG text style is invalid: ${name}`);
  }
  return Object.freeze({
    name,
    ...(value.background === undefined ? {} : {backgroundColor: value.background}),
    ...(value.color === undefined ? {} : {textColor: value.color}),
    ...(value.font === undefined ? {} : {font: value.font}),
    ...(value.size === undefined ? {} : {fontPercent: value.size}),
    ...(value.align === undefined ? {} : {alignment: value.align}),
    ...(value.direction === undefined ? {} : {direction: value.direction}),
  });
}

function createDisabledPlatform() {
  const port = Object.freeze({});
  return Object.freeze({
    enabled: false,
    composition: null,
    port,
    releaseTarget() {},
    releaseAll() {},
  });
}

/**
 * Create one block-free SVG Text composition for a DSL 4.0 app-shell runtime.
 *
 * The caller passes the startup-fixed feature snapshot through `enabled`. The default is OFF and
 * does not inspect runtime dependencies. Enabled instances own every applied skin until explicit
 * target release or final `releaseAll()`.
 *
 * @param {object} [options]
 * @param {boolean} [options.enabled]
 * @param {unknown} [options.runtime]
 * @param {unknown} [options.storyDocument]
 * @param {(actorId: string, context: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>} [options.resolveActor]
 * @param {Function} [options.createComposition]
 */
export function createDsl4SvgTextPlatform(options = {}) {
  if (!isRecord(options)) throw new TypeError('SVG text platform options must be an object');
  const enabled = options.enabled ?? false;
  if (typeof enabled !== 'boolean')
    throw new TypeError('SVG text platform enabled must be boolean');
  if (!enabled) return createDisabledPlatform();

  const storyDocument = validateStoryDocument(options.storyDocument);
  if (typeof options.resolveActor !== 'function') {
    throw new TypeError('SVG text platform resolveActor must be a function');
  }
  const resolveActor = options.resolveActor;
  const createComposition = options.createComposition ?? createSvgTextComposition;
  if (typeof createComposition !== 'function') {
    throw new TypeError('SVG text platform createComposition must be a function');
  }
  const composition = validateComposition(createComposition({runtime: options.runtime}));
  const styleNames = new Set(['default']);
  for (const [name, style] of Object.entries(
    /** @type {Record<string, unknown>} */ (storyDocument.textStyles),
  )) {
    requireNonEmptyString(name, 'SVG text style name');
    composition.defineStyle(mapTextStyle(style, name));
    styleNames.add(name);
  }

  const targets = new Map();
  let disposed = false;

  function ensureActive() {
    if (disposed) {
      throw platformError('K4-SVG-TEXT-006', 'SVG text platform has been released');
    }
  }

  const port = Object.freeze({
    /** @param {unknown} payload @param {unknown} context */
    async setText(payload, context) {
      ensureActive();
      const value = validateExactKeys(payload, ['target', 'text', 'style'], 'setText payload');
      const actorId = requireNonEmptyString(value.target, 'setText.target');
      if (typeof value.text !== 'string') {
        throw platformError('K4-SVG-TEXT-001', 'setText.text must be a string');
      }
      const styleName = requireNonEmptyString(value.style, 'setText.style');
      if (!styleNames.has(styleName)) {
        throw platformError('K4-SVG-TEXT-002', `SVG text style is not defined: ${styleName}`);
      }
      const signal = validateSignal(isRecord(context) ? context.signal : undefined);
      const actionContext = /** @type {Readonly<Record<string, unknown>>} */ (
        /** @type {unknown} */ (context)
      );
      const target = validateActor(
        await runCancellable(() => resolveActor(actorId, actionContext), signal),
        actorId,
      );
      if (signal.aborted) throw abortError();
      composition.setText({styleName, target, text: value.text});
      const previousTarget = targets.get(actorId);
      targets.set(actorId, target);
      if (previousTarget && previousTarget !== target) composition.releaseTarget(previousTarget);
    },
  });

  /** @param {unknown} actorId */
  function releaseTarget(actorId) {
    ensureActive();
    const name = requireNonEmptyString(actorId, 'SVG text actor ID');
    const target = targets.get(name);
    if (!target) {
      throw platformError('K4-SVG-TEXT-005', `SVG text actor is not owned: ${name}`);
    }
    composition.releaseTarget(target);
    targets.delete(name);
  }

  function releaseAll() {
    if (disposed) return;
    disposed = true;
    targets.clear();
    styleNames.clear();
    composition.releaseAll();
  }

  return Object.freeze({enabled: true, composition, port, releaseTarget, releaseAll});
}
