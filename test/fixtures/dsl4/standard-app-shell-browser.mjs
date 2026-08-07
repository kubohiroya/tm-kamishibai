import {createDsl4PoseFeedbackPresenter} from '../../../src/dsl4/platform/pose-feedback-presenter.js';
import {createDsl4StandardAppShell} from '../../../src/dsl4/platform/standard-app-shell.js';

const browserDocument = globalThis.document;
let presenter = null;

const shell = await createDsl4StandardAppShell({
  featureFlags: {
    dsl4Runtime: true,
    dsl4AppShell: true,
    dsl4PoseFeedbackModes: true,
  },
  surface: 'developmentPreview',
  document: browserDocument,
  mount: browserDocument.querySelector('#standard-app-shell-mount'),
  runtimeHostOptions: {},
  async createRuntimeHost(options) {
    presenter = createDsl4PoseFeedbackPresenter(options.poseFeedbackPresenter);
    return Object.freeze({
      ok: true,
      enabled: true,
      host: Object.freeze({
        async dispose() {
          presenter?.dispose();
          presenter = null;
        },
      }),
      diagnostics: [],
    });
  },
});

presenter.onPoseState({
  phase: 'charging',
  target: 'Hero',
  pose: 'help',
  stepIndex: 1,
  confidence: 0.82,
  progress: 0.64,
});

browserDocument.querySelector('#fixture-complete').addEventListener('click', () => {
  presenter?.onPoseState({
    phase: 'completed',
    target: 'Hero',
    pose: 'help',
    stepIndex: 1,
    confidence: 1,
    progress: 1,
  });
});
browserDocument.querySelector('#fixture-dispose').addEventListener('click', () => {
  void shell.dispose('browser-fixture');
});

globalThis.standardAppShellFixture = Object.freeze({shell});
browserDocument.querySelector('#fixture-ready').textContent = 'Browser fixture ready.';
