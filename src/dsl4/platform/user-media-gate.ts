function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireFunction(value: unknown, label: string) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value as (...parameters: unknown[]) => unknown;
}

function requireNonEmptyString(value: unknown, label: string) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

/**
 * Whether this browser carries the `<usermedia>` capability element.
 *
 * Chrome 151 is the first to ship it. Everywhere else the story keeps the path it has always had:
 * whoever wants frames opens the camera itself, with the browser's own permission prompt.
 */
export function supportsDsl4UserMediaGate(globalObject: unknown) {
  return isRecord(globalObject) && 'HTMLUserMediaElement' in globalObject;
}

export interface Dsl4UserMediaGateLabels {
  /** The button the person taps to grant the camera. */
  readonly prompt: string;
  /** What the button says while the stream is being handed over. */
  readonly working?: string;
  /** What it says after a refusal or a failure, when tapping again is worth a try. */
  readonly retry?: string;
}

export type Dsl4UserMediaGateOutcome = 'granted' | 'cancelled' | 'error';

/**
 * Stops the microphone `<usermedia>` answered with, and takes its track out of the stream.
 *
 * The element is defined for *combined* audio and video, and no constraint asks the microphone
 * away: `setConstraints` takes `HTMLMediaStreamConstraints`, whose `audio` and `video` must each
 * be a constraint set, so `audio: false` is a `TypeError`, and `{video: {}}` alone changes
 * nothing because the element's own default is `{audio: {}, video: {}}`. Constraints narrow each
 * track's parameters, not which tracks the element opens. Video alone is what the proposed
 * `<camera>` element is for, and no browser ships that yet.
 *
 * So the microphone arrives whatever the story asks for, and the one thing left is to stop it
 * before `adopt` ever sees the stream. The browser's prompt still names the microphone -- only a
 * `<camera>` element could change that -- but nothing listens on it, and the operating system's
 * in-use indicator lets go of it.
 */
function stopAudioTracks(stream: Record<string, unknown>) {
  const getAudioTracks = stream.getAudioTracks;
  if (typeof getAudioTracks !== 'function') return;
  const tracks = (getAudioTracks as () => unknown).call(stream);
  if (!Array.isArray(tracks)) return;
  const removeTrack = stream.removeTrack;
  for (const track of tracks) {
    if (typeof removeTrack === 'function') {
      (removeTrack as (track: unknown) => unknown).call(stream, track);
    }
    if (isRecord(track) && typeof track.stop === 'function') {
      (track.stop as () => unknown).call(track);
    }
  }
}

/**
 * The camera permission step the story document owns.
 *
 * `<usermedia>` is a data mediator, not a permission button: the browser draws the prompt, and the
 * element hands back the `MediaStream` itself. That is the whole reason this lives in the app
 * shell rather than in an extension. A `MediaStream` is neither transferable nor serializable, so
 * it cannot survive the page navigation from a gallery to a story; the document that will play the
 * story has to be the document that asks.
 *
 * What happens to the stream afterwards is the caller's business. This takes `adopt` and reports
 * what came of it; it does not know about Camera Source. The person granted the camera to the
 * story, not to this element -- the one track it does stop is the microphone the element adds on
 * its own, which `stopAudioTracks` explains.
 */
export function createDsl4UserMediaGate(options: {
  document: unknown;
  container: unknown;
  labels: Dsl4UserMediaGateLabels;
  constraints?: Record<string, unknown>;
  adopt: (stream: unknown) => unknown;
  onOutcome?: (outcome: Dsl4UserMediaGateOutcome, detail?: unknown) => void;
}) {
  if (!isRecord(options)) throw new TypeError('user media gate options must be an object');
  const document = options.document;
  if (!isRecord(document) || typeof document.createElement !== 'function') {
    throw new TypeError('document must create elements');
  }
  const container = options.container;
  if (!isRecord(container) || typeof container.appendChild !== 'function') {
    throw new TypeError('container must be a DOM element');
  }
  const adopt = requireFunction(options.adopt, 'adopt');
  const onOutcome =
    options.onOutcome === undefined ? () => {} : requireFunction(options.onOutcome, 'onOutcome');
  if (options.constraints !== undefined && !isRecord(options.constraints)) {
    throw new TypeError('constraints must be an object');
  }
  let labels = requireLabels(options.labels);

  const element = document.createElement('usermedia') as Record<string, unknown> & {
    style?: Record<string, string>;
    setConstraints?: (constraints: Record<string, unknown>) => unknown;
    stream?: unknown;
  };
  const button = document.createElement('button') as Record<string, unknown>;
  button.type = 'button';
  button.textContent = labels.prompt;
  if (typeof element.appendChild === 'function') {
    (element.appendChild as (child: unknown) => unknown)(button);
  }
  if (typeof element.setAttribute === 'function') {
    (element.setAttribute as (name: string, value: string) => unknown)(
      'data-dsl4-user-media-gate',
      'true',
    );
  }
  // The element rejects styles that would hide what the person is agreeing to -- it enforces
  // contrast, opacity and sizing itself -- so there is nothing to set here beyond leaving it
  // visible in the title panel's own flow.
  if (options.constraints && typeof element.setConstraints === 'function') {
    element.setConstraints(options.constraints);
  }
  (container.appendChild as (child: unknown) => unknown)(element);

  let settled = false;
  let disposed = false;

  function setButtonText(text: string) {
    button.textContent = text;
  }

  function finish(outcome: Dsl4UserMediaGateOutcome, detail?: unknown) {
    if (outcome === 'granted') {
      settled = true;
      hide();
    } else {
      setButtonText(labels.retry ?? labels.prompt);
    }
    onOutcome(outcome, detail);
  }

  function hide() {
    if (isRecord(element.style)) (element.style as Record<string, string>).display = 'none';
  }

  async function handleStream() {
    if (disposed || settled) return;
    const stream = element.stream;
    if (!isRecord(stream)) {
      finish('error', new TypeError('<usermedia> reported a stream it does not have'));
      return;
    }
    setButtonText(labels.working ?? labels.prompt);
    stopAudioTracks(stream);
    try {
      await adopt(stream);
      finish('granted', stream);
    } catch (error) {
      // The camera is open and the person said yes; only the handover failed. Recognition will
      // fall back to opening its own camera, which is the same place a browser without this
      // element starts from.
      finish('error', error);
    }
  }

  const listeners: Array<[string, () => void]> = [
    ['stream', () => void handleStream()],
    ['cancel', () => finish('cancelled')],
    ['error', () => finish('error')],
  ];
  for (const [type, listener] of listeners) {
    (element.addEventListener as (type: string, listener: () => void) => unknown)(type, listener);
  }

  function requireLabels(value: unknown) {
    if (!isRecord(value)) throw new TypeError('labels must be an object');
    return {
      prompt: requireNonEmptyString(value.prompt, 'labels.prompt'),
      ...(value.working === undefined
        ? {}
        : {working: requireNonEmptyString(value.working, 'labels.working')}),
      ...(value.retry === undefined
        ? {}
        : {retry: requireNonEmptyString(value.retry, 'labels.retry')}),
    } as Dsl4UserMediaGateLabels;
  }

  return Object.freeze({
    element,
    /** Re-label the button when the title panel switches language. */
    setLabels(next: unknown) {
      labels = requireLabels(next);
      if (!settled) setButtonText(labels.prompt);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const [type, listener] of listeners) {
        (element.removeEventListener as (type: string, listener: () => void) => unknown)(
          type,
          listener,
        );
      }
      const parent = element.parentElement ?? element.parentNode;
      if (isRecord(parent) && typeof parent.removeChild === 'function') {
        (parent.removeChild as (child: unknown) => unknown)(element);
      }
    },
  });
}
