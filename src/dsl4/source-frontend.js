import Ajv2020 from 'ajv/dist/2020.js';
import {isAlias, isPair, LineCounter, parseAllDocuments, visit} from 'yaml';

import {
  dsl4EmptyActionRegistrySnapshot,
  validateDsl4ActionRegistrySnapshot,
} from './action-registry.js';
import {validateDsl4Semantics} from './semantic-validator.js';
import {canonicalizeDsl4Source} from './source-canonicalizer.js';
import {createStoryDocument, deepFreeze, sourceRangeForNode} from './story-document.js';

export {canonicalizeDsl4Source} from './source-canonicalizer.js';

const forbiddenMappingKeys = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * @typedef {object} Dsl4Diagnostic
 * @property {1} version
 * @property {string} code
 * @property {'error' | 'warning'} severity
 * @property {string} message
 * @property {string} sourceId
 * @property {import('./story-document.js').SourceRange} range
 * @property {string} [storyPath]
 * @property {string} path
 * @property {readonly unknown[]} related
 *
 * @typedef {object} ParseSuccess
 * @property {true} ok
 * @property {string} canonicalSource
 * @property {readonly Dsl4Diagnostic[]} diagnostics
 * @property {Readonly<Record<string, unknown>>} storyDocument
 *
 * @typedef {object} ParseFailure
 * @property {false} ok
 * @property {string} canonicalSource
 * @property {readonly Dsl4Diagnostic[]} diagnostics
 *
 * @typedef {ParseSuccess | ParseFailure} ParseResult
 */

/**
 * @param {string} pointer
 * @returns {(string | number)[]}
 */
function jsonPointerSegments(pointer) {
  if (!pointer) return [];
  return pointer
    .slice(1)
    .split('/')
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
    .map((segment) => (/^(?:0|[1-9][0-9]*)$/.test(segment) ? Number(segment) : segment));
}

/**
 * @param {string} path
 * @returns {(string | number)[]}
 */
function jsonPathSegments(path) {
  /** @type {(string | number)[]} */
  const segments = [];
  for (const match of path.matchAll(/([^[.\]]+)|\[([0-9]+)\]|\["((?:[^"\\]|\\.)*)"\]/g)) {
    const value = match[1] ?? match[2] ?? JSON.parse(`"${match[3]}"`);
    if (value === '$') continue;
    segments.push(match[2] === undefined ? value : Number(value));
  }
  return segments;
}

/**
 * @param {(string | number)[]} segments
 * @returns {string | undefined}
 */
function storyPathFromSourceSegments(segments) {
  if (segments[0] !== 'scenes' || typeof segments[1] !== 'string') return undefined;
  const sceneId = segments[1];
  const actionOffset = segments[2] === 'actions' ? 3 : 2;
  const actionIndex = segments[actionOffset];
  if (typeof actionIndex !== 'number') return `/scenes/${sceneId}`;
  const actionPath = `/scenes/${sceneId}/actions/${actionIndex}`;
  const commandOffset = actionOffset + 1;
  const argumentSegments = segments.slice(commandOffset + 1);
  if (argumentSegments.length === 0) return actionPath;
  if (argumentSegments[0] === 'stableId') return `${actionPath}/stableId`;
  const normalizedArguments =
    argumentSegments[0] === 'arguments' ? argumentSegments.slice(1) : argumentSegments;
  return normalizedArguments.length === 0
    ? `${actionPath}/args`
    : `${actionPath}/args/${normalizedArguments.join('/')}`;
}

/**
 * @param {any} document
 * @param {(string | number)[]} segments
 * @returns {any}
 */
function nodeAtPath(document, segments) {
  for (let length = segments.length; length >= 0; length -= 1) {
    const node = length === 0 ? document.contents : document.getIn(segments.slice(0, length), true);
    if (node) return node;
  }
  return document.contents;
}

/**
 * @param {object} input
 * @param {string} input.code
 * @param {string} input.message
 * @param {string} input.sourceId
 * @param {string} input.path
 * @param {any} input.node
 * @param {import('yaml').LineCounter} input.lineCounter
 * @param {string | undefined} [input.storyPath]
 * @returns {Dsl4Diagnostic}
 */
function diagnostic({code, message, sourceId, path, node, lineCounter, storyPath}) {
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

/**
 * @param {readonly Dsl4Diagnostic[]} diagnostics
 * @returns {readonly Dsl4Diagnostic[]}
 */
function sortDiagnostics(diagnostics) {
  return deepFreeze(
    [...diagnostics].sort(
      (left, right) =>
        left.range.start.offset - right.range.start.offset ||
        left.code.localeCompare(right.code) ||
        left.message.localeCompare(right.message),
    ),
  );
}

/**
 * @param {any} error
 * @returns {string}
 */
function schemaDiagnosticCode(error) {
  if (error.instancePath === '/kamishibai' && error.keyword === 'const') {
    return 'K4-VERSION-001';
  }
  if (error.keyword === 'additionalProperties') return 'K4-SCHEMA-UNKNOWN-KEY';
  if (error.schemaPath.endsWith('/keyCode/pattern')) return 'K4-KEY-UNSUPPORTED';
  if (error.keyword === 'propertyNames') return 'K4-ID-INVALID';
  return 'K4-SCHEMA-001';
}

/**
 * @param {any} error
 * @returns {(string | number)[]}
 */
function schemaErrorSegments(error) {
  const segments = jsonPointerSegments(error.instancePath);
  const extraProperty = error.params?.additionalProperty ?? error.params?.propertyName;
  return extraProperty === undefined ? segments : [...segments, extraProperty];
}

/**
 * @param {string} source
 * @param {string} sourceId
 * @returns {{document: any, lineCounter: import('yaml').LineCounter, diagnostics: readonly Dsl4Diagnostic[]}}
 */
function parseRestrictedYaml(source, sourceId) {
  const lineCounter = new LineCounter();
  const documents = parseAllDocuments(source, {
    lineCounter,
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
    version: '1.2',
  });
  /** @type {Dsl4Diagnostic[]} */
  const diagnostics = [];

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
      const yamlNode = /** @type {any} */ (node);
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
  }

  return {document: documents[0], lineCounter, diagnostics: sortDiagnostics(diagnostics)};
}

/**
 * Compile a schema once and return the shared pure source frontend.
 *
 * @param {import('ajv').AnySchema} schema
 * @param {{actionRegistry?: unknown}} [options]
 * @returns {{parse(source: string, options?: {sourceId?: string}): ParseResult}}
 */
export function createDsl4SourceFrontend(
  schema,
  {actionRegistry = dsl4EmptyActionRegistrySnapshot} = {},
) {
  const registry = validateDsl4ActionRegistrySnapshot(actionRegistry);
  const AjvConstructor = /** @type {any} */ (Ajv2020);
  const validateSchema = new AjvConstructor({allErrors: true, strict: true}).compile(schema);
  return Object.freeze({
    parse(source, {sourceId = 'main'} = {}) {
      const canonicalSource = canonicalizeDsl4Source(source);
      const parsed = parseRestrictedYaml(canonicalSource, sourceId);
      if (parsed.diagnostics.length > 0 || !parsed.document) {
        return deepFreeze({ok: false, canonicalSource, diagnostics: parsed.diagnostics});
      }

      const rawStory = parsed.document.toJS({maxAliasCount: 0});
      if (!validateSchema(rawStory)) {
        const diagnostics = /** @type {any[]} */ (validateSchema.errors ?? []).map((error) => {
          const segments = schemaErrorSegments(error);
          return diagnostic({
            code: schemaDiagnosticCode(error),
            message: error.message ?? 'Schema validation failed',
            sourceId,
            path: error.instancePath || '$',
            node: nodeAtPath(parsed.document, segments),
            lineCounter: parsed.lineCounter,
            storyPath: storyPathFromSourceSegments(segments),
          });
        });
        return deepFreeze({
          ok: false,
          canonicalSource,
          diagnostics: sortDiagnostics(diagnostics),
        });
      }

      const story = /** @type {Record<string, unknown>} */ (rawStory);
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
      if (semanticDiagnostics.length > 0) {
        return deepFreeze({
          ok: false,
          canonicalSource,
          diagnostics: sortDiagnostics(semanticDiagnostics),
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
