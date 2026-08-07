import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp, readFile, rm, symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath, pathToFileURL} from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: options.cwd ?? projectRoot,
    encoding: 'utf8',
    env: options.env ?? process.env,
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`${command} terminated by ${result.signal}`);
  if (result.status !== 0) {
    throw new Error(
      `${command} ${arguments_.join(' ')} failed with status ${result.status}\n${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout;
}

const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'tmpose-kamishibai-pack-'));
try {
  const packResult = JSON.parse(
    run(
      'npm',
      [
        'pack',
        '--ignore-scripts',
        '--dry-run=false',
        '--json',
        '--pack-destination',
        temporaryDirectory,
      ],
      {
        env: {...process.env, npm_config_dry_run: 'false'},
      },
    ),
  )[0];
  assert(packResult?.filename, 'npm pack did not return a package filename');

  const packedPaths = new Set(packResult.files.map(({path: filePath}) => filePath));
  for (const requiredPath of [
    'bin/tmpose-kamishibai.mjs',
    'schema/dsl-4.schema.json',
    'src/builder/index.js',
    'src/dsl4/index.js',
    'src/dsl4/object-store/index.js',
    'src/dsl4/platform/standard-app-shell.js',
    'src/dsl4/platform/turbowarp-preview-session.js',
    'src/dsl4/platform/turbowarp-runtime-host.js',
  ]) {
    assert(packedPaths.has(requiredPath), `npm package is missing ${requiredPath}`);
  }

  const archivePath = path.join(temporaryDirectory, packResult.filename);
  run('tar', ['-xzf', archivePath, '-C', temporaryDirectory]);
  const packageDirectory = path.join(temporaryDirectory, 'package');
  await symlink(
    path.join(projectRoot, 'node_modules'),
    path.join(packageDirectory, 'node_modules'),
    'dir',
  );

  const packageJson = JSON.parse(
    await readFile(path.join(packageDirectory, 'package.json'), 'utf8'),
  );
  const dsl4 = await import(pathToFileURL(path.join(packageDirectory, 'src/dsl4/index.js')).href);
  const builder = await import(
    pathToFileURL(path.join(packageDirectory, 'src/builder/index.js')).href
  );
  assert.equal(typeof dsl4.createDsl4SourceFrontend, 'function');
  assert.equal(typeof dsl4.createDsl4InputArbitration, 'function');
  assert.equal(typeof builder.createDsl4ProductionSourceFrontend, 'function');
  assert.equal(typeof builder.runDsl4LocalPreviewCommand, 'function');

  const cliVersion = run(process.execPath, ['bin/tmpose-kamishibai.mjs', '--version'], {
    cwd: packageDirectory,
  }).trim();
  assert.equal(cliVersion, packageJson.version);
  process.stdout.write(
    `Verified npm package ${packageJson.name}@${packageJson.version} (${packResult.files.length} files).\n`,
  );
} finally {
  await rm(temporaryDirectory, {force: true, recursive: true});
}
