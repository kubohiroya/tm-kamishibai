import assert from 'node:assert/strict';
import test from 'node:test';

import {createDsl4JsonPathEngine, dsl4JsonPathDefaultLimits} from '../src/dsl4/index.js';

function ok(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}

function errorCode(result, code, operation) {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, code);
  if (operation) assert.equal(result.error.operation, operation);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.error), true);
}

function query(engine, value, source) {
  return ok(engine.query(value, source));
}

function values(result) {
  return result.nodes.map(({node}) => node);
}

function paths(result) {
  return result.nodes.map(({normalizedPath}) => normalizedPath);
}

test('compiles an immutable child-segment AST and classifies singular queries syntactically', () => {
  const engine = createDsl4JsonPathEngine();
  const root = ok(engine.compile('$'));
  const singular = ok(engine.compile("$ .actor ['a.b'][-1]"));
  const multiple = ok(engine.compile("$['a','b']"));
  const wildcard = ok(engine.compile('$.*'));
  const slice = ok(engine.compile('$[1:5:2]'));

  assert.equal(root.singular, true);
  assert.equal(root.astNodeCount, 1);
  assert.deepEqual(root.segments, []);
  assert.equal(singular.singular, true);
  assert.deepEqual(singular.segments, [
    {kind: 'child', selectors: [{kind: 'name', name: 'actor'}]},
    {kind: 'child', selectors: [{kind: 'name', name: 'a.b'}]},
    {kind: 'child', selectors: [{kind: 'index', index: -1}]},
  ]);
  assert.equal(multiple.singular, false);
  assert.equal(wildcard.singular, false);
  assert.equal(slice.singular, false);
  assert.equal(Object.isFrozen(singular), true);
  assert.equal(Object.isFrozen(singular.segments), true);
  assert.equal(Object.isFrozen(singular.segments[0].selectors), true);
  assert.deepEqual(engine.limits, dsl4JsonPathDefaultLimits);
});

test('evaluates RFC name selectors, escapes, and canonical normalized paths', () => {
  const engine = createDsl4JsonPathEngine();
  const fixture = {
    o: {'j j': {'k.k': 3}},
    "'": {'@': 2},
    a: 4,
    '🁁': 5,
    é: 6,
    é: 7,
  };

  assert.deepEqual(values(query(engine, fixture, "$.o['j j']['k.k']")), [3]);
  const unusual = query(engine, fixture, '$["\'"]["@"]');
  assert.deepEqual(values(unusual), [2]);
  assert.deepEqual(paths(unusual), ["$['\\\'']['@']"]);
  assert.deepEqual(values(query(engine, fixture, "$['\\u0061']")), [4]);
  assert.deepEqual(values(query(engine, fixture, "$['\\uD83C\\uDC41']")), [5]);
  assert.deepEqual(values(query(engine, fixture, "$['é']")), [6]);
  assert.deepEqual(values(query(engine, fixture, "$['é']")), [7]);
});

test('preserves array order, object insertion order, selector order, and duplicate nodes', () => {
  const engine = createDsl4JsonPathEngine();
  const fixture = {
    o: {j: 1, k: 2},
    a: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
  };

  const objectWildcard = query(engine, fixture, '$.o[*]');
  assert.deepEqual(values(objectWildcard), [1, 2]);
  assert.deepEqual(paths(objectWildcard), ["$['o']['j']", "$['o']['k']"]);
  assert.deepEqual(values(query(engine, fixture, '$.a[*]')), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  const duplicate = query(engine, fixture, '$.a[0,0,-1]');
  assert.deepEqual(values(duplicate), ['a', 'a', 'g']);
  assert.deepEqual(paths(duplicate), ["$['a'][0]", "$['a'][0]", "$['a'][6]"]);
  assert.deepEqual(values(query(engine, fixture, '$.a[0:2,5]')), ['a', 'b', 'f']);
});

test('implements RFC array index and slice bounds including reverse and zero step', () => {
  const engine = createDsl4JsonPathEngine();
  const array = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const cases = [
    ['$[1]', ['b']],
    ['$[-2]', ['f']],
    ['$[99]', []],
    ['$[-99]', []],
    ['$[1:3]', ['b', 'c']],
    ['$[1:5:2]', ['b', 'd']],
    ['$[5:1:-2]', ['f', 'd']],
    ['$[::-1]', ['g', 'f', 'e', 'd', 'c', 'b', 'a']],
    ['$[:]', ['a', 'b', 'c', 'd', 'e', 'f', 'g']],
    ['$[::]', ['a', 'b', 'c', 'd', 'e', 'f', 'g']],
    ['$[-10:10]', ['a', 'b', 'c', 'd', 'e', 'f', 'g']],
    ['$[10:-10:-2]', ['g', 'e', 'c', 'a']],
    ['$[::0]', []],
    ['$[1:5:0]', []],
  ];
  for (const [source, expected] of cases) {
    assert.deepEqual(values(query(engine, array, source)), expected, source);
  }
});

test('returns an empty nodelist for valid data mismatches without producing an error', () => {
  const engine = createDsl4JsonPathEngine();
  const fixture = {scalar: 1, array: [0]};
  for (const source of [
    '$.missing',
    '$.scalar.child',
    '$.scalar[*]',
    '$.array[9]',
    '$.array[-9]',
    '$.array[::0]',
  ]) {
    const result = query(engine, fixture, source);
    assert.deepEqual(result.nodes, [], source);
  }
});

test('accepts RFC whitespace only where the child-segment grammar permits it', () => {
  const engine = createDsl4JsonPathEngine();
  const fixture = [{name: 'zero'}, {name: 'one'}, {name: 'two'}];
  assert.deepEqual(values(query(engine, fixture, "$ [ 0 , 2 ] ['name']")), ['zero', 'two']);
  assert.deepEqual(values(query(engine, fixture, '$[ 0 : 3 : 2 ]')), [fixture[0], fixture[2]]);
  errorCode(engine.compile('$ '), 'SD-JSONPATH-SYNTAX', 'compile');
  errorCode(engine.compile(' $.name'), 'SD-JSONPATH-SYNTAX', 'compile');
  errorCode(engine.compile('$. name'), 'SD-JSONPATH-SYNTAX', 'compile');
});

test('rejects excluded RFC and script features as unsupported without delegating parsing', () => {
  const engine = createDsl4JsonPathEngine();
  for (const source of [
    '$..author',
    '$..[0]',
    '$[?@.price]',
    '$[@]',
    '$[(@.length-1)]',
    '$.name()',
    '$[length(@)]',
    '$=1',
  ]) {
    errorCode(engine.compile(source), 'SD-JSONPATH-UNSUPPORTED', 'compile');
  }
});

test('rejects malformed grammar, invalid escapes, lone surrogates, and inexact integers', () => {
  const engine = createDsl4JsonPathEngine();
  const invalid = [
    '',
    'name',
    '$[]',
    '$[01]',
    '$[-0]',
    '$[+1]',
    '$[1,]',
    '$[1 2]',
    '$.1name',
    "$['unterminated]",
    "$['\\x20']",
    '$["\\\'"]',
    "$['\\\"']",
    "$['\\uD800']",
    "$['\\uDC00']",
    "$['\\uD800\\u0041']",
    '$[9007199254740992]',
    '$[-9007199254740992]',
    `$['${String.fromCharCode(0xd800)}']`,
  ];
  for (const source of invalid) {
    errorCode(engine.compile(source), 'SD-JSONPATH-SYNTAX', 'compile');
  }
});

test('enforces syntactic singularity before evaluating the data', () => {
  const engine = createDsl4JsonPathEngine();
  const fixture = {a: [1]};
  const root = ok(engine.compile('$'));
  const singular = ok(engine.compile("$['a'][0]"));
  const missing = ok(engine.compile("$['missing']"));
  const wildcard = ok(engine.compile('$.a[*]'));
  const slice = ok(engine.compile('$.a[0:1]'));
  const list = ok(engine.compile('$.a[0,1]'));

  assert.deepEqual(values(ok(engine.evaluateSingular(root, fixture))), [fixture]);
  assert.deepEqual(values(ok(engine.evaluateSingular(singular, fixture))), [1]);
  assert.deepEqual(values(ok(engine.evaluateSingular(missing, fixture))), []);
  for (const program of [wildcard, slice, list]) {
    errorCode(engine.evaluateSingular(program, fixture), 'SD-QUERY-NOT-SINGULAR', 'evaluate');
  }
  errorCode(engine.querySingular(fixture, '$.a[*]'), 'SD-QUERY-NOT-SINGULAR', 'evaluate');
});

test('fails every compile and evaluation limit without returning a partial nodelist', () => {
  const compileCases = [
    [{maxQueryScalars: 3}, '$.ab'],
    [{maxSegments: 1}, '$.a.b'],
    [{maxSelectorsPerSegment: 1}, '$[0,1]'],
    [{maxAstNodes: 2}, '$.a'],
  ];
  for (const [limits, source] of compileCases) {
    const engine = createDsl4JsonPathEngine({limits});
    errorCode(engine.compile(source), 'SD-JSONPATH-LIMIT', 'compile');
  }

  const visitLimited = createDsl4JsonPathEngine({limits: {maxVisits: 1}});
  errorCode(
    visitLimited.query([{x: 1}, {x: 2}], '$[*].x'),
    'SD-JSONPATH-EVALUATION-LIMIT',
    'evaluate',
  );
  const resultLimited = createDsl4JsonPathEngine({limits: {maxResults: 1}});
  errorCode(resultLimited.query([1, 2], '$[*]'), 'SD-JSONPATH-EVALUATION-LIMIT', 'evaluate');
  const pathLimited = createDsl4JsonPathEngine({limits: {maxNormalizedPathScalars: 1}});
  errorCode(pathLimited.query({a: 1}, '$.a'), 'SD-JSONPATH-EVALUATION-LIMIT', 'evaluate');
  assert.deepEqual(values(query(pathLimited, {a: 1}, '$')), [{a: 1}]);

  assert.throws(
    () =>
      createDsl4JsonPathEngine({limits: {maxResults: dsl4JsonPathDefaultLimits.maxResults + 1}}),
    /maxResults/,
  );
  assert.throws(() => createDsl4JsonPathEngine({limits: {unknown: 1}}), /unknown/);
});

test('uses an injected pure node adapter without changing selector semantics', () => {
  const adapter = {
    classify(node) {
      return node.type;
    },
    objectEntries(node) {
      return node.entries;
    },
    arrayLength(node) {
      return node.items.length;
    },
    arrayItem(node, index) {
      return node.items[index];
    },
  };
  const customRoot = {
    type: 'object',
    entries: [
      [
        'items',
        {
          type: 'array',
          items: [
            {type: 'scalar', value: 1},
            {type: 'scalar', value: 2},
          ],
        },
      ],
    ],
  };
  const engine = createDsl4JsonPathEngine({adapter});
  const result = query(engine, customRoot, '$.items[::-1]');
  assert.deepEqual(
    result.nodes.map(({node}) => node.value),
    [2, 1],
  );
  assert.deepEqual(paths(result), ["$['items'][1]", "$['items'][0]"]);
  assert.throws(() => createDsl4JsonPathEngine({adapter: {}}), /adapter.classify/);

  const invalid = createDsl4JsonPathEngine({
    adapter: {...adapter, classify: () => 'unknown'},
  });
  errorCode(invalid.query(customRoot, '$.*'), 'SD-JSONPATH-EVALUATION-LIMIT', 'evaluate');
});

test('normalizes member names with the one RFC escape form and preserves result identities', () => {
  const engine = createDsl4JsonPathEngine();
  const fixture = {
    "a'b": 1,
    'a\\b': 2,
    '\b': 3,
    '\t': 4,
    '\n': 5,
    '\f': 6,
    '\r': 7,
    '\u000b': 8,
    '"/🁁': 9,
  };
  const result = query(engine, fixture, '$[*]');
  assert.deepEqual(paths(result), [
    "$['a\\'b']",
    "$['a\\\\b']",
    "$['\\b']",
    "$['\\t']",
    "$['\\n']",
    "$['\\f']",
    "$['\\r']",
    "$['\\u000b']",
    "$['\"/🁁']",
  ]);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.nodes), true);
  assert.equal(Object.isFrozen(result.nodes[0]), true);
  assert.strictEqual(query(engine, fixture, '$').nodes[0].node, fixture);
  assert.equal(Object.isFrozen(fixture), false);
  const nested = {child: {value: 1}};
  query(engine, nested, '$');
  assert.equal(Object.isFrozen(nested.child), false);
});

test('streams wildcard selection so result limits bound adapter reads', () => {
  let itemReads = 0;
  const engine = createDsl4JsonPathEngine({
    limits: {maxResults: 1},
    adapter: {
      classify: () => 'array',
      objectEntries: () => [],
      arrayLength: () => 1_000_000,
      arrayItem(_node, index) {
        itemReads += 1;
        return index;
      },
    },
  });

  errorCode(engine.query({}, '$[*]'), 'SD-JSONPATH-EVALUATION-LIMIT', 'evaluate');
  assert.equal(itemReads, 2);
});

test('binds compiled programs to the engine whose compile limits accepted them', () => {
  const source = createDsl4JsonPathEngine();
  const target = createDsl4JsonPathEngine();
  const program = ok(source.compile('$.a'));

  errorCode(target.evaluate(program, {a: 1}), 'SD-JSONPATH-SYNTAX', 'evaluate');
});
