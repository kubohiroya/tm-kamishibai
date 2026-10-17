export const dsl4BlockSourceHatOpcode = 'whenDsl4Source';
export const dsl4BlockSourceCommandOpcode = 'dsl4SourceFromYamlJson';
export const dsl4BlockSourceRuntimeExtensionId = 'kubohiroyakamishibairuntime4';
export const dsl4BlockSourceBundleExtensionId = 'kubohiroyakamishibai4';
export const yamlJsonExtensionId = 'kubohiroyayamljson';

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
