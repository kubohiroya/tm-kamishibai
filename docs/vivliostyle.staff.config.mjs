import {defineConfig} from '@vivliostyle/cli';

import {staffDocumentConfig} from './config.mjs';

export default defineConfig({
  title: staffDocumentConfig.title,
  author: staffDocumentConfig.author,
  language: 'ja',
  size: 'A4',
  entry: [
    {
      path: `${staffDocumentConfig.sourceDirectory}/${staffDocumentConfig.sourceFilename}`,
      output: staffDocumentConfig.htmlFilename,
    },
  ],
  theme: ['theme.css', 'staff-theme.css'],
  workspaceDir: '../tmp/docs-staff-vivliostyle',
  copyAsset: {
    excludes: ['dist/**', 'general/**', 'workshops/**', 'tmp/**'],
  },
});
