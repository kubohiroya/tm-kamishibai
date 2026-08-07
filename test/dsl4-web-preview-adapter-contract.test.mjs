import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const contract = JSON.parse(
  await readFile(
    new URL('fixtures/dsl4/web-preview-adapter-contract.json', import.meta.url),
    'utf8',
  ),
);

test('freezes the #390 startup flags and rollout dependencies', () => {
  assert.equal(contract.formatVersion, 1);
  assert.equal(contract.issue, 390);
  assert.deepEqual(contract.featureFlags.runtime, {
    name: 'dsl4Runtime',
    defaultEnabled: false,
    startupFixed: true,
    implemented: true,
    requires: [],
  });
  assert.deepEqual(contract.featureFlags.appShell.requires, ['dsl4Runtime']);
  assert.equal(contract.featureFlags.appShell.implemented, true);
  assert.deepEqual(contract.featureFlags.webPreviewAdapter.requires, [
    'dsl4Runtime',
    'dsl4AppShell',
  ]);
  assert.equal(contract.featureFlags.webPreviewAdapter.defaultEnabled, false);
  assert.equal(contract.featureFlags.webPreviewAdapter.implemented, true);
  assert.equal(contract.featureFlags.fileSystemObserver.requiredForRelease, false);
});

test('uses a read-only, session-only project root selection boundary', () => {
  assert.equal(contract.selection.secureContextRequired, true);
  assert.equal(contract.selection.topLevelContextRequired, true);
  assert.equal(contract.selection.userActivationRequired, true);
  assert.equal(contract.selection.pickerMethod, 'showDirectoryPicker');
  assert.deepEqual(contract.selection.pickerOptions, {mode: 'read'});
  assert.equal(contract.selection.manifestFilename, 'project.source.json');
  assert.equal(contract.selection.defaultSourceFilename, 'story.kamishibai.yaml');
  assert.equal(contract.selection.recommendedSourceFilenameSuffix, '.k4.yml');
  assert.deepEqual(contract.selection.acceptedSourceFilenameSuffixes, [
    '.k4.yml',
    '.k4.yaml',
    '.kamishibai.yml',
    '.kamishibai.yaml',
  ]);
  assert.equal(contract.selection.sourcePathOptional, true);
  assert.equal(contract.selection.sourcePathScope, 'normalized-project-root-relative');
  assert.equal(contract.selection.sourceDiscovery, 'manifest-or-default-only');
  assert.equal(contract.selection.assetDirectoryLayout, 'optional');
  assert.equal(contract.selection.manifestMaximumBytes, 32 * 1024);
  assert.equal(contract.selection.persistHandles, false);
});

test('bounds polling and requires canonical integrity instead of metadata', () => {
  assert.deepEqual(contract.polling, {
    foregroundIntervalMs: 500,
    backgroundIntervalMs: 5000,
    quietWindowMs: 100,
    retryIntervalMs: 50,
    stabilityTimeoutMs: 2000,
    stableReadCount: 2,
    scheduleAfterCompletion: true,
    maximumConcurrentReads: 1,
    reacquireHandlePerRead: true,
    canonicalIntegrityRequired: true,
    lastModifiedOrSizeIsSufficient: false,
    immediatePollWhenVisible: true,
    fileSystemObserverRequired: false,
  });
  assert.ok(contract.polling.backgroundIntervalMs > contract.polling.foregroundIntervalMs);
  assert.ok(contract.polling.stabilityTimeoutMs > contract.polling.quietWindowMs);
});

test('keeps Tier 1 narrow and makes runtime capability checks authoritative', () => {
  const tierOne = contract.browserSupport.filter((entry) => entry.tier === 1);
  assert.deepEqual(
    tierOne.map((entry) => entry.surface),
    ['Chrome desktop', 'Edge desktop', 'ChromeOS desktop'],
  );
  assert.ok(tierOne.every((entry) => entry.supported));
  assert.ok(
    contract.browserSupport
      .filter((entry) => entry.tier !== 1)
      .every((entry) => entry.supported === false),
  );
});

test('assigns unique machine-readable diagnostics and finite recovery states', () => {
  const codes = contract.diagnostics.map((diagnostic) => diagnostic.code);
  assert.equal(new Set(codes).size, codes.length);
  assert.ok(codes.every((code) => /^K4-[A-Z0-9-]+$/u.test(code)));
  assert.ok(contract.diagnostics.every(({severity}) => ['error', 'warning'].includes(severity)));
  assert.deepEqual(contract.states.at(0), 'disabled');
  assert.deepEqual(contract.states.at(-1), 'disposed');
  for (const state of [
    'selecting',
    'loading-manifest',
    'stabilizing',
    'watching-visible',
    'background-throttled',
    'diagnostic',
  ]) {
    assert.ok(contract.states.includes(state));
  }
});

test('advertises only the implemented bounded live preview command', () => {
  assert.equal(contract.fallback.livePreviewCommandImplemented, true);
  assert.equal(contract.fallback.livePreviewCommand, 'tmpose-kamishibai preview-dsl4 --watch');
  assert.equal(contract.fallback.trackingIssue, 258);
  assert.equal(contract.fallback.validateCommand, 'tmpose-kamishibai validate-dsl4');
  assert.equal(contract.fallback.buildCommand, 'tmpose-kamishibai build-dsl4');
  assert.equal(contract.fallback.polyfillAllowed, false);
  assert.equal(contract.fallback.webkitDirectoryFallbackAllowed, false);
});

test('requires adversarial fixtures, latency measurements, and production exclusion', () => {
  for (const required of [
    'initial-valid',
    'initial-invalid',
    'missing-restore',
    'rapid-save',
    'overlapping-poll',
    'atomic-replace',
    'partial-unstable-read',
    'permission-revoke',
    'stop-reselect-pagehide',
    'flag-off',
    'production-artifact',
  ]) {
    assert.ok(contract.testCases.includes(required), required);
  }
  assert.equal(contract.latencyReleaseGate.foregroundMedianMaximumMs, 1000);
  assert.equal(contract.latencyReleaseGate.foregroundP95MaximumMs, 2500);
  assert.equal(contract.latencyReleaseGate.backgroundMaximumGuaranteed, false);
  assert.equal(contract.sessionOnlyFields.length, new Set(contract.sessionOnlyFields).size);
  assert.ok(contract.productionSurfaces.includes('production SB3'));
  assert.equal(contract.rollbackFlag, 'dsl4WebPreviewAdapter');
});
