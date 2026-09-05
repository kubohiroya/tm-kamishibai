import globals from 'globals';
import tseslint from 'typescript-eslint';

const rules = {
  eqeqeq: 'error',
  'no-undef': 'error',
  'no-unused-vars': ['error', {argsIgnorePattern: '^_'}],
};

/**
 * TypeScript reports undefined identifiers and unused values through its own checker.
 *
 * `any` and `Function` carried over from the JSDoc annotations of the JavaScript sources, mostly at
 * TurboWarp platform boundaries that had no published types. Both rules are `error` so new code is
 * held to them; the occurrences that predate the switch are listed in `eslint-suppressions.json`
 * and are burned down by Phase 5 of docs/design/typescript-migration.md. ESLint fails on a
 * suppression that is no longer needed, so the list can only shrink -- run
 * `pnpm lint:prune-suppressions` after clearing a file.
 */
const typescriptRules = {
  eqeqeq: 'error',
  'no-undef': 'off',
  'no-unused-vars': 'off',
  '@typescript-eslint/no-unused-vars': ['error', {argsIgnorePattern: '^_'}],
  '@typescript-eslint/no-explicit-any': 'error',
  '@typescript-eslint/no-unsafe-function-type': 'error',
};

export default [
  {
    ignores: [
      'dist/**',
      'site-dist/**',
      'node_modules/**',
      'tmp/**',
      'src/dsl4/platform/posenet-bundle-assets.js',
      'src/builder/generated/dsl4-playback-runtime-extension.js',
    ],
  },
  {
    files: [
      'bin/**/*.{js,mjs,cjs}',
      'docs/**/*.{js,mjs,cjs}',
      'scripts/**/*.{js,mjs,cjs}',
      'src/**/*.{js,mjs,cjs}',
      'test/**/*.{js,mjs,cjs}',
      '*.{js,mjs,cjs}',
    ],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
    rules,
  },
  {
    files: ['site/**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.browser,
    },
    rules,
  },
  // The TypeScript parser and plugin must cover every TypeScript file, including `site/`, because a
  // rules-only block referencing `@typescript-eslint/*` fails to load without the plugin.
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ['**/*.{ts,mts,cts}'],
  })),
  {
    files: ['**/*.{ts,mts,cts}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
    rules: typescriptRules,
  },
  {
    files: ['site/**/*.{ts,mts,cts}'],
    languageOptions: {
      globals: globals.browser,
    },
    rules: typescriptRules,
  },
];
