import {createHash} from 'node:crypto';

type HashInput = string | NodeJS.ArrayBufferView;

export function sha256(value: HashInput): string {
  return createHash('sha256').update(value).digest('hex');
}

export function md5(value: HashInput): string {
  return createHash('md5').update(value).digest('hex');
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right, 'en'))
        .map(([key, child]) => [key, sortValue(child)]),
    );
  }
  return value;
}
