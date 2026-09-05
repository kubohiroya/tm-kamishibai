import {randomUUID} from 'node:crypto';
import {lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';

import {Sb3BuilderError} from './errors.js';
import {sha256} from './hash.js';

async function inspectFile(targetPath: string) {
  try {
    const stats = await lstat(targetPath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Sb3BuilderError(`Refusing to replace a non-file or symbolic link: ${targetPath}`, {
        stage: 'commit-output',
      });
    }
    const contents = await readFile(targetPath);
    return {exists: true, sha256: sha256(contents)};
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return {exists: false, sha256: null};
    }
    throw error;
  }
}

async function assertNoInterruptedTransaction(outputDirectory: string, outputName: string) {
  const prefix = `.${outputName}.rollback-`;
  const leftovers = (await readdir(outputDirectory)).filter((entry) => entry.startsWith(prefix));
  if (leftovers.length > 0) {
    throw new Sb3BuilderError(
      `Found an interrupted bundle transaction. Inspect or restore it before retrying: ${leftovers.join(', ')}`,
      {stage: 'commit-output'},
    );
  }
}

export async function installBundleTransactionally(options: {
  outputDirectory: string;
  outputName: string;
  files: Map<string, Buffer>;
  validateCandidate: (candidateDirectory: string) => Promise<void>;
  renameFile?: typeof rename;
}) {
  const outputDirectory = path.resolve(options.outputDirectory);
  if (
    outputDirectory === path.parse(outputDirectory).root ||
    outputDirectory.split(path.sep).includes('.git')
  ) {
    throw new Sb3BuilderError(`Unsafe output directory: ${outputDirectory}`, {
      stage: 'commit-output',
    });
  }
  await mkdir(outputDirectory, {recursive: true});
  const directoryStats = await lstat(outputDirectory);
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    throw new Sb3BuilderError(`Output path is not a regular directory: ${outputDirectory}`, {
      stage: 'commit-output',
    });
  }
  await assertNoInterruptedTransaction(outputDirectory, options.outputName);
  const filenames = [...options.files.keys()];
  const snapshots = new Map(
    await Promise.all(
      filenames.map(
        async (filename) =>
          [filename, await inspectFile(path.join(outputDirectory, filename))] as const,
      ),
    ),
  );
  const candidateDirectory = await mkdtemp(
    path.join(outputDirectory, `.${options.outputName}.build-`),
  );
  const rollbackDirectory = path.join(
    outputDirectory,
    `.${options.outputName}.rollback-${randomUUID()}`,
  );
  const renameFile = options.renameFile ?? rename;
  try {
    await Promise.all(
      [...options.files].map(([filename, contents]) =>
        writeFile(path.join(candidateDirectory, filename), contents),
      ),
    );
    await options.validateCandidate(candidateDirectory);
    for (const filename of filenames) {
      const current = await inspectFile(path.join(outputDirectory, filename));
      const expected = snapshots.get(filename);
      if (current.exists !== expected?.exists || current.sha256 !== expected.sha256) {
        throw new Sb3BuilderError(`Output changed during the build: ${filename}`, {
          stage: 'commit-output',
        });
      }
    }
    await mkdir(rollbackDirectory);
    const installed = [];
    const backedUp = [];
    try {
      for (const filename of filenames) {
        if (snapshots.get(filename)?.exists) {
          await renameFile(
            path.join(outputDirectory, filename),
            path.join(rollbackDirectory, filename),
          );
          backedUp.push(filename);
        }
      }
      for (const filename of filenames) {
        await renameFile(
          path.join(candidateDirectory, filename),
          path.join(outputDirectory, filename),
        );
        installed.push(filename);
      }
    } catch (installError) {
      const restoreErrors = [];
      for (const filename of installed.reverse()) {
        try {
          await rm(path.join(outputDirectory, filename), {force: true});
        } catch (error) {
          restoreErrors.push(error);
        }
      }
      for (const filename of backedUp.reverse()) {
        try {
          await rename(
            path.join(rollbackDirectory, filename),
            path.join(outputDirectory, filename),
          );
        } catch (error) {
          restoreErrors.push(error);
        }
      }
      if (restoreErrors.length > 0) {
        throw new AggregateError(
          [installError, ...restoreErrors],
          `Bundle installation and automatic restoration failed. Original files may remain in ${rollbackDirectory}`,
        );
      }
      await rm(rollbackDirectory, {recursive: true, force: true});
      throw installError;
    }
    await rm(rollbackDirectory, {recursive: true});
  } finally {
    await rm(candidateDirectory, {recursive: true, force: true});
  }
  return Object.fromEntries(
    filenames.map((filename) => [filename, path.join(outputDirectory, filename)]),
  );
}
