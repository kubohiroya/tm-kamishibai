const locales = Object.freeze({
  en: Object.freeze({
    fallback:
      'Temporary browser storage could not be established. This run will continue directly from the packaged assets. Performance and memory use may differ.',
    quota:
      'Temporary browser storage is full. Clear site data, reduce embedded assets, or rebuild for direct ZIP/Electron delivery. Reloading alone may not recover.',
    blocked:
      'Temporary browser storage is blocked by another tab or version change. Close other copies of this application, then reload.',
    corrupt:
      "This run's temporary asset storage is missing or damaged. Discard this run and reload the application; assets will not be extracted again during the failed run.",
    source:
      'The packaged asset metadata or content failed integrity checks. Rebuild the SB3 from the authoritative source assets.',
    unavailable:
      'Temporary browser storage is unavailable. Check browser storage settings, or use direct mode, normal ZIP, or Electron delivery.',
  }),
  ja: Object.freeze({
    fallback:
      '一時ブラウザストレージを確立できなかったため、この実行はパッケージ内アセットを直接読み込んで続行します。性能やメモリ使用量が変わることがあります。',
    quota:
      '一時ブラウザストレージの容量が不足しています。サイトデータの整理、埋め込みアセットの削減、または direct mode・通常ZIP・Electron向けの再ビルドを行ってください。再読み込みだけでは回復しない場合があります。',
    blocked:
      '別タブまたはバージョン変更により一時ブラウザストレージがブロックされています。同じアプリの他のタブを閉じてから再読み込みしてください。',
    corrupt:
      'この実行の一時アセットストレージが欠落または破損しています。この実行を破棄してアプリを再読み込みしてください。失敗した実行中の自動再抽出は行いません。',
    source:
      'パッケージ内アセットのメタデータまたは内容が整合性検証に失敗しました。正本アセットからSB3を再ビルドしてください。',
    unavailable:
      '一時ブラウザストレージを利用できません。ブラウザのストレージ設定を確認するか、direct mode・通常ZIP・Electronを利用してください。',
  }),
});

/** @param {unknown} value @returns {value is Record<string, any>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} failure */
function failureCode(failure) {
  if (!isRecord(failure)) return '';
  if (typeof failure.code === 'string') return failure.code;
  return typeof failure.failureCode === 'string' ? failure.failureCode : '';
}

/** @param {unknown} failure @param {Set<unknown>} [seen] @returns {string[]} */
function failureCodes(failure, seen = new Set()) {
  if (!isRecord(failure) || seen.has(failure) || seen.size >= 8) return [];
  seen.add(failure);
  const codes = [];
  const code = failureCode(failure);
  if (code) codes.push(code);
  if (Array.isArray(failure.errors)) {
    for (const nested of failure.errors) codes.push(...failureCodes(nested, seen));
  }
  codes.push(...failureCodes(failure.cause, seen));
  return [...new Set(codes)];
}

/** @param {string} code */
function recoveryKind(code) {
  if (/QUOTA/u.test(code)) return 'quota';
  if (/BLOCKED|VERSION|SESSION_CONFLICT/u.test(code)) return 'blocked';
  if (/SOURCE_|K4-ASSET-ENTRY-(?:INTEGRITY|SIZE|MANIFEST|DESCRIPTOR)/u.test(code)) {
    return 'source';
  }
  if (/NOT_FOUND|CORRUPT|INTEGRITY_MISMATCH|CONNECTION_CLOSED|TRANSACTION|ABORTED/u.test(code)) {
    return 'corrupt';
  }
  return 'unavailable';
}

/** @param {unknown} value @returns {'en' | 'ja'} */
function locale(value) {
  return value === 'ja' ? 'ja' : 'en';
}

/** @param {unknown} warning @param {'en' | 'ja'} [requestedLocale] */
export function createDsl4SessionBackingWarningDiagnostic(warning, requestedLocale = 'en') {
  const code = failureCode(warning) || 'ASSET_SESSION_BINARY_DIRECT_FALLBACK';
  const causeCode =
    isRecord(warning) && typeof warning.causeCode === 'string' ? warning.causeCode : '';
  return Object.freeze({
    code: causeCode ? `${code} (${causeCode})` : code,
    message: locales[locale(requestedLocale)].fallback,
  });
}

/** @param {unknown} failure @param {'en' | 'ja'} [requestedLocale] */
export function createDsl4SessionBackingFatalDiagnostic(failure, requestedLocale = 'en') {
  const codes = failureCodes(failure);
  if (codes.length === 0) codes.push('ASSET_SESSION_BINARY_READ_FAILED');
  const code = codes.join(' (') + ')'.repeat(Math.max(0, codes.length - 1));
  return Object.freeze({
    code,
    message: locales[locale(requestedLocale)][recoveryKind(codes.join(' '))],
  });
}
