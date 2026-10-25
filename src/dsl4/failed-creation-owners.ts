import {createDsl4AssetCleanupOwners} from './asset-cleanup-owners.js';
import {dsl4FailedCreationCleanupSteps, getDsl4CreationCleanup} from './creation-cleanup.js';

/** Keep a failed child's cleanup separate from normally returned resources. */
export function createDsl4FailedCreationOwners(message: string) {
  const owners = createDsl4AssetCleanupOwners(message);
  const retained = new WeakMap<object, ReturnType<typeof owners.own>>();
  function retain(failure: unknown) {
    const child = getDsl4CreationCleanup(failure);
    if (!child) return null;
    const previous = retained.get(child);
    if (previous?.hasPendingCleanup()) return previous;
    const owner = owners.own(dsl4FailedCreationCleanupSteps(failure));
    retained.set(child, owner);
    return owner;
  }
  return Object.freeze({
    retain,
    joinLateFailure(failure: unknown) {
      const owner = retain(failure);
      // A detached notification no longer reaches its caller's catch. Join once, never retry here.
      return owner ? (owner.completion ?? owner.release('late-notification-failed')) : null;
    },
    beginDispose: owners.beginDispose,
    endDispose: owners.endDispose,
    drain: owners.drain,
    hasPendingCleanup: owners.hasPendingCleanup,
  });
}
