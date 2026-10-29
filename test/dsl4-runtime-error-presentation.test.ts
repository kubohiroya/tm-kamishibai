import assert from 'node:assert/strict';
import {test} from 'vitest';
import {dsl4TestSourceFrontend} from './helpers/dsl4-test-frontend.ts';
import {normalizeDsl4DiagnosticSequence} from '../src/dsl4/diagnostic-sequence-policy.js';
import {
  createDsl4DiagnosticUiProjection,
  redactDsl4DiagnosticTelemetry,
} from '../src/dsl4/diagnostic-projection.js';
import {
  createRuntimeErrorPresentation,
  formatRuntimeErrorReport,
} from '../src/dsl4/platform/runtime-error-presentation.js';
import {
  runtimeErrorCauses,
  createRuntimeFailureContext,
} from '../src/dsl4/runtime-error-context.js';
import {createDsl4StructuredBlockSourceDeclaration} from '../src/dsl4/structured-block-source.js';
import {extractDsl4BlockSourcesFromProject} from '../src/dsl4/turbowarp-yaml-json-block-source.js';
import {createDsl4RuntimeBlockDiagnosticLocator} from '../src/dsl4/platform/runtime-block-diagnostic.js';
import type {Dsl4BlockErrorHost} from '../src/dsl4/platform/block-error-location.js';

test('Schema violations retain correction details through canonical normalization and UI projection', () => {
  const result = dsl4TestSourceFrontend.parse(
    "kamishibai: '4.0'\nscenes: {}\nunknownField: true\n",
    {sourceId: 'story.kamishibai.yaml'},
  );
  assert.equal(result.ok, false);
  const diagnostic = result.diagnostics.find(
    (item) => item.validation?.keyword === 'additionalProperties',
  );
  assert.ok(diagnostic);
  assert.equal(diagnostic.validation?.field, 'unknownField');
  const normalized = normalizeDsl4DiagnosticSequence([diagnostic], {
    maxDiagnostics: 10,
    maxRelatedLocations: 8,
  });
  const projected = createDsl4DiagnosticUiProjection(normalized.diagnostics, {
    canonicalSource: result.canonicalSource,
    displayName: 'story.kamishibai.yaml',
  }).diagnostics[0]!;
  assert.equal(projected.validation?.field, 'unknownField');
  assert.match(
    createRuntimeErrorPresentation(projected, 'ja').explanation,
    /unknownField.*使えません/u,
  );
  assert.equal(
    Object.hasOwn(
      redactDsl4DiagnosticTelemetry(diagnostic as unknown as Record<string, unknown>),
      'validation',
    ),
    false,
  );
  assert.throws(
    () =>
      normalizeDsl4DiagnosticSequence(
        [{...diagnostic, validation: {keyword: 'type', actualValue: 'secret'}}],
        {maxDiagnostics: 10, maxRelatedLocations: 8},
      ),
    /unknown/u,
  );
});

test('required and type violations explain the correction without translating English messages', () => {
  for (const locale of ['ja', 'en'] as const) {
    const missing = createRuntimeErrorPresentation(
      {
        code: 'K4-SCHEMA-001',
        message: 'unrelated',
        validation: {keyword: 'required', field: 'seconds'},
      },
      locale,
    );
    assert.match(missing.explanation, /seconds/u);
    assert.match(missing.recovery, /seconds/u);
    const typed = createRuntimeErrorPresentation(
      {code: 'K4-SCHEMA-001', validation: {keyword: 'type', expected: 'number'}},
      locale,
    );
    assert.match(typed.explanation, locale === 'ja' ? /数値/u : /number/u);
  }
});

test('unknown failures stay uncertain and non-camera permission errors are not labelled camera failures', () => {
  const unknown = createRuntimeErrorPresentation({message: 'Failed to fetch'}, 'ja');
  assert.match(unknown.explanation, /特定できません/u);
  assert.doesNotMatch(unknown.explanation, /通信|台本.*不正/u);
  assert.doesNotMatch(
    createRuntimeErrorPresentation({name: 'NotAllowedError'}, 'ja').title,
    /カメラ/u,
  );
  const camera = createRuntimeErrorPresentation(
    {failureContext: {command: 'pose', causes: [{name: 'NotAllowedError'}]}},
    'ja',
  );
  assert.match(camera.title, /カメラ.*許可/u);
});

test('reports human-readable locations and preserves generated source identity', () => {
  const view = createRuntimeErrorPresentation(
    {
      storyPath: '/scenes/道~1帰り/actions/2',
      sourceId: 'Stage.kamishibai.yaml',
      range: {start: {line: 10, column: 3}},
      generatedSource: true,
      blockName: '背景を変える',
      targetName: '案内役',
      failureContext: {command: 'backdrop', assetId: '夕焼け'},
    },
    'ja',
  );
  for (const part of ['道/帰り', '3番目', '背景を変える', '夕焼け', '案内役', '生成台本', '10行'])
    assert(view.place.includes(part));
});

test('cause chains are bounded, redact credentials and paths, and never serialize unrelated values', () => {
  const inner = new Error(
    'load https://user:pass@example.com/assets/a.svg?token=private#fragment from /Users/alice/private.sb3 apiKey=secret',
  );
  const outer = Object.assign(new Error('operation failed', {cause: inner}), {
    code: 'K4-ASSET-PREPARE-001',
    project: 'whole-project-secret',
  });
  Object.defineProperty(inner, 'cause', {value: outer});
  const causes = runtimeErrorCauses(outer);
  assert.equal(causes.length, 2);
  const failureContext = createRuntimeFailureContext(
    outer,
    {id: 'opening'},
    {command: 'backdrop', args: {asset: '夕焼け', text: 'private-script'}},
    0,
  );
  const report = formatRuntimeErrorReport(
    {
      message: outer.message,
      code: outer.code,
      failureContext,
      absolutePath: '/Users/alice/private',
      sessionToken: 'secret-token',
    },
    'ja',
    'test-version',
  );
  for (const secret of [
    'user:pass',
    'token=private',
    'fragment',
    '/Users/alice',
    'apiKey=secret',
    'whole-project-secret',
    'private-script',
    'secret-token',
  ])
    assert(!report.includes(secret), secret);
  assert.match(report, /test-version/u);
  assert.match(report, /夕焼け/u);
  assert.match(report, /example.com\/assets\/a.svg/u);
});

test('runtime source ranges resolve to original blocks and reject replaced or switched projects', () => {
  const blocks = createDsl4StructuredBlockSourceDeclaration({
    source: {kamishibai: '4.0', scenes: {opening: [{wait: 0}]}},
    form: 'bundle',
    hatId: 'root',
  });
  const target = {
    id: 'stage',
    isStage: true,
    getName: () => 'Stage',
    blocks: {getBlock: (id: string) => blocks[id]},
  };
  const host: Dsl4BlockErrorHost = {vm: {runtime: {targets: [target]}}};
  const sources = extractDsl4BlockSourcesFromProject({
    targets: [{name: 'Stage', isStage: true, blocks}],
  });
  const parsed = dsl4TestSourceFrontend.parse(sources.sources[sources.entryPath]!, {
    sourceId: sources.entryPath,
  });
  assert(parsed.ok);
  const diagnostic = {
    code: 'K4-RUNTIME-ACTION-001',
    sourceId: sources.entryPath,
    range: (parsed.storyDocument.sourceMap as Record<string, unknown>)['/scenes/opening/actions/0'],
  };
  const locate = createDsl4RuntimeBlockDiagnosticLocator(sources, host);
  const result = locate(diagnostic);
  assert.equal(result.targetName, 'Stage');
  const blockId = String(result.blockId);
  assert(blocks[blockId] && blockId !== 'root');
  assert.equal(result.generatedSource, true);
  blocks[blockId] = {...blocks[blockId]!};
  assert.equal(locate(diagnostic).blockId, undefined);
  host.vm.runtime = {targets: []};
  assert.equal(locate(diagnostic).blockId, undefined);
});

test('union validation does not prescribe the type of a rejected alternative', () => {
  const parsed = dsl4TestSourceFrontend.parse(
    "kamishibai: '4.0'\nassets:\n  Broken: {kind: invalid-kind, name: Menu}\nscenes: {opening: [{wait: 0}]}\n",
  );
  const first = parsed.diagnostics[0]!;
  assert.equal(first.validation?.alternative, true);
  const view = createRuntimeErrorPresentation(first as unknown as Record<string, unknown>, 'ja');
  assert.doesNotMatch(view.explanation, /文字列を指定/u);
  assert.match(view.recovery, /候補形式/u);
});
