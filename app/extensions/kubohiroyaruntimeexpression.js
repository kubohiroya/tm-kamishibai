// Name: Runtime Expression
// ID: kubohiroyaruntimeexpression
// Description: Safely evaluate JavaScript-like conditions over Temporary Variables runtime variables.
// By: Hiroya Kubo
// License: MPL-2.0

(function (Scratch) {
  'use strict';

  var __defProp = Object.defineProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
  const extensionName = "Runtime Expression";
  const blocks = [{ "opcode": "validateConditionSyntax", "blockType": "REPORTER", "text": "validate condition syntax [EXPRESSION]", "description": "Returns a JSON syntax-validation result without reading runtime variables or evaluating the expression.", "hideFromPalette": true, "arguments": { "EXPRESSION": { "type": "STRING", "defaultValue": 'state == "ready"' } } }, { "opcode": "runtimeCondition", "blockType": "BOOLEAN", "text": "condition [EXPRESSION]", "description": "Safely evaluates a JavaScript-like condition using Temporary Variables runtime variables.", "featureFlag": "runtimeExpression", "arguments": { "EXPRESSION": { "type": "STRING", "defaultValue": 'state == "ready"' } } }, { "opcode": "registerConditionalBroadcast", "blockType": "COMMAND", "text": "register [ID] conditional broadcast [CONDITION] [MESSAGE_ON_TRUE] / [MESSAGE_ON_FALSE] with [TIMEOUT] seconds timeout", "description": "Registers broadcasts for false-to-true and true-to-false runtime condition changes.", "featureFlag": "conditionalBroadcast", "arguments": { "ID": { "type": "STRING", "defaultValue": "watcher" }, "CONDITION": { "type": "STRING", "defaultValue": 'state == "ready"' }, "MESSAGE_ON_TRUE": { "type": "STRING", "defaultValue": "state ready" }, "MESSAGE_ON_FALSE": { "type": "STRING", "defaultValue": "state not ready" }, "TIMEOUT": { "type": "NUMBER", "defaultValue": 0 } } }, { "opcode": "unregisterConditionalBroadcast", "blockType": "COMMAND", "text": "unregister [ID] conditional broadcast", "description": "Unregisters the conditional broadcast with the matching ID.", "featureFlag": "conditionalBroadcast", "arguments": { "ID": { "type": "STRING", "defaultValue": "watcher" } } }];
  const definitions = {
    extensionName,
    blocks
  };
  const FEATURE_FLAGS = {
    conditionalBroadcast: true,
    runtimeExpression: true
  };
  const MAX_EXPRESSION_LENGTH = 4096;
  const MAX_TOKEN_COUNT = 512;
  const MAX_PARSE_DEPTH = 64;
  const MAX_CACHE_ENTRIES = 128;
  function collectRuntimeVariableNames(expression) {
    const names = /* @__PURE__ */ new Set();
    const visit = (node) => {
      switch (node.kind) {
        case "literal":
          return;
        case "variable":
          names.add(node.name);
          return;
        case "unary":
          visit(node.operand);
          return;
        case "binary":
          visit(node.left);
          visit(node.right);
      }
    };
    visit(expression);
    return [...names];
  }
  const MULTI_CHAR_OPERATORS = [
    "===",
    "!==",
    "==",
    "!=",
    "<=",
    ">=",
    "&&",
    "||"
  ];
  const SIMPLE_ESCAPES = {
    "\\": "\\",
    '"': '"',
    "'": "'",
    n: "\n",
    r: "\r",
    t: "	"
  };
  class ConditionSyntaxError extends Error {
    constructor(message, position) {
      super(`${message} at position ${position}.`);
      __publicField(this, "position");
      this.position = position;
      this.name = "ConditionSyntaxError";
    }
  }
  function tokenizeCondition(expression) {
    if (expression.length > MAX_EXPRESSION_LENGTH) {
      throw new ConditionSyntaxError(
        `Expression exceeds the ${MAX_EXPRESSION_LENGTH} character limit`,
        MAX_EXPRESSION_LENGTH
      );
    }
    const tokens = [];
    let index = 0;
    const push = (token) => {
      tokens.push(token);
      if (tokens.length > MAX_TOKEN_COUNT) {
        throw new ConditionSyntaxError(
          `Expression exceeds the ${MAX_TOKEN_COUNT} token limit`,
          token.position
        );
      }
    };
    while (index < expression.length) {
      const character = expression[index];
      if (/\s/u.test(character)) {
        index += 1;
        continue;
      }
      const position = index;
      const operator = MULTI_CHAR_OPERATORS.find(
        (candidate) => expression.startsWith(candidate, index)
      );
      if (operator) {
        push({ kind: "operator", value: operator, position });
        index += operator.length;
        continue;
      }
      if ("!+-*/%<>".includes(character)) {
        push({
          kind: "operator",
          value: character,
          position
        });
        index += 1;
        continue;
      }
      if ("()[]".includes(character)) {
        push({ kind: "punctuation", value: character, position });
        index += 1;
        continue;
      }
      if (character === '"' || character === "'") {
        const quote = character;
        let value = "";
        index += 1;
        let closed = false;
        while (index < expression.length) {
          const next = expression[index];
          if (next === quote) {
            closed = true;
            index += 1;
            break;
          }
          if (next === "\n" || next === "\r") {
            throw new ConditionSyntaxError("Unescaped newline in string literal", index);
          }
          if (next !== "\\") {
            value += next;
            index += 1;
            continue;
          }
          const escapePosition = index;
          index += 1;
          const escaped = expression[index];
          if (escaped === void 0) {
            throw new ConditionSyntaxError("Unterminated string escape", escapePosition);
          }
          if (escaped === "u") {
            const hexadecimal = expression.slice(index + 1, index + 5);
            if (!/^[0-9a-fA-F]{4}$/u.test(hexadecimal)) {
              throw new ConditionSyntaxError("Invalid Unicode escape", escapePosition);
            }
            value += String.fromCharCode(Number.parseInt(hexadecimal, 16));
            index += 5;
            continue;
          }
          const replacement = SIMPLE_ESCAPES[escaped];
          if (replacement === void 0) {
            throw new ConditionSyntaxError(`Unsupported string escape \\${escaped}`, escapePosition);
          }
          value += replacement;
          index += 1;
        }
        if (!closed) {
          throw new ConditionSyntaxError("Unterminated string literal", position);
        }
        push({ kind: "string", value, position });
        continue;
      }
      const rest = expression.slice(index);
      const numberMatch = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/u.exec(rest);
      if (numberMatch?.[0]) {
        const value = Number(numberMatch[0]);
        if (!Number.isFinite(value)) {
          throw new ConditionSyntaxError("Number literal must be finite", position);
        }
        push({ kind: "number", value, position });
        index += numberMatch[0].length;
        continue;
      }
      const identifierMatch = /^[A-Za-z_$][A-Za-z0-9_$]*/u.exec(rest);
      if (identifierMatch?.[0]) {
        push({ kind: "identifier", value: identifierMatch[0], position });
        index += identifierMatch[0].length;
        continue;
      }
      throw new ConditionSyntaxError(`Unexpected character ${JSON.stringify(character)}`, position);
    }
    push({ kind: "eof", position: expression.length });
    return tokens;
  }
  class ConditionParser {
    constructor(tokens) {
      __publicField(this, "tokens");
      __publicField(this, "index", 0);
      __publicField(this, "depth", 0);
      this.tokens = tokens;
    }
    parse() {
      if (this.current().kind === "eof") {
        throw new ConditionSyntaxError("Expression is empty", this.current().position);
      }
      const expression = this.parseLogicalOr();
      const trailing = this.current();
      if (trailing.kind !== "eof") {
        throw new ConditionSyntaxError("Unexpected trailing token", trailing.position);
      }
      return expression;
    }
    parseLogicalOr() {
      let expression = this.parseLogicalAnd();
      while (this.matchOperator("||")) {
        expression = {
          kind: "binary",
          operator: "||",
          left: expression,
          right: this.parseLogicalAnd()
        };
      }
      return expression;
    }
    parseLogicalAnd() {
      let expression = this.parseEquality();
      while (this.matchOperator("&&")) {
        expression = {
          kind: "binary",
          operator: "&&",
          left: expression,
          right: this.parseEquality()
        };
      }
      return expression;
    }
    parseEquality() {
      let expression = this.parseRelational();
      while (this.isOperator("==", "!=", "===", "!==")) {
        const operator = this.advanceOperator();
        expression = {
          kind: "binary",
          operator,
          left: expression,
          right: this.parseRelational()
        };
      }
      return expression;
    }
    parseRelational() {
      let expression = this.parseAdditive();
      while (this.isOperator("<", "<=", ">", ">=")) {
        const operator = this.advanceOperator();
        expression = {
          kind: "binary",
          operator,
          left: expression,
          right: this.parseAdditive()
        };
      }
      return expression;
    }
    parseAdditive() {
      let expression = this.parseMultiplicative();
      while (this.isOperator("+", "-")) {
        const operator = this.advanceOperator();
        expression = {
          kind: "binary",
          operator,
          left: expression,
          right: this.parseMultiplicative()
        };
      }
      return expression;
    }
    parseMultiplicative() {
      let expression = this.parseUnary();
      while (this.isOperator("*", "/", "%")) {
        const operator = this.advanceOperator();
        expression = {
          kind: "binary",
          operator,
          left: expression,
          right: this.parseUnary()
        };
      }
      return expression;
    }
    parseUnary() {
      if (this.isOperator("!", "+", "-")) {
        const token = this.current();
        const operator = this.advanceOperator();
        return this.withDepth(token.position, () => ({
          kind: "unary",
          operator,
          operand: this.parseUnary()
        }));
      }
      return this.parsePrimary();
    }
    parsePrimary() {
      const token = this.current();
      if (token.kind === "number" || token.kind === "string") {
        this.index += 1;
        return { kind: "literal", value: token.value };
      }
      if (token.kind === "identifier") {
        this.index += 1;
        if (token.value === "true") return { kind: "literal", value: true };
        if (token.value === "false") return { kind: "literal", value: false };
        if (token.value === "null") return { kind: "literal", value: null };
        if (token.value === "undefined") return { kind: "literal", value: void 0 };
        if (token.value === "vars" && this.matchPunctuation("[")) {
          const nameToken = this.current();
          if (nameToken.kind !== "string") {
            throw new ConditionSyntaxError(
              "vars[...] requires a string literal variable name",
              nameToken.position
            );
          }
          this.index += 1;
          this.expectPunctuation("]");
          return { kind: "variable", name: nameToken.value };
        }
        return { kind: "variable", name: token.value };
      }
      if (this.matchPunctuation("(")) {
        return this.withDepth(token.position, () => {
          const expression = this.parseLogicalOr();
          this.expectPunctuation(")");
          return expression;
        });
      }
      throw new ConditionSyntaxError("Expected a literal, variable, or parenthesized expression", token.position);
    }
    withDepth(position, action) {
      this.depth += 1;
      if (this.depth > MAX_PARSE_DEPTH) {
        throw new ConditionSyntaxError(
          `Expression exceeds the ${MAX_PARSE_DEPTH} nesting limit`,
          position
        );
      }
      try {
        return action();
      } finally {
        this.depth -= 1;
      }
    }
    current() {
      return this.tokens[this.index] ?? { kind: "eof", position: 0 };
    }
    isOperator(...operators) {
      const token = this.current();
      return token.kind === "operator" && operators.includes(token.value);
    }
    matchOperator(operator) {
      if (!this.isOperator(operator)) return false;
      this.index += 1;
      return true;
    }
    advanceOperator() {
      const token = this.current();
      if (token.kind !== "operator") {
        throw new ConditionSyntaxError("Expected an operator", token.position);
      }
      this.index += 1;
      return token.value;
    }
    matchPunctuation(punctuation) {
      const token = this.current();
      if (token.kind !== "punctuation" || token.value !== punctuation) return false;
      this.index += 1;
      return true;
    }
    expectPunctuation(punctuation) {
      const token = this.current();
      if (token.kind !== "punctuation" || token.value !== punctuation) {
        throw new ConditionSyntaxError(`Expected ${punctuation}`, token.position);
      }
      this.index += 1;
    }
  }
  function parseCondition(expression) {
    return new ConditionParser(tokenizeCondition(expression)).parse();
  }
  function validateConditionSyntax(expression) {
    try {
      parseCondition(expression);
      return { ok: true };
    } catch (error) {
      if (!(error instanceof ConditionSyntaxError)) throw error;
      return {
        ok: false,
        code: "CONDITION_SYNTAX_ERROR",
        position: error.position,
        message: error.message
      };
    }
  }
  function evaluateConditionExpression(expression, resolveVariable) {
    switch (expression.kind) {
      case "literal":
        return expression.value;
      case "variable":
        return resolveVariable(expression.name);
      case "unary": {
        const value = evaluateConditionExpression(expression.operand, resolveVariable);
        if (expression.operator === "!") return !value;
        if (expression.operator === "+") return Number(value);
        return -Number(value);
      }
      case "binary": {
        const left = evaluateConditionExpression(expression.left, resolveVariable);
        if (expression.operator === "&&") {
          return left && evaluateConditionExpression(expression.right, resolveVariable);
        }
        if (expression.operator === "||") {
          return left || evaluateConditionExpression(expression.right, resolveVariable);
        }
        const right = evaluateConditionExpression(expression.right, resolveVariable);
        switch (expression.operator) {
          case "==":
            return left == right;
          case "!=":
            return left != right;
          case "===":
            return left === right;
          case "!==":
            return left !== right;
          case "<":
            return left < right;
          case "<=":
            return left <= right;
          case ">":
            return left > right;
          case ">=":
            return left >= right;
          case "+":
            return left + right;
          case "-":
            return left - right;
          case "*":
            return left * right;
          case "/":
            return left / right;
          case "%":
            return left % right;
        }
      }
    }
  }
  class ConditionEvaluator {
    constructor() {
      __publicField(this, "cache", /* @__PURE__ */ new Map());
    }
    parse(expression) {
      const cached = this.cache.get(expression);
      if (cached) {
        this.cache.delete(expression);
        this.cache.set(expression, cached);
        return cached;
      }
      const parsed = parseCondition(expression);
      this.cache.set(expression, parsed);
      if (this.cache.size > MAX_CACHE_ENTRIES) {
        const oldest = this.cache.keys().next().value;
        if (oldest !== void 0) this.cache.delete(oldest);
      }
      return parsed;
    }
    evaluate(expression, resolveVariable) {
      return Boolean(evaluateConditionExpression(this.parse(expression), resolveVariable));
    }
  }
  function getRuntimeVariablesIfAvailable(runtime) {
    const extension = runtime.ext_lmsTempVars2;
    if (!extension || typeof extension.setRuntimeVariable !== "function" || typeof extension.getRuntimeVariable !== "function" || typeof extension.runtimeVariableExists !== "function") {
      return void 0;
    }
    return extension;
  }
  function requireRuntimeVariables(runtime) {
    const extension = getRuntimeVariablesIfAvailable(runtime);
    if (extension) return extension;
    throw new Error(
      "Temporary Variables (lmsTempVars2) must be loaded before using Runtime Expression."
    );
  }
  function readRuntimeVariableState(extension, name) {
    const exists = extension.runtimeVariableExists({ VAR: name });
    return {
      exists,
      value: exists ? extension.getRuntimeVariable({ VAR: name }) : void 0
    };
  }
  function readRuntimeVariable(extension, name) {
    return readRuntimeVariableState(extension, name).value;
  }
  class ConditionalBroadcastManager {
    constructor(runtime, evaluator = new ConditionEvaluator(), now = () => performance.now()) {
      __publicField(this, "runtime");
      __publicField(this, "evaluator");
      __publicField(this, "now");
      __publicField(this, "registrations", /* @__PURE__ */ new Map());
      this.runtime = runtime;
      this.evaluator = evaluator;
      this.now = now;
    }
    register(input) {
      const runtimeVariables = requireRuntimeVariables(this.runtime);
      const expression = this.evaluator.parse(input.condition);
      const dependencies = collectRuntimeVariableNames(expression);
      const snapshot = captureSnapshot(
        dependencies,
        (name) => readRuntimeVariableState(runtimeVariables, name)
      );
      const result = evaluateSnapshot(expression, snapshot);
      const expiresAt = input.timeoutSeconds > 0 ? this.now() + input.timeoutSeconds * 1e3 : null;
      this.registrations.set(input.id, {
        expression,
        dependencies,
        snapshot,
        result,
        messageOnTrue: input.messageOnTrue,
        messageOnFalse: input.messageOnFalse,
        expiresAt
      });
    }
    unregister(id) {
      this.registrations.delete(id);
    }
    clear() {
      this.registrations.clear();
    }
    processFrame() {
      if (this.registrations.size === 0) return;
      const now = this.now();
      for (const [id, registration] of this.registrations) {
        if (registration.expiresAt !== null && now >= registration.expiresAt) {
          this.registrations.delete(id);
        }
      }
      if (this.registrations.size === 0) return;
      const runtimeVariables = getRuntimeVariablesIfAvailable(this.runtime);
      if (!runtimeVariables) return;
      const readState = createCachedStateReader(runtimeVariables);
      for (const registration of this.registrations.values()) {
        const snapshot = captureSnapshot(registration.dependencies, readState);
        if (snapshotsEqual(registration.snapshot, snapshot)) continue;
        const result = evaluateSnapshot(registration.expression, snapshot);
        const previousResult = registration.result;
        registration.snapshot = snapshot;
        registration.result = result;
        if (result === previousResult) continue;
        const message = result ? registration.messageOnTrue : registration.messageOnFalse;
        this.runtime.startHats("event_whenbroadcastreceived", {
          BROADCAST_OPTION: message
        });
      }
    }
  }
  function captureSnapshot(dependencies, readState) {
    return new Map(
      dependencies.map((name) => [name, readState(name)])
    );
  }
  function createCachedStateReader(extension) {
    const cache = /* @__PURE__ */ new Map();
    return (name) => {
      const cached = cache.get(name);
      if (cached) return cached;
      const state = readRuntimeVariableState(extension, name);
      cache.set(name, state);
      return state;
    };
  }
  function evaluateSnapshot(expression, snapshot) {
    return Boolean(evaluateConditionExpression(
      expression,
      (name) => snapshot.get(name)?.value
    ));
  }
  function snapshotsEqual(left, right) {
    if (left.size !== right.size) return false;
    for (const [name, leftState] of left) {
      const rightState = right.get(name);
      if (!rightState || leftState.exists !== rightState.exists || !Object.is(leftState.value, rightState.value)) {
        return false;
      }
    }
    return true;
  }
  const EXTENSION_ID = "kubohiroyaruntimeexpression";
  const blockDefinitions = definitions.blocks;
  class RuntimeExpressionExtension {
    constructor() {
      __publicField(this, "runtime", Scratch.vm.runtime);
      __publicField(this, "evaluator", new ConditionEvaluator());
      __publicField(this, "conditionalBroadcasts", new ConditionalBroadcastManager(this.runtime, this.evaluator));
      this.runtime.on(
        "BEFORE_EXECUTE",
        () => this.conditionalBroadcasts.processFrame()
      );
      const clearConditionalBroadcasts = () => this.conditionalBroadcasts.clear();
      this.runtime.on("PROJECT_START", clearConditionalBroadcasts);
      this.runtime.on("PROJECT_STOP_ALL", clearConditionalBroadcasts);
    }
    getInfo() {
      return {
        id: EXTENSION_ID,
        name: Scratch.translate(definitions.extensionName),
        color1: "#6f5bd3",
        color2: "#5845b8",
        color3: "#40328e",
        blocks: blockDefinitions.filter((block) => !block.featureFlag || FEATURE_FLAGS[block.featureFlag]).map((block) => ({
          opcode: block.opcode,
          blockType: Scratch.BlockType[block.blockType],
          text: Scratch.translate(block.text),
          ...block.hideFromPalette ? { hideFromPalette: true } : {},
          arguments: Object.fromEntries(
            Object.entries(block.arguments).map(([name, argument]) => [
              name,
              {
                type: Scratch.ArgumentType[argument.type],
                defaultValue: argument.defaultValue
              }
            ])
          )
        }))
      };
    }
    runtimeCondition(args) {
      const runtimeVariables = requireRuntimeVariables(this.runtime);
      return this.evaluator.evaluate(
        String(args.EXPRESSION ?? ""),
        (name) => readRuntimeVariable(runtimeVariables, name)
      );
    }
    validateConditionSyntax(args) {
      return JSON.stringify(
        validateConditionSyntax(String(args.EXPRESSION ?? ""))
      );
    }
    registerConditionalBroadcast(args) {
      this.conditionalBroadcasts.register({
        id: String(args.ID ?? ""),
        condition: String(args.CONDITION ?? ""),
        messageOnTrue: String(args.MESSAGE_ON_TRUE ?? ""),
        messageOnFalse: String(args.MESSAGE_ON_FALSE ?? ""),
        timeoutSeconds: Number(args.TIMEOUT ?? 0)
      });
    }
    unregisterConditionalBroadcast(args) {
      this.conditionalBroadcasts.unregister(String(args.ID ?? ""));
    }
  }
  if (!Scratch.extensions.unsandboxed) {
    throw new Error("Runtime Expression must run unsandboxed.");
  }
  Scratch.extensions.register(new RuntimeExpressionExtension());

})(Scratch);
