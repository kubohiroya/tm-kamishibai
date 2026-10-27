import assert from 'node:assert/strict';
import {test} from 'vitest';

import {serializeReleasePlayerHtml} from '../scripts/build-release-player.ts';

const chunk = (data: string, size = 4) => `<script data="${data}">decodeChunk(${size})</script>`;

test('serializes all project chunks while preserving the surrounding document', () => {
  const before = '<!doctype html><title>Keep ~ text</title><script>const value = "~";</script>';
  const after = '<p data="~">Keep ~ text</p>';
  assert.equal(
    serializeReleasePlayerHtml(before + chunk('~****') + chunk('~****', 1) + after),
    before + chunk('&#126;****') + chunk('&#126;****', 1) + after,
  );
});

test('retains the Base85 alphabet and decodes to the same bytes', () => {
  const bytes = Uint8Array.from({length: 256}, (_, index) => index);
  const data = Array.from({length: bytes.length / 4}, (_, index) => {
    let value = new DataView(bytes.buffer).getUint32(index * 4, true);
    return Array.from({length: 5}, () => {
      const code = (value % 85) + 42;
      value = Math.floor(value / 85);
      return String.fromCharCode(code === 60 ? 40 : code === 62 ? 41 : code);
    }).join('');
  }).join('');
  const serialized = serializeReleasePlayerHtml(chunk(data, bytes.length));
  const attribute = serialized.match(/data="([^"]*)"/u)?.[1];
  assert(attribute);
  const domValue = attribute.replaceAll('&#126;', '~');
  assert.equal(domValue, data);
  const decoded = new Uint8Array(bytes.length);
  const view = new DataView(decoded.buffer);
  for (let offset = 0; offset < domValue.length; offset += 5) {
    let value = 0;
    for (let digit = 4; digit >= 0; digit -= 1) {
      const code = domValue.charCodeAt(offset + digit);
      value = value * 85 + (code === 40 ? 60 : code === 41 ? 62 : code) - 42;
    }
    view.setUint32((offset / 5) * 4, value, true);
  }
  assert.deepEqual(decoded, bytes);
});

test('is idempotent and leaves chunks without a tilde byte-identical', () => {
  const html = chunk('~****') + chunk('*****');
  const once = serializeReleasePlayerHtml(html);
  assert.equal(serializeReleasePlayerHtml(once), once);
  assert(once.endsWith(chunk('*****')));
});

test('does not rewrite unrelated script attributes or script contents', () => {
  const unrelated =
    '<script data="~****">otherFunction(4)</script>' +
    '<script data-other="~****">decodeChunk(4)</script>';
  assert.equal(
    serializeReleasePlayerHtml(unrelated + chunk('~****')),
    unrelated + chunk('&#126;****'),
  );
});

test('rejects unknown project output and malformed chunks instead of silently publishing them', () => {
  assert.throws(() => serializeReleasePlayerHtml('<html>No chunks</html>'), /Expected Packager/u);
  for (const invalid of [
    chunk('~****', 0),
    chunk('~****', 8),
    chunk('~***'),
    chunk('a&bcd'),
    chunk('&#x7e;****'),
    chunk('~****', Number.MAX_SAFE_INTEGER + 1),
  ]) {
    assert.throws(() => serializeReleasePlayerHtml(invalid), /Invalid Packager/u);
  }
});
