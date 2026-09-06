import assert from 'node:assert/strict';
import {test} from 'vitest';

import {
  dsl4DefaultFeatureFlags,
  dsl4StandardProductionFeatureFlags,
  resolveDsl4FeatureFlags,
} from '../src/dsl4/index.js';
import {
  decodeDsl5Envelope,
  Dsl5FormatError,
  dsl5DefaultFeatureFlags,
  dsl5DefaultResourceLimits,
  dsl5FormatVersions,
  dsl5SourceVersion,
  requireDsl5SourceVersion,
  resolveDsl5FeatureFlags,
  resolveDsl5ResourceLimits,
} from '../src/dsl5/index.js';

test('accepts only the exact 5.0 source version and names 4.0 as a conversion', () => {
  assert.equal(requireDsl5SourceVersion('5.0'), dsl5SourceVersion);
  assert.throws(() => requireDsl5SourceVersion('4.0'), /convert the document to 5\.0/u);
  assert.throws(() => requireDsl5SourceVersion('4.0'), /K5-VERSION-001|kamishibai/u);
  for (const rejected of ['5', '5.0.0', '5.1', '', null, undefined, 5, {}]) {
    assert.throws(() => requireDsl5SourceVersion(rejected), Dsl5FormatError);
  }
});

test('versions the five formats independently', () => {
  assert.deepEqual(Object.keys(dsl5FormatVersions).sort(), [
    'compiledArtifact',
    'publicationManifest',
    'saveData',
    'sealedArtifact',
    'storyDocument',
  ]);
  assert.equal(Object.isFrozen(dsl5FormatVersions), true);
  // Every format starts at 1 and moves on its own; nothing derives one version from another.
  for (const version of Object.values(dsl5FormatVersions)) assert.equal(version, 1);
});

const saveDataSpec = {
  kind: 'saveData',
  requiredKeys: ['storyId', 'variables'],
  optionalKeys: ['savedAt'],
} as const;

test('reads a well-formed envelope and hands back the record itself', () => {
  const envelope = {formatVersion: 1, storyId: 'story', variables: {score: 2}};
  assert.strictEqual(decodeDsl5Envelope(envelope, saveDataSpec), envelope);
  assert.doesNotThrow(() =>
    decodeDsl5Envelope({...envelope, savedAt: '2026-09-06T00:00:00Z'}, saveDataSpec),
  );
});

test('fails closed on shape, version, unknown keys, and missing keys alike', () => {
  const valid = {formatVersion: 1, storyId: 'story', variables: {}};
  const cases: readonly [unknown, RegExp][] = [
    [null, /must be an object/u],
    ['{}', /must be an object/u],
    [[valid], /must be an object/u],
    [{...valid, formatVersion: 2}, /formatVersion must be 1/u],
    [{...valid, formatVersion: '1'}, /formatVersion must be 1/u],
    [{storyId: 'story', variables: {}}, /formatVersion must be 1/u],
    // An unknown key is what a newer writer's extra member looks like. Dropping it silently is the
    // failure this decoder exists to prevent, so it is refused rather than ignored.
    [{...valid, checkpoint: 3}, /does not declare: checkpoint/u],
    [{formatVersion: 1, storyId: 'story'}, /missing required keys: variables/u],
    [{formatVersion: 1}, /missing required keys: storyId, variables/u],
  ];
  for (const [value, message] of cases) {
    assert.throws(() => decodeDsl5Envelope(value, saveDataSpec), message);
  }
});

test('reports the format that was refused so callers can map it to their own diagnostics', () => {
  try {
    decodeDsl5Envelope({formatVersion: 9}, saveDataSpec);
    assert.fail('expected the decoder to refuse the envelope');
  } catch (error) {
    assert.ok(error instanceof Dsl5FormatError);
    assert.equal(error.kind, 'saveData');
    assert.equal(error.code, 'K5-FORMAT-VERSION-001');
  }
});

test('defaults every 5.0 capability off and resolves an immutable snapshot', () => {
  assert.deepEqual(dsl5DefaultFeatureFlags, {
    dsl5NarrativeCore: false,
    dsl5Persistence: false,
    dsl5ProjectAppShell: false,
    dsl5PublicationSegments: false,
    dsl5ReadingUx: false,
    dsl5AssetGroups: false,
    dsl5AudioLifecycle: false,
    dsl5RichText: false,
    dsl5PresentationEffects: false,
    dsl5Viewport: false,
    dsl5Video: false,
    dsl5CompiledArtifact: false,
    dsl5SealedArtifact: false,
  });
  assert.equal(Object.isFrozen(dsl5DefaultFeatureFlags), true);

  const resolved = resolveDsl5FeatureFlags();
  assert.deepEqual(resolved, dsl5DefaultFeatureFlags);
  assert.equal(Object.isFrozen(resolved), true);
  assert.equal(Object.isFrozen(resolveDsl5FeatureFlags({dsl5Viewport: true})), true);
});

test('refuses an unknown flag, a non-boolean, and a non-record', () => {
  assert.throws(
    () => resolveDsl5FeatureFlags({dsl4Runtime: true}),
    /Unknown DSL 5\.0 feature flag/u,
  );
  assert.throws(() => resolveDsl5FeatureFlags({dsl5Video: 'true'}), /must be boolean/u);
  assert.throws(() => resolveDsl5FeatureFlags(null), /must be an object/u);
  assert.throws(() => resolveDsl5FeatureFlags([]), /must be an object/u);
});

test('holds each capability to the flags it reads from', () => {
  assert.throws(
    () => resolveDsl5FeatureFlags({dsl5Persistence: true}),
    /requires dsl5NarrativeCore/u,
  );
  assert.throws(
    () => resolveDsl5FeatureFlags({dsl5ProjectAppShell: true, dsl5Persistence: true}),
    /dsl5Persistence requires dsl5NarrativeCore/u,
  );
  assert.throws(
    () =>
      resolveDsl5FeatureFlags({
        dsl5Video: true,
        dsl5PublicationSegments: true,
        dsl5AssetGroups: true,
      }),
    /dsl5Video requires dsl5Viewport/u,
  );
  assert.throws(
    () => resolveDsl5FeatureFlags({dsl5SealedArtifact: true}),
    /dsl5SealedArtifact requires dsl5CompiledArtifact/u,
  );

  // A consistent chain resolves, which is what proves the requirements are satisfiable at all.
  const video = resolveDsl5FeatureFlags({
    dsl5PublicationSegments: true,
    dsl5AssetGroups: true,
    dsl5Viewport: true,
    dsl5Video: true,
  });
  assert.equal(video.dsl5Video, true);
  assert.equal(video.dsl5NarrativeCore, false);
});

test('bounds every declared resource and rejects one that is not finite and positive', () => {
  assert.equal(Object.isFrozen(dsl5DefaultResourceLimits), true);
  for (const [name, value] of Object.entries(dsl5DefaultResourceLimits)) {
    assert.ok(Number.isSafeInteger(value) && value > 0, `${name} is not a positive safe integer`);
  }
  // The source and asset bounds carry over from DSL 4.0 so a converted 4.0 story is not newly
  // rejected by a tighter 5.0 reader.
  assert.equal(dsl5DefaultResourceLimits.maxSourceBytes, 1024 * 1024);
  assert.equal(dsl5DefaultResourceLimits.maxSourceFiles, 64);
  assert.equal(dsl5DefaultResourceLimits.maxTotalSourceBytes, 4 * 1024 * 1024);
  assert.equal(dsl5DefaultResourceLimits.maxIncludeDepth, 32);

  assert.throws(() => resolveDsl5ResourceLimits({maxSegments: Infinity}), /positive safe integer/u);
  assert.throws(() => resolveDsl5ResourceLimits({maxSegments: 0}), /positive safe integer/u);
  assert.throws(() => resolveDsl5ResourceLimits({maxSegments: -1}), /positive safe integer/u);
  assert.throws(() => resolveDsl5ResourceLimits({maxSegments: 1.5}), /positive safe integer/u);
  assert.throws(() => resolveDsl5ResourceLimits({maxSegments: '8'}), /positive safe integer/u);
  assert.throws(
    () => resolveDsl5ResourceLimits({maxThings: 8}),
    /Unknown DSL 5\.0 resource limit/u,
  );
  assert.throws(
    () => resolveDsl5ResourceLimits({maxTotalSourceBytes: 1024}),
    /maxTotalSourceBytes must be greater than or equal to maxSourceBytes/u,
  );

  const tightened = resolveDsl5ResourceLimits({maxSegments: 4});
  assert.equal(tightened.maxSegments, 4);
  assert.equal(tightened.maxCachedDocuments, dsl5DefaultResourceLimits.maxCachedDocuments);
  assert.equal(Object.isFrozen(tightened), true);
});

test('leaves the DSL 4.0 flag surface untouched', () => {
  // Nothing in `src/dsl5` may reach into the 4.0 snapshot. If a 5.0 name appeared here, a 4.0
  // artifact could be built carrying a capability its runtime does not implement.
  const dsl4Names = Object.keys(dsl4DefaultFeatureFlags);
  assert.equal(
    dsl4Names.some((name) => name.startsWith('dsl5')),
    false,
  );
  assert.equal(
    Object.keys(dsl4StandardProductionFeatureFlags).some((name) => name.startsWith('dsl5')),
    false,
  );
  // The 4.0 resolver still refuses a 5.0 flag as unknown, so a 5.0 option cannot ride into a 4.0
  // startup by being passed along with the rest.
  assert.throws(
    () => resolveDsl4FeatureFlags({dsl5NarrativeCore: true}),
    /Unknown DSL 4\.0 feature flag: dsl5NarrativeCore/u,
  );
  assert.throws(
    () => resolveDsl4FeatureFlags({dsl4Runtime: true, dsl5Video: true}),
    /Unknown DSL 4\.0 feature flag: dsl5Video/u,
  );
});
