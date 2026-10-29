import {parseDocument} from 'yaml';
import type {extractDsl4BlockSourcesFromProject} from '../turbowarp-yaml-json-block-source.js';
import type {Dsl4BlockErrorHost} from './block-error-location.js';
import {dsl4ErrorBlockSignature} from './block-error-location.js';

type Sources = ReturnType<typeof extractDsl4BlockSourcesFromProject>;

/** Resolve original source ranges captured at compilation to unchanged live blocks. */
export function createDsl4RuntimeBlockDiagnosticLocator(
  sources: Sources,
  host: Dsl4BlockErrorHost,
) {
  const documents = new Map(
    Object.entries(sources.sources).map(([id, source]) => [id, parseDocument(source)]),
  );
  const locations = sources.blockLocations.flatMap((location) => {
    const document = documents.get(location.sourcePath);
    const node = (
      location.path.length ? document?.getIn([...location.path], true) : document?.contents
    ) as {range?: readonly number[]} | undefined;
    const target = host.vm.runtime?.targets?.find(
      (candidate) => candidate.isOriginal !== false && candidate.getName() === location.targetName,
    );
    const original = target?.blocks.getBlock(location.blockId);
    if (!node?.range || !target || !original) return [];
    return [
      {
        ...location,
        start: node.range[0]!,
        end: node.range[1]!,
        target,
        original,
        signature: dsl4ErrorBlockSignature(original),
      },
    ];
  });
  return (diagnostic: Readonly<Record<string, unknown>>): Record<string, unknown> => {
    if (diagnostic.blockId) return {...diagnostic, generatedSource: true};
    const range = diagnostic.range as
      {start?: {offset?: number}; end?: {offset?: number}} | undefined;
    const start = range?.start?.offset;
    const end = range?.end?.offset ?? start;
    if (typeof start !== 'number' || typeof end !== 'number') return {...diagnostic};
    const location = locations
      .filter(
        (item) => item.sourcePath === diagnostic.sourceId && item.start <= start && item.end >= end,
      )
      .sort(
        (left, right) =>
          left.end - left.start - (right.end - right.start) || right.path.length - left.path.length,
      )[0];
    if (!location)
      return {
        ...diagnostic,
        ...(Object.hasOwn(sources.sources, String(diagnostic.sourceId))
          ? {generatedSource: true}
          : {}),
      };
    const unchanged =
      host.vm.runtime?.targets?.includes(location.target) &&
      location.target.blocks.getBlock(location.blockId) === location.original &&
      location.signature !== null &&
      dsl4ErrorBlockSignature(location.original) === location.signature;
    return {
      ...diagnostic,
      generatedSource: true,
      ...(unchanged ? {targetName: location.targetName, blockId: location.blockId} : {}),
    };
  };
}
