const defaultFrameMilliseconds = 1000 / 60;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {string} code @param {string} message */
function adapterError(code, message) {
  const error = new Error(message);
  Object.defineProperty(error, 'code', {value: code});
  return error;
}

function createDefaultScheduler() {
  /** @param {() => void} callback @param {number} milliseconds */
  const schedule = (callback, milliseconds) => setTimeout(callback, milliseconds);
  /** @param {unknown} handle */
  const cancel = (handle) => clearTimeout(/** @type {ReturnType<typeof setTimeout>} */ (handle));
  return Object.freeze({
    now: () => performance.now(),
    setTimeout: schedule,
    clearTimeout: cancel,
  });
}

/** @param {unknown} value */
function validateScheduler(value) {
  const methods = ['now', 'setTimeout', 'clearTimeout'];
  if (!isRecord(value) || methods.some((method) => typeof value[method] !== 'function')) {
    throw new TypeError(`TurboWarp actor scheduler must provide ${methods.join(', ')}`);
  }
  return /** @type {{now: () => number, setTimeout: (callback: () => void, milliseconds: number) => unknown, clearTimeout: (handle: unknown) => void}} */ (
    /** @type {unknown} */ (value)
  );
}

/** @param {unknown} value */
function validateRuntime(value) {
  if (!isRecord(value) || !Array.isArray(value.targets)) {
    throw new TypeError('TurboWarp runtime must provide a targets array');
  }
  const looks = value.ext_scratch3_looks;
  if (!isRecord(looks) || typeof looks._say !== 'function') {
    throw new TypeError('TurboWarp runtime must provide ext_scratch3_looks._say');
  }
  return {
    runtime: /** @type {Record<string, unknown> & {targets: unknown[]}} */ (value),
    say: /** @type {(message: string, target: unknown) => void} */ (looks._say.bind(looks)),
  };
}

/** @param {unknown} value @param {string} field */
function finiteNumber(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw adapterError('K4-TW-ACTOR-002', `${field} must be a finite number`);
  }
  return value;
}

/** @param {unknown} value */
function validateActor(value) {
  const methods = ['lookupVariableByNameAndType', 'setXY', 'setSize', 'setVisible'];
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    value.isStage !== false ||
    methods.some((method) => typeof value[method] !== 'function')
  ) {
    throw adapterError('K4-TW-ACTOR-002', 'TurboWarp actor target is invalid');
  }
  finiteNumber(value.x, 'actor.x');
  finiteNumber(value.y, 'actor.y');
  return /** @type {Record<string, unknown> & {id: string, isStage: false, x: number, y: number, lookupVariableByNameAndType: (name: string, type: string) => unknown, setXY: (x: number, y: number) => void, setSize: (size: number) => void, setVisible: (visible: boolean) => void}} */ (
    /** @type {unknown} */ (value)
  );
}

/** @param {unknown} value @param {string[]} keys @param {string} operation */
function validateSpec(value, keys, operation) {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw adapterError(
      'K4-TW-ACTOR-002',
      `${operation} specification must provide exactly ${keys.join(', ')}`,
    );
  }
  return value;
}

/** @param {number} seconds @param {string} operation */
function durationMilliseconds(seconds, operation) {
  finiteNumber(seconds, `${operation}.seconds`);
  const duration = seconds * 1000;
  if (seconds < 0 || !Number.isFinite(duration)) {
    throw adapterError(
      'K4-TW-ACTOR-002',
      `${operation}.seconds must produce a finite non-negative duration`,
    );
  }
  return duration;
}

/**
 * Connect the DSL4 actor presentation boundary to one TurboWarp runtime.
 *
 * @param {object} options
 * @param {unknown} options.runtime
 * @param {unknown} [options.scheduler]
 * @param {number} [options.frameMilliseconds]
 */
export function createDsl4TurboWarpActorPlatform(options) {
  if (!isRecord(options)) throw new TypeError('TurboWarp actor platform options must be an object');
  const {runtime, say} = validateRuntime(options.runtime);
  const scheduler = validateScheduler(options.scheduler ?? createDefaultScheduler());
  const frameMilliseconds =
    options.frameMilliseconds === undefined
      ? defaultFrameMilliseconds
      : finiteNumber(options.frameMilliseconds, 'frameMilliseconds');
  if (frameMilliseconds <= 0) {
    throw new TypeError('frameMilliseconds must be greater than zero');
  }

  /** @param {string} actorId */
  function resolveActor(actorId) {
    if (typeof actorId !== 'string' || actorId.length === 0) {
      throw adapterError('K4-TW-ACTOR-001', 'actorId must be a non-empty string');
    }
    const matches = runtime.targets.filter((candidate) => {
      if (!isRecord(candidate) || candidate.isStage !== false) return false;
      if (typeof candidate.lookupVariableByNameAndType !== 'function') return false;
      const variable = candidate.lookupVariableByNameAndType('actorName', '');
      return isRecord(variable) && variable.value === actorId;
    });
    if (matches.length === 0) return null;
    if (matches.length > 1) {
      throw adapterError('K4-TW-ACTOR-001', `TurboWarp actor is ambiguous: ${actorId}`);
    }
    return validateActor(matches[0]);
  }

  const host = Object.freeze({
    /** @param {unknown} target @param {unknown} transform */
    showActor(target, transform) {
      const actor = validateActor(target);
      const value = validateSpec(transform, ['x', 'y', 'scale'], 'showActor');
      const x = finiteNumber(value.x, 'showActor.x');
      const y = finiteNumber(value.y, 'showActor.y');
      const scale = finiteNumber(value.scale, 'showActor.scale');
      if (scale <= 0) throw adapterError('K4-TW-ACTOR-002', 'showActor.scale must be positive');
      actor.setXY(x, y);
      actor.setSize(scale);
      actor.setVisible(true);
    },

    /** @param {unknown} target @param {unknown} destination */
    createMove(target, destination) {
      const actor = validateActor(target);
      const value = validateSpec(destination, ['x', 'y', 'seconds'], 'moveTo');
      const destinationX = finiteNumber(value.x, 'moveTo.x');
      const destinationY = finiteNumber(value.y, 'moveTo.y');
      const duration = durationMilliseconds(/** @type {number} */ (value.seconds), 'moveTo');
      let state = 'idle';
      /** @type {unknown} */
      let timer;
      /** @type {(() => void) | undefined} */
      let resolveOperation;
      /** @type {((error: unknown) => void) | undefined} */
      let rejectOperation;

      const cancelTimer = () => {
        if (timer === undefined) return;
        scheduler.clearTimeout(timer);
        timer = undefined;
      };
      const complete = () => {
        if (state === 'completed' || state === 'failed') return;
        cancelTimer();
        actor.setXY(destinationX, destinationY);
        state = 'completed';
        resolveOperation?.();
      };
      /** @param {unknown} error */
      const fail = (error) => {
        if (state !== 'running') return;
        cancelTimer();
        state = 'failed';
        rejectOperation?.(error);
      };

      return Object.freeze({
        start() {
          if (state !== 'idle') {
            throw adapterError('K4-TW-ACTOR-003', 'moveTo operation can only start once');
          }
          const startX = finiteNumber(actor.x, 'actor.x');
          const startY = finiteNumber(actor.y, 'actor.y');
          const startTime = finiteNumber(scheduler.now(), 'scheduler.now()');
          state = 'running';
          return new Promise((resolve, reject) => {
            resolveOperation = () => resolve(undefined);
            rejectOperation = (error) => reject(error);
            if (duration === 0) {
              try {
                complete();
              } catch (error) {
                fail(error);
              }
              return;
            }
            const tick = () => {
              timer = undefined;
              try {
                const elapsed = Math.max(
                  0,
                  finiteNumber(scheduler.now(), 'scheduler.now()') - startTime,
                );
                const progress = Math.min(elapsed / duration, 1);
                actor.setXY(
                  startX + (destinationX - startX) * progress,
                  startY + (destinationY - startY) * progress,
                );
                if (progress >= 1) {
                  complete();
                  return;
                }
                timer = scheduler.setTimeout(tick, Math.min(frameMilliseconds, duration - elapsed));
              } catch (error) {
                fail(error);
              }
            };
            try {
              timer = scheduler.setTimeout(tick, Math.min(frameMilliseconds, duration));
            } catch (error) {
              fail(error);
            }
          });
        },
        finish: complete,
      });
    },

    /** @param {unknown} target @param {unknown} speech */
    createSay(target, speech) {
      const actor = validateActor(target);
      const value = validateSpec(speech, ['text', 'seconds'], 'say');
      if (typeof value.text !== 'string') {
        throw adapterError('K4-TW-ACTOR-002', 'say.text must be a string');
      }
      const text = value.text;
      const duration = durationMilliseconds(/** @type {number} */ (value.seconds), 'say');
      let state = 'idle';
      /** @type {unknown} */
      let timer;
      /** @type {(() => void) | undefined} */
      let resolveOperation;
      /** @type {((error: unknown) => void) | undefined} */
      let rejectOperation;

      const cancelTimer = () => {
        if (timer === undefined) return;
        scheduler.clearTimeout(timer);
        timer = undefined;
      };
      const complete = () => {
        if (state === 'completed' || state === 'failed') return;
        cancelTimer();
        say('', actor);
        state = 'completed';
        resolveOperation?.();
      };
      /** @param {unknown} error */
      const fail = (error) => {
        if (state !== 'running') return;
        cancelTimer();
        state = 'failed';
        rejectOperation?.(error);
      };

      return Object.freeze({
        start() {
          if (state !== 'idle') {
            throw adapterError('K4-TW-ACTOR-003', 'say operation can only start once');
          }
          state = 'running';
          return new Promise((resolve, reject) => {
            resolveOperation = () => resolve(undefined);
            rejectOperation = (error) => reject(error);
            try {
              say(text, actor);
              if (duration === 0) {
                complete();
                return;
              }
              timer = scheduler.setTimeout(() => {
                timer = undefined;
                try {
                  complete();
                } catch (error) {
                  fail(error);
                }
              }, duration);
            } catch (error) {
              fail(error);
            }
          });
        },
        finish: complete,
      });
    },
  });

  return Object.freeze({host, resolveActor});
}
