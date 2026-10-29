import {resolveAppShellLocale} from '@kubohiroya/turbowarp-app-shell';
import {diagnosticText} from '../runtime-error-context.js';
import {
  createRuntimeErrorPresentation,
  formatRuntimeErrorReport,
} from './runtime-error-presentation.js';

interface IndicatorEvent {
  key?: string;
  shiftKey?: boolean;
  preventDefault?(): void;
  stopPropagation?(): void;
}
interface IndicatorElement {
  id?: string;
  textContent: string | null;
  hidden?: boolean;
  type?: string;
  disabled?: boolean;
  open?: boolean;
  readOnly?: boolean;
  value?: string;
  tabIndex?: number;
  style: Record<string, string> & {cssText?: string};
  setAttribute(name: string, value: string): void;
  appendChild(child: IndicatorElement): unknown;
  replaceChildren(...children: IndicatorElement[]): unknown;
  focus?(): void;
  select?(): void;
  addEventListener(type: string, listener: (event: IndicatorEvent) => unknown): unknown;
  removeEventListener(type: string, listener: (event: IndicatorEvent) => unknown): unknown;
  remove(): void;
  contains?(element: IndicatorElement | null): boolean;
}
interface IndicatorDocument {
  createElement(tag: string): IndicatorElement;
  readonly body?: IndicatorElement;
  readonly activeElement?: IndicatorElement | null;
}
const labels = {
  ja: {
    where: '確認する場所',
    recovery: '対処方法',
    technical: '技術的な詳細',
    code: 'エラーコード',
    source: '台本／素材ファイル',
    location: '行・列',
    path: '内部の位置',
    blockName: '該当ブロック',
    targetName: 'ステージ／スプライト',
    originalMessage: '元のエラー',
    phase: '失敗した段階',
    version: 'アプリのバージョン',
    causes: '原因例外',
    menu: 'メニューに戻る',
    close: '閉じる',
    locate: '該当ブロックを表示',
    sourceAction: '該当行を開く',
    copy: '診断情報をコピー',
    copied: '診断情報をコピーしました。',
    copyFailed: '自動コピーできませんでした。下の診断情報を選択してコピーしてください。',
    locateFailed:
      '編集箇所を表示できませんでした。コードタブまたは台本を開き、対象が残っているか確認してください。',
    returnFailed:
      'メニューに戻れませんでした。診断情報をコピーしてから、閉じる操作で編集画面へ戻れます。',
    excerpt: '該当箇所の抜粋',
    generated: 'この行番号は生成台本の位置です。修正は元のブロックで行ってください。',
    stopped: '閉じても再生は再開しません。',
    report: 'コピー用の診断情報',
  },
  en: {
    where: 'Where to check',
    recovery: 'What to do',
    technical: 'Technical details',
    code: 'Error code',
    source: 'Script / asset file',
    location: 'Line / column',
    path: 'Internal location',
    blockName: 'Block',
    targetName: 'Stage / sprite',
    originalMessage: 'Original error',
    phase: 'Phase',
    version: 'App version',
    causes: 'Cause chain',
    menu: 'Back to menu',
    close: 'Close',
    locate: 'Show block',
    sourceAction: 'Open source line',
    copy: 'Copy diagnostics',
    copied: 'Diagnostics copied.',
    copyFailed: 'Automatic copying failed. Select and copy the diagnostic text below.',
    locateFailed:
      'Could not open the location. Open the Code tab or script and check that it still exists.',
    returnFailed:
      'Could not return to the menu. Copy the diagnostics, then close this dialog to return to editing.',
    excerpt: 'Source excerpt',
    generated: 'These line numbers refer to generated source. Edit the original blocks.',
    stopped: 'Closing this dialog will not resume playback.',
    report: 'Diagnostic text to copy',
  },
};
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The default fatal-error UI for authoring, preview and playback. */
export function createDsl4RuntimeErrorIndicator(options: {
  document: unknown;
  mount: unknown;
  locales: unknown;
  initialLocale?: 'en' | 'ja';
  runtimeVersion?: string;
  onReturnToMenu?: () => unknown | Promise<unknown>;
  onLocateBlock?: () => boolean | Promise<boolean>;
  onLocateSource?: (diagnostic: Readonly<Record<string, unknown>>) => boolean | Promise<boolean>;
  writeClipboard?: (text: string) => unknown | Promise<unknown>;
}) {
  if (
    !record(options) ||
    !record(options.document) ||
    typeof options.document.createElement !== 'function'
  )
    throw new TypeError('document must provide the DOM document contract');
  if (!record(options.mount) || typeof options.mount.appendChild !== 'function')
    throw new TypeError('mount must be a DOM element');
  if (
    !record(options.locales) ||
    !['ja', 'en'].every((key) => {
      const localized = options.locales as Record<string, unknown>;
      return (
        record(localized[key]) &&
        typeof localized[key].title === 'string' &&
        localized[key].title.length > 0
      );
    })
  )
    throw new TypeError('locales must provide en and ja titles');
  if (options.initialLocale !== undefined && !['en', 'ja'].includes(options.initialLocale))
    throw new TypeError('initialLocale must be en or ja');
  for (const key of [
    'onReturnToMenu',
    'onLocateBlock',
    'onLocateSource',
    'writeClipboard',
  ] as const)
    if (options[key] !== undefined && typeof options[key] !== 'function')
      throw new TypeError(`${key} must be a function`);
  const document = options.document as unknown as IndicatorDocument;
  const mount = options.mount as unknown as IndicatorElement;
  const locale = options.initialLocale ?? (resolveAppShellLocale() as 'en' | 'ja');
  const text = labels[locale];
  const element = (tag: string, hook: string, css = '') => {
    const node = document.createElement(tag);
    node.setAttribute(`data-dsl4-runtime-error-${hook}`, 'true');
    node.style.cssText = css;
    return node;
  };
  const root = element('section', 'root');
  root.setAttribute('data-dsl4-runtime-error', 'true');
  root.setAttribute('role', 'alertdialog');
  root.setAttribute('aria-live', 'assertive');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-labelledby', 'dsl4-runtime-error-title');
  root.setAttribute('aria-describedby', 'dsl4-runtime-error-message');
  root.style.cssText =
    'position:absolute;inset:0;z-index:2147483647;display:none;align-items:center;justify-content:center;padding:8px;box-sizing:border-box;background:rgba(15,23,42,.7);font:14px/1.5 sans-serif;cursor:auto;color:#172033;';
  root.style.position = 'absolute';
  root.style.display = 'none';
  root.style.cursor = 'auto';
  const previousPosition = mount.style.position;
  if (mount !== document.body && !previousPosition) mount.style.position = 'relative';
  const panel = element(
    'div',
    'panel',
    'display:flex;flex-direction:column;min-height:0;width:min(680px,100%);max-height:100%;box-sizing:border-box;padding:14px;background:#fff;border:1px solid #cbd5e1;border-top:4px solid #b42318;border-radius:10px;box-shadow:0 8px 32px #0005;',
  );
  const heading = element(
    'h1',
    'title',
    'flex:none;margin:0 0 8px;font-size:20px;line-height:1.35;overflow-wrap:anywhere;',
  );
  heading.id = 'dsl4-runtime-error-title';
  const content = element(
    'div',
    'content',
    'min-height:0;overflow:auto;overscroll-behavior:contain;overflow-wrap:anywhere;',
  );
  const message = element('p', 'message', 'margin:0;white-space:pre-wrap;overflow-wrap:anywhere;');
  message.id = 'dsl4-runtime-error-message';
  const impact = element('p', 'impact', 'margin:6px 0 0;color:#526071;font-size:12px;');
  const whereHeading = element('h2', 'where-label', 'margin:14px 0 4px;font-size:14px;');
  whereHeading.textContent = text.where;
  const where = element('p', 'where', 'margin:0;white-space:pre-wrap;');
  const recoveryHeading = element('h2', 'recovery-label', 'margin:14px 0 4px;font-size:14px;');
  recoveryHeading.textContent = text.recovery;
  const recovery = element('p', 'recovery', 'margin:0;white-space:pre-wrap;');
  const excerpt = element(
    'pre',
    'excerpt',
    'display:none;white-space:pre-wrap;overflow-wrap:anywhere;background:#f1f5f9;padding:8px;border-radius:4px;font:12px/1.5 monospace;',
  );
  excerpt.setAttribute('aria-label', text.excerpt);
  const generated = element('p', 'generated', 'font-size:12px;color:#526071;');
  generated.textContent = text.generated;
  const technical = element('details', 'technical', 'margin-top:14px;font-size:12px;');
  const summary = element(
    'summary',
    'technical-toggle',
    'cursor:pointer;padding:5px 0;font-weight:700;',
  );
  summary.textContent = text.technical;
  const details = element(
    'dl',
    'details',
    'display:grid;grid-template-columns:minmax(0,1fr);gap:3px;margin:6px 0;',
  );
  const rows = Object.fromEntries(
    (
      [
        'code',
        'source',
        'location',
        'path',
        'blockName',
        'targetName',
        'originalMessage',
        'phase',
        'version',
        'causes',
      ] as const
    ).map((key) => {
      const term = document.createElement('dt');
      term.textContent = text[key];
      term.style.cssText = 'margin:8px 0 0;font-weight:700;';
      const value = element(
        'dd',
        key,
        'margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font-family:monospace;',
      );
      details.appendChild(term);
      details.appendChild(value);
      return [key, {term, value}];
    }),
  );
  const report = element(
    'textarea',
    'report',
    'width:100%;box-sizing:border-box;min-height:100px;font:12px/1.5 monospace;',
  );
  report.setAttribute('aria-label', text.report);
  report.readOnly = true;
  report.hidden = true;
  const status = element('p', 'locate-status', 'margin:8px 0 0;font-size:12px;');
  status.setAttribute('role', 'status');
  const actions = element(
    'div',
    'actions',
    'display:flex;flex:none;justify-content:flex-end;flex-wrap:wrap;gap:6px;padding-top:12px;',
  );
  const button = (action: string, label: string) => {
    const node = document.createElement('button');
    node.type = 'button';
    node.textContent = label;
    node.setAttribute('data-dsl4-runtime-error-action', action);
    node.style.cssText =
      'min-height:36px;max-width:100%;padding:6px 10px;border:1px solid #94a3b8;border-radius:5px;background:#fff;color:#172033;font:600 13px/1.4 sans-serif;cursor:pointer;';
    actions.appendChild(node);
    return node;
  };
  const locate = button('block', text.locate);
  const source = button('source', text.sourceAction);
  const copy = button('copy', text.copy);
  const close = button('close', text.close);
  const back = button('menu', text.menu);
  back.style.cssText = `${back.style.cssText}background:#9d251b;border-color:#9d251b;color:white;`;
  technical.appendChild(summary);
  technical.appendChild(details);
  for (const child of [
    message,
    impact,
    whereHeading,
    where,
    recoveryHeading,
    recovery,
    excerpt,
    generated,
    technical,
    report,
    status,
  ])
    content.appendChild(child);
  panel.appendChild(heading);
  panel.appendChild(content);
  panel.appendChild(actions);
  root.appendChild(panel);
  mount.appendChild(root);
  let disposed = false;
  let presentation = 0;
  let current: Readonly<Record<string, unknown>> = {};
  let currentReport = '';
  let previousFocus: IndicatorElement | null | undefined;
  let returnFailed = false;
  const ownsFocus = () => !root.contains || root.contains(document.activeElement ?? null);
  const restoreFocus = (expected: boolean) => {
    try {
      // A successful host action may already have focused its destination.
      if (expected) previousFocus?.focus?.();
    } catch {
      /* The previous editor may have been disposed. */
    }
  };
  const hide = () => {
    const expected = ownsFocus();
    presentation += 1;
    if (!disposed) {
      root.style.display = 'none';
      restoreFocus(expected);
    }
  };
  const renderRow = (key: string, value: unknown) => {
    const row = rows[key]!;
    const rendered = diagnosticText(value);
    row.value.textContent = rendered;
    row.term.hidden = !rendered;
    row.value.hidden = !rendered;
    row.value.style.display = rendered ? 'block' : 'none';
  };
  const onClose = () => hide();
  const onBack = async () => {
    if (disposed || back.disabled) return;
    const expected = presentation;
    back.disabled = true;
    try {
      await options.onReturnToMenu?.();
      if (!disposed && expected === presentation) hide();
    } catch {
      if (!disposed && expected === presentation) {
        status.textContent = text.returnFailed;
        returnFailed = true;
        close.hidden = false;
      }
    } finally {
      if (!disposed && expected === presentation) back.disabled = false;
    }
  };
  const navigate = async (kind: 'block' | 'source') => {
    const control = kind === 'block' ? locate : source;
    if (disposed || control.disabled) return;
    const expected = presentation;
    control.disabled = true;
    let found = false;
    try {
      found =
        (await (kind === 'block'
          ? options.onLocateBlock?.()
          : options.onLocateSource?.(current))) === true;
    } catch {
      /* Keep the original diagnostic visible. */
    }
    if (disposed || expected !== presentation) return;
    control.disabled = false;
    if (found) {
      presentation += 1;
      root.style.display = 'none';
    } else status.textContent = text.locateFailed;
  };
  const onLocate = () => navigate('block');
  const onSource = () => navigate('source');
  const onCopy = async () => {
    if (disposed || copy.disabled) return;
    const expected = presentation;
    const reportText = currentReport;
    copy.disabled = true;
    try {
      const write =
        options.writeClipboard ??
        ((value: string) => {
          if (!globalThis.navigator?.clipboard?.writeText) throw new Error('Clipboard unavailable');
          return globalThis.navigator.clipboard.writeText(value);
        });
      await write(reportText);
      if (!disposed && expected === presentation) status.textContent = text.copied;
    } catch {
      if (!disposed && expected === presentation) {
        report.value = reportText;
        report.hidden = false;
        status.textContent = text.copyFailed;
        report.focus?.();
        report.select?.();
      }
    } finally {
      if (!disposed && expected === presentation) copy.disabled = false;
    }
  };
  const onKey = (event: IndicatorEvent) => {
    if (root.style.display === 'none') return;
    if (event.key === 'Escape') {
      event.preventDefault?.();
      event.stopPropagation?.();
      hide();
    }
    if (event.key === 'Tab') {
      const controls = [
        summary,
        ...(report.hidden ? [] : [report]),
        locate,
        source,
        copy,
        close,
        back,
      ].filter((node) => !node.hidden && !node.disabled);
      const index = controls.indexOf(document.activeElement!);
      if (
        index < 0 ||
        (!event.shiftKey && index === controls.length - 1) ||
        (event.shiftKey && index === 0)
      ) {
        event.preventDefault?.();
        controls[event.shiftKey ? controls.length - 1 : 0]?.focus?.();
      }
    }
  };
  const listeners: [IndicatorElement, string, (event: IndicatorEvent) => unknown][] = [
    [close, 'click', onClose],
    [back, 'click', onBack],
    [locate, 'click', onLocate],
    [source, 'click', onSource],
    [copy, 'click', onCopy],
    [root, 'keydown', onKey],
  ];
  for (const [node, type, listener] of listeners) node.addEventListener(type, listener);
  return Object.freeze({
    element: root,
    show(
      diagnostic: Record<string, unknown>,
      showOptions: {returnToMenu?: boolean; locateBlock?: boolean; locateSource?: boolean} = {},
    ) {
      if (disposed) throw new TypeError('Runtime error indicator is disposed');
      if (!record(diagnostic) || !record(showOptions))
        throw new TypeError('diagnostic and showOptions must be objects');
      for (const key of ['returnToMenu', 'locateBlock', 'locateSource'] as const)
        if (showOptions[key] !== undefined && typeof showOptions[key] !== 'boolean')
          throw new TypeError(`${key} must be a boolean`);
      if (root.style.display === 'none') previousFocus = document.activeElement;
      presentation += 1;
      current = diagnostic;
      returnFailed = false;
      const view = createRuntimeErrorPresentation(diagnostic, locale);
      heading.textContent = view.title;
      message.textContent = view.explanation;
      impact.textContent = `${view.impact} ${text.stopped}`;
      where.textContent = view.place;
      recovery.textContent = view.recovery;
      generated.hidden = !view.generated;
      const range = record(diagnostic.range) ? diagnostic.range : {};
      const start = record(range.start) ? range.start : {};
      renderRow('code', diagnostic.code);
      renderRow('source', diagnostic.displayName ?? diagnostic.sourceId);
      renderRow(
        'location',
        start.line ? `${start.line}${start.column ? `:${start.column}` : ''}` : '',
      );
      renderRow('path', diagnostic.path ?? diagnostic.storyPath);
      renderRow('blockName', diagnostic.blockName);
      renderRow('targetName', diagnostic.targetName);
      renderRow('originalMessage', diagnostic.message);
      renderRow('phase', diagnostic.phase);
      renderRow('version', options.runtimeVersion);
      currentReport = formatRuntimeErrorReport(diagnostic, locale, options.runtimeVersion);
      renderRow(
        'causes',
        currentReport
          .split('\n')
          .filter((line) => /^(?:Cause|Cleanup) \d+:/u.test(line))
          .join('\n'),
      );
      report.hidden = true;
      report.value = '';
      technical.open = false;
      const excerptText = diagnosticText(diagnostic.excerpt);
      excerpt.replaceChildren();
      excerpt.textContent = excerptText;
      if (excerptText && !view.generated) {
        // Keep the exact source text and mark the diagnosed line without interpreting it as HTML.
        excerpt.textContent = '';
        const first = Number.isSafeInteger(diagnostic.excerptStartLine)
          ? Number(diagnostic.excerptStartLine)
          : null;
        excerptText.split('\n').forEach((line, index) => {
          const number = first === null ? null : first + index;
          const span = document.createElement(
            number === null || number === start.line ? 'mark' : 'span',
          );
          span.textContent = `${number === null ? '' : `${number} | `}${line}${index < excerptText.split('\n').length - 1 ? '\n' : ''}`;
          excerpt.appendChild(span);
        });
      }
      excerpt.style.display = excerptText && !view.generated ? 'block' : 'none';
      locate.hidden = !(showOptions.locateBlock === true && options.onLocateBlock);
      source.hidden = !(
        showOptions.locateSource === true &&
        options.onLocateSource &&
        !view.generated
      );
      back.hidden = !(showOptions.returnToMenu !== false && options.onReturnToMenu);
      close.hidden = !back.hidden;
      for (const node of [locate, source, back, copy]) node.disabled = false;
      status.textContent = '';
      root.style.display = 'flex';
      (!locate.hidden ? locate : !source.hidden ? source : !back.hidden ? back : close).focus?.();
    },
    hide,
    dispose() {
      if (disposed) return;
      const wasVisible = root.style.display !== 'none';
      const expected = ownsFocus();
      disposed = true;
      presentation += 1;
      for (const [node, type, listener] of listeners) node.removeEventListener(type, listener);
      root.remove();
      if (mount !== document.body && !previousPosition)
        mount.style.position = previousPosition ?? '';
      if (wasVisible && !returnFailed) restoreFocus(expected);
    },
  });
}
