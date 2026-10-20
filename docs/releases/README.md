# DSL 4.0のreleaseを切る

このディレクトリはreleaseごとのノートを持ちます。手順はここに書きます。

## 状態

`release-metadata/<version>.json`の`state`は`frozen`から始まり`published`へ進みます。

| 状態        | 意味                                                      |
| ----------- | --------------------------------------------------------- |
| `frozen`    | artifactが確定している。`release:dsl4:update`は拒否される |
| `published` | 公開済みassetと照合済み                                   |

`candidate`はローカルで`release:dsl4:update`を直接実行したときだけ現れる中間状態です。`main`には載せません。`candidate`が`main`にあると、その versionのバイト列をあとから差し替えられてしまい、pinした下流が別物を見ます。実際にturbowarp-kamishibai-samplesが中間candidateをpinし、公開artifactと207 bytes違っていたことがあります。`pnpm sb3:build`は`update`と`freeze`を一度に行うため、この窓が開きません。

freezeは一方向です。凍結したreleaseは再生成できないので、あとで問題が見つかったら次のcandidateを切って直します。

## 1. cutのPR

版の文字列を上げます。

- `package.json`
- `src/builder/constants.ts`
- `src/dsl4/runtime-provenance.ts`
- `scripts/sb3/dsl4-runtime-extension-entry.ts`
- `scripts/smoke/dsl4-packager-binary-memory.ts`
- `test/fixtures/dsl4/release-pins.json`
- `test/fixtures/dsl4/artifact-fingerprint-matrix.json`
- `test/fixtures/dsl4/capability-bundle-release-contract.json`
- `README.md`、`README.ja.md`（版の表、npm URL、`[rcNN]`リンク）
- `scripts/sb3/dsl4-release-policy.ts`の`dsl4NextReleaseVersion`を次の次へ

artifactを作って凍結します。

```sh
pnpm dsl4:playback-runtime:generate
pnpm sb3:build
```

`artifactFingerprint`は版の文字列から変わるので、失敗が報告する実測値へ再pinします。

```sh
pnpm vitest run test/dsl4-artifact-fingerprint.test.ts
# 失敗が出す Received を test/fixtures/dsl4/release-pins.json の expected へ
```

`docs/releases/v<version>.md`を書きます。「公開結果」は`- npm: 公開後に記録`のまま置きます。

```sh
pnpm verify:full
```

PRを出し、CIが通ったらmergeします。CIは`sb3:check`でSB3をsourceから再ビルドして照合するため、**凍結したartifactはmerge前に検証されます**。

> `pnpm typecheck`だけを単独で走らせると`dist/`が無いworktreeでは`test/e2e`が落ちます。`verify:full`は先にビルドするので、こちらを使ってください。

## 2. 公開

GitHub prereleaseを作り、`tmp/release-candidates/`のSB3を添付します。`--target`はfreezeしたcommitの完全なSHAです。

```sh
gh release create v<version> --target "$(git rev-parse origin/main)" --prerelease \
  --title v<version> --notes '...' tmp/release-candidates/kamishibai-<version>.sb3
```

npmへ公開します。**この操作は2要素認証のワンタイムパスワードを要求するので、maintainerが自分の端末で実行します。**

```sh
npm publish --access public --tag next
```

`latest`も現行へ向けます。releaseスクリプトはこれを動かしません。

```sh
npm dist-tag add @kubohiroya/turbowarp-kamishibai-app@<version> latest
```

実行前に`npm view @kubohiroya/turbowarp-kamishibai-app dist-tags`で状態を見てください。公開済みのversionへ重ねてpublishすることはできません。

## 3. recordのPR

公開済みassetを取得して照合し、`published`へ移します。
`published`はSB3の公開・照合状態です。npmを別途公開する場合、GitHub ReleaseとPagesのみを記録できます。その場合は`--npm-url`を省略し、ノートにnpmが未公開であることを明記します。未公開のnpm URLは記録しません。

```sh
pnpm release:dsl4:record-publication \
  --npm-url https://www.npmjs.com/package/@kubohiroya/turbowarp-kamishibai-app/v/<version> \
  --github-release-url https://github.com/kubohiroya/turbowarp-kamishibai-app/releases/tag/v<version> \
  --pages-url https://kubohiroya.github.io/turbowarp-kamishibai-app/
pnpm release:dsl4:verify-published-snapshot
```

ノートの「公開結果」を埋め、PRを出してmergeします。npm 11.19.0は packumentに`gitHead`を記録しないので、tarballのSHA-1と公開元commitを書きます。

## 4. 下流

turbowarp-kamishibai-samplesは`stories/urashima/dsl4-build.config.json`の`runtime`で、公開済みrelease artifactをbaseとして固定します。そちらのREADMEに再pinの手順があります。
