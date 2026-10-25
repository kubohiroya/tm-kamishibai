/** An opaque prepared presentation; the core never imports a native renderer. */
export interface Dsl4RestorePresentation {
  commit(): unknown;
  rollback(): unknown | Promise<unknown>;
  finalize(): unknown | Promise<unknown>;
}
