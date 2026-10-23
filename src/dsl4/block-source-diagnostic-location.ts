/** Resolve compiler diagnostics to the deepest original block, including nested controls and refs. */
export function locateDsl4BlockDiagnostic<T extends {sourceId?: string; path?: string}>(
  diagnostic: T,
  sources: {
    sourceLocations: Readonly<Record<string, {targetName: string; blockId: string}>>;
    blockLocations: readonly {
      sourcePath: string;
      path: readonly (string | number)[];
      targetName: string;
      blockId: string;
    }[];
  },
): T & {targetName?: string; blockId?: string} {
  const sourceId = diagnostic.sourceId ?? '';
  const path: string[] = [];
  const text = diagnostic.path ?? '$';
  if (text.startsWith('/'))
    path.push(
      ...text
        .slice(1)
        .split('/')
        .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~')),
    );
  else
    for (const match of text.matchAll(/([^[.\]]+)|\[([0-9]+)\]|\["((?:[^"\\]|\\.)*)"\]/g)) {
      const value = match[1] ?? match[2] ?? JSON.parse(`"${match[3]}"`);
      if (value !== '$') path.push(String(value));
    }
  const location =
    sources.blockLocations
      .filter(
        (candidate) =>
          candidate.sourcePath === sourceId &&
          candidate.path.length <= path.length &&
          candidate.path.every((part, index) => String(part) === path[index]),
      )
      .sort((a, b) => b.path.length - a.path.length)[0] ?? sources.sourceLocations[sourceId];
  return location
    ? {...diagnostic, targetName: location.targetName, blockId: location.blockId}
    : diagnostic;
}
