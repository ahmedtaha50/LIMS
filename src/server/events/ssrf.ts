/**
 * The SSRF guard of outbound webhooks (roadmap M23). Deny by default:
 *
 *   - only http: and https: URLs, without credentials in the URL;
 *   - the host is resolved and EVERY address it resolves to must be inside the LAN allow-list (EVENTS_WEBHOOK_ALLOWLIST, a comma
 *     separated list of addresses and CIDR ranges, IPv4 or IPv6); an empty list allows no webhook at all;
 *   - link-local (169.254.0.0/16, fe80::/10, which holds the cloud metadata service 169.254.169.254), unspecified (0.0.0.0/8, ::),
 *     multicast, reserved/broadcast (240.0.0.0/4) and the IPv6 metadata address fd00:ec2::254 are refused whatever the allow-list
 *     says, so an over-wide entry such as 0.0.0.0/0 cannot open them; IPv4-mapped IPv6 forms are checked as the IPv4 address.
 *
 * The check runs when a subscription is created and again before every delivery, against the address the request then actually
 * connects to (dispatcher -> sinks/webhook.ts), so a name that later resolves elsewhere (DNS rebinding) is refused too.
 */
import dns from 'dns/promises';
import net from 'net';

export class DestinationError extends Error {
  constructor(message: string) { super(message); this.name = 'DestinationError'; }
}

export interface AllowList { entries: string[]; list: net.BlockList }

const NEVER = new net.BlockList();
NEVER.addSubnet('0.0.0.0', 8, 'ipv4');
NEVER.addSubnet('169.254.0.0', 16, 'ipv4');
NEVER.addSubnet('224.0.0.0', 4, 'ipv4');
NEVER.addSubnet('240.0.0.0', 4, 'ipv4');
NEVER.addAddress('::', 'ipv6');
NEVER.addSubnet('fe80::', 10, 'ipv6');
NEVER.addSubnet('ff00::', 8, 'ipv6');
NEVER.addAddress('fd00:ec2::254', 'ipv6');

/** '::ffff:10.1.2.3' and '::ffff:a01:203' are the IPv4 address 10.1.2.3. */
function normalize(raw: string): { address: string; family: 'ipv4' | 'ipv6' } {
  const ip = raw.replace(/^\[|\]$/g, '').toLowerCase();
  const dotted = /^(?:0{0,4}:){0,5}:?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip) ?? /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (dotted && net.isIPv4(dotted[1])) return { address: dotted[1], family: 'ipv4' };
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
  if (hex) {
    const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
    return { address: [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.'), family: 'ipv4' };
  }
  if (net.isIPv4(ip)) return { address: ip, family: 'ipv4' };
  if (net.isIPv6(ip)) return { address: ip, family: 'ipv6' };
  throw new DestinationError(`"${raw}" is not an IP address.`);
}

export function parseAllowList(spec: string | readonly string[] | undefined | null): AllowList {
  const entries = (typeof spec === 'string' ? spec.split(',') : [...(spec ?? [])]).map(s => s.trim()).filter(Boolean);
  const list = new net.BlockList();
  for (const entry of entries) {
    const [addr, prefixText, extra] = entry.split('/');
    if (extra !== undefined) throw new DestinationError(`Webhook allow-list entry "${entry}" is not an address or a CIDR range.`);
    let n: { address: string; family: 'ipv4' | 'ipv6' };
    try { n = normalize(addr); } catch { throw new DestinationError(`Webhook allow-list entry "${entry}" is not an address or a CIDR range.`); }
    if (prefixText === undefined) { list.addAddress(n.address, n.family); continue; }
    const prefix = Number(prefixText);
    const max = n.family === 'ipv4' ? 32 : 128;
    if (!/^\d{1,3}$/.test(prefixText) || prefix > max) throw new DestinationError(`Webhook allow-list entry "${entry}" has an invalid prefix length.`);
    list.addSubnet(n.address, prefix, n.family);
  }
  return { entries, list };
}

/** The allow-list configured for this installation. Read on every call, so a changed environment needs no code path of its own. */
export const configuredAllowList = (env: NodeJS.ProcessEnv = process.env): AllowList => parseAllowList(env.EVENTS_WEBHOOK_ALLOWLIST ?? '');

/** Throws DestinationError unless `ip` may be contacted. */
export function checkAddress(ip: string, allow: AllowList): void {
  const n = normalize(ip);
  if (NEVER.check(n.address, n.family)) {
    throw new DestinationError(`${ip} is a link-local, cloud metadata, multicast, reserved or unspecified address and is never allowed as a webhook destination.`);
  }
  if (!allow.list.check(n.address, n.family)) {
    throw new DestinationError(`${ip} is not in the webhook allow-list (EVENTS_WEBHOOK_ALLOWLIST${allow.entries.length ? `: ${allow.entries.join(', ')}` : ' is empty'}).`);
  }
}

export interface CheckedDestination { url: URL; address: string; family: 4 | 6 }

/** Parses and checks a webhook URL, resolving its host. Every resolved address must pass; the first one is the one to connect to. */
export async function checkWebhookUrl(raw: string, allow: AllowList): Promise<CheckedDestination> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new DestinationError('The webhook address is not a valid URL.'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new DestinationError('A webhook address must start with http:// or https://.');
  if (url.username || url.password) throw new DestinationError('A webhook address must not contain credentials; the request is authenticated by its HMAC signature.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new DestinationError('The webhook address has no host.');

  let addresses: Array<{ address: string; family: number }>;
  if (net.isIP(host)) addresses = [{ address: host, family: net.isIPv6(host) ? 6 : 4 }];
  else {
    try { addresses = await dns.lookup(host, { all: true, verbatim: true }); } catch {
      throw new DestinationError(`The webhook host ${host} could not be resolved.`);
    }
    if (addresses.length === 0) throw new DestinationError(`The webhook host ${host} could not be resolved.`);
  }
  for (const a of addresses) checkAddress(a.address, allow);
  return { url, address: addresses[0].address, family: addresses[0].family === 6 ? 6 : 4 };
}
