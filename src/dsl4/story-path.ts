const canonicalSegmentPattern =
  /^(?:[^~/%\u0000-\u001f\u007f]|~[01]|%(?:25|0[0-9A-F]|1[0-9A-F]|7F))+$/u;

/**
 * Encode one literal DSL 4.0 identifier as a canonical StoryPath segment.
 *
 * RFC 6901 protects `~` and `/`. The additional `%HH` form protects literal percent signs and
 * control characters so StoryPaths remain safe to persist and display without changing IDs.
 */
export function encodeDsl4StoryPathSegment(value: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('StoryPath segments must be non-empty strings');
  }
  return value
    .replaceAll('%', '%25')
    .replace(
      /[\u0000-\u001f\u007f]/gu,
      (character) => `%${character.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase()}`,
    )
    .replaceAll('~', '~0')
    .replaceAll('/', '~1');
}

export function decodeDsl4StoryPathSegment(value: string): string {
  if (typeof value !== 'string' || !canonicalSegmentPattern.test(value)) {
    throw new TypeError('StoryPath segment is not canonical');
  }
  return value
    .replaceAll('~1', '/')
    .replaceAll('~0', '~')
    .replace(/%(?:25|0[0-9A-F]|1[0-9A-F]|7F)/gu, (escape) =>
      String.fromCodePoint(Number.parseInt(escape.slice(1), 16)),
    );
}

export function isCanonicalDsl4StoryPath(value: unknown): boolean {
  if (value === '/') return true;
  if (typeof value !== 'string' || !value.startsWith('/')) return false;
  const segments = value.slice(1).split('/');
  return segments.length > 0 && segments.every((segment) => canonicalSegmentPattern.test(segment));
}
