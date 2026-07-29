const topRevealOffset = 8;
const downwardThreshold = 24;
const upwardThreshold = 12;

export function shouldHideAppBarForFragment({hash, isDocumentPage}) {
  return isDocumentPage && hash.length > 1 && hash !== '#main-content';
}

export function renderAppBarState(header, {hidden, instant = false}) {
  header.classList.toggle('site-header--instant', instant);
  header.classList.toggle('site-header--hidden', hidden);

  if (instant) {
    // Commit the hidden transform before restoring transitions.
    header.getBoundingClientRect();
    header.classList.remove('site-header--instant');
  }
}

export function updateAppBarScrollState(state, {scrollY, headerHeight, hasFocus}) {
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

function initializeSiteAppBar(header) {
  const shouldHideForCurrentFragment = () =>
    shouldHideAppBarForFragment({
      hash: window.location.hash,
      isDocumentPage: document.body.classList.contains('site-document'),
    });
  const initiallyHidden = shouldHideForCurrentFragment();
  let state = {
    lastY: Math.max(0, window.scrollY),
    accumulatedDelta: 0,
    hidden: initiallyHidden,
  };
  let frameRequested = false;

  const render = ({instant = false} = {}) =>
    renderAppBarState(header, {hidden: state.hidden, instant});
  const reveal = () => {
    state = {
      ...state,
      lastY: Math.max(0, window.scrollY),
      accumulatedDelta: 0,
      hidden: false,
    };
    render();
  };
  const conceal = ({instant = false} = {}) => {
    state = {
      ...state,
      lastY: Math.max(0, window.scrollY),
      accumulatedDelta: 0,
      hidden: true,
    };
    render({instant});
  };
  const synchronizeFragmentVisibility = () => {
    if (shouldHideForCurrentFragment()) {
      conceal({instant: true});
      return;
    }
    reveal();
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
  window.addEventListener('pageshow', synchronizeFragmentVisibility);
  window.addEventListener('hashchange', synchronizeFragmentVisibility);
  header.addEventListener('focusin', reveal);
  render({instant: initiallyHidden});
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
