/**
 * Keystore (roadmap M16): one master key per generation, purpose keys derived from it with HKDF, and field encryption whose
 * ciphertext names the generation that wrote it, so a key can be rotated while older data stays readable.
 *
 *   key ring        { current: 2, keys: { 1: <master 1>, 2: <master 2> } }   new data is written with `current`; every generation stays readable
 *   purpose key     HKDF-SHA256(master, salt "bplims/keystore/v1", info "<purpose>[/<label>]") -> 32 bytes
 *                   purposes: jwt (token signing, one label per token type), field-enc (database fields), audit-hmac and
 *                   backup-wrap (reserved for the audit and backup tracks). A key for one purpose says nothing about another.
 *   ciphertext      v<generation>:<iv>:<tag>:<data>   AES-256-GCM, random 96-bit IV, base64url parts; the context string
 *                   (for example "users.totp_secret:usr-1") is authenticated, so a value copied to another row or column fails to decrypt
 *
 * Where the master key comes from (keyRingFromEnv): LIMS_KEYRING (JSON, for a rotation in progress), else LIMS_MASTER_KEY (generation 1),
 * else JWT_SECRET (generation 1; the fallback that keeps an installation without a separate master key working. Rotating JWT_SECRET
 * then makes the stored secrets unreadable, which is why the desktop shell should pass LIMS_MASTER_KEY from the OS credential store).
 * No key is ever written to a log or an error message.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'crypto';

export const KEY_PURPOSES = ['jwt', 'field-enc', 'audit-hmac', 'backup-wrap'] as const;
export type KeyPurpose = (typeof KEY_PURPOSES)[number];

export class KeystoreError extends Error {
  constructor(message: string) { super(message); this.name = 'KeystoreError'; }
}

export interface KeyRing {
  /** Generation used for everything written from now on. */
  current: number;
  /** Master key material by generation. Every generation still in use must be present. */
  keys: Record<number, string>;
}

export interface Keystore {
  readonly current: number;
  readonly generations: number[];
  /** 32-byte key for `purpose` (and optional `label`) from the master key of `generation` (default: current). */
  deriveKey(purpose: KeyPurpose, label?: string, generation?: number): Buffer;
  encrypt(plaintext: string, context: string): string;
  decrypt(ciphertext: string, context: string): string;
  /** True for a value in this module's ciphertext format (any generation). */
  isEncrypted(value: string | null | undefined): boolean;
  /** The generation that wrote `ciphertext`. */
  generationOf(ciphertext: string): number;
  /** `ciphertext` written with the current generation; returned unchanged if it already is. */
  reencrypt(ciphertext: string, context: string): string;
}

const SALT = Buffer.from('bplims/keystore/v1');
const MIN_KEY_LENGTH = 16; // sanity floor for any key; a stand-alone LIMS_MASTER_KEY must have 32
const FORMAT = /^v([1-9]\d{0,5}):([A-Za-z0-9_-]+):([A-Za-z0-9_-]+):([A-Za-z0-9_-]*)$/;

export function createKeystore(ring: KeyRing): Keystore {
  const generations = Object.keys(ring.keys ?? {}).map(Number).filter(Number.isInteger).sort((a, b) => a - b);
  if (generations.length === 0) throw new KeystoreError('The key ring is empty.');
  for (const g of generations) {
    if (g < 1) throw new KeystoreError('Key generations start at 1.');
    const material = ring.keys[g];
    if (typeof material !== 'string' || material.length < MIN_KEY_LENGTH) throw new KeystoreError(`Key generation ${g} is missing or shorter than ${MIN_KEY_LENGTH} characters.`);
  }
  if (!generations.includes(ring.current)) throw new KeystoreError(`The current key generation (${ring.current}) is not in the key ring.`);

  const cache = new Map<string, Buffer>();
  const deriveKey: Keystore['deriveKey'] = (purpose, label = '', generation = ring.current) => {
    if (!generations.includes(generation)) throw new KeystoreError(`Key generation ${generation} is not in the key ring.`);
    const id = `${generation}|${purpose}|${label}`;
    let key = cache.get(id);
    if (!key) {
      key = Buffer.from(hkdfSync('sha256', Buffer.from(ring.keys[generation], 'utf8'), SALT, Buffer.from(label ? `${purpose}/${label}` : purpose), 32));
      cache.set(id, key);
    }
    return Buffer.from(key); // a copy: callers cannot alter the cached key
  };

  const parse = (ciphertext: string) => {
    const m = typeof ciphertext === 'string' ? FORMAT.exec(ciphertext) : null;
    if (!m) throw new KeystoreError('The value is not keystore ciphertext.');
    return { generation: Number(m[1]), iv: Buffer.from(m[2], 'base64url'), tag: Buffer.from(m[3], 'base64url'), data: Buffer.from(m[4], 'base64url') };
  };

  const decrypt: Keystore['decrypt'] = (ciphertext, context) => {
    const { generation, iv, tag, data } = parse(ciphertext);
    if (!generations.includes(generation)) throw new KeystoreError(`The value was written with key generation ${generation}, which is not in the key ring.`);
    try {
      const d = createDecipheriv('aes-256-gcm', deriveKey('field-enc', '', generation), iv);
      d.setAAD(Buffer.from(context, 'utf8'));
      d.setAuthTag(tag);
      return Buffer.concat([d.update(data), d.final()]).toString('utf8');
    } catch {
      throw new KeystoreError('The value could not be decrypted (wrong key, altered data, or it belongs to another record).');
    }
  };

  const encrypt: Keystore['encrypt'] = (plaintext, context) => {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', deriveKey('field-enc'), iv);
    c.setAAD(Buffer.from(context, 'utf8'));
    const data = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
    return `v${ring.current}:${iv.toString('base64url')}:${c.getAuthTag().toString('base64url')}:${data.toString('base64url')}`;
  };

  return {
    current: ring.current,
    generations,
    deriveKey,
    encrypt,
    decrypt,
    isEncrypted: value => typeof value === 'string' && FORMAT.test(value),
    generationOf: ciphertext => parse(ciphertext).generation,
    reencrypt: (ciphertext, context) => (parse(ciphertext).generation === ring.current ? ciphertext : encrypt(decrypt(ciphertext, context), context)),
  };
}

type Env = Record<string, string | undefined>;

/** LIMS_KEYRING, else LIMS_MASTER_KEY, else JWT_SECRET. Throws KeystoreError when none is usable. */
export function keyRingFromEnv(env: Env = process.env): KeyRing {
  const keyring = env.LIMS_KEYRING;
  if (keyring) {
    let parsed: any;
    try { parsed = JSON.parse(keyring); } catch { throw new KeystoreError('LIMS_KEYRING is not valid JSON.'); }
    const keys: Record<number, string> = {};
    for (const [g, material] of Object.entries(parsed?.keys ?? {})) {
      // 16, not 32: generation 1 is typically the JWT_SECRET the installation started with (the 32-character rule for that is in config.ts)
      if (!/^[1-9]\d*$/.test(g) || typeof material !== 'string' || material.length < MIN_KEY_LENGTH) throw new KeystoreError(`LIMS_KEYRING: key ${g} must be a string of at least ${MIN_KEY_LENGTH} characters.`);
      keys[Number(g)] = material;
    }
    if (!Number.isInteger(parsed?.current)) throw new KeystoreError('LIMS_KEYRING: "current" must be an integer generation.');
    return { current: parsed.current, keys };
  }
  if (env.LIMS_MASTER_KEY) {
    if (env.LIMS_MASTER_KEY.length < 32) throw new KeystoreError('LIMS_MASTER_KEY must be at least 32 characters.');
    return { current: 1, keys: { 1: env.LIMS_MASTER_KEY } };
  }
  if (env.JWT_SECRET) return { current: 1, keys: { 1: env.JWT_SECRET } };
  throw new KeystoreError('No key material is configured: set LIMS_MASTER_KEY (or LIMS_KEYRING, or at least JWT_SECRET).');
}

let instance: Keystore | null = null;

/**
 * The process-wide keystore, built from the environment on first use. With no key material at all, development and test runs get a
 * random key for this process (sessions and encrypted fields then do not survive a restart); any other environment, production
 * included, refuses to start. There is no built-in key.
 */
export function getKeystore(): Keystore {
  if (instance) return instance;
  const env = process.env;
  const ephemeral = !env.LIMS_KEYRING && !env.LIMS_MASTER_KEY && !env.JWT_SECRET && (env.NODE_ENV === 'development' || env.NODE_ENV === 'test');
  return (instance = createKeystore(ephemeral ? { current: 1, keys: { 1: randomBytes(32).toString('hex') } } : keyRingFromEnv()));
}

/** Replaces (or, with null, resets) the process-wide keystore. For tests and for tools that run with a different ring. */
export function setKeystore(keystore: Keystore | null): void {
  instance = keystore;
}
