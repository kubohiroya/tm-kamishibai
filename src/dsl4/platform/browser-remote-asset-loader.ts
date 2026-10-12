function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function loaderError(code: string, message: string, cause?: unknown) {
  const error = new Error(message, cause === undefined ? undefined : {cause});
  Object.defineProperty(error, 'code', {value: code});
  return error;
}

function abortError() {
  const error = new Error('Remote asset loading was cancelled');
  error.name = 'AbortError';
  return error;
}

function positiveSafeInteger(value: unknown, name: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return Number(value);
}

function validateSignal(value: unknown) {
  if (value === undefined) return null;
  if (
    !isRecord(value) ||
    typeof value.aborted !== 'boolean' ||
    typeof value.addEventListener !== 'function' ||
    typeof value.removeEventListener !== 'function'
  ) {
    throw new TypeError('remote asset context signal must be an AbortSignal');
  }
  return value as unknown as AbortSignal;
}

function canonicalHttpsUrl(value: unknown) {
  if (typeof value !== 'string' || value.length === 0) {
    throw loaderError('K4-ASSET-REMOTE-URL-001', 'Remote asset URL must be a non-empty string');
  }
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw loaderError('K4-ASSET-REMOTE-URL-001', 'Remote asset URL is invalid', error);
  }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash) {
    throw loaderError(
      'K4-ASSET-REMOTE-URL-001',
      'Remote asset URL must be absolute HTTPS without credentials or fragment',
    );
  }
  return url.href;
}

async function readBounded(reader: Dsl4RemoteAssetReader, maxBytes: number) {
  const chunks = [];
  let length = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    if (!(result.value instanceof Uint8Array)) {
      await reader.cancel();
      throw loaderError(
        'K4-ASSET-REMOTE-LOAD-001',
        'Remote asset response returned a non-binary stream chunk',
      );
    }
    length += result.value.byteLength;
    if (length > maxBytes) {
      await reader.cancel();
      throw loaderError('K4-ASSET-REMOTE-LIMIT-001', 'Remote asset exceeds maxBytes');
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * The part of a `fetch` response this loader reads. Declared here rather than taken from `lib.dom`
 * because Standard delivery surfaces inject their own implementation, which answers this much.
 */
interface Dsl4RemoteAssetResponse {
  readonly ok?: unknown;
  readonly status?: unknown;
  readonly url?: unknown;
  readonly headers?: {get?(name: string): string | null};
  readonly body?: {getReader?(): Dsl4RemoteAssetReader} | null;
  arrayBuffer?(): Promise<ArrayBuffer>;
}

interface Dsl4RemoteAssetReader {
  read(): Promise<{done: true; value?: undefined} | {done: false; value: Uint8Array}>;
  cancel(reason?: unknown): unknown;
}

/** Whatever the injected scheduler hands back to identify a pending timeout. */
type Dsl4RemoteAssetTimer = Parameters<typeof clearTimeout>[0];

type Dsl4RemoteAssetFetch = (
  url: string,
  init: Readonly<Record<string, unknown>>,
) => Promise<Dsl4RemoteAssetResponse>;

const fetchFailureMessages = Object.freeze({
  en: Object.freeze({
    offline: (url: string) =>
      `Could not load the remote asset because this device is offline. Check the network connection and try again. URL: ${url}`,
    cors: (url: string) =>
      `The server answered, but it does not allow this page to read the remote asset (CORS). Configure the server to send Access-Control-Allow-Origin, or host the asset elsewhere. URL: ${url}`,
    connect: (url: string) =>
      `Could not establish a secure HTTPS connection to the remote asset server. The server's SSL/TLS certificate is most likely expired or invalid (a server that is down or a host name that does not resolve fails the same way). Open the URL directly in the browser and check for a certificate warning. URL: ${url}`,
  }),
  ja: Object.freeze({
    offline: (url: string) =>
      `この端末がオフラインのため、リモートアセットを読み込めませんでした。ネットワーク接続を確認してから再試行してください。URL: ${url}`,
    cors: (url: string) =>
      `サーバは応答しましたが、このページからのリモートアセットの読み込みを許可していません（CORS）。サーバが Access-Control-Allow-Origin を返すよう設定するか、別の場所にアセットを置いてください。URL: ${url}`,
    connect: (url: string) =>
      `リモートアセットのサーバとHTTPSの安全な接続を確立できませんでした。サーバのSSL/TLS証明書が期限切れ、または無効である可能性が高いです（サーバの停止やホスト名を解決できない場合も同じように失敗します）。このURLをブラウザで直接開き、証明書の警告が表示されないか確認してください。URL: ${url}`,
  }),
});

type Dsl4RemoteAssetLocale = keyof typeof fetchFailureMessages;

function defaultLocale(): Dsl4RemoteAssetLocale {
  return /^ja(?:-|$)/iu.test(globalThis.navigator?.language ?? '') ? 'ja' : 'en';
}

/** Create the bounded browser loader injected by Standard delivery surfaces. */
export function createDsl4BrowserRemoteAssetLoader(
  options: {
    fetch?: Dsl4RemoteAssetFetch;
    timeoutMs?: number;
    maxBytes?: number;
    schedule?: (callback: () => void, milliseconds: number) => Dsl4RemoteAssetTimer;
    cancelSchedule?: (timer: Dsl4RemoteAssetTimer) => unknown;
    locale?: Dsl4RemoteAssetLocale;
    isOnline?: () => boolean;
  } = {},
) {
  if (!isRecord(options)) throw new TypeError('browser remote loader options must be an object');
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== 'function') {
    throw new TypeError('browser remote loader requires fetch');
  }
  const timeoutMs = positiveSafeInteger(options.timeoutMs ?? 30_000, 'timeoutMs');
  const maxBytes = positiveSafeInteger(options.maxBytes ?? 64 * 1024 * 1024, 'maxBytes');
  const schedule = options.schedule ?? globalThis.setTimeout;
  const cancelSchedule = options.cancelSchedule ?? globalThis.clearTimeout;
  if (typeof schedule !== 'function' || typeof cancelSchedule !== 'function') {
    throw new TypeError('browser remote loader requires timer functions');
  }
  const locale = options.locale ?? defaultLocale();
  if (!Object.hasOwn(fetchFailureMessages, locale)) {
    throw new TypeError('browser remote loader locale must be en or ja');
  }
  const messages = fetchFailureMessages[locale];
  const isOnline = options.isOnline ?? (() => globalThis.navigator?.onLine !== false);

  /**
   * `fetch` rejects with the same opaque TypeError for an expired certificate, a missing CORS
   * header, a DNS failure and an offline device, so the message alone ("Failed to fetch") tells the
   * reader nothing. A `no-cors` request is not subject to CORS: when it reaches the server, the
   * first failure was CORS; when it fails too, the HTTPS connection itself could not be made, which
   * for a server that used to work is almost always its certificate.
   */
  async function classifyFetchFailure(url: string, error: unknown, probeSignal: AbortSignal) {
    if (!isOnline()) {
      return loaderError('K4-ASSET-REMOTE-OFFLINE-001', messages.offline(url), error);
    }
    let reachable = false;
    try {
      const probe = await fetchImplementation(url, {
        mode: 'no-cors',
        credentials: 'omit',
        redirect: 'follow',
        cache: 'no-store',
        signal: probeSignal,
      });
      reachable = true;
      await (probe as Dsl4RemoteAssetResponse | undefined)?.body?.getReader?.().cancel();
    } catch {
      // The probe exists only to classify the first failure; its own failure is the answer.
    }
    return reachable
      ? loaderError('K4-ASSET-REMOTE-CORS-001', messages.cors(url), error)
      : loaderError('K4-ASSET-REMOTE-CONNECT-001', messages.connect(url), error);
  }

  /**
   */
  return async function loadRemoteAsset(payload: unknown, context: unknown = {}) {
    if (!isRecord(payload) || !isRecord(context)) {
      throw new TypeError('remote asset payload and context must be objects');
    }
    const url = canonicalHttpsUrl(payload.url);
    const signal = validateSignal(context.signal);
    if (signal?.aborted) throw abortError();
    const controller = new AbortController();
    const cancel = () => controller.abort('cancelled');
    signal?.addEventListener('abort', cancel, {once: true});
    let timedOut = false;
    const timer = schedule(() => {
      timedOut = true;
      controller.abort('timeout');
    }, timeoutMs);
    try {
      let response: Dsl4RemoteAssetResponse;
      try {
        response = (await fetchImplementation(url, {
          credentials: 'omit',
          redirect: 'follow',
          signal: controller.signal,
        })) as Dsl4RemoteAssetResponse;
      } catch (error) {
        if (signal?.aborted || timedOut) throw error;
        throw await classifyFetchFailure(url, error, controller.signal);
      }
      if (!isRecord(response) || response.ok !== true) {
        throw loaderError(
          'K4-ASSET-REMOTE-HTTP-001',
          `Remote asset request failed with HTTP ${String(response?.status ?? 'unknown')}`,
        );
      }
      if (typeof response.url === 'string' && response.url) canonicalHttpsUrl(response.url);
      // `isRecord` above widened the response; read the declared members back off it.
      const headers = (response as Dsl4RemoteAssetResponse).headers;
      const body = (response as Dsl4RemoteAssetResponse).body;
      const contentLength = headers?.get?.('content-length');
      if (contentLength !== null && contentLength !== undefined && contentLength !== '') {
        const declaredLength = Number(contentLength);
        if (
          !Number.isSafeInteger(declaredLength) ||
          declaredLength < 0 ||
          declaredLength > maxBytes
        ) {
          throw loaderError(
            'K4-ASSET-REMOTE-LIMIT-001',
            'Remote asset Content-Length exceeds maxBytes',
          );
        }
      }
      const reader = body?.getReader?.();
      if (!reader) {
        throw loaderError(
          'K4-ASSET-REMOTE-LOAD-001',
          'Remote asset response does not provide a readable byte stream',
        );
      }
      return Object.freeze({
        bytes: await readBounded(reader, maxBytes),
        contentType: headers?.get?.('content-type') ?? '',
      });
    } catch (error) {
      if (signal?.aborted) throw abortError();
      if (timedOut) {
        throw loaderError('K4-ASSET-REMOTE-TIMEOUT-001', 'Remote asset request timed out', error);
      }
      throw error;
    } finally {
      cancelSchedule(timer);
      signal?.removeEventListener('abort', cancel);
    }
  };
}
