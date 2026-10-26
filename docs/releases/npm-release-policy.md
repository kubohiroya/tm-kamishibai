# npmリリース完了とdist-tag

- 新版を公開し、必要な検証を完了した時点で`latest`と`next`を同じ版に揃える。
- 次版の試験公開中は`next`だけを進め、`latest`は直前に完了した版を保持する。ローカル開発だけではnpmのタグは変わらない。
- 試験公開では`npm publish --tag next`を使い、`release:finalize`を呼ばない。
- 完了時は`pnpm release:finalize <package名> <version>`を実行する。registryへの反映を待ち、両タグを同期し、取得した値の一致を確認する。一致しない場合は未完了として停止する。
- タグpushによる既存のRelease workflowは完了版を公開する。試験公開は別途明示した手順で行う。
- OIDCでタグを変更するにはnpm 11.21.0以降とTrusted Publisherの`Allow npm dist-tag`権限が必要。直接`npm publish`の許可とは独立している。2FAは弱めない。
- rc.58では`latest=next=4.0.0-rc.58`を確認済み。RC識別子は維持し、安定版への昇格は別途判断する。
- 障害時は公開版を再発行せず、タグの確認・同期のみ再実行する。誤ったタグ変更は、Issueに記録した直前の検証済み版へ戻す。公開済みの同じ版やタグは作り直さない。

[公式仕様](https://docs.npmjs.com/trusted-publishers/) / [Issue #16](https://github.com/kubohiroya/turbowarp-plus-packages/issues/16)
