// SPDX-License-Identifier: MPL-2.0

/**
 * The shared preview reload surface, as the Web and CLI shells drive it.
 *
 * Both shells validate an injected surface against exactly these members before using it, so the
 * contract lives here rather than being spelled out — or left as an index signature — in each.
 */
export interface Dsl4PreviewReloadSurface {
  submitCandidate(candidate: unknown): unknown;
  setDiagnostic(channel: string, diagnostic: unknown): unknown;
  setWatchState(channel: string, state: unknown): unknown;
  acknowledgePreviewInput(inputId?: unknown): unknown;
  registerReservedRect(owner: unknown, rect: unknown): unknown;
  updateReservedRect(owner: unknown, rect: unknown): unknown;
  unregisterReservedRect(owner: unknown): unknown;
  updateViewport(viewport: unknown, safeArea?: unknown): unknown;
  dispose(): unknown;
  getSnapshot(): Readonly<Record<string, any>>;
  whenIdle(): Promise<unknown>;
}
