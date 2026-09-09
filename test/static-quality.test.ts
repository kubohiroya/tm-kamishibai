import assert from 'node:assert/strict';
import {readdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {test} from 'vitest';

import {ESLint} from 'eslint';

import {requireDefined} from './helpers/require-value.ts';

const projectRoot = new URL('../', import.meta.url);
const expectedRules = ['eqeqeq', 'no-undef', 'no-unused-vars'];
// TypeScript reports undefined and unused identifiers through the compiler and its own ESLint rule.
const expectedTypeScriptRules = ['eqeqeq', '@typescript-eslint/no-unused-vars'];
const firstPartyFiles = [
  'bin/tm-kamishibai.mjs',
  'eslint.config.mjs',
  'site/site-shell.js',
  'src/builder/index.js',
];
const firstPartyTypeScriptFiles = [
  'scripts/build-site.ts',
  'scripts/download-catalog.ts',
  'scripts/sb3/downloadable-releases.ts',
  'src/builder/hash.ts',
  'src/dsl4/story-path.ts',
  'test/dsl4-runtime-error-indicator.test.ts',
  'test/dsl4-turbowarp-runtime-host.test.ts',
  'vitest.config.ts',
];

test('applies static quality rules to every first-party code area', async () => {
  const eslint = new ESLint({cwd: new URL('.', projectRoot).pathname});
  for (const filename of firstPartyFiles) {
    const config = await eslint.calculateConfigForFile(filename);
    for (const rule of expectedRules) {
      assert.equal(config.rules[rule][0], 2, `${rule} is not enabled for ${filename}`);
    }
  }
});

test('applies static quality rules to first-party TypeScript', async () => {
  const eslint = new ESLint({cwd: new URL('.', projectRoot).pathname});
  for (const filename of firstPartyTypeScriptFiles) {
    assert.equal(await eslint.isPathIgnored(filename), false, `${filename} is ignored`);
    const config = await eslint.calculateConfigForFile(filename);
    for (const rule of expectedTypeScriptRules) {
      assert.equal(config.rules[rule][0], 2, `${rule} is not enabled for ${filename}`);
    }
  }
});

test('does not ignore current release workflow sources', async () => {
  const eslint = new ESLint({cwd: new URL('.', projectRoot).pathname});
  assert.equal(await eslint.isPathIgnored('scripts/sb3/downloadable-releases.ts'), false);
  assert.equal(await eslint.isPathIgnored('scripts/sb3/dsl4-release-workflow.ts'), false);
  assert.equal(await eslint.isPathIgnored('scripts/sb3/dsl4-release-policy.ts'), false);
});

/**
 * The JavaScript `tsconfig.json` type-checks through `allowJs` and `checkJs`.
 *
 * `@typescript-eslint/no-explicit-any` reports the `any` keyword as a syntax node, which a JSDoc
 * annotation in a JavaScript file is not -- it is a comment. So the lint gate cannot see an
 * `@type` tag naming `any`, and the 197 of them this repository accumulated stayed invisible until
 * they were counted by hand. This test is the gate for that surface: it derives the files from
 * `tsconfig.json` itself, so the two cannot drift apart.
 *
 * The annotations are written without their braces here so that adding `test/**` to the tsconfig
 * include would not make this file report itself.
 */
const typeCheckedJavaScriptExtensions = new Set(['.js', '.mjs', '.cjs']);

/** The two `tsconfig.json` members this test derives its file list from. */
interface TsconfigPaths {
  readonly include: readonly string[];
  readonly exclude: readonly string[];
}

/** One JSDoc type expression naming `any`, and the line it sits on. */
interface JsdocAnyOffence {
  readonly line: number;
  readonly type: string;
}

/** Turn one `tsconfig.json` include or exclude glob into a matcher for a repository-relative path. */
function globToRegExp(pattern: string) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, '\\$&');
  const body = escaped.replace(/\*\*\/|\*/gu, (token) => (token === '*' ? '[^/]*' : '(?:[^/]+/)*'));
  return new RegExp(`^${body}$`, 'u');
}

/** Read `tsconfig.json`, which carries `//` comments explaining what it excludes and why. */
async function readTsconfig(): Promise<TsconfigPaths> {
  const text = await readFile(new URL('tsconfig.json', projectRoot), 'utf8');
  return JSON.parse(
    text
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n'),
  );
}

/** Every tracked file under one of the directories `tsconfig.json` reaches into. */
async function listCandidateFiles(roots: readonly string[]) {
  const files: string[] = [];
  for (const root of roots) {
    const absolute = path.join(new URL('.', projectRoot).pathname, root);
    let entries;
    try {
      entries = await readdir(absolute, {recursive: true, withFileTypes: true});
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const relative = path.relative(
        new URL('.', projectRoot).pathname,
        path.join(entry.parentPath, entry.name),
      );
      files.push(relative);
    }
  }
  return files;
}

/** Report every JSDoc type expression that names `any`, with the line it sits on. */
function findJsdocAny(source: string) {
  const found: JsdocAnyOffence[] = [];
  for (const block of source.matchAll(/\/\*\*[\s\S]*?\*\//gu)) {
    for (const type of block[0].matchAll(/\{(?:[^{}]|\{[^{}]*\})*\}/gu)) {
      if (!/(?<![\w$.])any(?![\w$])/u.test(type[0])) continue;
      const offset = (block.index ?? 0) + (type.index ?? 0);
      found.push({line: source.slice(0, offset).split('\n').length, type: type[0]});
    }
  }
  return found;
}

test('keeps JSDoc `any` out of the JavaScript that tsconfig type-checks', async () => {
  const eslint = new ESLint({cwd: new URL('.', projectRoot).pathname});
  const tsconfig = await readTsconfig();
  const includes = tsconfig.include.map(globToRegExp);
  const excludes = tsconfig.exclude.map(globToRegExp);
  const roots = [
    ...new Set(
      tsconfig.include.map((pattern) =>
        requireDefined(pattern.split('/')[0], `the first segment of include glob ${pattern}`),
      ),
    ),
  ].filter((root) => !root.includes('*') && !root.includes('.'));

  const candidates = (await listCandidateFiles(roots)).filter(
    (file) =>
      typeCheckedJavaScriptExtensions.has(path.extname(file)) &&
      includes.some((pattern) => pattern.test(file)) &&
      !excludes.some((pattern) => pattern.test(file)),
  );
  // This test stands in for a lint rule, so it honours the same ignores, which is what drops
  // everything under a `generated/` directory. tsconfig still type-checks the PoseNet asset module
  // because a source file imports it, but an annotation there would have to be fixed in the
  // generator rather than in the file.
  const checked: string[] = [];
  for (const file of candidates) {
    if (!(await eslint.isPathIgnored(file))) checked.push(file);
  }

  // The list is derived, so a derivation that quietly stops matching would make this test pass by
  // checking nothing -- which is what a first attempt at `globToRegExp` did. These two are served
  // as-is and stay JavaScript, so neither leaves the surface by being converted; anchor on them.
  for (const anchor of ['bin/tm-kamishibai.mjs', 'site/site-shell.js']) {
    assert.ok(
      checked.includes(anchor),
      `${anchor} fell out of the derived type-checked JavaScript`,
    );
  }

  const offences: string[] = [];
  for (const file of checked) {
    const source = await readFile(new URL(file, projectRoot), 'utf8');
    for (const {line, type} of findJsdocAny(source)) offences.push(`${file}:${line} ${type}`);
  }

  assert.deepEqual(
    offences,
    [],
    `JSDoc \`any\` is invisible to @typescript-eslint/no-explicit-any, which reads syntax rather than comments.\n` +
      `Declare the shape the code reads, or move the file to TypeScript:\n  ${offences.join('\n  ')}`,
  );
});
