import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {describe, it} from 'vitest';

import {
  fetchPublishedRecord,
  publicationUrls,
  prepareSiteRecord,
  publishedMetadataFilename,
  verifyPublishedRecord,
} from '../scripts/sb3/dsl4-published-assets.ts';

const version = '4.0.0-rc.59';
const archive = Buffer.from('frozen SB3 test bytes');
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const source = {
  formatVersion: 1,
  series: '4.0',
  version,
  channel: 'next',
  buildDate: '2026-10-27',
  state: 'frozen',
  sourceIdentity: `sha256:${'a'.repeat(64)}`,
  artifact: {
    filename: `kamishibai-${version}.sb3`,
    url: `https://github.com/kubohiroya/turbowarp-kamishibai-app/releases/download/v${version}/kamishibai-${version}.sb3`,
    size: archive.length,
    sha256: hash(archive),
  },
  publication: {npm: {distTag: 'next'}, github: {tag: `v${version}`, prerelease: true}},
};
const published = {
  ...source,
  state: 'published',
  publication: {...source.publication, urls: publicationUrls(version)},
};

function fixture({
  record = published,
  tag = `v${version}`,
  draft = false,
  missingRecord = false,
  wrongDigest = false,
  wrongArchive = false,
} = {}) {
  const bytes = Buffer.from(JSON.stringify(record));
  const calls: {url: string; headers: Headers}[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({url, headers: new Headers(init?.headers)});
    if (url.startsWith('https://api.github.com/')) {
      return new Response(
        JSON.stringify({
          tag_name: tag,
          draft,
          prerelease: true,
          assets: [
            ...(missingRecord
              ? []
              : [
                  {
                    name: publishedMetadataFilename(version),
                    size: bytes.length,
                    digest: `sha256:${wrongDigest ? '0'.repeat(64) : hash(bytes)}`,
                  },
                ]),
            {
              name: source.artifact.filename,
              size: archive.length,
              digest: `sha256:${hash(archive)}`,
            },
          ],
        }),
      );
    }
    if (url.endsWith('.release-metadata.json')) return new Response(bytes);
    return new Response(wrongArchive ? Buffer.alloc(archive.length) : archive);
  };
  return {fetchImpl, calls};
}

describe('published DSL 4 release overlay', () => {
  it('verifies the record and frozen SB3 without changing source or leaking API credentials', async () => {
    const before = structuredClone(source);
    const {fetchImpl, calls} = fixture();
    assert.deepEqual(
      await fetchPublishedRecord(source, {fetchImpl, token: 'test-token'}),
      published,
    );
    assert.deepEqual(source, before);
    assert.equal(calls.length, 3);
    assert.equal(calls[0]!.headers.get('authorization'), 'Bearer test-token');
    assert.equal(calls[1]!.headers.has('authorization'), false);
    assert.equal(calls[2]!.headers.has('authorization'), false);
  });

  it('retries tag validation when the Release or SB3 exists but its publication record is absent', async () => {
    const environment = {
      KAMISHIBAI_RELEASE_CHECK: '1',
      GITHUB_ACTIONS: 'true',
      GITHUB_REF: `refs/tags/v${version}`,
    };
    const {fetchImpl, calls} = fixture({missingRecord: true});
    assert.equal(await prepareSiteRecord(source, {environment, fetchImpl}), null);
    assert.equal(calls.length, 0);
    await assert.rejects(prepareSiteRecord(source, {environment: {}, fetchImpl}), /no verified/u);
  });

  it('restores strict overlay verification after the publication record is attached', async () => {
    assert.deepEqual(await prepareSiteRecord(source, {environment: {}, ...fixture()}), published);
  });

  it('rejects release-check bypasses outside the exact Actions tag', async () => {
    await assert.rejects(prepareSiteRecord(source, {environment: {KAMISHIBAI_RELEASE_CHECK: '1'}}));
    await assert.rejects(
      prepareSiteRecord(source, {
        environment: {
          KAMISHIBAI_RELEASE_CHECK: '1',
          GITHUB_ACTIONS: 'true',
          GITHUB_REF: 'refs/tags/v4.0.0-rc.60',
        },
      }),
    );
  });

  it('retains the candidate view only when the release does not exist', async () => {
    const fetchImpl: typeof fetch = async () => new Response('', {status: 404});
    assert.equal(await fetchPublishedRecord(source, {fetchImpl}), null);
  });

  it('keeps candidate and historical published sources without remote overlays', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error('Unexpected request');
    };
    assert.equal(await fetchPublishedRecord({...source, state: 'candidate'}, {fetchImpl}), null);
    assert.equal(await fetchPublishedRecord(published, {fetchImpl}), null);
  });

  it('fails closed on an unavailable API', async () => {
    const fetchImpl: typeof fetch = async () => new Response('', {status: 503});
    await assert.rejects(fetchPublishedRecord(source, {fetchImpl}), /HTTP 503/u);
  });

  it('rejects an existing release missing its verified publication record', async () => {
    await assert.rejects(
      fetchPublishedRecord(source, fixture({missingRecord: true})),
      /no verified/u,
    );
  });

  it('rejects a tag for another version', async () => {
    await assert.rejects(fetchPublishedRecord(source, fixture({tag: 'v4.0.0-rc.60'})));
  });

  it('rejects drafts', async () => {
    await assert.rejects(fetchPublishedRecord(source, fixture({draft: true})));
  });

  it('rejects a publication record for different frozen source', async () => {
    const record = {...published, sourceIdentity: `sha256:${'b'.repeat(64)}`};
    await assert.rejects(fetchPublishedRecord(source, fixture({record})));
  });

  it('rejects a changed metadata attachment', async () => {
    await assert.rejects(fetchPublishedRecord(source, fixture({wrongDigest: true})));
  });

  it('rejects a changed SB3 even when its byte length agrees', async () => {
    await assert.rejects(fetchPublishedRecord(source, fixture({wrongArchive: true})));
  });

  it('rejects metadata that changes the immutable artifact URL', () => {
    assert.throws(() =>
      verifyPublishedRecord(source, {
        ...published,
        artifact: {...published.artifact, url: 'https://example.com/file.sb3'},
      }),
    );
  });

  it('rejects path traversal in metadata filenames', () => {
    assert.throws(() => publishedMetadataFilename('../4.0.0-rc.59'));
  });
});
