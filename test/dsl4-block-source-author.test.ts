import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'vitest';

import {strFromU8, strToU8, unzipSync, zipSync} from 'fflate';
import {parse} from 'yaml';

import {authorDsl4BlockSourceSb3} from '../src/builder/dsl4-block-source-author.js';
import {parseCliArguments, runCli} from '../src/builder/cli.js';
import {
  dsl4BlockSourceOpcodes,
  extractDsl4BlockSourcesFromProject,
  targetNameForSourcePath,
} from '../src/dsl4/turbowarp-yaml-json-block-source.js';
import {dsl4TestSourceFrontend} from './helpers/dsl4-test-frontend.ts';
import {captureWrites, cliResult, parsedOptions} from './helpers/cli-command.ts';
import {requireRecord} from './helpers/require-value.ts';

const frontend = dsl4TestSourceFrontend;
const validSource = "kamishibai: '4.0'\nscenes:\n  opening:\n    - wait: 0\n";

/** A base project shaped like a release base: one Stage, loading the bundled runtime. */
function baseBytes({
  extensions = ['kubohiroyakamishibai4'],
  blocks = {},
}: {extensions?: string[]; blocks?: Record<string, unknown>} = {}) {
  const project = {
    targets: [{isStage: true, name: 'Stage', variables: {}, lists: {}, broadcasts: {}, blocks}],
    monitors: [],
    extensions,
  };
  return new Uint8Array(
    zipSync(
      {'project.json': strToU8(`${JSON.stringify(project)}\n`), 'assets/keep.txt': strToU8('keep')},
      {level: 6},
    ),
  );
}

function projectOf(bytes: Uint8Array) {
  const archive = unzipSync(bytes);
  return JSON.parse(strFromU8(archive['project.json'] as Uint8Array)) as Record<string, unknown>;
}

test('writes a declaration the reader takes back as the same source, deterministically', () => {
  const first = authorDsl4BlockSourceSb3({
    baseBytes: baseBytes(),
    sourceText: validSource,
    sourceFrontend: frontend,
  });
  const second = authorDsl4BlockSourceSb3({
    baseBytes: baseBytes(),
    sourceText: validSource,
    sourceFrontend: frontend,
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;

  // 同じ入力から同じバイト列。samples は hash を固定して配布するため、ここが要件。
  assert.equal(Buffer.compare(first.bytes, second.bytes), 0);
  assert.equal(first.sourcePath, 'Stage.k4.yml');
  assert.equal(targetNameForSourcePath(first.sourcePath), 'Stage');

  const readBack = extractDsl4BlockSourcesFromProject(projectOf(new Uint8Array(first.bytes)));
  assert.equal(readBack.entryPath, 'Stage.k4.yml');
  assert.deepEqual(parse(readBack.sources['Stage.k4.yml']!), parse(validSource));

  // 既存のエントリは残る。オーサリング用途でもアセットを失わない。
  assert.equal(strFromU8(unzipSync(new Uint8Array(first.bytes))['assets/keep.txt']!), 'keep');
});

test('names the blocks for the extension the base loads', () => {
  const bundled = authorDsl4BlockSourceSb3({
    baseBytes: baseBytes(),
    sourceText: validSource,
    sourceFrontend: frontend,
  });
  const standalone = authorDsl4BlockSourceSb3({
    baseBytes: baseBytes({extensions: ['kubohiroyakamishibairuntime4']}),
    sourceText: validSource,
    sourceFrontend: frontend,
  });
  assert.equal(bundled.ok, true);
  assert.equal(standalone.ok, true);
  if (!bundled.ok || !standalone.ok) return;
  assert.equal(bundled.opcodeForm, 'bundle');
  assert.equal(standalone.opcodeForm, 'runtime');

  const opcodes = Object.values(
    requireRecord(
      requireRecord(
        (projectOf(new Uint8Array(bundled.bytes)).targets as Record<string, unknown>[])[0],
        'the Stage',
      ).blocks,
      'the Stage blocks',
    ),
  ).map((block) => requireRecord(block, 'a block').opcode);
  assert.ok(opcodes.includes(dsl4BlockSourceOpcodes('bundle').hat));
  assert.ok(opcodes.includes('kubohiroyakamishibai4_kubohiroyakamishibairuntime4__wait'));
  assert.ok(!opcodes.includes(dsl4BlockSourceOpcodes('bundle').command));
});

test('refuses an invalid story, a base without the runtime, an existing declaration, and includes', () => {
  const invalid = authorDsl4BlockSourceSb3({
    baseBytes: baseBytes(),
    sourceText: 'kamishibai: 4.0\nscenes:\n  opening: []\n',
    sourceFrontend: frontend,
  });
  assert.equal(invalid.ok, false);

  assert.throws(
    () =>
      authorDsl4BlockSourceSb3({
        baseBytes: baseBytes({extensions: []}),
        sourceText: validSource,
        sourceFrontend: frontend,
      }),
    /must load/u,
  );
  assert.throws(
    () =>
      authorDsl4BlockSourceSb3({
        baseBytes: baseBytes({
          blocks: {
            existing: {
              opcode: 'kubohiroyakamishibai4_kubohiroyakamishibairuntime4__whenDsl4Source',
              next: null,
              parent: null,
              inputs: {},
              fields: {},
              shadow: false,
              topLevel: true,
            },
          },
        }),
        sourceText: validSource,
        sourceFrontend: frontend,
      }),
    /already declares a DSL source/u,
  );
  assert.throws(
    () =>
      authorDsl4BlockSourceSb3({
        baseBytes: baseBytes(),
        sourceText: `include: other.k4.yml\n${validSource}`,
        sourceFrontend: frontend,
      }),
    /includes is not supported yet/u,
  );
});

test('authors through the CLI and leaves no file behind for an invalid story', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsl4-author-'));
  try {
    const basePath = path.join(directory, 'base.sb3');
    const sourcePath = path.join(directory, 'story.kamishibai.yaml');
    const outputPath = path.join(directory, 'blocks.sb3');
    await writeFile(basePath, baseBytes());
    await writeFile(sourcePath, validSource);

    const stdout = captureWrites();
    const stderr = captureWrites();
    const result = cliResult(
      await runCli(
        ['author-block-dsl', '--input', sourcePath, '--base', basePath, '--output', outputPath],
        {stdout, stderr},
      ),
      'the author result',
    );
    assert.equal(result.exitCode, 0);
    assert.match(stdout.text, /Stage\.k4\.yml/u);
    assert.equal(stderr.text, '');
    const written = await readFile(outputPath);
    assert.deepEqual(
      parse(
        extractDsl4BlockSourcesFromProject(projectOf(new Uint8Array(written))).sources[
          'Stage.k4.yml'
        ]!,
      ),
      parse(validSource),
    );

    const invalidSourcePath = path.join(directory, 'invalid.kamishibai.yaml');
    const invalidOutputPath = path.join(directory, 'invalid.sb3');
    await writeFile(invalidSourcePath, 'kamishibai: 4.0\nscenes:\n  opening: []\n');
    const invalidStdout = captureWrites();
    const invalidStderr = captureWrites();
    const invalidResult = cliResult(
      await runCli(
        [
          'author-block-dsl',
          '--input',
          invalidSourcePath,
          '--base',
          basePath,
          '--output',
          invalidOutputPath,
        ],
        {stdout: invalidStdout, stderr: invalidStderr},
      ),
      'the author result',
    );
    assert.equal(invalidResult.exitCode, 1);
    assert.equal(invalidStdout.text, '');
    assert.match(invalidStderr.text, /K4-VERSION-001/u);
    await assert.rejects(readFile(invalidOutputPath));

    assert.equal(
      parsedOptions(
        parseCliArguments([
          'author-block-dsl',
          '--input',
          sourcePath,
          '--base',
          basePath,
          '--output',
          outputPath,
        ]),
        'author-block-dsl',
      ).output,
      outputPath,
    );
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
