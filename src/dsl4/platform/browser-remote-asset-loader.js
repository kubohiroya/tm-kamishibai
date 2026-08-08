/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {string} code @param {string} message @param {unknown} [cause] */
function loaderError(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : {cause});
  Object.defineProperty(error, 'code', {value: code});
  return error;
}

function abortError() {
  const error = new Error('Remote asset loading was cancelled');
  error.name = 'AbortError';
  return error;
}

/** @param {unknown} value @param {string} name */
function positiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return Number(value);
}

/** @param {unknown} value */
function validateSignal(value) {
  if (value === undefined) return null;
  if (
    !isRecord(value) ||
    typeof value.aborted !== 'boolean' ||
    typeof value.addEventListener !== 'function' ||
    typeof value.removeEventListener !== 'function'
  ) {
    throw new TypeError('remote asset context signal must be an AbortSignal');
  }
  return /** @type {AbortSignal} */ (/** @type {unknown} */ (value));
}

/** @param {unknown} value */
function canonicalHttpsUrl(value) {
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

/** @param {ReadableStreamDefaultReader<Uint8Array>} reader @param {number} maxBytes */
async function readBounded(reader, maxBytes) {
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
 * Create the bounded browser loader injected by Standard delivery surfaces.
 *
 * @param {object} [options]
 * @param {Function} [options.fetch]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxBytes]
 * @param {Function} [options.schedule]
 * @param {Function} [options.cancelSchedule]
 */
export function createDsl4BrowserRemoteAssetLoader(options = {}) {
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

  /**
   * @param {unknown} payload
   * @param {unknown} [context]
   */
  return async function loadRemoteAsset(payload, context = {}) {
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
      const response = /** @type {any} */ (
        await fetchImplementation(url, {
          credentials: 'omit',
          redirect: 'follow',
          signal: controller.signal,
        })
      );
      if (!isRecord(response) || response.ok !== true) {
        throw loaderError(
          'K4-ASSET-REMOTE-HTTP-001',
          `Remote asset request failed with HTTP ${String(response?.status ?? 'unknown')}`,
        );
      }
      if (typeof response.url === 'string' && response.url) canonicalHttpsUrl(response.url);
      const headers = /** @type {any} */ (response.headers);
      const body = /** @type {any} */ (response.body);
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
