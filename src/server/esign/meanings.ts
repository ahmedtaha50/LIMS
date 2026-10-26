/** The signature meaning catalog (table signature_meanings, roadmap M07). Read only: it is changed with a migration. */
import { asc, eq } from 'drizzle-orm';
import { signatureMeanings } from '../../db/schema';
import type { Executor } from '../core/tx';

export type Meaning = typeof signatureMeanings.$inferSelect;

export async function getMeaning(ex: Executor, code: string): Promise<Meaning | undefined> {
  const [row] = await ex.select().from(signatureMeanings).where(eq(signatureMeanings.code, code)).limit(1);
  return row;
}

export async function listActiveMeanings(ex: Executor): Promise<Meaning[]> {
  return ex.select().from(signatureMeanings).where(eq(signatureMeanings.active, true)).orderBy(asc(signatureMeanings.code));
}

/** A reason that is only a few characters is not a reason (the same floor the signature dialog shows). */
export const MIN_REASON_LENGTH = 5;
