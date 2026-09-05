#!/usr/bin/env node

// Official entrypoint for exporting the block-authored DSL 4.0 script inside an SB3 as YAML.
// It forwards to the published `tm-kamishibai export-block-dsl` command so repository scripts and
// downstream sample CI share one implementation and one diagnostic contract.

import {runCli, usage} from '../src/builder/cli.js';

runCli(['export-block-dsl', ...process.argv.slice(2)])
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
