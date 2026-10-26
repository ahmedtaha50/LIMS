import { defineConfig } from "drizzle-kit";
import * as dotenv from "dotenv";

dotenv.config();

const sqlHost = process.env.SQL_HOST;
const sqlDbName = process.env.SQL_DB_NAME;
const user = process.env.SQL_ADMIN_USER;
const password = process.env.SQL_ADMIN_PASSWORD;

if (!sqlHost || !sqlDbName || !user || !password) {
  console.warn("Missing SQL_ environment variables. Drizzle kit might fail.");
}

// Migrations are hand-written SQL in drizzle/ applied by src/server/migrate.ts; drizzle-kit is only a helper here.
//   - Do NOT run `drizzle-kit generate`/`migrate` against drizzle/: the runner keeps its own journal and the numbering is reserved
//     per track (docs/migrations.md). `out` is therefore a scratch folder the runner never reads.
//   - To draft the SQL for a schema change: `npx tsx src/server/boot/migrate-cli.ts draft`, then write drizzle/NNNN_name.sql.
//   - `drizzle-kit push` still works for a throwaway local database, but such a database has no journal and the application
//     (installer, bootDatabase) will refuse it. tests/upgrade/schema-drift.test.ts fails when schema and migrations disagree.
export default defineConfig({
  schema: "./src/db/schema/index.ts",
  out: "./drizzle/.draft",
  dialect: "postgresql",
  schemaFilter: ["public"],
  dbCredentials: {
    host: sqlHost || '',
    user: user || '',
    password: password || '',
    database: sqlDbName || '',
    ssl: false,
  },
  verbose: true,
});
