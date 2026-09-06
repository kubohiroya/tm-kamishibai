/**
 * The clock a watching component takes by injection, so a suite can drive its waits.
 *
 * Three components share it: the browser preview source adapter, the preview reload policy, and
 * the builder's preview watcher. The timer handle stays opaque because a caller only holds what
 * `setTimeout` returned and hands it back to `clearTimeout`, and the injected fakes return a
 * counter rather than a `Timeout`.
 *
 * The module has no imports so the pure DSL 4.0 core can use it.
 */
export type Dsl4TimerHandle = unknown;

export interface Dsl4Clock {
  now(): number;
  setTimeout(handler: () => void, delay: number): Dsl4TimerHandle;
  clearTimeout(handle: Dsl4TimerHandle): void;
  sleep(milliseconds: number): Promise<unknown>;
}
