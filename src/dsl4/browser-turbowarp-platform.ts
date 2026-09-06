function requiredConstructor(value: unknown, name: string) {
  if (typeof value !== 'function') throw new TypeError(`${name} must be a constructor`);
  return value as new (...args: any[]) => any;
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
export function createDsl4BrowserTurboWarpPlatform(components: unknown) {
  if (typeof components !== 'object' || components === null) {
    throw new TypeError('TurboWarp browser components are required');
  }
  const parts = components as Record<string, unknown>;
  const VirtualMachine = requiredConstructor(parts.VirtualMachine, 'TurboWarp VirtualMachine');
  const Renderer = requiredConstructor(parts.Renderer, 'TurboWarp Renderer');
  const AudioEngine = requiredConstructor(parts.AudioEngine, 'TurboWarp AudioEngine');
  const Storage = requiredConstructor(parts.Storage, 'TurboWarp Storage');
  const BitmapAdapter = requiredConstructor(parts.BitmapAdapter, 'TurboWarp BitmapAdapter');

  return Object.freeze({
    createVm: () => new VirtualMachine(),
    createRenderer: (canvas: unknown) => new Renderer(canvas),
    createAudioEngine: () => new AudioEngine(),
    createStorage: () => new Storage(),
    createBitmapAdapter: () => new BitmapAdapter(),
    disposeRenderer(renderer: any) {
      const context = renderer?._gl;
      const loseContext = context?.getExtension?.('WEBGL_lose_context');
      loseContext?.loseContext?.();
    },
    async disposeAudioEngine(audioEngine: any) {
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
