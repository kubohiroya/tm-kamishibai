#!/usr/bin/env node

import {runCli, usage} from '../dist/builder/cli.js';

runCli(process.argv.slice(2))
  .then((result) => {
    if (result && typeof result === 'object' && 'exitCode' in result) {
      process.exitCode = Number(result.exitCode);
    }
  })
  .catch((error) => {
    const reported = error && typeof error === 'object' && 'reported' in error && error.reported;
    if (!reported) {
      console.error(error instanceof Error ? error.message : String(error));
      console.error(`\n${usage()}`);
    }
    const explicitExitCode =
      error && typeof error === 'object' && 'exitCode' in error ? Number(error.exitCode) : null;
    const usageExitCode =
      error && typeof error === 'object' && 'stage' in error && error.stage === 'cli' ? 2 : 1;
    process.exitCode = Number.isInteger(explicitExitCode) ? explicitExitCode : usageExitCode;
  });
