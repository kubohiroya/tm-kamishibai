import assert from 'node:assert/strict';
import test from 'node:test';

import {createDsl4LoadingScreenPresenter} from '../src/dsl4/platform/loading-screen-presenter.js';
import {
  createDsl4RuntimeApplicationMenu,
  dsl4RuntimeApplicationMenuDefaultIcons,
} from '../src/dsl4/platform/runtime-application-menu.js';
import {createDsl4RuntimeSourceChooser} from '../src/dsl4/platform/runtime-source-chooser.js';
import {createDsl4RuntimeTitleControls} from '../src/dsl4/platform/runtime-title-controls.js';
import {createFakeDocument, findByAttribute} from './helpers/fake-dom.mjs';

const menuLocales = Object.freeze({
  en: Object.freeze({
    open: 'Open',
    reload: 'Reload',
    build: 'Build',
    about: 'About',
    language: 'Language',
  }),
  ja: Object.freeze({
    open: '台本を開く',
    reload: 'もう一度',
    build: '配布用SB3を作る',
    about: 'アプリ情報',
    language: '言語',
  }),
});

/** @returns {{document: ReturnType<typeof createFakeDocument>, mount: any}} */
function stageMount() {
  const document = createFakeDocument();
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  return {document, mount};
}

test('title controls render injected Kamishibai copy, icon, and stage-relative close glyph', () => {
  const {document, mount} = stageMount();
  const controls = createDsl4RuntimeTitleControls({
    document,
    mount,
    locales: {
      en: {website: 'Official Website', close: 'Close'},
      ja: {website: '公式Webサイト', close: '閉じる'},
    },
    websiteIconUrl: 'https://example.test/site.png',
    onWebsite() {},
    onClose() {},
  });

  const root = findByAttribute(mount, 'data-dsl4-title-controls', 'true')[0];
  assert.equal(root, controls.element);
  assert.equal(root.getAttribute('aria-label'), 'Kamishibai title controls');

  const website = findByAttribute(root, 'data-dsl4-title-action', 'website')[0];
  assert.equal(website.getAttribute('aria-label'), 'Official Website');
  assert.equal(controls.show('ja'), 'ja');
  assert.equal(website.getAttribute('aria-label'), '公式Webサイト');
  // An unknown locale falls back to the Kamishibai default rather than the browser language.
  assert.equal(controls.show(/** @type {any} */ ('fr')), 'en');

  const icon = website.children[0];
  assert.equal(icon.style.backgroundImage, 'url("https://example.test/site.png")');
  assert.equal(icon.style.backgroundSize, 'contain');
  assert.match(icon.style.cssText, /width:10cqw;height:10cqw/u);

  // The stage scales with its container, so the close glyph must stay in container units.
  const lines = findByAttribute(root, 'data-dsl4-close-icon-line', 'true');
  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.match(line.style.cssText, /width:4\.1667cqw;height:\.625cqw/u);
    assert.doesNotMatch(line.style.cssText, /px/u);
  }

  controls.dispose();
  assert.equal(findByAttribute(mount, 'data-dsl4-title-controls', 'true').length, 0);
});

test('title controls invoke injected actions and report their failures', async () => {
  const {document, mount} = stageMount();
  const failures = [];
  let closes = 0;
  const controls = createDsl4RuntimeTitleControls({
    document,
    mount,
    locales: {
      en: {website: 'Official Website', close: 'Close'},
      ja: {website: '公式Webサイト', close: '閉じる'},
    },
    onWebsite() {
      return Promise.reject(new Error('website unavailable'));
    },
    onClose() {
      closes += 1;
    },
    onError(error) {
      failures.push(error);
    },
  });

  findByAttribute(controls.element, 'data-dsl4-title-action', 'close')[0].click();
  findByAttribute(controls.element, 'data-dsl4-title-action', 'website')[0].click();
  await Promise.resolve();
  assert.equal(closes, 1);
  assert.equal(failures.length, 1);
  assert.match(String(failures[0]?.message), /website unavailable/u);
  controls.dispose();
});

test('application menu keeps the Kamishibai icon set, recolor, and stage-relative layout', () => {
  const {document, mount} = stageMount();
  const menu = createDsl4RuntimeApplicationMenu({
    document,
    mount,
    locales: menuLocales,
    onOpen() {},
    onReload() {},
    onBuild() {},
    onAbout() {},
    onLocaleChange() {},
  });

  const root = findByAttribute(mount, 'data-dsl4-application-menu', 'true')[0];
  assert.equal(root.getAttribute('aria-label'), 'Kamishibai application menu');

  /** @param {string} action */
  const button = (action) => findByAttribute(root, 'data-dsl4-menu-action', action)[0];
  for (const action of ['open', 'reload', 'build', 'about', 'language']) {
    const icon = button(action).children[0];
    assert.equal(
      icon.style.backgroundImage,
      `url("${dsl4RuntimeApplicationMenuDefaultIcons[action]}")`,
    );
    // The shipped artwork is dark line art, so the stage buttons recolor it instead of
    // carrying a second icon set.
    assert.equal(icon.style.filter, 'invert(1) brightness(1.7) saturate(.35)');
    assert.match(icon.style.cssText, /width:10cqw;height:10cqw/u);
  }

  assert.equal(button('about').style.top, '58.8889%');
  assert.equal(button('build').hidden, true);

  menu.setBuildState({visible: true, enabled: true, status: 'Ready'});
  assert.equal(button('build').hidden, false);
  assert.equal(button('build').style.top, '43%');
  assert.equal(button('build').style.width, '80%');
  assert.equal(button('about').style.top, '68%');

  const status = findByAttribute(root, 'data-dsl4-menu-build-status', 'true')[0];
  assert.equal(status.textContent, 'Ready');
  assert.equal(status.style.color, '#004d40');

  menu.setBuildState({visible: false});
  assert.equal(button('about').style.top, '58.8889%');
  assert.equal(status.textContent, '');
  menu.dispose();
});

test('application menu toggles locale through the injected callback', async () => {
  const {document, mount} = stageMount();
  const locales = [];
  const menu = createDsl4RuntimeApplicationMenu({
    document,
    mount,
    locales: menuLocales,
    onOpen() {},
    onReload() {},
    onAbout() {},
    onLocaleChange(locale) {
      locales.push(locale);
    },
    reloadEnabled: false,
  });
  const root = menu.element;
  const open = findByAttribute(root, 'data-dsl4-menu-action', 'open')[0];
  const reload = findByAttribute(root, 'data-dsl4-menu-action', 'reload')[0];
  assert.equal(menu.show('en'), 'en');
  assert.equal(open.getAttribute('aria-label'), 'Open');
  assert.equal(reload.disabled, true);
  assert.equal(reload.style.cursor, 'not-allowed');

  findByAttribute(root, 'data-dsl4-menu-action', 'language')[0].click();
  await Promise.resolve();
  assert.deepEqual(locales, ['ja']);
  assert.equal(open.getAttribute('aria-label'), '台本を開く');

  menu.setReloadEnabled(true);
  assert.equal(reload.disabled, false);
  assert.equal(reload.style.cursor, 'pointer');
  menu.dispose();
});

test('source chooser centers the injected Kamishibai choices', () => {
  const {document, mount} = stageMount();
  const chooser = createDsl4RuntimeSourceChooser({
    document,
    mount,
    locales: {
      en: {openFile: 'Open story file', openProject: 'Open project directory', cancel: 'Cancel'},
      ja: {openFile: '台本ファイルを開く', openProject: 'プロジェクトを開く', cancel: 'やめる'},
    },
    onFile() {},
    onProject() {},
    onCancel() {},
  });

  const root = findByAttribute(mount, 'data-dsl4-source-chooser', 'true')[0];
  assert.equal(root, chooser.element);
  chooser.show('en', {fileEnabled: false});
  for (const choice of ['file', 'project', 'cancel']) {
    const button = findByAttribute(root, 'data-dsl4-source-choice', choice)[0];
    assert.match(button.style.cssText, /justify-content:center;text-align:center;/u);
    assert.doesNotMatch(button.style.cssText, /grid-template-columns/u);
  }
  assert.equal(findByAttribute(root, 'data-dsl4-source-choice', 'file')[0].disabled, true);
  assert.equal(findByAttribute(root, 'data-dsl4-source-choice', 'project')[0].disabled, false);
  chooser.dispose();
});

test('loading screen stays hidden until the story supplies loading artwork', () => {
  const {document, mount} = stageMount();
  const presenter = createDsl4LoadingScreenPresenter({document, mount});
  const root = findByAttribute(mount, 'data-dsl4-loading-screen', 'true')[0];
  assert.equal(root.getAttribute('aria-hidden'), 'true');

  presenter.setLoading({visible: true});
  assert.equal(root.style.display, 'none');

  presenter.setLoading({visible: true, resources: {backdrop: 'blob:backdrop', costumes: []}});
  assert.equal(root.style.display, 'flex');
  assert.equal(root.children[0].src, 'blob:backdrop');

  presenter.setLoading({visible: false, resources: {backdrop: 'blob:backdrop'}});
  assert.equal(root.style.display, 'none');
  presenter.dispose();
  assert.equal(findByAttribute(mount, 'data-dsl4-loading-screen', 'true').length, 0);
});
