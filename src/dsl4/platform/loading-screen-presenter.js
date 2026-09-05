import {createAppShellLoadingPresenter} from '@kubohiroya/turbowarp-app-shell';

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @param {string} name */
function requireElement(value, name) {
  if (!isRecord(value) || typeof value.appendChild !== 'function') {
    throw new TypeError(`${name} must be a DOM element`);
  }
  return /** @type {any} */ (value);
}

/**
 * Present DSL 3-compatible Loading artwork inside the Scratch stage bounds.
 *
 * The overlay mechanics live in `@kubohiroya/turbowarp-app-shell`. This module keeps the DSL 4.0
 * loading payload shape, the Kamishibai DOM hooks, and the rule that an empty resource set stays
 * hidden instead of covering the stage with a black rectangle.
 *
 * @param {object} options
 * @param {unknown} options.document
 * @param {unknown} options.mount
 * @param {number} [options.frameMilliseconds]
 */
export function createDsl4LoadingScreenPresenter({document, mount, frameMilliseconds = 250}) {
  if (!isRecord(document) || typeof document.createElement !== 'function') {
    throw new TypeError('Loading presenter document must provide createElement');
  }
  requireElement(mount, 'Loading presenter mount');
  if (!Number.isFinite(frameMilliseconds) || frameMilliseconds <= 0) {
    throw new TypeError('Loading presenter frameMilliseconds must be positive');
  }

  const presenter = createAppShellLoadingPresenter({
    document: /** @type {any} */ (document),
    mount: /** @type {any} */ (mount),
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
  const root = /** @type {any} */ (presenter.element);
  if (isRecord(root.dataset)) root.dataset.dsl4LoadingScreen = 'true';

  return Object.freeze({
    /** @param {unknown} payload */
    setLoading(payload) {
      const visible = isRecord(payload) && payload.visible === true;
      const resources = isRecord(payload) && isRecord(payload.resources) ? payload.resources : null;
      const backdropUrl =
        resources && typeof resources.backdrop === 'string' ? resources.backdrop : '';
      const frameUrls =
        resources && Array.isArray(resources.costumes)
          ? resources.costumes.filter((value) => typeof value === 'string' && value.length > 0)
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
