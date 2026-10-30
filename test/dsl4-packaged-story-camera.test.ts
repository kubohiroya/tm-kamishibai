import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'vitest';

import {
  createDsl4CameraProjectContext,
  packagedStoryUsesPoseRecognition,
} from '../src/dsl4/platform/packaged-story-camera.js';
import {createDsl4ProductionSourceFrontend} from '../src/dsl4/production-source-frontend.js';

const poseDocument = {
  scenes: [
    {id: 'opening', actions: [{command: 'say', text: 'hello'}]},
    {id: 'guard', actions: [{command: 'pose', steps: [{pose: 'guard'}]}]},
  ],
};
const plainDocument = {scenes: [{id: 'opening', actions: [{command: 'say', text: 'hello'}]}]};

function packaged(text: unknown, {nested = true} = {}) {
  const component = {application: {mode: 'story'}, source: {text}};
  return nested
    ? {
        extensionStorage: {
          kubohiroyakamishibai4: {components: {kubohiroyakamishibairuntime4: component}},
        },
      }
    : {extensionStorage: {kubohiroyakamishibairuntime4: component}};
}

// The real frontend answers with `storyDocument`, so this fake has to as well: a fake that
// invents its own member names tests the test.
const frontendFor = (storyDocument: Record<string, unknown>, ok = true) =>
  ({
    parse(source: string) {
      assert.equal(typeof source, 'string');
      return ok
        ? {ok: true as const, canonicalSource: source, diagnostics: [], storyDocument}
        : {ok: false as const, canonicalSource: source, diagnostics: []};
    },
  }) as unknown as Parameters<typeof packagedStoryUsesPoseRecognition>[0];

test('offers the camera for a packaged story that recognises a pose', () => {
  assert.equal(
    packagedStoryUsesPoseRecognition(frontendFor(poseDocument), packaged('kamishibai: "4.0"')),
    true,
  );
  // The component lives in either place depending on which writer produced the artifact.
  assert.equal(
    packagedStoryUsesPoseRecognition(
      frontendFor(poseDocument),
      packaged('kamishibai: "4.0"', {nested: false}),
    ),
    true,
  );
});

test('stays quiet for a story with no pose, no source, or no project', () => {
  assert.equal(
    packagedStoryUsesPoseRecognition(frontendFor(plainDocument), packaged('kamishibai: "4.0"')),
    false,
  );
  assert.equal(packagedStoryUsesPoseRecognition(frontendFor(poseDocument), packaged('')), false);
  assert.equal(packagedStoryUsesPoseRecognition(frontendFor(poseDocument), packaged(42)), false);
  assert.equal(packagedStoryUsesPoseRecognition(frontendFor(poseDocument), {}), false);
  assert.equal(packagedStoryUsesPoseRecognition(frontendFor(poseDocument), null), false);
});

test('offers nothing when the source will not parse', () => {
  // A story that cannot be read will fail on its own terms. Asking for a camera first would put a
  // permission prompt in front of an error.
  assert.equal(
    packagedStoryUsesPoseRecognition(frontendFor(poseDocument, false), packaged('nonsense')),
    false,
  );
  assert.equal(
    packagedStoryUsesPoseRecognition(
      {
        parse() {
          throw new Error('unreadable');
        },
      } as unknown as Parameters<typeof packagedStoryUsesPoseRecognition>[0],
      packaged('nonsense'),
    ),
    false,
  );
});

const schema = JSON.parse(
  await readFile(new URL('../schema/dsl-4.schema.json', import.meta.url), 'utf8'),
);
const realFrontend = createDsl4ProductionSourceFrontend(schema);
const implicitPoseSource = `kamishibai: '4.0'
assets:
  GuardModel:
    kind: recognitionModel
    file: guard-model
scenes:
  guard:
    recognitionModel: GuardModel
    actions:
      - stage: Classroom
      - Student.pose:
          steps:
            - pose: guard
              skin: ProtectHead
`;

function runtimeTargets() {
  const backdrop = {name: 'Classroom', bitmapResolution: 1};
  const costume = {name: 'ProtectHead', bitmapResolution: 2};
  Object.defineProperty(costume, 'asset', {
    get() {
      assert.fail('camera detection must not read media bytes');
    },
  });
  return [
    {
      isStage: true,
      isOriginal: true,
      getName: () => 'Stage',
      getCostumes: () => [backdrop],
      getSounds: () => [],
      variables: {},
    },
    {
      isStage: false,
      isOriginal: true,
      getName: () => 'Student',
      getCostumes: () => [costume],
      getSounds: () => [],
      variables: {
        actor: {name: 'actorName', type: '', value: 'Student'},
        ignored: {name: 'unrelated', value: 'do not retain'},
      },
    },
    {
      isStage: false,
      isOriginal: false,
      getName: () => 'Student',
      getCostumes: () => [costume],
      getSounds: () => [],
      variables: {},
    },
  ];
}

test('uses the canonical project context for a pose story with implicit actors and media', () => {
  assert.equal(
    realFrontend.parse(implicitPoseSource).ok,
    false,
    'source alone cannot resolve implicit project declarations',
  );
  const context = createDsl4CameraProjectContext(runtimeTargets());
  assert.equal(realFrontend.parse(implicitPoseSource, {project: context}).ok, true);
  assert.equal(
    packagedStoryUsesPoseRecognition(realFrontend, {...context, ...packaged(implicitPoseSource)}),
    true,
  );
  assert.equal(
    context.targets.length,
    2,
    'runtime clones must not create ambiguous implicit actors',
  );
  assert.deepEqual(context.targets[1]?.variables, {actor: ['actorName', 'Student']});
  assert.deepEqual(context.targets[1]?.costumes, [{name: 'ProtectHead', bitmapResolution: 2}]);
});

test('keeps implicit-project detection fail-closed for absent or ambiguous metadata', () => {
  assert.equal(packagedStoryUsesPoseRecognition(realFrontend, packaged(implicitPoseSource)), false);
  const targets = runtimeTargets();
  const student = targets[1];
  assert(student);
  assert.equal(
    packagedStoryUsesPoseRecognition(realFrontend, {
      ...createDsl4CameraProjectContext(targets.slice(0, 1)),
      ...packaged(implicitPoseSource),
    }),
    false,
  );
  assert.equal(
    packagedStoryUsesPoseRecognition(realFrontend, {
      ...createDsl4CameraProjectContext([...targets, student]),
      ...packaged(implicitPoseSource),
    }),
    false,
  );
  const plainSource = implicitPoseSource.replace(
    'Student.pose:\n          steps:\n            - pose: guard\n              skin: ProtectHead',
    'Student.say: hello',
  );
  assert.equal(
    packagedStoryUsesPoseRecognition(realFrontend, {
      ...createDsl4CameraProjectContext(targets),
      ...packaged(plainSource),
    }),
    false,
  );
});

test('keeps self-contained pose source independent from runtime target declarations', () => {
  const explicitSource = implicitPoseSource.replace(
    'scenes:\n',
    `  Classroom:
    kind: backdrop
    file: classroom.svg
  ProtectHead:
    kind: costume
    target: Student
    file: protect-head.svg
actors:
  Student: ProtectHead
cover:
  backdrop: Classroom
scenes:
`,
  );
  assert.equal(realFrontend.parse(explicitSource).ok, true);
  assert.equal(
    packagedStoryUsesPoseRecognition(realFrontend, {
      ...createDsl4CameraProjectContext([]),
      ...packaged(explicitSource),
    }),
    true,
  );
});
