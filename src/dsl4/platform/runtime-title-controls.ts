import {createAppShellTitleControls} from '@kubohiroya/turbowarp-app-shell';

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
 *
 * The overlay mechanics live in `@kubohiroya/turbowarp-app-shell`. This module injects the
 * Kamishibai copy, website icon, stage-relative close glyph metrics, and `data-dsl4-*` hooks.
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

  const controls = createAppShellTitleControls({
    document: document as unknown as Document,
    mount: mount as unknown as HTMLElement,
    locales: options.locales,
    // Kamishibai starts every surface in English and switches from the application menu.
    initialLocale: 'en',
    fallbackLocale: 'en',
    ariaLabel: 'Kamishibai title controls',
    websiteIcon: options.websiteIconUrl
      ? {url: options.websiteIconUrl}
      : {text: '🌐', size: 'auto', fontSize: '5.5cqw'},
    // The stage scales with its container, so the close glyph is sized in container units.
    closeIconMetrics: {size: '4.1667cqw', thickness: '.625cqw', radius: '.3125cqw'},
    attributes: {
      root: {'data-dsl4-title-controls': 'true'},
      website: {'data-dsl4-title-action': 'website'},
      close: {'data-dsl4-title-action': 'close'},
      closeIcon: {'data-dsl4-close-icon': 'true'},
      closeIconLine: {'data-dsl4-close-icon-line': 'true'},
    },
    onWebsite: options.onWebsite,
    onClose: options.onClose,
    ...(options.onError === undefined ? {} : {onError: options.onError}),
  });

  return Object.freeze({
    element: controls.element,
    show(nextLocale?: 'en' | 'ja') {
      return controls.show(
        nextLocale === undefined ? undefined : nextLocale === 'ja' ? 'ja' : 'en',
      );
    },
    hide: () => controls.hide(),
    dispose: () => controls.dispose(),
  });
}
