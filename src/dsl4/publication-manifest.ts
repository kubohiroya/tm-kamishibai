import {decodeDsl4Envelope, dsl4FormatVersions} from './format-versions.js';
import {deepFreeze} from './story-document.js';

export const dsl4PublicationManifestFormatVersion = 1;

export interface Dsl4SegmentSource {
  readonly entry: string;
  readonly integrity: string;
  readonly size: number;
  readonly url?: string;
}
export interface Dsl4PublicationSegment {
  readonly id: string;
  readonly title: string;
  readonly source: Dsl4SegmentSource;
  readonly next: readonly string[];
}
export interface Dsl4PublicationManifestV1 {
  readonly formatVersion: 1;
  readonly id: string;
  readonly title: string;
  readonly entrySegment: string;
  readonly entryPoints: readonly string[];
  /** Array order is chapter order; explicit next links describe branches. */
  readonly segments: readonly Dsl4PublicationSegment[];
}
export interface Dsl4PublicationPosition {
  readonly segmentId: string;
  readonly sceneId: string;
  readonly actionPath: string | null;
}

function record(value: unknown, keys: readonly string[], required = keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Publication record must be an object');
  const r = value as Record<string, unknown>;
  if (
    Object.keys(r).some((key) => !keys.includes(key)) ||
    required.some((key) => !Object.hasOwn(r, key))
  )
    throw new TypeError('Publication record has unknown or missing keys');
  return r;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024)
    throw new TypeError('Publication text must be a nonempty bounded string');
  return value;
}
function id(value: unknown) {
  const result = text(value);
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(result) ||
    ['constructor', 'prototype', '__proto__'].includes(result)
  )
    throw new TypeError('Invalid publication identifier');
  return result;
}
function ids(value: unknown) {
  if (!Array.isArray(value) || value.length > 4096)
    throw new TypeError('Invalid publication links');
  const result = value.map(id);
  if (new Set(result).size !== result.length) throw new TypeError('Duplicate publication link');
  return result;
}

/** A separate envelope over complete DSL 4.0 sources, never a new source language version. */
export function validateDsl4PublicationManifest(
  input: unknown,
): Readonly<Dsl4PublicationManifestV1> {
  const value = decodeDsl4Envelope(input, {
    kind: 'publicationManifest',
    requiredKeys: ['id', 'title', 'entrySegment', 'entryPoints', 'segments'],
  });
  if (!Array.isArray(value.segments) || value.segments.length === 0 || value.segments.length > 4096)
    throw new TypeError('Publication must contain 1 to 4096 segments');
  const segments = value.segments.map((item) => {
    const segment = record(item, ['id', 'title', 'source', 'next']);
    const source = record(
      segment.source,
      ['entry', 'integrity', 'size', 'url'],
      ['entry', 'integrity', 'size'],
    );
    const entry = text(source.entry);
    if (
      entry.includes('\\') ||
      entry.includes('\0') ||
      /[?#:%]/u.test(entry) ||
      entry.split('/').some((part) => !part || part === '.' || part === '..')
    )
      throw new TypeError('Segment entry must be a relative archive path');
    if (
      typeof source.integrity !== 'string' ||
      !/^sha256-[a-f0-9]{64}$/u.test(source.integrity) ||
      !Number.isSafeInteger(source.size) ||
      Number(source.size) <= 0 ||
      Number(source.size) > 1024 * 1024
    )
      throw new TypeError('Segment source requires a bounded size and SHA-256 integrity');
    let url: string | undefined;
    if (source.url !== undefined) {
      const parsed = new URL(text(source.url));
      if (
        !['https:', 'http:'].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password ||
        parsed.hash
      )
        throw new TypeError('Segment URL must be HTTP(S) without credentials or fragment');
      url = parsed.href;
    }
    return {
      id: id(segment.id),
      title: text(segment.title),
      next: ids(segment.next),
      source: {
        entry,
        integrity: source.integrity,
        size: Number(source.size),
        ...(url === undefined ? {} : {url}),
      },
    };
  });
  const known = new Set(segments.map((segment) => segment.id));
  if (known.size !== segments.length) throw new TypeError('Duplicate segment identifier');
  const entrySegment = id(value.entrySegment),
    entryPoints = ids(value.entryPoints);
  if (
    !known.has(entrySegment) ||
    entryPoints.some((key) => !known.has(key)) ||
    segments.some((segment) => segment.next.some((key) => !known.has(key)))
  )
    throw new TypeError('Publication contains an unknown segment reference');
  if (dsl4FormatVersions.publicationManifest !== dsl4PublicationManifestFormatVersion)
    throw new TypeError('Publication format index is inconsistent');
  return deepFreeze({
    formatVersion: 1 as const,
    id: id(value.id),
    title: text(value.title),
    entrySegment,
    entryPoints,
    segments,
  });
}

/** Resolve a stable position only against the complete validated document it belongs to. */
export function createDsl4PublicationPosition(
  segmentId: string,
  document: Readonly<Record<string, unknown>>,
  sceneId?: string,
  actionPath: string | null = null,
): Readonly<Dsl4PublicationPosition> {
  id(segmentId);
  const scenes = document.scenes as readonly {id: string; actions: readonly {id: string}[]}[];
  const scene = sceneId === undefined ? scenes[0] : scenes.find((item) => item.id === sceneId);
  if (!scene || (actionPath !== null && !scene.actions.some((action) => action.id === actionPath)))
    throw new TypeError('Publication position is outside the segment');
  return Object.freeze({segmentId, sceneId: scene.id, actionPath});
}
