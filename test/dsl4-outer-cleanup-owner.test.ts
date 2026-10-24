import assert from 'node:assert/strict';
import {test} from 'vitest';
import {createDsl4StandardAppShell} from '../src/dsl4/platform/standard-app-shell.js';
import {createDsl4IndeterminateProgressIndicator} from '../src/dsl4/platform/indeterminate-progress-indicator.js';
import {createFakeDocument, requireFakeElement} from './helpers/fake-dom.ts';
import {creationCleanup} from './helpers/creation-cleanup.ts';
import {deferred} from './helpers/async-test-helpers.ts';

const title = {
  locales: {
    en: {title: 'Story', officialWebsite: 'Website', close: 'Close', language: 'JA'},
    ja: {title: '物語', officialWebsite: 'サイト', close: '閉じる', language: 'EN'},
  },
  version: '4.0',
  officialWebsiteUrl: 'https://example.com/',
};
const flags = {dsl4Runtime: true, dsl4AppShell: true};

test('shell retains failed title removal and joins concurrent and reentrant disposal', async () => {
  const document = createFakeDocument();
  let nested: unknown;
  let hostCalls = 0;
  const gate = deferred<void>();
  const shell = await createDsl4StandardAppShell({
    featureFlags: flags,
    surface: 'webPlayer',
    document,
    mount: document.body,
    runtimeHostOptions: {},
    title,
    createRuntimeHost: async () => ({
      ok: true,
      enabled: true,
      diagnostics: [],
      host: {
        dispose() {
          hostCalls++;
          nested = shell.dispose();
          return gate.promise;
        },
      },
    }),
  });
  const root = requireFakeElement(shell.titleElement, 'title');
  const remove = root.remove.bind(root);
  let calls = 0;
  root.remove = () => {
    if (++calls === 1) throw new Error('title removal');
    remove();
  };
  const first = shell.dispose();
  assert.equal(shell.dispose(), first);
  assert.equal(nested, first);
  gate.resolve();
  await assert.rejects(first, /disposal failed/);
  assert.equal(shell.titleElement, root);
  shell.showTitle?.();
  assert.equal(root.style.display, 'none');
  await shell.dispose();
  assert.equal(hostCalls, 1);
  assert.equal(shell.titleElement, null);
  assert.equal(document.body.children.length, 0);
});

test('shell creation failure retains partial host and DOM until explicit retry', async () => {
  const document = createFakeDocument();
  let calls = 0;
  const failure = await createDsl4StandardAppShell({
    featureFlags: flags,
    surface: 'webPlayer',
    document,
    mount: document.body,
    title,
    runtimeHostOptions: {},
    createRuntimeHost: async () => ({
      ok: 'invalid',
      enabled: true,
      diagnostics: [],
      host: {
        dispose() {
          if (++calls === 1) throw new Error('host release');
        },
      },
    }),
  }).then(
    () => assert.fail('creation must fail'),
    (error: unknown) => error,
  );
  const cleanup = creationCleanup(failure);
  assert.equal(calls, 1);
  assert.equal(document.body.children.length, 0);
  assert.equal(cleanup.hasPendingCleanup(), true);
  await cleanup.dispose();
  assert.equal(calls, 2);
  assert.equal(cleanup.hasPendingCleanup(), false);
});

test('shell retains a child with late pending cleanup after a successful dispose', async () => {
  let pending = false;
  let calls = 0;
  const shell = await createDsl4StandardAppShell({
    featureFlags: flags,
    surface: 'webPlayer',
    runtimeHostOptions: {},
    createRuntimeHost: async () => ({
      ok: true,
      enabled: true,
      diagnostics: [],
      host: {
        dispose() {
          calls++;
          pending = false;
        },
        hasPendingCleanup() {
          return pending;
        },
      },
    }),
  });
  await shell.dispose();
  pending = true;
  await shell.dispose();
  assert.equal(calls, 2);
});

test('indicator retries failed DOM cleanup while releasing independent cursor ownership', async () => {
  const document = createFakeDocument();
  const indicator = createDsl4IndeterminateProgressIndicator({document, mount: document.body});
  indicator.setBusy({visible: true});
  const root = document.body.children.find(
    (child) => child.dataset.dsl4IndeterminateProgress === 'true',
  );
  assert.ok(root);
  const remove = root.remove.bind(root);
  let calls = 0;
  root.remove = () => {
    if (++calls === 1) throw new Error('indicator removal');
    remove();
  };
  await assert.rejects(Promise.resolve().then(() => indicator.dispose()));
  assert.equal(document.body.dataset.dsl4Cursor, undefined);
  indicator.setBusy({visible: true});
  await indicator.dispose();
  assert.equal(document.body.children.length, 0);
});

test('shell preserves the initial child failure without silently retrying it', async () => {
  const {createDsl4CreationCleanup, Dsl4CreationFailure} =
    await import('../src/dsl4/creation-cleanup.js');
  let calls = 0;
  const child = createDsl4CreationCleanup(
    [
      () => {
        if (++calls === 1) throw new Error('child release');
      },
    ],
    'child',
  );
  await assert.rejects(child.dispose());
  const original = new Error('host factory');
  const failure = await createDsl4StandardAppShell({
    featureFlags: flags,
    surface: 'webPlayer',
    runtimeHostOptions: {},
    createRuntimeHost: async () => {
      throw new Dsl4CreationFailure(original, child, 'host');
    },
  }).then(
    () => assert.fail('creation must fail'),
    (error: unknown) => error,
  );
  assert.equal(calls, 1);
  await creationCleanup(failure).dispose();
  assert.equal(calls, 2);
});

test('title construction failure keeps already-mounted DOM for explicit removal retry', async () => {
  const document = createFakeDocument();
  const create = document.createElement.bind(document);
  let removals = 0;
  document.createElement = (tag) => {
    const element = create(tag);
    if (tag === 'section') {
      const remove = element.remove.bind(element);
      element.remove = () => {
        if (++removals === 1) throw new Error('remove');
        remove();
      };
    }
    if (tag === 'button')
      element.addEventListener = () => {
        throw new Error('listener');
      };
    return element;
  };
  const failure = await createDsl4StandardAppShell({
    featureFlags: flags,
    surface: 'webPlayer',
    runtimeHostOptions: {},
    document,
    mount: document.body,
    title,
    createRuntimeHost: async () => assert.fail('host must not be created'),
  }).then(
    () => assert.fail('creation must fail'),
    (error: unknown) => error,
  );
  assert.equal(document.body.children.length, 1);
  await creationCleanup(failure).dispose();
  assert.equal(document.body.children.length, 0);
});

test('loading presenter retries removal after upstream has permanently closed', async () => {
  const {createDsl4LoadingScreenPresenter} =
    await import('../src/dsl4/platform/loading-screen-presenter.js');
  const document = createFakeDocument();
  const mount = document.createElement('main');
  document.body.appendChild(mount);
  const presenter = createDsl4LoadingScreenPresenter({document, mount});
  presenter.setLoading({visible: true, resources: {backdrop: 'test.svg'}});
  const root = mount.children[0]!;
  const remove = root.remove.bind(root);
  let calls = 0;
  root.remove = () => {
    if (++calls === 1) throw new Error('loading removal');
    remove();
  };
  await assert.rejects(presenter.dispose());
  presenter.setLoading({visible: true, resources: {backdrop: 'new.svg'}});
  await presenter.dispose();
  assert.equal(mount.children.length, 0);
  assert.equal(mount.style.position, '');
  assert.equal(calls, 2);
});

test('shell retries asynchronous host failure without repeating successful DOM cleanup', async () => {
  let releases = 0;
  const shell = await createDsl4StandardAppShell({
    featureFlags: flags,
    surface: 'webPlayer',
    runtimeHostOptions: {},
    createRuntimeHost: async () => ({
      ok: true,
      enabled: true,
      diagnostics: [],
      host: {
        async dispose() {
          if (++releases === 1) throw new Error('async release');
        },
      },
    }),
  });
  await assert.rejects(shell.dispose(), AggregateError);
  assert.equal(shell.hasPendingCleanup?.(), true);
  await shell.dispose();
  assert.equal(releases, 2);
  assert.equal(shell.hasPendingCleanup?.(), false);
});

test('loading presenter keeps the timer retryable when stopping animation throws', async () => {
  const {createDsl4LoadingScreenPresenter} =
    await import('../src/dsl4/platform/loading-screen-presenter.js');
  const {vi} = await import('vitest');
  const document = createFakeDocument();
  const presenter = createDsl4LoadingScreenPresenter({document, mount: document.body});
  presenter.setLoading({visible: true, resources: {costumes: ['one.svg', 'two.svg']}});
  const clear = globalThis.clearInterval;
  let calls = 0;
  let nested: unknown;
  const spy = vi.spyOn(globalThis, 'clearInterval').mockImplementation((timer) => {
    if (++calls === 1) {
      nested = presenter.dispose();
      throw new Error('timer clear');
    }
    clear(timer);
  });
  try {
    const first = presenter.dispose();
    assert.equal(nested, first);
    await assert.rejects(first, AggregateError);
    assert.equal(document.body.children.length, 0);
    assert.equal(presenter.hasPendingCleanup(), true);
    await presenter.dispose();
    assert.equal(document.body.children.length, 0);
    assert.equal(calls, 2);
  } finally {
    spy.mockRestore();
    await presenter.dispose();
  }
});

test('shell holds real loading and progress children across failed disposal', async () => {
  const document = createFakeDocument();
  let hostCalls = 0;
  const shell = await createDsl4StandardAppShell({
    featureFlags: flags,
    surface: 'webPlayer',
    document,
    mount: document.body,
    runtimeHostOptions: {setLoading() {}},
    async createRuntimeHost(options) {
      const loading = options.setLoading;
      assert.ok(typeof loading === 'function');
      loading({visible: true, resources: {backdrop: 'loading.svg'}}, {});
      return {
        ok: true,
        enabled: true,
        diagnostics: [],
        host: {
          dispose() {
            hostCalls++;
          },
        },
      };
    },
  });
  const roots = document.body.children.filter(
    (child) =>
      child.dataset.dsl4LoadingScreen === 'true' ||
      child.dataset.dsl4IndeterminateProgress === 'true',
  );
  assert.equal(roots.length, 2);
  for (const root of roots) {
    const remove = root.remove.bind(root);
    let attempts = 0;
    root.remove = () => {
      if (++attempts === 1) throw new Error('UI removal');
      remove();
    };
  }
  await assert.rejects(shell.dispose(), AggregateError);
  assert.equal(document.body.children.length, 2);
  await shell.dispose();
  assert.equal(document.body.children.length, 0);
  assert.equal(hostCalls, 1);
});

for (const failure of ['render-only', 'timer', 'root'] as const) {
  test(`loading releases independently of a failed frame render (${failure})`, async () => {
    const {createDsl4LoadingScreenPresenter} =
      await import('../src/dsl4/platform/loading-screen-presenter.js');
    const {vi} = await import('vitest');
    vi.useFakeTimers();
    const document = createFakeDocument();
    const mount = document.createElement('main');
    document.body.appendChild(mount);
    const presenter = createDsl4LoadingScreenPresenter({document, mount, frameMilliseconds: 10});
    const root = mount.children[0]!;
    const frame = root.children[1]!;
    const descriptor = Object.getOwnPropertyDescriptor(frame, 'src')!;
    const clear = globalThis.clearInterval;
    let clears = 0;
    const clearSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation((timer) => {
      if (failure === 'timer' && ++clears === 1) throw new Error('timer cleanup');
      clear(timer);
    });
    let removals = 0;
    const remove = root.remove.bind(root);
    root.remove = () => {
      if (++removals === 1 && failure === 'root') throw new Error('root cleanup');
      remove();
    };
    let renders = 0;
    try {
      presenter.setLoading({visible: true, resources: {costumes: ['one.svg', 'two.svg']}});
      Object.defineProperty(frame, 'src', {
        configurable: true,
        get() {
          return '';
        },
        set() {
          renders++;
          throw new Error('frame presentation failed');
        },
      });
      assert.throws(() => vi.advanceTimersByTime(10), /frame presentation failed/);
      const first = presenter.dispose();
      assert.equal(presenter.dispose(), first);
      if (failure === 'render-only') await first;
      else await assert.rejects(first, AggregateError);
      assert.equal(renders, 1, 'cleanup must not write presentation properties');
      assert.equal(mount.style.position, '');
      assert.equal(mount.children.length, failure === 'root' ? 1 : 0);
      assert.equal(vi.getTimerCount(), failure === 'timer' ? 1 : 0);
      assert.equal(presenter.hasPendingCleanup(), failure !== 'render-only');
      vi.advanceTimersByTime(20);
      assert.equal(renders, 1, 'a retained timer must not render after disposal');
      presenter.setLoading({visible: true, resources: {costumes: ['new.svg', 'later.svg']}});
      await presenter.dispose();
      assert.equal(presenter.hasPendingCleanup(), false);
      assert.equal(vi.getTimerCount(), 0);
      assert.equal(mount.children.length, 0);
      assert.equal(removals, failure === 'root' ? 2 : 1);
    } finally {
      Object.defineProperty(frame, 'src', descriptor);
      clearSpy.mockRestore();
      root.remove = remove;
      await presenter.dispose();
      vi.useRealTimers();
    }
  });
}

test('loading animates and replaces frames without rerendering the backdrop each tick', async () => {
  const {createDsl4LoadingScreenPresenter} =
    await import('../src/dsl4/platform/loading-screen-presenter.js');
  const {vi} = await import('vitest');
  vi.useFakeTimers();
  const document = createFakeDocument();
  const presenter = createDsl4LoadingScreenPresenter({
    document,
    mount: document.body,
    frameMilliseconds: 10,
  });
  const root = document.body.children[0]!;
  const backdrop = root.children[0]!;
  const frame = root.children[1]!;
  let backdropWrites = 0;
  let backdropUrl = '';
  Object.defineProperty(backdrop, 'src', {
    configurable: true,
    get() {
      return backdropUrl;
    },
    set(value: string) {
      backdropWrites++;
      backdropUrl = value;
    },
  });
  try {
    presenter.setLoading({
      visible: true,
      resources: {backdrop: 'backdrop.gif', costumes: ['one.svg', 'two.svg']},
    });
    assert.equal(frame.src, 'one.svg');
    assert.equal(vi.getTimerCount(), 1);
    vi.advanceTimersByTime(10);
    assert.equal(frame.src, 'two.svg');
    vi.advanceTimersByTime(10);
    assert.equal(frame.src, 'one.svg');
    assert.equal(backdropWrites, 1);
    presenter.setLoading({visible: true, resources: {costumes: ['three.svg', 'four.svg']}});
    assert.equal(vi.getTimerCount(), 1);
    assert.equal(frame.src, 'three.svg');
    vi.advanceTimersByTime(10);
    assert.equal(frame.src, 'four.svg');
    presenter.setLoading({visible: false});
    assert.equal(vi.getTimerCount(), 0);
    assert.equal(root.style.display, 'none');
    await presenter.dispose();
    assert.equal(vi.getTimerCount(), 0);
  } finally {
    await presenter.dispose();
    vi.useRealTimers();
  }
});
