# DSL 4.0 publisher signature

関連: [#781](https://github.com/kubohiroya/turbowarp-kamishibai-app/issues/781)。前提は[compiled](dsl-4-compiled-distribution.md)と[sealed](dsl-4-sealed-distribution.md)。

DSLは4.0のまま。feature flagは追加しない。Safariは対象外。

## 決めたこと

- **公開鍵をSB3に含め、指紋を表示する**（2026-10-25、ユーザー判断）。外部サーバや事前登録は使わない。
  改ざんは必ず検出し、誰が作ったかは閲覧者が指紋を配布元の公表値と照合して確かめる。
- authenticated key serviceは、鍵取得の境界（`unlockSealedStory`と`keyId`）の定義までとし、サーバの実装は別Issueにする（同日、ユーザー判断）。

## 形式（`publisher-signature.ts`）

`dsl4FormatVersions.publisherSignature = 1`。runtime componentの`signature`に保存する。

```json
{
  "formatVersion": 1,
  "algorithm": "ecdsa-p256-sha256",
  "publicKey": "（SPKI, base64）",
  "signature": "（ECDSA署名, base64）"
}
```

- 署名の対象は、`signature`を除くruntime component全体（`artifact`、`source`／`compiled`／`sealed`、`assets`、`application`等）。
  objectのkeyを全階層で並べ替えたJSONに、用途を示す接頭辞を付けて署名する。
- sealedでは暗号文のまま署名するため、復号の前に検証できる。
- 指紋は公開鍵（SPKI）のSHA-256を、`SHA256:AB:CD:…`の形で全32 byte表示する。

## 検証

`loadDsl4RuntimeArtifact` / `loadDsl4RuntimeComponent`は、componentに`signature`があれば最初に検証する。

- 署名がない: そのまま読み、結果の`publisher`は`null`。
- 署名が正しい: 結果の`publisher`は`{algorithm, fingerprint}`。
- 署名が合わない（componentの1か所でも変わった、別の鍵に差し替えた）: `K4-SIGNATURE-INVALID-001`で読まない。
- 形式・アルゴリズムが違う: `K4-SIGNATURE-001`、`K4-FORMAT-*`。

## 作者の手順

```bash
turbowarp-kamishibai generate-dsl4-signing-key --output-dir keys
```

`keys/kamishibai-signing-key.pem`（秘密鍵、権限600）と`.pub.pem`（公開鍵）を作り、指紋を表示する。既存の鍵は上書きしない。
秘密鍵は配布物と一緒に置かない。指紋はWebサイトなど、配布物とは別の経路で公表する。

```bash
turbowarp-kamishibai build-dsl4 … --signing-key keys/kamishibai-signing-key.pem
```

source／compiled／sealedのどのprofileにも署名できる。ビルドは署名した結果を読み直して検証してからSB3を書き出す。

## 表示

Standardアプリは、署名された紙芝居のタイトル画面とメニュー画面で、ステージ下部に「署名者 / Signed by: SHA256:…」を全桁で表示する
（選択してコピーできる）。再生中は表示しない。署名のない紙芝居では何も表示しない。

## 制約

### 日本語

- 署名は「作られた後に変更されていない」ことを保証する。「誰が作ったか」は、指紋を配布元の公表値と照合したときだけ分かる。
  公開鍵は配布物に入っているため、偽造者は自分の鍵で署名し直せる。その場合、指紋が配布元のものと違う。
- 指紋を照合しない閲覧者に対しては、署名は偽造を防がない。
- 秘密鍵を失うと同じ指紋で署名できず、漏れると誰でも同じ指紋で署名できる。鍵の失効の仕組みはまだない。
- 署名のない紙芝居も従来どおり開ける。署名を必須にする設定はまだない。

### English

- A signature guarantees the story was not changed after it was signed. Who made it is known only when the viewer compares the fingerprint with the one the publisher announces.
  The public key travels inside the artifact, so a forger can re-sign with their own key; the fingerprint then differs from the publisher's.
- For a viewer who does not compare fingerprints, a signature does not stop forgery.
- A lost private key cannot sign under the same fingerprint again, and a leaked one lets anyone do so. There is no key revocation yet.
- Unsigned stories still open as before. There is no setting that requires a signature yet.

## 検証

- `test/dsl4-publisher-signature.test.ts`: source／compiled／sealedの各profileに署名でき、読み込むと鍵の指紋が返る。署名なしは`publisher: null`。
  artifact・素材の変更、別の公開鍵への差し替えは`K4-SIGNATURE-INVALID-001`、アルゴリズム違いは`K4-SIGNATURE-001`。
  CLIで鍵を作り（権限600、上書き拒否）、その鍵で署名したビルドの指紋が一致する。表示のbadgeは署名ありで全桁、なしで非表示。
- 実ブラウザ（Chrome 152）: 署名したcompiledのPlayerで、紙芝居の終了後のメニューに、その回に作った鍵と同じ指紋が全桁で表示された。
  このステージの大きさでは文字が小さい（選択してコピーはできる）。[観測値](../testing/evidence/compiled-player-20261024/signed-player.json)。
- `test/dsl4-format-contracts.test.ts`・`test/dsl4-architecture.test.ts`に形式とcore moduleを登録した。

## 残り

- 複数章のpublicationの署名（現在は単一storyのcomponent）。
- 鍵の失効、署名の必須化、信頼する鍵の事前登録。
