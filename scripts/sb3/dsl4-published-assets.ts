import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const repository = 'kubohiroya/turbowarp-kamishibai-app';
const root = fileURLToPath(new URL('../../', import.meta.url));
const releasePrefix = `https://github.com/${repository}/releases`;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

interface Snapshot {
  series: string;
  channel: string;
  buildDate: string;
  state: string;
  version: string;
  sourceIdentity: string;
  artifact: {filename: string; url: string; size: number; sha256: string};
  publication: Record<string, unknown>;
  [key: string]: unknown;
}

interface ReleaseAsset {
  name: string;
  size: number;
  digest?: string;
}

function snapshot(value: unknown): Snapshot {
  assert(value && typeof value === 'object');
  const metadata = value as Snapshot;
  assert.match(metadata.version, /^4\.0\.\d+(?:-rc\.\d+)?$/u);
  assert.match(metadata.sourceIdentity, /^sha256:[a-f0-9]{64}$/u);
  assert(['candidate', 'frozen', 'published'].includes(metadata.state));
  assert.equal(metadata.artifact.filename, `kamishibai-${metadata.version}.sb3`);
  assert.equal(
    metadata.artifact.url,
    `${releasePrefix}/download/v${metadata.version}/${metadata.artifact.filename}`,
  );
  assert.match(metadata.artifact.sha256, /^[a-f0-9]{64}$/u);
  assert(Number.isSafeInteger(metadata.artifact.size) && metadata.artifact.size > 0);
  return metadata;
}

export function publishedMetadataFilename(version: string) {
  assert.match(version, /^4\.0\.\d+(?:-rc\.\d+)?$/u);
  return `kamishibai-${version}.release-metadata.json`;
}

export function publicationUrls(version: string) {
  return {
    npm: `https://www.npmjs.com/package/@kubohiroya/turbowarp-kamishibai-app/v/${version}`,
    githubRelease: `${releasePrefix}/tag/v${version}`,
    pages: 'https://kubohiroya.github.io/turbowarp-kamishibai-app/downloads/',
  };
}

async function boundedBytes(response: Response, maximum: number) {
  assert(response.ok, `Release input returned HTTP ${response.status}.`);
  assert(response.body, 'Release input has no response body.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      assert(size <= maximum, 'Release input exceeds its expected size.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks, size);
}

/** A published record may only add publication URLs and change the lifecycle state. */
export function verifyPublishedRecord(source: unknown, value: unknown) {
  const frozen = snapshot(source);
  assert.equal(frozen.state, 'frozen');
  const published = snapshot(value);
  assert.deepEqual(published, {
    ...frozen,
    state: 'published',
    publication: {...frozen.publication, urls: publicationUrls(frozen.version)},
  });
  return published;
}

/** Read only the current release; an absent release leaves the candidate card intact. */
export async function fetchPublishedRecord(
  source: unknown,
  {fetchImpl = fetch, token}: {fetchImpl?: typeof fetch; token?: string} = {},
) {
  const frozen = snapshot(source);
  if (frozen.state !== 'frozen') return null;
  const headers: Record<string, string> = {accept: 'application/vnd.github+json'};
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetchImpl(
    `https://api.github.com/repos/${repository}/releases/tags/v${frozen.version}`,
    {headers},
  );
  if (response.status === 404) return null;
  const release = JSON.parse((await boundedBytes(response, 1024 * 1024)).toString()) as {
    tag_name: string;
    draft: boolean;
    prerelease: boolean;
    assets: ReleaseAsset[];
  };
  assert.equal(release.tag_name, `v${frozen.version}`);
  assert.equal(release.draft, false);
  assert.equal(release.prerelease, frozen.version.includes('-'));
  const filename = publishedMetadataFilename(frozen.version);
  const recordAsset = release.assets.find(({name}) => name === filename);
  assert(recordAsset, 'Published release has no verified publication record.');
  assert(recordAsset.size > 0 && recordAsset.size <= 256 * 1024);
  const record = await boundedBytes(
    await fetchImpl(`${releasePrefix}/download/v${frozen.version}/${filename}`),
    recordAsset.size,
  );
  assert.equal(record.byteLength, recordAsset.size);
  if (recordAsset.digest) assert.equal(recordAsset.digest, `sha256:${sha256(record)}`);
  const published = verifyPublishedRecord(frozen, JSON.parse(record.toString()));
  const asset = release.assets.find(({name}) => name === frozen.artifact.filename);
  assert(asset, 'Published release has no frozen SB3.');
  assert.equal(asset.size, frozen.artifact.size);
  if (asset.digest) assert.equal(asset.digest, `sha256:${frozen.artifact.sha256}`);
  const archive = await boundedBytes(await fetchImpl(frozen.artifact.url), frozen.artifact.size);
  assert.equal(archive.byteLength, frozen.artifact.size);
  assert.equal(sha256(archive), frozen.artifact.sha256);
  return published;
}

/** Only the tag job's prepublication check may ignore incomplete remote release assets. */
export async function prepareSiteRecord(
  source: unknown,
  {
    environment = process.env,
    ...options
  }: {
    environment?: Record<string, string | undefined>;
    fetchImpl?: typeof fetch;
    token?: string;
  } = {},
) {
  const metadata = snapshot(source);
  if (environment.KAMISHIBAI_RELEASE_CHECK === '1') {
    assert.equal(
      environment.GITHUB_ACTIONS,
      'true',
      'Release-check mode is restricted to Actions.',
    );
    assert.equal(
      environment.GITHUB_REF,
      `refs/tags/v${metadata.version}`,
      'Release-check tag advanced.',
    );
    return null;
  }
  return fetchPublishedRecord(source, options);
}

let siteOverlay: {source: unknown; published: Snapshot} | undefined;

export function siteReleaseMetadata(source: unknown): Snapshot {
  if (!siteOverlay) return snapshot(source);
  assert.deepEqual(source, siteOverlay.source, 'The site publication source advanced.');
  return siteOverlay.published;
}

async function readCurrentSource() {
  const pins = JSON.parse(
    await readFile(path.join(root, 'test/fixtures/dsl4/release-pins.json'), 'utf8'),
  );
  return snapshot(
    JSON.parse(
      await readFile(path.join(root, `release-metadata/${pins.release.version}.json`), 'utf8'),
    ),
  );
}

/** Set an in-memory overlay before importing the catalog; never edit tracked metadata. */
export async function preparePublishedSite() {
  const source = await readCurrentSource();
  const token = process.env.GH_TOKEN;
  const published = await prepareSiteRecord(source, token ? {token} : {});
  if (published) siteOverlay = {source, published};
}

async function main() {
  const [command, directory] = process.argv.slice(2);
  assert(
    directory && path.isAbsolute(directory),
    'An absolute release output directory is required.',
  );
  await mkdir(directory, {recursive: true});
  if (command === 'stage') {
    const {rebuildFrozenDsl4Release} = await import('./dsl4-release-workflow.ts');
    const {archive, metadata} = await rebuildFrozenDsl4Release();
    await writeFile(path.join(directory, metadata.artifact.filename), archive);
    return;
  }
  assert.equal(command, 'record');
  const source = await readCurrentSource();
  const {recordPublishedSb3ReleaseSnapshot} = await import('@kubohiroya/sb3-toolchain');
  const published = await recordPublishedSb3ReleaseSnapshot(
    source,
    publicationUrls(source.version),
    {
      fetchPublishedArtifact: async () => {
        const bytes = await boundedBytes(await fetch(source.artifact.url), source.artifact.size);
        return bytes;
      },
    },
  );
  verifyPublishedRecord(source, published);
  await writeFile(
    path.join(directory, publishedMetadataFilename(source.version)),
    `${JSON.stringify(published, null, 2)}\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
