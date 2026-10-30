# 配布を完了しなかった候補 4.0.0-rc.74

この候補のmain統合とタグ作成後、Releaseのフル検証でChromiumの4件が失敗したため、Release・npm・Pagesの配布は完了していません。オフライン配信テストのStage無しfixtureと、previewのstandalone拡張登録経路を修正し、次のrc.75として新しく凍結します。

- 既存mainコミットは`9781f7a90045eba3be5868a8ac1d6d5cae857499`、作成済み注釈付きタグのobjectは`1fe99c5df897c5b62b2e18c81212fd6e2437d0f1`です。既存タグは移動・上書き・削除しません。
- `metadata.json`と`release-notes.md`は凍結候補の元バイトを保持した記録です。配布成功やnpm公開の証拠ではありません。
- 元SB3は8,301,203 bytes、SHA-256 `2515c8018ce02929065a3b372e62c7299041d8af0f55dd84eeda1a7c91cf74aa`、source identityは`sha256:789bfb2d5877e70b4d76c0dd4dcc106ad7d74b178f199c968eefa7d61d49161a`です。元バイトはローカル検証証跡にも保全し、上書きしません。

この記録を新しい公開ダウンロードカタログへ登録しないでください。既存rc.72／rc.73のarchiveも変更しません。
