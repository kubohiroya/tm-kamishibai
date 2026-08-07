import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(
  new URL('fixtures/dsl4/standard-app-shell-browser.html', import.meta.url),
  'utf8',
);
const moduleSource = await readFile(
  new URL('fixtures/dsl4/standard-app-shell-browser.mjs', import.meta.url),
  'utf8',
);

test('keeps the Standard app-shell real-browser fixture deterministic and local', () => {
  assert.match(html, /standard-app-shell-browser\.mjs/u);
  assert.match(html, /id="standard-app-shell-mount"/u);
  assert.match(moduleSource, /createDsl4StandardAppShell/u);
  assert.match(moduleSource, /surface: 'developmentPreview'/u);
  assert.match(moduleSource, /phase: 'charging'/u);
  assert.match(moduleSource, /shell\.dispose\('browser-fixture'\)/u);
  assert.doesNotMatch(moduleSource, /fetch\(|localStorage|sessionStorage/u);
});
