import { z } from 'zod';
import { signatureFields } from './signatures';

const title = z.string({ error: 'Title must be text.' }).trim().min(1, 'Worksheet title is required').max(300, 'Title is too long (at most 300 characters).');
const content = z.string({ error: 'Content must be text.' }).trim().min(1, 'Worksheet content is required').max(1_000_000, 'Content is too long.');
const optionalText = (label: string) => z.string({ error: `${label} must be text.` }).trim().min(1).max(200).optional();
const sampleId = z.string({ error: 'Sample id must be text.' }).trim().min(1).max(100).nullable().optional();

/** POST /eln. The author is the signed-in user; status, version and the signature fields are the server's. */
export const elnCreateSchema = z.object({
  title,
  content,
  sampleId,
  experimentType: optionalText('Experiment type'),
  pharmacopeia: optionalText('Pharmacopeia'),
}).strict();

/** PUT /eln/:id: only the author, only while Draft, with the version the author last saw. */
export const elnUpdateSchema = z.object({
  title: title.optional(),
  content: content.optional(),
  sampleId,
  experimentType: optionalText('Experiment type'),
  pharmacopeia: optionalText('Pharmacopeia'),
  expectedVersion: z.number({ error: 'expectedVersion is required (a number).' }).int().min(1),
}).strict();

/** POST /eln/:id/sign: the author's credentials. The meaning (AUTHORSHIP) is the server's: a meaning in the body is refused. */
export const elnSignSchema = z.object({
  password: signatureFields.password,
  totpCode: signatureFields.totpCode,
  reason: signatureFields.reason,
}).strict();

/** POST /samples/:id/notebook: the observation text and the author's credentials, nothing else. */
export const notebookEntrySchema = z.object({
  content: z.string({ error: 'Observation content must be text.' }).trim().min(1, 'Observation content is required').max(100_000),
  password: z.string().min(1, 'E-Signature password is required').max(1024),
  totpCode: signatureFields.totpCode,
}).strict();

/** POST /notebook-templates: QA or Admin; the author is the signed-in user. */
export const notebookTemplateSchema = z.object({
  title: z.string({ error: 'Title must be text.' }).trim().min(1, 'Template title is required').max(300, 'Title is too long (at most 300 characters).'),
  content: z.string({ error: 'Content must be text.' }).trim().min(1, 'Template content is required').max(1_000_000),
}).strict();
