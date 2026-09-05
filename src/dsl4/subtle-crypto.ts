/**
 * The Web Crypto surface the DSL 4.0 modules take by injection.
 *
 * Callers pass `globalThis.crypto.subtle`, and the suites substitute a stub that records the
 * requested algorithm, so this declares the structural subset actually used rather than
 * `SubtleCrypto` itself. `AlgorithmIdentifier`, `ArrayBufferView` and `ArrayBuffer` come from the
 * standard libs, which keeps this module import-free and therefore usable from the pure DSL 4.0
 * core graph.
 *
 * `data` is deliberately wider than the platform's `BufferSource`: these modules hash
 * `Uint8Array<ArrayBufferLike>` values that reach them from callers and from fetched responses, and
 * `BufferSource` excludes views over a `SharedArrayBuffer`. Narrowing the digest inputs to
 * `Uint8Array<ArrayBuffer>` is a separate change — it propagates up through the public integrity
 * and asset-bundle signatures.
 */
export interface Dsl4SubtleCrypto {
  digest(algorithm: AlgorithmIdentifier, data: ArrayBufferView | ArrayBuffer): Promise<ArrayBuffer>;
}
