/** @param {unknown} value */
export function isDsl4PoseArchivePath(value) {
  return typeof value === 'string' && /\.zip$/iu.test(value);
}

/** @param {unknown} value */
export function isDsl4RemotePoseArchiveUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    return isDsl4PoseArchivePath(new URL(value).pathname);
  } catch {
    return false;
  }
}
