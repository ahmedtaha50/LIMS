// Request body of the training certification route. Strict. Owned by r1-identity.
import { z } from 'zod';

export const certifyTrainingSchema = z.object({
  password: z.string().min(1, 'Password required').max(1024),
  moduleName: z.string().trim().min(2, 'Module name is required.').max(120),
}).strict();
