import {deepFreeze} from './story-document.js';

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate the persisted identity used to isolate verified remote caches by story.
 *
 * @param {unknown} value
 */
export function validateDsl4CacheIdentity(value) {
  if (!isRecord(value)) throw new TypeError('cacheIdentity must be an object');
  const keys = Object.keys(value);
  if (
    keys.length !== 3 ||
    !Object.hasOwn(value, 'id') ||
    !Object.hasOwn(value, 'label') ||
    !Object.hasOwn(value, 'databaseName')
  ) {
    throw new TypeError('cacheIdentity must contain only id, label, and databaseName');
  }
  const id = value.id;
  const label = value.label;
  const databaseName = value.databaseName;
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{7,63}$/u.test(id)) {
    throw new TypeError('cacheIdentity.id must be a stable 8 to 64 character identifier');
  }
  if (
    typeof label !== 'string' ||
    label.length === 0 ||
    label.length > 256 ||
    label.includes('/') ||
    label.includes('\\') ||
    /[\u0000-\u001f\u007f]/u.test(label)
  ) {
    throw new TypeError('cacheIdentity.label must be a basename without control characters');
  }
  if (
    typeof databaseName !== 'string' ||
    databaseName.length > 160 ||
    !databaseName.startsWith('tw-kamishibai-assets-v1--') ||
    !databaseName.endsWith(`--${id}`) ||
    !/^[\p{Letter}\p{Number}._-]+$/u.test(databaseName)
  ) {
    throw new TypeError('cacheIdentity.databaseName must be the persisted story cache name');
  }
  return deepFreeze({id, label, databaseName});
}
