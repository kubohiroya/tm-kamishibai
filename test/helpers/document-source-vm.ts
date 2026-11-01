import {EventEmitter} from 'node:events';

import schema from '../../schema/dsl-4.schema.json' with {type: 'json'};
import {createDsl4ProductionSourceFrontend} from '../../src/builder/dsl4-source-frontend.js';
import {createDsl4EmbeddedSourceDescriptor} from '../../src/dsl4/source-descriptor.js';
import {createDsl4RuntimeArtifactDescriptor} from '../../src/dsl4/runtime-artifact-descriptor.js';
import {createDsl4EmbeddedAssetBundle} from '../../src/dsl4/asset-bundle-descriptor.js';

type Project = Record<string, unknown>;
type Block = Record<string, unknown> & {id: string};

interface SerializedTarget {
  isStage?: boolean;
  name?: string;
  blocks?: Record<string, unknown>;
  comments?: Record<string, unknown>;
  costumes?: unknown[];
  sounds?: unknown[];
  variables?: Record<string, unknown>;
}

export const storySource = (scene = 'opening') =>
  `kamishibai: '4.0'\ncontrols:\n  keymaps:\n    production:\n      Space: navigation.nextAction\nscenes:\n  ${scene}: []\n`;

/** Build the owner component the way the App's builder does, so validation stays real. */
export async function storyComponent(text: string) {
  const source = await createDsl4EmbeddedSourceDescriptor(text, {
    sourceId: 'story',
    displayName: 'story.k4.yml',
    maxSourceBytes: 4096,
  });
  const parsed = createDsl4ProductionSourceFrontend(schema).parse(text, {sourceId: 'story'});
  if (!parsed.ok)
    throw new Error(`the fixture story must parse: ${JSON.stringify(parsed.diagnostics)}`);
  const artifact = await createDsl4RuntimeArtifactDescriptor(
    parsed.storyDocument,
    source,
    'production',
    {maxSourceBytes: 4096},
  );
  if (!artifact.ok)
    throw new Error(`the fixture artifact must build: ${JSON.stringify(artifact.diagnostics)}`);
  const assets = await createDsl4EmbeddedAssetBundle(
    parsed.storyDocument,
    {manifest: {formatVersion: 1, assets: []}, getFile: () => new Uint8Array()},
    {maxFiles: 8, maxTotalBytes: 4096},
  );
  return {
    source,
    application: {mode: 'story'},
    assets,
    artifact: (artifact as unknown as {artifact: unknown}).artifact,
  };
}

/** A serialized project whose owner component sits in the bundled or unbundled location. */
export async function storyProject({
  text = storySource(),
  form = 'bundled' as 'bundled' | 'unbundled',
} = {}): Promise<Project> {
  const component = await storyComponent(text);
  return {
    targets: [{isStage: true, name: 'Stage', blocks: {}, comments: {}} satisfies SerializedTarget],
    extensionStorage:
      form === 'bundled'
        ? {kubohiroyakamishibai4: {components: {kubohiroyakamishibairuntime4: component}}}
        : {kubohiroyakamishibairuntime4: component},
  };
}

/** The owner component, in whichever extension storage location holds it. */
export function ownerComponent(storage: Record<string, unknown>): Record<string, unknown> {
  const bundle = storage.kubohiroyakamishibai4 as
    {components?: Record<string, Record<string, unknown>>} | undefined;
  const component =
    bundle?.components?.kubohiroyakamishibairuntime4 ??
    (storage.kubohiroyakamishibairuntime4 as Record<string, unknown> | undefined);
  if (!component) throw new Error('the fixture has no owner component');
  return component;
}

/** The canonical document text the owner component stores. */
export function ownerSourceText(project: Project): string {
  const component = ownerComponent(project.extensionStorage as Record<string, unknown>);
  return (component.source as {text: string}).text;
}

/**
 * A VM the shared project patcher accepts: it exposes live block records and counts the
 * whole-project operations the document flow must never use.
 */
export function patchableVm(project: Project) {
  const counts = {saves: 0, loads: 0, stops: 0, changes: 0};
  const runtime = Object.assign(new EventEmitter(), {
    extensionStorage: project.extensionStorage as Record<string, Record<string, unknown>>,
    targets: [] as ReturnType<typeof liveTarget>[],
    emitProjectChanged() {
      counts.changes++;
      runtime.emit('PROJECT_CHANGED');
    },
  });
  runtime.targets = (project.targets as SerializedTarget[]).map(liveTarget);
  const vm = {
    runtime,
    toJSON: () => JSON.stringify(project),
    stopAll() {
      counts.stops++;
    },
    saveProjectSb3() {
      counts.saves++;
      throw new Error('Whole-archive saving is forbidden while editing a document.');
    },
    loadProject() {
      counts.loads++;
      throw new Error('Whole-project loading is forbidden while editing a document.');
    },
    emit() {},
    extensionManager: {isExtensionLoaded: () => true},
    securityManager: {canLoadExtensionFromProject: async () => true},
  };
  return {vm, counts, project};
}

function liveTarget(serialized: SerializedTarget, index: number) {
  const dictionary: Record<string, Block> = {};
  for (const [id, block] of Object.entries(serialized.blocks ?? {}))
    dictionary[id] = {
      next: null,
      parent: null,
      inputs: {},
      fields: {},
      topLevel: true,
      shadow: false,
      ...structuredClone(block as Record<string, unknown>),
      id,
    };
  // The serialized view follows the live records, the way scratch-vm's own save does.
  Object.defineProperty(serialized, 'blocks', {
    enumerable: true,
    configurable: true,
    get: () =>
      Object.fromEntries(
        Object.entries(dictionary).map(([id, block]) => {
          const serializedBlock = {...block} as Record<string, unknown>;
          delete serializedBlock.id;
          return [id, serializedBlock];
        }),
      ),
  });
  serialized.comments ??= {};
  return {
    id: `target-${index}`,
    isOriginal: true,
    isStage: serialized.isStage,
    name: serialized.name,
    getName: () => serialized.name,
    blocks: {
      _blocks: dictionary,
      getBlock: (id: string) => dictionary[id],
      createBlock(block: Block) {
        dictionary[block.id] = block;
      },
      deleteBlock(id: string) {
        delete dictionary[id];
      },
      resetCache() {},
      getScripts: () =>
        Object.values(dictionary)
          .filter((block) => block.topLevel)
          .map((block) => block.id),
      forceNoGlow: false,
    },
    comments: serialized.comments,
    sprite: {costumes: serialized.costumes ?? [], sounds: serialized.sounds ?? []},
    variables: serialized.variables ?? {},
    createComment(
      id: string,
      blockId: string | null | undefined,
      text: string,
      x: number,
      y: number,
      width: number,
      height: number,
      minimized: boolean,
    ) {
      (serialized.comments as Record<string, unknown>)[id] = {
        blockId,
        text,
        x,
        y,
        width,
        height,
        minimized,
      };
    },
  };
}

/** A fetch capability that serves fixed bodies and records every request. */
export function recordingFetch(bodies: Record<string, string | Error>) {
  const requests: string[] = [];
  const fetcher = async (input: string | URL) => {
    const url = String(input);
    requests.push(url);
    const body = bodies[url];
    if (body === undefined) throw new Error(`the fixture has no body for ${url}`);
    if (body instanceof Error) throw body;
    const bytes = new TextEncoder().encode(body);
    return {
      ok: true,
      redirected: false,
      url,
      headers: {
        get: (name: string) => (name === 'content-length' ? String(bytes.byteLength) : null),
      },
      body: {
        getReader() {
          let done = false;
          return {
            async read() {
              if (done) return {done: true, value: undefined};
              done = true;
              return {done: false, value: bytes};
            },
            async cancel() {},
            releaseLock() {},
          };
        },
      },
    } as unknown as Response;
  };
  return {fetch: fetcher as unknown as typeof globalThis.fetch, requests};
}
