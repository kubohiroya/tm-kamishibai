import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {
  RuntimeExpressionCompositionError,
  createRuntimeExpressionComposition,
} from '@kubohiroya/turbowarp-runtime-expression/composition';

import {dsl4PreviewWatchDefaults} from '../src/builder/index.js';
import {
  dsl4ActionHatDetectorDefaultLimits,
  dsl4CustomActionTimeoutDefaults,
  dsl4DiagnosticProjectionDefaults,
  dsl4JsonPathDefaultLimits,
  dsl4RuntimeQuiesceDefaults,
  dsl4SourceFrontendDefaultLimits,
  dsl4StructuredDataDefaultLimits,
} from '../src/dsl4/index.js';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const contract = JSON.parse(
  await readFile(
    new URL('fixtures/dsl4/expression-limits-diagnostics.json', import.meta.url),
    'utf8',
  ),
);
const expressionPackage = JSON.parse(
  await readFile(
    fileURLToPath(import.meta.resolve('@kubohiroya/turbowarp-runtime-expression/package.json')),
    'utf8',
  ),
);

function validation(expression) {
  const composition = createRuntimeExpressionComposition();
  try {
    return composition.validateConditionSyntax(expression);
  } finally {
    composition.releaseAll();
  }
}

test('pins the Runtime Expression composition grammar and security exclusions', () => {
  assert.equal(contract.formatVersion, 1);
  assert.equal(expressionPackage.name, contract.runtimeExpression.package);
  assert.equal(expressionPackage.version, contract.runtimeExpression.version);
  assert.ok(expressionPackage.exports[contract.runtimeExpression.entrypoint]);

  for (const expression of contract.runtimeExpression.allowed) {
    assert.deepEqual(validation(expression), {ok: true}, expression);
  }
  for (const expression of contract.runtimeExpression.rejected) {
    const result = validation(expression);
    assert.equal(result.ok, false, expression);
    assert.equal(result.code, 'CONDITION_SYNTAX_ERROR', expression);
    assert.equal(typeof result.position, 'number', expression);
  }
});

test('pins expression length, token, nesting, variable, and cache boundaries', () => {
  const limits = contract.runtimeExpression.limits;
  assert.deepEqual(validation('a'.repeat(limits.maxExpressionCodeUnits)), {ok: true});
  const tooLong = validation('a'.repeat(limits.maxExpressionCodeUnits + 1));
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.position, limits.maxExpressionCodeUnits);

  const maximumFlatTerms = limits.maxTokensIncludingEof / 2;
  assert.deepEqual(validation(Array(maximumFlatTerms).fill('true').join(' || ')), {ok: true});
  assert.equal(
    validation(
      Array(maximumFlatTerms + 1)
        .fill('true')
        .join(' || '),
    ).ok,
    false,
  );
  assert.deepEqual(
    validation(`${'('.repeat(limits.maxParseDepth)}true${')'.repeat(limits.maxParseDepth)}`),
    {ok: true},
  );
  assert.equal(
    validation(`${'('.repeat(limits.maxParseDepth + 1)}true${')'.repeat(limits.maxParseDepth + 1)}`)
      .ok,
    false,
  );

  const composition = createRuntimeExpressionComposition();
  assert.equal(
    composition.evaluateCondition('score >= 10 && state === "ready"', {
      score: 10,
      state: 'ready',
    }),
    true,
  );
  assert.equal(composition.evaluateCondition('true || missing', {}), true);
  assert.throws(
    () => composition.evaluateCondition('missing', {}),
    (error) =>
      error instanceof RuntimeExpressionCompositionError &&
      error.code === 'RUNTIME_EXPRESSION_UNKNOWN_VARIABLE',
  );
  assert.throws(
    () => composition.evaluateCondition('value', {value: Number.POSITIVE_INFINITY}),
    (error) =>
      error instanceof RuntimeExpressionCompositionError &&
      error.code === 'RUNTIME_EXPRESSION_INVALID_VARIABLE_VALUE',
  );
  for (let index = 0; index <= limits.maxCacheEntries; index += 1) {
    assert.equal(composition.evaluateCondition(`value === ${index}`, {value: index}), true);
  }
  composition.releaseAll();
});

test('keeps every implemented limit in the design registry synchronized with code', async () => {
  assert.deepEqual(contract.implementedLimits.jsonPath.values, dsl4JsonPathDefaultLimits);
  assert.deepEqual(
    contract.implementedLimits.structuredData.values,
    dsl4StructuredDataDefaultLimits,
  );
  assert.deepEqual(
    contract.implementedLimits.actionDiscovery.values,
    dsl4ActionHatDetectorDefaultLimits,
  );
  assert.deepEqual(contract.implementedLimits.customAction.values, dsl4CustomActionTimeoutDefaults);
  assert.deepEqual(contract.implementedLimits.runtimeQuiesce.values, dsl4RuntimeQuiesceDefaults);
  assert.deepEqual(contract.implementedLimits.previewWatch.values, dsl4PreviewWatchDefaults);
  assert.deepEqual(
    contract.implementedLimits.sourceFrontend.values,
    dsl4SourceFrontendDefaultLimits,
  );
  assert.deepEqual(
    contract.implementedLimits.diagnosticProjection.values,
    dsl4DiagnosticProjectionDefaults,
  );

  const objectStoreSource = await readFile(
    path.join(repositoryRoot, contract.implementedLimits.objectStore.source),
    'utf8',
  );
  for (const [name, value] of Object.entries(contract.implementedLimits.objectStore.values)) {
    const formatted = String(value).replace(/(?=(?:\d{3})+$)/gu, '_');
    assert.match(
      objectStoreSource,
      new RegExp(`\\b${name}: (?:${value}|${formatted.replaceAll('_', '[_]?')})[,\\n]`, 'u'),
      name,
    );
  }
});

test('separates implemented defaults from required explicit host limits', () => {
  assert.equal(contract.sourceFrontendPolicy.status, 'implemented-default');
  assert.equal(contract.diagnosticProjectionPolicy.status, 'implemented-default');
  assert.equal(
    new Set(contract.requiredExplicitLimits).size,
    contract.requiredExplicitLimits.length,
  );
  assert.equal(contract.sourceFrontendPolicy.values.maxCanonicalSourceBytes, 256 * 1024);
  assert.ok(
    contract.sourceFrontendPolicy.values.maxTotalActions <=
      contract.sourceFrontendPolicy.values.maxYamlNodes,
  );
  assert.ok(
    contract.diagnosticProjectionPolicy.values.maxUiDiagnostics <=
      contract.diagnosticProjectionPolicy.values.maxDiagnostics,
  );
  assert.deepEqual(contract.diagnosticProjectionPolicy.sortKeys, [
    'range.start.offset',
    'code',
    'message',
  ]);
  assert.equal(contract.diagnosticProjectionPolicy.sortStringOrder, 'unicode-code-unit');
});

test('maps generic expression failures and fixes a redacted telemetry allowlist', () => {
  assert.deepEqual(
    contract.diagnosticMappings.map(({generic, kamishibai, severity}) => [
      generic,
      kamishibai,
      severity,
    ]),
    [
      ['CONDITION_SYNTAX_ERROR', 'K4-EXPRESSION-SYNTAX-001', 'error'],
      ['RUNTIME_EXPRESSION_UNKNOWN_VARIABLE', 'K4-EXPRESSION-VARIABLE-UNKNOWN', 'error'],
      ['RUNTIME_EXPRESSION_INVALID_VARIABLE_*', 'K4-EXPRESSION-VARIABLE-001', 'error'],
      ['unexpected-expression-failure', 'K4-EXPRESSION-INTERNAL-001', 'error'],
    ],
  );
  const allowed = new Set(contract.redactedTelemetryFields);
  for (const forbidden of contract.forbiddenTelemetryFields) {
    assert.equal(allowed.has(forbidden), false, forbidden);
  }
  assert.equal(allowed.has('message'), false);
});
