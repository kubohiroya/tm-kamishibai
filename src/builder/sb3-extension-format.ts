import {
  discoverManifest,
  validateManifest,
  type ExecutionMode,
  type ExtensionSpec,
} from '@kubohiroya/turbowarp-extension-loader';

import {
  dsl4BlockAuthoringExtensionId,
  dsl4BlockSourceBundleExtensionId,
  dsl4BlockSourceRuntimeExtensionId,
} from '../dsl4/block-source-shared.js';
import {Sb3BuilderError} from './errors.js';
import {sha256} from './hash.js';
import {sb3SaveFormatSupport, type Sb3SaveFormat} from './sb3-save-format.js';

/**
 * The URL a retained copy records, when it records one.
 *
 * Loader 0.4.0 spells both retained forms `embedded`, and tells them apart by whether the URL is
 * there. Reading the URL rather than the word is what keeps the provenance from being dropped in
 * silence: a check on the word would simply stop matching, and the URL would vanish from the
 * payload without anything failing. The older spelling is refused by the loader itself, so a
 * manifest that uses it never reaches this far.
 */
const retainedURL = (spec: ExtensionSpec): string | undefined =>
  'url' in spec.source ? spec.source.url : undefined;

const legacyDataUrlPrefix = 'data:text/javascript;base64,';
const maxExtensionBytes = 16 * 1024 * 1024;

/** The archive entry this writer gives an extension it stores as a file. */
export const sb3PlusExtensionPath = (id: string) => `extensions/${id}.js`;

/**
 * The App's own DSL 4.0 extensions read the host `Scratch` surface and refuse a sandboxed host.
 *
 * A legacy `data:` URL records no execution mode, so only these IDs are requested unsandboxed by
 * default and every other extension is requested sandboxed: a rewrite never promotes an extension
 * on its own. An existing Manifest entry always keeps the mode it already requested, and nothing in
 * an SB3 grants it — a Plus host asks its `trustProvider`, a standard host asks the person.
 */
export const dsl4UnsandboxedExtensionIds: readonly string[] = Object.freeze([
  dsl4BlockSourceBundleExtensionId,
  dsl4BlockSourceRuntimeExtensionId,
  dsl4BlockAuthoringExtensionId,
]);

function fail(message: string, code: string, cause?: unknown): never {
  throw new Sb3BuilderError(message, {stage: 'sb3-extension-format', code, cause});
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface Sb3ExtensionPayload {
  readonly id: string;
  /** The current form this extension is stored in. */
  readonly format: Sb3SaveFormat;
  /** Absent for a remote extension, whose bytes are not in the SB3. */
  readonly bytes?: Uint8Array | undefined;
  readonly sha256?: string | undefined;
  readonly url?: string | undefined;
  /** The archive entry this extension occupies now, which a rewrite must release. */
  readonly path?: string | undefined;
  /** The Manifest entry it came from, whose execution mode and metadata a rewrite keeps. */
  readonly spec?: ExtensionSpec | undefined;
}

function decode(id: string, encoded: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(Buffer.from(encoded, 'base64'));
  } catch (cause) {
    fail(`Extension ${id} has an undecodable data URL.`, 'K4-EXT-FORMAT-001', cause);
  }
  if (!bytes.byteLength || bytes.byteLength > maxExtensionBytes)
    fail(`Extension ${id} is empty or too large.`, 'K4-EXT-FORMAT-001');
  try {
    new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  } catch (cause) {
    fail(`Extension ${id} is not UTF-8 JavaScript.`, 'K4-EXT-FORMAT-001', cause);
  }
  return bytes;
}

/**
 * Read every extension this project carries, whichever form holds it.
 *
 * A Plus Manifest wins over a `data:` carrier for the same ID, because that is the order a Plus
 * host resolves them in. A `data:` URL counts only when its ID is declared in `extensions`: an
 * undeclared leftover is not loaded today, and reading it here would bring it back.
 */
export function readSb3ExtensionPayloads(
  archive: Readonly<Record<string, Uint8Array>>,
  project: Readonly<Record<string, unknown>>,
): readonly Sb3ExtensionPayload[] {
  const result: Sb3ExtensionPayload[] = [];
  const seen = new Set<string>();
  const manifest = project.turboWarpPlus === undefined ? null : discoverManifest(project);
  for (const spec of manifest?.extensions ?? []) {
    seen.add(spec.id);
    if (spec.source.type === 'remote') {
      result.push(
        Object.freeze({
          id: spec.id,
          format: 'remote',
          url: spec.source.url,
          sha256: spec.sha256,
          spec,
        }),
      );
      continue;
    }
    const bytes = archive[spec.source.path];
    if (!bytes) fail(`The archive is missing ${spec.source.path}.`, 'K4-EXT-FORMAT-002');
    result.push(
      Object.freeze({
        id: spec.id,
        format: retainedURL(spec) === undefined ? 'embedded-file' : 'cached',
        bytes: new Uint8Array(bytes),
        sha256: spec.sha256,
        path: spec.source.path,
        ...(retainedURL(spec) === undefined ? {} : {url: retainedURL(spec)}),
        spec,
      }),
    );
  }
  const declared = new Set(
    Array.isArray(project.extensions)
      ? project.extensions.filter((id): id is string => typeof id === 'string')
      : [],
  );
  const urls = isRecord(project.extensionURLs) ? project.extensionURLs : {};
  for (const [id, url] of Object.entries(urls)) {
    if (seen.has(id) || !declared.has(id)) continue;
    if (typeof url !== 'string' || !url.startsWith(legacyDataUrlPrefix)) continue;
    const bytes = decode(id, url.slice(legacyDataUrlPrefix.length));
    result.push(Object.freeze({id, format: 'embedded-data', bytes, sha256: sha256(bytes)}));
  }
  return Object.freeze(result);
}

export interface Sb3ExtensionFormatOptions {
  /** Required for `remote` and `cached` unless the project already names the URL. */
  readonly urls?: Readonly<Record<string, string>> | undefined;
  /** Recorded in the Manifest for provenance only; it is never an execution permission. */
  readonly version?: string | undefined;
  /** Legacy `data:` extensions to request unsandboxed, beside the App's own DSL 4.0 ones. */
  readonly unsandboxed?: readonly string[] | undefined;
  /**
   * Also keep the `data:` carrier beside a Plus form, so one SB3 loads in both kinds of host.
   * A Plus host does not load it twice: the Loader drops Manifest IDs from `extensionURLs`.
   */
  readonly keepEmbeddedData?: boolean | undefined;
}

export interface Sb3ExtensionFormatResult {
  readonly converted: readonly string[];
  readonly format: Sb3SaveFormat;
}

const dataUrl = (bytes: Uint8Array) =>
  `${legacyDataUrlPrefix}${Buffer.from(bytes).toString('base64')}`;

/**
 * Rewrite every extension of this project into one form, in place. Running it again on its own
 * output is a no-op, so a rewritten SB3 can be rewritten or rebuilt like any other.
 *
 * `embedded-data` is the only form a standard TurboWarp host loads on its own, because it reads
 * `extensionURLs` and knows nothing about the Plus Manifest or the ZIP entries beside it;
 * `keepEmbeddedData` adds that carrier to a Plus form. `embedded-file`, `cached` and `remote` are
 * Plus forms, verified by SHA-256 and authorized by the host.
 */
export function writeSb3ExtensionFormat(
  archive: Record<string, Uint8Array>,
  project: Record<string, unknown>,
  format: Sb3SaveFormat,
  {urls = {}, version, unsandboxed = [], keepEmbeddedData = false}: Sb3ExtensionFormatOptions = {},
): Sb3ExtensionFormatResult {
  const support = sb3SaveFormatSupport('extensions', format);
  if (!support.supported)
    fail(`Cannot save extensions as ${format}: ${support.reason}`, 'K4-EXT-FORMAT-003');
  const payloads = readSb3ExtensionPayloads(archive, project);
  if (!payloads.length) return Object.freeze({converted: Object.freeze([]), format});
  if (format === 'embedded-data' && payloads.some((payload) => payload.spec?.dependencies.length))
    fail(
      'A data: URL cannot record dependencies between extensions; keep this project in a Plus form.',
      'K4-EXT-FORMAT-006',
    );

  const unsandboxedIds = new Set([...dsl4UnsandboxedExtensionIds, ...unsandboxed]);
  const declared = Array.isArray(project.extensions)
    ? project.extensions.filter((id): id is string => typeof id === 'string')
    : [];
  const nextURLs: Record<string, unknown> = isRecord(project.extensionURLs)
    ? {...project.extensionURLs}
    : {};
  // Release only what these extensions own now, then write back only the chosen form.
  for (const payload of payloads) {
    delete nextURLs[payload.id];
    if (payload.path !== undefined) delete archive[payload.path];
  }

  const specs: Record<string, unknown>[] = [];
  const converted: string[] = [];
  for (const payload of payloads) {
    const {id, bytes, spec} = payload;
    // A rewrite keeps what the existing entry declared, rather than resetting it.
    const metadata = {
      execution: (spec?.execution ??
        (unsandboxedIds.has(id) ? 'unsandboxed' : 'sandboxed')) as ExecutionMode,
      ...((version ?? spec?.version) === undefined ? {} : {version: version ?? spec?.version}),
      ...(spec?.publisher === undefined ? {} : {publisher: spec.publisher}),
      capabilities: [...(spec?.capabilities ?? [])],
      dependencies: [...(spec?.dependencies ?? [])],
    };
    if (format !== 'remote' && !bytes)
      fail(
        `Extension ${id} is only a remote reference, so its bytes must be fetched before saving it as ${format}.`,
        'K4-EXT-FORMAT-005',
      );
    if (keepEmbeddedData && format !== 'embedded-data') {
      if (!bytes)
        fail(
          `Extension ${id} is only a remote reference, so it has no bytes to keep as a data: URL.`,
          'K4-EXT-FORMAT-005',
        );
      nextURLs[id] = dataUrl(bytes);
    }
    if (format === 'embedded-data') {
      nextURLs[id] = dataUrl(bytes!);
      converted.push(id);
      continue;
    }
    const url = urls[id] ?? payload.url;
    if ((format === 'remote' || format === 'cached') && (typeof url !== 'string' || !url))
      fail(`Extension ${id} needs an HTTPS URL to be saved as ${format}.`, 'K4-EXT-FORMAT-004');
    if (format === 'remote') {
      const digest = payload.sha256;
      if (!digest)
        fail(`Extension ${id} has no digest to pin for a remote source.`, 'K4-EXT-FORMAT-004');
      // validateManifest enforces the HTTPS and digest policy for us.
      specs.push({id, source: {type: 'remote', url}, sha256: digest, ...metadata});
      converted.push(id);
      continue;
    }
    const path = sb3PlusExtensionPath(id);
    if (Object.hasOwn(archive, path))
      fail(`The archive already contains unrelated content at ${path}.`, 'K4-EXT-FORMAT-007');
    archive[path] = bytes!;
    specs.push({
      id,
      source: format === 'cached' ? {type: 'embedded', url, path} : {type: 'embedded', path},
      sha256: sha256(bytes!),
      ...metadata,
    });
    converted.push(id);
  }

  if (specs.length) project.turboWarpPlus = validateManifest({schemaVersion: 1, extensions: specs});
  else delete project.turboWarpPlus;
  project.extensionURLs = nextURLs;
  project.extensions = [...new Set([...declared, ...payloads.map((payload) => payload.id)])];
  return Object.freeze({converted: Object.freeze(converted), format});
}

export interface Sb3ExtensionUrlCheckOptions {
  /** Injected for tests; defaults to the global `fetch`. */
  readonly fetch?: typeof fetch | undefined;
  readonly timeoutMs?: number | undefined;
}

/**
 * Fetch every `remote` and `cached` URL this project's Manifest names, and refuse the project
 * unless each URL returns exactly the bytes its digest pins.
 *
 * The writer pins the digest of the bytes it has in hand, but a host loads the URL: a URL serving
 * other bytes makes an SB3 that a Plus host rejects with `DIGEST_MISMATCH` (a cached copy only
 * hides that until the host falls back to the URL). Like the Loader, this refuses redirects.
 */
export async function verifySb3ExtensionUrls(
  project: Record<string, unknown>,
  {fetch: fetchBytes = fetch, timeoutMs = 30_000}: Sb3ExtensionUrlCheckOptions = {},
): Promise<readonly string[]> {
  const checked: string[] = [];
  for (const spec of discoverManifest(project)?.extensions ?? []) {
    // Every source that names a URL has one to verify, whichever form it is stored in.
    const url = spec.source.type === 'remote' ? spec.source.url : retainedURL(spec);
    if (url === undefined) continue;
    let bytes: Uint8Array;
    try {
      const response = await fetchBytes(url, {
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const length = Number(response.headers.get('content-length'));
      if (length > maxExtensionBytes) throw new Error(`${length} bytes is too large`);
      bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > maxExtensionBytes)
        throw new Error(`${bytes.byteLength} bytes is too large`);
    } catch (error) {
      fail(
        `Could not fetch ${url} for extension ${spec.id}: ${(error as Error).message}. ` +
          'Pass --skip-url-check only if the URL will serve the pinned bytes later.',
        'K4-EXT-FORMAT-008',
        error,
      );
    }
    const actual = sha256(bytes);
    if (actual !== spec.sha256)
      fail(
        `${url} does not serve the bytes extension ${spec.id} pins ` +
          `(expected sha256 ${spec.sha256}, got ${actual}); a Plus host would reject it.`,
        'K4-EXT-FORMAT-009',
      );
    checked.push(spec.id);
  }
  return Object.freeze(checked);
}
