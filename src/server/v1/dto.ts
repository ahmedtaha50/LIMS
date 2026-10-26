/**
 * What /api/v1 answers: the response schemas (published in the OpenAPI document) and the mappers from database rows. A row is never
 * sent as it is: only the fields below leave the server, so a new internal column (or an attachment's bytes) cannot leak into the
 * contract, and a field removed from here is a breaking change the contract check reports.
 */
import { z } from 'zod';
import type { samples, results } from '../../db/schema';
import type { SpecParameter } from '../../lib/validations/specifications';
import type { ResolvedSpec } from '../lib/specs';

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const dateTime = () => z.string().meta({ format: 'date-time' });

export const sampleDto = z.object({
  id: z.string(),
  material: z.string(),
  batch: z.string(),
  state: z.string().meta({ description: 'Logged, Testing, Pending Review, Approved or Rejected' }),
  specId: z.string().nullable(),
  specRevision: z.number().int().nullable(),
  createdBy: z.string(),
  createdAt: dateTime(),
  version: z.number().int().meta({ description: 'Record version (optimistic concurrency)' }),
}).strict();

export const resultDto = z.object({
  id: z.string(),
  parameter: z.string(),
  value: z.string().nullable(),
  isOos: z.boolean(),
  unit: z.string().nullable(),
  limitKind: z.string().nullable().meta({ description: 'RANGE, NMT, NLT, TEXT or PRESENCE' }),
  lower: z.string().nullable().meta({ description: 'Lower limit as decimal text, as written in the specification' }),
  upper: z.string().nullable(),
  decimals: z.number().int().nullable(),
  acceptanceText: z.string().nullable(),
  instrumentId: z.string().nullable(),
  enteredBy: z.string().nullable(),
  enteredAt: dateTime().nullable(),
  version: z.number().int().meta({ description: 'Send it back as expectedVersion when entering the value' }),
}).strict();

export const specParameterDto = z.object({
  name: z.string(),
  unit: z.string(),
  limitKind: z.string(),
  lower: z.number().nullable(),
  upper: z.number().nullable(),
  decimals: z.number().int().nullable(),
  text: z.string().nullable(),
}).strict();

export const specificationDto = z.object({
  id: z.string(),
  material: z.string(),
  revision: z.number().int(),
  effectiveDate: z.string().meta({ format: 'date' }),
  parameters: z.array(specParameterDto),
}).strict();

export const toSample = (s: typeof samples.$inferSelect): z.infer<typeof sampleDto> => ({
  id: s.id, material: s.material, batch: s.batch, state: s.state, specId: s.specId ?? null, specRevision: s.specRevision ?? null,
  createdBy: s.createdBy, createdAt: s.createdAt.toISOString(), version: s.version,
});

export const toResult = (r: typeof results.$inferSelect): z.infer<typeof resultDto> => ({
  id: r.id, parameter: r.parameter, value: r.value ?? null, isOos: r.isOos, unit: r.unit ?? null, limitKind: r.limitKind ?? null,
  lower: r.lowerText ?? null, upper: r.upperText ?? null, decimals: r.decimals ?? null, acceptanceText: r.acceptanceText ?? null,
  instrumentId: r.instrumentId ?? null, enteredBy: r.enteredBy ?? null, enteredAt: iso(r.enteredAt), version: r.version,
});

const toParameter = (p: SpecParameter): z.infer<typeof specParameterDto> => ({
  name: p.name, unit: p.unit, limitKind: p.limit_kind, lower: p.lower, upper: p.upper, decimals: p.decimals, text: p.text,
});

export const toSpecification = (s: ResolvedSpec): z.infer<typeof specificationDto> => ({
  id: s.id, material: s.material, revision: s.revision, effectiveDate: s.effectiveDate, parameters: s.parameters.map(toParameter),
});
