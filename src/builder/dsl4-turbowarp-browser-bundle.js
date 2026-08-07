import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';

import {build} from 'esbuild';

const require = createRequire(import.meta.url);
// @ts-expect-error brfs does not publish TypeScript declarations.
const brfs = require('brfs');

export const dsl4TurboWarpBrowserBundleDefaults = Object.freeze({
  maxBundleBytes: 24 * 1024 * 1024,
});

export const dsl4TurboWarpBrowserBundleMaximumBytes = 48 * 1024 * 1024;

/** @param {unknown} value @param {string} name @param {number} minimum */
function safeInteger(value, name, minimum) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new TypeError(`${name} must be a safe integer >= ${minimum}`);
  }
  return Number(value);
}

/** @param {string} specifier @param {string} prefix */
function loaderTarget(specifier, prefix) {
  return specifier.slice(specifier.indexOf(prefix) + prefix.length);
}

/** @param {string} filename @returns {Promise<Buffer>} */
async function inlineBrowserifyFileReads(filename) {
  const source = await readFile(filename);
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    const transform = brfs(filename);
    /** @param {string | Buffer | Uint8Array} chunk */
    function collect(chunk) {
      chunks.push(Buffer.from(chunk));
    }
    transform.on('data', collect);
    transform.on('error', reject);
    transform.on('end', () => resolve(Buffer.concat(chunks)));
    transform.end(source);
  });
}

/**
 * Translate the reviewed webpack inline-loader imports used by pinned TurboWarp packages.
 * External extension worker constructors fail closed because local preview never loads them.
 */
function turbowarpInlineLoaderPlugin() {
  return {
    name: 'dsl4-turbowarp-inline-loaders',
    /** @param {import('esbuild').PluginBuild} pluginBuild */
    setup(pluginBuild) {
      pluginBuild.onResolve({filter: /raw-loader!/}, (args) => ({
        path: path.resolve(args.resolveDir, loaderTarget(args.path, 'raw-loader!')),
        namespace: 'dsl4-turbowarp-text',
      }));
      pluginBuild.onResolve({filter: /base64-loader!/}, (args) => ({
        path: path.resolve(args.resolveDir, loaderTarget(args.path, 'base64-loader!')),
        namespace: 'dsl4-turbowarp-base64',
      }));
      pluginBuild.onResolve({filter: /ify-loader!/}, async (args) => {
        const resolved = await pluginBuild.resolve(loaderTarget(args.path, 'ify-loader!'), {
          importer: args.importer,
          kind: args.kind,
          resolveDir: args.resolveDir,
        });
        if (resolved.errors.length > 0) return resolved;
        return {
          path: resolved.path,
          namespace: 'dsl4-turbowarp-ify',
          pluginData: resolved.pluginData,
          sideEffects: resolved.sideEffects,
        };
      });
      pluginBuild.onResolve({filter: /worker-loader.*!.*extension-worker$/}, () => ({
        path: 'external-extension-worker',
        namespace: 'dsl4-disabled-external-extension',
      }));
      pluginBuild.onResolve({filter: /tw-load-script-as-plain-text!/}, () => ({
        path: 'iframe-extension-worker-source',
        namespace: 'dsl4-disabled-external-extension',
      }));
      pluginBuild.onLoad({filter: /.*/, namespace: 'dsl4-turbowarp-text'}, async (args) => ({
        contents: await readFile(args.path, 'utf8'),
        loader: 'text',
      }));
      pluginBuild.onLoad({filter: /.*/, namespace: 'dsl4-turbowarp-base64'}, async (args) => ({
        contents: `module.exports = ${JSON.stringify((await readFile(args.path)).toString('base64'))};`,
        loader: 'js',
      }));
      pluginBuild.onLoad({filter: /.*/, namespace: 'dsl4-turbowarp-ify'}, async (args) => ({
        contents: await inlineBrowserifyFileReads(args.path),
        loader: 'js',
        resolveDir: path.dirname(args.path),
      }));
      pluginBuild.onLoad(
        {filter: /^external-extension-worker$/, namespace: 'dsl4-disabled-external-extension'},
        () => ({
          contents:
            'module.exports = class DisabledExternalExtensionWorker { constructor() { throw new Error("External extension workers are disabled in DSL 4.0 local preview"); } };',
          loader: 'js',
        }),
      );
      pluginBuild.onLoad(
        {
          filter: /^iframe-extension-worker-source$/,
          namespace: 'dsl4-disabled-external-extension',
        },
        () => ({
          contents:
            'module.exports = "throw new Error(\\"External iframe extensions are disabled in DSL 4.0 local preview\\");";',
          loader: 'js',
        }),
      );
    },
  };
}

/**
 * Bundle a local-preview browser entry with the pinned TurboWarp runtime packages.
 *
 * @param {object} options
 * @param {string} options.entryPoint
 * @param {number} [options.maxBundleBytes]
 * @param {boolean} [options.minify]
 */
export async function buildDsl4TurboWarpBrowserBundle(options) {
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('TurboWarp browser bundle options are required');
  }
  if (typeof options.entryPoint !== 'string' || !path.isAbsolute(options.entryPoint)) {
    throw new TypeError('entryPoint must be an absolute filesystem path');
  }
  const maximum = safeInteger(
    options.maxBundleBytes ?? dsl4TurboWarpBrowserBundleDefaults.maxBundleBytes,
    'maxBundleBytes',
    1,
  );
  if (maximum > dsl4TurboWarpBrowserBundleMaximumBytes) {
    throw new TypeError(`maxBundleBytes must be <= ${dsl4TurboWarpBrowserBundleMaximumBytes}`);
  }
  if (options.minify !== undefined && typeof options.minify !== 'boolean') {
    throw new TypeError('minify must be a boolean');
  }
  const result = await build({
    entryPoints: [options.entryPoint],
    bundle: true,
    charset: 'utf8',
    conditions: ['browser'],
    define: {global: 'globalThis', 'process.env.NODE_ENV': '"production"'},
    format: 'esm',
    legalComments: 'none',
    loader: {'.mp3': 'dataurl'},
    logLevel: 'silent',
    minify: options.minify ?? true,
    platform: 'browser',
    plugins: [turbowarpInlineLoaderPlugin()],
    splitting: false,
    target: ['es2022'],
    treeShaking: true,
    write: false,
  });
  if (result.outputFiles.length !== 1) {
    throw new TypeError('TurboWarp browser bundle must produce exactly one output file');
  }
  const bytes = new Uint8Array(result.outputFiles[0].contents);
  if (bytes.byteLength < 1 || bytes.byteLength > maximum) {
    throw new TypeError(`TurboWarp browser bundle must contain 1-${maximum} bytes`);
  }
  return bytes;
}
