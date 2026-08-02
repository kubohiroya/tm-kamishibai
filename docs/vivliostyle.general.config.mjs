import {defineConfig} from '@vivliostyle/cli';

import {generalDocumentConfig} from './config.mjs';

export function createGeneralVivliostyleConfig(sourceFilename) {
  const selectedDocument =
    sourceFilename === undefined
      ? undefined
      : generalDocumentConfig.documents.find(
          (document) => document.sourceFilename === sourceFilename,
        );
  if (sourceFilename !== undefined && selectedDocument === undefined) {
    throw new Error(`Unknown general document: ${sourceFilename}`);
  }

  const documents =
    selectedDocument === undefined ? generalDocumentConfig.documents : [selectedDocument];
  const standalone = selectedDocument !== undefined;

  return defineConfig({
    title: selectedDocument?.title ?? generalDocumentConfig.title,
    author: generalDocumentConfig.author,
    language: 'ja',
    size: 'A4',
    viewerParam: 'bookMode=true',
    entry: documents.map(({sourceFilename: documentSourceFilename}) => ({
      path: `${generalDocumentConfig.sourceDirectory}/${documentSourceFilename}`,
      output: standalone
        ? generalDocumentConfig.standaloneArticleHtmlFilename
        : documentSourceFilename.replace(/\.md$/u, '.html'),
    })),
    theme: ['theme.css', 'general-theme.css'],
    workspaceDir: standalone
      ? `../tmp/docs-general-vivliostyle/${sourceFilename.replace(/\.md$/u, '')}`
      : '../tmp/docs-general-vivliostyle/all',
    copyAsset: {
      excludes: ['dist/**', 'tmp/**', 'general/**', 'workshops/**'],
    },
    toc: {
      title: standalone ? '目次' : '一般ドキュメント目次',
      htmlPath: standalone
        ? generalDocumentConfig.standaloneTocHtmlFilename
        : generalDocumentConfig.tocHtmlFilename,
      sectionDepth: generalDocumentConfig.tocSectionDepth,
    },
  });
}

export default createGeneralVivliostyleConfig(process.env.GENERAL_DOCUMENT_SOURCE);
