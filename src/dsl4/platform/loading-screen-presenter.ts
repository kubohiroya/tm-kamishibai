function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireElement(value: unknown, name: string) {
  if (!isRecord(value) || typeof value.appendChild !== 'function') {
    throw new TypeError(`${name} must be a DOM element`);
  }
  return value as any;
}

/** Present DSL 3-compatible Loading artwork inside the Scratch stage bounds. */
export function createDsl4LoadingScreenPresenter({
  document,
  mount,
  frameMilliseconds = 250,
}: {
  document: unknown;
  mount: unknown;
  frameMilliseconds?: number;
}) {
  if (!isRecord(document) || typeof document.createElement !== 'function') {
    throw new TypeError('Loading presenter document must provide createElement');
  }
  const container = requireElement(mount, 'Loading presenter mount');
  if (!Number.isFinite(frameMilliseconds) || frameMilliseconds <= 0) {
    throw new TypeError('Loading presenter frameMilliseconds must be positive');
  }
  if (container !== document.body && isRecord(container.style) && !container.style.position) {
    container.style.position = 'relative';
  }

  const root = document.createElement('div') as any;
  const backdrop = document.createElement('img') as any;
  const costume = document.createElement('img') as any;
  root.dataset.dsl4LoadingScreen = 'true';
  root.setAttribute('data-dsl4-loading-screen', 'true');
  root.setAttribute('aria-hidden', 'true');
  Object.assign(root.style, {
    position: 'absolute',
    inset: '0',
    zIndex: '2147483645',
    display: 'none',
    overflow: 'hidden',
    pointerEvents: 'none',
    background: '#000000',
  });
  Object.assign(backdrop.style, {
    position: 'absolute',
    inset: '0',
    width: '100%',
    height: '100%',
    objectFit: 'cover',
  });
  Object.assign(costume.style, {
    position: 'absolute',
    left: '50%',
    top: '50%',
    maxWidth: '100%',
    maxHeight: '100%',
    transform: 'translate(-50%, -50%)',
    objectFit: 'contain',
  });
  root.appendChild(backdrop);
  root.appendChild(costume);
  container.appendChild(root);

  let disposed = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let costumeUrls: string[] = [];
  let costumeIndex = 0;

  function stopAnimation() {
    if (timer !== null) globalThis.clearInterval(timer);
    timer = null;
  }

  function renderCostume() {
    costume.src = costumeUrls[costumeIndex] ?? '';
  }

  function setLoading(payload: unknown) {
    if (disposed) return;
    stopAnimation();
    const visible = isRecord(payload) && payload.visible === true;
    const resources = isRecord(payload) && isRecord(payload.resources) ? payload.resources : null;
    const backdropUrl =
      resources && typeof resources.backdrop === 'string' ? resources.backdrop : '';
    costumeUrls =
      resources && Array.isArray(resources.costumes)
        ? resources.costumes.filter((value) => typeof value === 'string' && value.length > 0)
        : [];
    costumeIndex = 0;
    backdrop.src = backdropUrl;
    renderCostume();
    const renderable = visible && (backdropUrl.length > 0 || costumeUrls.length > 0);
    root.style.display = renderable ? 'block' : 'none';
    if (renderable && costumeUrls.length > 1) {
      timer = globalThis.setInterval(() => {
        costumeIndex = (costumeIndex + 1) % costumeUrls.length;
        renderCostume();
      }, frameMilliseconds);
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    stopAnimation();
    root.remove();
  }

  return Object.freeze({setLoading, dispose});
}
