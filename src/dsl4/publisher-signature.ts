import {fromByteArray, toByteArray} from 'base64-js';

import {decodeDsl4Envelope, Dsl4FormatError, dsl4FormatVersions} from './format-versions.js';
import {deepFreeze} from './story-document.js';

/**
 * Publisher signatures: who made a runtime component, and that nothing changed it since.
 *
 * The publisher signs the whole runtime component (everything but the signature itself, in a
 * canonical key order) with ECDSA P-256 / SHA-256 and stores the public key next to the
 * signature. Any change after signing fails verification. Who signed is shown as the SHA-256
 * fingerprint of that public key; the viewer compares it with the fingerprint the publisher
 * announces elsewhere. The key travels with the artifact, so the signature alone does not prove
 * identity: a forger can sign with their own key, and only the fingerprint check catches that.
 */
export const dsl4PublisherSignatureFormatVersion = 1;

const algorithm = 'ecdsa-p256-sha256';
const domain = 'kamishibai-dsl4-runtime-component-signature-v1\n';
const ecdsa = {name: 'ECDSA', namedCurve: 'P-256'} as const;

/** The Web Crypto surface signing needs, taken by injection like the other DSL 4.0 modules. */
export type Dsl4SignatureCrypto = Pick<
  SubtleCrypto,
  'importKey' | 'exportKey' | 'generateKey' | 'sign' | 'verify' | 'digest'
>;

export class Dsl4PublisherSignatureError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: {cause?: unknown}) {
    super(message, options);
    this.name = 'Dsl4PublisherSignatureError';
    this.code = code;
  }
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new Dsl4PublisherSignatureError(code, message, cause === undefined ? undefined : {cause});
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function subtle(crypto?: Dsl4SignatureCrypto): Dsl4SignatureCrypto {
  const value = crypto ?? (globalThis.crypto?.subtle as Dsl4SignatureCrypto | undefined);
  if (!value) fail('K4-SIGNATURE-CRYPTO-001', 'Web Crypto is unavailable');
  return value;
}

/** JSON with object keys sorted at every depth, so writer and reader sign the same bytes. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function signedMessage(component: Readonly<Record<string, unknown>>) {
  const unsigned = Object.fromEntries(
    Object.entries(component).filter(([key]) => key !== 'signature'),
  );
  return new TextEncoder().encode(domain + canonicalJson(unsigned));
}

/** `SHA256:` and the digest of the SPKI public key, in colon-separated hex pairs. */
export async function dsl4PublisherKeyFingerprint(
  publicKeySpki: Uint8Array,
  crypto?: Dsl4SignatureCrypto,
) {
  const digest = new Uint8Array(
    await subtle(crypto).digest('SHA-256', new Uint8Array(publicKeySpki)),
  );
  return `SHA256:${[...digest].map((byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(':')}`;
}

function pem(label: string, bytes: Uint8Array) {
  const body = fromByteArray(bytes)
    .replace(/(.{64})/gu, '$1\n')
    .trimEnd();
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

function unpem(label: string, text: string) {
  const match = new RegExp(
    `-----BEGIN ${label}-----([A-Za-z0-9+/=\\s]+)-----END ${label}-----`,
    'u',
  ).exec(text);
  if (!match) fail('K4-SIGNATURE-KEY-001', `Expected a PEM ${label}`);
  try {
    return toByteArray(match[1]!.replace(/\s+/gu, ''));
  } catch (error) {
    fail('K4-SIGNATURE-KEY-001', `The PEM ${label} is not base64`, error);
  }
}

/** Make a new signing key pair: the private key stays with the publisher, the fingerprint is announced. */
export async function generateDsl4SigningKeyPair(crypto?: Dsl4SignatureCrypto) {
  const keys = (await subtle(crypto).generateKey(ecdsa, true, ['sign', 'verify'])) as CryptoKeyPair;
  const privateKey = new Uint8Array(await subtle(crypto).exportKey('pkcs8', keys.privateKey));
  const publicKey = new Uint8Array(await subtle(crypto).exportKey('spki', keys.publicKey));
  return deepFreeze({
    privateKeyPem: pem('PRIVATE KEY', privateKey),
    publicKeyPem: pem('PUBLIC KEY', publicKey),
    fingerprint: await dsl4PublisherKeyFingerprint(publicKey, crypto),
  });
}

/** Read a PKCS#8 PEM private key and the public key that belongs to it. */
export async function importDsl4SigningKey(privateKeyPem: string, crypto?: Dsl4SignatureCrypto) {
  const pkcs8 = unpem('PRIVATE KEY', privateKeyPem);
  let privateKey: CryptoKey;
  try {
    privateKey = await subtle(crypto).importKey('pkcs8', new Uint8Array(pkcs8), ecdsa, true, [
      'sign',
    ]);
  } catch (error) {
    fail('K4-SIGNATURE-KEY-001', 'The signing key is not an ECDSA P-256 private key', error);
  }
  // The public half is the private JWK without `d`; Web Crypto has no direct derivation.
  const {kty, crv, x, y} = (await subtle(crypto).exportKey('jwk', privateKey)) as JsonWebKey;
  if (!kty || !crv || !x || !y) fail('K4-SIGNATURE-KEY-001', 'The signing key has no public point');
  const publicJwk: JsonWebKey = {kty, crv, x, y};
  const publicKey = await subtle(crypto).importKey('jwk', publicJwk, ecdsa, true, ['verify']);
  const publicKeySpki = new Uint8Array(await subtle(crypto).exportKey('spki', publicKey));
  return {privateKey, publicKeySpki};
}

/** Sign a runtime component in place; an existing signature is replaced. */
export async function signDsl4RuntimeComponent(
  component: Record<string, unknown>,
  key: {privateKey: CryptoKey; publicKeySpki: Uint8Array},
  crypto?: Dsl4SignatureCrypto,
) {
  delete component.signature;
  const signature = new Uint8Array(
    await subtle(crypto).sign(
      {name: 'ECDSA', hash: 'SHA-256'},
      key.privateKey,
      signedMessage(component),
    ),
  );
  component.signature = {
    formatVersion: dsl4PublisherSignatureFormatVersion,
    algorithm,
    publicKey: fromByteArray(key.publicKeySpki),
    signature: fromByteArray(signature),
  };
  return dsl4PublisherKeyFingerprint(key.publicKeySpki, crypto);
}

/**
 * Verify a runtime component's signature. Returns `null` for an unsigned component and the
 * publisher's key fingerprint for a valid signature; a malformed or failing signature throws.
 */
export async function verifyDsl4RuntimeComponentSignature(
  component: Readonly<Record<string, unknown>>,
  crypto?: Dsl4SignatureCrypto,
) {
  if (component.signature === undefined) return null;
  let value;
  try {
    value = decodeDsl4Envelope(component.signature, {
      kind: 'publisherSignature',
      requiredKeys: ['algorithm', 'publicKey', 'signature'],
    });
  } catch (error) {
    if (error instanceof Dsl4FormatError) fail(error.code, error.message, error);
    throw error;
  }
  if (dsl4FormatVersions.publisherSignature !== dsl4PublisherSignatureFormatVersion)
    throw new TypeError('Publisher signature format index is inconsistent');
  if (value.algorithm !== algorithm)
    fail('K4-SIGNATURE-001', `Publisher signature algorithm must be ${algorithm}`);
  let publicKeySpki: Uint8Array;
  let signature: Uint8Array;
  try {
    publicKeySpki = toByteArray(String(value.publicKey));
    signature = toByteArray(String(value.signature));
  } catch (error) {
    fail('K4-SIGNATURE-001', 'Publisher signature fields must be base64', error);
  }
  let publicKey: CryptoKey;
  try {
    publicKey = await subtle(crypto).importKey(
      'spki',
      new Uint8Array(publicKeySpki),
      ecdsa,
      false,
      ['verify'],
    );
  } catch (error) {
    fail('K4-SIGNATURE-001', 'Publisher public key is not an ECDSA P-256 key', error);
  }
  const valid = await subtle(crypto).verify(
    {name: 'ECDSA', hash: 'SHA-256'},
    publicKey,
    new Uint8Array(signature),
    signedMessage(component),
  );
  if (!valid) fail('K4-SIGNATURE-INVALID-001', 'The publisher signature does not match this story');
  return deepFreeze({
    algorithm,
    fingerprint: await dsl4PublisherKeyFingerprint(publicKeySpki, crypto),
  });
}

/** The runtime component a project stores, in whichever channel holds its control artifact. */
export function findDsl4RuntimeComponentStorage(project: unknown) {
  const storage =
    isRecord(project) && isRecord(project.extensionStorage) ? project.extensionStorage : {};
  const runtime = isRecord(storage.kubohiroyakamishibairuntime4)
    ? storage.kubohiroyakamishibairuntime4
    : null;
  const bundle = isRecord(storage.kubohiroyakamishibai4) ? storage.kubohiroyakamishibai4 : {};
  const components = isRecord(bundle.components) ? bundle.components : {};
  const bundled = isRecord(components.kubohiroyakamishibairuntime4)
    ? components.kubohiroyakamishibairuntime4
    : null;
  const found = [runtime, bundled].filter(
    (owner): owner is Record<string, unknown> => owner !== null && owner.artifact !== undefined,
  );
  return found.length === 1 ? found[0]! : null;
}
