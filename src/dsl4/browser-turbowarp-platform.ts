import {createDsl4BrowserTurboWarpPlatform} from './browser-turbowarp-components.js';
export {createDsl4BrowserTurboWarpPlatform} from './browser-turbowarp-components.js';
function requiredConstructor(value: unknown, name: string) {
  if (typeof value !== 'function') throw new TypeError(`${name} must be a constructor`);
  return value as new (...parameters: unknown[]) => unknown;
}

function moduleDefault(value: unknown) {
  if (typeof value === 'object' && value !== null && 'default' in value) {
    return (value as {default: unknown}).default;
  }
  return value;
}

function svgBitmapAdapter(value: unknown) {
  const exports = moduleDefault(value);
  if (typeof exports !== 'object' || exports === null || !('BitmapAdapter' in exports)) {
    throw new TypeError('TurboWarp SVG renderer must export BitmapAdapter');
  }
  return requiredConstructor(
    (exports as {BitmapAdapter: unknown}).BitmapAdapter,
    'TurboWarp BitmapAdapter',
  );
}

/**
 * Load the exact browser packages pinned by package.json and construct the stage platform.
 * The imports stay lazy so Node-only builder and validation users never initialize DOM libraries.
 */
export async function loadDsl4BrowserTurboWarpPlatform() {
  const [vmModule, rendererModule, audioModule, storageModule, svgModule] = await Promise.all([
    // @ts-expect-error The pinned CommonJS TurboWarp packages do not publish declarations.
    import('scratch-vm'),
    // @ts-expect-error The pinned CommonJS TurboWarp packages do not publish declarations.
    import('scratch-render'),
    // @ts-expect-error The pinned CommonJS TurboWarp packages do not publish declarations.
    import('scratch-audio'),
    // @ts-expect-error The pinned CommonJS TurboWarp packages do not publish declarations.
    import('@turbowarp/scratch-storage'),
    // @ts-expect-error The pinned CommonJS TurboWarp packages do not publish declarations.
    import('@turbowarp/scratch-svg-renderer'),
  ]);
  return createDsl4BrowserTurboWarpPlatform({
    VirtualMachine: moduleDefault(vmModule),
    Renderer: moduleDefault(rendererModule),
    AudioEngine: moduleDefault(audioModule),
    Storage: moduleDefault(storageModule),
    BitmapAdapter: svgBitmapAdapter(svgModule),
  });
}
