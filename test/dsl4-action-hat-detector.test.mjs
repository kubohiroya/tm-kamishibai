import assert from 'node:assert/strict';
import test from 'node:test';

import {
  detectDsl4ActionRegistrySnapshot,
  dsl4ActionHatDetectorDefaultLimits,
  Dsl4ActionRegistryError,
} from '../src/dsl4/index.js';

const hatOpcode = 'kubohiroyakamishibai4_actioncontext__whenCustomAction';

function mutation(declaration) {
  return {
    tagName: 'mutation',
    children: [],
    dsl4action: JSON.stringify(declaration),
  };
}

function declaration(name, extra = {}) {
  return {
    version: 1,
    name,
    target: 'actor',
    parameters: [],
    ...extra,
  };
}

function hat(name, extra = {}) {
  return {
    opcode: hatOpcode,
    topLevel: true,
    parent: null,
    mutation: mutation(declaration(name)),
    ...extra,
  };
}

function originalTarget(id, blocks, runtimeShape = false) {
  return {
    id,
    isOriginal: true,
    blocks: runtimeShape ? {_blocks: blocks} : blocks,
  };
}

function detect(targets, extra = {}) {
  return detectDsl4ActionRegistrySnapshot({
    runtime: {targets},
    hatOpcode,
    ...extra,
  });
}

function assertDeepFrozen(value) {
  if (typeof value !== 'object' || value === null) return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child);
}

function rejectsCode(operation, code) {
  assert.throws(operation, (error) => {
    assert.equal(error instanceof Dsl4ActionRegistryError, true);
    assert.equal(error.code, code);
    return true;
  });
}

test('detects only canonical original top-level hats without executing blocks', () => {
  const guardedHat = hat('zebra');
  Object.defineProperty(guardedHat, 'next', {
    get() {
      assert.fail('detector must not inspect or execute the handler body');
    },
  });
  const targets = [
    originalTarget(
      'target-b',
      {
        'hat-z': guardedHat,
        nested: hat('ignoredNested', {topLevel: false, parent: 'parent'}),
      },
      true,
    ),
    {
      id: 'clone-a',
      isOriginal: false,
      blocks: {_blocks: {'hat-clone': hat('ignoredClone')}},
    },
    originalTarget('target-a', {
      unrelated: {opcode: 'event_whenflagclicked', topLevel: true, parent: null},
      'hat-a': hat('alpha'),
      'hat-parented': hat('ignoredParented', {parent: 'other'}),
    }),
  ];
  const before = structuredClone(targets);

  const snapshot = detect(targets);

  assert.deepEqual(
    snapshot.actions.map(({name, source}) => ({name, source})),
    [
      {name: 'alpha', source: {targetId: 'target-a', hatBlockId: 'hat-a'}},
      {name: 'zebra', source: {targetId: 'target-b', hatBlockId: 'hat-z'}},
    ],
  );
  assert.deepEqual(targets, before);
  assertDeepFrozen(snapshot);
});

test('normalizes bounded declarative parameters and quiesce through Snapshot v2', () => {
  const input = declaration('wave', {
    parameters: [
      {name: 'speed', type: 'string'},
      {name: 'count', type: 'number', required: false},
      {name: 'enabled', type: 'boolean', required: true},
    ],
    quiesce: 'cancel-replay-safe',
  });
  const snapshot = detect([
    originalTarget('target', {
      handler: hat('ignored', {mutation: mutation(input)}),
    }),
  ]);
  assert.deepEqual(snapshot.actions[0], {
    name: 'wave',
    target: 'actor',
    parameters: [
      {name: 'speed', type: 'string', required: true},
      {name: 'count', type: 'number', required: false},
      {name: 'enabled', type: 'boolean', required: true},
    ],
    quiesce: 'cancel-replay-safe',
    source: {targetId: 'target', hatBlockId: 'handler'},
  });
});

test('rejects malformed graph and mutation inputs without a partial snapshot', () => {
  rejectsCode(
    () => detectDsl4ActionRegistrySnapshot({runtime: {}, hatOpcode}),
    'K4-REGISTRY-DETECT-001',
  );
  rejectsCode(
    () => detectDsl4ActionRegistrySnapshot({runtime: {targets: []}, hatOpcode: ''}),
    'K4-REGISTRY-DETECT-001',
  );
  rejectsCode(() => detect([{id: '', isOriginal: true, blocks: {}}]), 'K4-REGISTRY-DETECT-001');
  rejectsCode(() => detect([{id: 'target', blocks: {}}]), 'K4-REGISTRY-DETECT-001');
  assert.throws(
    () =>
      detect([originalTarget('private-target-id', {}), originalTarget('private-target-id', {})]),
    (error) => {
      assert.equal(error.code, 'K4-REGISTRY-DETECT-001');
      assert.doesNotMatch(error.message, /private-target-id/u);
      return true;
    },
  );
  rejectsCode(
    () => detect([{id: 'target', isOriginal: true, blocks: null}]),
    'K4-REGISTRY-DETECT-001',
  );
  rejectsCode(
    () => detect([originalTarget('target', {'': hat('wave')})]),
    'K4-REGISTRY-DETECT-001',
  );

  const invalidMutations = [
    null,
    {},
    {tagName: 'mutation', children: [], dsl4action: '{'},
    {tagName: 'wrong', children: [], dsl4action: '{}'},
    {tagName: 'mutation', children: [{}], dsl4action: '{}'},
    {tagName: 'mutation', children: [], dsl4Action: '{}'},
    {...mutation(declaration('wave')), unexpected: true},
    mutation(null),
    mutation({...declaration('wave'), version: 2}),
    mutation({...declaration('wave'), target: 'global'}),
    mutation({...declaration('wave'), parameters: {}}),
    mutation({...declaration('wave'), unexpected: true}),
    mutation({version: 1, name: 'wave', target: 'actor'}),
    mutation(declaration('wave', {parameters: [null]})),
    mutation(declaration('wave', {parameters: [{name: 'speed'}]})),
    mutation(
      declaration('wave', {
        parameters: [{name: 'speed', type: 'string', unexpected: true}],
      }),
    ),
  ];
  for (const candidate of invalidMutations) {
    rejectsCode(
      () =>
        detect([
          originalTarget('target', {
            valid: hat('valid'),
            invalid: hat('invalid', {mutation: candidate}),
          }),
        ]),
      'K4-REGISTRY-MUTATION-001',
    );
  }
  assert.throws(
    () =>
      detect([
        originalTarget('target', {
          invalid: hat('invalid', {
            mutation: mutation({...declaration('wave'), privateSourceText: 'secret'}),
          }),
        }),
      ]),
    (error) => {
      assert.equal(error.code, 'K4-REGISTRY-MUTATION-001');
      assert.doesNotMatch(error.message, /privateSourceText|secret/u);
      return true;
    },
  );
});

test('enforces every finite detection limit before publishing a snapshot', () => {
  assert.deepEqual(dsl4ActionHatDetectorDefaultLimits, {
    maxOriginalTargets: 256,
    maxTopLevelBlocksPerTarget: 4096,
    maxCustomActions: 64,
    maxParametersPerAction: 16,
    maxNameScalars: 64,
    maxMutationCodeUnits: 8192,
  });
  assert.equal(Object.isFrozen(dsl4ActionHatDetectorDefaultLimits), true);
  for (const limits of [null, {unknown: 1}, {maxCustomActions: 0}, {maxNameScalars: 1.5}]) {
    rejectsCode(() => detect([], {limits}), 'K4-REGISTRY-LIMIT-001');
  }

  rejectsCode(
    () =>
      detect([originalTarget('a', {}), originalTarget('b', {})], {limits: {maxOriginalTargets: 1}}),
    'K4-REGISTRY-LIMIT-001',
  );
  rejectsCode(
    () =>
      detect(
        [
          originalTarget('target', {
            a: {opcode: 'event_whenflagclicked', topLevel: true},
            b: {opcode: 'event_whenflagclicked', topLevel: true},
          }),
        ],
        {limits: {maxTopLevelBlocksPerTarget: 1}},
      ),
    'K4-REGISTRY-LIMIT-001',
  );
  rejectsCode(
    () =>
      detect([originalTarget('target', {a: hat('a'), b: hat('b')})], {
        limits: {maxCustomActions: 1},
      }),
    'K4-REGISTRY-LIMIT-001',
  );
  rejectsCode(
    () =>
      detect(
        [
          originalTarget('target', {
            handler: hat('wave', {
              mutation: mutation(
                declaration('wave', {
                  parameters: [
                    {name: 'a', type: 'string'},
                    {name: 'b', type: 'string'},
                  ],
                }),
              ),
            }),
          }),
        ],
        {limits: {maxParametersPerAction: 1}},
      ),
    'K4-REGISTRY-LIMIT-001',
  );
  rejectsCode(
    () => detect([originalTarget('target', {handler: hat('ab')})], {limits: {maxNameScalars: 1}}),
    'K4-REGISTRY-LIMIT-001',
  );
  rejectsCode(
    () =>
      detect([originalTarget('target', {handler: hat('wave')})], {
        limits: {maxMutationCodeUnits: 1},
      }),
    'K4-REGISTRY-LIMIT-001',
  );
});

test('delegates duplicate, core collision, and identifier rules to the canonical registry', () => {
  for (const blocks of [
    {a: hat('wave'), b: hat('wave')},
    {a: hat('wait')},
    {a: hat('bad name')},
    {
      a: hat('wave', {
        mutation: mutation(
          declaration('wave', {
            parameters: [
              {name: 'speed', type: 'string'},
              {name: 'speed', type: 'number'},
            ],
          }),
        ),
      }),
    },
  ]) {
    assert.throws(
      () => detect([originalTarget('target', blocks)]),
      (error) =>
        error instanceof Dsl4ActionRegistryError &&
        (error.code === 'K4-REGISTRY-COLLISION-001' || error.code === 'K4-REGISTRY-NAME-001'),
    );
  }
});
