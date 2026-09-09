import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {test} from 'vitest';
import {fileURLToPath} from 'node:url';

import {createDsl4SourceFrontend, resolveDsl4ControlProfile} from '../src/dsl4/index.js';
import {requireDefined, requireRecord} from './helpers/require-value.ts';

/** One diagnostic the resolver reports, as this suite reads it. */
interface ControlProfileDiagnostic {
  code: string;
  version: number;
  severity: string;
  sourceId: string;
  related: readonly unknown[];
  range: {start: {line: number; column: number}};
}

interface ResolvedControlProfile {
  keymap: Readonly<Record<string, string>>;
  canonicalKeymap: string;
  historyEnabled: boolean;
}

interface RefusedControlProfile {
  diagnostics: readonly ControlProfileDiagnostic[];
}

/**
 * The two shapes `resolveDsl4ControlProfile` returns, read by the outcome the case expects.
 *
 * `ok` is a plain boolean rather than a literal, so the union does not narrow on it. Each reader
 * asserts the outcome it names and then hands back the members that outcome carries, which is the
 * assertion the cases used to make on their own line.
 */
function resolvedProfile(result: unknown): ResolvedControlProfile {
  const resolution = requireRecord(result, 'the control profile resolution');
  assert.equal(resolution.ok, true, JSON.stringify(resolution.diagnostics));
  return resolution as unknown as ResolvedControlProfile;
}

function refusedProfile(result: unknown): RefusedControlProfile {
  const resolution = requireRecord(result, 'the control profile resolution');
  assert.equal(resolution.ok, false);
  return resolution as unknown as RefusedControlProfile;
}

/** Read the diagnostic a refusal is about. */
function firstDiagnostic(result: unknown): ControlProfileDiagnostic {
  return requireDefined(refusedProfile(result).diagnostics[0], 'the first diagnostic');
}

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const schema = JSON.parse(
  await readFile(path.join(projectRoot, 'schema', 'dsl-4.schema.json'), 'utf8'),
);
const frontend = createDsl4SourceFrontend(schema);

function parseStory(source: string) {
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
      Space: rehearsal.skipPose
    rehearsal:
      Space: rehearsal.skipPose
      ArrowRight: rehearsal.skipAction
      ArrowDown: rehearsal.skipScene
scenes:
  opening: []
`;

test('requires an explicit control profile', () => {
  const story = parseStory(profileStorySource);
  for (const profile of [undefined, null, '']) {
    assert.equal(
      firstDiagnostic(resolveDsl4ControlProfile(story, profile)).code,
      'K4-KEYMAP-PROFILE-REQUIRED',
    );
  }
});

test('rejects an unknown profile and a StoryDocument without controls', () => {
  const story = parseStory(profileStorySource);
  for (const profile of ['missing', '__proto__', 'constructor']) {
    assert.equal(
      firstDiagnostic(resolveDsl4ControlProfile(story, profile)).code,
      'K4-KEYMAP-PROFILE-UNKNOWN',
    );
  }

  const noControls = parseStory(`
kamishibai: '4.0'
scenes:
  opening: []
`);
  assert.equal(
    firstDiagnostic(resolveDsl4ControlProfile(noControls, 'production')).code,
    'K4-KEYMAP-PROFILE-UNKNOWN',
  );
});

test('resolves only the selected complete profile without inheritance or fallback', () => {
  const story = parseStory(profileStorySource);
  const production = resolvedProfile(resolveDsl4ControlProfile(story, 'production'));
  assert.deepEqual(production.keymap, {Space: 'rehearsal.skipPose'});
  assert.equal(production.historyEnabled, false);
  assert.equal(Object.hasOwn(production.keymap, 'ArrowLeft'), false);

  const rehearsal = resolvedProfile(resolveDsl4ControlProfile(story, 'rehearsal'));
  assert.equal(rehearsal.historyEnabled, false);
  assert.deepEqual(rehearsal.keymap, {
    ArrowDown: 'rehearsal.skipScene',
    ArrowRight: 'rehearsal.skipAction',
    Space: 'rehearsal.skipPose',
  });

  const development = resolvedProfile(
    resolveDsl4ControlProfile(story, 'development', {historyNavigationAvailable: true}),
  );
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
  const firstResult = resolvedProfile(resolveDsl4ControlProfile(first, 'production', options));
  const secondResult = resolvedProfile(resolveDsl4ControlProfile(second, 'production', options));
  assert.deepEqual(firstResult.keymap, secondResult.keymap);
  assert.equal(firstResult.canonicalKeymap, secondResult.canonicalKeymap);
  assert.equal(
    firstResult.canonicalKeymap,
    '{"Enter":"history.previousAction","Space":"navigation.nextAction"}',
  );
});

test('returns frozen copies without changing StoryDocument', () => {
  const story = parseStory(profileStorySource);
  const keymaps = requireRecord(
    requireRecord(requireRecord(story, 'the story document').controls, 'controls').keymaps,
    'keymaps',
  );
  const originalKeymap = keymaps.production;
  const raw = resolveDsl4ControlProfile(story, 'production');
  const result = resolvedProfile(raw);
  assert.equal(Object.isFrozen(raw), true);
  assert.equal(Object.isFrozen(result.keymap), true);
  assert.notStrictEqual(result.keymap, originalKeymap);
  assert.deepEqual(keymaps.production, {Space: 'rehearsal.skipPose'});
});

test('fails closed when the selected profile needs unavailable history navigation', () => {
  const story = parseStory(profileStorySource);
  assert.equal(
    firstDiagnostic(resolveDsl4ControlProfile(story, 'development')).code,
    'K4-KEYMAP-HISTORY-UNAVAILABLE',
  );

  const available = resolvedProfile(
    resolveDsl4ControlProfile(story, 'development', {historyNavigationAvailable: true}),
  );
  assert.equal(available.historyEnabled, true);

  const production = resolvedProfile(resolveDsl4ControlProfile(story, 'production'));
  assert.equal(production.historyEnabled, false);
});

test('profile diagnostics use the versioned K4 envelope', () => {
  const story = parseStory(profileStorySource);
  const diagnostic = firstDiagnostic(resolveDsl4ControlProfile(story, 'unknown'));
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
