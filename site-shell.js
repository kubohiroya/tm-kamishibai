/**
 * The site header's scroll state: where the page was, how far it has travelled in one direction since
 * the last decision, and whether the bar is hidden right now.
 *
 * @typedef {{lastY: number, accumulatedDelta: number, hidden: boolean}} SiteHeaderScrollState
 */

const topRevealOffset = 8;
const downwardThreshold = 24;
const upwardThreshold = 12;

/**
 * @param {HTMLElement} header
 * @param {{hidden: boolean}} state
 */
export function renderSiteHeaderState(header, {hidden}) {
  header.classList.toggle('site-header--hidden', hidden);
}

/**
 * @param {SiteHeaderScrollState} state
 * @param {{scrollY: number, headerHeight: number, hasFocus: boolean}} reading
 * @returns {SiteHeaderScrollState}
 */
export function updateSiteHeaderScrollState(state, {scrollY, headerHeight, hasFocus}) {
  const currentY = Math.max(0, scrollY);
  const delta = currentY - state.lastY;
  let accumulatedDelta = state.accumulatedDelta;

  if (delta !== 0) {
    const changedDirection =
      accumulatedDelta !== 0 && Math.sign(delta) !== Math.sign(accumulatedDelta);
    accumulatedDelta = changedDirection ? delta : accumulatedDelta + delta;
  }

  let hidden = state.hidden;
  if (currentY <= topRevealOffset || hasFocus) {
    hidden = false;
    accumulatedDelta = 0;
  } else if (currentY > headerHeight && accumulatedDelta >= downwardThreshold) {
    hidden = true;
    accumulatedDelta = 0;
  } else if (accumulatedDelta <= -upwardThreshold) {
    hidden = false;
    accumulatedDelta = 0;
  }

  return {
    lastY: currentY,
    accumulatedDelta,
    hidden,
  };
}

/** @param {HTMLElement} header */
function initializeSiteHeader(header) {
  /** @type {SiteHeaderScrollState} */
  let state = {
    lastY: Math.max(0, window.scrollY),
    accumulatedDelta: 0,
    hidden: false,
  };
  let frameRequested = false;

  const render = () => renderSiteHeaderState(header, {hidden: state.hidden});
  const reveal = () => {
    state = {
      ...state,
      lastY: Math.max(0, window.scrollY),
      accumulatedDelta: 0,
      hidden: false,
    };
    render();
  };
  const update = () => {
    frameRequested = false;
    state = updateSiteHeaderScrollState(state, {
      scrollY: window.scrollY,
      headerHeight: header.offsetHeight,
      hasFocus: header.contains(document.activeElement),
    });
    render();
  };
  const requestUpdate = () => {
    if (!frameRequested) {
      frameRequested = true;
      window.requestAnimationFrame(update);
    }
  };

  window.addEventListener('scroll', requestUpdate, {passive: true});
  window.addEventListener('pageshow', reveal);
  header.addEventListener('focusin', reveal);
  render();
}

function initializeSiteHeaders() {
  document.querySelectorAll('.site-header').forEach((header) => {
    if (header instanceof HTMLElement) initializeSiteHeader(header);
  });
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeSiteHeaders, {once: true});
  } else {
    initializeSiteHeaders();
  }
}
