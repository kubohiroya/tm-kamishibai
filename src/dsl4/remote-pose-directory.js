/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {string} baseUrl @param {string} fileName */
export function dsl4RemotePoseFileUrl(baseUrl, fileName) {
  const directoryUrl = new URL(baseUrl);
  if (!directoryUrl.pathname.endsWith('/')) directoryUrl.pathname = `${directoryUrl.pathname}/`;
  const search = directoryUrl.search;
  directoryUrl.search = '';
  const fileUrl = new URL(fileName, directoryUrl);
  fileUrl.search = search;
  return fileUrl.href;
}

/** @param {Uint8Array} bytes @param {string} name */
export function parseDsl4RemotePoseJson(bytes, name) {
  try {
    return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
  } catch (error) {
    throw new Error(`Remote pose model ${name} is not valid UTF-8 JSON`, {cause: error});
  }
}

/** @param {unknown} model */
export function resolveDsl4RemotePoseWeightsPath(model) {
  const declaredWeights =
    isRecord(model) && Array.isArray(model.weightsManifest)
      ? model.weightsManifest.flatMap((entry) =>
          isRecord(entry) && Array.isArray(entry.paths) ? entry.paths : [],
        )
      : [];
  if (
    declaredWeights.length !== 1 ||
    typeof declaredWeights[0] !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*\.bin$/u.test(declaredWeights[0])
  ) {
    throw new TypeError(
      'Remote pose model.json must declare exactly one root-level .bin weights file',
    );
  }
  return declaredWeights[0];
}
