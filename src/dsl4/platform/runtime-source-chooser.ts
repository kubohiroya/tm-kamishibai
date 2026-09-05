function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireElement(value: unknown, name: string) {
  if (!isRecord(value) || typeof value.appendChild !== 'function') {
    throw new TypeError(`${name} must be a DOM element`);
  }
  return value as Record<string, any>;
}

/**
 * Let an author choose the watched source shape while preserving the browser click activation
 * needed by File System Access pickers.
 */
export function createDsl4RuntimeSourceChooser(options: {
  document: unknown;
  mount: unknown;
  locales: Readonly<
    Record<'en' | 'ja', Readonly<Record<'openFile' | 'openProject' | 'cancel', string>>>
  >;
  onFile: () => unknown | Promise<unknown>;
  onProject: () => unknown | Promise<unknown>;
  onCancel: () => unknown | Promise<unknown>;
  onError?: (error: unknown) => unknown;
}) {
  if (!isRecord(options)) throw new TypeError('runtime source chooser options are required');
  const document = isRecord(options.document) ? (options.document as Record<string, any>) : null;
  if (!document || typeof document.createElement !== 'function') {
    throw new TypeError('document must provide createElement');
  }
  const mount = requireElement(options.mount, 'mount');
  for (const callback of ['onFile', 'onProject', 'onCancel'] as const) {
    if (typeof options[callback] !== 'function') {
      throw new TypeError(`${callback} must be a function`);
    }
  }
  for (const locale of ['en', 'ja'] as const) {
    for (const key of ['openFile', 'openProject', 'cancel'] as const) {
      if (typeof options.locales?.[locale]?.[key] !== 'string') {
        throw new TypeError(`locales.${locale}.${key} must be a string`);
      }
    }
  }

  const root = requireElement(document.createElement('section'), 'source chooser');
  const panel = requireElement(document.createElement('div'), 'source chooser panel');
  root.setAttribute('data-dsl4-source-chooser', 'true');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.style.cssText =
    'position:absolute;inset:0;z-index:2147483620;display:none;align-items:center;justify-content:center;padding:5cqw;box-sizing:border-box;background:rgba(0,20,18,.72);font-family:sans-serif;cursor:auto;pointer-events:auto;container-type:inline-size;';
  root.style.position = 'absolute';
  root.style.display = 'none';
  panel.style.cssText =
    'display:grid;width:min(75cqw,560px);gap:2.4cqw;padding:4cqw;box-sizing:border-box;border:.4cqw solid #005f50;border-radius:2.5cqw;background:#f4fffc;box-shadow:0 1.2cqw 3cqw rgba(0,0,0,.35);';

  const buttons: Map<
    'file' | 'project' | 'cancel',
    {button: Record<string, any>; onClick: () => void}
  > = new Map();
  const definitions = [
    ['file', 'openFile', options.onFile],
    ['project', 'openProject', options.onProject],
    ['cancel', 'cancel', options.onCancel],
  ] as const;
  let disposed = false;
  let locale: 'en' | 'ja' = 'en';

  function report(error: unknown) {
    try {
      options.onError?.(error);
    } catch {
      // Chooser error observers cannot change application state.
    }
  }

  for (const [choice, , callback] of definitions) {
    const button = requireElement(document.createElement('button'), `${choice} button`);
    button.type = 'button';
    button.setAttribute('data-dsl4-source-choice', choice);
    button.style.cssText =
      choice === 'cancel'
        ? 'min-height:7cqw;padding:1.3cqw 2cqw;border:.3cqw solid #52605d;border-radius:1.3cqw;background:#fff;color:#263330;font:inherit;font-size:3cqw;cursor:pointer;'
        : 'min-height:9cqw;padding:1.6cqw 2cqw;border:.3cqw solid #005f50;border-radius:1.5cqw;background:#007d66;color:#fff;font:inherit;font-size:3.4cqw;font-weight:700;cursor:pointer;';
    button.style.cursor = 'pointer';
    const onClick = () => {
      try {
        Promise.resolve(callback()).catch(report);
      } catch (error) {
        report(error);
      }
    };
    button.addEventListener('click', onClick);
    panel.appendChild(button);
    buttons.set(choice, {button, onClick});
  }
  root.appendChild(panel);
  mount.appendChild(root);

  function render() {
    for (const [choice, labelKey] of definitions) {
      const button = (buttons.get(choice) as {button: Record<string, any>}).button;
      button.textContent = options.locales[locale][labelKey];
      button.setAttribute('aria-label', options.locales[locale][labelKey]);
    }
  }

  return Object.freeze({
    element: root,
    show(
      nextLocale: 'en' | 'ja',
      availability: {fileEnabled?: boolean; projectEnabled?: boolean} = {},
    ) {
      if (disposed) throw new TypeError('runtime source chooser is disposed');
      locale = nextLocale === 'ja' ? 'ja' : 'en';
      const fileEnabled = availability.fileEnabled ?? true;
      const projectEnabled = availability.projectEnabled ?? true;
      if (typeof fileEnabled !== 'boolean' || typeof projectEnabled !== 'boolean') {
        throw new TypeError('source chooser availability must be boolean');
      }
      for (const [choice, enabled] of [
        ['file', fileEnabled],
        ['project', projectEnabled],
      ] as const) {
        const button = (buttons.get(choice) as {button: Record<string, any>}).button;
        button.disabled = !enabled;
        button.setAttribute('aria-disabled', String(!enabled));
        button.style.cursor = enabled ? 'pointer' : 'not-allowed';
        button.style.opacity = enabled ? '1' : '0.42';
      }
      render();
      root.style.display = 'flex';
    },
    hide() {
      if (!disposed) root.style.display = 'none';
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const {button, onClick} of buttons.values()) {
        button.removeEventListener('click', onClick);
      }
      buttons.clear();
      root.remove?.();
    },
  });
}
