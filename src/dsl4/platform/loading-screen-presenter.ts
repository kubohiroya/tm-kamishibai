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

import {createAppShellLoadingPresenter} from '@kubohiroya/turbowarp-app-shell';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireElement(value: unknown, name: string) {
  if (!isRecord(value) || typeof value.appendChild !== 'function') {
    throw new TypeError(`${name} must be a DOM element`);
  }
  return value as Dsl4RuntimeUiElement;
}

/**
 * Present DSL 3-compatible Loading artwork inside the Scratch stage bounds.
 *
 * The overlay mechanics live in `@kubohiroya/turbowarp-app-shell`. This module keeps the DSL 4.0
 * loading payload shape, the Kamishibai DOM hooks, and the rule that an empty resource set stays
 * hidden instead of covering the stage with a black rectangle.
 */
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
  requireElement(mount, 'Loading presenter mount');
  if (!Number.isFinite(frameMilliseconds) || frameMilliseconds <= 0) {
    throw new TypeError('Loading presenter frameMilliseconds must be positive');
  }

  const presenter = createAppShellLoadingPresenter({
    document: document as unknown as Document,
    mount: mount as unknown as HTMLElement,
    frameMilliseconds,
    attributes: {
      root: {
        'data-dsl4-loading-screen': 'true',
        // Loading artwork is decorative: the story text is announced by the runtime, not the stage.
        'aria-hidden': 'true',
        'aria-live': 'off',
      },
    },
  });
  const root = presenter.element as unknown as Dsl4RuntimeUiElement;
  if (isRecord(root.dataset)) root.dataset.dsl4LoadingScreen = 'true';

  return Object.freeze({
    setLoading(payload: unknown) {
      const visible = isRecord(payload) && payload.visible === true;
      const resources = isRecord(payload) && isRecord(payload.resources) ? payload.resources : null;
      const backdropUrl =
        resources && typeof resources.backdrop === 'string' ? resources.backdrop : '';
      const frameUrls =
        resources && Array.isArray(resources.costumes)
          ? resources.costumes.filter(
              (value): value is string => typeof value === 'string' && value.length > 0,
            )
          : [];
      presenter.setLoading({
        visible: visible && (backdropUrl.length > 0 || frameUrls.length > 0),
        backdropUrl,
        frameUrls,
      });
    },
    dispose() {
      presenter.dispose();
    },
  });
}
