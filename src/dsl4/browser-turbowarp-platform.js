/** @param {unknown} value @param {string} name */
function requiredConstructor(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} must be a constructor`);
  return /** @type {new (...args: any[]) => any} */ (value);
}

/** @param {unknown} value */
function moduleDefault(value) {
  if (typeof value === 'object' && value !== null && 'default' in value) {
    return /** @type {{default: unknown}} */ (value).default;
  }
  return value;
}

/** @param {unknown} value */
function svgBitmapAdapter(value) {
  const exports = moduleDefault(value);
  if (typeof exports !== 'object' || exports === null || !('BitmapAdapter' in exports)) {
    throw new TypeError('TurboWarp SVG renderer must export BitmapAdapter');
  }
  return requiredConstructor(
    /** @type {{BitmapAdapter: unknown}} */ (exports).BitmapAdapter,
    'TurboWarp BitmapAdapter',
  );
}

/**
 * Create the concrete platform contract consumed by createDsl4BrowserTurboWarpStage.
 * Constructor injection keeps the lifecycle contract testable without a DOM or WebGL context.
 *
 * @param {object} components
 * @param {unknown} components.VirtualMachine
 * @param {unknown} components.Renderer
 * @param {unknown} components.AudioEngine
 * @param {unknown} components.Storage
 * @param {unknown} components.BitmapAdapter
 */
export function createDsl4BrowserTurboWarpPlatform(components) {
  if (typeof components !== 'object' || components === null) {
    throw new TypeError('TurboWarp browser components are required');
  }
  const VirtualMachine = requiredConstructor(components.VirtualMachine, 'TurboWarp VirtualMachine');
  const Renderer = requiredConstructor(components.Renderer, 'TurboWarp Renderer');
  const AudioEngine = requiredConstructor(components.AudioEngine, 'TurboWarp AudioEngine');
  const Storage = requiredConstructor(components.Storage, 'TurboWarp Storage');
  const BitmapAdapter = requiredConstructor(components.BitmapAdapter, 'TurboWarp BitmapAdapter');

  return Object.freeze({
    createVm: () => new VirtualMachine(),
    /** @param {unknown} canvas */
    createRenderer: (canvas) => new Renderer(canvas),
    createAudioEngine: () => new AudioEngine(),
    createStorage: () => new Storage(),
    createBitmapAdapter: () => new BitmapAdapter(),
    /** @param {any} renderer */
    disposeRenderer(renderer) {
      const context = renderer?._gl;
      const loseContext = context?.getExtension?.('WEBGL_lose_context');
      loseContext?.loseContext?.();
    },
    /** @param {any} audioEngine */
    async disposeAudioEngine(audioEngine) {
      audioEngine?.inputNode?.disconnect?.();
      const context = audioEngine?.audioContext;
      if (context?.state !== 'closed') await context?.close?.();
    },
    disposeStorage() {},
    disposeBitmapAdapter() {},
  });
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
