interface PlaybackResources {
  releaseAssets(assetIds: readonly string[]): void;
  clear(): void;
}

/** Release playback before revoking its assets, without abandoning later cleanup on failure. */
export async function releaseDsl4PlaybackAssets({
  videoPort,
  audioPort,
  assetIds,
  releaseBase,
}: {
  videoPort: PlaybackResources | null;
  audioPort: PlaybackResources | null;
  assetIds: readonly string[] | undefined;
  releaseBase: () => unknown;
}) {
  const errors: unknown[] = [];
  for (const port of [videoPort, audioPort]) {
    try {
      if (assetIds === undefined) port?.clear();
      else port?.releaseAssets(assetIds);
    } catch (error) {
      errors.push(error);
    }
  }
  let result: unknown;
  try {
    result = await releaseBase();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Playback and asset cleanup failed');
  return result;
}
