import assert from 'node:assert/strict';
import {access} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {test} from 'vitest';
import {chromium} from 'playwright-core';
import {
  createDsl4PublicationLayout,
  fitDsl4PublicationStage,
} from '../../src/dsl4/platform/publication-stage-layout.js';

async function chromeExecutable() {
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
      : spawnSync('which', [candidate], {encoding: 'utf8'}).stdout.trim();
    if (resolved)
      try {
        await access(resolved);
        return resolved;
      } catch {
        /* Try the next installed browser. */
      }
  }
  throw new Error('Set CHROME_BIN to run publication layout browser regression');
}

test('reserves a visible save row and keeps scaled stage input outside the controls after resizing', async () => {
  const browser = await chromium.launch({executablePath: await chromeExecutable(), headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 1280, height: 960}});
    await page.setContent(
      '<!doctype html><body style="margin:0"><main style="position:fixed;inset:0"></main>',
    );
    await page.evaluate(`(() => {
      const {layout, stageMount, controls} = (${createDsl4PublicationLayout.toString()})(document);
      document.querySelector('main').append(layout);
      const button = document.createElement('button'); button.textContent = 'Save SB3';
      const output = document.createElement('output'); output.textContent = 'Ready'; controls.append(button, output);
      const stage = document.createElement('div'); stage.style.position = 'absolute'; stageMount.append(stage);
      const layers = document.createElement('div'); layers.style.position = 'relative'; stage.append(layers);
      const canvas = document.createElement('canvas'); canvas.width = 480; canvas.height = 360; canvas.tabIndex = 0; canvas.style.display = 'block'; layers.append(canvas);
      canvas.getContext('2d').fillRect(0, 0, 480, 360);
      const state = window.publicationLayoutRegression = {clicks: 0, keys: 0, pointer: null};
      button.addEventListener('click', () => state.clicks++);
      document.addEventListener('keydown', () => state.keys++);
      canvas.addEventListener('pointerdown', e => {const r = canvas.getBoundingClientRect(); state.pointer = {x: (e.clientX-r.x)/r.width*480-240, y: 180-(e.clientY-r.y)/r.height*360};});
      state.dispose = (${fitDsl4PublicationStage.toString()})({mount: stageMount, element: stage, canvas, width: 480, height: 360});
      state.inspect = () => {const rect = e => {const r=e.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom};}; return {stage:rect(stage),canvas:rect(canvas),controls:rect(controls),button:rect(button),viewport:rect(stageMount)};};
    })()`);
    const checkGeometry = async () => {
      await page.waitForFunction(
        `(() => {const s=window.publicationLayoutRegression.inspect();return Math.abs(s.canvas.width-Math.min(s.viewport.width,s.viewport.height*4/3))<.02&&Math.abs(s.canvas.height-Math.min(s.viewport.height,s.viewport.width*3/4))<.02&&s.canvas.bottom<=s.controls.y+.01&&s.button.bottom<=s.controls.bottom+.01&&Math.abs(s.canvas.width/s.canvas.height-4/3)<.001&&['x','y','width','height'].every(k=>Math.abs(s.canvas[k]-s.stage[k])<.02);})()`,
      );
    };
    await checkGeometry();
    const button = page.getByRole('button', {name: 'Save SB3', exact: true});
    await button.click();
    await button.press('Enter');
    await button.press('Space');
    assert.deepEqual(
      await page.evaluate(
        '({clicks:window.publicationLayoutRegression.clicks, keys:window.publicationLayoutRegression.keys})',
      ),
      {clicks: 3, keys: 0},
    );
    for (const size of [
      {width: 800, height: 700},
      {width: 1400, height: 900},
    ]) {
      await page.setViewportSize(size);
      await checkGeometry();
      const box = await page.locator('canvas').boundingBox();
      assert(box);
      await page.mouse.click(box.x + box.width * 0.25, box.y + box.height * 0.1);
      const pointer = (await page.evaluate('window.publicationLayoutRegression.pointer')) as {
        x: number;
        y: number;
      };
      assert(Math.abs(pointer.x + 120) < 1, JSON.stringify({size, box, pointer}));
      assert(Math.abs(pointer.y - 144) < 1, JSON.stringify({size, box, pointer}));
    }
    await page.evaluate('window.publicationLayoutRegression.dispose()');
  } finally {
    await browser.close();
  }
});
