import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {appendFile, mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

import {isVersionedPagesArtifact} from './pages-history.ts';
import {waitForPagesDeployment} from './pages-deployment-status.ts';

interface ArtifactResult {
  path: string;
  url: string;
  expectedCommit: string;
  expectedSize: number;
  expectedSha256: string;
  status: number | null;
  size: number | null;
  sha256: string | null;
  attempts: number;
  errors: string[];
}

type Request = (url: string, options: RequestInit) => Promise<Response>;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function git(repository: string, args: string[]) {
  return execFileSync('git', args, {cwd: repository, maxBuffer: 64 * 1024 * 1024});
}

function artifactObjects(repository: string, commit: string) {
  const objects = new Map<string, string>();
  for (const entry of git(repository, ['ls-tree', '-rz', '--full-tree', commit])
    .toString()
    .split('\0')) {
    const separator = entry.indexOf('\t');
    if (separator < 0) continue;
    const filename = entry.slice(separator + 1);
    if (!isVersionedPagesArtifact(filename)) continue;
    const [mode, kind, object] = entry.slice(0, separator).split(' ');
    assert(
      kind === 'blob' && (mode === '100644' || mode === '100755') && object,
      `Release artifact must be a regular Git blob: ${filename}`,
    );
    objects.set(filename, object);
  }
  return objects;
}

/** Check the deployed snapshot and its public bytes against the previous publication. */
export async function verifyPagesReleaseHistory({
  repository,
  commit,
  baseUrl = 'https://kubohiroya.github.io/turbowarp-kamishibai-app/',
  request = fetch,
  maxAttempts = 3,
  retryDelayMs = 2000,
}: {
  repository: string;
  commit: string;
  baseUrl?: string;
  request?: Request;
  maxAttempts?: number;
  retryDelayMs?: number;
}) {
  assert.match(commit, /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u);
  assert(Number.isInteger(maxAttempts) && maxAttempts > 0);
  // Read the commit header rather than treating a shallow boundary as an initial publish.
  const previousCommit =
    git(repository, ['cat-file', 'commit', commit])
      .toString()
      .split('\n\n')[0]!
      .split('\n')
      .find((line) => line.startsWith('parent '))
      ?.slice(7) ?? null;
  const current = artifactObjects(repository, commit);
  const previous = previousCommit
    ? artifactObjects(repository, previousCommit)
    : new Map<string, string>();
  const filenames = [...new Set([...previous.keys(), ...current.keys()])].sort();
  assert(
    filenames.length > 0,
    'No versioned release artifacts were found; refusing an empty check.',
  );

  async function verifyFile(filename: string): Promise<ArtifactResult> {
    const expectedCommit = previous.has(filename) ? previousCommit! : commit;
    const original = git(repository, ['show', `${expectedCommit}:${filename}`]);
    const publicPath = filename
      .replace(/\/index\.html$/u, '/')
      .split('/')
      .map(encodeURIComponent)
      .join('/');
    const result: ArtifactResult = {
      path: filename,
      url: new URL(publicPath, baseUrl).href,
      expectedCommit,
      expectedSize: original.length,
      expectedSha256: sha256(original),
      status: null,
      size: null,
      sha256: null,
      attempts: 0,
      errors: [],
    };
    if (previous.has(filename) && current.get(filename) !== previous.get(filename)) {
      result.errors.push(
        current.has(filename)
          ? 'Deployed Git snapshot changed a published artifact.'
          : 'Deployed Git snapshot removed a published artifact.',
      );
    }
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      result.attempts = attempt;
      result.status = null;
      result.size = null;
      result.sha256 = null;
      try {
        const response = await request(result.url, {
          cache: 'no-store',
          headers: {'cache-control': 'no-cache'},
          redirect: 'error',
          signal: AbortSignal.timeout(30_000),
        });
        result.status = response.status;
        if (response.status !== 200) {
          await response.body?.cancel();
          throw new Error(`HTTP ${response.status}`);
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        result.size = bytes.length;
        result.sha256 = sha256(bytes);
        assert.equal(result.size, result.expectedSize, 'Public byte size differs.');
        assert.equal(result.sha256, result.expectedSha256, 'Public SHA-256 differs.');
        break;
      } catch (error) {
        if (attempt === maxAttempts)
          result.errors.push(error instanceof Error ? error.message : String(error));
        else await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
    return result;
  }

  const records: ArtifactResult[] = new Array(filenames.length);
  let next = 0;
  await Promise.all(
    Array.from({length: Math.min(3, filenames.length)}, async () => {
      while (next < filenames.length) {
        const index = next++;
        records[index] = await verifyFile(filenames[index]!);
      }
    }),
  );
  return {
    checkedAt: new Date().toISOString(),
    commit,
    previousCommit,
    baseUrl,
    success: records.every((record) => record.errors.length === 0),
    records,
  };
}

/** Run without installing application dependencies; only Node, Git and gh are required. */
async function main() {
  const repository = fileURLToPath(new URL('../', import.meta.url));
  const read = (endpoint: string): unknown =>
    JSON.parse(
      execFileSync('gh', ['api', `repos/kubohiroya/turbowarp-kamishibai-app/${endpoint}`], {
        encoding: 'utf8',
      }),
    );
  let commit = process.env.PAGES_DEPLOYED_SHA?.trim();
  let createdAt = process.env.PAGES_BUILD_CREATED_AT?.trim();
  if (!commit) {
    const build = read('pages/builds/latest') as {
      status: string;
      commit: string;
      created_at: string;
    };
    assert.equal(build.status, 'built', 'Pages build is not complete.');
    commit = build.commit;
    createdAt = build.created_at;
  }
  assert(createdAt, 'Pages build creation time is required.');
  assert.match(commit, /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u);
  const deploymentId = await waitForPagesDeployment({commit, createdAt, read});
  console.log(`Confirmed successful Pages deployment ${deploymentId} for ${commit}.`);
  const shallow =
    git(repository, ['rev-parse', '--is-shallow-repository']).toString().trim() === 'true';
  execFileSync('git', ['fetch', '--no-tags', ...(shallow ? ['--depth=2'] : []), 'origin', commit], {
    cwd: repository,
  });
  const report = await verifyPagesReleaseHistory({repository, commit});
  const output = path.join(repository, 'tmp/pages-release-history/report.json');
  await mkdir(path.dirname(output), {recursive: true});
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  const summary =
    `## Pages版付き成果物の公開後検証\n\ncommit: \`${commit}\`\n\n` +
    '| 公開URL | HTTP | bytes | SHA-256 | 結果 |\n| --- | --- | ---: | --- | --- |\n' +
    report.records
      .map(
        (record) =>
          `| [${record.path}](${record.url}) | ${record.status ?? '—'} | ${record.size ?? '—'} | \`${record.sha256 ?? '—'}\` | ${record.errors.length ? '失敗' : '成功'} |`,
      )
      .join('\n') +
    '\n';
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
  console.log(summary);
  for (const record of report.records)
    for (const error of record.errors) console.error(`${record.path}: ${error}`);
  assert(report.success, 'Published release history verification failed; see report.json.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
