import {readFile} from 'node:fs/promises';
import path from 'node:path';

import {
  convertDsl32File,
  Dsl32ConversionError,
  formatConversionDiagnostic,
} from '../converter/index.js';
import {dsl4BrowserPreviewArtifactLimits} from '../dsl4/browser-preview-artifact-limits.js';
import {packageVersion} from './constants.js';
import {dsl4CliDefaultLimits} from './dsl4-cli-default-limits.js';
import {runDsl4LocalPreviewCommand} from './dsl4-local-preview-command.js';
import {dsl4LocalPreviewBrowserBootstrapMaximums} from './dsl4-local-preview-browser-bootstrap.js';
import {createDsl4ProductionSourceFrontend} from './dsl4-source-frontend.js';
import {
  formatDsl4Diagnostic,
  serializeDsl4ValidationResult,
  validateDsl4SourceFile,
} from './dsl4-validate.js';
import {Sb3BuilderError} from './errors.js';
import {
  auditDsl4AssetDistribution,
  buildDsl4RuntimeComponentFile,
  buildSb3Bundle,
  convertDsl4ProjectAssets,
  formatDsl4AssetDistributionAudit,
  generateDsl4AssetDistributionLockFile,
  serializeDsl4AssetDistributionAudit,
  vendorDsl4AssetDistribution,
} from './index.js';

const dsl4SchemaUrl = new URL('../../schema/dsl-4.schema.json', import.meta.url);

export {dsl4CliDefaultLimits} from './dsl4-cli-default-limits.js';

const dsl4CliDefaultLimitOptions = Object.freeze({
  '--max-source-bytes': dsl4CliDefaultLimits.maxSourceBytes,
  '--max-asset-file-bytes': dsl4CliDefaultLimits.maxAssetFileBytes,
  '--max-asset-files': dsl4CliDefaultLimits.maxAssetFiles,
  '--max-total-asset-bytes': dsl4CliDefaultLimits.maxTotalAssetBytes,
});

function resolveDsl4CliDefaultLimit(
  values: Map<string, string>,
  option: keyof typeof dsl4CliDefaultLimitOptions,
) {
  const value = Number(values.get(option) ?? dsl4CliDefaultLimitOptions[option]);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Sb3BuilderError(`${option} must be an integer >= 1.`, {stage: 'cli'});
  }
  if (option === '--max-source-bytes' && value > dsl4CliDefaultLimits.maxSourceBytes) {
    throw new Sb3BuilderError(
      `--max-source-bytes must be <= ${dsl4CliDefaultLimits.maxSourceBytes}.`,
      {stage: 'cli'},
    );
  }
  return value;
}

function parseCliFlagAndValueOptions(
  arguments_: string[],
  {flagOptions, valueOptions}: {flagOptions: Set<string>; valueOptions: Set<string>},
) {
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < arguments_.length; index += 1) {
    const option = arguments_[index];
    if (flagOptions.has(option)) {
      if (flags.has(option)) {
        throw new Sb3BuilderError(`Duplicate option: ${option}`, {stage: 'cli'});
      }
      flags.add(option);
      continue;
    }
    if (!valueOptions.has(option)) {
      throw new Sb3BuilderError(`Unknown option: ${option}`, {stage: 'cli'});
    }
    const value = arguments_[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Sb3BuilderError(`${option} requires a value.`, {stage: 'cli'});
    }
    if (values.has(option)) {
      throw new Sb3BuilderError(`Duplicate option: ${option}`, {stage: 'cli'});
    }
    values.set(option, value);
    index += 1;
  }
  return {flags, values};
}

function requireCliValueOptions(values: Map<string, string>, requiredOptions: Iterable<string>) {
  for (const required of requiredOptions) {
    if (!values.has(required)) {
      throw new Sb3BuilderError(`Missing required option: ${required}`, {stage: 'cli'});
    }
  }
}

function readCliInteger(values: Map<string, string>, option: string, minimum: number) {
  const value = Number(values.get(option));
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Sb3BuilderError(`${option} must be an integer >= ${minimum}.`, {stage: 'cli'});
  }
  return value;
}

export function usage() {
  return `Usage:
  tm-kamishibai build-sb3 --base BASE.sb3 --script SOURCE.txt \\
    --assets assets.lock.json --output dist/sample --profile editor [options]

  tm-kamishibai build-dsl4 --base BASE.sb3 --project-root DIR \\
    --output dist/story.sb3 --control-profile production --channel bundled \\
    [--source STORY.k4.yml] [--source-id ID] \\
    [--source-manifest project.source.yml] \\
    [--asset-config FILE --asset-lock FILE --asset-profile PROFILE \\
     --max-asset-config-bytes N --max-asset-lock-bytes N] \\
    [--max-project-bytes N] [--max-project-json-bytes N] [options]

  tm-kamishibai convert-dsl4 --input SOURCE.txt \\
    --output STORY.k4.yml [--pose-models REPLACEMENTS.json]

  tm-kamishibai convert-dsl4-assets --project-root DIR \\
    [--source STORY.k4.yml] [--source-id ID] \\
    [--source-manifest project.source.yml] --base BASE.sb3 \\
    --output-dir converted --to local|remote|project \\
    --max-source-manifest-bytes N \\
    --max-remote-map-bytes N --max-base-sb3-bytes N \\
    --timeout-ms N --max-redirects N \\
    [--asset ASSET_ID] [--remote-map FILE | \\
     --rsync-destination USER@HOST:/PATH --remote-base-url HTTPS_URL] \\
    [--rsync-ssh-port N] [--rsync-timeout-ms N] \\
    [--allow-host HOST] [--output-name NAME]

  tm-kamishibai validate-dsl4 --input STORY.k4.yml \\
    [--format pretty|json]

  tm-kamishibai audit-dsl4-assets --project-root DIR \\
    [--source STORY.k4.yml] [--source-id ID] \\
    [--source-manifest project.source.yml] \\
    --asset-config project.assets.json --asset-lock project.assets.lock.json \\
    --asset-profile PROFILE --max-source-manifest-bytes N \\
    --max-asset-config-bytes N \\
    --max-asset-lock-bytes N [--format pretty|json] [options]

  tm-kamishibai lock-dsl4-assets --project-root DIR \\
    [--source STORY.k4.yml] [--source-id ID] \\
    [--source-manifest project.source.yml] --asset-config project.assets.json \\
    --output project.assets.lock.json --allow-host HOST [options]

  tm-kamishibai vendor-dsl4-assets --project-root DIR \\
    --asset-config project.assets.json --asset-lock project.assets.lock.json \\
    --output-config project.assets.offline.json --output-lock project.assets.offline.lock.json \\
    --allow-host HOST [options]

  tm-kamishibai preview-dsl4 --watch --base BASE.sb3 --project-root DIR \\
    --control-profile production --channel bundled \\
    [--source STORY.k4.yml] [--source-id ID] \\
    [--source-manifest project.source.yml] [options]

DSL 3.1/3.2 build-sb3 options:
  --allow-file-root DIR   Allow file: assets below DIR (repeatable)
  --allow-http            Permit plain HTTP assets (HTTPS is the default)
  --timeout-ms N          Per-request timeout in milliseconds
  --max-asset-bytes N     Maximum bytes per asset
  --max-script-bytes N    Maximum embedded script bytes
  --max-redirects N       Maximum HTTP redirects

DSL 4.0 build-dsl4 options:
  --enable-source-includes       Enable multi-file include processing
  --enable-root-binary-entries  Package DSL assets as root content-addressed ZIP entries
  --max-source-files N          Maximum files in the include graph
  --max-total-source-bytes N    Maximum graph total and composed source bytes
  --max-include-depth N         Maximum include graph depth
  --history-navigation-available  Permit a selected history.* keymap
  --replace-existing              Replace a same-channel component in the base SB3
  --asset-config FILE             Asset distribution config (requires lock and profile)
  --asset-lock FILE               Asset distribution lock (requires config and profile)
  --asset-profile PROFILE         Explicit asset distribution profile
  --max-asset-config-bytes N      Maximum asset config bytes
  --max-asset-lock-bytes N        Maximum asset lock bytes

DSL 4.0 preview-dsl4 options:
  --watch                         Keep watching the selected source (required)
  --enable-source-includes        Enable transactional Source Graph watching
  --max-source-files N            Maximum files in the include graph
  --max-total-source-bytes N      Maximum graph total and composed source bytes
  --max-include-depth N           Maximum include graph depth
  --max-project-bytes N           Maximum compressed preview SB3 bytes
  --max-project-json-bytes N      Maximum expanded project.json bytes
  --allow-large-preview-artifacts Acknowledge memory risk above recommended limits
  --port N                        Loopback port; 0 lets the OS select one (default)
  --replace-existing              Replace a same-channel component in the base SB3

DSL 4.0 common limit options (when supported):
  --max-source-bytes N       Maximum source bytes (default: 1048576)
  --max-asset-file-bytes N   Maximum bytes per asset file (default: 16777216)
  --max-asset-files N        Maximum asset files/pose entries (default: 256)
  --max-total-asset-bytes N  Maximum total asset bytes (default: 134217728)

Omit these four options for normal projects. The source limit is the current fixed
canonical maximum. Review memory, disk, and network impact before raising asset limits;
browser preview currently caps source bytes and asset files at their defaults.

DSL 4.0 project source options (when supported):
  --source FILE             Override the root-level entry source
  --source-id ID            Override the diagnostic source ID (default: main)
  --source-manifest FILE    Use an explicit manifest; otherwise discover one

Without an explicit source, the CLI uses the manifest path or the only root-level
*.k4.yml file. Zero or multiple candidates fail instead of choosing a fixed filename.

convert-dsl4 options:
  --pose-models FILE      Optionally embed exact TMURL values as local poseModel assets

convert-dsl4-assets options:
  --asset ASSET_ID             Convert one asset (repeatable; omitted means all assets)
  --to local|remote|project    Destination representation
  --remote-map FILE            JSON map of asset IDs to verified remote source metadata
  --rsync-destination TARGET   rsync SSH target in safe [user@]host:/absolute/path form
  --remote-base-url URL        Public HTTPS directory URL corresponding to the rsync target
  --rsync-ssh-port N           SSH port for rsync (default: 22)
  --rsync-timeout-ms N         Overall rsync timeout (default: --timeout-ms)
  --allow-host HOST            Allowed HTTPS hostname for downloads (repeatable)
  --output-dir DIR             New reusable project root with manifest, YAML, SB3, and assets
  --output-name NAME           Output filename stem (defaults to the input story name)
  --max-remote-map-bytes N     Maximum remote mapping JSON bytes
  --max-base-sb3-bytes N       Maximum input SB3 bytes

validate-dsl4 options:
  --format FORMAT         Diagnostic output: pretty (default) or json

audit-dsl4-assets options:
  --enable-source-includes       Enable multi-file include processing
  --max-source-files N          Maximum files in the include graph
  --max-total-source-bytes N    Maximum total bytes in the include graph
  --max-include-depth N         Maximum include graph depth
  --format FORMAT               Audit output: pretty (default) or json

lock-dsl4-assets options:
  --allow-host HOST             Allowed HTTPS remote hostname (repeatable)
  --timeout-ms N                Per-request timeout in milliseconds
  --max-redirects N             Maximum HTTPS redirects
  --max-asset-file-bytes N      Maximum bytes per local or remote asset
  --max-asset-files N           Maximum local/expanded pose entries
  --max-total-asset-bytes N     Maximum total inspected bytes

vendor-dsl4-assets options:
  --vendor-dir DIR              Project-relative content-addressed mirror root
  --allow-host HOST             Allowed HTTPS remote hostname (repeatable)
  --timeout-ms N                Per-request timeout in milliseconds
  --max-redirects N             Maximum HTTPS redirects
  --max-asset-config-bytes N    Maximum input config bytes
  --max-asset-lock-bytes N      Maximum input lock bytes
  --max-asset-file-bytes N      Maximum bytes per remote asset
  --max-asset-files N           Maximum vendored files/pose entries
  --max-total-asset-bytes N     Maximum total downloaded bytes

General options:
  --help                  Show this help
  --version               Show the package version

build-sb3 takes an output basename and writes .sb3, .txt, and .manifest.json.
build-dsl4 writes one self-contained SB3 after revalidating the disk candidate.
preview-dsl4 builds a development-only browser runtime in memory, opens the system
browser, and reports success only after the authenticated runtime-ready acknowledgement.
validate-dsl4 uses the production canonicalizer, schema, semantics, and diagnostics.
audit-dsl4-assets resolves a frozen asset lock without network access or file writes.
lock-dsl4-assets fetches only allowlisted HTTPS providers and atomically writes a canonical lock.
vendor-dsl4-assets fetches and verifies lock providers, then atomically installs a content-addressed
mirror and generated config/lock files for offline resolution.
convert-dsl4-assets writes one new authoring directory and never overwrites inputs or remote files
outside its content-addressed rsync payload names. It never performs remote deletion.
convert-dsl4 never modifies its DSL 3.2 input and atomically replaces only the
explicitly selected YAML output.`;
}

function parseValidateDsl4Arguments(arguments_: string[]): {
  input: string;
  format: 'pretty' | 'json';
  maxSourceBytes: number;
} {
  const values = new Map();
  const allowed = new Set(['--input', '--format', '--max-source-bytes']);
  for (let index = 0; index < arguments_.length; index += 2) {
    const option = arguments_[index];
    const value = arguments_[index + 1];
    if (!allowed.has(option)) {
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
  for (const required of ['--input']) {
    if (!values.has(required)) {
      throw new Sb3BuilderError(`Missing required option: ${required}`, {stage: 'cli'});
    }
  }
  const maxSourceBytes = resolveDsl4CliDefaultLimit(values, '--max-source-bytes');
  const format = values.get('--format') ?? 'pretty';
  if (format !== 'pretty' && format !== 'json') {
    throw new Sb3BuilderError('--format must be either pretty or json.', {stage: 'cli'});
  }
  return {
    input: path.resolve(values.get('--input') as string),
    format,
    maxSourceBytes,
  };
}

function parseAuditDsl4AssetArguments(arguments_: string[]): {
  projectRoot: string;
  sourceManifest?: string;
  source?: string;
  sourceId?: string;
  assetConfig: string;
  assetLock: string;
  assetProfile: string;
  format: 'pretty' | 'json';
  maxSourceBytes: number;
  maxSourceManifestBytes: number;
  maxAssetConfigBytes: number;
  maxAssetLockBytes: number;
  sourceIncludesEnabled: boolean;
  maxSourceFiles?: number;
  maxTotalSourceBytes?: number;
  maxIncludeDepth?: number;
} {
  const values = new Map();
  const flags = new Set();
  const flagOptions = new Set(['--enable-source-includes']);
  const allowedValueOptions = new Set([
    '--project-root',
    '--source-manifest',
    '--source',
    '--source-id',
    '--asset-config',
    '--asset-lock',
    '--asset-profile',
    '--max-source-bytes',
    '--max-source-manifest-bytes',
    '--max-asset-config-bytes',
    '--max-asset-lock-bytes',
    '--max-source-files',
    '--max-total-source-bytes',
    '--max-include-depth',
    '--format',
  ]);

  for (let index = 0; index < arguments_.length; index += 1) {
    const option = arguments_[index];
    if (flagOptions.has(option)) {
      if (flags.has(option)) {
        throw new Sb3BuilderError(`Duplicate option: ${option}`, {stage: 'cli'});
      }
      flags.add(option);
      continue;
    }
    if (!allowedValueOptions.has(option)) {
      throw new Sb3BuilderError(`Unknown option: ${option}`, {stage: 'cli'});
    }
    const value = arguments_[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Sb3BuilderError(`${option} requires a value.`, {stage: 'cli'});
    }
    if (values.has(option)) {
      throw new Sb3BuilderError(`Duplicate option: ${option}`, {stage: 'cli'});
    }
    values.set(option, value);
    index += 1;
  }

  for (const required of [
    '--project-root',
    '--asset-config',
    '--asset-lock',
    '--asset-profile',
    '--max-source-manifest-bytes',
    '--max-asset-config-bytes',
    '--max-asset-lock-bytes',
  ]) {
    if (!values.has(required)) {
      throw new Sb3BuilderError(`Missing required option: ${required}`, {stage: 'cli'});
    }
  }

  const positiveInteger = (option: string) => {
    const value = Number(values.get(option));
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Sb3BuilderError(`${option} must be an integer >= 1.`, {stage: 'cli'});
    }
    return value;
  };
  const maxSourceBytes = resolveDsl4CliDefaultLimit(values, '--max-source-bytes');
  const maxSourceManifestBytes = positiveInteger('--max-source-manifest-bytes');
  const maxAssetConfigBytes = positiveInteger('--max-asset-config-bytes');
  const maxAssetLockBytes = positiveInteger('--max-asset-lock-bytes');
  const format = values.get('--format') ?? 'pretty';
  if (format !== 'pretty' && format !== 'json') {
    throw new Sb3BuilderError('--format must be either pretty or json.', {stage: 'cli'});
  }

  const sourceIncludesEnabled = flags.has('--enable-source-includes');
  const sourceGraphOptions = [
    '--max-source-files',
    '--max-total-source-bytes',
    '--max-include-depth',
  ];
  if (!sourceIncludesEnabled) {
    const unexpected = sourceGraphOptions.find((option) => values.has(option));
    if (unexpected) {
      throw new Sb3BuilderError(`${unexpected} requires --enable-source-includes.`, {stage: 'cli'});
    }
  } else {
    const missing = sourceGraphOptions.find((option) => !values.has(option));
    if (missing) {
      throw new Sb3BuilderError(`${missing} is required with --enable-source-includes.`, {
        stage: 'cli',
      });
    }
  }

  const maxTotalSourceBytes = sourceIncludesEnabled
    ? positiveInteger('--max-total-source-bytes')
    : undefined;
  if (maxTotalSourceBytes !== undefined && maxTotalSourceBytes < maxSourceBytes) {
    throw new Sb3BuilderError(
      '--max-total-source-bytes must be greater than or equal to --max-source-bytes.',
      {stage: 'cli'},
    );
  }

  return {
    projectRoot: path.resolve(values.get('--project-root') as string),
    ...(values.has('--source-manifest')
      ? {sourceManifest: path.resolve(values.get('--source-manifest') as string)}
      : {}),
    ...(values.has('--source') ? {source: values.get('--source')} : {}),
    ...(values.has('--source-id') ? {sourceId: values.get('--source-id')} : {}),
    assetConfig: path.resolve(values.get('--asset-config') as string),
    assetLock: path.resolve(values.get('--asset-lock') as string),
    assetProfile: values.get('--asset-profile') as string,
    format,
    maxSourceBytes,
    maxSourceManifestBytes,
    maxAssetConfigBytes,
    maxAssetLockBytes,
    sourceIncludesEnabled,
    ...(sourceIncludesEnabled
      ? {
          maxSourceFiles: positiveInteger('--max-source-files'),
          maxTotalSourceBytes,
          maxIncludeDepth: positiveInteger('--max-include-depth'),
        }
      : {}),
  };
}

function parseLockDsl4AssetArguments(arguments_: string[]): {
  projectRoot: string;
  sourceManifest?: string;
  source?: string;
  sourceId?: string;
  assetConfig: string;
  output: string;
  maxSourceBytes: number;
  maxSourceManifestBytes: number;
  maxAssetFileBytes: number;
  maxAssetFiles: number;
  maxTotalAssetBytes: number;
  timeoutMs: number;
  maxRedirects: number;
  allowedHosts: string[];
  sourceIncludesEnabled: boolean;
  maxSourceFiles?: number;
  maxTotalSourceBytes?: number;
  maxIncludeDepth?: number;
} {
  const values = new Map();
  const allowedHosts = [];
  const flags = new Set();
  const flagOptions = new Set(['--enable-source-includes']);
  const allowedValueOptions = new Set([
    '--project-root',
    '--source-manifest',
    '--source',
    '--source-id',
    '--asset-config',
    '--output',
    '--max-source-bytes',
    '--max-source-manifest-bytes',
    '--max-asset-file-bytes',
    '--max-asset-files',
    '--max-total-asset-bytes',
    '--timeout-ms',
    '--max-redirects',
    '--max-source-files',
    '--max-total-source-bytes',
    '--max-include-depth',
    '--allow-host',
  ]);
  for (let index = 0; index < arguments_.length; index += 1) {
    const option = arguments_[index];
    if (flagOptions.has(option)) {
      if (flags.has(option))
        throw new Sb3BuilderError(`Duplicate option: ${option}`, {stage: 'cli'});
      flags.add(option);
      continue;
    }
    if (!allowedValueOptions.has(option)) {
      throw new Sb3BuilderError(`Unknown option: ${option}`, {stage: 'cli'});
    }
    const value = arguments_[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Sb3BuilderError(`${option} requires a value.`, {stage: 'cli'});
    }
    if (option === '--allow-host') {
      allowedHosts.push(value);
    } else {
      if (values.has(option))
        throw new Sb3BuilderError(`Duplicate option: ${option}`, {stage: 'cli'});
      values.set(option, value);
    }
    index += 1;
  }
  for (const required of [
    '--project-root',
    '--asset-config',
    '--output',
    '--max-source-manifest-bytes',
    '--timeout-ms',
    '--max-redirects',
  ]) {
    if (!values.has(required))
      throw new Sb3BuilderError(`Missing required option: ${required}`, {stage: 'cli'});
  }
  if (allowedHosts.length === 0) {
    throw new Sb3BuilderError('Missing required option: --allow-host', {stage: 'cli'});
  }
  const positiveInteger = (option: string) => {
    const value = Number(values.get(option));
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Sb3BuilderError(`${option} must be an integer >= 1.`, {stage: 'cli'});
    }
    return value;
  };
  const nonNegativeInteger = (option: string) => {
    const value = Number(values.get(option));
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Sb3BuilderError(`${option} must be an integer >= 0.`, {stage: 'cli'});
    }
    return value;
  };
  const maxSourceBytes = resolveDsl4CliDefaultLimit(values, '--max-source-bytes');
  const maxSourceManifestBytes = positiveInteger('--max-source-manifest-bytes');
  const maxAssetFileBytes = resolveDsl4CliDefaultLimit(values, '--max-asset-file-bytes');
  const maxAssetFiles = resolveDsl4CliDefaultLimit(values, '--max-asset-files');
  const maxTotalAssetBytes = resolveDsl4CliDefaultLimit(values, '--max-total-asset-bytes');
  const timeoutMs = positiveInteger('--timeout-ms');
  const maxRedirects = nonNegativeInteger('--max-redirects');
  if (maxAssetFileBytes > maxTotalAssetBytes) {
    throw new Sb3BuilderError('--max-asset-file-bytes must be <= --max-total-asset-bytes.', {
      stage: 'cli',
    });
  }
  const sourceIncludesEnabled = flags.has('--enable-source-includes');
  const sourceGraphOptions = [
    '--max-source-files',
    '--max-total-source-bytes',
    '--max-include-depth',
  ];
  if (!sourceIncludesEnabled) {
    const unexpected = sourceGraphOptions.find((option) => values.has(option));
    if (unexpected)
      throw new Sb3BuilderError(`${unexpected} requires --enable-source-includes.`, {stage: 'cli'});
  } else {
    const missing = sourceGraphOptions.find((option) => !values.has(option));
    if (missing)
      throw new Sb3BuilderError(`${missing} is required with --enable-source-includes.`, {
        stage: 'cli',
      });
  }
  const maxTotalSourceBytes = sourceIncludesEnabled
    ? positiveInteger('--max-total-source-bytes')
    : undefined;
  if (maxTotalSourceBytes !== undefined && maxTotalSourceBytes < maxSourceBytes) {
    throw new Sb3BuilderError(
      '--max-total-source-bytes must be greater than or equal to --max-source-bytes.',
      {stage: 'cli'},
    );
  }
  return {
    projectRoot: path.resolve(values.get('--project-root') as string),
    ...(values.has('--source-manifest')
      ? {sourceManifest: path.resolve(values.get('--source-manifest') as string)}
      : {}),
    ...(values.has('--source') ? {source: values.get('--source')} : {}),
    ...(values.has('--source-id') ? {sourceId: values.get('--source-id')} : {}),
    assetConfig: path.resolve(values.get('--asset-config') as string),
    output: path.resolve(values.get('--output') as string),
    maxSourceBytes,
    maxSourceManifestBytes,
    maxAssetFileBytes,
    maxAssetFiles,
    maxTotalAssetBytes,
    timeoutMs,
    maxRedirects,
    allowedHosts,
    sourceIncludesEnabled,
    ...(sourceIncludesEnabled
      ? {
          maxSourceFiles: positiveInteger('--max-source-files'),
          maxTotalSourceBytes,
          maxIncludeDepth: positiveInteger('--max-include-depth'),
        }
      : {}),
  };
}

function parseVendorDsl4AssetArguments(arguments_: string[]): {
  projectRoot: string;
  assetConfig: string;
  assetLock: string;
  outputConfig: string;
  outputLock: string;
  vendorDirectory?: string;
  maxAssetConfigBytes: number;
  maxAssetLockBytes: number;
  maxAssetFileBytes: number;
  maxAssetFiles: number;
  maxTotalAssetBytes: number;
  timeoutMs: number;
  maxRedirects: number;
  allowedHosts: string[];
} {
  const values = new Map();
  const allowedHosts = [];
  const allowed = new Set([
    '--project-root',
    '--asset-config',
    '--asset-lock',
    '--output-config',
    '--output-lock',
    '--vendor-dir',
    '--max-asset-config-bytes',
    '--max-asset-lock-bytes',
    '--max-asset-file-bytes',
    '--max-asset-files',
    '--max-total-asset-bytes',
    '--timeout-ms',
    '--max-redirects',
    '--allow-host',
  ]);
  for (let index = 0; index < arguments_.length; index += 2) {
    const option = arguments_[index];
    const value = arguments_[index + 1];
    if (!allowed.has(option))
      throw new Sb3BuilderError(`Unknown option: ${option}`, {stage: 'cli'});
    if (!value || value.startsWith('--'))
      throw new Sb3BuilderError(`${option} requires a value.`, {stage: 'cli'});
    if (option === '--allow-host') {
      allowedHosts.push(value);
    } else {
      if (values.has(option))
        throw new Sb3BuilderError(`Duplicate option: ${option}`, {stage: 'cli'});
      values.set(option, value);
    }
  }
  for (const required of [
    '--project-root',
    '--asset-config',
    '--asset-lock',
    '--output-config',
    '--output-lock',
    '--max-asset-config-bytes',
    '--max-asset-lock-bytes',
    '--timeout-ms',
    '--max-redirects',
  ]) {
    if (!values.has(required))
      throw new Sb3BuilderError(`Missing required option: ${required}`, {stage: 'cli'});
  }
  if (allowedHosts.length === 0)
    throw new Sb3BuilderError('Missing required option: --allow-host', {stage: 'cli'});
  const integer = (option: string, minimum: number) => {
    const value = Number(values.get(option));
    if (!Number.isSafeInteger(value) || value < minimum) {
      throw new Sb3BuilderError(`${option} must be an integer >= ${minimum}.`, {stage: 'cli'});
    }
    return value;
  };
  const maxAssetConfigBytes = integer('--max-asset-config-bytes', 1);
  const maxAssetLockBytes = integer('--max-asset-lock-bytes', 1);
  const maxAssetFileBytes = resolveDsl4CliDefaultLimit(values, '--max-asset-file-bytes');
  const maxTotalAssetBytes = resolveDsl4CliDefaultLimit(values, '--max-total-asset-bytes');
  if (maxAssetFileBytes > maxTotalAssetBytes) {
    throw new Sb3BuilderError('--max-asset-file-bytes must be <= --max-total-asset-bytes.', {
      stage: 'cli',
    });
  }
  return {
    projectRoot: path.resolve(values.get('--project-root') as string),
    assetConfig: path.resolve(values.get('--asset-config') as string),
    assetLock: path.resolve(values.get('--asset-lock') as string),
    outputConfig: path.resolve(values.get('--output-config') as string),
    outputLock: path.resolve(values.get('--output-lock') as string),
    ...(values.has('--vendor-dir') ? {vendorDirectory: values.get('--vendor-dir')} : {}),
    maxAssetConfigBytes,
    maxAssetLockBytes,
    maxAssetFileBytes,
    maxAssetFiles: resolveDsl4CliDefaultLimit(values, '--max-asset-files'),
    maxTotalAssetBytes,
    timeoutMs: integer('--timeout-ms', 1),
    maxRedirects: integer('--max-redirects', 0),
    allowedHosts,
  };
}

function parseConvertDsl4Arguments(arguments_: string[]): Parameters<typeof convertDsl32File>[0] {
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const option = arguments_[index];
    const value = arguments_[index + 1];
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
    inputPath: path.resolve(values.get('--input') as string),
    outputPath: path.resolve(values.get('--output') as string),
    ...(values.has('--pose-models')
      ? {poseModelMapPath: path.resolve(values.get('--pose-models') as string)}
      : {}),
  };
}

function parseConvertDsl4AssetsArguments(
  arguments_: string[],
): Omit<Parameters<typeof convertDsl4ProjectAssets>[0], 'sourceFrontend'> {
  const values = new Map();
  const assets = [];
  const allowedHosts = [];
  const allowed = new Set([
    '--project-root',
    '--source-manifest',
    '--source',
    '--source-id',
    '--base',
    '--output-dir',
    '--output-name',
    '--to',
    '--asset',
    '--remote-map',
    '--rsync-destination',
    '--remote-base-url',
    '--rsync-ssh-port',
    '--rsync-timeout-ms',
    '--allow-host',
    '--max-source-bytes',
    '--max-source-manifest-bytes',
    '--max-remote-map-bytes',
    '--max-base-sb3-bytes',
    '--max-asset-file-bytes',
    '--max-asset-files',
    '--max-total-asset-bytes',
    '--timeout-ms',
    '--max-redirects',
  ]);
  for (let index = 0; index < arguments_.length; index += 2) {
    const option = arguments_[index];
    const value = arguments_[index + 1];
    if (!allowed.has(option)) {
      throw new Sb3BuilderError(`Unknown option: ${option}`, {stage: 'cli'});
    }
    if (!value || value.startsWith('--')) {
      throw new Sb3BuilderError(`${option} requires a value.`, {stage: 'cli'});
    }
    if (option === '--asset') assets.push(value);
    else if (option === '--allow-host') allowedHosts.push(value);
    else {
      if (values.has(option)) {
        throw new Sb3BuilderError(`Duplicate option: ${option}`, {stage: 'cli'});
      }
      values.set(option, value);
    }
  }
  const required = [
    '--project-root',
    '--base',
    '--output-dir',
    '--to',
    '--max-source-manifest-bytes',
    '--max-remote-map-bytes',
    '--max-base-sb3-bytes',
    '--timeout-ms',
    '--max-redirects',
  ];
  for (const option of required) {
    if (!values.has(option)) {
      throw new Sb3BuilderError(`Missing required option: ${option}`, {stage: 'cli'});
    }
  }
  const integer = (option: string, minimum: number) => {
    const value = Number(values.get(option));
    if (!Number.isSafeInteger(value) || value < minimum) {
      throw new Sb3BuilderError(`${option} must be an integer >= ${minimum}.`, {stage: 'cli'});
    }
    return value;
  };
  const to = values.get('--to');
  if (to !== 'local' && to !== 'project' && to !== 'remote') {
    throw new Sb3BuilderError('--to must be local, project, or remote.', {stage: 'cli'});
  }
  const maxAssetFileBytes = resolveDsl4CliDefaultLimit(values, '--max-asset-file-bytes');
  const maxTotalAssetBytes = resolveDsl4CliDefaultLimit(values, '--max-total-asset-bytes');
  if (maxAssetFileBytes > maxTotalAssetBytes) {
    throw new Sb3BuilderError('--max-asset-file-bytes must be <= --max-total-asset-bytes.', {
      stage: 'cli',
    });
  }
  const hasRsyncDestination = values.has('--rsync-destination');
  const hasRemoteBaseUrl = values.has('--remote-base-url');
  const hasRsyncOption =
    hasRsyncDestination ||
    hasRemoteBaseUrl ||
    values.has('--rsync-ssh-port') ||
    values.has('--rsync-timeout-ms');
  if (hasRsyncOption && (!hasRsyncDestination || !hasRemoteBaseUrl)) {
    throw new Sb3BuilderError(
      '--rsync-destination and --remote-base-url must be specified together.',
      {stage: 'cli'},
    );
  }
  if (hasRsyncOption && to !== 'remote') {
    throw new Sb3BuilderError('rsync options require --to remote.', {stage: 'cli'});
  }
  if (hasRsyncOption && values.has('--remote-map')) {
    throw new Sb3BuilderError('--remote-map cannot be combined with rsync options.', {
      stage: 'cli',
    });
  }
  const rsyncSshPort = values.has('--rsync-ssh-port') ? integer('--rsync-ssh-port', 1) : 22;
  if (rsyncSshPort > 65_535) {
    throw new Sb3BuilderError('--rsync-ssh-port must be <= 65535.', {stage: 'cli'});
  }
  return {
    projectRoot: path.resolve(values.get('--project-root') as string),
    ...(values.has('--source-manifest')
      ? {sourceManifest: path.resolve(values.get('--source-manifest') as string)}
      : {}),
    ...(values.has('--source') ? {source: values.get('--source')} : {}),
    ...(values.has('--source-id') ? {sourceId: values.get('--source-id')} : {}),
    baseSb3: path.resolve(values.get('--base') as string),
    outputDirectory: path.resolve(values.get('--output-dir') as string),
    to,
    assets,
    allowedHosts,
    maxSourceBytes: resolveDsl4CliDefaultLimit(values, '--max-source-bytes'),
    maxSourceManifestBytes: integer('--max-source-manifest-bytes', 1),
    maxRemoteMapBytes: integer('--max-remote-map-bytes', 1),
    maxBaseSb3Bytes: integer('--max-base-sb3-bytes', 1),
    maxAssetFileBytes,
    maxAssetFiles: resolveDsl4CliDefaultLimit(values, '--max-asset-files'),
    maxTotalAssetBytes,
    timeoutMs: integer('--timeout-ms', 1),
    maxRedirects: integer('--max-redirects', 0),
    ...(values.has('--remote-map')
      ? {remoteMap: path.resolve(values.get('--remote-map') as string)}
      : {}),
    ...(hasRsyncOption
      ? {
          rsyncDestination: values.get('--rsync-destination'),
          remoteBaseUrl: values.get('--remote-base-url'),
          rsyncSshPort,
          rsyncTimeoutMs: values.has('--rsync-timeout-ms')
            ? integer('--rsync-timeout-ms', 1)
            : integer('--timeout-ms', 1),
        }
      : {}),
    ...(values.has('--output-name') ? {outputName: values.get('--output-name')} : {}),
  };
}

function parseBuildSb3Arguments(rest: string[]): Parameters<typeof buildSb3Bundle>[0] {
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
  const numberValue = (option: string) => {
    const raw = values.get(option);
    if (raw === undefined) return undefined;
    const value = Number(raw);
    const minimum = option === '--max-redirects' ? 0 : 1;
    if (!Number.isInteger(value) || value < minimum) {
      throw new Sb3BuilderError(`${option} must be an integer >= ${minimum}.`, {stage: 'cli'});
    }
    return value;
  };
  const outputBase = path.resolve(values.get('--output') as string);
  const profile = values.get('--profile');
  if (profile !== 'editor' && profile !== 'player') {
    throw new Sb3BuilderError('--profile must be either editor or player.', {stage: 'cli'});
  }
  return {
    baseSb3: path.resolve(values.get('--base') as string),
    sourceScript: path.resolve(values.get('--script') as string),
    assetManifest: path.resolve(values.get('--assets') as string),
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

export type Dsl4CliOptions = Omit<
  Parameters<typeof buildDsl4RuntimeComponentFile>[0],
  'sourceFrontend'
>;

function parseBuildDsl4Arguments(rest: string[]): Dsl4CliOptions {
  const booleanOptions = new Set([
    '--enable-source-includes',
    '--enable-root-binary-entries',
    '--history-navigation-available',
    '--replace-existing',
  ]);
  const requiredValueOptions = new Set([
    '--base',
    '--project-root',
    '--output',
    '--control-profile',
    '--channel',
  ]);
  const defaultedValueOptions = new Set([
    '--max-source-bytes',
    '--max-asset-file-bytes',
    '--max-asset-files',
    '--max-total-asset-bytes',
  ]);
  const valueOptions = new Set([
    ...requiredValueOptions,
    ...defaultedValueOptions,
    '--source-manifest',
    '--source',
    '--source-id',
    '--max-source-files',
    '--max-total-source-bytes',
    '--max-include-depth',
    '--asset-config',
    '--asset-lock',
    '--asset-profile',
    '--max-asset-config-bytes',
    '--max-asset-lock-bytes',
  ]);
  const {flags, values} = parseCliFlagAndValueOptions(rest, {
    flagOptions: booleanOptions,
    valueOptions,
  });
  requireCliValueOptions(values, requiredValueOptions);
  if (flags.has('--enable-source-includes')) {
    requireCliValueOptions(values, [
      '--max-source-files',
      '--max-total-source-bytes',
      '--max-include-depth',
    ]);
  }
  const positiveInteger = (option: string) => readCliInteger(values, option, 1);
  const channel = values.get('--channel');
  if (channel !== 'bundled' && channel !== 'unbundled') {
    throw new Sb3BuilderError('--channel must be either bundled or unbundled.', {stage: 'cli'});
  }
  const maxSourceBytes = resolveDsl4CliDefaultLimit(values, '--max-source-bytes');
  const sourceIncludesEnabled = flags.has('--enable-source-includes');
  const rootBinaryEntriesEnabled = flags.has('--enable-root-binary-entries');
  const maxTotalSourceBytes = sourceIncludesEnabled
    ? positiveInteger('--max-total-source-bytes')
    : null;
  if (maxTotalSourceBytes !== null && maxTotalSourceBytes < maxSourceBytes) {
    throw new Sb3BuilderError(
      '--max-total-source-bytes must be greater than or equal to --max-source-bytes.',
      {stage: 'cli'},
    );
  }
  const distributionOptions = ['--asset-config', '--asset-lock', '--asset-profile'];
  const distributionSelected = distributionOptions.some((option) => values.has(option));
  if (distributionSelected) {
    for (const required of [
      ...distributionOptions,
      '--max-asset-config-bytes',
      '--max-asset-lock-bytes',
    ]) {
      if (!values.has(required)) {
        throw new Sb3BuilderError(`${required} is required with asset distribution options.`, {
          stage: 'cli',
        });
      }
    }
  } else if (values.has('--max-asset-config-bytes') || values.has('--max-asset-lock-bytes')) {
    throw new Sb3BuilderError(
      '--max-asset-config-bytes and --max-asset-lock-bytes require asset distribution options.',
      {stage: 'cli'},
    );
  }
  return {
    baseSb3: path.resolve(values.get('--base') as string),
    projectRoot: path.resolve(values.get('--project-root') as string),
    ...(values.has('--source-manifest')
      ? {sourceManifest: path.resolve(values.get('--source-manifest') as string)}
      : {}),
    ...(values.has('--source') ? {source: values.get('--source')} : {}),
    ...(values.has('--source-id') ? {sourceId: values.get('--source-id')} : {}),
    output: path.resolve(values.get('--output') as string),
    controlProfile: values.get('--control-profile') as string,
    channel,
    maxSourceBytes,
    maxAssetFileBytes: resolveDsl4CliDefaultLimit(values, '--max-asset-file-bytes'),
    maxAssetFiles: resolveDsl4CliDefaultLimit(values, '--max-asset-files'),
    maxTotalAssetBytes: resolveDsl4CliDefaultLimit(values, '--max-total-asset-bytes'),
    ...(distributionSelected
      ? {
          assetConfig: path.resolve(values.get('--asset-config') as string),
          assetLock: path.resolve(values.get('--asset-lock') as string),
          assetProfile: values.get('--asset-profile') as string,
          maxAssetConfigBytes: positiveInteger('--max-asset-config-bytes'),
          maxAssetLockBytes: positiveInteger('--max-asset-lock-bytes'),
        }
      : {}),
    ...(sourceIncludesEnabled || rootBinaryEntriesEnabled
      ? {
          featureFlags: {
            dsl4Runtime: true,
            ...(sourceIncludesEnabled ? {dsl4SourceIncludes: true} : {}),
            ...(rootBinaryEntriesEnabled ? {dsl4RootBinaryEntryPackaging: true} : {}),
          },
          ...(sourceIncludesEnabled
            ? {
                maxSourceFiles: positiveInteger('--max-source-files'),
                maxTotalSourceBytes: maxTotalSourceBytes as number,
                maxIncludeDepth: positiveInteger('--max-include-depth'),
              }
            : {}),
        }
      : {}),
    historyNavigationAvailable: flags.has('--history-navigation-available'),
    replaceExisting: flags.has('--replace-existing'),
  };
}

export type Dsl4PreviewCliOptions = Omit<
  Dsl4CliOptions,
  'output' | 'historyNavigationAvailable'
> & {
  watch: true;
  port: number;
  maxProjectBytes: number;
  maxProjectJsonBytes: number;
  allowLargePreviewArtifacts: boolean;
};

function parsePreviewDsl4Arguments(rest: string[]): Dsl4PreviewCliOptions {
  const booleanOptions = new Set([
    '--watch',
    '--replace-existing',
    '--enable-source-includes',
    '--allow-large-preview-artifacts',
  ]);
  const requiredValueOptions = new Set([
    '--base',
    '--project-root',
    '--control-profile',
    '--channel',
  ]);
  const defaultedValueOptions = new Set([
    '--max-source-bytes',
    '--max-asset-file-bytes',
    '--max-asset-files',
    '--max-total-asset-bytes',
  ]);
  const graphValueOptions = new Set([
    '--max-source-files',
    '--max-total-source-bytes',
    '--max-include-depth',
  ]);
  const valueOptions = new Set([
    ...requiredValueOptions,
    ...defaultedValueOptions,
    ...graphValueOptions,
    '--source-manifest',
    '--source',
    '--source-id',
    '--max-project-bytes',
    '--max-project-json-bytes',
    '--port',
  ]);
  const {flags, values} = parseCliFlagAndValueOptions(rest, {
    flagOptions: booleanOptions,
    valueOptions,
  });
  if (!flags.has('--watch')) {
    throw new Sb3BuilderError('Missing required option: --watch', {stage: 'cli'});
  }
  requireCliValueOptions(values, requiredValueOptions);
  const sourceIncludesEnabled = flags.has('--enable-source-includes');
  if (sourceIncludesEnabled) {
    requireCliValueOptions(values, graphValueOptions);
  } else {
    for (const option of graphValueOptions) {
      if (values.has(option)) {
        throw new Sb3BuilderError(`${option} requires --enable-source-includes.`, {stage: 'cli'});
      }
    }
  }
  const positiveInteger = (option: string) => readCliInteger(values, option, 1);
  const port = values.has('--port') ? Number(values.get('--port')) : 0;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Sb3BuilderError('--port must be an integer between 0 and 65535.', {stage: 'cli'});
  }
  const channel = values.get('--channel');
  if (channel !== 'bundled' && channel !== 'unbundled') {
    throw new Sb3BuilderError('--channel must be either bundled or unbundled.', {stage: 'cli'});
  }
  const maxAssetFileBytes = resolveDsl4CliDefaultLimit(values, '--max-asset-file-bytes');
  const maxTotalAssetBytes = resolveDsl4CliDefaultLimit(values, '--max-total-asset-bytes');
  if (maxAssetFileBytes > maxTotalAssetBytes) {
    throw new Sb3BuilderError('--max-asset-file-bytes must be <= --max-total-asset-bytes.', {
      stage: 'cli',
    });
  }
  const maxSourceBytes = resolveDsl4CliDefaultLimit(values, '--max-source-bytes');
  const maxTotalSourceBytes = sourceIncludesEnabled
    ? positiveInteger('--max-total-source-bytes')
    : null;
  if (maxTotalSourceBytes !== null && maxTotalSourceBytes < maxSourceBytes) {
    throw new Sb3BuilderError(
      '--max-total-source-bytes must be greater than or equal to --max-source-bytes.',
      {stage: 'cli'},
    );
  }
  const maxAssetFiles = resolveDsl4CliDefaultLimit(values, '--max-asset-files');
  const maxProjectBytes = values.has('--max-project-bytes')
    ? positiveInteger('--max-project-bytes')
    : dsl4BrowserPreviewArtifactLimits.defaults.maxProjectBytes;
  const maxProjectJsonBytes = values.has('--max-project-json-bytes')
    ? positiveInteger('--max-project-json-bytes')
    : dsl4BrowserPreviewArtifactLimits.defaults.maxProjectJsonBytes;
  for (const [option, value, maximum] of [
    ['--max-source-bytes', maxSourceBytes, dsl4LocalPreviewBrowserBootstrapMaximums.maxSourceBytes],
    [
      '--max-asset-file-bytes',
      maxAssetFileBytes,
      dsl4BrowserPreviewArtifactLimits.absoluteMaximums.maxAssetBytes,
    ],
    ['--max-asset-files', maxAssetFiles, dsl4LocalPreviewBrowserBootstrapMaximums.maxAssetFiles],
    [
      '--max-total-asset-bytes',
      maxTotalAssetBytes,
      dsl4BrowserPreviewArtifactLimits.absoluteMaximums.maxAssetBytes,
    ],
    [
      '--max-project-bytes',
      maxProjectBytes,
      dsl4BrowserPreviewArtifactLimits.absoluteMaximums.maxProjectBytes,
    ],
    [
      '--max-project-json-bytes',
      maxProjectJsonBytes,
      dsl4BrowserPreviewArtifactLimits.absoluteMaximums.maxProjectJsonBytes,
    ],
  ]) {
    if (value > maximum) {
      throw new Sb3BuilderError(`${option} must be <= ${maximum}.`, {stage: 'cli'});
    }
  }
  const allowLargePreviewArtifacts = flags.has('--allow-large-preview-artifacts');
  for (const [option, value, recommendedMaximum] of [
    [
      '--max-asset-file-bytes',
      maxAssetFileBytes,
      dsl4BrowserPreviewArtifactLimits.recommendedMaximums.maxAssetBytes,
    ],
    [
      '--max-total-asset-bytes',
      maxTotalAssetBytes,
      dsl4BrowserPreviewArtifactLimits.recommendedMaximums.maxAssetBytes,
    ],
    [
      '--max-project-bytes',
      maxProjectBytes,
      dsl4BrowserPreviewArtifactLimits.recommendedMaximums.maxProjectBytes,
    ],
    [
      '--max-project-json-bytes',
      maxProjectJsonBytes,
      dsl4BrowserPreviewArtifactLimits.recommendedMaximums.maxProjectJsonBytes,
    ],
  ]) {
    if (value > recommendedMaximum && !allowLargePreviewArtifacts) {
      throw new Sb3BuilderError(
        `${option} above ${recommendedMaximum} requires --allow-large-preview-artifacts.`,
        {stage: 'cli'},
      );
    }
  }
  return {
    watch: true,
    baseSb3: path.resolve(values.get('--base') as string),
    projectRoot: path.resolve(values.get('--project-root') as string),
    ...(values.has('--source-manifest')
      ? {sourceManifest: path.resolve(values.get('--source-manifest') as string)}
      : {}),
    ...(values.has('--source') ? {source: values.get('--source')} : {}),
    ...(values.has('--source-id') ? {sourceId: values.get('--source-id')} : {}),
    controlProfile: values.get('--control-profile') as string,
    channel,
    maxSourceBytes,
    maxAssetFileBytes,
    maxAssetFiles,
    maxTotalAssetBytes,
    maxProjectBytes,
    maxProjectJsonBytes,
    allowLargePreviewArtifacts,
    ...(sourceIncludesEnabled
      ? {
          featureFlags: {dsl4Runtime: true, dsl4SourceIncludes: true},
          maxSourceFiles: positiveInteger('--max-source-files'),
          maxTotalSourceBytes: maxTotalSourceBytes as number,
          maxIncludeDepth: positiveInteger('--max-include-depth'),
        }
      : {}),
    replaceExisting: flags.has('--replace-existing'),
    port,
  };
}

export function parseCliArguments(
  arguments_: string[],
):
  | {action: 'help'}
  | {action: 'version'}
  | {action: 'build'; options: Parameters<typeof buildSb3Bundle>[0]}
  | {action: 'build-dsl4'; options: Dsl4CliOptions}
  | {action: 'preview-dsl4'; options: Dsl4PreviewCliOptions}
  | {action: 'convert'; options: Parameters<typeof convertDsl32File>[0]}
  | {action: 'convert-dsl4-assets'; options: ReturnType<typeof parseConvertDsl4AssetsArguments>}
  | {action: 'validate-dsl4'; options: ReturnType<typeof parseValidateDsl4Arguments>}
  | {action: 'audit-dsl4-assets'; options: ReturnType<typeof parseAuditDsl4AssetArguments>}
  | {action: 'lock-dsl4-assets'; options: ReturnType<typeof parseLockDsl4AssetArguments>}
  | {action: 'vendor-dsl4-assets'; options: ReturnType<typeof parseVendorDsl4AssetArguments>} {
  if (arguments_.includes('--help') || arguments_.includes('-h')) return {action: 'help'};
  if (arguments_.includes('--version') || arguments_.includes('-v')) return {action: 'version'};
  const [command, ...rest] = arguments_;
  if (command === 'build-sb3') {
    return {action: 'build', options: parseBuildSb3Arguments(rest)};
  }
  if (command === 'build-dsl4') {
    return {action: 'build-dsl4', options: parseBuildDsl4Arguments(rest)};
  }
  if (command === 'convert-dsl4') {
    return {action: 'convert', options: parseConvertDsl4Arguments(rest)};
  }
  if (command === 'convert-dsl4-assets') {
    return {action: 'convert-dsl4-assets', options: parseConvertDsl4AssetsArguments(rest)};
  }
  if (command === 'validate-dsl4') {
    return {action: 'validate-dsl4', options: parseValidateDsl4Arguments(rest)};
  }
  if (command === 'audit-dsl4-assets') {
    return {action: 'audit-dsl4-assets', options: parseAuditDsl4AssetArguments(rest)};
  }
  if (command === 'lock-dsl4-assets') {
    return {action: 'lock-dsl4-assets', options: parseLockDsl4AssetArguments(rest)};
  }
  if (command === 'vendor-dsl4-assets') {
    return {action: 'vendor-dsl4-assets', options: parseVendorDsl4AssetArguments(rest)};
  }
  if (command === 'preview-dsl4') {
    return {action: 'preview-dsl4', options: parsePreviewDsl4Arguments(rest)};
  }
  throw new Sb3BuilderError(
    `Expected the audit-dsl4-assets, build-sb3, build-dsl4, convert-dsl4, convert-dsl4-assets, lock-dsl4-assets, preview-dsl4, vendor-dsl4-assets, or validate-dsl4 command, received ${command ?? '(none)'}.`,
    {stage: 'cli'},
  );
}

export async function runCli(
  arguments_: string[],
  io: {stdout?: Pick<NodeJS.WriteStream, 'write'>; stderr?: Pick<NodeJS.WriteStream, 'write'>} = {},
  dependencies: {
    runPreview?: typeof runDsl4LocalPreviewCommand;
    runAssetAudit?: typeof auditDsl4AssetDistribution;
    runAssetConverter?: typeof convertDsl4ProjectAssets;
    runAssetLock?: typeof generateDsl4AssetDistributionLockFile;
    runAssetVendor?: typeof vendorDsl4AssetDistribution;
  } = {},
) {
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
      stderr.write(`${formatConversionDiagnostic(diagnostic)}\n`);
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
  if (parsed.action === 'build') {
    const result = await buildSb3Bundle(parsed.options);
    stdout.write(`Built ${result.outputPaths[`${parsed.options.outputName}.sb3`]}\n`);
    stdout.write(`Built ${result.outputPaths[`${parsed.options.outputName}.txt`]}\n`);
    stdout.write(`Built ${result.outputPaths[`${parsed.options.outputName}.manifest.json`]}\n`);
    return result;
  }
  const schema = JSON.parse(await readFile(dsl4SchemaUrl, 'utf8'));
  if (parsed.action === 'convert-dsl4-assets') {
    const runAssetConverter = dependencies.runAssetConverter ?? convertDsl4ProjectAssets;
    if (typeof runAssetConverter !== 'function') {
      throw new TypeError('runAssetConverter must be a function');
    }
    const result = await runAssetConverter({
      ...parsed.options,
      sourceFrontend: createDsl4ProductionSourceFrontend(schema, {
        limits: {maxCanonicalSourceBytes: parsed.options.maxSourceBytes},
      }),
    });
    stdout.write(`Converted ${Object.keys(result.converted).length} asset(s)\n`);
    stdout.write(`Saved ${path.basename(result.sourceManifestPath)}\n`);
    stdout.write(`Saved ${path.basename(result.sourcePath)}\n`);
    stdout.write(`Saved ${path.basename(result.sb3Path)}\n`);
    return result;
  }
  if (parsed.action === 'validate-dsl4') {
    const result = await validateDsl4SourceFile({
      ...parsed.options,
      sourceFrontend: createDsl4ProductionSourceFrontend(schema, {
        limits: {maxCanonicalSourceBytes: parsed.options.maxSourceBytes},
      }),
    });
    if (parsed.options.format === 'json') {
      stdout.write(serializeDsl4ValidationResult(result));
    } else if (result.ok) {
      stdout.write(`${path.basename(parsed.options.input)}: valid\n`);
    } else {
      for (const diagnostic of result.diagnostics) {
        stderr.write(`${formatDsl4Diagnostic(diagnostic, path.basename(parsed.options.input))}\n`);
      }
    }
    return {...result, exitCode: result.ok ? 0 : 1};
  }
  if (parsed.action === 'audit-dsl4-assets') {
    const runAssetAudit = dependencies.runAssetAudit ?? auditDsl4AssetDistribution;
    if (typeof runAssetAudit !== 'function') {
      throw new TypeError('runAssetAudit must be a function');
    }
    const result = await runAssetAudit({
      ...parsed.options,
      sourceFrontend: createDsl4ProductionSourceFrontend(schema, {
        limits: {
          maxCanonicalSourceBytes:
            parsed.options.maxTotalSourceBytes ?? parsed.options.maxSourceBytes,
        },
      }),
    });
    stdout.write(
      parsed.options.format === 'json'
        ? serializeDsl4AssetDistributionAudit(result)
        : formatDsl4AssetDistributionAudit(result),
    );
    return {...result, exitCode: 0};
  }
  if (parsed.action === 'lock-dsl4-assets') {
    const runAssetLock = dependencies.runAssetLock ?? generateDsl4AssetDistributionLockFile;
    if (typeof runAssetLock !== 'function') throw new TypeError('runAssetLock must be a function');
    const result = await runAssetLock({
      ...parsed.options,
      sourceFrontend: createDsl4ProductionSourceFrontend(schema, {
        limits: {
          maxCanonicalSourceBytes:
            parsed.options.maxTotalSourceBytes ?? parsed.options.maxSourceBytes,
        },
      }),
    });
    stdout.write(`Locked ${path.basename(result.outputPath)}\n`);
    return result;
  }
  if (parsed.action === 'vendor-dsl4-assets') {
    const runAssetVendor = dependencies.runAssetVendor ?? vendorDsl4AssetDistribution;
    if (typeof runAssetVendor !== 'function')
      throw new TypeError('runAssetVendor must be a function');
    const result = await runAssetVendor(parsed.options);
    stdout.write(`Vendored ${result.vendoredAssets.length} asset(s)\n`);
    return result;
  }
  if (parsed.action === 'preview-dsl4') {
    const runPreview = dependencies.runPreview ?? runDsl4LocalPreviewCommand;
    if (typeof runPreview !== 'function') throw new TypeError('runPreview must be a function');
    return runPreview(
      {
        ...parsed.options,
        sourceFrontend: createDsl4ProductionSourceFrontend(schema, {
          limits: {
            maxCanonicalSourceBytes:
              parsed.options.maxTotalSourceBytes ?? parsed.options.maxSourceBytes,
          },
        }),
      },
      {stdout, stderr},
    );
  }
  const result = await buildDsl4RuntimeComponentFile({
    ...parsed.options,
    sourceFrontend: createDsl4ProductionSourceFrontend(schema, {
      limits: {
        maxCanonicalSourceBytes:
          parsed.options.maxTotalSourceBytes ?? parsed.options.maxSourceBytes,
      },
    }),
  });
  stdout.write(`Built ${path.basename(result.outputPath)}\n`);
  return result;
}
