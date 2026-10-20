import {dsl4VideoOperations, isDsl4VideoUrl} from '../video-source.js';
import {createDsl4VideoBackgroundPresentation} from './video-background-presentation.js';
import {deepFreeze} from '../story-document.js';

interface VideoRenderer {
  addOverlay(element: HTMLElement, mode: string): unknown;
  removeOverlay(element: HTMLElement): unknown;
  canvas?: {ownerDocument?: Document};
}

interface VideoEntry {
  display: Readonly<Record<string, unknown>>;
  assetId: string | null;
  element: HTMLVideoElement;
  cancel: ((error?: Error) => void) | null;
  onError: () => void;
  background: boolean;
  releasePresentation: () => void;
  orderPresentation: (order: number) => void;
  setVisible: (visible: boolean) => void;
}

export interface Dsl4VideoPlaybackState {
  readonly display: Readonly<Record<string, unknown>>;
  readonly time: number;
  readonly paused: boolean;
  readonly loop: boolean;
  readonly volume: number;
  readonly muted: boolean;
  readonly rate: number;
}

export interface Dsl4VideoActionPort extends Readonly<Record<string, unknown>> {
  video(payload: unknown, context: unknown): void;
  videoControl(payload: unknown, context: unknown): void | Promise<void>;
  clear(): void;
  releaseAssets(assetIds: readonly string[]): void;
  captureState(): readonly Dsl4VideoPlaybackState[];
  restoreState(state: unknown, context: unknown): Promise<void>;
  dispose(): void;
}

const portEntries = new WeakMap<Dsl4VideoActionPort, Map<string, VideoEntry>>();

function waitForMetadata(element: HTMLVideoElement, signal: AbortSignal) {
  if (signal.aborted) return Promise.reject(cancelled());
  if (element.readyState >= 1) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => finish(videoError('K4-VIDEO-RESTORE', 'Video metadata did not become ready')),
      10_000,
    );
    function finish(error?: Error) {
      clearTimeout(timer);
      element.removeEventListener('loadedmetadata', ready);
      element.removeEventListener('error', failed);
      signal.removeEventListener('abort', aborted);
      if (error) reject(error);
      else resolve();
    }
    const ready = () => finish();
    const failed = () =>
      finish(videoError('K4-VIDEO-RESTORE', 'Video metadata could not be loaded'));
    const aborted = () => finish(cancelled());
    element.addEventListener('loadedmetadata', ready, {once: true});
    element.addEventListener('error', failed, {once: true});
    signal.addEventListener('abort', aborted, {once: true});
    if (signal.aborted) aborted();
  });
}

function videoError(code: string, message: string, cause?: unknown) {
  const error = new Error(message, cause === undefined ? undefined : {cause});
  Object.defineProperty(error, 'code', {value: code});
  return error;
}

function cancelled() {
  const error = videoError('K4-VIDEO-CANCELLED', 'Video playback was cancelled');
  error.name = 'AbortError';
  return error;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw videoError('K4-VIDEO-ARGUMENT', 'Video arguments must be an object');
  }
  return value as Record<string, unknown>;
}

function signalFor(context: unknown): AbortSignal {
  const signal = record(context).signal as AbortSignal;
  if (
    !signal ||
    typeof signal.addEventListener !== 'function' ||
    typeof signal.aborted !== 'boolean'
  ) {
    throw videoError('K4-VIDEO-ARGUMENT', 'Video actions require an AbortSignal');
  }
  if (signal.aborted) throw cancelled();
  return signal;
}

function idFor(args: Record<string, unknown>) {
  if (typeof args.id !== 'string' || args.id.length === 0) {
    throw videoError('K4-VIDEO-ARGUMENT', 'Video id must be a non-empty string');
  }
  return args.id;
}

/** Scene-scoped video overlays share Scratch's native stage scaling in every player surface. */
export function createDsl4VideoActionPort(options: {
  renderer: unknown;
  getAssetResource: (id: string) => unknown;
  createVideo?: () => HTMLVideoElement;
  onBackgroundError?: (error: unknown) => unknown;
}): Dsl4VideoActionPort {
  const renderer = options.renderer as VideoRenderer;
  if (typeof renderer?.addOverlay !== 'function' || typeof renderer.removeOverlay !== 'function') {
    throw videoError('K4-VIDEO-UNAVAILABLE', 'Video playback requires stage overlay support');
  }
  const createVideo =
    options.createVideo ??
    (() => {
      const document = renderer.canvas?.ownerDocument ?? globalThis.document;
      if (!document) throw videoError('K4-VIDEO-UNAVAILABLE', 'Video playback requires a document');
      return document.createElement('video');
    });
  const entries = new Map<string, VideoEntry>();
  let disposed = false;

  function orderPresentations() {
    // Stable sorting preserves display order when two regions share a z-index.
    const ordered = [...entries.values()].sort(
      (a, b) => Number(a.display.zIndex ?? 0) - Number(b.display.zIndex ?? 0),
    );
    ordered
      .filter((entry) => entry.display.plane === 'background')
      .reverse()
      .forEach((entry, index) => entry.orderPresentation(index));
    ordered
      .filter((entry) => (entry.display.plane ?? 'front') === 'front')
      .forEach((entry, index) => entry.orderPresentation(index));
  }

  function stop(entry: VideoEntry, error?: Error) {
    entry.background = false;
    entry.cancel?.(error);
    entry.element.pause();
    entry.element.loop = false;
    entry.element.currentTime = 0;
  }

  function release(id: string) {
    const entry = entries.get(id);
    if (!entry) return;
    entries.delete(id);
    try {
      stop(entry, cancelled());
    } finally {
      entry.element.removeEventListener('error', entry.onError);
      entry.element.removeAttribute('src');
      try {
        entry.element.load();
      } finally {
        entry.releasePresentation();
      }
    }
  }

  function clear() {
    const errors: unknown[] = [];
    for (const id of entries.keys()) {
      try {
        release(id);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Video cleanup failed');
  }

  function requireActive() {
    if (disposed) throw videoError('K4-VIDEO-DISPOSED', 'Video port is disposed');
  }

  const port: Dsl4VideoActionPort = {
    video(payload: unknown, context: unknown) {
      requireActive();
      const args = record(payload);
      const id = idFor(args);
      const displayKeys = new Set([
        'id',
        'asset',
        'url',
        'x',
        'y',
        'width',
        'height',
        'muted',
        'volume',
        'playbackRate',
        'plane',
        'zIndex',
        'fit',
        'stableId',
      ]);
      if (Object.keys(args).some((key) => !displayKeys.has(key)))
        throw videoError('K4-VIDEO-ARGUMENT', 'Unknown video display option');
      if (!entries.has(id) && entries.size >= 32)
        throw videoError('K4-VIDEO-LIMIT', 'At most 32 video regions may be active');
      signalFor(context);
      for (const name of ['x', 'y', 'width', 'height'] as const) {
        if (
          typeof args[name] !== 'number' ||
          !Number.isFinite(args[name]) ||
          ((name === 'width' || name === 'height') && args[name] <= 0)
        ) {
          throw videoError('K4-VIDEO-ARGUMENT', `Invalid video ${name}`);
        }
      }
      if (
        Object.hasOwn(args, 'asset') === Object.hasOwn(args, 'url') ||
        (args.muted !== undefined && typeof args.muted !== 'boolean')
      ) {
        throw videoError(
          'K4-VIDEO-ARGUMENT',
          'Video requires exactly one asset or URL and a boolean muted value',
        );
      }
      const plane = args.plane ?? 'front';
      const fit = args.fit ?? 'contain';
      if (
        (args.plane !== undefined && !['front', 'background'].includes(String(args.plane))) ||
        (args.fit !== undefined && !['contain', 'cover'].includes(String(args.fit))) ||
        (args.zIndex !== undefined && !Number.isSafeInteger(args.zIndex)) ||
        (args.volume !== undefined &&
          (typeof args.volume !== 'number' ||
            !Number.isFinite(args.volume) ||
            args.volume < 0 ||
            args.volume > 100)) ||
        (args.playbackRate !== undefined &&
          (typeof args.playbackRate !== 'number' ||
            !Number.isFinite(args.playbackRate) ||
            args.playbackRate < 0.25 ||
            args.playbackRate > 4))
      ) {
        throw videoError('K4-VIDEO-ARGUMENT', 'Invalid video presentation or playback settings');
      }
      let source: string;
      if (Object.hasOwn(args, 'url')) {
        if (!isDsl4VideoUrl(args.url)) {
          throw videoError(
            'K4-VIDEO-SOURCE',
            'Video URL must be an HTTP(S) media URL without credentials',
          );
        }
        source = args.url;
      } else {
        if (typeof args.asset !== 'string')
          throw videoError('K4-VIDEO-SOURCE', 'Video asset id is invalid');
        const resource = options.getAssetResource(args.asset) as {
          kind?: unknown;
          objectUrl?: unknown;
        } | null;
        if (resource?.kind !== 'video' || typeof resource.objectUrl !== 'string') {
          throw videoError('K4-VIDEO-ASSET', `Video asset is not prepared: ${args.asset}`);
        }
        source = resource.objectUrl;
      }
      const element = createVideo();
      element.preload = 'metadata';
      element.playsInline = true;
      element.controls = false;
      element.muted = args.muted === true;
      element.volume = Number(args.volume ?? 100) / 100;
      element.playbackRate = Number(args.playbackRate ?? 1);
      if (plane === 'background') element.crossOrigin = 'anonymous';
      Object.assign(element.style, {
        position: 'absolute',
        left: `${Number(args.x) - Number(args.width) / 2}px`,
        top: `${-Number(args.y) - Number(args.height) / 2}px`,
        width: `${args.width}px`,
        height: `${args.height}px`,
        objectFit: String(fit),
        background: 'black',
        pointerEvents: 'none',
      });
      const entry: VideoEntry = {
        display: deepFreeze(
          Object.fromEntries(Object.entries(args).filter(([name]) => name !== 'stableId')),
        ),
        assetId: typeof args.asset === 'string' ? args.asset : null,
        element,
        cancel: null,
        background: false,
        releasePresentation: () => {},
        orderPresentation: () => {},
        setVisible: () => {},
        onError: () => {},
      };
      const failPlayback = (error: Error) => {
        if (entry.cancel) entry.cancel(error);
        else if (entry.background) {
          stop(entry);
          try {
            void Promise.resolve(options.onBackgroundError?.(error)).catch(() => {});
          } catch {
            // Error observers cannot interrupt media cleanup.
          }
        }
      };
      entry.onError = () =>
        failPlayback(videoError('K4-VIDEO-MEDIA', `Video could not be loaded or decoded: ${id}`));
      element.addEventListener('error', entry.onError);
      try {
        element.src = source;
        if (plane === 'background') {
          const presentation = createDsl4VideoBackgroundPresentation({
            renderer,
            element,
            x: Number(args.x),
            y: Number(args.y),
            width: Number(args.width),
            height: Number(args.height),
            fit: fit as 'contain' | 'cover',
            onError: (cause) =>
              failPlayback(
                videoError('K4-VIDEO-RENDER', `Video frame rendering failed: ${id}`, cause),
              ),
          });
          entry.releasePresentation = presentation.dispose;
          entry.orderPresentation = presentation.moveToBack;
          entry.setVisible = presentation.setVisible;
        } else {
          entry.releasePresentation = () => {
            renderer.removeOverlay(element);
          };
          const overlay = renderer.addOverlay(element, 'scale-centered') as
            {container?: HTMLElement} | undefined;
          // Each native overlay has a transformed wrapper, which owns its stacking context.
          const container = overlay?.container ?? element;
          entry.orderPresentation = (order) => {
            container.style.zIndex = String(order);
          };
          entry.setVisible = (visible) => {
            container.style.visibility = visible ? '' : 'hidden';
          };
        }
        release(id);
      } catch (error) {
        element.removeEventListener('error', entry.onError);
        element.removeAttribute('src');
        element.load();
        entry.releasePresentation();
        throw error;
      }
      entries.set(id, entry);
      orderPresentations();
    },

    videoControl(payload: unknown, context: unknown) {
      requireActive();
      const args = record(payload);
      const id = idFor(args);
      const signal = signalFor(context);
      const entry = entries.get(id);
      if (!entry) throw videoError('K4-VIDEO-ID', `Unknown video id: ${id}`);
      if (!dsl4VideoOperations.includes(String(args.operation))) {
        throw videoError('K4-VIDEO-ARGUMENT', 'Unknown video operation');
      }
      const operation = String(args.operation);
      const numeric = (field: string, minimum: number, maximum: number) => {
        const value = args[field];
        if (
          typeof value !== 'number' ||
          !Number.isFinite(value) ||
          value < minimum ||
          value > maximum
        ) {
          throw videoError('K4-VIDEO-ARGUMENT', `Invalid video ${field}`);
        }
        return value;
      };
      const element = entry.element;
      if (operation === 'seek') {
        const seconds = numeric('seconds', 0, Number.MAX_SAFE_INTEGER);
        if (Number.isFinite(element.duration) && seconds > element.duration) {
          throw videoError('K4-VIDEO-SEEK', `Video seek exceeds its duration: ${id}`);
        }
        element.currentTime = seconds;
        return;
      }
      if (operation === 'setVolume') {
        element.volume = numeric('volume', 0, 100) / 100;
        return;
      }
      if (operation === 'setPlaybackRate') {
        element.playbackRate = numeric('rate', 0.25, 4);
        return;
      }
      if (operation === 'setMuted') {
        if (typeof args.muted !== 'boolean')
          throw videoError('K4-VIDEO-ARGUMENT', 'Video muted value must be boolean');
        element.muted = args.muted;
        return;
      }
      if (operation === 'pause') {
        entry.background = false;
        entry.cancel?.();
        element.pause();
        return;
      }
      if (operation !== 'resume') stop(entry);
      else {
        entry.background = false;
        entry.cancel?.();
      }
      if (args.operation === 'stop') return;
      if (element.error)
        throw videoError('K4-VIDEO-MEDIA', `Video could not be loaded or decoded: ${id}`);
      if (operation !== 'resume') element.loop = args.operation === 'loop';
      return new Promise<void>((resolve, reject) => {
        let settled = false;
        function finish(error?: Error) {
          if (settled) return;
          settled = true;
          entry!.cancel = null;
          element.removeEventListener('ended', ended);
          signal.removeEventListener('abort', aborted);
          if (error) {
            element.pause();
            element.loop = false;
            reject(error);
          } else resolve();
        }
        const ended = () => finish();
        const aborted = () => finish(cancelled());
        entry.cancel = finish;
        element.addEventListener('ended', ended);
        signal.addEventListener('abort', aborted, {once: true});
        if (signal.aborted) {
          aborted();
          return;
        }
        try {
          void Promise.resolve(element.play()).then(
            () => {
              if (settled) return;
              if (args.operation !== 'playUntilDone') {
                entry.background = true;
                finish();
              }
            },
            (cause) =>
              finish(
                videoError(
                  (cause as {name?: string})?.name === 'NotAllowedError'
                    ? 'K4-VIDEO-AUTOPLAY'
                    : 'K4-VIDEO-PLAY',
                  `Video playback could not start: ${id}`,
                  cause,
                ),
              ),
          );
        } catch (cause) {
          finish(videoError('K4-VIDEO-PLAY', `Video playback could not start: ${id}`, cause));
        }
      });
    },
    clear,
    captureState() {
      requireActive();
      return deepFreeze(
        [...entries.values()].map((entry) => ({
          display: entry.display,
          time: entry.element.currentTime,
          paused: entry.element.paused,
          loop: entry.element.loop,
          volume: entry.element.volume * 100,
          muted: entry.element.muted,
          rate: entry.element.playbackRate,
        })),
      );
    },
    async restoreState(input: unknown, context: unknown) {
      requireActive();
      const signal = signalFor(context);
      if (!Array.isArray(input) || input.length > 32)
        throw videoError('K4-VIDEO-RESTORE', 'Video state must contain at most 32 regions');
      const ids = new Set<string>();
      const states = input.map((value) => {
        const state = record(value);
        const expected = ['display', 'time', 'paused', 'loop', 'volume', 'muted', 'rate'];
        if (
          Object.keys(state).length !== expected.length ||
          expected.some((key) => !Object.hasOwn(state, key))
        ) {
          throw videoError('K4-VIDEO-RESTORE', 'Video state keys are invalid');
        }
        const display = {...record(state.display)};
        const id = idFor(display);
        if (ids.has(id)) throw videoError('K4-VIDEO-RESTORE', 'Duplicate video state id');
        ids.add(id);
        for (const [field, min, max] of [
          ['time', 0, Number.MAX_SAFE_INTEGER],
          ['volume', 0, 100],
          ['rate', 0.25, 4],
        ] as const) {
          if (
            typeof state[field] !== 'number' ||
            !Number.isFinite(state[field]) ||
            state[field] < min ||
            state[field] > max
          ) {
            throw videoError('K4-VIDEO-RESTORE', `Invalid video state ${field}`);
          }
        }
        if (['paused', 'loop', 'muted'].some((field) => typeof state[field] !== 'boolean'))
          throw videoError('K4-VIDEO-RESTORE', 'Invalid video state boolean');
        return {...state, display} as unknown as Dsl4VideoPlaybackState;
      });
      const candidate = createDsl4VideoActionPort(options);
      try {
        for (const state of states) {
          candidate.video(state.display, context);
          const entry = portEntries.get(candidate)!.get(String(state.display.id))!;
          entry.setVisible(false);
          await waitForMetadata(entry.element, signal);
          if (Number.isFinite(entry.element.duration) && state.time > entry.element.duration)
            throw videoError('K4-VIDEO-RESTORE', 'Saved playback position exceeds video duration');
          entry.element.currentTime = state.time;
          entry.element.volume = state.volume / 100;
          entry.element.playbackRate = state.rate;
          entry.element.muted = state.muted;
          entry.element.loop = state.loop;
        }
        for (const state of states) {
          if (!state.paused)
            await candidate.videoControl({id: state.display.id, operation: 'resume'}, context);
        }
        if (signal.aborted) throw cancelled();
        requireActive();
        clear();
        const prepared = portEntries.get(candidate)!;
        for (const [id, entry] of prepared) entries.set(id, entry);
        prepared.clear();
        orderPresentations();
        for (const entry of entries.values()) entry.setVisible(true);
      } finally {
        candidate.dispose();
      }
    },
    releaseAssets(assetIds: readonly string[]) {
      for (const [id, entry] of entries) {
        if (entry.assetId !== null && assetIds.includes(entry.assetId)) release(id);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clear();
    },
  };
  portEntries.set(port, entries);
  return Object.freeze(port);
}
