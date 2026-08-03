export const generalDocumentConfig = {
  title: 'TMPose紙芝居 一般ドキュメント',
  author: 'Hiroya Kubo',
  sourceDirectory: 'general',
  outputDirectory: 'general',
  tocHtmlFilename: 'toc.html',
  tocSectionDepth: 3,
  standaloneArticleHtmlFilename: 'document.html',
  standaloneTocHtmlFilename: 'index.html',
  documents: [
    {
      sourceFilename: '01-executive-summary-adult.md',
      title: '紙芝居アプリ 概要説明書 大人向け',
      audience: '保護者・教員・運営者',
      description: 'アプリの価値、仕組み、利用場面、教育的な意義を簡潔にまとめています。',
    },
    {
      sourceFilename: '02-executive-summary-kids.md',
      title: '紙芝居アプリ 概要説明書 子供向け',
      audience: '子供・初めての方',
      description: '紙芝居でできることや安全な使い方を、やさしい言葉で紹介します。',
      addFurigana: true,
    },
    {
      sourceFilename: '03-user-guide.md',
      title: '紙芝居アプリ 操作説明書',
      audience: 'アプリを使う方',
      description: '台本の読み込み、再生、ポーズ認識、本番前の確認方法を説明します。',
    },
    {
      sourceFilename: '04-dsl-manual.md',
      title: '紙芝居DSLファイル作成マニュアル',
      audience: '作品を作る方',
      description:
        '3.1の台本を設計し、シーンラベル、分岐、入力、アニメーションを含めて作成・テストする手順を説明します。',
    },
    {
      sourceFilename: '05-command-reference.md',
      title: '紙芝居DSL コマンドリファレンス',
      audience: '台本文法を調べる方',
      description:
        'kamishibai 3.1で利用できるコマンド、アクション、引数、注意事項を一覧化しています。',
    },
    {
      sourceFilename: '06-developer-guide.md',
      title: '紙芝居アプリ ソフトウェアメンテナンスガイド',
      audience: 'ソフトウェア開発者',
      description:
        '成果物とビルダーの利用、アプリ本体、SB3、ドキュメントの変更、検証、公開手順を案内します。',
    },
    {
      sourceFilename: '07-internal-specification.md',
      title: '紙芝居アプリ内部仕様書',
      audience: 'アプリの実装を調査・変更する方',
      description:
        '現行の汎用アプリSB3におけるtarget、変数、block、message、呼出し関係、状態遷移を記録します。',
    },
    {
      sourceFilename: '08-extension-guide.md',
      title: 'TMPose紙芝居 機能拡張ガイド',
      audience: 'アプリの依存機能を調査・変更する方',
      description: '15個の依存機能拡張を一覧と図解付き・1拡張1ページの全16ページで紹介します。',
      pdfIncludesGeneratedToc: false,
      expectedPdfPageCount: 16,
    },
    {
      sourceFilename: '09-application-materials-guide.md',
      title: 'TMPose紙芝居 アプリ・教材・ツールチェインガイド',
      audience: 'アプリと教材の全体像を把握する方',
      description:
        'アプリ概要、浦島太郎、体験会教材、DSL 3.1、sb3-toolchainを図解付き・全8ページで紹介します。',
      pdfIncludesGeneratedToc: false,
      expectedPdfPageCount: 8,
    },
    {
      sourceFilename: 'history.md',
      title: '紙芝居DSL 2.0から3.1への変更履歴',
      audience: '2.0から移行する方',
      description:
        '2.0から3.1で追加・変更・置換したDSL仕様と、台本の移行手順を差分形式でまとめています。',
    },
  ],
};

export const documentConfig = {
  title: 'AIを使って「紙芝居の物語に参加する仕組み」を作ろう！',
  author: 'Hiroya Kubo',
  sourceDirectory: 'workshops/2026-08-01',
  outputDirectory: 'workshops/2026-08-01',
  learnedThroughGrade: 3,
  coverFilename: 'tmpose-kamishibai-cover-20260801.md',
  coverHtmlFilename: 'index.html',
  sourceFilename: 'tmpose-kamishibai-20260801.md',
  tocHtmlFilename: 'toc.html',
  pdfFilename: 'tmpose-kamishibai-20260801.pdf',
  tocSectionDepth: 3,
  rubyOverrides: [
    '久保裕也:裕也:ひろや',
    '竜宮城:りゅうぐうじょう',
    '玉手箱:たまてばこ',
    '浦島太郎:うらしまたろう',
    '未習漢字:みしゅうかんじ',
  ],
};

export const staffDocumentConfig = {
  title: '親子AIプログラミング体験会スタッフ向け資料2026年8月1日版',
  author: 'Hiroya Kubo',
  sourceDirectory: 'workshops/2026-08-01',
  outputDirectory: 'workshops/2026-08-01/staff',
  sourceFilename: 'tmpose-kamishibai-staff-20260801.md',
  htmlFilename: 'index.html',
  pdfFilename: 'tmpose-kamishibai-staff-20260801.pdf',
};

export function resolveLearnedThroughGrade(value = process.env.RUBYGANA_GRADE) {
  const grade =
    value === undefined || value === '' ? documentConfig.learnedThroughGrade : Number(value);

  if (!Number.isInteger(grade) || grade < 1 || grade > 6) {
    throw new RangeError('RUBYGANA_GRADE must be an integer from 1 through 6.');
  }

  return grade;
}
