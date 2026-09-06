/**
 * The typed boundary for `scripts/site-navigation.mjs`.
 *
 * That module is synced byte for byte from `kubohiroya/tm-kamishibai-docs` and the navigation
 * contract workflow compares the two files, so this repository must not annotate it. TypeScript
 * prefers this declaration over the JavaScript source, which keeps the synced file out of the
 * type-check program while its callers stay checked. Update this file when the contract changes.
 */

export interface NavigationContractItem {
  readonly href: string;
  readonly id?: string;
  readonly label?: string;
}

export interface NavigationContract {
  readonly contractVersion: string;
  readonly items: readonly NavigationContractItem[];
  readonly [key: string]: unknown;
}

export interface SiteNavigationOptions {
  readonly site: string;
  readonly pathname: string;
  readonly assetBase?: string;
}

export const NAVIGATION_CONTRACT: NavigationContract;
export const NAVIGATION_CONTRACT_VERSION: string;
export function resolveCurrentSection(site: string, pathname: string): string | null;
export function renderSiteNavigation(options: SiteNavigationOptions): string;
export function renderSiteHeader(options: SiteNavigationOptions): string;
export function replaceSiteNavigation(source: string, options: SiteNavigationOptions): string;
