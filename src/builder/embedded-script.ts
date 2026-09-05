import {
  defaultMaxEmbeddedScriptBytes,
  embeddedScriptVariableId,
  embeddedScriptVariableName,
} from './constants.js';
import {Sb3BuilderError} from './errors.js';

function isObject(value: unknown) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Resolve the reserved Stage variable used for embedded scripts. */
export function resolveEmbeddedScriptSlot(
  project: Record<string, any>,
  stage: string = 'embedded-script',
) {
  const targets = Array.isArray(project?.targets) ? project.targets : [];
  const stages = targets.filter((target) => target?.isStage === true);
  if (stages.length !== 1) {
    throw new Sb3BuilderError(`SB3 Stage must resolve exactly once (found ${stages.length}).`, {
      stage,
    });
  }
  const variables = stages[0].variables;
  if (!isObject(variables)) {
    throw new Sb3BuilderError('SB3 Stage variables must be an object.', {stage});
  }
  const namedSlots = Object.entries(variables).filter(
    ([, value]) => Array.isArray(value) && value[0] === embeddedScriptVariableName,
  );
  if (namedSlots.length !== 1 || namedSlots[0][0] !== embeddedScriptVariableId) {
    throw new Sb3BuilderError(
      `Embedded script slot must resolve exactly once as ${embeddedScriptVariableId}/${embeddedScriptVariableName}.`,
      {stage},
    );
  }
  const slot = variables[embeddedScriptVariableId];
  if (!Array.isArray(slot) || slot.length !== 2 || typeof slot[1] !== 'string') {
    throw new Sb3BuilderError('Embedded script slot must contain a string value.', {stage});
  }
  return slot;
}

export function configureEmbeddedScript(
  project: Record<string, any>,
  profile: 'editor' | 'player',
  scriptBytes: Buffer | Uint8Array,
  maxEmbeddedScriptBytes = defaultMaxEmbeddedScriptBytes,
) {
  const slot = resolveEmbeddedScriptSlot(project, 'build-sb3');
  if (slot[1] !== '') {
    throw new Sb3BuilderError('Base SB3 embedded script slot must be empty.', {
      stage: 'build-sb3',
    });
  }
  if (profile === 'editor') return;
  if (scriptBytes.length === 0) {
    throw new Sb3BuilderError('Player profile requires a non-empty script.', {
      stage: 'build-sb3',
    });
  }
  if (scriptBytes.length > maxEmbeddedScriptBytes) {
    throw new Sb3BuilderError(`Embedded script exceeds the ${maxEmbeddedScriptBytes} byte limit.`, {
      stage: 'build-sb3',
    });
  }
  try {
    slot[1] = new TextDecoder('utf-8', {fatal: true}).decode(scriptBytes);
  } catch (error) {
    throw new Sb3BuilderError('Embedded script is not valid UTF-8.', {
      stage: 'build-sb3',
      cause: error,
    });
  }
}
