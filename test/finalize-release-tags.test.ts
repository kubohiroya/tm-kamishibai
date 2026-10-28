import assert from 'node:assert/strict';
import {test} from 'vitest';

import {assertCurrentRelease, finalizeReleaseTags} from '../scripts/finalize-release-tags.ts';

const name = '@kubohiroya/turbowarp-kamishibai-app';
const version = '4.0.0-rc.58';
const sleep = async () => {};

test('waits for publication and verifies both tags after promotion', async () => {
  const commands: string[][] = [];
  let visible = false;
  const tags = {latest: '4.0.0-rc.49', next: version};
  const result = await finalizeReleaseTags(name, version, {
    sleep,
    run(args) {
      commands.push(args);
      if (args[2] === 'version') {
        if (!visible) {
          visible = true;
          throw Object.assign(new Error('pending'), {
            stdout: JSON.stringify({error: {code: 'E404'}}),
          });
        }
        return JSON.stringify(version);
      }
      if (args[0] === 'dist-tag') {
        tags.latest = version;
        return '';
      }
      return JSON.stringify(tags);
    },
  });
  assert.deepEqual(result, {latest: version, next: version});
  assert.deepEqual(
    commands.filter(([command]) => command === 'dist-tag'),
    [['dist-tag', 'add', `${name}@${version}`, 'latest']],
  );
});

test('already completed releases require no tag writes', async () => {
  await finalizeReleaseTags(name, version, {
    sleep,
    run(args) {
      assert.equal(args[0], 'view');
      return JSON.stringify(args[2] === 'version' ? version : {latest: version, next: version});
    },
  });
});

test('unpublished versions never change tags', async () => {
  await assert.rejects(
    finalizeReleaseTags(name, version, {
      sleep,
      attempts: 2,
      run(args) {
        assert.equal(args[0], 'view');
        throw Object.assign(new Error('pending'), {
          stdout: JSON.stringify({error: {code: 'E404'}}),
        });
      },
    }),
    /not visible/u,
  );
});

test('permission errors fail completion', async () => {
  const denied = new Error('OIDC permission denied');
  await assert.rejects(
    finalizeReleaseTags(name, version, {
      sleep,
      run(args) {
        if (args[0] === 'dist-tag') throw denied;
        return JSON.stringify(args[2] === 'version' ? version : {next: version});
      },
    }),
    denied,
  );
});

test('an unsuccessful tag write cannot be reported as a completed release', async () => {
  await assert.rejects(
    finalizeReleaseTags(name, version, {
      sleep,
      attempts: 2,
      run(args) {
        if (args[0] === 'dist-tag') return '';
        return JSON.stringify(args[2] === 'version' ? version : {next: version});
      },
    }),
    /incomplete/u,
  );
});

test('rejects moved main or peeled tags before a mutable write', () => {
  const sha = 'a'.repeat(40);
  const changed = 'b'.repeat(40);
  for (const moved of ['refs/heads/main', `refs/tags/v${version}^{}`]) {
    assert.throws(
      () =>
        assertCurrentRelease({
          sha,
          tag: `v${version}`,
          git(args) {
            const ref = args[2]!;
            return `${ref === moved ? changed : sha}\t${ref}\n`;
          },
        }),
      /advanced/u,
    );
  }
});

test('registry visibility waits cannot allow an obsolete release to downgrade tags', async () => {
  let moved = false;
  let calls = 0;
  const writes: string[][] = [];
  await assert.rejects(
    finalizeReleaseTags(name, version, {
      sleep: async () => {
        moved = true;
      },
      run(args) {
        if (args[2] === 'version') {
          if (calls++ === 0)
            throw Object.assign(new Error('pending'), {
              stdout: JSON.stringify({error: {code: 'E404'}}),
            });
          return JSON.stringify(version);
        }
        if (args[0] === 'dist-tag') {
          writes.push(args);
          return '';
        }
        return JSON.stringify({latest: '4.0.0-rc.60', next: '4.0.0-rc.60'});
      },
      assertCurrent() {
        assert(!moved, 'main advanced');
      },
    }),
    /main advanced/u,
  );
  assert.deepEqual(writes, []);
});

test('rechecks identity before each separate tag write', async () => {
  const writes: string[][] = [];
  let guards = 0;
  await assert.rejects(
    finalizeReleaseTags(name, version, {
      sleep,
      run(args) {
        if (args[0] === 'dist-tag') {
          writes.push(args);
          return '';
        }
        return JSON.stringify(args[2] === 'version' ? version : {});
      },
      assertCurrent() {
        guards++;
        assert(guards === 1, 'tag advanced');
      },
    }),
    /tag advanced/u,
  );
  assert.equal(guards, 2);
  assert.deepEqual(writes, [['dist-tag', 'add', `${name}@${version}`, 'latest']]);
});
