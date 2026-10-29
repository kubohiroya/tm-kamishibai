import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {test} from 'vitest';
import {build} from 'vite';
import {chromium} from 'playwright-core';

test('default runtime error dialog fits small stages, traps focus, copies and returns without replaying', async () => {
  const built = await build({
    configFile: false,
    logLevel: 'error',
    build: {
      write: false,
      minify: false,
      lib: {
        entry: path.resolve('src/dsl4/platform/runtime-error-indicator.ts'),
        name: 'KamishibaiErrorUi',
        formats: ['iife'],
      },
    },
  });
  const output = (Array.isArray(built) ? built[0]! : built) as {
    output: {type: string; code?: string}[];
  };
  const bundle = output.output.find((item) => item.type === 'chunk')?.code;
  assert(bundle);
  const browser = await chromium.launch({
    executablePath:
      process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    args: ['--no-sandbox'],
  });
  try {
    const page = await browser.newPage({viewport: {width: 1100, height: 850}});
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.setContent(
      '<!doctype html><html lang="ja"><meta charset="utf-8"><body style="margin:20px;font-family:sans-serif"><button id="editor">台本を編集</button><div id="stage" style="position:relative;width:480px;height:360px;background:#dbeafe"></div></body></html>',
    );
    await page.addScriptTag({content: bundle});
    await page.locator('#editor').focus();
    await page.evaluate(`(() => {
      window.errorHarness = {returns: 0, copied: '', starts: 0};
      window.errorHarness.indicator = KamishibaiErrorUi.createDsl4RuntimeErrorIndicator({
        document, mount: document.querySelector('#stage'), initialLocale: 'ja', runtimeVersion: 'browser-test',
        locales: {ja: {title: '紙芝居の実行エラー'}, en: {title: 'Runtime error'}},
        onReturnToMenu: () => {window.errorHarness.returns += 1;},
        writeClipboard: async text => {window.errorHarness.copied = text;}
      });
      window.errorHarness.show = () => window.errorHarness.indicator.show({
        code: 'K4-SCHEMA-001', message: 'must have required property seconds',
        validation: {keyword: 'required', field: 'seconds'},
        sourceId: 'stories/帰り道.kamishibai.yaml', range: {start: {line: 42, column: 7}},
        storyPath: '/scenes/帰り道/actions/2', phase: 'preview',
        failureContext: {sceneId: '帰り道', actionIndex: 2, command: 'wait'},
        excerpt: '    - wait: {}'
      });
      window.errorHarness.show();
    })()`);
    for (const size of [
      {width: 480, height: 360},
      {width: 320, height: 240},
      {width: 960, height: 720},
    ]) {
      await page.locator('#stage').evaluate((node, value) => {
        node.style.width = `${value.width}px`;
        node.style.height = `${value.height}px`;
      }, size);
      const fits = (await page.evaluate(`(() => {
        const stage = document.querySelector('#stage').getBoundingClientRect();
        const panel = document.querySelector('[data-dsl4-runtime-error-panel]').getBoundingClientRect();
        const button = document.querySelector('[data-dsl4-runtime-error-action=menu]').getBoundingClientRect();
        const content = document.querySelector('[data-dsl4-runtime-error-content]');
        return {fits: panel.top >= stage.top && panel.bottom <= stage.bottom + 1 && button.bottom <= stage.bottom && button.left >= stage.left, overflow: content.scrollWidth > content.clientWidth + 1};
      })()`)) as {fits: boolean; overflow: boolean};
      assert.equal(fits.fits, true, JSON.stringify(size));
      assert.equal(fits.overflow, false, JSON.stringify(size));
    }
    assert.match(
      await page.locator('[data-dsl4-runtime-error-message]').innerText(),
      /必須項目「seconds」/u,
    );
    assert.match(
      await page.locator('[data-dsl4-runtime-error-where]').innerText(),
      /帰り道.*3番目/u,
    );
    await page.getByRole('button', {name: '診断情報をコピー', exact: true}).click();
    assert.match(await page.evaluate('window.errorHarness.copied'), /browser-test/u);
    await page.getByRole('button', {name: 'メニューに戻る', exact: true}).focus();
    await page.keyboard.press('Tab');
    assert.equal(
      await page.locator('summary').evaluate((node) => node === document.activeElement),
      true,
    );
    await page.keyboard.press('Shift+Tab');
    assert.equal(
      await page
        .getByRole('button', {name: 'メニューに戻る', exact: true})
        .evaluate((node) => node === document.activeElement),
      true,
    );
    await page.locator('#stage').evaluate((node) => {
      node.style.width = '480px';
      node.style.height = '360px';
    });
    await mkdir('test-results/runtime-errors', {recursive: true});
    await page.screenshot({path: 'test-results/runtime-errors/schema-ja.png'});
    await page.getByRole('button', {name: 'メニューに戻る', exact: true}).click();
    assert.equal(await page.evaluate('window.errorHarness.returns'), 1);
    assert.equal(await page.evaluate('window.errorHarness.starts'), 0);
    await page.evaluate('window.errorHarness.show()');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('[data-dsl4-runtime-error=true]').isVisible(), false);
    assert.equal(
      await page.locator('#editor').evaluate((node) => node === document.activeElement),
      true,
    );
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
