import path from 'node:path';

import {packageVersion} from './constants.js';
import {Sb3BuilderError} from './errors.js';
import {buildSb3Bundle} from './index.js';
import {
  convertDsl32File,
  Dsl32ConversionError,
  formatConversionDiagnostic,
} from '../converter/index.js';

export function usage() {
  return `Usage:
  tmpose-kamishibai build-sb3 --base BASE.sb3 --script SOURCE.txt \\
    --assets assets.lock.json --output dist/sample --profile editor [options]

  tmpose-kamishibai convert-dsl4 --input SOURCE.txt \\
    --output STORY.kamishibai.yaml [--pose-models REPLACEMENTS.json]

build-sb3 options:
  --allow-file-root DIR   Allow file: assets below DIR (repeatable)
  --allow-http            Permit plain HTTP assets (HTTPS is the default)
  --timeout-ms N          Per-request timeout in milliseconds
  --max-asset-bytes N     Maximum bytes per asset
  --max-script-bytes N    Maximum embedded script bytes
  --max-redirects N       Maximum HTTP redirects

convert-dsl4 options:
  --pose-models FILE      Map exact TMPoseURL values to local poseModel assets

General options:
  --help                  Show this help
  --version               Show the package version

build-sb3 treats the output path as a basename and writes .sb3, .txt, and
.manifest.json files. convert-dsl4 never modifies its DSL 3.2 input and
atomically replaces only the explicitly selected YAML output.`;
}

/**
 * @param {string[]} arguments_
 * @returns {{action: 'help'} | {action: 'version'} | {action: 'build', options: Parameters<typeof buildSb3Bundle>[0]} | {action: 'convert', options: Parameters<typeof convertDsl32File>[0]}}
 */
export function parseCliArguments(arguments_) {
  if (arguments_.includes('--help') || arguments_.includes('-h')) return {action: 'help'};
  if (arguments_.includes('--version') || arguments_.includes('-v')) return {action: 'version'};
  const [command, ...rest] = arguments_;
  if (command === 'convert-dsl4') {
    const values = new Map();
    for (let index = 0; index < rest.length; index += 2) {
      const option = rest[index];
      const value = rest[index + 1];
      if (!['--input', '--output', '--pose-models'].includes(option)) {
        throw new Sb3BuilderError(`Unknown option: ${option}`, {stage: 'cli'});
      }
      if (!value || value.startsWith('--')) {
        throw new Sb3BuilderError(`${option} requires a value.`, {stage: 'cli'});
      }
      if (values.has(option)) {
        throw new Sb3BuilderError(`Duplicate option: ${option}`, {stage: 'cli'});
      }
      values.set(option, value);
    }
    for (const required of ['--input', '--output']) {
      if (!values.has(required)) {
        throw new Sb3BuilderError(`Missing required option: ${required}`, {stage: 'cli'});
      }
    }
    return {
      action: 'convert',
      options: {
        inputPath: path.resolve(/** @type {string} */ (values.get('--input'))),
        outputPath: path.resolve(/** @type {string} */ (values.get('--output'))),
        ...(values.has('--pose-models')
          ? {
              poseModelMapPath: path.resolve(/** @type {string} */ (values.get('--pose-models'))),
            }
          : {}),
      },
    };
  }
  if (command !== 'build-sb3') {
    throw new Sb3BuilderError(
      `Expected the build-sb3 or convert-dsl4 command, received ${command ?? '(none)'}.`,
      {stage: 'cli'},
    );
  }
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
      if (values.has(option))
        throw new Sb3BuilderError(`Duplicate option: ${option}`, {stage: 'cli'});
      values.set(option, value);
    } else {
      throw new Sb3BuilderError(`Unknown option: ${option}`, {stage: 'cli'});
    }
    index += 1;
  }
  for (const required of ['--base', '--script', '--assets', '--output', '--profile']) {
    if (!values.has(required))
      throw new Sb3BuilderError(`Missing required option: ${required}`, {stage: 'cli'});
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
    action: 'build',
    options: {
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
    },
  };
}

/**
 * @param {string[]} arguments_
 * @param {{stdout?: Pick<NodeJS.WriteStream, 'write'>, stderr?: Pick<NodeJS.WriteStream, 'write'>}} [io]
 */
export async function runCli(arguments_, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const parsed = parseCliArguments(arguments_);
  if (parsed.action === 'help') {
    stdout.write(`${usage()}\n`);
    return null;
  }
  if (parsed.action === 'version') {
    stdout.write(`${packageVersion}\n`);
    return null;
  }
  if (parsed.action === 'convert') {
    const result = await convertDsl32File(parsed.options);
    for (const diagnostic of result.diagnostics) {
      stderr.write(`${formatConversionDiagnostic(diagnostic, parsed.options.inputPath)}\n`);
    }
    if (!result.ok || !result.outputPath) {
      const errorCount = result.diagnostics.filter(
        (diagnostic) => diagnostic.severity === 'error',
      ).length;
      throw new Dsl32ConversionError(
        `DSL 3.2 to 4.0 conversion failed with ${errorCount} error(s).`,
        result.diagnostics,
        {reported: true},
      );
    }
    stdout.write(`Converted ${result.outputPath}\n`);
    return result;
  }
  const result = await buildSb3Bundle(parsed.options);
  stdout.write(`Built ${result.outputPaths[`${parsed.options.outputName}.sb3`]}\n`);
  stdout.write(`Built ${result.outputPaths[`${parsed.options.outputName}.txt`]}\n`);
  stdout.write(`Built ${result.outputPaths[`${parsed.options.outputName}.manifest.json`]}\n`);
  return result;
}
