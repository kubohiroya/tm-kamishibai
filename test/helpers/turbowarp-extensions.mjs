import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';

const require = createRequire(import.meta.url);
const BlockType = require('scratch-vm/src/extension-support/block-type');
const Cast = require('scratch-vm/src/util/cast');
const assetManagerSource = readFileSync(
  new URL('../../app/extensions/twAssetManager.js', import.meta.url),
  'utf8',
);

function block(opcode, blockType = BlockType.COMMAND, argumentNames = []) {
  return {
    opcode,
    blockType,
    text: opcode,
    arguments: Object.fromEntries(argumentNames.map((name) => [name, {
      type: 'string',
      defaultValue: '',
    }])),
  };
}

function extensionInfo(id, blocks) {
  return {id, name: id, blocks};
}

function register(vm, id, ExtensionClass) {
  vm.extensionManager.addBuiltinExtension(id, ExtensionClass);
}

function createProductionAssetManagerClass(vm, onCreate) {
  let registeredExtension = null;
  const Scratch = {
    vm,
    extensions: {
      unsandboxed: true,
      register(extension) {
        registeredExtension = extension;
      },
    },
    BlockType,
    ArgumentType: {
      NUMBER: 'number',
      STRING: 'string',
    },
    translate(value) {
      return typeof value === 'object' && value !== null
        ? value.default ?? value.defaultMessage ?? ''
        : value;
    },
  };
  runInNewContext(assetManagerSource, {
    AbortSignal,
    Audio: class {},
    Blob,
    console,
    fetch,
    indexedDB: {},
    performance,
    Response,
    Scratch,
    setTimeout,
    clearTimeout,
    URL,
  });
  if (!registeredExtension) {
    throw new Error('Production Asset Manager did not register itself.');
  }
  const ProductionAssetManager = registeredExtension.constructor;
  return class {
    constructor() {
      const extension = new ProductionAssetManager();
      onCreate(extension);
      return extension;
    }
  };
}

export function registerKamishibaiTestExtensions(
  vm,
  clock,
  {productionAssetManager = false} = {},
) {
  const state = {
    actorSequences: new Map(),
    actorSkins: new Map(),
    assetManager: null,
    assetRegistrations: [],
    asyncInput: null,
    assets: new Map(),
    bubbleUpdates: [],
    consoleErrors: [],
    displayedAssets: new Map(),
    displayedAssetHistory: [],
    displayedText: new Map(),
    filePickerRequests: 0,
    keyInputBindings: new Map(),
    localStorage: new Map(),
    loadingAssetCount: 0,
    loadingCostumes: [],
    playingSounds: new Set(),
    runtimeVariableWrites: [],
    timers: new Map(),
    tempVariables: null,
    textColors: new Map(),
    textOutlineColors: new Map(),
    textOutlineWidths: new Map(),
    touchInputBindings: new Map(),
  };
  vm.runtime.on('SAY', (target, type, text) => {
    state.bubbleUpdates.push({
      targetName: target.getName(),
      text: Cast.toString(text),
      type,
    });
  });

  class ConsoleExtension {
    getInfo() {
      return extensionInfo('sipcconsole', [
        block('Emptying'),
        block('Error', BlockType.COMMAND, ['string']),
        block('Journal', BlockType.COMMAND, ['string']),
        block('debug', BlockType.COMMAND, ['string']),
      ]);
    }
    Emptying() {}
    Error(args) {
      state.consoleErrors.push(Cast.toString(args.string));
    }
    Journal() {}
    debug() {}
  }

  class TempVariablesExtension {
    constructor(runtime) {
      this.runtimeVariables = Object.create(null);
      state.tempVariables = this;
      runtime.on('PROJECT_START', () => this.resetRuntimeVariables());
      runtime.on('PROJECT_STOP_ALL', () => this.resetRuntimeVariables());
    }
    getInfo() {
      return extensionInfo('lmsTempVars2', [
        block('setThreadVariable', BlockType.COMMAND, ['VAR', 'STRING']),
        block('changeThreadVariable', BlockType.COMMAND, ['VAR', 'NUM']),
        block('getThreadVariable', BlockType.REPORTER, ['VAR']),
        block('setRuntimeVariable', BlockType.COMMAND, ['VAR', 'STRING']),
        block('changeRuntimeVariable', BlockType.COMMAND, ['VAR', 'NUM']),
        block('getRuntimeVariable', BlockType.REPORTER, ['VAR']),
        block('runtimeVariableExists', BlockType.BOOLEAN, ['VAR']),
        block('deleteRuntimeVariable', BlockType.COMMAND, ['VAR']),
      ]);
    }
    threadVariables(util) {
      if (!util.thread.variables) {
        util.thread.variables = Object.create(null);
      }
      return util.thread.variables;
    }
    setThreadVariable(args, util) {
      this.threadVariables(util)[args.VAR] = args.STRING;
    }
    changeThreadVariable(args, util) {
      const variables = this.threadVariables(util);
      variables[args.VAR] = Cast.toNumber(variables[args.VAR]) + Cast.toNumber(args.NUM);
    }
    getThreadVariable(args, util) {
      return this.threadVariables(util)[args.VAR] ?? '';
    }
    setRuntimeVariable(args) {
      this.runtimeVariables[args.VAR] = args.STRING;
      state.runtimeVariableWrites.push({
        name: Cast.toString(args.VAR),
        value: Cast.toString(args.STRING),
      });
    }
    changeRuntimeVariable(args) {
      this.runtimeVariables[args.VAR]
        = Cast.toNumber(this.runtimeVariables[args.VAR]) + Cast.toNumber(args.NUM);
    }
    getRuntimeVariable(args) {
      return this.runtimeVariables[args.VAR] ?? '';
    }
    runtimeVariableExists(args) {
      return Object.hasOwn(this.runtimeVariables, args.VAR);
    }
    deleteRuntimeVariable(args) {
      Reflect.deleteProperty(this.runtimeVariables, args.VAR);
    }
    resetRuntimeVariables() {
      this.runtimeVariables = Object.create(null);
      state.runtimeVariableWrites.length = 0;
    }
  }

  class StringsExtension {
    getInfo() {
      return extensionInfo('strings', [
        block('count', BlockType.REPORTER, ['SUBSTRING', 'STRING']),
        block('identical', BlockType.BOOLEAN, ['OPERAND1', 'OPERAND2']),
        block('indexof', BlockType.REPORTER, ['SUBSTRING', 'STRING']),
        block('letters_of', BlockType.REPORTER, ['LETTER1', 'LETTER2', 'STRING']),
        block('menu_positions', BlockType.REPORTER),
        block('menu_trimMethod', BlockType.REPORTER),
        block('posWith', BlockType.BOOLEAN, ['STRING', 'POSITION', 'SUBSTRING']),
        block('replaceRegex', BlockType.REPORTER, ['REGEX', 'FLAGS', 'STRING', 'REPLACE']),
        block('split', BlockType.REPORTER, ['ITEM', 'STRING', 'SPLIT']),
        block('trim', BlockType.REPORTER, ['STRING', 'METHOD']),
      ]);
    }
    count(args) {
      const string = Cast.toString(args.STRING);
      const substring = Cast.toString(args.SUBSTRING);
      return substring ? string.split(substring).length - 1 : 0;
    }
    identical(args) {
      return Cast.toString(args.OPERAND1) === Cast.toString(args.OPERAND2);
    }
    indexof(args) {
      const index = Cast.toString(args.STRING).indexOf(Cast.toString(args.SUBSTRING));
      return index < 0 ? 0 : index + 1;
    }
    letters_of(args) {
      const string = Cast.toString(args.STRING);
      const first = Math.max(1, Math.trunc(Cast.toNumber(args.LETTER1)));
      const last = Math.max(first, Math.trunc(Cast.toNumber(args.LETTER2)));
      return string.slice(first - 1, last);
    }
    menu_positions(args) {
      return args.positions ?? '';
    }
    menu_trimMethod(args) {
      return args.trimMethod ?? '';
    }
    posWith(args) {
      const string = Cast.toString(args.STRING);
      const substring = Cast.toString(args.SUBSTRING);
      return args.POSITION === 'ends'
        ? string.endsWith(substring)
        : string.startsWith(substring);
    }
    replaceRegex(args) {
      return Cast.toString(args.STRING).replace(
        new RegExp(Cast.toString(args.REGEX), Cast.toString(args.FLAGS)),
        Cast.toString(args.REPLACE),
      );
    }
    split(args) {
      const parts = Cast.toString(args.STRING).split(Cast.toString(args.SPLIT));
      return parts[Math.trunc(Cast.toNumber(args.ITEM)) - 1] ?? '';
    }
    trim(args) {
      const string = Cast.toString(args.STRING);
      if (args.METHOD === 'left') return string.trimStart();
      if (args.METHOD === 'right') return string.trimEnd();
      return string.trim();
    }
  }

  class AssetManagerExtension {
    constructor(runtime) {
      this.runtime = runtime;
      const resetState = () => {
        state.actorSequences.clear();
        state.actorSkins.clear();
        state.assetRegistrations.length = 0;
        state.displayedAssets.clear();
        state.displayedAssetHistory.length = 0;
        state.loadingAssetCount = 0;
        state.loadingCostumes = [];
        state.playingSounds.clear();
      };
      runtime.on('PROJECT_START', resetState);
      runtime.on('PROJECT_STOP_ALL', resetState);
    }
    getInfo() {
      return extensionInfo('twAssetManager', [
        block('isLoaded', BlockType.BOOLEAN, ['NAME']),
        block('playSound', BlockType.COMMAND, ['NAME']),
        block('playSoundUntilDone', BlockType.COMMAND, ['NAME']),
        block('registerAsset', BlockType.COMMAND, ['RESOURCE_ID', 'NAME']),
        block('setLoadingCostumes', BlockType.COMMAND, ['NAMES']),
        block('prepareLoadingAssets', BlockType.COMMAND, ['LIST']),
        block('loadingAssetCount', BlockType.REPORTER),
        block('loadingCostumeAt', BlockType.REPORTER, ['INDEX']),
        block('setTextStyle', BlockType.COMMAND, ['NAME', 'PROPERTY', 'VALUE']),
        block('setTextValue', BlockType.COMMAND, ['NAME', 'VALUE']),
        block('setStageSkin', BlockType.COMMAND, ['NAME']),
        block('setThisSpriteSkin', BlockType.COMMAND, ['NAME']),
        block('startActorLoop', BlockType.COMMAND, ['ACTOR', 'ASSETS', 'DURATIONS']),
        block('startActorSequence', BlockType.COMMAND, ['ACTOR', 'ASSETS', 'DURATIONS']),
        block('finishAllActorSequences'),
        block('stopSound', BlockType.COMMAND, ['NAME']),
        block('stopAllSounds'),
      ]);
    }
    registerAsset(args) {
      const name = Cast.toString(args.NAME);
      state.assetRegistrations.push(name);
      state.assets.set(name, Cast.toString(args.RESOURCE_ID));
    }
    setLoadingCostumes(args) {
      const seen = new Set();
      state.loadingCostumes = Cast.toString(args.NAMES)
        .split(',')
        .map((name) => name.trim())
        .filter((name) => {
          if (!name || seen.has(name)) return false;
          seen.add(name);
          return true;
        });
      state.loadingAssetCount = 0;
    }
    prepareLoadingAssets(args, util) {
      const listName = Cast.toString(args.LIST).trim();
      const list = util.target.lookupVariableByNameAndType(listName, 'list');
      if (!list || !Array.isArray(list.value)) {
        throw new Error(`Loading asset list not found: ${listName || '(empty)'}`);
      }
      const loadingNames = new Set(state.loadingCostumes);
      const entries = list.value.map((entry) => Cast.toString(entry));
      const declaredNames = new Set(entries.map((entry) => {
        const separatorIndex = entry.indexOf(',');
        return (separatorIndex < 0 ? entry : entry.slice(0, separatorIndex)).trim();
      }));
      const missingNames = state.loadingCostumes.filter((name) => !declaredNames.has(name));
      if (missingNames.length > 0) {
        throw new Error(`Loading asset is not declared: ${missingNames.join(', ')}`);
      }
      const prioritized = [];
      const regular = [];
      for (const entry of entries) {
        const separatorIndex = entry.indexOf(',');
        const assetName = (separatorIndex < 0 ? entry : entry.slice(0, separatorIndex)).trim();
        (loadingNames.has(assetName) ? prioritized : regular).push(entry);
      }
      list.value.splice(0, list.value.length, ...prioritized, ...regular);
      state.loadingAssetCount = prioritized.length;
    }
    loadingAssetCount() {
      return state.loadingAssetCount;
    }
    loadingCostumeAt(args) {
      if (state.loadingCostumes.length === 0) return '';
      const index = Math.max(1, Math.trunc(Cast.toNumber(args.INDEX)));
      return state.loadingCostumes[(index - 1) % state.loadingCostumes.length];
    }
    setTextStyle() {}
    setTextValue(args) {
      const name = Cast.toString(args.NAME);
      const resource = state.assets.get(name);
      if (
        resource !== undefined
        && resource !== 'text'
        && !resource.startsWith('text:')
      ) {
        throw new Error(`Asset is not text: ${name}`);
      }
      const explicitName = resource?.startsWith('text:')
        ? resource.slice('text:'.length).trim()
        : '';
      const value = Cast.toString(args.VALUE);
      state.tempVariables.setRuntimeVariable({
        VAR: `text:${explicitName || name}`,
        STRING: value,
      });
      for (const [targetId, displayedName] of state.displayedAssets) {
        if (displayedName === name) state.displayedText.set(targetId, value);
      }
    }
    isLoaded(args) {
      return state.assets.has(Cast.toString(args.NAME));
    }
    resolveCostumeName(name) {
      const resource = state.assets.get(Cast.toString(name)) ?? '';
      if (resource === 'backdrop' || resource === 'costume') return Cast.toString(name);
      const parts = resource.split(':');
      return parts.at(-1) || Cast.toString(name);
    }
    applyCostume(target, name) {
      state.displayedAssets.set(target.id, Cast.toString(name));
      state.displayedAssetHistory.push({
        assetName: Cast.toString(name),
        targetName: target.getName(),
      });
      const costumeName = this.resolveCostumeName(name);
      const index = target.getCostumes().findIndex((costume) => costume.name === costumeName);
      if (index >= 0) target.setCostume(index);
      const actorName = target.lookupVariableByNameAndType?.('actorName', '')?.value;
      if (actorName) state.actorSkins.set(actorName, Cast.toString(name));
    }
    setStageSkin(args) {
      this.applyCostume(this.runtime.getTargetForStage(), args.NAME);
    }
    setThisSpriteSkin(args, util) {
      const name = Cast.toString(args.NAME);
      const resource = state.assets.get(name);
      if (resource === 'text' || resource?.startsWith('text:')) {
        const explicitName = resource.startsWith('text:')
          ? resource.slice('text:'.length).trim()
          : '';
        state.displayedAssets.set(util.target.id, name);
        state.displayedText.set(
          util.target.id,
          state.tempVariables.getRuntimeVariable({
            VAR: `text:${explicitName || name}`,
          }),
        );
        return;
      }
      this.applyCostume(util.target, name);
    }
    playSound(args) {
      state.playingSounds.add(Cast.toString(args.NAME));
    }
    playSoundUntilDone(args, util) {
      const name = Cast.toString(args.NAME);
      if (!util.stackFrame.started) {
        util.stackFrame.started = true;
        state.playingSounds.add(name);
      }
      if (state.playingSounds.has(name)) util.yield();
    }
    stopAllSounds() {
      state.playingSounds.clear();
    }
    stopSound(args) {
      state.playingSounds.delete(Cast.toString(args.NAME));
    }
    startActorLoop() {}
    startActorSequence(args) {
      const actor = Cast.toString(args.ACTOR);
      const assets = Cast.toString(args.ASSETS).split(',').map((name) => name.trim());
      state.actorSequences.set(actor, assets.at(-1));
      if (assets[0]) state.actorSkins.set(actor, assets[0]);
    }
    finishAllActorSequences() {
      for (const [actor, finalAsset] of state.actorSequences) {
        state.actorSkins.set(actor, finalAsset);
      }
      state.actorSequences.clear();
    }
  }

  class PoseExtension {
    getInfo() {
      return extensionInfo('tmpose', [
        block('currentPoseReporter', BlockType.REPORTER),
        block('hidePreview'),
        block('isModelLoaded', BlockType.BOOLEAN),
        block('isPoseWithThreshold', BlockType.BOOLEAN, ['NAME', 'THRESHOLD']),
        block('lastErrorReporter', BlockType.REPORTER),
        block('loadModel'),
        block('menu_positionMenu', BlockType.REPORTER),
        block('poseScoreReporter', BlockType.REPORTER, ['NAME']),
        block('scoreReporter', BlockType.REPORTER),
        block('setModelURL', BlockType.COMMAND, ['URL']),
        block('setPreviewOpacity', BlockType.COMMAND, ['OPACITY']),
        block('setPreviewPosition', BlockType.COMMAND, ['POSITION']),
        block('showPreview'),
        block('startCamera'),
        block('startPredict'),
        block('stopCamera'),
        block('stopPredict'),
      ]);
    }
    currentPoseReporter() { return ''; }
    hidePreview() {}
    isModelLoaded() { return true; }
    isPoseWithThreshold() { return false; }
    lastErrorReporter() { return ''; }
    loadModel() {}
    menu_positionMenu(args) { return args.positionMenu ?? 'top-left'; }
    poseScoreReporter() { return 0; }
    scoreReporter() { return 0; }
    setModelURL() {}
    setPreviewOpacity() {}
    setPreviewPosition() {}
    showPreview() {}
    startCamera() {}
    startPredict() {}
    stopCamera() {}
    stopPredict() {}
  }

  class LocalStorageExtension {
    getInfo() {
      return extensionInfo('localstorage', [
        block('get', BlockType.REPORTER, ['KEY']),
        block('set', BlockType.COMMAND, ['KEY', 'VALUE']),
        block('setProjectId', BlockType.COMMAND, ['ID']),
      ]);
    }
    get(args) { return state.localStorage.get(Cast.toString(args.KEY)) ?? ''; }
    set(args) { state.localStorage.set(Cast.toString(args.KEY), args.VALUE); }
    setProjectId() {}
  }

  class TextLinesExtension {
    constructor(runtime) {
      this.runtime = runtime;
    }
    getInfo() {
      return extensionInfo('kubohiroyatextlines', [
        block('menu_LIST_MENU', BlockType.REPORTER),
        block('writeLinesToList', BlockType.COMMAND, ['TEXT', 'LIST']),
      ]);
    }
    menu_LIST_MENU(args) { return args.LIST_MENU ?? ''; }
    writeLinesToList(args, util) {
      const listName = Cast.toString(args.LIST);
      const stage = this.runtime.getTargetForStage();
      const list = util.target.lookupVariableById(listName)
        ?? stage?.lookupVariableById(listName)
        ?? util.target.lookupVariableByNameAndType(listName, 'list')
        ?? stage?.lookupVariableByNameAndType(listName, 'list');
      if (!list) throw new Error(`List not found: ${listName}`);
      list.value = Cast.toString(args.TEXT).split(/\r\n|\n|\r/u);
    }
  }

  class RuntimeExpressionExtension {
    constructor(runtime) {
      this.runtime = runtime;
    }
    getInfo() {
      return extensionInfo('twRuntimeExpression', [
        block('runtimeCondition', BlockType.BOOLEAN, ['EXPRESSION']),
      ]);
    }
    runtimeCondition(args) {
      const expression = Cast.toString(args.EXPRESSION).trim();
      if (expression === 'true') return true;
      if (expression === 'false' || !expression) return false;
      return Cast.toBoolean(
        this.runtime.ext_lmsTempVars2.getRuntimeVariable({VAR: expression}),
      );
    }
  }

  class AsyncInputExtension {
    constructor(runtime) {
      this.runtime = runtime;
      state.asyncInput = this;
      const reset = () => {
        state.keyInputBindings.clear();
        state.touchInputBindings.clear();
      };
      runtime.on('PROJECT_START', reset);
      runtime.on('PROJECT_STOP_ALL', reset);
    }
    getInfo() {
      return extensionInfo('twAsyncInput', [
        block('listenForKeyAndBroadcast', BlockType.COMMAND, [
          'KEY_ID', 'RUNTIME_VAR', 'VALUE', 'MESSAGE',
        ]),
        block('listenForActorTouchAndBroadcast', BlockType.COMMAND, [
          'ACTOR', 'RUNTIME_VAR', 'VALUE', 'MESSAGE',
        ]),
        block('stopAllInputListeners'),
        block('stopAllKeyListeners'),
      ]);
    }
    listenForKeyAndBroadcast(args, util) {
      state.keyInputBindings.set(Cast.toString(args.KEY_ID), {
        ...args,
        ownerTargetId: util.target.id,
      });
    }
    listenForActorTouchAndBroadcast(args, util) {
      state.touchInputBindings.set(Cast.toString(args.ACTOR), {
        ...args,
        ownerTargetId: util.target.id,
      });
    }
    stopAllInputListeners(_args, util) {
      this.removeOwnedBindings(state.keyInputBindings, util.target.id);
      this.removeOwnedBindings(state.touchInputBindings, util.target.id);
    }
    stopAllKeyListeners(_args, util) {
      this.removeOwnedBindings(state.keyInputBindings, util.target.id);
    }
    emitKey(keyId) {
      this.emit(state.keyInputBindings.get(keyId));
    }
    emitActorTouch(actorName) {
      this.emit(state.touchInputBindings.get(actorName));
    }
    emit(binding) {
      if (!binding) return;
      this.runtime.ext_lmsTempVars2.setRuntimeVariable({
        VAR: binding.RUNTIME_VAR,
        STRING: binding.VALUE,
      });
      this.runtime.startHats('event_whenbroadcastreceived', {
        BROADCAST_OPTION: binding.MESSAGE,
      });
    }
    removeOwnedBindings(bindings, ownerTargetId) {
      for (const [key, binding] of bindings) {
        if (binding.ownerTargetId === ownerTargetId) bindings.delete(key);
      }
    }
  }

  class TimersExtension {
    constructor(runtime) {
      runtime.on('PROJECT_START', () => state.timers.clear());
      runtime.on('PROJECT_STOP_ALL', () => state.timers.clear());
    }
    getInfo() {
      return extensionInfo('lmsTimers', [
        block('removeTimer', BlockType.COMMAND, ['TIMER']),
        block('startResetTimer', BlockType.COMMAND, ['TIMER']),
        block('valueOfTimer', BlockType.REPORTER, ['TIMER']),
      ]);
    }
    removeTimer(args) { state.timers.delete(Cast.toString(args.TIMER)); }
    startResetTimer(args) { state.timers.set(Cast.toString(args.TIMER), clock.now); }
    valueOfTimer(args) {
      const start = state.timers.get(Cast.toString(args.TIMER));
      return start === undefined ? '' : (clock.now - start) / 1000;
    }
  }

  class FilesExtension {
    getInfo() {
      return extensionInfo('files', [
        block('menu_automaticallyOpen', BlockType.REPORTER),
        block('menu_encoding', BlockType.REPORTER),
        block('setOpenMode', BlockType.COMMAND, ['mode']),
        block('showPickerExtensionsAs', BlockType.COMMAND, ['extension', 'as']),
      ]);
    }
    menu_automaticallyOpen(args) { return args.automaticallyOpen ?? ''; }
    menu_encoding(args) { return args.encoding ?? ''; }
    setOpenMode() {}
    showPickerExtensionsAs() {
      state.filePickerRequests += 1;
      return '';
    }
  }

  class TextExtension {
    getInfo() {
      return extensionInfo('text', [
        block('setText', BlockType.COMMAND, ['TEXT']),
        block('animateText', BlockType.COMMAND, ['ANIMATE', 'TEXT']),
        block('setFont', BlockType.COMMAND, ['FONT']),
        block('setColor', BlockType.COMMAND, ['COLOR']),
        block('setWidth', BlockType.COMMAND, ['WIDTH', 'ALIGN']),
        block('setOutlineWidth', BlockType.COMMAND, ['WIDTH']),
        block('setOutlineColor', BlockType.COMMAND, ['COLOR']),
      ]);
    }
    setText(args, util) {
      state.displayedText.set(util.target.id, Cast.toString(args.TEXT));
    }
    animateText(args, util) {
      state.displayedText.set(util.target.id, Cast.toString(args.TEXT));
    }
    setFont() {}
    setColor(args, util) {
      state.textColors.set(util.target.id, Cast.toString(args.COLOR));
    }
    setWidth() {}
    setOutlineWidth(args, util) {
      state.textOutlineWidths.set(util.target.id, Cast.toNumber(args.WIDTH));
    }
    setOutlineColor(args, util) {
      state.textOutlineColors.set(util.target.id, Cast.toString(args.COLOR));
    }
  }

  register(vm, 'sipcconsole', ConsoleExtension);
  register(vm, 'lmsTempVars2', TempVariablesExtension);
  register(vm, 'strings', StringsExtension);
  register(
    vm,
    'twAssetManager',
    productionAssetManager
      ? createProductionAssetManagerClass(vm, (extension) => {
        state.assetManager = extension;
      })
      : AssetManagerExtension,
  );
  register(vm, 'tmpose', PoseExtension);
  register(vm, 'localstorage', LocalStorageExtension);
  register(vm, 'kubohiroyatextlines', TextLinesExtension);
  register(vm, 'twRuntimeExpression', RuntimeExpressionExtension);
  register(vm, 'twAsyncInput', AsyncInputExtension);
  register(vm, 'lmsTimers', TimersExtension);
  register(vm, 'files', FilesExtension);
  register(vm, 'text', TextExtension);

  return state;
}
