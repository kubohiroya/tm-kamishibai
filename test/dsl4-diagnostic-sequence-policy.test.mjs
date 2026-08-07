import assert from 'node:assert/strict';
import test from 'node:test';

import {
  dsl4DiagnosticTruncationCode,
  Dsl4DiagnosticPolicyError,
  normalizeDsl4DiagnosticSequence,
} from '../src/dsl4/index.js';

function range(offset, length = 1) {
  return {
    start: {line: 1, column: offset + 1, offset},
    end: {line: 1, column: offset + length + 1, offset: offset + length},
  };
}

function diagnostic(overrides = {}) {
  return {
    version: 1,
    code: 'K4-SCHEMA-001',
    severity: 'error',
    message: 'Schema validation failed',
    sourceId: 'main',
    range: range(0),
    path: '$',
    related: [],
    ...overrides,
  };
}

function policy(overrides = {}) {
  return {maxDiagnostics: 10, maxRelatedLocations: 2, ...overrides};
}

function throwsCode(callback, code, path) {
  assert.throws(callback, (error) => {
    assert.equal(error instanceof Dsl4DiagnosticPolicyError, true);
    assert.equal(error.code, code);
    assert.equal(error.path, path);
    return true;
  });
}

test('normalizes an empty sequence without choosing a default limit', () => {
  assert.equal(dsl4DiagnosticTruncationCode, 'K4-DIAGNOSTICS-TRUNCATED');
  assert.deepEqual(normalizeDsl4DiagnosticSequence([], policy()), {
    version: 1,
    canStage: true,
    counts: {total: 0, errors: 0, warnings: 0, retained: 0},
    truncation: null,
    diagnostics: [],
  });
  throwsCode(
    () => normalizeDsl4DiagnosticSequence([], {}),
    'K4-DIAGNOSTIC-POLICY-SCHEMA',
    'policy',
  );
});

test('orders by offset, code, and Unicode code units without changing the input', () => {
  const input = [
    diagnostic({code: 'K4-Z-001', message: 'later offset', range: range(9)}),
    diagnostic({code: 'K4-B-001', message: 'same offset', range: range(2)}),
    diagnostic({code: 'K4-A-001', message: 'ä', range: range(2)}),
    diagnostic({code: 'K4-A-001', message: 'z', range: range(2)}),
  ];
  const original = structuredClone(input);
  const normalized = normalizeDsl4DiagnosticSequence(input, policy());
  assert.deepEqual(
    normalized.diagnostics.map(({code, message, range: diagnosticRange}) => [
      diagnosticRange.start.offset,
      code,
      message,
    ]),
    [
      [2, 'K4-A-001', 'z'],
      [2, 'K4-A-001', 'ä'],
      [2, 'K4-B-001', 'same offset'],
      [9, 'K4-Z-001', 'later offset'],
    ],
  );
  assert.deepEqual(input, original);
  assert.notStrictEqual(normalized.diagnostics[0], input[3]);
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.diagnostics), true);
  assert.equal(Object.isFrozen(normalized.diagnostics[0].range.start), true);
});

test('returns byte-equivalent order for input permutations with distinct sort keys', () => {
  const first = diagnostic({code: 'K4-C-001', message: 'three', range: range(3)});
  const second = diagnostic({code: 'K4-A-001', message: 'one', range: range(1)});
  const third = diagnostic({code: 'K4-B-001', message: 'two', range: range(2)});
  const forward = normalizeDsl4DiagnosticSequence([first, second, third], policy());
  const reverse = normalizeDsl4DiagnosticSequence([third, second, first], policy());
  assert.equal(JSON.stringify(forward), JSON.stringify(reverse));
});

test('allows warning-only staging and blocks any retained error', () => {
  const warnings = normalizeDsl4DiagnosticSequence(
    [
      diagnostic({code: 'K4-WARNING-001', severity: 'warning'}),
      diagnostic({code: 'K4-WARNING-002', severity: 'warning', range: range(2)}),
    ],
    policy(),
  );
  assert.equal(warnings.canStage, true);
  assert.deepEqual(warnings.counts, {total: 2, errors: 0, warnings: 2, retained: 2});

  const errors = normalizeDsl4DiagnosticSequence(
    [
      diagnostic({code: 'K4-WARNING-001', severity: 'warning'}),
      diagnostic({code: 'K4-ERROR-001', range: range(2)}),
    ],
    policy(),
  );
  assert.equal(errors.canStage, false);
  assert.deepEqual(errors.counts, {total: 2, errors: 1, warnings: 1, retained: 2});
});

test('replaces the final slot with a machine-readable error truncation sentinel', () => {
  const normalized = normalizeDsl4DiagnosticSequence(
    [
      diagnostic({code: 'K4-WARNING-001', severity: 'warning', range: range(1)}),
      diagnostic({code: 'K4-WARNING-002', severity: 'warning', range: range(2)}),
      diagnostic({code: 'K4-ERROR-001', range: range(3), storyPath: '/scenes/opening'}),
      diagnostic({code: 'K4-WARNING-003', severity: 'warning', range: range(4)}),
    ],
    policy({maxDiagnostics: 3}),
  );
  assert.equal(normalized.canStage, false);
  assert.deepEqual(normalized.counts, {total: 4, errors: 1, warnings: 3, retained: 3});
  assert.deepEqual(
    normalized.diagnostics.map(({code, severity}) => [code, severity]),
    [
      ['K4-WARNING-001', 'warning'],
      ['K4-WARNING-002', 'warning'],
      [dsl4DiagnosticTruncationCode, 'error'],
    ],
  );
  assert.deepEqual(normalized.truncation, {
    omittedDiagnostics: 2,
    omittedErrors: 1,
    omittedWarnings: 1,
    firstOmitted: {
      code: 'K4-ERROR-001',
      sourceId: 'main',
      range: range(3),
      storyPath: '/scenes/opening',
      path: '$',
    },
  });
  assert.equal(Object.isFrozen(normalized.truncation.firstOmitted.range), true);
});

test('keeps warning-only truncation stageable, including a one-slot policy', () => {
  const normalized = normalizeDsl4DiagnosticSequence(
    [
      diagnostic({code: 'K4-WARNING-002', severity: 'warning', range: range(2)}),
      diagnostic({code: 'K4-WARNING-001', severity: 'warning', range: range(1)}),
    ],
    policy({maxDiagnostics: 1}),
  );
  assert.equal(normalized.canStage, true);
  assert.equal(normalized.diagnostics.length, 1);
  assert.equal(normalized.diagnostics[0].code, dsl4DiagnosticTruncationCode);
  assert.equal(normalized.diagnostics[0].severity, 'warning');
  assert.deepEqual(normalized.truncation, {
    omittedDiagnostics: 2,
    omittedErrors: 0,
    omittedWarnings: 2,
    firstOmitted: {
      code: 'K4-WARNING-001',
      sourceId: 'main',
      range: range(1),
      path: '$',
    },
  });
});

test('does not truncate at the exact limit', () => {
  const normalized = normalizeDsl4DiagnosticSequence(
    [
      diagnostic({code: 'K4-WARNING-001', severity: 'warning', range: range(1)}),
      diagnostic({code: 'K4-WARNING-002', severity: 'warning', range: range(2)}),
    ],
    policy({maxDiagnostics: 2}),
  );
  assert.equal(normalized.canStage, true);
  assert.deepEqual(normalized.counts, {total: 2, errors: 0, warnings: 2, retained: 2});
  assert.equal(normalized.truncation, null);
  assert.deepEqual(
    normalized.diagnostics.map(({code}) => code),
    ['K4-WARNING-001', 'K4-WARNING-002'],
  );
});

test('keeps an earlier retained error blocking when only warnings are omitted', () => {
  const normalized = normalizeDsl4DiagnosticSequence(
    [
      diagnostic({code: 'K4-ERROR-001', range: range(1)}),
      diagnostic({code: 'K4-WARNING-001', severity: 'warning', range: range(2)}),
      diagnostic({code: 'K4-WARNING-002', severity: 'warning', range: range(3)}),
    ],
    policy({maxDiagnostics: 2}),
  );
  assert.equal(normalized.canStage, false);
  assert.deepEqual(normalized.counts, {total: 3, errors: 1, warnings: 2, retained: 2});
  assert.deepEqual(
    normalized.diagnostics.map(({code, severity}) => [code, severity]),
    [
      ['K4-ERROR-001', 'error'],
      [dsl4DiagnosticTruncationCode, 'warning'],
    ],
  );
  assert.deepEqual(
    {
      omittedErrors: normalized.truncation.omittedErrors,
      omittedWarnings: normalized.truncation.omittedWarnings,
    },
    {omittedErrors: 0, omittedWarnings: 2},
  );
});

test('validates and copies bounded canonical related locations', () => {
  const related = {
    message: 'First declaration is here',
    sourceId: 'main',
    range: range(4),
    storyPath: '/scenes/opening/actions/0',
    path: '$.scenes.opening[0]',
  };
  const input = diagnostic({related: [related]});
  const normalized = normalizeDsl4DiagnosticSequence([input], policy());
  assert.deepEqual(normalized.diagnostics[0].related, [related]);
  assert.notStrictEqual(normalized.diagnostics[0].related[0], related);
  assert.equal(Object.isFrozen(normalized.diagnostics[0].related[0]), true);

  throwsCode(
    () =>
      normalizeDsl4DiagnosticSequence(
        [diagnostic({related: [related, related]})],
        policy({maxRelatedLocations: 1}),
      ),
    'K4-DIAGNOSTIC-POLICY-LIMIT',
    'diagnostics[0].related',
  );
});

test('rejects malformed canonical fields without returning a partial sequence', () => {
  const invalidCases = [
    [null, 'diagnostics[0]'],
    [diagnostic({version: 2}), 'diagnostics[0].version'],
    [diagnostic({code: 'GENERIC_ERROR'}), 'diagnostics[0].code'],
    [diagnostic({severity: 'info'}), 'diagnostics[0].severity'],
    [diagnostic({message: 'bad\0message'}), 'diagnostics[0].message'],
    [diagnostic({sourceId: ''}), 'diagnostics[0].sourceId'],
    [diagnostic({path: ''}), 'diagnostics[0].path'],
    [
      diagnostic({range: {start: {line: 0, column: 1, offset: 0}, end: range(0).end}}),
      'diagnostics[0].range.start.line',
    ],
    [diagnostic({range: {start: range(3).start, end: range(1).end}}), 'diagnostics[0].range'],
    [diagnostic({related: {}}), 'diagnostics[0].related'],
    [diagnostic({related: [{}]}), 'diagnostics[0].related[0]'],
    [{...diagnostic(), unexpected: true}, 'diagnostics[0]'],
  ];
  for (const [value, expectedPath] of invalidCases) {
    throwsCode(
      () => normalizeDsl4DiagnosticSequence([value], policy()),
      'K4-DIAGNOSTIC-POLICY-SCHEMA',
      expectedPath,
    );
  }
  throwsCode(
    () => normalizeDsl4DiagnosticSequence({}, policy()),
    'K4-DIAGNOSTIC-POLICY-SCHEMA',
    'diagnostics',
  );
});

test('rejects invalid or unknown policy limits', () => {
  for (const [value, expectedPath] of [
    [{maxDiagnostics: 0, maxRelatedLocations: 0}, 'policy.maxDiagnostics'],
    [{maxDiagnostics: 1, maxRelatedLocations: -1}, 'policy.maxRelatedLocations'],
    [{maxDiagnostics: 1}, 'policy'],
    [{maxDiagnostics: 1, maxRelatedLocations: 0, unknown: true}, 'policy'],
  ]) {
    throwsCode(
      () => normalizeDsl4DiagnosticSequence([], value),
      expectedPath === 'policy' ? 'K4-DIAGNOSTIC-POLICY-SCHEMA' : 'K4-DIAGNOSTIC-POLICY-LIMIT',
      expectedPath,
    );
  }
});

test('rejects non-canonical extra data without copying its sensitive value', () => {
  const secret = 'file:///Users/example/private/story.yaml?token=secret';
  let caught;
  try {
    normalizeDsl4DiagnosticSequence([diagnostic({sourceText: secret})], policy());
  } catch (error) {
    caught = error;
  }
  assert.equal(caught instanceof Dsl4DiagnosticPolicyError, true);
  assert.equal(caught.code, 'K4-DIAGNOSTIC-POLICY-SCHEMA');
  assert.doesNotMatch(JSON.stringify(caught), /Users\/example|token=secret/u);
  assert.doesNotMatch(caught.message, /Users\/example|token=secret/u);
});

test('rejects sparse arrays, metadata, custom prototypes, and accessors before reading values', () => {
  const sparse = [];
  sparse.length = 1;
  throwsCode(
    () => normalizeDsl4DiagnosticSequence(sparse, policy()),
    'K4-DIAGNOSTIC-POLICY-SCHEMA',
    'diagnostics[0]',
  );

  const withMetadata = [diagnostic()];
  withMetadata.sourceText = 'secret';
  throwsCode(
    () => normalizeDsl4DiagnosticSequence(withMetadata, policy()),
    'K4-DIAGNOSTIC-POLICY-SCHEMA',
    'diagnostics',
  );

  let inheritedAccessed = false;
  const customPrototype = Object.create({
    get storyPath() {
      inheritedAccessed = true;
      throw new Error('must not execute');
    },
  });
  Object.assign(customPrototype, diagnostic());
  throwsCode(
    () => normalizeDsl4DiagnosticSequence([customPrototype], policy()),
    'K4-DIAGNOSTIC-POLICY-SCHEMA',
    'diagnostics[0]',
  );
  assert.equal(inheritedAccessed, false);

  let accessed = false;
  const withAccessor = diagnostic();
  Object.defineProperty(withAccessor, 'message', {
    enumerable: true,
    get() {
      accessed = true;
      throw new Error('must not execute');
    },
  });
  throwsCode(
    () => normalizeDsl4DiagnosticSequence([withAccessor], policy()),
    'K4-DIAGNOSTIC-POLICY-SCHEMA',
    'diagnostics[0]',
  );
  assert.equal(accessed, false);
});
