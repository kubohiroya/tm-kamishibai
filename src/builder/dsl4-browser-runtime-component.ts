import {unzipSync} from 'fflate';

import {
  dsl4BrowserTurboWarpStageDefaults,
  dsl4BrowserTurboWarpStageMaximumProjectBytes,
} from '../dsl4/browser-turbowarp-stage.js';
import {dsl4BrowserPreviewArtifactLimits} from '../dsl4/browser-preview-artifact-limits.js';
import {loadDsl4RuntimeComponent} from '../dsl4/runtime-artifact-loader.js';
import {deepFreeze} from '../dsl4/story-document.js';

const standardRuntimeExtensionId = 'kubohiroyakamishibai4';

export const dsl4BrowserRuntimeComponentDefaults = deepFreeze({
  maxProjectBytes: dsl4BrowserTurboWarpStageDefaults.maxProjectBytes,
  maxArchiveEntries: 4096,
  maxProjectJsonBytes: dsl4BrowserPreviewArtifactLimits.defaults.maxProjectJsonBytes,
});

export const dsl4BrowserRuntimeComponentMaximums = deepFreeze({
  maxProjectBytes: dsl4BrowserTurboWarpStageMaximumProjectBytes,
  maxArchiveEntries: 16_384,
  maxProjectJsonBytes: dsl4BrowserPreviewArtifactLimits.absoluteMaximums.maxProjectJsonBytes,
});

export class Dsl4BrowserRuntimeComponentError extends Error {
  code: string;

  constructor(code: string, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : {cause});
    this.name = 'Dsl4BrowserRuntimeComponentError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new Dsl4BrowserRuntimeComponentError(code, message, cause);
}

function boundedLimit(value: unknown, name: string, maximum: number) {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) {
    throw new TypeError(`${name} must be a safe integer between 1 and ${maximum}`);
  }
  return Number(value);
}

function validateEntryName(entryName: string) {
  const path = entryName.endsWith('/') ? entryName.slice(0, -1) : entryName;
  const segments = path.split('/');
  if (
    path.length === 0 ||
    path.includes('\0') ||
    path.includes('\\') ||
    path.startsWith('/') ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(path) ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    fail('K4-PREVIEW-PROJECT-PATH-001', 'Preview SB3 contains an unsafe ZIP entry path');
  }
}

function requiresStandardRuntimeMarker(project: Record<string, any>) {
  if (
    !Array.isArray(project.extensions) ||
    !project.extensions.includes(standardRuntimeExtensionId)
  ) {
    return false;
  }
  const extensionUrl = project.extensionURLs?.[standardRuntimeExtensionId];
  if (
    typeof extensionUrl !== 'string' ||
    !extensionUrl.startsWith('data:text/javascript;base64,')
  ) {
    fail(
      'K4-PREVIEW-PROJECT-EXTENSION-001',
      'Preview Standard runtime extension metadata is invalid',
    );
  }
  return true;
}

/**
 * Extract and validate the immutable runtime component embedded in one browser preview base SB3.
 * The external generation StoryDocument is deliberately absent from this boundary.
 */
export async function loadDsl4BrowserRuntimeComponent(optionsInput: object) {
  if (!isRecord(optionsInput)) {
    throw new TypeError('browser runtime component options are required');
  }
  const options = optionsInput as Record<string, any>;
  if (!(options.projectBytes instanceof Uint8Array)) {
    throw new TypeError('projectBytes must be a Uint8Array');
  }
  if (!isRecord(options.sourceFrontend) || typeof options.sourceFrontend.parse !== 'function') {
    throw new TypeError('sourceFrontend must provide parse');
  }
  const sourceFrontend = options.sourceFrontend as {
    parse(source: string, options?: {sourceId?: string}): Readonly<Record<string, any>>;
  };
  const maxProjectBytes = boundedLimit(
    options.maxProjectBytes ?? dsl4BrowserRuntimeComponentDefaults.maxProjectBytes,
    'maxProjectBytes',
    dsl4BrowserRuntimeComponentMaximums.maxProjectBytes,
  );
  const maxArchiveEntries = boundedLimit(
    options.maxArchiveEntries ?? dsl4BrowserRuntimeComponentDefaults.maxArchiveEntries,
    'maxArchiveEntries',
    dsl4BrowserRuntimeComponentMaximums.maxArchiveEntries,
  );
  const maxProjectJsonBytes = boundedLimit(
    options.maxProjectJsonBytes ?? dsl4BrowserRuntimeComponentDefaults.maxProjectJsonBytes,
    'maxProjectJsonBytes',
    dsl4BrowserRuntimeComponentMaximums.maxProjectJsonBytes,
  );
  if (options.projectBytes.byteLength < 1 || options.projectBytes.byteLength > maxProjectBytes) {
    fail('K4-PREVIEW-PROJECT-LIMIT-001', 'Preview SB3 exceeds the configured project byte limit');
  }

  let retainedBytes = new Uint8Array(options.projectBytes);
  let projectEntry;
  try {
    let entryCount = 0;
    const seen = new Set();
    const archive = unzipSync(retainedBytes, {
      filter(info) {
        entryCount += 1;
        if (entryCount > maxArchiveEntries) {
          fail(
            'K4-PREVIEW-PROJECT-LIMIT-001',
            'Preview SB3 exceeds the configured archive entry limit',
          );
        }
        validateEntryName(info.name);
        if (seen.has(info.name)) {
          fail('K4-PREVIEW-PROJECT-ARCHIVE-001', 'Preview SB3 contains a duplicate ZIP entry');
        }
        seen.add(info.name);
        if (info.name !== 'project.json') return false;
        if (info.originalSize < 1 || info.originalSize > maxProjectJsonBytes) {
          fail(
            'K4-PREVIEW-PROJECT-LIMIT-001',
            'Preview project.json exceeds the configured uncompressed byte limit',
          );
        }
        if (info.compression !== 0 && info.compression !== 8) {
          fail(
            'K4-PREVIEW-PROJECT-ARCHIVE-001',
            'Preview project.json uses an unsupported ZIP compression method',
          );
        }
        return true;
      },
    });
    if (!seen.has('project.json')) {
      fail('K4-PREVIEW-PROJECT-ARCHIVE-001', 'Preview SB3 is missing project.json');
    }
    const names = Object.keys(archive);
    if (names.length !== 1 || names[0] !== 'project.json') {
      fail('K4-PREVIEW-PROJECT-ARCHIVE-001', 'Preview project.json extraction failed');
    }
    projectEntry = new Uint8Array(archive['project.json'] ?? new Uint8Array());
  } catch (error) {
    if (error instanceof Dsl4BrowserRuntimeComponentError) throw error;
    fail('K4-PREVIEW-PROJECT-ARCHIVE-001', 'Preview SB3 is not a valid bounded ZIP archive', error);
  } finally {
    retainedBytes.fill(0);
    retainedBytes = new Uint8Array(0);
  }

  let projectText;
  try {
    projectText = new TextDecoder('utf-8', {fatal: true}).decode(projectEntry);
  } catch (error) {
    projectEntry.fill(0);
    fail('K4-PREVIEW-PROJECT-UTF8-001', 'Preview project.json is not valid UTF-8', error);
  }
  projectEntry.fill(0);
  let project;
  try {
    project = JSON.parse(projectText);
  } catch (error) {
    fail('K4-PREVIEW-PROJECT-JSON-001', 'Preview project.json is not valid JSON', error);
  } finally {
    projectText = '';
  }
  if (!isRecord(project) || Object.getPrototypeOf(project) !== Object.prototype) {
    fail('K4-PREVIEW-PROJECT-JSON-001', 'Preview project.json must contain an object');
  }
  if (!Array.isArray(project.targets)) {
    fail('K4-PREVIEW-PROJECT-JSON-001', 'Preview project.json must contain a targets array');
  }
  const standardRuntimeMarkerRequired = requiresStandardRuntimeMarker(project);
  const component = await loadDsl4RuntimeComponent(project, sourceFrontend, {
    maxSourceBytes: options.maxSourceBytes,
    maxAssetFiles: options.maxAssetFiles,
    maxAssetBytes: options.maxAssetBytes,
    historyNavigationAvailable: options.historyNavigationAvailable ?? false,
    ...(options.subtleCrypto === undefined ? {} : {subtleCrypto: options.subtleCrypto}),
  });
  return component.ok ? deepFreeze({...component, standardRuntimeMarkerRequired}) : component;
}
