#!/usr/bin/env node

import {runCli, usage} from '../src/builder/cli.js';

runCli(process.argv.slice(2)).catch((error) => {
  const reported = error && typeof error === 'object' && 'reported' in error && error.reported;
  if (!reported) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(`\n${usage()}`);
  }
  process.exitCode = 1;
});
