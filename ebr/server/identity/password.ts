import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const scrypt = (pw: string, salt: Buffer, len: number, o: ScryptOptions) =>
  new Promise<Buffer>((res, rej) => scryptCb(pw, salt, len, o, (e, k) => (e ? rej(e) : res(k))));
const N = 1 << 15, R = 8, P = 1, LEN = 32;

/** scrypt$N$r$p$salt$hash (base64url). The parameters are stored, so they can be raised later without breaking old hashes. */
export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pw.normalize('NFKC'), salt, LEN, { N, r: R, p: P, maxmem: 128 * N * R * 2 });
  return ['scrypt', N, R, P, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, key] = stored.split('$');
  if (alg !== 'scrypt' || !n || !r || !p || !salt || !key) return false;
  const want = Buffer.from(key, 'base64url');
  const got = await scrypt(pw.normalize('NFKC'), Buffer.from(salt, 'base64url'), want.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: 128 * Number(n) * Number(r) * 2 });
  return got.length === want.length && timingSafeEqual(got, want);
}

/** The policy, in one place: at least 12 characters, not the user name. Returns the reason, or null when acceptable. */
export function passwordProblem(pw: string, username: string): string | null {
  if (pw.length < 12) return 'The password must have at least 12 characters.';
  if (pw.toLowerCase().includes(username.toLowerCase())) return 'The password must not contain the user name.';
  return null;
}
