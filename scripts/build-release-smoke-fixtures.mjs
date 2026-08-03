import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

import {strFromU8, strToU8, unzipSync, zipSync} from 'fflate';

import {
  embeddedScriptVariableId,
  embeddedScriptVariableName,
  fixedZipTimestamp,
} from '../src/builder/constants.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const detailedErrorsVariableId = 'featureDetailedScriptErrors';
const unsupportedVersionScript = 'kamishibai=4.0\n';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function stageFromProject(project) {
  const stage = project.targets?.find((target) => target.isStage);
  if (!stage) throw new Error('The base SB3 has no Stage target.');
  return stage;
}

function setStageVariable(stage, id, expectedName, value) {
  const variable = stage.variables?.[id];
  if (!Array.isArray(variable) || variable[0] !== expectedName) {
    throw new Error(`The base SB3 is missing Stage variable ${id}/${expectedName}.`);
  }
  variable[1] = value;
}

function createFixture(baseArchive, {detailedErrors}) {
  const archive = {...baseArchive};
  const projectEntry = archive['project.json'];
  if (!projectEntry) throw new Error('The base SB3 is missing project.json.');
  const project = JSON.parse(strFromU8(projectEntry));
  const stage = stageFromProject(project);
  setStageVariable(
    stage,
    embeddedScriptVariableId,
    embeddedScriptVariableName,
    unsupportedVersionScript,
  );
  setStageVariable(stage, detailedErrorsVariableId, 'featureDetailedScriptErrors', detailedErrors);
  archive['project.json'] = strToU8(`${JSON.stringify(project)}\n`);
  const orderedEntries = Object.fromEntries(
    Object.entries(archive)
      .filter(([entryName]) => !entryName.endsWith('/'))
      .sort(([left], [right]) => {
        if (left === 'project.json') return -1;
        if (right === 'project.json') return 1;
        return left.localeCompare(right, 'en');
      }),
  );
  return Buffer.from(zipSync(orderedEntries, {level: 6, mtime: fixedZipTimestamp}));
}

export async function buildReleaseSmokeFixtures({
  baseSb3 = path.join(projectRoot, 'dist/downloads/kamishibai.sb3'),
  outputDirectory = path.join(projectRoot, 'tmp/release-smoke'),
} = {}) {
  const baseBytes = await readFile(baseSb3);
  const baseArchive = unzipSync(new Uint8Array(baseBytes));
  const definitions = [
    {filename: 'detailed-on-unsupported-version.sb3', detailedErrors: true},
    {filename: 'detailed-off-unsupported-version.sb3', detailedErrors: false},
  ];
  await mkdir(outputDirectory, {recursive: true});
  const fixtures = [];
  for (const definition of definitions) {
    const bytes = createFixture(baseArchive, definition);
    const outputPath = path.join(outputDirectory, definition.filename);
    await writeFile(outputPath, bytes);
    fixtures.push({
      filename: definition.filename,
      detailedErrors: definition.detailedErrors,
      script: unsupportedVersionScript,
      sha256: sha256(bytes),
      size: bytes.length,
    });
  }
  const manifest = {
    formatVersion: 1,
    base: {
      path: path.relative(projectRoot, path.resolve(baseSb3)),
      sha256: sha256(baseBytes),
      size: baseBytes.length,
    },
    fixtures,
  };
  const manifestPath = path.join(outputDirectory, 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return {fixtures, manifest, manifestPath, outputDirectory};
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const baseSb3 = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
  const outputDirectory = process.argv[3] ? path.resolve(process.argv[3]) : undefined;
  const result = await buildReleaseSmokeFixtures({baseSb3, outputDirectory});
  for (const fixture of result.fixtures) {
    process.stdout.write(
      `Built ${path.join(result.outputDirectory, fixture.filename)} (${fixture.sha256})\n`,
    );
  }
  process.stdout.write(`Built ${result.manifestPath}\n`);
}
