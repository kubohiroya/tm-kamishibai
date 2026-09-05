export function deepFreezeStoreValue<T>(value: T): Readonly<T> {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreezeStoreValue(child);
  return Object.freeze(value);
}
