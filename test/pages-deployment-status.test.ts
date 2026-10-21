import assert from 'node:assert/strict';
import {test} from 'vitest';

import {waitForPagesDeployment} from '../scripts/pages-deployment-status.ts';

const commit = 'a'.repeat(40);
const createdAt = '2026-10-21T09:26:53Z';
const deployment = {
  id: 42,
  sha: commit,
  environment: 'github-pages',
  created_at: '2026-10-21T09:27:38Z',
};
const options = {commit, createdAt, retryDelayMs: 0, maxAttempts: 3};

test('waits past build completion until this publication deploys successfully', async () => {
  let attempt = 0;
  const id = await waitForPagesDeployment({
    ...options,
    read: (endpoint) => {
      if (endpoint.startsWith('deployments?')) return ++attempt === 1 ? [] : [deployment];
      assert.equal(endpoint, 'deployments/42/statuses');
      return [{state: attempt === 2 ? 'in_progress' : 'success'}];
    },
  });
  assert.equal(id, 42);
  assert.equal(attempt, 3);
});

test('does not accept an earlier publication of the same commit or another environment', async () => {
  let statusReads = 0;
  await assert.rejects(
    waitForPagesDeployment({
      ...options,
      maxAttempts: 1,
      read: (endpoint) => {
        if (endpoint.startsWith('deployments?'))
          return [
            {...deployment, created_at: '2026-10-21T06:54:09Z'},
            {...deployment, environment: 'preview'},
            {...deployment, sha: 'b'.repeat(40)},
          ];
        statusReads++;
        return [{state: 'success'}];
      },
    }),
    /Timed out/u,
  );
  assert.equal(statusReads, 0);
});

test.each(['failure', 'error'])(
  'fails immediately when Pages deployment reports %s',
  async (state) => {
    let reads = 0;
    await assert.rejects(
      waitForPagesDeployment({
        ...options,
        read: (endpoint) => {
          reads++;
          return endpoint.startsWith('deployments?') ? [deployment] : [{state}];
        },
      }),
      /Pages deployment 42 failed/u,
    );
    assert.equal(reads, 2);
  },
);

test('fails on a deployment timeout instead of testing an older public copy', async () => {
  await assert.rejects(
    waitForPagesDeployment({
      ...options,
      read: (endpoint) =>
        endpoint.startsWith('deployments?') ? [deployment] : [{state: 'in_progress'}],
    }),
    /Timed out/u,
  );
});

test('retains completed success when a later publication has marked it inactive', async () => {
  assert.equal(
    await waitForPagesDeployment({
      ...options,
      read: (endpoint) =>
        endpoint.startsWith('deployments?')
          ? [deployment]
          : [{state: 'inactive'}, {state: 'success'}],
    }),
    42,
  );
});
