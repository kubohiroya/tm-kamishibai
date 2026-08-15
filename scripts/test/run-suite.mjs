import {readdir} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const testDirectory = path.join(projectRoot, 'test');
const fullOnlyTests = new Set(['builder.test.mjs']);

const run = (command, arguments_) => {
  const result = spawnSync(command, arguments_, {
    cwd: projectRoot,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`${command} terminated by ${result.signal}`);
  return result.status ?? 1;
};

const suite = process.argv[2];
if (suite !== 'quick' && suite !== 'full') {
  console.error('Usage: node scripts/test/run-suite.mjs <quick|full>');
  process.exitCode = 2;
} else {
  try {
    const testFiles = (await readdir(testDirectory))
      .filter((fileName) => fileName.endsWith('.test.mjs'))
      .sort();
    const missingFullOnlyTests = [...fullOnlyTests].filter(
      (fileName) => !testFiles.includes(fileName),
    );
    if (missingFullOnlyTests.length > 0) {
      throw new Error(`Missing Full-only test files: ${missingFullOnlyTests.join(', ')}`);
    }

    const selectedTests =
      suite === 'full' ? testFiles : testFiles.filter((fileName) => !fullOnlyTests.has(fileName));

    if (process.exitCode === undefined) {
      process.exitCode = run(process.execPath, [
        '--test',
        ...selectedTests.map((fileName) => path.join('test', fileName)),
      ]);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
