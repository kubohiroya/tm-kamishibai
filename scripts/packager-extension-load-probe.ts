import assert from 'node:assert/strict';

/**
 * Page script for browser checks of a packaged project. It must run before the Packager document's
 * own scripts, and records, in order, when the project starts loading, when its targets are
 * installed, each extension URL the VM is asked to load, and each extension registration.
 * Checks only; the product never wraps these objects.
 */
export const packagerExtensionLoadProbeScript = `(() => {
  const events = [];
  Object.defineProperty(globalThis, '__k4PackagerExtensionLoadEvents', {value: events});
  const wrapped = new WeakSet();
  const wrap = (owner, name, before) => {
    const original = owner[name];
    if (typeof original !== 'function' || wrapped.has(original)) return;
    const replacement = function (...values) {
      before(...values);
      return original.apply(this, values);
    };
    wrapped.add(replacement);
    owner[name] = replacement;
  };
  const accessor = (name, onSet) => {
    let current;
    Object.defineProperty(globalThis, name, {
      configurable: true,
      enumerable: true,
      get: () => current,
      set(value) {
        current = value;
        onSet(value);
      },
    });
  };
  accessor('Scratch', (value) => {
    if (!value?.extensions) return;
    wrap(value.extensions, 'register', (extension) => {
      let id = null;
      try {
        id = extension.getInfo().id;
      } catch {}
      events.push('register:' + id);
    });
  });
  accessor('Scaffolding', (value) => {
    const prototype = value?.Scaffolding?.prototype;
    if (!prototype) return;
    wrap(prototype, 'loadProject', () => events.push('loadProject'));
    const setup = prototype.setup;
    if (typeof setup !== 'function' || wrapped.has(setup)) return;
    const replacement = function (...values) {
      const returned = setup.apply(this, values);
      wrap(this.vm, 'installTargets', () => events.push('installTargets'));
      wrap(this.vm.extensionManager, 'loadExtensionURL', (url) =>
        events.push('loadExtensionURL:' + String(url).split(':')[0]),
      );
      return returned;
    };
    wrapped.add(replacement);
    prototype.setup = replacement;
  });
})();`;

/** The expression that reads the events the probe recorded. */
export const packagerExtensionLoadProbeEvents = 'globalThis.__k4PackagerExtensionLoadEvents';

/**
 * Assert the embedded extension was requested and registered once, while the project's targets
 * were being installed: nothing was preloaded before `loadProject()`.
 */
export function assertEmbeddedExtensionLoadedOnceWithProject(events: unknown, extensionId: string) {
  assert.deepEqual(
    events,
    ['loadProject', 'installTargets', 'loadExtensionURL:data', `register:${extensionId}`],
    `Unexpected packaged extension load order: ${JSON.stringify(events)}`,
  );
}
