import type {Dsl4SourceFrontend} from '../source-frontend.js';
import {storyUsesPoseRecognition} from './story-camera-lifecycle.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read only public target metadata needed by the canonical implicit-project resolver. */
export function createDsl4CameraProjectContext(targets: readonly unknown[]) {
  const collection = (target: Record<string, unknown>, method: string) => {
    const read = target[method];
    const value: unknown = typeof read === 'function' ? read.call(target) : [];
    return Array.isArray(value) ? value.filter(isRecord) : [];
  };
  return {
    targets: targets
      .filter(isRecord)
      .filter((target) => target.isOriginal !== false)
      .map((target) => {
        const name: unknown = typeof target.getName === 'function' ? target.getName() : undefined;
        return {
          name: typeof name === 'string' ? name : undefined,
          isStage: typeof target.isStage === 'boolean' ? target.isStage : undefined,
          costumes: collection(target, 'getCostumes').map((costume) => ({
            name: costume.name,
            bitmapResolution: costume.bitmapResolution === 2 ? 2 : 1,
          })),
          sounds: collection(target, 'getSounds').map((sound) => ({name: sound.name})),
          variables: Object.fromEntries(
            Object.entries(isRecord(target.variables) ? target.variables : {})
              .filter(
                ([, variable]) =>
                  isRecord(variable) &&
                  variable.type === '' &&
                  variable.name === 'actorName' &&
                  typeof variable.value === 'string',
              )
              .map(([id, variable]) => [id, ['actorName', (variable as {value: string}).value]]),
          ),
        };
      }),
  };
}

/** The runtime component a packaged DSL 4.0 artifact carries, wherever the writer put it. */
function packagedRuntimeComponent(project: unknown) {
  if (!isRecord(project) || !isRecord(project.extensionStorage)) return null;
  const storage = project.extensionStorage;
  const bundle = isRecord(storage.kubohiroyakamishibai4) ? storage.kubohiroyakamishibai4 : null;
  const components = bundle && isRecord(bundle.components) ? bundle.components : null;
  const fromBundle = components?.kubohiroyakamishibairuntime4;
  const direct = storage.kubohiroyakamishibairuntime4;
  return isRecord(fromBundle) ? fromBundle : isRecord(direct) ? direct : null;
}

/**
 * Whether this title should offer the camera, read from the packaged story itself.
 *
 * The question has to be answered here rather than from the runtime host, because the packaged
 * title is a Stage backdrop shown long before the story starts and the host parses the document.
 * The source travels with the project, so the title can read it: parse it, ask whether any scene
 * recognises a pose, and offer nothing when the answer is no or the source will not parse. A
 * story that cannot be read is a story that will fail on its own terms; it does not need a camera
 * button first.
 */
export function packagedStoryUsesPoseRecognition(frontend: Dsl4SourceFrontend, project: unknown) {
  try {
    const component = packagedRuntimeComponent(project);
    const source = component && isRecord(component.source) ? component.source : null;
    const text = source?.text;
    if (typeof text !== 'string' || text.length === 0) return false;
    const parsed = frontend.parse(text, {project});
    return parsed.ok && storyUsesPoseRecognition(parsed.storyDocument);
  } catch {
    return false;
  }
}
