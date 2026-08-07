import {deepFreeze} from './story-document.js';

const interactiveTags = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'SUMMARY', 'TEXTAREA']);
const interactiveRoles = new Set([
  'button',
  'combobox',
  'link',
  'listbox',
  'menu',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
]);

/**
 * @param {unknown} node
 * @returns {boolean}
 */
function isInteractiveNode(node) {
  if (typeof node !== 'object' || node === null) return false;
  const element = /** @type {Record<string, any>} */ (node);
  if (interactiveTags.has(String(element.tagName ?? '').toUpperCase())) return true;
  if (element.isContentEditable === true) return true;
  const contentEditable = element.getAttribute?.('contenteditable');
  if (contentEditable !== null && contentEditable !== undefined && contentEditable !== 'false') {
    return true;
  }
  const role = String(element.getAttribute?.('role') ?? element.role ?? '').toLowerCase();
  if (interactiveRoles.has(role)) return true;
  const ignoreAttribute = element.getAttribute?.('data-kamishibai-keymap-ignore');
  if (ignoreAttribute !== null && ignoreAttribute !== undefined) return true;
  return Boolean(element.dataset && Object.hasOwn(element.dataset, 'kamishibaiKeymapIgnore'));
}

/**
 * @param {Record<string, any>} event
 * @returns {unknown[]}
 */
function eventPath(event) {
  try {
    const path = event.composedPath?.();
    if (Array.isArray(path)) return path;
  } catch {
    // Fall back to the structural parent chain.
  }
  const path = [];
  let node = event.target;
  while (node && typeof node === 'object') {
    path.push(node);
    node = node.parentElement ?? node.parentNode;
  }
  return path;
}

/**
 * @param {Record<string, any>} event
 * @returns {boolean}
 */
function shouldIgnore(event) {
  if (event.defaultPrevented) return true;
  if (event.isComposing) return true;
  if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return true;
  return eventPath(event).some(isInteractiveNode);
}

/**
 * Create an input adapter for one already-resolved keymap.
 *
 * @param {object} options
 * @param {Readonly<Record<string, string>>} options.keymap
 * @param {(command: string, context: Readonly<{code: string}>) => unknown | Promise<unknown>} options.dispatchCommand
 * @param {(context: Readonly<{code: string}>) => boolean} [options.consumeAnyKey]
 * @param {(context: Readonly<{pointerType: string}>) => boolean} [options.consumePointer]
 * @param {(command: string, context: Readonly<{code: string}>) => boolean | undefined} [options.shouldConsumeCommand]
 * @param {boolean} [options.dispatchImmediately]
 * @param {(error: unknown, context: Readonly<{command: string, code: string}>) => unknown | Promise<unknown>} [options.onError]
 */
export function createDsl4KeymapInputAdapter({
  keymap,
  dispatchCommand,
  consumeAnyKey,
  consumePointer,
  shouldConsumeCommand,
  dispatchImmediately = false,
  onError,
}) {
  if (typeof keymap !== 'object' || keymap === null || Array.isArray(keymap)) {
    throw new TypeError('keymap must be an object');
  }
  if (Object.values(keymap).some((command) => typeof command !== 'string')) {
    throw new TypeError('keymap commands must be strings');
  }
  if (typeof dispatchCommand !== 'function') {
    throw new TypeError('dispatchCommand must be a function');
  }
  if (consumeAnyKey !== undefined && typeof consumeAnyKey !== 'function') {
    throw new TypeError('consumeAnyKey must be a function');
  }
  if (consumePointer !== undefined && typeof consumePointer !== 'function') {
    throw new TypeError('consumePointer must be a function');
  }
  if (shouldConsumeCommand !== undefined && typeof shouldConsumeCommand !== 'function') {
    throw new TypeError('shouldConsumeCommand must be a function');
  }
  if (typeof dispatchImmediately !== 'boolean') {
    throw new TypeError('dispatchImmediately must be boolean');
  }
  if (shouldConsumeCommand && !dispatchImmediately) {
    throw new TypeError('shouldConsumeCommand requires immediate command dispatch');
  }
  if (onError !== undefined && typeof onError !== 'function') {
    throw new TypeError('onError must be a function');
  }

  const resolvedKeymap = deepFreeze(Object.fromEntries(Object.entries(keymap)));
  let disposed = false;
  /** @type {Record<string, Function> | null} */
  let attachedTarget = null;
  /** @type {Record<string, Function> | null} */
  let attachedPointerTarget = null;
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();

  /**
   * @param {unknown} error
   * @param {string} command
   * @param {string} code
   */
  function reportError(error, command, code) {
    try {
      Promise.resolve(onError?.(error, deepFreeze({command, code}))).catch(() => {});
    } catch {
      // Error observers cannot create an unhandled command failure.
    }
  }

  /**
   * @param {Record<string, any>} event
   * @returns {boolean}
   */
  function handleKeyDown(event) {
    if (disposed || typeof event !== 'object' || event === null || shouldIgnore(event)) {
      return false;
    }
    const code = typeof event.code === 'string' ? event.code : '';
    if (!event.repeat && code && consumeAnyKey) {
      try {
        if (consumeAnyKey(deepFreeze({code}))) {
          event.preventDefault?.();
          event.stopPropagation?.();
          return true;
        }
      } catch (error) {
        reportError(error, 'speech.advance', code);
        return false;
      }
    }
    if (!Object.hasOwn(resolvedKeymap, code)) return false;
    const command = resolvedKeymap[code];
    const context = deepFreeze({code});
    let dispatchNow = dispatchImmediately && !shouldConsumeCommand;
    if (shouldConsumeCommand) {
      try {
        const consumption = shouldConsumeCommand(command, context);
        if (consumption !== undefined && typeof consumption !== 'boolean') {
          throw new TypeError('shouldConsumeCommand must return boolean or undefined');
        }
        if (consumption === false) return false;
        dispatchNow = consumption === true && dispatchImmediately;
      } catch (error) {
        reportError(error, command, code);
        return false;
      }
    }
    event.preventDefault?.();
    event.stopPropagation?.();
    if (event.repeat) return true;

    if (dispatchNow) {
      try {
        const operation = Promise.resolve(dispatchCommand(command, context)).catch((error) =>
          reportError(error, command, code),
        );
        queue = Promise.all([queue, operation]).then(() => undefined);
      } catch (error) {
        reportError(error, command, code);
      }
      return true;
    }
    queue = queue
      .then(() => dispatchCommand(command, context))
      .catch((error) => reportError(error, command, code));
    return true;
  }

  /** @param {Record<string, any>} event */
  function handlePointerUp(event) {
    if (
      disposed ||
      !consumePointer ||
      typeof event !== 'object' ||
      event === null ||
      shouldIgnore(event) ||
      event.isPrimary === false ||
      (event.button !== undefined && event.button !== 0)
    ) {
      return false;
    }
    const pointerType = typeof event.pointerType === 'string' ? event.pointerType : 'unknown';
    try {
      if (!consumePointer(deepFreeze({pointerType}))) return false;
      event.preventDefault?.();
      event.stopPropagation?.();
      return true;
    } catch (error) {
      reportError(error, 'speech.advance', `Pointer:${pointerType}`);
      return false;
    }
  }

  /**
   * @param {Record<string, Function>} target
   */
  function attach(target) {
    if (disposed) throw new Error('Keymap input adapter is disposed');
    if (
      typeof target?.addEventListener !== 'function' ||
      typeof target?.removeEventListener !== 'function'
    ) {
      throw new TypeError('Keymap input target must support event listener registration');
    }
    if (attachedTarget === target) return;
    if (attachedTarget) throw new Error('Keymap input adapter is already attached');
    target.addEventListener('keydown', handleKeyDown);
    attachedTarget = target;
  }

  /**
   * Attach pointer advance separately so a shell can scope it to the rendered stage.
   *
   * @param {Record<string, Function>} target
   */
  function attachPointer(target) {
    if (disposed) throw new Error('Keymap input adapter is disposed');
    if (!consumePointer) throw new Error('Pointer input consumer is not configured');
    if (
      typeof target?.addEventListener !== 'function' ||
      typeof target?.removeEventListener !== 'function'
    ) {
      throw new TypeError('Pointer target must support event listener registration');
    }
    if (attachedPointerTarget === target) return;
    if (attachedPointerTarget) throw new Error('Pointer input adapter is already attached');
    target.addEventListener('pointerup', handlePointerUp);
    attachedPointerTarget = target;
  }

  function detach() {
    attachedTarget?.removeEventListener?.('keydown', handleKeyDown);
    attachedTarget = null;
  }

  function detachPointer() {
    attachedPointerTarget?.removeEventListener?.('pointerup', handlePointerUp);
    attachedPointerTarget = null;
  }

  function dispose() {
    detach();
    detachPointer();
    disposed = true;
  }

  return Object.freeze({
    attach,
    attachPointer,
    detach,
    detachPointer,
    dispose,
    handleKeyDown,
    handlePointerUp,
    whenIdle() {
      return queue;
    },
  });
}
