import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {unzipSync, strFromU8} from 'fflate';
import {test} from 'vitest';
import {buildDsl4BrowserSelectedStoryProject} from '../src/dsl4/platform/browser-story-file-loader.js';
import {createDsl4PublicationDistributionSb3} from '../src/dsl4/platform/publication-distribution.js';
import {
  readDsl4ProjectPublication,
  validateDsl4ProjectPublication,
} from '../src/dsl4/platform/publication-project.js';
import {dsl4TestProductionSourceFrontend as sourceFrontend} from './helpers/dsl4-test-frontend.ts';

const limits = {
  maxSourceBytes: 16384,
  maxAssetFiles: 8,
  maxAssetFileBytes: 16384,
  maxTotalAssetBytes: 32768,
};
const source = `kamishibai: '4.0'\ncontrols:\n  keymaps:\n    production:\n      Space: navigation.nextAction\nscenes:\n  first:\n    - wait: 60\n`;
const file = (path: string, text: string) => {
  const bytes = new TextEncoder().encode(text);
  return {
    path,
    file: {
      name: path.split('/').at(-1)!,
      size: bytes.length,
      arrayBuffer: async () => bytes.buffer,
    },
  };
};
function manifest() {
  return {
    formatVersion: 1,
    id: 'book',
    title: 'Book',
    entrySegment: 'a',
    entryPoints: ['a'],
    segments: ['a', 'b'].map((id, index) => ({
      id,
      title: id,
      next: index === 0 ? ['b'] : [],
      source: {
        entry: `${id}.k4.yml`,
        size: new TextEncoder().encode(source).length,
        integrity: 'sha256-' + createHash('sha256').update(source).digest('hex'),
      },
    })),
  };
}
async function fixture() {
  return buildDsl4BrowserSelectedStoryProject({
    project: {targets: [], extensionStorage: {}},
    entries: [
      file('book/publication.json', JSON.stringify(manifest())),
      file('book/a.k4.yml', source),
      file('book/b.k4.yml', source),
    ],
    sourceFrontend,
    ...limits,
  });
}
test('normal folder selection builds all verified chapters and SB3 preserves publication data', async () => {
  const built = await fixture();
  const publication = validateDsl4ProjectPublication(
    readDsl4ProjectPublication(built.project),
    sourceFrontend,
  );
  assert.equal(publication.manifest.entrySegment, 'a');
  assert.deepEqual(Object.keys(publication.components), ['a', 'b']);
  const artifact = await createDsl4PublicationDistributionSb3({
    project: built.project,
    projectFiles: {'project.json': '{}', 'kept.svg': '<svg/>'},
    sourceFrontend,
    ...limits,
  });
  assert.equal(artifact.filename, 'book.sb3');
  const restored = JSON.parse(strFromU8(unzipSync(artifact.bytes)['project.json']!));
  const restoredPublication = readDsl4ProjectPublication(restored) as {stageArchive?: unknown};
  assert(restoredPublication.stageArchive);
  const repacked = await createDsl4PublicationDistributionSb3({
    project: restored,
    projectFiles: {'project.json': '{}'},
    sourceFrontend,
    ...limits,
  });
  assert.equal(strFromU8(unzipSync(repacked.bytes)['kept.svg']!), '<svg/>');
  delete restoredPublication.stageArchive;
  assert.deepEqual(
    restoredPublication,
    JSON.parse(JSON.stringify(readDsl4ProjectPublication(built.project))),
  );
});
test('invalid publication digest and missing chapters fail selection before replacing a project', async () => {
  const input = manifest();
  input.segments[1]!.source.integrity = 'sha256-' + '0'.repeat(64);
  await assert.rejects(
    buildDsl4BrowserSelectedStoryProject({
      project: {targets: []},
      entries: [
        file('publication.json', JSON.stringify(input)),
        file('a.k4.yml', source),
        file('b.k4.yml', source),
      ],
      sourceFrontend,
      ...limits,
    }),
    /integrity/,
  );
  await assert.rejects(
    buildDsl4BrowserSelectedStoryProject({
      project: {},
      entries: [file('publication.json', JSON.stringify(manifest())), file('a.k4.yml', source)],
      sourceFrontend,
      ...limits,
    }),
    /Missing publication source/,
  );
});
test('distribution checks every chapter and rejects unsafe archive paths', async () => {
  const built = await fixture();
  await assert.rejects(
    createDsl4PublicationDistributionSb3({
      project: built.project,
      projectFiles: {'../escape': new Uint8Array()},
      sourceFrontend,
      ...limits,
    }),
    /Unsafe/,
  );
  const corrupted = structuredClone(built.project);
  const publication = readDsl4ProjectPublication(corrupted) as {
    components: Record<string, {source: {text: string}}>;
  };
  publication.components.b!.source.text += '\n';
  assert.throws(
    () => validateDsl4ProjectPublication(publication, sourceFrontend),
    /does not match/,
  );
});

test('Packager bootstrap retains originals, validates integrity, and rejects already-lost assets', async () => {
  const {createDsl4PublicationStageArchive, validateDsl4PublicationStageArchive} =
    await import('../src/dsl4/platform/publication-stage-archive.js');
  const project = {
    targets: [
      {blocks: {hat: {opcode: 'event_whenflagclicked'}}, costumes: [{md5ext: 'original.svg'}]},
    ],
    extensions: ['custom'],
    extensionURLs: {custom: 'https://example.test/code.js'},
    extensionStorage: {},
  };
  await assert.rejects(createDsl4PublicationStageArchive(project, {}), /requires original/);
  const archive = await createDsl4PublicationStageArchive(project, {
    'original.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
  });
  assert.deepEqual(
    (await validateDsl4PublicationStageArchive(archive.descriptor)).bytes,
    archive.bytes,
  );
  const scratch = JSON.parse(strFromU8(unzipSync(archive.bytes)['project.json']!));
  assert.deepEqual(scratch.targets[0].blocks, {});
  assert.equal(scratch.extensions, undefined);
  assert.equal(scratch.extensionStorage, undefined);
  await assert.rejects(
    validateDsl4PublicationStageArchive({...archive.descriptor, integrity: 'sha256-invalid'}),
    /integrity/,
  );
  assert.equal(project.targets[0]!.blocks.hat.opcode, 'event_whenflagclicked');
});

test('publication snapshot is immutable and cannot be changed by later project edits', async () => {
  const built = await fixture();
  const input = readDsl4ProjectPublication(built.project) as {
    sources: Record<string, string>;
    components: Record<string, {source: {text: string}}>;
  };
  const snapshot = validateDsl4ProjectPublication(input, sourceFrontend);
  input.sources['a.k4.yml'] = 'changed';
  input.components.a!.source.text = 'changed';
  assert.equal(snapshot.sources['a.k4.yml'], source);
  assert.equal((snapshot.components.a as {source: {text: string}}).source.text, source);
  assert(Object.isFrozen(snapshot.components.a));
});

test('stage archive rejects oversized entry metadata before inflation', async () => {
  const {unpackDsl4PublicationStageArchive} =
    await import('../src/dsl4/platform/publication-stage-archive.js');
  const {zipSync} = await import('fflate');
  const bytes = zipSync({'large.bin': new Uint8Array([1])});
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < bytes.length - 28; i++) {
    if (view.getUint32(i, true) === 0x02014b50) {
      view.setUint32(i + 24, 128 * 1024 * 1024, true);
      break;
    }
  }
  assert.throws(() => unpackDsl4PublicationStageArchive(bytes), /exceeds limit/);
});

test('opening a standalone story from a saved publication removes the old publication and archive', async () => {
  const book = await fixture();
  const old = readDsl4ProjectPublication(book.project) as {stageArchive?: unknown};
  old.stageArchive = {oldArchive: true};
  const standaloneSource = source.replace('wait: 60', 'wait: 17');
  const selected = await buildDsl4BrowserSelectedStoryProject({
    project: book.project,
    entries: [file('standalone.k4.yml', standaloneSource)],
    sourceFrontend,
    ...limits,
  });
  assert.equal(readDsl4ProjectPublication(selected.project), null);
  const component = selected.project.extensionStorage!.kubohiroyakamishibai4!.components!
    .kubohiroyakamishibairuntime4 as {source: {text: string}};
  assert.equal(component.source.text, standaloneSource);
  assert.equal(readDsl4ProjectPublication(book.project), old);
});

test('publication validates explicit scenario chapter transitions against manifest next, including backward story links', async () => {
  const first = source.replace('wait: 60', 'gotoSegment: b');
  const second = source.replace('wait: 60', 'gotoSegment: a');
  const input = manifest();
  input.segments[1]!.next = ['a'];
  for (const [index, text] of [first, second].entries()) {
    input.segments[index]!.source.size = new TextEncoder().encode(text).length;
    input.segments[index]!.source.integrity =
      'sha256-' + createHash('sha256').update(text).digest('hex');
  }
  const built = await buildDsl4BrowserSelectedStoryProject({
    project: {targets: []},
    entries: [
      file('publication.json', JSON.stringify(input)),
      file('a.k4.yml', first),
      file('b.k4.yml', second),
    ],
    sourceFrontend,
    ...limits,
  });
  assert(readDsl4ProjectPublication(built.project));
  input.segments[1]!.next = [];
  await assert.rejects(
    buildDsl4BrowserSelectedStoryProject({
      project: {targets: []},
      entries: [
        file('publication.json', JSON.stringify(input)),
        file('a.k4.yml', first),
        file('b.k4.yml', second),
      ],
      sourceFrontend,
      ...limits,
    }),
    /manifest next/,
  );
});
