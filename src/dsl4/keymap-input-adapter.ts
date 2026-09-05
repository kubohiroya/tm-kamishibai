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
const keyListenerCapture = true;

function isInteractiveNode(node: unknown): boolean {
  if (typeof node !== 'object' || node === null) return false;
  const element = node as Record<string, any>;
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

function eventPath(event: Record<string, any>): unknown[] {
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

function shouldIgnore(event: Record<string, any>): boolean {
  if (event.defaultPrevented) return true;
  if (event.isComposing) return true;
  if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return true;
  return eventPath(event).some(isInteractiveNode);
}

/** Create an input adapter for one already-resolved keymap. */
export function createDsl4KeymapInputAdapter({
  keymap,
  dispatchCommand,
  consumeAnyKey,
  consumePointer,
  shouldDeferKey,
  arbitratePointer,
  cancelPointer,
  shouldConsumeCommand,
  dispatchImmediately = false,
  onError,
}: {
  keymap: Readonly<Record<string, string>>;
  dispatchCommand: (
    command: string,
    context: Readonly<{code: string}>,
  ) => unknown | Promise<unknown>;
  consumeAnyKey?: (context: Readonly<{code: string}>) => boolean;
  consumePointer?: (context: Readonly<{pointerType: string}>) => boolean;
  shouldDeferKey?: (context: Readonly<{code: string}>) => boolean;
  arbitratePointer?: (context: Readonly<{pointerType: string}>) => 'allow' | 'defer' | 'suppress';
  cancelPointer?: (context: Readonly<{pointerType: string}>) => unknown;
  shouldConsumeCommand?: (
    command: string,
    context: Readonly<{code: string}>,
  ) => boolean | undefined;
  dispatchImmediately?: boolean;
  onError?: (
    error: unknown,
    context: Readonly<{command: string; code: string}>,
  ) => unknown | Promise<unknown>;
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
  if (shouldDeferKey !== undefined && typeof shouldDeferKey !== 'function') {
    throw new TypeError('shouldDeferKey must be a function');
  }
  if (arbitratePointer !== undefined && typeof arbitratePointer !== 'function') {
    throw new TypeError('arbitratePointer must be a function');
  }
  if (cancelPointer !== undefined && typeof cancelPointer !== 'function') {
    throw new TypeError('cancelPointer must be a function');
  }
  if ((arbitratePointer || cancelPointer) && !consumePointer) {
    throw new TypeError('pointer arbitration requires consumePointer');
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
  let attachedTarget: Record<string, Function> | null = null;
  let attachedPointerTarget: Record<string, Function> | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  function reportError(error: unknown, command: string, code: string) {
    try {
      Promise.resolve(onError?.(error, deepFreeze({command, code}))).catch(() => {});
    } catch {
      // Error observers cannot create an unhandled command failure.
    }
  }

  function handleKeyDown(event: Record<string, any>): boolean {
    if (disposed || typeof event !== 'object' || event === null || shouldIgnore(event)) {
      return false;
    }
    const code = typeof event.code === 'string' ? event.code : '';
    if (!event.repeat && code && shouldDeferKey) {
      try {
        const deferred = shouldDeferKey(deepFreeze({code}));
        if (typeof deferred !== 'boolean') {
          throw new TypeError('shouldDeferKey must return boolean');
        }
        if (deferred) return false;
      } catch (error) {
        reportError(error, 'input.arbitration', code);
        return false;
      }
    }
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
    const command = resolvedKeymap[code];
    if (command === undefined) return false;
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

  function handlePointerUp(event: Record<string, any>) {
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
    const context = deepFreeze({pointerType});
    if (arbitratePointer) {
      try {
        const decision = arbitratePointer(context);
        if (decision === 'defer') return false;
        if (decision === 'suppress') {
          event.preventDefault?.();
          event.stopPropagation?.();
          return true;
        }
        if (decision !== 'allow') {
          throw new TypeError('arbitratePointer must return allow, defer, or suppress');
        }
      } catch (error) {
        reportError(error, 'input.arbitration', `Pointer:${pointerType}`);
        return false;
      }
    }
    try {
      if (!consumePointer(context)) return false;
      event.preventDefault?.();
      event.stopPropagation?.();
      return true;
    } catch (error) {
      reportError(error, 'speech.advance', `Pointer:${pointerType}`);
      return false;
    }
  }

  function handlePointerCancel(event: Record<string, any>) {
    if (
      disposed ||
      !cancelPointer ||
      typeof event !== 'object' ||
      event === null ||
      event.isPrimary === false
    ) {
      return false;
    }
    const pointerType = typeof event.pointerType === 'string' ? event.pointerType : 'unknown';
    try {
      cancelPointer(deepFreeze({pointerType}));
    } catch (error) {
      reportError(error, 'input.arbitration', `Pointer:${pointerType}`);
    }
    return false;
  }

  function attach(target: Record<string, Function>) {
    if (disposed) throw new Error('Keymap input adapter is disposed');
    if (
      typeof target?.addEventListener !== 'function' ||
      typeof target?.removeEventListener !== 'function'
    ) {
      throw new TypeError('Keymap input target must support event listener registration');
    }
    if (attachedTarget === target) return;
    if (attachedTarget) throw new Error('Keymap input adapter is already attached');
    target.addEventListener('keydown', handleKeyDown, keyListenerCapture);
    attachedTarget = target;
  }

  /** Attach pointer advance separately so a shell can scope it to the rendered stage. */
  function attachPointer(target: Record<string, Function>) {
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
    if (cancelPointer) target.addEventListener('pointercancel', handlePointerCancel);
    attachedPointerTarget = target;
  }

  function detach() {
    attachedTarget?.removeEventListener?.('keydown', handleKeyDown, keyListenerCapture);
    attachedTarget = null;
  }

  function detachPointer() {
    attachedPointerTarget?.removeEventListener?.('pointerup', handlePointerUp);
    if (cancelPointer) {
      attachedPointerTarget?.removeEventListener?.('pointercancel', handlePointerCancel);
    }
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
    handlePointerCancel,
    whenIdle() {
      return queue;
    },
  });
}
