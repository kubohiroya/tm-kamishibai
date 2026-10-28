import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

/** Share one reviewed graph across successive projects in the same Editor page. */
export async function createDsl4TeachableMachineExtensionSource() {
  const [embedded, loader] = await Promise.all([
    readFile(
      fileURLToPath(
        import.meta
          .resolve('@kubohiroya/turbowarp-teachable-machine/dist/teachable-machine-webgpu.js'),
      ),
      'utf8',
    ),
    readFile(
      fileURLToPath(
        import.meta.resolve('@kubohiroya/turbowarp-teachable-machine/dist/teachable-machine.js'),
      ),
      'utf8',
    ),
  ]);
  const captureRegistration = (source: string) => {
    const call = /\bScratch\s*\.\s*extensions\s*\.\s*register\s*\(/gu;
    assert.equal(
      [...source.matchAll(call)].length,
      1,
      'Teachable Machine must register exactly once',
    );
    return source.replace(call, 'captureTeachableMachine(');
  };
  // Only the registration call changes. In particular, the upstream threaded WASM factory must
  // retain its original closure and Function.toString() output when workers initialize.
  const key = '@kubohiroya/turbowarp-teachable-machine/runtime';
  return Buffer.from(`
(function () {
let teachableMachineExtension;
const captureTeachableMachine = (extension) => {
  if (teachableMachineExtension) throw new Error('Duplicate Teachable Machine registration');
  teachableMachineExtension = extension;
};
if (globalThis[Symbol.for(${JSON.stringify(key)})]?.version === '4.0.2' &&
    globalThis.tf && globalThis.tmPose && globalThis.tmCompute) {
${captureRegistration(loader)}
} else {
${captureRegistration(embedded)}
}
if (!teachableMachineExtension) throw new Error('Teachable Machine did not register');
Scratch.extensions.register(teachableMachineExtension);
})();
`);
}
