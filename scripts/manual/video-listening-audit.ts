/** Browser-only audit, serialized by the manual runner and the native-input regression tests. */
export interface SpeakerAuditOptions {
  caseId: string;
  label: string;
  index: number;
  total: number;
}

interface AuditVm {
  runtime: {_primitives: Record<string, (args: Record<string, never>) => unknown>};
  start(): void;
  greenFlag(): void;
  stopAll(): void;
}

interface PlayObservation {
  muted: boolean;
  activation: boolean | null;
  result: string;
  name?: string;
  message?: string;
}

interface InputRecord {
  caseId: string;
  type: string;
  at: string;
  state: unknown;
}

export function installAudit({caseId, label, index, total}: SpeakerAuditOptions) {
  const host = globalThis as typeof globalThis & {
    vm?: AuditVm;
    Scratch?: {vm?: AuditVm};
    __speakerAudit?: {inspect: () => unknown; inputDiagnostics: () => unknown};
    __recordSpeakerOutcome?: (payload: unknown) => Promise<unknown>;
  };
  const refs: WeakRef<HTMLVideoElement>[] = [],
    plays: PlayObservation[] = [],
    errors: string[] = [],
    diagnostics: unknown[] = [],
    steps: unknown[] = [],
    inputEvents: InputRecord[] = [];
  let ready = false,
    selected = false,
    permitted = false,
    started = false,
    titleClosed = false,
    startReport: {trusted: boolean; activation: boolean | null; at: string} | undefined,
    playing: ReturnType<typeof inspect> | undefined,
    stopped: ReturnType<typeof inspect> | undefined,
    stopRequested = false,
    stopAt = 0,
    finished = false;
  const began = performance.now();
  const vm = () => host.vm ?? host.Scratch?.vm;
  const requireVm = () => {
    const current = vm();
    if (!current) throw new Error('The audit VM is unavailable');
    return current;
  };
  const activation = () => navigator.userActivation?.hasBeenActive ?? null;
  const primitive = (name: string) =>
    Object.entries(vm()?.runtime?._primitives ?? {}).find(([key]) =>
      key.endsWith('kamishibairuntime4__' + name),
    )?.[1];
  const visible = (e: Element | null): e is HTMLElement =>
    Boolean(e && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0);
  const step = (name: string) => {
    const event = {
      name,
      caseId,
      elapsedMs: Math.round(performance.now() - began),
      activation: activation(),
    };
    steps.push(event);
    console.log('VIDEO_LISTENING_STAGE:' + JSON.stringify(event));
  };
  addEventListener('error', (e) => errors.push(e.message));
  addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
  const originalError = console.error;
  console.error = function (...args) {
    diagnostics.push(
      args.map((a) => ({
        code: a && typeof a === 'object' && 'code' in a ? a.code : null,
        message: a instanceof Error ? a.message : String(a),
      })),
    );
    return originalError.apply(this, args);
  };
  const nativePlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) {
    if (!(this instanceof HTMLVideoElement)) return nativePlay.apply(this, args);
    if (!refs.some((r) => r.deref() === this)) refs.push(new WeakRef(this));
    const record: PlayObservation = {
      muted: this.muted,
      activation: activation(),
      result: 'pending',
    };
    plays.push(record);
    const p = nativePlay.apply(this, args);
    p.then(
      () => (record.result = 'playing'),
      (e) => Object.assign(record, {result: 'rejected', name: e.name, message: e.message}),
    );
    return p;
  };
  const inspect = () => ({
    activation: activation(),
    status: primitive('statusReporter')?.({}) ?? null,
    error: primitive('lastErrorReporter')?.({}) ?? null,
    videos: refs
      .map((r) => r.deref())
      .filter((v): v is HTMLVideoElement => v !== undefined)
      .map((v) => ({
        width: v.videoWidth,
        height: v.videoHeight,
        currentTime: v.currentTime,
        paused: v.paused,
        muted: v.muted,
        loop: v.loop,
        volume: v.volume,
        src: v.getAttribute('src'),
        frames: v.getVideoPlaybackQuality?.().totalVideoFrames ?? null,
        hasAudio: (v as HTMLVideoElement & {mozHasAudio?: boolean}).mozHasAudio ?? null,
      })),
    plays: structuredClone(plays),
    diagnostics: structuredClone(diagnostics),
  });
  host.__speakerAudit = {
    inspect,
    inputDiagnostics: () => ({events: structuredClone(inputEvents), current: inputSnapshot()}),
  };
  let panel: HTMLElement | undefined,
    status: HTMLElement,
    start: HTMLButtonElement | undefined,
    heard: HTMLButtonElement,
    silent: HTMLButtonElement,
    unknown: HTMLButtonElement,
    lastAvailability: string | undefined;
  const describe = (e: Element | null) =>
    e
      ? {
          tag: e.tagName,
          id: e.id || null,
          action: e.getAttribute?.('data-dsl4-title-action') ?? null,
        }
      : null;
  const inputSnapshot = () => {
    const rect = start?.getBoundingClientRect();
    const x = rect ? rect.x + rect.width / 2 : 0,
      y = rect ? rect.y + rect.height / 2 : 0;
    return {
      ready,
      started,
      finished,
      connected: panel?.isConnected ?? false,
      disabled: start?.disabled ?? null,
      focused: document.hasFocus(),
      visibility: document.visibilityState,
      active: describe(document.activeElement),
      runtimeStatus: primitive('statusReporter')?.({}) ?? null,
      rect: rect ? {x: rect.x, y: rect.y, width: rect.width, height: rect.height} : null,
      hit: rect ? document.elementFromPoint(x, y) === start : false,
      stack: rect ? document.elementsFromPoint(x, y).slice(0, 5).map(describe) : [],
    };
  };
  const inputEvent = (type: string, detail: Record<string, unknown> = {}) => {
    const record = {caseId, type, at: new Date().toISOString(), ...detail, state: inputSnapshot()};
    inputEvents.push(record);
    if (inputEvents.length > 120) inputEvents.shift();
    console.log('VIDEO_LISTENING_INPUT:' + JSON.stringify(record));
  };
  const begin = (e: MouseEvent) => {
    if (!e.isTrusted) {
      inputEvent('start-rejected', {reason: 'untrusted-input'});
      return;
    }
    if (!ready || started || !start) {
      inputEvent('start-rejected', {reason: started ? 'already-started' : 'not-ready'});
      return;
    }
    started = true;
    start.disabled = true;
    startReport = {trusted: e.isTrusted, activation: activation(), at: new Date().toISOString()};
    inputEvent('start-accepted');
    step('listener-start');
    try {
      requireVm().start();
      requireVm().greenFlag();
      status.textContent = '再生を開始しています…';
    } catch (error) {
      errors.push(String(error instanceof Error ? error.stack : error));
      try {
        vm()?.stopAll();
      } catch {}
      started = false;
      start.disabled = false;
      status.textContent =
        '開始処理でエラーが発生しました。入力診断を保存しました。再試行または未確認で記録できます。';
      inputEvent('start-error', {message: String(error instanceof Error ? error.message : error)});
    }
  };
  for (const type of [
    'pointerdown',
    'pointerup',
    'pointercancel',
    'click',
    'keydown',
    'keyup',
    'focusin',
    'focusout',
  ])
    document.addEventListener(
      type,
      (e) => {
        if (!panel?.contains(e.target as Node | null)) return;
        inputEvent(type, {
          trusted: e.isTrusted,
          key: ['Enter', ' ', 'Tab', 'Escape'].includes((e as KeyboardEvent).key)
            ? (e as KeyboardEvent).key
            : null,
          defaultPrevented: e.defaultPrevented,
          target: describe(e.target instanceof Element ? e.target : null),
        });
      },
      true,
    );
  for (const type of ['focus', 'blur', 'pagehide'])
    addEventListener(type, () => {
      if (panel) inputEvent('window-' + type);
    });
  document.addEventListener('visibilitychange', () => {
    if (panel) inputEvent('visibility-change');
  });
  const publish = async (result: string, e: MouseEvent) => {
    if (finished || !e.isTrusted) return;
    finished = true;
    vm()?.stopAll();
    clearInterval(timer);
    const payload = {
      inputDiagnostics: host.__speakerAudit?.inputDiagnostics(),
      caseId,
      label,
      index,
      total,
      outcome: playing && stopped ? 'completed' : 'incomplete',
      listenerResult: result,
      listenerEventTrusted: e.isTrusted,
      listenerReportedAt: new Date().toISOString(),
      startReport,
      playing,
      stopped,
      final: inspect(),
      steps,
      errors,
      userAgent: navigator.userAgent,
    };
    status.textContent = '回答を保存しています…';
    if (typeof host.__recordSpeakerOutcome === 'function') {
      await host.__recordSpeakerOutcome(payload);
      status.textContent = '保存しました。次の条件へ進みます。';
    } else {
      console.log('VIDEO_UNATTENDED_DONE:' + JSON.stringify(payload));
      status.textContent = '報告を送信しました。';
    }
  };
  const makeButton = (text: string, handler: (e: MouseEvent) => unknown) => {
    const b = document.createElement('button');
    b.textContent = text;
    b.type = 'button';
    b.style.cssText =
      'font:inherit;padding:10px 14px;margin:6px 8px 0 0;border:1px solid #45566e;border-radius:6px;background:#fff;color:#172033;cursor:pointer';
    b.addEventListener('click', handler);
    return b;
  };
  const show = () => {
    if (panel || !document.body) return;
    panel = document.createElement('section');
    panel.id = 'speaker-listening-audit';
    panel.style.cssText =
      'position:fixed;z-index:2147483647;left:12px;bottom:12px;max-width:690px;padding:16px;background:#f7fbff;color:#172033;border:3px solid #2766ba;border-radius:10px;box-shadow:0 2px 16px #0005;font:16px/1.5 sans-serif';
    const heading = document.createElement('strong');
    heading.textContent = `Issue #780 スピーカー実聴 ${index}/${total} — ${label}`;
    panel.append(heading);
    const description = document.createElement('div');
    description.textContent =
      'スピーカーで、約4秒の「ピー」という音が聞こえ、停止後に止まるか確認してください。実聴の判定はあなたの回答として記録します。音量・出力先は自動変更しません。';
    panel.append(description);
    status = document.createElement('div');
    status.textContent = 'プロジェクトを準備しています…';
    panel.append(status);
    start = makeButton('再生して確認', begin);
    start.disabled = true;
    panel.append(start);
    heard = makeButton('聞こえた・停止後に止まった', (e) => publish('heard-and-stopped', e));
    heard.disabled = true;
    panel.append(heard);
    silent = makeButton('聞こえない／止まらない', (e) => publish('failed-listening', e));
    silent.disabled = true;
    panel.append(silent);
    unknown = makeButton('この条件は未確認', (e) => publish('not-checked', e));
    panel.append(unknown);
    panel.append(makeButton('確認を終了', (e) => publish('end-session', e)));
    // Keep native button activation while isolating the audit from the host's keyboard shortcuts.
    for (const type of ['keydown', 'keyup'])
      panel.addEventListener(type, (e) => e.stopPropagation());
    const style = document.createElement('style');
    style.textContent = '#speaker-listening-audit button:disabled{opacity:.5;cursor:not-allowed}';
    panel.append(style);
    document.body.append(panel);
    inputEvent('mounted');
  };
  const nativeClick = HTMLElement.prototype.click;
  const timer = setInterval(() => {
    if (finished) return;
    show();
    try {
      const snapshot = inputSnapshot(),
        availability = JSON.stringify([
          snapshot.disabled,
          snapshot.focused,
          snapshot.visibility,
          snapshot.active,
          snapshot.runtimeStatus,
          snapshot.hit,
          snapshot.connected,
        ]);
      if (availability !== lastAvailability) {
        lastAvailability = availability;
        inputEvent('availability-change');
      }
      const modal = document.querySelector('.twextsec-modal');
      if (visible(modal)) {
        if (!selected) {
          const b = [...modal.querySelectorAll('button')].find(
            (b) => (b.textContent ?? '').trim() === 'Without sandbox' && !b.disabled,
          );
          if (b) {
            selected = true;
            step('fixture-permission-select');
            nativeClick.call(b);
          }
          return;
        }
        if (!permitted) {
          const b = [...modal.querySelectorAll('button')].find(
            (b) => (b.textContent ?? '').trim() === 'OK' && !b.disabled,
          );
          if (b) {
            permitted = true;
            step('fixture-permission-confirm');
            nativeClick.call(b);
          }
          return;
        }
        return;
      }
      const state = inspect();
      if (!ready && start && state.status === 'ready') {
        ready = true;
        start.disabled = false;
        status.textContent = '準備できました。「再生して確認」を押してください。';
        step('ready-for-listener');
        inputEvent('ready');
      }
      if (!started) return;
      if (!titleClosed && state.status === 'title') {
        const button = document.querySelector('[data-dsl4-title-action=close]');
        if (visible(button)) {
          titleClosed = true;
          step('close-title');
          nativeClick.call(button);
        }
        return;
      }
      if (
        !playing &&
        state.videos.length === 2 &&
        state.videos.every((v) => !v.paused && v.width === 160 && v.currentTime > 1)
      ) {
        playing = state;
        stopAt = performance.now() + 2800;
        status.textContent = '音を確認してください。約4秒で自動停止します。';
        step('playing-observed');
      }
      if (playing && !stopRequested && performance.now() >= stopAt) {
        stopRequested = true;
        requireVm().stopAll();
      }
      if (
        stopRequested &&
        !stopped &&
        state.videos.length === 2 &&
        state.videos.every((v) => v.paused && v.src === null)
      ) {
        stopped = state;
        status.textContent = '停止しました。聞こえ方と停止後の状態を回答してください。';
        heard.disabled = false;
        silent.disabled = false;
        step('stopped-for-listener');
      }
      if (!playing && state.status === 'error') {
        status.textContent =
          '再生エラーです。「聞こえない／止まらない」または「未確認」で記録してください。';
        silent.disabled = false;
      }
    } catch (e) {
      errors.push(String(e instanceof Error ? e.stack : e));
      status.textContent = '準備または再生でエラーが発生しました。未確認として記録できます。';
    }
  }, 100);
}
