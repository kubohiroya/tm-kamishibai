import {strFromU8, strToU8, zipSync} from 'fflate';

import {createDsl4RuntimeArtifactDescriptor} from '../runtime-artifact-descriptor.js';
import {loadDsl4RuntimeComponent} from '../runtime-artifact-loader.js';
import {dsl4ScratchPoseFeedbackVariableNames} from './scratch-pose-feedback-adapter.js';

export const dsl4BrowserDistributionBuildDefaults = Object.freeze({
  maxArchiveEntries: 4096,
  maxArchiveBytes: 256 * 1024 * 1024,
  maxProjectBytes: 16 * 1024 * 1024,
});

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class Dsl4BrowserDistributionBuildError extends Error {
  /** @param {string} code @param {string} message @param {unknown} [cause] */
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : {cause});
    this.name = 'Dsl4BrowserDistributionBuildError';
    this.code = code;
  }
}

/** @param {string} code @param {string} message @param {unknown} [cause] @returns {never} */
function fail(code, message, cause) {
  throw new Dsl4BrowserDistributionBuildError(code, message, cause);
}

/** @param {unknown} value @param {string} name */
function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return Number(value);
}

/** @param {string} name */
function safeArchiveEntryName(name) {
  const segments = name.replace(/\/$/u, '').split('/');
  if (
    name.length === 0 ||
    name.includes('\0') ||
    name.includes('\\') ||
    name.startsWith('/') ||
    /^[A-Za-z]:/u.test(name) ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    fail('K4-BROWSER-BUILD-ARCHIVE-PATH', `The open project contains an unsafe entry: ${name}`);
  }
  return name;
}

/** @param {unknown} value @param {string} name */
function archiveBytes(value, name) {
  if (!(value instanceof Uint8Array)) {
    fail('K4-BROWSER-BUILD-ARCHIVE-ENTRY', `The open project entry is not binary data: ${name}`);
  }
  return new Uint8Array(value);
}

/** @param {unknown} projectFiles @param {number} maxArchiveEntries @param {number} maxArchiveBytes */
function inspectProjectFiles(projectFiles, maxArchiveEntries, maxArchiveBytes) {
  if (!isRecord(projectFiles)) {
    fail('K4-BROWSER-BUILD-ARCHIVE', 'TurboWarp did not provide the open project files');
  }
  const entries = Object.entries(projectFiles);
  if (entries.length === 0 || entries.length > maxArchiveEntries) {
    fail(
      'K4-BROWSER-BUILD-ARCHIVE-LIMIT',
      `The open project must contain between 1 and ${maxArchiveEntries} files`,
    );
  }
  let totalBytes = 0;
  /** @type {Record<string, Uint8Array>} */
  const archive = {};
  for (const [entryName, value] of entries) {
    safeArchiveEntryName(entryName);
    if (entryName.endsWith('/')) continue;
    const bytes = archiveBytes(value, entryName);
    totalBytes += bytes.byteLength;
    if (totalBytes > maxArchiveBytes) {
      fail(
        'K4-BROWSER-BUILD-ARCHIVE-LIMIT',
        `The open project exceeds the ${maxArchiveBytes}-byte build limit`,
      );
    }
    archive[entryName] = bytes;
  }
  if (!archive['project.json']) {
    fail('K4-BROWSER-BUILD-PROJECT', 'The open project does not contain project.json');
  }
  return /** @type {Record<string, Uint8Array>} */ (archive);
}

/** @param {Uint8Array} bytes @param {number} maxProjectBytes */
function parseProject(bytes, maxProjectBytes) {
  if (bytes.byteLength > maxProjectBytes) {
    fail(
      'K4-BROWSER-BUILD-PROJECT-LIMIT',
      `project.json exceeds the ${maxProjectBytes}-byte build limit`,
    );
  }
  let project;
  try {
    project = JSON.parse(strFromU8(bytes));
  } catch (error) {
    fail('K4-BROWSER-BUILD-PROJECT', 'The open project contains invalid project.json', error);
  }
  if (!isRecord(project) || !Array.isArray(project.targets)) {
    fail('K4-BROWSER-BUILD-PROJECT', 'The open project.json must contain a target list');
  }
  return /** @type {Record<string, any>} */ (project);
}

/** @param {unknown} runtimeComponent */
function requireRuntimeComponent(runtimeComponent) {
  if (
    !isRecord(runtimeComponent) ||
    !isRecord(runtimeComponent.storyDocument) ||
    !isRecord(runtimeComponent.sourceDescriptor) ||
    !isRecord(runtimeComponent.assetBundle)
  ) {
    fail(
      'K4-BROWSER-BUILD-SOURCE',
      'The latest validated browser preview generation is unavailable',
    );
  }
  return /** @type {Readonly<Record<string, any>>} */ (runtimeComponent);
}

const poseFeedbackVariables = Object.freeze([
  Object.freeze({
    preferredId: 'dsl4-pose-confidence',
    name: dsl4ScratchPoseFeedbackVariableNames.confidence,
    x: 0,
  }),
  Object.freeze({
    preferredId: 'dsl4-pose-progress',
    name: dsl4ScratchPoseFeedbackVariableNames.progress,
    x: 343,
  }),
]);

/** @param {Record<string, any>} variables @param {string} preferredId @param {string} name */
function ensureStageVariable(variables, preferredId, name) {
  const existing = Object.entries(variables).find(
    ([, value]) => Array.isArray(value) && value[0] === name,
  );
  if (existing) {
    if (existing[1][2] === true) {
      fail(
        'K4-BROWSER-BUILD-PROJECT',
        `The required Stage variable cannot be a cloud variable: ${name}`,
      );
    }
    variables[existing[0]] = [name, 0];
    return existing[0];
  }
  let id = preferredId;
  let suffix = 2;
  while (Object.hasOwn(variables, id)) {
    id = `${preferredId}-${suffix}`;
    suffix += 1;
  }
  variables[id] = [name, 0];
  return id;
}

/** @param {Record<string, any>} project */
function ensureProductionStageContract(project) {
  const stage = project.targets.find(
    (/** @type {unknown} */ target) => isRecord(target) && target.isStage === true,
  );
  if (!isRecord(stage)) {
    fail('K4-BROWSER-BUILD-PROJECT', 'The open project.json does not contain a Stage target');
  }
  if (!isRecord(stage.variables)) stage.variables = {};
  if (!Array.isArray(project.monitors)) project.monitors = [];
  for (const definition of poseFeedbackVariables) {
    const id = ensureStageVariable(
      /** @type {Record<string, any>} */ (stage.variables),
      definition.preferredId,
      definition.name,
    );
    const monitor = {
      id,
      mode: 'slider',
      opcode: 'data_variable',
      params: {VARIABLE: definition.name},
      spriteName: null,
      value: 0,
      width: 0,
      height: 0,
      x: definition.x,
      y: 0,
      visible: false,
      sliderMin: 0,
      sliderMax: 100,
      isDiscrete: true,
    };
    const monitorIndex = project.monitors.findIndex(
      (/** @type {unknown} */ candidate) => isRecord(candidate) && candidate.id === id,
    );
    if (monitorIndex === -1) project.monitors.push(monitor);
    else project.monitors[monitorIndex] = monitor;
  }
}

/** @param {Record<string, any>} project @param {Readonly<Record<string, any>>} component @param {Readonly<Record<string, any>>} artifact */
function installDistributionComponent(project, component, artifact) {
  const output = structuredClone(project);
  ensureProductionStageContract(output);
  if (!isRecord(output.extensionStorage)) output.extensionStorage = {};
  delete output.extensionStorage.kubohiroyakamishibairuntime4;
  if (!isRecord(output.extensionStorage.kubohiroyakamishibai4)) {
    output.extensionStorage.kubohiroyakamishibai4 = {};
  }
  const bundle = output.extensionStorage.kubohiroyakamishibai4;
  if (!isRecord(bundle.components)) bundle.components = {};
  bundle.components.kubohiroyakamishibairuntime4 = {
    source: structuredClone(component.sourceDescriptor),
    artifact: structuredClone(artifact),
    assets: structuredClone(component.assetBundle),
    application: {mode: 'story'},
  };
  return output;
}

/** @param {string} displayName */
export function createDsl4BrowserDistributionFilename(displayName) {
  const leaf = String(displayName || 'story.kamishibai.yaml')
    .split(/[\\/]/u)
    .at(-1);
  const stem = String(leaf)
    .replace(/\.(?:k4|kamishibai)\.ya?ml$/iu, '')
    .replace(/\.ya?ml$/iu, '')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-');
  return `${stem || 'story'}.sb3`;
}

/**
 * Build a standalone SB3 from the currently open TurboWarp project and one stable browser preview
 * generation. The input project and runtime component are never mutated.
 *
 * @param {object} options
 * @param {unknown} options.projectFiles
 * @param {unknown} options.runtimeComponent
 * @param {{parse(source: string, options?: {sourceId?: string}): Readonly<Record<string, any>>}} options.sourceFrontend
 * @param {number} options.maxSourceBytes
 * @param {number} options.maxAssetFiles
 * @param {number} options.maxAssetBytes
 * @param {number} [options.maxArchiveEntries]
 * @param {number} [options.maxArchiveBytes]
 * @param {number} [options.maxProjectBytes]
 * @param {'allowed' | 'forbidden'} [options.network]
 * @param {{digest: Function}} [options.subtleCrypto]
 */
export async function createDsl4BrowserDistributionSb3(options) {
  if (!isRecord(options)) throw new TypeError('browser distribution build options are required');
  if (!isRecord(options.sourceFrontend) || typeof options.sourceFrontend.parse !== 'function') {
    throw new TypeError('sourceFrontend must provide parse');
  }
  const maxSourceBytes = positiveInteger(options.maxSourceBytes, 'maxSourceBytes');
  const maxAssetFiles = positiveInteger(options.maxAssetFiles, 'maxAssetFiles');
  const maxAssetBytes = positiveInteger(options.maxAssetBytes, 'maxAssetBytes');
  const maxArchiveEntries = positiveInteger(
    options.maxArchiveEntries ?? dsl4BrowserDistributionBuildDefaults.maxArchiveEntries,
    'maxArchiveEntries',
  );
  const maxArchiveBytes = positiveInteger(
    options.maxArchiveBytes ?? dsl4BrowserDistributionBuildDefaults.maxArchiveBytes,
    'maxArchiveBytes',
  );
  const maxProjectBytes = positiveInteger(
    options.maxProjectBytes ?? dsl4BrowserDistributionBuildDefaults.maxProjectBytes,
    'maxProjectBytes',
  );
  const network = options.network ?? 'allowed';
  if (!['allowed', 'forbidden'].includes(network)) {
    throw new TypeError('network must be allowed or forbidden');
  }
  const component = requireRuntimeComponent(options.runtimeComponent);
  const manifestAssets = /** @type {ReadonlyArray<Record<string, any>>} */ (
    component.assetBundle.manifest.assets
  );
  const remoteAssetCount = manifestAssets.filter(
    (asset) => asset?.source?.type === 'remote',
  ).length;
  if (network === 'forbidden' && remoteAssetCount > 0) {
    fail(
      'K4-BROWSER-BUILD-OFFLINE-REMOTE',
      'Offline distribution cannot contain remote asset providers',
    );
  }
  const archive = inspectProjectFiles(options.projectFiles, maxArchiveEntries, maxArchiveBytes);
  const project = parseProject(archive['project.json'], maxProjectBytes);
  const artifactResult = await createDsl4RuntimeArtifactDescriptor(
    component.storyDocument,
    component.sourceDescriptor,
    'production',
    {maxSourceBytes, subtleCrypto: options.subtleCrypto},
  );
  if (artifactResult.ok !== true) {
    const diagnostic = artifactResult.diagnostics?.[0];
    fail(
      typeof diagnostic?.code === 'string' ? diagnostic.code : 'K4-BROWSER-BUILD-CONTROLS',
      diagnostic?.message ?? 'The latest validated source cannot use production controls',
    );
  }
  const outputProject = installDistributionComponent(
    project,
    component,
    /** @type {Readonly<Record<string, any>>} */ (artifactResult).artifact,
  );
  const verified = await loadDsl4RuntimeComponent(outputProject, options.sourceFrontend, {
    maxSourceBytes,
    maxAssetFiles,
    maxAssetBytes,
    subtleCrypto: options.subtleCrypto,
  });
  if (verified.ok !== true) {
    const diagnostic = verified.diagnostics?.[0];
    fail(
      typeof diagnostic?.code === 'string' ? diagnostic.code : 'K4-BROWSER-BUILD-VERIFY',
      diagnostic?.message ?? 'The generated distribution component could not be verified',
    );
  }
  const projectBytes = strToU8(`${JSON.stringify(outputProject)}\n`);
  if (projectBytes.byteLength > maxProjectBytes) {
    fail(
      'K4-BROWSER-BUILD-PROJECT-LIMIT',
      `Generated project.json exceeds the ${maxProjectBytes}-byte build limit`,
    );
  }
  const orderedArchive = Object.fromEntries(
    Object.entries({...archive, 'project.json': projectBytes}).sort(([left], [right]) => {
      if (left === 'project.json') return -1;
      if (right === 'project.json') return 1;
      return left.localeCompare(right, 'en');
    }),
  );
  const outputUncompressedBytes = Object.values(orderedArchive).reduce(
    (total, entry) => total + entry.byteLength,
    0,
  );
  if (outputUncompressedBytes > maxArchiveBytes) {
    fail(
      'K4-BROWSER-BUILD-ARCHIVE-LIMIT',
      `Generated SB3 entries exceed the ${maxArchiveBytes}-byte build limit`,
    );
  }
  const bytes = new Uint8Array(zipSync(orderedArchive, {level: 6}));
  if (bytes.byteLength > maxArchiveBytes) {
    fail(
      'K4-BROWSER-BUILD-ARCHIVE-LIMIT',
      `Generated SB3 exceeds the ${maxArchiveBytes}-byte build limit`,
    );
  }
  return Object.freeze({
    bytes,
    filename: createDsl4BrowserDistributionFilename(component.sourceDescriptor.displayName),
    project: outputProject,
    runtimeComponent: verified,
    delivery: Object.freeze({networkRequired: remoteAssetCount > 0, remoteAssetCount}),
  });
}

/**
 * Download generated bytes without asking for persistent filesystem permission.
 *
 * @param {object} options
 * @param {unknown} options.bytes
 * @param {string} options.filename
 * @param {Record<string, any>} [options.globalObject]
 */
export function downloadDsl4BrowserDistributionSb3({
  bytes: bytesInput,
  filename,
  globalObject = globalThis,
}) {
  const bytes = archiveBytes(bytesInput, 'distribution.sb3');
  if (typeof filename !== 'string' || !filename.endsWith('.sb3')) {
    throw new TypeError('distribution filename must end with .sb3');
  }
  const document = /** @type {Record<string, any>} */ (globalObject.document);
  const URL = /** @type {Record<string, any>} */ (globalObject.URL);
  const Blob = globalObject.Blob;
  if (
    !isRecord(document) ||
    typeof document.createElement !== 'function' ||
    typeof URL.createObjectURL !== 'function' ||
    typeof URL.revokeObjectURL !== 'function' ||
    typeof Blob !== 'function'
  ) {
    fail('K4-BROWSER-BUILD-DOWNLOAD', 'This browser cannot download the generated SB3');
  }
  const browserDocument = /** @type {Record<string, any>} */ (document);
  const browserURL = /** @type {Record<string, any>} */ (URL);
  const anchorCandidate = browserDocument.createElement('a');
  if (!isRecord(anchorCandidate) || typeof anchorCandidate.click !== 'function') {
    fail('K4-BROWSER-BUILD-DOWNLOAD', 'This browser cannot create an SB3 download');
  }
  const anchor = /** @type {Record<string, any>} */ (anchorCandidate);
  const objectUrl = browserURL.createObjectURL(
    new Blob([bytes], {type: 'application/x.scratch.sb3'}),
  );
  try {
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.style.display = 'none';
    browserDocument.body?.appendChild?.(anchor);
    anchor.click();
  } finally {
    anchor.remove?.();
    browserURL.revokeObjectURL(objectUrl);
  }
  return Object.freeze({method: 'download', filename, size: bytes.byteLength});
}

/**
 * Invoke the native save picker while the build-button activation is still current. Unsupported
 * browsers return null and use the download adapter after verification.
 *
 * @param {object} options
 * @param {string} options.filename
 * @param {Record<string, any>} [options.globalObject]
 */
export function requestDsl4BrowserDistributionSaveTarget({filename, globalObject = globalThis}) {
  if (typeof filename !== 'string' || !filename.endsWith('.sb3')) {
    throw new TypeError('distribution filename must end with .sb3');
  }
  let topLevel = false;
  try {
    topLevel = globalObject.self === globalObject.top;
  } catch {
    topLevel = false;
  }
  if (
    globalObject.isSecureContext !== true ||
    !topLevel ||
    typeof globalObject.showSaveFilePicker !== 'function'
  ) {
    return Promise.resolve(null);
  }
  let selection;
  try {
    selection = globalObject.showSaveFilePicker({
      suggestedName: filename,
      types: [
        {
          description: 'Scratch 3 project',
          accept: {'application/x.scratch.sb3': ['.sb3']},
        },
      ],
    });
  } catch (error) {
    selection = Promise.reject(error);
  }
  return Promise.resolve(selection).then(
    (handle) => {
      if (!isRecord(handle) || typeof handle.createWritable !== 'function') {
        fail('K4-BROWSER-BUILD-SAVE', 'The browser returned an invalid save destination');
      }
      return Object.freeze({method: 'file-system', filename, handle});
    },
    (error) => {
      if (isRecord(error) && error.name === 'AbortError') {
        return Object.freeze({method: 'cancelled', filename});
      }
      fail('K4-BROWSER-BUILD-SAVE', 'The browser could not select an SB3 destination', error);
    },
  );
}

/**
 * Save to a user-selected file transactionally, or fall back to a browser download.
 *
 * @param {object} options
 * @param {unknown} options.bytes
 * @param {string} options.filename
 * @param {unknown} [options.target]
 * @param {Record<string, any>} [options.globalObject]
 */
export async function saveDsl4BrowserDistributionSb3({
  bytes: bytesInput,
  filename,
  target = null,
  globalObject = globalThis,
}) {
  const bytes = archiveBytes(bytesInput, 'distribution.sb3');
  if (isRecord(target) && target.method === 'cancelled') {
    return Object.freeze({method: 'cancelled', filename, size: 0});
  }
  if (!isRecord(target) || target.method !== 'file-system') {
    return downloadDsl4BrowserDistributionSb3({bytes, filename, globalObject});
  }
  const handle = /** @type {Record<string, any>} */ (target.handle);
  let writable;
  try {
    writable = await handle.createWritable({keepExistingData: false});
    if (
      !isRecord(writable) ||
      typeof writable.write !== 'function' ||
      typeof writable.close !== 'function'
    ) {
      fail('K4-BROWSER-BUILD-SAVE', 'The selected destination is not writable');
    }
    await writable.write(bytes);
    await writable.close();
  } catch (error) {
    try {
      await writable?.abort?.();
    } catch {
      // The original write failure remains the actionable diagnostic.
    }
    if (error instanceof Dsl4BrowserDistributionBuildError) throw error;
    fail('K4-BROWSER-BUILD-SAVE', 'The generated SB3 could not be saved', error);
  }
  return Object.freeze({method: 'file-system', filename, size: bytes.byteLength});
}
