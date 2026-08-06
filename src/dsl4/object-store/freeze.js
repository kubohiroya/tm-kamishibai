/**
 * @template T
 * @param {T} value
 * @returns {Readonly<T>}
 */
export function deepFreezeStoreValue(value) {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreezeStoreValue(child);
  return Object.freeze(value);
}
