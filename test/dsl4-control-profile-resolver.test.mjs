import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {createDsl4SourceFrontend, resolveDsl4ControlProfile} from '../src/dsl4/index.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const schema = JSON.parse(
  await readFile(path.join(projectRoot, 'schema', 'dsl-4.schema.json'), 'utf8'),
);
const frontend = createDsl4SourceFrontend(schema);

function parseStory(source) {
  const result = frontend.parse(source, {sourceId: 'profile-test.kamishibai.yaml'});
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  return result.storyDocument;
}

const profileStorySource = `
kamishibai: '4.0'
controls:
  keymaps:
    development:
      Space: navigation.nextAction
      ArrowLeft: history.previousAction
      ArrowUp: history.previousScene
      ArrowDown: history.nextScene
    production:
      Space: navigation.nextAction
scenes:
  opening: []
`;

test('requires an explicit control profile', () => {
  const story = parseStory(profileStorySource);
  for (const profile of [undefined, null, '']) {
    const result = resolveDsl4ControlProfile(story, profile);
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics[0].code, 'K4-KEYMAP-PROFILE-REQUIRED');
  }
});

test('rejects an unknown profile and a StoryDocument without controls', () => {
  const story = parseStory(profileStorySource);
  for (const profile of ['rehearsal', '__proto__', 'constructor']) {
    const unknown = resolveDsl4ControlProfile(story, profile);
    assert.equal(unknown.ok, false);
    assert.equal(unknown.diagnostics[0].code, 'K4-KEYMAP-PROFILE-UNKNOWN');
  }

  const noControls = parseStory(`
kamishibai: '4.0'
scenes:
  opening: []
`);
  const missing = resolveDsl4ControlProfile(noControls, 'production');
  assert.equal(missing.ok, false);
  assert.equal(missing.diagnostics[0].code, 'K4-KEYMAP-PROFILE-UNKNOWN');
});

test('resolves only the selected complete profile without inheritance or fallback', () => {
  const story = parseStory(profileStorySource);
  const production = resolveDsl4ControlProfile(story, 'production');
  assert.equal(production.ok, true);
  assert.deepEqual(production.keymap, {Space: 'navigation.nextAction'});
  assert.equal(production.historyEnabled, false);
  assert.equal(Object.hasOwn(production.keymap, 'ArrowLeft'), false);

  const development = resolveDsl4ControlProfile(story, 'development', {
    historyNavigationAvailable: true,
  });
  assert.equal(development.ok, true);
  assert.equal(development.historyEnabled, true);
  assert.deepEqual(Object.keys(development.keymap), ['ArrowDown', 'ArrowLeft', 'ArrowUp', 'Space']);
});

test('canonical keymap is independent of YAML key order', () => {
  const first = parseStory(`
kamishibai: '4.0'
controls:
  keymaps:
    production:
      Space: navigation.nextAction
      Enter: history.previousAction
scenes:
  opening: []
`);
  const second = parseStory(`
kamishibai: '4.0'
controls:
  keymaps:
    production:
      Enter: history.previousAction
      Space: navigation.nextAction
scenes:
  opening: []
`);
  const options = {historyNavigationAvailable: true};
  const firstResult = resolveDsl4ControlProfile(first, 'production', options);
  const secondResult = resolveDsl4ControlProfile(second, 'production', options);
  assert.equal(firstResult.ok, true);
  assert.equal(secondResult.ok, true);
  assert.deepEqual(firstResult.keymap, secondResult.keymap);
  assert.equal(firstResult.canonicalKeymap, secondResult.canonicalKeymap);
  assert.equal(
    firstResult.canonicalKeymap,
    '{"Enter":"history.previousAction","Space":"navigation.nextAction"}',
  );
});

test('returns frozen copies without changing StoryDocument', () => {
  const story = parseStory(profileStorySource);
  const originalKeymap = story.controls.keymaps.production;
  const result = resolveDsl4ControlProfile(story, 'production');
  assert.equal(result.ok, true);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.keymap), true);
  assert.notStrictEqual(result.keymap, originalKeymap);
  assert.deepEqual(story.controls.keymaps.production, {Space: 'navigation.nextAction'});
});

test('fails closed when the selected profile needs unavailable history navigation', () => {
  const story = parseStory(profileStorySource);
  const unavailable = resolveDsl4ControlProfile(story, 'development');
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.diagnostics[0].code, 'K4-KEYMAP-HISTORY-UNAVAILABLE');

  const available = resolveDsl4ControlProfile(story, 'development', {
    historyNavigationAvailable: true,
  });
  assert.equal(available.ok, true);
  assert.equal(available.historyEnabled, true);

  const production = resolveDsl4ControlProfile(story, 'production');
  assert.equal(production.ok, true);
  assert.equal(production.historyEnabled, false);
});

test('profile diagnostics use the versioned K4 envelope', () => {
  const story = parseStory(profileStorySource);
  const result = resolveDsl4ControlProfile(story, 'unknown');
  const diagnostic = result.diagnostics[0];
  assert.deepEqual(
    {
      version: diagnostic.version,
      severity: diagnostic.severity,
      sourceId: diagnostic.sourceId,
      related: diagnostic.related,
    },
    {
      version: 1,
      severity: 'error',
      sourceId: 'profile-test.kamishibai.yaml',
      related: [],
    },
  );
  assert.ok(diagnostic.range.start.line >= 1);
});

test('control profile resolver has no filesystem, network, DOM, VM, or Scratch dependency', async () => {
  const implementation = await readFile(
    path.join(projectRoot, 'src', 'dsl4', 'control-profile-resolver.js'),
    'utf8',
  );
  assert.doesNotMatch(implementation, /(?:node:fs|node:http|node:https|\bfetch\s*\()/);
  assert.doesNotMatch(
    implementation,
    /(?:globalThis\.(?:document|window)|KeyboardEvent|addEventListener)/,
  );
  assert.doesNotMatch(implementation, /(?:\bScratch\b|scratch-vm|vm\.runtime|startHats)/);
});
