import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';

import {build} from 'vite';

const require = createRequire(import.meta.url);
const brfs = require('brfs');

export const dsl4TurboWarpBrowserBundleDefaults = Object.freeze({
  maxBundleBytes: 24 * 1024 * 1024,
});

export const dsl4TurboWarpBrowserBundleMaximumBytes = 48 * 1024 * 1024;

function safeInteger(value: unknown, name: string, minimum: number) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new TypeError(`${name} must be a safe integer >= ${minimum}`);
  }
  return Number(value);
}

function loaderTarget(specifier: string, prefix: string) {
  return specifier.slice(specifier.indexOf(prefix) + prefix.length);
}

async function inlineBrowserifyFileReads(filename: string): Promise<string> {
  const source = await readFile(filename);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const transform = brfs(filename);
    function collect(chunk: string | Buffer | Uint8Array) {
      chunks.push(Buffer.from(chunk));
    }
    transform.on('data', collect);
    transform.on('error', reject);
    transform.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    transform.end(source);
  });
}

/**
 * Virtual module identifiers carry no file extension, so the CSS and asset pipelines never claim
 * a module that one of the reviewed webpack inline loaders produced.
 */
const textPrefix = '\0dsl4-turbowarp-text:';
const base64Prefix = '\0dsl4-turbowarp-base64:';
const browserifyPrefix = '\0dsl4-turbowarp-ify:';
const disabledWorkerId = '\0dsl4-turbowarp-disabled-worker';
const disabledIframeId = '\0dsl4-turbowarp-disabled-iframe';

/**
 * Translate the reviewed webpack inline-loader imports used by pinned TurboWarp packages.
 * External extension worker constructors fail closed because local preview never loads them.
 */
function turbowarpInlineLoaderPlugin() {
  const virtualPaths = new Map<string, string>();
  const virtualIds = new Map<string, string>();
  let counter = 0;
  // One loader target resolves to one virtual module, the way the webpack inline loaders behaved.
  // Minting an id per import site would place a second, separately initialised copy of the same
  // module in the bundle.
  const virtualId = (prefix: string, filename: string) => {
    const key = `${prefix}${filename}`;
    const existing = virtualIds.get(key);
    if (existing !== undefined) return existing;
    counter += 1;
    const id = `${prefix}${counter}`;
    virtualIds.set(key, id);
    virtualPaths.set(id, filename);
    return id;
  };

  return {
    name: 'dsl4-turbowarp-inline-loaders',
    // The loader specifiers must be claimed before the default resolver rejects them.
    enforce: 'pre' as const,
    async resolveId(this: any, specifier: string, importer: string | undefined) {
      const originalImporter = importer?.startsWith(browserifyPrefix)
        ? virtualPaths.get(importer)
        : importer;
      const resolveDir = originalImporter ? path.dirname(originalImporter) : process.cwd();
      if (specifier.includes('raw-loader!')) {
        return virtualId(
          textPrefix,
          path.resolve(resolveDir, loaderTarget(specifier, 'raw-loader!')),
        );
      }
      if (specifier.includes('base64-loader!')) {
        return virtualId(
          base64Prefix,
          path.resolve(resolveDir, loaderTarget(specifier, 'base64-loader!')),
        );
      }
      if (/worker-loader.*!.*extension-worker$/u.test(specifier)) return disabledWorkerId;
      if (specifier.includes('tw-load-script-as-plain-text!')) return disabledIframeId;
      if (specifier.includes('ify-loader!')) {
        const resolved = await this.resolve(
          loaderTarget(specifier, 'ify-loader!'),
          originalImporter,
          {skipSelf: false},
        );
        return resolved ? virtualId(browserifyPrefix, resolved.id) : null;
      }
      // Everything a transformed module imports resolves against the real file it came from.
      if (importer?.startsWith(browserifyPrefix)) {
        return this.resolve(specifier, originalImporter, {skipSelf: false});
      }
      return null;
    },
    async load(id: string) {
      if (id.startsWith(textPrefix)) {
        const filename = virtualPaths.get(id) ?? '';
        // The pinned packages `require()` these modules, so they expose a CommonJS string.
        return `module.exports = ${JSON.stringify(await readFile(filename, 'utf8'))};`;
      }
      if (id.startsWith(base64Prefix)) {
        const filename = virtualPaths.get(id) ?? '';
        const encoded = (await readFile(filename)).toString('base64');
        return `module.exports = ${JSON.stringify(encoded)};`;
      }
      if (id.startsWith(browserifyPrefix)) {
        return inlineBrowserifyFileReads(virtualPaths.get(id) ?? '');
      }
      if (id === disabledWorkerId) {
        return 'module.exports = class DisabledExternalExtensionWorker { constructor() { throw new Error("External extension workers are disabled in DSL 4.0 local preview"); } };';
      }
      if (id === disabledIframeId) {
        return 'module.exports = "throw new Error(\\"External iframe extensions are disabled in DSL 4.0 local preview\\");";';
      }
      return null;
    },
  };
}

/** Bundle a local-preview browser entry with the pinned TurboWarp runtime packages. */
export async function buildDsl4TurboWarpBrowserBundle(options: {
  entryPoint: string;
  maxBundleBytes?: number;
  minify?: boolean;
}) {
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
    configFile: false,
    logLevel: 'error',
    root: path.dirname(options.entryPoint),
    define: {global: 'globalThis', 'process.env.NODE_ENV': '"production"'},
    esbuild: {charset: 'utf8', legalComments: 'none'},
    resolve: {conditions: ['browser']},
    plugins: [turbowarpInlineLoaderPlugin()],
    build: {
      // Audio and font assets belong inside the single preview module, as data URLs.
      assetsInlineLimit: dsl4TurboWarpBrowserBundleMaximumBytes,
      lib: {
        entry: options.entryPoint,
        fileName: () => 'dsl4-local-preview.js',
        formats: ['es'],
      },
      minify: options.minify ?? true,
      // Local preview loads one module, so dynamic imports stay inside the same chunk.
      // `inlineDynamicImports` is deprecated in Vite 8; `codeSplitting` replaces it.
      rollupOptions: {output: {codeSplitting: false}},
      target: 'es2022',
      write: false,
    },
  });
  // `build` returns a watcher only when `build.watch` is set, which this bundle never does.
  const built = (Array.isArray(result) ? result[0] : result) as {
    output: ReadonlyArray<{type: string; code?: string}>;
  };
  const outputs = built.output;
  const chunks = outputs.filter((output) => output.type === 'chunk');
  if (outputs.length !== 1 || chunks.length !== 1) {
    throw new TypeError('TurboWarp browser bundle must produce exactly one output file');
  }
  const bytes = new TextEncoder().encode(chunks[0].code ?? '');
  if (bytes.byteLength < 1 || bytes.byteLength > maximum) {
    throw new TypeError(`TurboWarp browser bundle must contain 1-${maximum} bytes`);
  }
  return bytes;
}
