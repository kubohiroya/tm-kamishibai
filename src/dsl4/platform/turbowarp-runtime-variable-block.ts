import {
  coerceScalarBlockValue,
  createBlockSurfaceBuilder,
} from '@kubohiroya/turbowarp-runtime-host';

/**
 * Define the feature-gated public runtime-variable blocks without coupling their contract to the
 * packaged extension entry.
 *
 * Record shape, palette visibility, and the reporter monitor default come from the shared block
 * surface builder. Every opcode, label, and menu item below stays here, because they are DSL 4.0
 * story vocabulary rather than TurboWarp mechanics.
 */
export function createDsl4TurboWarpRuntimeVariableBlockSurface(
  {
    ArgumentType,
    BlockType,
  }: {ArgumentType: Record<string, string>; BlockType: Record<string, string>},
  {stateVisible, writeVisible}: {stateVisible: boolean; writeVisible: boolean},
) {
  if (typeof stateVisible !== 'boolean' || typeof writeVisible !== 'boolean') {
    throw new TypeError('runtime variable block visibility must be boolean');
  }
  if (writeVisible && !stateVisible) {
    throw new TypeError('story variable write blocks require the state surface');
  }
  const build = createBlockSurfaceBuilder({ArgumentType, BlockType}, {visible: stateVisible});
  const nameArgument = () => build.stringArgument();
  return build.surface(
    [
      build.reporter({
        opcode: 'storyVariableReporter',
        text: 'story variable [NAME]',
        arguments: {NAME: nameArgument()},
      }),
      build.boolean({
        opcode: 'storyVariableExists',
        text: 'story variable [NAME] exists?',
        arguments: {NAME: nameArgument()},
      }),
      build.reporter({
        opcode: 'storyVariableType',
        text: 'story variable [NAME] type',
        arguments: {NAME: nameArgument()},
      }),
      ...build.reporters([
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
      ]),
      build.boolean({
        opcode: 'canNavigateToPreviousAction',
        text: 'can navigate to previous action?',
      }),
      build.boolean({opcode: 'canNavigateToNextAction', text: 'can navigate to next action?'}),
      build.command({
        opcode: 'setStoryVariable',
        text: 'set story variable [NAME] to [VALUE] as [TYPE]',
        arguments: {
          NAME: nameArgument(),
          VALUE: build.stringArgument(),
          TYPE: build.menuArgument('dsl4StoryVariableTypes'),
        },
        visible: writeVisible,
      }),
      build.command({
        opcode: 'changeNumberStoryVariable',
        text: 'change number story variable [NAME] by [DELTA]',
        arguments: {NAME: nameArgument(), DELTA: build.numberArgument(1)},
        visible: writeVisible,
      }),
      build.boolean({
        opcode: 'lastStoryVariableWriteAccepted',
        text: 'last story variable write accepted?',
        visible: writeVisible,
      }),
    ],
    {dsl4StoryVariableTypes: build.menu(['string', 'number', 'boolean'])},
  );
}

/**
 * Keep the `K4-VARIABLE-WRITE-*` diagnostics while the string/number/boolean coercion itself comes
 * from the shared package.
 */
export function coerceDsl4StoryVariableBlockValue(value: unknown, type: string) {
  return coerceScalarBlockValue(value, type, {errorCodePrefix: 'K4'});
}
