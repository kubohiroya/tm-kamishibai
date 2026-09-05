import {
  isAlias,
  isMap,
  isPair,
  isScalar,
  LineCounter,
  parseAllDocuments,
  stringify,
  visit,
} from 'yaml';

import {resolveDsl4FeatureFlags} from './feature-flags.js';
import type {Dsl4Diagnostic, Dsl4SourceFrontend} from './source-frontend.js';
import {createStoryDocument, deepFreeze, sourceRangeForNode} from './story-document.js';

const namedDeclarationNamespaces = new Set([
  'assets',
  'actors',
  'textStyles',
  'bubbleStyles',
  'variables',
  'branches',
  'scenes',
]);
const singletonDeclarationNames = new Set(['cover', 'loading', 'recognition', 'controls']);
const allowedTopLevelKeys = new Set([
  'include',
  'kamishibai',
  ...namedDeclarationNamespaces,
  ...singletonDeclarationNames,
]);
const forbiddenMappingKeys = new Set(['__proto__', 'constructor', 'prototype']);
const textEncoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonPointerSegments(pointer: string) {
  if (!pointer || pointer === '$') return [];
  return pointer
    .slice(1)
    .split('/')
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
    .map((segment) => (/^(?:0|[1-9][0-9]*)$/u.test(segment) ? Number(segment) : segment));
}

function jsonPathSegments(path: string) {
  const segments: (string | number)[] = [];
  for (const match of path.matchAll(/([^[.\]]+)|\[([0-9]+)\]|\["((?:[^"\\]|\\.)*)"\]/gu)) {
    const value = match[1] ?? match[2] ?? JSON.parse(`"${match[3]}"`);
    if (value === '$') continue;
    segments.push(match[2] === undefined ? value : Number(value));
  }
  return segments;
}

function nodeAtPath(document: any, segments: readonly (string | number)[]) {
  for (let length = segments.length; length >= 0; length -= 1) {
    const node = length === 0 ? document.contents : document.getIn(segments.slice(0, length), true);
    if (node) return node;
  }
  return document.contents;
}

function diagnostic(
  code: string,
  message: string,
  sourceId: string,
  path: string,
  node: any,
  lineCounter: import('yaml').LineCounter,
): Dsl4Diagnostic {
  return {
    version: 1,
    code,
    severity: 'error',
    message,
    sourceId,
    range: sourceRangeForNode(node, lineCounter),
    path,
    related: [],
  };
}

function sortDiagnostics(diagnostics: readonly Dsl4Diagnostic[], sourceOrder: readonly string[]) {
  const order = new Map(sourceOrder.map((sourceId, index) => [sourceId, index]));
  return deepFreeze(
    [...diagnostics].sort(
      (left, right) =>
        (order.get(left.sourceId) ?? Number.MAX_SAFE_INTEGER) -
          (order.get(right.sourceId) ?? Number.MAX_SAFE_INTEGER) ||
        left.range.start.offset - right.range.start.offset ||
        (left.code < right.code ? -1 : left.code > right.code ? 1 : 0),
    ),
  );
}

function validateSourceGraph(input: unknown) {
  if (
    !isRecord(input) ||
    input.formatVersion !== 1 ||
    typeof input.entryPath !== 'string' ||
    !Array.isArray(input.discoveryOrder) ||
    !Array.isArray(input.order) ||
    !Array.isArray(input.nodes) ||
    !Array.isArray(input.declarations) ||
    !Array.isArray(input.assetFiles)
  ) {
    throw new TypeError('A validated DSL 4.0 Source Graph is required');
  }
  const sourceCount = typeof input.sourceCount === 'number' ? input.sourceCount : Number.NaN;
  if (
    !Number.isSafeInteger(sourceCount) ||
    sourceCount < 1 ||
    input.nodes.length !== sourceCount ||
    input.discoveryOrder.length !== sourceCount ||
    input.order.length !== sourceCount
  ) {
    throw new TypeError('Source Graph topology counts must match');
  }
  if (input.discoveryOrder[0] !== input.entryPath) {
    throw new TypeError('Source Graph discovery order must start with the entry path');
  }
  const nodes = new Map();
  for (const value of input.nodes) {
    if (
      !isRecord(value) ||
      typeof value.sourcePath !== 'string' ||
      value.sourceId !== value.sourcePath ||
      typeof value.canonicalSource !== 'string' ||
      nodes.has(value.sourcePath)
    ) {
      throw new TypeError('Source Graph nodes must have unique paths and canonical source text');
    }
    nodes.set(value.sourcePath, value);
  }
  const topologyOrders = [
    {name: 'discovery order', values: input.discoveryOrder as unknown[]},
    {name: 'dependency order', values: input.order as unknown[]},
  ];
  for (const {name, values} of topologyOrders) {
    if (
      new Set(values).size !== nodes.size ||
      values.some((sourcePath) => typeof sourcePath !== 'string' || !nodes.has(sourcePath))
    ) {
      throw new TypeError(`Source Graph ${name} must reference every source node exactly once`);
    }
  }
  return {
    graph: input as Record<string, any>,
    nodes,
    discoveryOrder: input.discoveryOrder as string[],
  };
}

/**
 * Reparse one graph node for composition. Source Graph discovery has already bounded bytes and
 * rejected YAML syntax errors; this pass enforces the DSL restricted-YAML policy per source.
 */
function parseGraphNode(node: Record<string, any>) {
  const sourceId = node.sourcePath;
  const lineCounter = new LineCounter();
  const documents = parseAllDocuments(node.canonicalSource, {
    lineCounter,
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
    version: '1.2',
  });
  const document = documents[0];
  const diagnostics: Dsl4Diagnostic[] = [];
  if (documents.length !== 1 || !document || !isMap(document.contents)) {
    diagnostics.push(
      diagnostic(
        'K4-INCLUDE-SOURCE-001',
        'Included source must contain one top-level mapping',
        sourceId,
        '$',
        document?.contents,
        lineCounter,
      ),
    );
    return {ok: false, diagnostics, document, lineCounter, raw: null};
  }

  visit(document, (_key, value) => {
    const yamlNode = value as any;
    if (isAlias(value) || yamlNode?.anchor) {
      diagnostics.push(
        diagnostic(
          'K4-YAML-003',
          'YAML aliases and anchors are not supported',
          sourceId,
          '$',
          value,
          lineCounter,
        ),
      );
    }
    if (isPair(value) && yamlNode.key?.value === '<<') {
      diagnostics.push(
        diagnostic(
          'K4-YAML-004',
          'YAML merge keys are not supported',
          sourceId,
          '$',
          value,
          lineCounter,
        ),
      );
    }
    if (yamlNode?.tag) {
      diagnostics.push(
        diagnostic(
          'K4-YAML-005',
          'Custom YAML tags are not supported',
          sourceId,
          '$',
          value,
          lineCounter,
        ),
      );
    }
    if (isPair(value) && forbiddenMappingKeys.has(String(yamlNode.key?.value))) {
      diagnostics.push(
        diagnostic(
          'K4-YAML-006',
          `Mapping key ${String(yamlNode.key?.value)} is not supported`,
          sourceId,
          '$',
          value,
          lineCounter,
        ),
      );
    }
  });

  for (const pair of document.contents.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== 'string') {
      diagnostics.push(
        diagnostic(
          'K4-YAML-001',
          'Top-level mapping keys must be strings',
          sourceId,
          '$',
          pair.key,
          lineCounter,
        ),
      );
      continue;
    }
    if (!allowedTopLevelKeys.has(pair.key.value)) {
      diagnostics.push(
        diagnostic(
          'K4-SCHEMA-UNKNOWN-KEY',
          `Unknown top-level key ${pair.key.value}`,
          sourceId,
          '$',
          pair.key,
          lineCounter,
        ),
      );
    }
  }
  if (diagnostics.length > 0) {
    return {ok: false, diagnostics, document, lineCounter, raw: null};
  }
  return {
    ok: true,
    diagnostics,
    document,
    lineCounter,
    raw: document.toJS({maxAliasCount: 0}) as Record<string, unknown>,
  };
}

function composeRawStory(
  graph: Record<string, any>,
  parsedNodes: Map<string, Record<string, any>>,
) {
  const composed: Record<string, unknown> = {};
  const diagnostics: Dsl4Diagnostic[] = [];
  const assetPaths = new Map<string, Record<string, any>>(
    graph.assetFiles.map((asset: Record<string, any>) => [
      `${asset.sourcePath}\0${asset.assetId}`,
      asset,
    ]),
  );

  for (const sourcePath of graph.discoveryOrder) {
    const parsed = parsedNodes.get(sourcePath);
    const raw = (parsed?.raw ?? {}) as Record<string, unknown>;
    for (const [name, value] of Object.entries(raw)) {
      if (name === 'include') continue;
      if (name === 'kamishibai') {
        if (sourcePath !== graph.entryPath) {
          diagnostics.push(
            diagnostic(
              'K4-INCLUDE-ROOT-ONLY',
              'kamishibai may only be declared by the entry source',
              sourcePath,
              '$.kamishibai',
              parsed?.document.getIn(['kamishibai'], true),
              parsed?.lineCounter,
            ),
          );
        } else {
          composed.kamishibai = structuredClone(value);
        }
        continue;
      }
      if (namedDeclarationNamespaces.has(name)) {
        if (!isRecord(value)) {
          diagnostics.push(
            diagnostic(
              'K4-INCLUDE-COMPOSITION-001',
              `${name} must be a mapping in every source fragment`,
              sourcePath,
              `$.${name}`,
              parsed?.document.getIn([name], true),
              parsed?.lineCounter,
            ),
          );
          continue;
        }
        const target = (composed[name] ?? {}) as Record<string, unknown>;
        composed[name] = target;
        for (const [id, declaration] of Object.entries(value)) {
          const cloned = structuredClone(declaration) as Record<string, unknown>;
          if (name === 'assets' && isRecord(cloned) && typeof cloned.file === 'string') {
            const resolved = assetPaths.get(`${sourcePath}\0${id}`);
            if (resolved) cloned.file = resolved.path;
          }
          target[id] = cloned;
        }
        continue;
      }
      if (singletonDeclarationNames.has(name)) {
        composed[name] = structuredClone(value);
      }
    }
  }
  return {composed, diagnostics};
}

function projectStoryOrigins(
  graph: Record<string, any>,
  parsedNodes: Map<string, Record<string, any>>,
  storyDocument: Readonly<Record<string, any>>,
  artifactSourceId: string,
) {
  const knownOrigins: Record<string, {sourceId: string; range: unknown}> = {};
  for (const sourcePath of graph.discoveryOrder) {
    const parsed = parsedNodes.get(sourcePath);
    const raw = (parsed?.raw ?? {}) as Record<string, unknown>;
    const partialStory = {
      ...raw,
      scenes: isRecord(raw.scenes) ? raw.scenes : {},
    } as Record<string, unknown>;
    delete partialStory.include;
    const partial = createStoryDocument(
      partialStory,
      parsed?.document,
      parsed?.lineCounter,
      sourcePath,
    );
    for (const [storyPath, range] of Object.entries(partial.sourceMap as Record<string, unknown>)) {
      if (storyPath === '/' && sourcePath !== graph.entryPath) continue;
      knownOrigins[storyPath] = {sourceId: sourcePath, range};
    }
  }

  const rootOrigin = knownOrigins['/'];
  const sourceMap: Record<string, unknown> = {};
  const sourceOrigins: Record<string, unknown> = {};
  for (const [storyPath, generatedRange] of Object.entries(
    storyDocument.sourceMap as Record<string, unknown>,
  )) {
    const origin = knownOrigins[storyPath] ?? rootOrigin;
    sourceMap[storyPath] = origin?.range ?? generatedRange;
    sourceOrigins[storyPath] = {
      sourceId: origin?.sourceId ?? graph.entryPath,
      range: origin?.range ?? generatedRange,
    };
  }

  const scenes = (storyDocument.scenes as Readonly<Record<string, any>>[]).map((scene) => ({
    ...scene,
    actions: scene.actions.map((action: Record<string, any>) => ({
      ...action,
      sourceRange: sourceMap[action.id] ?? action.sourceRange,
    })),
  }));
  return deepFreeze({
    ...storyDocument,
    metadata: {...storyDocument.metadata, sourceId: artifactSourceId},
    scenes,
    sourceMap,
    sourceOrigins,
  });
}

function projectDiagnostics(
  graph: Record<string, any>,
  parsedNodes: Map<string, Record<string, any>>,
  input: Readonly<Record<string, any>>,
) {
  const declarationOrigins = new Map<string, Record<string, any>>(
    graph.declarations.map((declaration: Record<string, any>) => [
      `${declaration.namespace}\0${declaration.name}`,
      declaration,
    ]),
  );
  return input.diagnostics.map((value: Record<string, any>) => {
    const segments = value.path?.startsWith('/')
      ? jsonPointerSegments(value.path)
      : jsonPathSegments(value.path ?? '$');
    const section = segments[0];
    const name = segments[1];
    const declaration =
      typeof section === 'string' &&
      namedDeclarationNamespaces.has(section) &&
      typeof name === 'string'
        ? declarationOrigins.get(`${section}\0${name}`)
        : typeof section === 'string' && singletonDeclarationNames.has(section)
          ? declarationOrigins.get(`$singleton\0${section}`)
          : null;
    const sourceId = declaration?.sourceId ?? graph.entryPath;
    const parsed = parsedNodes.get(sourceId);
    const node = parsed?.document ? nodeAtPath(parsed.document, segments) : null;
    return {
      ...value,
      sourceId,
      range:
        parsed?.lineCounter && node
          ? sourceRangeForNode(node, parsed.lineCounter)
          : (declaration?.range ?? value.range),
    };
  });
}

/** Add graph composition in front of the existing canonical single-source frontend. */
export function createDsl4SourceGraphFrontend(sourceFrontend: Dsl4SourceFrontend) {
  if (!sourceFrontend || typeof sourceFrontend.parse !== 'function') {
    throw new TypeError('sourceFrontend must provide parse');
  }
  return Object.freeze({
    parse(
      inputGraph: unknown,
      {
        featureFlags: inputFeatureFlags = {},
        sourceId,
        maxComposedSourceBytes,
      }: {featureFlags?: unknown; sourceId?: string; maxComposedSourceBytes?: number} = {},
    ) {
      const featureFlags = resolveDsl4FeatureFlags(inputFeatureFlags);
      if (!featureFlags.dsl4SourceIncludes) {
        throw new TypeError('Source Graph frontend requires dsl4SourceIncludes');
      }
      if (!Number.isSafeInteger(maxComposedSourceBytes) || Number(maxComposedSourceBytes) < 1) {
        throw new TypeError('maxComposedSourceBytes must be a positive safe integer');
      }
      const {graph, nodes, discoveryOrder} = validateSourceGraph(inputGraph);
      const artifactSourceId = sourceId ?? graph.entryPath;
      if (
        typeof artifactSourceId !== 'string' ||
        artifactSourceId.length === 0 ||
        artifactSourceId.includes('\0')
      ) {
        throw new TypeError('sourceId must be a non-empty string without NUL');
      }
      const parsedNodes: Map<string, Record<string, any>> = new Map();
      const sourceDiagnostics: Dsl4Diagnostic[] = [];
      for (const sourcePath of discoveryOrder) {
        const parsed = parseGraphNode(nodes.get(sourcePath) as Record<string, any>);
        parsedNodes.set(sourcePath, parsed);
        sourceDiagnostics.push(...parsed.diagnostics);
      }
      if (sourceDiagnostics.length > 0) {
        return deepFreeze({
          ok: false,
          canonicalSource: '',
          diagnostics: sortDiagnostics(sourceDiagnostics, discoveryOrder),
        });
      }

      const composed = composeRawStory(graph, parsedNodes);
      if (composed.diagnostics.length > 0) {
        return deepFreeze({
          ok: false,
          canonicalSource: '',
          diagnostics: sortDiagnostics(composed.diagnostics, discoveryOrder),
        });
      }
      const effectiveSource = stringify(composed.composed, {lineWidth: 0});
      const composedSourceBytes = textEncoder.encode(effectiveSource).byteLength;
      if (composedSourceBytes > Number(maxComposedSourceBytes)) {
        const entry = parsedNodes.get(graph.entryPath) as Record<string, any>;
        return deepFreeze({
          ok: false,
          canonicalSource: effectiveSource,
          diagnostics: [
            diagnostic(
              'K4-SOURCE-LIMIT-BYTES-001',
              `Composed canonical source is ${composedSourceBytes} bytes and exceeds the ${maxComposedSourceBytes} byte limit`,
              graph.entryPath,
              '$',
              entry.document.contents,
              entry.lineCounter,
            ),
          ],
        });
      }
      const parsed = sourceFrontend.parse(effectiveSource, {sourceId: artifactSourceId});
      if (!parsed.ok) {
        return deepFreeze({
          ...parsed,
          diagnostics: sortDiagnostics(
            projectDiagnostics(graph, parsedNodes, parsed),
            discoveryOrder,
          ),
        });
      }
      return deepFreeze({
        ...parsed,
        storyDocument: projectStoryOrigins(
          graph,
          parsedNodes,
          parsed.storyDocument,
          artifactSourceId,
        ),
      });
    },
  });
}
