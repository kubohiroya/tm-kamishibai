import {createRuntimeExpressionComposition} from '@kubohiroya/turbowarp-runtime-expression/composition';

import {createDsl4SourceFrontend} from '../dsl4/source-frontend.js';

/**
 * Compose the pure DSL 4.0 source frontend with the pinned Runtime Expression engine.
 *
 * @param {import('ajv').AnySchema} schema
 * @param {{actionRegistry?: unknown, limits?: Record<string, number>, createRuntimeExpressionComposition?: () => unknown}} [options]
 */
export function createDsl4ProductionSourceFrontend(schema, options = {}) {
  return createDsl4SourceFrontend(schema, {
    ...options,
    createRuntimeExpressionComposition:
      options.createRuntimeExpressionComposition ?? createRuntimeExpressionComposition,
  });
}
