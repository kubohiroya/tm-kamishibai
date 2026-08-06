import {readFile} from 'node:fs/promises';
import path from 'node:path';

import {createDsl4SourceFrontend} from '../dsl4/source-frontend.js';
import {packageVersion} from './constants.js';
import {Sb3BuilderError} from './errors.js';
import {buildDsl4RuntimeComponentFile, buildSb3Bundle} from './index.js';

const dsl4SchemaUrl = new URL('../../schema/dsl-4.schema.json', import.meta.url);

export function usage() {
  return `Usage:
  tmpose-kamishibai build-sb3 --base BASE.sb3 --script SOURCE.txt \\
    --assets assets.lock.json --output dist/sample --profile editor [options]

  tmpose-kamishibai build-dsl4 --base BASE.sb3 --project-root DIR \\
    --source-manifest project.source.json --output dist/story.sb3 \\
    --control-profile production --channel bundled \\
    --max-source-bytes N --max-asset-file-bytes N \\
    --max-asset-files N --max-total-asset-bytes N [options]

DSL 3.1/3.2 build-sb3 options:
  --allow-file-root DIR   Allow file: assets below DIR (repeatable)
  --allow-http            Permit plain HTTP assets (HTTPS is the default)
  --timeout-ms N          Per-request timeout in milliseconds
  --max-asset-bytes N     Maximum bytes per asset
  --max-script-bytes N    Maximum embedded script bytes
  --max-redirects N       Maximum HTTP redirects

DSL 4.0 build-dsl4 options:
  --history-navigation-available  Permit a selected history.* keymap
  --replace-existing              Replace a same-channel component in the base SB3

General options:
  --help                  Show this help
  --version               Show the package version

build-sb3 takes an output basename and writes .sb3, .txt, and .manifest.json.
build-dsl4 writes one self-contained SB3 after revalidating the disk candidate.`;
}

/**
 * @param {string[]} rest
 * @returns {Parameters<typeof buildSb3Bundle>[0]}
 */
function parseBuildSb3Arguments(rest) {
  const values = new Map();
  const allowedFileRoots = [];
  let allowHttp = false;
  const numericOptions = new Set([
    '--timeout-ms',
    '--max-asset-bytes',
    '--max-script-bytes',
    '--max-redirects',
  ]);
  for (let index = 0; index < rest.length; index += 1) {
    const option = rest[index];
    if (option === '--allow-http') {
      allowHttp = true;
      continue;
    }
    const value = rest[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Sb3BuilderError(`${option} requires a value.`, {stage: 'cli'});
    }
    if (option === '--allow-file-root') {
      allowedFileRoots.push(path.resolve(value));
    } else if (
      ['--base', '--script', '--assets', '--output', '--profile'].includes(option) ||
      numericOptions.has(option)
    ) {
      if (values.has(option)) {
        throw new Sb3BuilderError(`Duplicate option: ${option}`, {stage: 'cli'});
      }
      values.set(option, value);
    } else {
      throw new Sb3BuilderError(`Unknown option: ${option}`, {stage: 'cli'});
    }
    index += 1;
  }
  for (const required of ['--base', '--script', '--assets', '--output', '--profile']) {
    if (!values.has(required)) {
      throw new Sb3BuilderError(`Missing required option: ${required}`, {stage: 'cli'});
    }
  }
  /** @param {string} option */
  const numberValue = (option) => {
    const raw = values.get(option);
    if (raw === undefined) return undefined;
    const value = Number(raw);
    const minimum = option === '--max-redirects' ? 0 : 1;
    if (!Number.isInteger(value) || value < minimum) {
      throw new Sb3BuilderError(`${option} must be an integer >= ${minimum}.`, {stage: 'cli'});
    }
    return value;
  };
  const outputBase = path.resolve(/** @type {string} */ (values.get('--output')));
  const profile = values.get('--profile');
  if (profile !== 'editor' && profile !== 'player') {
    throw new Sb3BuilderError('--profile must be either editor or player.', {stage: 'cli'});
  }
  return {
    baseSb3: path.resolve(/** @type {string} */ (values.get('--base'))),
    sourceScript: path.resolve(/** @type {string} */ (values.get('--script'))),
    assetManifest: path.resolve(/** @type {string} */ (values.get('--assets'))),
    outputDirectory: path.dirname(outputBase),
    outputName: path.basename(outputBase),
    profile,
    allowedFileRoots: allowedFileRoots.length > 0 ? allowedFileRoots : undefined,
    allowHttp,
    requestTimeoutMs: numberValue('--timeout-ms'),
    maxAssetBytes: numberValue('--max-asset-bytes'),
    maxEmbeddedScriptBytes: numberValue('--max-script-bytes'),
    maxRedirects: numberValue('--max-redirects'),
  };
}

/**
 * @typedef {Omit<Parameters<typeof buildDsl4RuntimeComponentFile>[0], 'sourceFrontend'>} Dsl4CliOptions
 */

/**
 * @param {string[]} rest
 * @returns {Dsl4CliOptions}
 */
function parseBuildDsl4Arguments(rest) {
  const values = new Map();
  const flags = new Set();
  const booleanOptions = new Set(['--history-navigation-available', '--replace-existing']);
  const valueOptions = new Set([
    '--base',
    '--project-root',
    '--source-manifest',
    '--output',
    '--control-profile',
    '--channel',
    '--max-source-bytes',
    '--max-asset-file-bytes',
    '--max-asset-files',
    '--max-total-asset-bytes',
  ]);
  for (let index = 0; index < rest.length; index += 1) {
    const option = rest[index];
    if (booleanOptions.has(option)) {
      if (flags.has(option)) {
        throw new Sb3BuilderError(`Duplicate option: ${option}`, {stage: 'cli'});
      }
      flags.add(option);
      continue;
    }
    if (!valueOptions.has(option)) {
      throw new Sb3BuilderError(`Unknown option: ${option}`, {stage: 'cli'});
    }
    const value = rest[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Sb3BuilderError(`${option} requires a value.`, {stage: 'cli'});
    }
    if (values.has(option)) {
      throw new Sb3BuilderError(`Duplicate option: ${option}`, {stage: 'cli'});
    }
    values.set(option, value);
    index += 1;
  }
  for (const required of valueOptions) {
    if (!values.has(required)) {
      throw new Sb3BuilderError(`Missing required option: ${required}`, {stage: 'cli'});
    }
  }
  /** @param {string} option */
  const positiveInteger = (option) => {
    const value = Number(values.get(option));
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Sb3BuilderError(`${option} must be an integer >= 1.`, {stage: 'cli'});
    }
    return value;
  };
  const channel = values.get('--channel');
  if (channel !== 'bundled' && channel !== 'unbundled') {
    throw new Sb3BuilderError('--channel must be either bundled or unbundled.', {stage: 'cli'});
  }
  return {
    baseSb3: path.resolve(/** @type {string} */ (values.get('--base'))),
    projectRoot: path.resolve(/** @type {string} */ (values.get('--project-root'))),
    sourceManifest: path.resolve(/** @type {string} */ (values.get('--source-manifest'))),
    output: path.resolve(/** @type {string} */ (values.get('--output'))),
    controlProfile: /** @type {string} */ (values.get('--control-profile')),
    channel,
    maxSourceBytes: positiveInteger('--max-source-bytes'),
    maxAssetFileBytes: positiveInteger('--max-asset-file-bytes'),
    maxAssetFiles: positiveInteger('--max-asset-files'),
    maxTotalAssetBytes: positiveInteger('--max-total-asset-bytes'),
    historyNavigationAvailable: flags.has('--history-navigation-available'),
    replaceExisting: flags.has('--replace-existing'),
  };
}

/**
 * @param {string[]} arguments_
 * @returns {{action: 'help'} | {action: 'version'} | {action: 'build', options: Parameters<typeof buildSb3Bundle>[0]} | {action: 'build-dsl4', options: Dsl4CliOptions}}
 */
export function parseCliArguments(arguments_) {
  if (arguments_.includes('--help') || arguments_.includes('-h')) return {action: 'help'};
  if (arguments_.includes('--version') || arguments_.includes('-v')) return {action: 'version'};
  const [command, ...rest] = arguments_;
  if (command === 'build-sb3') {
    return {action: 'build', options: parseBuildSb3Arguments(rest)};
  }
  if (command === 'build-dsl4') {
    return {action: 'build-dsl4', options: parseBuildDsl4Arguments(rest)};
  }
  throw new Sb3BuilderError(
    `Expected the build-sb3 or build-dsl4 command, received ${command ?? '(none)'}.`,
    {stage: 'cli'},
  );
}

/**
 * @param {string[]} arguments_
 * @param {{stdout?: Pick<NodeJS.WriteStream, 'write'>}} [io]
 */
export async function runCli(arguments_, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const parsed = parseCliArguments(arguments_);
  if (parsed.action === 'help') {
    stdout.write(`${usage()}\n`);
    return null;
  }
  if (parsed.action === 'version') {
    stdout.write(`${packageVersion}\n`);
    return null;
  }
  if (parsed.action === 'build') {
    const result = await buildSb3Bundle(parsed.options);
    stdout.write(`Built ${result.outputPaths[`${parsed.options.outputName}.sb3`]}\n`);
    stdout.write(`Built ${result.outputPaths[`${parsed.options.outputName}.txt`]}\n`);
    stdout.write(`Built ${result.outputPaths[`${parsed.options.outputName}.manifest.json`]}\n`);
    return result;
  }
  const schema = JSON.parse(await readFile(dsl4SchemaUrl, 'utf8'));
  const result = await buildDsl4RuntimeComponentFile({
    ...parsed.options,
    sourceFrontend: createDsl4SourceFrontend(schema),
  });
  stdout.write(`Built ${path.basename(result.outputPath)}\n`);
  return result;
}
