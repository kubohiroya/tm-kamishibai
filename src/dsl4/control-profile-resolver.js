import {deepFreeze, sourceOriginForStoryPath} from './story-document.js';

const zeroRange = deepFreeze({
  start: {line: 1, column: 1, offset: 0},
  end: {line: 1, column: 1, offset: 0},
});

/**
 * @param {Readonly<Record<string, unknown>>} storyDocument
 * @param {string} code
 * @param {string} message
 */
function diagnostic(storyDocument, code, message) {
  const origin = sourceOriginForStoryPath(storyDocument, '/controls');
  return deepFreeze({
    version: 1,
    code,
    severity: 'error',
    message,
    sourceId: origin.sourceId,
    range: origin.range ?? zeroRange,
    path: '$.controls.keymaps',
    related: [],
  });
}

/**
 * @param {Readonly<Record<string, unknown>>} storyDocument
 * @param {string} code
 * @param {string} message
 */
function failure(storyDocument, code, message) {
  return deepFreeze({ok: false, diagnostics: [diagnostic(storyDocument, code, message)]});
}

/**
 * Resolve exactly one complete keymap profile without inheritance or fallback.
 *
 * @param {Readonly<Record<string, unknown>>} storyDocument
 * @param {string | undefined | null} controlProfile
 * @param {{historyNavigationAvailable?: boolean}} [options]
 */
export function resolveDsl4ControlProfile(
  storyDocument,
  controlProfile,
  {historyNavigationAvailable = false} = {},
) {
  if (storyDocument.kind !== 'StoryDocument' || storyDocument.version !== '4.0') {
    throw new TypeError('DSL 4.0 control profile resolver requires a StoryDocument version 4.0');
  }
  if (typeof historyNavigationAvailable !== 'boolean') {
    throw new TypeError('historyNavigationAvailable must be a boolean');
  }
  if (typeof controlProfile !== 'string' || controlProfile.length === 0) {
    return failure(
      storyDocument,
      'K4-KEYMAP-PROFILE-REQUIRED',
      'A controlProfile must be selected explicitly',
    );
  }

  const controls = /** @type {Record<string, unknown> | null} */ (storyDocument.controls);
  const keymaps = /** @type {Record<string, Record<string, string>>} */ (
    /** @type {Record<string, unknown> | undefined} */ (controls?.keymaps) ?? {}
  );
  if (!Object.hasOwn(keymaps, controlProfile)) {
    return failure(
      storyDocument,
      'K4-KEYMAP-PROFILE-UNKNOWN',
      `Control profile ${controlProfile} is not defined`,
    );
  }
  const selected = keymaps[controlProfile];

  const entries = Object.entries(selected).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const keymap = deepFreeze(Object.fromEntries(entries));
  const historyEnabled = entries.some(([, command]) => command.startsWith('history.'));
  if (historyEnabled && !historyNavigationAvailable) {
    return failure(
      storyDocument,
      'K4-KEYMAP-HISTORY-UNAVAILABLE',
      `Control profile ${controlProfile} requires unavailable history navigation`,
    );
  }

  return deepFreeze({
    ok: true,
    profile: controlProfile,
    keymap,
    canonicalKeymap: JSON.stringify(keymap),
    historyEnabled,
    diagnostics: [],
  });
}
