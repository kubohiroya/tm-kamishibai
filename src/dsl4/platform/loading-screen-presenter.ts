import {createDsl4RetryableCleanup} from '../retryable-cleanup.js';
import {Dsl4CreationFailure, createDsl4CreationCleanup} from '../creation-cleanup.js';
/**
 * The DOM surface this runtime UI builds and mounts. Narrower than the platform's `HTMLElement` on
 * purpose: a suite fake only has to provide what is listed here.
 */
interface Dsl4RuntimeUiElement {
  [member: string]: unknown;
  id?: string;
  textContent?: string | null;
  hidden?: boolean;
  src?: string;
  children?: ArrayLike<Dsl4RuntimeUiElement>;
  getAttribute?(name: string): string | null;
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

  const mountElement = requireElement(mount, 'Loading presenter mount');
  const previousPosition = mountElement.style.position;
  const presenter = createAppShellLoadingPresenter({
    document: document as unknown as Document,
    mount: mount as unknown as HTMLElement,
    frameMilliseconds,
    attributes: {
      frame: {'data-dsl4-loading-frame': 'true'},
      root: {
        'data-dsl4-loading-screen': 'true',
        // Loading artwork is decorative: the story text is announced by the runtime, not the stage.
        'aria-hidden': 'true',
        'aria-live': 'off',
      },
    },
  });
  const root = presenter.element as unknown as Dsl4RuntimeUiElement;
  let closed = false;
  let presenterClosed = false;
  let animationFrame: Dsl4RuntimeUiElement | null = null;
  let timer: ReturnType<typeof globalThis.setInterval> | null = null;
  let frames: readonly string[] = [];
  let frameIndex = 0;

  function stopAnimation() {
    if (timer !== null) {
      globalThis.clearInterval(timer);
      timer = null;
    }
  }

  function findFrame(element: Dsl4RuntimeUiElement): Dsl4RuntimeUiElement | null {
    if (element.getAttribute?.('data-dsl4-loading-frame') === 'true') return element;
    for (const child of Array.from(element.children ?? [])) {
      const frame = findFrame(child);
      if (frame) return frame;
    }
    return null;
  }

  const releaseSteps = [
    stopAnimation,
    () => {
      if (!presenterClosed) {
        // app-shell 0.3.1 closes before removing DOM. It owns no interval: we pass one frame.
        presenterClosed = true;
        presenter.dispose();
      } else {
        root.remove();
      }
    },
    () => {
      if (
        mount !== (document as {body?: unknown}).body &&
        (previousPosition === undefined || previousPosition === '')
      ) {
        mountElement.style.position = previousPosition ?? '';
      }
    },
  ];
  const cleanup = createDsl4RetryableCleanup({
    steps: releaseSteps,
    parallel: true,
    message: 'Loading presenter disposal failed',
  });
  try {
    animationFrame = findFrame(root);
    if (!animationFrame) throw new TypeError('Loading presenter frame element is missing');
    if (isRecord(root.dataset)) root.dataset.dsl4LoadingScreen = 'true';
  } catch (error) {
    const failedCleanup = createDsl4CreationCleanup(
      releaseSteps,
      'Loading presenter creation cleanup failed',
      true,
    );
    void failedCleanup.dispose().catch(() => {});
    throw new Dsl4CreationFailure(error, failedCleanup, 'Loading presenter creation failed');
  }

  return Object.freeze({
    setLoading(payload: unknown) {
      if (closed) return;
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
      if (closed) return;
      stopAnimation();
      if (closed) return;
      frames = frameUrls;
      frameIndex = 0;
      // Keep the dependency's interval permanently unallocated; cleanup owns our handle directly.
      presenter.setLoading({
        visible: visible && (backdropUrl.length > 0 || frameUrls.length > 0),
        backdropUrl,
        frameUrls: frameUrls.slice(0, 1),
      });
      if (!closed && visible && frames.length > 1) {
        timer = globalThis.setInterval(() => {
          if (closed || frames.length === 0) return;
          frameIndex = (frameIndex + 1) % frames.length;
          const url = frames[frameIndex] ?? '';
          animationFrame!.src = url;
          animationFrame!.style.display = url.length > 0 ? 'block' : 'none';
        }, frameMilliseconds);
      }
    },
    dispose() {
      closed = true;
      frames = [];
      return cleanup.run();
    },
    hasPendingCleanup: cleanup.hasPendingCleanup,
  });
}
