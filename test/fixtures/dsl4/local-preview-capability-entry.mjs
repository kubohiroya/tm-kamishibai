import schema from '../../../schema/dsl-4.schema.json' with {type: 'json'};

import {Buffer} from 'buffer';

import {createDsl4LocalPreviewBrowserBootstrap} from '../../../src/builder/dsl4-local-preview-browser-bootstrap.js';
import {createDsl4ProductionSourceFrontend} from '../../../src/builder/dsl4-source-frontend.js';

globalThis.Buffer ??= Buffer;

const metrics = {
  cameraStarts: 0,
  cameraTrackStops: 0,
  webcamUpdates: 0,
  modelLoads: 0,
  predictions: 0,
  classifierDisposals: 0,
  poseNetDisposals: 0,
};

class DeterministicWebcam {
  constructor() {
    this.canvas = globalThis.document.createElement('canvas');
    this.canvas.width = 320;
    this.canvas.height = 240;
    this.webcam = globalThis.document.createElement('video');
    Object.defineProperty(this.webcam, 'srcObject', {
      configurable: true,
      writable: true,
      value: {
        getTracks() {
          return [
            {
              stop() {
                metrics.cameraTrackStops += 1;
              },
            },
          ];
        },
      },
    });
  }

  async setup() {
    metrics.cameraStarts += 1;
  }

  async play() {}

  update() {
    metrics.webcamUpdates += 1;
  }
}

const tmPoseRuntime = Object.freeze({
  Webcam: DeterministicWebcam,
  async loadFromFiles(model, weights, metadata) {
    metrics.modelLoads += 1;
    if (model.name !== 'model.json' || weights.name !== 'weights.bin') {
      throw new Error('The deterministic pose model filenames are invalid.');
    }
    const parsedMetadata = JSON.parse(await metadata.text());
    return {
      model: {
        dispose() {
          metrics.classifierDisposals += 1;
        },
      },
      posenetModel: {
        dispose() {
          metrics.poseNetDisposals += 1;
        },
      },
      getClassLabels() {
        return parsedMetadata.labels;
      },
      async estimatePose() {
        return {posenetOutput: [1]};
      },
      async predict() {
        metrics.predictions += 1;
        return [{className: 'help', probability: 0}];
      },
    };
  },
});

const fixture = {
  client: null,
  errors: [],
  events: [],
  metrics,
  started: false,
};
globalThis.dsl4LocalPreviewCapabilityFixture = fixture;

fixture.client = createDsl4LocalPreviewBrowserBootstrap({
  globalObject: globalThis,
  sourceFrontend: createDsl4ProductionSourceFrontend(schema),
  tmPoseRuntime,
  onRuntimeEvent(event) {
    fixture.events.push({type: event.type, actionPath: event.actionPath, details: event.details});
  },
  onError(error) {
    fixture.errors.push(String(error?.message ?? error));
  },
});

void fixture.client
  .start()
  .then(() => {
    fixture.started = true;
  })
  .catch(() => {
    // The client exposes its bounded diagnostic and fixture error list for the E2E assertion.
  });
