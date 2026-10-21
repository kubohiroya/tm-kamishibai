# Pagesの公開と過去版の保持

通常の公開には`pnpm run deploy`を使います。サイト生成に成功すると、
`scripts/deploy-site.ts`がgh-pagesの公開直前に既存成果物を保持します。
pre/postフックの設定には依存しません。`pnpm deploy`はpnpm自身のworkspace用コマンドなので使いません。
ローカルの`site-dist/`が空の状態から生成し直しても、公開ブランチから元のファイルを復元します。

保持するURLは次のとおりです。

- `downloads/kamishibai-<完全なversion>.sb3`（例: `4.0.0-rc.38`、`4.0.0`）
- `players/<完全なversion>/`配下の全ファイル（HTML・画像・スクリプトなど）

保持元はgh-pagesがfetchした公開ブランチのHEADです。古いPlayerを現在のPackagerで
作り直したり、旧HTMLへ現在のヘッダーやfaviconを追加したりしません。
生成物に同じURL・同じ内容があれば再公開できます。同じURLの内容が異なる場合は、
pushする前に中断します。変更したい場合は新しいリリースversionを使用します。
Gitの取得・読取・復元に失敗した場合も公開を中断し、履歴なしで続行しません。

初回公開では保持する履歴がないため、新しい成果物をそのまま配信します。
トップページなどの更新と不要ファイルの削除は従来どおりです。
`kamishibai-3.2.sb3`などのシリーズURLはカタログに従って更新します。

`gh-pages -d site-dist`を直接実行すると保護処理を通らないため、公開には使用しません。
過去の版付きファイルはGitHub Releaseから取得できても、Pages側で自動復元できるのは
公開ブランチのHEADに存在するものです。すでに削除されたファイルは元の履歴から復旧してから公開します。

## 検証とロールバック

### Pages公開後の自動検証

`pages build and deployment`が成功すると、`Verify published release history`が自動起動します。
デプロイしたcommitを固定し、その直前のcommitにある旧版と、新しく追加された版付きSB3・Playerを照合します。
旧版がGit上で削除・変更されていれば、CDNに古いファイルが残っていても失敗します。
公開URLでもHTTP 200、サイズ、SHA-256の一致を検査し、反映待ちは最大3回まで再試行します。
公開に失敗した場合は公開後検証を開始しません。

結果はActions summaryと`pages-release-history-<run ID>`のJSON artifact（14日保持）へ保存します。
この検証はNode.jsとGitのみで動作し、アプリ全体のビルド・インストールは実行しません。
検証のために公開物を変更したり、Issueへ自動投稿したりしません。

再確認はActions画面からこのworkflowを手動起動するか、
`node scripts/verify-pages-release-history.ts`を実行します。手動実行時もPages APIから
ビルド完了済みのcommitを取得し、未公開のgh-pages先端を基準にはしません。
CLIからの手動実行には、Node.js 24以上・Git・GitHub CLIが必要です。

### 回帰テストと切り戻し

`test/verify-pages-release-history.test.ts`で、公開後の正常系・404・サイズ/ハッシュ不一致・
Git上の削除/改変・CDN反映待ちと、workflowの起動条件を確認します。

`test/pages-history.test.ts`はローカルのbare Gitリポジトリへ実際に公開し、
初回公開、cleanな出力からの再公開、旧版のバイト一致、新版の追加、不要ページの削除、
同内容の再公開と異なる内容の拒否を検証します。通常のPR CIでも実行します。

この修正をrevertする場合は、自動公開を止めて現在のgh-pagesを退避してください。
旧版の成果物も含めた出力から公開し、版付きURLとハッシュを照合します。
公開済みの同じversionを再生成して差し替える方法は使いません。

公開後検証だけをrevertする場合も、公開前の保持処理は残し、同じGit基準と公開URLを手動で照合してください。
