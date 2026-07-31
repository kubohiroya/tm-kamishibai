import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {documentConfig} from '../docs/config.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const copyrightNotice = /Copyright © 2026 Hiroya Kubo\./u;

const collectMarkdownFiles = async (directory) => {
  const entries = await readdir(directory, {withFileTypes: true});
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectMarkdownFiles(entryPath)));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(entryPath);
    }
  }
  return files;
};

test('declares the repository license boundaries', async () => {
  const [licenseMap, packageJson, readme] = await Promise.all([
    readFile(path.join(projectRoot, 'LICENSES.md'), 'utf8'),
    readFile(path.join(projectRoot, 'package.json'), 'utf8').then(JSON.parse),
    readFile(path.join(projectRoot, 'README.md'), 'utf8'),
  ]);

  assert.equal(packageJson.license, 'MPL-2.0');
  for (const text of [licenseMap, readme]) {
    assert.match(text, /docs\/general/u);
    assert.match(text, /CC BY-SA 4\.0/u);
    assert.match(text, /docs\/workshops/u);
    assert.match(text, /All rights reserved/u);
    assert.match(text, /MPL-2\.0/u);
  }
});

test('marks every general document as CC BY-SA 4.0', async () => {
  const generalDirectory = path.join(projectRoot, 'docs/general');
  const files = (await collectMarkdownFiles(generalDirectory)).filter(
    (filePath) => path.basename(filePath) !== 'LICENSE.md',
  );
  assert(files.length > 0);

  for (const filePath of files) {
    const source = await readFile(filePath, 'utf8');
    assert.match(source, copyrightNotice, filePath);
    assert.match(source, /CC BY-SA 4\.0/u, filePath);
  }
});

test('keeps the workshop license notice outside the participant body', async () => {
  const workshopDirectory = path.join(projectRoot, 'docs/workshops');
  const participantSourcePath = path.join(
    projectRoot,
    'docs',
    documentConfig.sourceDirectory,
    documentConfig.sourceFilename,
  );
  const files = (await collectMarkdownFiles(workshopDirectory)).filter(
    (filePath) => path.basename(filePath) !== 'LICENSE.md' && filePath !== participantSourcePath,
  );
  assert(files.length > 0);

  for (const filePath of files) {
    const source = await readFile(filePath, 'utf8');
    assert.match(source, copyrightNotice, filePath);
    assert.match(source, /All rights reserved\./u, filePath);
  }

  const [licenseSource, participantSource] = await Promise.all([
    readFile(path.join(workshopDirectory, 'LICENSE.md'), 'utf8'),
    readFile(participantSourcePath, 'utf8'),
  ]);
  assert.match(licenseSource, copyrightNotice);
  assert.match(licenseSource, /All rights reserved\./u);
  assert.doesNotMatch(participantSource, copyrightNotice);
  assert.doesNotMatch(participantSource, /All rights reserved\./u);
});
