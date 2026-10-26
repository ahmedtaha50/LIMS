/**
 * The contract of /api/v1 on disk (roadmap M22). Run with tsx from the repository root:
 *
 *   npx tsx src/server/v1/openapi-cli.ts write [--allow-breaking "<reason>"]
 *       writes docs/api/{openapi.json, openapi.js, index.html, docs.js, docs.css} from the code. Refuses when the new document breaks
 *       the committed one, unless --allow-breaking names the reason (a breaking change belongs under a new prefix, /api/v2).
 *   npx tsx src/server/v1/openapi-cli.ts check [--base <git ref>]
 *       exit 1 when docs/api is stale (the code changed and `write` was not run), or when the generated document breaks the
 *       docs/api/openapi.json of <git ref> (CI: the target branch of the change). Exit 0 otherwise.
 */
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { findBreakingChanges } from './breaking';
import { docsFiles } from './docsSite';
import { buildOpenApiDocument } from './openapi';

const DIR = path.resolve(process.cwd(), 'docs', 'api');
const REL = 'docs/api/openapi.json';

function committedAt(ref: string): Record<string, any> | null {
  try {
    return JSON.parse(execFileSync('git', ['show', `${ref}:${REL}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch { return null; }
}

function main(argv: string[]): number {
  const [command, ...rest] = argv;
  const flag = (name: string) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  const doc = buildOpenApiDocument();
  const files = docsFiles(doc);

  if (command === 'write') {
    const current = existsSync(path.join(DIR, 'openapi.json')) ? JSON.parse(readFileSync(path.join(DIR, 'openapi.json'), 'utf8')) : null;
    const breaks = current ? findBreakingChanges(current, doc) : [];
    const allow = flag('--allow-breaking');
    if (breaks.length && !allow) {
      console.error(`Refused: the new contract breaks the committed one:\n${breaks.map(b => `  - ${b}`).join('\n')}\n` +
        'Keep /api/v1 compatible (add, do not change or remove), or pass --allow-breaking "<reason>" after the change was approved.');
      return 1;
    }
    mkdirSync(DIR, { recursive: true });
    for (const [name, content] of Object.entries(files)) writeFileSync(path.join(DIR, name), content);
    console.log(`Wrote docs/api (${Object.keys(doc.paths).length} paths)${breaks.length ? `; breaking changes accepted: ${allow}` : ''}.`);
    return 0;
  }

  if (command === 'check') {
    const stale = Object.entries(files).filter(([name, content]) => !existsSync(path.join(DIR, name)) || readFileSync(path.join(DIR, name), 'utf8') !== content).map(([n]) => n);
    if (stale.length) { console.error(`docs/api is stale (${stale.join(', ')}): run npx tsx src/server/v1/openapi-cli.ts write`); return 1; }
    const base = flag('--base');
    if (base) {
      const before = committedAt(base);
      if (!before) { console.log(`${REL} does not exist at ${base}: nothing to compare.`); return 0; }
      const breaks = findBreakingChanges(before, doc);
      if (breaks.length) { console.error(`Breaking change against ${base}:\n${breaks.map(b => `  - ${b}`).join('\n')}`); return 1; }
    }
    console.log('The contract of /api/v1 is current' + (base ? ` and compatible with ${base}.` : '.'));
    return 0;
  }

  console.error('usage: openapi-cli.ts write [--allow-breaking "<reason>"] | check [--base <git ref>]');
  return 2;
}

process.exitCode = main(process.argv.slice(2));
