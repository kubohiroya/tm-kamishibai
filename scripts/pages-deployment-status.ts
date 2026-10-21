import assert from 'node:assert/strict';

interface Deployment {
  id: number;
  sha: string;
  environment: string;
  created_at: string;
}

interface DeploymentStatus {
  state: string;
}

/** A Pages build can finish before deployment; require this publication's success. */
export async function waitForPagesDeployment({
  commit,
  createdAt,
  read,
  maxAttempts = 30,
  retryDelayMs = 10_000,
}: {
  commit: string;
  createdAt: string;
  read: (endpoint: string) => unknown;
  maxAttempts?: number;
  retryDelayMs?: number;
}) {
  assert.match(commit, /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u);
  const started = Date.parse(createdAt);
  assert(Number.isFinite(started), 'Pages build creation time is required.');
  assert(Number.isInteger(maxAttempts) && maxAttempts > 0);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const deployments = read(
      `deployments?sha=${commit}&environment=github-pages&per_page=100`,
    ) as Deployment[];
    const deployment = deployments.find(
      (item) =>
        item.sha === commit &&
        item.environment === 'github-pages' &&
        Date.parse(item.created_at) >= started,
    );
    if (deployment) {
      const statuses = read(`deployments/${deployment.id}/statuses`) as DeploymentStatus[];
      // Inactivation by a later deployment does not erase this deployment's completion.
      const status = statuses.find((item) => item.state !== 'inactive');
      if (status?.state === 'success') return deployment.id;
      assert(
        status?.state !== 'failure' && status?.state !== 'error',
        `Pages deployment ${deployment.id} failed: ${status?.state}`,
      );
    }
    if (attempt < maxAttempts) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }
  throw new Error(`Timed out waiting for a successful Pages deployment of ${commit}.`);
}
