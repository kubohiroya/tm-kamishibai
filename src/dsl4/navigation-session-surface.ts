// SPDX-License-Identifier: MPL-2.0

/**
 * The navigation session as its hosts drive it.
 *
 * `createDsl4NavigationSession` returns more than this; the type lists what the TurboWarp runtime
 * host, the preview session, and the startup helper actually call, so those call sites stop going
 * through an index signature that makes every member possibly undefined.
 */
export interface Dsl4NavigationSessionSurface {
  start(...parameters: any[]): any;
  stop(...parameters: any[]): any;
  dispose(...parameters: any[]): any;
  getState(): Readonly<Record<string, any>>;
  getRunPromise(): Promise<unknown> | null;
  attach(...parameters: any[]): any;
  detach(...parameters: any[]): any;
  attachStagePointer(...parameters: any[]): any;
  detachStagePointer(...parameters: any[]): any;
  dispatchCommand(...parameters: any[]): any;
  handleKeyDown(...parameters: any[]): any;
  handlePointerUp(...parameters: any[]): any;
  whenInputIdle(...parameters: any[]): any;
  quiesce(...parameters: any[]): any;
  resumeQuiesce(...parameters: any[]): any;
  invokeAction(...parameters: any[]): any;
  queueVariableWrite(...parameters: any[]): any;
  rejectActionInvocation(...parameters: any[]): any;
  /** Probed before use: only sessions with the debugger surface expose it. */
  getRuntimeVariableSnapshot?(...parameters: any[]): any;
}
