import {createDsl4IndeterminateProgressIndicator} from '../../../src/dsl4/platform/indeterminate-progress-indicator.js';

/* global document, getComputedStyle */

const mount = document.querySelector('#mount');
const canvas = document.querySelector('#stage');
const enabled = document.querySelector('#enabled');
const disabled = document.querySelector('#disabled');
const indicator = createDsl4IndeterminateProgressIndicator({document, mount});

indicator.setCursor({visible: true, source: 'fixture', cursor: 'pointer'});
indicator.setCursor({visible: false, source: 'fixture', cursor: 'pointer'});

globalThis.dsl4CursorComputedStyleFixture = Object.freeze({
  ready: true,
  setCursor(state) {
    indicator.setCursor({...state, source: 'fixture'});
  },
  snapshot() {
    return {
      surface: mount.dataset.dsl4Cursor,
      canvas: getComputedStyle(canvas).cursor,
      enabled: getComputedStyle(enabled).cursor,
      disabled: getComputedStyle(disabled).cursor,
    };
  },
});
