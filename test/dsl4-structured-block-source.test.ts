import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {runInNewContext, runInThisContext} from 'node:vm';
import {test} from 'vitest';
import {strFromU8, strToU8, unzipSync, zipSync} from 'fflate';
import {parse} from 'yaml';

import {authorDsl4BlockSourceSb3} from '../src/builder/dsl4-block-source-author.js';
import {exportDsl4BlockSourcesToYaml} from '../src/builder/dsl4-block-source-export.js';
import {serializeDsl4CanonicalDocument} from '../src/builder/dsl4-validate.js';
import {
  dsl4TurboWarpCoreActionBlockSpecs,
  createDsl4TurboWarpCoreActionBlockSurface,
  createDsl4TurboWarpBlockSourceSurface,
} from '../src/dsl4/platform/turbowarp-core-action-block.js';
import {
  createDsl4StructuredBlockSourceDeclaration,
  dsl4BlockAuthoringExtensionId,
} from '../src/dsl4/structured-block-source.js';
import {extractDsl4BlockSourcesFromProject} from '../src/dsl4/turbowarp-yaml-json-block-source.js';
import {dsl4TestSourceFrontend as frontend} from './helpers/dsl4-test-frontend.ts';

type Blocks = ReturnType<typeof createDsl4StructuredBlockSourceDeclaration>;
interface Project {
  targets: {name: string; isStage: boolean; blocks: Blocks}[];
  extensions: string[];
  extensionURLs: Record<string, string>;
}
const helperPrefix = `${dsl4BlockAuthoringExtensionId}_`;
const runtimePrefix = 'kubohiroyakamishibai4_kubohiroyakamishibairuntime4__';
const costumeSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360"></svg>';
const costumeId = createHash('md5').update(costumeSvg).digest('hex');
const source = `kamishibai: '4.0'
assets:
  Beach: backdrop
  HeroIdle: costume:Hero
actors:
  Hero: HeroIdle
variables:
  score: 0
scenes:
  opening:
    entryTransition: {effect: cut}
    actions:
      - stage:
          backdrop: Beach
          stableId: backdropAction
          transition: {effect: crossfade, seconds: 0.5}
      - Hero.show: {skin: HeroIdle, x: 0, y: -20, scale: 100}
      - Hero.moveTo: {x: 10, y: 20, seconds: 1}
      - Hero.say: {text: こんにちは, seconds: 1}
      - wait: 1
      - wait: 2
      - goto: ending
  ending:
    - wait: 0
`;

function archive(project: Project | Record<string, unknown>) {
  return zipSync({
    'project.json': strToU8(JSON.stringify(project)),
    [`${costumeId}.svg`]: strToU8(costumeSvg),
  });
}
function authored(sourceText = source): Project {
  const result = authorDsl4BlockSourceSb3({
    baseBytes: archive({
      targets: [
        {
          name: 'Stage',
          isStage: true,
          blocks: {},
          variables: {},
          lists: {},
          broadcasts: {},
          costumes: [
            {
              name: 'blank',
              assetId: costumeId,
              md5ext: `${costumeId}.svg`,
              dataFormat: 'svg',
              bitmapResolution: 1,
              rotationCenterX: 240,
              rotationCenterY: 180,
            },
          ],
          sounds: [],
          comments: {},
          currentCostume: 0,
          volume: 100,
          layerOrder: 0,
          tempo: 60,
          videoTransparency: 50,
          videoState: 'on',
          textToSpeechLanguage: null,
        },
      ],
      extensions: ['kubohiroyakamishibai4'],
      monitors: [],
      meta: {semver: '3.0.0', vm: '0.2.0', agent: 'block script roundtrip test'},
    }),
    sourceText,
    sourceFrontend: frontend,
  });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics.slice(0, 6)));
  if (!result.ok) throw new Error('Authoring failed');
  return JSON.parse(strFromU8(unzipSync(result.bytes)['project.json']!)) as Project;
}
function blocksOf(project: Project): Blocks {
  return project.targets[0]!.blocks;
}
function blockWith(blocks: Blocks, opcode: string) {
  const entry = Object.entries(blocks).find(([, block]) => block.opcode === opcode);
  assert.ok(entry, `Missing block ${opcode}`);
  return entry;
}
function setInput(block: Blocks[string], name: string, value: unknown) {
  block.inputs[name] = [1, [10, value]];
}
function extracted(project: Project): string {
  return extractDsl4BlockSourcesFromProject(project).sources['Stage.k4.yml']!;
}
function comparable(text: string) {
  const result = frontend.parse(text, {sourceId: 'main'});
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics.slice(0, 6)));
  return serializeDsl4CanonicalDocument(result);
}

test('places real action blocks in scene substacks and retains metadata and optional arguments', () => {
  const project = authored();
  const blocks = blocksOf(project);
  assert.ok(Object.values(blocks).some(({opcode}) => opcode === `${runtimePrefix}stage`));
  assert.ok(Object.values(blocks).some(({opcode}) => opcode === `${runtimePrefix}say`));
  assert.ok(!Object.values(blocks).some(({opcode}) => opcode.endsWith('dsl4SourceFromYamlJson')));
  assert.ok(!JSON.stringify(blocks).includes(source));
  const scenes = Object.values(blocks).filter(({opcode}) => opcode === `${helperPrefix}scene`);
  assert.equal(scenes.length, 2);
  assert.ok(scenes.every(({inputs}) => Array.isArray(inputs.SUBSTACK)));
  assert.equal(comparable(extracted(project)), comparable(source));
  const decoded = parse(extracted(project));
  assert.ok(!Object.hasOwn(decoded.scenes.opening.actions[2]['Hero.moveTo'], 'easing'));
});

test('retains meaning for the comprehensive production fixture', async () => {
  const fixture = await readFile(
    new URL('fixtures/dsl4/valid/comprehensive.kamishibai.yaml', import.meta.url),
    'utf8',
  );
  assert.equal(comparable(extracted(authored(fixture))), comparable(fixture));
});

test('exports input edits, action reordering, insertion, deletion and scene renaming from the graph', async () => {
  const project = authored();
  const blocks = blocksOf(project);
  const [sceneId, scene] = blockWith(blocks, `${helperPrefix}scene`);
  setInput(scene, 'SCENE', 'editedOpening');
  const [, speech] = blockWith(blocks, `${runtimePrefix}say`);
  setInput(speech, 'SPEC', '{"text":"編集しました","seconds":3}');
  const [firstWaitId, firstWait] = blockWith(blocks, `${runtimePrefix}wait`);
  const secondWaitId = firstWait.next!;
  const secondWait = blocks[secondWaitId]!;
  const gotoId = secondWait.next!;
  const previousId = firstWait.parent!;
  // Swap the two waits using the same next/parent links that an editor saves.
  blocks[previousId]!.next = secondWaitId;
  secondWait.parent = previousId;
  secondWait.next = firstWaitId;
  firstWait.parent = secondWaitId;
  firstWait.next = 'insertedWait';
  setInput(firstWait, 'SECONDS', 9);
  // Insert a new wait and disconnect the goto; disconnected blocks are not part of the script.
  blocks.insertedWait = {
    ...firstWait,
    parent: firstWaitId,
    next: null,
    inputs: {SECONDS: [1, [4, 7]]},
  };
  blocks[gotoId]!.parent = null;
  blocks[gotoId]!.topLevel = true;
  assert.equal(blocks[sceneId], scene);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsl4-block-edit-'));
  try {
    const input = path.join(directory, 'edited.sb3');
    await writeFile(input, archive(project));
    const result = await exportDsl4BlockSourcesToYaml({
      input,
      outputDir: directory,
      name: 'edited',
      sourceFrontend: frontend,
      maxSourceBytes: 1024 * 1024,
    });
    const yaml = parse(await readFile(result.outputPath, 'utf8'));
    assert.deepEqual(Object.keys(yaml.scenes), ['editedOpening', 'ending']);
    const actions = yaml.scenes.editedOpening.actions;
    assert.deepEqual(actions[3], {'Hero.say': {text: '編集しました', seconds: 3}});
    assert.deepEqual(actions.slice(4), [{wait: 2}, {wait: 9}, {wait: 7}]);
    assert.deepEqual(yaml.scenes.editedOpening.entryTransition, {effect: 'cut'});
    assert.equal(actions[0].stage.stableId, 'backdropAction');
    assert.deepEqual(actions[0].stage.transition, {effect: 'crossfade', seconds: 0.5});
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('exports edits to optional properties, scene ordering and story metadata', () => {
  const project = authored();
  const blocks = blocksOf(project);
  const [, move] = blockWith(blocks, `${runtimePrefix}moveTo`);
  setInput(move, 'EASING', 'easeIn');
  const property = Object.values(blocks).find(
    (block) =>
      block.opcode === `${helperPrefix}property` &&
      JSON.stringify(block.inputs.PATH).includes('score'),
  )!;
  setInput(property, 'VALUE', '42');
  const [sceneId, scene] = blockWith(blocks, `${helperPrefix}scene`);
  const endingId = scene.next!;
  const ending = blocks[endingId]!;
  const previous = scene.parent!;
  blocks[previous]!.next = endingId;
  ending.parent = previous;
  ending.next = sceneId;
  scene.parent = endingId;
  scene.next = null;
  const yaml = parse(extracted(project));
  assert.deepEqual(Object.keys(yaml.scenes), ['ending', 'opening']);
  assert.equal(yaml.variables.score, 42);
  assert.equal(yaml.scenes.opening.actions[2]['Hero.moveTo'].easing, 'easeIn');
});

test('round-trips all 29 core actions using their own opcodes, including scalar/long arguments', () => {
  const actions = [
    {stage: {backdrop: 'Beach', stableId: 'stageId'}},
    {bgm: {sound: 'Music', restart: false, volume: 35}},
    {stopBgm: null},
    {setBgmVolume: 30},
    {sound: 'Sound'},
    {wait: {seconds: 2, stableId: 'waitId'}},
    {debugger: null},
    {broadcastMessageAndWait: 'hello'},
    {transition: {effect: 'fadeOut', seconds: 1}},
    {goto: 'ending'},
    {branch: 'branch'},
    {setVariable: {name: 'score', value: false}},
    {changeVariable: {name: 'score', by: -2}},
    {toggleVariable: 'flag'},
    {keyInputToChangeScene: {Space: 'ending'}},
    {touchInputToChangeScene: {Hero: 'ending'}},
    {poseInputToChangeScene: {routes: {Pose: 'ending'}, stableId: 'poseRoute'}},
    {imageInputToChangeScene: {Label: 'ending'}},
    {
      'Hero.show': {
        skin: 'Skin',
        x: 0,
        y: -10,
        scale: 80,
        transition: {effect: 'fadeOut', seconds: 1},
      },
    },
    {'Hero.hide': {transition: {effect: 'fadeOut', seconds: 1}}},
    {'Hero.setTransparency': {from: 0, to: 100, seconds: 1, stableId: 'fade'}},
    {'Hero.moveTo': {x: 1, y: 2, seconds: 3}},
    {'Hero.say': {text: 'Hello', seconds: 2}},
    {'Hero.think': {text: 'Hmm', waitFor: 'advance'}},
    {'Hero.setSkin': {skin: 'Skin', stableId: 'skinId'}},
    {'Hero.setLayer': {layer: 2, stableId: 'layerId'}},
    {'Hero.loop': {steps: [{skin: 'Skin', seconds: 1}], stableId: 'loopId'}},
    {'Caption.setText': {text: [{text: 'Rich text'}], stableId: 'textId'}},
    {'Hero.pose': {steps: [{pose: 'Pose'}], stableId: 'poseId'}},
  ];
  for (const form of ['runtime', 'bundle'] as const) {
    const blocks = createDsl4StructuredBlockSourceDeclaration({
      source: {kamishibai: '4.0', scenes: {opening: actions}},
      form,
      hatId: 'hat',
    });
    const project = {targets: [{isStage: true, name: 'Stage', blocks}]};
    const decoded = parse(extractDsl4BlockSourcesFromProject(project).sources['Stage.k4.yml']!);
    const output = decoded.scenes.opening;
    assert.equal(output.length, 29);
    for (const {command} of dsl4TurboWarpCoreActionBlockSpecs) {
      assert.ok(
        Object.values(blocks).some(({opcode}) =>
          opcode.endsWith(form === 'runtime' ? `_${command}` : `__${command}`),
        ),
        command,
      );
    }
    assert.deepEqual(output[0], actions[0]);
    assert.deepEqual(output[1], actions[1]);
    assert.deepEqual(output[2], {stopBgm: {}});
    assert.deepEqual(output[3], {setBgmVolume: {volume: 30}});
    assert.deepEqual(output[11], actions[11]);
    assert.deepEqual(output[14], {keyInputToChangeScene: {routes: {Space: 'ending'}}});
    for (const index of [5, 16, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28]) {
      assert.deepEqual(output[index], actions[index], `action ${index}`);
    }
  }
});

test('preserves custom action arguments as editable blocks', () => {
  const actions = [{'Hero.wave': {arguments: {count: 2}, stableId: 'wave'}}];
  const blocks = createDsl4StructuredBlockSourceDeclaration({
    source: {kamishibai: '4.0', scenes: {opening: actions}},
    form: 'bundle',
    hatId: 'hat',
  });
  const [, custom] = blockWith(blocks, `${helperPrefix}customAction`);
  setInput(custom, 'ARGUMENTS', '{"count":4}');
  const project = {targets: [{isStage: true, name: 'Stage', blocks}]};
  const yaml = parse(extractDsl4BlockSourcesFromProject(project).sources['Stage.k4.yml']!);
  assert.deepEqual(yaml.scenes.opening, [{'Hero.wave': {arguments: {count: 4}, stableId: 'wave'}}]);
});

test('ships editor definitions for scenes and option substacks without relying on a newer base', () => {
  const project = authored();
  assert.ok(project.extensions.includes(dsl4BlockAuthoringExtensionId));
  const url = project.extensionURLs[dsl4BlockAuthoringExtensionId]!;
  assert.match(url, /^data:text\/javascript;base64,/u);
  let info: {id: string; blocks: {opcode: string; branchCount?: number}[]} | undefined;
  runInNewContext(Buffer.from(url.split(',')[1]!, 'base64').toString('utf8'), {
    Scratch: {
      extensions: {
        register(extension: {getInfo(): typeof info}) {
          info = extension.getInfo();
        },
      },
    },
  });
  assert.equal(info?.id, dsl4BlockAuthoringExtensionId);
  for (const opcode of ['scene', 'actionOptions']) {
    assert.equal(info?.blocks.find((block) => block.opcode === opcode)?.branchCount, 1);
  }
});

test('retains editable scenes and labeled includes through a pinned TurboWarp VM load, edit and resave', async () => {
  const require = createRequire(import.meta.url);
  const VirtualMachine = require('scratch-vm');
  const Scratch = {
    BlockType: require('scratch-vm/src/extension-support/block-type'),
    ArgumentType: require('scratch-vm/src/extension-support/argument-type'),
  };
  const core = createDsl4TurboWarpCoreActionBlockSurface(Scratch, {visible: true});
  const sourceBlocks = createDsl4TurboWarpBlockSourceSurface(Scratch, {visible: true});
  const definitions = [...sourceBlocks.blocks, ...core.blocks].map((block) => ({
    ...block,
    opcode: `kubohiroyakamishibairuntime4__${block.opcode}`,
  }));
  const info = {
    id: 'kubohiroyakamishibai4',
    name: 'Runtime action palette fixture',
    blocks: definitions,
    menus: core.menus,
  };
  const infoJson = JSON.stringify(info)
    .replaceAll('dsl4TransitionEffect', 'kubohiroyakamishibairuntime4__dsl4TransitionEffect')
    .replaceAll('dsl4MoveEasing', 'kubohiroyakamishibairuntime4__dsl4MoveEasing')
    .replaceAll('dsl4VariableValueType', 'kubohiroyakamishibairuntime4__dsl4VariableValueType');
  const runtime =
    'Scratch.extensions.register(Object.assign({getInfo(){return ' +
    infoJson +
    ';}},Object.fromEntries(' +
    JSON.stringify(definitions.map(({opcode}) => opcode)) +
    '.map(opcode=>[opcode,()=>false]))));';
  const vmSource =
    source +
    '    - setVariable: {name: score, value: 5}\n    - transition: {effect: fadeOut, seconds: 1}\n';
  const project = authored(vmSource);
  project.extensionURLs.kubohiroyakamishibai4 =
    'data:text/javascript;base64,' + Buffer.from(runtime).toString('base64');
  const names = ['document', 'location', 'Scratch', 'ScratchExtensions'] as const;
  const previous = names.map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  Object.defineProperties(globalThis, {
    document: {
      configurable: true,
      value: {
        visibilityState: 'visible',
        scripts: [],
        addEventListener() {},
        removeEventListener() {},
        createElement() {
          return {src: '', onerror: null};
        },
        body: {
          appendChild(script: {src: string; onerror?: (error: unknown) => void}) {
            try {
              runInThisContext(Buffer.from(script.src.split(',')[1]!, 'base64').toString('utf8'));
            } catch (error) {
              script.onerror?.(error);
            }
          },
        },
      },
    },
    location: {configurable: true, value: {href: 'https://blocks.test/'}},
  });
  const vm = new VirtualMachine();
  try {
    const ScratchStorage = require('@turbowarp/scratch-storage');
    vm.attachStorage(new ScratchStorage());
    vm.securityManager.canLoadExtensionFromProject = () => true;
    vm.securityManager.getSandboxMode = () => 'unsandboxed';
    await vm.loadProject(archive(project));
    assert.equal(comparable(extracted(JSON.parse(vm.toJSON()))), comparable(vmSource));
    const definitions: {type: string; [key: string]: unknown}[] = vm.runtime.getBlocksJSON();
    for (const opcode of ['scene', 'actionOptions']) {
      const definition = definitions.find(({type}) => type === `${helperPrefix}${opcode}`);
      assert.ok(definition);
      assert.ok(
        Object.values(definition).some(
          (value) =>
            Array.isArray(value) &&
            value.some((entry) => entry?.type === 'input_statement' && entry?.name === 'SUBSTACK'),
        ),
      );
    }
    const stage = vm.runtime.getTargetForStage();
    const [waitId] = blockWith(blocksOf(project), `${runtimePrefix}wait`);
    const wait = stage.blocks.getBlock(waitId);
    stage.blocks.changeBlock({
      id: wait.inputs.SECONDS.block,
      element: 'field',
      name: 'NUM',
      value: '12',
    });
    const transitionMenu = Object.keys(blocksOf(project)).find(
      (id) =>
        blocksOf(project)[id]!.opcode ===
        'kubohiroyakamishibai4_menu_kubohiroyakamishibairuntime4__dsl4TransitionEffect',
    )!;
    stage.blocks.changeBlock({
      id: transitionMenu,
      element: 'field',
      name: 'kubohiroyakamishibairuntime4__dsl4TransitionEffect',
      value: 'fadeUp',
    });
    const saved = JSON.parse(vm.toJSON()) as Project;
    const yaml = parse(extracted(saved));
    assert.equal(yaml.scenes.opening.actions[4].wait, 12);
    assert.equal(yaml.scenes.ending[2].transition.effect, 'fadeUp');
    assert.equal(
      saved.extensionURLs[dsl4BlockAuthoringExtensionId],
      project.extensionURLs[dsl4BlockAuthoringExtensionId],
    );
    const savedBlocks = blocksOf(saved);
    const moduleBlocks = createDsl4StructuredBlockSourceDeclaration({
      source: {scenes: {shared: [{wait: 1}]}},
      form: 'bundle',
      hatId: 'sharedHat',
      idPrefix: 'shared-',
      label: '共通',
    });
    const [rootId, root] = blockWith(savedBlocks, `${helperPrefix}kamishibai`);
    const previousFirst = root.next!;
    Object.assign(savedBlocks, moduleBlocks, {
      includeShared: {
        opcode: `${helperPrefix}includeBlocks`,
        parent: rootId,
        next: previousFirst,
        inputs: {LABEL: [1, [10, '共通']]},
        fields: {},
        shadow: false,
        topLevel: false,
      },
    });
    root.next = 'includeShared';
    savedBlocks[previousFirst]!.parent = 'includeShared';
    await vm.loadProject(archive(saved));
    const reloaded = vm.runtime.getTargetForStage();
    for (const id of ['sharedHat', 'includeShared']) {
      const block = reloaded.blocks.getBlock(id);
      reloaded.blocks.changeBlock({
        id: block.inputs.LABEL.block,
        element: 'field',
        name: 'TEXT',
        value: '共通更新',
      });
    }
    const [sharedWaitId] = blockWith(moduleBlocks, `${runtimePrefix}wait`);
    reloaded.blocks.changeBlock({
      id: reloaded.blocks.getBlock(sharedWaitId).inputs.SECONDS.block,
      element: 'field',
      name: 'NUM',
      value: '9',
    });
    const savedIncludes = JSON.parse(vm.toJSON()) as Project;
    const sourceSet = extractDsl4BlockSourcesFromProject(savedIncludes);
    const modulePath = parse(sourceSet.sources[sourceSet.entryPath]!).include[0];
    assert.deepEqual(parse(sourceSet.sources[modulePath]!).scenes.shared, [{wait: 9}]);
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'dsl4-vm-includes-'));
    try {
      const input = path.join(temporary, 'edited.sb3');
      await writeFile(input, archive(savedIncludes));
      const exported = await exportDsl4BlockSourcesToYaml({
        input,
        outputDir: temporary,
        name: 'edited',
        sourceFrontend: frontend,
        maxSourceBytes: 1024 * 1024,
      });
      const yamlFiles = unzipSync(await readFile(exported.outputPath));
      assert.deepEqual(parse(strFromU8(yamlFiles[`edited-k4/${modulePath}`]!)).scenes.shared, [
        {wait: 9},
      ]);
    } finally {
      await rm(temporary, {recursive: true, force: true});
    }
  } finally {
    vm.quit();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

test('rejects cycles, broken parents, missing blocks, unknown opcodes and duplicate scenes', () => {
  const mutations: ((blocks: Blocks) => void)[] = [
    (blocks) => {
      blockWith(blocks, `${runtimePrefix}wait`)[1].inputs.SECONDS = [
        3,
        [12, 'score', 'variableId'],
        [4, '0'],
      ];
    },
    (blocks) => {
      const [id, block] = blockWith(blocks, `${runtimePrefix}wait`);
      block.next = id;
    },
    (blocks) => {
      blockWith(blocks, `${runtimePrefix}wait`)[1].parent = 'wrong';
    },
    (blocks) => {
      delete blocks[blockWith(blocks, `${runtimePrefix}wait`)[0]];
    },
    (blocks) => {
      blockWith(blocks, `${runtimePrefix}wait`)[1].opcode = 'unrecognized';
    },
    (blocks) => {
      const [, scene] = blockWith(blocks, `${helperPrefix}scene`);
      setInput(blocks[scene.next!]!, 'SCENE', 'opening');
    },
    (blocks) => {
      setInput(
        blockWith(blocks, `${helperPrefix}actionOptions`)[1],
        'PROPERTIES',
        '{"arguments":{"backdrop":"stale"}}',
      );
    },
    (blocks) => {
      setInput(blockWith(blocks, `${helperPrefix}scene`)[1], 'PROPERTIES', '{"actions":[]}');
    },
  ];
  for (const mutate of mutations) {
    const project = authored();
    mutate(blocksOf(project));
    assert.throws(() => extracted(project));
  }
});

test('rejects invalid edits during YAML export and leaves no plausible output', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsl4-block-invalid-'));
  try {
    for (const [index, value] of ['-1', 'not a number'].entries()) {
      const project = authored();
      setInput(blockWith(blocksOf(project), `${runtimePrefix}wait`)[1], 'SECONDS', value);
      const input = path.join(directory, `invalid${index}.sb3`);
      await writeFile(input, archive(project));
      await assert.rejects(
        exportDsl4BlockSourcesToYaml({
          input,
          outputDir: directory,
          name: `invalid${index}`,
          sourceFrontend: frontend,
          maxSourceBytes: 1024 * 1024,
        }),
      );
      await assert.rejects(readFile(path.join(directory, `invalid${index}.k4.yml`)), {
        code: 'ENOENT',
      });
    }
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
