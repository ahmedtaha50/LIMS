/**
 * The webhook sink (roadmap M23). One POST of the event envelope, signed with the subscription's secret (hmac.ts).
 *
 *   - the destination is checked by the SSRF guard (ssrf.ts) at every attempt, and the request connects to exactly the address that
 *     was checked (the `lookup` below answers with it), so a host name that resolves elsewhere between the check and the connection
 *     (DNS rebinding) cannot redirect the request;
 *   - a redirect is never followed: a 3xx answer is a failed attempt like any answer outside 2xx;
 *   - one attempt lasts at most `timeoutMs`; the receiver's body is read up to 4 KB and discarded.
 */
import http from 'http';
import https from 'https';
import type { LookupFunction } from 'net';
import { signWebhook, SIGNATURE_HEADER } from '../hmac';
import { checkWebhookUrl, type AllowList } from '../ssrf';
import type { SinkOutcome } from './types';

export const WEBHOOK_TIMEOUT_MS = 10_000;

export async function deliverWebhook(
  input: { url: string; secret: string; eventId: string; eventType: string; body: string },
  o: { allowList: AllowList; timeoutMs?: number },
): Promise<SinkOutcome> {
  const dest = await checkWebhookUrl(input.url, o.allowList); // throws DestinationError: the dispatcher records it as the attempt's error
  const lookup: LookupFunction = (_host, opts, cb) => {
    if ((opts as { all?: boolean }).all) (cb as any)(null, [{ address: dest.address, family: dest.family }]);
    else cb(null, dest.address, dest.family);
  };
  const client = dest.url.protocol === 'https:' ? https : http;
  return new Promise<SinkOutcome>((resolve) => {
    let settled = false;
    const done = (r: SinkOutcome) => { if (!settled) { settled = true; resolve(r); } };
    const req = client.request(dest.url, {
      method: 'POST',
      lookup,
      timeout: o.timeoutMs ?? WEBHOOK_TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(input.body),
        'User-Agent': 'B-Pharma-LIMS-Webhook/1',
        'X-LIMS-Event-Id': input.eventId,
        'X-LIMS-Event-Type': input.eventType,
        [SIGNATURE_HEADER]: signWebhook(input.secret, input.body),
      },
    }, (res) => {
      let read = 0;
      res.on('data', (c: Buffer) => { read += c.length; if (read > 4096) res.destroy(); });
      const finish = () => {
        const status = res.statusCode ?? 0;
        done(status >= 200 && status < 300
          ? { ok: true, statusCode: status }
          : { ok: false, statusCode: status, error: status >= 300 && status < 400 ? `HTTP ${status}: redirects are not followed` : `HTTP ${status}` });
      };
      res.on('end', finish);
      res.on('close', finish);
      res.on('error', finish);
    });
    req.on('timeout', () => { req.destroy(new Error(`no answer within ${o.timeoutMs ?? WEBHOOK_TIMEOUT_MS} ms`)); });
    req.on('error', (err) => done({ ok: false, error: err.message }));
    req.end(input.body);
  });
}
