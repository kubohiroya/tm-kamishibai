import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'vitest';

import {dsl4CliDefaultLimits, parseCliArguments, runCli, usage} from '../src/builder/cli.js';
import {Dsl4ValidationInternalError, validateDsl4SourceFile} from '../src/builder/dsl4-validate.js';
import {dsl4TestProjectRoot, dsl4TestSourceFrontend} from './helpers/dsl4-test-frontend.ts';
import {captureWrites, cliResult, parsedOptions} from './helpers/cli-command.ts';
import {requireArray, requireRecord} from './helpers/require-value.ts';

/** The three paths every fixture case works with. */
interface ValidateFixture {
  directory: string;
  invalidPath: string;
  validPath: string;
}

const repositoryRoot = dsl4TestProjectRoot;
const binPath = path.join(repositoryRoot, 'bin', 'tm-kamishibai.mjs');
const frontend = dsl4TestSourceFrontend;
const validSource = "kamishibai: '4.0'\nscenes:\n  opening:\n    - wait: 0\n";

async function withFixture<T>(callback: (fixture: ValidateFixture) => Promise<T> | T): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsl4-validate-'));
  try {
    const validPath = path.join(directory, 'valid.kamishibai.yaml');
    const invalidPath = path.join(directory, 'invalid.kamishibai.yaml');
    await writeFile(validPath, validSource);
    await writeFile(invalidPath, 'kamishibai: 4.0\nscenes:\n  opening: []\n');
    return await callback({directory, invalidPath, validPath});
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}

function argumentsFor(input: string, format = 'pretty', maxSourceBytes = 4096) {
  return [
    'validate-dsl4',
    '--input',
    input,
    '--max-source-bytes',
    String(maxSourceBytes),
    '--format',
    format,
  ];
}

/**
 * A source frontend that reports success without producing a document.
 *
 * The case below proves the validator treats that as an internal failure rather than reading past
 * it, so the double cannot satisfy the frontend's result type -- refusing it is the behaviour under
 * test. Declaring it here keeps the case itself free of a cast.
 */
const incompleteSourceFrontend = {parse: () => ({ok: true})} as unknown as typeof frontend;

/** Read the code of the first diagnostic in one validation envelope. */
function firstDiagnosticCode(envelope: unknown) {
  const diagnostics = requireArray(
    requireRecord(envelope, 'the validation envelope').diagnostics,
    'diagnostics',
  );
  return requireRecord(diagnostics[0], 'the first diagnostic').code;
}

function capture() {
  const stdout = captureWrites();
  const stderr = captureWrites();
  return {
    io: {stdout, stderr},
    output: () => ({stderr: stderr.text, stdout: stdout.text}),
  };
}

test('parses the default and explicitly bounded one-shot validation commands', () => {
  const parsed = parsedOptions(
    parseCliArguments(argumentsFor('story.kamishibai.yaml')),
    'validate-dsl4',
  );
  assert.equal(parsed.format, 'pretty');
  assert.equal(parsed.maxSourceBytes, 4096);
  assert.match(usage(), /validate-dsl4/u);
  assert.throws(
    () => parseCliArguments(argumentsFor('story.kamishibai.yaml', 'xml')),
    /pretty or json/u,
  );
  assert.equal(
    parsedOptions(
      parseCliArguments(['validate-dsl4', '--input', 'story.kamishibai.yaml']),
      'validate-dsl4',
    ).maxSourceBytes,
    dsl4CliDefaultLimits.maxSourceBytes,
  );
  assert.throws(
    () =>
      parseCliArguments(
        argumentsFor('story.kamishibai.yaml', 'pretty', dsl4CliDefaultLimits.maxSourceBytes + 1),
      ),
    /max-source-bytes must be <= 1048576/u,
  );
});

test('prints pretty diagnostics at canonical source positions without source text or absolute paths', async () => {
  await withFixture(async ({directory, invalidPath, validPath}) => {
    const validCapture = capture();
    const valid = cliResult(
      await runCli(argumentsFor(validPath), validCapture.io),
      'the validation result',
    );
    assert.equal(valid.ok, true);
    assert.equal(valid.exitCode, 0);
    assert.deepEqual(validCapture.output(), {stderr: '', stdout: 'valid.kamishibai.yaml: valid\n'});

    const invalidCapture = capture();
    const invalid = cliResult(
      await runCli(argumentsFor(invalidPath), invalidCapture.io),
      'the validation result',
    );
    assert.equal(invalid.ok, false);
    assert.equal(invalid.exitCode, 1);
    const output = invalidCapture.output();
    assert.equal(output.stdout, '');
    assert.match(output.stderr, /^invalid\.kamishibai\.yaml:1:/u);
    assert.match(output.stderr, /error \[K4-VERSION-001\]/u);
    assert.equal(output.stderr.includes(directory), false);
    assert.equal(output.stderr.includes('kamishibai: 4.0'), false);
  });
});

test('prints a machine-readable envelope without serializing canonical source or AST', async () => {
  await withFixture(async ({directory, invalidPath}) => {
    const captured = capture();
    const result = cliResult(
      await runCli(argumentsFor(invalidPath, 'json'), captured.io),
      'the validation result',
    );
    assert.equal(result.exitCode, 1);
    assert.equal(captured.output().stderr, '');
    const output = JSON.parse(captured.output().stdout);
    assert.deepEqual(Object.keys(output), [
      'version',
      'ok',
      'sourceId',
      'byteLength',
      'diagnostics',
    ]);
    assert.equal(output.ok, false);
    assert.equal(output.sourceId, 'main');
    assert.equal(firstDiagnosticCode(output), 'K4-VERSION-001');
    assert.equal(captured.output().stdout.includes(directory), false);
    assert.equal(Object.hasOwn(output, 'canonicalSource'), false);
    assert.equal(Object.hasOwn(output, 'storyDocument'), false);
  });
});

test('maps missing, invalid UTF-8, and canonical byte overflow to stable source diagnostics', async () => {
  await withFixture(async ({directory, validPath}) => {
    const missing = await validateDsl4SourceFile({
      input: path.join(directory, 'missing.kamishibai.yaml'),
      sourceFrontend: frontend,
      maxSourceBytes: 4096,
    });
    assert.equal(firstDiagnosticCode(missing), 'K4-SOURCE-MISSING');

    const invalidUtf8Path = path.join(directory, 'invalid-utf8.kamishibai.yaml');
    await writeFile(invalidUtf8Path, Uint8Array.from([0xc3, 0x28]));
    const invalidUtf8 = await validateDsl4SourceFile({
      input: invalidUtf8Path,
      sourceFrontend: frontend,
      maxSourceBytes: 4096,
    });
    assert.equal(firstDiagnosticCode(invalidUtf8), 'K4-SOURCE-UTF8-001');

    const oversized = await validateDsl4SourceFile({
      input: validPath,
      sourceFrontend: frontend,
      maxSourceBytes: 8,
    });
    assert.equal(firstDiagnosticCode(oversized), 'K4-SOURCE-TOO-LARGE');
  });
});

test('uses exit codes 0 for valid, 1 for source errors, and 2 for usage or internal failures', async () => {
  await withFixture(async ({directory, invalidPath, validPath}) => {
    const valid = spawnSync(process.execPath, [binPath, ...argumentsFor(validPath)], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
    assert.equal(valid.status, 0, valid.stderr);

    const invalid = spawnSync(process.execPath, [binPath, ...argumentsFor(invalidPath, 'json')], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
    assert.equal(invalid.status, 1, invalid.stderr);
    assert.equal(firstDiagnosticCode(JSON.parse(invalid.stdout)), 'K4-VERSION-001');

    const usageFailure = spawnSync(
      process.execPath,
      [binPath, ...argumentsFor(validPath, 'unsupported')],
      {cwd: repositoryRoot, encoding: 'utf8'},
    );
    assert.equal(usageFailure.status, 2, usageFailure.stderr);

    const internal = spawnSync(process.execPath, [binPath, ...argumentsFor(directory)], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
    assert.equal(internal.status, 2, internal.stderr);
    assert.equal(internal.stderr.includes(directory), false);

    await assert.rejects(
      validateDsl4SourceFile({
        input: directory,
        sourceFrontend: frontend,
        maxSourceBytes: 4096,
      }),
      (error) => error instanceof Dsl4ValidationInternalError && error.exitCode === 2,
    );

    await assert.rejects(
      validateDsl4SourceFile({
        input: validPath,
        sourceFrontend: incompleteSourceFrontend,
        maxSourceBytes: 4096,
      }),
      (error) => error instanceof Dsl4ValidationInternalError && error.exitCode === 2,
    );
  });
});
