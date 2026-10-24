export const dsl4BlockSourceRuntimeExtensionId = 'kubohiroyakamishibairuntime4';
export const dsl4BlockSourceBundleExtensionId = 'kubohiroyakamishibai4';
export const dsl4BlockAuthoringExtensionId = 'kubohiroyakamishibaiauthoring4';
/** The hats a block-source project keeps its YAML under, shared with the compiled profile. */
export const dsl4LabeledBlockSourceHatOpcode = `${dsl4BlockAuthoringExtensionId}_kamishibai`;
export const dsl4ConfigBlockSourceHatOpcode = `${dsl4BlockAuthoringExtensionId}_kamishibaiConfig`;

export class Dsl4BlockSourceError extends Error {
  readonly code: string;
  readonly targetName: string | null;
  readonly blockId: string | null;

  constructor(
    code: string,
    message: string,
    details: {targetName?: string; blockId?: string; cause?: unknown} = {},
  ) {
    super(message, details.cause === undefined ? undefined : {cause: details.cause});
    this.name = 'Dsl4BlockSourceError';
    this.code = code;
    this.targetName = details.targetName ?? null;
    this.blockId = details.blockId ?? null;
  }
}
