import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Time-based one-time passwords, RFC 6238 (HMAC-SHA1, 30 s, 6 digits), as authenticator apps implement them. */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const b of buf) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, '').replace(/\s/g, '').toUpperCase();
  let bits = 0, value = 0; const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('not base32');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
export const newSecret = () => base32Encode(randomBytes(20));

export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', secret).update(msg).digest();
  const off = h[h.length - 1]! & 15;
  const bin = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!;
  return String(bin % 10 ** digits).padStart(digits, '0');
}
export const totp = (secretB32: string, at = Date.now(), digits = 6) => hotp(base32Decode(secretB32), Math.floor(at / 30_000), digits);

/** Accepts the code of this 30-second step or of the one before or after (clock drift of the phone). */
export function verifyTotp(secretB32: string, code: string, at = Date.now()): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const key = base32Decode(secretB32), step = Math.floor(at / 30_000);
  return [-1, 0, 1].some(d => timingSafeEqual(Buffer.from(hotp(key, step + d)), Buffer.from(code)));
}
export const otpauthUrl = (secret: string, account: string, issuer = 'B-Pharma EBR') =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
