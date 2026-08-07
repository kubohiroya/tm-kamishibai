import schema from '../../schema/dsl-4.schema.json' with {type: 'json'};

import {createDsl4ProductionSourceFrontend} from '../../src/builder/dsl4-source-frontend.js';
import {createDsl4StandardAppShell} from '../../src/dsl4/platform/standard-app-shell.js';

const extensionId = 'kubohiroyakamishibairuntime4';
const extensionVersion = '4.0.0';
const limits = Object.freeze({
  maxSourceBytes: 64 * 1024,
  maxAssetFiles: 64,
  maxAssetBytes: 64 * 1024 * 1024,
});

function fallbackTMPoseRuntime() {
  return Object.freeze({
    Webcam: class {},
    async loadFromFiles() {
      throw new Error('This story requires the Teachable Machine Pose runtime.');
    },
  });
}

class KamishibaiDsl4RuntimeExtension {
  constructor(Scratch) {
    this.Scratch = Scratch;
    this.frontend = createDsl4ProductionSourceFrontend(schema);
    this.shell = null;
    this.operation = Promise.resolve();
    this.status = 'ready';
    this.lastError = '';

    const runtime = Scratch.vm.runtime;
    runtime.on('PROJECT_RUN_STOP', () => this.enqueue(() => this.stop('project-stop')));
    runtime.on('PROJECT_START', () => this.enqueue(() => this.restart()));
  }

  getInfo() {
    const {ArgumentType, BlockType} = this.Scratch;
    return {
      id: extensionId,
      name: 'Kamishibai DSL 4.0 Runtime',
      blocks: [
        {
          opcode: 'versionReporter',
          blockType: BlockType.REPORTER,
          text: 'Kamishibai DSL 4.0 runtime version',
          hideFromPalette: true,
          disableMonitor: true,
        },
        {
          opcode: 'statusReporter',
          blockType: BlockType.REPORTER,
          text: 'Kamishibai DSL 4.0 runtime status',
          hideFromPalette: true,
          disableMonitor: true,
        },
        {
          opcode: 'lastErrorReporter',
          blockType: BlockType.REPORTER,
          text: 'Kamishibai DSL 4.0 runtime error',
          hideFromPalette: true,
          disableMonitor: true,
        },
        {
          opcode: 'setTextValue',
          blockType: BlockType.COMMAND,
          text: 'set internal text [NAME] to [VALUE]',
          arguments: {
            NAME: {type: ArgumentType.STRING, defaultValue: ''},
            VALUE: {type: ArgumentType.STRING, defaultValue: ''},
          },
          hideFromPalette: true,
        },
      ],
    };
  }

  versionReporter() {
    return extensionVersion;
  }

  statusReporter() {
    return this.status;
  }

  lastErrorReporter() {
    return this.lastError;
  }

  setTextValue() {}

  enqueue(operation) {
    this.operation = this.operation.then(operation, operation).catch((error) => {
      this.status = 'error';
      this.lastError = String(error?.message ?? error);
      console.error('Kamishibai DSL 4.0 runtime failed.', error);
    });
    return this.operation;
  }

  async stop(reason) {
    const shell = this.shell;
    this.shell = null;
    if (shell) await shell.dispose(reason);
    if (this.status === 'running' || this.status === 'starting') this.status = 'stopped';
  }

  async restart() {
    await this.stop('project-restart');
    this.status = 'starting';
    this.lastError = '';

    const Scratch = this.Scratch;
    const project = JSON.parse(Scratch.vm.toJSON());
    const shell = await createDsl4StandardAppShell({
      featureFlags: {dsl4Runtime: true, dsl4AppShell: true},
      surface: 'regularEditor',
      runtimeHostOptions: {
        project,
        sourceFrontend: this.frontend,
        ...limits,
        runtime: Scratch.vm.runtime,
        tmPoseRuntime: globalThis.tmPose ?? fallbackTMPoseRuntime(),
        setLoading() {},
        subtleCrypto: globalThis.crypto?.subtle,
      },
    });
    if (!shell.ok || !shell.runtimeHost) {
      const diagnostic = shell.diagnostics[0];
      throw new Error(diagnostic?.message ?? 'The packaged DSL 4.0 story is invalid.');
    }

    this.shell = shell;
    this.status = 'running';
    const result = await shell.runtimeHost.start();
    if (this.shell === shell) this.status = result.status;
  }
}

const Scratch = globalThis.Scratch;
if (!Scratch?.extensions?.unsandboxed) {
  throw new Error('Kamishibai DSL 4.0 Runtime must run unsandboxed.');
}
Scratch.extensions.register(new KamishibaiDsl4RuntimeExtension(Scratch));
