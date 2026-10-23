import {deepFreeze} from '../story-document.js';
import {canonicalizeDsl4Source} from '../source-canonicalizer.js';
import {createDsl4PublicationSourceProvider} from '../publication-loader.js';
import {validateDsl4PublicationManifest} from '../publication-manifest.js';
import type {Dsl4SourceFrontend} from '../source-frontend.js';
import {buildDsl4BrowserSelectedStoryProject} from './browser-story-file-loader.js';

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Invalid publication project record');
  return value as Record<string, unknown>;
}
export function readDsl4ProjectPublication(project: unknown) {
  const storage = record(project).extensionStorage as Record<string, unknown> | undefined;
  const bundle = storage?.kubohiroyakamishibai4 as Record<string, unknown> | undefined;
  return bundle?.publication ?? null;
}
export function publicationSegmentProject(project: unknown, component: unknown) {
  const result = structuredClone(record(project));
  const storage = record(result.extensionStorage);
  delete storage.kubohiroyakamishibairuntime4;
  const bundle = record(storage.kubohiroyakamishibai4);
  delete bundle.publication;
  bundle.components = {
    ...record(bundle.components),
    kubohiroyakamishibairuntime4: structuredClone(component),
  };
  return result;
}

/** Select publication.json together with its chapter sources and assets using the normal folder route. */
export async function buildDsl4BrowserSelectedPublicationProject(
  options: Parameters<typeof buildDsl4BrowserSelectedStoryProject>[0],
) {
  const selected = options.entries.filter(
    (entry) =>
      (entry.path ?? (entry.file as {name: string}).name).split('/').at(-1) === 'publication.json',
  );
  if (selected.length !== 1) throw new TypeError('Select exactly one publication.json');
  const manifestEntry = selected[0]!;
  const manifestPath = manifestEntry.path ?? (manifestEntry.file as {name: string}).name;
  const directory = manifestPath.slice(0, manifestPath.length - 'publication.json'.length);
  const manifestFile = manifestEntry.file as {size: number; arrayBuffer(): Promise<ArrayBuffer>};
  if (manifestFile.size > options.maxSourceBytes)
    throw new TypeError('Publication manifest exceeds maxSourceBytes');
  const bytes = new Uint8Array(await manifestFile.arrayBuffer());
  if (bytes.length > options.maxSourceBytes)
    throw new TypeError('Publication manifest exceeds maxSourceBytes');
  const manifest = validateDsl4PublicationManifest(
    JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)),
  );
  const entries = new Map(
    options.entries.map((entry) => [entry.path ?? (entry.file as {name: string}).name, entry]),
  );
  const sourcePaths = new Set(manifest.segments.map((segment) => directory + segment.source.entry));
  const sources: Record<string, string> = Object.create(null);
  let publicationBytes = 0;
  const components: Record<string, unknown> = Object.create(null);
  // The manifest digest covers original source bytes, before source-descriptor canonicalization.
  for (const segment of manifest.segments) {
    const source = entries.get(directory + segment.source.entry);
    if (!source) throw new TypeError(`Missing publication source: ${segment.source.entry}`);
    const file = source.file as {size: number; arrayBuffer(): Promise<ArrayBuffer>};
    if (file.size !== segment.source.size || file.size > options.maxSourceBytes)
      throw new TypeError('Publication source size mismatch');
    publicationBytes += file.size;
    if (publicationBytes > options.maxTotalAssetBytes)
      throw new TypeError('Publication sources exceed total byte limit');
    sources[segment.source.entry] = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(
      await file.arrayBuffer(),
    );
  }
  const provider = createDsl4PublicationSourceProvider({
    mode: 'offline',
    readEntry: async (entry) => new TextEncoder().encode(sources[entry]!),
  });
  let entryProject:
    Awaited<ReturnType<typeof buildDsl4BrowserSelectedStoryProject>>['project'] | null = null;
  let entryDocument:
    Awaited<ReturnType<typeof buildDsl4BrowserSelectedStoryProject>>['storyDocument'] | null = null;
  let componentBytes = 0;
  for (const segment of manifest.segments) {
    await provider.read(segment);
    const sourcePath = directory + segment.source.entry;
    const assets = options.entries.filter((entry) => {
      const path = entry.path ?? (entry.file as {name: string}).name;
      return !path.endsWith('/publication.json') && !sourcePaths.has(path) && path !== manifestPath;
    });
    const built = await buildDsl4BrowserSelectedStoryProject({
      ...options,
      entries: [...assets, entries.get(sourcePath)!],
    });
    const storage = record(record(built.project.extensionStorage).kubohiroyakamishibai4);
    components[segment.id] = record(storage.components).kubohiroyakamishibairuntime4;
    componentBytes += new TextEncoder().encode(JSON.stringify(components[segment.id])).length;
    if (componentBytes > options.maxTotalAssetBytes * 2)
      throw new TypeError('Publication components exceed total byte limit');
    if (segment.id === manifest.entrySegment) {
      entryProject = built.project;
      entryDocument = built.storyDocument;
    }
  }
  if (!entryProject || !entryDocument) throw new TypeError('Publication entry is missing');
  record(record(entryProject.extensionStorage).kubohiroyakamishibai4).publication = {
    formatVersion: 1,
    manifest,
    sources,
    components,
  };
  validateDsl4ProjectPublication(readDsl4ProjectPublication(entryProject), options.sourceFrontend);
  return Object.freeze({
    project: entryProject,
    sourcePath: manifestPath,
    storyDocument: entryDocument,
  });
}

export function validateDsl4ProjectPublication(input: unknown, frontend: Dsl4SourceFrontend) {
  const publication = record(input);
  if (publication.formatVersion !== 1)
    throw new TypeError('Unsupported publication project version');
  const manifest = validateDsl4PublicationManifest(publication.manifest);
  const sources = record(publication.sources);
  const components = record(publication.components);
  for (const segment of manifest.segments) {
    const source = sources[segment.source.entry];
    const component = record(components[segment.id]);
    if (
      typeof source !== 'string' ||
      record(component.source).text !== canonicalizeDsl4Source(source)
    )
      throw new TypeError('Publication component source does not match manifest source');
    // Reject malformed chapters before exposing a chapter selector. Runtime artifact/bundle
    // validation is repeated by the host when a candidate is prepared.
    const parsed = frontend.parse(source, {sourceId: segment.source.entry});
    if (!parsed.ok) throw new TypeError('Invalid publication chapter');
    const scenes = parsed.storyDocument.scenes as readonly {
      actions: readonly {command: string; args: Record<string, unknown>}[];
    }[];
    for (const action of scenes.flatMap((scene) => scene.actions)) {
      if (action.command === 'gotoSegment' && !segment.next.includes(String(action.args.segment)))
        throw new TypeError(
          `Chapter ${segment.id} gotoSegment must reference a manifest next link`,
        );
    }
  }
  return deepFreeze({
    manifest,
    sources: {...sources} as Record<string, string>,
    components: structuredClone(components),
  });
}
