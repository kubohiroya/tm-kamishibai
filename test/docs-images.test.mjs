import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import test from 'node:test';

import {documentConfig} from '../docs/config.mjs';

const imageReferences = [documentConfig.coverFilename, documentConfig.sourceFilename].flatMap(
  (filename) => {
    const sourceUrl = new URL(
      `../docs/${documentConfig.sourceDirectory}/${filename}`,
      import.meta.url,
    );
    const source = readFileSync(sourceUrl, 'utf8');
    return [...source.matchAll(/!\[[^\]]*\]\(([^)]+)\)(?:\{style="([^"]+)"\})?/gu)].map(
      ([, reference, style]) => ({reference, sourceUrl, style}),
    );
  },
);

test('resolves every local image referenced by the workshop Markdown', () => {
  assert(imageReferences.length > 0);

  for (const {reference, sourceUrl} of imageReferences) {
    assert.match(reference, /\.(?:avif|gif|jpe?g|png|svg|webp)$/iu);
    assert(existsSync(new URL(reference, sourceUrl)), `Missing workshop image: ${reference}`);
  }
});

test('accepts omitted image sizes and validates explicit pixel sizes', () => {
  for (const {reference, style} of imageReferences) {
    if (!style) {
      continue;
    }
    const size = style.match(/(?:^|;)\s*(?:height|width):\s*([0-9.]+)px;/u);
    if (size) {
      assert(Number(size[1]) > 0, `Invalid image size for ${reference}`);
    }
  }
});
