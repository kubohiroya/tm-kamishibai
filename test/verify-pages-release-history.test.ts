import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'vitest';
import {parse} from 'yaml';

import {verifyPagesReleaseHistory} from '../scripts/verify-pages-release-history.ts';

const oldSb3 = 'downloads/kamishibai-4.0.0-rc.38.sb3';
const oldPlayer = 'players/4.0.0-rc.38/index.html';
const oldAsset = 'players/4.0.0-rc.38/assets/audio data.bin';
const newSb3 = 'downloads/kamishibai-4.0.0-rc.39.sb3';
const newPlayer = 'players/4.0.0-rc.39/index.html';
const files = new Map([
  [oldSb3, 'old SB3 bytes'],
  [oldPlayer, 'old Player'],
  [oldAsset, 'asset'],
  [newSb3, 'new SB3 bytes'],
  [newPlayer, 'new Player'],
]);
const response = (body: string, status = 200) =>
  new Response(new TextEncoder().encode(body), {status});
const filenameForUrl = (url: string) => {
  const filename = decodeURIComponent(new URL(url).pathname).replace(/^\/app\//u, '');
  return filename.endsWith('/') ? filename + 'index.html' : filename;
};
const request = async (url: string) => {
  const contents = files.get(filenameForUrl(url));
  return contents === undefined ? response('missing', 404) : response(contents);
};

async function fixture(
  run: (context: {
    repository: string;
    initial: string;
    commit: string;
    git: (...args: string[]) => string;
  }) => Promise<void>,
) {
  const repository = await mkdtemp(path.join(os.tmpdir(), 'pages-public-verification-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, {cwd: repository, encoding: 'utf8'}).trim();
  async function save(filenames: string[]) {
    for (const filename of filenames) {
      await mkdir(path.dirname(path.join(repository, filename)), {recursive: true});
      await writeFile(path.join(repository, filename), files.get(filename)!);
    }
    git('add', '.');
    git(
      '-c',
      'user.name=Pages Test',
      '-c',
      'user.email=pages@example.invalid',
      'commit',
      '-m',
      'publication',
    );
    return git('rev-parse', 'HEAD');
  }
  try {
    git('init', '--initial-branch=gh-pages');
    const initial = await save([oldSb3, oldPlayer, oldAsset]);
    const commit = await save([newSb3, newPlayer]);
    await run({repository, initial, commit, git});
  } finally {
    await rm(repository, {recursive: true, force: true});
  }
}

test('checks all old and new versioned URLs, canonical Player URLs and attached assets', async () => {
  await fixture(async ({repository, initial, commit}) => {
    const report = await verifyPagesReleaseHistory({
      repository,
      commit,
      baseUrl: 'https://example.invalid/app/',
      request,
    });
    assert.equal(report.success, true);
    assert.equal(report.previousCommit, initial);
    assert.equal(report.records.length, 5);
    assert.equal(report.records.find((record) => record.path === oldSb3)?.expectedCommit, initial);
    assert.equal(report.records.find((record) => record.path === newSb3)?.expectedCommit, commit);
    assert.ok(report.records.some((record) => record.url.endsWith('/players/4.0.0-rc.38/')));
    assert.ok(report.records.some((record) => record.url.endsWith('/assets/audio%20data.bin')));
    const repeated = await verifyPagesReleaseHistory({
      repository,
      commit,
      baseUrl: 'https://example.invalid/app/',
      request,
    });
    assert.deepEqual(repeated.records, report.records);
  });
});

test('checks an initial publication without inventing a previous commit', async () => {
  await fixture(async ({repository, initial}) => {
    const report = await verifyPagesReleaseHistory({
      repository,
      commit: initial,
      baseUrl: 'https://example.invalid/app/',
      request,
    });
    assert.equal(report.previousCommit, null);
    assert.equal(report.records.length, 3);
    assert.equal(report.success, true);
  });
});

test.each(['missing', 'size', 'hash'])('fails for a public %s mismatch', async (failure) => {
  await fixture(async ({repository, commit}) => {
    const report = await verifyPagesReleaseHistory({
      repository,
      commit,
      baseUrl: 'https://example.invalid/app/',
      maxAttempts: 1,
      request: async (url) =>
        filenameForUrl(url) === oldSb3
          ? response(
              failure === 'size' ? 'short' : 'bad SB3 bytes',
              failure === 'missing' ? 404 : 200,
            )
          : request(url),
    });
    assert.equal(report.success, false);
    assert.equal(report.records.filter((record) => record.errors.length > 0).length, 1);
    assert.match(
      report.records.find((record) => record.path === oldSb3)!.errors.join(' '),
      failure === 'missing' ? /HTTP 404/u : failure === 'size' ? /byte size/u : /SHA-256/u,
    );
  });
});

test.each(['removed', 'changed'])(
  'detects a %s Git artifact even if a stale CDN serves the original bytes',
  async (failure) => {
    await fixture(async ({repository, git}) => {
      if (failure === 'removed') git('rm', oldSb3);
      else {
        await writeFile(path.join(repository, oldSb3), 'changed bytes');
        git('add', oldSb3);
      }
      git(
        '-c',
        'user.name=Pages Test',
        '-c',
        'user.email=pages@example.invalid',
        'commit',
        '-m',
        failure,
      );
      const report = await verifyPagesReleaseHistory({
        repository,
        commit: git('rev-parse', 'HEAD'),
        baseUrl: 'https://example.invalid/app/',
        request,
      });
      const record = report.records.find((record) => record.path === oldSb3)!;
      assert.equal(report.success, false);
      assert.equal(record.status, 200);
      assert.equal(record.sha256, record.expectedSha256);
      assert.match(record.errors.join(' '), new RegExp(failure, 'u'));
    });
  },
);

test('retries a transient CDN response and retains the final matching hash', async () => {
  await fixture(async ({repository, commit}) => {
    let attempts = 0;
    const report = await verifyPagesReleaseHistory({
      repository,
      commit,
      baseUrl: 'https://example.invalid/app/',
      retryDelayMs: 0,
      request: async (url) =>
        filenameForUrl(url) === oldSb3 && ++attempts === 1
          ? response('pending', 404)
          : request(url),
    });
    assert.equal(report.success, true);
    assert.equal(report.records.find((record) => record.path === oldSb3)?.attempts, 2);
  });
});

test('triggers only after Pages completion and keeps the deployed SHA and read-only permissions', async () => {
  const workflow = parse(
    await readFile(
      new URL('../.github/workflows/pages-release-history.yml', import.meta.url),
      'utf8',
    ),
  );
  assert.deepEqual(workflow.on.workflow_run, {
    workflows: ['pages build and deployment'],
    types: ['completed'],
    branches: ['gh-pages'],
  });
  assert.ok(Object.hasOwn(workflow.on, 'workflow_dispatch'));
  assert.deepEqual(workflow.permissions, {contents: 'read', pages: 'read'});
  const job = workflow.jobs['verify-public-artifacts'];
  assert.ok(job.if.includes("github.event.workflow_run.conclusion == 'success'"));
  const verification = job.steps.find(
    (step: {run?: string}) => step.run === 'node scripts/verify-pages-release-history.ts',
  );
  assert.equal(verification.env.PAGES_DEPLOYED_SHA, '${{ github.event.workflow_run.head_sha }}');
  assert.equal(
    job.steps.find((step: {uses?: string}) => step.uses === 'actions/upload-artifact@v7').if,
    'always()',
  );
});
