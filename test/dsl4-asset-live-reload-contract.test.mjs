import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const contract = JSON.parse(
  await readFile(new URL('fixtures/dsl4/asset-live-reload-contract.json', import.meta.url), 'utf8'),
);
const design = await readFile(
  new URL('../docs/design/dsl-4-asset-live-reload.md', import.meta.url),
  'utf8',
);

test('freezes the #391 rollout, classification, and rollback boundary', () => {
  assert.deepEqual(contract.featureFlag, {
    name: 'dsl4WebPreviewAssetLiveReload',
    default: false,
    startupFixed: true,
    requires: ['dsl4Runtime', 'dsl4AppShell', 'dsl4WebPreviewAdapter'],
  });
  assert.deepEqual(contract.classifications, [
    'no-change',
    'source-live-reload',
    'asset-live-reload',
    'composite-live-reload',
    'additive-composite-live-reload',
    'full-rebuild',
  ]);
  assert.equal(contract.rollbackFlag, contract.featureFlag.name);
  assert.match(design, /dsl4WebPreviewAssetLiveReload=false/u);
});

test('requires bounded non-overlapping stable reads and finite decode limits', () => {
  assert.deepEqual(contract.polling, {
    foregroundIntervalMs: 500,
    backgroundIntervalMs: 5000,
    quietWindowMs: 100,
    retryIntervalMs: 50,
    stabilityTimeoutMs: 2000,
    overlap: false,
    adoptionKey: 'sha256-integrity',
  });
  for (const value of Object.values(contract.limits)) {
    assert.equal(Number.isSafeInteger(value) && value > 0, true);
  }
  assert.match(design, /two reads with the same/u);
});

test('keeps local data and decoded resources outside protocol and production state', () => {
  assert.deepEqual(contract.protocolCapabilities, [
    'asset.commit.v1',
    'asset.defer.v1',
    'asset.diagnostics.v1',
    'asset.stage.v1',
  ]);
  for (const excluded of [
    'ArrayBuffer',
    'AudioBuffer',
    'FileSystemHandle',
    'objectUrl',
    'previewToken',
    'reloadPreference',
  ]) {
    assert.equal(contract.productionExclusions.includes(excluded), true);
  }
  assert.match(design, /never recursively scans the project root/u);
  assert.match(design, /cannot include bytes or paths/u);
});

test('assigns unique stable diagnostics to every failure boundary', () => {
  assert.equal(new Set(contract.diagnosticCodes).size, contract.diagnosticCodes.length);
  assert.deepEqual([...contract.diagnosticCodes].sort(), contract.diagnosticCodes);
  for (const code of contract.diagnosticCodes) assert.match(code, /^K4-ASSET-[A-Z0-9-]+$/u);
});
