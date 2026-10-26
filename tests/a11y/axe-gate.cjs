// The accessibility gate (roadmap M37, UX-10): axe-core on every screen of the application, reached through the real shell.
//
// A screen fails on any SERIOUS or CRITICAL violation that is not in tests/a11y/baseline.json. The baseline is a ratchet: a screen listed
// there may carry exactly the rules listed (each tied to an open deviation) and nothing new; once a rule no longer occurs the entry is
// stale and the gate FAILS until the entry is removed, so the list can only shrink. Every violation, known or new, is printed with its
// elements as an INFO line so the evidence shows what is wrong, not only that something is.
//
// Needs axe-core (AXE_PATH=.../axe-core/axe.min.js, or node_modules/axe-core) and a running, seeded server (see tests/e2e/lib.cjs).
const fs = require('fs');
const path = require('path');
const { check, info, newPage, launch, signIn, sampleInTesting, approvedSample, BASE_URL, run } = require('./../e2e/lib.cjs');

let AXE_PATH = process.env.AXE_PATH;
if (!AXE_PATH) { try { AXE_PATH = require.resolve('axe-core/axe.min.js', { paths: [path.join(__dirname, '..', '..')] }); } catch { /* reported below */ } }
const BASELINE = JSON.parse(fs.readFileSync(path.join(__dirname, 'baseline.json'), 'utf8'));

// [name, hash, who]. Every navigation entry of Layout.tsx and every shell extension, for a role that can open it.
const SCREENS = [
  ['dashboard', '#/dashboard', 'qa@gxp.com'], ['samples', '#/samples', 'analyst1@gxp.com'], ['inbox', '#/inbox', 'qa@gxp.com'],
  ['lab notebook', '#/eln', 'analyst1@gxp.com'], ['batch traceability', '#/traceability', 'qa@gxp.com'], ['OOS investigations', '#/oos', 'qa@gxp.com'],
  ['stability studies', '#/stability', 'qa@gxp.com'], ['environmental monitoring', '#/environmental', 'qa@gxp.com'], ['test specifications', '#/specs', 'qa@gxp.com'],
  ['equipment and calibration', '#/instruments', 'qa@gxp.com'], ['reagents and standards', '#/reagents', 'qa@gxp.com'], ['SOP training matrix', '#/training', 'qa@gxp.com'],
  ['audit trail', '#/audit', 'qa@gxp.com'], ['reports', '#/reports', 'qa@gxp.com'], ['system administration', '#/admin', 'admin@gxp.com'],
  ['master data', '#/master-data', 'qa@gxp.com'], ['methods and calculations', '#/methods', 'qa@gxp.com'], ['controlled documents', '#/documents', 'qa@gxp.com'],
  ['quality management', '#/qms', 'qa@gxp.com'], ['custody and storage', '#/custody', 'qa@gxp.com'], ['worklists', '#/worklists', 'analyst1@gxp.com'],
  ['instrument imports', '#/imports', 'analyst1@gxp.com'], ['API clients', '#/api-clients', 'admin@gxp.com'], ['event subscriptions', '#/event-subscriptions', 'admin@gxp.com'],
  ['audit review', '#/audit-review', 'qa@gxp.com'], ['module qualification', '#/module-qualification', 'qa@gxp.com'],
];

run(async (browser) => {
  if (!AXE_PATH || !fs.existsSync(AXE_PATH)) { check('A0 axe-core is available', false, 'set AXE_PATH to axe-core/axe.min.js or install axe-core'); return; }
  const approved = await approvedSample();
  const testing = await sampleInTesting();
  const extra = [['sample in Testing (result workbench)', `#/samples/${testing.id}`, 'analyst1@gxp.com'], ['approved sample (certificate panel)', `#/samples/${approved.id}`, 'qa@gxp.com']];

  const pages = new Map();
  const pageFor = async (who) => {
    if (pages.has(who)) return pages.get(who);
    // bypassCSP: axe is injected as a script, which the application's CSP (script-src 'self') rightly refuses
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, bypassCSP: true });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    await signIn(page, who, '#/dashboard');
    pages.set(who, page);
    return page;
  };
  const scan = async (page) => {
    await page.waitForTimeout(900);
    await page.addScriptTag({ path: AXE_PATH });
    return page.evaluate(async () => {
      const res = await window.axe.run(document, { resultTypes: ['violations'] });
      return res.violations.filter(v => v.impact === 'serious' || v.impact === 'critical').map(v => ({ id: v.id, impact: v.impact, n: v.nodes.length, where: v.nodes.slice(0, 3).map(n => n.target.join(' ')) }));
    });
  };

  const seen = new Set();
  for (const [name, hash, who] of [...SCREENS, ...extra]) {
    const page = await pageFor(who);
    await page.evaluate((h) => { location.hash = h; }, hash);
    await page.waitForSelector('main#main', { timeout: 10000 }).catch(() => {});
    const found = await scan(page);
    seen.add(name);
    const known = new Map((BASELINE.screens[name]?.rules || []).map(r => [r.id, r]));
    const fresh = found.filter(v => !known.has(v.id));
    const stale = [...known.keys()].filter(id => !found.some(v => v.id === id));
    for (const v of found) info(`axe ${name}: ${v.id} (${v.impact}) x${v.n} at ${v.where.join(' | ')}${known.has(v.id) ? ` [known, ${known.get(v.id).deviation}]` : ''}`);
    check(`A ${name}: no new serious or critical axe violation${known.size ? ` (${known.size} known rule(s) in baseline.json)` : ''}`, fresh.length === 0, fresh);
    if (stale.length) check(`A ${name}: baseline entry is current`, false, `${stale.join(', ')} no longer occurs: remove it from tests/a11y/baseline.json`);
  }
  for (const name of Object.keys(BASELINE.screens)) if (!seen.has(name)) check(`A ${name}: baseline names a screen this gate does not scan`, false, name);
  for (const page of pages.values()) await page.context().close();
});
