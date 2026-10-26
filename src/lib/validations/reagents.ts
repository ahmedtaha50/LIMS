import { z } from 'zod';
import { signatureFields } from './signatures';
import { calendarDate } from './instruments';

const text = (label: string, max = 200) => z.string({ error: iss => (iss.input === undefined ? `${label} is required.` : `${label} must be text.`) })
  .trim().min(1, `${label} is required.`).max(max, `${label} is too long (at most ${max} characters).`);

/**
 * POST /reagents: the receipt of a reagent or standard, signed by the person who received it (meaning RECEIPT, chosen by the
 * server). The expiry date may not have passed (checked by the route against the server's date). Status and id are the server's.
 */
export const reagentSchema = z.object({
  name: text('Reagent name'),
  lotNumber: text('Lot number'),
  quantity: text('Quantity', 100),
  expiryDate: calendarDate('Expiry date'),
  password: signatureFields.password,
  totpCode: signatureFields.totpCode,
}).strict();
