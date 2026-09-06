type Dsl4PlatformAssetAdapter = Readonly<{
  prepare: (payload: unknown, context: unknown) => unknown;
  release: (resource: unknown, context: unknown) => unknown;
}>;

const mediaKinds = new Set(['backdrop', 'costume', 'image', 'sound']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateAdapter(value: unknown, label: string): Dsl4PlatformAssetAdapter {
  if (
    !isRecord(value) ||
    typeof value.prepare !== 'function' ||
    typeof value.release !== 'function'
  ) {
    throw new TypeError(`${label} must provide prepare and release`);
  }
  return value as unknown as Dsl4PlatformAssetAdapter;
}

/**
 * Route one embedded lifecycle across the media and pose feature owners.
 */
export function createDsl4PlatformAssetAdapter({
  mediaAdapter,
  poseAdapter,
}: {
  mediaAdapter: unknown;
  poseAdapter: unknown;
}) {
  const media = validateAdapter(mediaAdapter, 'mediaAdapter');
  const pose = validateAdapter(poseAdapter, 'poseAdapter');
  const owners = new WeakMap<object, Dsl4PlatformAssetAdapter>();
  const released = new WeakSet<object>();

  return Object.freeze({
    async prepare(payload: unknown, context: unknown): Promise<Record<string, unknown>> {
      if (!isRecord(payload) || !isRecord(payload.asset)) {
        throw new TypeError('platform asset payload must provide an asset record');
      }
      const kind = payload.asset.kind;
      const owner =
        kind === 'recognitionModel' ? pose : mediaKinds.has(String(kind)) ? media : null;
      if (!owner) throw new TypeError(`Unsupported platform asset kind: ${String(kind)}`);
      const resource = await owner.prepare(payload, context);
      if (!isRecord(resource)) {
        throw new TypeError('platform asset adapter must return an object resource');
      }
      owners.set(resource, owner);
      return resource;
    },

    async release(resource: unknown, context: unknown): Promise<void> {
      if (!isRecord(resource) || !owners.has(resource)) {
        throw new TypeError('platform asset resource is not owned by this router');
      }
      if (released.has(resource)) return;
      released.add(resource);
      await owners.get(resource)?.release(resource, context);
    },
  });
}
