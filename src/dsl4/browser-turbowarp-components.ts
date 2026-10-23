/** The part of a scratch-render instance this platform releases when the preview tears down. */
export interface Dsl4ScratchRenderer {
  _gl?: {getExtension?(name: string): {loseContext?(): void} | null};
}

/** The part of a scratch-audio engine this platform releases when the preview tears down. */
export interface Dsl4ScratchAudioEngine {
  inputNode?: {disconnect?(): void};
  audioContext?: {state?: string; close?(): Promise<void> | void};
}

function requiredConstructor(value: unknown, name: string) {
  if (typeof value !== 'function') throw new TypeError(`${name} must be a constructor`);
  return value as new (...parameters: unknown[]) => unknown;
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
    disposeRenderer(renderer: Dsl4ScratchRenderer) {
      const context = renderer?._gl;
      const loseContext = context?.getExtension?.('WEBGL_lose_context');
      loseContext?.loseContext?.();
    },
    async disposeAudioEngine(audioEngine: Dsl4ScratchAudioEngine) {
      audioEngine?.inputNode?.disconnect?.();
      const context = audioEngine?.audioContext;
      if (context?.state !== 'closed') await context?.close?.();
    },
    disposeStorage() {},
    disposeBitmapAdapter() {},
  });
}
