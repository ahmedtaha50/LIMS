import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Client, Pool } from '../core/db.js';
import type { Actor } from '../core/route.js';
import type { Step } from '../mbr/design.js';

export type RaisedException = { kind: string; message: string };
export type StepContext = {
  c: Client; pool: Pool; actor: Actor;
  batch: { id: string; batchNumber: string; productName: string };
  phaseKey: string;
  /** values of the numeric steps already recorded in this batch, by `phase.step` */
  numbers: ReadonlyMap<string, number>;
};
/**
 * How one type of step is recorded. The engine (service.ts) does everything common to all steps: order, signature,
 * version check, audit, exceptions. A handler only turns the operator's input into the stored value and says what is
 * outside its limits. Handlers live in folders server/steps/<group>/ that export `handlers`; a track adds a folder.
 */
export type StepHandler = {
  type: Step['type'];
  /** `effects` runs after the step is signed, in the same transaction, with that signature (an automatic logbook entry). */
  record: (input: Record<string, unknown>, def: Step, ctx: StepContext) => Promise<{ value: unknown; number?: number; exceptions: RaisedException[]; effects?: (signatureId: string, signedAt: string) => Promise<void> }>;
};
/** Runs when a batch is closed, in the closing transaction: it may refuse the closing (throw) or write what closing means. */
export type BatchHook = (ctx: { c: Client; pool: Pool; actor: Actor; batch: { id: string; batchNumber: string; productName: string }; signatureId: string; signedAt: string }) => Promise<void>;

let cache: Map<string, StepHandler> | null = null;
let hookCache: BatchHook[] = [];
export async function batchHooks(): Promise<BatchHook[]> { await handlers(); return hookCache; }
export async function handlers(): Promise<Map<string, StepHandler>> {
  if (cache) return cache;
  const hooks: BatchHook[] = [];
  const root = fileURLToPath(new URL('../steps', import.meta.url));
  const out = new Map<string, StepHandler>();
  if (existsSync(root)) {
    for (const group of readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort()) {
      const file = ['index.ts', 'index.js'].map(f => join(root, group, f)).find(existsSync);
      if (!file) continue;
      const mod: { handlers?: StepHandler[]; onBatchComplete?: BatchHook } = await import(pathToFileURL(file).href);
      if (mod.onBatchComplete) hooks.push(mod.onBatchComplete);
      for (const h of mod.handlers ?? []) {
        if (out.has(h.type)) throw new Error(`two step handlers for the type ${h.type} (server/steps/${group})`);
        out.set(h.type, h);
      }
    }
  }
  cache = out; hookCache = hooks;
  return out;
}

/** A step that a second person must verify: the type "verified", or any step the recipe marks critical. */
export const needsVerification = (def: Step) => def.type === 'verified' || def.critical === true;
