import schema from '../../schema/dsl-4.schema.json' with {type: 'json'};

import {Buffer} from 'buffer';

import {createDsl4LocalPreviewBrowserBootstrap} from './dsl4-local-preview-browser-bootstrap.js';
import {createDsl4ProductionSourceFrontend} from './dsl4-source-frontend.js';

/** @type {Record<string, any>} */ (globalThis).Buffer ??= Buffer;

function resolveTMPoseRuntime() {
  const candidate = /** @type {Record<string, any>} */ (globalThis).tmPose;
  if (
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof candidate.Webcam === 'function' &&
    typeof candidate.loadFromFiles === 'function'
  ) {
    return candidate;
  }
  return Object.freeze({
    Webcam: class MissingTMPoseWebcam {},
    async loadFromFiles() {
      throw new Error('This preview requires the Teachable Machine Pose browser runtime.');
    },
  });
}

const client = createDsl4LocalPreviewBrowserBootstrap({
  globalObject: globalThis,
  sourceFrontend: createDsl4ProductionSourceFrontend(schema),
  getTMPoseRuntime: resolveTMPoseRuntime,
});

void client.start().catch(() => {
  // The client renders its bounded startup diagnostic and remains available for page cleanup.
});
