// SPDX-License-Identifier: MPL-2.0

/**
 * The runtime check that a TurboWarp extension composition provides what a port calls.
 *
 * The result is keyed by the method names that were checked rather than by an index signature, so
 * reaching for a method nobody validated is a type error instead of a runtime one, and the checked
 * members are not each independently possibly undefined. `Optional` names the members a caller may
 * use when the composition offers them and must fall back when it does not.
 */
/**
 * A composition method reached by name.
 *
 * The parameters stay open because each port calls its own members with its own arguments, and the
 * result is `unknown` so the port narrows what came back rather than taking the extension's word
 * for it.
 */
export type Dsl4CompositionMethod = (...parameters: unknown[]) => unknown;

export function validateCompositionMethods<Method extends string, Optional extends string = never>(
  value: unknown,
  label: string,
  methods: readonly Method[],
): Record<Method, Dsl4CompositionMethod> & Partial<Record<Optional, Dsl4CompositionMethod>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const candidate = value as Record<string, unknown>;
  const missing = methods.filter((method) => typeof candidate[method] !== 'function');
  if (missing.length > 0) {
    throw new TypeError(`${label} must provide ${missing.join(', ')}`);
  }
  return value as Record<Method, Dsl4CompositionMethod> &
    Partial<Record<Optional, Dsl4CompositionMethod>>;
}
