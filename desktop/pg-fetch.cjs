/**
 * Build-time step: downloads the pinned PostgreSQL 16 Windows binaries (desktop/pg-bundle.json), checks the zip's SHA-256, keeps only
 * what the built-in database needs (bin, lib, share), and writes build/pgsql/PG_BINARIES.json: the SHA-256 of every executable and DLL,
 * which the application checks at each start (desktop/pg-supervisor.cjs verifyBinaries) and which belongs in the IQ and the release record.
 *   node desktop/pg-fetch.cjs [--zip <local file>]      (--zip: use an already downloaded archive, still checked against the pin)
 * NOT RUN in the repository's CI so far: needs network access to the vendor and a pinned hash.
 */
const fs = require('fs'), path = require('path'), https = require('https'), crypto = require('crypto'), os = require('os');
const { spawnSync } = require('child_process');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'pg-bundle.json'), 'utf8'));
const out = path.join(__dirname, '..', 'build', 'pgsql');
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const die = (m) => { console.error('pg-fetch: ' + m); process.exit(1); };

function download(url, dest, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) { res.resume(); return resolve(download(new URL(res.headers.location, url).href, dest, redirects - 1)); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' for ' + url)); }
      const f = fs.createWriteStream(dest); res.pipe(f); f.on('finish', () => f.close(resolve)); f.on('error', reject);
    }).on('error', reject);
  });
}
function walk(dir, base = dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, base, acc); else acc.push(path.relative(base, p).split(path.sep).join('/')); }
  return acc;
}

(async () => {
  if (!/^[0-9a-f]{64}$/.test(cfg.sha256 || '')) die('desktop/pg-bundle.json has no pinned sha256. Download the archive once, verify it against the vendor\'s published value, and pin it there.');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'lims-pgfetch-'));
  try {
    let zip = process.argv.includes('--zip') ? path.resolve(process.argv[process.argv.indexOf('--zip') + 1]) : path.join(work, 'pg.zip');
    if (!process.argv.includes('--zip')) await download(cfg.url, zip);
    const got = sha(zip);
    if (got !== cfg.sha256) die(`SHA-256 of the archive is ${got}, the pin is ${cfg.sha256}. Nothing was installed.`);
    const x = path.join(work, 'x'); fs.mkdirSync(x);
    const t = spawnSync('tar', ['-xf', zip, '-C', x], { stdio: 'inherit' }); // bsdtar (Windows 10+) reads zip
    if (t.status !== 0) die('could not extract the archive');
    const src = path.join(x, 'pgsql');
    if (!fs.existsSync(path.join(src, 'bin', 'postgres.exe'))) die('the archive has no pgsql/bin/postgres.exe');
    fs.rmSync(out, { recursive: true, force: true });
    for (const d of ['bin', 'lib', 'share']) fs.cpSync(path.join(src, d), path.join(out, d), { recursive: true });
    const files = {};
    for (const rel of walk(out)) if (/^bin\/[^/]+\.(exe|dll)$/i.test(rel)) files[rel] = sha(path.join(out, rel));
    fs.writeFileSync(path.join(out, 'PG_BINARIES.json'), JSON.stringify({ version: cfg.version, source: cfg.url, archiveSha256: cfg.sha256, files }, null, 2));
    console.log(`pg-fetch: PostgreSQL ${cfg.version}: ${Object.keys(files).length} executables and libraries recorded in build/pgsql/PG_BINARIES.json`);
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
})().catch(e => die(e.message));
