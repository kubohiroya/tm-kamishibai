import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const dsl4Root = path.join(repositoryRoot, 'src', 'dsl4');

/**
 * Shared packages the DSL 4.0 core may import. The core purity rule exists to keep platform and
 * I/O dependencies out of the core graph, not to forbid app-neutral extraction, so a package
 * earns a place here only while it stays dependency-free and platform-free. The test below
 * enforces that, so this list cannot silently become a hole in the rule.
 */
const pureSharedPackages = Object.freeze(['@kubohiroya/turbowarp-preview-runtime']);

const pureEntries = [
  'action-hat-detector.js',
  'action-invocation-adapter.js',
  'action-registry.js',
  'asset-bundle-descriptor.js',
  'asset-dependency-index.js',
  'binary-entry-provider.js',
  'control-profile-resolver.js',
  'embedded-asset-lifecycle.js',
  'history-reducer.js',
  'jsonpath.js',
  'kamishibai-structured-data.js',
  'live-reload-session.js',
  'navigation-session.js',
  'object-store/index.js',
  'preview-protocol.js',
  'pose-feedback-policy.js',
  'reload-planner.js',
  'runtime-artifact-descriptor.js',
  'runtime-artifact-loader.js',
  'runtime-controller.js',
  'runtime-startup.js',
  'semantic-validator.js',
  'source-descriptor.js',
  'source-frontend.js',
  'story-document.js',
  'structured-data.js',
];

function moduleSpecifiers(source, filename) {
  const result = [];
  for (const match of source.matchAll(
    /\b(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/gmu,
  )) {
    result.push(match[1]);
  }
  for (const match of source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gmu)) {
    result.push(match[1]);
  }
  assert.equal(
    result.every((specifier) => specifier.length > 0),
    true,
    filename,
  );
  return result;
}

async function importGraph(entry) {
  const pending = [path.join(dsl4Root, entry)];
  const modules = new Map();
  while (pending.length > 0) {
    const filename = pending.pop();
    if (modules.has(filename)) continue;
    const source = await readFile(filename, 'utf8');
    const imports = moduleSpecifiers(source, filename);
    modules.set(filename, {source, imports});
    for (const specifier of imports) {
      if (!specifier.startsWith('.')) continue;
      const target = path.resolve(path.dirname(filename), specifier);
      assert.equal(
        target.startsWith(`${dsl4Root}${path.sep}`),
        true,
        `${path.relative(repositoryRoot, filename)} escapes the DSL4 core`,
      );
      pending.push(target);
    }
  }
  return modules;
}

test('keeps every declared DSL4 core graph outside platform and I/O dependencies', async () => {
  for (const entry of pureEntries) {
    const graph = await importGraph(entry);
    for (const [filename, {source, imports}] of graph) {
      const relative = path.relative(repositoryRoot, filename);
      assert.equal(
        relative.includes(`${path.sep}platform${path.sep}`),
        false,
        `${entry}: ${relative}`,
      );
      for (const specifier of imports) {
        if (pureSharedPackages.includes(specifier)) continue;
        assert.doesNotMatch(specifier, /^node:/u, `${entry}: ${relative}`);
        assert.doesNotMatch(
          specifier,
          /(?:scratch-vm|@kubohiroya\/turbowarp-)/u,
          `${entry}: ${relative}`,
        );
      }
      assert.doesNotMatch(
        source,
        /(?:globalThis\.(?:document|window)|\bfetch\s*\(|\bScratch\.extensions\b|\bvm\.runtime\b|\bstartHats\b)/u,
        `${entry}: ${relative}`,
      );
    }
  }
});

test('keeps every DSL4 core shared package dependency-free and platform-free', async () => {
  for (const specifier of pureSharedPackages) {
    const manifest = JSON.parse(
      await readFile(fileURLToPath(import.meta.resolve(`${specifier}/package.json`)), 'utf8'),
    );
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
      assert.deepEqual(manifest[field] ?? {}, {}, `${specifier}: ${field}`);
    }
    const entry = fileURLToPath(import.meta.resolve(specifier));
    const source = await readFile(entry, 'utf8');
    assert.deepEqual(moduleSpecifiers(source, specifier), [], specifier);
    assert.doesNotMatch(
      source,
      /\b(?:globalThis|window|document|navigator|indexedDB|localStorage|fetch|XMLHttpRequest|WebSocket|Scratch|process|require)\b/u,
      specifier,
    );
  }
});

test('keeps specialized pure modules outside their forbidden graphs', async () => {
  const jsonPathSource = await readFile(path.join(dsl4Root, 'jsonpath.js'), 'utf8');
  assert.deepEqual(moduleSpecifiers(jsonPathSource, 'jsonpath.js'), []);
  assert.doesNotMatch(jsonPathSource, /\b(?:eval|Function|RegExp)\s*\(|\.match\s*\(/u);

  const detectorSource = await readFile(path.join(dsl4Root, 'action-hat-detector.js'), 'utf8');
  assert.doesNotMatch(detectorSource, /\b(?:eval|Function)\s*\(/u);

  const objectStore = await importGraph('object-store/index.js');
  for (const {imports} of objectStore.values()) {
    for (const specifier of imports) assert.doesNotMatch(specifier, /story-document/u);
  }

  const kamishibai = await importGraph('kamishibai-structured-data.js');
  for (const {imports} of kamishibai.values()) {
    for (const specifier of imports) {
      assert.doesNotMatch(specifier, /(?:structured-data\.js|jsonpath\.js)/u);
    }
  }
});

test('keeps custom action discovery and invocation outside default runtime graphs', async () => {
  for (const entry of [
    'runtime-startup.js',
    'navigation-session.js',
    'platform/turbowarp-runtime-host.js',
  ]) {
    const graph = await importGraph(entry);
    const files = [...graph.keys()].map((filename) => path.relative(dsl4Root, filename));
    assert.equal(files.includes('action-hat-detector.js'), false, entry);
    assert.equal(files.includes('action-invocation-adapter.js'), false, entry);
    assert.equal(files.includes('action-context-turbowarp.js'), false, entry);
  }
});

test('keeps startup and host composition independent from ambient platform globals', async () => {
  for (const filename of [
    path.join(dsl4Root, 'runtime-startup.js'),
    path.join(dsl4Root, 'platform', 'turbowarp-runtime-host.js'),
  ]) {
    const source = await readFile(filename, 'utf8');
    assert.doesNotMatch(
      source,
      /(?:globalThis\.(?:document|window)|\bindexedDB\b|\bfetch\s*\(|\bScratch\.extensions\b)/u,
      path.relative(repositoryRoot, filename),
    );
  }
});

test('keeps platform adapters explicit, injected, and outside the public core graph', async () => {
  const coreGraph = await importGraph('index.js');
  for (const filename of coreGraph.keys()) {
    assert.equal(
      filename.includes(`${path.sep}platform${path.sep}`),
      false,
      path.relative(repositoryRoot, filename),
    );
  }

  for (const relative of [
    'asset-adapter-router.js',
    'asset-manager-adapter.js',
    'actor-action-port.js',
    'async-input-action-port.js',
    'media-action-port.js',
    'platform-asset-session.js',
    'svg-text-action-port.js',
    'tm-model-adapter.js',
    'turbowarp-actor-adapter.js',
    'turbowarp-runtime-host.js',
  ]) {
    const filename = path.join(dsl4Root, 'platform', relative);
    const source = await readFile(filename, 'utf8');
    for (const specifier of moduleSpecifiers(source, filename)) {
      assert.doesNotMatch(specifier, /^node:/u, relative);
      assert.doesNotMatch(specifier, /scratch-vm/u, relative);
    }
    assert.doesNotMatch(
      source,
      /(?:globalThis\.(?:document|window)|\bindexedDB\b|\bfetch\s*\(|\bScratch\b|getInfo\s*\()/u,
      relative,
    );
    if (relative === 'turbowarp-runtime-host.js') {
      assert.match(source, /@kubohiroya\/turbowarp-runtime-host/u, relative);
    } else {
      assert.doesNotMatch(source, /\bstartHats\b/u, relative);
    }
  }
});

test('keeps one-shot build output mutation outside the orchestration core', async () => {
  const source = await readFile(
    path.join(repositoryRoot, 'src', 'builder', 'dsl4-build.js'),
    'utf8',
  );
  assert.doesNotMatch(source, /(?:atomic-output|\bwriteFile\b|\brename\b|\bmkdir\b|\brm\s*\()/u);
});
