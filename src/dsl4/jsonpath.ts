const exactIntegerMaximum = 9007199254740991;
const whitespaceCodePoints = new Set([0x09, 0x0a, 0x0d, 0x20]);

export const dsl4JsonPathDefaultLimits = Object.freeze({
  maxAstNodes: 128,
  maxNormalizedPathScalars: 4096,
  maxQueryScalars: 1024,
  maxResults: 1000,
  maxSegments: 32,
  maxSelectorsPerSegment: 16,
  maxVisits: 10000,
});

class JsonPathFailure extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function success<T>(value: T): Readonly<{ok: true; value: T}> {
  return Object.freeze({ok: true, value}) as Readonly<{ok: true; value: T}>;
}

function failure(
  code: string,
  operation: string,
  message: string,
): Readonly<{ok: false; error: Readonly<{code: string; operation: string; message: string}>}> {
  return deepFreeze({ok: false, error: {code, operation, message}}) as Readonly<{
    ok: false;
    error: Readonly<{code: string; operation: string; message: string}>;
  }>;
}

function normalizeLimits(inputLimits: unknown) {
  if (inputLimits === undefined) return dsl4JsonPathDefaultLimits;
  if (typeof inputLimits !== 'object' || inputLimits === null || Array.isArray(inputLimits)) {
    throw new TypeError('limits must be an object');
  }
  const limits = inputLimits as Record<string, unknown>;
  if (Object.keys(limits).some((name) => !Object.hasOwn(dsl4JsonPathDefaultLimits, name))) {
    throw new TypeError('limits contain an unknown field');
  }
  const normalized = {...dsl4JsonPathDefaultLimits, ...limits};
  const defaults = dsl4JsonPathDefaultLimits as Readonly<Record<string, number>>;
  for (const [name, value] of Object.entries(normalized)) {
    const defaultValue = defaults[name];
    if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > defaultValue) {
      throw new TypeError(`${name} must be a positive safe integer no greater than its default`);
    }
  }
  return Object.freeze(normalized as typeof dsl4JsonPathDefaultLimits);
}

function unicodeScalarLength(value: string) {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return null;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return null;
    }
    count += 1;
  }
  return count;
}

function isWhitespace(codePoint: number) {
  return whitespaceCodePoints.has(codePoint);
}

function isAsciiDigit(codePoint: number) {
  return codePoint >= 0x30 && codePoint <= 0x39;
}

function isNameFirst(codePoint: number) {
  return (
    (codePoint >= 0x41 && codePoint <= 0x5a) ||
    (codePoint >= 0x61 && codePoint <= 0x7a) ||
    codePoint === 0x5f ||
    codePoint >= 0x80
  );
}

function isNameCharacter(codePoint: number) {
  return isNameFirst(codePoint) || isAsciiDigit(codePoint);
}

function codePointWidth(codePoint: number) {
  return codePoint > 0xffff ? 2 : 1;
}

function queryCodePointAt(query: string, index: number) {
  return query.codePointAt(index) ?? -1;
}

function skipWhitespace(state: any) {
  while (
    state.index < state.query.length &&
    isWhitespace(queryCodePointAt(state.query, state.index))
  ) {
    state.index += 1;
  }
}

function syntax(state: any, message = 'The JSONPath query is not valid subset syntax'): never {
  throw new JsonPathFailure('SD-JSONPATH-SYNTAX', message);
}

function unsupported(message = 'The JSONPath query uses an unsupported feature'): never {
  throw new JsonPathFailure('SD-JSONPATH-UNSUPPORTED', message);
}

function unsupportedOrSyntax(state: any) {
  if (state.query.startsWith('..', state.index)) unsupported();
  const codePoint = queryCodePointAt(state.query, state.index);
  if (
    codePoint === 0x3f ||
    codePoint === 0x40 ||
    codePoint === 0x28 ||
    codePoint === 0x29 ||
    codePoint === 0x3d
  ) {
    unsupported();
  }
  let cursor = state.index;
  while (cursor < state.query.length) {
    const current = queryCodePointAt(state.query, cursor);
    if (current === 0x2c || current === 0x5d || isWhitespace(current)) break;
    if (current === 0x28 || current === 0x40 || current === 0x3f || current === 0x3d) {
      unsupported();
    }
    cursor += codePointWidth(current);
  }
  syntax(state);
}

function hexDigitValue(codePoint: number) {
  if (codePoint >= 0x30 && codePoint <= 0x39) return codePoint - 0x30;
  if (codePoint >= 0x41 && codePoint <= 0x46) return codePoint - 0x41 + 10;
  if (codePoint >= 0x61 && codePoint <= 0x66) return codePoint - 0x61 + 10;
  return -1;
}

function readUnicodeEscape(state: any) {
  let value = 0;
  for (let count = 0; count < 4; count += 1) {
    const digit = hexDigitValue(queryCodePointAt(state.query, state.index));
    if (digit < 0) syntax(state, 'A JSONPath Unicode escape is invalid');
    value = value * 16 + digit;
    state.index += 1;
  }
  return value;
}

function parseQuotedName(state: any) {
  const delimiter = queryCodePointAt(state.query, state.index);
  state.index += 1;
  let value = '';
  while (state.index < state.query.length) {
    const codePoint = queryCodePointAt(state.query, state.index);
    if (codePoint === delimiter) {
      state.index += 1;
      return {kind: 'name', name: value};
    }
    if (codePoint === 0x5c) {
      state.index += 1;
      const escaped = queryCodePointAt(state.query, state.index);
      if (escaped < 0) syntax(state, 'A JSONPath string escape is incomplete');
      state.index += 1;
      const simpleEscapes = new Map([
        [0x62, '\b'],
        [0x66, '\f'],
        [0x6e, '\n'],
        [0x72, '\r'],
        [0x74, '\t'],
        [0x2f, '/'],
        [0x5c, '\\'],
      ]);
      if (simpleEscapes.has(escaped)) {
        value += simpleEscapes.get(escaped);
        continue;
      }
      if (escaped === delimiter) {
        value += String.fromCodePoint(escaped);
        continue;
      }
      if (escaped !== 0x75) syntax(state, 'A JSONPath string escape is unsupported');
      const first = readUnicodeEscape(state);
      if (first >= 0xd800 && first <= 0xdbff) {
        if (
          queryCodePointAt(state.query, state.index) !== 0x5c ||
          queryCodePointAt(state.query, state.index + 1) !== 0x75
        ) {
          syntax(state, 'A JSONPath surrogate escape is incomplete');
        }
        state.index += 2;
        const second = readUnicodeEscape(state);
        if (second < 0xdc00 || second > 0xdfff) {
          syntax(state, 'A JSONPath surrogate escape is invalid');
        }
        value += String.fromCodePoint(0x10000 + (first - 0xd800) * 0x400 + second - 0xdc00);
        continue;
      }
      if (first >= 0xdc00 && first <= 0xdfff) {
        syntax(state, 'A JSONPath surrogate escape is invalid');
      }
      value += String.fromCodePoint(first);
      continue;
    }
    if (codePoint < 0x20) syntax(state, 'A JSONPath quoted name contains a control character');
    value += String.fromCodePoint(codePoint);
    state.index += codePointWidth(codePoint);
  }
  syntax(state, 'A JSONPath quoted name is not terminated');
}

function parseInteger(state: any) {
  const start = state.index;
  let negative = false;
  if (queryCodePointAt(state.query, state.index) === 0x2d) {
    negative = true;
    state.index += 1;
  }
  const first = queryCodePointAt(state.query, state.index);
  if (!isAsciiDigit(first)) syntax(state, 'A JSONPath integer is invalid');
  if (first === 0x30) {
    if (negative) syntax(state, 'Negative zero is not a JSONPath integer');
    state.index += 1;
  } else {
    state.index += 1;
    while (isAsciiDigit(queryCodePointAt(state.query, state.index))) state.index += 1;
  }
  const value = Number(state.query.slice(start, state.index));
  if (!Number.isSafeInteger(value) || Math.abs(value) > exactIntegerMaximum) {
    syntax(state, 'A JSONPath integer is outside the I-JSON exact range');
  }
  return value;
}

function parseNumericSelector(state: any) {
  const firstCodePoint = queryCodePointAt(state.query, state.index);
  const hasStart = firstCodePoint === 0x2d || isAsciiDigit(firstCodePoint);
  const start = hasStart ? parseInteger(state) : null;
  skipWhitespace(state);
  if (queryCodePointAt(state.query, state.index) !== 0x3a) {
    if (start === null) unsupportedOrSyntax(state);
    return {kind: 'index', index: start};
  }
  state.index += 1;
  skipWhitespace(state);
  const endCodePoint = queryCodePointAt(state.query, state.index);
  const hasEnd = endCodePoint === 0x2d || isAsciiDigit(endCodePoint);
  const end = hasEnd ? parseInteger(state) : null;
  skipWhitespace(state);
  let step = null;
  if (queryCodePointAt(state.query, state.index) === 0x3a) {
    state.index += 1;
    skipWhitespace(state);
    const stepCodePoint = queryCodePointAt(state.query, state.index);
    if (stepCodePoint === 0x2d || isAsciiDigit(stepCodePoint)) step = parseInteger(state);
    skipWhitespace(state);
  }
  return {kind: 'slice', start, end, step};
}

function parseSelector(state: any) {
  const codePoint = queryCodePointAt(state.query, state.index);
  if (codePoint === 0x22 || codePoint === 0x27) return parseQuotedName(state);
  if (codePoint === 0x2a) {
    state.index += 1;
    return {kind: 'wildcard'};
  }
  if (codePoint === 0x3a || codePoint === 0x2d || isAsciiDigit(codePoint)) {
    return parseNumericSelector(state);
  }
  unsupportedOrSyntax(state);
}

function appendSegment(state: any, selectors: any[]) {
  if (selectors.length > state.limits.maxSelectorsPerSegment) {
    throw new JsonPathFailure('SD-JSONPATH-LIMIT', 'The selector limit was exceeded');
  }
  if (state.segments.length >= state.limits.maxSegments) {
    throw new JsonPathFailure('SD-JSONPATH-LIMIT', 'The segment limit was exceeded');
  }
  const nextAstNodes = state.astNodes + 1 + selectors.length;
  if (nextAstNodes > state.limits.maxAstNodes) {
    throw new JsonPathFailure('SD-JSONPATH-LIMIT', 'The compiled AST limit was exceeded');
  }
  state.astNodes = nextAstNodes;
  state.segments.push({kind: 'child', selectors});
}

function parseDotSegment(state: any) {
  state.index += 1;
  if (queryCodePointAt(state.query, state.index) === 0x2e) unsupported();
  if (queryCodePointAt(state.query, state.index) === 0x2a) {
    state.index += 1;
    appendSegment(state, [{kind: 'wildcard'}]);
    return;
  }
  const first = queryCodePointAt(state.query, state.index);
  if (!isNameFirst(first)) unsupportedOrSyntax(state);
  let name = String.fromCodePoint(first);
  state.index += codePointWidth(first);
  while (isNameCharacter(queryCodePointAt(state.query, state.index))) {
    const codePoint = queryCodePointAt(state.query, state.index);
    name += String.fromCodePoint(codePoint);
    state.index += codePointWidth(codePoint);
  }
  appendSegment(state, [{kind: 'name', name}]);
}

function parseBracketSegment(state: any) {
  state.index += 1;
  skipWhitespace(state);
  if (queryCodePointAt(state.query, state.index) === 0x5d) syntax(state);
  const selectors = [];
  while (state.index < state.query.length) {
    if (selectors.length >= state.limits.maxSelectorsPerSegment) {
      throw new JsonPathFailure('SD-JSONPATH-LIMIT', 'The selector limit was exceeded');
    }
    selectors.push(parseSelector(state));
    skipWhitespace(state);
    const separator = queryCodePointAt(state.query, state.index);
    if (separator === 0x2c) {
      state.index += 1;
      skipWhitespace(state);
      if (queryCodePointAt(state.query, state.index) === 0x5d) syntax(state);
      continue;
    }
    if (separator === 0x5d) {
      state.index += 1;
      appendSegment(state, selectors);
      return;
    }
    unsupportedOrSyntax(state);
  }
  syntax(state, 'A JSONPath bracket segment is not terminated');
}

function compileQuery(query: string, limits: any) {
  if (typeof query !== 'string') {
    throw new JsonPathFailure('SD-JSONPATH-SYNTAX', 'The JSONPath query must be a string');
  }
  const scalarLength = unicodeScalarLength(query);
  if (scalarLength === null) {
    throw new JsonPathFailure(
      'SD-JSONPATH-SYNTAX',
      'The JSONPath query contains a non-scalar value',
    );
  }
  if (scalarLength > limits.maxQueryScalars) {
    throw new JsonPathFailure('SD-JSONPATH-LIMIT', 'The query scalar limit was exceeded');
  }
  if (queryCodePointAt(query, 0) !== 0x24) {
    throw new JsonPathFailure('SD-JSONPATH-SYNTAX', 'The JSONPath query must start with root');
  }
  const state = {query, index: 1, limits, segments: [], astNodes: 1} as any;
  while (state.index < query.length) {
    const whitespaceStart = state.index;
    skipWhitespace(state);
    if (state.index === query.length) {
      if (state.index !== whitespaceStart) syntax(state, 'Trailing JSONPath whitespace is invalid');
      break;
    }
    const codePoint = queryCodePointAt(query, state.index);
    if (codePoint === 0x2e) parseDotSegment(state);
    else if (codePoint === 0x5b) parseBracketSegment(state);
    else unsupportedOrSyntax(state);
  }
  const singular = state.segments.every(
    (segment: any) =>
      segment.selectors.length === 1 &&
      (segment.selectors[0].kind === 'name' || segment.selectors[0].kind === 'index'),
  );
  const program = deepFreeze({
    kind: 'Dsl4JsonPathProgram',
    version: 1,
    singular,
    astNodeCount: state.astNodes,
    segments: state.segments,
  });
  return program;
}

const rawJsonAdapter = Object.freeze({
  classify(node: unknown) {
    if (Array.isArray(node)) return 'array';
    if (typeof node === 'object' && node !== null) return 'object';
    return 'scalar';
  },
  objectEntries(node: Record<string, unknown>) {
    return Object.entries(node);
  },
  arrayLength(node: unknown[]) {
    return node.length;
  },
  arrayItem(node: unknown[], index: number) {
    return node[index];
  },
});

function validateAdapter(adapter: unknown): any {
  if (typeof adapter !== 'object' || adapter === null) {
    throw new TypeError('adapter must be an object');
  }
  const candidate = adapter as Record<string, unknown>;
  for (const method of ['classify', 'objectEntries', 'arrayLength', 'arrayItem']) {
    if (typeof candidate[method] !== 'function')
      throw new TypeError(`adapter.${method} is required`);
  }
  return adapter;
}

function normalizedNameSegment(name: string) {
  let encoded = '';
  for (let index = 0; index < name.length; index += 1) {
    const codePoint = name.codePointAt(index);
    if (codePoint === undefined) break;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
      throw new JsonPathFailure(
        'SD-JSONPATH-EVALUATION-LIMIT',
        'A result path cannot be represented as Unicode scalar values',
      );
    }
    if (codePoint > 0xffff) index += 1;
    const escaped = new Map([
      [0x08, '\\b'],
      [0x09, '\\t'],
      [0x0a, '\\n'],
      [0x0c, '\\f'],
      [0x0d, '\\r'],
      [0x27, "\\'"],
      [0x5c, '\\\\'],
    ]).get(codePoint);
    if (escaped !== undefined) encoded += escaped;
    else if (codePoint < 0x20) encoded += `\\u00${codePoint.toString(16).padStart(2, '0')}`;
    else encoded += String.fromCodePoint(codePoint);
  }
  return `['${encoded}']`;
}

function childResult(parent: any, key: string | number, limits: any, node: unknown) {
  const segment = typeof key === 'number' ? `[${key}]` : normalizedNameSegment(key);
  const normalizedPath = `${parent.normalizedPath}${segment}`;
  const scalarLength = unicodeScalarLength(normalizedPath);
  if (scalarLength === null || scalarLength > limits.maxNormalizedPathScalars) {
    throw new JsonPathFailure(
      'SD-JSONPATH-EVALUATION-LIMIT',
      'The normalized result path limit was exceeded',
    );
  }
  return {
    node,
    path: Object.freeze([...parent.path, key]),
    normalizedPath,
  };
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

function normalizeArrayIndex(value: number, length: number) {
  return value >= 0 ? value : length + value;
}

function adapterKind(adapter: any, node: unknown) {
  const kind = adapter.classify(node);
  if (kind !== 'object' && kind !== 'array' && kind !== 'scalar') {
    throw new JsonPathFailure(
      'SD-JSONPATH-EVALUATION-LIMIT',
      'The JSONPath node adapter returned an invalid kind',
    );
  }
  return kind;
}

function* adapterObjectEntries(adapter: any, node: unknown) {
  for (const entry of adapter.objectEntries(node)) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') {
      throw new JsonPathFailure(
        'SD-JSONPATH-EVALUATION-LIMIT',
        'The JSONPath node adapter returned invalid object entries',
      );
    }
    yield entry;
  }
}

function adapterArrayLength(adapter: any, node: unknown) {
  const length = adapter.arrayLength(node);
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new JsonPathFailure(
      'SD-JSONPATH-EVALUATION-LIMIT',
      'The JSONPath node adapter returned an invalid array length',
    );
  }
  return length;
}

/**
 * Create a pure RFC 9535 child-segment subset compiler and evaluator.
 */
export function createDsl4JsonPathEngine({
  limits: inputLimits,
  adapter = rawJsonAdapter,
}: {
  limits?: Partial<typeof dsl4JsonPathDefaultLimits> | undefined;
  adapter?: unknown;
} = {}) {
  const limits = normalizeLimits(inputLimits);
  const nodeAdapter = validateAdapter(adapter);
  const compiledPrograms = new WeakSet();

  function compile(query: unknown) {
    try {
      const program = compileQuery(query as string, limits);
      compiledPrograms.add(program);
      return success(program);
    } catch (error) {
      if (error instanceof JsonPathFailure) return failure(error.code, 'compile', error.message);
      return failure('SD-JSONPATH-SYNTAX', 'compile', 'The JSONPath query could not be compiled');
    }
  }

  function validateProgram(program: unknown) {
    const candidate = program as any;
    if (
      typeof program !== 'object' ||
      program === null ||
      !compiledPrograms.has(program) ||
      candidate.kind !== 'Dsl4JsonPathProgram' ||
      candidate.version !== 1 ||
      candidate.segments.length > limits.maxSegments ||
      candidate.astNodeCount > limits.maxAstNodes ||
      candidate.segments.some(
        (segment: any) => segment.selectors.length > limits.maxSelectorsPerSegment,
      )
    ) {
      throw new JsonPathFailure('SD-JSONPATH-SYNTAX', 'The compiled JSONPath program is invalid');
    }
    return candidate;
  }

  function evaluateProgram(program: unknown, root: unknown, requireSingular: boolean) {
    try {
      const compiled = validateProgram(program);
      if (requireSingular && !compiled.singular) {
        throw new JsonPathFailure(
          'SD-QUERY-NOT-SINGULAR',
          'The JSONPath query is not syntactically singular',
        );
      }
      let visits = 0;
      const results: Array<
        Readonly<{node: unknown; path: readonly (string | number)[]; normalizedPath: string}>
      > = [];

      function* select(input: any, selector: any) {
        visits += 1;
        if (visits > limits.maxVisits) {
          throw new JsonPathFailure(
            'SD-JSONPATH-EVALUATION-LIMIT',
            'The JSONPath node visit limit was exceeded',
          );
        }
        const kind = adapterKind(nodeAdapter, input.node);
        if (selector.kind === 'name') {
          if (kind !== 'object') return;
          for (const [name, child] of adapterObjectEntries(nodeAdapter, input.node)) {
            if (name === selector.name) {
              yield childResult(input, selector.name, limits, child);
              return;
            }
          }
          return;
        }
        if (selector.kind === 'wildcard') {
          if (kind === 'object') {
            for (const [name, child] of adapterObjectEntries(nodeAdapter, input.node)) {
              yield childResult(input, name, limits, child);
            }
            return;
          }
          if (kind === 'array') {
            const length = adapterArrayLength(nodeAdapter, input.node);
            for (let index = 0; index < length; index += 1) {
              yield childResult(input, index, limits, nodeAdapter.arrayItem(input.node, index));
            }
          }
          return;
        }
        if (kind !== 'array') return;
        const length = adapterArrayLength(nodeAdapter, input.node);
        if (selector.kind === 'index') {
          const index = normalizeArrayIndex(selector.index, length);
          if (index >= 0 && index < length) {
            yield childResult(input, index, limits, nodeAdapter.arrayItem(input.node, index));
          }
          return;
        }
        const step = selector.step ?? 1;
        if (step === 0) return;
        const defaultStart = step >= 0 ? 0 : length - 1;
        const defaultEnd = step >= 0 ? length : -length - 1;
        const normalizedStart = normalizeArrayIndex(selector.start ?? defaultStart, length);
        const normalizedEnd = normalizeArrayIndex(selector.end ?? defaultEnd, length);
        if (step > 0) {
          const lower = clamp(normalizedStart, 0, length);
          const upper = clamp(normalizedEnd, 0, length);
          for (let index = lower; index < upper; index += step) {
            yield childResult(input, index, limits, nodeAdapter.arrayItem(input.node, index));
          }
        } else {
          const upper = clamp(normalizedStart, -1, length - 1);
          const lower = clamp(normalizedEnd, -1, length - 1);
          for (let index = upper; lower < index; index += step) {
            yield childResult(input, index, limits, nodeAdapter.arrayItem(input.node, index));
          }
        }
      }

      function visit(input: any, segmentIndex: number) {
        if (segmentIndex >= compiled.segments.length) {
          if (results.length >= limits.maxResults) {
            throw new JsonPathFailure(
              'SD-JSONPATH-EVALUATION-LIMIT',
              'The JSONPath result limit was exceeded',
            );
          }
          results.push(Object.freeze(input));
          return;
        }
        for (const selector of compiled.segments[segmentIndex].selectors) {
          for (const selected of select(input, selector)) visit(selected, segmentIndex + 1);
        }
      }

      visit({node: root, path: Object.freeze([]), normalizedPath: '$'}, 0);
      return success(
        Object.freeze({
          kind: 'Dsl4JsonPathNodelist',
          singular: compiled.singular,
          nodes: Object.freeze(results),
          visits,
        }),
      );
    } catch (error) {
      if (error instanceof JsonPathFailure) return failure(error.code, 'evaluate', error.message);
      return failure(
        'SD-JSONPATH-EVALUATION-LIMIT',
        'evaluate',
        'The JSONPath evaluation could not be completed',
      );
    }
  }

  function evaluate(program: unknown, root: unknown) {
    return evaluateProgram(program, root, false);
  }

  function evaluateSingular(program: unknown, root: unknown) {
    return evaluateProgram(program, root, true);
  }

  function query(root: unknown, query: unknown) {
    const compiled = compile(query);
    return compiled.ok ? evaluate(compiled.value, root) : compiled;
  }

  function querySingular(root: unknown, query: unknown) {
    const compiled = compile(query);
    return compiled.ok ? evaluateSingular(compiled.value, root) : compiled;
  }

  return Object.freeze({limits, compile, evaluate, evaluateSingular, query, querySingular});
}
