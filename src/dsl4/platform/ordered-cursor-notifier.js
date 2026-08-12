/** @param {unknown} value */
function isThenable(value) {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return false;
  try {
    return typeof (/** @type {{then?: unknown}} */ (value).then) === 'function';
  } catch {
    return false;
  }
}

/**
 * Preserve synchronous cursor updates while serializing adapters that return promises. Observer
 * failures stay isolated because cursor presentation cannot change runtime execution semantics.
 *
 * @param {(payload: Readonly<{visible: boolean, source: string, cursor: string}>) => unknown | Promise<unknown>} setCursor
 */
export function createDsl4OrderedCursorNotifier(setCursor) {
  /** @type {Promise<void> | null} */
  let tail = null;

  /** @param {unknown} operation */
  function track(operation) {
    const current = Promise.resolve(operation).then(
      () => undefined,
      () => undefined,
    );
    tail = current;
    void current.then(() => {
      if (tail === current) tail = null;
    });
  }

  /** @param {Readonly<{visible: boolean, source: string, cursor: string}>} event */
  function publish(event) {
    try {
      return setCursor(event);
    } catch {
      return undefined;
    }
  }

  /** @param {Readonly<{visible: boolean, source: string, cursor: string}>} event */
  return function notifyCursor(event) {
    if (tail) {
      track(tail.then(() => publish(event)));
      return;
    }
    const operation = publish(event);
    if (isThenable(operation)) track(operation);
  };
}
