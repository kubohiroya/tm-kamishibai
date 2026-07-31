export const appShellCommon = Object.freeze({
  about: Object.freeze({
    author: Object.freeze({email: 'hiroya@cuc.ac.jp'}),
    officialWebsite: Object.freeze({
      url: 'https://kubohiroya.github.io/tmpose-kamishibai/',
    }),
  }),
});

export const appShellLocales = Object.freeze({
  en: Object.freeze({
    about: Object.freeze({
      author: Object.freeze({
        name: 'Hiroya Kubo',
        organization: 'Faculty of Policy Informatics, Chiba University of Commerce',
      }),
      license: Object.freeze({
        app: "This application's source code is provided under the Mozilla Public License 2.0 (MPL-2.0).",
        story: 'Each story script is subject to the license and terms stated in that file.',
      }),
      officialWebsite: Object.freeze({name: 'Official Website'}),
      title: 'Participatory AI Kamishibai',
    }),
    ui: Object.freeze({
      about: 'About',
      invalidScript: 'Invalid script',
      language: 'Language',
      open: 'Open',
      reload: 'Reload',
    }),
  }),
  ja: Object.freeze({
    about: Object.freeze({
      author: Object.freeze({
        name: '久保 裕也',
        organization: '千葉商科大学 総合政策学部',
      }),
      license: Object.freeze({
        app: '本アプリのソースコードはMozilla Public License 2.0（MPL-2.0）で提供されています。',
        story: '台本ファイルには、各ファイル記載のライセンス・利用条件が適用されます。',
      }),
      officialWebsite: Object.freeze({name: '公式Webサイト'}),
      title: '「参加型」AI紙芝居',
    }),
    ui: Object.freeze({
      about: 'このアプリについて',
      invalidScript: 'エラー：不正な台本ファイル',
      language: '言語',
      open: 'ファイルを開く',
      reload: 'もう一度',
    }),
  }),
});

export const appShellLanguageNames = Object.freeze({
  en: 'English',
  ja: '日本語',
});

export const appShellSelectedLanguageNames = Object.freeze({
  en: `✓ ${appShellLanguageNames.en}`,
  ja: `✓ ${appShellLanguageNames.ja}`,
});

export const appShellProjectPlaceholders = Object.freeze({
  '{{ABOUT_OFFICIAL_WEBSITE_URL}}': appShellCommon.about.officialWebsite.url,
  '{{LANGUAGE_NAME_EN}}': appShellLanguageNames.en,
  '{{LANGUAGE_NAME_EN_SELECTED}}': appShellSelectedLanguageNames.en,
  '{{LANGUAGE_NAME_JA}}': appShellLanguageNames.ja,
  '{{LANGUAGE_NAME_JA_SELECTED}}': appShellSelectedLanguageNames.ja,
  '{{UI_ABOUT_EN}}': appShellLocales.en.ui.about,
  '{{UI_ABOUT_JA}}': appShellLocales.ja.ui.about,
  '{{UI_INVALID_SCRIPT_EN}}': appShellLocales.en.ui.invalidScript,
  '{{UI_INVALID_SCRIPT_JA}}': appShellLocales.ja.ui.invalidScript,
  '{{UI_LANGUAGE_EN}}': appShellLocales.en.ui.language,
  '{{UI_LANGUAGE_JA}}': appShellLocales.ja.ui.language,
  '{{UI_OPEN_EN}}': appShellLocales.en.ui.open,
  '{{UI_OPEN_JA}}': appShellLocales.ja.ui.open,
  '{{UI_RELOAD_EN}}': appShellLocales.en.ui.reload,
  '{{UI_RELOAD_JA}}': appShellLocales.ja.ui.reload,
});
