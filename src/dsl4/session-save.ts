import {
  decodeDsl4SaveBlob,
  decodeDsl4SaveData,
  encodeDsl4SaveBlob,
  Dsl4SaveDataError,
  type Dsl4SaveIdentity,
  type Dsl4SaveDataV1,
} from './save-data.js';
import type {Dsl4RestorePresentation} from './save-presentation.js';

/** Coordinates an atomic checkpoint without replaying commands or their external side effects. */
export function createDsl4SessionSavePort(options: {
  identity?: Dsl4SaveIdentity;
  quiesce(id: number): Promise<unknown>;
  resume(id: number): unknown;
  capture(): Omit<
    Dsl4SaveDataV1,
    'formatVersion' | 'dslVersion' | 'savedAt' | 'storyId' | 'sourceIntegrity'
  >;
  validate(save: Readonly<Dsl4SaveDataV1>): void;
  prepare(
    save: Readonly<Dsl4SaveDataV1>,
    signal: AbortSignal,
  ): Promise<{
    commit(adopt: () => void): Promise<unknown>;
    cancel(): unknown;
    finalize?(): unknown;
  }>;
  preparePresentation(
    save: Readonly<Dsl4SaveDataV1>,
    signal: AbortSignal,
  ): Promise<Dsl4RestorePresentation>;
  adopt(save: Readonly<Dsl4SaveDataV1>): void;
  report(error: unknown): void;
}) {
  function report(error: unknown) {
    try {
      options.report(error);
    } catch {
      /* Diagnostics do not change checkpoint ownership. */
    }
  }
  let closed = false,
    operation: Promise<unknown> | null = null,
    abort: AbortController | null = null,
    nextId = 1_000_000;
  const retained = new Set<() => unknown>();
  let cleaning: Promise<void> | null = null;
  function active() {
    if (closed) throw new Dsl4SaveDataError('K4-SAVE-DISPOSED', 'Session is closed');
  }
  function identity() {
    if (!options.identity)
      throw new Dsl4SaveDataError('K4-SAVE-IDENTITY', 'A verified story identity is required');
    return options.identity;
  }
  function run<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    active();
    if (operation || retained.size || cleaning)
      throw new Dsl4SaveDataError('K4-SAVE-BUSY', 'A checkpoint or its cleanup is pending');
    const controller = new AbortController();
    abort = controller;
    const pending = Promise.resolve()
      .then(() => {
        active();
        return task(controller.signal);
      })
      .catch((error) => {
        report(error);
        throw error;
      });
    operation = pending;
    const done = () => {
      if (operation === pending) {
        operation = null;
        abort = null;
      }
    };
    void pending.then(done, done);
    return pending;
  }
  async function release(callback: () => unknown) {
    retained.add(callback);
    await callback();
    retained.delete(callback);
  }
  function check(signal: AbortSignal) {
    active();
    if (signal.aborted) throw new DOMException('Checkpoint cancelled', 'AbortError');
  }
  function capture() {
    return run(async (signal) => {
      const owner = identity(),
        id = nextId++;
      let quiesced = false;
      try {
        await options.quiesce(id);
        quiesced = true;
        check(signal);
        const save = decodeDsl4SaveData(
          {
            formatVersion: 1,
            dslVersion: '4.0',
            ...owner,
            savedAt: new Date().toISOString(),
            ...options.capture(),
          },
          {identity: owner},
        );
        options.validate(save);
        return save;
      } finally {
        if (quiesced && !closed) options.resume(id);
      }
    });
  }
  function restore(input: unknown) {
    return run(async (signal) => {
      const owner = identity();
      const save =
        input instanceof Blob
          ? await decodeDsl4SaveBlob(input, {identity: owner})
          : decodeDsl4SaveData(input, {identity: owner});
      options.validate(save);
      check(signal);
      const id = nextId++;
      let quiesced = false,
        committed = false;
      let prepared: Awaited<ReturnType<typeof options.prepare>> | null = null;
      let presentation: Dsl4RestorePresentation | null = null;
      try {
        await options.quiesce(id);
        quiesced = true;
        check(signal);
        prepared = await options.prepare(save, signal);
        check(signal);
        presentation = await options.preparePresentation(save, signal);
        check(signal);
        await presentation.commit();
        check(signal);
        let adopted = false;
        const result = await prepared.commit(() => {
          options.adopt(save);
          adopted = true;
          committed = true;
        });
        if (!adopted) {
          check(signal);
          options.adopt(save);
          committed = true;
        }
        return {ok: true, save, state: result};
      } catch (error) {
        const failures: unknown[] = [error];
        if (!committed) {
          if (presentation)
            try {
              await release(() => presentation!.rollback());
            } catch (failure) {
              failures.push(failure);
            }
          if (prepared)
            try {
              await release(() => prepared!.cancel());
            } catch (failure) {
              failures.push(failure);
            }
          if (quiesced && !closed)
            try {
              options.resume(id);
            } catch (failure) {
              failures.push(failure);
            }
        }
        const failure =
          failures.length === 1
            ? error
            : new AggregateError(failures, 'Checkpoint and rollback failed');
        throw failure;
      } finally {
        // Adoption transfers ownership even when a later notification fails or closes the session.
        if (committed) {
          const cleanup = async () => {
            const errors: unknown[] = [];
            try {
              await presentation!.finalize();
            } catch (error) {
              errors.push(error);
            }
            try {
              await prepared!.finalize?.();
            } catch (error) {
              errors.push(error);
            }
            if (errors.length)
              throw new AggregateError(errors, 'Previous checkpoint cleanup failed');
          };
          try {
            await release(cleanup);
          } catch (error) {
            report(error);
          }
        }
      }
    });
  }
  function clean() {
    if (cleaning) return cleaning;
    const pending = Promise.resolve().then(async () => {
      if (operation) await operation.catch(() => {});
      const errors: unknown[] = [];
      for (const callback of [...retained])
        try {
          await callback();
          retained.delete(callback);
        } catch (error) {
          errors.push(error);
        }
      if (errors.length) throw new AggregateError(errors, 'Checkpoint cleanup failed');
    });
    cleaning = pending;
    const done = () => {
      if (cleaning === pending) cleaning = null;
    };
    void pending.then(done, done);
    return pending;
  }
  return Object.freeze({
    captureSave: capture,
    async exportSave() {
      return encodeDsl4SaveBlob(await capture());
    },
    restore,
    isBusy: () => operation !== null || retained.size > 0 || cleaning !== null,
    hasPendingCleanup: () => operation !== null || retained.size > 0 || cleaning !== null,
    close() {
      closed = true;
      abort?.abort('session-dispose');
    },
    dispose() {
      closed = true;
      abort?.abort('session-dispose');
      return clean();
    },
    retrySaveCleanup() {
      active();
      if (operation) throw new Dsl4SaveDataError('K4-SAVE-BUSY', 'Checkpoint is pending');
      return clean();
    },
  });
}
