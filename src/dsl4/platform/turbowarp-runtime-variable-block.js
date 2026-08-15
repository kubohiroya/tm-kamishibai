/**
 * Define the feature-gated public runtime-variable blocks without coupling their contract to the
 * packaged extension entry.
 *
 * @param {{ArgumentType: Record<string, string>, BlockType: Record<string, string>}} scratch
 * @param {{stateVisible: boolean, writeVisible: boolean}} visibility
 */
export function createDsl4TurboWarpRuntimeVariableBlockSurface(
  {ArgumentType, BlockType},
  {stateVisible, writeVisible},
) {
  if (typeof stateVisible !== 'boolean' || typeof writeVisible !== 'boolean') {
    throw new TypeError('runtime variable block visibility must be boolean');
  }
  if (writeVisible && !stateVisible) {
    throw new TypeError('story variable write blocks require the state surface');
  }
  const hiddenState = !stateVisible;
  const hiddenWrite = !writeVisible;
  const nameArgument = {type: ArgumentType.STRING, defaultValue: ''};
  return Object.freeze({
    blocks: Object.freeze([
      {
        opcode: 'storyVariableReporter',
        blockType: BlockType.REPORTER,
        text: 'story variable [NAME]',
        arguments: {NAME: nameArgument},
        hideFromPalette: hiddenState,
        disableMonitor: true,
      },
      {
        opcode: 'storyVariableExists',
        blockType: BlockType.BOOLEAN,
        text: 'story variable [NAME] exists?',
        arguments: {NAME: nameArgument},
        hideFromPalette: hiddenState,
      },
      {
        opcode: 'storyVariableType',
        blockType: BlockType.REPORTER,
        text: 'story variable [NAME] type',
        arguments: {NAME: nameArgument},
        hideFromPalette: hiddenState,
        disableMonitor: true,
      },
      ...[
        ['storyStatusReporter', 'story status'],
        ['currentSceneIdReporter', 'current scene id'],
        ['currentActionNumberReporter', 'current action number'],
        ['currentActionPathReporter', 'current action path'],
        ['lastRuntimeErrorCodeReporter', 'last runtime error code'],
        ['lastRuntimeErrorStoryPathReporter', 'last runtime error story path'],
        ['posePhaseReporter', 'pose phase'],
        ['poseTargetReporter', 'pose target'],
        ['poseNameReporter', 'pose name'],
        ['poseStepNumberReporter', 'pose step number'],
        ['runtimeVersionReporter', 'Kamishibai DSL 4.0 runtime version'],
        ['applicationStatusReporter', 'application status'],
      ].map(([opcode, text]) => ({
        opcode,
        blockType: BlockType.REPORTER,
        text,
        hideFromPalette: hiddenState,
        disableMonitor: true,
      })),
      {
        opcode: 'canNavigateToPreviousAction',
        blockType: BlockType.BOOLEAN,
        text: 'can navigate to previous action?',
        hideFromPalette: hiddenState,
      },
      {
        opcode: 'canNavigateToNextAction',
        blockType: BlockType.BOOLEAN,
        text: 'can navigate to next action?',
        hideFromPalette: hiddenState,
      },
      {
        opcode: 'setStoryVariable',
        blockType: BlockType.COMMAND,
        text: 'set story variable [NAME] to [VALUE] as [TYPE]',
        arguments: {
          NAME: nameArgument,
          VALUE: {type: ArgumentType.STRING, defaultValue: ''},
          TYPE: {type: ArgumentType.STRING, menu: 'dsl4StoryVariableTypes'},
        },
        hideFromPalette: hiddenWrite,
      },
      {
        opcode: 'changeNumberStoryVariable',
        blockType: BlockType.COMMAND,
        text: 'change number story variable [NAME] by [DELTA]',
        arguments: {
          NAME: nameArgument,
          DELTA: {type: ArgumentType.NUMBER, defaultValue: 1},
        },
        hideFromPalette: hiddenWrite,
      },
      {
        opcode: 'lastStoryVariableWriteAccepted',
        blockType: BlockType.BOOLEAN,
        text: 'last story variable write accepted?',
        hideFromPalette: hiddenWrite,
      },
    ]),
    menus: Object.freeze({
      dsl4StoryVariableTypes: Object.freeze({
        acceptReporters: false,
        items: Object.freeze(['string', 'number', 'boolean']),
      }),
    }),
  });
}

/** @param {unknown} value @param {string} type */
export function coerceDsl4StoryVariableBlockValue(value, type) {
  if (type === 'string') return Object.freeze({ok: true, value: String(value ?? '')});
  if (type === 'number') {
    const number = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(number)
      ? Object.freeze({ok: true, value: number})
      : Object.freeze({ok: false, code: 'K4-VARIABLE-WRITE-VALUE'});
  }
  if (type === 'boolean') {
    if (typeof value === 'boolean') return Object.freeze({ok: true, value});
    if (value === 'true') return Object.freeze({ok: true, value: true});
    if (value === 'false') return Object.freeze({ok: true, value: false});
    return Object.freeze({ok: false, code: 'K4-VARIABLE-WRITE-VALUE'});
  }
  return Object.freeze({ok: false, code: 'K4-VARIABLE-WRITE-TYPE'});
}
