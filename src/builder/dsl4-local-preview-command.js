import {spawn} from 'node:child_process';
import {open} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

import {resolveDsl4FeatureFlags} from '../dsl4/feature-flags.js';
import {dsl4BrowserPreviewArtifactLimits} from '../dsl4/browser-preview-artifact-limits.js';
import {buildDsl4RuntimeComponent} from './dsl4-build.js';
import {validateDsl4ExternalSourceManifest} from './dsl4-external-source.js';
import {
  dsl4LocalPreviewBrowserBootstrapDefaults,
  dsl4LocalPreviewBrowserBootstrapMaximums,
} from './dsl4-local-preview-browser-bootstrap.js';
import {
  createDsl4LocalPreviewHost,
  dsl4LocalPreviewHostDefaults,
} from './dsl4-local-preview-host.js';
import {resolveDsl4BuildSourceLimits} from './dsl4-source-limits.js';
import {buildDsl4TurboWarpBrowserBundle} from './dsl4-turbowarp-browser-bundle.js';
import {Sb3BuilderError} from './errors.js';

const browserEntryPoint = fileURLToPath(
  new URL('./dsl4-local-preview-browser-entry.js', import.meta.url),
);
const maximumManifestBytes = 64 * 1024;

/**
 * @typedef {{start: Function, getLaunchUrl: Function, getSnapshot: Function, dispose: Function}} PreviewHost
 */

export const dsl4LocalPreviewCommandDefaults = Object.freeze({
  readyTimeoutMs: 20_000,
});

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {string} message @param {string} code @param {unknown} [cause] */
function commandError(message, code, cause) {
  return new Sb3BuilderError(message, {stage: 'dsl4-local-preview-command', code, cause});
}

/** @param {unknown} value @param {string} name @param {number} minimum @param {number} maximum */
function boundedInteger(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new TypeError(`${name} must be a safe integer between ${minimum} and ${maximum}`);
  }
  return Number(value);
}

/** @param {string} filePath @param {number} maximumBytes @param {string} description */
async function readBoundedFile(filePath, maximumBytes, description) {
  let handle;
  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  try {
    handle = await open(filePath, 'r');
    const state = await handle.stat();
    if (!state.isFile()) {
      throw commandError(`${description} must be a regular file`, 'K4-PREVIEW-CLI-INPUT');
    }
    if (state.size < 1 || state.size > maximumBytes) {
      throw commandError(
        `${description} must contain 1-${maximumBytes} bytes`,
        'K4-PREVIEW-CLI-INPUT-LIMIT',
      );
    }
    while (size <= maximumBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maximumBytes - size + 1));
      const result = await handle.read(chunk, 0, chunk.length, null);
      if (result.bytesRead === 0) break;
      chunks.push(chunk.subarray(0, result.bytesRead));
      size += result.bytesRead;
    }
  } catch (error) {
    if (error instanceof Sb3BuilderError) throw error;
    throw commandError(`Cannot read ${description}`, 'K4-PREVIEW-CLI-INPUT', error);
  } finally {
    try {
      await handle?.close();
    } catch (error) {
      for (const chunk of chunks) chunk.fill(0);
      throw commandError(`Cannot close ${description}`, 'K4-PREVIEW-CLI-INPUT', error);
    }
  }
  if (size < 1 || size > maximumBytes) {
    for (const chunk of chunks) chunk.fill(0);
    throw commandError(
      `${description} must contain 1-${maximumBytes} bytes`,
      'K4-PREVIEW-CLI-INPUT-LIMIT',
    );
  }
  const bytes = Buffer.concat(chunks, size);
  for (const chunk of chunks) chunk.fill(0);
  return bytes;
}

/** @param {Buffer} bytes */
function parseSourceManifest(bytes) {
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
  } catch (error) {
    throw commandError(
      'Source manifest must be valid UTF-8 JSON',
      'K4-PREVIEW-CLI-MANIFEST',
      error,
    );
  }
  if (!isRecord(parsed)) {
    throw commandError('Source manifest JSON must contain one object', 'K4-PREVIEW-CLI-MANIFEST');
  }
  return validateDsl4ExternalSourceManifest(parsed);
}

/**
 * Open one validated loopback launch URL with the platform browser launcher.
 *
 * @param {string} launchUrl
 * @param {{platform?: NodeJS.Platform, spawnProcess?: typeof spawn}} [dependencies]
 */
export async function openDsl4LocalPreviewBrowser(launchUrl, dependencies = {}) {
  let parsed;
  try {
    parsed = new URL(launchUrl);
  } catch (error) {
    throw commandError('Preview launch URL is invalid', 'K4-PREVIEW-CLI-BROWSER', error);
  }
  if (
    parsed.protocol !== 'http:' ||
    (parsed.hostname !== '127.0.0.1' && parsed.hostname !== '[::1]' && parsed.hostname !== '::1') ||
    parsed.port.length === 0 ||
    parsed.pathname !== '/' ||
    parsed.search.length > 0 ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    !/^#[A-Za-z0-9_-]{43}$/u.test(parsed.hash)
  ) {
    throw commandError(
      'Preview browser launcher accepts only an authenticated loopback URL',
      'K4-PREVIEW-CLI-BROWSER',
    );
  }
  const platform = dependencies.platform ?? process.platform;
  const spawnProcess = dependencies.spawnProcess ?? spawn;
  if (typeof spawnProcess !== 'function') {
    throw new TypeError('spawnProcess must be a function');
  }
  let command;
  let arguments_;
  if (platform === 'darwin') {
    command = 'open';
    arguments_ = [launchUrl];
  } else if (platform === 'win32') {
    command = 'rundll32.exe';
    arguments_ = ['url.dll,FileProtocolHandler', launchUrl];
  } else {
    command = 'xdg-open';
    arguments_ = [launchUrl];
  }
  await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess(command, arguments_, {detached: true, stdio: 'ignore'});
    } catch (error) {
      reject(commandError('Cannot start the system browser', 'K4-PREVIEW-CLI-BROWSER', error));
      return;
    }
    child.once('error', (error) => {
      reject(commandError('Cannot start the system browser', 'K4-PREVIEW-CLI-BROWSER', error));
    });
    child.once('spawn', () => {
      try {
        child.unref();
        resolve(undefined);
      } catch (error) {
        reject(commandError('Cannot detach the system browser', 'K4-PREVIEW-CLI-BROWSER', error));
      }
    });
  });
}

/**
 * Build and own one browser-backed DSL 4.0 local preview until signal or browser close.
 *
 * @param {object} optionsInput
 * @param {Record<string, unknown>} [dependenciesInput]
 */
export async function runDsl4LocalPreviewCommand(optionsInput, dependenciesInput = {}) {
  if (!isRecord(optionsInput)) throw new TypeError('local preview command options are required');
  if (!isRecord(dependenciesInput))
    throw new TypeError('local preview dependencies must be an object');
  const options = /** @type {Record<string, any>} */ (optionsInput);
  const dependencies = /** @type {Record<string, any>} */ (dependenciesInput);
  if (options.watch !== true) {
    throw commandError('watch must be explicitly enabled', 'K4-PREVIEW-CLI-WATCH');
  }
  const maxSourceBytes = boundedInteger(
    options.maxSourceBytes,
    'maxSourceBytes',
    1,
    dsl4LocalPreviewBrowserBootstrapDefaults.maxSourceBytes,
  );
  const featureFlags = resolveDsl4FeatureFlags(options.featureFlags ?? {});
  const sourceLimits = resolveDsl4BuildSourceLimits({
    sourceIncludesEnabled: featureFlags.dsl4SourceIncludes,
    maxSourceBytes,
    maxTotalSourceBytes: options.maxTotalSourceBytes,
  });
  const graphOptions = featureFlags.dsl4SourceIncludes
    ? {
        maxSourceFiles: boundedInteger(
          options.maxSourceFiles,
          'maxSourceFiles',
          1,
          Number.MAX_SAFE_INTEGER,
        ),
        maxTotalSourceBytes: sourceLimits.maxSourceGraphBytes,
        maxIncludeDepth: boundedInteger(
          options.maxIncludeDepth,
          'maxIncludeDepth',
          1,
          Number.MAX_SAFE_INTEGER,
        ),
      }
    : {};
  const maxAssetFileBytes = boundedInteger(
    options.maxAssetFileBytes,
    'maxAssetFileBytes',
    1,
    dsl4LocalPreviewBrowserBootstrapMaximums.maxAssetBytes,
  );
  const maxAssetFiles = boundedInteger(
    options.maxAssetFiles,
    'maxAssetFiles',
    1,
    dsl4LocalPreviewBrowserBootstrapMaximums.maxAssetFiles,
  );
  const maxTotalAssetBytes = boundedInteger(
    options.maxTotalAssetBytes,
    'maxTotalAssetBytes',
    1,
    dsl4LocalPreviewBrowserBootstrapMaximums.maxAssetBytes,
  );
  if (maxAssetFileBytes > maxTotalAssetBytes) {
    throw commandError(
      'maxAssetFileBytes must not exceed maxTotalAssetBytes',
      'K4-PREVIEW-CLI-LIMIT',
    );
  }
  const port = boundedInteger(options.port ?? 0, 'port', 0, 65_535);
  const projectRoot = path.resolve(options.projectRoot);
  const sourceManifestPath = path.resolve(options.sourceManifest);
  if (sourceManifestPath !== path.join(projectRoot, 'project.source.json')) {
    throw commandError(
      'sourceManifest must be projectRoot/project.source.json',
      'K4-PREVIEW-CLI-MANIFEST',
    );
  }
  const maxProjectBytes = boundedInteger(
    options.maxProjectBytes ?? dsl4LocalPreviewHostDefaults.maxProjectBytes,
    'maxProjectBytes',
    1,
    dsl4BrowserPreviewArtifactLimits.absoluteMaximums.maxProjectBytes,
  );
  const maxProjectJsonBytes = boundedInteger(
    options.maxProjectJsonBytes ?? dsl4BrowserPreviewArtifactLimits.defaults.maxProjectJsonBytes,
    'maxProjectJsonBytes',
    1,
    dsl4BrowserPreviewArtifactLimits.absoluteMaximums.maxProjectJsonBytes,
  );
  const exceedsRecommendedArtifactLimit =
    maxAssetFileBytes > dsl4BrowserPreviewArtifactLimits.recommendedMaximums.maxAssetBytes ||
    maxTotalAssetBytes > dsl4BrowserPreviewArtifactLimits.recommendedMaximums.maxAssetBytes ||
    maxProjectBytes > dsl4BrowserPreviewArtifactLimits.recommendedMaximums.maxProjectBytes ||
    maxProjectJsonBytes > dsl4BrowserPreviewArtifactLimits.recommendedMaximums.maxProjectJsonBytes;
  if (exceedsRecommendedArtifactLimit && options.allowLargePreviewArtifacts !== true) {
    throw commandError(
      'Artifact limits above the recommended maximum require allowLargePreviewArtifacts',
      'K4-PREVIEW-CLI-LIMIT-ACK',
    );
  }
  const readyTimeoutMs = boundedInteger(
    dependencies.readyTimeoutMs ?? dsl4LocalPreviewCommandDefaults.readyTimeoutMs,
    'readyTimeoutMs',
    1,
    60_000,
  );
  const readInput = dependencies.readFile ?? readBoundedFile;
  const buildRuntime = dependencies.buildRuntime ?? buildDsl4RuntimeComponent;
  const buildBrowserBundle = dependencies.buildBrowserBundle ?? buildDsl4TurboWarpBrowserBundle;
  const createHost = dependencies.createHost ?? createDsl4LocalPreviewHost;
  const openBrowser = dependencies.openBrowser ?? openDsl4LocalPreviewBrowser;
  const signalTarget = dependencies.signalTarget ?? process;
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  for (const [name, value] of [
    ['readFile', readInput],
    ['buildRuntime', buildRuntime],
    ['buildBrowserBundle', buildBrowserBundle],
    ['createHost', createHost],
    ['openBrowser', openBrowser],
  ]) {
    if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
  }
  if (
    !isRecord(signalTarget) ||
    typeof signalTarget.once !== 'function' ||
    typeof signalTarget.off !== 'function'
  ) {
    throw new TypeError('signalTarget must provide once and off');
  }
  if (typeof stdout?.write !== 'function' || typeof stderr?.write !== 'function') {
    throw new TypeError('stdout and stderr must provide write');
  }
  if (exceedsRecommendedArtifactLimit) {
    stderr.write(
      'Warning: large preview artifact limits were explicitly enabled; browser memory use may be substantial.\n',
    );
  }

  /** @type {PreviewHost | null} */
  let host = null;
  let stopping = false;
  /** @type {string | null} */
  let receivedSignal = null;
  let readyObserved = false;
  /** @type {(value?: unknown) => void} */
  let settleReadyResolve = () => {};
  /** @type {(reason?: unknown) => void} */
  let settleReadyReject = () => {};
  const ready = new Promise((resolve, reject) => {
    settleReadyResolve = resolve;
    settleReadyReject = reject;
  });
  /** @type {(value?: unknown) => void} */
  let settleCompletionResolve = () => {};
  /** @type {(reason?: unknown) => void} */
  let settleCompletionReject = () => {};
  const completion = new Promise((resolve, reject) => {
    settleCompletionResolve = resolve;
    settleCompletionReject = reject;
  });
  /** @type {(value?: unknown) => void} */
  let settleSignal = () => {};
  const signalled = new Promise((resolve) => {
    settleSignal = resolve;
  });
  void ready.catch(() => {});
  void completion.catch(() => {});
  /** @param {string} signal */
  const onSignal = (signal) => {
    if (receivedSignal) return;
    receivedSignal = signal;
    stopping = true;
    settleSignal(signal);
  };
  const handleSigint = () => onSignal('SIGINT');
  const handleSigterm = () => onSignal('SIGTERM');
  signalTarget.once('SIGINT', handleSigint);
  signalTarget.once('SIGTERM', handleSigterm);

  let readyTimer = null;
  let result = null;
  let primaryError = null;
  try {
    const [baseSb3Bytes, manifestBytes] = await Promise.all([
      readInput(path.resolve(options.baseSb3), maxProjectBytes, 'base SB3'),
      readInput(sourceManifestPath, maximumManifestBytes, 'source manifest'),
    ]);
    let sourceManifest;
    try {
      sourceManifest = parseSourceManifest(manifestBytes);
    } finally {
      manifestBytes.fill(0);
    }
    let built;
    let browserBundleBytes;
    try {
      [built, browserBundleBytes] = await Promise.all([
        buildRuntime({
          baseSb3Bytes,
          projectRoot,
          sourceManifest,
          sourceFrontend: options.sourceFrontend,
          controlProfile: options.controlProfile,
          channel: options.channel,
          maxSourceBytes,
          maxAssetFileBytes,
          maxAssetFiles,
          maxTotalAssetBytes,
          featureFlags,
          ...graphOptions,
          replaceExisting: options.replaceExisting,
        }),
        buildBrowserBundle({entryPoint: browserEntryPoint}),
      ]);
    } finally {
      baseSb3Bytes.fill(0);
    }
    if (!isRecord(built) || !(built.bytes instanceof Uint8Array)) {
      throw commandError('Preview runtime build returned invalid bytes', 'K4-PREVIEW-CLI-BUILD');
    }
    if (!(browserBundleBytes instanceof Uint8Array)) {
      built.bytes.fill(0);
      throw commandError('Preview browser build returned invalid bytes', 'K4-PREVIEW-CLI-BUILD');
    }
    const projectBytes = Uint8Array.from(built.bytes);
    built.bytes.fill(0);
    const bundleBytes = Uint8Array.from(browserBundleBytes);
    browserBundleBytes.fill(0);
    try {
      const createdHost = createHost({
        projectRoot,
        sourceManifestPath,
        sourceManifest,
        sourceFrontend: options.sourceFrontend,
        maxSourceBytes,
        featureFlags,
        ...graphOptions,
        maxAssetFileBytes,
        maxAssetFiles,
        maxTotalAssetBytes,
        maxProjectBytes,
        maxProjectJsonBytes,
        runtimeOwner: 'browser',
        port,
        projectBytes,
        browserBundleBytes: bundleBytes,
        /** @param {unknown} event */
        onEvent(event) {
          if (!isRecord(event) || typeof event.type !== 'string') return;
          if (event.type === 'local-preview.runtime-ready') {
            readyObserved = true;
            settleReadyResolve(event);
            return;
          }
          if (event.type === 'local-preview.full-rebuild-required') {
            const outcome = {reason: 'full-rebuild', event};
            if (readyObserved) settleCompletionResolve(outcome);
            else {
              settleReadyReject(
                commandError(
                  'Preview requires a full rebuild before runtime startup',
                  'K4-PREVIEW-CLI-FULL-REBUILD',
                ),
              );
            }
            return;
          }
          if (event.type === 'local-preview.transport-disconnected' && !stopping) {
            const outcome = {reason: 'browser-disconnected', event};
            if (readyObserved) settleCompletionResolve(outcome);
            else {
              settleReadyReject(
                commandError(
                  'Browser disconnected before the preview runtime became ready',
                  'K4-PREVIEW-CLI-RUNTIME-DISCONNECTED',
                ),
              );
            }
          }
        },
        /** @param {unknown} error */
        onError(error) {
          if (stopping) return;
          const wrapped = commandError('Local preview host failed', 'K4-PREVIEW-CLI-HOST', error);
          if (readyObserved) settleCompletionReject(wrapped);
          else settleReadyReject(wrapped);
        },
      });
      if (
        !isRecord(createdHost) ||
        typeof createdHost.start !== 'function' ||
        typeof createdHost.getLaunchUrl !== 'function' ||
        typeof createdHost.getSnapshot !== 'function' ||
        typeof createdHost.dispose !== 'function'
      ) {
        throw commandError('Preview host factory returned an invalid owner', 'K4-PREVIEW-CLI-HOST');
      }
      host = /** @type {PreviewHost} */ (createdHost);
    } finally {
      projectBytes.fill(0);
      bundleBytes.fill(0);
    }
    if (!host) throw commandError('Preview host is unavailable', 'K4-PREVIEW-CLI-HOST');
    if (receivedSignal) {
      result = {exitCode: 0, reason: 'signal', signal: receivedSignal};
    } else {
      const hostStartup = await Promise.race([
        host.start().then(
          /** @param {{origin: string}} listening */ (listening) => ({
            kind: 'listening',
            listening,
          }),
        ),
        signalled.then((signal) => ({kind: 'signal', signal})),
      ]);
      if (hostStartup.kind === 'signal' && 'signal' in hostStartup) {
        result = {exitCode: 0, reason: 'signal', signal: hostStartup.signal};
      } else {
        const launchUrl = host.getLaunchUrl();
        stdout.write(`Opening DSL 4.0 preview at ${hostStartup.listening.origin}\n`);
        await openBrowser(launchUrl);
      }
      if (!result) {
        readyTimer = setTimeout(() => {
          settleReadyReject(
            commandError(
              `Browser runtime did not acknowledge readiness within ${readyTimeoutMs}ms`,
              'K4-PREVIEW-CLI-RUNTIME-TIMEOUT',
            ),
          );
        }, readyTimeoutMs);
        const startup = await Promise.race([
          ready.then(() => ({kind: 'ready'})),
          signalled.then((signal) => ({kind: 'signal', signal})),
        ]);
        clearTimeout(readyTimer);
        readyTimer = null;
        if (startup.kind === 'signal' && 'signal' in startup) {
          result = {exitCode: 0, reason: 'signal', signal: startup.signal};
        } else {
          const snapshot = host.getSnapshot();
          if (snapshot.browserRuntimeReady !== true) {
            throw commandError(
              'Browser runtime readiness acknowledgement was not retained',
              'K4-PREVIEW-CLI-RUNTIME-DISCONNECTED',
            );
          }
          stdout.write(`Preview ready at ${snapshot.origin}; watching ${sourceManifest.path}\n`);
          const outcome = await Promise.race([
            completion,
            signalled.then((signal) => ({reason: 'signal', signal})),
          ]);
          if (outcome.reason === 'full-rebuild') {
            stderr.write(
              'Preview stopped because a full rebuild is required. Restart the command.\n',
            );
            result = {exitCode: 1, reason: outcome.reason};
          } else if (outcome.reason === 'browser-disconnected') {
            stdout.write('Preview stopped because the browser disconnected.\n');
            result = {exitCode: 0, reason: outcome.reason};
          } else {
            stdout.write(`Preview stopped by ${outcome.signal}.\n`);
            result = {exitCode: 0, reason: 'signal', signal: outcome.signal};
          }
        }
      }
    }
  } catch (error) {
    primaryError = error;
  } finally {
    if (readyTimer) clearTimeout(readyTimer);
    stopping = true;
    signalTarget.off('SIGINT', handleSigint);
    signalTarget.off('SIGTERM', handleSigterm);
    try {
      await host?.dispose();
    } catch (cleanupError) {
      primaryError = primaryError
        ? new AggregateError(
            [primaryError, cleanupError],
            'Local preview command and cleanup failed',
          )
        : cleanupError;
    }
  }
  if (primaryError) throw primaryError;
  if (!result) {
    throw commandError('Local preview command did not settle', 'K4-PREVIEW-CLI-INTERNAL');
  }
  return Object.freeze(result);
}
