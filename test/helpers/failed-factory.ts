import {vi} from 'vitest';
import {createDsl4CreationCleanup, Dsl4CreationFailure} from '../../src/dsl4/creation-cleanup.js';

/** A factory already tried to release its unpublished resource. */
export function failedFactory({initiallyBroken = true} = {}) {
  let broken = initiallyBroken;
  const release = vi.fn(() => {
    if (broken) throw new Error('partial resource release failed');
  });
  const cleanup = createDsl4CreationCleanup([release], 'Partial factory cleanup failed');
  void cleanup.dispose('creation-failed').catch(() => {});
  return {
    failure: new Dsl4CreationFailure(new Error('factory failed'), cleanup, 'Factory failed'),
    cleanup,
    release,
    repair() {
      broken = false;
    },
  };
}
