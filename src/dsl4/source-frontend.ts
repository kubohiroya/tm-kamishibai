import Ajv2020 from 'ajv/dist/2020.js';
import {isAlias, isMap, isPair, isScalar, isSeq, LineCounter, parseAllDocuments, visit} from 'yaml';

import {
  dsl4EmptyActionRegistrySnapshot,
  validateDsl4ActionRegistrySnapshot,
} from './action-registry.js';
import {validateDsl4Semantics} from './semantic-validator.js';
import {canonicalizeDsl4Source} from './source-canonicalizer.js';
import {normalizeDsl4DiagnosticSequence} from './diagnostic-sequence-policy.js';
import {createStoryDocument, deepFreeze, sourceRangeForNode} from './story-document.js';
import {encodeDsl4StoryPathSegment} from './story-path.js';

export {canonicalizeDsl4Source} from './source-canonicalizer.js';

const forbiddenMappingKeys = new Set(['__proto__', 'constructor', 'prototype']);
const textEncoder = new TextEncoder();

export const dsl4SourceFrontendDefaultLimits = Object.freeze({
  maxCanonicalSourceBytes: 1024 * 1024,
  maxYamlNodes: 20_000,
  maxYamlDepth: 64,
  maxScalarScalars: 16_384,
  maxScenes: 512,
  maxActionsPerScene: 1_024,
  maxTotalActions: 4_096,
  maxAssets: 1_024,
  maxDiagnostics: 100,
  maxRelatedLocations: 8,
});

export interface Dsl4Diagnostic {
  version: 1;
  code: string;
  severity: 'error' | 'warning';
  message: string;
  sourceId: string;
  range: import('./story-document.js').SourceRange;
  storyPath?: string;
  path: string;
  related: readonly unknown[];
}

export interface ParseSuccess {
  ok: true;
  canonicalSource: string;
  diagnostics: readonly Dsl4Diagnostic[];
  storyDocument: Readonly<Record<string, unknown>>;
}

export interface ParseFailure {
  ok: false;
  canonicalSource: string;
  diagnostics: readonly Dsl4Diagnostic[];
}

export type ParseResult = ParseSuccess | ParseFailure;

function jsonPointerSegments(pointer: string): (string | number)[] {
  if (!pointer) return [];
  return pointer
    .slice(1)
    .split('/')
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
    .map((segment) => (/^(?:0|[1-9][0-9]*)$/.test(segment) ? Number(segment) : segment));
}

function jsonPathSegments(path: string): (string | number)[] {
  const segments: (string | number)[] = [];
  for (const match of path.matchAll(/([^[.\]]+)|\[([0-9]+)\]|\["((?:[^"\\]|\\.)*)"\]/g)) {
    const value = match[1] ?? match[2] ?? JSON.parse(`"${match[3]}"`);
    if (value === '$') continue;
    segments.push(match[2] === undefined ? value : Number(value));
  }
  return segments;
}

function escapedJsonPath(segments: readonly (string | number)[]) {
  return segments.reduce(
    (path, segment) =>
      typeof segment === 'number'
        ? `${path}[${segment}]`
        : `${path}[${JSON.stringify(segment).replace(/\u007f/gu, '\\u007f')}]`,
    '$',
  );
}

function storyPathFromSourceSegments(segments: (string | number)[]): string | undefined {
  if (segments[0] !== 'scenes' || typeof segments[1] !== 'string') return undefined;
  const sceneId = segments[1];
  const actionOffset = segments[2] === 'actions' ? 3 : 2;
  const actionIndex = segments[actionOffset];
  if (typeof actionIndex !== 'number') {
    return `/scenes/${encodeDsl4StoryPathSegment(sceneId)}`;
  }
  const actionPath = `/scenes/${encodeDsl4StoryPathSegment(sceneId)}/actions/${actionIndex}`;
  const commandOffset = actionOffset + 1;
  const argumentSegments = segments.slice(commandOffset + 1);
  if (argumentSegments.length === 0) return actionPath;
  if (argumentSegments[0] === 'stableId') return `${actionPath}/stableId`;
  const normalizedArguments =
    argumentSegments[0] === 'arguments' ? argumentSegments.slice(1) : argumentSegments;
  return normalizedArguments.length === 0
    ? `${actionPath}/args`
    : `${actionPath}/args/${normalizedArguments
        .map((segment) =>
          typeof segment === 'string' ? encodeDsl4StoryPathSegment(segment) : String(segment),
        )
        .join('/')}`;
}

function nodeAtPath(document: any, segments: (string | number)[]): any {
  for (let length = segments.length; length >= 0; length -= 1) {
    const node = length === 0 ? document.contents : document.getIn(segments.slice(0, length), true);
    if (node) return node;
  }
  return document.contents;
}

function diagnostic({
  code,
  message,
  sourceId,
  path,
  node,
  lineCounter,
  storyPath,
}: {
  code: string;
  message: string;
  sourceId: string;
  path: string;
  node: any;
  lineCounter: import('yaml').LineCounter;
  storyPath?: string | undefined;
}): Dsl4Diagnostic {
  return {
    version: 1,
    code,
    severity: 'error',
    message,
    sourceId,
    range: sourceRangeForNode(node, lineCounter),
    ...(storyPath ? {storyPath} : {}),
    path,
    related: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveFrontendLimits(input: unknown) {
  if (!isRecord(input)) throw new TypeError('source frontend limits must be an object');
  const unknown = Object.keys(input).filter(
    (name) => !Object.hasOwn(dsl4SourceFrontendDefaultLimits, name),
  );
  if (unknown.length > 0) {
    throw new TypeError(`Unknown source frontend limits: ${unknown.sort().join(', ')}`);
  }
  return Object.freeze(
    Object.fromEntries(
      Object.entries(dsl4SourceFrontendDefaultLimits).map(([name, maximum]) => {
        const value = Object.hasOwn(input, name) ? input[name] : maximum;
        const minimum = name === 'maxRelatedLocations' ? 0 : 1;
        if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
          throw new TypeError(`${name} must be a safe integer between ${minimum} and ${maximum}`);
        }
        return [name, Number(value)];
      }),
    ),
  );
}

function finalizeDiagnostics(
  diagnostics: readonly Dsl4Diagnostic[],
  limits: Readonly<Record<string, number>>,
) {
  return normalizeDsl4DiagnosticSequence(diagnostics, {
    maxDiagnostics: limits.maxDiagnostics,
    maxRelatedLocations: limits.maxRelatedLocations,
  }).diagnostics;
}

function sortDiagnostics(diagnostics: readonly Dsl4Diagnostic[]): readonly Dsl4Diagnostic[] {
  const compareCodeUnits = (left: string, right: string) =>
    left < right ? -1 : left > right ? 1 : 0;
  return deepFreeze(
    [...diagnostics].sort(
      (left, right) =>
        left.range.start.offset - right.range.start.offset ||
        compareCodeUnits(left.code, right.code) ||
        compareCodeUnits(left.message, right.message),
    ),
  );
}

/** Count YAML collections and scalars without recursively traversing an attacker-controlled tree. */
function inspectYamlResources(root: any, limits: Readonly<Record<string, number>>) {
  const stack = [{node: root, collectionDepth: 0}];
  let nodeCount = 0;
  let firstNodeOverflow = null;
  let firstDepthOverflow = null;
  let firstScalarOverflow = null;

  while (stack.length > 0) {
    const next = stack.pop();
    if (!next) break;
    const {node, collectionDepth} = next;
    if (!node) continue;
    if (isPair(node)) {
      stack.push({node: node.value, collectionDepth});
      stack.push({node: node.key, collectionDepth});
      continue;
    }

    if (isMap(node) || isSeq(node)) {
      nodeCount += 1;
      if (nodeCount > limits.maxYamlNodes && !firstNodeOverflow) firstNodeOverflow = node;
      const nextDepth = collectionDepth + 1;
      if (nextDepth > limits.maxYamlDepth && !firstDepthOverflow) firstDepthOverflow = node;
      for (let index = node.items.length - 1; index >= 0; index -= 1) {
        stack.push({node: node.items[index], collectionDepth: nextDepth});
      }
      continue;
    }

    if (isScalar(node)) {
      nodeCount += 1;
      if (nodeCount > limits.maxYamlNodes && !firstNodeOverflow) firstNodeOverflow = node;
      if (
        typeof node.value === 'string' &&
        [...node.value].length > limits.maxScalarScalars &&
        !firstScalarOverflow
      ) {
        firstScalarOverflow = node;
      }
    }
  }

  return {nodeCount, firstNodeOverflow, firstDepthOverflow, firstScalarOverflow};
}

function validateStoryResourceLimits(
  story: Record<string, unknown>,
  document: any,
  lineCounter: import('yaml').LineCounter,
  sourceId: string,
  limits: Readonly<Record<string, number>>,
) {
  const diagnostics: Dsl4Diagnostic[] = [];
  const assets = isRecord(story.assets) ? story.assets : {};
  if (Object.keys(assets).length > limits.maxAssets) {
    diagnostics.push(
      diagnostic({
        code: 'K4-ASSET-LIMIT-001',
        message: `Story exceeds the ${limits.maxAssets} asset limit`,
        sourceId,
        path: '$.assets',
        node: document.getIn(['assets'], true),
        lineCounter,
      }),
    );
  }

  const scenes = isRecord(story.scenes) ? story.scenes : {};
  if (Object.keys(scenes).length > limits.maxScenes) {
    diagnostics.push(
      diagnostic({
        code: 'K4-SCENE-LIMIT-001',
        message: `Story exceeds the ${limits.maxScenes} scene limit`,
        sourceId,
        path: '$.scenes',
        node: document.getIn(['scenes'], true),
        lineCounter,
      }),
    );
  }

  let totalActions = 0;
  let totalOverflowNode = null;
  for (const [sceneId, scene] of Object.entries(scenes)) {
    const actions = Array.isArray(scene)
      ? scene
      : isRecord(scene) && Array.isArray(scene.actions)
        ? scene.actions
        : [];
    const actionsPath = Array.isArray(scene) ? ['scenes', sceneId] : ['scenes', sceneId, 'actions'];
    if (actions.length > limits.maxActionsPerScene) {
      diagnostics.push(
        diagnostic({
          code: 'K4-ACTION-LIMIT-SCENE-001',
          message: `Scene exceeds the ${limits.maxActionsPerScene} action limit`,
          sourceId,
          path: Array.isArray(scene)
            ? `$.scenes[${JSON.stringify(sceneId)}]`
            : `$.scenes[${JSON.stringify(sceneId)}].actions`,
          node: document.getIn(actionsPath, true),
          lineCounter,
          storyPath: `/scenes/${encodeDsl4StoryPathSegment(sceneId)}`,
        }),
      );
    }
    if (!totalOverflowNode && totalActions + actions.length > limits.maxTotalActions) {
      const overflowIndex = Math.max(0, limits.maxTotalActions - totalActions);
      totalOverflowNode = document.getIn([...actionsPath, overflowIndex], true);
    }
    totalActions += actions.length;
  }
  if (totalActions > limits.maxTotalActions) {
    diagnostics.push(
      diagnostic({
        code: 'K4-ACTION-LIMIT-TOTAL-001',
        message: `Story exceeds the ${limits.maxTotalActions} total action limit`,
        sourceId,
        path: '$.scenes',
        node: totalOverflowNode ?? document.getIn(['scenes'], true),
        lineCounter,
      }),
    );
  }
  return diagnostics;
}

function validateBranchExpressions(
  story: Record<string, unknown>,
  document: any,
  lineCounter: import('yaml').LineCounter,
  sourceId: string,
  createRuntimeExpressionComposition: (() => unknown) | null,
) {
  const branches = isRecord(story.branches) ? story.branches : {};
  const conditions = Object.entries(branches).flatMap(([branchId, value]) =>
    Array.isArray(value)
      ? value.flatMap((rule, index) =>
          isRecord(rule) && typeof rule.if === 'string'
            ? [{branchId, index, expression: rule.if}]
            : [],
        )
      : [],
  );
  if (conditions.length === 0) return [];
  if (typeof createRuntimeExpressionComposition !== 'function') return [];

  const diagnostics: Dsl4Diagnostic[] = [];
  let composition;
  try {
    composition = createRuntimeExpressionComposition();
    if (
      !isRecord(composition) ||
      typeof composition.validateConditionSyntax !== 'function' ||
      typeof composition.releaseAll !== 'function'
    ) {
      throw new TypeError(
        'Runtime Expression composition must provide validateConditionSyntax and releaseAll',
      );
    }
    for (const {branchId, index, expression} of conditions) {
      const result = composition.validateConditionSyntax(expression);
      if (isRecord(result) && result.ok === true) continue;
      const position =
        isRecord(result) && Number.isSafeInteger(result.position) ? result.position : 0;
      const unknownRuntimeKey =
        isRecord(result) && result.code === 'RUNTIME_EXPRESSION_UNKNOWN_RUNTIME_KEY';
      diagnostics.push(
        diagnostic({
          code: unknownRuntimeKey ? 'K4-EXPRESSION-RUNTIME-UNKNOWN' : 'K4-EXPRESSION-SYNTAX-001',
          message: unknownRuntimeKey
            ? `Condition uses an unknown runtime key at expression offset ${position}`
            : `Condition syntax is invalid at expression offset ${position}`,
          sourceId,
          path: `$.branches[${JSON.stringify(branchId)}][${index}].if`,
          node: document.getIn(['branches', branchId, index, 'if'], true),
          lineCounter,
          storyPath: `/branches/${encodeDsl4StoryPathSegment(branchId)}/${index}/if`,
        }),
      );
    }
  } catch {
    diagnostics.push(
      diagnostic({
        code: 'K4-EXPRESSION-INTERNAL-001',
        message: 'Expression validation failed internally',
        sourceId,
        path: '$.branches',
        node: document.getIn(['branches'], true),
        lineCounter,
      }),
    );
  } finally {
    try {
      if (isRecord(composition) && typeof composition.releaseAll === 'function') {
        composition.releaseAll();
      }
    } catch {
      diagnostics.push(
        diagnostic({
          code: 'K4-EXPRESSION-INTERNAL-001',
          message: 'Expression validation resources could not be released',
          sourceId,
          path: '$.branches',
          node: document.getIn(['branches'], true),
          lineCounter,
        }),
      );
    }
  }
  return diagnostics;
}

function schemaDiagnosticCode(error: any): string {
  if (error.instancePath === '/kamishibai' && error.keyword === 'const') {
    return 'K4-VERSION-001';
  }
  if (error.keyword === 'additionalProperties') return 'K4-SCHEMA-UNKNOWN-KEY';
  if (error.schemaPath.endsWith('/keyCode/pattern')) return 'K4-KEY-UNSUPPORTED';
  if (error.keyword === 'propertyNames') return 'K4-ID-INVALID';
  return 'K4-SCHEMA-001';
}

function schemaErrorSegments(error: any): (string | number)[] {
  const segments = jsonPointerSegments(error.instancePath);
  const extraProperty = error.params?.additionalProperty ?? error.params?.propertyName;
  return extraProperty === undefined ? segments : [...segments, extraProperty];
}

function parseRestrictedYaml(
  source: string,
  sourceId: string,
  limits: Readonly<Record<string, number>>,
): {
  document: any;
  lineCounter: import('yaml').LineCounter;
  diagnostics: readonly Dsl4Diagnostic[];
} {
  const lineCounter = new LineCounter();
  const documents = parseAllDocuments(source, {
    lineCounter,
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
    version: '1.2',
  });
  const diagnostics: Dsl4Diagnostic[] = [];

  for (const document of documents) {
    for (const error of [...document.errors, ...document.warnings]) {
      const node = {range: error.pos ?? [0, 0]};
      diagnostics.push(
        diagnostic({
          code: 'K4-YAML-001',
          message: error.message,
          sourceId,
          path: '$',
          node,
          lineCounter,
        }),
      );
    }
  }

  if (documents.length !== 1) {
    const secondDocument = documents[1];
    diagnostics.push(
      diagnostic({
        code: 'K4-YAML-002',
        message: 'Exactly one YAML document is required',
        sourceId,
        path: '$',
        node: secondDocument?.contents ?? documents[0]?.contents,
        lineCounter,
      }),
    );
  }

  for (const document of documents) {
    visit(document, (_key, node) => {
      const yamlNode = node as any;
      if (isAlias(node) || yamlNode?.anchor) {
        diagnostics.push(
          diagnostic({
            code: 'K4-YAML-003',
            message: 'YAML aliases and anchors are not supported',
            sourceId,
            path: '$',
            node,
            lineCounter,
          }),
        );
      }
      if (isPair(node) && yamlNode.key?.value === '<<') {
        diagnostics.push(
          diagnostic({
            code: 'K4-YAML-004',
            message: 'YAML merge keys are not supported',
            sourceId,
            path: '$',
            node,
            lineCounter,
          }),
        );
      }
      if (yamlNode?.tag) {
        diagnostics.push(
          diagnostic({
            code: 'K4-YAML-005',
            message: 'Custom YAML tags are not supported',
            sourceId,
            path: '$',
            node,
            lineCounter,
          }),
        );
      }
      if (isPair(node) && forbiddenMappingKeys.has(String(yamlNode.key?.value))) {
        diagnostics.push(
          diagnostic({
            code: 'K4-YAML-006',
            message: `Mapping key ${String(yamlNode.key?.value)} is not supported`,
            sourceId,
            path: '$',
            node,
            lineCounter,
          }),
        );
      }
    });
    const resources = inspectYamlResources(document.contents, limits);
    if (resources.firstNodeOverflow) {
      diagnostics.push(
        diagnostic({
          code: 'K4-YAML-LIMIT-NODES-001',
          message: `YAML exceeds the ${limits.maxYamlNodes} node limit`,
          sourceId,
          path: '$',
          node: resources.firstNodeOverflow,
          lineCounter,
        }),
      );
    }
    if (resources.firstDepthOverflow) {
      diagnostics.push(
        diagnostic({
          code: 'K4-YAML-LIMIT-DEPTH-001',
          message: `YAML exceeds the ${limits.maxYamlDepth} collection depth limit`,
          sourceId,
          path: '$',
          node: resources.firstDepthOverflow,
          lineCounter,
        }),
      );
    }
    if (resources.firstScalarOverflow) {
      diagnostics.push(
        diagnostic({
          code: 'K4-YAML-LIMIT-SCALAR-001',
          message: `YAML scalar exceeds the ${limits.maxScalarScalars} Unicode scalar limit`,
          sourceId,
          path: '$',
          node: resources.firstScalarOverflow,
          lineCounter,
        }),
      );
    }
  }

  return {document: documents[0], lineCounter, diagnostics: sortDiagnostics(diagnostics)};
}

/**
 * Compile a schema once and return the shared pure source frontend.
 *
 */
export function createDsl4SourceFrontend(
  schema: import('ajv').AnySchema,
  {
    actionRegistry = dsl4EmptyActionRegistrySnapshot,
    limits: limitOverrides = {},
    createRuntimeExpressionComposition = null,
  }: {
    actionRegistry?: unknown;
    limits?: Partial<typeof dsl4SourceFrontendDefaultLimits>;
    createRuntimeExpressionComposition?: (() => unknown) | null;
  } = {},
): {parse(source: string, options?: {sourceId?: string}): ParseResult} {
  const registry = validateDsl4ActionRegistrySnapshot(actionRegistry);
  const limits = resolveFrontendLimits(limitOverrides);
  if (
    createRuntimeExpressionComposition !== null &&
    typeof createRuntimeExpressionComposition !== 'function'
  ) {
    throw new TypeError('createRuntimeExpressionComposition must be a function or null');
  }
  const AjvConstructor = Ajv2020 as any;
  const validateSchema = new AjvConstructor({allErrors: true, strict: true}).compile(schema);
  return Object.freeze({
    parse(source, {sourceId = 'main'} = {}) {
      const canonicalSource = canonicalizeDsl4Source(source);
      if (textEncoder.encode(canonicalSource).byteLength > limits.maxCanonicalSourceBytes) {
        const lineCounter = new LineCounter();
        lineCounter.addNewLine(0);
        const diagnostics = finalizeDiagnostics(
          [
            diagnostic({
              code: 'K4-SOURCE-LIMIT-BYTES-001',
              message: `Canonical source exceeds the ${limits.maxCanonicalSourceBytes} byte limit`,
              sourceId,
              path: '$',
              node: {range: [0, 0]},
              lineCounter,
            }),
          ],
          limits,
        );
        return deepFreeze({ok: false, canonicalSource, diagnostics});
      }
      const parsed = parseRestrictedYaml(canonicalSource, sourceId, limits);
      if (parsed.diagnostics.length > 0 || !parsed.document) {
        return deepFreeze({
          ok: false,
          canonicalSource,
          diagnostics: finalizeDiagnostics(parsed.diagnostics, limits),
        });
      }

      const rawStory = parsed.document.toJS({maxAliasCount: 0});
      if (!validateSchema(rawStory)) {
        const diagnostics = ((validateSchema.errors ?? []) as any[]).map((error) => {
          const segments = schemaErrorSegments(error);
          const rawPath = error.instancePath || '$';
          return diagnostic({
            code: schemaDiagnosticCode(error),
            message: error.message ?? 'Schema validation failed',
            sourceId,
            path: /[\u0000-\u001f\u007f]/u.test(rawPath) ? escapedJsonPath(segments) : rawPath,
            node: nodeAtPath(parsed.document, segments),
            lineCounter: parsed.lineCounter,
            storyPath: storyPathFromSourceSegments(segments),
          });
        });
        return deepFreeze({
          ok: false,
          canonicalSource,
          diagnostics: finalizeDiagnostics(diagnostics, limits),
        });
      }

      const story = rawStory as Record<string, unknown>;
      const semanticDiagnostics = validateDsl4Semantics(story, {actionRegistry: registry}).map(
        (issue) => {
          const segments = jsonPathSegments(issue.path);
          return diagnostic({
            code: issue.code,
            message: issue.message,
            sourceId,
            path: issue.path,
            node: nodeAtPath(parsed.document, segments),
            lineCounter: parsed.lineCounter,
            storyPath: storyPathFromSourceSegments(segments),
          });
        },
      );
      const resourceDiagnostics = validateStoryResourceLimits(
        story,
        parsed.document,
        parsed.lineCounter,
        sourceId,
        limits,
      );
      const expressionDiagnostics = validateBranchExpressions(
        story,
        parsed.document,
        parsed.lineCounter,
        sourceId,
        createRuntimeExpressionComposition,
      );
      const finalDiagnostics = finalizeDiagnostics(
        [...semanticDiagnostics, ...resourceDiagnostics, ...expressionDiagnostics],
        limits,
      );
      if (finalDiagnostics.length > 0) {
        return deepFreeze({
          ok: false,
          canonicalSource,
          diagnostics: finalDiagnostics,
        });
      }

      return deepFreeze({
        ok: true,
        canonicalSource,
        diagnostics: [],
        storyDocument: createStoryDocument(story, parsed.document, parsed.lineCounter, sourceId),
      });
    },
  });
}
