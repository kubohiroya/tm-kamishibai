/** Convert bounded diagnostics into explanations without evaluating source or serializing projects. */
export function diagnosticText(value: unknown, maximum = 2_000): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const text = String(value)
    .replace(/https?:\/\/[^\s<>"']+/gu, (address) => {
      try {
        const url = new URL(address);
        return `${url.origin}${url.pathname}`;
      } catch {
        return '[URL]';
      }
    })
    .replace(
      /(?:file:\/\/|[A-Za-z]:\\|\/(?:Users|home|private|tmp|var|Volumes)\/)[^\s"'<>]*/gu,
      '[local path]',
    )
    .replace(
      /\b(token|password|secret|authorization|api[_-]?key)\s*[:=]\s*[^\s,;]+/giu,
      '$1=[redacted]',
    );
  const scalars = [...text];
  return scalars.length <= maximum ? text : `${scalars.slice(0, maximum - 1).join('')}…`;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Preserve just the cause chain's names, codes and messages, including non-enumerable Error fields. */
export function runtimeErrorCauses(error: unknown) {
  const seen = new Set<unknown>();
  const causes: {name: string; code: string; message: string}[] = [];
  const visit = (value: unknown) => {
    if (seen.has(value) || causes.length >= 6) return;
    seen.add(value);
    const item = record(value);
    const message = diagnosticText(item.message ?? (typeof value === 'string' ? value : ''), 500);
    if (message || item.code || item.name)
      causes.push({
        name: diagnosticText(item.name, 80),
        code: diagnosticText(item.code, 160),
        message,
      });
    if (item.cause !== undefined) visit(item.cause);
    if (Array.isArray(item.errors)) for (const child of item.errors.slice(0, 6)) visit(child);
  };
  visit(error);
  return causes;
}

/** Capture UI context separately from the canonical diagnostic and its wire contract. */
export function createRuntimeFailureContext(
  error: unknown,
  scene: Readonly<Record<string, unknown>> | null,
  action: Readonly<Record<string, unknown>> | null,
  actionIndex: number,
  cleanupError?: unknown,
) {
  const args = record(action?.args);
  const assetId = [
    args.asset,
    args.backdrop,
    args.costume,
    args.sound,
    args.video,
    args.poseModel,
  ].find((value) => typeof value === 'string');
  return {
    sceneId: diagnosticText(scene?.id),
    actionIndex,
    command: diagnosticText(action?.command),
    ...(assetId ? {assetId: diagnosticText(assetId)} : {}),
    causes: runtimeErrorCauses(error),
    ...(cleanupError ? {cleanupCauses: runtimeErrorCauses(cleanupError)} : {}),
  };
}
