import {deepFreeze} from './story-document.js';

export const dsl4BrowserPreviewArtifactLimits = deepFreeze({
  defaults: {
    maxTotalAssetBytes: 64 * 1024 * 1024,
    maxProjectBytes: 192 * 1024 * 1024,
    maxProjectJsonBytes: 192 * 1024 * 1024,
  },
  recommendedMaximums: {
    maxTotalAssetBytes: 128 * 1024 * 1024,
    maxProjectBytes: 256 * 1024 * 1024,
    maxProjectJsonBytes: 256 * 1024 * 1024,
  },
  absoluteMaximums: {
    maxTotalAssetBytes: 512 * 1024 * 1024,
    maxProjectBytes: 1024 * 1024 * 1024,
    maxProjectJsonBytes: 1024 * 1024 * 1024,
  },
});
