import assert from 'node:assert/strict';
import {test} from 'vitest';

import {requestPagesBuild} from '../scripts/request-pages-build.ts';

const commit = 'a'.repeat(40);
const source = 'b'.repeat(40);
const sleep = async () => {};

function fixture({
  branch = 'gh-pages',
  identity = commit,
  message = `Publish verified release ${source}`,
  statuses = ['building', 'built'],
  buildCommit = commit,
} = {}) {
  const calls: string[] = [];
  let poll = 0;
  const api = async (method: 'GET' | 'POST', endpoint: string) => {
    calls.push(`${method} ${endpoint}`);
    if (endpoint.endsWith('/pages')) return {build_type: 'legacy', source: {branch, path: '/'}};
    if (endpoint.includes('/git/commits/')) return {sha: identity, message};
    if (method === 'POST') return {status: 'queued'};
    return [
      {
        commit: buildCommit,
        status: statuses[Math.min(poll++, statuses.length - 1)],
        url: 'https://api.github.com/build/1',
      },
    ];
  };
  return {api, calls};
}

test('explicitly requests the legacy Pages build and waits for this exact commit', async () => {
  const {api, calls} = fixture();
  const result = await requestPagesBuild(commit, source, {api, sleep});
  assert.equal(result.commit, commit);
  assert.equal(result.status, 'built');
  assert.deepEqual(
    calls.filter((call) => call.startsWith('POST')),
    ['POST repos/kubohiroya/turbowarp-kamishibai-app/pages/builds'],
  );
  assert.equal(calls.filter((call) => call.includes('per_page')).length, 2);
  assert(!calls.some((call) => /PUT|PATCH/u.test(call)));
});

test('rejects a changed Pages source before requesting a build', async () => {
  const {api, calls} = fixture({branch: 'main'});
  await assert.rejects(requestPagesBuild(commit, source, {api, sleep}), /source changed/u);
  assert(!calls.some((call) => call.startsWith('POST')));
});

test('rejects a different commit or source release message', async () => {
  for (const change of [{identity: 'c'.repeat(40)}, {message: 'Another release'}]) {
    const {api, calls} = fixture(change);
    await assert.rejects(requestPagesBuild(commit, source, {api, sleep}));
    assert(!calls.some((call) => call.startsWith('POST')));
  }
});

test('rejects an obsolete release immediately before the Pages POST', async () => {
  const {api, calls} = fixture();
  await assert.rejects(
    requestPagesBuild(commit, source, {
      api,
      sleep,
      assertCurrent() {
        throw new Error('main advanced');
      },
    }),
    /main advanced/u,
  );
  assert(!calls.some((call) => call.startsWith('POST')));
});

test('does not accept a successful build for another commit', async () => {
  const {api} = fixture({statuses: ['built'], buildCommit: 'c'.repeat(40)});
  await assert.rejects(
    requestPagesBuild(commit, source, {api, sleep, attempts: 2}),
    /successful build/u,
  );
});

test('fails if the exact commit build errors', async () => {
  const {api} = fixture({statuses: ['errored']});
  await assert.rejects(requestPagesBuild(commit, source, {api, sleep}), /build failed/u);
});
