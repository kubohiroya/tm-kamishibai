import {deepFreeze} from './story-document.js';

export const dsl4BrowserPreviewArtifactLimits = deepFreeze({
  defaults: {
    maxAssetBytes: 64 * 1024 * 1024,
    maxProjectBytes: 192 * 1024 * 1024,
    maxProjectJsonBytes: 192 * 1024 * 1024,
  },
  recommendedMaximums: {
    maxAssetBytes: 128 * 1024 * 1024,
    maxProjectBytes: 256 * 1024 * 1024,
    maxProjectJsonBytes: 256 * 1024 * 1024,
  },
  absoluteMaximums: {
    maxAssetBytes: 512 * 1024 * 1024,
    maxProjectBytes: 1024 * 1024 * 1024,
    maxProjectJsonBytes: 1024 * 1024 * 1024,
  },
});
