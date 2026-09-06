import assert from 'node:assert/strict';

/**
 * The File System Access shapes these fakes stand in for.
 *
 * They are declared here rather than reached for from `lib.dom` because the code under test only
 * reads the handful of members below -- a fake built to the full `FileSystemFileHandle` would have
 * to implement members no test exercises, and a directory handle here yields `[name, handle]`
 * pairs the way the adapter iterates them rather than the platform's own entry type.
 */
export interface BrowserFile {
  name: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface BrowserFileHandle {
  kind: 'file';
  name: string;
  getFile(): Promise<BrowserFile>;
}

export interface BrowserDirectoryHandle {
  kind: 'directory';
  name: string;
  entries(): AsyncGenerator<BrowserDirectoryEntry>;
}

/** One `[name, handle]` pair, as the directory handle yields them. */
export type BrowserDirectoryEntry = readonly [string, BrowserFileHandle | BrowserDirectoryHandle];

export function createBrowserFile(name: string, contents: ArrayLike<number>): BrowserFile {
  const bytes = new Uint8Array(contents);
  return {
    name,
    size: bytes.byteLength,
    async arrayBuffer() {
      return bytes.slice().buffer;
    },
  };
}

export function createBrowserTextFile(name: string, text: string) {
  return createBrowserFile(name, new TextEncoder().encode(text));
}

export function createBrowserFileHandle(name: string, file: BrowserFile): BrowserFileHandle {
  return {
    kind: 'file',
    name,
    async getFile() {
      return file;
    },
  };
}

export function createBrowserFileHandleFromBytes(
  name: string,
  readBytes: () => ArrayLike<number> | Promise<ArrayLike<number>>,
): BrowserFileHandle {
  return {
    kind: 'file',
    name,
    async getFile() {
      const bytes = await readBytes();
      return createBrowserFile(name, bytes);
    },
  };
}

export function createBrowserDirectoryHandle(
  name: string,
  entries: readonly BrowserDirectoryEntry[],
): BrowserDirectoryHandle {
  return {
    kind: 'directory',
    name,
    async *entries() {
      for (const entry of entries) yield entry;
    },
  };
}

export function createMutablePreviewProject(initialSource: string) {
  const encoder = new TextEncoder();
  let source = initialSource;
  const manifest =
    'formatVersion: 1\nmode: external\nsourceId: main\npath: story.kamishibai.yaml\n';
  const fileHandle = (name: string, read: () => string) =>
    createBrowserFileHandleFromBytes(name, async () => encoder.encode(read()));
  return {
    root: {
      kind: 'directory',
      async queryPermission() {
        return 'granted';
      },
      async getFileHandle(name: string) {
        if (name === 'project.source.yaml') return fileHandle(name, () => manifest);
        if (name === 'story.kamishibai.yaml') return fileHandle(name, () => source);
        throw Object.assign(new Error('NotFoundError'), {name: 'NotFoundError'});
      },
      async getDirectoryHandle() {
        throw Object.assign(new Error('NotFoundError'), {name: 'NotFoundError'});
      },
    },
    setSource(value: string) {
      source = value;
    },
  };
}

export function installPreviewBrowserGlobals(
  projectRoot: unknown,
  {
    storyFileHandle,
    saveFileHandle,
  }: {storyFileHandle?: BrowserFileHandle; saveFileHandle?: unknown} = {},
) {
  const names = [
    'isSecureContext',
    'self',
    'top',
    'showDirectoryPicker',
    'showOpenFilePicker',
    'showSaveFilePicker',
  ];
  const previous = new Map(
    names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
  );
  Object.defineProperties(globalThis, {
    isSecureContext: {configurable: true, value: true},
    self: {configurable: true, value: globalThis},
    top: {configurable: true, value: globalThis},
    showDirectoryPicker: {
      configurable: true,
      value: async (options: unknown) => {
        assert.deepEqual(options, {mode: 'read'});
        return projectRoot;
      },
    },
    ...(storyFileHandle === undefined
      ? {}
      : {
          showOpenFilePicker: {
            configurable: true,
            value: async (options: unknown) => {
              assert.deepEqual(options, {
                multiple: false,
                types: [
                  {
                    description: 'Kamishibai DSL 4.0 YAML',
                    accept: {'application/yaml': ['.yml', '.yaml']},
                  },
                ],
              });
              return [storyFileHandle];
            },
          },
        }),
    ...(saveFileHandle === undefined
      ? {}
      : {
          showSaveFilePicker: {
            configurable: true,
            value: async (options: unknown) => {
              assert.deepEqual(options, {
                suggestedName: 'story.sb3',
                types: [
                  {
                    description: 'Scratch 3 project',
                    accept: {'application/x.scratch.sb3': ['.sb3']},
                  },
                ],
              });
              return saveFileHandle;
            },
          },
        }),
  });
  return () => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  };
}
