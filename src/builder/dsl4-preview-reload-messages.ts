/** User-facing reload text; machine states and stored preferences stay language-neutral. */
export function previewReloadMessages(locale: 'ja' | 'en') {
  const ja = locale === 'ja';
  return {
    title: ja ? '自動リロードの設定' : 'Automatic reload settings',
    help: ja
      ? '台本ファイルや関連素材の更新を検知して、プレビューに反映します。通常の閲覧では操作は不要です。'
      : 'Detect updates to story files and related assets and apply them to the preview. Ordinary playback needs no action here.',
    waiting: ja
      ? '台本ファイルまたはプロジェクトを開くと、台本ファイルや関連素材の更新検知を開始します。'
      : 'Open a story file or project to detect updates to story files and related assets.',
    close: ja ? '閉じる' : 'Close',
    closeLabel: ja ? '未確定の変更を破棄して閉じる' : 'Close and discard pending changes',
    restartTitle: ja ? '変更後の再開位置' : 'Restart position after changes',
    latestEmpty: ja ? 'まだ更新していません' : 'No changes have been applied yet',
    latest: (time: string) => (ja ? `前回の更新: ${time}` : `Last update: ${time}`),
    preference: (position: string) =>
      ja ? `次回の再開位置: ${position}` : `Next restart: ${position}`,
    previous: (position: string) =>
      ja ? `前回の再開位置: ${position}` : `Previous restart: ${position}`,
    previousEmpty: ja ? '前回の再開位置: まだありません' : 'Previous restart: none',
    fallback: ja ? '安全に再開できる位置へ変更しました' : 'A safe restart position was used',
    stale: ja
      ? '新しい変更が届きました。再開位置を選び直してください。'
      : 'New changes arrived. Choose the restart position again.',
    positions: ja
      ? {story: '作品の最初から', scene: '現在の場面の最初から', action: '現在の処理から'}
      : {
          story: 'Start of the story',
          scene: 'Start of the current scene',
          action: 'Current action',
        },
    scopes: ja
      ? {
          'reload-once': '今回だけこの位置から再開',
          'reload-and-save': '再開して、次回以降にも適用',
          'save-next': '次回以降に適用',
          cancel: 'キャンセル',
        }
      : {
          'reload-once': 'Restart here once',
          'reload-and-save': 'Restart and use next time',
          'save-next': 'Use next time',
          cancel: 'Cancel',
        },
    anchorTitle: ja ? 'ボタンの表示位置' : 'Status button position',
    anchors: ja
      ? {
          'top-left': '左上',
          'top-center': '上中央',
          'top-right': '右上',
          'right-center': '右中央',
          'bottom-right': '右下',
          'bottom-center': '下中央',
          'bottom-left': '左下',
          'left-center': '左中央',
        }
      : {
          'top-left': 'Top left',
          'top-center': 'Top center',
          'top-right': 'Top right',
          'right-center': 'Right center',
          'bottom-right': 'Bottom right',
          'bottom-center': 'Bottom center',
          'bottom-left': 'Bottom left',
          'left-center': 'Left center',
        },
    anchorSummary: (preferred: string, actual: string) =>
      ja
        ? preferred === actual
          ? `現在の位置: ${actual}`
          : `希望: ${preferred} ／ 表示: ${actual}（ほかの操作部品を避けています）`
        : preferred === actual
          ? `Position: ${actual}`
          : `Preferred: ${preferred} / shown: ${actual} (avoiding other controls)`,
    resetAnchor: ja ? '既定の位置に戻す' : 'Reset position',
    immediate: ja
      ? 'ボタンの位置とデバッグ実行方法は、選ぶとすぐに反映されます。'
      : 'Button position and debug mode take effect immediately.',
    toolbarPosition: ja
      ? '再生画面の共通操作ボタンに表示しています。'
      : 'Shown in the shared playback controls.',
    immediateToolbar: ja
      ? 'デバッグ実行方法は、選ぶとすぐに反映されます。'
      : 'Debug mode takes effect immediately.',
    debugTitle: ja ? 'デバッグ実行' : 'Debug execution',
    debugModes: ja
      ? {breakpoints: 'ブレークポイントで停止', step: '処理を1つずつ実行'}
      : {breakpoints: 'Pause at breakpoints', step: 'Run one action at a time'},
    resume: ja ? '次の処理を実行' : 'Run the next action',
    debugStep: ja ? '各処理の直前で一時停止します。' : 'Pause before each action.',
    debugBreakpoints: ja
      ? '台本に設定したブレークポイントの直前で一時停止します。'
      : 'Pause before a breakpoint in the story.',
    debugPaused: (scene: string, index: number) =>
      ja
        ? `場面「${scene}」の${index}番目の処理で一時停止中`
        : `Paused in ${scene}, before action ${index}`,
    debugBadge: ja ? '停止中' : 'Debug',
    states: ja
      ? {
          idle: ['○', '待機中', '更新を検知する台本ファイルまたはプロジェクトを選んでください'],
          watching: ['↻', '更新検知', '台本ファイルや関連素材の更新を検知しています'],
          stabilizing: ['…', '確認中', '変更内容を確認しています'],
          applying: ['↻', '反映中', '確認済みの変更を反映しています'],
          reloaded: ['✓', '更新済み', '変更を反映しました'],
          diagnostic: ['!', '要確認', 'プレビューの状態を確認してください'],
          paused: ['Ⅱ', '休止中', '台本ファイルや関連素材の更新検知を休止しています'],
          disconnected: ['×', '未接続', '台本ファイルまたはプロジェクトに接続されていません'],
        }
      : {
          idle: ['○', 'Idle', 'Choose a story file or project to detect file updates'],
          watching: ['↻', 'Watching', 'Detecting updates to story files and related assets'],
          stabilizing: ['…', 'Checking', 'Reload status: stabilizing changes'],
          applying: ['↻', 'Applying', 'Reload status: applying a validated change'],
          reloaded: ['✓', 'Reloaded', 'Reload status: reload completed'],
          diagnostic: ['!', 'Error', 'Reload status: preview needs attention'],
          paused: ['Ⅱ', 'Paused', 'Update detection for story files and related assets is paused'],
          disconnected: ['×', 'Offline', 'Story file or project is disconnected'],
        },
  };
}
