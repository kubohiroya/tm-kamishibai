import assert from 'node:assert/strict';
import test from 'node:test';

import {createDsl4PoseFeedbackPresenter} from '../src/dsl4/platform/index.js';
import {createFakeDocument, findByAttribute} from './helpers/fake-dom.mjs';

const event = Object.freeze({
  phase: 'waiting',
  target: 'Hero',
  pose: 'rescue',
  stepIndex: 0,
  confidence: 0.823,
  progress: 0.25,
});

test('renders separate accessible recognition and charge progress without Scratch state', () => {
  const document = createFakeDocument();
  const presenter = createDsl4PoseFeedbackPresenter({
    container: document.body,
    labels: {
      region: 'ポーズ認識の進捗',
      confidence: '認識度',
      progress: 'チャージ',
      waiting: 'ポーズ待機中',
      charging: 'ポーズ保持中',
      completed: 'ポーズ完了',
      cancelled: 'ポーズ中止',
      step: '手順',
    },
  });

  const root = findByAttribute(document.body, 'role', 'group')[0];
  const status = findByAttribute(document.body, 'role', 'status')[0];
  assert.ok(root);
  assert.ok(status);
  assert.equal(root.hidden, true);
  assert.equal(root.style.display, 'none');
  assert.equal(root.getAttribute('aria-label'), 'ポーズ認識の進捗');
  assert.equal(status.getAttribute('aria-live'), 'polite');
  assert.equal(status.getAttribute('aria-atomic'), 'true');

  presenter.onPoseState(event);

  const confidenceRow = root.children.find(
    (child) => child.dataset.dsl4PoseFeedbackMetric === 'confidence',
  );
  const progressRow = root.children.find(
    (child) => child.dataset.dsl4PoseFeedbackMetric === 'progress',
  );
  const confidence = confidenceRow.children[1];
  const confidenceOutput = confidenceRow.children[2];
  const progress = progressRow.children[1];
  const progressOutput = progressRow.children[2];
  assert.equal(root.hidden, false);
  assert.equal(root.style.display, 'grid');
  assert.equal(root.dataset.phase, 'waiting');
  assert.equal(confidence.tagName, 'PROGRESS');
  assert.equal(progress.tagName, 'PROGRESS');
  assert.equal(confidence.max, 100);
  assert.equal(progress.max, 100);
  assert.equal(confidence.value, 82.3);
  assert.equal(progress.value, 25);
  assert.equal(confidence.getAttribute('aria-valuetext'), '82.3%');
  assert.equal(progress.getAttribute('aria-valuetext'), '25%');
  assert.equal(confidenceOutput.textContent, '82.3%');
  assert.equal(progressOutput.textContent, '25%');
  assert.match(root.children[0].textContent, /ポーズ待機中: Hero \/ rescue \/ 手順 1/u);
  assert.match(status.textContent, /認識度 82\.3%; チャージ 25%/u);

  presenter.onPoseState({...event, phase: 'charging', stepIndex: 1, progress: 0.6});
  assert.equal(root.dataset.phase, 'charging');
  assert.match(root.children[0].textContent, /ポーズ保持中: Hero \/ rescue \/ 手順 2/u);
  assert.equal(progress.value, 60);

  presenter.onPoseState({...event, phase: 'completed', confidence: 1, progress: 1});
  assert.equal(root.hidden, true);
  assert.equal(root.style.display, 'none');
  assert.equal(root.dataset.phase, undefined);
  assert.equal(confidence.value, 0);
  assert.equal(progress.value, 0);
  assert.match(status.textContent, /ポーズ完了/u);
  assert.match(status.textContent, /認識度 100%; チャージ 100%/u);

  presenter.onPoseState(event);
  presenter.onPoseState({...event, phase: 'cancelled'});
  assert.equal(root.hidden, true);
  assert.match(status.textContent, /ポーズ中止/u);

  presenter.dispose();
  assert.equal(document.body.children.length, 0);
  presenter.dispose();
  assert.throws(() => presenter.onPoseState(event), /disposed/u);
});

test('fails closed on invalid presenter configuration and semantic events', () => {
  const document = createFakeDocument();
  assert.throws(() => createDsl4PoseFeedbackPresenter(), /options/u);
  assert.throws(
    () => createDsl4PoseFeedbackPresenter({container: {}}),
    /container must be a DOM element/u,
  );
  assert.throws(
    () => createDsl4PoseFeedbackPresenter({container: document.body, labels: {colour: 'red'}}),
    /Unknown pose feedback presenter label: colour/u,
  );
  const presenter = createDsl4PoseFeedbackPresenter({container: document.body});
  assert.throws(() => presenter.onPoseState({...event, confidence: 101}), /between 0 and 1/u);
  assert.equal(findByAttribute(document.body, 'role', 'group')[0].hidden, true);
  presenter.dispose();
});
