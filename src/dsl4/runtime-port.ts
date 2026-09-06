/**
 * The runtime port: what the runtime controller calls on the platform for each story action.
 *
 * The TurboWarp runtime host assembles it by name from the media, actor, broadcast, SVG text, pose,
 * async input and host ports, and the controller dispatches an action to the operation named after
 * it. That dispatch is by string, so `Dsl4RuntimePort` cannot enumerate the operations; it names the
 * handful of members the controller reaches for directly, and the dispatch site narrows a looked-up
 * member to `Dsl4RuntimePortOperation` after checking it is a function. Every module that passes
 * the port along declares this type, so the shape is written once instead of at each hand-off.
 */

/** One dispatched operation: the action payload and the controller's context for it. */
export type Dsl4RuntimePortOperation = (
  payload: Readonly<Record<string, unknown>>,
  context: unknown,
) => unknown;

export interface Dsl4RuntimePort {
  /** Finish or cancel every presentation transition the platform still owns. */
  finishPresentationTransitions?(reason: string): unknown;
  /** Hide the story's actors between scenes; the host installs it when an actor platform exists. */
  hideSceneActors?(
    request: Readonly<{actors: readonly string[]; from: string | null; to: string; reason: string}>,
  ): unknown;
  /** Present when the crossfade platform is enabled; resolves to a start/finish operation pair. */
  createSceneCrossfade?(
    transition: Readonly<Record<string, unknown>>,
    options: Readonly<{from: unknown; to: unknown; reason: string}>,
  ): unknown;
  /** Present when pose preview mirroring is enabled. */
  setPosePreviewMirroring?(mode: string): unknown;
}
