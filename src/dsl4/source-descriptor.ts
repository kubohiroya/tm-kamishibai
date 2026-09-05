import {canonicalizeDsl4Source} from './source-canonicalizer.js';
import {validateDsl4CacheIdentity} from './cache-identity.js';
import {hasDsl4SourceFilenameSuffix} from './source-filename.js';
import {
  createDsl4SourceOriginDescriptor,
  Dsl4SourceOriginError,
  validateDsl4SourceOriginDescriptor,
} from './source-origin-descriptor.js';
import {deepFreeze} from './story-document.js';
import type {Dsl4SubtleCrypto} from './subtle-crypto.js';

const requiredDescriptorKeys = new Set([
  'byteLength',
  'displayName',
  'encoding',
  'formatVersion',
  'integrity',
  'mediaType',
  'mode',
  'sourceId',
  'text',
]);
const descriptorKeys = new Set([...requiredDescriptorKeys, 'cacheIdentity', 'sourceOrigins']);
const base64Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export const dsl4SourceStoragePaths = deepFreeze({
  bundled: 'extensionStorage.kubohiroyakamishibai4.components.kubohiroyakamishibairuntime4.source',
  unbundled: 'extensionStorage.kubohiroyakamishibairuntime4.source',
});

export class Dsl4SourceDescriptorError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'Dsl4SourceDescriptorError';
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new Dsl4SourceDescriptorError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown, name: string) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    fail('K4-SOURCE-DESCRIPTOR-001', `${name} must be a non-empty string without NUL`);
  }
  return value as string;
}

function requireDisplayName(value: unknown) {
  const displayName = requireNonEmptyString(value, 'displayName');
  if (
    displayName.includes('/') ||
    displayName.includes('\\') ||
    !hasDsl4SourceFilenameSuffix(displayName)
  ) {
    fail(
      'K4-SOURCE-DESCRIPTOR-001',
      'displayName must be a DSL 4 source basename without path separators',
    );
  }
  return displayName;
}

function requireCacheIdentity(value: unknown) {
  try {
    return validateDsl4CacheIdentity(value);
  } catch (error) {
    fail(
      'K4-SOURCE-DESCRIPTOR-001',
      error instanceof Error ? error.message : 'cacheIdentity is invalid',
    );
  }
}

function requireMaxSourceBytes(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError('maxSourceBytes must be a positive safe integer');
  }
  return Number(value);
}

function encodeBase64(bytes: Uint8Array): string {
  let result = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const value = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    result += base64Alphabet[(value >>> 18) & 63];
    result += base64Alphabet[(value >>> 12) & 63];
    result += second === undefined ? '=' : base64Alphabet[(value >>> 6) & 63];
    result += third === undefined ? '=' : base64Alphabet[value & 63];
  }
  return result;
}

export async function computeDsl4Sha256Integrity(
  bytes: Uint8Array,
  subtleCrypto: Dsl4SubtleCrypto = globalThis.crypto?.subtle,
) {
  if (!subtleCrypto || typeof subtleCrypto.digest !== 'function') {
    fail('K4-SOURCE-INTEGRITY-UNAVAILABLE', 'SHA-256 digest capability is unavailable');
  }
  let digest;
  try {
    digest = await subtleCrypto.digest('SHA-256', bytes);
  } catch (error) {
    fail(
      'K4-SOURCE-INTEGRITY-UNAVAILABLE',
      `SHA-256 digest failed: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
  return `sha256-${encodeBase64(new Uint8Array(digest as ArrayBuffer))}`;
}

function encodeSource(text: string, maxSourceBytes: number) {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > maxSourceBytes) {
    fail(
      'K4-SOURCE-SIZE-001',
      `Canonical source is ${bytes.length} bytes and exceeds the ${maxSourceBytes} byte limit`,
    );
  }
  return bytes;
}

export async function createDsl4EmbeddedSourceDescriptor(
  source: string,
  {
    sourceId,
    displayName,
    maxSourceBytes,
    cacheIdentity,
    sourceOrigins,
    sourceOriginLimits,
    subtleCrypto = globalThis.crypto?.subtle,
  }: {
    sourceId: string;
    displayName: string;
    maxSourceBytes: number;
    cacheIdentity?: unknown;
    sourceOrigins?: unknown;
    sourceOriginLimits?: Record<string, number>;
    subtleCrypto?: Dsl4SubtleCrypto | undefined;
  },
) {
  const canonicalSource = canonicalizeDsl4Source(source);
  const limit = requireMaxSourceBytes(maxSourceBytes);
  const bytes = encodeSource(canonicalSource, limit);
  const normalizedDisplayName = requireDisplayName(displayName);
  const normalizedCacheIdentity =
    cacheIdentity === undefined ? null : requireCacheIdentity(cacheIdentity);
  let normalizedSourceOrigins = null;
  if (sourceOrigins !== undefined) {
    try {
      normalizedSourceOrigins = createDsl4SourceOriginDescriptor(sourceOrigins, sourceOriginLimits);
    } catch (error) {
      if (error instanceof Dsl4SourceOriginError) fail(error.code, error.message);
      throw error;
    }
  }
  if (normalizedCacheIdentity && normalizedCacheIdentity.label !== normalizedDisplayName) {
    fail(
      'K4-SOURCE-DESCRIPTOR-001',
      'cacheIdentity.label must match the source descriptor displayName',
    );
  }
  const descriptor = {
    formatVersion: 1,
    mode: 'embedded',
    sourceId: requireNonEmptyString(sourceId, 'sourceId'),
    displayName: normalizedDisplayName,
    mediaType: 'application/yaml',
    encoding: 'utf-8',
    byteLength: bytes.length,
    integrity: await computeDsl4Sha256Integrity(bytes, subtleCrypto),
    text: canonicalSource,
    ...(normalizedCacheIdentity ? {cacheIdentity: normalizedCacheIdentity} : {}),
    ...(normalizedSourceOrigins ? {sourceOrigins: normalizedSourceOrigins} : {}),
  };
  return deepFreeze(descriptor);
}

export async function validateDsl4EmbeddedSourceDescriptor(
  input: unknown,
  {
    maxSourceBytes,
    sourceOriginLimits,
    subtleCrypto = globalThis.crypto?.subtle,
  }: {
    maxSourceBytes: number;
    sourceOriginLimits?: Record<string, number>;
    subtleCrypto?: Dsl4SubtleCrypto | undefined;
  },
) {
  const limit = requireMaxSourceBytes(maxSourceBytes);
  if (!isRecord(input)) {
    fail('K4-SOURCE-DESCRIPTOR-001', 'Embedded source descriptor must be an object');
  }
  const inputKeys = Object.keys(input);
  const unknownKeys = inputKeys.filter((key) => !descriptorKeys.has(key));
  const missingKeys = [...requiredDescriptorKeys].filter((key) => !Object.hasOwn(input, key));
  if (unknownKeys.length > 0 || missingKeys.length > 0) {
    fail(
      'K4-SOURCE-DESCRIPTOR-001',
      `Embedded source descriptor keys are invalid (unknown: ${unknownKeys.sort().join(', ') || 'none'}; missing: ${missingKeys.sort().join(', ') || 'none'})`,
    );
  }
  if (
    input.formatVersion !== 1 ||
    input.mode !== 'embedded' ||
    input.mediaType !== 'application/yaml' ||
    input.encoding !== 'utf-8'
  ) {
    fail(
      'K4-SOURCE-DESCRIPTOR-001',
      'Embedded source descriptor format, mode, mediaType, or encoding is invalid',
    );
  }
  const sourceId = requireNonEmptyString(input.sourceId, 'sourceId');
  const displayName = requireDisplayName(input.displayName);
  const text = requireNonEmptyString(input.text, 'text');
  if (canonicalizeDsl4Source(text) !== text) {
    fail('K4-SOURCE-DESCRIPTOR-001', 'Embedded source text is not canonical');
  }
  const bytes = encodeSource(text, limit);
  if (!Number.isSafeInteger(input.byteLength) || input.byteLength !== bytes.length) {
    fail('K4-SOURCE-DESCRIPTOR-001', 'Embedded source byteLength does not match UTF-8 text');
  }
  if (
    typeof input.integrity !== 'string' ||
    !/^sha256-[A-Za-z0-9+/]{43}=$/u.test(input.integrity)
  ) {
    fail('K4-SOURCE-DESCRIPTOR-001', 'Embedded source integrity is not a SHA-256 SRI value');
  }
  const expectedIntegrity = await computeDsl4Sha256Integrity(bytes, subtleCrypto);
  if (input.integrity !== expectedIntegrity) {
    fail('K4-SOURCE-INTEGRITY-001', 'Embedded source integrity does not match UTF-8 text');
  }
  const cacheIdentity =
    input.cacheIdentity === undefined ? null : requireCacheIdentity(input.cacheIdentity);
  let sourceOrigins = null;
  if (input.sourceOrigins !== undefined) {
    try {
      sourceOrigins = validateDsl4SourceOriginDescriptor(input.sourceOrigins, sourceOriginLimits);
    } catch (error) {
      if (error instanceof Dsl4SourceOriginError) fail(error.code, error.message);
      throw error;
    }
  }
  if (cacheIdentity && cacheIdentity.label !== displayName) {
    fail(
      'K4-SOURCE-DESCRIPTOR-001',
      'cacheIdentity.label must match the source descriptor displayName',
    );
  }
  return deepFreeze({
    formatVersion: 1,
    mode: 'embedded',
    sourceId,
    displayName,
    mediaType: 'application/yaml',
    encoding: 'utf-8',
    byteLength: bytes.length,
    integrity: expectedIntegrity,
    text,
    ...(cacheIdentity ? {cacheIdentity} : {}),
    ...(sourceOrigins ? {sourceOrigins} : {}),
  });
}

/** Resolve exactly one descriptor location without cross-channel fallback. */
export async function resolveDsl4EmbeddedSource(
  project: unknown,
  {
    maxSourceBytes,
    sourceOriginLimits,
    subtleCrypto = globalThis.crypto?.subtle,
  }: {
    maxSourceBytes: number;
    sourceOriginLimits?: Record<string, number>;
    subtleCrypto?: Dsl4SubtleCrypto | undefined;
  },
) {
  if (!isRecord(project)) {
    fail('K4-SOURCE-DESCRIPTOR-001', 'Project must be an object');
  }
  const extensionStorage = isRecord(project.extensionStorage) ? project.extensionStorage : {};
  const runtimeStorage = isRecord(extensionStorage.kubohiroyakamishibairuntime4)
    ? extensionStorage.kubohiroyakamishibairuntime4
    : {};
  const bundleStorage = isRecord(extensionStorage.kubohiroyakamishibai4)
    ? extensionStorage.kubohiroyakamishibai4
    : {};
  const components = isRecord(bundleStorage.components) ? bundleStorage.components : {};
  const bundledRuntime = isRecord(components.kubohiroyakamishibairuntime4)
    ? components.kubohiroyakamishibairuntime4
    : {};
  const locations = [
    {
      channel: 'unbundled',
      descriptor: runtimeStorage.source,
      path: dsl4SourceStoragePaths.unbundled,
    },
    {
      channel: 'bundled',
      descriptor: bundledRuntime.source,
      path: dsl4SourceStoragePaths.bundled,
    },
  ].filter(({descriptor}) => descriptor !== undefined);

  if (locations.length === 0) {
    fail('K4-SOURCE-CHANNEL-MISSING', 'DSL 4.0 embedded source descriptor is missing');
  }
  if (locations.length !== 1) {
    fail(
      'K4-SOURCE-CHANNEL-AMBIGUOUS',
      'DSL 4.0 embedded source exists in both bundled and unbundled storage',
    );
  }
  const location = locations[0];
  const descriptor = await validateDsl4EmbeddedSourceDescriptor(location.descriptor, {
    maxSourceBytes,
    sourceOriginLimits,
    subtleCrypto,
  });
  return deepFreeze({channel: location.channel, path: location.path, descriptor});
}
