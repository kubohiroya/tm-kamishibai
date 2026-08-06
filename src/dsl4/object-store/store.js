import {
  commitDsl4MapBackend,
  createDsl4MapBackend,
  initializeDsl4MapBackend,
  isDsl4MapBackend,
  readDsl4MapBackend,
} from './backend.js';
import {deepFreezeStoreValue as deepFreeze} from './freeze.js';

const handlePattern = /^@os1\.([A-Za-z0-9_-]{22,86})\.([A-Za-z0-9_-]{22,86})$/;
const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor']);
const handleKinds = new Set(['scope', 'owner', 'lease']);
const terminalHandleStates = new Set(['released', 'freed']);
const base64UrlAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const defaultLimits = Object.freeze({
  maxDepth: 64,
  maxEntries: 1024,
  maxHandles: 4096,
  maxNodes: 32768,
  maxNonceAttempts: 8,
  maxOperationSteps: 100000,
  maxScopes: 1024,
  maxStringLength: 1048576,
});

/** @type {WeakMap<object, {storeKey: object, nodeSlot: number, generation: number}>} */
const refValueMetadata = new WeakMap();

class StoreFailure extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {string} [handleKind]
   */
  constructor(code, message, handleKind) {
    super(message);
    this.code = code;
    this.handleKind = handleKind;
  }
}

class StoreInvariantFailure extends Error {}

/** @param {unknown} value */
export function isDsl4RefValue(value) {
  return typeof value === 'object' && value !== null && refValueMetadata.has(value);
}

/** @param {number} byteLength */
function defaultNonceSource(byteLength) {
  if (!globalThis.crypto?.getRandomValues) {
    throw new TypeError('A cryptographic nonce source is required');
  }
  return globalThis.crypto.getRandomValues(new Uint8Array(byteLength));
}

/** @param {Uint8Array} bytes */
function encodeBase64Url(bytes) {
  let encoded = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const third = index + 2 < bytes.length ? bytes[index + 2] : 0;
    const combined = (first << 16) | (second << 8) | third;
    encoded += base64UrlAlphabet[(combined >>> 18) & 63];
    encoded += base64UrlAlphabet[(combined >>> 12) & 63];
    if (index + 1 < bytes.length) encoded += base64UrlAlphabet[(combined >>> 6) & 63];
    if (index + 2 < bytes.length) encoded += base64UrlAlphabet[combined & 63];
  }
  return encoded;
}

/**
 * @param {(byteLength: number) => Uint8Array} nonceSource
 * @param {boolean} constructorPhase
 */
function createNonce(nonceSource, constructorPhase) {
  try {
    const bytes = nonceSource(16);
    if (!(bytes instanceof Uint8Array) || bytes.length < 16 || bytes.length > 64) {
      throw new TypeError('nonceSource must return between 16 and 64 bytes');
    }
    return encodeBase64Url(bytes);
  } catch (error) {
    if (constructorPhase) {
      throw error instanceof TypeError ? error : new TypeError('nonceSource failed');
    }
    throw new StoreFailure('STORE-BACKEND-FAILURE', 'The nonce source failed');
  }
}

/** @param {unknown} inputLimits */
function normalizeLimits(inputLimits) {
  if (inputLimits === undefined) return defaultLimits;
  if (typeof inputLimits !== 'object' || inputLimits === null || Array.isArray(inputLimits)) {
    throw new TypeError('limits must be an object');
  }
  const limits = /** @type {Record<string, unknown>} */ (inputLimits);
  const unknown = Object.keys(limits).filter((key) => !Object.hasOwn(defaultLimits, key));
  if (unknown.length > 0) throw new TypeError('limits contain an unknown field');
  const normalized = {...defaultLimits, ...limits};
  for (const [name, value] of Object.entries(normalized)) {
    if (!Number.isSafeInteger(value) || Number(value) < 1) {
      throw new TypeError(`${name} must be a positive safe integer`);
    }
  }
  return Object.freeze(/** @type {typeof defaultLimits} */ (normalized));
}

/** @param {string} code @param {string} operation @param {string} message @param {string} [handleKind] */
function failure(code, operation, message, handleKind) {
  return deepFreeze({
    ok: false,
    error: {
      code,
      operation,
      message,
      ...(handleKind ? {handleKind} : {}),
    },
  });
}

/** @template T @param {T} value */
function success(value) {
  return deepFreeze({ok: true, value});
}

/** @param {any} left @param {any} right */
function bySlot(left, right) {
  return left.slot - right.slot || left.generation - right.generation;
}

/** @param {string | number} left @param {string | number} right */
function compareMemberKeys(left, right) {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  if (typeof left === 'number') return -1;
  if (typeof right === 'number') return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** @param {any} working */
function freezeRoot(working) {
  const nodes = [...working.nodes.values()].sort(bySlot).map((node) => ({
    slot: node.slot,
    generation: node.generation,
    entrySlot: node.entrySlot,
    kind: node.kind,
    incomingCount: node.incomingCount,
    ...(node.kind === 'scalar'
      ? {scalar: node.scalar}
      : {
          members: [...node.members.entries()]
            .sort(([left], [right]) => compareMemberKeys(left, right))
            .map(([key, member]) => ({
              key,
              kind: member.kind,
              targetNodeSlot: member.targetNodeSlot,
            })),
        }),
  }));
  return deepFreeze({
    nextSlot: working.nextSlot,
    freeSlots: [...working.freeSlots].sort((left, right) => left - right),
    generations: [...working.generations.entries()]
      .sort(([left], [right]) => left - right)
      .map(([slot, generation]) => ({slot, generation})),
    handles: [...working.handles.values()]
      .sort((left, right) => left.token.localeCompare(right.token))
      .map((handle) => ({...handle})),
    scopes: [...working.scopes.values()].sort(bySlot).map((scope) => ({...scope})),
    entries: [...working.entries.values()].sort(bySlot).map((entry) => ({...entry})),
    leases: [...working.leases.values()].sort(bySlot).map((lease) => ({...lease})),
    nodes,
  });
}

/** @param {any} root */
function cloneRoot(root) {
  const generations = /** @type {any[]} */ (root.generations);
  const handles = /** @type {any[]} */ (root.handles);
  const scopes = /** @type {any[]} */ (root.scopes);
  const entries = /** @type {any[]} */ (root.entries);
  const leases = /** @type {any[]} */ (root.leases);
  const nodes = /** @type {any[]} */ (root.nodes);
  return {
    nextSlot: root.nextSlot,
    freeSlots: [...root.freeSlots],
    generations: new Map(generations.map((record) => [record.slot, record.generation])),
    handles: new Map(handles.map((record) => [record.token, {...record}])),
    scopes: new Map(scopes.map((record) => [record.slot, {...record}])),
    entries: new Map(entries.map((record) => [record.slot, {...record}])),
    leases: new Map(leases.map((record) => [record.slot, {...record}])),
    nodes: new Map(
      nodes.map((record) => [
        record.slot,
        {
          ...record,
          ...(record.kind === 'scalar'
            ? {}
            : {
                members: new Map(
                  /** @type {any[]} */ (record.members).map((member) => [
                    member.key,
                    {kind: member.kind, targetNodeSlot: member.targetNodeSlot},
                  ]),
                ),
              }),
        },
      ]),
    ),
  };
}

/** @param {any} working */
function allocateSlot(working) {
  const reused = working.freeSlots.shift();
  const slot = reused ?? working.nextSlot++;
  const generation = (working.generations.get(slot) ?? 0) + 1;
  working.generations.set(slot, generation);
  return {slot, generation};
}

/** @param {any} working @param {number} slot */
function releaseSlot(working, slot) {
  if (working.freeSlots.includes(slot)) throw new StoreInvariantFailure('Slot released twice');
  working.freeSlots.push(slot);
  working.freeSlots.sort((/** @type {number} */ left, /** @type {number} */ right) => left - right);
}

/**
 * @param {any} working
 * @param {any} context
 * @param {'scope' | 'owner' | 'lease'} kind
 * @param {number} slot
 * @param {number} generation
 * @param {number | null} ownerScopeSlot
 */
function issueHandle(working, context, kind, slot, generation, ownerScopeSlot) {
  if (working.handles.size >= context.limits.maxHandles) {
    throw new StoreFailure('STORE-LIMIT-EXCEEDED', 'The handle limit was exceeded');
  }
  for (let attempt = 0; attempt < context.limits.maxNonceAttempts; attempt += 1) {
    const token = `@os1.${context.realmNonce}.${createNonce(context.nonceSource, false)}`;
    if (working.handles.has(token)) continue;
    working.handles.set(token, {
      token,
      kind,
      slot,
      generation,
      state: 'active',
      ownerScopeSlot,
    });
    return token;
  }
  throw new StoreFailure('STORE-LIMIT-EXCEEDED', 'A unique handle could not be allocated');
}

/** @param {unknown} value @param {any} limits */
function normalizeStoredValue(value, limits) {
  const seen = new WeakSet();
  const active = new WeakSet();
  let nodeCount = 0;

  /** @param {unknown} current @param {number} depth @returns {any} */
  function visit(current, depth) {
    if (depth > limits.maxDepth) {
      throw new StoreFailure('STORE-LIMIT-EXCEEDED', 'The value depth limit was exceeded');
    }
    nodeCount += 1;
    if (nodeCount > limits.maxOperationSteps) {
      throw new StoreFailure('STORE-LIMIT-EXCEEDED', 'The value operation limit was exceeded');
    }
    if (current === null || typeof current === 'boolean') {
      return {kind: 'scalar', scalar: current};
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) {
        throw new StoreFailure('STORE-VALUE-INVALID', 'Stored numbers must be finite');
      }
      return {kind: 'scalar', scalar: current};
    }
    if (typeof current === 'string') {
      if (current.length > limits.maxStringLength) {
        throw new StoreFailure('STORE-LIMIT-EXCEEDED', 'The stored string limit was exceeded');
      }
      return {kind: 'scalar', scalar: current};
    }
    if (typeof current !== 'object') {
      throw new StoreFailure('STORE-VALUE-INVALID', 'Stored values must be JSON-like');
    }
    if (isDsl4RefValue(current)) {
      throw new StoreFailure('STORE-VALUE-INVALID', 'RefValue cannot be supplied as input data');
    }
    if (active.has(current)) {
      throw new StoreFailure('STORE-VALUE-CYCLE', 'Stored values must not contain a cycle');
    }
    if (seen.has(current)) {
      throw new StoreFailure('STORE-VALUE-INVALID', 'Stored values must not share object identity');
    }
    seen.add(current);
    active.add(current);

    if (Array.isArray(current)) {
      if (Object.getOwnPropertySymbols(current).length > 0) {
        throw new StoreFailure('STORE-VALUE-INVALID', 'Stored arrays cannot have symbol keys');
      }
      const ownKeys = Object.getOwnPropertyNames(current);
      if (
        ownKeys.some(
          (key) =>
            key !== 'length' && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= current.length),
        )
      ) {
        throw new StoreFailure('STORE-VALUE-INVALID', 'Stored arrays cannot have extra properties');
      }
      const children = [];
      for (let index = 0; index < current.length; index += 1) {
        if (!Object.hasOwn(current, index)) {
          throw new StoreFailure('STORE-VALUE-INVALID', 'Stored arrays cannot be sparse');
        }
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
          throw new StoreFailure(
            'STORE-VALUE-INVALID',
            'Stored array elements must be data values',
          );
        }
        children.push({key: index, child: visit(descriptor.value, depth + 1)});
      }
      active.delete(current);
      return {kind: 'array', children};
    }

    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new StoreFailure('STORE-VALUE-INVALID', 'Stored objects must be plain objects');
    }
    if (Object.getOwnPropertySymbols(current).length > 0) {
      throw new StoreFailure('STORE-VALUE-INVALID', 'Stored objects cannot have symbol keys');
    }
    const children = [];
    for (const key of Object.getOwnPropertyNames(current)) {
      if (forbiddenKeys.has(key) || key.length > limits.maxStringLength) {
        throw new StoreFailure('STORE-VALUE-INVALID', 'Stored object keys are invalid');
      }
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
        throw new StoreFailure(
          'STORE-VALUE-INVALID',
          'Stored object properties must be enumerable data values',
        );
      }
      children.push({key, child: visit(descriptor.value, depth + 1)});
    }
    active.delete(current);
    return {kind: 'object', children};
  }

  const descriptor = visit(value, 0);
  return {descriptor, nodeCount};
}

/** @param {any} working @param {any} descriptor @param {number} entrySlot */
function createNodeTree(working, descriptor, entrySlot) {
  const {slot, generation} = allocateSlot(working);
  const node = /** @type {any} */ ({
    slot,
    generation,
    entrySlot,
    kind: descriptor.kind,
    incomingCount: 0,
    ...(descriptor.kind === 'scalar' ? {scalar: descriptor.scalar} : {members: new Map()}),
  });
  working.nodes.set(slot, node);
  if (descriptor.kind !== 'scalar') {
    for (const {key, child} of descriptor.children) {
      const childNode = createNodeTree(working, child, entrySlot);
      node.members.set(key, {kind: 'node', targetNodeSlot: childNode.slot});
    }
  }
  return node;
}

/** @param {unknown} token */
function parseHandle(token) {
  if (typeof token !== 'string' || token.length > 200) return null;
  return handlePattern.exec(token);
}

/**
 * @param {any} working
 * @param {any} context
 * @param {unknown} token
 * @param {ReadonlySet<string>} expectedKinds
 */
function resolveHandle(working, context, token, expectedKinds) {
  const match = parseHandle(token);
  if (!match) {
    throw new StoreFailure('STORE-REFERENCE-INVALID', 'The handle format is invalid');
  }
  if (match[1] !== context.realmNonce) {
    throw new StoreFailure('STORE-REALM-MISMATCH', 'The handle belongs to another realm');
  }
  const handle = working.handles.get(token);
  if (!handle) {
    throw new StoreFailure('STORE-REFERENCE-INVALID', 'The handle is not registered');
  }
  if (!expectedKinds.has(handle.kind)) {
    throw new StoreFailure(
      'STORE-HANDLE-KIND',
      'The handle kind is not valid for this operation',
      handle.kind,
    );
  }
  if (handle.state === 'released') {
    throw new StoreFailure(
      handle.kind === 'scope' ? 'STORE-SCOPE-RELEASED' : 'STORE-REFERENCE-RELEASED',
      'The handle was released',
      handle.kind,
    );
  }
  if (handle.state === 'freed') {
    throw new StoreFailure('STORE-REFERENCE-STALE', 'The owner handle is stale', handle.kind);
  }
  if (!handleKinds.has(handle.kind) || handle.state !== 'active') {
    throw new StoreInvariantFailure('Handle state is invalid');
  }
  if (working.generations.get(handle.slot) !== handle.generation) {
    throw new StoreFailure('STORE-REFERENCE-STALE', 'The handle generation is stale', handle.kind);
  }
  return handle;
}

/** @param {any} working @param {any} context @param {unknown} scopeRef */
function resolveScope(working, context, scopeRef) {
  const handle = resolveHandle(working, context, scopeRef, new Set(['scope']));
  const scope = working.scopes.get(handle.slot);
  if (!scope || scope.generation !== handle.generation) {
    throw new StoreInvariantFailure('Active scope handle has no scope');
  }
  return scope;
}

/** @param {object} storeKey @param {number} nodeSlot @param {number} generation */
function createRefValue(storeKey, nodeSlot, generation) {
  const value = Object.freeze({kind: 'RefValue'});
  refValueMetadata.set(value, {storeKey, nodeSlot, generation});
  return value;
}

/**
 * @param {any} working
 * @param {any} context
 * @param {unknown} source
 */
function resolveSourceNode(working, context, source) {
  if (isDsl4RefValue(source)) {
    throw new StoreFailure(
      'STORE-HANDLE-KIND',
      'A RefValue is an attached value and cannot be used as a handle',
      'refValue',
    );
  }
  const handle = resolveHandle(working, context, source, new Set(['owner', 'lease']));
  if (handle.kind === 'owner') {
    const entry = working.entries.get(handle.slot);
    const node = entry && working.nodes.get(entry.rootNodeSlot);
    if (!entry || !node) throw new StoreInvariantFailure('Active owner has no root node');
    return {node, ownerScopeSlot: entry.ownerScopeSlot};
  }
  const lease = working.leases.get(handle.slot);
  const node = lease && working.nodes.get(lease.targetNodeSlot);
  if (!lease || !node) throw new StoreInvariantFailure('Active lease has no target node');
  return {node, ownerScopeSlot: lease.ownerScopeSlot};
}

/** @param {unknown} path @param {any} limits */
function normalizePath(path, limits) {
  if (path === undefined || path === null || path === '$') return [];
  if (Array.isArray(path)) {
    if (path.length > limits.maxDepth) {
      throw new StoreFailure('STORE-LIMIT-EXCEEDED', 'The reference path limit was exceeded');
    }
    return path.map((segment) => {
      if (typeof segment === 'number' && Number.isSafeInteger(segment) && segment >= 0)
        return segment;
      if (
        typeof segment === 'string' &&
        segment.length <= limits.maxStringLength &&
        !forbiddenKeys.has(segment)
      ) {
        return segment;
      }
      throw new StoreFailure('STORE-VALUE-INVALID', 'The reference path is invalid');
    });
  }
  if (typeof path !== 'string' || !path.startsWith('$')) {
    throw new StoreFailure('STORE-VALUE-INVALID', 'The reference path is invalid');
  }
  const segments = [];
  let index = 1;
  while (index < path.length) {
    if (segments.length >= limits.maxDepth) {
      throw new StoreFailure('STORE-LIMIT-EXCEEDED', 'The reference path limit was exceeded');
    }
    if (path[index] === '.') {
      const start = ++index;
      while (index < path.length && path[index] !== '.' && path[index] !== '[') index += 1;
      const key = path.slice(start, index);
      if (!key || key.length > limits.maxStringLength || forbiddenKeys.has(key)) {
        throw new StoreFailure('STORE-VALUE-INVALID', 'The reference path is invalid');
      }
      segments.push(key);
      continue;
    }
    if (path[index] === '[') {
      const end = path.indexOf(']', index + 1);
      const sourceIndex = end === -1 ? '' : path.slice(index + 1, end);
      if (!/^(0|[1-9][0-9]*)$/.test(sourceIndex)) {
        throw new StoreFailure('STORE-VALUE-INVALID', 'The reference path is invalid');
      }
      const arrayIndex = Number(sourceIndex);
      if (!Number.isSafeInteger(arrayIndex)) {
        throw new StoreFailure('STORE-LIMIT-EXCEEDED', 'The reference path limit was exceeded');
      }
      segments.push(arrayIndex);
      index = end + 1;
      continue;
    }
    throw new StoreFailure('STORE-VALUE-INVALID', 'The reference path is invalid');
  }
  return segments;
}

/** @param {any} working @param {any} startNode @param {readonly (string | number)[]} segments */
function followPath(working, startNode, segments) {
  let node = startNode;
  for (const segment of segments) {
    if (node.kind === 'scalar') {
      throw new StoreFailure('STORE-REFERENCE-INVALID', 'The reference path does not exist');
    }
    const key = node.kind === 'array' ? segment : String(segment);
    if (
      (node.kind === 'array' && (typeof key !== 'number' || !Number.isSafeInteger(key))) ||
      (node.kind === 'object' && typeof key !== 'string')
    ) {
      throw new StoreFailure('STORE-REFERENCE-INVALID', 'The reference path does not exist');
    }
    const member = node.members.get(key);
    node = member && working.nodes.get(member.targetNodeSlot);
    if (!member || !node) {
      throw new StoreFailure('STORE-REFERENCE-INVALID', 'The reference path does not exist');
    }
  }
  return node;
}

/** @param {any} node @param {string | number} key */
function normalizeMemberKey(node, key) {
  if (node.kind === 'object') {
    if (typeof key !== 'string' || forbiddenKeys.has(key)) {
      throw new StoreFailure('STORE-VALUE-INVALID', 'The reference member key is invalid');
    }
    return key;
  }
  if (node.kind === 'array') {
    if (!Number.isSafeInteger(key) || Number(key) < 0) {
      throw new StoreFailure('STORE-VALUE-INVALID', 'The reference member index is invalid');
    }
    return Number(key);
  }
  throw new StoreFailure('STORE-VALUE-INVALID', 'Reference members require a container node');
}

/** @param {any} working @param {number} sourceEntrySlot @param {number} targetEntrySlot */
function wouldCreateStrongCycle(working, sourceEntrySlot, targetEntrySlot) {
  if (sourceEntrySlot === targetEntrySlot) return false;
  const adjacency = new Map();
  for (const node of working.nodes.values()) {
    for (const member of node.kind === 'scalar' ? [] : node.members.values()) {
      if (member.kind !== 'ref') continue;
      const target = working.nodes.get(member.targetNodeSlot);
      if (!target || target.entrySlot === node.entrySlot) continue;
      if (!adjacency.has(node.entrySlot)) adjacency.set(node.entrySlot, new Set());
      adjacency.get(node.entrySlot).add(target.entrySlot);
    }
  }
  if (!adjacency.has(sourceEntrySlot)) adjacency.set(sourceEntrySlot, new Set());
  adjacency.get(sourceEntrySlot).add(targetEntrySlot);
  const pending = [targetEntrySlot];
  const visited = new Set();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === sourceEntrySlot) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const next of adjacency.get(current) ?? []) pending.push(next);
  }
  return false;
}

/** @param {any} node @param {number} delta */
function adjustIncomingCount(node, delta) {
  const next = node.incomingCount + delta;
  if (!Number.isSafeInteger(next) || next < 0) {
    throw new StoreInvariantFailure('Reference count underflow');
  }
  node.incomingCount = next;
}

/** @param {any} working @param {'scope' | 'owner' | 'lease'} kind @param {number} slot @param {number} generation @param {'released' | 'freed'} state */
function markHandleTerminal(working, kind, slot, generation, state) {
  const matches = [...working.handles.values()].filter(
    (handle) =>
      handle.kind === kind &&
      handle.slot === slot &&
      handle.generation === generation &&
      handle.state === 'active',
  );
  if (matches.length !== 1) throw new StoreInvariantFailure('Active record has no unique handle');
  matches[0].state = state;
}

/**
 * @param {any} working
 * @param {Set<number>} scopeSlots
 * @param {Set<number>} entrySlots
 * @param {Set<number>} leaseSlots
 */
function releaseClosure(working, scopeSlots, entrySlots, leaseSlots) {
  const nodeSlots = new Set(
    [...working.nodes.values()]
      .filter((node) => entrySlots.has(node.entrySlot))
      .map((node) => node.slot),
  );

  for (const lease of working.leases.values()) {
    if (nodeSlots.has(lease.targetNodeSlot) && !leaseSlots.has(lease.slot)) {
      throw new StoreFailure('STORE-OBJECT-IN-USE', 'The release closure has an incoming lease');
    }
  }
  for (const sourceNode of working.nodes.values()) {
    if (entrySlots.has(sourceNode.entrySlot) || sourceNode.kind === 'scalar') continue;
    for (const member of sourceNode.members.values()) {
      if (member.kind === 'ref' && nodeSlots.has(member.targetNodeSlot)) {
        throw new StoreFailure(
          'STORE-OBJECT-IN-USE',
          'The release closure has an incoming reference',
        );
      }
    }
  }

  for (const leaseSlot of leaseSlots) {
    const lease = working.leases.get(leaseSlot);
    if (!lease) throw new StoreInvariantFailure('Release closure lease is missing');
    if (!nodeSlots.has(lease.targetNodeSlot)) {
      const target = working.nodes.get(lease.targetNodeSlot);
      if (!target) throw new StoreInvariantFailure('Lease target is missing');
      adjustIncomingCount(target, -1);
    }
    markHandleTerminal(working, 'lease', lease.slot, lease.generation, 'released');
    working.leases.delete(lease.slot);
    releaseSlot(working, lease.slot);
  }

  for (const sourceNode of working.nodes.values()) {
    if (!entrySlots.has(sourceNode.entrySlot) || sourceNode.kind === 'scalar') continue;
    for (const member of sourceNode.members.values()) {
      if (member.kind !== 'ref' || nodeSlots.has(member.targetNodeSlot)) continue;
      const target = working.nodes.get(member.targetNodeSlot);
      if (!target) throw new StoreInvariantFailure('Reference target is missing');
      adjustIncomingCount(target, -1);
    }
  }

  for (const entrySlot of entrySlots) {
    const entry = working.entries.get(entrySlot);
    if (!entry) throw new StoreInvariantFailure('Release closure entry is missing');
    markHandleTerminal(working, 'owner', entry.slot, entry.generation, 'freed');
    working.entries.delete(entry.slot);
    releaseSlot(working, entry.slot);
  }
  for (const nodeSlot of nodeSlots) {
    working.nodes.delete(nodeSlot);
    releaseSlot(working, nodeSlot);
  }
  for (const scopeSlot of [...scopeSlots].sort((left, right) => right - left)) {
    const scope = working.scopes.get(scopeSlot);
    if (!scope) throw new StoreInvariantFailure('Release closure scope is missing');
    markHandleTerminal(working, 'scope', scope.slot, scope.generation, 'released');
    working.scopes.delete(scope.slot);
    releaseSlot(working, scope.slot);
  }
}

/** @param {any} working @param {any} limits */
function verifyWorking(working, limits) {
  if (
    working.scopes.size > limits.maxScopes ||
    working.entries.size > limits.maxEntries ||
    working.nodes.size > limits.maxNodes ||
    working.handles.size > limits.maxHandles
  ) {
    throw new StoreFailure('STORE-LIMIT-EXCEEDED', 'The committed state limit was exceeded');
  }
  let steps = 0;
  const step = () => {
    steps += 1;
    if (steps > limits.maxOperationSteps) {
      throw new StoreFailure('STORE-LIMIT-EXCEEDED', 'The operation scan limit was exceeded');
    }
  };

  for (const scope of working.scopes.values()) {
    step();
    if (working.generations.get(scope.slot) !== scope.generation) {
      throw new StoreInvariantFailure('Scope generation mismatch');
    }
    if (scope.parentScopeSlot !== null && !working.scopes.has(scope.parentScopeSlot)) {
      throw new StoreInvariantFailure('Scope parent is missing');
    }
    const visited = new Set([scope.slot]);
    let parentSlot = scope.parentScopeSlot;
    while (parentSlot !== null) {
      step();
      if (visited.has(parentSlot)) throw new StoreInvariantFailure('Scope cycle');
      visited.add(parentSlot);
      parentSlot = working.scopes.get(parentSlot)?.parentScopeSlot ?? null;
    }
  }

  const computedCounts = new Map([...working.nodes.keys()].map((slot) => [slot, 0]));
  for (const lease of working.leases.values()) {
    step();
    if (
      working.generations.get(lease.slot) !== lease.generation ||
      !working.scopes.has(lease.ownerScopeSlot) ||
      !working.nodes.has(lease.targetNodeSlot)
    ) {
      throw new StoreInvariantFailure('Lease ownership is invalid');
    }
    computedCounts.set(lease.targetNodeSlot, (computedCounts.get(lease.targetNodeSlot) ?? 0) + 1);
  }

  const entryNodes = new Map();
  for (const node of working.nodes.values()) {
    step();
    if (
      working.generations.get(node.slot) !== node.generation ||
      !working.entries.has(node.entrySlot)
    ) {
      throw new StoreInvariantFailure('Node ownership is invalid');
    }
    if (!entryNodes.has(node.entrySlot)) entryNodes.set(node.entrySlot, new Set());
    entryNodes.get(node.entrySlot).add(node.slot);
    if (node.kind === 'scalar') continue;
    for (const member of node.members.values()) {
      step();
      const target = working.nodes.get(member.targetNodeSlot);
      if (!target) throw new StoreInvariantFailure('Node member target is missing');
      if (member.kind === 'node' && target.entrySlot !== node.entrySlot) {
        throw new StoreInvariantFailure('Structural edge crosses an entry');
      }
      if (member.kind === 'ref') {
        computedCounts.set(target.slot, (computedCounts.get(target.slot) ?? 0) + 1);
      }
    }
  }

  for (const entry of working.entries.values()) {
    step();
    if (
      working.generations.get(entry.slot) !== entry.generation ||
      !working.scopes.has(entry.ownerScopeSlot) ||
      !working.nodes.has(entry.rootNodeSlot)
    ) {
      throw new StoreInvariantFailure('Entry ownership is invalid');
    }
    const reachable = new Set();
    const pending = [entry.rootNodeSlot];
    while (pending.length > 0) {
      step();
      const nodeSlot = pending.pop();
      if (reachable.has(nodeSlot)) throw new StoreInvariantFailure('Structural graph is shared');
      reachable.add(nodeSlot);
      const node = working.nodes.get(nodeSlot);
      if (!node || node.entrySlot !== entry.slot)
        throw new StoreInvariantFailure('Entry node is invalid');
      if (node.kind !== 'scalar') {
        for (const member of node.members.values()) {
          if (member.kind === 'node') pending.push(member.targetNodeSlot);
        }
      }
    }
    if (reachable.size !== entryNodes.get(entry.slot)?.size) {
      throw new StoreInvariantFailure('Entry has an orphan structural node');
    }
  }

  for (const node of working.nodes.values()) {
    step();
    if (
      !Number.isSafeInteger(node.incomingCount) ||
      node.incomingCount < 0 ||
      node.incomingCount !== computedCounts.get(node.slot)
    ) {
      throw new StoreInvariantFailure('Reference count mismatch');
    }
  }

  const activeHandleKeys = new Map();
  for (const handle of working.handles.values()) {
    step();
    if (!handleKinds.has(handle.kind)) throw new StoreInvariantFailure('Unknown handle kind');
    if (handle.state !== 'active') {
      if (!terminalHandleStates.has(handle.state))
        throw new StoreInvariantFailure('Unknown handle state');
      continue;
    }
    if (working.generations.get(handle.slot) !== handle.generation) {
      throw new StoreInvariantFailure('Active handle generation mismatch');
    }
    const key = `${handle.kind}:${handle.slot}:${handle.generation}`;
    activeHandleKeys.set(key, (activeHandleKeys.get(key) ?? 0) + 1);
  }
  for (const [kind, records] of [
    ['scope', working.scopes],
    ['owner', working.entries],
    ['lease', working.leases],
  ]) {
    for (const record of records.values()) {
      step();
      if (activeHandleKeys.get(`${kind}:${record.slot}:${record.generation}`) !== 1) {
        throw new StoreInvariantFailure('Active record has no unique handle');
      }
    }
  }

  const adjacency = new Map();
  for (const node of working.nodes.values()) {
    if (node.kind === 'scalar') continue;
    for (const member of node.members.values()) {
      if (member.kind !== 'ref') continue;
      const target = working.nodes.get(member.targetNodeSlot);
      if (!target || target.entrySlot === node.entrySlot) continue;
      if (!adjacency.has(node.entrySlot)) adjacency.set(node.entrySlot, new Set());
      adjacency.get(node.entrySlot).add(target.entrySlot);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  /** @param {number} entrySlot */
  function visitEntry(entrySlot) {
    step();
    if (visiting.has(entrySlot)) throw new StoreInvariantFailure('Cross-entry strong cycle');
    if (visited.has(entrySlot)) return;
    visiting.add(entrySlot);
    for (const target of adjacency.get(entrySlot) ?? []) visitEntry(target);
    visiting.delete(entrySlot);
    visited.add(entrySlot);
  }
  for (const entrySlot of working.entries.keys()) visitEntry(entrySlot);
}

/** @param {any} node @returns {any[]} */
function snapshotMembers(node) {
  return /** @type {any[]} */ (node.members ?? []);
}

/** @param {any} root @param {'active' | 'faulted' | 'disposed'} realmState @param {number} revision */
function createDebugSnapshot(root, realmState, revision) {
  const scopes = [...root.scopes].sort(bySlot);
  const entries = [...root.entries].sort(bySlot);
  const nodes = [...root.nodes].sort(bySlot);
  const leases = [...root.leases].sort(bySlot);
  const handles = [...root.handles].sort(bySlot);
  const scopeIds = new Map(scopes.map((scope, index) => [scope.slot, `scope-${index + 1}`]));
  const entryIds = new Map(entries.map((entry, index) => [entry.slot, `entry-${index + 1}`]));
  const nodeIds = new Map(nodes.map((node, index) => [node.slot, `node-${index + 1}`]));
  const leaseIds = new Map(leases.map((lease, index) => [lease.slot, `lease-${index + 1}`]));
  const computedCounts = new Map(nodes.map((node) => [node.slot, 0]));
  for (const lease of leases) {
    computedCounts.set(lease.targetNodeSlot, (computedCounts.get(lease.targetNodeSlot) ?? 0) + 1);
  }
  for (const node of nodes) {
    for (const member of snapshotMembers(node)) {
      if (member.kind === 'ref') {
        computedCounts.set(
          member.targetNodeSlot,
          (computedCounts.get(member.targetNodeSlot) ?? 0) + 1,
        );
      }
    }
  }
  return deepFreeze({
    kind: 'Dsl4ObjectStoreDebugSnapshot',
    realmState,
    revision,
    counts: {
      scopes: scopes.length,
      entries: entries.length,
      nodes: nodes.length,
      leases: leases.length,
      handles: handles.length,
      tombstones: handles.filter((handle) => handle.state !== 'active').length,
      referenceEdges: nodes.reduce(
        (count, node) =>
          count + snapshotMembers(node).filter((member) => member.kind === 'ref').length,
        0,
      ),
    },
    scopes: scopes.map((scope) => ({
      id: scopeIds.get(scope.slot),
      parentId: scope.parentScopeSlot === null ? null : scopeIds.get(scope.parentScopeSlot),
    })),
    entries: entries.map((entry) => ({
      id: entryIds.get(entry.slot),
      scopeId: scopeIds.get(entry.ownerScopeSlot),
      nodeCount: nodes.filter((node) => node.entrySlot === entry.slot).length,
    })),
    nodes: nodes.map((node) => ({
      id: nodeIds.get(node.slot),
      entryId: entryIds.get(node.entrySlot),
      kind: node.kind,
      incomingCount: node.incomingCount,
      computedIncomingCount: computedCounts.get(node.slot),
      structuralChildren: snapshotMembers(node).filter((member) => member.kind === 'node').length,
      referenceEdges: snapshotMembers(node).filter((member) => member.kind === 'ref').length,
    })),
    leases: leases.map((lease) => ({
      id: leaseIds.get(lease.slot),
      scopeId: scopeIds.get(lease.ownerScopeSlot),
      targetNodeId: nodeIds.get(lease.targetNodeSlot),
    })),
    handles: handles.map((handle, index) => ({
      id: `handle-${index + 1}`,
      kind: handle.kind,
      state: handle.state,
    })),
  });
}

/**
 * Create one isolated Generic Object Store realm.
 *
 * @param {object} [options]
 * @param {ReturnType<typeof createDsl4MapBackend>} [options.backend]
 * @param {(byteLength: number) => Uint8Array} [options.nonceSource]
 * @param {Partial<typeof defaultLimits>} [options.limits]
 */
export function createDsl4ObjectStore({
  backend = createDsl4MapBackend(),
  nonceSource = defaultNonceSource,
  limits: inputLimits,
} = {}) {
  if (!isDsl4MapBackend(backend)) throw new TypeError('backend must be an unused DSL 4 MapBackend');
  if (typeof nonceSource !== 'function') throw new TypeError('nonceSource must be a function');
  const limits = normalizeLimits(inputLimits);
  const realmNonce = createNonce(nonceSource, true);
  const rootHandleNonce = createNonce(nonceSource, true);
  const rootScopeRef = `@os1.${realmNonce}.${rootHandleNonce}`;
  const storeKey = Object.freeze({});
  const rootScopeSlot = 1;
  const initialRoot = freezeRoot({
    nextSlot: 2,
    freeSlots: [],
    generations: new Map([[rootScopeSlot, 1]]),
    handles: new Map([
      [
        rootScopeRef,
        {
          token: rootScopeRef,
          kind: 'scope',
          slot: rootScopeSlot,
          generation: 1,
          state: 'active',
          ownerScopeSlot: null,
        },
      ],
    ]),
    scopes: new Map([[rootScopeSlot, {slot: rootScopeSlot, generation: 1, parentScopeSlot: null}]]),
    entries: new Map(),
    leases: new Map(),
    nodes: new Map(),
  });
  initializeDsl4MapBackend(backend, initialRoot);

  const context = /** @type {any} */ ({
    backend,
    limits,
    nonceSource,
    realmNonce,
    rootScopeSlot,
    storeKey,
    realmState: /** @type {'active' | 'faulted' | 'disposed'} */ ('active'),
    disposedResult: null,
  });

  /** @param {string} operation */
  function inactiveFailure(operation) {
    if (context.realmState === 'disposed') {
      return failure('STORE-REALM-DISPOSED', operation, 'The Object Store realm was disposed');
    }
    if (context.realmState === 'faulted') {
      return failure('STORE-REFERENCE-UNDERFLOW', operation, 'The Object Store realm is faulted');
    }
    return null;
  }

  /**
   * @template T
   * @param {string} operation
   * @param {(working: any) => {changed: boolean, value: T}} mutate
   */
  function execute(operation, mutate) {
    const inactive = inactiveFailure(operation);
    if (inactive) return inactive;
    try {
      const {root, revision} = readDsl4MapBackend(backend);
      const working = cloneRoot(root);
      const outcome = mutate(working);
      if (!outcome.changed) return success(outcome.value);
      verifyWorking(working, limits);
      const candidateRoot = freezeRoot(working);
      const committed = commitDsl4MapBackend(backend, {
        baseRevision: revision,
        operation,
        root: candidateRoot,
      });
      if (!committed.ok) {
        return failure(
          committed.reason === 'conflict' ? 'STORE-CONFLICT' : 'STORE-BACKEND-FAILURE',
          operation,
          committed.reason === 'conflict'
            ? 'The backend revision changed before commit'
            : 'The backend commit failed',
        );
      }
      return success(outcome.value);
    } catch (error) {
      if (error instanceof StoreFailure) {
        return failure(error.code, operation, error.message, error.handleKind);
      }
      if (error instanceof StoreInvariantFailure) {
        context.realmState = 'faulted';
        return failure('STORE-REFERENCE-UNDERFLOW', operation, 'An Object Store invariant failed');
      }
      return failure('STORE-BACKEND-FAILURE', operation, 'The Object Store operation failed');
    }
  }

  /**
   * @template T
   * @param {string} operation
   * @param {(working: any) => T} read
   */
  function executeRead(operation, read) {
    const inactive = inactiveFailure(operation);
    if (inactive) return inactive;
    try {
      const {root} = readDsl4MapBackend(backend);
      return success(read(cloneRoot(root)));
    } catch (error) {
      if (error instanceof StoreFailure) {
        return failure(error.code, operation, error.message, error.handleKind);
      }
      if (error instanceof StoreInvariantFailure) {
        context.realmState = 'faulted';
        return failure('STORE-REFERENCE-UNDERFLOW', operation, 'An Object Store invariant failed');
      }
      return failure('STORE-BACKEND-FAILURE', operation, 'The Object Store operation failed');
    }
  }

  /** @param {unknown} parentScopeRef @param {unknown} label */
  function createScope(parentScopeRef = rootScopeRef, label = '') {
    return execute('createScope', (working) => {
      const parent = resolveScope(working, context, parentScopeRef);
      if (typeof label !== 'string') {
        throw new StoreFailure('STORE-VALUE-INVALID', 'Scope labels must be strings');
      }
      if (label.length > limits.maxStringLength) {
        throw new StoreFailure('STORE-LIMIT-EXCEEDED', 'The scope label limit was exceeded');
      }
      if (working.scopes.size >= limits.maxScopes) {
        throw new StoreFailure('STORE-LIMIT-EXCEEDED', 'The scope limit was exceeded');
      }
      const {slot, generation} = allocateSlot(working);
      const token = issueHandle(working, context, 'scope', slot, generation, parent.slot);
      working.scopes.set(slot, {slot, generation, parentScopeSlot: parent.slot, label});
      return {changed: true, value: token};
    });
  }

  /** @param {unknown} value @param {unknown} typeTag @param {unknown} ownerScopeRef */
  function newEntry(value, typeTag = 'generic', ownerScopeRef = rootScopeRef) {
    return execute('newEntry', (working) => {
      const ownerScope = resolveScope(working, context, ownerScopeRef);
      if (
        typeof typeTag !== 'string' ||
        typeTag.length === 0 ||
        typeTag.length > limits.maxStringLength
      ) {
        throw new StoreFailure('STORE-VALUE-INVALID', 'The entry type tag is invalid');
      }
      if (working.entries.size >= limits.maxEntries) {
        throw new StoreFailure('STORE-LIMIT-EXCEEDED', 'The entry limit was exceeded');
      }
      const normalized = normalizeStoredValue(value, limits);
      if (working.nodes.size + normalized.nodeCount > limits.maxNodes) {
        throw new StoreFailure('STORE-LIMIT-EXCEEDED', 'The node limit was exceeded');
      }
      const {slot, generation} = allocateSlot(working);
      const rootNode = createNodeTree(working, normalized.descriptor, slot);
      const token = issueHandle(working, context, 'owner', slot, generation, ownerScope.slot);
      working.entries.set(slot, {
        slot,
        generation,
        ownerScopeSlot: ownerScope.slot,
        rootNodeSlot: rootNode.slot,
        typeTag,
      });
      return {changed: true, value: token};
    });
  }

  /** @param {unknown} source @param {unknown} path @param {unknown} ownerScopeRef */
  function createReference(source, path = '$', ownerScopeRef) {
    return execute('createReference', (working) => {
      const resolved = resolveSourceNode(working, context, source);
      const target = followPath(working, resolved.node, normalizePath(path, limits));
      const ownerScope = resolveScope(
        working,
        context,
        ownerScopeRef === undefined
          ? [...working.handles.values()].find(
              (handle) =>
                handle.kind === 'scope' &&
                handle.slot === resolved.ownerScopeSlot &&
                handle.state === 'active',
            )?.token
          : ownerScopeRef,
      );
      const {slot, generation} = allocateSlot(working);
      const token = issueHandle(working, context, 'lease', slot, generation, ownerScope.slot);
      working.leases.set(slot, {
        slot,
        generation,
        ownerScopeSlot: ownerScope.slot,
        targetNodeSlot: target.slot,
      });
      adjustIncomingCount(target, 1);
      return {changed: true, value: token};
    });
  }

  /** @param {unknown} leaseRef @param {unknown} ownerScopeRef */
  function duplicateReference(leaseRef, ownerScopeRef) {
    return execute('duplicateReference', (working) => {
      const sourceHandle = resolveHandle(working, context, leaseRef, new Set(['lease']));
      const sourceLease = working.leases.get(sourceHandle.slot);
      if (!sourceLease) throw new StoreInvariantFailure('Active lease is missing');
      const scopeToken =
        ownerScopeRef === undefined
          ? [...working.handles.values()].find(
              (handle) =>
                handle.kind === 'scope' &&
                handle.slot === sourceLease.ownerScopeSlot &&
                handle.state === 'active',
            )?.token
          : ownerScopeRef;
      const ownerScope = resolveScope(working, context, scopeToken);
      const target = working.nodes.get(sourceLease.targetNodeSlot);
      if (!target) throw new StoreInvariantFailure('Lease target is missing');
      const {slot, generation} = allocateSlot(working);
      const token = issueHandle(working, context, 'lease', slot, generation, ownerScope.slot);
      working.leases.set(slot, {
        slot,
        generation,
        ownerScopeSlot: ownerScope.slot,
        targetNodeSlot: target.slot,
      });
      adjustIncomingCount(target, 1);
      return {changed: true, value: token};
    });
  }

  /** @param {unknown} leaseRef */
  function releaseReference(leaseRef) {
    return execute('releaseReference', (working) => {
      const handle = resolveHandle(working, context, leaseRef, new Set(['lease']));
      const lease = working.leases.get(handle.slot);
      const target = lease && working.nodes.get(lease.targetNodeSlot);
      if (!lease || !target) throw new StoreInvariantFailure('Active lease is invalid');
      adjustIncomingCount(target, -1);
      markHandleTerminal(working, 'lease', lease.slot, lease.generation, 'released');
      working.leases.delete(lease.slot);
      releaseSlot(working, lease.slot);
      return {changed: true, value: {released: true}};
    });
  }

  /** @param {unknown} source @param {unknown} key @param {unknown} target */
  function setReferenceValue(source, key, target) {
    return execute('setReferenceValue', (working) => {
      const sourceNode = resolveSourceNode(working, context, source).node;
      const memberKey = normalizeMemberKey(sourceNode, /** @type {string | number} */ (key));
      if (typeof memberKey === 'string' && memberKey.length > limits.maxStringLength) {
        throw new StoreFailure(
          'STORE-LIMIT-EXCEEDED',
          'The reference member key limit was exceeded',
        );
      }
      const oldMember = sourceNode.members.get(memberKey);
      if (oldMember?.kind === 'node') {
        throw new StoreFailure(
          'STORE-VALUE-INVALID',
          'A structural member cannot be replaced by a RefValue',
        );
      }
      const highestArrayIndex =
        sourceNode.kind === 'array'
          ? Math.max(-1, ...[...sourceNode.members.keys()].map(Number))
          : -1;
      if (target === null) {
        if (!oldMember) return {changed: false, value: {changed: false}};
        if (sourceNode.kind === 'array' && memberKey !== highestArrayIndex) {
          throw new StoreFailure(
            'STORE-VALUE-INVALID',
            'Removing the RefValue would make the stored array sparse',
          );
        }
        const oldTarget = working.nodes.get(oldMember.targetNodeSlot);
        if (!oldTarget) throw new StoreInvariantFailure('Reference target is missing');
        adjustIncomingCount(oldTarget, -1);
        sourceNode.members.delete(memberKey);
        return {changed: true, value: {changed: true}};
      }
      const targetNode = resolveSourceNode(working, context, target).node;
      if (sourceNode.kind === 'array' && !oldMember && memberKey !== highestArrayIndex + 1) {
        throw new StoreFailure(
          'STORE-VALUE-INVALID',
          'Adding the RefValue would make the stored array sparse',
        );
      }
      if (oldMember?.targetNodeSlot === targetNode.slot) {
        return {changed: false, value: {changed: false}};
      }
      if (oldMember) {
        const oldTarget = working.nodes.get(oldMember.targetNodeSlot);
        if (!oldTarget) throw new StoreInvariantFailure('Reference target is missing');
        adjustIncomingCount(oldTarget, -1);
        sourceNode.members.delete(memberKey);
      }
      if (wouldCreateStrongCycle(working, sourceNode.entrySlot, targetNode.entrySlot)) {
        throw new StoreFailure('STORE-STRONG-CYCLE', 'The reference would create a strong cycle');
      }
      sourceNode.members.set(memberKey, {kind: 'ref', targetNodeSlot: targetNode.slot});
      adjustIncomingCount(targetNode, 1);
      return {changed: true, value: {changed: true}};
    });
  }

  /** @param {unknown} source @param {unknown} key */
  function deleteReferenceValue(source, key) {
    return execute('deleteReferenceValue', (working) => {
      const sourceNode = resolveSourceNode(working, context, source).node;
      const memberKey = normalizeMemberKey(sourceNode, /** @type {string | number} */ (key));
      const oldMember = sourceNode.members.get(memberKey);
      if (!oldMember) return {changed: false, value: {changed: false}};
      if (oldMember.kind !== 'ref') {
        throw new StoreFailure('STORE-VALUE-INVALID', 'A structural member is not a RefValue');
      }
      if (
        sourceNode.kind === 'array' &&
        memberKey !== Math.max(-1, ...[...sourceNode.members.keys()].map(Number))
      ) {
        throw new StoreFailure(
          'STORE-VALUE-INVALID',
          'Removing the RefValue would make the stored array sparse',
        );
      }
      const oldTarget = working.nodes.get(oldMember.targetNodeSlot);
      if (!oldTarget) throw new StoreInvariantFailure('Reference target is missing');
      adjustIncomingCount(oldTarget, -1);
      sourceNode.members.delete(memberKey);
      return {changed: true, value: {changed: true}};
    });
  }

  /** @param {unknown} ownerRef */
  function free(ownerRef) {
    return execute('free', (working) => {
      const handle = resolveHandle(working, context, ownerRef, new Set(['owner']));
      if (!working.entries.has(handle.slot))
        throw new StoreInvariantFailure('Active owner is missing');
      releaseClosure(working, new Set(), new Set([handle.slot]), new Set());
      return {changed: true, value: {freed: true}};
    });
  }

  /** @param {unknown} scopeRef */
  function releaseScope(scopeRef) {
    return execute('releaseScope', (working) => {
      const scope = resolveScope(working, context, scopeRef);
      const scopeSlots = new Set([scope.slot]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const candidate of working.scopes.values()) {
          if (
            candidate.parentScopeSlot !== null &&
            scopeSlots.has(candidate.parentScopeSlot) &&
            !scopeSlots.has(candidate.slot)
          ) {
            scopeSlots.add(candidate.slot);
            changed = true;
          }
        }
      }
      const entrySlots = new Set(
        [...working.entries.values()]
          .filter((entry) => scopeSlots.has(entry.ownerScopeSlot))
          .map((entry) => entry.slot),
      );
      const leaseSlots = new Set(
        [...working.leases.values()]
          .filter((lease) => scopeSlots.has(lease.ownerScopeSlot))
          .map((lease) => lease.slot),
      );
      releaseClosure(working, scopeSlots, entrySlots, leaseSlots);
      return {changed: true, value: {released: true}};
    });
  }

  /** @param {unknown} source */
  function readValue(source) {
    return executeRead('readValue', (working) => {
      const selected = resolveSourceNode(working, context, source).node;
      const entry = working.entries.get(selected.entrySlot);
      if (!entry) throw new StoreInvariantFailure('Selected node has no entry');

      /** @param {any} node @returns {any} */
      function materialize(node) {
        if (node.kind === 'scalar') return node.scalar;
        if (node.kind === 'array') {
          const array = [];
          for (const [key, member] of [...node.members.entries()].sort(([left], [right]) =>
            compareMemberKeys(left, right),
          )) {
            const target = working.nodes.get(member.targetNodeSlot);
            if (!target) throw new StoreInvariantFailure('Materialized target is missing');
            array[Number(key)] =
              member.kind === 'ref'
                ? createRefValue(storeKey, target.slot, target.generation)
                : materialize(target);
          }
          return deepFreeze(array);
        }
        const object = {};
        for (const [key, member] of node.members.entries()) {
          const target = working.nodes.get(member.targetNodeSlot);
          if (!target) throw new StoreInvariantFailure('Materialized target is missing');
          Object.defineProperty(object, String(key), {
            value:
              member.kind === 'ref'
                ? createRefValue(storeKey, target.slot, target.generation)
                : materialize(target),
            enumerable: true,
            configurable: false,
            writable: false,
          });
        }
        return deepFreeze(object);
      }

      return deepFreeze({typeTag: entry.typeTag, value: materialize(selected)});
    });
  }

  function debugSnapshot() {
    const {root, revision} = readDsl4MapBackend(backend);
    return createDebugSnapshot(root, context.realmState, revision);
  }

  function disposeRealm() {
    if (context.realmState === 'disposed' && context.disposedResult) {
      return context.disposedResult;
    }
    try {
      const {revision} = readDsl4MapBackend(backend);
      const emptyRoot = freezeRoot({
        nextSlot: 1,
        freeSlots: [],
        generations: new Map(),
        handles: new Map(),
        scopes: new Map(),
        entries: new Map(),
        leases: new Map(),
        nodes: new Map(),
      });
      const committed = commitDsl4MapBackend(backend, {
        baseRevision: revision,
        operation: 'disposeRealm',
        root: emptyRoot,
      });
      if (!committed.ok) {
        return failure(
          committed.reason === 'conflict' ? 'STORE-CONFLICT' : 'STORE-BACKEND-FAILURE',
          'disposeRealm',
          committed.reason === 'conflict'
            ? 'The backend revision changed before commit'
            : 'The backend commit failed',
        );
      }
      context.realmState = 'disposed';
      context.disposedResult = success(debugSnapshot());
      return context.disposedResult;
    } catch {
      return failure('STORE-BACKEND-FAILURE', 'disposeRealm', 'The backend commit failed');
    }
  }

  return Object.freeze({
    rootScopeRef,
    createScope,
    newEntry,
    createReference,
    duplicateReference,
    releaseReference,
    setReferenceValue,
    deleteReferenceValue,
    free,
    releaseScope,
    readValue,
    debugSnapshot,
    backendStatus: () => backend.debugStatus(),
    disposeRealm,
  });
}
