export const dsl4VideoOperations = Object.freeze([
  'playUntilDone',
  'play',
  'resume',
  'pause',
  'stop',
  'loop',
  'seek',
  'setVolume',
  'setMuted',
  'setPlaybackRate',
]);

export const dsl4VideoControlValueFields: Readonly<Record<string, string>> = Object.freeze({
  seek: 'seconds',
  setVolume: 'volume',
  setMuted: 'muted',
  setPlaybackRate: 'rate',
});

/** The two video containers supported by file-backed DSL assets. Codecs remain browser-owned. */
export function dsl4VideoContentType(bytes: Uint8Array): string | null {
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(4, 8)) === 'ftyp') {
    return 'video/mp4';
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  ) {
    return 'video/webm';
  }
  return null;
}

/** Direct sources use a media URL, rather than an HTML page or executable URL. */
export function isDsl4VideoUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !/^https?:\/\/[^\s]+$/u.test(value)) return false;
  try {
    const url = new URL(value);
    return Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}
