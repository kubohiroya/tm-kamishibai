export interface Sb3BuilderErrorDetails {
  assetName?: string;
  inputUri?: string;
  stage?: string;
  code?: string;
  cause?: unknown;
}

export class Sb3BuilderError extends Error {
  readonly code: string;
  readonly stage: string;
  readonly assetName: string | null;
  readonly inputUri: string | null;

  constructor(message: string, details: Sb3BuilderErrorDetails = {}) {
    const context = [
      details.stage ? `stage=${details.stage}` : null,
      details.assetName ? `asset=${JSON.stringify(details.assetName)}` : null,
      details.inputUri ? `uri=${JSON.stringify(details.inputUri)}` : null,
    ]
      .filter(Boolean)
      .join(' ');
    super(context ? `${context}: ${message}` : message, {cause: details.cause});
    this.name = 'Sb3BuilderError';
    this.code = details.code ?? 'ERR_SB3_BUILDER';
    this.stage = details.stage ?? 'build';
    this.assetName = details.assetName ?? null;
    this.inputUri = details.inputUri ?? null;
  }
}

export function toAssetError(
  error: unknown,
  details: {assetName: string; inputUri: string; stage: string},
): Sb3BuilderError {
  if (error instanceof Sb3BuilderError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new Sb3BuilderError(message, {...details, cause: error});
}
