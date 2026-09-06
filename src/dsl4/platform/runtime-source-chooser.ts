/**
 * The DOM surface this runtime UI builds and mounts. Narrower than the platform's `HTMLElement` on
 * purpose: a suite fake only has to provide what is listed here.
 */
interface Dsl4RuntimeUiElement {
  [member: string]: unknown;
  id?: string;
  textContent?: string | null;
  hidden?: boolean;
  /** Set on the button nodes these surfaces create, absent on the rest. */
  type?: string;
  disabled?: boolean;
  dataset?: Record<string, string | undefined>;
  style: Record<string, string> & {cssText?: string};
  setAttribute(name: string, value: string): void;
  appendChild(child: Dsl4RuntimeUiElement): unknown;
  append?(...children: Dsl4RuntimeUiElement[]): unknown;
  replaceChildren?(...children: Dsl4RuntimeUiElement[]): unknown;
  remove(): void;
  focus?(): void;
  click?(): void;
  addEventListener(type: string, listener: (event: never) => unknown, options?: unknown): unknown;
  removeEventListener(
    type: string,
    listener: (event: never) => unknown,
    options?: unknown,
  ): unknown;
}

import {createAppShellSourceChooser} from '@kubohiroya/turbowarp-app-shell';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireElement(value: unknown, name: string) {
  if (!isRecord(value) || typeof value.appendChild !== 'function') {
    throw new TypeError(`${name} must be a DOM element`);
  }
  return value as Dsl4RuntimeUiElement;
}

const choiceLabelKeys = Object.freeze([
  Object.freeze(['file', 'openFile'] as const),
  Object.freeze(['project', 'openProject'] as const),
  Object.freeze(['cancel', 'cancel'] as const),
]);

/**
 * Let an author choose the watched source shape while preserving the browser click activation
 * needed by File System Access pickers.
 *
 * The dialog mechanics live in `@kubohiroya/turbowarp-app-shell`. This module owns the Kamishibai
 * source choices, their copy, the picker callbacks, and the `data-dsl4-*` hooks.
 */
export function createDsl4RuntimeSourceChooser(options: {
  document: unknown;
  mount: unknown;
  locales: Readonly<
    Record<'en' | 'ja', Readonly<Record<'openFile' | 'openProject' | 'cancel', string>>>
  >;
  onFile: () => unknown | Promise<unknown>;
  onProject: () => unknown | Promise<unknown>;
  onCancel: () => unknown | Promise<unknown>;
  onError?: (error: unknown) => unknown;
}) {
  if (!isRecord(options)) throw new TypeError('runtime source chooser options are required');
  const document = isRecord(options.document) ? (options.document as Dsl4RuntimeUiElement) : null;
  if (!document || typeof document.createElement !== 'function') {
    throw new TypeError('document must provide createElement');
  }
  const mount = requireElement(options.mount, 'mount');
  for (const callback of ['onFile', 'onProject', 'onCancel'] as const) {
    if (typeof options[callback] !== 'function') {
      throw new TypeError(`${callback} must be a function`);
    }
  }
  for (const locale of ['en', 'ja'] as const) {
    for (const key of ['openFile', 'openProject', 'cancel'] as const) {
      if (typeof options.locales?.[locale]?.[key] !== 'string') {
        throw new TypeError(`locales.${locale}.${key} must be a string`);
      }
    }
  }

  const callbacks = {
    file: options.onFile,
    project: options.onProject,
    cancel: options.onCancel,
  } as const;
  const chooser = createAppShellSourceChooser({
    document: document as unknown as Document,
    mount: mount as unknown as HTMLElement,
    initialLocale: 'en',
    fallbackLocale: 'en',
    ariaLabel: 'Kamishibai source chooser',
    choices: choiceLabelKeys.map(([choice, labelKey]) => ({
      id: choice,
      labels: Object.freeze({
        en: options.locales.en[labelKey],
        ja: options.locales.ja[labelKey],
      }),
      // Cancel is the quiet way out, so it keeps the secondary treatment.
      primary: choice !== 'cancel',
      align: 'center' as const,
      attributes: {'data-dsl4-source-choice': choice},
      onSelect: callbacks[choice],
    })),
    attributes: {root: {'data-dsl4-source-chooser': 'true'}},
    ...(options.onError === undefined ? {} : {onError: options.onError}),
  });

  return Object.freeze({
    element: chooser.element,
    show(
      nextLocale: 'en' | 'ja',
      availability: {fileEnabled?: boolean; projectEnabled?: boolean} = {},
    ) {
      const fileEnabled = availability.fileEnabled ?? true;
      const projectEnabled = availability.projectEnabled ?? true;
      if (typeof fileEnabled !== 'boolean' || typeof projectEnabled !== 'boolean') {
        throw new TypeError('source chooser availability must be boolean');
      }
      chooser.show(nextLocale === 'ja' ? 'ja' : 'en', {
        file: {enabled: fileEnabled},
        project: {enabled: projectEnabled},
      });
    },
    hide: () => chooser.hide(),
    dispose: () => chooser.dispose(),
  });
}
