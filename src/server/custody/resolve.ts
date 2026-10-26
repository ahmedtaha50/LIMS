/**
 * The scan lookup (roadmap M29, UX-08): a scanned or typed code becomes the record it names, the address of its page and what blocks
 * work on it, in words. Used by GET /resolve (src/server/routes/resolve.ts), which the global wedge-scanner hook
 * (src/lib/useScanSink.ts) and the camera scanner call, so a scan opens the record even when no list on the screen has loaded it.
 *
 * Codes, in the order they are tried: a sample id, a container id, a storage location id or code, an instrument id, a reagent id or
 * lot number. A code that matches nothing exactly is tried once more in upper case (a scanner in lower-case mode).
 */
import { asc, eq, sql } from 'drizzle-orm';
import { instruments, reagents, samples } from '../../db/schema';
import { sampleContainers, storageLocations } from '../../db/schema/custody';
import type { Executor } from '../core/tx';
import { quantityNumber } from './ledger';
import { activeRetainOf, custodyStatus, readReceipt, receiptBlocker, todayIso } from './status';

export type ResolvedKind = 'Sample' | 'Container' | 'Location' | 'Instrument' | 'Reagent';

export interface Resolved {
  kind: ResolvedKind;
  id: string;
  /** What the person sees: the record in a few words. */
  label: string;
  /** The page of the record (src/lib/router.ts). */
  href: string;
  sampleId?: string;
  /** Why work on the record may not go ahead, in words; empty when nothing blocks. */
  blockers: string[];
}

const hash = (view: string, ...segments: string[]) => `#/${[view, ...segments].map(encodeURIComponent).join('/')}`;

async function sampleBlockers(ex: Executor, sample: { id: string; state: string }): Promise<string[]> {
  const out: string[] = [];
  const receipt = await readReceipt(ex, sample.id);
  // Not received matters only before testing starts (the guard of Logged -> Testing); a pending deviation always matters.
  const blocked = receiptBlocker(sample.id, receipt);
  if (blocked && (sample.state === 'Logged' || custodyStatus(receipt) === 'Deviation: awaiting QA')) out.push(blocked);
  if (receipt?.expDate && receipt.expDate < todayIso()) out.push(`Sample ${sample.id} expired on ${receipt.expDate}.`);
  if (sample.state === 'Rejected') out.push(`Sample ${sample.id} is Rejected.`);
  return out;
}

async function tryCode(ex: Executor, code: string): Promise<Resolved | null> {
  const [s] = await ex.select({ id: samples.id, state: samples.state, material: samples.material, batch: samples.batch }).from(samples).where(eq(samples.id, code)).limit(1);
  if (s) return { kind: 'Sample', id: s.id, label: `${s.id}: ${s.material}, batch ${s.batch} (${s.state})`, href: hash('samples', s.id), sampleId: s.id, blockers: await sampleBlockers(ex, s) };

  const [c] = await ex.select().from(sampleContainers).where(eq(sampleContainers.id, code)).limit(1);
  if (c) {
    const [parent] = await ex.select({ id: samples.id, state: samples.state }).from(samples).where(eq(samples.id, c.sampleId)).limit(1);
    const blockers: string[] = [];
    if (c.status !== 'Active') blockers.push(`Container ${c.id} is ${c.status.toLowerCase()}.`);
    const retain = await activeRetainOf(ex, c.id);
    if (retain) blockers.push(`Container ${c.id} is a retained sample (${retain.id}, until ${retain.retainUntil}): do not use it up.`);
    blockers.push(...await sampleBlockers(ex, parent));
    return {
      kind: 'Container', id: c.id, label: `${c.id}: ${c.kind.toLowerCase()} of ${c.sampleId}, ${quantityNumber(c.quantity)} ${c.unit}`,
      href: hash('samples', c.sampleId), sampleId: c.sampleId, blockers,
    };
  }

  const [l] = await ex.select().from(storageLocations).where(sql`${storageLocations.id} = ${code} OR lower(${storageLocations.code}) = lower(${code})`).limit(1);
  if (l) {
    return {
      kind: 'Location', id: l.id, label: `${l.code}: ${l.name} (${l.kind})`, href: hash('custody', 'locations', l.id),
      blockers: l.status === 'Active' ? [] : [`Storage location ${l.code} is inactive.`],
    };
  }

  const [i] = await ex.select().from(instruments).where(eq(instruments.id, code)).limit(1);
  if (i) {
    const blockers: string[] = [];
    if (i.status !== 'Active') blockers.push(`Instrument ${i.id} is ${i.status}.`);
    if (i.calibrationDueDate && i.calibrationDueDate < todayIso()) blockers.push(`Instrument ${i.id} is overdue for calibration (due ${i.calibrationDueDate}).`);
    return { kind: 'Instrument', id: i.id, label: `${i.id}: ${i.name} (${i.type})`, href: hash('instruments', i.id), blockers };
  }

  const [r] = await ex.select().from(reagents).where(sql`${reagents.id} = ${code} OR ${reagents.lotNumber} = ${code}`).orderBy(asc(reagents.id)).limit(1);
  if (r) {
    const blockers: string[] = [];
    if (r.expiryDate && r.expiryDate < todayIso()) blockers.push(`Reagent ${r.name}, lot ${r.lotNumber}, expired on ${r.expiryDate}.`);
    if (/expired|quarantin|reject|depleted|blocked/i.test(r.status)) blockers.push(`Reagent ${r.name}, lot ${r.lotNumber}, is ${r.status}.`);
    return { kind: 'Reagent', id: r.id, label: `${r.name}, lot ${r.lotNumber}`, href: hash('reagents', r.id), blockers };
  }
  return null;
}

export async function resolveCode(ex: Executor, raw: string): Promise<Resolved | null> {
  const code = raw.trim();
  return (await tryCode(ex, code)) ?? (code.toUpperCase() !== code ? tryCode(ex, code.toUpperCase()) : null);
}
