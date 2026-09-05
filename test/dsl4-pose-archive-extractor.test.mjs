import assert from 'node:assert/strict';
import {createHash, webcrypto} from 'node:crypto';
import {test} from 'vitest';

import {strToU8, zipSync} from 'fflate';

import {
  createDsl4PoseArchiveExtractor,
  DSL4_POSE_ARCHIVE_EXTRACTOR_FORMAT,
  extractDsl4PoseArchive,
  isDsl4PoseArchivePath,
  isDsl4RemotePoseArchiveUrl,
} from '../src/dsl4/platform/pose-archive-extractor.js';

const files = Object.freeze({
  'metadata.json': strToU8('{"labels":["rescue"]}'),
  'model.json': strToU8('{"model":true}'),
  'weights.bin': Uint8Array.from([1, 2, 3, 4]),
});
const limits = Object.freeze({
  maxArchiveBytes: 4096,
  maxEntries: 4,
  maxCompressedEntryBytes: 2048,
  maxExpandedEntryBytes: 2048,
  maxTotalExpandedBytes: 4096,
  maxCompressionRatio: 100,
});

function archive(entries = files) {
  return zipSync(entries, {level: 6});
}

function integrity(bytes) {
  return `sha256-${createHash('sha256').update(bytes).digest('hex')}`;
}

function extractor(overrides = {}) {
  return createDsl4PoseArchiveExtractor({
    limits: {...limits, ...overrides},
    subtleCrypto: webcrypto.subtle,
  });
}

function replaceAscii(bytes, from, to) {
  assert.equal(from.length, to.length);
  const result = new Uint8Array(bytes);
  const source = strToU8(from);
  const replacement = strToU8(to);
  let replacements = 0;
  for (let index = 0; index <= result.length - source.length; index += 1) {
    if (source.every((value, offset) => result[index + offset] === value)) {
      result.set(replacement, index);
      replacements += 1;
    }
  }
  assert.equal(replacements, 2);
  return result;
}

async function extract(bytes, selectedExtractor = extractor(), context = {}) {
  return selectedExtractor(
    {
      assetId: 'RescuePose',
      bytes,
      archiveIntegrity: integrity(bytes),
      contentType: 'application/zip',
    },
    context,
  );
}

test('extracts exactly one bounded pose model and binds every file to the verified archive', async () => {
  const bytes = archive();
  const result = await extract(bytes);

  assert.equal(result.archiveIntegrity, integrity(bytes));
  assert.equal(result.extractorFormat, DSL4_POSE_ARCHIVE_EXTRACTOR_FORMAT);
  assert.deepEqual(
    result.files.map((file) => file.path),
    ['metadata.json', 'model.json', 'weights.bin'],
  );
  for (const file of result.files) {
    assert.equal(file.archiveIntegrity, result.archiveIntegrity);
    assert.equal(file.extractorFormat, result.extractorFormat);
    assert.equal(file.size, file.bytes.byteLength);
    assert.equal(file.integrity, integrity(file.bytes));
  }
});

test('detects local and remote pose archives by case-insensitive path suffix', () => {
  assert.equal(isDsl4PoseArchivePath('models/rescue.zip'), true);
  assert.equal(isDsl4PoseArchivePath('models/rescue.ZIP'), true);
  assert.equal(isDsl4PoseArchivePath('models/rescue.zip/'), false);
  assert.equal(isDsl4RemotePoseArchiveUrl('https://cdn.example.com/rescue.ZIP?download=1'), true);
  assert.equal(isDsl4RemotePoseArchiveUrl('https://cdn.example.com/rescue/?file=model.zip'), false);
  assert.equal(isDsl4RemotePoseArchiveUrl('not a URL.zip'), false);
});

test('extracts an unbound local archive through the finite convenience boundary', async () => {
  const bytes = archive();
  const result = await extractDsl4PoseArchive({
    assetId: 'LocalPose',
    bytes,
    maxArchiveBytes: limits.maxArchiveBytes,
    maxFileBytes: limits.maxExpandedEntryBytes,
    maxTotalBytes: limits.maxTotalExpandedBytes,
    subtleCrypto: webcrypto.subtle,
  });
  assert.equal(result.archiveIntegrity, integrity(bytes));
  assert.deepEqual(
    result.files.map((file) => file.path),
    ['metadata.json', 'model.json', 'weights.bin'],
  );
});

test('rejects traversal, nested, absolute, backslash, and duplicate entry paths', async () => {
  for (const unsafePath of [
    '../model.json',
    'nested/model.json',
    '/model.json',
    'nested\\model.json',
  ]) {
    const bytes = archive({
      'metadata.json': files['metadata.json'],
      'weights.bin': files['weights.bin'],
      [unsafePath]: files['model.json'],
    });
    await assert.rejects(extract(bytes), (error) => error.code === 'K4-ASSET-ARCHIVE-PATH-001');
  }

  const duplicate = replaceAscii(
    archive({...files, 'weightz.bin': Uint8Array.from([5])}),
    'weightz.bin',
    'weights.bin',
  );
  await assert.rejects(
    extract(duplicate),
    (error) => error.code === 'K4-ASSET-ARCHIVE-DUPLICATE-001',
  );
});

test('rejects entry count, compressed bytes, expanded bytes, total bytes, and ratio limits', async () => {
  const fourthEntry = archive({...files, 'notes.txt': strToU8('unexpected')});
  await assert.rejects(
    extract(fourthEntry, extractor({maxEntries: 3})),
    (error) => error.code === 'K4-ASSET-ARCHIVE-COUNT-001',
  );
  await assert.rejects(
    extract(archive(), extractor({maxCompressedEntryBytes: 1})),
    (error) => error.code === 'K4-ASSET-ARCHIVE-COMPRESSED-SIZE-001',
  );

  const expanded = archive({...files, 'weights.bin': new Uint8Array(1536).fill(7)});
  await assert.rejects(
    extract(expanded, extractor({maxExpandedEntryBytes: 1024})),
    (error) => error.code === 'K4-ASSET-ARCHIVE-EXPANDED-SIZE-001',
  );
  await assert.rejects(
    extract(
      archive({
        'metadata.json': new Uint8Array(800).fill(1),
        'model.json': new Uint8Array(800).fill(2),
        'weights.bin': files['weights.bin'],
      }),
      extractor({maxExpandedEntryBytes: 1024, maxTotalExpandedBytes: 1500}),
    ),
    (error) => error.code === 'K4-ASSET-ARCHIVE-EXPANDED-SIZE-001',
  );
  await assert.rejects(
    extract(expanded, extractor({maxCompressionRatio: 2})),
    (error) => error.code === 'K4-ASSET-ARCHIVE-RATIO-001',
  );
});

test('rejects malformed archives, wrong file sets, oversized archives, and cancellation', async () => {
  await assert.rejects(
    extract(Uint8Array.from([1, 2, 3])),
    (error) => error.code === 'K4-ASSET-ARCHIVE-FORMAT-001',
  );
  await assert.rejects(
    extract(
      archive({
        'metadata.json': files['metadata.json'],
        'model.json': files['model.json'],
      }),
    ),
    (error) => error.code === 'K4-ASSET-ARCHIVE-ENTRY-001',
  );
  const valid = archive();
  await assert.rejects(
    extract(valid, extractor({maxArchiveBytes: valid.byteLength - 1})),
    (error) => error.code === 'K4-ASSET-ARCHIVE-COMPRESSED-SIZE-001',
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(extract(valid, extractor(), {signal: controller.signal}), (error) => {
    assert.equal(error.name, 'AbortError');
    return true;
  });
});

test('requires explicit finite limits and Web Crypto', () => {
  assert.throws(
    () =>
      createDsl4PoseArchiveExtractor({
        limits: {...limits, maxArchiveBytes: undefined},
      }),
    /maxArchiveBytes/u,
  );
  assert.throws(() => createDsl4PoseArchiveExtractor({limits, subtleCrypto: {}}), /Web Crypto/u);
  assert.throws(
    () => extractor({maxCompressionRatio: Number.POSITIVE_INFINITY}),
    /maxCompressionRatio/u,
  );
});
