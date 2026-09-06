/**
 * The unsandboxed TurboWarp `Scratch` host surface the DSL 4.0 extensions read.
 *
 * TurboWarp injects this object into an unsandboxed extension at load time, and the surfaces here
 * validate it before use. Only the members those surfaces actually read are declared: this is a
 * boundary contract, not a description of everything TurboWarp exposes.
 *
 * This module must stay import-free so pure DSL 4.0 core modules can use it.
 */

/** The value coercion helpers TurboWarp exposes; each surface falls back when they are absent. */
export interface Dsl4ScratchCast {
  toString?(value: unknown): string;
  toNumber?(value: unknown): number;
}

/** The registration surface an unsandboxed extension is handed. */
export interface Dsl4ScratchExtensions {
  unsandboxed?: unknown;
  register(extension: unknown): unknown;
}

export interface Dsl4ScratchHost {
  extensions: Dsl4ScratchExtensions;
  BlockType: Readonly<Record<string, string>>;
  ArgumentType: Readonly<Record<string, string>>;
  Cast?: Dsl4ScratchCast;
}
