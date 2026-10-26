import { createServer } from 'http';
import { db } from './src/db/index';
import { createApp } from './src/server/app';
import { bootDatabase } from './src/server/boot';
import { startupAnchorCheck } from './src/server/audit/anchors';
import { checkClock } from './src/server/audit/clockGuard';
import { installProcessHandlers } from './src/server/core/process';
import { log, serializeError } from './src/server/core/logger';
import { mountFrontend } from './src/server/http/static';
import { initRabbitMQ } from './src/server/rabbitmq';
import { agentEnabled, startFolderAgent } from './src/server/connectors/folderAgent';
import { startDispatcher } from './src/server/events';
import { createRealtime } from './src/server/realtime';

async function startServer() {
  const PORT = Number(process.env.PORT || 3000);
  const HOST = process.env.HOST || '0.0.0.0';

  const httpServer = createServer();
  installProcessHandlers({ onFatal: () => { httpServer.close(); } });
  // Sockets are authenticated with the session token and joined to their user's room only (r2-events, roadmap M23).
  const io = createRealtime(httpServer, { db });

  // Check only: the server refuses a database that is behind, ahead of, or different from this build's migrations, and installs the
  // append-only triggers (as ensureProtections() did). It never changes the schema of a validated database by merely starting; the
  // installer (init-db) or `migrate-cli migrate` does that, after a verified backup. See docs/migrations.md.
  await bootDatabase({ migrate: false });
  // Tamper evidence at start (roadmap M35): the chain tail against the anchor files, and the clock against the newest records.
  // Neither stops the start; a mismatch is logged and written as a security event, a set-back blocks signing.
  await startupAnchorCheck(db, { log: m => console.log(m) });
  const clock = await checkClock(db, { source: 'startup' });
  if (!clock.ok) console.log(`ERROR The system clock is ${Math.round(clock.behindMs / 60_000)} minute(s) behind records already written; signing is blocked until an Administrator acknowledges it.`);
  await initRabbitMQ();
  // Committed outbox events become notifications and webhook / e-mail / file deliveries (r2-events).
  startDispatcher(db, { io });
  // Instrument data capture (r2-instrument-integration, roadmap M21): the folders of approved capture profiles. INSTRUMENT_AGENT=off disables it.
  if (agentEnabled()) startFolderAgent(db);

  const app = createApp({ db, io });
  await mountFrontend(app);
  httpServer.on('request', app);

  httpServer.listen(PORT, HOST, () => {
    console.log(`Secured LIMS Server running on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  log.error({ err: serializeError(err) }, 'server failed to start');
  process.exit(1);
});
