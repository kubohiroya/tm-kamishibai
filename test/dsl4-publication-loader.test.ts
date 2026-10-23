import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'vitest';
import {
  validateDsl4PublicationManifest,
  createDsl4PublicationPosition,
} from '../src/dsl4/publication-manifest.js';
import {
  createDsl4PublicationLoader,
  createDsl4PublicationSourceProvider,
} from '../src/dsl4/publication-loader.js';
import {dsl4TestSourceFrontend as frontend} from './helpers/dsl4-test-frontend.ts';

const source = new TextEncoder().encode("kamishibai: '4.0'\nscenes:\n  main:\n    - wait: 0\n");
function manifest(count = 4) {
  return {
    formatVersion: 1,
    id: 'long-story',
    title: '長編',
    entrySegment: 's0',
    entryPoints: ['s0'],
    segments: Array.from({length: count}, (_, i) => ({
      id: `s${i}`,
      title: `章${i}`,
      next: i + 1 < count ? [`s${i + 1}`] : [],
      source: {
        entry: `segments/${i}.yaml`,
        size: source.length,
        integrity: 'sha256-' + createHash('sha256').update(source).digest('hex'),
        url: `https://example.test/${i}.yaml`,
      },
    })),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return {promise, resolve};
}

test('publication manifest fails closed and records ordered chapters, branch links, and entry points', () => {
  const input = manifest();
  const validated = validateDsl4PublicationManifest(input);
  assert(Object.isFrozen(validated.segments[0]!.source));
  assert.equal(Object.isFrozen(input), false);
  for (const mutate of [
    (m: typeof input) => {
      m.formatVersion = 2;
    },
    (m: typeof input) => {
      Object.assign(m, {unknown: true});
    },
    (m: typeof input) => {
      m.entrySegment = 'missing';
    },
    (m: typeof input) => {
      m.segments[1]!.id = 's0';
    },
    (m: typeof input) => {
      m.segments[0]!.next = ['missing'];
    },
    (m: typeof input) => {
      m.segments[0]!.source.entry = '../story.yaml';
    },
    (m: typeof input) => {
      m.segments[0]!.source.url = 'https://user:pass@example.test/story';
    },
    (m: typeof input) => {
      m.segments[0]!.source.integrity = 'unchecked';
    },
    (m: typeof input) => {
      m.segments[0]!.source.size = 2 ** 30;
    },
    (m: typeof input) => {
      Object.assign(m.segments[0]!.source, {extra: true});
    },
  ]) {
    const copy = structuredClone(input);
    mutate(copy);
    assert.throws(() => validateDsl4PublicationManifest(copy));
  }
});

test.each(['online', 'hybrid', 'offline'] as const)(
  'source provider verifies %s sources without enabling offline network access',
  async (mode) => {
    let network = 0,
      archive = 0;
    const provider = createDsl4PublicationSourceProvider({
      mode,
      async readEntry() {
        archive++;
        return source;
      },
      fetchSource: async () => {
        network++;
        return new Response(source);
      },
    });
    assert.equal(
      await provider.read(validateDsl4PublicationManifest(manifest()).segments[0]!),
      new TextDecoder().decode(source),
    );
    assert.equal(network, mode === 'offline' ? 0 : 1);
    assert.equal(archive, mode === 'offline' ? 1 : 0);
  },
);

test('hybrid retries verified local bytes after network failure; invalid bytes and aborted reads never succeed', async () => {
  const segment = validateDsl4PublicationManifest(manifest()).segments[0]!;
  const readEntry = async () => source;
  const failedFetch = async () => {
    throw new Error('offline');
  };
  const provider = createDsl4PublicationSourceProvider({
    mode: 'hybrid',
    readEntry,
    fetchSource: failedFetch,
  });
  assert.equal(await provider.read(segment), new TextDecoder().decode(source));
  await assert.rejects(
    createDsl4PublicationSourceProvider({mode: 'online', readEntry, fetchSource: failedFetch}).read(
      segment,
    ),
    /offline/u,
  );
  const changed = new Uint8Array(source);
  changed[1] = changed[1]! ^ 1;
  await assert.rejects(
    createDsl4PublicationSourceProvider({mode: 'offline', readEntry: async () => changed}).read(
      segment,
    ),
    /integrity/u,
  );
  await assert.rejects(
    createDsl4PublicationSourceProvider({
      mode: 'online',
      fetchSource: async () => new Response(new Uint8Array(source.length + 1)),
    }).read(segment),
    /exceeds/u,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(provider.read(segment, controller.signal), {name: 'AbortError'});
});

test('lazy startup, prefetch, and long transitions bound cached documents and prepared leases', async () => {
  const reads: string[] = [],
    active = new Set<string>();
  let maximumActive = 0;
  const loader = createDsl4PublicationLoader({
    manifest: manifest(60),
    frontend,
    maxCachedDocuments: 2,
    provider: {
      async read(segment) {
        reads.push(segment.id);
        return new TextDecoder().decode(source);
      },
    },
    async prepare(segment) {
      active.add(segment.id);
      maximumActive = Math.max(maximumActive, active.size);
      return {
        value: segment.id,
        release() {
          active.delete(segment.id);
        },
      };
    },
  });
  assert.deepEqual(reads, []);
  const first = await loader.transition();
  assert.equal(first.current.position.sceneId, 'main');
  assert.deepEqual(reads, ['s0']);
  assert(Object.isFrozen(first.current.document));
  await loader.prefetch('s1');
  assert.deepEqual([...active], ['s0']);
  for (let i = 1; i < 60; i++) {
    const result = await loader.transition(`s${i}`);
    assert.equal(result.cleanupError, null);
    assert.equal(active.size, 1);
    assert(loader.getCachedSegmentIds().length <= 2);
  }
  assert.equal(reads.filter((id) => id === 's1').length, 1);
  assert.equal(maximumActive, 2, 'Only current and prepared candidate coexist');
  await loader.dispose();
  assert.equal(active.size, 0);
  assert.equal(loader.getCurrent(), null);
  assert.deepEqual(loader.getCachedSegmentIds(), []);
  await assert.rejects(loader.transition(), /disposed/u);
});

test('load, validation, preparation, and position failures preserve the previous valid segment and allow retry', async () => {
  let failure = '';
  const prepared: string[] = [],
    released: string[] = [];
  const loader = createDsl4PublicationLoader({
    manifest: manifest(),
    frontend,
    provider: {
      async read(segment) {
        if (segment.id === 's1' && failure === 'read') throw new Error('read failed');
        return failure === 'parse' ? 'not a document' : new TextDecoder().decode(source);
      },
    },
    async prepare(segment) {
      if (failure === 'prepare') throw new Error('prepare failed');
      prepared.push(segment.id);
      return {
        value: segment.id,
        release() {
          released.push(segment.id);
        },
      };
    },
  });
  await loader.transition();
  const previous = loader.getCurrent();
  await assert.rejects(loader.transition('s2'), /linked/u);
  for (const error of ['read', 'parse', 'prepare']) {
    failure = error;
    await assert.rejects(loader.transition('s1'));
    assert.equal(loader.getCurrent(), previous);
    assert.deepEqual(released, []);
  }
  failure = '';
  await assert.rejects(loader.transition('s1', {sceneId: 'absent'}), /position/u);
  assert.equal(loader.getCurrent(), previous);
  const result = await loader.transition('s1', {actionPath: '/scenes/main/actions/0'});
  assert.equal(result.current.position.actionPath, '/scenes/main/actions/0');
  assert.deepEqual(prepared, ['s0', 's1']);
  assert.deepEqual(released, ['s0']);
  await loader.dispose();
});

test('cancellation after candidate preparation releases it without switching or releasing current', async () => {
  const ready = deferred<void>(),
    releaseCandidate = deferred<void>();
  const released: string[] = [];
  const loader = createDsl4PublicationLoader({
    manifest: manifest(),
    frontend,
    provider: {
      async read() {
        return new TextDecoder().decode(source);
      },
    },
    async prepare(segment) {
      if (segment.id === 's1') {
        ready.resolve();
        await releaseCandidate.promise;
      }
      return {
        value: segment.id,
        release() {
          released.push(segment.id);
        },
      };
    },
  });
  await loader.transition();
  const previous = loader.getCurrent(),
    controller = new AbortController();
  const waiting = loader.transition('s1', {signal: controller.signal});
  await ready.promise;
  controller.abort();
  releaseCandidate.resolve();
  await assert.rejects(waiting, {name: 'AbortError'});
  assert.equal(loader.getCurrent(), previous);
  assert.deepEqual(released, ['s1']);
  await loader.transition('s1');
  assert.equal(loader.getCurrent()?.segmentId, 's1');
  await loader.dispose();
});

test('post-commit cleanup failure is reported separately from the successful new state', async () => {
  const failure = new Error('old cleanup');
  const loader = createDsl4PublicationLoader({
    manifest: manifest(),
    frontend,
    provider: {
      async read() {
        return new TextDecoder().decode(source);
      },
    },
    async prepare(segment) {
      return {
        value: segment.id,
        release() {
          if (segment.id === 's0') throw failure;
        },
      };
    },
  });
  await loader.transition();
  const result = await loader.transition('s1');
  assert.equal(result.current.segmentId, 's1');
  assert.equal(result.cleanupError, failure);
  await loader.dispose();
});

test('initial scene and old segment cleanup diagnostics are both preserved after commit', async () => {
  const initial = new Error('entry cleanup');
  const previous = new Error('old cleanup');
  const loader = createDsl4PublicationLoader({
    manifest: manifest(),
    frontend,
    provider: {
      async read() {
        return new TextDecoder().decode(source);
      },
    },
    async prepare(segment) {
      return {
        value: segment.id,
        ...(segment.id === 's1' ? {cleanupError: initial} : {}),
        release() {
          if (segment.id === 's0') throw previous;
        },
      };
    },
  });
  await loader.transition();
  const result = await loader.transition('s1');
  assert.equal(result.current.segmentId, 's1');
  assert.equal(loader.getCurrent(), result.current);
  assert(result.cleanupError instanceof AggregateError);
  assert.deepEqual(result.cleanupError.errors, [initial, previous]);
  await loader.dispose();
});

test('publication positions reject another scene/action rather than silently remapping it', () => {
  const parsed = frontend.parse(new TextDecoder().decode(source));
  assert(parsed.ok);
  assert.equal(
    createDsl4PublicationPosition('s0', parsed.storyDocument, 'main', '/scenes/main/actions/0')
      .sceneId,
    'main',
  );
  assert.throws(() =>
    createDsl4PublicationPosition('s0', parsed.storyDocument, 'main', '/scenes/main/actions/1'),
  );
});

test('loader verifies injected provider output rather than accepting changed valid source', async () => {
  const changed = new TextDecoder().decode(source).replace('wait: 0', 'wait: 1');
  const loader = createDsl4PublicationLoader({
    manifest: manifest(),
    frontend,
    provider: {
      async read() {
        return changed;
      },
    },
    async prepare() {
      assert.fail('unverified document cannot prepare');
    },
  });
  await assert.rejects(loader.transition(), /integrity/u);
  assert.equal(loader.getCurrent(), null);
  await loader.dispose();
});

test('cache of one document retains the committed source after candidate promotion', async () => {
  const loader = createDsl4PublicationLoader({
    manifest: manifest(),
    frontend,
    maxCachedDocuments: 1,
    provider: {
      async read() {
        return new TextDecoder().decode(source);
      },
    },
    async prepare(segment) {
      return {value: segment.id, release() {}};
    },
  });
  await loader.transition();
  await loader.transition('s1');
  assert.deepEqual(loader.getCachedSegmentIds(), ['s1']);
  await loader.dispose();
});

test.each(['online', 'hybrid', 'offline'] as const)(
  'long %s provider fixture reads individual archive entries and bounds documents',
  async (mode) => {
    const {zipSync, unzipSync} = await import('fflate');
    const input = manifest(20),
      archive = unzipSync(
        zipSync(
          Object.fromEntries(input.segments.map((segment) => [segment.source.entry, source])),
        ),
      );
    let network = 0,
      local = 0;
    const provider = createDsl4PublicationSourceProvider({
      mode,
      async readEntry(entry) {
        local++;
        return archive[entry] ?? null;
      },
      async fetchSource() {
        network++;
        if (mode === 'hybrid') throw new Error('offline fallback');
        return new Response(source);
      },
    });
    const loader = createDsl4PublicationLoader({
      manifest: input,
      frontend,
      provider,
      async prepare(segment) {
        return {value: segment.id, release() {}};
      },
    });
    await loader.transition();
    assert.equal(network + local, mode === 'hybrid' ? 2 : 1, 'Lazy startup reads entry only');
    for (let i = 1; i < 20; i++) {
      await loader.transition(`s${i}`);
      assert(loader.getCachedSegmentIds().length <= 2);
    }
    assert.equal(network, mode === 'offline' ? 0 : 20);
    assert.equal(local, mode === 'online' ? 0 : 20);
    await loader.dispose();
  },
);

test('invalid complete-source semantics fail before any asset preparation despite valid source integrity', async () => {
  const invalid = "kamishibai: '4.0'\nscenes:\n  main:\n    - goto: missing\n";
  const bytes = new TextEncoder().encode(invalid),
    input = manifest(1);
  input.segments[0]!.source.size = bytes.length;
  input.segments[0]!.source.integrity =
    'sha256-' + createHash('sha256').update(bytes).digest('hex');
  const loader = createDsl4PublicationLoader({
    manifest: input,
    frontend,
    provider: {
      async read() {
        return invalid;
      },
    },
    async prepare() {
      assert.fail('invalid segment must not prepare assets');
    },
  });
  await assert.rejects(loader.transition(), /valid complete DSL/u);
  assert.equal(loader.getCurrent(), null);
  await loader.dispose();
});

test('presentation commit failure keeps current and releases only the prepared candidate', async () => {
  const released: string[] = [];
  let rejectCommit = false;
  const loader = createDsl4PublicationLoader({
    manifest: manifest(2),
    frontend,
    provider: {read: async () => new TextDecoder().decode(source)},
    async prepare(segment) {
      return {
        value: segment.id,
        commit() {
          if (rejectCommit) throw new Error('input attachment failed');
        },
        release() {
          released.push(segment.id);
        },
      };
    },
  });
  await loader.transition('s0');
  const previous = loader.getCurrent();
  rejectCommit = true;
  await assert.rejects(loader.transition('s1'), /input attachment/);
  assert.equal(loader.getCurrent(), previous);
  assert.deepEqual(released, ['s1']);
  await loader.dispose();
  assert.deepEqual(released, ['s1', 's0']);
});

test('chapter order and public entry points do not permit implicit backward or unlinked transitions', async () => {
  const input = manifest();
  input.entryPoints = ['s0', 's2'];
  const loader = createDsl4PublicationLoader({
    manifest: input,
    frontend,
    provider: {
      async read() {
        return new TextDecoder().decode(source);
      },
    },
    async prepare(segment) {
      return {value: segment.id, release() {}};
    },
  });
  await loader.transition('s0');
  await assert.rejects(loader.transition('s2'), /not linked/);
  await loader.transition('s1');
  await assert.rejects(loader.transition('s0'), /not linked/);
  assert.equal(loader.getCurrent()!.segmentId, 's1');
  await loader.dispose();
});
