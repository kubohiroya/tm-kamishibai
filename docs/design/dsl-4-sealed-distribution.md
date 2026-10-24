# DSL 4.0 sealed distribution profile

関連: [#781](https://github.com/kubohiroya/turbowarp-kamishibai-app/issues/781)（親 [#636](https://github.com/kubohiroya/turbowarp-kamishibai-app/issues/636)）。
2026-10-24、基準main `c28f1d39`、作業ブランチ `feat/dsl4/sealed-artifact`。前提は[compiled distribution profile](dsl-4-compiled-distribution.md)。

DSLは4.0のまま。feature flagは追加しない（compiledと同じ方針）。Safariは対象外。

## 決めたこと

- **sealedはcompiledを前提にする**（2026-10-24、ユーザー判断）。暗号化するのはcompiled story artifact（Story IR）と埋め込み素材で、
  YAMLは対象にしない。復号した後もYAML・comment・ファイルパス・source mapはメモリに現れず、実行時にYAMLを解析しない。
- **鍵はパスワードから先に実装する**（同日、ユーザー判断）。閲覧者のパスワードからブラウザ内で鍵を導出する（WebCryptoのみ、サーバ不要）。
  authenticated key serviceは、loaderが受け取る`unlockSealedStory`の境界だけを定め、実装は後にする。

## 形式（`sealed-story-artifact.ts`）

`dsl4FormatVersions.sealedArtifact = 1`。runtime componentの`sealed`に保存し、同じcomponentに`source`・`compiled`・`assets`・
`assetDistribution`を置かない。

```json
{
  "formatVersion": 1,
  "profile": "sealed",
  "sourceIntegrity": "sha256-…（省いたcanonical sourceのintegrity。runtime artifactと同じ）",
  "keyDerivation": {"kind": "pbkdf2-sha256", "iterations": 600000, "salt": "（16 bytes, base64）"},
  "cipher": {"kind": "aes-256-gcm", "iv": "（12 bytes, base64）"},
  "cacheIdentity": {"id": "…", "label": "compiled", "databaseName": "…"},
  "ciphertext": "（base64）"
}
```

- 平文は`{compiled, assets}`のJSON。`compiled`はcompiled story artifact、`assets`は埋め込み素材のbundle（base64のfile dataを含む）。
- 鍵: PBKDF2-HMAC-SHA256でパスワードから256 bitのAES-GCM鍵を導出する。既定は600,000回（OWASPの2023年推奨）、読む側は100,000回未満を拒否する。
- 暗号: AES-256-GCM（tag 128 bit）。saltとIVは毎回乱数で作るため、同じstoryを2回sealedにしても同じbytesにはならない。
- 読める部分（header）はGCMのadditional dataにする。headerを1文字でも変えると、間違ったパスワードと同じく認証に失敗する。
- 平文で残るのは、runtime artifact descriptor（control profileとkeymap）とheaderだけ。台詞・scene・変数・素材は残らない。

## 読込

`loadDsl4RuntimeArtifact` / `loadDsl4RuntimeComponent`は、`unlockSealedStory({sourceIntegrity})`でパスワードを受け取る。

1. `sealed`の隣に`source`・`compiled`・`assets`・`assetDistribution`があれば拒否（`K4-SEALED-STORY-001`）。
   binary entryの素材形式も拒否（`K4-SEALED-ASSETS-001`）。
2. `unlockSealedStory`がなければ`K4-SEALED-KEY-REQUIRED`。
3. envelopeを検証してから復号する。パスワード違い・headerやciphertextの変更は`K4-SEALED-AUTH-001`（区別しない）。
4. 復号したcompiled storyをcompiledと同じ方法で検証し（envelope・digest・Story IR）、headerの`sourceIntegrity`と一致するか確かめる。
5. 復号した`compiled`と`assets`を、メモリ上のprojectの複製に置いて、compiledと同じ経路で読む。結果の`distributionProfile`は`sealed`。

復号したstoryと素材はcomponentの寿命の間だけメモリにあり、どこにも書き出さない。素材のmaterializationは既存のasset group／
lifecycleの解放に従う。remote素材はsealedでは使えないため、IndexedDBのcacheに平文が入る経路はない。

## ビルド

`build-dsl4 --distribution-profile sealed --sealed-password-env NAME`。パスワードは環境変数`NAME`から読み、コマンドラインには書かない。
APIは`buildDsl4RuntimeComponent({distributionProfile: 'sealed', sealedPassword, sealedIterations?})`。

1. compiledと同じくsourceでビルド・検証し、compiledに変換・検証する。
2. compiled storyと埋め込み素材をsealedにし、`compiled`と`assets`を削除する（`sealDsl4CompiledProject`）。
3. 同じパスワードで開き直して検証してからSB3を書き出す。

root binary entry（`--enable-root-binary-entries`）は素材のbytesがproject.jsonの外にあるため拒否する。

## 制約

### 日本語

- `sealed`は、配布物（SB3）を保存・転送している間にstoryと素材を読めなくする。パスワードを知っている閲覧者からは守らない。
  再生するには復号が必要で、再生中の内容はブラウザのメモリにあり、開発者ツール等で取り出せる。
- 強さはパスワードで決まる。短いパスワードはPBKDF2があっても総当たりで破られうる。パスワードを配布物と同じ場所に置かない。
- 同じパスワードを全閲覧者に配る方式のため、閲覧者ごとの取り消しはできない。
- publisher signatureはまだない。GCMは「このパスワードを知る人が作った」ことは示すが、「誰が作った」ことは示さない。

### English

- `sealed` keeps the story and its assets unreadable while the SB3 is stored or transferred. It does not protect them from a viewer who knows the password: playing the story requires decrypting it, and while it plays the content is in browser memory, where developer tools can read it.
- Its strength is the password's. A short password can be brute-forced despite PBKDF2. Do not ship the password with the artifact.
- Every viewer gets the same password, so access cannot be revoked per viewer.
- There is no publisher signature yet. GCM shows the artifact was made by someone who knows the password, not who made it.

## 検証

- `test/dsl4-sealed-artifact.test.ts`: 両channelで、台詞の目印・素材の目印・素材ファイル名・`kamishibai:`・`"scenes"`がSB3のどのentryにもない。
  `source`・`compiled`・`assets`がcomponentに残らない。正しいパスワードで開け、素材のbytesが元と一致する。
  パスワードなし・違い、header（`sourceIntegrity`・iterations）やciphertextの変更、平文の`assets`との同時保存、未知のkeyを拒否する。
  2回のsealedでsaltとIVが変わる。binary entryとパスワードなしのビルドを拒否する。CLIは環境変数からパスワードを読む。
- `test/dsl4-format-contracts.test.ts`・`test/dsl4-architecture.test.ts`に形式とcore moduleを登録した。

## 残り（#781）

- Player／Standardアプリでのパスワード入力（現在は`unlockSealedStory`を渡すhostがなく、sealed SB3は`K4-SEALED-KEY-REQUIRED`で止まる）。
- authenticated key serviceの実装、publisher signature。
- 複数章のpublicationのsealed、segment／asset group単位の暗号化と、必要な章だけの復号。
