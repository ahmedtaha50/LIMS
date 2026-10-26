// `npm run dev`: the server with the Vite dev middleware. Development has to be asked for explicitly
// (NODE_ENV=development); a missing JWT_SECRET is replaced by a random one for this run, never by a fixed literal.
const { spawn } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const child = spawn(process.execPath, ['--import', 'tsx', path.join('src', 'server', 'obs', 'entry.ts')], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: process.env.NODE_ENV || 'development' },
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
