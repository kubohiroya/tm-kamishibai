const commonRules = {
  eqeqeq: 'error',
  'no-undef': 'error',
  'no-unused-vars': ['error', {argsIgnorePattern: '^_'}],
};

const nodeGlobals = {
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  Blob: 'readonly',
  Buffer: 'readonly',
  clearTimeout: 'readonly',
  console: 'readonly',
  fetch: 'readonly',
  FormData: 'readonly',
  Headers: 'readonly',
  performance: 'readonly',
  process: 'readonly',
  Request: 'readonly',
  Response: 'readonly',
  setTimeout: 'readonly',
  structuredClone: 'readonly',
  TextDecoder: 'readonly',
  TextEncoder: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
};

export default [
  {
    ignores: [
      // These files are pinned build artifacts owned by their standalone extension repositories.
      'app/extensions/kubohiroyaassetmanager.js',
      'app/extensions/kubohiroyaasyncinput.js',
      'app/extensions/kubohiroyaruntimeexpression.js',
      'app/extensions/kubohiroyatextlines.js',
      'app/extensions/tmpose.js',
    ],
  },
  {
    files: [
      'src/**/*.{js,mjs}',
      'bin/**/*.mjs',
      'scripts/**/*.mjs',
      'test/**/*.mjs',
      'docs/**/*.mjs',
      'eslint.config.mjs',
    ],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: nodeGlobals,
    },
    rules: commonRules,
  },
  {
    files: ['site/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        console: 'readonly',
        document: 'readonly',
        window: 'readonly',
      },
    },
    rules: commonRules,
  },
  {
    files: ['app/extensions/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: {
        Scratch: 'readonly',
      },
    },
    rules: commonRules,
  },
];
