import {computeDsl4Sha256Integrity} from '../dsl4/source-descriptor.js';
import {deepFreeze} from '../dsl4/story-document.js';
import {packageName, packageVersion} from './constants.js';
import {validateDsl4ExternalSourceManifest} from './dsl4-external-source.js';

const inputKeys = new Set([
  'appShell',
  'assetBundleIntegrity',
  'baseSb3Integrity',
  'builder',
  'extensionBundle',
  'formatVersion',
  'project',
]);
const appShellKeys = new Set(['id', 'integrity', 'templateVersion']);
const extensionBundleKeys = new Set(['formatVersion', 'id', 'integrity']);
const builderKeys = new Set(['package', 'settings', 'version']);
const builderSettingKeys = new Set([
  'channel',
  'historyNavigationAvailable',
  'maxAssetFileBytes',
  'maxAssetFiles',
  'maxSourceBytes',
  'maxTotalAssetBytes',
  'replaceExisting',
]);
const projectKeys = new Set(['controlProfile', 'sourceManifest']);
const classificationKeys = new Set([
  'activeArtifactFingerprint',
  'activeSourceIntegrity',
  'candidateArtifactFingerprint',
  'candidateSourceIntegrity',
]);
const sha256SRI = /^sha256-[A-Za-z0-9+/]{43}=$/u;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @param {Set<string>} keys @param {string} name */
function exactRecord(value, keys, name) {
  if (!isRecord(value)) throw new TypeError(`${name} must be an object`);
  const actual = Object.keys(value);
  const unknown = actual.filter((key) => !keys.has(key));
  const missing = [...keys].filter((key) => !Object.hasOwn(value, key));
  if (unknown.length > 0 || missing.length > 0) {
    throw new TypeError(
      `${name} keys are invalid (unknown: ${unknown.sort().join(', ') || 'none'}; missing: ${missing.sort().join(', ') || 'none'})`,
    );
  }
  return value;
}

/** @param {unknown} value @param {string} name */
function nonEmptyString(value, name) {
  if (typeof value !== 'string' || value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${name} must be a non-empty string without control characters`);
  }
  return value;
}

/** @param {unknown} value @param {string} name */
function positiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return Number(value);
}

/** @param {unknown} value @param {string} name */
function boolean(value, name) {
  if (typeof value !== 'boolean') throw new TypeError(`${name} must be boolean`);
  return value;
}

/** @param {unknown} value @param {string} name */
function integrity(value, name) {
  if (typeof value !== 'string' || !sha256SRI.test(value)) {
    throw new TypeError(`${name} must be a canonical SHA-256 SRI value`);
  }
  return value;
}

/**
 * Create the structural fingerprint used to choose live reload or a full rebuild.
 * Source text is deliberately not accepted. Its separate integrity selects live reload.
 *
 * @param {unknown} input
 * @param {{subtleCrypto?: {digest: Function}}} [options]
 */
export async function createDsl4ArtifactFingerprint(
  input,
  {subtleCrypto = globalThis.crypto?.subtle} = {},
) {
  const root = exactRecord(input, inputKeys, 'artifact fingerprint input');
  if (root.formatVersion !== 1) {
    throw new TypeError('artifact fingerprint input formatVersion must be 1');
  }
  const appShell = exactRecord(root.appShell, appShellKeys, 'appShell');
  const extensionBundle = exactRecord(root.extensionBundle, extensionBundleKeys, 'extensionBundle');
  if (extensionBundle.formatVersion !== 1) {
    throw new TypeError('extensionBundle.formatVersion must be 1');
  }
  const builder = exactRecord(root.builder, builderKeys, 'builder');
  if (builder.package !== packageName || builder.version !== packageVersion) {
    throw new TypeError(
      `builder package and version must be exactly ${packageName}@${packageVersion}`,
    );
  }
  const settings = exactRecord(builder.settings, builderSettingKeys, 'builder.settings');
  if (settings.channel !== 'bundled' && settings.channel !== 'unbundled') {
    throw new TypeError('builder.settings.channel must be bundled or unbundled');
  }
  const project = exactRecord(root.project, projectKeys, 'project');
  const sourceManifest = validateDsl4ExternalSourceManifest(project.sourceManifest);

  const normalized = deepFreeze({
    formatVersion: 1,
    baseSb3Integrity: integrity(root.baseSb3Integrity, 'baseSb3Integrity'),
    assetBundleIntegrity: integrity(root.assetBundleIntegrity, 'assetBundleIntegrity'),
    appShell: {
      id: nonEmptyString(appShell.id, 'appShell.id'),
      templateVersion: nonEmptyString(appShell.templateVersion, 'appShell.templateVersion'),
      integrity: integrity(appShell.integrity, 'appShell.integrity'),
    },
    extensionBundle: {
      formatVersion: 1,
      id: nonEmptyString(extensionBundle.id, 'extensionBundle.id'),
      integrity: integrity(extensionBundle.integrity, 'extensionBundle.integrity'),
    },
    builder: {
      package: packageName,
      version: packageVersion,
      settings: {
        channel: settings.channel,
        maxSourceBytes: positiveSafeInteger(
          settings.maxSourceBytes,
          'builder.settings.maxSourceBytes',
        ),
        maxAssetFileBytes: positiveSafeInteger(
          settings.maxAssetFileBytes,
          'builder.settings.maxAssetFileBytes',
        ),
        maxAssetFiles: positiveSafeInteger(
          settings.maxAssetFiles,
          'builder.settings.maxAssetFiles',
        ),
        maxTotalAssetBytes: positiveSafeInteger(
          settings.maxTotalAssetBytes,
          'builder.settings.maxTotalAssetBytes',
        ),
        historyNavigationAvailable: boolean(
          settings.historyNavigationAvailable,
          'builder.settings.historyNavigationAvailable',
        ),
        replaceExisting: boolean(settings.replaceExisting, 'builder.settings.replaceExisting'),
      },
    },
    project: {
      sourceManifest,
      controlProfile: nonEmptyString(project.controlProfile, 'project.controlProfile'),
    },
  });
  const canonicalInput = JSON.stringify(normalized);
  const fingerprintIntegrity = await computeDsl4Sha256Integrity(
    new TextEncoder().encode(canonicalInput),
    subtleCrypto,
  );
  return deepFreeze({formatVersion: 1, integrity: fingerprintIntegrity, inputs: normalized});
}

/**
 * Classify two already validated snapshots. Structural changes always take precedence.
 *
 * @param {unknown} input
 */
export function classifyDsl4PreviewChange(input) {
  const values = exactRecord(input, classificationKeys, 'preview change classification');
  const activeArtifactFingerprint = integrity(
    values.activeArtifactFingerprint,
    'activeArtifactFingerprint',
  );
  const candidateArtifactFingerprint = integrity(
    values.candidateArtifactFingerprint,
    'candidateArtifactFingerprint',
  );
  const activeSourceIntegrity = integrity(values.activeSourceIntegrity, 'activeSourceIntegrity');
  const candidateSourceIntegrity = integrity(
    values.candidateSourceIntegrity,
    'candidateSourceIntegrity',
  );

  if (activeArtifactFingerprint !== candidateArtifactFingerprint) {
    return deepFreeze({
      formatVersion: 1,
      kind: 'full-rebuild',
      requiresFullRebuild: true,
      requiresNewPreviewSession: true,
      restartFrom: 'entrypoint',
    });
  }
  if (activeSourceIntegrity !== candidateSourceIntegrity) {
    return deepFreeze({
      formatVersion: 1,
      kind: 'live-reload',
      requiresFullRebuild: false,
      requiresNewPreviewSession: false,
      restartFrom: 'author-choice',
    });
  }
  return deepFreeze({
    formatVersion: 1,
    kind: 'no-change',
    requiresFullRebuild: false,
    requiresNewPreviewSession: false,
    restartFrom: 'unchanged',
  });
}
