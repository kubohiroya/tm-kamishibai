import {createDsl4PoseStateEvent} from '../pose-feedback-policy.js';

export const dsl4ScratchPoseFeedbackVariableNames = Object.freeze({
  confidence: 'ポーズ認識',
  progress: 'チャージ',
});

const supportedModes = new Set(['scratchMirror', 'scratchBinding']);
const scratchNumberPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {string} code @param {string} message */
function adapterError(code, message) {
  const error = new Error(message);
  Object.defineProperty(error, 'code', {value: code});
  return error;
}

/** @param {unknown} value */
function parseScratchPercentage(value) {
  let number = value;
  if (typeof number === 'string') {
    const source = number.trim();
    if (source.length === 0 || !scratchNumberPattern.test(source)) return null;
    number = Number(source);
  }
  if (typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number > 100) {
    return null;
  }
  return number;
}

/** @param {unknown} runtime */
function resolveStage(runtime) {
  if (!isRecord(runtime) || typeof runtime.getTargetForStage !== 'function') {
    throw new TypeError('TurboWarp runtime must provide getTargetForStage');
  }
  const stage = runtime.getTargetForStage();
  if (
    !isRecord(stage) ||
    stage.isStage !== true ||
    typeof stage.lookupVariableByNameAndType !== 'function'
  ) {
    throw adapterError('K4-TW-POSE-FEEDBACK-001', 'TurboWarp stage target is unavailable');
  }
  return /** @type {Record<string, unknown> & {lookupVariableByNameAndType: (name: string, type: string) => unknown}} */ (
    stage
  );
}

/** @param {ReturnType<typeof resolveStage>} stage @param {string} name */
function resolveVariable(stage, name) {
  const variable = stage.lookupVariableByNameAndType(name, '');
  if (!isRecord(variable) || !Object.hasOwn(variable, 'value') || variable.isCloud === true) {
    throw adapterError(
      'K4-TW-POSE-FEEDBACK-001',
      `Scratch stage variable is unavailable or unsupported: ${name}`,
    );
  }
  return variable;
}

/**
 * Create one platform-only consumer for the renderer-independent pose state contract.
 *
 * @param {object} options
 * @param {unknown} options.runtime
 * @param {'scratchMirror' | 'scratchBinding'} options.mode
 * @param {{confidence: string, progress: string}} [options.variableNames]
 */
export function createDsl4ScratchPoseFeedbackAdapter(options) {
  if (!isRecord(options)) throw new TypeError('Scratch pose feedback options must be an object');
  if (typeof options.mode !== 'string' || !supportedModes.has(options.mode)) {
    throw new TypeError('Scratch pose feedback mode must be scratchMirror or scratchBinding');
  }
  const variableNames = options.variableNames ?? dsl4ScratchPoseFeedbackVariableNames;
  if (
    !isRecord(variableNames) ||
    Object.keys(variableNames).length !== 2 ||
    typeof variableNames.confidence !== 'string' ||
    variableNames.confidence.length === 0 ||
    typeof variableNames.progress !== 'string' ||
    variableNames.progress.length === 0 ||
    variableNames.confidence === variableNames.progress
  ) {
    throw new TypeError('Scratch pose feedback variableNames must provide two distinct names');
  }

  const stage = resolveStage(options.runtime);
  const confidenceVariable = resolveVariable(stage, variableNames.confidence);
  const progressVariable = resolveVariable(stage, variableNames.progress);
  if (confidenceVariable === progressVariable) {
    throw adapterError('K4-TW-POSE-FEEDBACK-001', 'Scratch pose feedback variables are ambiguous');
  }

  let disposed = false;
  let active = false;
  let sampled = true;
  /** @type {{confidence: number, progress: number} | null} */
  let projection = null;

  /** @param {{confidence: number, progress: number}} value */
  function writeProjection(value) {
    confidenceVariable.value = value.confidence;
    progressVariable.value = value.progress;
  }

  function restoreProjection() {
    if (!projection) return;
    try {
      writeProjection(projection);
    } catch {
      // A failed platform projection cannot become authoritative pose input.
    }
  }

  const adapter = {
    /** @param {unknown} input */
    onPoseState(input) {
      if (disposed) return;
      const event = createDsl4PoseStateEvent(input);
      const nextProjection = {
        confidence: event.confidence * 100,
        progress: event.progress * 100,
      };
      writeProjection(nextProjection);
      projection = nextProjection;
      active = event.phase === 'waiting' || event.phase === 'charging';
      sampled = !active;
    },

    readPoseStateBinding() {
      if (disposed || options.mode !== 'scratchBinding' || !active || !projection || sampled) {
        return null;
      }
      sampled = true;
      const confidence = parseScratchPercentage(confidenceVariable.value);
      const progress = parseScratchPercentage(progressVariable.value);
      if (confidence === null || progress === null) {
        restoreProjection();
        return null;
      }
      const confidenceChanged = confidence !== projection.confidence;
      const progressChanged = progress !== projection.progress;
      if (!confidenceChanged && !progressChanged) return null;
      return Object.freeze({
        ...(confidenceChanged ? {confidence: confidence / 100} : {}),
        ...(progressChanged ? {progress: progress / 100} : {}),
      });
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      active = false;
      sampled = true;
      projection = null;
      const errors = [];
      for (const variable of [confidenceVariable, progressVariable]) {
        try {
          variable.value = 0;
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, 'Scratch pose feedback cleanup failed');
      }
    },
  };

  return Object.freeze(adapter);
}
