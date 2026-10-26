/**
 * Roadmap M23 (r2-events): the SSRF guard of outbound webhooks and the HMAC signature.
 * Deny by default: a destination must be in the LAN allow-list; link-local, cloud metadata, unspecified, multicast and broadcast
 * addresses are refused whatever the allow-list says (so "0.0.0.0/0" cannot open 169.254.169.254).
 */
import { describe, expect, it } from 'vitest';
import { checkAddress, checkWebhookUrl, parseAllowList } from '../../../src/server/events/ssrf';
import { signWebhook, verifyWebhookSignature } from '../../../src/server/events/hmac';

const allow = (s: string) => parseAllowList(s);

describe('checkAddress', () => {
  it('never allows link-local, metadata, unspecified, multicast or broadcast addresses', () => {
    for (const ip of ['169.254.169.254', '169.254.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', 'fe80::1', '::', 'ff02::1', '::ffff:169.254.169.254', 'fd00:ec2::254']) {
      expect(() => checkAddress(ip, allow('0.0.0.0/0,::/0')), ip).toThrow(/never allowed/);
    }
  });
  it('allows an address only inside the allow-list', () => {
    expect(() => checkAddress('127.0.0.1', allow(''))).toThrow(/allow-list/);
    expect(() => checkAddress('10.1.2.3', allow('10.0.0.0/8'))).not.toThrow();
    expect(() => checkAddress('10.1.2.3', allow('192.168.0.0/16'))).toThrow(/allow-list/);
    expect(() => checkAddress('192.168.4.20', allow('192.168.4.20'))).not.toThrow();
    expect(() => checkAddress('::ffff:10.1.2.3', allow('10.0.0.0/8'))).not.toThrow();
    expect(() => checkAddress('fd12::5', allow('fd12::/16'))).not.toThrow();
    expect(() => checkAddress('8.8.8.8', allow('10.0.0.0/8'))).toThrow(/allow-list/);
  });
  it('rejects a malformed allow-list entry instead of ignoring it', () => {
    expect(() => parseAllowList('10.0.0.0/33')).toThrow();
    expect(() => parseAllowList('not-an-address')).toThrow();
  });
});

describe('checkWebhookUrl', () => {
  it('accepts http and https without credentials, resolves names, and refuses the rest', async () => {
    const a = allow('127.0.0.1/32');
    await expect(checkWebhookUrl('http://127.0.0.1:8080/hook', a)).resolves.toMatchObject({ address: '127.0.0.1' });
    // localhost may resolve to ::1 as well as (or instead of) 127.0.0.1; every resolved address must be allowed
    const loopback = allow('127.0.0.1/32,::1/128');
    expect(['127.0.0.1', '::1']).toContain((await checkWebhookUrl('http://localhost:8080/hook', loopback)).address);
    await expect(checkWebhookUrl('http://169.254.169.254/latest/meta-data', allow('0.0.0.0/0'))).rejects.toThrow(/169\.254\.169\.254/);
    await expect(checkWebhookUrl('http://[::ffff:a9fe:a9fe]/', allow('0.0.0.0/0,::/0'))).rejects.toThrow(/never allowed/);
    await expect(checkWebhookUrl('http://user:pw@127.0.0.1/hook', a)).rejects.toThrow(/credentials/);
    await expect(checkWebhookUrl('ftp://127.0.0.1/hook', a)).rejects.toThrow(/http/);
    await expect(checkWebhookUrl('not a url', a)).rejects.toThrow();
  });
});

describe('webhook signature', () => {
  it('signs the timestamp and the exact body; verification fails on any change and outside the tolerance', () => {
    const body = '{"id":"evt-1"}';
    const header = signWebhook('whsec_secret', body, 1_760_000_000);
    expect(header).toMatch(/^t=1760000000,v1=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature('whsec_secret', header, body, { now: 1_760_000_100 })).toBe(true);
    expect(verifyWebhookSignature('whsec_secret', header, body + ' ', { now: 1_760_000_100 })).toBe(false);
    expect(verifyWebhookSignature('whsec_other', header, body, { now: 1_760_000_100 })).toBe(false);
    expect(verifyWebhookSignature('whsec_secret', header, body, { now: 1_760_000_000 + 3600 })).toBe(false);
    expect(verifyWebhookSignature('whsec_secret', 'garbage', body)).toBe(false);
  });
});
