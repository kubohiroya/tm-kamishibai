import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

import {generalDocumentConfig} from '../docs/config.mjs';

const docsIndex = readFileSync(new URL('../site/docs/index.html', import.meta.url), 'utf8');

const audienceSections = [
  {
    id: 'general-documents',
    title: '一般向けドキュメント',
    documents: ['01-executive-summary-adult', '02-executive-summary-kids', '03-user-guide'],
  },
  {
    id: 'dsl-author-documents',
    title: '紙芝居DSL作成者向けドキュメント',
    documents: ['04-dsl-manual', '05-command-reference', 'history'],
  },
  {
    id: 'developer-documents',
    title: '開発者向けドキュメント',
    documents: ['06-developer-guide', '07-internal-specification', '08-extension-guide'],
  },
];

function sectionSource(id) {
  const match = docsIndex.match(
    new RegExp(`<section aria-labelledby="${id}">([\\s\\S]*?)\\n  </section>`, 'u'),
  );
  assert(match, `Documentation section is missing: ${id}`);
  return match[1];
}

test('groups every general document into exactly one audience section', () => {
  const expectedDocuments = generalDocumentConfig.documents.map(({sourceFilename}) =>
    sourceFilename.replace(/\.md$/u, ''),
  );
  const groupedDocuments = audienceSections.flatMap(({documents}) => documents);

  assert.deepEqual(groupedDocuments.toSorted(), expectedDocuments.toSorted());

  for (const {id, title, documents} of audienceSections) {
    const section = sectionSource(id);
    assert.match(section, new RegExp(`<h2 id="${id}">${title}</h2>`, 'u'));

    for (const basename of expectedDocuments) {
      const expectedOccurrences = documents.includes(basename) ? 2 : 0;
      const actualOccurrences = (
        section.match(new RegExp(`href="general/${basename}(?:/|\\.pdf)"`, 'gu')) ?? []
      ).length;
      assert.equal(
        actualOccurrences,
        expectedOccurrences,
        `${basename} is assigned incorrectly in ${id}.`,
      );
    }
  }

  for (const basename of expectedDocuments) {
    const occurrences = (
      docsIndex.match(new RegExp(`href="general/${basename}(?:/|\\.pdf)"`, 'gu')) ?? []
    ).length;
    assert.equal(occurrences, 2, `${basename} must have exactly one HTML link and one PDF link.`);
    assert.match(
      docsIndex,
      new RegExp(
        `href="https://vivliostyle\\.org/viewer/#src=https://kubohiroya\\.github\\.io/tmpose-kamishibai/docs/general/${basename}/publication\\.json&amp;bookMode=true"`,
        'u',
      ),
    );
  }
});

test('offers HTML, Vivliostyle Viewer, and PDF on every document card', () => {
  const actionGroups = [...docsIndex.matchAll(/<div class="actions">([\s\S]*?)<\/div>/gu)].map(
    ([, actions]) => actions,
  );

  assert.equal(actionGroups.length, 11);
  for (const actions of actionGroups) {
    assert.deepEqual(
      [...actions.matchAll(/<a\b[^>]*>([^<]+)<\/a>/gu)].map(([, label]) => label),
      ['HTML', 'Vivliostyle Viewer', 'PDF'],
    );
    assert.match(
      actions,
      /href="https:\/\/vivliostyle\.org\/viewer\/#src=[^"]+&amp;bookMode=true" target="_blank" rel="noopener">Vivliostyle Viewer<\/a>/u,
    );
  }
});
