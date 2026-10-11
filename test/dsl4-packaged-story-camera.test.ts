import assert from 'node:assert/strict';
import {test} from 'vitest';

import {packagedStoryUsesPoseRecognition} from '../src/dsl4/platform/packaged-story-camera.js';

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
