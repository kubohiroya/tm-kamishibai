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

/** @param {Record<string, unknown>} variable @param {boolean} observeWrites @param {string} name */
function createVariableChannel(variable, observeWrites, name) {
  const descriptor = Object.getOwnPropertyDescriptor(variable, 'value');
  if (!descriptor) {
    throw adapterError('K4-TW-POSE-FEEDBACK-001', `Scratch variable has no value: ${name}`);
  }
  const dataProperty = Object.hasOwn(descriptor, 'value');
  if (dataProperty && descriptor.writable !== true) {
    throw adapterError('K4-TW-POSE-FEEDBACK-001', `Scratch variable is read-only: ${name}`);
  }
  if (
    !dataProperty &&
    (typeof descriptor.get !== 'function' || typeof descriptor.set !== 'function')
  ) {
    throw adapterError(
      'K4-TW-POSE-FEEDBACK-001',
      `Scratch variable is not readable/writable: ${name}`,
    );
  }
  if (observeWrites && descriptor.configurable !== true) {
    throw adapterError(
      'K4-TW-POSE-FEEDBACK-001',
      `Scratch variable cannot expose binding revisions: ${name}`,
    );
  }

  let dataValue = descriptor.value;
  let revision = 0;
  let observing = false;
  const readUnderlying = dataProperty
    ? observeWrites
      ? () => dataValue
      : () => variable.value
    : () => /** @type {Function} */ (descriptor.get).call(variable);
  const writeUnderlying = dataProperty
    ? observeWrites
      ? (/** @type {unknown} */ value) => {
          dataValue = value;
        }
      : (/** @type {unknown} */ value) => {
          variable.value = value;
        }
    : (/** @type {unknown} */ value) => {
        /** @type {Function} */ (descriptor.set).call(variable, value);
      };

  if (observeWrites) {
    Object.defineProperty(variable, 'value', {
      configurable: true,
      enumerable: descriptor.enumerable ?? true,
      get: readUnderlying,
      set(value) {
        writeUnderlying(value);
        revision += 1;
      },
    });
    observing = true;
  }

  return {
    read: readUnderlying,
    writeAuthoritative: writeUnderlying,
    getRevision: () => revision,
    detach() {
      if (!observing) return;
      observing = false;
      if (dataProperty) {
        Object.defineProperty(variable, 'value', {...descriptor, value: dataValue});
      } else {
        Object.defineProperty(variable, 'value', descriptor);
      }
    },
  };
}

/** @param {unknown[]} errors @param {string} message */
function throwCollected(errors, message) {
  if (errors.length === 0) return;
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, message);
}

/**
 * Create one platform-only consumer for the renderer-independent pose state contract.
 *
 * In binding mode, configurable Scratch value properties are wrapped for the session lifetime.
 * Every successful external set increments a monotonic revision; authoritative projections bypass
 * that revision so the adapter can reject more than one write to either variable in one pose tick.
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
  const observeWrites = options.mode === 'scratchBinding';
  const confidenceChannel = createVariableChannel(
    confidenceVariable,
    observeWrites,
    variableNames.confidence,
  );
  /** @type {ReturnType<typeof createVariableChannel>} */
  let progressChannel;
  try {
    progressChannel = createVariableChannel(
      progressVariable,
      observeWrites,
      variableNames.progress,
    );
  } catch (error) {
    confidenceChannel.detach();
    throw error;
  }

  let disposed = false;
  let active = false;
  let sampled = true;
  /** @type {{confidence: number, progress: number, confidenceRevision: number, progressRevision: number} | null} */
  let projection = null;

  /** @param {{confidence: number, progress: number}} value */
  function writePair(value) {
    const previous = {
      confidence: confidenceChannel.read(),
      progress: progressChannel.read(),
    };
    try {
      confidenceChannel.writeAuthoritative(value.confidence);
      progressChannel.writeAuthoritative(value.progress);
    } catch (error) {
      const errors = [error];
      for (const [channel, previousValue] of [
        [progressChannel, previous.progress],
        [confidenceChannel, previous.confidence],
      ]) {
        try {
          channel.writeAuthoritative(previousValue);
        } catch (rollbackError) {
          errors.push(rollbackError);
        }
      }
      throwCollected(errors, 'Scratch pose feedback projection and rollback failed');
    }
  }

  function restoreProjection() {
    if (!projection) return;
    try {
      writePair(projection);
    } catch {
      // A failed platform projection cannot become authoritative pose input.
    }
  }

  const adapter = {
    /** @param {unknown} input */
    onPoseState(input) {
      if (disposed) return;
      const event = createDsl4PoseStateEvent(input);
      const terminal = event.phase === 'completed' || event.phase === 'cancelled';
      if (terminal) {
        active = false;
        sampled = true;
        writePair({confidence: 0, progress: 0});
        projection = null;
        return;
      }
      const nextProjection = {
        confidence: event.confidence * 100,
        progress: event.progress * 100,
      };
      writePair(nextProjection);
      projection = {
        ...nextProjection,
        confidenceRevision: confidenceChannel.getRevision(),
        progressRevision: progressChannel.getRevision(),
      };
      active = true;
      sampled = false;
    },

    readPoseStateBinding() {
      if (disposed || options.mode !== 'scratchBinding' || !active || !projection || sampled) {
        return null;
      }
      sampled = true;
      const confidenceWriteCount = confidenceChannel.getRevision() - projection.confidenceRevision;
      const progressWriteCount = progressChannel.getRevision() - projection.progressRevision;
      if (confidenceWriteCount > 1 || progressWriteCount > 1) {
        restoreProjection();
        return null;
      }
      const confidence = parseScratchPercentage(confidenceChannel.read());
      const progress = parseScratchPercentage(progressChannel.read());
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
      try {
        writePair({confidence: 0, progress: 0});
      } catch (error) {
        errors.push(error);
      }
      for (const channel of [progressChannel, confidenceChannel]) {
        try {
          channel.detach();
        } catch (error) {
          errors.push(error);
        }
      }
      throwCollected(errors, 'Scratch pose feedback cleanup failed');
    },
  };

  return Object.freeze(adapter);
}
