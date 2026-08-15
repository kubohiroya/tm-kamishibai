import {createRuntimeExpressionComposition} from '@kubohiroya/turbowarp-runtime-expression/composition';

import {createDsl4SourceFrontend} from '../dsl4/source-frontend.js';
import {createDsl4RuntimeStateExpressionComposition} from '../dsl4/runtime-variable-surface.js';

/**
 * Compose the pure DSL 4.0 source frontend with the pinned Runtime Expression engine.
 *
 * @param {import('ajv').AnySchema} schema
 * @param {{actionRegistry?: unknown, limits?: Record<string, number>, createRuntimeExpressionComposition?: () => unknown, runtimeStateExpressionsEnabled?: boolean}} [options]
 */
export function createDsl4ProductionSourceFrontend(schema, options = {}) {
  const createComposition =
    options.createRuntimeExpressionComposition ?? createRuntimeExpressionComposition;
  const runtimeStateExpressionsEnabled = options.runtimeStateExpressionsEnabled ?? false;
  if (typeof runtimeStateExpressionsEnabled !== 'boolean') {
    throw new TypeError('runtimeStateExpressionsEnabled must be boolean');
  }
  return createDsl4SourceFrontend(schema, {
    ...options,
    createRuntimeExpressionComposition: runtimeStateExpressionsEnabled
      ? () =>
          createDsl4RuntimeStateExpressionComposition({
            composition: createComposition(),
            enabled: true,
          })
      : createComposition,
  });
}
