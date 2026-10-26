// Request bodies of the AI routes (roadmap M16). Strict. Owned by r1-identity.
import { z } from 'zod';

const text = (max: number) => z.string().trim().max(max).optional();

export const transcribeSchema = z.object({
  // A data URL as MediaRecorder + FileReader produce it: data:audio/webm;base64,....
  audio: z.string().min(32).max(30_000_000).refine(v => v.startsWith('data:audio/') && v.includes(';base64,'), 'audio must be a base64 data URL of an audio recording.'),
}).strict();

export const capaAnalysisSchema = z.object({
  sampleId: text(100),
  resultId: text(100),
  parameter: text(300),
  value: z.union([z.string().trim().max(300), z.number()]).optional(),
  specMin: z.union([z.string().trim().max(50), z.number()]).nullable().optional(),
  specMax: z.union([z.string().trim().max(50), z.number()]).nullable().optional(),
  instrument: text(300),
  notes: text(4000),
}).strict();

export const elnProtocolSchema = z.object({
  title: text(300),
  experimentType: text(300),
  sampleId: text(100),
  rawMaterial: text(300),
  instrument: text(300),
  pharmacopeia: text(300),
  dosageForm: text(300),
}).strict();
