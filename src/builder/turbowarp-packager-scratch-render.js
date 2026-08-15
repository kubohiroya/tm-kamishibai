const silhouetteReadbackFunction =
  /unlazy\(\)\{if\(!this\._lazyData\)return;const ([A-Za-z_$][\w$]*)=this\._lazyData\.width,([A-Za-z_$][\w$]*)=this\._lazyData\.height;if\(\1&&\2\)\{const ([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*\._updateCanvas\(\);\3\.width=\1,\3\.height=\2;const ([A-Za-z_$][\w$]*)=\3\.getContext\("2d"\);\4\.clearRect\(0,0,\1,\2\),\4\.drawImage\(this\._lazyData,0,0,\1,\2\);const ([A-Za-z_$][\w$]*)=\4\.getImageData\(0,0,\1,\2\);this\._colorData=\5\.data\}this\._lazyData=null\}/gu;
const readbackContext = 'getContext("2d")';
const optimizedReadbackContext = 'getContext("2d",{willReadFrequently:!0})';

export const turboWarpPackagerScratchRenderContract = Object.freeze({
  packagerPackage: '@turbowarp/packager',
  packagerVersion: '3.13.0',
  upstreamRepository: 'TurboWarp/scratch-render',
  upstreamBaseCommit: 'a67f7c9c07d459582c227d4fd3fae8f59d8fc9ce',
  upstreamPullRequest: 21,
  fixedRepository: 'kubohiroya/scratch-render',
  fixedCommit: 'c69318a6c8d43439fc35fa9e403bf6d2781fdaee',
  readbackCanvases: Object.freeze(['Silhouette.updateCanvas']),
});

/**
 * Patch the single scratch-render silhouette readback context embedded in pinned Packager HTML.
 *
 * @param {Uint8Array} htmlBytes
 */
export function patchTurboWarpPackagerScratchRenderReadbackContext(htmlBytes) {
  if (!(htmlBytes instanceof Uint8Array)) {
    throw new TypeError('Packager HTML must be a Uint8Array');
  }
  const decoder = new TextDecoder('utf-8', {fatal: true});
  const html = decoder.decode(htmlBytes);
  const matches = [...html.matchAll(silhouetteReadbackFunction)];
  if (matches.length !== 1) {
    throw new Error(
      'K4-PACKAGER-READBACK-TEMPLATE-001: pinned scratch-render silhouette template was not found exactly once',
    );
  }
  const match = matches[0];
  const replacement = match[0].replace(readbackContext, optimizedReadbackContext);
  if (replacement === match[0] || replacement.includes(readbackContext)) {
    throw new Error(
      'K4-PACKAGER-READBACK-TEMPLATE-001: scratch-render silhouette context patch was not isolated',
    );
  }
  return new TextEncoder().encode(
    `${html.slice(0, match.index)}${replacement}${html.slice(match.index + match[0].length)}`,
  );
}
