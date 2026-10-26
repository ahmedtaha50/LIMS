// Bundles the server side into dist-server/ (never into dist/, which Express serves to browsers).
//   dist-server/server.cjs      the API server (entry: src/server/obs/entry.ts, which validates the configuration first)
//   dist-server/init-db.cjs     first-run schema and administrator (run by the desktop shell or by IT)
//   dist-server/backup-cli.cjs  backup / verify / restore command line
//   dist-server/supervisor.cjs  restarts the server child and keeps its log (loaded by desktop/main.cjs)
// Source maps are written next to the bundles for readable stack traces (node --enable-source-maps); they are not served.
// Usage: node scripts/build-server.cjs [--outdir <dir>]
const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const i = process.argv.indexOf('--outdir');
const outdir = path.resolve(root, i > -1 ? process.argv[i + 1] : 'dist-server');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

fs.rmSync(outdir, { recursive: true, force: true });

esbuild.build({
  absWorkingDir: root,
  entryPoints: {
    server: 'src/server/obs/entry.ts',
    'init-db': 'src/server/init-db.ts',
    'backup-cli': 'src/server/backup-cli.ts',
    supervisor: 'src/server/obs/supervisor.ts',
  },
  outdir,
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20', // Electron 33 runs the server as Node 20
  sourcemap: 'linked',
  define: { __APP_VERSION__: JSON.stringify(version) },
  // Not needed at run time in production (dev server and native add-ons), or optional.
  external: ['vite', 'pg-native', 'lightningcss', 'fsevents', 'esbuild', '@tailwindcss/vite', '@vitejs/plugin-react', 'pino-pretty'],
  logLevel: 'info',
}).catch(() => process.exit(1));
