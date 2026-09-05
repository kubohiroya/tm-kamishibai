import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {strFromU8, strToU8, unzipSync, zipSync} from 'fflate';

import {runCli} from '../src/builder/cli.js';
import {
  Dsl4BlockSourceExportError,
  exportDsl4BlockSourcesToYaml,
} from '../src/builder/dsl4-block-source-export.js';
import {
  createDsl4BlockSourceGraph,
  planDsl4BlockSourceExport,
  serializeDsl4SourceYaml,
} from '../src/dsl4/block-source-export.js';
import {createDsl4SourceFrontend} from '../src/dsl4/source-frontend.js';
import {createDsl4SourceGraphFrontend} from '../src/dsl4/source-graph-frontend.js';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const schema = JSON.parse(
  await readFile(path.join(repositoryRoot, 'schema', 'dsl-4.schema.json'), 'utf8'),
);
const frontend = createDsl4SourceFrontend(schema);
const runtimePrefix = 'kubohiroyakamishibairuntime4_';
const yamlJsonPrefix = 'kubohiroyayamljson_';

const rootSource = `include: turtle.k4.yml
kamishibai: '4.0'
controls:
  keymaps:
    production:
      Space: navigation.nextAction
scenes:
  opening:
    - goto: chapter1
`;
const turtleSource = `assets:
  ChapterBackground:
    kind: backdrop
    file: image/background.svg
scenes:
  chapter1:
    - stage: ChapterBackground
`;
const standaloneSource = `kamishibai: '4.0'
controls:
  keymaps:
    production:
      Space: navigation.nextAction
assets:
  Cover:
    kind: backdrop
    file: image/cover.svg
scenes:
  opening:
    - stage: Cover
`;

/** @param {string} sourceText @param {string} [suffix] */
function declarationBlocks(sourceText, suffix = '') {
  return {
    [`hat${suffix}`]: {
      opcode: `${runtimePrefix}whenDsl4Source`,
      next: `command${suffix}`,
      parent: null,
      inputs: {},
      fields: {},
      shadow: false,
      topLevel: true,
    },
    [`command${suffix}`]: {
      opcode: `${runtimePrefix}dsl4SourceFromYamlJson`,
      next: null,
      parent: `hat${suffix}`,
      inputs: {FRAGMENT: [1, [10, sourceText]]},
      fields: {},
      shadow: false,
      topLevel: false,
    },
  };
}

/**
 * @param {{stage?: Record<string, unknown> | null, sprites?: Record<string, Record<string, unknown>>}} targets
 */
function sb3Bytes({stage = declarationBlocks(standaloneSource), sprites = {}} = {}) {
  const project = {
    targets: [
      {isStage: true, name: 'Stage', variables: {}, lists: {}, broadcasts: {}, blocks: stage ?? {}},
      ...Object.entries(sprites).map(([name, blocks]) => ({
        isStage: false,
        name,
        variables: {},
        lists: {},
        broadcasts: {},
        blocks,
      })),
    ],
    monitors: [],
  };
  return Buffer.from(zipSync({'project.json': strToU8(`${JSON.stringify(project)}\n`)}));
}

/** @param {Buffer} bytes */
function unzipText(bytes) {
  return Object.fromEntries(
    Object.entries(unzipSync(new Uint8Array(bytes))).map(([entryName, contents]) => [
      entryName,
      strFromU8(contents),
    ]),
  );
}

/** @param {(directory: string) => Promise<void>} body */
async function withTemporaryDirectory(body) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'k4-block-export-'));
  try {
    await body(directory);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}

/** @param {string} directory @param {Buffer} bytes @param {string} [name] */
async function writeSb3(directory, bytes, name = 'urashima.sb3') {
  const inputPath = path.join(directory, name);
  await writeFile(inputPath, bytes);
  return inputPath;
}

/** @param {string} directory @param {Record<string, unknown>} [overrides] */
function exportOptions(directory, overrides = {}) {
  return {
    outputDir: path.join(directory, 'dist'),
    sourceFrontend: frontend,
    maxSourceBytes: 64 * 1024,
    maxTotalSourceBytes: 256 * 1024,
    ...overrides,
  };
}

test('exports one YAML file when the block story has no includes', async () => {
  await withTemporaryDirectory(async (directory) => {
    const input = await writeSb3(directory, sb3Bytes());
    const result = await exportDsl4BlockSourcesToYaml(exportOptions(directory, {input}));

    assert.equal(result.kind, 'single');
    assert.equal(result.name, 'urashima');
    assert.equal(path.basename(result.outputPath), 'urashima.k4.yml');
    assert.deepEqual(result.moduleFilenames, []);
    const written = await readFile(result.outputPath, 'utf8');
    assert.match(written, /^kamishibai: "4\.0"$/mu);
    assert.match(written, /^ {4}- stage: Cover$/mu);
  });
});

test('exports the root and every referenced module into one deterministic ZIP package', async () => {
  await withTemporaryDirectory(async (directory) => {
    const input = await writeSb3(
      directory,
      sb3Bytes({
        stage: declarationBlocks(rootSource),
        sprites: {turtle: declarationBlocks(turtleSource)},
      }),
    );
    const result = await exportDsl4BlockSourcesToYaml(exportOptions(directory, {input}));

    assert.equal(result.kind, 'package');
    assert.equal(path.basename(result.outputPath), 'urashima-k4.zip');
    assert.deepEqual(
      result.files.map((file) => file.path),
      ['urashima-k4/turtle.k4.yml', 'urashima-k4/urashima.k4.yml'],
    );
    const first = Buffer.from(await readFile(result.outputPath));
    const entries = unzipText(first);
    assert.deepEqual(Object.keys(entries).sort(), [
      'urashima-k4/turtle.k4.yml',
      'urashima-k4/urashima.k4.yml',
    ]);
    // The root keeps its include reference, so the package re-resolves as a Source Graph on disk.
    assert.match(entries['urashima-k4/urashima.k4.yml'], /^include: turtle\.k4\.yml$/mu);

    const second = await exportDsl4BlockSourcesToYaml(exportOptions(directory, {input}));
    assert.ok(first.equals(Buffer.from(await readFile(second.outputPath))));
  });
});

test('exported YAML revalidates as a Source Graph and matches the block story semantics', async () => {
  const blockSourceSet = {
    entryPath: 'Stage.k4.yml',
    sources: {'Stage.k4.yml': rootSource, 'turtle.k4.yml': turtleSource},
  };
  const graph = await createDsl4BlockSourceGraph(blockSourceSet, {
    maxSourceBytes: 64 * 1024,
    maxTotalSourceBytes: 256 * 1024,
  });
  const graphFrontend = createDsl4SourceGraphFrontend(frontend);
  const fromBlocks = graphFrontend.parse(graph, {
    featureFlags: {dsl4Runtime: true, dsl4SourceIncludes: true},
    sourceId: graph.entryPath,
    maxComposedSourceBytes: 256 * 1024,
  });
  assert.equal(fromBlocks.ok, true);

  const plan = planDsl4BlockSourceExport({blockSourceSet, sourceGraph: graph, name: 'urashima'});
  const exportedSources = Object.fromEntries(plan.files.map((file) => [file.filename, file.text]));
  const exportedGraph = await createDsl4BlockSourceGraph(
    {entryPath: plan.entryFilename, sources: exportedSources},
    {maxSourceBytes: 64 * 1024, maxTotalSourceBytes: 256 * 1024},
  );
  const fromYaml = graphFrontend.parse(exportedGraph, {
    featureFlags: {dsl4Runtime: true, dsl4SourceIncludes: true},
    sourceId: graph.entryPath,
    maxComposedSourceBytes: 256 * 1024,
  });
  assert.equal(fromYaml.ok, true);
  assert.equal(fromYaml.canonicalSource, fromBlocks.canonicalSource);
});

test('normalizes YAML rendered by YAML/JSON reporter blocks', async () => {
  const blocks = {
    hat: {
      opcode: `${runtimePrefix}whenDsl4Source`,
      next: 'command',
      parent: null,
      inputs: {},
      fields: {},
      shadow: false,
      topLevel: true,
    },
    command: {
      opcode: `${runtimePrefix}dsl4SourceFromYamlJson`,
      next: null,
      parent: 'hat',
      inputs: {FRAGMENT: [3, 'map', [10, '']]},
      fields: {},
      shadow: false,
      topLevel: false,
    },
    map: {
      opcode: `${yamlJsonPrefix}map`,
      next: null,
      parent: 'command',
      inputs: {ENTRIES: [3, 'version', [10, '']]},
      fields: {},
      shadow: false,
      topLevel: false,
    },
    version: {
      opcode: `${yamlJsonPrefix}pair`,
      next: null,
      parent: 'map',
      inputs: {KEY: [1, [10, 'kamishibai']], VALUE: [3, 'versionValue', [10, '']]},
      fields: {},
      shadow: false,
      topLevel: false,
    },
    versionValue: {
      opcode: `${yamlJsonPrefix}string`,
      next: null,
      parent: 'version',
      inputs: {VALUE: [1, [10, '4.0']]},
      fields: {},
      shadow: false,
      topLevel: false,
    },
  };
  // The block renderer double-quotes every scalar; the export serializer re-emits canonical YAML.
  assert.equal(serializeDsl4SourceYaml('kamishibai: "4.0"\n'), 'kamishibai: "4.0"\n');
  assert.equal(
    serializeDsl4SourceYaml('scenes:\n  opening:\n    - "goto": "a"\n'),
    'scenes:\n  opening:\n    - goto: a\n',
  );

  await withTemporaryDirectory(async (directory) => {
    const input = await writeSb3(directory, sb3Bytes({stage: blocks}), 'blocks.sb3');
    await assert.rejects(
      exportDsl4BlockSourcesToYaml(exportOptions(directory, {input})),
      (/** @type {Dsl4BlockSourceExportError} */ error) => {
        // The reporter tree only declares `kamishibai`, so schema validation rejects it.
        assert.equal(error instanceof Dsl4BlockSourceExportError, true);
        assert.equal(error.stage, 'dsl4-block-export-validate');
        assert.ok(error.diagnostics.length > 0);
        return true;
      },
    );
  });
});

test('fails when the Stage declares no root DSL source', async () => {
  await withTemporaryDirectory(async (directory) => {
    const input = await writeSb3(
      directory,
      sb3Bytes({stage: {}, sprites: {turtle: declarationBlocks(turtleSource)}}),
    );
    await assert.rejects(
      exportDsl4BlockSourcesToYaml(exportOptions(directory, {input})),
      (/** @type {Dsl4BlockSourceExportError} */ error) => {
        assert.equal(error.code, 'K4-BLOCK-SOURCE-MISSING-001');
        assert.equal(error.stage, 'dsl4-block-export-frontend');
        return true;
      },
    );
  });
});

test('fails when one target declares more than one DSL source hat', async () => {
  await withTemporaryDirectory(async (directory) => {
    const input = await writeSb3(
      directory,
      sb3Bytes({
        stage: {
          ...declarationBlocks(standaloneSource, 'A'),
          ...declarationBlocks(standaloneSource, 'B'),
        },
      }),
    );
    await assert.rejects(
      exportDsl4BlockSourcesToYaml(exportOptions(directory, {input})),
      (/** @type {Dsl4BlockSourceExportError} */ error) => {
        assert.equal(error.code, 'K4-BLOCK-SOURCE-DUPLICATE-001');
        return true;
      },
    );
  });
});

test('fails when two targets claim the same DSL source filename', async () => {
  await withTemporaryDirectory(async (directory) => {
    const input = await writeSb3(
      directory,
      sb3Bytes({
        stage: declarationBlocks(rootSource),
        sprites: {
          turtle: declarationBlocks(turtleSource),
          'turtle.k4.yml': declarationBlocks(turtleSource),
        },
      }),
    );
    await assert.rejects(
      exportDsl4BlockSourcesToYaml(exportOptions(directory, {input})),
      (/** @type {Dsl4BlockSourceExportError} */ error) => {
        assert.equal(error.code, 'K4-BLOCK-SOURCE-DUPLICATE-001');
        return true;
      },
    );
  });
});

test('fails when an include names a Sprite that declares no DSL source', async () => {
  await withTemporaryDirectory(async (directory) => {
    const input = await writeSb3(directory, sb3Bytes({stage: declarationBlocks(rootSource)}));
    await assert.rejects(
      exportDsl4BlockSourcesToYaml(exportOptions(directory, {input})),
      (/** @type {Dsl4BlockSourceExportError} */ error) => {
        assert.equal(error.code, 'K4-SOURCE-MISSING');
        assert.equal(error.stage, 'dsl4-block-export-graph');
        return true;
      },
    );
  });
});

test('fails on a cyclic include between Sprite modules', async () => {
  await withTemporaryDirectory(async (directory) => {
    const input = await writeSb3(
      directory,
      sb3Bytes({
        stage: declarationBlocks(rootSource),
        sprites: {
          turtle: declarationBlocks(`include: princess.k4.yml\n${turtleSource}`),
          princess: declarationBlocks('include: turtle.k4.yml\n'),
        },
      }),
    );
    await assert.rejects(
      exportDsl4BlockSourcesToYaml(exportOptions(directory, {input})),
      (/** @type {Dsl4BlockSourceExportError} */ error) => {
        assert.equal(error.code, 'K4-INCLUDE-CYCLE');
        assert.equal(error.stage, 'dsl4-block-export-graph');
        return true;
      },
    );
  });
});

test('fails with source-located diagnostics when a module breaks the schema', async () => {
  await withTemporaryDirectory(async (directory) => {
    const input = await writeSb3(
      directory,
      sb3Bytes({
        stage: declarationBlocks(rootSource),
        sprites: {turtle: declarationBlocks('scenes:\n  chapter1:\n    - notAnAction: 1\n')},
      }),
    );
    await assert.rejects(
      exportDsl4BlockSourcesToYaml(exportOptions(directory, {input})),
      (/** @type {Dsl4BlockSourceExportError} */ error) => {
        assert.equal(error.stage, 'dsl4-block-export-validate');
        assert.equal(
          error.diagnostics.some(
            (/** @type {Record<string, any>} */ diagnostic) =>
              diagnostic.sourceId === 'turtle.k4.yml',
          ),
          true,
        );
        return true;
      },
    );
  });
});

test('fails when the requested work name collides with a module filename', async () => {
  await withTemporaryDirectory(async (directory) => {
    const input = await writeSb3(
      directory,
      sb3Bytes({
        stage: declarationBlocks(rootSource),
        sprites: {turtle: declarationBlocks(turtleSource)},
      }),
    );
    await assert.rejects(
      exportDsl4BlockSourcesToYaml(exportOptions(directory, {input, name: 'turtle'})),
      (/** @type {Dsl4BlockSourceExportError} */ error) => {
        assert.equal(error.code, 'K4-BLOCK-EXPORT-COLLISION-001');
        return true;
      },
    );
  });
});

test('rejects a work name that cannot become a portable filename', async () => {
  await withTemporaryDirectory(async (directory) => {
    const input = await writeSb3(directory, sb3Bytes());
    for (const name of ['../escape', 'nul', '.hidden', 'has.dot', '']) {
      await assert.rejects(
        exportDsl4BlockSourcesToYaml(exportOptions(directory, {input, name})),
        (/** @type {Error & {code?: string}} */ error) => {
          assert.equal(error.code, 'K4-BLOCK-EXPORT-NAME-001');
          return true;
        },
        name,
      );
    }
  });
});

test('fails when a Sprite declares a DSL source that no include ever reaches', async () => {
  await withTemporaryDirectory(async (directory) => {
    const input = await writeSb3(
      directory,
      sb3Bytes({
        stage: declarationBlocks(rootSource),
        sprites: {
          turtle: declarationBlocks(turtleSource),
          orphan: declarationBlocks('scenes:\n  unused:\n    - goto: chapter1\n'),
        },
      }),
    );
    await assert.rejects(
      exportDsl4BlockSourcesToYaml(exportOptions(directory, {input})),
      (/** @type {Dsl4BlockSourceExportError} */ error) => {
        assert.equal(error.code, 'K4-BLOCK-EXPORT-UNREFERENCED-001');
        assert.equal(error.stage, 'dsl4-block-export-plan');
        assert.match(error.message, /"orphan\.k4\.yml"/u);
        return true;
      },
    );
    // The export is all-or-nothing: nothing is written when a declared module is unreachable.
    await assert.rejects(readFile(path.join(directory, 'dist', 'urashima-k4.zip')));
  });
});

test('names every unreachable module in one diagnostic', async () => {
  await withTemporaryDirectory(async (directory) => {
    const input = await writeSb3(
      directory,
      sb3Bytes({
        stage: declarationBlocks(rootSource),
        sprites: {
          turtle: declarationBlocks(turtleSource),
          zebra: declarationBlocks('scenes:\n  unusedZebra: []\n'),
          orphan: declarationBlocks('scenes:\n  unusedOrphan: []\n'),
        },
      }),
    );
    await assert.rejects(
      exportDsl4BlockSourcesToYaml(exportOptions(directory, {input})),
      (/** @type {Dsl4BlockSourceExportError} */ error) => {
        assert.equal(error.code, 'K4-BLOCK-EXPORT-UNREFERENCED-001');
        assert.match(error.message, /"orphan\.k4\.yml", "zebra\.k4\.yml"/u);
        return true;
      },
    );
  });
});

test('exports through the CLI and reports the written package', async () => {
  await withTemporaryDirectory(async (directory) => {
    const input = await writeSb3(
      directory,
      sb3Bytes({
        stage: declarationBlocks(rootSource),
        sprites: {turtle: declarationBlocks(turtleSource)},
      }),
    );
    const outputDirectory = path.join(directory, 'dist');
    /** @type {string[]} */
    const out = [];
    /** @type {string[]} */
    const errorOut = [];
    const result = await runCli(
      ['export-block-dsl', '--input', input, '--output-dir', outputDirectory],
      {
        stdout: {write: (chunk) => out.push(String(chunk))},
        stderr: {write: (chunk) => errorOut.push(String(chunk))},
      },
    );
    assert.equal(result.exitCode, 0);
    assert.equal(out.join('').includes('Exported urashima-k4.zip'), true);
    assert.equal(errorOut.join(''), '');
    const entries = unzipText(
      Buffer.from(await readFile(path.join(outputDirectory, 'urashima-k4.zip'))),
    );
    assert.deepEqual(Object.keys(entries).sort(), [
      'urashima-k4/turtle.k4.yml',
      'urashima-k4/urashima.k4.yml',
    ]);
  });
});

test('reports CLI failures as JSON diagnostics and exits non-zero', async () => {
  await withTemporaryDirectory(async (directory) => {
    const input = await writeSb3(directory, sb3Bytes({stage: declarationBlocks(rootSource)}));
    /** @type {string[]} */
    const out = [];
    await assert.rejects(
      runCli(
        [
          'export-block-dsl',
          '--input',
          input,
          '--output-dir',
          path.join(directory, 'dist'),
          '--format',
          'json',
        ],
        {stdout: {write: (chunk) => out.push(String(chunk))}, stderr: {write: () => true}},
      ),
      (/** @type {Error & {exitCode?: number, reported?: boolean}} */ error) => {
        assert.equal(error.exitCode, 1);
        assert.equal(error.reported, true);
        return true;
      },
    );
    const report = JSON.parse(out.join(''));
    assert.equal(report.ok, false);
    assert.equal(report.code, 'K4-SOURCE-MISSING');
  });
});
