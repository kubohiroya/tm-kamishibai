import {deepFreeze} from './story-document.js';

const publicRuntimeStatuses = new Set([
  'idle',
  'running',
  'paused',
  'failed',
  'finished',
  'stopped',
]);
const publicPosePhases = new Set(['waiting', 'charging', 'completed', 'cancelled']);
// The prefix keeps every lowered token the same length as runtime["KEY"], preserving limits and offsets.
const runtimeExpressionPrefix = '@r:';

export const dsl4RuntimeExpressionKeys = deepFreeze([
  'status',
  'scene.id',
  'action.number',
  'action.path',
  'pose.phase',
  'pose.target',
  'pose.name',
  'pose.stepNumber',
  'version',
]);

const runtimeExpressionKeySet = new Set(dsl4RuntimeExpressionKeys);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function publicString(value: unknown) {
  return typeof value === 'string' ? value : '';
}

/**
 * Build the complete public runtime-variable snapshot. This is the only mapping used by both
 * TurboWarp reporters and the Runtime Expression namespace.
 *
 */
export function createDsl4RuntimeVariableSnapshot(
  runtimeState: unknown,
  {
    poseState,
    version,
    disposed = false,
  }: {poseState?: unknown; version?: unknown; disposed?: boolean} = {},
) {
  const runtime = isRecord(runtimeState) ? runtimeState : {};
  const pose = isRecord(poseState) ? poseState : {};
  const diagnostic = isRecord(runtime.diagnostic) ? runtime.diagnostic : {};
  const storyVariables = isRecord(runtime.variables)
    ? Object.fromEntries(
        Object.entries(runtime.variables).filter(
          ([, value]) =>
            typeof value === 'string' ||
            typeof value === 'boolean' ||
            (typeof value === 'number' && Number.isFinite(value)),
        ),
      )
    : {};
  const status = disposed
    ? 'stopped'
    : typeof runtime.status === 'string' && publicRuntimeStatuses.has(runtime.status)
      ? runtime.status
      : 'idle';
  const actionPath = publicString(runtime.actionPath);
  const actionIndex =
    typeof runtime.actionIndex === 'number' && Number.isSafeInteger(runtime.actionIndex)
      ? runtime.actionIndex
      : -1;
  const poseStepIndex =
    typeof pose.stepIndex === 'number' && Number.isSafeInteger(pose.stepIndex)
      ? pose.stepIndex
      : -1;
  const posePhase =
    typeof pose.phase === 'string' && publicPosePhases.has(pose.phase) ? pose.phase : 'inactive';
  const runtimeValues = {
    status,
    'scene.id': disposed ? '' : publicString(runtime.sceneId),
    'action.number': !disposed && actionPath && actionIndex >= 0 ? actionIndex + 1 : 0,
    'action.path': disposed ? '' : actionPath,
    'pose.phase': disposed ? 'inactive' : posePhase,
    'pose.target': disposed ? '' : publicString(pose.target),
    'pose.name': disposed ? '' : publicString(pose.pose),
    'pose.stepNumber': !disposed && poseStepIndex >= 0 ? poseStepIndex + 1 : 0,
    version: publicString(version),
  };
  return deepFreeze({
    storyVariables,
    runtime: runtimeValues,
    diagnostic: {
      code: publicString(diagnostic.code),
      storyPath: publicString(diagnostic.storyPath),
    },
  });
}

function syntheticVariableName(key: string) {
  return `${runtimeExpressionPrefix}${key}`;
}

function readQuotedString(source: string, index: number) {
  const quote = source[index];
  if (quote !== '"' && quote !== "'") return null;
  let value = '';
  for (let cursor = index + 1; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (character === quote) return {value, end: cursor + 1};
    if (character === '\\') {
      const escaped = source[cursor + 1];
      if (escaped === undefined) return null;
      if (escaped === quote || escaped === '\\') {
        value += escaped;
        cursor += 1;
        continue;
      }
      return null;
    }
    value += character;
  }
  return null;
}

function skipWhitespace(source: string, index: number) {
  let cursor = index;
  while (/\s/u.test(source[cursor] ?? '')) cursor += 1;
  return cursor;
}

/**
 * Lower the deliberately narrow runtime["KEY"] syntax to collision-proof variables understood
 * by the pinned Runtime Expression engine.
 */
export function lowerDsl4RuntimeExpression(expression: string) {
  if (typeof expression !== 'string') throw new TypeError('expression must be a string');
  let output = '';
  let cursor = 0;
  let copiedFrom = 0;
  let quote = null;
  while (cursor < expression.length) {
    const character = expression[cursor];
    if (quote !== null) {
      if (character === '\\') cursor += 2;
      else {
        if (character === quote) quote = null;
        cursor += 1;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      cursor += 1;
      continue;
    }
    if (
      expression.startsWith('runtime', cursor) &&
      !/[A-Za-z0-9_]/u.test(expression[cursor - 1] ?? '') &&
      !/[A-Za-z0-9_]/u.test(expression[cursor + 7] ?? '')
    ) {
      let tokenCursor = skipWhitespace(expression, cursor + 7);
      if (expression[tokenCursor] !== '[') {
        cursor += 7;
        continue;
      }
      tokenCursor = skipWhitespace(expression, tokenCursor + 1);
      const literal = readQuotedString(expression, tokenCursor);
      if (!literal) {
        cursor += 7;
        continue;
      }
      tokenCursor = skipWhitespace(expression, literal.end);
      if (expression[tokenCursor] !== ']') {
        cursor += 7;
        continue;
      }
      if (!runtimeExpressionKeySet.has(literal.value)) {
        const error = new Error('Runtime expression referenced an unknown runtime key');
        Object.defineProperties(error, {
          code: {value: 'RUNTIME_EXPRESSION_UNKNOWN_RUNTIME_KEY'},
          position: {value: cursor},
        });
        throw error;
      }
      output += expression.slice(copiedFrom, cursor);
      const tokenLength = tokenCursor + 1 - cursor;
      output += `vars[${JSON.stringify(syntheticVariableName(literal.value))}]`.padEnd(tokenLength);
      cursor = tokenCursor + 1;
      copiedFrom = cursor;
      continue;
    }
    cursor += 1;
  }
  output += expression.slice(copiedFrom);
  return output;
}

/** Adapt a Runtime Expression composition without creating a second expression evaluator. */
export function createDsl4RuntimeStateExpressionComposition(input: unknown) {
  if (!isRecord(input) || !isRecord(input.composition)) {
    throw new TypeError('Runtime state expression adapter requires a composition');
  }
  const composition = input.composition as Record<string, Function>;
  if (
    typeof composition.evaluateCondition !== 'function' ||
    typeof composition.validateConditionSyntax !== 'function' ||
    typeof composition.releaseAll !== 'function'
  ) {
    throw new TypeError(
      'Runtime Expression composition must provide evaluateCondition, validateConditionSyntax, and releaseAll',
    );
  }
  if (typeof input.enabled !== 'boolean') throw new TypeError('enabled must be boolean');

  return Object.freeze({
    validateConditionSyntax(expression: string) {
      if (!input.enabled) return composition.validateConditionSyntax(expression);
      try {
        return composition.validateConditionSyntax(lowerDsl4RuntimeExpression(expression));
      } catch (error) {
        const position =
          isRecord(error) && Number.isSafeInteger(error.position) ? error.position : 0;
        return deepFreeze({
          ok: false,
          code:
            isRecord(error) && error.code === 'RUNTIME_EXPRESSION_UNKNOWN_RUNTIME_KEY'
              ? error.code
              : 'CONDITION_SYNTAX_ERROR',
          position,
        });
      }
    },
    evaluateCondition(
      expression: string,
      variables: Readonly<Record<string, string | number | boolean>>,
      runtimeSnapshot: unknown = {},
    ) {
      if (!input.enabled) return composition.evaluateCondition(expression, variables);
      const snapshot = isRecord(runtimeSnapshot) ? runtimeSnapshot : {};
      const runtimeValues = isRecord(snapshot.runtime) ? snapshot.runtime : {};
      const syntheticValues = Object.fromEntries(
        dsl4RuntimeExpressionKeys.map((key) => [syntheticVariableName(key), runtimeValues[key]]),
      );
      return composition.evaluateCondition(lowerDsl4RuntimeExpression(expression), {
        ...variables,
        ...syntheticValues,
      });
    },
    releaseAll() {
      return composition.releaseAll();
    },
  });
}
