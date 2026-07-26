import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';

import {defaultKamishibaiSb3Path} from './sb3-project.mjs';
import {registerKamishibaiTestExtensions} from './turbowarp-extensions.mjs';

const require = createRequire(import.meta.url);
const VirtualMachine = require('scratch-vm');
const vmLog = require('scratch-vm/src/util/log');

export const turbowarpVmCommit = 'c4823421cb7c17d8d8a89878851ce1668c26a21f';

export class KamishibaiVmHarness {
  constructor(vm, clock, extensionState) {
    this.vm = vm;
    this.clock = clock;
    this.extensionState = extensionState;
  }

  step({milliseconds = 16, count = 1} = {}) {
    for (let index = 0; index < count; index += 1) {
      this.clock.now += milliseconds;
      this.vm.runtime.currentMSecs = this.clock.now;
      this.vm.runtime._step();
    }
  }

  runUntil(predicate, {maxSteps = 500, milliseconds = 16} = {}) {
    for (let step = 0; step < maxSteps; step += 1) {
      if (predicate()) return;
      this.step({milliseconds});
    }
    throw new Error(`VM condition was not reached within ${maxSteps} steps.`);
  }

  greenFlag() {
    this.vm.greenFlag();
    this.clock.now = 0;
    this.vm.runtime.currentMSecs = 0;
  }

  stopAll() {
    this.vm.runtime.stopAll();
  }

  pressKey(key) {
    this.vm.postIOData('keyboard', {key, isDown: true});
    this.step();
    this.vm.postIOData('keyboard', {key, isDown: false});
    this.step();
  }

  clickStage() {
    this.vm.runtime.startHats('event_whenstageclicked');
    this.step();
  }

  triggerAsyncKey(keyId) {
    this.extensionState.asyncInput.emitKey(keyId);
    this.step();
  }

  triggerActorTouch(actorName) {
    this.extensionState.asyncInput.emitActorTouch(actorName);
    this.step();
  }

  broadcast(name) {
    this.vm.runtime.startHats('event_whenbroadcastreceived', {
      BROADCAST_OPTION: name,
    });
  }

  getRuntimeVariable(name) {
    return this.extensionState.tempVariables?.runtimeVariables[name];
  }

  hasRuntimeVariable(name) {
    return Object.hasOwn(
      this.extensionState.tempVariables?.runtimeVariables ?? {},
      name,
    );
  }

  setRuntimeVariable(name, value) {
    this.extensionState.tempVariables.runtimeVariables[name] = value;
  }

  deleteRuntimeVariable(name) {
    Reflect.deleteProperty(this.extensionState.tempVariables.runtimeVariables, name);
  }

  getStage() {
    return this.vm.runtime.getTargetForStage();
  }

  getBackdropName() {
    const stage = this.getStage();
    return stage.getCostumes()[stage.currentCostume]?.name;
  }

  getStageEffect(name) {
    return this.getStage().effects[name];
  }

  getStageVariable(name) {
    return this.getStage().lookupVariableByNameAndType(name, '')?.value;
  }

  getActor(name) {
    return this.vm.runtime.targets.find((target) => (
      !target.isStage
      && target.sprite?.name === 'Actor'
      && target.lookupVariableByNameAndType('actorName', '')?.value === name
    ));
  }

  getBubbleText(name) {
    return this.getActor(name)?.getCustomState('Scratch.looks')?.text ?? '';
  }

  isSoundPlaying(name) {
    return this.extensionState.playingSounds.has(name);
  }

  getActorSkin(name) {
    return this.extensionState.actorSkins.get(name);
  }

  quit() {
    this.vm.quit();
  }
}

export async function loadKamishibaiVm({
  sb3Path = defaultKamishibaiSb3Path,
  productionAssetManager = false,
} = {}) {
  const originalWarn = vmLog.warn;
  const originalWarning = vmLog.warning;
  vmLog.warn = () => {};
  vmLog.warning = () => {};
  let vm;
  try {
    vm = new VirtualMachine();
  } finally {
    vmLog.warn = originalWarn;
    vmLog.warning = originalWarning;
  }
  const clock = {now: 0};
  const extensionState = registerKamishibaiTestExtensions(vm, clock, {
    productionAssetManager,
  });

  vm.setCompatibilityMode(false);
  vm.setTurboMode(false);
  vm.setCompilerOptions({enabled: false});
  vm.securityManager.canLoadExtensionFromProject = (url) => {
    throw new Error(`Unexpected external extension load: ${url}`);
  };

  vmLog.warn = () => {};
  vmLog.warning = () => {};
  try {
    await vm.loadProject(await readFile(sb3Path));
  } finally {
    vmLog.warn = originalWarn;
    vmLog.warning = originalWarning;
  }
  vm.runtime.currentMSecs = 0;
  return new KamishibaiVmHarness(vm, clock, extensionState);
}
