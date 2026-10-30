import assert from 'node:assert/strict';
import {test} from 'vitest';
import {readEmbeddedYamlDocumentViewsFlag} from '../src/dsl4/embedded-yaml-feature-flags.js';

test('document views require the exact launch query value or the existing true global flag', () => {
  for (const search of [
    '',
    '?twPlusYamlEditor=0',
    '?twPlusYamlEditor=false',
    '?twPlusYamlEditor=true',
    '?twPlusYamlEditor=01',
    '?project_url=twPlusYamlEditor%3D1',
  ])
    assert.equal(readEmbeddedYamlDocumentViewsFlag({location: {search}}), false, search);
  assert.equal(
    readEmbeddedYamlDocumentViewsFlag({location: {search: '?lang=ja&twPlusYamlEditor=1'}}),
    true,
  );
  assert.equal(
    readEmbeddedYamlDocumentViewsFlag({
      TW_EMBEDDED_DOCUMENT_VIEWS: true,
      location: {search: '?twPlusYamlEditor=0'},
    }),
    true,
  );
  assert.equal(readEmbeddedYamlDocumentViewsFlag({TW_EMBEDDED_DOCUMENT_VIEWS: 'true'}), false);
});

test('reading in Node or without a browser location is safe and returns a fixed boolean snapshot', () => {
  assert.equal(readEmbeddedYamlDocumentViewsFlag({}), false);
  assert.equal(readEmbeddedYamlDocumentViewsFlag({location: {search: undefined}}), false);
  const environment = {location: {search: '?twPlusYamlEditor=1'}};
  const launchValue = readEmbeddedYamlDocumentViewsFlag(environment);
  environment.location.search = '?twPlusYamlEditor=0';
  assert.equal(launchValue, true);
  assert.equal(readEmbeddedYamlDocumentViewsFlag(environment), false);
});
