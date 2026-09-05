import {createTurboWarpBubbleComposition} from '@kubohiroya/turbowarp-bubble/turbowarp-adapter';
import {bubbleStyleNameForStyleIds, composeBubbleStyles} from '../bubble-style.js';

function isRecord(value: unknown): value is Record<string, unknown> {
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

function defineStyle(
  composition: Record<string, Function>,
  name: string,
  style: Record<string, unknown>,
) {
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

/** Create the app-shell-owned Bubble composition used by DSL 4.0 say and think actions. */
export function createDsl4BubblePlatform(options: {
  runtime: unknown;
  storyDocument: unknown;
  assetManager: unknown;
  textCapability: unknown;
  scheduler?: unknown;
  createComposition?: Function;
}) {
  if (!isRecord(options)) throw new TypeError('Bubble platform options must be an object');
  if (!isRecord(options.storyDocument) || options.storyDocument.version !== '4.0') {
    throw new TypeError('Bubble platform requires a validated DSL 4.0 StoryDocument');
  }
  const createComposition = options.createComposition ?? createTurboWarpBubbleComposition;
  if (typeof createComposition !== 'function') {
    throw new TypeError('Bubble platform createComposition must be a function');
  }
  const composition = createComposition(options.runtime, {
    imageResolver: options.assetManager,
    audio: options.assetManager,
    textCapability: options.textCapability,
    ...(options.scheduler === undefined ? {} : {scheduler: options.scheduler}),
  }) as Record<string, Function>;
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
  const styles = (options.storyDocument.bubbleStyles ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  for (const name of Object.keys(styles)) {
    defineStyle(composition, name, composeBubbleStyles([name], styles));
  }
  const definedCompositions = new Set();
  for (const scene of (options.storyDocument.scenes ?? []) as ReadonlyArray<
    Record<string, unknown>
  >) {
    for (const action of (scene.actions ?? []) as ReadonlyArray<Record<string, unknown>>) {
      if (action.command !== 'say' && action.command !== 'think') continue;
      const args = (action.args ?? {}) as Record<string, unknown>;
      if (!Array.isArray(args.styles) || args.styles.length === 0) continue;
      const styleIds = args.styles as string[];
      const name = bubbleStyleNameForStyleIds(styleIds);
      if (definedCompositions.has(name)) continue;
      definedCompositions.add(name);
      defineStyle(composition, name, composeBubbleStyles(styleIds, styles));
    }
  }
  return Object.freeze({composition, releaseAll: () => composition.releaseAll()});
}
