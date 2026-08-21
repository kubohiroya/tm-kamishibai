import {encodeDsl4StoryPathSegment} from './story-path.js';

export const dsl4TransitionMaximumSeconds = 60;

export const dsl4CutTransition = Object.freeze({effect: 'cut'});

export const dsl4BuiltInTransitionDefaults = Object.freeze({
  scene: dsl4CutTransition,
  backdrop: dsl4CutTransition,
  actorSkin: dsl4CutTransition,
  actorVisibility: dsl4CutTransition,
  bgm: dsl4CutTransition,
});

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {string} message */
function transitionError(message) {
  const error = new TypeError(message);
  Object.defineProperty(error, 'code', {value: 'K4-TRANSITION-001'});
  return error;
}

/** @param {unknown} value @param {string} path */
function seconds(value, path) {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > dsl4TransitionMaximumSeconds ||
    !Number.isFinite(value * 1000)
  ) {
    throw transitionError(
      `${path} must be a finite number from 0 to ${dsl4TransitionMaximumSeconds}`,
    );
  }
  return value;
}

/**
 * Normalize the shared author-facing visual transition shorthand.
 *
 * @param {unknown} value
 * @param {string} [path]
 */
export function normalizeDsl4VisualTransition(value, path = 'transition') {
  if (typeof value === 'number') {
    const duration = seconds(value, path);
    return duration === 0
      ? dsl4CutTransition
      : Object.freeze({effect: 'crossfade', seconds: duration, easing: 'easeInOut'});
  }
  if (!isRecord(value)) throw transitionError(`${path} must be a number or object`);
  const effect = value.effect;
  if (effect === 'cut') {
    if (Object.keys(value).some((key) => key !== 'effect')) {
      throw transitionError(`${path} cut must not provide seconds or easing`);
    }
    return dsl4CutTransition;
  }
  if (effect !== 'crossfade') {
    throw transitionError(`${path}.effect must be cut or crossfade`);
  }
  if (Object.keys(value).some((key) => !['effect', 'seconds', 'easing'].includes(key))) {
    throw transitionError(`${path} contains an unknown property`);
  }
  const duration = seconds(value.seconds, `${path}.seconds`);
  if (duration === 0) return dsl4CutTransition;
  const easing = value.easing ?? 'easeInOut';
  if (!['linear', 'easeInOut'].includes(String(easing))) {
    throw transitionError(`${path}.easing must be linear or easeInOut`);
  }
  return Object.freeze({effect: 'crossfade', seconds: duration, easing: String(easing)});
}

/**
 * Normalize the BGM transition shorthand independently from visual easing.
 *
 * @param {unknown} value
 * @param {string} [path]
 */
export function normalizeDsl4AudioTransition(value, path = 'transition') {
  if (typeof value === 'number') {
    const duration = seconds(value, path);
    return duration === 0
      ? dsl4CutTransition
      : Object.freeze({effect: 'crossfade', seconds: duration, curve: 'equalPower'});
  }
  if (!isRecord(value)) throw transitionError(`${path} must be a number or object`);
  const effect = value.effect;
  if (effect === 'cut') {
    if (Object.keys(value).some((key) => key !== 'effect')) {
      throw transitionError(`${path} cut must not provide seconds or curve`);
    }
    return dsl4CutTransition;
  }
  if (effect !== 'crossfade') {
    throw transitionError(`${path}.effect must be cut or crossfade`);
  }
  if (Object.keys(value).some((key) => !['effect', 'seconds', 'curve'].includes(key))) {
    throw transitionError(`${path} contains an unknown property`);
  }
  const duration = seconds(value.seconds, `${path}.seconds`);
  if (duration === 0) return dsl4CutTransition;
  const curve = value.curve ?? 'equalPower';
  if (!['linear', 'equalPower'].includes(String(curve))) {
    throw transitionError(`${path}.curve must be linear or equalPower`);
  }
  return Object.freeze({effect: 'crossfade', seconds: duration, curve: String(curve)});
}

/** @param {unknown} value */
export function isDsl4CrossfadeTransition(value) {
  return isRecord(value) && value.effect === 'crossfade' && Number(value.seconds) > 0;
}

/** @param {Readonly<Record<string, unknown>>} storyDocument */
export function resolveDsl4TransitionDefaults(storyDocument) {
  const presentation = isRecord(storyDocument.presentation) ? storyDocument.presentation : {};
  const transitions = isRecord(presentation.transitions) ? presentation.transitions : {};
  const audio = isRecord(storyDocument.audio) ? storyDocument.audio : {};
  const bgm = isRecord(audio.bgm) ? audio.bgm : {};
  return Object.freeze({
    scene: Object.hasOwn(transitions, 'scene')
      ? normalizeDsl4VisualTransition(transitions.scene, 'presentation.transitions.scene')
      : dsl4CutTransition,
    backdrop: Object.hasOwn(transitions, 'backdrop')
      ? normalizeDsl4VisualTransition(transitions.backdrop, 'presentation.transitions.backdrop')
      : dsl4CutTransition,
    actorSkin: Object.hasOwn(transitions, 'actorSkin')
      ? normalizeDsl4VisualTransition(transitions.actorSkin, 'presentation.transitions.actorSkin')
      : dsl4CutTransition,
    actorVisibility: Object.hasOwn(transitions, 'actorVisibility')
      ? normalizeDsl4VisualTransition(
          transitions.actorVisibility,
          'presentation.transitions.actorVisibility',
        )
      : dsl4CutTransition,
    bgm: Object.hasOwn(bgm, 'transition')
      ? normalizeDsl4AudioTransition(bgm.transition, 'audio.bgm.transition')
      : dsl4CutTransition,
  });
}

/** @param {Readonly<Record<string, unknown>>} storyDocument */
export function dsl4StoryUsesCrossfade(storyDocument) {
  return dsl4FirstCrossfadeStoryPath(storyDocument) !== null;
}

/** @param {Readonly<Record<string, unknown>>} storyDocument */
export function dsl4FirstCrossfadeStoryPath(storyDocument) {
  const presentation = isRecord(storyDocument.presentation) ? storyDocument.presentation : {};
  const transitions = isRecord(presentation.transitions) ? presentation.transitions : {};
  for (const field of ['scene', 'backdrop', 'actorSkin', 'actorVisibility']) {
    if (isDsl4CrossfadeTransition(transitions[field])) {
      return `/presentation/transitions/${field}`;
    }
  }
  const audio = isRecord(storyDocument.audio) ? storyDocument.audio : {};
  const bgm = isRecord(audio.bgm) ? audio.bgm : {};
  if (isDsl4CrossfadeTransition(bgm.transition)) return '/audio/bgm/transition';
  const scenes = Array.isArray(storyDocument.scenes) ? storyDocument.scenes : [];
  for (let sceneIndex = 0; sceneIndex < scenes.length; sceneIndex += 1) {
    const scene = scenes[sceneIndex];
    if (!isRecord(scene)) continue;
    const sceneId =
      typeof scene.id === 'string' && scene.id.length > 0 ? scene.id : String(sceneIndex);
    const scenePath = `/scenes/${encodeDsl4StoryPathSegment(sceneId)}`;
    if (Object.hasOwn(scene, 'entryTransition')) {
      if (isDsl4CrossfadeTransition(scene.entryTransition)) return `${scenePath}/entryTransition`;
    }
    const actions = Array.isArray(scene.actions) ? scene.actions : [];
    for (let actionIndex = 0; actionIndex < actions.length; actionIndex += 1) {
      const action = actions[actionIndex];
      if (
        !isRecord(action) ||
        !isRecord(action.args) ||
        !Object.hasOwn(action.args, 'transition')
      ) {
        continue;
      }
      if (isDsl4CrossfadeTransition(action.args.transition)) {
        return `${scenePath}/actions/${actionIndex}/args/transition`;
      }
    }
  }
  return null;
}
