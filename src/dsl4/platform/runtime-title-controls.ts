function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireElement(value: unknown, name: string) {
  if (!isRecord(value) || typeof value.appendChild !== 'function') {
    throw new TypeError(`${name} must be a DOM element`);
  }
  return value as Record<string, any>;
}

function requireDocument(value: unknown) {
  if (!isRecord(value) || typeof value.createElement !== 'function') {
    throw new TypeError('document must provide createElement');
  }
  return value as Record<string, any>;
}

/**
 * Render title actions above the Stage without adding Scratch sprites or clones.
 * Pointer events pass through the empty overlay so the Stage itself remains clickable.
 */
export function createDsl4RuntimeTitleControls(options: {
  document: unknown;
  mount: unknown;
  locales: Readonly<Record<'en' | 'ja', Readonly<{website: string; close: string}>>>;
  websiteIconUrl?: string;
  onWebsite: () => unknown | Promise<unknown>;
  onClose: () => unknown | Promise<unknown>;
  onError?: (error: unknown) => unknown;
}) {
  if (!isRecord(options)) throw new TypeError('title control options are required');
  const document = requireDocument(options.document);
  const mount = requireElement(options.mount, 'mount');
  if (typeof options.onWebsite !== 'function') throw new TypeError('onWebsite must be a function');
  if (typeof options.onClose !== 'function') throw new TypeError('onClose must be a function');
  for (const locale of ['en', 'ja'] as const) {
    if (
      !isRecord(options.locales?.[locale]) ||
      typeof options.locales[locale].website !== 'string' ||
      typeof options.locales[locale].close !== 'string'
    ) {
      throw new TypeError(`locales.${locale} must provide website and close`);
    }
  }

  const root = requireElement(document.createElement('section'), 'title control root');
  root.setAttribute('data-dsl4-title-controls', 'true');
  root.setAttribute('aria-label', 'Kamishibai title controls');
  root.style.cssText =
    'position:absolute;inset:0;z-index:2147483600;display:none;box-sizing:border-box;overflow:hidden;pointer-events:none;font-family:sans-serif;container-type:inline-size;';
  root.style.position = 'absolute';
  root.style.display = 'none';

  let restoreMountPosition: null | (() => void) = null;
  if (isRecord(mount.style)) {
    const previous = mount.style.position;
    if (previous === undefined || previous === '' || previous === 'static') {
      mount.style.position = 'relative';
      restoreMountPosition = () => {
        mount.style.position = previous ?? '';
      };
    }
  }

  const website = document.createElement('button');
  const websiteIcon = document.createElement(options.websiteIconUrl ? 'img' : 'span');
  const websiteLabel = document.createElement('span');
  const close = document.createElement('button');
  const closeIcon = document.createElement('span');
  const closeIconForwardLine = document.createElement('span');
  const closeIconBackwardLine = document.createElement('span');
  for (const element of [
    website,
    websiteIcon,
    websiteLabel,
    close,
    closeIcon,
    closeIconForwardLine,
    closeIconBackwardLine,
  ]) {
    if (!isRecord(element) || typeof element.appendChild !== 'function') {
      throw new TypeError('document must create title control elements');
    }
  }
  website.type = 'button';
  website.setAttribute('data-dsl4-title-action', 'website');
  website.style.cssText =
    'position:absolute;left:33.3333%;top:25.5556%;width:33.3333%;height:17.7778%;display:flex;align-items:center;justify-content:center;gap:5%;box-sizing:border-box;border:.4167cqw solid #005f50;border-radius:2.5cqw;background:#007d66;color:#fff;box-shadow:0 .625cqw 1.6667cqw rgba(0,0,0,.2);cursor:pointer;pointer-events:auto;font:inherit;';
  website.style.cursor = 'pointer';
  websiteIcon.setAttribute('aria-hidden', 'true');
  if (options.websiteIconUrl) {
    websiteIcon.src = options.websiteIconUrl;
    websiteIcon.alt = '';
    websiteIcon.style.cssText = 'display:block;width:10cqw;height:10cqw;object-fit:contain;';
  } else {
    websiteIcon.style.cssText = 'font-size:5.5cqw;line-height:1;';
    websiteIcon.textContent = '🌐';
  }
  websiteLabel.style.cssText = 'font-size:2.5cqw;line-height:1.15;text-align:center;';
  website.appendChild(websiteIcon);
  website.appendChild(websiteLabel);

  close.type = 'button';
  close.setAttribute('data-dsl4-title-action', 'close');
  close.style.cssText =
    'position:absolute;left:92.5%;top:1.1111%;width:6.6667%;height:8.8889%;display:flex;align-items:center;justify-content:center;box-sizing:border-box;border:.2083cqw solid #005f50;border-radius:50%;background:#007d66;color:#fff;box-shadow:0 .4167cqw 1.25cqw rgba(0,0,0,.2);cursor:pointer;pointer-events:auto;padding:0;';
  close.style.cursor = 'pointer';
  closeIcon.setAttribute('data-dsl4-close-icon', 'true');
  closeIcon.setAttribute('aria-hidden', 'true');
  closeIcon.style.cssText =
    'position:relative;display:block;width:4.1667cqw;height:4.1667cqw;pointer-events:none;';
  for (const [line, rotation] of [
    [closeIconForwardLine, '45deg'],
    [closeIconBackwardLine, '-45deg'],
  ]) {
    line.setAttribute('data-dsl4-close-icon-line', 'true');
    line.style.cssText = `position:absolute;left:50%;top:50%;display:block;width:4.1667cqw;height:.625cqw;border-radius:.3125cqw;background:currentColor;transform:translate(-50%,-50%) rotate(${rotation});transform-origin:center;`;
    closeIcon.appendChild(line);
  }
  close.appendChild(closeIcon);

  const reportFailure = (failure: unknown) => {
    try {
      options.onError?.(failure);
    } catch {
      // Title control error observers cannot change the application lifecycle.
    }
  };
  const invoke = (event: Record<string, any>, operation: () => unknown) => {
    event.preventDefault?.();
    event.stopPropagation?.();
    try {
      Promise.resolve(operation()).catch(reportFailure);
    } catch (error) {
      reportFailure(error);
    }
  };
  const onWebsiteClick = (event: Record<string, any>) => invoke(event, options.onWebsite);
  const onCloseClick = (event: Record<string, any>) => invoke(event, options.onClose);
  website.addEventListener('click', onWebsiteClick);
  close.addEventListener('click', onCloseClick);
  root.appendChild(website);
  root.appendChild(close);
  mount.appendChild(root);

  let locale: 'en' | 'ja' = 'en';
  let disposed = false;

  function render() {
    websiteLabel.textContent = options.locales[locale].website;
    website.setAttribute('aria-label', options.locales[locale].website);
    close.setAttribute('aria-label', options.locales[locale].close);
    close.setAttribute('title', options.locales[locale].close);
  }

  function show(nextLocale = locale) {
    if (disposed) throw new TypeError('title controls are disposed');
    locale = nextLocale === 'ja' ? 'ja' : 'en';
    render();
    root.style.display = 'block';
    return locale;
  }

  function hide() {
    if (!disposed) root.style.display = 'none';
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    website.removeEventListener('click', onWebsiteClick);
    close.removeEventListener('click', onCloseClick);
    root.remove?.();
    restoreMountPosition?.();
  }

  render();
  return Object.freeze({element: root, show, hide, dispose});
}
