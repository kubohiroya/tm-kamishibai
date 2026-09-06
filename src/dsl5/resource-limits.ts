import {deepFreeze} from '../dsl4/story-document.js';

/**
 * Every bound DSL 5.0 places on what one publication may cost to read.
 *
 * They are listed in one record so that a reader can see the whole envelope at once. DSL 4.0 spread
 * the same idea across `dsl4SourceGraphDefaultLimits`, `dsl4CliDefaultLimits`, the browser preview
 * artifact limits, and a handful of literals at call sites; the values agreed, but nothing said so.
 *
 * The source and asset numbers carry over from 4.0 unchanged, so a 4.0 story converted to 5.0 is not
 * newly rejected. The numbers for concepts 5.0 introduces are starting points chosen to be finite
 * rather than measured -- each names the child issue that owns it, and that issue is where a
 * measured value replaces this one.
 */
export const dsl5DefaultResourceLimits = deepFreeze({
  // Carried from `dsl4SourceGraphDefaultLimits` and `dsl4CliDefaultLimits`.
  maxSourceBytes: 1024 * 1024,
  maxSourceFiles: 64,
  maxTotalSourceBytes: 4 * 1024 * 1024,
  maxIncludeDepth: 32,
  maxAssetFiles: 256,
  maxAssetFileBytes: 16 * 1024 * 1024,
  maxTotalAssetBytes: 128 * 1024 * 1024,

  // YAML anchor/alias expansion (#774). The epic bounds expansions, expanded nodes, depth and
  // actions separately because one alias can be cheap by every measure but the last.
  maxAliasExpansions: 1024,
  maxExpandedNodes: 65_536,
  maxAliasDepth: 16,
  maxActionsPerScene: 4096,

  // Publication and segment loading (#773). `maxCachedDocuments` is the bound that keeps a long
  // publication from holding every StoryDocument at once, which is the point of segmenting at all.
  maxSegments: 1024,
  maxCachedDocuments: 8,

  // Save data (#771). A save holds variables and history, not assets, so it is small by design;
  // the bound exists so a corrupt or hostile file cannot be read into memory before it is rejected.
  maxSaveDataBytes: 4 * 1024 * 1024,
  maxSaveHistoryEntries: 16_384,
});

export type Dsl5ResourceLimits = typeof dsl5DefaultResourceLimits;

const resourceLimitKeys = new Set(Object.keys(dsl5DefaultResourceLimits));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Resolve one immutable limit snapshot, refusing a bound that is not a finite positive integer.
 *
 * `Infinity` is rejected along with the rest: a limit that is not finite is not a limit, and the
 * epic requires every format to carry finite ones.
 */
export function resolveDsl5ResourceLimits(input: unknown = {}): Dsl5ResourceLimits {
  if (!isRecord(input)) throw new TypeError('DSL 5.0 resource limits must be an object');
  const unknown = Object.keys(input)
    .filter((key) => !resourceLimitKeys.has(key))
    .sort();
  if (unknown.length > 0) {
    throw new TypeError(`Unknown DSL 5.0 resource limit: ${unknown.join(', ')}`);
  }
  const resolved = {...dsl5DefaultResourceLimits, ...input};
  for (const [name, value] of Object.entries(resolved)) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive safe integer`);
    }
  }
  if (resolved.maxTotalSourceBytes < resolved.maxSourceBytes) {
    throw new TypeError('maxTotalSourceBytes must be greater than or equal to maxSourceBytes');
  }
  if (resolved.maxTotalAssetBytes < resolved.maxAssetFileBytes) {
    throw new TypeError('maxTotalAssetBytes must be greater than or equal to maxAssetFileBytes');
  }
  return deepFreeze(resolved) as Dsl5ResourceLimits;
}
