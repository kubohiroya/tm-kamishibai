import {createDsl4PoseStateEvent} from '../pose-feedback-policy.js';

const labelKeys = new Set([
  'region',
  'confidence',
  'progress',
  'waiting',
  'charging',
  'completed',
  'cancelled',
  'step',
]);

const defaultLabels = Object.freeze({
  region: 'Pose recognition progress',
  confidence: 'Recognition',
  progress: 'Charge',
  waiting: 'Waiting for pose',
  charging: 'Holding pose',
  completed: 'Pose completed',
  cancelled: 'Pose cancelled',
  step: 'Step',
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireElement(value: unknown, label: string) {
  if (
    !isRecord(value) ||
    typeof value.append !== 'function' ||
    !isRecord(value.ownerDocument) ||
    typeof value.ownerDocument.createElement !== 'function'
  ) {
    throw new TypeError(`${label} must be a DOM element`);
  }
  return value as unknown as HTMLElement;
}

function resolveLabels(input: unknown): Readonly<typeof defaultLabels> {
  if (input === undefined) return defaultLabels;
  if (!isRecord(input)) throw new TypeError('pose feedback presenter labels must be an object');
  const unknown = Object.keys(input).filter((key) => !labelKeys.has(key));
  if (unknown.length > 0) {
    throw new TypeError(`Unknown pose feedback presenter label: ${unknown.sort().join(', ')}`);
  }
  const labels: Record<string, string> = {...defaultLabels};
  for (const [name, value] of Object.entries(input)) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new TypeError(`pose feedback presenter label ${name} must be a non-empty string`);
    }
    labels[name] = value;
  }
  return Object.freeze(labels) as Readonly<typeof defaultLabels>;
}

function percentage(value: number) {
  const scaled = Math.round(value * 1000) / 10;
  return Number.isInteger(scaled) ? String(scaled) : scaled.toFixed(1);
}

/** Render Standard app-shell pose feedback without reading or writing Scratch variables. */
export function createDsl4PoseFeedbackPresenter(options: {
  container: unknown;
  labels?: Readonly<Record<string, string>>;
}) {
  if (!isRecord(options)) throw new TypeError('pose feedback presenter options must be an object');
  const container = requireElement(options.container, 'pose feedback presenter container');
  const labels = resolveLabels(options.labels);
  const document = container.ownerDocument;
  let disposed = false;
  let lastAnnouncementKey: string | null = null;

  const root = document.createElement('section') as HTMLElement;
  root.dataset.dsl4PoseFeedback = 'true';
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', labels.region);
  root.hidden = true;
  Object.assign(root.style, {display: 'none'});

  const summary = document.createElement('p') as HTMLElement;
  summary.dataset.dsl4PoseFeedbackSummary = 'true';
  root.append(summary);

  function createProgress(name: 'confidence' | 'progress') {
    const row = document.createElement('div') as HTMLElement;
    row.dataset.dsl4PoseFeedbackMetric = name;
    const text = document.createElement('span') as HTMLElement;
    text.textContent = labels[name];
    const progress = document.createElement('progress') as HTMLProgressElement;
    progress.max = 100;
    progress.value = 0;
    progress.setAttribute('aria-label', labels[name]);
    progress.setAttribute('aria-valuetext', '0%');
    const output = document.createElement('span') as HTMLElement;
    output.dataset.dsl4PoseFeedbackValue = name;
    output.textContent = '0%';
    row.append(text, progress, output);
    root.append(row);
    return {progress, output};
  }

  const confidenceMetric = createProgress('confidence');
  const progressMetric = createProgress('progress');

  const status = document.createElement('div') as HTMLElement;
  status.dataset.dsl4PoseFeedbackStatus = 'true';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('aria-atomic', 'true');
  Object.assign(status.style, {
    position: 'absolute',
    width: '1px',
    height: '1px',
    overflow: 'hidden',
    clip: 'rect(0 0 0 0)',
    whiteSpace: 'nowrap',
  });
  container.append(root, status);

  function updateMetric(
    metric: {progress: HTMLProgressElement; output: HTMLElement},
    value: number,
  ) {
    const text = `${percentage(value)}%`;
    metric.progress.value = value * 100;
    metric.progress.setAttribute('aria-valuetext', text);
    metric.output.textContent = text;
  }

  function resetVisibleState() {
    root.hidden = true;
    root.style.display = 'none';
    delete root.dataset.phase;
    summary.textContent = '';
    updateMetric(confidenceMetric, 0);
    updateMetric(progressMetric, 0);
  }

  function describe(event: Readonly<ReturnType<typeof createDsl4PoseStateEvent>>) {
    const confidence = `${labels.confidence} ${percentage(event.confidence)}%`;
    const progress = `${labels.progress} ${percentage(event.progress)}%`;
    return `${labels[event.phase]}: ${event.target} / ${event.pose} / ${labels.step} ${event.stepIndex + 1}; ${confidence}; ${progress}`;
  }

  function onPoseState(input: unknown) {
    if (disposed) throw new Error('pose feedback presenter is disposed');
    const event = createDsl4PoseStateEvent(input);
    const description = describe(event);
    const announcementKey = JSON.stringify([
      event.phase,
      event.target,
      event.pose,
      event.stepIndex,
    ]);
    if (announcementKey !== lastAnnouncementKey) {
      lastAnnouncementKey = announcementKey;
      status.textContent = description;
    }
    if (event.phase === 'completed' || event.phase === 'cancelled') {
      resetVisibleState();
      return;
    }
    root.dataset.phase = event.phase;
    root.hidden = false;
    root.style.display = 'grid';
    summary.textContent = description;
    updateMetric(confidenceMetric, event.confidence);
    updateMetric(progressMetric, event.progress);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    resetVisibleState();
    status.textContent = '';
    const errors = [];
    for (const element of [root, status]) {
      try {
        element.remove();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, 'Pose feedback presenter disposal failed');
    }
  }

  return Object.freeze({onPoseState, dispose});
}
