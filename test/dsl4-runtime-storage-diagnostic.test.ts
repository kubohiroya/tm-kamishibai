import assert from 'node:assert/strict';
import {test} from 'vitest';

import {createDsl4RuntimeWarningIndicator} from '../src/dsl4/platform/runtime-warning-indicator.js';
import {
  createDsl4SessionBackingFatalDiagnostic,
  createDsl4SessionBackingWarningDiagnostic,
} from '../src/dsl4/platform/session-backing-diagnostic.js';
import {createFakeDocument, findByAttribute, requireByAttribute} from './helpers/fake-dom.ts';
import {requireDefined} from './helpers/require-value.ts';

test('projects bounded localized session backing recovery guidance without payload data', () => {
  const warning = createDsl4SessionBackingWarningDiagnostic(
    {
      code: 'ASSET_SESSION_BINARY_DIRECT_FALLBACK',
      causeCode: 'ASSET_SESSION_BINARY_QUOTA_EXCEEDED',
      bytes: 'do-not-render',
      path: '/private/model.bin',
    },
    'ja',
  );
  assert.equal(
    warning.code,
    'ASSET_SESSION_BINARY_DIRECT_FALLBACK (ASSET_SESSION_BINARY_QUOTA_EXCEEDED)',
  );
  assert.match(warning.message, /直接読み込んで続行/u);
  assert.doesNotMatch(JSON.stringify(warning), /do-not-render|private/u);

  const cases = [
    ['ASSET_SESSION_BINARY_QUOTA_EXCEEDED', /site data|direct ZIP\/Electron/iu],
    ['ASSET_SESSION_BINARY_INDEXEDDB_BLOCKED', /Close other copies/iu],
    ['ASSET_SESSION_BINARY_CORRUPT', /missing or damaged/iu],
    ['ASSET_SESSION_BINARY_SOURCE_INTEGRITY_MISMATCH', /Rebuild the SB3/iu],
    ['ASSET_SESSION_BINARY_INDEXEDDB_UNAVAILABLE', /browser storage settings/iu],
  ] as const;
  // The table pairs a code with the pattern its message must match; `as const` keeps each entry a
  // tuple so `expected` stays a RegExp rather than widening to `string | RegExp`.
  for (const [code, expected] of cases) {
    const diagnostic = createDsl4SessionBackingFatalDiagnostic({code}, 'en');
    assert.equal(diagnostic.code, code);
    assert.match(diagnostic.message, expected);
  }
  const nested = createDsl4SessionBackingFatalDiagnostic(
    {
      code: 'ASSET_SESSION_BINARY_SOURCE_READ_FAILED',
      cause: {code: 'K4-ASSET-ENTRY-INTEGRITY-001'},
    },
    'en',
  );
  assert.equal(
    nested.code,
    'ASSET_SESSION_BINARY_SOURCE_READ_FAILED (K4-ASSET-ENTRY-INTEGRITY-001)',
  );
  assert.match(nested.message, /Rebuild the SB3/iu);
});

test('renders and dismisses a non-modal warning inside its mount', () => {
  const document = createFakeDocument();
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  const indicator = createDsl4RuntimeWarningIndicator({document, mount});
  indicator.show({message: 'Direct source fallback', code: 'FALLBACK'});
  const root = requireByAttribute(mount, 'data-dsl4-runtime-warning', 'true');
  assert.equal(root.getAttribute('role'), 'status');
  assert.equal(root.style.display, 'flex');
  const [message, code, dismiss] = root.children;
  assert.equal(
    requireDefined(message, 'the warning message node').textContent,
    'Direct source fallback',
  );
  assert.equal(requireDefined(code, 'the warning code node').textContent, 'FALLBACK');
  assert.equal(requireDefined(dismiss, 'the warning dismiss node').style.cursor, 'pointer');
  requireDefined(dismiss, 'the warning dismiss node').click();
  assert.equal(root.style.display, 'none');
  indicator.dispose();
  assert.equal(findByAttribute(mount, 'data-dsl4-runtime-warning', 'true').length, 0);
});
