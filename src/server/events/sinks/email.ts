/**
 * The e-mail sink (roadmap M23): the notification text of an event, sent through the site's SMTP relay. A small SMTP client
 * (RFC 5321) is enough here: one message to one recipient per delivery, no attachment.
 *
 *   EVENTS_SMTP_HOST      the relay; without it no e-mail subscription can be created
 *   EVENTS_SMTP_PORT      default 587 (starttls), 465 (tls), 25 (none)
 *   EVENTS_SMTP_SECURITY  starttls (default) | tls | none
 *   EVENTS_SMTP_FROM      the sender address (required)
 *   EVENTS_SMTP_USER / EVENTS_SMTP_PASSWORD   optional AUTH PLAIN, only over an encrypted connection
 *
 * An e-mail is a copy for people who are not signed in. It is not a GxP record and carries what the notification carries: no
 * result value.
 */
import { randomBytes } from 'crypto';
import net from 'net';
import os from 'os';
import tls from 'tls';
import type { SinkOutcome } from './types';

export const SMTP_TIMEOUT_MS = 15_000;
type Security = 'starttls' | 'tls' | 'none';

export interface SmtpConfig { host: string; port: number; security: Security; from: string; user?: string; password?: string }

const ADDRESS = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/;
export const isEmailAddress = (s: string) => s.length <= 254 && ADDRESS.test(s);

/** The relay configuration, or a sentence saying what is missing. */
export function smtpConfig(env: NodeJS.ProcessEnv = process.env): SmtpConfig | string {
  const host = env.EVENTS_SMTP_HOST?.trim();
  if (!host) return 'E-mail delivery is not configured on this server (EVENTS_SMTP_HOST is not set).';
  const security = (env.EVENTS_SMTP_SECURITY?.trim().toLowerCase() || 'starttls') as Security;
  if (!['starttls', 'tls', 'none'].includes(security)) return 'EVENTS_SMTP_SECURITY must be starttls, tls or none.';
  const from = env.EVENTS_SMTP_FROM?.trim() ?? '';
  if (!isEmailAddress(from)) return 'EVENTS_SMTP_FROM must be the sender e-mail address.';
  const port = env.EVENTS_SMTP_PORT ? Number(env.EVENTS_SMTP_PORT) : security === 'tls' ? 465 : security === 'none' ? 25 : 587;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 'EVENTS_SMTP_PORT must be a port number.';
  const user = env.EVENTS_SMTP_USER?.trim() || undefined;
  if (user && security === 'none') return 'SMTP credentials are only sent over an encrypted connection: set EVENTS_SMTP_SECURITY to starttls or tls.';
  return { host, port, security, from, user, password: user ? env.EVENTS_SMTP_PASSWORD ?? '' : undefined };
}

/** Header values never carry a line break (header injection). */
const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();
/** RFC 2047 for a subject that is not plain ASCII. */
const encodeWord = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);

export function buildMessage(c: SmtpConfig, to: string, subject: string, text: string, eventId: string): string {
  const domain = c.from.split('@')[1];
  const headers = [
    `From: ${c.from}`, `To: ${to}`, `Subject: ${encodeWord(oneLine(subject))}`, `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${eventId}.${randomBytes(6).toString('hex')}@${domain}>`, 'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit', 'Auto-Submitted: auto-generated', `X-LIMS-Event-Id: ${eventId}`,
  ];
  // Dot-stuffing (RFC 5321 4.5.2) and CRLF line ends.
  const body = text.replace(/\r?\n/g, '\r\n').split('\r\n').map(l => (l.startsWith('.') ? `.${l}` : l)).join('\r\n');
  return `${headers.join('\r\n')}\r\n\r\n${body}\r\n`;
}

/** Reads SMTP replies (multi-line "250-..." ends with "250 ..."), in order; a reply that arrives before it is awaited is kept. */
class Replies {
  private buf = '';
  private lines: string[] = [];
  private ready: Array<{ code: number; text: string }> = [];
  private waiting: { resolve: (r: { code: number; text: string }) => void; reject: (e: Error) => void } | null = null;
  private failed: Error | null = null;

  attach(sock: net.Socket) {
    sock.setEncoding('utf8');
    sock.on('data', (d: string) => { this.buf += d; this.drain(); });
  }
  fail(e: Error) {
    this.failed ??= e;
    const w = this.waiting; this.waiting = null;
    w?.reject(e);
  }
  private drain() {
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, ''); this.buf = this.buf.slice(i + 1);
      this.lines.push(line);
      if (/^\d{3}(?: |$)/.test(line)) {
        this.ready.push({ code: Number(line.slice(0, 3)), text: this.lines.join('\n') });
        this.lines = [];
      }
    }
    if (this.waiting && this.ready.length) { const w = this.waiting; this.waiting = null; w.resolve(this.ready.shift()!); }
  }
  next(): Promise<{ code: number; text: string }> {
    if (this.ready.length) return Promise.resolve(this.ready.shift()!);
    if (this.failed) return Promise.reject(this.failed);
    return new Promise((resolve, reject) => { this.waiting = { resolve, reject }; });
  }
}

class SmtpError extends Error { constructor(readonly code: number, message: string) { super(message); } }

export async function deliverEmail(input: { to: string; subject: string; text: string; eventId: string }, env: NodeJS.ProcessEnv = process.env): Promise<SinkOutcome> {
  const c = smtpConfig(env);
  if (typeof c === 'string') return { ok: false, error: c };
  if (!isEmailAddress(input.to)) return { ok: false, error: `${input.to} is not an e-mail address.` };

  let sock: net.Socket | null = null;
  const replies = new Replies();
  const timer = setTimeout(() => { const e = new Error(`the SMTP relay did not answer within ${SMTP_TIMEOUT_MS} ms`); replies.fail(e); sock?.destroy(); }, SMTP_TIMEOUT_MS);
  const expect = async (want: number[], what: string) => {
    const r = await replies.next();
    if (!want.includes(r.code)) throw new SmtpError(r.code, `SMTP ${what}: ${r.text.slice(0, 300)}`);
    return r;
  };
  const send = (line: string) => { sock!.write(`${line}\r\n`); };
  const connect = (): Promise<net.Socket> => new Promise((resolve, reject) => {
    const s = c.security === 'tls' ? tls.connect({ host: c.host, port: c.port, servername: c.host }) : net.connect({ host: c.host, port: c.port });
    s.once(c.security === 'tls' ? 'secureConnect' : 'connect', () => resolve(s));
    s.once('error', reject);
  });
  const ehlo = async () => { send(`EHLO ${oneLine(os.hostname()) || 'lims'}`); return expect([250], 'EHLO'); };

  try {
    sock = await connect();
    sock.on('error', (e) => replies.fail(e));
    replies.attach(sock);
    await expect([220], 'greeting');
    let caps = await ehlo();
    if (c.security === 'starttls') {
      if (!/STARTTLS/i.test(caps.text)) throw new Error('the SMTP relay does not offer STARTTLS (set EVENTS_SMTP_SECURITY=none only on a trusted network)');
      send('STARTTLS');
      await expect([220], 'STARTTLS');
      const plain = sock;
      plain.removeAllListeners('data');
      sock = await new Promise<net.Socket>((resolve, reject) => {
        const s = tls.connect({ socket: plain, servername: c.host }, () => resolve(s));
        s.once('error', reject);
      });
      sock.on('error', (e) => replies.fail(e));
      replies.attach(sock);
      caps = await ehlo();
    }
    if (c.user) {
      send(`AUTH PLAIN ${Buffer.from(`\0${c.user}\0${c.password ?? ''}`, 'utf8').toString('base64')}`);
      await expect([235], 'AUTH');
    }
    send(`MAIL FROM:<${c.from}>`); await expect([250], 'MAIL FROM');
    send(`RCPT TO:<${input.to}>`); await expect([250, 251], 'RCPT TO');
    send('DATA'); await expect([354], 'DATA');
    sock.write(buildMessage(c, input.to, input.subject, input.text, input.eventId));
    send('.');
    const accepted = await expect([250], 'message');
    send('QUIT');
    return { ok: true, statusCode: accepted.code };
  } catch (err) {
    return { ok: false, statusCode: err instanceof SmtpError ? err.code : undefined, error: (err as Error).message };
  } finally {
    clearTimeout(timer);
    sock?.end();
  }
}
