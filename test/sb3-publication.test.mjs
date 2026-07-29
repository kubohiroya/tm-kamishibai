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
  const [
    downloadPage,
    developerGuide,
    internalSpecification,
    readme,
    userGuide,
    packageJsonSource,
  ] = await Promise.all([
    readFile(path.join(projectRoot, 'site/downloads/index.html'), 'utf8'),
    readFile(path.join(projectRoot, 'docs/general/06-developer-guide.md'), 'utf8'),
    readFile(path.join(projectRoot, 'docs/general/07-internal-specification.md'), 'utf8'),
    readFile(path.join(projectRoot, 'README.md'), 'utf8'),
    readFile(path.join(projectRoot, 'docs/general/03-user-guide.md'), 'utf8'),
    readFile(path.join(projectRoot, 'package.json'), 'utf8'),
  ]);
  const packageJson = JSON.parse(packageJsonSource);

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
  assert.match(developerGuide, /github\.com\/kubohiroya\/sb3-toolchain/u);
  assert.doesNotMatch(developerGuide, /github:kubohiroya\/sb3-toolchain#[0-9a-f]{40}/u);
  assert.match(readme, /github\.com\/kubohiroya\/sb3-toolchain/u);
  assert.match(
    packageJson.devDependencies['@kubohiroya/sb3-toolchain'],
    /^github:kubohiroya\/sb3-toolchain#[0-9a-f]{40}$/u,
    'SB3 toolchain dependency must use a fixed commit.',
  );
  assert.doesNotMatch(readme, /github:kubohiroya\/sb3-toolchain#[0-9a-f]{40}/u);
  assert.match(developerGuide, /`stories\/urashima\/`/u);
  assert.doesNotMatch(developerGuide, /samples\/urashima\//u);
  assert.match(internalSpecification, /`dist\/downloads\/kamishibai\.sb3`/u);
  assert.match(userGuide, /kubohiroya\.github\.io\/tmpose-kamishibai\/downloads\//u);
  assert.match(
    userGuide,
    /kubohiroya\.github\.io\/tmpose-kamishibai-samples\/stories\/urashima\//u,
  );
  assert.match(
    readme,
    /pnpm add --save-exact @kubohiroya\/tmpose-kamishibai@3\.1\.1/u,
    'README installation must use the current fixed npm version.',
  );
  assert.match(
    internalSpecification,
    /pnpm add --save-exact @kubohiroya\/tmpose-kamishibai@<VERSION>/u,
  );
  assert.match(internalSpecification, /npm view @kubohiroya\/tmpose-kamishibai version/u);
  for (const document of [developerGuide, internalSpecification, readme]) {
    assert.doesNotMatch(
      document,
      /github:kubohiroya\/tmpose-kamishibai#v3\.1\.0/u,
      'Documentation must not use the retired Git tag installation path.',
    );
    assert.doesNotMatch(document, /allowBuilds/u);
  }
  for (const document of [developerGuide, readme]) {
    assert.match(document, /github\.com\/kubohiroya\/tmpose-kamishibai-samples/u);
    assert.match(document, /kubohiroya\.github\.io\/tmpose-kamishibai-samples\//u);
  }
  assert.match(developerGuide, /pnpm install --frozen-lockfile/u);
  for (const command of [
    'pnpm sb3:extensions:status',
    'pnpm sb3:extensions:sync',
    'pnpm sb3:extensions:update -- OLD_ID --migrate-id NEW_ID',
    'pnpm run preview:docs',
  ]) {
    assert(developerGuide.includes(command), `Developer guide is missing: ${command}`);
  }
  for (const command of ['pnpm release:check', 'npm publish --access public']) {
    assert(
      internalSpecification.includes(command),
      `Internal specification is missing: ${command}`,
    );
  }
  for (const exportedName of [
    'buildSb3Bundle',
    'Sb3BuilderError',
    'validateAssetManifest',
    'validateBundle',
  ]) {
    assert(
      internalSpecification.includes(exportedName),
      `Internal specification is missing: ${exportedName}`,
    );
  }
  assert.match(readme, /\[開発者ガイド\]\(docs\/general\/06-developer-guide\.md\)/u);
  assert.doesNotMatch(readme, /setLoadingCostume=/u);
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
  const internalSpecification = await readFile(
    path.join(projectRoot, 'docs/general/07-internal-specification.md'),
    'utf8',
  );
  const profileSection = internalSpecification.match(
    /^## 2\. 成果物プロファイル$(?<section>[\s\S]*?)(?=^## 3\. )/mu,
  )?.groups?.section;

  assert(profileSection, 'Internal specification is missing the artifact profile section.');
  for (const profile of ['`generic`', '`editor`', '`player`']) {
    assert(profileSection.includes(profile), `Artifact profile is missing: ${profile}`);
  }
  for (const filename of ['`kamishibai.sb3`', '`_urashima.sb3`', '`urashima.sb3`']) {
    assert(profileSection.includes(filename), `Artifact filename is missing: ${filename}`);
  }
  assert.match(profileSection, /`generic`[^\n]*`kamishibai\.sb3`[^\n]*非埋め込み[^\n]*非埋め込み/u);
  assert.match(profileSection, /`editor`[^\n]*`_urashima\.sb3`[^\n]*非埋め込み[^\n]*埋め込み/u);
  assert.match(profileSection, /`player`[^\n]*`urashima\.sb3`[^\n]*埋め込み[^\n]*埋め込み/u);
  assert.match(
    profileSection,
    /builder APIとCLIが受け付ける\s*`profile`は`editor`または`player`/u,
  );
  assert.match(profileSection, /`player`[\s\S]*ファイル選択なし/u);
  assert.match(profileSection, /オンライン依存[^\n]*成果物manifest/u);
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
