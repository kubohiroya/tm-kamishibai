const mediaKinds = new Set(['backdrop', 'costume', 'image', 'sound']);

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @param {string} label */
function validateAdapter(value, label) {
  if (
    !isRecord(value) ||
    typeof value.prepare !== 'function' ||
    typeof value.release !== 'function'
  ) {
    throw new TypeError(`${label} must provide prepare and release`);
  }
  return /** @type {Record<string, Function>} */ (value);
}

/**
 * Route one embedded lifecycle across the media and pose feature owners.
 *
 * @param {object} options
 * @param {unknown} options.mediaAdapter
 * @param {unknown} options.poseAdapter
 */
export function createDsl4PlatformAssetAdapter({mediaAdapter, poseAdapter}) {
  const media = validateAdapter(mediaAdapter, 'mediaAdapter');
  const pose = validateAdapter(poseAdapter, 'poseAdapter');
  const owners = new WeakMap();
  const released = new WeakSet();

  return Object.freeze({
    /** @param {unknown} payload @param {unknown} context */
    async prepare(payload, context) {
      if (!isRecord(payload) || !isRecord(payload.asset)) {
        throw new TypeError('platform asset payload must provide an asset record');
      }
      const kind = payload.asset.kind;
      const owner = kind === 'poseModel' ? pose : mediaKinds.has(String(kind)) ? media : null;
      if (!owner) throw new TypeError(`Unsupported platform asset kind: ${String(kind)}`);
      const resource = await owner.prepare(payload, context);
      if (!isRecord(resource)) {
        throw new TypeError('platform asset adapter must return an object resource');
      }
      owners.set(resource, owner);
      return resource;
    },

    /** @param {unknown} resource @param {unknown} context */
    async release(resource, context) {
      if (!isRecord(resource) || !owners.has(resource)) {
        throw new TypeError('platform asset resource is not owned by this router');
      }
      if (released.has(resource)) return;
      released.add(resource);
      await owners.get(resource).release(resource, context);
    },
  });
}
