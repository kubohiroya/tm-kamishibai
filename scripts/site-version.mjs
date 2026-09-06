export const siteVersionPlaceholder = '{{PACKAGE_VERSION}}';

export function renderSiteVersion(/** @type {any} */ source, /** @type {any} */ version) {
  if (typeof version !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z.+-]*$/u.test(version)) {
    throw new Error(`Invalid package version for the site: ${JSON.stringify(version)}`);
  }

  const placeholderCount = source.split(siteVersionPlaceholder).length - 1;
  if (placeholderCount !== 1) {
    throw new Error(
      `Expected exactly one ${siteVersionPlaceholder} in the site index, ` +
        `found ${placeholderCount}.`,
    );
  }

  return source.replace(siteVersionPlaceholder, version);
}
