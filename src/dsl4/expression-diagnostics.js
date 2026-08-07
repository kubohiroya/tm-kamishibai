const runtimeExpressionInvalidVariableCodes = new Set([
  'RUNTIME_EXPRESSION_INVALID_VARIABLE_MAP',
  'RUNTIME_EXPRESSION_INVALID_VARIABLE_PROPERTY',
  'RUNTIME_EXPRESSION_INVALID_VARIABLE_VALUE',
]);

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Map a Runtime Expression failure once at the Kamishibai boundary.
 *
 * The returned error deliberately does not copy the expression, variable name, runtime value,
 * absolute path, or the dependency's original message.
 *
 * @param {unknown} error
 * @param {{storyPath: string, sourcePath: string}} location
 */
export function mapDsl4RuntimeExpressionError(error, {storyPath, sourcePath}) {
  const genericCode = isRecord(error) && typeof error.code === 'string' ? error.code : null;
  let code = 'K4-EXPRESSION-INTERNAL-001';
  let message = 'Runtime expression evaluation failed';

  if (genericCode === 'RUNTIME_EXPRESSION_UNKNOWN_VARIABLE') {
    code = 'K4-EXPRESSION-VARIABLE-UNKNOWN';
    message = 'Runtime expression referenced an undefined variable';
  } else if (genericCode && runtimeExpressionInvalidVariableCodes.has(genericCode)) {
    code = 'K4-EXPRESSION-VARIABLE-001';
    message = 'Runtime variables do not satisfy the expression contract';
  } else if (error instanceof Error && error.name === 'ConditionSyntaxError') {
    code = 'K4-EXPRESSION-SYNTAX-001';
    message = 'Runtime expression syntax is invalid';
  }

  const mapped = new Error(message);
  Object.defineProperties(mapped, {
    code: {value: code},
    storyPath: {value: storyPath},
    sourcePath: {value: sourcePath},
  });
  return mapped;
}
