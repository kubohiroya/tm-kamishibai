import {deepFreeze} from './story-document.js';

const assetKinds = new Set(['backdrop', 'costume', 'image', 'recognitionModel', 'sound']);
const deliveryPolicies = new Set(['embedded', 'remote']);
const networkPolicies = new Set(['allowed', 'forbidden']);
const configKeys = new Set(['formatVersion', 'profiles', 'providers']);
const profileKeys = new Set(['assets', 'defaultDelivery', 'kinds', 'network']);
const providerSetKeys = new Set(['embedded', 'remote']);
const embeddedFileKeys = new Set(['file']);
const embeddedProjectKeys = new Set(['name']);
const remoteConfigKeys = new Set(['url']);
const lockKeys = new Set(['assets', 'formatVersion']);
const lockAssetKeys = new Set(['contentIntegrity', 'contentType', 'kind', 'providers', 'size']);
const remoteLockKeys = new Set(['contentType', 'size', 'transportIntegrity', 'url']);
const sha256Integrity = /^sha256-[0-9a-f]{64}$/u;
const mediaType = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u;
const profileName = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;
const resolutionKeys = new Set([
  'assets',
  'canonicalResolution',
  'formatVersion',
  'network',
  'profile',
  'storyDocument',
]);
const resolutionAssetKeys = new Set([
  'contentIntegrity',
  'contentType',
  'delivery',
  'id',
  'kind',
  'provider',
  'size',
]);

export const dsl4AssetDistributionFormatVersion = 1;

export class Dsl4AssetDistributionError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'Dsl4AssetDistributionError';
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new Dsl4AssetDistributionError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strictKeys(
  value: Record<string, unknown>,
  allowed: Set<string>,
  required: ReadonlyArray<string>,
  name: string,
  code: string,
) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  if (unknown.length > 0 || missing.length > 0) {
    fail(
      code,
      `${name} keys are invalid (unknown: ${unknown.sort().join(', ') || 'none'}; missing: ${missing.sort().join(', ') || 'none'})`,
    );
  }
}

function record(value: unknown, name: string, code: string) {
  if (!isRecord(value)) fail(code, `${name} must be an object`);
  return value;
}

function nonEmptyString(value: unknown, name: string, code: string) {
  if (typeof value !== 'string' || value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(code, `${name} must be a non-empty string without control characters`);
  }
  return value;
}

function delivery(value: unknown, name: string, code: string) {
  if (!deliveryPolicies.has(String(value))) {
    fail(code, `${name} must be embedded or remote`);
  }
  return value as 'embedded' | 'remote';
}

function integrity(value: unknown, name: string, code: string) {
  if (typeof value !== 'string' || !sha256Integrity.test(value)) {
    fail(code, `${name} must be a lowercase hexadecimal SHA-256 integrity value`);
  }
  return value;
}

function contentType(value: unknown, name: string, code: string) {
  if (typeof value !== 'string' || !mediaType.test(value)) {
    fail(code, `${name} must be a canonical media type`);
  }
  return value;
}

function safeSize(value: unknown, name: string, code: string, minimum: number) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    fail(code, `${name} must be a safe integer >= ${minimum}`);
  }
  return Number(value);
}

function safeRelativePath(value: unknown, name: string, code: string) {
  const filePath = nonEmptyString(value, name, code);
  const segments = filePath.split('/');
  if (
    filePath.startsWith('/') ||
    filePath.includes('\\') ||
    /^[A-Za-z]:/u.test(filePath) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(filePath) ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    fail(code, `${name} must be a canonical project-relative POSIX path`);
  }
  return filePath;
}

function httpsUrl(value: unknown, name: string, code: string) {
  const source = nonEmptyString(value, name, code);
  let parsed;
  try {
    parsed = new URL(source);
  } catch {
    fail(code, `${name} must be an absolute HTTPS URL`);
  }
  if (
    parsed.protocol !== 'https:' ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    source.includes('#')
  ) {
    fail(code, `${name} must be an absolute HTTPS URL without credentials or fragment`);
  }
  return source;
}

function sortedRecord<T>(value: Record<string, unknown>, map: (child: unknown, key: string) => T) {
  return Object.fromEntries(
    Object.keys(value)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      .map((key) => [key, map(value[key], key)]),
  );
}

function embeddedProvider(input: unknown, name: string, code: string) {
  const provider = record(input, name, code);
  const hasFile = Object.hasOwn(provider, 'file');
  const hasName = Object.hasOwn(provider, 'name');
  if (hasFile === hasName) {
    fail(code, `${name} must contain exactly one of file or name`);
  }
  if (hasFile) {
    strictKeys(provider, embeddedFileKeys, ['file'], name, code);
    return {file: safeRelativePath(provider.file, `${name}.file`, code)};
  }
  strictKeys(provider, embeddedProjectKeys, ['name'], name, code);
  return {name: nonEmptyString(provider.name, `${name}.name`, code)};
}

function remoteConfigProvider(input: unknown, name: string) {
  const provider = record(input, name, 'K4-ASSET-PROVIDER-001');
  strictKeys(provider, remoteConfigKeys, ['url'], name, 'K4-ASSET-PROVIDER-001');
  return {url: httpsUrl(provider.url, `${name}.url`, 'K4-ASSET-PROVIDER-001')};
}

function configProviderSet(input: unknown, name: string) {
  const providers = record(input, name, 'K4-ASSET-PROVIDER-001');
  strictKeys(providers, providerSetKeys, [], name, 'K4-ASSET-PROVIDER-001');
  if (!Object.hasOwn(providers, 'embedded') && !Object.hasOwn(providers, 'remote')) {
    fail('K4-ASSET-PROVIDER-001', `${name} must declare embedded or remote`);
  }
  return {
    ...(Object.hasOwn(providers, 'embedded')
      ? {
          embedded: embeddedProvider(
            providers.embedded,
            `${name}.embedded`,
            'K4-ASSET-PROVIDER-001',
          ),
        }
      : {}),
    ...(Object.hasOwn(providers, 'remote')
      ? {remote: remoteConfigProvider(providers.remote, `${name}.remote`)}
      : {}),
  };
}

function distributionProfile(input: unknown, name: string) {
  const profile = record(input, name, 'K4-ASSET-PROFILE-001');
  strictKeys(profile, profileKeys, ['network'], name, 'K4-ASSET-PROFILE-001');
  if (!networkPolicies.has(String(profile.network))) {
    fail('K4-ASSET-PROFILE-001', `${name}.network must be allowed or forbidden`);
  }
  const kinds = Object.hasOwn(profile, 'kinds')
    ? sortedRecord(record(profile.kinds, `${name}.kinds`, 'K4-ASSET-PROFILE-001'), (value, key) => {
        if (!assetKinds.has(key)) {
          fail('K4-ASSET-PROFILE-001', `${name}.kinds contains unknown asset kind ${key}`);
        }
        return delivery(value, `${name}.kinds.${key}`, 'K4-ASSET-PROFILE-001');
      })
    : {};
  const assets = Object.hasOwn(profile, 'assets')
    ? sortedRecord(
        record(profile.assets, `${name}.assets`, 'K4-ASSET-PROFILE-001'),
        (value, key) => {
          nonEmptyString(key, `${name}.assets asset ID`, 'K4-ASSET-PROFILE-001');
          return delivery(value, `${name}.assets.${key}`, 'K4-ASSET-PROFILE-001');
        },
      )
    : {};
  return {
    network: profile.network as 'allowed' | 'forbidden',
    ...(Object.hasOwn(profile, 'defaultDelivery')
      ? {
          defaultDelivery: delivery(
            profile.defaultDelivery,
            `${name}.defaultDelivery`,
            'K4-ASSET-PROFILE-001',
          ),
        }
      : {}),
    ...(Object.keys(kinds).length > 0 ? {kinds} : {}),
    ...(Object.keys(assets).length > 0 ? {assets} : {}),
  };
}

/** Validate and normalize the author-managed distribution profile configuration. */
export function validateDsl4AssetDistributionConfig(input: unknown) {
  const config = record(input, 'asset distribution config', 'K4-ASSET-PROFILE-001');
  strictKeys(
    config,
    configKeys,
    ['formatVersion', 'profiles', 'providers'],
    'asset distribution config',
    'K4-ASSET-PROFILE-001',
  );
  if (config.formatVersion !== dsl4AssetDistributionFormatVersion) {
    fail('K4-ASSET-PROFILE-001', 'asset distribution config formatVersion must be 1');
  }
  const inputProfiles = record(config.profiles, 'profiles', 'K4-ASSET-PROFILE-001');
  if (Object.keys(inputProfiles).length === 0) {
    fail('K4-ASSET-PROFILE-001', 'profiles must contain at least one profile');
  }
  const profiles = sortedRecord(inputProfiles, (value, key) => {
    if (!profileName.test(key)) {
      fail('K4-ASSET-PROFILE-001', `profile name ${key} is invalid`);
    }
    return distributionProfile(value, `profiles.${key}`);
  });
  const providers = sortedRecord(
    record(config.providers, 'providers', 'K4-ASSET-PROVIDER-001'),
    (value, key) => {
      nonEmptyString(key, 'provider asset ID', 'K4-ASSET-PROVIDER-001');
      return configProviderSet(value, `providers.${key}`);
    },
  );
  return deepFreeze({formatVersion: dsl4AssetDistributionFormatVersion, profiles, providers});
}

function remoteLockProvider(input: unknown, name: string) {
  const provider = record(input, name, 'K4-ASSET-LOCK-001');
  strictKeys(provider, remoteLockKeys, [...remoteLockKeys], name, 'K4-ASSET-LOCK-001');
  return {
    url: httpsUrl(provider.url, `${name}.url`, 'K4-ASSET-LOCK-001'),
    transportIntegrity: integrity(
      provider.transportIntegrity,
      `${name}.transportIntegrity`,
      'K4-ASSET-LOCK-001',
    ),
    contentType: contentType(provider.contentType, `${name}.contentType`, 'K4-ASSET-LOCK-001'),
    size: safeSize(provider.size, `${name}.size`, 'K4-ASSET-LOCK-001', 1),
  };
}

function lockProviderSet(input: unknown, name: string) {
  const providers = record(input, name, 'K4-ASSET-LOCK-001');
  strictKeys(providers, providerSetKeys, [], name, 'K4-ASSET-LOCK-001');
  if (!Object.hasOwn(providers, 'embedded') && !Object.hasOwn(providers, 'remote')) {
    fail('K4-ASSET-LOCK-001', `${name} must declare embedded or remote`);
  }
  return {
    ...(Object.hasOwn(providers, 'embedded')
      ? {embedded: embeddedProvider(providers.embedded, `${name}.embedded`, 'K4-ASSET-LOCK-001')}
      : {}),
    ...(Object.hasOwn(providers, 'remote')
      ? {remote: remoteLockProvider(providers.remote, `${name}.remote`)}
      : {}),
  };
}

function lockAsset(input: unknown, name: string) {
  const asset = record(input, name, 'K4-ASSET-LOCK-001');
  strictKeys(asset, lockAssetKeys, [...lockAssetKeys], name, 'K4-ASSET-LOCK-001');
  if (!assetKinds.has(String(asset.kind))) {
    fail('K4-ASSET-LOCK-001', `${name}.kind is invalid`);
  }
  const normalized = {
    kind: asset.kind as string,
    contentIntegrity: integrity(
      asset.contentIntegrity,
      `${name}.contentIntegrity`,
      'K4-ASSET-LOCK-001',
    ),
    contentType: contentType(asset.contentType, `${name}.contentType`, 'K4-ASSET-LOCK-001'),
    size: safeSize(asset.size, `${name}.size`, 'K4-ASSET-LOCK-001', 0),
    providers: lockProviderSet(asset.providers, `${name}.providers`),
  };
  const remote = normalized.providers.remote;
  if (
    remote &&
    normalized.kind !== 'recognitionModel' &&
    (normalized.contentIntegrity !== remote.transportIntegrity ||
      normalized.contentType !== remote.contentType ||
      normalized.size !== remote.size)
  ) {
    fail(
      'K4-ASSET-CONTENT-MISMATCH-001',
      `${name} remote transport does not match its logical single-file content`,
    );
  }
  return normalized;
}

/** Validate and normalize the generated asset distribution lock. */
export function validateDsl4AssetDistributionLock(input: unknown) {
  const lock = record(input, 'asset distribution lock', 'K4-ASSET-LOCK-001');
  strictKeys(
    lock,
    lockKeys,
    ['formatVersion', 'assets'],
    'asset distribution lock',
    'K4-ASSET-LOCK-001',
  );
  if (lock.formatVersion !== dsl4AssetDistributionFormatVersion) {
    fail('K4-ASSET-LOCK-001', 'asset distribution lock formatVersion must be 1');
  }
  const assets = sortedRecord(
    record(lock.assets, 'lock assets', 'K4-ASSET-LOCK-001'),
    (value, key) => {
      nonEmptyString(key, 'lock asset ID', 'K4-ASSET-LOCK-001');
      return lockAsset(value, `assets.${key}`);
    },
  );
  const contentIdentities = new Map();
  for (const [assetId, asset] of Object.entries(assets)) {
    const identity = JSON.stringify({contentType: asset.contentType, size: asset.size});
    const previous = contentIdentities.get(asset.contentIntegrity);
    if (previous !== undefined && previous.identity !== identity) {
      fail(
        'K4-ASSET-CONTENT-MISMATCH-001',
        `Assets ${previous.assetId} and ${assetId} disagree about one logical content identity`,
      );
    }
    contentIdentities.set(asset.contentIntegrity, {assetId, identity});
  }
  return deepFreeze({formatVersion: dsl4AssetDistributionFormatVersion, assets});
}

export function serializeDsl4AssetDistributionLock(input: unknown) {
  return `${JSON.stringify(validateDsl4AssetDistributionLock(input), null, 2)}\n`;
}

function storyProvider(asset: Readonly<Record<string, any>>) {
  if (asset.delivery === 'remote') {
    if (!isRecord(asset.source)) {
      fail('K4-ASSET-PROVIDER-001', `Story asset ${asset.id} remote source is missing`);
    }
    return {
      remote: {
        url: httpsUrl(asset.source.url, `Story asset ${asset.id} URL`, 'K4-ASSET-PROVIDER-001'),
        ...(asset.source.integrity === undefined
          ? {}
          : {
              transportIntegrity: integrity(
                asset.source.integrity,
                `Story asset ${asset.id} integrity`,
                'K4-ASSET-PROVIDER-001',
              ),
              contentType: contentType(
                asset.source.contentType,
                `Story asset ${asset.id} contentType`,
                'K4-ASSET-PROVIDER-001',
              ),
              size: safeSize(
                asset.source.size,
                `Story asset ${asset.id} size`,
                'K4-ASSET-PROVIDER-001',
                1,
              ),
            }),
      },
    };
  }
  if (typeof asset.file === 'string') {
    return {
      embedded: {
        file: safeRelativePath(asset.file, `Story asset ${asset.id} file`, 'K4-ASSET-PROVIDER-001'),
      },
    };
  }
  return {
    embedded: {
      name: nonEmptyString(
        asset.name ?? asset.id,
        `Story asset ${asset.id} name`,
        'K4-ASSET-PROVIDER-001',
      ),
    },
  };
}

function sameEmbeddedProvider(
  left: Readonly<Record<string, any>>,
  right: Readonly<Record<string, any>>,
) {
  return left.file === right.file && left.name === right.name;
}

function declaredProviders(
  assetId: string,
  story: Readonly<Record<string, any>>,
  configured: Readonly<Record<string, any>> | undefined,
) {
  const result = {...story};
  if (configured?.embedded) {
    if (result.embedded && !sameEmbeddedProvider(result.embedded, configured.embedded)) {
      fail('K4-ASSET-PROVIDER-001', `Asset ${assetId} declares conflicting embedded providers`);
    }
    result.embedded = configured.embedded;
  }
  if (configured?.remote) {
    if (result.remote && result.remote.url !== configured.remote.url) {
      fail('K4-ASSET-PROVIDER-001', `Asset ${assetId} declares conflicting remote providers`);
    }
    result.remote = {...result.remote, ...configured.remote};
  }
  return result;
}

function bindProviders(
  assetId: string,
  declared: Readonly<Record<string, any>>,
  locked: Readonly<Record<string, any>>,
) {
  const declaredDeliveries = Object.keys(declared).sort();
  const lockedDeliveries = Object.keys(locked).sort();
  if (JSON.stringify(declaredDeliveries) !== JSON.stringify(lockedDeliveries)) {
    fail('K4-ASSET-LOCK-001', `Asset ${assetId} lock providers do not match declarations`);
  }
  if (declared.embedded && !sameEmbeddedProvider(declared.embedded, locked.embedded)) {
    fail('K4-ASSET-LOCK-001', `Asset ${assetId} embedded lock locator is stale`);
  }
  if (declared.remote) {
    if (declared.remote.url !== locked.remote.url) {
      fail('K4-ASSET-LOCK-001', `Asset ${assetId} remote lock URL is stale`);
    }
    for (const key of ['transportIntegrity', 'contentType', 'size']) {
      if (declared.remote[key] !== undefined && declared.remote[key] !== locked.remote[key]) {
        fail('K4-ASSET-LOCK-001', `Asset ${assetId} remote lock ${key} is stale`);
      }
    }
  }
}

function resolvedStoryAsset(
  asset: Readonly<Record<string, any>>,
  selected: 'embedded' | 'remote',
  provider: Readonly<Record<string, any>>,
) {
  const result = {...asset, delivery: selected} as Record<string, any>;
  delete result.file;
  delete result.name;
  delete result.source;
  if (selected === 'embedded') {
    if (provider.file) result.file = provider.file;
    else result.name = provider.name;
  } else {
    result.source = {
      url: provider.url,
      integrity: provider.transportIntegrity,
      contentType: provider.contentType,
      size: provider.size,
    };
  }
  return result;
}

/** Resolve one immutable distribution profile without file or network access. */
export function resolveDsl4AssetDistributionProfile(
  storyDocument: Readonly<Record<string, unknown>>,
  inputConfig: unknown,
  inputLock: unknown,
  selectedProfile: string,
) {
  if (storyDocument.kind !== 'StoryDocument' || storyDocument.version !== '4.0') {
    throw new TypeError('asset distribution resolver requires a DSL 4.0 StoryDocument');
  }
  if (typeof selectedProfile !== 'string' || !profileName.test(selectedProfile)) {
    fail('K4-ASSET-PROFILE-001', 'asset distribution profile must be selected explicitly');
  }
  const config = validateDsl4AssetDistributionConfig(inputConfig);
  const lock = validateDsl4AssetDistributionLock(inputLock);
  const profile = config.profiles[selectedProfile] as Readonly<Record<string, any>> | undefined;
  if (!profile) {
    fail('K4-ASSET-PROFILE-001', `asset distribution profile ${selectedProfile} is not defined`);
  }
  const storyAssets = (storyDocument.assets ?? {}) as Readonly<
    Record<string, Readonly<Record<string, any>>>
  >;
  const storyIds = Object.keys(storyAssets).sort();
  const lockIds = Object.keys(lock.assets).sort();
  if (JSON.stringify(storyIds) !== JSON.stringify(lockIds)) {
    fail('K4-ASSET-LOCK-001', 'asset distribution lock must contain every StoryDocument asset');
  }
  for (const assetId of Object.keys(config.providers)) {
    if (!Object.hasOwn(storyAssets, assetId)) {
      fail('K4-ASSET-PROVIDER-001', `provider configuration references unknown asset ${assetId}`);
    }
  }
  for (const assetId of Object.keys(profile.assets ?? {})) {
    if (!Object.hasOwn(storyAssets, assetId)) {
      fail(
        'K4-ASSET-PROFILE-001',
        `profile ${selectedProfile} references unknown asset ${assetId}`,
      );
    }
  }

  const resolution: Record<string, any>[] = [];
  const resolvedAssets = Object.fromEntries(
    storyIds.map((assetId) => {
      const asset = storyAssets[assetId];
      const lockAssetEntry = lock.assets[assetId] as Readonly<Record<string, any>> | undefined;
      if (!lockAssetEntry || lockAssetEntry.kind !== asset.kind) {
        fail('K4-ASSET-LOCK-001', `Asset ${assetId} lock kind is stale`);
      }
      const declared = declaredProviders(assetId, storyProvider(asset), config.providers[assetId]);
      bindProviders(assetId, declared, lockAssetEntry.providers);
      const selected = (profile.assets?.[assetId] ??
        profile.kinds?.[asset.kind] ??
        profile.defaultDelivery ??
        asset.delivery) as 'embedded' | 'remote';
      if (profile.network === 'forbidden' && selected === 'remote') {
        fail(
          'K4-ASSET-OFFLINE-001',
          `Profile ${selectedProfile} forbids network but asset ${assetId} resolves to remote`,
        );
      }
      const provider = lockAssetEntry.providers[selected];
      if (!provider) {
        fail('K4-ASSET-PROVIDER-001', `Asset ${assetId} has no ${selected} provider`);
      }
      const resolved = resolvedStoryAsset(asset, selected, provider);
      resolution.push({
        id: assetId,
        kind: asset.kind,
        delivery: selected,
        contentIntegrity: lockAssetEntry.contentIntegrity,
        contentType: lockAssetEntry.contentType,
        size: lockAssetEntry.size,
        provider:
          selected === 'embedded'
            ? provider.file
              ? {type: 'file', file: provider.file}
              : {type: 'project', name: provider.name}
            : {
                type: 'remote',
                url: provider.url,
                integrity: provider.transportIntegrity,
                contentType: provider.contentType,
                size: provider.size,
              },
      });
      return [assetId, resolved];
    }),
  );
  const canonicalResolution = JSON.stringify({
    formatVersion: dsl4AssetDistributionFormatVersion,
    profile: selectedProfile,
    network: profile.network,
    assets: resolution,
  });
  return deepFreeze({
    formatVersion: dsl4AssetDistributionFormatVersion,
    profile: selectedProfile,
    network: profile.network,
    storyDocument: {...storyDocument, assets: resolvedAssets},
    assets: resolution,
    canonicalResolution,
  });
}

function resolutionProvider(input: unknown, name: string) {
  const provider = record(input, name, 'K4-ASSET-DISTRIBUTION-001');
  if (provider.type === 'file') {
    strictKeys(
      provider,
      new Set(['file', 'type']),
      ['file', 'type'],
      name,
      'K4-ASSET-DISTRIBUTION-001',
    );
    return {
      type: 'file',
      file: safeRelativePath(provider.file, `${name}.file`, 'K4-ASSET-DISTRIBUTION-001'),
    };
  }
  if (provider.type === 'project') {
    strictKeys(
      provider,
      new Set(['name', 'type']),
      ['name', 'type'],
      name,
      'K4-ASSET-DISTRIBUTION-001',
    );
    return {
      type: 'project',
      name: nonEmptyString(provider.name, `${name}.name`, 'K4-ASSET-DISTRIBUTION-001'),
    };
  }
  if (provider.type === 'remote') {
    strictKeys(
      provider,
      new Set(['contentType', 'integrity', 'size', 'type', 'url']),
      ['contentType', 'integrity', 'size', 'type', 'url'],
      name,
      'K4-ASSET-DISTRIBUTION-001',
    );
    return {
      type: 'remote',
      url: httpsUrl(provider.url, `${name}.url`, 'K4-ASSET-DISTRIBUTION-001'),
      integrity: integrity(provider.integrity, `${name}.integrity`, 'K4-ASSET-DISTRIBUTION-001'),
      contentType: contentType(
        provider.contentType,
        `${name}.contentType`,
        'K4-ASSET-DISTRIBUTION-001',
      ),
      size: safeSize(provider.size, `${name}.size`, 'K4-ASSET-DISTRIBUTION-001', 1),
    };
  }
  fail('K4-ASSET-DISTRIBUTION-001', `${name}.type is invalid`);
}

/** Validate the immutable resolution persisted into a built runtime component. */
export function validateDsl4AssetDistributionResolution(
  sourceStoryDocument: Readonly<Record<string, unknown>>,
  input: unknown,
) {
  if (sourceStoryDocument.kind !== 'StoryDocument' || sourceStoryDocument.version !== '4.0') {
    throw new TypeError('asset distribution resolution requires a DSL 4.0 StoryDocument');
  }
  const resolution = record(input, 'asset distribution resolution', 'K4-ASSET-DISTRIBUTION-001');
  strictKeys(
    resolution,
    resolutionKeys,
    [...resolutionKeys],
    'asset distribution resolution',
    'K4-ASSET-DISTRIBUTION-001',
  );
  if (resolution.formatVersion !== dsl4AssetDistributionFormatVersion) {
    fail('K4-ASSET-DISTRIBUTION-001', 'asset distribution resolution formatVersion must be 1');
  }
  if (typeof resolution.profile !== 'string' || !profileName.test(resolution.profile)) {
    fail('K4-ASSET-DISTRIBUTION-001', 'asset distribution resolution profile is invalid');
  }
  if (!networkPolicies.has(String(resolution.network))) {
    fail('K4-ASSET-DISTRIBUTION-001', 'asset distribution resolution network is invalid');
  }
  const resolvedStory = record(
    resolution.storyDocument,
    'asset distribution resolution storyDocument',
    'K4-ASSET-DISTRIBUTION-001',
  );
  if (resolvedStory.kind !== 'StoryDocument' || resolvedStory.version !== '4.0') {
    fail('K4-ASSET-DISTRIBUTION-001', 'resolved storyDocument must be DSL 4.0');
  }
  const sourceWithoutAssets = structuredClone(sourceStoryDocument) as Record<string, unknown>;
  const resolvedWithoutAssets = structuredClone(resolvedStory) as Record<string, unknown>;
  delete sourceWithoutAssets.assets;
  delete resolvedWithoutAssets.assets;
  if (JSON.stringify(sourceWithoutAssets) !== JSON.stringify(resolvedWithoutAssets)) {
    fail('K4-ASSET-DISTRIBUTION-001', 'resolved storyDocument changes non-asset story data');
  }
  const sourceAssets = record(
    sourceStoryDocument.assets ?? {},
    'source assets',
    'K4-ASSET-DISTRIBUTION-001',
  );
  const resolvedAssets = record(
    resolvedStory.assets ?? {},
    'resolved assets',
    'K4-ASSET-DISTRIBUTION-001',
  );
  const sourceIds = Object.keys(sourceAssets).sort();
  if (JSON.stringify(sourceIds) !== JSON.stringify(Object.keys(resolvedAssets).sort())) {
    fail('K4-ASSET-DISTRIBUTION-001', 'resolved storyDocument asset IDs do not match source');
  }
  if (!Array.isArray(resolution.assets)) {
    fail('K4-ASSET-DISTRIBUTION-001', 'asset distribution resolution assets must be an array');
  }
  const normalizedAssets = resolution.assets.map((candidate, index) => {
    const asset = record(candidate, `resolution.assets[${index}]`, 'K4-ASSET-DISTRIBUTION-001');
    strictKeys(
      asset,
      resolutionAssetKeys,
      [...resolutionAssetKeys],
      `resolution.assets[${index}]`,
      'K4-ASSET-DISTRIBUTION-001',
    );
    const id = nonEmptyString(
      asset.id,
      `resolution.assets[${index}].id`,
      'K4-ASSET-DISTRIBUTION-001',
    );
    const sourceAsset = record(
      sourceAssets[id],
      `source assets.${id}`,
      'K4-ASSET-DISTRIBUTION-001',
    );
    const resolvedAsset = record(
      resolvedAssets[id],
      `resolved assets.${id}`,
      'K4-ASSET-DISTRIBUTION-001',
    );
    if (
      asset.kind !== sourceAsset.kind ||
      asset.kind !== resolvedAsset.kind ||
      !deliveryPolicies.has(String(asset.delivery))
    ) {
      fail('K4-ASSET-DISTRIBUTION-001', `resolution asset ${id} metadata is stale`);
    }
    const normalized = {
      id,
      kind: String(asset.kind),
      delivery: asset.delivery as 'embedded' | 'remote',
      contentIntegrity: integrity(
        asset.contentIntegrity,
        `resolution.assets[${index}].contentIntegrity`,
        'K4-ASSET-DISTRIBUTION-001',
      ),
      contentType: contentType(
        asset.contentType,
        `resolution.assets[${index}].contentType`,
        'K4-ASSET-DISTRIBUTION-001',
      ),
      size: safeSize(
        asset.size,
        `resolution.assets[${index}].size`,
        'K4-ASSET-DISTRIBUTION-001',
        0,
      ),
      provider: resolutionProvider(asset.provider, `resolution.assets[${index}].provider`),
    };
    if (normalized.delivery === 'embedded') {
      if (normalized.provider.type === 'remote' || resolvedAsset.delivery !== 'embedded') {
        fail('K4-ASSET-DISTRIBUTION-001', `resolution asset ${id} embedded provider is stale`);
      }
      const expected =
        normalized.provider.type === 'file'
          ? {file: normalized.provider.file}
          : {name: normalized.provider.name};
      if (
        JSON.stringify(
          Object.fromEntries(
            Object.entries(resolvedAsset).filter(([key]) => key === 'file' || key === 'name'),
          ),
        ) !== JSON.stringify(expected)
      ) {
        fail('K4-ASSET-DISTRIBUTION-001', `resolution asset ${id} embedded locator is stale`);
      }
    } else {
      if (normalized.provider.type !== 'remote' || resolvedAsset.delivery !== 'remote') {
        fail('K4-ASSET-DISTRIBUTION-001', `resolution asset ${id} remote provider is stale`);
      }
      const resolvedSource = record(
        resolvedAsset.source,
        `resolved assets.${id}.source`,
        'K4-ASSET-DISTRIBUTION-001',
      );
      if (
        resolvedSource.url !== normalized.provider.url ||
        resolvedSource.integrity !== normalized.provider.integrity ||
        resolvedSource.contentType !== normalized.provider.contentType ||
        resolvedSource.size !== normalized.provider.size
      ) {
        fail('K4-ASSET-DISTRIBUTION-001', `resolution asset ${id} remote locator is stale`);
      }
    }
    return normalized;
  });
  const sortedAssets = [...normalizedAssets].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
  if (
    JSON.stringify(normalizedAssets) !== JSON.stringify(sortedAssets) ||
    JSON.stringify(sourceIds) !== JSON.stringify(sortedAssets.map(({id}) => id))
  ) {
    fail('K4-ASSET-DISTRIBUTION-001', 'resolution assets are not canonical');
  }
  const canonicalResolution = JSON.stringify({
    formatVersion: 1,
    profile: resolution.profile,
    network: resolution.network,
    assets: normalizedAssets,
  });
  if (resolution.canonicalResolution !== canonicalResolution) {
    fail('K4-ASSET-DISTRIBUTION-001', 'resolution canonicalResolution is stale');
  }
  return deepFreeze({
    formatVersion: 1,
    profile: resolution.profile,
    network: resolution.network,
    storyDocument: resolvedStory,
    assets: normalizedAssets,
    canonicalResolution,
  });
}
