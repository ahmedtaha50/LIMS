/**
 * Entry point of the server bundle (dist-server/server.cjs) and of `npm run dev`.
 * bootstrap() runs to completion before the application is imported, so no application module can read
 * an unvalidated environment (core/auth.ts, for one, reads NODE_ENV and JWT_SECRET when it is first loaded).
 */
import { bootstrap } from './bootstrap';

bootstrap();
import('../../../server').catch((err) => {
  console.error(err);
  process.exit(1);
});
