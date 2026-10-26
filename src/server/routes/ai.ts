// Domain: ai (roadmap M16). Controlled external egress: AI is off unless an Administrator switched it on, nothing is sent while it is off,
// every request that leaves the machine is recorded first (EXTERNAL_CALL), and what comes back is a labelled draft. When AI is off or fails
// the answer is a 503 with no content: the canned transcription and the template CAPA / protocol that used to be returned in that
// case looked like observations and analyses, and one of them reached ELN entries as if the analyst had said it.
import { GoogleGenAI } from '@google/genai';
import type { Request } from 'express';
import { capaAnalysisSchema, elnProtocolSchema, transcribeSchema } from '../../lib/validations/ai';
import { AI_KEY_CONTEXT, AI_PROVIDER, loadIntegrationSettings } from '../auth/integrationSettings';
import { recordSecurityEvent, SecurityEventType, securityEventContext } from '../auth/events';
import { type RouteContext } from '../core/context';
import { log, serializeError } from '../core/logger';
import { createRouter } from '../core/router';
import { getKeystore } from '../crypto/keystore';
import { AppError } from '../http/errors';
import { validate } from '../http/validate';

export const AI_LABEL = 'AI draft - not a GxP record';
const AI_TIMEOUT_MS = 60_000;

const SAMPLE_ID = /\bSMP-\d{4}-\d{3,}\b/g;
const RESULT_ID = /\bRES-[A-Z0-9]{4,}\b/g;

type Scalar = string | number | null | undefined;
/** With redaction on, record identifiers inside free text become placeholders; the science (parameter, limits, method) is kept. */
const scrub = (value: Scalar, redact: boolean): Scalar =>
  redact && typeof value === 'string' ? value.replace(SAMPLE_ID, '[sample id]').replace(RESULT_ID, '[result id]') : value;

interface Gate { apiKey: string; model: string; redact: boolean }

/** Refuses with 503 AI_DISABLED unless AI is switched on and a key is stored. Reads settings fresh: a switch-off takes effect at once. */
async function openGate(db: RouteContext['db']): Promise<Gate> {
  const settings = await loadIntegrationSettings(db);
  if (!settings.externalAiEnabled || !settings.aiApiKeyEnc) {
    throw new AppError(503, 'AI_DISABLED', 'External AI assistance is switched off, so nothing was sent and nothing was generated. An Administrator can enable it under System Administration > Integrations.');
  }
  try {
    return { apiKey: getKeystore().decrypt(settings.aiApiKeyEnc, AI_KEY_CONTEXT), model: settings.aiModel, redact: settings.aiRedactIdentifiers };
  } catch (e) {
    log.error({ err: serializeError(e) }, 'the stored AI key could not be decrypted');
    throw new AppError(503, 'AI_UNAVAILABLE', 'The stored AI key cannot be read. An Administrator must enter it again under System Administration > Integrations.');
  }
}

/** Records the request, sends it, and returns the answer text. Never returns invented content. */
async function askAi(db: RouteContext['db'], req: Request, gate: Gate, call: { endpoint: string; purpose: string; bytes: number; contents: unknown }): Promise<string> {
  // The record comes first and is committed on its own: if it cannot be written, nothing leaves the machine.
  const user = (req as any).user as { id: string; role: string };
  await recordSecurityEvent(db, {
    type: SecurityEventType.EXTERNAL_CALL, outcome: 'info', actorId: user.id, actorRole: user.role, ...securityEventContext(req),
    detail: { endpoint: call.endpoint, provider: AI_PROVIDER, model: gate.model, purpose: call.purpose, bytes: call.bytes, identifiersRedacted: gate.redact },
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    const ai = new GoogleGenAI({ apiKey: gate.apiKey });
    const response = await Promise.race([
      ai.models.generateContent({ model: gate.model, contents: call.contents as any }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), AI_TIMEOUT_MS); }),
    ]);
    return (response.text || '').trim();
  } catch (e) {
    log.warn({ err: serializeError(e), endpoint: call.endpoint }, 'external AI call failed');
    throw new AppError(503, 'AI_UNAVAILABLE', 'The AI service could not be reached or did not answer. Nothing was generated; continue without it.');
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const generatedBy = (gate: Gate) => ({ provider: AI_PROVIDER, model: gate.model, label: AI_LABEL, generatedAt: new Date().toISOString() });

export const aiRoutes = ({ db, requireAuth }: RouteContext) => {
  const router = createRouter();

  router.post('/transcribe', requireAuth, validate(transcribeSchema), async (req, res) => {
    const gate = await openGate(db);
    const audio: string = req.body.audio;
    const comma = audio.indexOf(',');
    const mimeType = /^data:([^;,]+)/.exec(audio.slice(0, comma))?.[1] ?? 'audio/webm';
    const base64Data = audio.slice(comma + 1);
    const text = await askAi(db, req, gate, {
      endpoint: '/api/transcribe', purpose: 'transcription', bytes: base64Data.length,
      contents: [
        { inlineData: { mimeType, data: base64Data } },
        'You are a specialized pharmaceutical QC laboratory transcription assistant. Transcribe the spoken audio recorded by analysts working in cleanroom conditions (wearing sterile gloves and PPE). Transcribe verbatim and accurately recognize analytical terminology, units, numbers, and symbols: HPLC, %RSD, µg/mL, mg, mL, pH 3.0, mobile phase, diluent, tare, balance, dissolution, absorbance, peaks, baseline, retention time, OOS, Annex 1, Grade A, CFU. Return ONLY the transcribed text.',
      ],
    });
    res.json({ text, generatedBy: generatedBy(gate) });
  });

  router.post('/ai/capa-analysis', requireAuth, validate(capaAnalysisSchema), async (req, res) => {
    const gate = await openGate(db);
    const input = req.body as typeof capaAnalysisSchema._output;
    const sampleId = gate.redact ? undefined : input.sampleId;
    const resultId = gate.redact ? undefined : input.resultId;
    const parameter = scrub(input.parameter, gate.redact);
    const value = scrub(input.value, gate.redact);
    const specMin = input.specMin;
    const specMax = input.specMax;
    const instrument = scrub(input.instrument, gate.redact);
    const notes = scrub(input.notes, gate.redact);

    const prompt = `You are a certified pharmaceutical Quality Assurance (QA) and regulatory compliance expert specialized in FDA 21 CFR Part 211, EU GMP Annex 1, and ICH Q10 Pharmaceutical Quality Systems.
Analyze this Out-of-Specification (OOS) event and provide a comprehensive root cause analysis and Corrective & Preventative Action (CAPA) plan.

OOS Incident Details:
- Sample ID: ${sampleId || 'N/A'}
- Result ID: ${resultId || 'N/A'}
- Analytical Parameter: ${parameter || 'N/A'}
- Observed Failed Value: ${value || 'N/A'}
- Specification Range: ${specMin ?? 'N/A'} to ${specMax ?? 'N/A'}
- Instrument in Use: ${instrument || 'Laboratory Instrumentation'}
- Analyst Notes: ${notes || 'None provided'}

Provide your response in structured JSON format with the following keys:
{
  "summary": "Concise 2-sentence summary of the breach and immediate compliance risk",
  "phase1LabInvestigation": [
    "Check 1 (e.g. calculation & dilution check)",
    "Check 2 (e.g. instrument calibration & system suitability)",
    "Check 3 (e.g. reagent/reference standard purity & expiry)",
    "Check 4 (e.g. glassware volumetric accuracy & analyst technique)"
  ],
  "fishboneAnalysis": {
    "method": "Analysis of analytical method robustness or sample prep deviations",
    "machine": "Analysis of instrument state, column degradation, baseline noise",
    "material": "Analysis of raw material lot, solvent grade, reference standard",
    "measurement": "Analysis of balance calibration, volumetric pipetting, integration",
    "man": "Analysis of analyst qualification, training records, pipetting technique",
    "motherNature": "Analysis of cleanroom temperature, humidity, light exposure"
  },
  "fmeaRiskScore": {
    "severity": 8,
    "occurrence": 4,
    "detection": 3,
    "rpn": 96,
    "riskLevel": "Medium"
  },
  "rootCauseConclusion": "Probable root cause statement based on empirical evidence",
  "immediateContainment": [
    "Immediate containment step 1 (e.g. quarantine batch)",
    "Immediate containment step 2"
  ],
  "correctiveActions": [
    "CAPA action 1",
    "CAPA action 2"
  ],
  "preventativeActions": [
    "Preventative action 1 (e.g. update SOP)",
    "Preventative action 2 (e.g. re-training requirement)"
  ]
}
Return ONLY valid JSON without Markdown fences or conversational text.`;

    const text = await askAi(db, req, gate, { endpoint: '/api/ai/capa-analysis', purpose: 'OOS root cause and CAPA draft', bytes: prompt.length, contents: prompt });
    let analysis: unknown;
    try { analysis = JSON.parse(text.replace(/```json/g, '').replace(/```/g, '').trim()); } catch { analysis = null; }
    if (!analysis || typeof analysis !== 'object' || Array.isArray(analysis)) {
      throw new AppError(503, 'AI_UNAVAILABLE', 'The AI service returned an answer that could not be used. Nothing was generated; continue without it.');
    }
    res.json({ ...(analysis as object), generatedBy: generatedBy(gate) });
  });

  router.post('/ai/eln-protocol', requireAuth, validate(elnProtocolSchema), async (req, res) => {
    const gate = await openGate(db);
    const input = req.body as typeof elnProtocolSchema._output;
    const title = scrub(input.title, gate.redact);
    const experimentType = scrub(input.experimentType, gate.redact);
    const sampleId = gate.redact ? undefined : input.sampleId;
    const rawMaterial = scrub(input.rawMaterial, gate.redact);
    const instrument = scrub(input.instrument, gate.redact);
    const dosageForm = scrub(input.dosageForm, gate.redact);
    const selectedPharmacopeia = input.pharmacopeia || 'USP <621> Chromatography & European Pharmacopoeia (EP 2.2.46)';

    const prompt = `You are a Principal Pharmaceutical Analytical Chemist and GxP documentation scientist.
Generate a comprehensive, regulatory-compliant laboratory analytical protocol and testing worksheet template strictly adhering to official pharmacopeial standards.

Parameters:
- Title: ${title || 'Analytical Testing Protocol & Execution Worksheet'}
- Experiment / Test Type: ${experimentType || 'HPLC Quantitative Assay'}
- Target Pharmacopeia: ${selectedPharmacopeia}
- Target Sample/Batch: ${sampleId || 'QC Release Sample'}
- Dosage Form: ${dosageForm || 'Finished Product Tablets'}
- Active Material / Drug Substance: ${rawMaterial || 'Active Pharmaceutical Ingredient'}
- Primary Analytical Instrument: ${instrument || 'Agilent 1260 Infinity II HPLC System'}

Return a formatted, structured markdown laboratory notebook worksheet including:
1. ## Objective & Pharmacopeial Scope (Exact reference to ${selectedPharmacopeia}, ICH Q2(R1), and FDA 21 CFR Part 211)
2. ## Safety, PPE & Cleanroom Handling Precautions (ISO 14644 cleanroom protocol, fume hood, disposal)
3. ## Reference Standards, Reagents & Solutions (Lot#, Grade, Purity, Expiration, Storage)
4. ## Instrumentation & Chromatographic Setup (Column chemistry L-class, dimensions, particle size, flow rate, column temp, detection wavelength, injection volume)
5. ## Mobile Phase / Buffer Preparation (Exact pH adjustment with pH meter calibration, degassing, filtration through 0.22µm membrane)
6. ## System Suitability Testing (SST) Acceptance Criteria per ${selectedPharmacopeia} (Retention time %RSD ≤ 1.0%, Peak area %RSD ≤ 1.0%, Theoretical plates N ≥ 2500, Tailing factor 0.8 ≤ T ≤ 1.5, Resolution Rs > 2.0)
7. ## Step-by-Step Standard & Sample Preparation (Analytical balance weighing, volumetric dilution, filtration)
8. ## Analytical Sequence & Bracketing Injection Order (Blank, SST x 5, Standard x 2, Samples in duplicate, Bracketing standard every 10 injections)
9. ## Mathematical Calculation Formula for Quantitative Determination
10. ## Acceptance Specification Limits & Pass/Fail Criteria
11. ## 21 CFR Part 11 Electronic Signature Block (Analyst execution certification and QA review declaration)

Make it thorough, realistic, and ready for immediate execution in a regulated QC pharmaceutical laboratory.`;

    const text = await askAi(db, req, gate, { endpoint: '/api/ai/eln-protocol', purpose: 'analytical protocol draft', bytes: prompt.length, contents: prompt });
    if (!text) throw new AppError(503, 'AI_UNAVAILABLE', 'The AI service returned an empty answer. Nothing was generated; continue without it.');
    // The label is part of the text, so it stays on the entry until a person reads, edits and removes it.
    const marker = `AI DRAFT - NOT A GXP RECORD. Generated by ${gate.model} on ${new Date().toISOString().slice(0, 10)}. Review, correct and sign before use.\n\n`;
    res.json({ protocol: marker + text, pharmacopeia: selectedPharmacopeia, generatedBy: generatedBy(gate) });
  });

  return router;
};
