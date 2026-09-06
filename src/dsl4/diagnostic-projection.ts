import {normalizeDsl4DiagnosticSequence} from './diagnostic-sequence-policy.js';
import {deepFreeze} from './story-document.js';

export const dsl4DiagnosticProjectionDefaults = Object.freeze({
  maxDiagnostics: 100,
  maxUiDiagnostics: 20,
  maxExcerptScalars: 240,
  maxMessageScalars: 500,
  maxRelatedLocations: 8,
});

const telemetryFields = Object.freeze([
  'version',
  'code',
  'severity',
  'sourceId',
  'range',
  'storyPath',
  'path',
]);

function safeInteger(value: unknown, name: string, minimum: number) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new TypeError(`${name} must be a safe integer >= ${minimum}`);
  }
  return Number(value);
}

function truncateScalars(value: string, maximum: number) {
  const scalars = [...value];
  return scalars.length <= maximum
    ? value
    : `${scalars.slice(0, Math.max(0, maximum - 1)).join('')}…`;
}

function escapeXml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function sourceLine(canonicalSource: string, line: number) {
  if (line < 1) return '';
  let currentLine = 1;
  let start = 0;
  for (let index = 0; index <= canonicalSource.length; index += 1) {
    if (index !== canonicalSource.length && canonicalSource[index] !== '\n') continue;
    if (currentLine === line) return canonicalSource.slice(start, index);
    currentLine += 1;
    start = index + 1;
  }
  return '';
}

export function redactDsl4DiagnosticTelemetry(diagnostic: Readonly<Record<string, any>>) {
  const canonical = normalizeDsl4DiagnosticSequence([diagnostic], {
    maxDiagnostics: 1,
    maxRelatedLocations: dsl4DiagnosticProjectionDefaults.maxRelatedLocations,
  }).diagnostics[0];
  const record = canonical as Readonly<Record<string, unknown>>;
  return deepFreeze(
    Object.fromEntries(
      telemetryFields
        .filter((field) => Object.hasOwn(record, field))
        .map((field) => [field, structuredClone(record[field])]),
    ),
  );
}

/**
 * Produce the only source-bearing diagnostic object intended for author UI.
 * The full canonical source is used transiently and is never retained in the result.
 */
export function createDsl4DiagnosticUiProjection(
  diagnostics: unknown,
  {
    canonicalSource,
    displayName,
    limits = {},
  }: {
    canonicalSource: string;
    displayName: string;
    limits?: Partial<typeof dsl4DiagnosticProjectionDefaults>;
  },
) {
  if (typeof canonicalSource !== 'string') throw new TypeError('canonicalSource must be a string');
  if (typeof displayName !== 'string' || displayName.length === 0) {
    throw new TypeError('displayName must be a non-empty string');
  }
  const resolved = {
    ...dsl4DiagnosticProjectionDefaults,
    ...limits,
  };
  const maxDiagnostics = safeInteger(resolved.maxDiagnostics, 'maxDiagnostics', 1);
  const maxUiDiagnostics = safeInteger(resolved.maxUiDiagnostics, 'maxUiDiagnostics', 1);
  const maxExcerptScalars = safeInteger(resolved.maxExcerptScalars, 'maxExcerptScalars', 1);
  const maxMessageScalars = safeInteger(resolved.maxMessageScalars, 'maxMessageScalars', 1);
  const maxRelatedLocations = safeInteger(resolved.maxRelatedLocations, 'maxRelatedLocations', 0);
  if (maxUiDiagnostics > maxDiagnostics) {
    throw new TypeError('maxUiDiagnostics must not exceed maxDiagnostics');
  }
  const normalized = normalizeDsl4DiagnosticSequence(diagnostics, {
    maxDiagnostics,
    maxRelatedLocations,
  });
  const visible = normalized.diagnostics.slice(0, maxUiDiagnostics).map((diagnostic) => ({
    version: 1,
    code: diagnostic.code,
    severity: diagnostic.severity,
    message: truncateScalars(diagnostic.message, maxMessageScalars),
    sourceId: diagnostic.sourceId,
    displayName,
    range: structuredClone(diagnostic.range),
    ...(diagnostic.storyPath === undefined ? {} : {storyPath: diagnostic.storyPath}),
    path: diagnostic.path,
    excerpt: truncateScalars(
      sourceLine(canonicalSource, diagnostic.range.start.line),
      maxExcerptScalars,
    ),
    related: structuredClone(diagnostic.related),
  }));
  return deepFreeze({
    version: 1,
    canStage: normalized.canStage,
    totalDiagnostics: normalized.counts.total,
    hiddenDiagnostics: Math.max(0, normalized.counts.retained - visible.length),
    diagnostics: visible,
  });
}

export function formatDsl4DiagnosticClipboard(projectedDiagnostic: Readonly<Record<string, any>>) {
  const line = Number(projectedDiagnostic.range?.start?.line ?? 1);
  const column = Number(projectedDiagnostic.range?.start?.column ?? 1);
  return `${projectedDiagnostic.displayName}:${line}:${column}: ${projectedDiagnostic.severity} [${projectedDiagnostic.code}] ${projectedDiagnostic.message}`;
}

export function renderDsl4DiagnosticFallbackSvg(projection: Readonly<Record<string, any>>) {
  const first = projection.diagnostics?.[0];
  if (!first) return '';
  const title = `${first.severity === 'error' ? 'Error' : 'Warning'}: ${first.code}`;
  const summary = `${projection.totalDiagnostics} diagnostic${projection.totalDiagnostics === 1 ? '' : 's'}`;
  const location = `${first.displayName}:${first.range.start.line}:${first.range.start.column}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="160" viewBox="0 0 640 160" role="img" aria-label="${escapeXml(title)}"><rect width="640" height="160" fill="#1f1f24"/><text x="24" y="42" fill="#ffcf5c" font-family="sans-serif" font-size="22">${escapeXml(title)}</text><text x="24" y="78" fill="#ffffff" font-family="sans-serif" font-size="16">${escapeXml(first.message)}</text><text x="24" y="112" fill="#c8c8d0" font-family="monospace" font-size="14">${escapeXml(location)}</text><text x="24" y="140" fill="#c8c8d0" font-family="sans-serif" font-size="14">${escapeXml(summary)}</text></svg>`;
}

export function serializeDsl4DiagnosticExport(
  diagnostics: unknown,
  limits: {maxDiagnostics?: number; maxRelatedLocations?: number} = {},
) {
  const normalized = normalizeDsl4DiagnosticSequence(diagnostics, {
    maxDiagnostics: limits.maxDiagnostics ?? dsl4DiagnosticProjectionDefaults.maxDiagnostics,
    maxRelatedLocations:
      limits.maxRelatedLocations ?? dsl4DiagnosticProjectionDefaults.maxRelatedLocations,
  });
  return `${JSON.stringify({version: 1, diagnostics: normalized.diagnostics})}\n`;
}
