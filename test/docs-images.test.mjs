import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import test from 'node:test';

import {documentConfig} from '../docs/config.mjs';

const sources = [documentConfig.coverFilename, documentConfig.sourceFilename].map((filename) =>
  readFileSync(
    new URL(`../docs/${documentConfig.sourceDirectory}/${filename}`, import.meta.url),
    'utf8',
  ),
);
const body = sources.join('\n');
const imageReferences = [
  ...body.matchAll(/!\[[^\]]*\]\(\.\.\/\.\.\/images\/([^)]+)\)(?:\{style="([^"]+)"\})?/gu),
];
const imageDirectory = new URL('../docs/images/', import.meta.url);

test('resolves every local image referenced by the workshop Markdown', () => {
  assert(imageReferences.length > 0);

  for (const [, filename] of imageReferences) {
    assert.match(filename, /\.(?:avif|gif|jpe?g|png|svg|webp)$/iu);
    assert(existsSync(new URL(filename, imageDirectory)), `Missing workshop image: ${filename}`);
  }
});

test('accepts omitted image sizes and validates explicit pixel sizes', () => {
  for (const [, filename, style] of imageReferences) {
    if (!style) {
      continue;
    }
    const size = style.match(/(?:^|;)\s*(?:height|width):\s*([0-9.]+)px;/u);
    if (size) {
      assert(Number(size[1]) > 0, `Invalid image size for ${filename}`);
    }
  }
});
