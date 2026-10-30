import {
  parseSourceSyntax,
  applySourceSyntaxEdits,
  type SourceSyntaxNode,
  type SourceSyntaxPair,
} from '@kubohiroya/turbowarp-yaml-json/source-syntax';
type Obj = Record<string, unknown>;
type Path = readonly (string | number)[];
export interface SchemaSourceLocation {
  readonly path: Path;
  readonly blockId: string;
}
interface Anchor {
  path: Path;
  placement: 'before' | 'after';
}
export interface SchemaLineCommentDescriptor {
  readonly version: 1;
  readonly bindings: readonly (Anchor & {
    readonly commentIds: readonly string[];
  })[];
}
export interface ObservedSchemaLineComment {
  readonly anchorId: string;
  readonly placement: 'before' | 'after';
  readonly text: string;
}
const object = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
function fail(message: string): never {
  throw Object.assign(new Error(message), {
    code: 'VIEW_SCHEMA_COMMENT_UNSUPPORTED',
  });
}
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const pathKey = (path: Path) => JSON.stringify(path);
const anchorKey = (a: Anchor) => JSON.stringify([a.path, a.placement]);
const prefix = (a: Path, b: Path) => a.length <= b.length && a.every((v, i) => v === b[i]);
function bodyOrder(blocks: Obj, rootIds: readonly string[]) {
  const order = new Map<string, number>(),
    seen = new Set<string>();
  function chain(start: unknown) {
    let id = start;
    while (id !== null && id !== undefined) {
      if (typeof id !== 'string' || seen.has(id) || !object(blocks[id]))
        fail('The schema statement graph is cyclic or incomplete.');
      seen.add(id);
      order.set(id, order.size);
      const b = blocks[id] as Obj;
      for (const [name, input] of Object.entries(object(b.inputs) ? b.inputs : {}))
        if (/^SUBSTACK\d*$/u.test(name) && Array.isArray(input)) chain(input[1]);
      id = b.next;
      if (seen.size > 100000) fail('The schema statement graph exceeds its limit.');
    }
  }
  for (const id of rootIds) {
    const b = blocks[id];
    if (!object(b)) fail('The document body root is missing.');
    chain(b.next);
  }
  return order;
}
function canonicalLocations(
  locations: readonly SchemaSourceLocation[],
  order: Map<string, number>,
) {
  const byId = new Map<string, SchemaSourceLocation>();
  for (const item of locations) {
    if (!order.has(item.blockId)) continue;
    const old = byId.get(item.blockId);
    if (!old || item.path.length < old.path.length)
      byId.set(item.blockId, {path: [...item.path], blockId: item.blockId});
  }
  return [...byId.values()];
}
function normalizedPath(path: Path, value: unknown): Path {
  if (
    path[0] === 'scenes' &&
    typeof path[1] === 'string' &&
    path[2] === 'actions' &&
    object(value) &&
    object(value.scenes) &&
    Array.isArray(value.scenes[path[1]])
  )
    return [path[0], path[1], ...path.slice(3)];
  return path;
}
interface Projected {
  anchorId: string;
  anchor: Anchor;
  commentId: string;
  text: string;
}
function project(
  source: string,
  blocks: Obj,
  rootIds: readonly string[],
  locations: readonly SchemaSourceLocation[],
  semanticValue: unknown,
): Projected[] {
  const tree = parseSourceSyntax(source, {format: 'yaml'}).tree,
    order = bodyOrder(blocks, rootIds),
    known = canonicalLocations(locations, order),
    result: Projected[] = [];
  const choose = (
    node: SourceSyntaxNode | SourceSyntaxPair,
    path: Path,
    placement: 'before' | 'after',
  ): SchemaSourceLocation => {
    let search = normalizedPath(path, semanticValue);
    if (node.kind === 'map' && typeof search.at(-1) === 'number') {
      const action = known.find((item) => pathKey(item.path) === pathKey(search));
      if (action) return action;
    }
    if (node.kind === 'map') {
      const entry = placement === 'before' ? node.entries[0] : node.entries.at(-1);
      if (!entry)
        fail(`A comment in an empty mapping has no schema statement at ${pathKey(path)}.`);
      search = normalizedPath([...path, String(entry.key.value)], semanticValue);
    } else if (node.kind === 'sequence') {
      if (!node.items.length)
        fail(`A comment in an empty sequence has no schema statement at ${pathKey(path)}.`);
      search = normalizedPath(
        [...path, placement === 'before' ? 0 : node.items.length - 1],
        semanticValue,
      );
    }
    let candidates = known.filter((item) => prefix(search, item.path));
    if (!candidates.length && node.kind === 'pair' && search.length) {
      const parent = search.slice(0, -1);
      candidates =
        typeof parent.at(-1) === 'number'
          ? known.filter((item) => pathKey(item.path) === pathKey(parent))
          : [];
    }
    // The version field is represented by the separate root, so its leading comment starts this file body.
    if (!candidates.length && search.length === 1 && search[0] === 'kamishibai')
      return (
        [...known].sort((a, b) => order.get(a.blockId)! - order.get(b.blockId)!)[0] ??
        fail('A file header comment has no visible schema body.')
      );
    if (!candidates.length)
      fail(
        `A line comment has no corresponding visible schema statement at ${pathKey(path)}. Use raw source or common YAML blocks.`,
      );
    const depth = Math.min(...candidates.map((item) => item.path.length));
    candidates = candidates
      .filter((item) => item.path.length === depth)
      .sort((a, b) => order.get(a.blockId)! - order.get(b.blockId)!);
    return (placement === 'before' ? candidates[0] : candidates.at(-1))!;
  };
  const add = (
    node: SourceSyntaxNode | SourceSyntaxPair,
    path: Path,
    placement: 'before' | 'after',
  ) => {
    const comments = node.comments?.[placement];
    if (!comments?.length) return;
    const target = choose(node, path, placement);
    for (const comment of comments) {
      if (typeof comment.text !== 'string' || /[\r\n]/u.test(comment.text))
        fail('Each schema line comment must contain one physical line.');
      result.push({
        anchorId: target.blockId,
        anchor: {path: target.path, placement},
        commentId: comment.id,
        text: comment.text,
      });
    }
  };
  function visit(node: SourceSyntaxNode | SourceSyntaxPair, path: Path) {
    if (node.comments?.inline?.length)
      fail(`Inline comments at ${pathKey(path)} require raw source or common YAML blocks.`);
    add(node, path, 'before');
    if (node.kind === 'map')
      for (const pair of node.entries) visit(pair, [...path, String(pair.key.value)]);
    else if (node.kind === 'pair') visit(node.value, path);
    else if (node.kind === 'sequence') node.items.forEach((child, i) => visit(child, [...path, i]));
    add(node, path, 'after');
  }
  visit(tree, []);
  return result;
}
function grouped(projected: readonly Projected[]) {
  const groups = new Map<string, {anchor: Anchor; items: Projected[]}>();
  for (const item of projected) {
    const id = anchorKey(item.anchor);
    let group = groups.get(id);
    if (!group) {
      group = {anchor: item.anchor, items: []};
      groups.set(id, group);
    }
    group.items.push(item);
  }
  return groups;
}
/** Insert explicit source line comments only where a real schema statement represents their position. */
export function addSchemaLineCommentBlocks({
  source,
  blocks,
  rootIds,
  locations,
  semanticValue,
  opcode,
  idPrefix,
}: {
  source: string;
  blocks: Obj;
  rootIds: readonly string[];
  locations: readonly SchemaSourceLocation[];
  semanticValue: unknown;
  opcode: string;
  idPrefix: string;
}): SchemaLineCommentDescriptor {
  const projected = project(source, blocks, rootIds, locations, semanticValue),
    groups = grouped(projected);
  let serial = 0;
  for (const group of groups.values()) {
    const targetId = group.items[0]!.anchorId,
      target = blocks[targetId];
    if (!object(target)) fail('The schema comment anchor is missing.');
    const ids = group.items.map(() => {
      let id: string;
      do {
        id = `${idPrefix}${serial++}`;
      } while (Object.hasOwn(blocks, id));
      return id;
    });
    for (const [index, item] of group.items.entries())
      blocks[ids[index]!] = {
        opcode,
        next: ids[index + 1] ?? (item.anchor.placement === 'before' ? targetId : target.next),
        parent: index
          ? ids[index - 1]
          : item.anchor.placement === 'before'
            ? target.parent
            : targetId,
        inputs: {TEXT: [1, [10, item.text]]},
        fields: {PLACEMENT: [item.anchor.placement, null]},
        shadow: false,
        topLevel: false,
      };
    if (group.anchor.placement === 'before') {
      if (typeof target.parent !== 'string' || !object(blocks[target.parent]))
        fail('A line comment cannot precede an unconnected document hat.');
      const parent = blocks[target.parent] as Obj;
      if (parent.next === targetId) parent.next = ids[0];
      else {
        let replaced = false;
        for (const [name, input] of Object.entries(object(parent.inputs) ? parent.inputs : {}))
          if (/^SUBSTACK\d*$/u.test(name) && Array.isArray(input) && input[1] === targetId) {
            input[1] = ids[0];
            replaced = true;
          }
        if (!replaced) fail('A line comment cannot be placed inside a reporter or JSON field.');
      }
      target.parent = ids.at(-1);
    } else {
      const next = target.next;
      target.next = ids[0];
      if (typeof next === 'string' && object(blocks[next]))
        (blocks[next] as Obj).parent = ids.at(-1);
    }
  }
  return {
    version: 1,
    bindings: [...groups.values()].map((group) => ({
      ...clone(group.anchor),
      commentIds: group.items.map((item) => item.commentId),
    })),
  };
}
/** Strip only connected line-comment commands in a read clone; reporter positions are never interpreted. */
export function stripSchemaLineCommentBlocks(
  blocks: Obj,
  rootIds: readonly string[],
  opcode: string,
): ObservedSchemaLineComment[] {
  const result: ObservedSchemaLineComment[] = [],
    seen = new Set<string>();
  const text = (id: string, b: Obj): string => {
    if (
      !object(b.inputs) ||
      Object.keys(b.inputs).some((k) => k !== 'TEXT') ||
      !object(b.fields) ||
      Object.keys(b.fields).some((k) => k !== 'PLACEMENT')
    )
      fail('A schema line comment contains unknown fields.');
    const input = b.inputs.TEXT;
    if (!Array.isArray(input) || ![1, 2, 3].includes(input[0] as number))
      fail('A schema line comment requires static text.');
    let value: unknown = input[1];
    if (typeof value === 'string') {
      const shadow = blocks[value];
      if (
        !object(shadow) ||
        shadow.opcode !== 'text' ||
        shadow.shadow !== true ||
        shadow.parent !== id ||
        shadow.next !== null ||
        !object(shadow.fields) ||
        !object(shadow.inputs) ||
        Object.keys(shadow.inputs).length
      )
        fail('A comment TEXT reporter is unsupported.');
      value = (shadow.fields.TEXT as unknown[])?.[0];
      delete blocks[input[1] as string];
    } else if (Array.isArray(value) && value[0] === 10) value = value[1];
    if (typeof value !== 'string' || /[\r\n]/u.test(value))
      fail('Each schema line comment requires one static physical line.');
    return value;
  };
  function chain(start: unknown, parentId: string, branch: string) {
    const ids: string[] = [];
    let id = start;
    while (id !== null && id !== undefined) {
      if (typeof id !== 'string' || seen.has(id) || !object(blocks[id]))
        fail('The schema comment chain is cyclic or incomplete.');
      const block = blocks[id] as Obj;
      const expectedParent = ids.at(-1) ?? parentId;
      if (block.parent !== expectedParent)
        fail('A schema statement has an invalid original parent.');
      seen.add(id);
      ids.push(id);
      id = (blocks[id] as Obj).next;
    }
    const statements = ids.filter((id) => (blocks[id] as Obj).opcode !== opcode);
    let previous: string | null = null;
    for (const [index, current] of ids.entries()) {
      const b = blocks[current] as Obj;
      if (b.opcode === opcode) {
        const field = object(b.fields) ? b.fields.PLACEMENT : undefined,
          placement = Array.isArray(field) ? field[0] : undefined;
        if (placement !== 'before' && placement !== 'after')
          fail('A schema line comment needs a before/after placement.');
        const next = ids.slice(index + 1).find((id) => (blocks[id] as Obj).opcode !== opcode),
          anchor = placement === 'before' ? next : previous;
        if (!anchor) fail('A line comment without a corresponding statement is ambiguous.');
        result.push({anchorId: anchor, placement, text: text(current, b)});
      } else {
        previous = current;
        for (const [name, input] of Object.entries(object(b.inputs) ? b.inputs : {}))
          if (/^SUBSTACK\d*$/u.test(name) && Array.isArray(input)) chain(input[1], current, name);
      }
    }
    const parent = blocks[parentId] as Obj;
    if (branch === 'next') parent.next = statements[0] ?? null;
    else {
      const input = (parent.inputs as Obj)[branch] as unknown[];
      input[1] = statements[0] ?? null;
    }
    for (const [index, current] of statements.entries()) {
      const b = blocks[current] as Obj;
      b.parent = index ? statements[index - 1] : parentId;
      b.next = statements[index + 1] ?? null;
    }
    for (const current of ids)
      if ((blocks[current] as Obj).opcode === opcode) delete blocks[current];
  }
  for (const rootId of rootIds) {
    const root = blocks[rootId];
    if (!object(root)) fail('The source document root is missing.');
    chain(root.next, rootId, 'next');
  }
  return result;
}
/** Update the original CST comment identities, then verify the semantic patch still matches visible placement. */
export function reconcileSchemaLineComments({
  source,
  descriptor,
  observed,
  blocks,
  rootIds,
  locations,
  semanticValue,
  patch,
}: {
  source: string;
  descriptor?: SchemaLineCommentDescriptor | undefined;
  observed: readonly ObservedSchemaLineComment[];
  blocks: Obj;
  rootIds: readonly string[];
  locations: readonly SchemaSourceLocation[];
  semanticValue: unknown;
  patch: (commentUpdatedSource: string) => string;
}): string {
  const order = bodyOrder(blocks, rootIds),
    known = new Map(canonicalLocations(locations, order).map((item) => [item.blockId, item.path])),
    groups = new Map<string, {anchor: Anchor; texts: string[]}>();
  for (const item of observed) {
    const path = known.get(item.anchorId);
    if (!path) fail('A comment anchor no longer represents the same schema statement.');
    const anchor = {path, placement: item.placement},
      id = anchorKey(anchor);
    let group = groups.get(id);
    if (!group) {
      group = {anchor, texts: []};
      groups.set(id, group);
    }
    group.texts.push(item.text);
  }
  if (
    descriptor &&
    (!object(descriptor) ||
      descriptor.version !== 1 ||
      !Array.isArray(descriptor.bindings) ||
      descriptor.bindings.length > 100000 ||
      descriptor.bindings.some(
        (binding) =>
          !object(binding) ||
          !Array.isArray(binding.path) ||
          binding.path.some(
            (value) =>
              typeof value !== 'string' && (!Number.isSafeInteger(value) || Number(value) < 0),
          ) ||
          !['before', 'after'].includes(String(binding.placement)) ||
          !Array.isArray(binding.commentIds) ||
          binding.commentIds.some((id) => typeof id !== 'string'),
      ))
  )
    fail('The schema line-comment descriptor is malformed.');
  const bindings = descriptor?.bindings ?? [];
  if (descriptor && descriptor.version !== 1)
    fail('The schema line-comment descriptor is unsupported.');
  if (groups.size !== bindings.length)
    fail(
      'Adding, removing or moving schema line comments is ambiguous. Edit the raw source or common YAML blocks first.',
    );
  const updates = new Map<string, string>();
  for (const binding of bindings) {
    const group = groups.get(anchorKey(binding));
    if (!group || group.texts.length !== binding.commentIds.length)
      fail(
        'The schema line-comment position or count changed. Edit raw source or common YAML blocks first.',
      );
    binding.commentIds.forEach((id, index) => {
      if (updates.has(id)) fail('A schema comment identity is duplicated.');
      updates.set(id, group.texts[index]!);
    });
  }
  const parsed = parseSourceSyntax(source, {format: 'yaml'}),
    tree = clone(parsed.tree),
    found = new Set<string>();
  function update(node: SourceSyntaxNode | SourceSyntaxPair) {
    for (const placement of ['before', 'after'] as const)
      for (const comment of node.comments?.[placement] ?? [])
        if (updates.has(comment.id)) {
          comment.text = updates.get(comment.id)!;
          found.add(comment.id);
        }
    if (node.kind === 'map') node.entries.forEach(update);
    else if (node.kind === 'pair') update(node.value);
    else if (node.kind === 'sequence') node.items.forEach(update);
  }
  update(tree);
  if (found.size !== updates.size) fail('The source comment identities no longer match this view.');
  const commented = updates.size
      ? applySourceSyntaxEdits(parsed.baseline, [{op: 'replace-tree', tree}]).source
      : source,
    result = patch(commented),
    actual = grouped(project(result, blocks, rootIds, locations, semanticValue));
  if (actual.size !== groups.size)
    fail('The semantic edit would move or lose a visible line comment.');
  for (const [id, group] of groups) {
    const value = actual.get(id);
    if (
      !value ||
      JSON.stringify(value.items.map((item) => item.text)) !== JSON.stringify(group.texts)
    )
      fail(
        'The semantic edit would move a visible line comment. Use raw source or common YAML blocks.',
      );
  }
  return result;
}
