import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const fixtureUrl = new URL('./fixtures/dsl4/browser/remote-cache-retention.html', import.meta.url);

test('ships a browser fixture for bounded remote cache and pose retention', async () => {
  const fixture = await readFile(fixtureUrl, 'utf8');
  assert.match(fixture, /createVerifiedRemoteBinaryCache/u);
  assert.match(fixture, /createDsl4RemoteAssetLifecycle/u);
  assert.match(fixture, /maximumActiveModels/u);
  assert.match(fixture, /indexedDbBytes/u);
  assert.match(fixture, /cache\.clear\(\)/u);
  assert.match(fixture, /data-status="running"/u);
});
