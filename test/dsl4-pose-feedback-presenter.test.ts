import assert from 'node:assert/strict';
import {test} from 'vitest';

import {createDsl4PoseFeedbackPresenter} from '../src/dsl4/platform/index.js';
import {createFakeDocument, requireByAttribute} from './helpers/fake-dom.ts';
import {requireDefined} from './helpers/require-value.ts';

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

  const root = requireByAttribute(document.body, 'role', 'group');
  const status = requireByAttribute(document.body, 'role', 'status');
  assert.equal(root.hidden, true);
  assert.equal(root.style.display, 'none');
  assert.equal(root.getAttribute('aria-label'), 'ポーズ認識の進捗');
  assert.equal(status.getAttribute('aria-live'), 'polite');
  assert.equal(status.getAttribute('aria-atomic'), 'true');

  presenter.onPoseState(event);

  const confidenceRow = requireDefined(
    root.children.find((child) => child.dataset.dsl4PoseFeedbackMetric === 'confidence'),
    'the confidence row',
  );
  const progressRow = requireDefined(
    root.children.find((child) => child.dataset.dsl4PoseFeedbackMetric === 'progress'),
    'the charge row',
  );
  const confidence = requireDefined(confidenceRow.children[1], 'the confidence bar');
  const confidenceOutput = requireDefined(confidenceRow.children[2], 'the confidence readout');
  const progress = requireDefined(progressRow.children[1], 'the charge bar');
  const progressOutput = requireDefined(progressRow.children[2], 'the charge readout');
  assert.equal(root.hidden, false);
  assert.equal(root.style.display, 'grid');
  assert.equal(root.dataset.phase, 'waiting');
  assert.equal(confidence.tagName, 'PROGRESS');
  assert.equal(progress.tagName, 'PROGRESS');
  assert.equal(confidenceRow.tagName, 'DIV');
  assert.equal(progressRow.tagName, 'DIV');
  assert.equal(confidenceOutput.tagName, 'SPAN');
  assert.equal(progressOutput.tagName, 'SPAN');
  assert.equal(confidence.max, 100);
  assert.equal(progress.max, 100);
  assert.equal(confidence.value, 82.3);
  assert.equal(progress.value, 25);
  assert.equal(confidence.getAttribute('aria-valuetext'), '82.3%');
  assert.equal(progress.getAttribute('aria-valuetext'), '25%');
  assert.equal(confidenceOutput.textContent, '82.3%');
  assert.equal(progressOutput.textContent, '25%');
  assert.match(
    requireDefined(root.children[0], 'the announcement row').textContent,
    /ポーズ待機中: Hero \/ rescue \/ 手順 1/u,
  );
  assert.match(status.textContent, /認識度 82\.3%; チャージ 25%/u);

  const waitingAnnouncement = status.textContent;
  presenter.onPoseState({...event, confidence: 0.9, progress: 0.5});
  assert.equal(confidence.value, 90);
  assert.equal(progress.value, 50);
  assert.match(
    requireDefined(root.children[0], 'the announcement row').textContent,
    /認識度 90%; チャージ 50%/u,
  );
  assert.equal(status.textContent, waitingAnnouncement);

  presenter.onPoseState({...event, phase: 'charging', stepIndex: 1, progress: 0.6});
  assert.equal(root.dataset.phase, 'charging');
  assert.match(
    requireDefined(root.children[0], 'the announcement row').textContent,
    /ポーズ保持中: Hero \/ rescue \/ 手順 2/u,
  );
  assert.equal(progress.value, 60);
  const chargingAnnouncement = status.textContent;
  presenter.onPoseState({...event, phase: 'charging', stepIndex: 1, progress: 0.8});
  assert.equal(progress.value, 80);
  assert.equal(status.textContent, chargingAnnouncement);

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

/**
 * The presenter as a caller that forgot its options reaches it.
 *
 * The declared parameter is required, which is the point of the case below -- the presenter must
 * refuse the call rather than read `undefined`. Saying that once here keeps the case itself plain.
 */
const createPresenterWithoutOptions = createDsl4PoseFeedbackPresenter as () => unknown;

test('fails closed on invalid presenter configuration and semantic events', () => {
  const document = createFakeDocument();
  assert.throws(() => createPresenterWithoutOptions(), /options/u);
  assert.throws(
    () => createDsl4PoseFeedbackPresenter({container: {}}),
    /container must be a DOM element/u,
  );
  assert.throws(
    () => createDsl4PoseFeedbackPresenter({container: document.body, labels: {colour: 'red'}}),
    /Unknown pose feedback presenter label: colour/u,
  );
  assert.throws(
    () => createDsl4PoseFeedbackPresenter({container: document.body, labels: {region: ' '}}),
    /region must be a non-empty string/u,
  );
  const presenter = createDsl4PoseFeedbackPresenter({container: document.body});
  assert.throws(() => presenter.onPoseState({...event, confidence: 101}), /between 0 and 1/u);
  assert.equal(requireByAttribute(document.body, 'role', 'group').hidden, true);
  presenter.dispose();
});
