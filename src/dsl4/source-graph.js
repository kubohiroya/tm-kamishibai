import {isMap, isScalar, isSeq, LineCounter, parseAllDocuments} from 'yaml';

import {canonicalizeDsl4Source} from './source-canonicalizer.js';
import {dsl4SourceFilenameSuffixes, hasDsl4SourceFilenameSuffix} from './source-filename.js';
import {deepFreeze, sourceRangeForNode} from './story-document.js';

const namedDeclarationNamespaces = Object.freeze([
  'assets',
  'actors',
  'textStyles',
  'bubbleStyles',
  'variables',
  'branches',
  'scenes',
]);
const singletonDeclarationNames = Object.freeze(['cover', 'loading', 'recognition', 'controls']);
const textDecoder = new TextDecoder('utf-8', {fatal: true});
const textEncoder = new TextEncoder();

export const dsl4SourceGraphDefaultLimits = deepFreeze({
  maxSourceFiles: 64,
  maxSourceBytes: 1024 * 1024,
  maxTotalSourceBytes: 4 * 1024 * 1024,
  maxIncludeDepth: 32,
});

export class Dsl4SourceGraphError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {object} [details]
   * @param {string} [details.sourceId]
   * @param {string} [details.sourcePath]
   * @param {import('./story-document.js').SourceRange} [details.range]
   * @param {readonly unknown[]} [details.related]
   * @param {readonly string[]} [details.cycle]
   * @param {unknown} [details.cause]
   */
  constructor(code, message, details = {}) {
    super(message, details.cause === undefined ? undefined : {cause: details.cause});
    this.name = 'Dsl4SourceGraphError';
    this.code = code;
    this.sourceId = details.sourceId ?? null;
    this.sourcePath = details.sourcePath ?? null;
    this.range = details.range ? deepFreeze(structuredClone(details.range)) : null;
    this.related = deepFreeze(structuredClone(details.related ?? []));
    this.cycle = deepFreeze([...(details.cycle ?? [])]);
  }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {string} code @param {string} message @param {ConstructorParameters<typeof Dsl4SourceGraphError>[2]} [details] @returns {never} */
function fail(code, message, details) {
  throw new Dsl4SourceGraphError(code, message, details);
}

/** @param {unknown} value @param {string} name */
function positiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return Number(value);
}

/** @param {unknown} input */
function resolveLimits(input) {
  if (input !== undefined && !isRecord(input)) {
    throw new TypeError('DSL 4.0 Source Graph limits must be an object');
  }
  const limits = {
    ...dsl4SourceGraphDefaultLimits,
    .../** @type {Record<string, unknown>} */ (input),
  };
  const unknown = Object.keys(limits).filter(
    (key) => !Object.hasOwn(dsl4SourceGraphDefaultLimits, key),
  );
  if (unknown.length > 0) {
    throw new TypeError(`Unknown DSL 4.0 Source Graph limit: ${unknown.sort().join(', ')}`);
  }
  return deepFreeze({
    maxSourceFiles: positiveSafeInteger(limits.maxSourceFiles, 'maxSourceFiles'),
    maxSourceBytes: positiveSafeInteger(limits.maxSourceBytes, 'maxSourceBytes'),
    maxTotalSourceBytes: positiveSafeInteger(limits.maxTotalSourceBytes, 'maxTotalSourceBytes'),
    maxIncludeDepth: positiveSafeInteger(limits.maxIncludeDepth, 'maxIncludeDepth'),
  });
}

/** @param {unknown} value @param {string} name */
function pathText(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    fail('K4-SOURCE-PATH-001', `${name} must be a non-empty string without NUL`);
  }
  if (
    value.includes('\\') ||
    value.startsWith('/') ||
    /^[A-Za-z]:/u.test(value) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)
  ) {
    fail('K4-SOURCE-PATH-001', `${name} must be a local POSIX relative path`);
  }
  return value;
}

/**
 * @param {readonly string[]} baseSegments
 * @param {string} reference
 * @param {string} name
 */
function resolveSegments(baseSegments, reference, name) {
  const value = pathText(reference, name);
  const resolved = [...baseSegments];
  for (const segment of value.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (resolved.length === 0) {
        fail('K4-SOURCE-PATH-001', `${name} must not escape the project root`);
      }
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }
  if (resolved.length === 0) {
    fail('K4-SOURCE-PATH-001', `${name} must resolve to a project file`);
  }
  return resolved;
}

/** @param {string} sourcePath */
function sourceDirectorySegments(sourcePath) {
  const segments = resolveSegments([], sourcePath, 'sourcePath');
  segments.pop();
  return segments;
}

/** @param {string} sourcePath */
function requireSourceSuffix(sourcePath) {
  if (!hasDsl4SourceFilenameSuffix(sourcePath)) {
    fail(
      'K4-INCLUDE-PATH-001',
      `DSL source path must end with one of: ${dsl4SourceFilenameSuffixes.join(', ')}`,
      {sourceId: sourcePath, sourcePath},
    );
  }
  return sourcePath;
}

/**
 * Resolve an include target relative to the source which declares it.
 *
 * @param {string} sourcePath
 * @param {string} includePath
 */
export function resolveDsl4IncludePath(sourcePath, includePath) {
  const source = requireSourceSuffix(resolveSegments([], sourcePath, 'sourcePath').join('/'));
  const resolved = resolveSegments(
    sourceDirectorySegments(source),
    includePath,
    'include path',
  ).join('/');
  return requireSourceSuffix(resolved);
}

/**
 * Resolve a local asset reference relative to the source which declares the asset.
 *
 * @param {string} sourcePath
 * @param {string} assetPath
 */
export function resolveDsl4SourceRelativeAssetPath(sourcePath, assetPath) {
  const source = requireSourceSuffix(resolveSegments([], sourcePath, 'sourcePath').join('/'));
  return resolveSegments(sourceDirectorySegments(source), assetPath, 'asset path').join('/');
}

/** @param {unknown} value @param {string} sourcePath @param {number} maxSourceBytes */
function decodeSource(value, sourcePath, maxSourceBytes) {
  const byteLength =
    typeof value === 'string'
      ? textEncoder.encode(value).length
      : value instanceof Uint8Array
        ? value.byteLength
        : fail('K4-INCLUDE-READ-001', 'Source loader must return a string or Uint8Array', {
            sourceId: sourcePath,
            sourcePath,
          });
  if (byteLength > maxSourceBytes) {
    fail(
      'K4-SOURCE-SIZE-001',
      `Included source is ${byteLength} bytes and exceeds the ${maxSourceBytes} byte limit`,
      {sourceId: sourcePath, sourcePath},
    );
  }
  let text;
  try {
    text =
      typeof value === 'string'
        ? value
        : value instanceof Uint8Array
          ? textDecoder.decode(value)
          : '';
  } catch (error) {
    if (error instanceof Dsl4SourceGraphError) throw error;
    fail('K4-SOURCE-UTF8-001', 'Included source is not valid UTF-8', {
      sourceId: sourcePath,
      sourcePath,
      cause: error,
    });
  }
  const canonicalSource = canonicalizeDsl4Source(text);
  return {canonicalSource, byteLength};
}

/**
 * @param {string} canonicalSource
 * @param {string} sourcePath
 */
function parseSourceDocument(canonicalSource, sourcePath) {
  const lineCounter = new LineCounter();
  const documents = parseAllDocuments(canonicalSource, {
    lineCounter,
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
    version: '1.2',
  });
  const document = documents[0];
  const yamlIssue = documents.flatMap((item) => [...item.errors, ...item.warnings])[0];
  if (yamlIssue || documents.length !== 1 || !document) {
    const range = yamlIssue?.pos
      ? sourceRangeForNode({range: yamlIssue.pos}, lineCounter)
      : sourceRangeForNode(document?.contents, lineCounter);
    fail(
      'K4-INCLUDE-YAML-001',
      yamlIssue?.message ?? 'Included source must contain exactly one YAML document',
      {sourceId: sourcePath, sourcePath, range},
    );
  }
  if (!isMap(document.contents)) {
    fail('K4-INCLUDE-SOURCE-001', 'Included source must be a top-level mapping', {
      sourceId: sourcePath,
      sourcePath,
      range: sourceRangeForNode(document.contents, lineCounter),
    });
  }
  return {document, lineCounter};
}

/**
 * Discover only include edges. Declaration indexing and asset path resolution intentionally run
 * after cycle validation.
 *
 * @param {string} canonicalSource
 * @param {string} sourcePath
 */
function inspectIncludes(canonicalSource, sourcePath) {
  const {document, lineCounter} = parseSourceDocument(canonicalSource, sourcePath);
  /** @type {{specifier: string, path: string, sourceId: string, range: import('./story-document.js').SourceRange}[]} */
  const includes = [];
  const includeNode = document.get('include', true);
  const includeItems =
    includeNode === undefined ? [] : isSeq(includeNode) ? includeNode.items : [includeNode];
  for (const node of includeItems) {
    if (!isScalar(node) || typeof node.value !== 'string' || node.value.length === 0) {
      fail('K4-INCLUDE-001', 'include must be a source path or a sequence of source paths', {
        sourceId: sourcePath,
        sourcePath,
        range: sourceRangeForNode(node ?? includeNode, lineCounter),
      });
    }
    let targetPath;
    try {
      targetPath = resolveDsl4IncludePath(sourcePath, node.value);
    } catch (error) {
      if (!(error instanceof Dsl4SourceGraphError)) throw error;
      fail(error.code, error.message, {
        sourceId: sourcePath,
        sourcePath,
        range: sourceRangeForNode(node, lineCounter),
        cause: error,
      });
    }
    includes.push({
      specifier: node.value,
      path: targetPath,
      sourceId: targetPath,
      range: sourceRangeForNode(node, lineCounter),
    });
  }
  return deepFreeze(includes);
}

/**
 * Index declarations and resolve asset paths only after the complete include graph is acyclic.
 *
 * @param {string} canonicalSource
 * @param {string} sourcePath
 */
function inspectDeclarations(canonicalSource, sourcePath) {
  const {document, lineCounter} = parseSourceDocument(canonicalSource, sourcePath);
  /** @type {{namespace: string, name: string, sourceId: string, sourcePath: string, range: import('./story-document.js').SourceRange}[]} */
  const declarations = [];
  for (const namespace of namedDeclarationNamespaces) {
    const namespaceNode = document.get(namespace, true);
    if (!isMap(namespaceNode)) continue;
    for (const pair of namespaceNode.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== 'string') continue;
      declarations.push({
        namespace,
        name: pair.key.value,
        sourceId: sourcePath,
        sourcePath,
        range: sourceRangeForNode(pair.key, lineCounter),
      });
    }
  }
  for (const name of singletonDeclarationNames) {
    const node = document.get(name, true);
    if (node === undefined) continue;
    declarations.push({
      namespace: '$singleton',
      name,
      sourceId: sourcePath,
      sourcePath,
      range: sourceRangeForNode(node, lineCounter),
    });
  }

  /** @type {{assetId: string, sourceId: string, sourcePath: string, reference: string, path: string, range: import('./story-document.js').SourceRange}[]} */
  const assetFiles = [];
  const assetsNode = document.get('assets', true);
  if (isMap(assetsNode)) {
    for (const pair of assetsNode.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== 'string' || !isMap(pair.value)) continue;
      const fileNode = pair.value.get('file', true);
      if (!isScalar(fileNode) || typeof fileNode.value !== 'string') continue;
      let resolvedPath;
      try {
        resolvedPath = resolveDsl4SourceRelativeAssetPath(sourcePath, fileNode.value);
      } catch (error) {
        if (!(error instanceof Dsl4SourceGraphError)) throw error;
        fail(error.code, error.message, {
          sourceId: sourcePath,
          sourcePath,
          range: sourceRangeForNode(fileNode, lineCounter),
          cause: error,
        });
      }
      assetFiles.push({
        assetId: pair.key.value,
        sourceId: sourcePath,
        sourcePath,
        reference: fileNode.value,
        path: resolvedPath,
        range: sourceRangeForNode(fileNode, lineCounter),
      });
    }
  }

  return deepFreeze({declarations, assetFiles});
}

/**
 * Discover and validate one immutable DSL 4.0 Source Graph without loading assets or performing
 * schema, semantic, or runtime work.
 *
 * @param {string} entryPath
 * @param {object} [options]
 * @param {(sourcePath: string, maxSourceBytes: number) => Promise<string | Uint8Array> | string | Uint8Array} [options.readSource]
 * @param {Partial<typeof dsl4SourceGraphDefaultLimits>} [options.limits]
 */
export async function createDsl4SourceGraph(entryPath, {readSource, limits: inputLimits} = {}) {
  if (typeof readSource !== 'function') throw new TypeError('readSource must be a function');
  const limits = resolveLimits(inputLimits);
  const entry = requireSourceSuffix(resolveSegments([], entryPath, 'entryPath').join('/'));
  /** @type {Map<string, Record<string, any>>} */
  const discovered = new Map();
  const scheduled = new Set([entry]);
  const queue = [entry];
  let totalSourceBytes = 0;

  while (queue.length > 0) {
    const sourcePath = /** @type {string} */ (queue.shift());
    if (discovered.size >= limits.maxSourceFiles) {
      fail('K4-INCLUDE-LIMIT-001', `Source Graph exceeds the ${limits.maxSourceFiles} file limit`, {
        sourceId: sourcePath,
        sourcePath,
      });
    }
    let loaded;
    try {
      loaded = await readSource(sourcePath, limits.maxSourceBytes);
    } catch (error) {
      if (error instanceof Dsl4SourceGraphError) throw error;
      fail('K4-INCLUDE-READ-001', 'Included source could not be read', {
        sourceId: sourcePath,
        sourcePath,
        cause: error,
      });
    }
    const decoded = decodeSource(loaded, sourcePath, limits.maxSourceBytes);
    totalSourceBytes += decoded.byteLength;
    if (totalSourceBytes > limits.maxTotalSourceBytes) {
      fail(
        'K4-INCLUDE-LIMIT-001',
        `Source Graph exceeds the ${limits.maxTotalSourceBytes} total byte limit`,
        {sourceId: sourcePath, sourcePath},
      );
    }
    const includes = inspectIncludes(decoded.canonicalSource, sourcePath);
    const baseSegments = sourceDirectorySegments(sourcePath);
    discovered.set(
      sourcePath,
      deepFreeze({
        sourceId: sourcePath,
        sourcePath,
        baseDirectory: baseSegments.join('/'),
        canonicalSource: decoded.canonicalSource,
        byteLength: decoded.byteLength,
        includes,
      }),
    );
    for (const edge of includes) {
      if (scheduled.has(edge.path)) continue;
      scheduled.add(edge.path);
      queue.push(edge.path);
    }
  }

  /** @type {Map<string, 'visiting' | 'visited'>} */
  const visitState = new Map();
  /** @type {string[]} */
  const stack = [];
  /** @type {string[]} */
  const order = [];
  /** @param {string} sourcePath */
  function visit(sourcePath) {
    if (visitState.get(sourcePath) === 'visited') return;
    if (visitState.get(sourcePath) === 'visiting') {
      const cycleStart = stack.indexOf(sourcePath);
      const cycle = [...stack.slice(cycleStart), sourcePath];
      fail('K4-INCLUDE-CYCLE', `DSL include cycle: ${cycle.join(' -> ')}`, {
        sourceId: sourcePath,
        sourcePath,
        cycle,
      });
    }
    visitState.set(sourcePath, 'visiting');
    stack.push(sourcePath);
    const node = discovered.get(sourcePath);
    for (const edge of node?.includes ?? []) visit(edge.path);
    stack.pop();
    visitState.set(sourcePath, 'visited');
    order.push(sourcePath);
  }
  visit(entry);

  /** @type {Map<string, number>} */
  const longestDepth = new Map();
  /** @param {string} sourcePath */
  function depthFrom(sourcePath) {
    const known = longestDepth.get(sourcePath);
    if (known !== undefined) return known;
    const node = discovered.get(sourcePath);
    const depth = Math.max(
      0,
      ...(node?.includes ?? []).map(
        (/** @type {{path: string}} */ edge) => 1 + depthFrom(edge.path),
      ),
    );
    longestDepth.set(sourcePath, depth);
    return depth;
  }
  const includeDepth = depthFrom(entry);
  if (includeDepth > limits.maxIncludeDepth) {
    fail(
      'K4-INCLUDE-LIMIT-001',
      `Source Graph include depth ${includeDepth} exceeds the ${limits.maxIncludeDepth} limit`,
      {sourceId: entry, sourcePath: entry},
    );
  }

  for (const [sourcePath, node] of discovered) {
    const inspected = inspectDeclarations(node.canonicalSource, sourcePath);
    discovered.set(
      sourcePath,
      deepFreeze({
        ...node,
        declarations: inspected.declarations,
        assetFiles: inspected.assetFiles,
      }),
    );
  }

  /** @type {Map<string, Record<string, any>>} */
  const declarationIndex = new Map();
  for (const node of discovered.values()) {
    for (const declaration of node.declarations) {
      const key = `${declaration.namespace}\0${declaration.name}`;
      const previous = declarationIndex.get(key);
      if (previous) {
        const label =
          declaration.namespace === '$singleton'
            ? declaration.name
            : `${declaration.namespace}.${declaration.name}`;
        fail('K4-DECLARATION-DUPLICATE', `${label} is declared more than once`, {
          sourceId: declaration.sourceId,
          sourcePath: declaration.sourcePath,
          range: declaration.range,
          related: [previous],
        });
      }
      declarationIndex.set(key, declaration);
    }
  }

  const nodes = order.map((sourcePath) => discovered.get(sourcePath));
  return deepFreeze({
    formatVersion: 1,
    entryPath: entry,
    discoveryOrder: [...discovered.keys()],
    order,
    sourceCount: nodes.length,
    totalSourceBytes,
    includeDepth,
    nodes,
    declarations: [...declarationIndex.values()],
    assetFiles: nodes.flatMap((node) => node?.assetFiles ?? []),
    limits,
  });
}
