import globals from 'globals';

const rules = {
  eqeqeq: 'error',
  'no-undef': 'error',
  'no-unused-vars': ['error', {argsIgnorePattern: '^_'}],
};

export default [
  {
    ignores: [
      'dist/**',
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
];
