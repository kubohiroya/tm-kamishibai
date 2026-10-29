function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function dsl4RemotePoseFileUrl(baseUrl: string, fileName: string): string {
  const directoryUrl = new URL(baseUrl);
  if (!directoryUrl.pathname.endsWith('/')) directoryUrl.pathname = `${directoryUrl.pathname}/`;
  const search = directoryUrl.search;
  directoryUrl.search = '';
  const fileUrl = new URL(fileName, directoryUrl);
  fileUrl.search = search;
  return fileUrl.href;
}

export function parseDsl4RemotePoseJson(bytes: Uint8Array, name: string): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
  } catch (error) {
    throw new Error(`Remote pose model ${name} is not valid UTF-8 JSON`, {cause: error});
  }
}

export function resolveDsl4RemotePoseWeightsPath(model: unknown): string {
  const declaredWeights =
    isRecord(model) && Array.isArray(model.weightsManifest)
      ? model.weightsManifest.flatMap((entry) =>
          isRecord(entry) && Array.isArray(entry.paths) ? entry.paths : [],
        )
      : [];
  // Teachable Machine exports both root filenames and paths prefixed with './'.
  const declaredPath = declaredWeights[0];
  const weightsPath =
    typeof declaredPath === 'string' && declaredPath.startsWith('./')
      ? declaredPath.slice(2)
      : declaredPath;
  if (
    declaredWeights.length !== 1 ||
    typeof weightsPath !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*\.bin$/u.test(weightsPath)
  ) {
    throw new TypeError(
      'Remote pose model.json must declare exactly one root-level .bin weights file',
    );
  }
  return weightsPath;
}
