import {readFile} from 'node:fs/promises';
import path from 'node:path';

import {installBundleTransactionally} from './atomic-output.js';
import {resolveAssets} from './assets.js';
import {
  builderProfiles,
  bundleManifestFormatVersion,
  defaultMaxEmbeddedScriptBytes,
  embeddedScriptVariableId,
  packageName,
  packageVersion,
} from './constants.js';
import {Sb3BuilderError} from './errors.js';
import {sha256} from './hash.js';
import {loadAssetManifest, validateOutputName} from './manifest.js';
import {transformScript} from './script.js';
import {buildSb3Archive} from './sb3.js';
import {validateBundle} from './validate.js';

export {Sb3BuilderError} from './errors.js';
export {buildDsl4RuntimeComponent, Dsl4BuildError} from './dsl4-build.js';
export {buildDsl4RuntimeComponentFile} from './dsl4-build-output.js';
export {resolveDsl4BuildSourceLimits} from './dsl4-source-limits.js';
export {createDsl4ProductionSourceFrontend} from './dsl4-source-frontend.js';
export {
  classifyDsl4PreviewChange,
  createDsl4ArtifactFingerprint,
} from './dsl4-artifact-fingerprint.js';
export {
  createDsl4BinaryEntryProviderFromSb3,
  embedDsl4BinaryEntryRuntimeComponentInSb3,
} from './dsl4-binary-entry-sb3.js';
export {
  ensureDsl4ExternalSourceCacheIdentity,
  loadDsl4ExternalSource,
  validateDsl4ExternalSourceManifest,
} from './dsl4-external-source.js';
export {loadDsl4LocalAssetSnapshot} from './dsl4-local-assets.js';
export {
  createDsl4LocalPreviewHost,
  dsl4LocalPreviewHostDefaults,
} from './dsl4-local-preview-host.js';
export {
  dsl4LocalPreviewCommandDefaults,
  openDsl4LocalPreviewBrowser,
  runDsl4LocalPreviewCommand,
} from './dsl4-local-preview-command.js';
export {
  dsl4BrowserRuntimeComponentDefaults,
  dsl4BrowserRuntimeComponentMaximums,
  Dsl4BrowserRuntimeComponentError,
  loadDsl4BrowserRuntimeComponent,
} from './dsl4-browser-runtime-component.js';
export {
  createDsl4LocalPreviewBrowserRuntime,
  Dsl4LocalPreviewBrowserRuntimeError,
} from './dsl4-local-preview-browser-runtime.js';
export {
  createDsl4LocalPreviewBrowserClient,
  dsl4LocalPreviewBrowserClientDefaults,
} from './dsl4-local-preview-browser-client.js';
export {
  createDsl4LocalPreviewBrowserBootstrap,
  dsl4LocalPreviewBrowserBootstrapDefaults,
} from './dsl4-local-preview-browser-bootstrap.js';
export {
  buildDsl4TurboWarpBrowserBundle,
  dsl4TurboWarpBrowserBundleDefaults,
  dsl4TurboWarpBrowserBundleMaximumBytes,
} from './dsl4-turbowarp-browser-bundle.js';
export {createDsl4PreviewSourceWatcher, dsl4PreviewWatchDefaults} from './dsl4-preview-watch.js';
export {
  createDsl4CliPreviewShell,
  createDsl4DevelopmentPreviewShell,
  dsl4DevelopmentPreviewShellManifest,
  inspectDsl4ProductionPreviewExclusion,
  validateDsl4PreviewShellView,
} from './dsl4-preview-shell.js';
export {
  createDsl4PreviewReloadOverlay,
  dsl4PreviewReloadOverlayManifest,
} from './dsl4-preview-reload-overlay.js';
export {
  createDsl4PreviewReloadSurface,
  dsl4PreviewReloadSurfaceManifest,
} from './dsl4-preview-reload-surface.js';
export {createDsl4WebPreviewShell, dsl4WebPreviewShellManifest} from './dsl4-web-preview-shell.js';
export {
  createDsl4PreviewTransportPolicy,
  dsl4PreviewTransportLimits,
  dsl4PreviewTransportTokenBytes,
} from './dsl4-preview-transport-policy.js';
export {
  Dsl4ValidationInternalError,
  formatDsl4Diagnostic,
  serializeDsl4ValidationResult,
  validateDsl4SourceFile,
} from './dsl4-validate.js';
export {
  embedDsl4PackagedRuntimeComponentInSb3,
  embedDsl4RuntimeComponentInSb3,
  embedDsl4SourceInSb3,
  installDsl4BinaryEntryRuntimeComponent,
  installDsl4EmbeddedSource,
  installDsl4PackagedRuntimeComponent,
  installDsl4RuntimeComponent,
} from './dsl4-source.js';
export {validateAssetManifest} from './manifest.js';
export {validateBundle} from './validate.js';

/** @param {string | URL} input @param {string} description */
async function readInput(input, description) {
  if (!(typeof input === 'string' || input instanceof URL)) {
    throw new Sb3BuilderError(`${description} must be a filesystem path or file URL.`, {
      stage: 'read-input',
    });
  }
  try {
    return Buffer.from(await readFile(input));
  } catch (error) {
    throw new Sb3BuilderError(`Cannot read ${description}: ${String(input)}`, {
      stage: 'read-input',
      cause: error,
    });
  }
}

/** @param {string | URL} input */
function inputName(input) {
  return input instanceof URL ? path.basename(input.pathname) : path.basename(input);
}

/**
 * Build a deterministic SB3, transformed DSL script, and provenance manifest as one transaction.
 *
 * @param {{baseSb3: string | URL, sourceScript: string | URL, assetManifest: string | URL | Record<string, unknown>, outputDirectory: string, outputName: string, profile: 'editor' | 'player', manifestBaseDirectory?: string, allowedFileRoots?: string[], allowHttp?: boolean, fetchImplementation?: typeof fetch, maxAssetBytes?: number, maxEmbeddedScriptBytes?: number, maxRedirects?: number, requestTimeoutMs?: number}} options
 */
export async function buildSb3Bundle(options) {
  if (!options || typeof options !== 'object') {
    throw new Sb3BuilderError('buildSb3Bundle options are required.', {stage: 'options'});
  }
  if (typeof options.outputDirectory !== 'string' || options.outputDirectory.length === 0) {
    throw new Sb3BuilderError('outputDirectory must be a non-empty string.', {stage: 'options'});
  }
  if (!builderProfiles.includes(options.profile)) {
    throw new Sb3BuilderError('profile must be either editor or player.', {stage: 'options'});
  }
  const maxEmbeddedScriptBytes = options.maxEmbeddedScriptBytes ?? defaultMaxEmbeddedScriptBytes;
  if (!Number.isInteger(maxEmbeddedScriptBytes) || maxEmbeddedScriptBytes < 1) {
    throw new Sb3BuilderError('maxEmbeddedScriptBytes must be an integer >= 1.', {
      stage: 'options',
    });
  }
  const outputName = validateOutputName(options.outputName);
  const outputDirectory = path.resolve(options.outputDirectory);
  const [baseSb3Bytes, sourceScriptBytes, loadedManifest] = await Promise.all([
    readInput(options.baseSb3, 'baseSb3'),
    readInput(options.sourceScript, 'sourceScript'),
    loadAssetManifest(options.assetManifest, options.manifestBaseDirectory),
  ]);
  const resolvedAssets = await resolveAssets(
    loadedManifest.manifest,
    loadedManifest.baseDirectory,
    {
      allowedFileRoots: options.allowedFileRoots,
      allowHttp: options.allowHttp,
      fetchImplementation: options.fetchImplementation,
      maxAssetBytes: options.maxAssetBytes,
      maxRedirects: options.maxRedirects,
      requestTimeoutMs: options.requestTimeoutMs,
    },
  );
  const transformedScript = transformScript(sourceScriptBytes, loadedManifest.manifest);
  const builtSb3 = buildSb3Archive(baseSb3Bytes, resolvedAssets, {
    profile: options.profile,
    scriptBytes: transformedScript.bytes,
    maxEmbeddedScriptBytes,
  });
  const sb3Filename = `${outputName}.sb3`;
  const scriptFilename = `${outputName}.txt`;
  const manifestFilename = `${outputName}.manifest.json`;
  const sb3Mappings = new Map(builtSb3.mappings.map((mapping) => [mapping.name, mapping]));
  const scriptMappings = new Map(
    transformedScript.mappings.map((mapping) => [mapping.name, mapping]),
  );
  const manifest = {
    formatVersion: bundleManifestFormatVersion,
    builder: {package: packageName, version: packageVersion},
    profile: options.profile,
    inputs: {
      assetManifest: {filename: loadedManifest.sourceName, sha256: sha256(loadedManifest.bytes)},
      baseSb3: {filename: inputName(options.baseSb3), sha256: sha256(baseSb3Bytes)},
      sourceScript: {filename: inputName(options.sourceScript), sha256: sha256(sourceScriptBytes)},
    },
    outputName,
    script: {
      mode: options.profile === 'player' ? 'embedded' : 'external',
      embeddedVariableId: options.profile === 'player' ? embeddedScriptVariableId : null,
      size: transformedScript.bytes.length,
      sha256: sha256(transformedScript.bytes),
    },
    assets: loadedManifest.manifest.assets.map((entry) => {
      const sb3Mapping = sb3Mappings.get(entry.name);
      const scriptMapping = scriptMappings.get(entry.name);
      if (!sb3Mapping || !scriptMapping) {
        throw new Sb3BuilderError(`Internal mapping is missing for ${entry.name}.`, {
          stage: 'manifest-output',
        });
      }
      return {
        name: entry.name,
        inputUri: entry.uri,
        resolvedUri: resolvedAssets.find((asset) => asset.entry.name === entry.name)?.resolvedUri,
        kind: entry.kind,
        target: entry.target,
        sb3Name: entry.sb3Name,
        contentType: entry.contentType,
        dataFormat: entry.dataFormat,
        size: entry.size,
        sha256: entry.sha256,
        license: entry.license,
        output: {
          assetId: sb3Mapping.assetId,
          filename: sb3Mapping.filename,
          reference: scriptMapping.reference,
        },
      };
    }),
    outputs: {
      sb3: {filename: sb3Filename, sha256: sha256(builtSb3.bytes), size: builtSb3.bytes.length},
      script: {
        filename: scriptFilename,
        sha256: sha256(transformedScript.bytes),
        size: transformedScript.bytes.length,
      },
      manifest: {filename: manifestFilename},
    },
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  validateBundle({sb3Bytes: builtSb3.bytes, scriptBytes: transformedScript.bytes, manifest});
  const files = new Map([
    [sb3Filename, builtSb3.bytes],
    [scriptFilename, transformedScript.bytes],
    [manifestFilename, manifestBytes],
  ]);
  const outputPaths = await installBundleTransactionally({
    outputDirectory,
    outputName,
    files,
    validateCandidate: async (candidateDirectory) => {
      const [candidateSb3, candidateScript, candidateManifest] = await Promise.all([
        readFile(path.join(candidateDirectory, sb3Filename)),
        readFile(path.join(candidateDirectory, scriptFilename)),
        readFile(path.join(candidateDirectory, manifestFilename), 'utf8'),
      ]);
      validateBundle({
        sb3Bytes: candidateSb3,
        scriptBytes: candidateScript,
        manifest: JSON.parse(candidateManifest),
      });
    },
  });
  return {manifest, outputPaths};
}
