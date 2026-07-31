import path from 'node:path';
import process from 'node:process';
import {fileURLToPath, pathToFileURL} from 'node:url';

import {buildKamishibaiSb3} from './build.mjs';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const defaultSourceDirectory = path.join(projectRoot, 'app');
const defaultOutputPath = path.join(projectRoot, 'tmp', 'kamishibai.sb3');

export async function prepareTestSb3({build = buildKamishibaiSb3, environment = process.env} = {}) {
  if (environment.KAMISHIBAI_SB3_PATH) {
    return {
      configured: true,
      outputPath: environment.KAMISHIBAI_SB3_PATH,
    };
  }
  return {
    ...(await build({
      environment,
      outputPath: defaultOutputPath,
      sourceDirectory: defaultSourceDirectory,
      yes: true,
    })),
    configured: false,
  };
}

async function main() {
  const result = await prepareTestSb3();
  if (result.configured) {
    console.log(`Using configured SB3 for tests: ${result.outputPath}`);
    return;
  }
  const action = result.changed ? 'Built test SB3' : 'Test SB3 already up to date';
  console.log(`${action}: ${result.outputPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
