import {createDsl4PublicationStageArchive} from './publication-stage-archive.js';
import {
  createDsl4BrowserTurboWarpStage,
  dsl4BrowserTurboWarpStageDefaults,
} from '../browser-turbowarp-stage.js';
import {createDsl4BrowserTurboWarpPlatform} from '../browser-turbowarp-components.js';
import type {Dsl4PublicationStage} from './publication-runtime-host.js';
import {fitDsl4PublicationStage} from './publication-stage-layout.js';

/** Construct isolated chapter VMs from the Standard host's already-loaded, pinned constructors. */
export async function createDsl4PublicationVmStageFactory({
  vm,
  document,
  mount,
  projectFiles,
  project,
}: {
  vm: unknown;
  document: Document;
  mount: HTMLElement;
  projectFiles: unknown;
  project: Readonly<Record<string, unknown>>;
}) {
  const hostVm = vm as {
    constructor: unknown;
    runtime: {renderer: unknown; audioEngine: unknown; storage: unknown; v2BitmapAdapter: unknown};
  };
  const constructorOf = (value: unknown) => (value as {constructor: unknown})?.constructor;
  const platform = createDsl4BrowserTurboWarpPlatform({
    VirtualMachine: hostVm.constructor,
    Renderer: constructorOf(hostVm.runtime.renderer),
    AudioEngine: constructorOf(hostVm.runtime.audioEngine),
    Storage: constructorOf(hostVm.runtime.storage),
    BitmapAdapter: constructorOf(hostVm.runtime.v2BitmapAdapter),
  });
  const {bytes} = await createDsl4PublicationStageArchive(project, projectFiles);
  return async (
    _project: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
    stageMount: HTMLElement = mount,
  ): Promise<Dsl4PublicationStage> => {
    const element = document.createElement('div');
    element.dataset.dsl4PublicationStage = 'true';
    element.style.cssText = 'position:absolute;inset:0;visibility:hidden;background:white;';
    stageMount.appendChild(element);
    const stage = createDsl4BrowserTurboWarpStage({
      document,
      mount: element,
      projectBytes: bytes,
      platform,
    });
    let releaseLayout: (() => void) | null = null;
    try {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      await stage.start();
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      releaseLayout = fitDsl4PublicationStage({
        mount: stageMount,
        element,
        canvas: stage.getCanvas() as unknown as HTMLCanvasElement,
        width: dsl4BrowserTurboWarpStageDefaults.stageWidth,
        height: dsl4BrowserTurboWarpStageDefaults.stageHeight,
      });
      return {
        runtime: stage.getRuntime(),
        element,
        async dispose(_reason) {
          releaseLayout?.();
          try {
            await stage.dispose();
          } finally {
            element.remove();
          }
        },
      };
    } catch (error) {
      releaseLayout?.();
      try {
        await stage.dispose();
      } finally {
        element.remove();
      }
      throw error;
    }
  };
}
