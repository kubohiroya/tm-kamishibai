import {createTurboWarpBubbleComposition} from '@kubohiroya/turbowarp-bubble/turbowarp-adapter';
import {bubbleStyleNameForStyleIds, composeBubbleStyles} from '../bubble-style.js';

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const bubbleStyleFields = Object.freeze([
  'textStyle',
  'maxWidth',
  'textLocale',
  'placement',
  'distance',
  'tailLength',
  'offset',
  'visualStyle',
  'portrait',
  'continueIndicator',
  'reveal',
  'audio',
  'showAnimation',
  'hideAnimation',
]);

/** @param {Record<string, Function>} composition @param {string} name @param {Record<string, unknown>} style */
function defineStyle(composition, name, style) {
  composition.defineStyle(
    Object.fromEntries([
      ['name', name],
      ['textStyle', style.textStyle ?? 'default'],
      ...bubbleStyleFields
        .filter((field) => field !== 'textStyle' && Object.hasOwn(style, field))
        .map((field) => [field, style[field]]),
    ]),
  );
}

/**
 * Create the app-shell-owned Bubble composition used by DSL 4.0 say and think actions.
 *
 * @param {object} options
 * @param {unknown} options.runtime
 * @param {unknown} options.storyDocument
 * @param {unknown} options.assetManager
 * @param {unknown} options.textCapability
 * @param {unknown} [options.scheduler]
 * @param {Function} [options.createComposition]
 */
export function createDsl4BubblePlatform(options) {
  if (!isRecord(options)) throw new TypeError('Bubble platform options must be an object');
  if (!isRecord(options.storyDocument) || options.storyDocument.version !== '4.0') {
    throw new TypeError('Bubble platform requires a validated DSL 4.0 StoryDocument');
  }
  const createComposition = options.createComposition ?? createTurboWarpBubbleComposition;
  if (typeof createComposition !== 'function') {
    throw new TypeError('Bubble platform createComposition must be a function');
  }
  const composition = /** @type {Record<string, Function>} */ (
    createComposition(options.runtime, {
      imageResolver: options.assetManager,
      audio: options.assetManager,
      textCapability: options.textCapability,
      ...(options.scheduler === undefined ? {} : {scheduler: options.scheduler}),
    })
  );
  for (const method of ['defineStyle', 'show', 'releaseAll']) {
    if (typeof composition[method] !== 'function') {
      throw new TypeError(`Bubble composition must provide ${method}`);
    }
  }
  composition.defineStyle({
    name: '__dsl4_default__',
    textStyle: 'default',
    visualStyle: 'NORMAL',
  });
  composition.defineStyle({
    name: '__dsl4_default_think__',
    textStyle: 'default',
    visualStyle: 'THINKING',
  });
  const styles = /** @type {Record<string, Record<string, unknown>>} */ (
    options.storyDocument.bubbleStyles ?? {}
  );
  for (const name of Object.keys(styles)) {
    defineStyle(composition, name, composeBubbleStyles([name], styles));
  }
  const definedCompositions = new Set();
  for (const scene of /** @type {ReadonlyArray<Record<string, unknown>>} */ (
    options.storyDocument.scenes ?? []
  )) {
    for (const action of /** @type {ReadonlyArray<Record<string, unknown>>} */ (
      scene.actions ?? []
    )) {
      if (action.command !== 'say' && action.command !== 'think') continue;
      const args = /** @type {Record<string, unknown>} */ (action.args ?? {});
      if (!Array.isArray(args.styles) || args.styles.length === 0) continue;
      const styleIds = /** @type {string[]} */ (args.styles);
      const name = bubbleStyleNameForStyleIds(styleIds);
      if (definedCompositions.has(name)) continue;
      definedCompositions.add(name);
      defineStyle(composition, name, composeBubbleStyles(styleIds, styles));
    }
  }
  return Object.freeze({composition, releaseAll: () => composition.releaseAll()});
}
