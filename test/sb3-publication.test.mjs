import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

test('keeps static distribution sources free of SB3 binaries', async () => {
  const downloadEntries = await readdir(path.join(projectRoot, 'site/downloads'));
  assert.deepEqual(
    downloadEntries.filter((entryName) => entryName.endsWith('.sb3')),
    [],
  );

  const ignoreRules = new Set(
    (await readFile(path.join(projectRoot, '.gitignore'), 'utf8')).split(/\r?\n/u),
  );
  assert(ignoreRules.has('/kamishibai.sb3'));
  assert(ignoreRules.has('/urashima.sb3'));
  assert(ignoreRules.has('/site/downloads/*.sb3'));
  await assert.rejects(
    readFile(path.join(projectRoot, 'urashima.sb3')),
    (error) => error.code === 'ENOENT',
  );
});

test('links and documents the generated downloadable SB3', async () => {
  const [downloadPage, developerGuide, readme, userGuide] = await Promise.all([
    readFile(path.join(projectRoot, 'site/downloads/index.html'), 'utf8'),
    readFile(path.join(projectRoot, 'docs/general/06-developer-guide.md'), 'utf8'),
    readFile(path.join(projectRoot, 'README.md'), 'utf8'),
    readFile(path.join(projectRoot, 'docs/general/01-user-guide.md'), 'utf8'),
  ]);

  assert.match(downloadPage, /href="kamishibai\.sb3" download/u);
  assert.doesNotMatch(downloadPage, /kamishibai-3_1a1\.sb3/u);
  assert.match(userGuide, /`kamishibai\.sb3`/u);
  for (const command of [
    'pnpm sb3:build',
    'pnpm sb3:import -- /path/to/edited-kamishibai.sb3',
    'pnpm sb3:check',
    'pnpm test',
    'pnpm run build',
  ]) {
    assert(developerGuide.includes(command), `Developer guide is missing: ${command}`);
  }
  assert.match(developerGuide, /`app\/`[^\n]*正本/u);
  assert.match(developerGuide, /`stories\/urashima\/`/u);
  assert.doesNotMatch(developerGuide, /samples\/urashima\//u);
  assert.match(readme, /`dist\/downloads\/kamishibai\.sb3`/u);
  assert.match(userGuide, /kubohiroya\.github\.io\/tmpose-kamishibai\/downloads\//u);
  assert.match(
    userGuide,
    /kubohiroya\.github\.io\/tmpose-kamishibai-samples\/stories\/urashima\//u,
  );
  for (const document of [developerGuide, readme]) {
    assert.match(
      document,
      /github:kubohiroya\/tmpose-kamishibai#v3\.1\.0/u,
      'Builder installation must use the fixed GitHub tag.',
    );
    assert.match(document, /allowBuilds/u);
    assert.match(document, /pnpm install --frozen-lockfile/u);
    assert.doesNotMatch(
      document,
      /pnpm add --save-exact @kubohiroya\/tmpose-kamishibai@3\.1\.0/u,
      'Documentation must not require the unpublished npm package.',
    );
    assert.match(document, /github\.com\/kubohiroya\/tmpose-kamishibai-samples/u);
    assert.match(document, /kubohiroya\.github\.io\/tmpose-kamishibai-samples\//u);
  }
});

test('links the public sample site without restoring the retired local page', async () => {
  const pages = await Promise.all([
    'site/index.html',
    'site/docs/index.html',
    'site/downloads/index.html',
  ].map((relativePath) => readFile(path.join(projectRoot, relativePath), 'utf8')));

  for (const page of pages) {
    assert.match(
      page,
      /href="https:\/\/kubohiroya\.github\.io\/tmpose-kamishibai-samples\/"/u,
    );
    assert.doesNotMatch(page, /href="(?:\.\.\/)*samples\/"/u);
  }
});

test('documents the generic, editor, and player artifact profiles', async () => {
  const developerGuide = await readFile(
    path.join(projectRoot, 'docs/general/06-developer-guide.md'),
    'utf8',
  );
  const profileSection = developerGuide.match(
    /### 1\.7 成果物プロファイル(?<section>[\s\S]*?)\n## 2\./u,
  )?.groups?.section;

  assert(profileSection, 'Developer guide is missing the artifact profile section.');
  for (const profile of ['`generic`', '`editor`', '`player`']) {
    assert(profileSection.includes(profile), `Artifact profile is missing: ${profile}`);
  }
  for (const filename of ['`kamishibai.sb3`', '`_urashima.sb3`', '`urashima.sb3`']) {
    assert(profileSection.includes(filename), `Artifact filename is missing: ${filename}`);
  }
  assert.match(profileSection, /`generic`[^\n]*`kamishibai\.sb3`[^\n]*非埋め込み[^\n]*非埋め込み/u);
  assert.match(profileSection, /`editor`[^\n]*`_urashima\.sb3`[^\n]*非埋め込み[^\n]*埋め込み/u);
  assert.match(profileSection, /`player`[^\n]*`urashima\.sb3`[^\n]*埋め込み[^\n]*埋め込み/u);
  assert.match(profileSection, /TurboWarp Packager[^\n]*`player`だけを入力/u);
  assert.match(profileSection, /タイトル画面をクリック[^\n]*ファイル選択を行わず/u);
  assert.match(profileSection, /「再生専用」ではなく「再生用」/u);
  assert.match(profileSection, /issues\/60/u);
  assert.match(profileSection, /tmpose-kamishibai-samples\/issues\/2/u);
  assert.match(profileSection, /tmpose-kamishibai-samples\/issues\/7/u);
  assert.match(profileSection, /プロファイル契約は導入済み/u);
  assert.doesNotMatch(profileSection, /段階導入中/u);
});

test('keeps only minimal validation scripts in the application repository', async () => {
  const sampleEntries = await readdir(path.join(projectRoot, 'samples')).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  assert.deepEqual(sampleEntries, []);

  const fixtureDirectories = ['manual', 'runtime'];
  const fixtureFiles = [];
  for (const directory of fixtureDirectories) {
    const directoryPath = path.join(projectRoot, 'test/fixtures', directory);
    for (const filename of await readdir(directoryPath)) {
      if (filename.endsWith('.txt')) fixtureFiles.push(path.join(directoryPath, filename));
    }
  }

  assert(fixtureFiles.length > 0, 'No validation scripts were found.');
  for (const fixtureFile of fixtureFiles) {
    const fixture = await readFile(fixtureFile, 'utf8');
    assert(fixture.length < 1_000, `Validation script is not minimal: ${fixtureFile}`);
  }
});

test('keeps the generic app source free of Urashima sample content', async () => {
  const genericProjectSource = await readFile(
    path.join(projectRoot, 'app/project.source.json'),
    'utf8',
  );
  const genericProject = JSON.parse(genericProjectSource);
  const genericStage = genericProject.targets.find((target) => target.isStage);
  const sampleTargetNames = ['Fish', 'Princess', 'Turtle', 'Urashima'];
  const sampleAssetNames = ['Beach1', 'Dragon Castle', 'Ocean Wave', 'Urashima-old-2'];

  assert(genericStage, 'The generic app source has no Stage target.');
  assert.deepEqual(genericStage.variables?.tmposeEmbeddedScript, [
    '__tmpose_embedded_script',
    '',
  ]);
  assert.equal(
    genericProject.monitors.some((monitor) => monitor.id === 'tmposeEmbeddedScript'),
    false,
    'The reserved embedded script variable must not have a monitor.',
  );
  assert.equal(genericStage.blocks.embeddedScriptChoice?.opcode, 'control_if_else');
  assert.equal(
    genericStage.blocks.embeddedSetScript?.opcode,
    'lmsTempVars2_setRuntimeVariable',
  );
  assert.deepEqual(genericStage.blocks.embeddedSetScript?.inputs?.VAR, [
    1,
    [10, 'script'],
  ]);
  assert.equal(
    genericStage.blocks.embeddedStartStory?.inputs?.BROADCAST_INPUT?.[1]?.[1],
    'startStory',
  );
  assert.equal(
    genericStage.blocks['l@']?.inputs?.BROADCAST_INPUT?.[1]?.[1],
    'showCover',
  );
  for (const list of Object.values(genericStage.lists ?? {})) {
    assert.deepEqual(list[1], [], `Generic runtime list is not empty: ${list[0]}`);
  }
  for (const targetName of sampleTargetNames) {
    assert(!genericProject.targets.some((target) => target.name === targetName),
      `Generic app source contains the sample target: ${targetName}`);
  }

  const genericAssetNames = genericProject.targets.flatMap((target) => [
    ...(target.costumes ?? []).map((costume) => costume.name),
    ...(target.sounds ?? []).map((sound) => sound.name),
  ]);
  for (const assetName of sampleAssetNames) {
    assert(!genericAssetNames.includes(assetName),
      `Generic app source contains the sample asset: ${assetName}`);
  }
});
