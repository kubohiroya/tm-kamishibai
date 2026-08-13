import {appShellLocales} from '../../../scripts/sb3/app-shell-locales.mjs';
import {createDsl4RuntimeApplicationMenu} from '../../../src/dsl4/platform/runtime-application-menu.js';
import {createDsl4RuntimeErrorIndicator} from '../../../src/dsl4/platform/runtime-error-indicator.js';

const mode = new URL(globalThis.location.href).searchParams.get('mode') ?? 'start';
const browserDocument = globalThis.document;
const stage = browserDocument.querySelector('#stage');
const stageLabel = browserDocument.querySelector('#stage-label');
const greenFlag = browserDocument.querySelector('#green-flag');

if (mode === 'start') {
  stage.dataset.mode = 'start';
  greenFlag.dataset.highlight = 'true';
  stageLabel.textContent = '① Standard SB3を開く　② 緑の旗を押す';
} else if (mode === 'diagnostic') {
  stage.dataset.mode = 'diagnostic';
  const indicator = createDsl4RuntimeErrorIndicator({
    document: browserDocument,
    mount: stage,
    initialLocale: 'ja',
    locales: Object.freeze({
      en: Object.freeze({title: appShellLocales.en.ui.invalidScript}),
      ja: Object.freeze({title: appShellLocales.ja.ui.invalidScript}),
    }),
  });
  indicator.show({
    title: appShellLocales.ja.ui.invalidScript,
    message:
      'story.kamishibai.yaml:38:9\nTurtle.sya は未知の命令です。Turtle.say に直して保存してください。',
    code: 'K4-SCHEMA-UNKNOWN-KEY',
  });
} else {
  const menu = createDsl4RuntimeApplicationMenu({
    document: browserDocument,
    mount: stage,
    locales: Object.freeze({en: appShellLocales.en.ui, ja: appShellLocales.ja.ui}),
    onOpen() {},
    onReload() {},
    onBuild() {},
    onAbout() {},
    onLocaleChange() {},
    reloadEnabled: true,
    buildVisible: true,
    buildEnabled: mode === 'build',
  });
  menu.setBuildState({
    visible: true,
    enabled: mode === 'build',
    status:
      mode === 'build'
        ? '最新の台本と素材を検査済みです。'
        : appShellLocales.ja.ui.buildUnavailable,
  });
  menu.show('ja');
  const action = mode === 'build' ? 'build' : 'open';
  browserDocument.querySelector(`[data-dsl4-menu-action='${action}']`).dataset.highlight = 'true';
  stageLabel.textContent =
    mode === 'build'
      ? '台本と素材が正常なとき、配布用SB3を作れます。'
      : '「台本を開く」からtutorial-storyフォルダーを選びます。';
}

globalThis.browserAuthoringMenuFixture = Object.freeze({ready: true, mode});
