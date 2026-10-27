import {strFromU8, unzipSync} from 'fflate';

const failureCode = 'K4-PACKAGER-EXTENSION-PRELOAD-001';
const preloadLoopStart = '      for (const extension of ';
const preloadLoopEnd = ') {\n        vm.extensionManager.loadExtensionURL(extension);\n      }';

/** Which analyzed extension URLs were left out of the preload list, and which remain in it. */
export type Dsl4PackagerExtensionPreloadPlan = Readonly<{
  excluded: readonly string[];
  preloaded: readonly string[];
}>;

export class Dsl4PackagerExtensionPreloadError extends Error {
  code: string;

  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : {cause});
    this.name = 'Dsl4PackagerExtensionPreloadError';
    this.code = failureCode;
  }
}

function fail(message: string, cause?: unknown): never {
  throw new Dsl4PackagerExtensionPreloadError(message, cause);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function sameList(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function readProjectExtensionUrls(arrayBuffer: ArrayBuffer) {
  let projectJson;
  try {
    const archive = unzipSync(new Uint8Array(arrayBuffer), {
      filter: ({name}) => name === 'project.json',
    });
    projectJson = JSON.parse(strFromU8(archive['project.json'] ?? new Uint8Array()));
  } catch (error) {
    fail('Packager project.json could not be read', error);
  }
  if (!isRecord(projectJson)) fail('Packager project.json is not an object');
  const extensionUrls = projectJson.extensionURLs ?? {};
  if (!isRecord(extensionUrls)) fail('Packager project.json extensionURLs is not an object');
  const values = Object.values(extensionUrls);
  if (!isStringArray(values)) fail('Packager project.json extensionURLs has a non-string URL');
  return values;
}

/**
 * Packager 3.14.0 preloads every `project.analysis.extensions` URL before the project loads, and
 * that list is `Object.values(project.json extensionURLs)`. Extensions the project embeds as
 * `data:` URLs are removed from the preload list so the generated HTML does not carry them twice;
 * the VM still loads them from the project during `installTargets()`. Other URLs are kept.
 * Returns the plan that `verifyDsl4PackagerExtensionPreload()` checks generated documents against.
 */
export function excludeEmbeddedProjectExtensionsFromPackagerPreload(
  packager: Record<string, unknown>,
): Dsl4PackagerExtensionPreloadPlan {
  const project = packager.project;
  if (
    !isRecord(project) ||
    project.type !== 'sb3' ||
    !(project.arrayBuffer instanceof ArrayBuffer) ||
    !isRecord(project.analysis)
  ) {
    fail('Packager project has no SB3 analysis');
  }
  const analyzed = project.analysis.extensions;
  if (!isStringArray(analyzed)) fail('Packager project.analysis.extensions is not a URL list');
  const recorded = readProjectExtensionUrls(project.arrayBuffer);
  if (!sameList(analyzed, recorded)) {
    fail('Packager project.analysis.extensions differs from project.json extensionURLs');
  }
  const excluded = analyzed.filter((url) => url.startsWith('data:'));
  const preloaded = analyzed.filter((url) => !url.startsWith('data:'));
  // Replace the configured project with a copy so a project shared by several Packagers is unchanged.
  packager.project = {...project, analysis: {...project.analysis, extensions: [...preloaded]}};
  return Object.freeze({
    excluded: Object.freeze(excluded),
    preloaded: Object.freeze(preloaded),
  });
}

/**
 * Check one generated Packager document: its preload loop appears once and lists exactly the
 * planned URLs, and no excluded embedded extension is written into the document.
 */
export function verifyDsl4PackagerExtensionPreload(
  html: string,
  plan: Dsl4PackagerExtensionPreloadPlan,
) {
  const start = html.indexOf(preloadLoopStart);
  if (start < 0 || start !== html.lastIndexOf(preloadLoopStart)) {
    fail('Pinned Packager extension preload loop was not found exactly once');
  }
  const listStart = start + preloadLoopStart.length;
  const listEnd = html.indexOf(preloadLoopEnd, listStart);
  if (listEnd < 0) fail('Pinned Packager extension preload loop has an unexpected form');
  let listed;
  try {
    listed = JSON.parse(html.slice(listStart, listEnd));
  } catch (error) {
    fail('Packager extension preload list is not JSON', error);
  }
  if (!isStringArray(listed) || !sameList(listed, plan.preloaded)) {
    fail('Packager extension preload list differs from the planned list');
  }
  if (plan.excluded.some((url) => html.includes(url))) {
    fail('Generated Packager document contains an embedded project extension');
  }
}

/** Verify the one Packager document of a ZIP result: `index.html`, or Electron's `resources/app`. */
export function verifyDsl4PackagerArchiveExtensionPreload(
  data: Uint8Array,
  plan: Dsl4PackagerExtensionPreloadPlan,
) {
  let documents;
  try {
    documents = unzipSync(data, {
      filter: ({name}) =>
        name === 'index.html' || /(?:^|\/)resources\/app\/index\.html$/iu.test(name),
    });
  } catch (error) {
    fail('Packager ZIP result could not be read', error);
  }
  const names = Object.keys(documents);
  if (names.length !== 1) fail('Packager ZIP result does not have exactly one document');
  for (const bytes of Object.values(documents)) {
    verifyDsl4PackagerExtensionPreload(new TextDecoder('utf-8', {fatal: true}).decode(bytes), plan);
  }
}
