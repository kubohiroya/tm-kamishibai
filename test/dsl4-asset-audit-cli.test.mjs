import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {dsl4CliDefaultLimits, parseCliArguments, runCli, usage} from '../src/builder/cli.js';

function auditArguments(extra = []) {
  return [
    'audit-dsl4-assets',
    '--project-root',
    'project',
    '--source-manifest',
    'project/project.source.yaml',
    '--asset-config',
    'project/project.assets.json',
    '--asset-lock',
    'project/project.assets.lock.json',
    '--asset-profile',
    'online',
    '--max-source-bytes',
    '16384',
    '--max-source-manifest-bytes',
    '4096',
    '--max-asset-config-bytes',
    '16384',
    '--max-asset-lock-bytes',
    '32768',
    ...extra,
  ];
}

const emptySummary = {
  assets: 0,
  logicalBytes: 0,
  embedded: {assets: 0, logicalBytes: 0},
  remote: {assets: 0, logicalBytes: 0, transportBytes: 0},
};
const auditResult = {
  formatVersion: 1,
  profile: 'online',
  network: 'allowed',
  offlineReady: true,
  totals: {...emptySummary, eager: emptySummary, lazy: emptySummary},
  byKind: {},
  preparation: {startup: {...emptySummary, ids: []}},
  scenes: {},
  duplicates: {groups: [], savingsBytes: 0},
  assets: [],
};

test('parses the finite audit-dsl4-assets CLI contract', () => {
  const parsed = parseCliArguments(auditArguments());
  assert.equal(parsed.action, 'audit-dsl4-assets');
  assert.equal(parsed.options.projectRoot, path.resolve('project'));
  assert.equal(parsed.options.assetProfile, 'online');
  assert.equal(parsed.options.format, 'pretty');
  assert.equal(parsed.options.maxAssetLockBytes, 32768);
  assert.equal(parsed.options.sourceIncludesEnabled, false);
  const defaultSource = auditArguments();
  defaultSource.splice(defaultSource.indexOf('--max-source-bytes'), 2);
  assert.equal(
    parseCliArguments(defaultSource).options.maxSourceBytes,
    dsl4CliDefaultLimits.maxSourceBytes,
  );
  assert.match(usage(), /audit-dsl4-assets/u);
  assert.match(usage(), /without network access or file writes/u);

  const included = parseCliArguments(
    auditArguments([
      '--enable-source-includes',
      '--max-source-files',
      '8',
      '--max-total-source-bytes',
      '32768',
      '--max-include-depth',
      '4',
      '--format',
      'json',
    ]),
  );
  assert.equal(included.options.sourceIncludesEnabled, true);
  assert.equal(included.options.maxSourceFiles, 8);
  assert.equal(included.options.maxTotalSourceBytes, 32768);
  assert.equal(included.options.maxIncludeDepth, 4);
  assert.equal(included.options.format, 'json');

  assert.throws(
    () => parseCliArguments(auditArguments(['--max-source-files', '8'])),
    /requires --enable-source-includes/u,
  );
  assert.throws(
    () => parseCliArguments(auditArguments(['--enable-source-includes'])),
    /is required with --enable-source-includes/u,
  );
  assert.throws(() => parseCliArguments(auditArguments(['--format', 'yaml'])), /pretty or json/u);
  const invalidLimit = auditArguments();
  invalidLimit[invalidLimit.indexOf('--max-asset-lock-bytes') + 1] = '0';
  assert.throws(() => parseCliArguments(invalidLimit), /integer >= 1/u);
});

test('runs the audit command through an injected network-free implementation', async () => {
  let received;
  let stdout = '';
  const result = await runCli(
    auditArguments(['--format', 'json']),
    {stdout: {write: (chunk) => (stdout += chunk)}},
    {
      runAssetAudit: async (options) => {
        received = options;
        return auditResult;
      },
    },
  );
  assert.equal(typeof received.sourceFrontend.parse, 'function');
  assert.equal(received.assetProfile, 'online');
  assert.deepEqual(JSON.parse(stdout), auditResult);
  assert.equal(result.exitCode, 0);

  stdout = '';
  await runCli(
    auditArguments(),
    {stdout: {write: (chunk) => (stdout += chunk)}},
    {runAssetAudit: async () => auditResult},
  );
  assert.match(stdout, /Asset profile: online/u);
  assert.match(stdout, /Remote: 0/u);
});
