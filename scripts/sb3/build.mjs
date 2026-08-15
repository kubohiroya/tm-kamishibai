import process from 'node:process';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

import {buildSb3, createDeterministicSb3} from '@kubohiroya/sb3-toolchain';

import {withTitleBuildMetadataSource} from './title-build-metadata.mjs';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
export const defaultKamishibaiPackageJsonPath = path.join(projectRoot, 'package.json');
export const defaultKamishibaiFaviconPath = path.join(projectRoot, 'site', 'favicon.png');
export const defaultKamishibaiOutputPath = path.join(projectRoot, 'tmp', 'kamishibai.sb3');

function titleSourceOptions(options) {
  return {
    buildDate: options.buildDate,
    environment: options.environment ?? process.env,
    faviconPath: options.faviconPath ?? defaultKamishibaiFaviconPath,
    now: options.now ?? new Date(),
    packageJsonPath: options.packageJsonPath ?? defaultKamishibaiPackageJsonPath,
    sourceDirectory: options.sourceDirectory,
    version: options.version,
  };
}

export async function createKamishibaiSb3(options = {}) {
  const create = options.create ?? createDeterministicSb3;
  return withTitleBuildMetadataSource(
    titleSourceOptions(options),
    async ({metadata, sourceDirectory}) => ({
      ...(await create(sourceDirectory)),
      titleBuildMetadata: metadata,
    }),
  );
}

export async function buildKamishibaiSb3(options = {}) {
  const build = options.build ?? buildSb3;
  const outputPath = options.outputPath ?? defaultKamishibaiOutputPath;
  return withTitleBuildMetadataSource(
    titleSourceOptions(options),
    async ({metadata, sourceDirectory}) => ({
      ...(await build({
        confirmReplace: options.confirmReplace,
        outputPath,
        sourceDirectory,
        yes: options.yes ?? false,
      })),
      titleBuildMetadata: metadata,
    }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.error('Use pnpm release:dsl4:update to create the transient current release artifact.');
  process.exitCode = 1;
}
