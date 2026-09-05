import {Sb3BuilderError} from './errors.js';

function fail(message: string, code: string): never {
  throw new Sb3BuilderError(message, {stage: 'dsl4-asset-convert', code});
}

export function extensionFor(contentType: string, kind: string) {
  const known = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/svg+xml': 'svg',
    'image/webp': 'webp',
    'audio/mpeg': 'mp3',
    'audio/ogg': 'ogg',
    'audio/wav': 'wav',
  } as Record<string, string>;
  const knownExtension = known[contentType];
  if (knownExtension) return knownExtension;
  const subtype = contentType.split('/')[1]?.replace(/[^a-z0-9]+/gu, '-') || kind;
  return subtype || 'bin';
}

export function contentTypeFor(bytes: Buffer, filePath: string, kind: string) {
  if (kind === 'backdrop' || kind === 'costume' || kind === 'image') {
    if (
      bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    ) {
      return 'image/png';
    }
    if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
    const signature = bytes.subarray(0, 6).toString('ascii');
    if (signature === 'GIF89a' || signature === 'GIF87a') return 'image/gif';
    if (
      bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.subarray(8, 12).toString('ascii') === 'WEBP'
    ) {
      return 'image/webp';
    }
    try {
      if (
        /^(?:\uFEFF)?\s*(?:<\?xml[^>]*>\s*)?<svg(?:\s|\/?>)/iu.test(
          new TextDecoder().decode(bytes.subarray(0, 4096)),
        )
      ) {
        return 'image/svg+xml';
      }
    } catch {
      // The diagnostic below is authoritative.
    }
  }
  if (kind === 'sound') {
    if (
      bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.subarray(8, 12).toString('ascii') === 'WAVE'
    ) {
      return 'audio/wav';
    }
    if (bytes.subarray(0, 4).toString('ascii') === 'OggS') return 'audio/ogg';
    if (
      bytes.subarray(0, 3).toString('ascii') === 'ID3' ||
      (bytes.length >= 2 && bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)
    ) {
      return 'audio/mpeg';
    }
  }
  const extension = filePath.split('.').at(-1)?.toLowerCase() ?? '';
  const byExtension = {
    gif: 'image/gif',
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    mp3: 'audio/mpeg',
    ogg: 'audio/ogg',
    png: 'image/png',
    svg: 'image/svg+xml',
    wav: 'audio/wav',
    wave: 'audio/wav',
    webp: 'image/webp',
  } as Record<string, string>;
  const inferred = byExtension[extension];
  if (inferred) return inferred;
  fail(`Cannot determine the media type for asset file ${filePath}`, 'K4-ASSET-CONVERT-TYPE-001');
}

function pngDimensions(bytes: Buffer) {
  if (bytes.length < 24) return null;
  return {width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20)};
}

function gifDimensions(bytes: Buffer) {
  if (bytes.length < 10) return null;
  return {width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8)};
}

function jpegDimensions(bytes: Buffer) {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    // The loop stops before the last byte, so the marker is present; a missing one would fall
    // through to the frame-size branch below and be rejected by the length check there.
    const marker = bytes[offset + 1] ?? 0;
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    if (offset + 4 > bytes.length) break;
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) break;
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      return {height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7)};
    }
    offset += 2 + length;
  }
  return null;
}

function svgDimensions(bytes: Buffer) {
  let source;
  try {
    source = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  } catch {
    return null;
  }
  const opening = source.match(/<svg\b[^>]*>/iu)?.[0];
  if (!opening) return null;
  const viewBox = opening.match(/\sviewBox\s*=\s*["']([^"']+)["']/iu)?.[1];
  if (viewBox) {
    const values = viewBox
      .trim()
      .split(/[\s,]+/u)
      .map(Number);
    const [, , viewBoxWidth, viewBoxHeight] = values;
    if (
      values.length === 4 &&
      values.every(Number.isFinite) &&
      viewBoxWidth !== undefined &&
      viewBoxHeight !== undefined &&
      viewBoxWidth > 0 &&
      viewBoxHeight > 0
    ) {
      return {width: viewBoxWidth, height: viewBoxHeight};
    }
  }
  const numeric = (name: string) => {
    const numberPattern = '[+-]?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)(?:[eE][+-]?[0-9]+)?';
    const match = opening.match(
      new RegExp(`\\s${name}\\s*=\\s*["']\\s*(${numberPattern})(?:px)?\\s*["']`, 'iu'),
    );
    return match ? Number(match[1]) : null;
  };
  const width = numeric('width');
  const height = numeric('height');
  if (width && height) return {width, height};
  return null;
}

export function imageDimensions(bytes: Buffer, contentType: string) {
  const dimensions =
    contentType === 'image/png'
      ? pngDimensions(bytes)
      : contentType === 'image/gif'
        ? gifDimensions(bytes)
        : contentType === 'image/jpeg'
          ? jpegDimensions(bytes)
          : contentType === 'image/svg+xml'
            ? svgDimensions(bytes)
            : null;
  if (
    !dimensions ||
    !Number.isFinite(dimensions.width) ||
    !Number.isFinite(dimensions.height) ||
    dimensions.width <= 0 ||
    dimensions.height <= 0
  ) {
    fail(
      `Cannot determine image dimensions for project asset Content-Type ${contentType}`,
      'K4-ASSET-CONVERT-METADATA-001',
    );
  }
  return dimensions;
}

function wavMetadata(bytes: Buffer) {
  let offset = 12;
  let sampleRate = null;
  let blockAlign = null;
  let dataBytes = null;
  while (offset + 8 <= bytes.length) {
    const kind = bytes.subarray(offset, offset + 4).toString('ascii');
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > bytes.length) break;
    if (kind === 'fmt ' && size >= 16) {
      sampleRate = bytes.readUInt32LE(start + 4);
      blockAlign = bytes.readUInt16LE(start + 12);
    } else if (kind === 'data') {
      dataBytes = size;
    }
    offset = start + size + (size % 2);
  }
  if (!sampleRate || !blockAlign || dataBytes === null) return null;
  return {rate: sampleRate, sampleCount: Math.floor(dataBytes / blockAlign)};
}

function oggMetadata(bytes: Buffer) {
  const identification = bytes.indexOf(Buffer.from([0x01, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73]));
  if (identification < 0 || identification + 16 > bytes.length) return null;
  const rate = bytes.readUInt32LE(identification + 12);
  let offset = 0;
  let sampleCount = 0;
  while (offset + 27 <= bytes.length) {
    if (bytes.subarray(offset, offset + 4).toString('ascii') !== 'OggS') break;
    // The loop condition guarantees 27 bytes from the offset, so the segment count is present.
    const segmentCount = bytes[offset + 26] ?? 0;
    if (offset + 27 + segmentCount > bytes.length) break;
    const bodySize = bytes
      .subarray(offset + 27, offset + 27 + segmentCount)
      .reduce((total, value) => total + value, 0);
    const granule = bytes.readBigUInt64LE(offset + 6);
    if (granule !== 0xffffffffffffffffn && granule <= BigInt(Number.MAX_SAFE_INTEGER)) {
      sampleCount = Number(granule);
    }
    offset += 27 + segmentCount + bodySize;
  }
  return rate > 0 && sampleCount > 0 ? {rate, sampleCount} : null;
}

function mp3Metadata(bytes: Buffer) {
  let offset = 0;
  if (bytes.subarray(0, 3).toString('ascii') === 'ID3' && bytes.length >= 10) {
    // The ID3 header is ten bytes and the length check above has already required them.
    const size =
      (((bytes[6] ?? 0) & 0x7f) << 21) |
      (((bytes[7] ?? 0) & 0x7f) << 14) |
      (((bytes[8] ?? 0) & 0x7f) << 7) |
      ((bytes[9] ?? 0) & 0x7f);
    offset = 10 + size;
  }
  const bitrates = {
    '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
    '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    '2-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  } as Record<string, number[]>;
  const baseRates = [44_100, 48_000, 32_000];
  let rate = 0;
  let sampleCount = 0;
  while (offset + 4 <= bytes.length) {
    const header = bytes.readUInt32BE(offset);
    if (header >>> 21 !== 0x7ff) {
      offset += 1;
      continue;
    }
    const versionBits = (header >>> 19) & 3;
    const layerBits = (header >>> 17) & 3;
    const bitrateIndex = (header >>> 12) & 15;
    const rateIndex = (header >>> 10) & 3;
    if (
      versionBits === 1 ||
      layerBits === 0 ||
      bitrateIndex === 0 ||
      bitrateIndex === 15 ||
      rateIndex === 3
    ) {
      offset += 1;
      continue;
    }
    const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5;
    const layer = 4 - layerBits;
    const rateDivisor = version === 1 ? 1 : version === 2 ? 2 : 4;
    // rateIndex 3 is rejected above, so the table always has an entry for it.
    const frameRate = (baseRates[rateIndex] ?? 0) / rateDivisor;
    const tableVersion = version === 1 ? 1 : 2;
    const bitrate = bitrates[`${tableVersion}-${layer}`]?.[bitrateIndex];
    if (!bitrate) {
      offset += 1;
      continue;
    }
    const padding = (header >>> 9) & 1;
    const frameLength =
      layer === 1
        ? Math.floor(((12 * bitrate * 1000) / frameRate + padding) * 4)
        : Math.floor(
            ((layer === 3 && version !== 1 ? 72 : 144) * bitrate * 1000) / frameRate + padding,
          );
    if (frameLength < 4 || offset + frameLength > bytes.length) break;
    const samples = layer === 1 ? 384 : layer === 3 && version !== 1 ? 576 : 1152;
    rate ||= frameRate;
    sampleCount += samples;
    offset += frameLength;
  }
  return rate > 0 && sampleCount > 0 ? {rate, sampleCount} : null;
}

export function soundMetadata(bytes: Buffer, contentType: string) {
  const metadata =
    contentType === 'audio/wav'
      ? wavMetadata(bytes)
      : contentType === 'audio/ogg'
        ? oggMetadata(bytes)
        : contentType === 'audio/mpeg'
          ? mp3Metadata(bytes)
          : null;
  if (!metadata) {
    fail(
      `Cannot determine sound metadata for project asset Content-Type ${contentType}`,
      'K4-ASSET-CONVERT-METADATA-001',
    );
  }
  return metadata;
}
