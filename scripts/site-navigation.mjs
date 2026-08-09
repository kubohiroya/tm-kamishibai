import {readFileSync} from 'node:fs';

const contractLocations = [
  new URL('../site/contracts/navigation-contract.json', import.meta.url),
  new URL('../docs/tutorials/navigation-contract.json', import.meta.url),
];
const contract = JSON.parse(
  contractLocations
    .map((location) => {
      try {
        return readFileSync(location, 'utf8');
      } catch {
        return null;
      }
    })
    .find((contents) => contents !== null),
);

const githubMark = `<svg class="site-repository__icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M10.226 17.284c-2.965-.36-5.054-2.493-5.054-5.256 0-1.123.404-2.336 1.078-3.144-.292-.741-.247-2.314.09-2.965.898-.112 2.111.36 2.83 1.01.853-.269 1.752-.404 2.853-.404 1.1 0 1.999.135 2.807.382.696-.629 1.932-1.1 2.83-.988.315.606.36 2.179.067 2.942.72.854 1.101 2 1.101 3.167 0 2.763-2.089 4.852-5.098 5.234.763.494 1.28 1.572 1.28 2.807v2.336c0 .674.561 1.056 1.235.786 4.066-1.55 7.255-5.615 7.255-10.646C23.5 6.188 18.334 1 11.978 1 5.62 1 .5 6.188.5 12.545c0 4.986 3.167 9.12 7.435 10.669.606.225 1.19-.18 1.19-.786V20.63a2.9 2.9 0 0 1-1.078.224c-1.483 0-2.359-.808-2.987-2.313-.247-.607-.517-.966-1.034-1.033-.27-.023-.359-.135-.359-.27 0-.27.45-.471.898-.471.652 0 1.213.404 1.797 1.235.45.651.921.943 1.483.943.561 0 .92-.202 1.437-.719.382-.381.674-.718.944-.943"/>
      </svg>`;

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function normalizePath(pathname) {
  const value = pathname || '/';
  return value.startsWith('/') ? value : `/${value}`;
}

export const NAVIGATION_CONTRACT = contract;
export const NAVIGATION_CONTRACT_VERSION = contract.contractVersion;

export function resolveCurrentSection(site, pathname) {
  const normalizedPath = normalizePath(pathname);
  const matches = contract.currentSectionRules
    .filter(
      (rule) => rule.site === site && normalizedPath.startsWith(normalizePath(rule.pathPrefix)),
    )
    .sort((left, right) => right.pathPrefix.length - left.pathPrefix.length);
  return matches[0]?.current ?? null;
}

export function renderSiteNavigation({site, pathname}) {
  const settings = contract.siteSettings[site];
  if (!settings) throw new Error(`Unknown site in navigation contract: ${site}`);
  const current = resolveCurrentSection(site, pathname);
  if (!current) throw new Error(`No current-section rule matches ${site}:${pathname}`);
  const links = contract.items
    .map(({id, label, href}) => {
      const currentAttribute = id === current ? ' aria-current="page"' : '';
      return `      <a class="site-nav__link" href="${escapeHtml(href)}"${currentAttribute}>${escapeHtml(label)}</a>`;
    })
    .join('\n');
  const repositoryUrl = escapeHtml(settings.repository);
  const repositoryLabel = escapeHtml(settings.repositoryLabel);
  return `<nav class="site-nav" aria-label="サイトナビゲーション" data-navigation-contract-version="${escapeHtml(NAVIGATION_CONTRACT_VERSION)}">
${links}
    </nav>
    <a class="site-repository" href="${repositoryUrl}" target="_blank" rel="noopener" aria-label="${repositoryLabel}をGitHubで開く" title="${repositoryLabel}をGitHubで開く">
      ${githubMark}
    </a>`;
}

export function renderSiteHeader({assetBase = '', site, pathname}) {
  const home = contract.items.find(({id}) => id === 'home');
  return `<a class="skip-link" href="#main-content">本文へ移動</a>
<header class="site-header">
  <div class="site-header__inner">
    <a class="site-brand" href="${escapeHtml(home.href)}">
      <img class="site-brand__symbol" src="${escapeHtml(assetBase)}favicon.png" width="40" height="40" alt="">
      <span>TMPose紙芝居</span>
    </a>
    ${renderSiteNavigation({site, pathname})}
  </div>
</header>`;
}

export function replaceSiteNavigation(source, options) {
  const navigation = renderSiteNavigation(options);
  const navPattern = /<nav\b[^>]*\bclass=(['"])[^'"]*\bsite-nav\b[^'"]*\1[^>]*>[\s\S]*?<\/nav>/iu;
  const repositoryPattern =
    /<a\b[^>]*\bclass=(['"])[^'"]*\bsite-repository\b[^'"]*\1[^>]*>[\s\S]*?<\/a>/iu;
  if (!navPattern.test(source)) throw new Error('Document does not contain a site navigation.');
  const withNavigation = source.replace(
    navPattern,
    navigation.match(/<nav[\s\S]*?<\/nav>/u)?.[0] ?? '',
  );
  if (!repositoryPattern.test(withNavigation))
    throw new Error('Document does not contain a site repository link.');
  const withRepository = withNavigation.replace(
    repositoryPattern,
    navigation.match(/<a\b[^>]*\bclass=(['"])[^'"]*\bsite-repository\b[\s\S]*?<\/a>/iu)?.[0] ?? '',
  );
  return withRepository;
}
