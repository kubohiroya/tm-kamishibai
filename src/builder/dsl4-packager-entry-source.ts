import {unzipSync, zipSync} from 'fflate';

import {dsl4BinaryEntryFormatVersion} from '../dsl4/binary-entry-provider.js';
import {
  dsl4PackagerEntrySourceContractVersion,
  dsl4PackagerEntrySourceRegistryName,
} from '../dsl4/packager-entry-source.js';
import {fixedZipTimestamp} from './constants.js';
import {inspectDsl4BinaryEntryArchive} from './dsl4-binary-entry-sb3.js';
import {dsl4PackagerCompatibility} from './dsl4-packager-compatibility.js';

const bootstrapMarker = '/* tm-kamishibai dsl4-packager-entry-source v1 */';
const packagerZipLoadTemplate =
  "zip = await Scaffolding.JSZip.loadAsync(data);\n          const file = findFileInZip('project.json');";
const packagerEntrySourceAttach = `globalThis[Symbol.for(${JSON.stringify(
  dsl4PackagerEntrySourceRegistryName,
)})].attachZip(zip);`;

export class Dsl4PackagerAdapterError extends Error {
  code: string;

  constructor(code: string, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : {cause});
    this.name = 'Dsl4PackagerAdapterError';
    this.code = code;
  }
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new Dsl4PackagerAdapterError(code, message, cause);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function resolveDsl4PackagerEntrySourceSurface(target: string) {
  if (target === 'html') return Object.freeze({id: 'plain-html', mode: 'archive'});
  if (target === 'zip-one-asset') return Object.freeze({id: 'zip-one-asset', mode: 'archive'});
  if (target === 'zip') return Object.freeze({id: 'zip', mode: 'direct'});
  if (target.startsWith('electron-')) return Object.freeze({id: 'electron', mode: 'direct'});
  throw new TypeError(`Unsupported DSL 4.0 Packager target: ${target}`);
}

function validatePackagerMetadata(metadata: unknown) {
  if (!isRecord(metadata)) throw new TypeError('packagerPackage must be an object');
  if (
    metadata.name !== dsl4PackagerCompatibility.package ||
    metadata.version !== dsl4PackagerCompatibility.version
  ) {
    fail(
      'K4-PACKAGER-COMPATIBILITY-001',
      `DSL 4.0 requires ${dsl4PackagerCompatibility.package} ${dsl4PackagerCompatibility.version}`,
    );
  }
}

function createBootstrapScript(configuration: Readonly<Record<string, any>>) {
  return `${bootstrapMarker}
(() => {
  const configuration = Object.freeze(${JSON.stringify(configuration)});
  const key = Symbol.for(${JSON.stringify(dsl4PackagerEntrySourceRegistryName)});
  const contractVersion = ${dsl4PackagerEntrySourceContractVersion};
  const entryPrefix = 'k4asset-v1-';
  const archiveMetadata = Object.freeze({...configuration.archive});
  const entries = Object.freeze(configuration.entries.map((entry) => Object.freeze({...entry})));
  const entriesByName = new Map(entries.map((entry) => [entry.name, entry]));
  let archive = null;
  let claimed = false;
  let released = false;

  const codedError = (code, message) => {
    const error = new Error(message);
    Object.defineProperty(error, 'code', {value: code});
    return error;
  };
  const validatePath = (entryName) => {
    const path = entryName.endsWith('/') ? entryName.slice(0, -1) : entryName;
    const segments = path.split('/');
    if (
      path.length === 0 ||
      path.includes('\\0') ||
      path.includes('\\\\') ||
      path.startsWith('/') ||
      /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path) ||
      segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
    ) {
      throw codedError('K4-ASSET-ENTRY-PATH-001', 'Packager ZIP contains an unsafe entry path');
    }
  };
  const assertReadable = (entryName, signal) => {
    if (released) {
      throw codedError('K4-PACKAGER-ENTRY-SOURCE-RELEASED-001', 'Packager entry source was released');
    }
    if (signal?.aborted) {
      throw codedError('K4-ASSET-ENTRY-ABORTED-001', 'Packager entry read was aborted');
    }
    const metadata = entriesByName.get(entryName);
    if (!metadata) {
      throw codedError('K4-ASSET-ENTRY-LOOKUP-001', 'Packager binary entry was not declared');
    }
    return metadata;
  };
  const source = Object.freeze({
    contractVersion,
    surface: configuration.surface,
    archive: archiveMetadata,
    entries,
    get released() {
      return released;
    },
    async readEntry(entryName, {signal} = {}) {
      const metadata = assertReadable(entryName, signal);
      let bytes;
      if (configuration.mode === 'archive') {
        if (!archive) {
          throw codedError('K4-PACKAGER-ENTRY-SOURCE-NOT-READY-001', 'Packager ZIP is not attached');
        }
        const file = archive.file(entryName);
        if (!file || file.dir) {
          throw codedError('K4-ASSET-ENTRY-LOOKUP-001', 'Packager binary entry is missing');
        }
        bytes = await file.async('uint8array');
      } else {
        const response = await fetch(new URL('./assets/' + encodeURIComponent(entryName), location), {
          cache: 'no-store',
          credentials: 'same-origin',
          signal,
        });
        if (!response.ok) {
          throw codedError('K4-ASSET-ENTRY-READ-001', 'Packager binary entry request failed');
        }
        bytes = new Uint8Array(await response.arrayBuffer());
      }
      if (signal?.aborted) {
        throw codedError('K4-ASSET-ENTRY-ABORTED-001', 'Packager entry read was aborted');
      }
      return {bytes: new Uint8Array(bytes), compressedSize: metadata.compressedSize};
    },
    release() {
      if (released) return;
      released = true;
      archive = null;
      entriesByName.clear();
    },
  });
  const registry = Object.freeze({
    contractVersion,
    surface: configuration.surface,
    attachZip(candidate) {
      if (configuration.mode !== 'archive' || archive || claimed || released) {
        throw codedError('K4-PACKAGER-ENTRY-SOURCE-ATTACH-001', 'Packager ZIP attachment is invalid');
      }
      if (!candidate || typeof candidate.file !== 'function' || !candidate.files) {
        throw codedError('K4-PACKAGER-ENTRY-SOURCE-CONTRACT-001', 'Packager ZIP contract is invalid');
      }
      const names = Object.keys(candidate.files);
      for (const name of names) validatePath(name);
      const reserved = names.filter((name) => name.startsWith(entryPrefix)).sort();
      const expected = entries.map((entry) => entry.name);
      if (
        reserved.length !== expected.length ||
        reserved.some((name, index) => name !== expected[index])
      ) {
        throw codedError('K4-ASSET-ENTRY-MANIFEST-001', 'Packager ZIP entries do not match metadata');
      }
      archive = candidate;
    },
    claim() {
      if (claimed || released) {
        throw codedError('K4-PACKAGER-ENTRY-SOURCE-CLAIM-001', 'Packager entry source was already claimed');
      }
      if (configuration.mode === 'archive' && !archive) {
        throw codedError('K4-PACKAGER-ENTRY-SOURCE-NOT-READY-001', 'Packager ZIP is not attached');
      }
      claimed = true;
      if (globalThis[key] === registry) delete globalThis[key];
      return source;
    },
    release() {
      source.release();
      if (globalThis[key] === registry) delete globalThis[key];
    },
  });
  if (globalThis[key] !== undefined) {
    throw codedError('K4-PACKAGER-ENTRY-SOURCE-COLLISION-001', 'Packager entry source is already registered');
  }
  Object.defineProperty(globalThis, key, {
    value: registry,
    configurable: true,
  });
})();`;
}

function patchPackagerHtml(htmlBytes: Uint8Array) {
  const decoder = new TextDecoder('utf-8', {fatal: true});
  const html = decoder.decode(htmlBytes);
  const first = html.indexOf(packagerZipLoadTemplate);
  const last = html.lastIndexOf(packagerZipLoadTemplate);
  if (first < 0 || first !== last) {
    fail(
      'K4-PACKAGER-TEMPLATE-001',
      'Pinned Packager ZIP expansion template was not found exactly once',
    );
  }
  const replacement = packagerZipLoadTemplate.replace(
    "\n          const file = findFileInZip('project.json');",
    `\n          ${packagerEntrySourceAttach}\n          const file = findFileInZip('project.json');`,
  );
  const patched = `${html.slice(0, first)}${replacement}${html.slice(first + packagerZipLoadTemplate.length)}`;
  const attachIndex = patched.indexOf(packagerEntrySourceAttach);
  const loadProjectIndex = patched.lastIndexOf('await scaffolding.loadProject(projectData);');
  if (attachIndex < 0 || loadProjectIndex < 0 || attachIndex >= loadProjectIndex) {
    fail(
      'K4-PACKAGER-TEMPLATE-001',
      'Packager entry source is not registered before scaffolding.loadProject()',
    );
  }
  return new TextEncoder().encode(patched);
}

function adaptPackagerResult(
  result: Readonly<Record<string, any>>,
  surface: Readonly<{id: string; mode: string}>,
) {
  if (!isRecord(result) || !(result.data instanceof Uint8Array)) {
    fail('K4-PACKAGER-RESULT-001', 'Packager returned an invalid result');
  }
  if (surface.id === 'plain-html') {
    if (result.type !== 'text/html') {
      fail('K4-PACKAGER-RESULT-001', 'Plain HTML Packager result has an invalid content type');
    }
    return Object.freeze({...result, data: patchPackagerHtml(result.data)});
  }
  if (surface.id === 'zip-one-asset') {
    if (result.type !== 'application/zip') {
      fail('K4-PACKAGER-RESULT-001', 'zip-one-asset result has an invalid content type');
    }
    let archive;
    try {
      archive = unzipSync(result.data);
    } catch (error) {
      fail('K4-PACKAGER-RESULT-001', 'zip-one-asset result is not a ZIP archive', error);
    }
    if (!archive['index.html']) {
      fail('K4-PACKAGER-RESULT-001', 'zip-one-asset result is missing index.html');
    }
    archive['index.html'] = patchPackagerHtml(archive['index.html']);
    const ordered = Object.fromEntries(
      Object.entries(archive)
        .filter(([name]) => !name.endsWith('/'))
        .sort(([left], [right]) => left.localeCompare(right, 'en')),
    );
    return Object.freeze({
      ...result,
      data: zipSync(ordered, {level: 6, mtime: fixedZipTimestamp}),
    });
  }
  return Object.freeze({...result, data: new Uint8Array(result.data)});
}

/**
 * Package a binary-entry DSL 4.0 project through the pinned TurboWarp Packager adapter.
 * Only the documented `options.custom.js` option is configured. Plain HTML and zip-one-asset
 * results are then checked against the pinned generation template and patched at the explicit ZIP
 * expansion boundary; no runtime method or private Packager object is replaced.
 */
export async function packageDsl4WithTurboWarpPackager({
  packager,
  packagerPackage,
  storyDocument,
  descriptor,
  limits,
}: {
  packager: unknown;
  packagerPackage: unknown;
  storyDocument: Readonly<Record<string, unknown>>;
  descriptor: unknown;
  limits: {
    maxArchiveBytes: number;
    maxArchiveEntries: number;
    maxArchiveEntryBytes: number;
    maxArchiveExpandedBytes: number;
    maxAssetFiles: number;
    maxAssetFileBytes: number;
    maxAssetBytes: number;
    maxCompressionRatio: number;
    subtleCrypto?: {digest: Function} | undefined;
  };
}) {
  validatePackagerMetadata(packagerPackage);
  if (
    !isRecord(packager) ||
    typeof packager.package !== 'function' ||
    !isRecord(packager.options) ||
    !isRecord(packager.options.custom) ||
    !isRecord(packager.project)
  ) {
    throw new TypeError('packager must be a configured TurboWarp Packager instance');
  }
  if (packager.project.type !== 'sb3' || !(packager.project.arrayBuffer instanceof ArrayBuffer)) {
    fail('K4-PACKAGER-PROJECT-001', 'DSL 4.0 Packager adapter requires a normalized SB3 project');
  }
  if (typeof packager.options.target !== 'string') {
    throw new TypeError('packager.options.target must be a string');
  }
  if (typeof packager.options.custom.js !== 'string') {
    throw new TypeError('packager.options.custom.js must be a string');
  }
  if (packager.options.custom.js.includes(bootstrapMarker)) {
    fail('K4-PACKAGER-ADAPTER-REUSE-001', 'Packager entry source adapter is already installed');
  }
  const surface = resolveDsl4PackagerEntrySourceSurface(packager.options.target);
  const inspection = await inspectDsl4BinaryEntryArchive(
    new Uint8Array(packager.project.arrayBuffer),
    storyDocument,
    descriptor,
    limits,
  );
  if (inspection.descriptor.formatVersion !== dsl4BinaryEntryFormatVersion) {
    fail(
      'K4-PACKAGER-ENTRY-FORMAT-001',
      'DSL 4.0 Packager adapter requires root binary entry descriptor v3',
    );
  }
  const configuration = Object.freeze({
    contractVersion: dsl4PackagerEntrySourceContractVersion,
    surface: surface.id,
    mode: surface.mode,
    archive: inspection.archive,
    entries: inspection.entries,
  });
  const bootstrap = createBootstrapScript(configuration);
  packager.options.custom.js = packager.options.custom.js
    ? `${bootstrap}\n;${packager.options.custom.js}`
    : bootstrap;
  const result = await packager.package();
  return adaptPackagerResult(result, surface);
}

export const dsl4PackagerEntrySourceTemplateContract = Object.freeze({
  bootstrapMarker,
  packagerEntrySourceAttach,
  packagerZipLoadTemplate,
});
