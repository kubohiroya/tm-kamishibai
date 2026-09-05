import {createDsl4PoseStateEvent} from '../pose-feedback-policy.js';

export const dsl4ScratchPoseFeedbackVariableNames = Object.freeze({
  confidence: 'ポーズ認識',
  progress: 'チャージ',
});

const supportedModes = new Set(['scratchMirror', 'scratchBinding']);
const scratchNumberPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function adapterError(code: string, message: string) {
  const error = new Error(message);
  Object.defineProperty(error, 'code', {value: code});
  return error;
}

function parseScratchPercentage(value: unknown) {
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

function validateRuntimeHost(value: unknown) {
  if (!isRecord(value) || typeof value.getStageTarget !== 'function' || !isRecord(value.runtime)) {
    throw new TypeError('Scratch pose feedback requires an injected TurboWarp runtime host');
  }
  return value as unknown as {
    getStageTarget: () => unknown;
    runtime: Record<string, unknown>;
  };
}

function resolveStage(runtimeHost: ReturnType<typeof validateRuntimeHost>) {
  const stage = runtimeHost.getStageTarget();
  if (
    !isRecord(stage) ||
    stage.isStage !== true ||
    typeof stage.lookupVariableByNameAndType !== 'function'
  ) {
    throw adapterError('K4-TW-POSE-FEEDBACK-001', 'TurboWarp stage target is unavailable');
  }
  return stage as Record<string, unknown> & {
    lookupVariableByNameAndType: (name: string, type: string) => unknown;
  };
}

function resolveVariable(stage: ReturnType<typeof resolveStage>, name: string) {
  const variable = stage.lookupVariableByNameAndType(name, '');
  if (
    !isRecord(variable) ||
    typeof variable.id !== 'string' ||
    variable.id.length === 0 ||
    variable.name !== name ||
    variable.type !== '' ||
    !Object.hasOwn(variable, 'value') ||
    variable.isCloud === true
  ) {
    throw adapterError(
      'K4-TW-POSE-FEEDBACK-001',
      `Scratch stage variable is unavailable or unsupported: ${name}`,
    );
  }
  return variable;
}

function monitorProperty(record: unknown, property: string) {
  if (!isRecord(record) || typeof record.get !== 'function') {
    throw adapterError('K4-TW-POSE-FEEDBACK-001', 'Scratch monitor state is unavailable');
  }
  return record.get(property);
}

/**
 * Resolve exactly one Stage scalar monitor through the same monitor block contract used by
 * Scratch's data_showvariable/data_hidevariable primitives.
 */
function createMonitorChannel(
  runtime: Record<string, unknown>,
  variable: Record<string, unknown>,
  name: string,
) {
  const monitorBlocksCandidate = runtime.monitorBlocks;
  const getMonitorState = runtime.getMonitorState;
  if (
    !isRecord(monitorBlocksCandidate) ||
    typeof monitorBlocksCandidate.getBlock !== 'function' ||
    typeof monitorBlocksCandidate.getScripts !== 'function' ||
    typeof monitorBlocksCandidate.changeBlock !== 'function' ||
    typeof getMonitorState !== 'function'
  ) {
    throw adapterError('K4-TW-POSE-FEEDBACK-001', 'TurboWarp monitor API is unavailable');
  }
  const monitorBlocks = monitorBlocksCandidate as {
    getBlock: Function;
    getScripts: Function;
    changeBlock: Function;
  };
  const monitorState = getMonitorState.call(runtime);
  if (
    !isRecord(monitorState) ||
    typeof monitorState.has !== 'function' ||
    typeof monitorState.get !== 'function' ||
    typeof monitorState.valueSeq !== 'function'
  ) {
    throw adapterError('K4-TW-POSE-FEEDBACK-001', 'TurboWarp monitor state is unavailable');
  }

  const id = variable.id as string;
  const matchingBlocks = monitorBlocks
    .getScripts()
    .map((blockId: string) => monitorBlocks.getBlock(blockId))
    .filter(
      (candidate: unknown) =>
        isRecord(candidate) &&
        candidate.opcode === 'data_variable' &&
        isRecord(candidate.fields) &&
        isRecord(candidate.fields.VARIABLE) &&
        candidate.fields.VARIABLE.id === id &&
        candidate.fields.VARIABLE.value === name,
    );
  const matchingRecords = [...monitorState.valueSeq()].filter((candidate) => {
    const params = monitorProperty(candidate, 'params');
    return (
      monitorProperty(candidate, 'opcode') === 'data_variable' &&
      monitorProperty(candidate, 'id') === id &&
      monitorProperty(candidate, 'targetId') === null &&
      isRecord(params) &&
      params.VARIABLE === name
    );
  });
  const block = monitorBlocks.getBlock(id);
  const record = monitorState.get(id);
  if (
    matchingBlocks.length !== 1 ||
    matchingBlocks[0] !== block ||
    matchingRecords.length !== 1 ||
    matchingRecords[0] !== record ||
    !isRecord(block) ||
    block.id !== id ||
    block.opcode !== 'data_variable' ||
    !isRecord(block.fields) ||
    !isRecord(block.fields.VARIABLE) ||
    block.fields.VARIABLE.id !== id ||
    block.fields.VARIABLE.value !== name ||
    typeof block.isMonitored !== 'boolean' ||
    !monitorState.has(id) ||
    monitorProperty(record, 'id') !== id ||
    monitorProperty(record, 'opcode') !== 'data_variable' ||
    monitorProperty(record, 'targetId') !== null ||
    monitorProperty(record, 'spriteName') !== null ||
    monitorProperty(record, 'mode') !== 'slider' ||
    monitorProperty(record, 'sliderMin') !== 0 ||
    monitorProperty(record, 'sliderMax') !== 100 ||
    monitorProperty(record, 'isDiscrete') !== true ||
    typeof monitorProperty(record, 'visible') !== 'boolean' ||
    block.isMonitored !== monitorProperty(record, 'visible')
  ) {
    throw adapterError(
      'K4-TW-POSE-FEEDBACK-001',
      `Scratch Stage variable monitor is missing, ambiguous, or unsupported: ${name}`,
    );
  }

  function readVisible() {
    const currentBlock = monitorBlocks.getBlock(id);
    const currentRecord = monitorState.get(id);
    const blockVisible = isRecord(currentBlock) ? currentBlock.isMonitored : undefined;
    const stateVisible = monitorProperty(currentRecord, 'visible');
    if (typeof blockVisible !== 'boolean' || blockVisible !== stateVisible) {
      throw adapterError(
        'K4-TW-POSE-FEEDBACK-001',
        `Scratch Stage variable monitor state is inconsistent: ${name}`,
      );
    }
    return blockVisible;
  }

  return {
    readVisible,
    writeVisible(visible: boolean) {
      if (readVisible() === visible) return;
      monitorBlocks.changeBlock({id, element: 'checkbox', value: visible}, runtime);
      if (readVisible() !== visible) {
        throw adapterError(
          'K4-TW-POSE-FEEDBACK-001',
          `Scratch Stage variable monitor visibility did not update: ${name}`,
        );
      }
    },
  };
}

function createVariableChannel(variable: Record<string, unknown>, name: string) {
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
  const readUnderlying = dataProperty
    ? () => variable.value
    : () => (descriptor.get as Function).call(variable);
  const writeUnderlying = dataProperty
    ? (value: unknown) => {
        variable.value = value;
      }
    : (value: unknown) => {
        (descriptor.set as Function).call(variable, value);
      };

  return {
    read: readUnderlying,
    writeAuthoritative: writeUnderlying,
  };
}

function throwCollected(errors: unknown[], message: string) {
  if (errors.length === 0) return;
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, message);
}

/**
 * Create one platform-only consumer for the renderer-independent pose state contract.
 * In binding mode, Scratch keeps its normal ordered-write semantics. The adapter samples the final
 * variable pair once at the pose tick boundary, so multiple writes deterministically use the last
 * values produced by the Scratch runtime. Invalid final pairs are restored atomically.
 */
export function createDsl4ScratchPoseFeedbackAdapter(options: {
  /** Injected `@kubohiroya/turbowarp-runtime-host` adapter. */
  runtimeHost: unknown;
  mode: 'scratchMirror' | 'scratchBinding';
  variableNames?: {confidence: string; progress: string};
}) {
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

  const runtimeHost = validateRuntimeHost(options.runtimeHost);
  const stage = resolveStage(runtimeHost);
  const confidenceVariable = resolveVariable(stage, variableNames.confidence);
  const progressVariable = resolveVariable(stage, variableNames.progress);
  if (confidenceVariable === progressVariable) {
    throw adapterError('K4-TW-POSE-FEEDBACK-001', 'Scratch pose feedback variables are ambiguous');
  }
  const confidenceChannel = createVariableChannel(confidenceVariable, variableNames.confidence);
  let progressChannel: ReturnType<typeof createVariableChannel>;
  try {
    progressChannel = createVariableChannel(progressVariable, variableNames.progress);
  } catch (error) {
    throw error;
  }
  const runtime = runtimeHost.runtime;
  const confidenceMonitor = createMonitorChannel(
    runtime,
    confidenceVariable,
    variableNames.confidence,
  );
  const progressMonitor = createMonitorChannel(runtime, progressVariable, variableNames.progress);

  let disposed = false;
  let active = false;
  let sampled = true;
  let projection: {confidence: number; progress: number} | null = null;

  function writePair(value: {confidence: number; progress: number}) {
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

  function writeMonitorPair(visible: boolean) {
    const previous = {
      confidence: confidenceMonitor.readVisible(),
      progress: progressMonitor.readVisible(),
    };
    try {
      confidenceMonitor.writeVisible(visible);
      progressMonitor.writeVisible(visible);
    } catch (error) {
      const errors = [error];
      try {
        progressMonitor.writeVisible(previous.progress);
      } catch (rollbackError) {
        errors.push(rollbackError);
      }
      try {
        confidenceMonitor.writeVisible(previous.confidence);
      } catch (rollbackError) {
        errors.push(rollbackError);
      }
      throwCollected(errors, 'Scratch pose feedback monitor update and rollback failed');
    }
  }

  function hideMonitorPair() {
    const errors = [];
    for (const monitor of [confidenceMonitor, progressMonitor]) {
      try {
        monitor.writeVisible(false);
      } catch (error) {
        errors.push(error);
      }
    }
    throwCollected(errors, 'Scratch pose feedback monitor cleanup failed');
  }

  function cleanupDisplay() {
    const errors = [];
    for (const cleanup of [
      () => writePair({confidence: 0, progress: 0}),
      () => hideMonitorPair(),
    ]) {
      try {
        cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    throwCollected(errors, 'Scratch pose feedback display cleanup failed');
  }

  try {
    cleanupDisplay();
  } catch (error) {
    const errors = error instanceof AggregateError ? error.errors : [error];
    throw new AggregateError(errors, 'Scratch pose feedback startup cleanup failed');
  }

  const adapter = {
    onPoseState(input: unknown) {
      if (disposed) return;
      const event = createDsl4PoseStateEvent(input);
      const terminal = event.phase === 'completed' || event.phase === 'cancelled';
      if (terminal) {
        active = false;
        sampled = true;
        projection = null;
        cleanupDisplay();
        return;
      }
      const nextProjection = {
        confidence: event.confidence * 100,
        progress: event.progress * 100,
      };
      if (!active) {
        const errors = [];
        try {
          writePair(nextProjection);
          writeMonitorPair(true);
        } catch (error) {
          errors.push(error);
          try {
            cleanupDisplay();
          } catch (cleanupError) {
            errors.push(cleanupError);
          }
          throwCollected(errors, 'Scratch pose feedback activation failed');
        }
      } else {
        writePair(nextProjection);
      }
      projection = nextProjection;
      active = true;
      sampled = false;
    },

    readPoseStateBinding() {
      if (disposed || options.mode !== 'scratchBinding' || !active || !projection || sampled) {
        return null;
      }
      sampled = true;
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
        cleanupDisplay();
      } catch (error) {
        errors.push(error);
      }
      throwCollected(errors, 'Scratch pose feedback cleanup failed');
    },
  };

  return Object.freeze(adapter);
}
