import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {poseNetBundleManifest} from '@kubohiroya/turbowarp-tm/posenet';

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const outputPath = path.join(repositoryRoot, 'src/dsl4/platform/posenet-bundle-assets.js');

function sourceLiteral(value) {
  return JSON.stringify(value);
}

const entries = [];
for (const {path: name, mediaType, packageSpecifier} of poseNetBundleManifest.files) {
  const bytes = await readFile(fileURLToPath(import.meta.resolve(packageSpecifier)));
  entries.push(
    `  Object.freeze({path: ${sourceLiteral(name)}, mediaType: ${sourceLiteral(mediaType)}, base64: ${sourceLiteral(bytes.toString('base64'))}})`,
  );
}

const source = `/* This file is generated from @kubohiroya/turbowarp-tm/posenet-assets. */
/** @param {string} value */
function decodeBase64(value) {
  if (typeof atob !== 'function') throw new Error('K4-POSENET-ASSET-001: atob is required');
  const decoded = atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes;
}

export const embeddedPoseNetFiles = Object.freeze([
${entries.join(',\n')},
].map(({path, mediaType, base64}) =>
  Object.freeze({path, mediaType, bytes: decodeBase64(base64)}),
));
`;

await writeFile(outputPath, source);
