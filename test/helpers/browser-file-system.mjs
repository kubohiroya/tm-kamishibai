import assert from 'node:assert/strict';

export function createBrowserFile(name, contents) {
  const bytes = new Uint8Array(contents);
  return {
    name,
    size: bytes.byteLength,
    async arrayBuffer() {
      return bytes.slice().buffer;
    },
  };
}

export function createBrowserTextFile(name, text) {
  return createBrowserFile(name, new TextEncoder().encode(text));
}

export function createBrowserFileHandle(name, file) {
  return {
    kind: 'file',
    name,
    async getFile() {
      return file;
    },
  };
}

export function createBrowserFileHandleFromBytes(name, readBytes) {
  return {
    kind: 'file',
    name,
    async getFile() {
      const bytes = await readBytes();
      return createBrowserFile(name, bytes);
    },
  };
}

export function createBrowserDirectoryHandle(name, entries) {
  return {
    kind: 'directory',
    name,
    async *entries() {
      for (const entry of entries) yield entry;
    },
  };
}

export function createMutablePreviewProject(initialSource) {
  const encoder = new TextEncoder();
  let source = initialSource;
  const manifest =
    'formatVersion: 1\nmode: external\nsourceId: main\npath: story.kamishibai.yaml\n';
  const fileHandle = (name, read) =>
    createBrowserFileHandleFromBytes(name, async () => encoder.encode(read()));
  return {
    root: {
      kind: 'directory',
      async queryPermission() {
        return 'granted';
      },
      async getFileHandle(name) {
        if (name === 'project.source.yaml') return fileHandle(name, () => manifest);
        if (name === 'story.kamishibai.yaml') return fileHandle(name, () => source);
        throw Object.assign(new Error('NotFoundError'), {name: 'NotFoundError'});
      },
      async getDirectoryHandle() {
        throw Object.assign(new Error('NotFoundError'), {name: 'NotFoundError'});
      },
    },
    setSource(value) {
      source = value;
    },
  };
}

export function installPreviewBrowserGlobals(projectRoot, {storyFileHandle, saveFileHandle} = {}) {
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
      value: async (options) => {
        assert.deepEqual(options, {mode: 'read'});
        return projectRoot;
      },
    },
    ...(storyFileHandle === undefined
      ? {}
      : {
          showOpenFilePicker: {
            configurable: true,
            value: async (options) => {
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
            value: async (options) => {
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
