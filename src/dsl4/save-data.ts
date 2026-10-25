import {createDsl4HistoryReducer, type HistoryState} from './history-reducer.js';
import {decodeDsl4Envelope} from './format-versions.js';
import {deepFreeze} from './story-document.js';
import {isDsl4VideoUrl} from './video-source.js';

export const dsl4SaveDataFormatVersion = 1;
export interface Dsl4SaveLimits {
  maxBytes: number;
  maxEntries: number;
  maxDepth: number;
}
export const dsl4SaveDataLimits: Readonly<Dsl4SaveLimits> = Object.freeze({
  maxBytes: 2_097_152,
  maxEntries: 20_000,
  maxDepth: 32,
});
export interface Dsl4SaveIdentity {
  readonly storyId: string;
  readonly sourceIntegrity: string;
}
export interface Dsl4SaveDataV1 extends Dsl4SaveIdentity {
  readonly formatVersion: 1;
  readonly dslVersion: '4.0';
  readonly savedAt: string;
  readonly runtime: Readonly<{
    sceneId: string;
    actionIndex: number;
    variables: Readonly<Record<string, string | number | boolean>>;
    status: 'paused' | 'finished';
    history: Readonly<HistoryState>;
  }>;
  readonly presentation: Readonly<Record<string, unknown>>;
}
export class Dsl4SaveDataError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'Dsl4SaveDataError';
  }
}
function invalid(message: string): never {
  throw new Dsl4SaveDataError('K4-SAVE-DATA', message);
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    invalid('Save data must contain objects');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: readonly string[]) {
  if (
    Object.keys(value).length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key))
  )
    invalid('Save data keys are invalid');
}
function limits(input: Partial<typeof dsl4SaveDataLimits>) {
  const result = {...dsl4SaveDataLimits, ...input};
  for (const [name, value] of Object.entries(result))
    if (
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > dsl4SaveDataLimits[name as keyof typeof dsl4SaveDataLimits]
    )
      invalid(`Invalid save limit: ${name}`);
  return result;
}
/** Inspect data before serialization; getters, cycles and values JSON would silently change are refused. */
function assertJson(value: unknown, maximum: ReturnType<typeof limits>) {
  let entries = 0;
  const seen = new Set<object>();
  function visit(item: unknown, depth: number) {
    if (++entries > maximum.maxEntries || depth > maximum.maxDepth)
      invalid('Save entry/depth limit exceeded');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || seen.has(item)) invalid('Save data is not finite JSON data');
    if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item)))
      invalid('Save data must use plain JSON objects');
    seen.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (
      Array.isArray(item) &&
      (Object.keys(item).length !== item.length ||
        Object.keys(item).some((key, index) => key !== String(index)))
    )
      invalid('Save arrays must be dense JSON arrays');
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(item) && key === 'length') continue;
      if (!descriptor.enumerable) invalid('Save data contains nonenumerable properties');
      if (!Object.hasOwn(descriptor, 'value')) invalid('Save data must not contain accessors');
      visit(descriptor.value, depth + 1);
    }
    if (Object.getOwnPropertySymbols(item).length) invalid('Save data must not contain symbols');
    seen.delete(item);
  }
  visit(value, 0);
}

/** Decode an independent, bounded save format. A source update is an explicit incompatibility, never an implicit migration. */
export function decodeDsl4SaveData(
  input: unknown,
  options: Partial<typeof dsl4SaveDataLimits> & {identity?: Dsl4SaveIdentity} = {},
): Readonly<Dsl4SaveDataV1> {
  const {identity, ...limitOptions} = options;
  const maximum = limits(limitOptions);
  assertJson(input, maximum);
  const value = decodeDsl4Envelope(input, {
    kind: 'saveData',
    requiredKeys: [
      'dslVersion',
      'storyId',
      'sourceIntegrity',
      'savedAt',
      'runtime',
      'presentation',
    ],
  });
  if (
    value.dslVersion !== '4.0' ||
    typeof value.storyId !== 'string' ||
    !value.storyId ||
    value.storyId.length > 256 ||
    value.storyId.includes('\0')
  )
    invalid('Save identity is invalid');
  if (
    typeof value.sourceIntegrity !== 'string' ||
    !/^sha256-[A-Za-z0-9+/]{43}=$/u.test(value.sourceIntegrity)
  )
    invalid('Save source fingerprint is invalid');
  if (
    identity &&
    (identity.storyId !== value.storyId || identity.sourceIntegrity !== value.sourceIntegrity)
  )
    throw new Dsl4SaveDataError(
      'K4-SAVE-INCOMPATIBLE',
      'Save belongs to a different story or source revision',
    );
  if (
    typeof value.savedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.savedAt)) ||
    new Date(value.savedAt).toISOString() !== value.savedAt
  )
    invalid('Save timestamp must be canonical UTC');
  const runtime = object(value.runtime);
  keys(runtime, ['sceneId', 'actionIndex', 'variables', 'status', 'history']);
  if (
    typeof runtime.sceneId !== 'string' ||
    !runtime.sceneId ||
    !Number.isSafeInteger(runtime.actionIndex) ||
    Number(runtime.actionIndex) < 0 ||
    !['paused', 'finished'].includes(String(runtime.status))
  )
    invalid('Save runtime position is invalid');
  for (const item of Object.values(object(runtime.variables)))
    if (
      typeof item !== 'string' &&
      typeof item !== 'boolean' &&
      !(typeof item === 'number' && Number.isFinite(item))
    )
      invalid('Save variable must be a finite scalar');
  if (
    Object.values(object(runtime.variables)).some(
      (item) => typeof item === 'string' && item.startsWith('@os1.'),
    )
  )
    invalid('Transient object-store handles cannot be saved');
  try {
    createDsl4HistoryReducer({
      maxActionEntries: maximum.maxEntries,
      maxSceneVisits: maximum.maxEntries,
    }).restore(runtime.history);
  } catch (error) {
    throw new Dsl4SaveDataError('K4-SAVE-HISTORY', 'Save history violates its DTO invariants', {
      cause: error,
    });
  }
  const presentation = object(value.presentation);
  // Presentation handlers must persist portable references, not transient browser capabilities.
  function portable(item: unknown): void {
    if (typeof item === 'string' && /^blob:/iu.test(item))
      invalid('Object URLs cannot be persisted');
    if (item && typeof item === 'object') Object.values(item).forEach(portable);
  }
  portable(presentation);
  if (Object.hasOwn(presentation, 'videos')) {
    if (!Array.isArray(presentation.videos) || presentation.videos.length > 32)
      invalid('Save video limit exceeded');
    const ids = new Set<string>();
    for (const item of presentation.videos) {
      const state = object(item);
      keys(state, ['display', 'time', 'paused', 'loop', 'volume', 'muted', 'rate']);
      const display = object(state.display);
      if (typeof display.id !== 'string' || !display.id || ids.has(display.id))
        invalid('Save video ID is invalid or duplicated');
      ids.add(display.id);
      if (
        Object.hasOwn(display, 'asset') === Object.hasOwn(display, 'url') ||
        (Object.hasOwn(display, 'asset') &&
          (typeof display.asset !== 'string' || !display.asset)) ||
        (Object.hasOwn(display, 'url') && !isDsl4VideoUrl(display.url))
      )
        invalid('Save video source must be an asset or HTTP(S) URL');
      if (
        Object.keys(display).some(
          (key) =>
            ![
              'id',
              'asset',
              'url',
              'x',
              'y',
              'width',
              'height',
              'muted',
              'volume',
              'playbackRate',
              'plane',
              'zIndex',
              'fit',
            ].includes(key),
        )
      )
        invalid('Unknown saved video display key');
      for (const field of ['x', 'y', 'width', 'height'])
        if (
          typeof display[field] !== 'number' ||
          !Number.isFinite(display[field]) ||
          (['width', 'height'].includes(field) && Number(display[field]) <= 0)
        )
          invalid('Saved video rectangle is invalid');
      if (display.plane !== undefined && !['front', 'background'].includes(String(display.plane)))
        invalid('Saved video plane is invalid');
      if (display.fit !== undefined && !['contain', 'cover'].includes(String(display.fit)))
        invalid('Saved video fit is invalid');
      if (display.muted !== undefined && typeof display.muted !== 'boolean')
        invalid('Invalid video display muted');
      if (
        display.volume !== undefined &&
        (typeof display.volume !== 'number' || display.volume < 0 || display.volume > 100)
      )
        invalid('Invalid video display volume');
      if (
        display.playbackRate !== undefined &&
        (typeof display.playbackRate !== 'number' ||
          display.playbackRate < 0.25 ||
          display.playbackRate > 4)
      )
        invalid('Invalid video display rate');
      if (display.zIndex !== undefined && !Number.isSafeInteger(display.zIndex))
        invalid('Saved video zIndex is invalid');
      for (const [field, min, max] of [
        ['time', 0, Number.MAX_SAFE_INTEGER],
        ['volume', 0, 100],
        ['rate', 0.25, 4],
      ] as const)
        if (
          typeof state[field] !== 'number' ||
          !Number.isFinite(state[field]) ||
          Number(state[field]) < min ||
          Number(state[field]) > max
        )
          invalid(`Invalid saved video ${field}`);
      if (['paused', 'loop', 'muted'].some((field) => typeof state[field] !== 'boolean'))
        invalid('Invalid saved video playback state');
    }
  }
  const json = JSON.stringify(value);
  if (new TextEncoder().encode(json).byteLength > maximum.maxBytes)
    invalid('Save byte limit exceeded');
  return deepFreeze(JSON.parse(json)) as Readonly<Dsl4SaveDataV1>;
}

export function encodeDsl4SaveBlob(
  input: unknown,
  options: Parameters<typeof decodeDsl4SaveData>[1] = {},
) {
  return new Blob([JSON.stringify(decodeDsl4SaveData(input, options))], {type: 'application/json'});
}
export async function decodeDsl4SaveBlob(
  blob: Blob,
  options: Parameters<typeof decodeDsl4SaveData>[1] = {},
) {
  if (!(blob instanceof Blob) || blob.size > (options.maxBytes ?? dsl4SaveDataLimits.maxBytes))
    invalid('Save Blob byte limit exceeded');
  let input: unknown;
  try {
    input = JSON.parse(await blob.text());
  } catch (error) {
    throw new Dsl4SaveDataError('K4-SAVE-DATA', 'Save Blob is not valid JSON', {cause: error});
  }
  return decodeDsl4SaveData(input, options);
}
