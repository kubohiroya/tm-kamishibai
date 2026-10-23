/** Compile bounded narrative structure without executing Scratch or evaluating expressions. */
export type NarrativePath = (string | number)[];
type RecordValue = Record<string, unknown>;
type Scalar = string | number | boolean;
export interface NarrativeOrigin {
  path: NarrativePath;
  frames: {scope: string; index: number; number: number}[];
  guards: {id: string; expected: boolean}[];
  boundary?: true;
  decision?: {id: string; condition: string | boolean};
}
export interface NarrativeCompilation {
  story: RecordValue;
  origins: Record<string, NarrativeOrigin[]>;
  validation: Record<string, {action: RecordValue; origin: NarrativeOrigin}[]>;
}
export const dsl4NarrativeControlLimits = Object.freeze({maxIterations: 1024, maxNesting: 16});
export class Dsl4NarrativeControlError extends Error {
  readonly code: string;
  constructor(
    code: string,
    message: string,
    readonly path: NarrativePath,
  ) {
    super(message);
    this.name = 'Dsl4NarrativeControlError';
    this.code = code;
  }
}
const id = /^[\p{L}_][\p{L}\p{N}_-]*$/u;
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
function record(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function fail(message: string, path: NarrativePath, limit = false): never {
  throw new Dsl4NarrativeControlError(
    limit ? 'K4-NARRATIVE-LIMIT-001' : 'K4-NARRATIVE-SOURCE-001',
    message,
    path,
  );
}
function keys(value: RecordValue, allowed: string[], path: NarrativePath) {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    fail('Unknown narrative field', path);
}
function scopeName(value: unknown, path: NarrativePath): string {
  if (
    typeof value !== 'string' ||
    !id.test(value) ||
    value !== value.normalize('NFC') ||
    forbidden.has(value)
  ) {
    fail('Narrative scope and column names must be canonical DSL identifiers', path);
  }
  return value;
}
function actions(value: unknown, path: NarrativePath): RecordValue[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => !record(item) || Object.keys(item).length !== 1)
  ) {
    fail('Narrative body must be a sequence of single-command mappings', path);
  }
  return value as RecordValue[];
}

/** The caller validates ordinary actions through the existing schema and semantic frontend. */
export function compileDsl41NarrativeSource(
  input: RecordValue,
  {
    maxActionsPerScene = 1024,
    maxTotalActions = 4096,
    maxIterations = 1024,
    maxNesting = 16,
  }: {
    maxActionsPerScene?: number;
    maxTotalActions?: number;
    maxIterations?: number;
    maxNesting?: number;
  } = {},
): NarrativeCompilation {
  for (const limit of [maxActionsPerScene, maxTotalActions]) {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new TypeError('Narrative action limits must be positive integers');
  }
  if (
    !Number.isSafeInteger(maxIterations) ||
    maxIterations < 0 ||
    maxIterations > 1024 ||
    !Number.isSafeInteger(maxNesting) ||
    maxNesting < 0 ||
    maxNesting > 16
  )
    throw new TypeError('Narrative policy may only lower the default limits');
  if (input.kamishibai !== '4.1' || !record(input.scenes))
    fail('Narrative source requires version 4.1 and scenes', []);
  const sceneEntries = Object.entries(input.scenes);
  const sourceBodies = sceneEntries.map(([sceneId, scene]) => {
    if (!Array.isArray(scene) && !record(scene))
      fail('Scene must contain an action sequence', ['scenes', sceneId]);
    const path: NarrativePath = ['scenes', sceneId, ...(Array.isArray(scene) ? [] : ['actions'])];
    return {
      sceneId,
      scene,
      path,
      body: actions(Array.isArray(scene) ? scene : scene.actions, path),
    };
  });
  // Count bounded control boundaries as well as both arms before allocating an expanded sequence.
  function cost(body: RecordValue[], path: NarrativePath, depth: number): number {
    if (depth > maxNesting) fail(`Narrative nesting exceeds ${maxNesting}`, path, true);
    let count = 0;
    body.forEach((action, index) => {
      const [command] = Object.keys(action);
      const at = [...path, index, command!];
      const value = action[command!];
      if (['if', 'repeat', 'forEach'].includes(command!)) {
        if (!record(value)) fail('Narrative arguments must be a mapping', at);
        if (command === 'if') {
          keys(value, ['condition', 'then', 'else'], at);
          if (!Object.hasOwn(value, 'condition')) fail('Condition is required', at);
          count +=
            1 +
            cost(actions(value.then, [...at, 'then']), [...at, 'then'], depth + 1) +
            cost(actions(value.else ?? [], [...at, 'else']), [...at, 'else'], depth + 1);
        } else {
          const each = command === 'forEach';
          keys(value, each ? ['as', 'items', 'do'] : ['as', 'times', 'do'], at);
          if (each || value.as !== undefined) scopeName(value.as, [...at, 'as']);
          const times = each ? (Array.isArray(value.items) ? value.items.length : -1) : value.times;
          if (
            typeof times !== 'number' ||
            !Number.isSafeInteger(times) ||
            times < 0 ||
            times > maxIterations
          ) {
            fail(`Iteration count must be an integer from 0 through ${maxIterations}`, at, true);
          }
          const inner = cost(actions(value.do, [...at, 'do']), [...at, 'do'], depth + 1);
          count += 1 + times * (1 + inner);
          if (each) {
            let columns: string | undefined;
            for (const [rowIndex, row] of (value.items as unknown[]).entries()) {
              if (!record(row))
                fail('Each narrative row must be a mapping', [...at, 'items', rowIndex]);
              for (const [name, field] of Object.entries(row)) {
                scopeName(name, [...at, 'items', rowIndex, name]);
                if (
                  !['string', 'number', 'boolean'].includes(typeof field) ||
                  (typeof field === 'number' && !Number.isFinite(field))
                ) {
                  fail('Narrative row values must be finite scalar values', [
                    ...at,
                    'items',
                    rowIndex,
                    name,
                  ]);
                }
              }
              const shape = JSON.stringify(
                Object.entries(row)
                  .map(([name, field]) => [name, typeof field])
                  .sort(),
              );
              if (columns !== undefined && shape !== columns)
                fail('Narrative row column names and types must match', [...at, 'items', rowIndex]);
              columns = shape;
            }
          }
        }
      } else count += 1;
      if (count > Math.min(maxActionsPerScene, maxTotalActions))
        fail('Expanded action count exceeds the host limit', at, true);
    });
    return count;
  }
  let total = 0;
  for (const entry of sourceBodies) {
    total += cost(entry.body, entry.path, 0);
    if (total > maxTotalActions)
      fail('Expanded story exceeds the total action limit', entry.path, true);
  }
  const origins: NarrativeCompilation['origins'] = Object.create(null);
  const validation: NarrativeCompilation['validation'] = Object.create(null);
  const scenes: RecordValue = Object.create(null);
  let sequence = 0;
  for (const {sceneId, scene, path, body} of sourceBodies) {
    const expanded: RecordValue[] = [];
    origins[sceneId] = [];
    validation[sceneId] = [];
    function resolve(
      value: unknown,
      scopes: Map<string, Record<string, Scalar>>,
      at: NarrativePath,
    ): unknown {
      if (Array.isArray(value)) return value.map((child, i) => resolve(child, scopes, [...at, i]));
      if (!record(value)) return value;
      if (Object.keys(value).length === 1 && Object.hasOwn(value, 'ref')) {
        const match = typeof value.ref === 'string' ? value.ref.split('.') : [];
        const [scope, name] = match;
        if (
          match.length !== 2 ||
          !scope ||
          !name ||
          !scopes.has(scope) ||
          !Object.hasOwn(scopes.get(scope)!, name)
        ) {
          fail('Unknown narrative reference', at);
        }
        return scopes.get(scope)![name];
      }
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => {
          if (forbidden.has(key)) fail('Forbidden mapping key', [...at, key]);
          return [key, resolve(child, scopes, [...at, key])];
        }),
      );
    }
    function emit(action: RecordValue, origin: NarrativeOrigin, active: boolean) {
      if (validation[sceneId]!.length >= maxTotalActions)
        fail('Validation action count exceeds the host limit', origin.path, true);
      validation[sceneId]!.push({action, origin});
      if (active) {
        expanded.push(action);
        origins[sceneId]!.push(origin);
      }
    }
    function walk(
      list: RecordValue[],
      at: NarrativePath,
      scopes: Map<string, Record<string, Scalar>>,
      parent: Omit<NarrativeOrigin, 'path'>,
      active: boolean,
    ) {
      list.forEach((action, index) => {
        const [command] = Object.keys(action);
        const path = [...at, index];
        const value = action[command!];
        const origin: NarrativeOrigin = {
          path,
          frames: [...parent.frames],
          guards: [...parent.guards],
        };
        if (command === 'if') {
          const args = value as RecordValue;
          const condition = resolve(args.condition, scopes, [...path, 'if', 'condition']);
          if (!(
            typeof condition === 'boolean' ||
            (typeof condition === 'string' && condition.length > 0)
          ))
            fail('Condition must be a boolean or expression string', [...path, 'if', 'condition']);
          if (record(args.condition) && typeof condition !== 'boolean')
            fail('Condition reference must be boolean', [...path, 'if', 'condition']);
          const id = `narrative-${sequence++}`;
          emit({wait: 0}, {...origin, boundary: true, decision: {id, condition}}, active);
          for (const [arm, expected] of [
            ['then', true],
            ['else', false],
          ] as const) {
            walk(
              (args[arm] ?? []) as RecordValue[],
              [...path, 'if', arm],
              scopes,
              {...parent, guards: [...parent.guards, {id, expected}]},
              active,
            );
          }
        } else if (command === 'repeat' || command === 'forEach') {
          const args = value as RecordValue;
          emit({wait: 0}, {...origin, boundary: true}, active);
          const each = command === 'forEach';
          const count = each ? (args.items as unknown[]).length : (args.times as number);
          for (let i = 0; i < Math.max(1, count); i += 1) {
            const scoped = new Map(scopes);
            if (typeof args.as === 'string')
              scoped.set(
                args.as,
                each
                  ? ((args.items as Record<string, Scalar>[])[i] ?? {})
                  : {index: i, number: i + 1},
              );
            const frame = {scope: String(args.as ?? ''), index: i, number: i + 1};
            const context = {...parent, frames: [...parent.frames, frame]};
            if (count > 0)
              emit({wait: 0}, {...origin, frames: context.frames, boundary: true}, active);
            walk(
              args.do as RecordValue[],
              [...path, command, 'do'],
              scoped,
              context,
              active && count > 0,
            );
          }
        } else {
          const resolved = resolve(action, scopes, path) as RecordValue;
          const args = resolved[command!];
          if (record(args) && typeof args.stableId === 'string' && parent.frames.length) {
            args.stableId += `__iteration_${parent.frames.map((frame) => frame.index).join('_')}`;
          }
          emit(resolved, origin, active);
        }
      });
    }
    walk(body, path, new Map(), {frames: [], guards: []}, true);
    scenes[sceneId] = Array.isArray(scene) ? expanded : {...scene, actions: expanded};
  }
  return {story: {...input, kamishibai: '4.0', scenes}, origins, validation};
}
