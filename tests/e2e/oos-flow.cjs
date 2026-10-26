// An out-of-specification result entered at the bench, in a real browser (roadmap M10, M19, M26 and M37): the analyst saves the whole grid with
// one value outside its limits; the server judges it, opens exactly one investigation in the same save and the screen says so; QA finds the
// investigation, in Phase I with a due date, in the OOS register; the audit trail has the result and the investigation.
const { psql, check, api, tokenOf, newPage, signIn, sampleInTesting, run } = require('./lib.cjs');

run(async (browser) => {
  const { id } = await sampleInTesting();
  const rows = psql(`SELECT id || '|' || parameter || '|' || coalesce(limit_kind, '') || '|' || coalesce(lower_text, '') || '|' || coalesce(upper_text, '') FROM results WHERE sample_id = '${id}' ORDER BY id`).split('\n').map(l => l.split('|'));
  const numeric = rows.find(r => r[2] === 'RANGE');
  const valueFor = (r) => (r === numeric ? String(Number(r[4]) + 25) : r[2] === 'TEXT' ? 'Complies' : r[2] === 'PRESENCE' ? 'Absent' : String((Number(r[3]) + Number(r[4])) / 2));

  const page = await newPage(browser);
  await signIn(page, 'analyst1@gxp.com', `#/samples/${id}`);
  await page.waitForSelector('input[id^="value-"]');
  for (const r of rows) await page.fill(`#value-${r[0]}`, valueFor(r));
  await page.focus(`#value-${rows[0][0]}`);
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => document.body.innerText.includes('saved.'), null, { timeout: 10000 }).catch(() => {});

  const oos = psql(`SELECT count(*) || '|' || coalesce(max(status), '') FROM oos_investigations WHERE sample_id = '${id}'`);
  check('O1 saving one out-of-limit value opens exactly one investigation, in the same save', oos.startsWith('1|'), oos);
  const body = (await page.evaluate(() => document.body.innerText)).toLowerCase();
  check('O2 the screen says that an investigation was opened (no silent consequence)', /investigation/.test(body) && /oos/.test(body), body.slice(0, 300));
  const row = await page.textContent(`tr[data-row="${numeric[0]}"]`);
  check('O3 the saved row shows OOS as the server judged it', /OOS/.test(row), row);
  check('O4 the values are stored as typed and the result carries the OOS flag', psql(`SELECT value || '|' || is_oos FROM results WHERE id = '${numeric[0]}'`) === `${valueFor(numeric)}|true`, psql(`SELECT value || '|' || is_oos FROM results WHERE id = '${numeric[0]}'`));
  check('O5 the audit trail holds the result entry and the investigation', Number(psql(`SELECT count(*) FROM audit_trail WHERE entity IN ('Result', 'OOS') AND (entity_id = '${numeric[0]}' OR entity_id IN (SELECT id FROM oos_investigations WHERE sample_id = '${id}'))`)) >= 2);

  const qa = await newPage(browser);
  await signIn(qa, 'qa@gxp.com', '#/oos');
  await qa.waitForSelector('main#main');
  const found = await qa.waitForSelector(`text=${id}`, { timeout: 10000 }).then(() => true, () => false);
  check('O6 QA finds the investigation of that sample in the OOS register', found);
  const list = await api('/oos', { token: await tokenOf('qa@gxp.com') });
  const mine = Array.isArray(list.body) ? list.body.find(o => o.sampleId === id) : null;
  check('O7 it is in Phase I with a due date the server worked out', !!mine && mine.phase === 'Phase I' && /^\d{4}-\d{2}-\d{2}$/.test(mine.dueDate || ''), mine && { phase: mine.phase, dueDate: mine.dueDate, status: mine.status });
  check('O8 no uncaught exception', page.errors.length === 0 && qa.errors.length === 0, [...page.errors, ...qa.errors]);
});
