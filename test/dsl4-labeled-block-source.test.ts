import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {test} from 'vitest';
import {strFromU8, strToU8, unzipSync, zipSync} from 'fflate';
import {parse} from 'yaml';

import {buildDsl4RuntimeComponent} from '../src/builder/dsl4-build.js';
import {authorDsl4BlockSourceGraphSb3} from '../src/builder/dsl4-block-source-author.js';
import {runCli, parseCliArguments} from '../src/builder/cli.js';
import {serializeDsl4CanonicalDocument} from '../src/builder/dsl4-validate.js';
import {createDsl4SourceGraph} from '../src/dsl4/source-graph.js';
import {createDsl4SourceGraphFrontend} from '../src/dsl4/source-graph-frontend.js';
import {
  createDsl4BlockSourceGraph,
  planDsl4BlockSourceExport,
} from '../src/dsl4/block-source-export.js';
import {
  createDsl4StructuredBlockSourceDeclaration,
  dsl4LabeledBlockSourceHatOpcode as hatOpcode,
  dsl4IncludeBlocksOpcode as includeOpcode,
} from '../src/dsl4/structured-block-source.js';
import {
  createDsl4BlockSourceDeclaration,
  extractDsl4BlockSourcesFromProject,
  Dsl4BlockSourceError,
} from '../src/dsl4/turbowarp-yaml-json-block-source.js';
import {dsl4TestSourceFrontend as frontend} from './helpers/dsl4-test-frontend.ts';
import {captureWrites, cliResult} from './helpers/cli-command.ts';
import {requireRecord, requireString} from './helpers/require-value.ts';

const helperPrefix = 'kubohiroyakamishibaiauthoring4_';
const runtimePrefix = 'kubohiroyakamishibai4_kubohiroyakamishibairuntime4__';
type Blocks = ReturnType<typeof createDsl4StructuredBlockSourceDeclaration>;
type Project = {
  targets: {name: string; isStage: boolean; blocks: Blocks}[];
  extensions?: string[];
  extensionURLs?: Record<string, string>;
};
const sources: Record<string, string> = {
  'story.k4.yml': `kamishibai: '4.0'
include: [chapters/intro.k4.yml, ending.k4.yml]
controls:
  keymaps:
    production:
      Space: navigation.nextAction
scenes:
  opening:
    - goto: intro
`,
  'chapters/intro.k4.yml': `include: ../assets.k4.yml
scenes:
  intro:
    - stage: Background
    - wait: 1
    - goto: ending
`,
  'ending.k4.yml': 'scenes:\n  ending:\n    - wait: 0\n',
  'assets.k4.yml': 'assets:\n  Background: backdrop\n',
};
function archive(project: Project) {
  return zipSync({'project.json': strToU8(JSON.stringify(project))});
}
function base(): Project {
  return {
    targets: [{name: 'Stage', isStage: true, blocks: {}}],
    extensions: ['kubohiroyakamishibai4'],
  };
}
function declaration(label: string, scene: string, includes: string[] = [], id = scene): Blocks {
  return createDsl4StructuredBlockSourceDeclaration({
    source: {scenes: {[scene]: [{wait: 1}]}},
    form: 'bundle',
    hatId: id,
    idPrefix: `${id}-`,
    label,
    includeLabels: includes,
  });
}
function projectWithModules(): Project {
  return {
    targets: [
      {
        name: 'Stage',
        isStage: true,
        blocks: {...declaration('', 'opening', ['共通']), ...declaration('共通', 'ending')},
      },
    ],
  };
}
function setInput(block: Blocks[string], name: string, value: string | number) {
  block.inputs[name] = [1, [typeof value === 'number' ? 4 : 10, value]];
}
function first(blocks: Blocks, opcode: string): [string, Blocks[string]] {
  const found = Object.entries(blocks).find(([, block]) => block.opcode === opcode);
  assert.ok(found, `Missing ${opcode}`);
  return found;
}
function rawSources(project: Project) {
  return Object.fromEntries(
    Object.entries(extractDsl4BlockSourcesFromProject(project).sources).map(([name, text]) => [
      name,
      parse(text),
    ]),
  );
}
async function inputGraph(input = sources) {
  return createDsl4SourceGraph('story.k4.yml', {
    readSource(name) {
      assert.ok(Object.hasOwn(input, name), `Missing ${name}`);
      return input[name]!;
    },
  });
}
async function author(input = sources) {
  const graph = await inputGraph(input);
  const result = await authorDsl4BlockSourceGraphSb3({
    baseBytes: archive(base()),
    sourceGraph: graph,
    sourceFrontend: frontend,
  });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  if (!result.ok) throw new Error('author failed');
  const project = JSON.parse(strFromU8(unzipSync(result.bytes)['project.json']!)) as Project;
  return {graph, result, project};
}
function composed(graph: Awaited<ReturnType<typeof inputGraph>>) {
  const result = createDsl4SourceGraphFrontend(frontend).parse(graph, {
    featureFlags: {dsl4Runtime: true, dsl4SourceIncludes: true},
    maxComposedSourceBytes: 1024 * 1024,
    sourceId: 'main',
  });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  return serializeDsl4CanonicalDocument(frontend.parse(result.canonicalSource, {sourceId: 'main'}));
}

test('authors nested includes as separate labeled declarations deterministically and keeps their meaning', async () => {
  const {graph, result, project} = await author();
  const again = await author();
  assert.deepEqual(result.bytes, again.result.bytes);
  const blocks = project.targets[0]!.blocks;
  assert.equal(Object.values(blocks).filter((block) => block.opcode === hatOpcode).length, 4);
  assert.equal(Object.values(blocks).filter((block) => block.opcode === includeOpcode).length, 3);
  const extracted = extractDsl4BlockSourcesFromProject(project);
  assert.equal(composed(await createDsl4BlockSourceGraph(extracted)), composed(graph));
  const raw = rawSources(project);
  assert.deepEqual(raw['Stage.k4.yml'].include, ['blocks-0002.k4.yml', 'blocks-0003.k4.yml']);
  assert.deepEqual(raw['blocks-0002.k4.yml'].include, ['blocks-0001.k4.yml']);
  assert.equal(raw['blocks-0001.k4.yml'].kamishibai, undefined);
  assert.equal(raw['blocks-0001.k4.yml'].scenes, undefined);
});

test('rebases asset paths from nested modules before flattening their exported filenames', async () => {
  const input = {
    ...sources,
    'chapters/intro.k4.yml':
      'scenes:\n  intro:\n    - wait: 1\nassets:\n  Extra:\n    kind: backdrop\n    file: image/bg.svg\n',
  };
  const {graph, project} = await author(input);
  const extracted = extractDsl4BlockSourcesFromProject(project);
  const assets = Object.values(rawSources(project)).flatMap((value) =>
    Object.values(value.assets ?? {}),
  );
  assert.ok(
    assets.some(
      (value) =>
        typeof value === 'object' &&
        value !== null &&
        'file' in value &&
        value.file === 'chapters/image/bg.svg',
    ),
  );
  assert.equal(composed(await createDsl4BlockSourceGraph(extracted)), composed(graph));
});

test('resolves labels across targets and uses safe portable filenames even for path-like labels', async () => {
  const label = '../../共通/CON:*?';
  const project = base();
  project.targets[0]!.blocks = declaration('', 'opening', [label]);
  project.targets.push({name: 'Actor', isStage: false, blocks: declaration(label, 'ending')});
  const result = extractDsl4BlockSourcesFromProject(project);
  assert.deepEqual(Object.keys(result.sources), ['Stage.k4.yml', 'blocks-0001.k4.yml']);
  assert.deepEqual(parse(result.sources['Stage.k4.yml']!).include, ['blocks-0001.k4.yml']);
  await createDsl4BlockSourceGraph(result);
});

test('reflects label, include order, insertion, deletion and module action edits in YAML', async () => {
  const project = projectWithModules();
  const blocks = project.targets[0]!.blocks;
  setInput(blocks.ending!, 'LABEL', '改名');
  const [includeId, include] = first(blocks, includeOpcode);
  setInput(include, 'LABEL', '改名');
  const [, action] = first(
    Object.fromEntries(Object.entries(blocks).filter(([id]) => id.startsWith('ending-'))),
    `${runtimePrefix}wait`,
  );
  setInput(action, 'SECONDS', 8);
  Object.assign(blocks, declaration('追加', 'extra'));
  // Add one reference before the existing one, exactly as the editor connects commands.
  blocks.newInclude = {
    ...include,
    parent: 'opening',
    next: includeId,
    inputs: {LABEL: [1, [10, '追加']]},
  };
  blocks.opening!.next = 'newInclude';
  include.parent = 'newInclude';
  let raw = rawSources(project);
  const entryIncludes = raw['Stage.k4.yml'].include;
  assert.equal(entryIncludes.length, 2);
  assert.deepEqual(raw[entryIncludes[1]].scenes.ending, [{wait: 8}]);
  assert.deepEqual(raw[entryIncludes[0]].scenes.extra, [{wait: 1}]);
  // Remove the newly inserted include and its module.
  blocks.opening!.next = includeId;
  include.parent = 'opening';
  delete blocks.newInclude;
  for (const id of Object.keys(blocks))
    if (id === 'extra' || id.startsWith('extra-')) delete blocks[id];
  raw = rawSources(project);
  assert.equal(raw['Stage.k4.yml'].include.length, 1);
  assert.equal(Object.keys(raw).length, 2);
  await createDsl4BlockSourceGraph(extractDsl4BlockSourcesFromProject(project));
});

for (const invalid of [
  'missing',
  'empty',
  'duplicate',
  'self',
  'cycle',
  'dynamic',
  'version',
  'collision',
  'bad-parent',
] as const) {
  test(`diagnoses ${invalid} references or declarations without using cached YAML`, () => {
    const project = projectWithModules();
    const blocks = project.targets[0]!.blocks;
    const [, include] = first(blocks, includeOpcode);
    if (invalid === 'missing') setInput(include, 'LABEL', '存在しない');
    if (invalid === 'empty') setInput(include, 'LABEL', '');
    if (invalid === 'duplicate') Object.assign(blocks, declaration('共通', 'duplicate'));
    if (invalid === 'self') Object.assign(blocks, declaration('共通', 'ending', ['共通']));
    if (invalid === 'cycle') {
      Object.assign(
        blocks,
        declaration('共通', 'ending', ['別']),
        declaration('別', 'cycle', ['共通']),
      );
    }
    if (invalid === 'dynamic') include.inputs.LABEL = [3, [12, 'name', 'variable'], [10, '共通']];
    if (invalid === 'version') setInput(blocks.opening!, 'VERSION', '5.0');
    if (invalid === 'collision') project.targets[0]!.name = 'blocks-0001';
    if (invalid === 'bad-parent') include.parent = 'ending';
    const category = {
      missing: 'LABEL',
      empty: 'LABEL',
      duplicate: 'DUPLICATE',
      self: 'CYCLE',
      cycle: 'CYCLE',
      dynamic: 'LABEL',
      version: 'VERSION',
      collision: 'DUPLICATE',
      'bad-parent': 'GRAPH',
    }[invalid];
    assert.throws(
      () => extractDsl4BlockSourcesFromProject(project),
      (error) =>
        error instanceof Dsl4BlockSourceError &&
        error.code === `K4-BLOCK-SOURCE-${category}-001` &&
        error.targetName === project.targets[0]!.name &&
        typeof error.blockId === 'string',
    );
  });
}

test('diagnoses declaration collisions after include composition', async () => {
  const project = projectWithModules();
  const scene = first(
    Object.fromEntries(
      Object.entries(project.targets[0]!.blocks).filter(([id]) => id.startsWith('ending-')),
    ),
    `${helperPrefix}scene`,
  )[1];
  setInput(scene, 'SCENE', 'opening');
  await assert.rejects(
    createDsl4BlockSourceGraph(extractDsl4BlockSourcesFromProject(project)),
    (error: {code?: string; message?: string}) =>
      error.code === 'K4-DECLARATION-DUPLICATE' &&
      /target "Stage", block "ending"/u.test(error.message ?? ''),
  );
});

test('rejects export names that collide with generated modules on case-insensitive filesystems', async () => {
  const sourceSet = extractDsl4BlockSourcesFromProject(projectWithModules());
  const graph = await createDsl4BlockSourceGraph(sourceSet);
  assert.throws(
    () =>
      planDsl4BlockSourceExport({
        blockSourceSet: sourceSet,
        sourceGraph: {...graph, nodes: graph.nodes.filter((node) => node !== undefined)},
        name: 'BLOCKS-0001',
      }),
    (error) =>
      error instanceof Dsl4BlockSourceError && error.code === 'K4-BLOCK-EXPORT-COLLISION-001',
  );
});

test('keeps unlabeled old declarations and treats omitted new labels as empty', () => {
  const blocks = declaration('', 'opening');
  delete blocks.opening!.inputs.LABEL;
  const project = {targets: [{name: 'Stage', isStage: true, blocks}]};
  assert.equal(
    parse(extractDsl4BlockSourcesFromProject(project).sources['Stage.k4.yml']!).kamishibai,
    '4.0',
  );
  const legacy = createDsl4BlockSourceDeclaration({
    sourceText: "kamishibai: '4.0'\nscenes:\n  opening:\n    - wait: 1\n",
    form: 'bundle',
    hatId: 'legacy',
    commandId: 'command',
  });
  project.targets[0]!.blocks = legacy;
  assert.deepEqual(
    parse(extractDsl4BlockSourcesFromProject(project).sources['Stage.k4.yml']!).scenes.opening,
    [{wait: 1}],
  );
  const oldStructured = declaration('', 'opening');
  const hat = oldStructured.opening!;
  const oldFirst = hat.next!;
  hat.opcode = `${runtimePrefix}whenDsl4Source`;
  hat.inputs = {};
  hat.next = 'oldVersion';
  oldStructured[oldFirst]!.parent = 'oldVersion';
  oldStructured.oldVersion = {
    opcode: `${helperPrefix}property`,
    parent: 'opening',
    next: oldFirst,
    inputs: {PATH: [1, [10, '["kamishibai"]']], VALUE: [1, [10, '"4.0"']]},
    fields: {},
    topLevel: false,
    shadow: false,
  };
  project.targets[0]!.blocks = oldStructured;
  assert.deepEqual(parse(extractDsl4BlockSourcesFromProject(project).sources['Stage.k4.yml']!), {
    kamishibai: '4.0',
    scenes: {opening: [{wait: 1}]},
  });
});

test('requires an unambiguous Stage entry and enforces the declaration count bound', () => {
  const named = {
    targets: [{name: 'Stage', isStage: true, blocks: declaration('主台本', 'opening')}],
  };
  assert.equal(extractDsl4BlockSourcesFromProject(named).entryPath, 'Stage.k4.yml');
  Object.assign(named.targets[0]!.blocks, declaration('別', 'ending'));
  assert.throws(() => extractDsl4BlockSourcesFromProject(named), /unambiguous/u);
  assert.throws(
    () =>
      extractDsl4BlockSourcesFromProject(projectWithModules(), {
        limits: {maxDeclarations: 1},
      }),
    /declaration limit/u,
  );
});

test('CLI authors, exports a YAML package, reauthors, and builds the edited include graph', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsl4-label-cli-'));
  try {
    await mkdir(path.join(directory, 'chapters'));
    for (const [name, text] of Object.entries(sources))
      await writeFile(
        path.join(directory, name),
        name === 'assets.k4.yml'
          ? 'variables: {shared: 0}\n'
          : text.replace('    - stage: Background\n', ''),
      );
    const basePath = path.join(directory, 'base.sb3');
    const blockPath = path.join(directory, 'blocks.sb3');
    await writeFile(basePath, archive(base()));
    const io = {stdout: captureWrites(), stderr: captureWrites()};
    const authorResult = await runCli(
      [
        'author-block-dsl',
        '--input',
        path.join(directory, 'story.k4.yml'),
        '--base',
        basePath,
        '--output',
        blockPath,
      ],
      io,
    );
    assert.equal(cliResult(authorResult, 'authorResult').ok, true);
    const project = JSON.parse(
      strFromU8(unzipSync(await readFile(blockPath))['project.json']!),
    ) as Project;
    const blocks = project.targets[0]!.blocks;
    const [, wait] = first(blocks, `${runtimePrefix}wait`);
    setInput(wait, 'SECONDS', 17);
    await writeFile(blockPath, archive(project));
    const exported = await runCli(
      [
        'export-block-dsl',
        '--input',
        blockPath,
        '--output-dir',
        path.join(directory, 'out'),
        '--name',
        'edited',
      ],
      io,
    );
    assert.equal(cliResult(exported, 'exported').exitCode, 0, io.stderr.text);
    const packageBytes = await readFile(path.join(directory, 'out', 'edited-k4.zip'));
    const files = unzipSync(packageBytes);
    const packageDirectory = path.join(directory, 'exported');
    await mkdir(packageDirectory);
    for (const [name, bytes] of Object.entries(files)) {
      const filePath = path.join(packageDirectory, name);
      await mkdir(path.dirname(filePath), {recursive: true});
      await writeFile(filePath, bytes);
    }
    assert.equal(Object.keys(files).filter((name) => name.endsWith('.k4.yml')).length, 4);
    assert.ok(Object.values(files).some((bytes) => strFromU8(bytes).includes('wait: 17')));
    const reauthored = await runCli(
      [
        'author-block-dsl',
        '--input',
        path.join(packageDirectory, 'edited-k4', 'edited.k4.yml'),
        '--base',
        basePath,
        '--output',
        path.join(directory, 'again.sb3'),
      ],
      io,
    );
    assert.equal(cliResult(reauthored, 'reauthored').ok, true);
    const buildRoot = path.join(directory, 'build-root');
    await mkdir(buildRoot);
    const built = await runCli(
      [
        'build-dsl4',
        '--base',
        blockPath,
        '--project-root',
        path.join(packageDirectory, 'edited-k4'),
        '--source',
        'edited.k4.yml',
        '--enable-source-includes',
        '--max-source-files',
        '64',
        '--max-total-source-bytes',
        '1048576',
        '--max-include-depth',
        '32',
        '--output',
        path.join(directory, 'play.sb3'),
        '--control-profile',
        'production',
        '--channel',
        'bundled',
      ],
      io,
    );
    assert.equal(cliResult(built, 'built').outputPath, path.join(directory, 'play.sb3'));
    const fromBlocks = await buildDsl4RuntimeComponent({
      baseSb3Bytes: archive(project),
      projectRoot: buildRoot,
      sourceFrontend: frontend,
      controlProfile: 'production',
      channel: 'bundled',
      featureFlags: {dsl4Runtime: true, dsl4SourceIncludes: true},
      maxSourceBytes: 1024 * 1024,
      maxTotalSourceBytes: 4 * 1024 * 1024,
      maxAssetFileBytes: 1024 * 1024,
      maxAssetFiles: 64,
      maxTotalAssetBytes: 4 * 1024 * 1024,
    });
    assert.ok(fromBlocks.bytes.length > 0);
    const component = requireRecord(fromBlocks.runtimeComponent, 'built component');
    const descriptor = requireRecord(component.sourceDescriptor, 'built source descriptor');
    assert.match(requireString(descriptor.text, 'built source text'), /wait: 17/u);
    assert.ok((await readFile(path.join(directory, 'play.sb3'))).length > 0);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('CLI rejects missing includes and finite limits before writing an SB3', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsl4-label-limit-'));
  try {
    const input = path.join(directory, 'story.k4.yml');
    const output = path.join(directory, 'no.sb3');
    const basePath = path.join(directory, 'base.sb3');
    await writeFile(input, sources['story.k4.yml']!);
    await writeFile(basePath, archive(base()));
    const args = ['author-block-dsl', '--input', input, '--base', basePath, '--output', output];
    await assert.rejects(
      runCli(args, {stdout: captureWrites(), stderr: captureWrites()}),
      /missing|read/iu,
    );
    await assert.rejects(readFile(output), {code: 'ENOENT'});
    assert.throws(() => parseCliArguments([...args, '--max-source-files', '0']), /integer/u);
    assert.throws(() => parseCliArguments([...args, '--max-total-source-bytes', '1']), /integer/u);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
