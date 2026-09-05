import {deepFreeze} from './story-document.js';

const eventKeys = new Set(['phase', 'target', 'pose', 'stepIndex', 'confidence', 'progress']);
const phases = new Set(['waiting', 'charging', 'completed', 'cancelled']);

export interface Dsl4PoseStateEvent {
  phase: 'waiting' | 'charging' | 'completed' | 'cancelled';
  target: string;
  pose: string;
  stepIndex: number;
  confidence: number;
  progress: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, name: string) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function normalizedNumber(value: unknown, name: string) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`${name} must be a finite number between 0 and 1`);
  }
  return value;
}

/** Validate and freeze one renderer-independent DSL 4.0 pose feedback event. */
export function createDsl4PoseStateEvent(input: unknown): Readonly<Dsl4PoseStateEvent> {
  if (!isRecord(input)) throw new TypeError('pose state event must be an object');
  const unknown = Object.keys(input).filter((key) => !eventKeys.has(key));
  const missing = [...eventKeys].filter((key) => !Object.hasOwn(input, key));
  if (unknown.length > 0 || missing.length > 0) {
    throw new TypeError(
      `pose state event keys are invalid (unknown: ${unknown.sort().join(', ') || 'none'}; missing: ${missing.sort().join(', ') || 'none'})`,
    );
  }
  if (typeof input.phase !== 'string' || !phases.has(input.phase)) {
    throw new TypeError('pose state event phase is unsupported');
  }
  if (!Number.isSafeInteger(input.stepIndex) || Number(input.stepIndex) < 0) {
    throw new TypeError('pose state event stepIndex must be a non-negative safe integer');
  }
  return deepFreeze({
    phase: input.phase as Dsl4PoseStateEvent['phase'],
    target: nonEmptyString(input.target, 'pose state event target'),
    pose: nonEmptyString(input.pose, 'pose state event pose'),
    stepIndex: Number(input.stepIndex),
    confidence: normalizedNumber(input.confidence, 'pose state event confidence'),
    progress: normalizedNumber(input.progress, 'pose state event progress'),
  });
}
