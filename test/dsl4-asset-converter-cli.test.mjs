import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {dsl4CliDefaultLimits, parseCliArguments, runCli, usage} from '../src/builder/cli.js';

function argumentsFor(extra = []) {
  return [
    'convert-dsl4-assets',
    '--project-root',
    'project',
    '--source-manifest',
    'project/project.source.yaml',
    '--base',
    'project/base.sb3',
    '--output-dir',
    'project/converted',
    '--to',
    'local',
    '--max-source-bytes',
    '65536',
    '--max-source-manifest-bytes',
    '4096',
    '--max-remote-map-bytes',
    '16384',
    '--max-base-sb3-bytes',
    '1048576',
    '--max-asset-file-bytes',
    '65536',
    '--max-asset-files',
    '32',
    '--max-total-asset-bytes',
    '524288',
    '--timeout-ms',
    '1000',
    '--max-redirects',
    '2',
    '--asset',
    'Opening',
    '--asset',
    'Narration',
    '--allow-host',
    'cdn.example.com',
    ...extra,
  ];
}

test('parses the bounded author asset conversion command', () => {
  const parsed = parseCliArguments(argumentsFor(['--output-name', 'offline']));
  assert.equal(parsed.action, 'convert-dsl4-assets');
  assert.equal(parsed.options.to, 'local');
  assert.deepEqual(parsed.options.assets, ['Opening', 'Narration']);
  assert.deepEqual(parsed.options.allowedHosts, ['cdn.example.com']);
  assert.equal(parsed.options.outputName, 'offline');
  assert.equal(path.isAbsolute(parsed.options.outputDirectory), true);
  assert.match(usage(), /convert-dsl4-assets/u);
  assert.match(usage(), /omitted means all assets/u);
  assert.match(usage(), /rsync-destination/u);

  const defaulted = argumentsFor();
  for (const option of [
    '--max-source-bytes',
    '--max-asset-file-bytes',
    '--max-asset-files',
    '--max-total-asset-bytes',
  ]) {
    defaulted.splice(defaulted.indexOf(option), 2);
  }
  const defaultedOptions = parseCliArguments(defaulted).options;
  assert.deepEqual(
    {
      maxSourceBytes: defaultedOptions.maxSourceBytes,
      maxAssetFileBytes: defaultedOptions.maxAssetFileBytes,
      maxAssetFiles: defaultedOptions.maxAssetFiles,
      maxTotalAssetBytes: defaultedOptions.maxTotalAssetBytes,
    },
    dsl4CliDefaultLimits,
  );
  const invalidTarget = argumentsFor();
  invalidTarget[invalidTarget.indexOf('--to') + 1] = 'automatic';
  assert.throws(() => parseCliArguments(invalidTarget), /local, project, or remote/u);
});

test('parses rsync over SSH options and rejects ambiguous remote configuration', () => {
  const rsyncArguments = argumentsFor([
    '--rsync-destination',
    'author@assets.example.com:/srv/www/k4-assets',
    '--remote-base-url',
    'https://cdn.example.com/k4-assets/',
    '--rsync-ssh-port',
    '2222',
    '--rsync-timeout-ms',
    '30000',
  ]);
  rsyncArguments[rsyncArguments.indexOf('--to') + 1] = 'remote';
  const parsed = parseCliArguments(rsyncArguments);
  assert.equal(parsed.options.rsyncDestination, 'author@assets.example.com:/srv/www/k4-assets');
  assert.equal(parsed.options.remoteBaseUrl, 'https://cdn.example.com/k4-assets/');
  assert.equal(parsed.options.rsyncSshPort, 2222);
  assert.equal(parsed.options.rsyncTimeoutMs, 30000);

  const missingBase = argumentsFor([
    '--rsync-destination',
    'author@assets.example.com:/srv/www/k4-assets',
  ]);
  missingBase[missingBase.indexOf('--to') + 1] = 'remote';
  assert.throws(() => parseCliArguments(missingBase), /must be specified together/u);

  const ambiguous = [...rsyncArguments, '--remote-map', 'project/remote-map.json'];
  assert.throws(() => parseCliArguments(ambiguous), /cannot be combined/u);

  const invalidPort = [...rsyncArguments];
  invalidPort[invalidPort.indexOf('--rsync-ssh-port') + 1] = '65536';
  assert.throws(() => parseCliArguments(invalidPort), /must be <= 65535/u);
});

test('routes conversion through the production frontend and reports the reusable project', async () => {
  let received;
  let stdout = '';
  const result = await runCli(
    argumentsFor(),
    {stdout: {write: (chunk) => (stdout += chunk)}},
    {
      runAssetConverter: async (options) => {
        received = options;
        return {
          converted: {Opening: 'local', Narration: 'local'},
          sourceManifestPath: path.join(options.outputDirectory, 'project.source.yaml'),
          sourcePath: path.join(options.outputDirectory, 'story.k4.yml'),
          sb3Path: path.join(options.outputDirectory, 'story.sb3'),
        };
      },
    },
  );
  assert(received.sourceFrontend);
  assert.equal(received.maxSourceBytes, 65536);
  assert.deepEqual(result.converted, {Opening: 'local', Narration: 'local'});
  assert.equal(
    stdout,
    'Converted 2 asset(s)\nSaved project.source.yaml\nSaved story.k4.yml\nSaved story.sb3\n',
  );
});
