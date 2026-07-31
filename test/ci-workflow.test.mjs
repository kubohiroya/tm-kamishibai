import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

test('runs static quality gates before tests and the build in CI', async () => {
  const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const qualityCommands = [...workflow.matchAll(/^\s*- run: (pnpm \S+)\s*$/gmu)]
    .map((match) => match[1])
    .filter((command) =>
      ['pnpm lint', 'pnpm format', 'pnpm typecheck', 'pnpm test', 'pnpm build'].includes(command),
    );

  assert.deepEqual(qualityCommands, [
    'pnpm lint',
    'pnpm format',
    'pnpm typecheck',
    'pnpm test',
    'pnpm build',
  ]);
});
