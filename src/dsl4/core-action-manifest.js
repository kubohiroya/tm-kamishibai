/**
 * The single machine-readable contract for DSL 4.0 core actions.
 *
 * `requiredTurboWarpBlock` describes the public block that must exist before
 * TurboWarp -> DSL action parity can be considered complete. Runtime surfaces
 * consume the same command name so the block and YAML paths can share one
 * dispatcher instead of implementing parallel semantics.
 */

/**
 * @typedef {'global' | 'actor'} Dsl4CoreActionTarget
 * @typedef {'port' | 'debug' | 'navigation' | 'branch' | 'selection' | 'pose-sequence'} Dsl4CoreActionDispatch
 */

/**
 * @param {string} command
 * @param {Dsl4CoreActionTarget} target
 * @param {string} schemaDefinition
 * @param {'finish-only' | 'cancel-replay-safe'} quiesce
 * @param {Dsl4CoreActionDispatch} runtimeDispatch
 */
function defineCoreAction(command, target, schemaDefinition, quiesce, runtimeDispatch) {
  return Object.freeze({
    command,
    target,
    schemaDefinition,
    schemaRef: `#/$defs/${schemaDefinition}`,
    quiesce,
    runtimeDispatch,
    requiredTurboWarpBlock: Object.freeze({
      opcode: command,
      visibility: 'visible',
    }),
  });
}

export const dsl4CustomActionSchemaDefinition = 'customActorAction';

export const dsl4CoreActionManifest = Object.freeze([
  defineCoreAction('stage', 'global', 'stageAction', 'finish-only', 'port'),
  defineCoreAction('bgm', 'global', 'bgmAction', 'finish-only', 'port'),
  defineCoreAction('sound', 'global', 'soundAction', 'finish-only', 'port'),
  defineCoreAction('wait', 'global', 'waitAction', 'cancel-replay-safe', 'port'),
  defineCoreAction('debugger', 'global', 'debuggerAction', 'cancel-replay-safe', 'debug'),
  defineCoreAction(
    'broadcastMessageAndWait',
    'global',
    'broadcastMessageAndWaitAction',
    'finish-only',
    'port',
  ),
  defineCoreAction('transition', 'global', 'transitionAction', 'cancel-replay-safe', 'port'),
  defineCoreAction('goto', 'global', 'gotoAction', 'finish-only', 'navigation'),
  defineCoreAction('branch', 'global', 'branchAction', 'finish-only', 'branch'),
  defineCoreAction(
    'keyInputToChangeScene',
    'global',
    'keyInputAction',
    'cancel-replay-safe',
    'selection',
  ),
  defineCoreAction(
    'touchInputToChangeScene',
    'global',
    'touchInputAction',
    'cancel-replay-safe',
    'selection',
  ),
  defineCoreAction(
    'poseInputToChangeScene',
    'global',
    'poseInputAction',
    'cancel-replay-safe',
    'selection',
  ),
  defineCoreAction('show', 'actor', 'showAction', 'finish-only', 'port'),
  defineCoreAction('hide', 'actor', 'hideAction', 'finish-only', 'port'),
  defineCoreAction('setTransparency', 'actor', 'setTransparencyAction', 'finish-only', 'port'),
  defineCoreAction('moveTo', 'actor', 'moveToAction', 'cancel-replay-safe', 'port'),
  defineCoreAction('say', 'actor', 'sayAction', 'cancel-replay-safe', 'port'),
  defineCoreAction('think', 'actor', 'thinkAction', 'cancel-replay-safe', 'port'),
  defineCoreAction('setSkin', 'actor', 'setSkinAction', 'finish-only', 'port'),
  defineCoreAction('setLayer', 'actor', 'setLayerAction', 'finish-only', 'port'),
  defineCoreAction('loop', 'actor', 'loopAction', 'finish-only', 'port'),
  defineCoreAction('setText', 'actor', 'setTextAction', 'finish-only', 'port'),
  defineCoreAction('pose', 'actor', 'poseAction', 'cancel-replay-safe', 'pose-sequence'),
]);
