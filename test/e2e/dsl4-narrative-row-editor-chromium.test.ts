import assert from 'node:assert/strict';
import {access, mkdir} from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {test} from 'vitest';
import {chromium} from 'playwright-core';
import {createDsl4NarrativeRowsEditor} from '../../src/dsl4/narrative-row-editor.js';

async function chrome() {
  for (const candidate of [
    process.env.CHROME_BIN,
    process.env.GOOGLE_CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'google-chrome',
    'chromium',
  ]) {
    if (!candidate) continue;
    const resolved = candidate.includes('/')
      ? candidate
      : spawnSync('which', [candidate], {encoding: 'utf8'}).stdout?.trim();
    if (resolved)
      try {
        await access(resolved);
        return resolved;
      } catch {
        /* Try the next installed browser. */
      }
  }
  throw new Error('Set CHROME_BIN to run the narrative row table browser test');
}

test('real table edits, reorders, validates and cancels without writing the source until save', async () => {
  const browser = await chromium.launch({
    executablePath: await chrome(),
    headless: true,
    args: ['--no-sandbox'],
  });
  try {
    const page = await browser.newPage({viewport: {width: 1280, height: 800}});
    await page.setContent(
      '<!doctype html><html lang="ja"><head><meta charset="utf-8"></head><body style="font-family:sans-serif"><h1>各回の展開</h1><div id="editor" style="max-width:1100px"></div></body></html>',
    );
    await page.evaluate(`(() => {
      const definition = (${createDsl4NarrativeRowsEditor.toString()})('authoring');
      const source = '[{"名前":"長兄","親切":false,"待ち時間":1},{"名前":"次兄","親切":false,"待ち時間":2},{"名前":"末弟","親切":true,"待ち時間":3}]';
      const snapshot = {arguments: {ITEMS: {kind: 'literal', value: source}}};
      const state = {draft: definition.read(snapshot), issues: [], source, snapshot, definition, remove: null};
      const context = {getDraft: () => structuredClone(state.draft), setDraft: value => {state.draft = structuredClone(value);}, setValidationIssues: value => {state.issues = value;}, getState: () => ({status: 'editing'}), subscribe: () => () => {}};
      state.remove = definition.mount(document.querySelector('#editor'), context);
      window.tableHarness = state;
    })()`);
    await page.getByRole('textbox', {name: '2行目 名前', exact: true}).fill('次兄・改稿');
    await page.getByRole('button', {name: '3行目を上へ'}).click();
    await page.getByRole('textbox', {name: '1行目 待ち時間', exact: true}).fill('1e');
    assert(await page.evaluate('window.tableHarness.issues.length > 0'));
    await page.getByRole('textbox', {name: '1行目 待ち時間', exact: true}).fill('2.5');
    assert.equal(await page.evaluate('window.tableHarness.issues.length'), 0);
    await page.getByRole('textbox', {name: '新しい列名', exact: true}).fill('結果');
    await page.getByRole('button', {name: '列を追加', exact: true}).click();
    await page.getByRole('textbox', {name: '1行目 結果', exact: true}).fill('何もなし');
    const state = (await page.evaluate(
      '({rows: window.tableHarness.draft.rows, original: window.tableHarness.snapshot.arguments.ITEMS.value, patch: window.tableHarness.definition.createPatch(window.tableHarness.draft, window.tableHarness.snapshot)})',
    )) as {rows: {名前: string}[]; original: string; patch: {argument: string; value: string}[]};
    assert.deepEqual(
      state.rows.map((row) => row.名前),
      ['長兄', '末弟', '次兄・改稿'],
    );
    assert(!state.original.includes('改稿'));
    assert(state.patch[0]!.value.includes('改稿'));
    const output = path.resolve('test-results/narrative-rows-table.png');
    await mkdir(path.dirname(output), {recursive: true});
    await page.screenshot({path: output, fullPage: true});
    await page.evaluate('window.tableHarness.remove()');
    assert.equal(await page.locator('[data-kamishibai-narrative-rows]').count(), 0);
    assert.equal(
      await page.evaluate('window.tableHarness.snapshot.arguments.ITEMS.value.includes("改稿")'),
      false,
    );
  } finally {
    await browser.close();
  }
});
