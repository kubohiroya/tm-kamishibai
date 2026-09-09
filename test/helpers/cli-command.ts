import assert from 'node:assert/strict';

import type {parseCliArguments, runCli} from '../../src/builder/cli.js';

import {requireDefined, requireRecord} from './require-value.ts';

/**
 * Readers for the two CLI seams every command suite crosses.
 *
 * `parseCliArguments` returns one discriminated union over every command, and `runCli` returns the
 * union of what those commands produce. A suite knows which command it ran; the compiler does not.
 * Narrowing that once here is what keeps the individual cases free of casts -- and `parsedCommand`
 * asserts the action it narrows to, so a suite that names the wrong command fails on the action
 * rather than on a missing option later.
 */

type ParsedCliCommand = ReturnType<typeof parseCliArguments>;
type CommandWithOptions = Extract<ParsedCliCommand, {options: unknown}>;
type CliDependencies = NonNullable<Parameters<typeof runCli>[2]>;

/** The options one parsed command carries, chosen by its action. */
type OptionsFor<A extends CommandWithOptions['action'], C = CommandWithOptions> = C extends {
  action: A;
  options: infer O;
}
  ? O
  : never;

/**
 * Read a set of partial dependency doubles as the dependencies `runCli` declares.
 *
 * Each dependency is typed as the real function, so a double would have to rebuild a whole lock or
 * config document to satisfy it. These suites assert on what the command does with the result --
 * the path it prints, the count it reports -- so the doubles return only that, and this reader is
 * the one place that says so.
 */
export function cliDoubles(
  doubles: Partial<Record<keyof CliDependencies, (options: unknown) => Promise<unknown>>>,
): CliDependencies {
  return doubles as CliDependencies;
}

/** Read one parsed command as the action the case says it is. */
export function parsedCommand<A extends ParsedCliCommand['action']>(
  parsed: ParsedCliCommand,
  action: A,
): Extract<ParsedCliCommand, {action: A}> {
  assert.equal(parsed.action, action, `expected the parsed command to be ${action}`);
  return parsed as Extract<ParsedCliCommand, {action: A}>;
}

/** Read the options one parsed command carries. */
export function parsedOptions<A extends CommandWithOptions['action']>(
  parsed: ParsedCliCommand,
  action: A,
): OptionsFor<A> {
  return (parsedCommand(parsed, action) as {options: OptionsFor<A>}).options;
}

/**
 * Collect what a command wrote to one stream.
 *
 * `write` returns a boolean in Node's contract -- the back-pressure signal -- so a stub that hands
 * back the accumulated string does not satisfy it. Every CLI suite needs the same two lines.
 */
export function captureWrites() {
  let text = '';
  return {
    write(chunk: string) {
      text += chunk;
      return true;
    },
    get text() {
      return text;
    },
  };
}

/**
 * Read what `runCli` returned as a record.
 *
 * The return is `null` for the commands that only print, so a case reading a member is asserting
 * that its command produced one. The members stay `unknown`: `assert.equal` takes them as they are,
 * and the readers in `require-value.ts` say what a case expects when it needs more.
 */
export function cliResult(result: unknown, description: string): Record<string, unknown> {
  return requireRecord(requireDefined(result, description), description);
}
