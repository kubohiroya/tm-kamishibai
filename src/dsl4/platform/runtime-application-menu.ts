import {createAppShellApplicationMenu} from '@kubohiroya/turbowarp-app-shell';

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

export const dsl4RuntimeApplicationMenuDefaultIcons = Object.freeze({
  open: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0OCIgaGVpZ2h0PSI0OCIgdmlld0JveD0iMCAwIDQ4IDQ4Ij4KICA8cGF0aCBkPSJNNSAxMy41aDE0bDQuNSA1SDQzdjIySDV6IiBmaWxsPSIjZDg1NjU2IiBzdHJva2U9IiMwMDAiIHN0cm9rZS13aWR0aD0iMi41IiBzdHJva2UtbGluZWpvaW49InJvdW5kIi8+CiAgPHBhdGggZD0iTTUgMTguNWgzOCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMDAwIiBzdHJva2Utd2lkdGg9IjIuNSIvPgo8L3N2Zz4K',
  reload:
    'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0OCIgaGVpZ2h0PSI0OCIgdmlld0JveD0iMCAwIDQ4IDQ4Ij4KICA8cGF0aCBkPSJNNDMuNSAxOS40IDM4LjIgNy4xIDM2LjIgOS40QTE5IDE5IDAgMSAwIDQyLjQgMjguNkwzNi42IDI3LjFBMTMgMTMgMCAxIDEgMzIuNCAxNEwzMC40IDE2LjNaIiBmaWxsPSIjZDg1NjU2IiBzdHJva2U9IiMwMDAiIHN0cm9rZS13aWR0aD0iMi41IiBzdHJva2UtbGluZWpvaW49InJvdW5kIi8+Cjwvc3ZnPgo=',
  build:
    'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0OCIgaGVpZ2h0PSI0OCIgdmlld0JveD0iMCAwIDQ4IDQ4Ij48cGF0aCBkPSJNOCAxMWgzMnYyN0g4eiIgZmlsbD0iI2Q4NTY1NiIgc3Ryb2tlPSIjMDAwIiBzdHJva2Utd2lkdGg9IjIuNSIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCIvPjxwYXRoIGQ9Ik0yNCA3djIybS04LTggOCA4IDgtOE0xNSAzNmgxOCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMDAwIiBzdHJva2Utd2lkdGg9IjMiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCIvPjwvc3ZnPg==',
  about:
    'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0OCIgaGVpZ2h0PSI0OCIgdmlld0JveD0iMCAwIDQ4IDQ4Ij4KICA8Y2lyY2xlIGN4PSIyNCIgY3k9IjI0IiByPSIxOSIgZmlsbD0iI2Q4NTY1NiIgc3Ryb2tlPSIjMDAwIiBzdHJva2Utd2lkdGg9IjIuNSIvPgogIDxjaXJjbGUgY3g9IjI0IiBjeT0iMTUiIHI9IjIuNSIgZmlsbD0iIzAwMCIvPgogIDxwYXRoIGQ9Ik0yNCAyMnYxMyIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMDAwIiBzdHJva2Utd2lkdGg9IjQiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPgo8L3N2Zz4K',
  language:
    'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0OCIgaGVpZ2h0PSI0OCIgdmlld0JveD0iMCAwIDQ4IDQ4Ij4KICA8Y2lyY2xlIGN4PSIyNCIgY3k9IjI0IiByPSIxOSIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMDAwIiBzdHJva2Utd2lkdGg9IjUuNSIvPgogIDxjaXJjbGUgY3g9IjI0IiBjeT0iMjQiIHI9IjE5IiBmaWxsPSJub25lIiBzdHJva2U9IiNkODU2NTYiIHN0cm9rZS13aWR0aD0iMi41Ii8+CiAgPHBhdGggZD0iTTUuNSAyNGgzN004LjUgMTVoMzFNOC41IDMzaDMxTTI0IDVjNSA1IDcgMTEgNyAxOXMtMiAxNC03IDE5Yy01LTUtNy0xMS03LTE5czItMTQgNy0xOVoiIGZpbGw9Im5vbmUiIHN0cm9rZT0iIzAwMCIgc3Ryb2tlLXdpZHRoPSI1IiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiLz4KICA8cGF0aCBkPSJNNS41IDI0aDM3TTguNSAxNWgzMU04LjUgMzNoMzFNMjQgNWM1IDUgNyAxMSA3IDE5cy0yIDE0LTcgMTljLTUtNS03LTExLTctMTlzMi0xNCA3LTE5WiIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZDg1NjU2IiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCIvPgo8L3N2Zz4K',
});

// The menu artwork ships as dark line art so it stays legible on a light editor page. The stage
// buttons are dark teal, so the runtime recolors the same asset instead of shipping a second set.
const menuIconFilter = 'invert(1) brightness(1.7) saturate(.35)';

/** The application actions, which are also the keys of both layout tables. */
type MenuAction = 'open' | 'reload' | 'build' | 'about' | 'language';

const compactLayout = Object.freeze({
  open: {left: '10%', top: '25.5556%', width: '36.6667%', height: '24.4444%'},
  reload: {left: '53.3333%', top: '25.5556%', width: '36.6667%', height: '24.4444%'},
  build: {left: '10%', top: '45%', width: '36.6667%', height: '24.4444%'},
  about: {left: '10%', top: '58.8889%', width: '36.6667%', height: '24.4444%'},
  language: {left: '53.3333%', top: '58.8889%', width: '36.6667%', height: '24.4444%'},
});

const buildLayout = Object.freeze({
  open: {left: '10%', top: '18%', width: '36.6667%', height: '24.4444%'},
  reload: {left: '53.3333%', top: '18%', width: '36.6667%', height: '24.4444%'},
  build: {left: '10%', top: '43%', width: '80%', height: '20%'},
  about: {left: '10%', top: '68%', width: '36.6667%', height: '24.4444%'},
  language: {left: '53.3333%', top: '68%', width: '36.6667%', height: '24.4444%'},
});

/**
 * Render the application actions above the stage without adding Scratch sprites or clones.
 * The overlay is owned by the stage mount, so it cannot escape into the surrounding editor UI.
 *
 * The menu mechanics live in `@kubohiroya/turbowarp-app-shell`. This module owns the Kamishibai
 * action set, its stage-relative layout, the icon recolor, and the `data-dsl4-*` hooks.
 */
export function createDsl4RuntimeApplicationMenu(options: {
  document: unknown;
  mount: unknown;
  locales: Readonly<Record<'en' | 'ja', Readonly<Record<string, string>>>>;
  icons?: Readonly<Partial<Record<'open' | 'reload' | 'build' | 'about' | 'language', string>>>;
  onOpen?: () => unknown | Promise<unknown>;
  onReload: () => unknown | Promise<unknown>;
  onBuild?: () => unknown | Promise<unknown>;
  onAbout: () => unknown | Promise<unknown>;
  onLocaleChange: (locale: 'en' | 'ja') => unknown | Promise<unknown>;
  onError?: (error: unknown) => unknown;
  openVisible?: boolean;
  reloadEnabled?: boolean;
  buildVisible?: boolean;
  buildEnabled?: boolean;
}) {
  if (!isRecord(options)) throw new TypeError('application menu options are required');
  const document = requireDocument(options.document);
  const mount = requireElement(options.mount, 'mount');
  const openVisible = options.openVisible ?? true;
  if (typeof openVisible !== 'boolean') throw new TypeError('open visible state must be boolean');
  if (openVisible && typeof options.onOpen !== 'function') {
    throw new TypeError('onOpen must be a function when the open action is visible');
  }
  if (options.onOpen !== undefined && typeof options.onOpen !== 'function') {
    throw new TypeError('onOpen must be a function');
  }
  for (const callback of ['onReload', 'onAbout', 'onLocaleChange'] as const) {
    if (typeof options[callback] !== 'function') {
      throw new TypeError(`${callback} must be a function`);
    }
  }
  if (options.onBuild !== undefined && typeof options.onBuild !== 'function') {
    throw new TypeError('onBuild must be a function');
  }
  for (const locale of ['en', 'ja'] as const) {
    if (!isRecord(options.locales?.[locale])) {
      throw new TypeError(`locales.${locale} must be an object`);
    }
    for (const key of ['open', 'reload', 'about', 'language']) {
      if (typeof options.locales[locale][key] !== 'string') {
        throw new TypeError(`locales.${locale}.${key} must be a string`);
      }
    }
    if (options.onBuild !== undefined && typeof options.locales[locale].build !== 'string') {
      throw new TypeError(`locales.${locale}.build must be a string`);
    }
  }
  const icons: Record<string, string> = {
    ...dsl4RuntimeApplicationMenuDefaultIcons,
    ...(options.icons ?? {}),
  };
  for (const action of ['open', 'reload', 'build', 'about', 'language'] as const) {
    if (typeof icons?.[action] !== 'string' || icons[action].length === 0) {
      throw new TypeError(`icons.${action} must be a non-empty string`);
    }
  }

  let locale: 'en' | 'ja' = 'en';
  let reloadEnabled = options.reloadEnabled ?? true;
  if (typeof reloadEnabled !== 'boolean') {
    throw new TypeError('reloadEnabled must be a boolean');
  }
  let buildVisible = options.onBuild !== undefined && (options.buildVisible ?? false);
  let buildEnabled = options.buildEnabled ?? false;
  if (typeof buildVisible !== 'boolean') throw new TypeError('buildVisible must be a boolean');
  if (typeof buildEnabled !== 'boolean') throw new TypeError('buildEnabled must be a boolean');
  let buildStatus = '';

  const labelsOf = (action: string) =>
    Object.freeze({
      en: options.locales.en[action] as string,
      ja: options.locales.ja[action] as string,
    });
  const actionState = (action: MenuAction) => {
    const enabled =
      (action !== 'open' || openVisible) &&
      (action !== 'reload' || reloadEnabled) &&
      (action !== 'build' || buildEnabled);
    const visible = (action !== 'open' || openVisible) && (action !== 'build' || buildVisible);
    return {enabled, visible, position: (buildVisible ? buildLayout : compactLayout)[action]};
  };

  const toggleLocale = () => {
    locale = locale === 'ja' ? 'en' : 'ja';
    menu.setLocale(locale);
    return options.onLocaleChange(locale);
  };

  const definitions: ReadonlyArray<{id: MenuAction; onSelect: () => unknown | Promise<unknown>}> = [
    {id: 'open', onSelect: options.onOpen ?? (() => undefined)},
    {id: 'reload', onSelect: options.onReload},
    ...(options.onBuild === undefined ? [] : [{id: 'build' as const, onSelect: options.onBuild}]),
    {id: 'about', onSelect: options.onAbout},
    {id: 'language', onSelect: toggleLocale},
  ];

  const menu = createAppShellApplicationMenu({
    document: document as unknown as Document,
    mount: mount as unknown as HTMLElement,
    // Kamishibai starts every surface in English and switches from this menu.
    initialLocale: 'en',
    fallbackLocale: 'en',
    ariaLabel: 'Kamishibai application menu',
    actions: definitions.map(({id, onSelect}) => ({
      id,
      labels: labelsOf(id),
      icon: {url: icons[id] as string, filter: menuIconFilter},
      attributes: {'data-dsl4-menu-action': id},
      onSelect,
      ...actionState(id),
    })),
    status: {text: '', visible: false, color: '#004d40'},
    attributes: {
      root: {'data-dsl4-application-menu': 'true'},
      status: {'data-dsl4-menu-build-status': 'true'},
    },
    ...(options.onError === undefined ? {} : {onError: options.onError}),
  });

  function render() {
    for (const {id} of definitions) menu.setActionState(id, actionState(id));
    menu.setStatus({text: buildVisible ? buildStatus : '', visible: buildVisible});
  }

  function setReloadEnabled(enabled: boolean) {
    if (typeof enabled !== 'boolean') throw new TypeError('reload enabled state must be a boolean');
    reloadEnabled = enabled;
    render();
  }

  function setBuildState(state: {visible?: boolean; enabled?: boolean; status?: string}) {
    if (!isRecord(state)) throw new TypeError('build state must be an object');
    if (state.visible !== undefined) {
      if (typeof state.visible !== 'boolean')
        throw new TypeError('build visible state must be boolean');
      buildVisible = options.onBuild !== undefined && state.visible;
    }
    if (state.enabled !== undefined) {
      if (typeof state.enabled !== 'boolean')
        throw new TypeError('build enabled state must be boolean');
      buildEnabled = state.enabled;
    }
    if (state.status !== undefined) {
      if (typeof state.status !== 'string') throw new TypeError('build status must be a string');
      buildStatus = state.status.slice(0, 500);
    }
    render();
  }

  render();
  return Object.freeze({
    element: menu.element,
    show(nextLocale?: 'en' | 'ja') {
      if (nextLocale !== undefined) locale = nextLocale === 'ja' ? 'ja' : 'en';
      return menu.show(locale);
    },
    hide: () => menu.hide(),
    setReloadEnabled,
    setBuildState,
    dispose: () => menu.dispose(),
  });
}
