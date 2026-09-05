export function isDsl4PoseArchivePath(value: unknown): value is string {
  return typeof value === 'string' && /\.zip$/iu.test(value);
}

export function isDsl4RemotePoseArchiveUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    return isDsl4PoseArchivePath(new URL(value).pathname);
  } catch {
    return false;
  }
}
