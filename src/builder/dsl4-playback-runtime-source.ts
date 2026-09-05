import {readFile} from 'node:fs/promises';

import {createDsl4PoseNetProjectBundleFromLoader} from '../dsl4/platform/posenet-bundle.js';

const playbackRuntimeUrl = new URL(
  './generated/dsl4-playback-runtime-extension.js',
  import.meta.url,
);
let pendingSource;
let pendingPoseNetProjectBundle;

/** Read the generated playback-only extension shipped with the builder package. */
export function readDsl4PlaybackRuntimeExtensionSource() {
  pendingSource ??= readFile(playbackRuntimeUrl, 'utf8');
  return pendingSource;
}

/**
 * Read and verify the fixed PoseNet model data installed beside the playback runtime.
 *
 */
export function readDsl4PlaybackPoseNetBundle({
  subtleCrypto = globalThis.crypto?.subtle,
}: {subtleCrypto?: {digest: Function} | undefined} = {}) {
  pendingPoseNetProjectBundle ??= createDsl4PoseNetProjectBundleFromLoader(
    async ({packageSpecifier}) =>
      new Uint8Array(await readFile(new URL(import.meta.resolve(packageSpecifier)))),
    {
      subtleCrypto: subtleCrypto as Pick<SubtleCrypto, 'digest'> | undefined,
    },
  );
  return pendingPoseNetProjectBundle;
}
