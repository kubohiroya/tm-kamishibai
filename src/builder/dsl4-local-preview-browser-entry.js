import schema from '../../schema/dsl-4.schema.json' with {type: 'json'};

import {Buffer} from 'buffer';

import {createDsl4LocalPreviewBrowserBootstrap} from './dsl4-local-preview-browser-bootstrap.js';
import {createDsl4ProductionSourceFrontend} from './dsl4-source-frontend.js';
import {createDsl4BundledTMRuntime} from '../dsl4/platform/posenet-bundle.js';
import {embeddedPoseNetFiles} from '../dsl4/platform/posenet-bundle-assets.js';

/** @type {Record<string, any>} */ (globalThis).Buffer ??= Buffer;

function resolveTMRuntime() {
  const candidate = /** @type {Record<string, any>} */ (globalThis).tmPose;
  if (
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof candidate.Webcam === 'function' &&
    typeof candidate.loadFromFiles === 'function'
  ) {
    return createDsl4BundledTMRuntime({
      runtime: candidate,
      globalObject: globalThis,
      files: embeddedPoseNetFiles,
    });
  }
  return Object.freeze({
    Webcam: class MissingTMWebcam {},
    async loadFromFiles() {
      throw new Error('This preview requires the Teachable Machine Pose browser runtime.');
    },
  });
}

/** @param {string} name */
function configuredLimit(name) {
  const value = Number(globalThis.document?.documentElement?.dataset?.[name]);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`The local preview ${name} configuration is invalid.`);
  }
  return value;
}

const client = createDsl4LocalPreviewBrowserBootstrap({
  globalObject: globalThis,
  sourceFrontend: createDsl4ProductionSourceFrontend(schema),
  getTMRuntime: resolveTMRuntime,
  maxProjectBytes: configuredLimit('dsl4MaxProjectBytes'),
  maxProjectJsonBytes: configuredLimit('dsl4MaxProjectJsonBytes'),
  maxAssetFiles: configuredLimit('dsl4MaxAssetFiles'),
  maxAssetBytes: configuredLimit('dsl4MaxAssetBytes'),
});

void client.start().catch(() => {
  // The client renders its bounded startup diagnostic and remains available for page cleanup.
});
