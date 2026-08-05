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
 * @param {(error: unknown, context: Readonly<{command: string, code: string}>) => unknown | Promise<unknown>} [options.onError]
 */
export function createDsl4KeymapInputAdapter({keymap, dispatchCommand, onError}) {
  if (typeof keymap !== 'object' || keymap === null || Array.isArray(keymap)) {
    throw new TypeError('keymap must be an object');
  }
  if (Object.values(keymap).some((command) => typeof command !== 'string')) {
    throw new TypeError('keymap commands must be strings');
  }
  if (typeof dispatchCommand !== 'function') {
    throw new TypeError('dispatchCommand must be a function');
  }
  if (onError !== undefined && typeof onError !== 'function') {
    throw new TypeError('onError must be a function');
  }

  const resolvedKeymap = deepFreeze(Object.fromEntries(Object.entries(keymap)));
  let disposed = false;
  /** @type {Record<string, Function> | null} */
  let attachedTarget = null;
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
    if (!Object.hasOwn(resolvedKeymap, code)) return false;
    const command = resolvedKeymap[code];
    event.preventDefault?.();
    event.stopPropagation?.();
    if (event.repeat) return true;

    const context = deepFreeze({code});
    queue = queue
      .then(() => dispatchCommand(command, context))
      .catch((error) => reportError(error, command, code));
    return true;
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

  function detach() {
    attachedTarget?.removeEventListener?.('keydown', handleKeyDown);
    attachedTarget = null;
  }

  function dispose() {
    detach();
    disposed = true;
  }

  return Object.freeze({
    attach,
    detach,
    dispose,
    handleKeyDown,
    whenIdle() {
      return queue;
    },
  });
}
