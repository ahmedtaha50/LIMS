/**
 * Webhook signatures (roadmap M23). Every delivery carries
 *
 *   X-LIMS-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
 *
 * The receiver recomputes the HMAC over the raw body it received with the subscription's secret, compares in constant time and refuses
 * a timestamp older than its tolerance (a replayed request). X-LIMS-Event-Id is the same on every attempt of one event, so a receiver
 * that answered 200 but whose answer was lost can tell the retry is a duplicate.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

export const SIGNATURE_HEADER = 'X-LIMS-Signature';
export const DEFAULT_TOLERANCE_SECONDS = 300;

/** A new webhook secret: 32 random bytes. Shown once to the Administrator; stored only as keystore ciphertext. */
export const newWebhookSecret = () => `whsec_${randomBytes(32).toString('base64url')}`;

const mac = (secret: string, t: number, body: string) => createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');

export function signWebhook(secret: string, body: string, timestampSeconds = Math.floor(Date.now() / 1000)): string {
  return `t=${timestampSeconds},v1=${mac(secret, timestampSeconds, body)}`;
}

export function verifyWebhookSignature(secret: string, header: string, body: string, o: { now?: number; toleranceSeconds?: number } = {}): boolean {
  const m = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(header ?? '');
  if (!m) return false;
  const t = Number(m[1]);
  const now = o.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > (o.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS)) return false;
  const expected = Buffer.from(mac(secret, t, body), 'hex');
  const given = Buffer.from(m[2], 'hex');
  return expected.length === given.length && timingSafeEqual(expected, given);
}
