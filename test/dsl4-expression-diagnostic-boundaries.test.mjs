import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {
  buildDsl4RuntimeComponent,
  createDsl4PreviewSourceWatcher,
  createDsl4ProductionSourceFrontend,
  Dsl4BuildError,
  formatDsl4Diagnostic,
  serializeDsl4ValidationResult,
  validateDsl4SourceFile,
} from '../src/builder/index.js';
import {
  createDsl4DiagnosticUiProjection,
  createDsl4EmbeddedSourceDescriptor,
  createDsl4RuntimeController,
  dsl4DiagnosticProjectionDefaults,
  dsl4SourceFrontendDefaultLimits,
  formatDsl4DiagnosticClipboard,
  loadDsl4RuntimeArtifact,
  mapDsl4RuntimeExpressionError,
  redactDsl4DiagnosticTelemetry,
  renderDsl4DiagnosticFallbackSvg,
  serializeDsl4DiagnosticExport,
} from '../src/dsl4/index.js';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const schema = JSON.parse(
  await readFile(path.join(repositoryRoot, 'schema', 'dsl-4.schema.json'), 'utf8'),
);

function frontend(limits = {}, options = {}) {
  return createDsl4ProductionSourceFrontend(schema, {limits, ...options});
}

function canonicalDiagnostic(overrides = {}) {
  return {
    version: 1,
    code: 'K4-EXPRESSION-SYNTAX-001',
    severity: 'error',
    message: 'Expression is invalid',
    sourceId: 'main',
    range: {
      start: {line: 2, column: 3, offset: 12},
      end: {line: 2, column: 4, offset: 13},
    },
    storyPath: '/branches/choice/0/if',
    path: '$.branches["choice"][0].if',
    related: [],
    ...overrides,
  };
}

test('validates every branch expression before creating a stageable StoryDocument', () => {
  const calls = [];
  const sourceFrontend = frontend(
    {},
    {
      createRuntimeExpressionComposition() {
        calls.push('create');
        return {
          validateConditionSyntax(expression) {
            calls.push(['validate', expression]);
            return {ok: false, code: 'CONDITION_SYNTAX_ERROR', position: 6};
          },
          releaseAll() {
            calls.push('release');
          },
        };
      },
    },
  );
  const result = sourceFrontend.parse(`
kamishibai: '4.0'
branches:
  choice:
    - if: score = 1
      goto: ending
    - else: ending
scenes:
  opening:
    - branch: choice
  ending: []
`);
  assert.equal(result.ok, false);
  assert.equal(Object.hasOwn(result, 'storyDocument'), false);
  assert.deepEqual(calls, ['create', ['validate', 'score = 1'], 'release']);
  assert.deepEqual(
    result.diagnostics.map(({code, path, storyPath}) => [code, path, storyPath]),
    [['K4-EXPRESSION-SYNTAX-001', '$.branches["choice"][0].if', '/branches/choice/0/if']],
  );
  assert.equal(result.diagnostics[0].range.start.line, 5);
  assert.doesNotMatch(JSON.stringify(result.diagnostics), /score = 1/u);
});

test('enforces adopted source, YAML, scene, action, and asset limits with stable diagnostics', () => {
  assert.deepEqual(dsl4SourceFrontendDefaultLimits, {
    maxCanonicalSourceBytes: 1_048_576,
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

  const cases = [
    {
      limits: {maxCanonicalSourceBytes: 20},
      source: "kamishibai: '4.0'\nscenes: {opening: []}\n",
      codes: ['K4-SOURCE-LIMIT-BYTES-001'],
    },
    {
      limits: {maxYamlNodes: 4},
      source: "kamishibai: '4.0'\nscenes: {opening: []}\n",
      codes: ['K4-YAML-LIMIT-NODES-001'],
    },
    {
      limits: {maxYamlDepth: 2},
      source: "kamishibai: '4.0'\nscenes: {opening: [[[]]]}\n",
      codes: ['K4-YAML-LIMIT-DEPTH-001'],
    },
    {
      limits: {maxScalarScalars: 3},
      source: "kamishibai: '4.0'\nscenes: {opening: []}\n",
      codes: ['K4-YAML-LIMIT-SCALAR-001'],
    },
    {
      limits: {maxScenes: 1},
      source: "kamishibai: '4.0'\nscenes: {opening: [], ending: []}\n",
      codes: ['K4-SCENE-LIMIT-001'],
    },
    {
      limits: {maxActionsPerScene: 1, maxTotalActions: 1},
      source: "kamishibai: '4.0'\nscenes:\n  opening:\n    - wait: 0\n    - wait: 0\n",
      codes: ['K4-ACTION-LIMIT-SCENE-001', 'K4-ACTION-LIMIT-TOTAL-001'],
    },
    {
      limits: {maxAssets: 1},
      source:
        "kamishibai: '4.0'\nassets: {First: backdrop, Second: sound}\nscenes: {opening: []}\n",
      codes: ['K4-ASSET-LIMIT-001'],
    },
  ];

  for (const fixture of cases) {
    const result = frontend(fixture.limits).parse(fixture.source);
    assert.equal(result.ok, false, fixture.codes.join(','));
    assert.deepEqual(
      result.diagnostics.map(({code}) => code).sort(),
      [...fixture.codes].sort(),
      JSON.stringify(result.diagnostics),
    );
  }

  assert.throws(
    () => frontend({maxTotalActions: dsl4SourceFrontendDefaultLimits.maxTotalActions + 1}),
    /maxTotalActions/u,
  );
});

test('bounds author UI, SVG, clipboard, export, and telemetry without retaining source input', () => {
  const source = "first line\n<script>秘密 & token='private'</script>\n";
  const diagnostic = canonicalDiagnostic({
    message: '<script>& very long diagnostic message',
  });
  const projection = createDsl4DiagnosticUiProjection([diagnostic, diagnostic], {
    canonicalSource: source,
    displayName: '<story.kamishibai.yaml>',
    limits: {
      maxDiagnostics: 2,
      maxUiDiagnostics: 1,
      maxExcerptScalars: 12,
      maxMessageScalars: 14,
    },
  });
  assert.equal(projection.diagnostics.length, 1);
  assert.equal(projection.hiddenDiagnostics, 1);
  assert.equal([...projection.diagnostics[0].message].length, 14);
  assert.equal([...projection.diagnostics[0].excerpt].length, 12);
  assert.equal(Object.hasOwn(projection, 'canonicalSource'), false);
  assert.equal(Object.isFrozen(projection), true);

  const svg = renderDsl4DiagnosticFallbackSvg(projection);
  assert.doesNotMatch(svg, /<script>/u);
  assert.match(svg, /&lt;script/u);
  assert.match(svg, /2 diagnostics/u);

  const clipboard = formatDsl4DiagnosticClipboard(projection.diagnostics[0]);
  assert.match(clipboard, /& ver/u);
  assert.doesNotMatch(clipboard, /秘密|private/u);

  const telemetry = redactDsl4DiagnosticTelemetry(diagnostic);
  assert.deepEqual(Object.keys(telemetry), [
    'version',
    'code',
    'severity',
    'sourceId',
    'range',
    'storyPath',
    'path',
  ]);
  assert.doesNotMatch(JSON.stringify(telemetry), /message|秘密|private|token/u);

  const exported = serializeDsl4DiagnosticExport([diagnostic]);
  assert.match(exported, /K4-EXPRESSION-SYNTAX-001/u);
  assert.doesNotMatch(
    exported,
    /canonicalSource|excerpt|runtimeValues|absolutePath|sessionToken|秘密/u,
  );
  assert.deepEqual(dsl4DiagnosticProjectionDefaults, {
    maxDiagnostics: 100,
    maxUiDiagnostics: 20,
    maxExcerptScalars: 240,
    maxMessageScalars: 500,
    maxRelatedLocations: 8,
  });
});

test('maps runtime expression failures once, stops, and releases owned resources', async () => {
  const parsed = frontend().parse(`
kamishibai: '4.0'
branches:
  choice:
    - if: missing
      goto: ending
    - else: ending
scenes:
  opening:
    - branch: choice
  ending: []
`);
  assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics));
  const calls = [];
  const controller = createDsl4RuntimeController({
    storyDocument: parsed.storyDocument,
    port: {},
    evaluateCondition() {
      const error = new Error('private variable value: secret');
      Object.defineProperties(error, {
        code: {value: 'RUNTIME_EXPRESSION_UNKNOWN_VARIABLE'},
        variableName: {value: 'secret'},
      });
      throw error;
    },
    assetLifecycle: {
      async prepare() {},
      async setLoading() {},
      async releaseAssets() {},
      async release(payload) {
        calls.push(payload.reason);
      },
    },
  });
  const state = await controller.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.status, 'failed');
  assert.equal(state.diagnostic.code, 'K4-EXPRESSION-VARIABLE-UNKNOWN');
  assert.equal(state.diagnostic.storyPath, '/branches/choice/0/if');
  assert.equal(state.diagnostic.path, '$.branches["choice"][0].if');
  assert.equal(state.diagnostic.range.start.line, 5);
  assert.doesNotMatch(JSON.stringify(state.diagnostic), /private|secret|missing/u);
  assert.deepEqual(calls, ['runtime-failed']);

  for (const [genericCode, expectedCode] of [
    ['RUNTIME_EXPRESSION_INVALID_VARIABLE_VALUE', 'K4-EXPRESSION-VARIABLE-001'],
    ['UNEXPECTED_PRIVATE_ERROR', 'K4-EXPRESSION-INTERNAL-001'],
  ]) {
    const error = Object.assign(new Error('secret'), {code: genericCode});
    const mapped = mapDsl4RuntimeExpressionError(error, {
      storyPath: '/branches/choice/0/if',
      sourcePath: '$.branches["choice"][0].if',
    });
    assert.equal(mapped.code, expectedCode);
    assert.doesNotMatch(mapped.message, /secret/u);
  }
});

test('preserves one diagnostic identity across preview, validate, build, and runtime', async (t) => {
  const source = `
kamishibai: '4.0'
branches:
  choice:
    - if: score = 1
      goto: ending
    - else: ending
scenes:
  opening:
    - branch: choice
  ending: []
`;
  const sourceFrontend = frontend();
  const direct = sourceFrontend.parse(source, {sourceId: 'main'});
  assert.equal(direct.ok, false);
  const expected = direct.diagnostics[0];
  const identity = ({code, severity, range, path}) => ({code, severity, range, path});

  const editor = createDsl4DiagnosticUiProjection(direct.diagnostics, {
    canonicalSource: direct.canonicalSource,
    displayName: 'story.kamishibai.yaml',
  });
  assert.deepEqual(identity(editor.diagnostics[0]), identity(expected));

  const previewResults = [];
  const watcher = createDsl4PreviewSourceWatcher({
    projectRoot: '/project',
    manifest: {
      formatVersion: 1,
      mode: 'external',
      sourceId: 'main',
      path: 'story.k4.yml',
    },
    sourceFrontend,
    maxSourceBytes: 4096,
    onResult: (result) => previewResults.push(result),
    loadSource: async () => ({
      descriptor: {sourceId: 'main', text: source, integrity: 'sha256-preview'},
    }),
    watchFactory: () => ({
      close() {},
      on() {
        return this;
      },
    }),
  });
  await watcher.start();
  assert.deepEqual(identity(previewResults[0].diagnostics[0]), identity(expected));
  await watcher.dispose();

  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsl4-diagnostic-surfaces-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const sourcePath = path.join(directory, 'story.kamishibai.yaml');
  await writeFile(sourcePath, source);
  const cliResult = await validateDsl4SourceFile({
    input: sourcePath,
    sourceFrontend,
    maxSourceBytes: 4096,
  });
  assert.deepEqual(identity(cliResult.diagnostics[0]), identity(expected));
  assert.match(formatDsl4Diagnostic(cliResult.diagnostics[0], 'story.kamishibai.yaml'), /:5:11:/u);
  assert.deepEqual(
    identity(JSON.parse(serializeDsl4ValidationResult(cliResult)).diagnostics[0]),
    identity(expected),
  );

  await assert.rejects(
    buildDsl4RuntimeComponent({
      baseSb3Bytes: Buffer.from('unread because source validation fails'),
      projectRoot: directory,
      sourceManifest: {
        formatVersion: 1,
        mode: 'external',
        sourceId: 'main',
        path: 'story.kamishibai.yaml',
      },
      sourceFrontend,
      controlProfile: 'production',
      channel: 'bundled',
      maxSourceBytes: 4096,
      maxAssetFileBytes: 4096,
      maxAssetFiles: 10,
      maxTotalAssetBytes: 4096,
      subtleCrypto: webcrypto.subtle,
    }),
    (error) => {
      assert.equal(error instanceof Dsl4BuildError, true);
      assert.equal(error.stage, 'dsl4-parse');
      assert.deepEqual(identity(error.diagnostics[0]), identity(expected));
      return true;
    },
  );

  const embeddedSource = await createDsl4EmbeddedSourceDescriptor(source, {
    sourceId: 'main',
    displayName: 'story.k4.yml',
    maxSourceBytes: 4096,
    subtleCrypto: webcrypto.subtle,
  });
  const runtimeResult = await loadDsl4RuntimeArtifact(
    {
      extensionStorage: {
        kubohiroyakamishibairuntime4: {source: embeddedSource},
      },
    },
    sourceFrontend,
    {maxSourceBytes: 4096, subtleCrypto: webcrypto.subtle},
  );
  assert.equal(runtimeResult.ok, false);
  assert.deepEqual(identity(runtimeResult.diagnostics[0]), identity(expected));
});
