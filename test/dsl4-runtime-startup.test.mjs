import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {test} from 'vitest';
import {fileURLToPath} from 'node:url';

import {
  createDsl4RuntimeStartup,
  createDsl4SourceFrontend,
  dsl4DefaultFeatureFlags,
  dsl4NonEmbeddedDevelopmentFeatureFlags,
  dsl4StandardProductionFeatureFlags,
  resolveDsl4FeatureFlags,
} from '../src/dsl4/index.js';
import {
  createDsl4EmptyProject,
  createDsl4InstalledRuntimeFixture,
  dsl4TestSubtleCrypto,
} from './helpers/dsl4-runtime-fixtures.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const schema = JSON.parse(
  await readFile(path.join(repositoryRoot, 'schema', 'dsl-4.schema.json'), 'utf8'),
);
const frontend = createDsl4SourceFrontend(schema);
const subtleCrypto = dsl4TestSubtleCrypto;
const maxSourceBytes = 8192;
const maxAssetFiles = 10;
const maxAssetBytes = 8192;
const sourceText = `
kamishibai: '4.0'
controls:
  keymaps:
    development:
      ArrowLeft: history.previousAction
      Space: navigation.nextAction
    production:
      Space: navigation.nextAction
scenes:
  opening:
    - wait: 0
`;

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail('condition was not reached');
}

function keyEvent(code) {
  const counters = {preventDefault: 0, stopPropagation: 0};
  return {
    code,
    defaultPrevented: false,
    repeat: false,
    preventDefault() {
      counters.preventDefault += 1;
      this.defaultPrevented = true;
    },
    stopPropagation() {
      counters.stopPropagation += 1;
    },
    counters,
  };
}

async function packagedProject(profile, historyNavigationAvailable = false, source = sourceText) {
  const {project, runtimeArtifact} = await createDsl4InstalledRuntimeFixture(source, {
    sourceFrontend: frontend,
    profile,
    historyNavigationAvailable,
    limits: {maxSourceBytes, maxAssetFiles, maxAssetBytes},
    subtleCrypto,
  });
  return {project, runtimeArtifact};
}

const enabledOptions = (project, extra = {}) => ({
  featureFlags: {dsl4Runtime: true},
  project,
  sourceFrontend: frontend,
  maxSourceBytes,
  maxAssetFiles,
  maxAssetBytes,
  port: {},
  subtleCrypto,
  ...extra,
});

test('defaults OFF and does not inspect runtime inputs or adapters', async () => {
  assert.deepEqual(dsl4DefaultFeatureFlags, {
    dsl4Runtime: false,
    dsl4CrossfadeTransitions: false,
    dsl4BroadcastMessageAndWait: false,
    dsl4SessionBinaryBacking: false,
    dsl4SourceIncludes: false,
    dsl4AppShell: false,
    dsl4WebPreviewAdapter: false,
    dsl4BrowserDistributionBuild: false,
    dsl4WebPreviewAssetLiveReload: false,
    dsl4PreviewReloadOverlay: false,
    dsl4Debugger: false,
    dsl4PoseFeedbackModes: false,
    dsl4PosePreviewMirroring: false,
    dsl4CameraPreviewControls: false,
    dsl4SpeechAdvanceTypewriter: false,
    dsl4BubbleAdvanceIndicator: false,
    dsl4TurboWarpBubble: false,
    dsl4TurboWarpBubbleAdvancedPresentation: false,
    dsl4TurboWarpActionSurface: false,
    dsl4TurboWarpStateSurface: false,
    dsl4TurboWarpStoryVariableWrite: false,
    dsl4ExpressionRuntimeState: false,
    structuredDataIntegrationEnabled: false,
  });
  assert.equal(Object.isFrozen(dsl4DefaultFeatureFlags), true);
  const implicit = await createDsl4RuntimeStartup();
  let factoryCalls = 0;
  const explicit = await createDsl4RuntimeStartup({
    featureFlags: {dsl4Runtime: false},
    project: new Proxy({}, {get: () => assert.fail('project must not be read')}),
    sourceFrontend: new Proxy({}, {get: () => assert.fail('frontend must not be read')}),
    port: new Proxy({}, {get: () => assert.fail('port must not be read')}),
    createAssetLifecycle() {
      factoryCalls += 1;
      assert.fail('asset lifecycle factory must not be called');
    },
    createRuntimeEnvironment() {
      factoryCalls += 1;
      assert.fail('runtime environment factory must not be called');
    },
  });
  const integrationWithoutRuntime = await createDsl4RuntimeStartup({
    featureFlags: {dsl4Runtime: false, structuredDataIntegrationEnabled: true},
    project: new Proxy({}, {get: () => assert.fail('project must not be read')}),
  });
  assert.equal(factoryCalls, 0);
  for (const result of [implicit, explicit, integrationWithoutRuntime]) {
    assert.equal(result.ok, true);
    assert.equal(result.enabled, false);
    assert.equal(result.session, null);
    assert.equal(result.featureFlags.dsl4Runtime, false);
    assert.equal(Object.isFrozen(result), true);
  }
  assert.equal(integrationWithoutRuntime.featureFlags.structuredDataIntegrationEnabled, true);
});

test('enables crossfade syntax in the Standard profile and preserves explicit rollback', async () => {
  const source = sourceText.replace(
    'scenes:\n',
    'presentation:\n  transitions: {scene: 0.5}\nscenes:\n',
  );
  const component = await packagedProject('production', false, source);
  let environmentCalls = 0;
  const disabled = await createDsl4RuntimeStartup(
    enabledOptions(component.project, {
      featureFlags: {
        ...dsl4StandardProductionFeatureFlags,
        dsl4CrossfadeTransitions: false,
      },
      port: undefined,
      createRuntimeEnvironment() {
        environmentCalls += 1;
        return {port: {wait() {}}, dispose() {}};
      },
    }),
  );
  assert.equal(disabled.ok, false);
  assert.equal(disabled.diagnostics[0].code, 'K4-TRANSITION-FLAG-001');
  assert.equal(disabled.diagnostics[0].storyPath, '/presentation/transitions/scene');
  assert.equal(disabled.diagnostics[0].range.start.line, 11);
  assert.equal(environmentCalls, 0);

  const enabled = await createDsl4RuntimeStartup(
    enabledOptions(component.project, {
      featureFlags: dsl4StandardProductionFeatureFlags,
      port: undefined,
      createRuntimeEnvironment() {
        environmentCalls += 1;
        return {port: {wait() {}}, dispose() {}};
      },
    }),
  );
  assert.equal(enabled.ok, true, JSON.stringify(enabled.diagnostics));
  assert.equal(environmentCalls, 1);
  enabled.session.dispose();
});

test('strictly resolves one immutable startup flag snapshot', async () => {
  assert.deepEqual(dsl4StandardProductionFeatureFlags, {
    dsl4Runtime: true,
    dsl4CrossfadeTransitions: true,
    dsl4AppShell: true,
    dsl4PoseFeedbackModes: true,
    dsl4SpeechAdvanceTypewriter: true,
    dsl4TurboWarpActionSurface: true,
  });
  assert.equal(Object.isFrozen(dsl4StandardProductionFeatureFlags), true);
  assert.equal(
    resolveDsl4FeatureFlags(dsl4StandardProductionFeatureFlags).dsl4SpeechAdvanceTypewriter,
    true,
  );
  assert.deepEqual(dsl4NonEmbeddedDevelopmentFeatureFlags, {
    dsl4Runtime: true,
    dsl4CrossfadeTransitions: true,
    dsl4AppShell: true,
    dsl4PoseFeedbackModes: true,
    dsl4SpeechAdvanceTypewriter: true,
    dsl4TurboWarpActionSurface: true,
    dsl4WebPreviewAdapter: true,
    dsl4BrowserDistributionBuild: true,
    dsl4PreviewReloadOverlay: true,
    dsl4Debugger: true,
  });
  assert.equal(Object.isFrozen(dsl4NonEmbeddedDevelopmentFeatureFlags), true);
  assert.equal(
    resolveDsl4FeatureFlags(dsl4NonEmbeddedDevelopmentFeatureFlags).dsl4WebPreviewAdapter,
    true,
  );
  assert.equal(
    resolveDsl4FeatureFlags({
      ...dsl4StandardProductionFeatureFlags,
      dsl4CrossfadeTransitions: false,
    }).dsl4CrossfadeTransitions,
    false,
  );
  assert.throws(
    () => resolveDsl4FeatureFlags({dsl4SessionBinaryBacking: true}),
    /requires dsl4Runtime/u,
  );
  const disabledFlags = {
    dsl4Runtime: false,
    dsl4CrossfadeTransitions: false,
    dsl4BroadcastMessageAndWait: false,
    dsl4SessionBinaryBacking: false,
    dsl4SourceIncludes: false,
    dsl4AppShell: false,
    dsl4WebPreviewAdapter: false,
    dsl4BrowserDistributionBuild: false,
    dsl4WebPreviewAssetLiveReload: false,
    dsl4PreviewReloadOverlay: false,
    dsl4Debugger: false,
    dsl4PoseFeedbackModes: false,
    dsl4PosePreviewMirroring: false,
    dsl4CameraPreviewControls: false,
    dsl4SpeechAdvanceTypewriter: false,
    dsl4BubbleAdvanceIndicator: false,
    dsl4TurboWarpBubble: false,
    dsl4TurboWarpBubbleAdvancedPresentation: false,
    dsl4TurboWarpActionSurface: false,
    dsl4TurboWarpStateSurface: false,
    dsl4TurboWarpStoryVariableWrite: false,
    dsl4ExpressionRuntimeState: false,
    structuredDataIntegrationEnabled: false,
  };
  assert.deepEqual(resolveDsl4FeatureFlags(), disabledFlags);
  assert.deepEqual(resolveDsl4FeatureFlags({}), disabledFlags);
  assert.deepEqual(resolveDsl4FeatureFlags({dsl4Runtime: true}), {
    dsl4Runtime: true,
    dsl4CrossfadeTransitions: false,
    dsl4BroadcastMessageAndWait: false,
    dsl4SessionBinaryBacking: false,
    dsl4SourceIncludes: false,
    dsl4AppShell: false,
    dsl4WebPreviewAdapter: false,
    dsl4BrowserDistributionBuild: false,
    dsl4WebPreviewAssetLiveReload: false,
    dsl4PreviewReloadOverlay: false,
    dsl4Debugger: false,
    dsl4PoseFeedbackModes: false,
    dsl4PosePreviewMirroring: false,
    dsl4CameraPreviewControls: false,
    dsl4SpeechAdvanceTypewriter: false,
    dsl4BubbleAdvanceIndicator: false,
    dsl4TurboWarpBubble: false,
    dsl4TurboWarpBubbleAdvancedPresentation: false,
    dsl4TurboWarpActionSurface: false,
    dsl4TurboWarpStateSurface: false,
    dsl4TurboWarpStoryVariableWrite: false,
    dsl4ExpressionRuntimeState: false,
    structuredDataIntegrationEnabled: false,
  });
  assert.deepEqual(resolveDsl4FeatureFlags({dsl4PoseFeedbackModes: true}), {
    dsl4Runtime: false,
    dsl4CrossfadeTransitions: false,
    dsl4BroadcastMessageAndWait: false,
    dsl4SessionBinaryBacking: false,
    dsl4SourceIncludes: false,
    dsl4AppShell: false,
    dsl4WebPreviewAdapter: false,
    dsl4BrowserDistributionBuild: false,
    dsl4WebPreviewAssetLiveReload: false,
    dsl4PreviewReloadOverlay: false,
    dsl4Debugger: false,
    dsl4PoseFeedbackModes: true,
    dsl4PosePreviewMirroring: false,
    dsl4CameraPreviewControls: false,
    dsl4SpeechAdvanceTypewriter: false,
    dsl4BubbleAdvanceIndicator: false,
    dsl4TurboWarpBubble: false,
    dsl4TurboWarpBubbleAdvancedPresentation: false,
    dsl4TurboWarpActionSurface: false,
    dsl4TurboWarpStateSurface: false,
    dsl4TurboWarpStoryVariableWrite: false,
    dsl4ExpressionRuntimeState: false,
    structuredDataIntegrationEnabled: false,
  });
  assert.deepEqual(resolveDsl4FeatureFlags({dsl4PosePreviewMirroring: true}), {
    dsl4Runtime: false,
    dsl4CrossfadeTransitions: false,
    dsl4BroadcastMessageAndWait: false,
    dsl4SessionBinaryBacking: false,
    dsl4SourceIncludes: false,
    dsl4AppShell: false,
    dsl4WebPreviewAdapter: false,
    dsl4BrowserDistributionBuild: false,
    dsl4WebPreviewAssetLiveReload: false,
    dsl4PreviewReloadOverlay: false,
    dsl4Debugger: false,
    dsl4PoseFeedbackModes: false,
    dsl4PosePreviewMirroring: true,
    dsl4CameraPreviewControls: false,
    dsl4SpeechAdvanceTypewriter: false,
    dsl4BubbleAdvanceIndicator: false,
    dsl4TurboWarpBubble: false,
    dsl4TurboWarpBubbleAdvancedPresentation: false,
    dsl4TurboWarpActionSurface: false,
    dsl4TurboWarpStateSurface: false,
    dsl4TurboWarpStoryVariableWrite: false,
    dsl4ExpressionRuntimeState: false,
    structuredDataIntegrationEnabled: false,
  });
  assert.deepEqual(resolveDsl4FeatureFlags({structuredDataIntegrationEnabled: true}), {
    dsl4Runtime: false,
    dsl4CrossfadeTransitions: false,
    dsl4BroadcastMessageAndWait: false,
    dsl4SessionBinaryBacking: false,
    dsl4SourceIncludes: false,
    dsl4AppShell: false,
    dsl4WebPreviewAdapter: false,
    dsl4BrowserDistributionBuild: false,
    dsl4WebPreviewAssetLiveReload: false,
    dsl4PreviewReloadOverlay: false,
    dsl4Debugger: false,
    dsl4PoseFeedbackModes: false,
    dsl4PosePreviewMirroring: false,
    dsl4CameraPreviewControls: false,
    dsl4SpeechAdvanceTypewriter: false,
    dsl4BubbleAdvanceIndicator: false,
    dsl4TurboWarpBubble: false,
    dsl4TurboWarpBubbleAdvancedPresentation: false,
    dsl4TurboWarpActionSurface: false,
    dsl4TurboWarpStateSurface: false,
    dsl4TurboWarpStoryVariableWrite: false,
    dsl4ExpressionRuntimeState: false,
    structuredDataIntegrationEnabled: true,
  });
  assert.throws(
    () => resolveDsl4FeatureFlags({dsl4SpeechAdvanceTypewriter: true}),
    /requires dsl4Runtime/u,
  );
  assert.deepEqual(
    resolveDsl4FeatureFlags({dsl4Runtime: true, dsl4SpeechAdvanceTypewriter: true}),
    {
      dsl4Runtime: true,
      dsl4CrossfadeTransitions: false,
      dsl4BroadcastMessageAndWait: false,
      dsl4SessionBinaryBacking: false,
      dsl4SourceIncludes: false,
      dsl4AppShell: false,
      dsl4WebPreviewAdapter: false,
      dsl4BrowserDistributionBuild: false,
      dsl4WebPreviewAssetLiveReload: false,
      dsl4PreviewReloadOverlay: false,
      dsl4Debugger: false,
      dsl4PoseFeedbackModes: false,
      dsl4PosePreviewMirroring: false,
      dsl4CameraPreviewControls: false,
      dsl4SpeechAdvanceTypewriter: true,
      dsl4BubbleAdvanceIndicator: false,
      dsl4TurboWarpBubble: false,
      dsl4TurboWarpBubbleAdvancedPresentation: false,
      dsl4TurboWarpActionSurface: false,
      dsl4TurboWarpStateSurface: false,
      dsl4TurboWarpStoryVariableWrite: false,
      dsl4ExpressionRuntimeState: false,
      structuredDataIntegrationEnabled: false,
    },
  );
  assert.throws(() => resolveDsl4FeatureFlags({dsl4Runtime: 1}), TypeError);
  assert.throws(
    () => resolveDsl4FeatureFlags({dsl4CrossfadeTransitions: true}),
    /requires dsl4Runtime/u,
  );
  assert.equal(
    resolveDsl4FeatureFlags({dsl4Runtime: true, dsl4CrossfadeTransitions: true})
      .dsl4CrossfadeTransitions,
    true,
  );
  assert.throws(
    () => resolveDsl4FeatureFlags({dsl4BroadcastMessageAndWait: true}),
    /requires dsl4Runtime/u,
  );
  assert.equal(
    resolveDsl4FeatureFlags({
      dsl4Runtime: true,
      dsl4BroadcastMessageAndWait: true,
    }).dsl4BroadcastMessageAndWait,
    true,
  );
  assert.throws(() => resolveDsl4FeatureFlags({dsl4PoseFeedbackModes: 1}), TypeError);
  assert.throws(() => resolveDsl4FeatureFlags({dsl4PosePreviewMirroring: 1}), TypeError);
  assert.throws(() => resolveDsl4FeatureFlags({dsl4PoseOverlay: true}), /Unknown/u);
  assert.throws(() => resolveDsl4FeatureFlags({dsl4CameraPreviewControls: 1}), TypeError);
  assert.throws(() => resolveDsl4FeatureFlags({dsl4SpeechAdvanceTypewriter: 1}), TypeError);
  assert.throws(() => resolveDsl4FeatureFlags({dsl4BubbleAdvanceIndicator: 1}), TypeError);
  assert.throws(() => resolveDsl4FeatureFlags({dsl4TurboWarpBubble: 1}), TypeError);
  assert.throws(() => resolveDsl4FeatureFlags({dsl4TurboWarpActionSurface: 1}), TypeError);
  assert.throws(
    () => resolveDsl4FeatureFlags({dsl4TurboWarpBubbleAdvancedPresentation: 1}),
    TypeError,
  );
  assert.throws(
    () => resolveDsl4FeatureFlags({dsl4BubbleAdvanceIndicator: true}),
    /requires dsl4Runtime, dsl4AppShell, and dsl4SpeechAdvanceTypewriter/u,
  );
  assert.throws(
    () => resolveDsl4FeatureFlags({dsl4TurboWarpBubble: true}),
    /requires dsl4Runtime, dsl4AppShell, and dsl4SpeechAdvanceTypewriter/u,
  );
  assert.throws(
    () => resolveDsl4FeatureFlags({dsl4TurboWarpBubbleAdvancedPresentation: true}),
    /requires dsl4TurboWarpBubble/u,
  );
  assert.throws(
    () => resolveDsl4FeatureFlags({dsl4TurboWarpActionSurface: true}),
    /requires dsl4Runtime/u,
  );
  assert.equal(
    resolveDsl4FeatureFlags({
      dsl4Runtime: true,
      dsl4TurboWarpActionSurface: true,
    }).dsl4TurboWarpActionSurface,
    true,
  );
  assert.throws(
    () => resolveDsl4FeatureFlags({dsl4TurboWarpStateSurface: true}),
    /requires dsl4Runtime/u,
  );
  assert.throws(
    () =>
      resolveDsl4FeatureFlags({
        dsl4Runtime: true,
        dsl4TurboWarpStoryVariableWrite: true,
      }),
    /requires dsl4Runtime and dsl4TurboWarpStateSurface/u,
  );
  assert.throws(
    () => resolveDsl4FeatureFlags({dsl4Runtime: true, dsl4ExpressionRuntimeState: true}),
    /requires dsl4Runtime and dsl4TurboWarpStateSurface/u,
  );
  const runtimeVariableFlags = resolveDsl4FeatureFlags({
    dsl4Runtime: true,
    dsl4TurboWarpStateSurface: true,
    dsl4TurboWarpStoryVariableWrite: true,
    dsl4ExpressionRuntimeState: true,
  });
  assert.equal(runtimeVariableFlags.dsl4TurboWarpStateSurface, true);
  assert.equal(runtimeVariableFlags.dsl4TurboWarpStoryVariableWrite, true);
  assert.equal(runtimeVariableFlags.dsl4ExpressionRuntimeState, true);
  assert.equal(
    resolveDsl4FeatureFlags({
      dsl4Runtime: true,
      dsl4AppShell: true,
      dsl4SpeechAdvanceTypewriter: true,
      dsl4BubbleAdvanceIndicator: true,
    }).dsl4BubbleAdvanceIndicator,
    true,
  );
  assert.equal(
    resolveDsl4FeatureFlags({
      dsl4Runtime: true,
      dsl4AppShell: true,
      dsl4SpeechAdvanceTypewriter: true,
      dsl4TurboWarpBubble: true,
      dsl4TurboWarpBubbleAdvancedPresentation: true,
    }).dsl4TurboWarpBubbleAdvancedPresentation,
    true,
  );
  assert.equal(
    resolveDsl4FeatureFlags({
      dsl4Runtime: true,
      dsl4AppShell: true,
      dsl4SpeechAdvanceTypewriter: true,
      dsl4TurboWarpBubble: true,
    }).dsl4TurboWarpBubble,
    true,
  );
  assert.throws(() => resolveDsl4FeatureFlags({structuredDataIntegrationEnabled: 1}), TypeError);
  assert.throws(() => resolveDsl4FeatureFlags({dsl4AppShell: true}), /requires dsl4Runtime/u);
  assert.throws(
    () => resolveDsl4FeatureFlags({dsl4Runtime: true, dsl4WebPreviewAdapter: true}),
    /requires dsl4Runtime and dsl4AppShell/u,
  );
  assert.throws(
    () => resolveDsl4FeatureFlags({dsl4BrowserDistributionBuild: true}),
    /requires dsl4Runtime, dsl4AppShell, and dsl4WebPreviewAdapter/u,
  );
  assert.deepEqual(
    resolveDsl4FeatureFlags({
      dsl4Runtime: true,
      dsl4SourceIncludes: false,
      dsl4AppShell: true,
      dsl4WebPreviewAdapter: true,
      dsl4BrowserDistributionBuild: false,
      dsl4WebPreviewAssetLiveReload: false,
      dsl4PreviewReloadOverlay: false,
    }),
    {
      dsl4Runtime: true,
      dsl4CrossfadeTransitions: false,
      dsl4BroadcastMessageAndWait: false,
      dsl4SessionBinaryBacking: false,
      dsl4SourceIncludes: false,
      dsl4AppShell: true,
      dsl4WebPreviewAdapter: true,
      dsl4BrowserDistributionBuild: false,
      dsl4WebPreviewAssetLiveReload: false,
      dsl4PreviewReloadOverlay: false,
      dsl4Debugger: false,
      dsl4PoseFeedbackModes: false,
      dsl4PosePreviewMirroring: false,
      dsl4CameraPreviewControls: false,
      dsl4SpeechAdvanceTypewriter: false,
      dsl4BubbleAdvanceIndicator: false,
      dsl4TurboWarpBubble: false,
      dsl4TurboWarpBubbleAdvancedPresentation: false,
      dsl4TurboWarpActionSurface: false,
      dsl4TurboWarpStateSurface: false,
      dsl4TurboWarpStoryVariableWrite: false,
      dsl4ExpressionRuntimeState: false,
      structuredDataIntegrationEnabled: false,
    },
  );
  assert.throws(
    () => resolveDsl4FeatureFlags({dsl4WebPreviewAssetLiveReload: true}),
    /requires dsl4Runtime, dsl4AppShell, and dsl4WebPreviewAdapter/u,
  );
  assert.deepEqual(
    resolveDsl4FeatureFlags({
      dsl4Runtime: true,
      dsl4SourceIncludes: false,
      dsl4AppShell: true,
      dsl4WebPreviewAdapter: true,
      dsl4WebPreviewAssetLiveReload: true,
    }).dsl4WebPreviewAssetLiveReload,
    true,
  );
  assert.throws(
    () => resolveDsl4FeatureFlags({dsl4PreviewReloadOverlay: true}),
    /requires dsl4Runtime and dsl4AppShell/u,
  );
  assert.equal(
    resolveDsl4FeatureFlags({
      dsl4Runtime: true,
      dsl4SourceIncludes: false,
      dsl4AppShell: true,
      dsl4PreviewReloadOverlay: true,
    }).dsl4PreviewReloadOverlay,
    true,
  );
  assert.throws(
    () => resolveDsl4FeatureFlags({dsl4Debugger: true}),
    /requires dsl4Runtime, dsl4AppShell, dsl4WebPreviewAdapter, and dsl4PreviewReloadOverlay/u,
  );
  assert.equal(
    resolveDsl4FeatureFlags({
      dsl4Runtime: true,
      dsl4AppShell: true,
      dsl4WebPreviewAdapter: true,
      dsl4PreviewReloadOverlay: true,
      dsl4Debugger: true,
    }).dsl4Debugger,
    true,
  );
  assert.throws(() => resolveDsl4FeatureFlags({dsl4Runtime: false, extra: true}), TypeError);

  const component = await packagedProject('production');
  const mutableFlags = {dsl4Runtime: true};
  const pending = createDsl4RuntimeStartup(
    enabledOptions(component.project, {featureFlags: mutableFlags}),
  );
  mutableFlags.dsl4Runtime = false;
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.enabled, true);
  assert.deepEqual(result.featureFlags, {
    dsl4Runtime: true,
    dsl4CrossfadeTransitions: false,
    dsl4BroadcastMessageAndWait: false,
    dsl4SessionBinaryBacking: false,
    dsl4SourceIncludes: false,
    dsl4AppShell: false,
    dsl4WebPreviewAdapter: false,
    dsl4BrowserDistributionBuild: false,
    dsl4WebPreviewAssetLiveReload: false,
    dsl4PreviewReloadOverlay: false,
    dsl4Debugger: false,
    dsl4PoseFeedbackModes: false,
    dsl4PosePreviewMirroring: false,
    dsl4CameraPreviewControls: false,
    dsl4SpeechAdvanceTypewriter: false,
    dsl4BubbleAdvanceIndicator: false,
    dsl4TurboWarpBubble: false,
    dsl4TurboWarpBubbleAdvancedPresentation: false,
    dsl4TurboWarpActionSurface: false,
    dsl4TurboWarpStateSurface: false,
    dsl4TurboWarpStoryVariableWrite: false,
    dsl4ExpressionRuntimeState: false,
    structuredDataIntegrationEnabled: false,
  });
  assert.equal(Object.isFrozen(result.featureFlags), true);
  result.session.dispose();
});

test('connects pose preview mirroring to a direct runtime port only when enabled', async () => {
  const component = await packagedProject(
    'production',
    false,
    `
kamishibai: '4.0'
controls:
  keymaps:
    production:
      Space: navigation.nextAction
scenes:
  opening:
    posePreview:
      mirroring: unmirrored
    actions: []
`,
  );
  const disabledPort = {};
  Object.defineProperty(disabledPort, 'setPosePreviewMirroring', {
    get() {
      assert.fail('disabled startup must not inspect the pose preview port');
    },
  });
  const disabled = await createDsl4RuntimeStartup(
    enabledOptions(component.project, {port: disabledPort}),
  );
  assert.equal((await disabled.session.start()).status, 'finished');
  disabled.session.dispose();

  await assert.rejects(
    createDsl4RuntimeStartup(
      enabledOptions(component.project, {
        featureFlags: {dsl4Runtime: true, dsl4PosePreviewMirroring: true},
        port: {},
      }),
    ),
    /setPosePreviewMirroring/u,
  );

  const modes = [];
  const enabled = await createDsl4RuntimeStartup(
    enabledOptions(component.project, {
      featureFlags: {dsl4Runtime: true, dsl4PosePreviewMirroring: true},
      port: {
        setPosePreviewMirroring(mode) {
          modes.push(mode);
        },
      },
    }),
  );
  assert.equal((await enabled.session.start()).status, 'finished');
  assert.deepEqual(modes, ['unmirrored']);
  enabled.session.dispose();
});

test('connects the startup pose flag to refusal without consuming the mapped key', async () => {
  const component = await packagedProject(
    'production',
    false,
    `
kamishibai: '4.0'
controls:
  keymaps:
    production:
      Space: navigation.nextAction
assets:
  Tick: sound
  Charge: sound
  HeroIdle: costume:Hero
  RescuePose:
    kind: recognitionModel
    delivery: remote
    loading: lazy
    source:
      url: https://cdn.example.com/rescue-pose.zip
      integrity: sha256-fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210
      contentType: application/zip
      size: 1024
actors:
  Hero: HeroIdle
recognition:
  idleSound: Tick
  chargeSound: Charge
  navigation:
    allowSkip: false
scenes:
  rescue:
    recognitionModel: RescuePose
    actions:
      - Hero.pose:
          steps:
            - pose: help
`,
  );
  let aborted = false;
  const result = await createDsl4RuntimeStartup(
    enabledOptions(component.project, {
      featureFlags: {dsl4Runtime: true, dsl4PoseFeedbackModes: true},
      port: {
        waitForPose: (_payload, context) =>
          new Promise((resolve) => {
            context.signal.addEventListener(
              'abort',
              () => {
                aborted = true;
                resolve();
              },
              {once: true},
            );
          }),
      },
    }),
  );
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  const run = result.session.start();

  const space = keyEvent('Space');
  assert.equal(result.session.handleKeyDown(space), false);
  assert.deepEqual(space.counters, {preventDefault: 0, stopPropagation: 0});
  assert.equal(aborted, false);

  result.session.stop('test-cleanup');
  await run;
  assert.equal(aborted, true);
  result.session.dispose();
});

test('enables internal Structured Data independently without exposing a generic palette', async () => {
  const component = await packagedProject('production');
  let actionResources;
  const result = await createDsl4RuntimeStartup(
    enabledOptions(component.project, {
      featureFlags: {
        dsl4Runtime: true,
        dsl4SourceIncludes: false,
        structuredDataIntegrationEnabled: true,
      },
      port: {
        wait(_payload, context) {
          actionResources = context.structuredData;
          assert.match(actionResources.actionScopeRef, /^@os1\./u);
          assert.match(actionResources.actionViewRef, /^@os1\./u);
          assert.equal(Object.isFrozen(actionResources), true);
        },
      },
    }),
  );

  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.deepEqual(result.featureFlags, {
    dsl4Runtime: true,
    dsl4CrossfadeTransitions: false,
    dsl4BroadcastMessageAndWait: false,
    dsl4SessionBinaryBacking: false,
    dsl4SourceIncludes: false,
    dsl4AppShell: false,
    dsl4WebPreviewAdapter: false,
    dsl4BrowserDistributionBuild: false,
    dsl4WebPreviewAssetLiveReload: false,
    dsl4PreviewReloadOverlay: false,
    dsl4Debugger: false,
    dsl4PoseFeedbackModes: false,
    dsl4PosePreviewMirroring: false,
    dsl4CameraPreviewControls: false,
    dsl4SpeechAdvanceTypewriter: false,
    dsl4BubbleAdvanceIndicator: false,
    dsl4TurboWarpBubble: false,
    dsl4TurboWarpBubbleAdvancedPresentation: false,
    dsl4TurboWarpActionSurface: false,
    dsl4TurboWarpStateSurface: false,
    dsl4TurboWarpStoryVariableWrite: false,
    dsl4ExpressionRuntimeState: false,
    structuredDataIntegrationEnabled: true,
  });
  assert.equal((await result.session.start()).status, 'finished');
  assert.ok(actionResources);
  assert.equal(JSON.stringify(component.project).includes('kubohiroyastructdata1'), false);
  result.session.dispose();
});

test('withholds component and session when enabled startup validation fails', async () => {
  let factoryCalls = 0;
  const result = await createDsl4RuntimeStartup(
    enabledOptions(createDsl4EmptyProject(), {
      createAssetLifecycle() {
        factoryCalls += 1;
      },
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.enabled, true);
  assert.equal(result.diagnostics[0].code, 'K4-SOURCE-CHANNEL-MISSING');
  assert.equal(Object.hasOwn(result, 'runtimeComponent'), false);
  assert.equal(Object.hasOwn(result, 'session'), false);
  assert.equal(factoryCalls, 0);
});

test('creates a component-aware asset lifecycle after validation and releases it', async () => {
  const component = await packagedProject('production');
  const calls = [];
  let receivedComponent;
  let receivedContext;
  const result = await createDsl4RuntimeStartup(
    enabledOptions(component.project, {
      createAssetLifecycle(runtimeComponent, startupContext) {
        receivedComponent = runtimeComponent;
        receivedContext = startupContext;
        calls.push(['create']);
        return {
          prepare(payload, context) {
            calls.push(['prepare', payload, context]);
          },
          setLoading(payload, context) {
            calls.push(['setLoading', payload, context]);
          },
          releaseAssets(payload) {
            calls.push(['releaseAssets', payload]);
          },
          release(payload) {
            calls.push(['release', payload]);
          },
        };
      },
      port: {wait() {}},
    }),
  );
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.strictEqual(receivedComponent, result.runtimeComponent);
  assert.equal(Object.isFrozen(receivedComponent), true);
  assert.equal(typeof receivedComponent.getAssetFile, 'function');
  assert.deepEqual(receivedContext, {
    channel: 'unbundled',
    featureFlags: {
      dsl4Runtime: true,
      dsl4CrossfadeTransitions: false,
      dsl4BroadcastMessageAndWait: false,
      dsl4SessionBinaryBacking: false,
      dsl4SourceIncludes: false,
      dsl4AppShell: false,
      dsl4WebPreviewAdapter: false,
      dsl4BrowserDistributionBuild: false,
      dsl4WebPreviewAssetLiveReload: false,
      dsl4PreviewReloadOverlay: false,
      dsl4Debugger: false,
      dsl4PoseFeedbackModes: false,
      dsl4PosePreviewMirroring: false,
      dsl4CameraPreviewControls: false,
      dsl4SpeechAdvanceTypewriter: false,
      dsl4BubbleAdvanceIndicator: false,
      dsl4TurboWarpBubble: false,
      dsl4TurboWarpBubbleAdvancedPresentation: false,
      dsl4TurboWarpActionSurface: false,
      dsl4TurboWarpStateSurface: false,
      dsl4TurboWarpStoryVariableWrite: false,
      dsl4ExpressionRuntimeState: false,
      structuredDataIntegrationEnabled: false,
    },
  });
  assert.equal(Object.isFrozen(receivedContext), true);
  assert.equal(Object.isFrozen(receivedContext.featureFlags), true);
  assert.deepEqual(
    calls.map(([name]) => name),
    ['create'],
  );

  const finished = await result.session.start();
  assert.equal(finished.status, 'finished');
  assert.deepEqual(
    calls.map(([name]) => name),
    ['create', 'prepare'],
  );
  result.session.dispose();
  await waitUntil(() => calls.some(([name]) => name === 'release'));
  assert.deepEqual(
    calls.map(([name]) => name),
    ['create', 'prepare', 'release'],
  );
});

test('rejects conflicting or invalid asset lifecycle factories before publishing a session', async () => {
  const component = await packagedProject('production');
  await assert.rejects(
    createDsl4RuntimeStartup(
      enabledOptions(component.project, {
        assetLifecycle: {prepare() {}, setLoading() {}, releaseAssets() {}, release() {}},
        createAssetLifecycle() {},
      }),
    ),
    /either assetLifecycle or createAssetLifecycle/u,
  );
  await assert.rejects(
    createDsl4RuntimeStartup(
      enabledOptions(component.project, {createAssetLifecycle: /** @type {any} */ ({})}),
    ),
    /must be a function/u,
  );
  await assert.rejects(
    createDsl4RuntimeStartup(
      enabledOptions(component.project, {createAssetLifecycle: () => ({prepare() {}})}),
    ),
    /must provide prepare, setLoading, releaseAssets, and release/u,
  );
  await assert.rejects(
    createDsl4RuntimeStartup(
      enabledOptions(component.project, {createAssetLifecycle: () => undefined}),
    ),
    /must provide prepare, setLoading, releaseAssets, and release/u,
  );
});

test('creates isolated lifecycle instances for separate startups', async () => {
  const component = await packagedProject('production');
  const receivedComponents = [];
  const releases = [];
  let instance = 0;
  const createAssetLifecycle = (runtimeComponent) => {
    receivedComponents.push(runtimeComponent);
    const current = ++instance;
    return {
      prepare() {},
      setLoading() {},
      releaseAssets() {},
      release() {
        releases.push(current);
      },
    };
  };
  const first = await createDsl4RuntimeStartup(
    enabledOptions(component.project, {createAssetLifecycle}),
  );
  const second = await createDsl4RuntimeStartup(
    enabledOptions(component.project, {createAssetLifecycle}),
  );
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(instance, 2);
  assert.notStrictEqual(receivedComponents[0], receivedComponents[1]);
  await first.session.start();
  await second.session.start();
  first.session.dispose();
  second.session.dispose();
  await waitUntil(() => releases.length === 2);
  assert.deepEqual(releases.sort(), [1, 2]);
});

test('creates an atomic runtime environment only after component validation', async () => {
  const component = await packagedProject('production');
  const calls = [];
  let receivedComponent;
  let receivedContext;
  const result = await createDsl4RuntimeStartup({
    featureFlags: {dsl4Runtime: true},
    project: component.project,
    sourceFrontend: frontend,
    maxSourceBytes,
    maxAssetFiles,
    maxAssetBytes,
    subtleCrypto,
    createRuntimeEnvironment(runtimeComponent, startupContext) {
      receivedComponent = runtimeComponent;
      receivedContext = startupContext;
      calls.push('create');
      return {
        port: {wait() {}},
        assetLifecycle: {prepare() {}, setLoading() {}, releaseAssets() {}, release() {}},
        dispose(reason) {
          calls.push(`dispose:${reason}`);
        },
      };
    },
  });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.strictEqual(receivedComponent, result.runtimeComponent);
  assert.deepEqual(receivedContext, {
    channel: 'unbundled',
    featureFlags: {
      dsl4Runtime: true,
      dsl4CrossfadeTransitions: false,
      dsl4BroadcastMessageAndWait: false,
      dsl4SessionBinaryBacking: false,
      dsl4SourceIncludes: false,
      dsl4AppShell: false,
      dsl4WebPreviewAdapter: false,
      dsl4BrowserDistributionBuild: false,
      dsl4WebPreviewAssetLiveReload: false,
      dsl4PreviewReloadOverlay: false,
      dsl4Debugger: false,
      dsl4PoseFeedbackModes: false,
      dsl4PosePreviewMirroring: false,
      dsl4CameraPreviewControls: false,
      dsl4SpeechAdvanceTypewriter: false,
      dsl4BubbleAdvanceIndicator: false,
      dsl4TurboWarpBubble: false,
      dsl4TurboWarpBubbleAdvancedPresentation: false,
      dsl4TurboWarpActionSurface: false,
      dsl4TurboWarpStateSurface: false,
      dsl4TurboWarpStoryVariableWrite: false,
      dsl4ExpressionRuntimeState: false,
      structuredDataIntegrationEnabled: false,
    },
  });
  assert.deepEqual(calls, ['create']);
  assert.equal(result.session.getState().runtime.status, 'idle');
  const firstDispose = result.session.dispose('startup-test-dispose');
  const secondDispose = result.session.dispose('ignored');
  assert.strictEqual(secondDispose, firstDispose);
  await firstDispose;
  assert.deepEqual(calls, ['create', 'dispose:startup-test-dispose']);
});

test('uses the condition evaluator owned by the atomic runtime environment', async () => {
  const component = await packagedProject(
    'production',
    false,
    `
kamishibai: '4.0'
variables:
  score: 2
controls:
  keymaps:
    production:
      Space: navigation.nextAction
branches:
  route:
    - if: 'score === 2'
      goto: accepted
    - else: rejected
scenes:
  opening:
    - branch: route
  rejected:
    - wait: 0
  accepted:
    - wait: 0
`,
  );
  const evaluations = [];
  const result = await createDsl4RuntimeStartup({
    featureFlags: {dsl4Runtime: true},
    project: component.project,
    sourceFrontend: frontend,
    maxSourceBytes,
    maxAssetFiles,
    maxAssetBytes,
    subtleCrypto,
    evaluateCondition() {
      assert.fail('the top-level evaluator must not replace environment ownership');
    },
    createRuntimeEnvironment() {
      return {
        port: {wait() {}},
        evaluateCondition(expression, variables) {
          evaluations.push({expression, variables});
          return expression === 'score === 2' && variables.score === 2;
        },
        dispose() {},
      };
    },
  });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  const finished = await result.session.start();
  assert.equal(finished.status, 'finished');
  assert.equal(finished.sceneId, 'accepted');
  assert.deepEqual(evaluations, [{expression: 'score === 2', variables: {score: 2}}]);
  await result.session.dispose('environment-evaluator-complete');
});

test('cleans an atomic runtime environment when navigation session creation is rejected', async () => {
  const component = await packagedProject('development', true);
  const calls = [];
  const result = await createDsl4RuntimeStartup({
    featureFlags: {dsl4Runtime: true},
    project: component.project,
    sourceFrontend: frontend,
    maxSourceBytes,
    maxAssetFiles,
    maxAssetBytes,
    historyNavigationAvailable: true,
    subtleCrypto,
    createRuntimeEnvironment() {
      calls.push('create');
      return {
        port: {wait() {}},
        dispose(reason) {
          calls.push(`dispose:${reason}`);
        },
      };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0].code, 'K4-HISTORY-LIMIT-CONFIG-001');
  assert.deepEqual(calls, ['create', 'dispose:navigation-session-rejected']);
});

test('rejects conflicting or malformed atomic runtime environment options', async () => {
  const component = await packagedProject('production');
  await assert.rejects(
    createDsl4RuntimeStartup({
      ...enabledOptions(component.project),
      createRuntimeEnvironment() {},
    }),
    /cannot be combined/u,
  );
  await assert.rejects(
    createDsl4RuntimeStartup({
      ...enabledOptions(component.project),
      port: undefined,
      createRuntimeEnvironment: /** @type {any} */ ({}),
    }),
    /must be a function/u,
  );
  const calls = [];
  await assert.rejects(
    createDsl4RuntimeStartup({
      ...enabledOptions(component.project),
      port: undefined,
      createRuntimeEnvironment() {
        return {
          port: {wait: 1},
          dispose(reason) {
            calls.push(reason);
          },
        };
      },
    }),
    /port values must be functions/u,
  );
  await assert.rejects(
    createDsl4RuntimeStartup({
      ...enabledOptions(component.project),
      port: undefined,
      createRuntimeEnvironment() {
        return {
          port: {wait() {}},
          evaluateCondition: true,
          dispose(reason) {
            calls.push(reason);
          },
        };
      },
    }),
    /evaluateCondition must be a function/u,
  );
  assert.deepEqual(calls, ['invalid-runtime-environment', 'invalid-runtime-environment']);
});

test('creates but does not auto-start or attach a production navigation session', async () => {
  const component = await packagedProject('production');
  const calls = [];
  const events = [];
  const lifecycle = {
    prepare(payload, context) {
      calls.push(['prepare', payload, context]);
    },
    setLoading(payload, context) {
      calls.push(['setLoading', payload, context]);
    },
    releaseAssets(payload) {
      calls.push(['releaseAssets', payload]);
    },
    release(payload) {
      calls.push(['release', payload]);
    },
  };
  const result = await createDsl4RuntimeStartup(
    enabledOptions(component.project, {
      port: {
        wait(payload, context) {
          calls.push(['wait', payload, context]);
        },
      },
      assetLifecycle: lifecycle,
      onEvent(event) {
        events.push(event);
      },
    }),
  );
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(result.enabled, true);
  assert.equal(result.channel, 'unbundled');
  assert.deepEqual(result.session.getState().keymap, component.runtimeArtifact.resolvedKeymap);
  assert.equal(result.session.getState().historyEnabled, false);
  assert.equal(result.session.getState().history, null);
  assert.deepEqual(calls, []);
  assert.deepEqual(events, []);

  const finished = await result.session.start();
  assert.equal(finished.status, 'finished');
  assert.deepEqual(
    calls.map(([name]) => name),
    ['prepare', 'wait'],
  );
  assert.equal(
    events.some(({type}) => type === 'action.commit'),
    true,
  );
  result.session.dispose();
  await waitUntil(() => calls.some(([name]) => name === 'release'));
  assert.equal(
    calls.some(([name]) => name === 'release'),
    true,
  );
});

test('uses artifact history activation and requires availability plus finite limits', async () => {
  const component = await packagedProject('development', true);
  let factoryCalls = 0;
  const createAssetLifecycle = () => {
    factoryCalls += 1;
    return {prepare() {}, setLoading() {}, releaseAssets() {}, release() {}};
  };
  const unavailable = await createDsl4RuntimeStartup(
    enabledOptions(component.project, {createAssetLifecycle}),
  );
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.diagnostics[0].code, 'K4-KEYMAP-HISTORY-UNAVAILABLE');
  assert.equal(Object.hasOwn(unavailable, 'session'), false);

  const unlimited = await createDsl4RuntimeStartup(
    enabledOptions(component.project, {
      historyNavigationAvailable: true,
      createAssetLifecycle,
    }),
  );
  assert.equal(unlimited.ok, false);
  assert.equal(unlimited.diagnostics[0].code, 'K4-HISTORY-LIMIT-CONFIG-001');
  assert.equal(Object.hasOwn(unlimited, 'runtimeComponent'), false);
  assert.equal(Object.hasOwn(unlimited, 'session'), false);
  assert.equal(factoryCalls, 0);

  const enabled = await createDsl4RuntimeStartup(
    enabledOptions(component.project, {
      historyNavigationAvailable: true,
      historyLimits: {maxActionEntries: 20, maxSceneVisits: 10},
    }),
  );
  assert.equal(enabled.ok, true, JSON.stringify(enabled.diagnostics));
  assert.equal(enabled.session.getState().historyEnabled, true);
  assert.notEqual(enabled.session.getState().history, null);
  assert.deepEqual(enabled.session.getState().keymap, component.runtimeArtifact.resolvedKeymap);
  enabled.session.dispose();
});
