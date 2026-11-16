import { z } from 'zod';

/** Configuration from the environment, validated once at start-up: a wrong value stops the server with its name. */
const Env = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required (postgres://user:password@host:5432/database)'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4100),
  HOST: z.string().default('127.0.0.1'),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(500).default(20),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});
export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const r = Env.safeParse(env);
  if (!r.success) {
    const lines = r.error.issues.map(i => `${i.path.join('.') || 'environment'}: ${i.message}`);
    throw new Error(`invalid configuration:\n  ${lines.join('\n  ')}`);
  }
  return r.data;
}
