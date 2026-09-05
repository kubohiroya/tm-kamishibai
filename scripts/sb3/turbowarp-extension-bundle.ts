import assert from 'node:assert/strict';
import vm from 'node:vm';

import {
  validateBundleCode,
  type TurboWarpExtensionMetadata,
  type TurboWarpExtensionRegistrations,
} from '@kubohiroya/vite-plugin-turbowarp-extension';
import {build, type BuildOptions, type ESBuildOptions} from 'vite';

/**
 * Build one single-file TurboWarp extension with Vite.
 *
 * `@kubohiroya/vite-plugin-turbowarp-extension` owns the extension contract, and
 * `validateBundleCode` enforces it here: one JavaScript chunk, no leftover module syntax, and a
 * bounded number of `Scratch.extensions.register(...)` calls. The plugin's own `generateBundle`
 * hook cannot build this extension yet, because it indents the wrapped source by two spaces and a
 * minifier writes `"\n"` string constants as template literals holding a real newline; indenting
 * rewrites those constants to `"\n  "` and silently corrupts the bundled libraries. See
 * https://github.com/kubohiroya/vite-plugin-turbowarp-extension/issues/16.
 */
export async function buildTurboWarpExtensionBundle({
  entry,
  root,
  fileName,
  metadata,
  define,
  target = 'es2022',
  minify = 'esbuild' as const,
  esbuildOptions,
  globalName,
  header,
  prelude,
  registrations = 1,
}: {
  entry: string;
  root: string;
  fileName: string;
  globalName: string;
  metadata: TurboWarpExtensionMetadata;
  define?: Record<string, string>;
  target?: string;
  minify?: BuildOptions['minify'];
  esbuildOptions?: ESBuildOptions;
  header?: string;
  prelude?: string;
  registrations?: TurboWarpExtensionRegistrations;
}): Promise<Buffer> {
  assert.ok(fileName.endsWith('.js'), 'A TurboWarp extension file name must end with .js');
  const result = await build({
    configFile: false,
    logLevel: 'error',
    root,
    ...(define === undefined ? {} : {define}),
    ...(esbuildOptions === undefined ? {} : {esbuild: esbuildOptions}),
    build: {
      // An IIFE places every module-level name in function scope, where the minifier can shorten
      // it. The same graph built as an ES library is about 30% larger.
      lib: {entry, fileName: () => fileName, formats: ['iife'], name: globalName},
      minify,
      // The chunk-level comment filter drops legal comments before the minifier option can keep
      // them, so dependency licence notices need both settings.
      rollupOptions: {output: {comments: {legal: true}}},
      target,
      write: false,
    },
  });

  // `build` returns a watcher only when `build.watch` is set, which this bundle never does.
  const built = (Array.isArray(result) ? result[0] : result) as unknown as {
    output: ReadonlyArray<{type: string; code?: string}>;
  };
  const chunks = built.output.filter((output) => output.type === 'chunk');
  assert.equal(built.output.length, 1, 'A TurboWarp extension must build into one output file');
  assert.equal(chunks.length, 1, 'A TurboWarp extension must build into one JavaScript chunk');
  const code = chunks[0].code ?? '';
  validateBundleCode(
    code,
    (message) => {
      throw new Error(`${metadata.id}: ${message}`);
    },
    registrations,
  );

  // The wrapper never re-indents the built source: see the note above.
  const sections = [
    header ?? defaultHeader(metadata),
    prelude === undefined ? '' : prepareTurboWarpExtensionPrelude(prelude),
    `(function (Scratch) {\n'use strict';\n\n${code.trim()}\n\n})(Scratch);`,
  ];
  return Buffer.from(
    `${sections
      .map((section) => section.replace(/\s+$/u, ''))
      .filter((section) => section.length > 0)
      .join('\n\n')}\n`,
    'utf8',
  );
}

/**
 * Prepare one vendored runtime to sit above the wrapper.
 *
 * The prelude runs outside the IIFE, as a classic script, so compiling it here rejects the module
 * syntax an ESM distribution build would carry — `new vm.Script` parses without executing. The
 * plugin does the same through `validatePreludeCode`, which it does not export.
 *
 * The wrapper that follows starts with `(`, so the prelude has to end in a statement terminator or
 * automatic semicolon insertion reads the wrapper as a call of the prelude's last expression.
 */
export function prepareTurboWarpExtensionPrelude(prelude: string) {
  const source = prelude.replace(/\s+$/u, '');
  if (source === '') return '';
  try {
    new vm.Script(source, {filename: 'turbowarp-extension-prelude.js'});
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`The TurboWarp extension prelude is not a valid classic script: ${detail}`);
  }
  return source.endsWith(';') ? source : `${source};`;
}

function defaultHeader(metadata: TurboWarpExtensionMetadata) {
  return [
    `// Name: ${metadata.name}`,
    `// ID: ${metadata.id}`,
    `// Description: ${metadata.description}`,
    `// By: ${metadata.author}`,
    `// License: ${metadata.license}`,
  ].join('\n');
}
