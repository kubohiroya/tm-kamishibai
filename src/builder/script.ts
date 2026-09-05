import {Sb3BuilderError} from './errors.js';

const externalUriPattern = /^(?:file|https?):/u;

export function collectAssetLines(
  source: string,
): {name: string; reference: string; lineNumber: number}[] {
  const lines = source.split(/\r\n|\n|\r/u);
  const assets = [];
  for (const [index, line] of lines.entries()) {
    if (!line.startsWith('asset=')) continue;
    const separator = line.indexOf(',', 'asset='.length);
    if (separator < 0) {
      throw new Sb3BuilderError(`Invalid asset command at line ${index + 1}: missing comma.`, {
        stage: 'transform-script',
      });
    }
    const name = line.slice('asset='.length, separator);
    const reference = line.slice(separator + 1);
    if (!name || !reference) {
      throw new Sb3BuilderError(
        `Invalid asset command at line ${index + 1}: name and reference are required.`,
        {
          stage: 'transform-script',
        },
      );
    }
    assets.push({name, reference, lineNumber: index + 1});
  }
  return assets;
}

export function createEmbeddedReference(entry: {
  kind: string;
  name: string;
  target: string;
  sb3Name: string;
}) {
  if (entry.kind === 'backdrop') return `backdrop:${entry.sb3Name}`;
  if (entry.kind === 'costume') {
    if (entry.target === entry.name && entry.sb3Name === entry.name) return 'costume';
    if (entry.sb3Name === entry.name) return `costume:${entry.target}`;
    return `costume:${entry.target}:${entry.sb3Name}`;
  }
  if (entry.kind === 'stageSound') return `sound:@stage:${entry.sb3Name}`;
  if (entry.kind === 'spriteSound') return `sound:${entry.target}:${entry.sb3Name}`;
  throw new Sb3BuilderError(`Unsupported asset kind: ${entry.kind}`, {stage: 'transform-script'});
}

export function transformScript(
  sourceBytes: Buffer | Uint8Array,
  assetManifest: ReturnType<typeof import('./manifest.js').validateAssetManifest>,
) {
  let source;
  try {
    source = new TextDecoder('utf-8', {fatal: true}).decode(sourceBytes);
  } catch (error) {
    throw new Sb3BuilderError('Source script is not valid UTF-8.', {
      stage: 'transform-script',
      cause: error,
    });
  }
  const entries = new Map(assetManifest.assets.map((entry) => [entry.name, entry]));
  const seen = new Set();
  const parts = source.split(/(\r\n|\n|\r)/u);
  for (let index = 0; index < parts.length; index += 2) {
    // The loop steps over the separator captures, so every even index is a line.
    const line = parts[index] ?? '';
    if (!line.startsWith('asset=')) continue;
    const separator = line.indexOf(',', 'asset='.length);
    if (separator < 0) {
      throw new Sb3BuilderError(`Invalid asset command: ${line}`, {stage: 'transform-script'});
    }
    const name = line.slice('asset='.length, separator);
    const reference = line.slice(separator + 1);
    if (!externalUriPattern.test(reference)) continue;
    const entry = entries.get(name);
    if (!entry) {
      throw new Sb3BuilderError('External asset has no manifest entry.', {
        assetName: name,
        inputUri: reference,
        stage: 'transform-script',
      });
    }
    if (seen.has(name)) {
      throw new Sb3BuilderError('External asset is declared more than once in the script.', {
        assetName: name,
        inputUri: reference,
        stage: 'transform-script',
      });
    }
    if (reference !== entry.uri) {
      throw new Sb3BuilderError(`Script URI does not match the locked manifest URI ${entry.uri}.`, {
        assetName: name,
        inputUri: reference,
        stage: 'transform-script',
      });
    }
    seen.add(name);
    parts[index] = `asset=${name},${createEmbeddedReference(entry)}`;
  }
  const missing = assetManifest.assets.filter((entry) => !seen.has(entry.name));
  if (missing.length > 0) {
    const [entry] = missing;
    throw new Sb3BuilderError('Manifest asset is not referenced by an external asset= command.', {
      assetName: entry?.name,
      inputUri: entry?.uri,
      stage: 'transform-script',
    });
  }
  const transformed = parts.join('');
  const remaining = collectAssetLines(transformed).find(({reference}) =>
    externalUriPattern.test(reference),
  );
  if (remaining) {
    throw new Sb3BuilderError('Transformed script still contains an external asset reference.', {
      assetName: remaining.name,
      inputUri: remaining.reference,
      stage: 'transform-script',
    });
  }
  return {
    bytes: Buffer.from(transformed, 'utf8'),
    mappings: assetManifest.assets.map((entry) => ({
      name: entry.name,
      inputUri: entry.uri,
      reference: createEmbeddedReference(entry),
    })),
    text: transformed,
  };
}
