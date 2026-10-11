import type {Dsl4SourceFrontend} from '../source-frontend.js';
import {storyUsesPoseRecognition} from './story-camera-lifecycle.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
    const parsed = frontend.parse(text);
    return parsed.ok && storyUsesPoseRecognition(parsed.storyDocument);
  } catch {
    return false;
  }
}
