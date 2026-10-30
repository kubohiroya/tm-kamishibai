import {
  parseSourceSyntax,
  applySourceSyntaxEdits,
  type SourceSyntaxNode,
  type SourceSyntaxPair,
} from '@kubohiroya/turbowarp-yaml-json/source-syntax';
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function fail(message: string): never {
  throw Object.assign(new Error(message), {code: 'VIEW_COMMENT_CONFLICT'});
}
const hasComments = (node: SourceSyntaxNode | SourceSyntaxPair): boolean =>
  Boolean(node.comments && Object.values(node.comments).some((items) => items.length)) ||
  (node.kind === 'map'
    ? node.entries.some(hasComments)
    : node.kind === 'sequence'
      ? node.items.some(hasComments)
      : node.kind === 'pair'
        ? hasComments(node.key) || hasComments(node.value)
        : false);
/** Reconcile owner-normalized value edits into the existing syntax identities and comments. */
export function patchKamishibaiSourceValue(
  source: string,
  baselineValue: unknown,
  nextValue: unknown,
): string {
  if (same(baselineValue, nextValue)) return source;
  const parsed = parseSourceSyntax(source, {format: 'yaml'});
  let serial = 0;
  const fresh = (value: unknown): SourceSyntaxNode => {
    const tree = parseSourceSyntax(JSON.stringify(value), {format: 'json'}).tree;
    const rename = (node: SourceSyntaxNode | SourceSyntaxPair): void => {
      node.id = `app-new:${serial++}`;
      if (node.kind === 'map') node.entries.forEach(rename);
      else if (node.kind === 'sequence') node.items.forEach(rename);
      else if (node.kind === 'pair') {
        rename(node.key);
        rename(node.value);
      }
    };
    rename(tree);
    return tree;
  };
  const update = (node: SourceSyntaxNode, before: unknown, after: unknown): SourceSyntaxNode => {
    if (same(before, after)) return clone(node);
    if (node.kind === 'map' && record(before) && record(after)) {
      const entries = node.entries.map(clone);
      const byKey = new Map(entries.map((pair) => [String(pair.key.value), pair]));
      for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (
          same(before[key], after[key]) &&
          Object.hasOwn(before, key) === Object.hasOwn(after, key)
        )
          continue;
        const pair = byKey.get(key);
        if (!Object.hasOwn(after, key)) {
          if (pair && hasComments(pair))
            fail(
              `The removed property ${key} contains comments. Edit those comments explicitly before converting.`,
            );
          if (pair) entries.splice(entries.indexOf(pair), 1);
        } else if (pair) {
          pair.value = update(pair.value, before[key], after[key]);
        } else {
          const generated = fresh({[key]: after[key]});
          if (generated.kind !== 'map') fail('The property could not be represented.');
          entries.push(generated.entries[0]!);
        }
      }
      return {...clone(node), entries};
    }
    if (
      node.kind === 'sequence' &&
      Array.isArray(before) &&
      Array.isArray(after) &&
      node.items.length === before.length
    ) {
      const used = new Set<number>();
      const matches = after.map((value) => {
        const old = before.findIndex((item, index) => !used.has(index) && same(item, value));
        if (old >= 0) used.add(old);
        return old;
      });
      const remainingOld = before.map((_, index) => index).filter((index) => !used.has(index));
      const remainingNew = matches
        .map((old, index) => (old < 0 ? index : -1))
        .filter((index) => index >= 0);
      if (
        remainingOld.some(
          (old, index) => old !== remainingNew[index] && hasComments(node.items[old]!),
        )
      )
        fail(
          'This sequence edit has ambiguous comment ownership. Edit the raw source or YAML blocks explicitly first.',
        );
      const items = after.map((value, index) => {
        let previous = matches[index]!;
        if (previous < 0 && index < before.length && !used.has(index)) previous = index;
        if (previous < 0) previous = remainingOld.find((old) => !used.has(old)) ?? -1;
        if (previous < 0) return fresh(value);
        used.add(previous);
        return update(node.items[previous]!, before[previous], value);
      });
      node.items.forEach((item, index) => {
        if (!used.has(index) && hasComments(item))
          fail(
            'A removed sequence item contains comments. Edit those comments explicitly before converting.',
          );
      });
      return {...clone(node), items};
    }
    if (
      (node.kind === 'map' && node.entries.some(hasComments)) ||
      (node.kind === 'sequence' && node.items.some(hasComments))
    )
      fail(
        'This structural change would detach comments. Edit the raw source or YAML blocks explicitly first.',
      );
    const replacement = fresh(after);
    replacement.id = node.id;
    if (node.comments) replacement.comments = clone(node.comments);
    return replacement;
  };
  const tree = update(parsed.tree, baselineValue, nextValue);
  return applySourceSyntaxEdits(parsed.baseline, [{op: 'replace-tree', tree}]).source;
}
