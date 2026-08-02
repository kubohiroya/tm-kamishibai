import {defineConfig} from '@vivliostyle/cli';

import {documentConfig} from './config.mjs';

function flattenDocumentTableOfContents() {
  return (documentProps) => ({
    type: 'element',
    tagName: 'ol',
    properties: {},
    children: documentProps.flatMap(({children}) =>
      [children]
        .flat(Infinity)
        .flatMap((child) =>
          child?.type === 'element' && child.tagName === 'ol' ? child.children : child,
        ),
    ),
  });
}

export default defineConfig({
  title: documentConfig.title,
  author: documentConfig.author,
  language: 'ja',
  size: 'A4',
  viewerParam: 'bookMode=true',
  entry: [
    {
      rel: 'cover',
      path: `${documentConfig.sourceDirectory}/${documentConfig.coverFilename}`,
      output: documentConfig.coverHtmlFilename,
      imageSrc: 'images/image01.png',
      theme: ['theme.css', 'document-theme.css'],
    },
    {
      rel: 'contents',
    },
    {
      path: `${documentConfig.sourceDirectory}/${documentConfig.sourceFilename}`,
      output: documentConfig.sourceFilename.replace(/\.md$/u, '.html'),
    },
  ],
  theme: ['theme.css', 'document-theme.css'],
  workspaceDir: '../tmp/docs-workshop-vivliostyle',
  copyAsset: {
    excludes: ['dist/**', 'general/**', 'tmp/**'],
  },
  toc: {
    title: '目次',
    htmlPath: documentConfig.tocHtmlFilename,
    sectionDepth: documentConfig.tocSectionDepth,
    transformDocumentList: flattenDocumentTableOfContents,
  },
});
