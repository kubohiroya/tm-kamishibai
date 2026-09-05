const topRevealOffset = 8;
const downwardThreshold = 24;
const upwardThreshold = 12;

export function renderAppBarState(/** @type {any} */ header, /** @type {any} */ {hidden}) {
  header.classList.toggle('site-header--hidden', hidden);
}

export function updateAppBarScrollState(
  /** @type {any} */ state,
  /** @type {any} */ {scrollY, headerHeight, hasFocus},
) {
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

function initializeSiteAppBar(/** @type {any} */ header) {
  let state = {
    lastY: Math.max(0, window.scrollY),
    accumulatedDelta: 0,
    hidden: false,
  };
  let frameRequested = false;

  const render = () => renderAppBarState(header, {hidden: state.hidden});
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
    state = updateAppBarScrollState(state, {
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

function initializeSiteAppBars() {
  document.querySelectorAll('.site-header').forEach(initializeSiteAppBar);
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeSiteAppBars, {once: true});
  } else {
    initializeSiteAppBars();
  }
}
