export type Dsl4CursorEvent = Readonly<{visible: boolean; source: string; cursor: string}>;

function isThenable(value: unknown): boolean {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return false;
  try {
    return typeof (value as {then?: unknown}).then === 'function';
  } catch {
    return false;
  }
}

/**
 * Preserve synchronous cursor updates while serializing adapters that return promises. Observer
 * failures stay isolated because cursor presentation cannot change runtime execution semantics.
 */
export function createDsl4OrderedCursorNotifier(
  setCursor: (payload: Dsl4CursorEvent) => unknown | Promise<unknown>,
): (event: Dsl4CursorEvent) => void {
  let tail: Promise<void> | null = null;

  function track(operation: unknown): void {
    const current = Promise.resolve(operation).then(
      () => undefined,
      () => undefined,
    );
    tail = current;
    void current.then(() => {
      if (tail === current) tail = null;
    });
  }

  function publish(event: Dsl4CursorEvent): unknown {
    try {
      return setCursor(event);
    } catch {
      return undefined;
    }
  }

  return function notifyCursor(event: Dsl4CursorEvent): void {
    if (tail) {
      track(tail.then(() => publish(event)));
      return;
    }
    const operation = publish(event);
    if (isThenable(operation)) track(operation);
  };
}
