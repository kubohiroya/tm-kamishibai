import narrativeSchema from '../../schema/dsl-4-narrative-control.schema.json' with {type: 'json'};
import {createRuntimeExpressionComposition} from '@kubohiroya/turbowarp-runtime-expression/composition';

import {createDsl4SourceFrontend} from '../dsl4/source-frontend.js';
import {dsl4StandardProductionFeatureFlags} from '../dsl4/feature-flags.js';
import {createDsl4RuntimeStateExpressionComposition} from '../dsl4/runtime-variable-surface.js';

/** Compose the pure DSL 4.0 source frontend with the pinned Runtime Expression engine. */
export function createDsl4ProductionSourceFrontend(
  schema: import('ajv').AnySchema,
  options: {
    actionRegistry?: unknown;
    limits?: Record<string, number>;
    createRuntimeExpressionComposition?: () => unknown;
    runtimeStateExpressionsEnabled?: boolean;
    narrativeControlEnabled?: boolean;
  } = {},
) {
  const createComposition =
    options.createRuntimeExpressionComposition ?? createRuntimeExpressionComposition;
  const runtimeStateExpressionsEnabled = options.runtimeStateExpressionsEnabled ?? false;
  const narrativeControlEnabled =
    options.narrativeControlEnabled ?? dsl4StandardProductionFeatureFlags.dsl4NarrativeControl;
  if (typeof runtimeStateExpressionsEnabled !== 'boolean') {
    throw new TypeError('runtimeStateExpressionsEnabled must be boolean');
  }
  return createDsl4SourceFrontend(schema, {
    ...options,
    narrativeControlEnabled,
    ...(narrativeControlEnabled ? {narrativeControlSchema: narrativeSchema} : {}),
    createRuntimeExpressionComposition: runtimeStateExpressionsEnabled
      ? () =>
          createDsl4RuntimeStateExpressionComposition({
            composition: createComposition(),
            enabled: true,
          })
      : createComposition,
  });
}
