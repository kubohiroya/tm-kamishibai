import {collectDsl4DefinitionReferences, definitionRecord} from './definition-references.js';
import type {Dsl4DefinitionPath, Dsl4DefinitionReference} from './definition-references.js';
import type {Dsl4Diagnostic} from './source-frontend.js';
import {deepFreeze} from './story-document.js';
import type {SourceRange} from './story-document.js';

export interface Dsl4DefinitionAuditSource {
  sourceId: string;
  story: Record<string, unknown>;
}
export interface Dsl4AuditedReference extends Dsl4DefinitionReference {
  sourceId: string;
  range: SourceRange;
}
export interface Dsl4AuditedDefinition {
  kind: string;
  namespace: string;
  name: string;
  sourceId: string;
  path: Dsl4DefinitionPath;
  range: SourceRange;
  status: 'used' | 'unused' | 'protected';
  removable: boolean;
  reason: string;
  references: Dsl4AuditedReference[];
}

const kindByNamespace: Record<string, string> = {
  assets: 'asset',
  actors: 'actor',
  textStyles: 'textStyle',
  variables: 'variable',
  'controls.keymaps': 'control',
  cover: 'cover',
  loading: 'loading',
  recognition: 'recognition',
  scenes: 'navigation',
  $commands: 'navigation',
  branches: 'branch',
  bubbleStyles: 'bubbleStyle',
  bubbleClosePolicies: 'bubbleClosePolicy',
};
const deletable = new Set(['assets', 'actors', 'textStyles', 'variables']);
const named = [
  'assets',
  'actors',
  'textStyles',
  'variables',
  'scenes',
  'branches',
  'bubbleStyles',
  'bubbleClosePolicies',
];
const zeroRange: SourceRange = {
  start: {line: 1, column: 1, offset: 0},
  end: {line: 1, column: 1, offset: 0},
};
const keyFor = (namespace: string, name: string) => JSON.stringify([namespace, name]);

export function dsl4DefinitionJsonPath(path: readonly (string | number)[]) {
  return (
    '$' +
    path
      .map((part) => (typeof part === 'number' ? `[${part}]` : `[${JSON.stringify(part)}]`))
      .join('')
  );
}

/** Analyze author intent without executing code or treating scene reachability as proof of non-use. */
export function auditDsl4Definitions(
  sources: readonly Dsl4DefinitionAuditSource[],
  schema: unknown,
  options: {
    controlProfile?: string;
    protectedSources?: readonly string[];
    locate?: (sourceId: string, path: Dsl4DefinitionPath) => SourceRange;
  } = {},
) {
  const definitions = new Map<string, Dsl4AuditedDefinition>();
  const references: Dsl4AuditedReference[] = [];
  const diagnostics: Dsl4Diagnostic[] = [];
  const roots = new Set<string>();
  const protectedKeys = new Map<string, string>();
  const edges = new Map<string, Set<string>>();
  const locate = options.locate ?? (() => zeroRange);
  const commands = definitionRecord(
    definitionRecord(definitionRecord(schema).$defs).navigationCommand,
  ).enum;
  const builtinCommands = new Set(Array.isArray(commands) ? commands : []);
  function diagnostic(
    sourceId: string,
    path: Dsl4DefinitionPath,
    code: string,
    message: string,
    severity: 'error' | 'warning',
  ) {
    diagnostics.push({
      version: 1,
      code,
      severity,
      message,
      sourceId,
      range: locate(sourceId, path),
      path: dsl4DefinitionJsonPath(path),
      related: [],
    });
  }
  function define(sourceId: string, namespace: string, name: string, path: Dsl4DefinitionPath) {
    const key = keyFor(namespace, name);
    if (definitions.has(key)) {
      diagnostic(
        sourceId,
        path,
        'K4-DEFINITION-DUPLICATE',
        `定義が重複しています: ${namespace} ${JSON.stringify(name)}`,
        'error',
      );
      return;
    }
    definitions.set(key, {
      kind: kindByNamespace[namespace] ?? namespace,
      namespace,
      name,
      sourceId,
      path,
      range: locate(sourceId, path),
      status: 'unused',
      removable: false,
      reason: '',
      references: [],
    });
    if (!deletable.has(namespace)) roots.add(key);
    if (namespace === 'variables' && name === 'startSceneIndex') roots.add(key);
  }
  for (const {sourceId, story} of sources) {
    for (const namespace of named)
      for (const name of Object.keys(definitionRecord(story[namespace])))
        define(sourceId, namespace, name, [namespace, name]);
    for (const namespace of ['cover', 'loading', 'recognition'])
      if (Object.hasOwn(story, namespace)) define(sourceId, namespace, namespace, [namespace]);
    for (const name of Object.keys(definitionRecord(definitionRecord(story.controls).keymaps)))
      define(sourceId, 'controls.keymaps', name, ['controls', 'keymaps', name]);
  }
  for (const {sourceId, story} of sources) {
    const collected = collectDsl4DefinitionReferences(story, schema);
    references.push(
      ...collected.references.map((reference) => ({
        ...reference,
        sourceId,
        range: locate(sourceId, reference.path),
      })),
    );
    for (const issue of collected.uncertain) {
      diagnostic(sourceId, issue.path, 'K4-DEFINITION-UNCERTAIN', issue.reason, 'warning');
      for (const [key, definition] of definitions)
        if (issue.namespaces.includes(definition.namespace)) protectedKeys.set(key, issue.reason);
    }
  }
  // Editable disabled sections may refer to any declaration when re-enabled.
  if (options.protectedSources?.length) {
    for (const [key, definition] of definitions)
      if (deletable.has(definition.namespace))
        protectedKeys.set(key, '無効部分の復元情報があるため定義を保持します');
    for (const sourceId of options.protectedSources)
      diagnostic(
        sourceId,
        [],
        'K4-DEFINITION-SECTION-STATE',
        '無効部分の復元情報があります。定義の自動削除を保留します',
        'warning',
      );
  }
  for (const reference of references) {
    if (reference.namespace === '$commands') {
      if (!builtinCommands.has(reference.name))
        diagnostic(
          reference.sourceId,
          reference.path,
          'K4-DEFINITION-UNDEFINED',
          `未知のnavigationコマンドです: ${JSON.stringify(reference.name)}`,
          'error',
        );
      continue;
    }
    const key = keyFor(reference.namespace, reference.name);
    const definition = definitions.get(key);
    if (!definition) {
      if (reference.namespace === 'variables' && reference.name === 'startSceneIndex') continue;
      if (reference.namespace === 'textStyles' && reference.name === 'default') continue;
      diagnostic(
        reference.sourceId,
        reference.path,
        'K4-DEFINITION-UNDEFINED',
        `未定義の${kindByNamespace[reference.namespace] ?? reference.namespace}です: ${JSON.stringify(reference.name)}`,
        'error',
      );
      continue;
    }
    definition.references.push(reference);
    const ownerSection = reference.path[0];
    const ownerName = reference.path[1];
    const owner =
      typeof ownerSection === 'string' &&
      typeof ownerName === 'string' &&
      deletable.has(ownerSection)
        ? keyFor(ownerSection, ownerName)
        : null;
    if (owner && definitions.has(owner)) {
      if (!edges.has(owner)) edges.set(owner, new Set());
      edges.get(owner)!.add(key);
    } else roots.add(key);
  }
  if (options.controlProfile !== undefined) {
    const key = keyFor('controls.keymaps', options.controlProfile);
    if (!definitions.has(key))
      diagnostic(
        sources[0]?.sourceId ?? 'main',
        ['controls', 'keymaps'],
        'K4-DEFINITION-UNDEFINED',
        `未定義のcontrolです: ${JSON.stringify(options.controlProfile)}`,
        'error',
      );
  }
  for (const key of protectedKeys.keys()) roots.add(key);
  const reached = new Set<string>();
  const queue = [...roots];
  for (let index = 0; index < queue.length; index += 1) {
    const key = queue[index]!;
    if (reached.has(key)) continue;
    reached.add(key);
    for (const dependency of edges.get(key) ?? []) queue.push(dependency);
  }
  for (const [key, definition] of definitions) {
    const reason = protectedKeys.get(key);
    if (reason) {
      definition.status = 'protected';
      definition.reason = reason;
    } else if (definition.namespace === 'controls.keymaps') {
      definition.status = options.controlProfile === definition.name ? 'used' : 'protected';
      definition.reason = 'controlは再生環境から選択されるため保持します';
    } else if (reached.has(key)) {
      definition.status = 'used';
      definition.reason = deletable.has(definition.namespace)
        ? '作品から直接または間接に利用されています'
        : '宣言・場面・設定として利用されます';
    } else {
      definition.status = 'unused';
      definition.removable = deletable.has(definition.namespace);
      definition.reason = '全場面・設定からの利用がありません';
      diagnostic(
        definition.sourceId,
        definition.path,
        'K4-DEFINITION-UNUSED',
        `未使用の${definition.kind}です: ${JSON.stringify(definition.name)}`,
        'warning',
      );
    }
  }
  const values = [...definitions.values()];
  return deepFreeze({
    formatVersion: 1 as const,
    ok: !diagnostics.some((item) => item.severity === 'error'),
    definitions: values,
    references,
    diagnostics,
    removable: values.filter((item) => item.removable),
  });
}
