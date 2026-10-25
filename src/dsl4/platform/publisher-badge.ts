/** The DOM surface the badge builds; narrow on purpose, like the runtime indicators. */
interface BadgeElement {
  textContent: string | null;
  hidden?: boolean;
  style: Record<string, string> & {cssText?: string};
  setAttribute(name: string, value: string): void;
  appendChild(child: BadgeElement): unknown;
  remove(): void;
}

interface BadgeDocument {
  createElement(tag: string): BadgeElement;
}

const labels = Object.freeze({
  en: 'Signed by',
  ja: '署名者',
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Show who signed the open story: the publisher key's full SHA-256 fingerprint.
 *
 * The fingerprint is the only thing that tells a viewer who made a signed story, so it is shown
 * whole and selectable, to compare with the one the publisher announces. An unsigned story shows
 * nothing. The badge sits over the stage's lower edge on the title and menu screens.
 */
export function createDsl4PublisherBadge(options: {document: unknown; mount: unknown}) {
  if (!isRecord(options)) throw new TypeError('Publisher badge options must be an object');
  const document = options.document as BadgeDocument;
  if (!isRecord(document) || typeof document.createElement !== 'function')
    throw new TypeError('document must provide createElement');
  const mount = options.mount as BadgeElement;
  if (!isRecord(mount) || typeof mount.appendChild !== 'function')
    throw new TypeError('mount must be a DOM element');
  const badge = document.createElement('div');
  badge.setAttribute('data-dsl4-publisher', 'true');
  badge.setAttribute('role', 'note');
  badge.style.cssText =
    'position:absolute;left:8px;right:8px;bottom:6px;z-index:2147483646;padding:4px 8px;border-radius:6px;background:rgba(255,255,255,.88);color:#1b1b1b;font:11px/1.35 monospace;overflow-wrap:anywhere;user-select:text;pointer-events:auto;';
  badge.hidden = true;
  mount.appendChild(badge);
  return Object.freeze({
    show(publisher: Readonly<{fingerprint?: unknown}> | null | undefined, locale: 'en' | 'ja') {
      const fingerprint = typeof publisher?.fingerprint === 'string' ? publisher.fingerprint : null;
      badge.textContent = fingerprint === null ? '' : `${labels[locale]}: ${fingerprint}`;
      badge.hidden = fingerprint === null;
    },
    hide() {
      badge.hidden = true;
    },
    dispose() {
      badge.remove();
    },
  });
}
