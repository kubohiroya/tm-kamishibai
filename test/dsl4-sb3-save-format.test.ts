import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'vitest';

import {discoverManifest} from '@kubohiroya/turbowarp-extension-loader';

import {runCli} from '../src/builder/cli.js';
import {readSb3, serializeSb3} from '../src/builder/sb3.js';
import {
  describeSb3SaveFormats,
  normalizeSb3SaveSelection,
  sb3SaveFormatSupport,
  sb3SaveFormats,
  sb3SavePayloads,
  sb3SupportedSaveFormats,
} from '../src/builder/sb3-save-format.js';
import {
  dsl4UnsandboxedExtensionIds,
  readSb3ExtensionPayloads,
  sb3PlusExtensionPath,
  writeSb3ExtensionFormat,
} from '../src/builder/sb3-extension-format.js';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const id = 'kubohiroyakamishibai4';
const code = '// Name: Kamishibai DSL 4.0 Runtime\n// ID: kubohiroyakamishibai4\nexport {};\n';
const dataUrl = (source: string) =>
  `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
const hex = (source: string) => createHash('sha256').update(source, 'utf8').digest('hex');

interface TestProject extends Record<string, unknown> {
  extensionURLs: Record<string, unknown>;
}

const embeddedDataProject = (extensionId = id, source = code): TestProject => ({
  targets: [{isStage: true}],
  extensions: [extensionId],
  extensionURLs: {[extensionId]: dataUrl(source)},
});

/** A Plus project another tool wrote, with metadata and a path this writer would not choose. */
function plusProject() {
  const a = '// a\n';
  const b = '// b\n';
  const archive: Record<string, Uint8Array> = {
    [`extensions/alpha-${hex(a)}.js`]: new TextEncoder().encode(a),
    [`extensions/beta-${hex(b)}.js`]: new TextEncoder().encode(b),
  };
  const project: TestProject = {
    targets: [{isStage: true}],
    extensions: ['alpha', 'beta'],
    extensionURLs: {},
    turboWarpPlus: {
      schemaVersion: 1,
      extensions: [
        {
          id: 'beta',
          source: {type: 'embedded', path: `extensions/beta-${hex(b)}.js`},
          execution: 'sandboxed',
          sha256: hex(b),
          version: '1.2.3',
          publisher: 'Example',
          capabilities: ['network'],
          dependencies: [],
        },
        {
          id: 'alpha',
          source: {type: 'embedded', path: `extensions/alpha-${hex(a)}.js`},
          execution: 'sandboxed',
          sha256: hex(a),
          capabilities: [],
          dependencies: ['beta'],
        },
      ],
    },
  };
  return {archive, project};
}

test('the vocabulary names four formats for three payloads', () => {
  assert.deepEqual(sb3SaveFormats, ['remote', 'cached', 'embedded-file', 'embedded-data']);
  assert.deepEqual(sb3SavePayloads, ['extensions', 'source', 'assets']);
  assert.equal(
    describeSb3SaveFormats(),
    'extensions: remote|cached|embedded-file|embedded-data; source: kept as built; assets: kept as built',
  );
});

test('an option left unset keeps that payload, and a named one is never ignored', () => {
  // Leaving everything unset is a request to change nothing.
  assert.deepEqual(normalizeSb3SaveSelection({}), {
    extensions: undefined,
    source: undefined,
    assets: undefined,
    assetsAsProjectAssets: false,
  });
  // This command rewrites extensions only, so any named source or asset form is refused.
  assert.deepEqual(sb3SupportedSaveFormats('source'), []);
  assert.deepEqual(sb3SupportedSaveFormats('assets'), []);
  assert.throws(
    () => normalizeSb3SaveSelection({assets: 'embedded-data'}),
    /does not rewrite assets\. Omit --assets/u,
  );
  assert.throws(() => normalizeSb3SaveSelection({assets: 'remote'}), /resolved at build time/u);
  assert.throws(
    () => normalizeSb3SaveSelection({assets: 'cached'}),
    /no command produces one yet/u,
  );
  assert.throws(
    () => normalizeSb3SaveSelection({assets: 'embedded-file'}),
    /saveProjectSb3DontZip/u,
  );
  assert.throws(() => normalizeSb3SaveSelection({source: 'remote'}), /turbowarp-document-source/u);
  assert.throws(
    () => normalizeSb3SaveSelection({assetsAsProjectAssets: true}),
    /Cannot store assets as project assets: .*convert-dsl4-assets --to project/u,
  );
  assert.deepEqual(sb3SupportedSaveFormats('extensions'), [
    'remote',
    'cached',
    'embedded-file',
    'embedded-data',
  ]);
  assert.equal(sb3SaveFormatSupport('extensions', 'cached').supported, true);
});

test('a selection must name known options and known formats', () => {
  assert.throws(() => normalizeSb3SaveSelection({nope: 'remote'}), /Unknown save option nope/u);
  assert.throws(() => normalizeSb3SaveSelection({extensions: 'nope'}), /must be one of/u);
  assert.throws(() => normalizeSb3SaveSelection(null), /selection object is required/u);
  assert.throws(
    () => normalizeSb3SaveSelection({assetsAsProjectAssets: 'yes'}),
    /assetsAsProjectAssets must be a boolean/u,
  );
});

test('embedded-data and embedded-file round-trip the exact extension bytes', () => {
  const archive: Record<string, Uint8Array> = {};
  const project = embeddedDataProject();
  writeSb3ExtensionFormat(archive, project, 'embedded-file');
  assert.equal(Buffer.from(archive[sb3PlusExtensionPath(id)]!).toString('utf8'), code);
  assert.equal(project.extensionURLs[id], undefined, 'a single Plus form drops the data carrier');
  writeSb3ExtensionFormat(archive, project, 'embedded-data');
  assert.equal(project.extensionURLs[id], dataUrl(code));
  assert.equal(archive[sb3PlusExtensionPath(id)], undefined);
  assert.equal(project.turboWarpPlus, undefined, 'no empty Manifest is left behind');
});

test('a rewrite keeps the execution mode, dependencies and metadata it found', () => {
  const {archive, project} = plusProject();
  writeSb3ExtensionFormat(archive, project, 'embedded-file');
  const manifest = discoverManifest(project)!;
  const beta = manifest.extensions.find((spec) => spec.id === 'beta')!;
  const alpha = manifest.extensions.find((spec) => spec.id === 'alpha')!;
  assert.equal(beta.execution, 'sandboxed', 'a sandboxed request is never promoted');
  assert.equal(alpha.execution, 'sandboxed');
  assert.deepEqual(alpha.dependencies, ['beta'], 'the dependency survives');
  assert.deepEqual(
    manifest.extensions.map((spec) => spec.id),
    ['beta', 'alpha'],
    'so the Loader still orders the dependency first',
  );
  assert.equal(beta.version, '1.2.3');
  assert.equal(beta.publisher, 'Example');
  assert.deepEqual(beta.capabilities, ['network']);
});

test('only the App’s own DSL 4.0 extensions are requested unsandboxed by default', () => {
  assert.ok(dsl4UnsandboxedExtensionIds.includes(id));
  const runtime = embeddedDataProject();
  writeSb3ExtensionFormat({}, runtime, 'embedded-file');
  assert.equal(discoverManifest(runtime)!.extensions[0]!.execution, 'unsandboxed');

  const thirdParty = embeddedDataProject('thirdparty', '// a sandboxed extension\n');
  writeSb3ExtensionFormat({}, thirdParty, 'embedded-file');
  assert.equal(discoverManifest(thirdParty)!.extensions[0]!.execution, 'sandboxed');

  const named = embeddedDataProject('thirdparty', '// trusted by the caller\n');
  writeSb3ExtensionFormat({}, named, 'embedded-file', {unsandboxed: ['thirdparty']});
  assert.equal(discoverManifest(named)!.extensions[0]!.execution, 'unsandboxed');
});

test('a rewrite releases the archive entry an extension occupied, wherever it was', () => {
  const {archive, project} = plusProject();
  const original = Object.keys(archive).sort();
  writeSb3ExtensionFormat(archive, project, 'embedded-file');
  for (const entry of original) assert.equal(archive[entry], undefined, `${entry} is released`);
  assert.deepEqual(Object.keys(archive).sort(), ['extensions/alpha.js', 'extensions/beta.js']);
});

test('remote and cached reuse the URL a project already names', () => {
  const archive: Record<string, Uint8Array> = {};
  const project = embeddedDataProject();
  const url = `https://example.test/${id}.js`;
  writeSb3ExtensionFormat(archive, project, 'cached', {urls: {[id]: url}});

  // cached → remote and remote → remote need no URL again.
  writeSb3ExtensionFormat(archive, project, 'remote');
  assert.deepEqual(discoverManifest(project)!.extensions[0]!.source, {type: 'remote', url});
  writeSb3ExtensionFormat(archive, project, 'remote');
  assert.deepEqual(discoverManifest(project)!.extensions[0]!.source, {type: 'remote', url});
  assert.equal(archive[sb3PlusExtensionPath(id)], undefined, 'a remote form keeps no copy');

  // A remote-only project has no bytes, so an embedded form must fetch them first.
  assert.throws(
    () => writeSb3ExtensionFormat(archive, project, 'embedded-file'),
    /must be fetched/u,
  );
});

test('rewriting its own output is a no-op, so a converted SB3 can be rebuilt or rewritten', () => {
  for (const format of ['embedded-file', 'cached', 'embedded-data'] as const) {
    const archive: Record<string, Uint8Array> = {};
    const project = embeddedDataProject();
    const options = {urls: {[id]: `https://example.test/${id}.js`}, keepEmbeddedData: true};
    writeSb3ExtensionFormat(archive, project, format, options);
    const once = serializeSb3({...archive}, structuredClone(project));
    writeSb3ExtensionFormat(archive, project, format, options);
    assert.deepEqual(serializeSb3({...archive}, project), once, `${format} is idempotent`);
  }
});

test('keepEmbeddedData puts the data carrier beside a Plus form for standard hosts', () => {
  const archive: Record<string, Uint8Array> = {};
  const project = embeddedDataProject();
  writeSb3ExtensionFormat(archive, project, 'embedded-file', {keepEmbeddedData: true});
  assert.equal(project.extensionURLs[id], dataUrl(code), 'a standard host still finds it');
  assert.ok(discoverManifest(project), 'a Plus host verifies it through the Manifest');
  assert.ok(archive[sb3PlusExtensionPath(id)]);

  const remoteOnly = embeddedDataProject();
  writeSb3ExtensionFormat({}, remoteOnly, 'remote', {urls: {[id]: 'https://example.test/x.js'}});
  assert.throws(
    () => writeSb3ExtensionFormat({}, remoteOnly, 'remote', {keepEmbeddedData: true}),
    /no bytes to keep as a data: URL/u,
  );
});

test('a data: URL that cannot keep dependencies is refused instead of dropping them', () => {
  const {archive, project} = plusProject();
  assert.throws(
    () => writeSb3ExtensionFormat(archive, project, 'embedded-data'),
    /cannot record dependencies/u,
  );
});

test('an undeclared leftover data: URL is left alone rather than brought back', () => {
  const project: TestProject = {
    ...embeddedDataProject(),
    extensionURLs: {[id]: dataUrl(code), leftover: dataUrl('// not declared\n')},
  };
  writeSb3ExtensionFormat({}, project, 'embedded-file');
  assert.deepEqual(project.extensions, [id]);
  assert.equal(project.extensionURLs.leftover, dataUrl('// not declared\n'));
  assert.deepEqual(
    discoverManifest(project)!.extensions.map((spec) => spec.id),
    [id],
  );
});

test('unrelated content at the chosen archive path is refused rather than overwritten', () => {
  assert.throws(
    () =>
      writeSb3ExtensionFormat(
        {[sb3PlusExtensionPath(id)]: new Uint8Array([1])},
        embeddedDataProject(),
        'embedded-file',
      ),
    /already contains unrelated content/u,
  );
});

test('a project with no extension is left alone', () => {
  const project: Record<string, unknown> = {targets: []};
  const archive: Record<string, Uint8Array> = {};
  assert.deepEqual(writeSb3ExtensionFormat(archive, project, 'embedded-file').converted, []);
  assert.deepEqual(project, {targets: []});
  assert.deepEqual(archive, {});
  assert.deepEqual(readSb3ExtensionPayloads(archive, project), []);
});

test('a published release SB3 converts to the Plus form and back to its exact bytes', async () => {
  const bytes = await readFile(
    path.join(repositoryRoot, 'site-dist/downloads/kamishibai-4.0.0-rc.46.sb3'),
  );
  const {archive, project} = readSb3(bytes);
  const originalURL = (project.extensionURLs as Record<string, string>)[id];
  assert.ok(originalURL?.startsWith('data:text/javascript;base64,'));
  writeSb3ExtensionFormat(archive, project, 'embedded-file');
  assert.deepEqual(
    discoverManifest(project)!.extensions.map((spec) => [spec.source, spec.execution]),
    [[{type: 'embedded', path: sb3PlusExtensionPath(id)}, 'unsandboxed']],
  );
  writeSb3ExtensionFormat(archive, project, 'embedded-data');
  assert.equal((project.extensionURLs as Record<string, string>)[id], originalURL);
});

test('the command keeps every payload it is not told to change, and bounds its input', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'save-sb3-format-'));
  try {
    const input = path.join(directory, 'in.sb3');
    const output = path.join(directory, 'out.sb3');
    await writeFile(input, serializeSb3({}, embeddedDataProject()));
    const writes: string[] = [];
    const stdout = {write: (text: string) => (writes.push(text), true)};

    await runCli(['save-sb3-format', '--input', input, '--output', output], {stdout});
    const kept = readSb3(await readFile(output)).project as TestProject;
    assert.equal(kept.extensionURLs[id], dataUrl(code), 'no --extensions means no rewrite');
    assert.equal(kept.turboWarpPlus, undefined);
    assert.match(writes.join(''), /extensions kept as they were/u);

    await assert.rejects(
      runCli(['save-sb3-format', '--input', input, '--output', output, '--max-input-bytes', '8'], {
        stdout,
      }),
      /more than --max-input-bytes 8/u,
    );
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
