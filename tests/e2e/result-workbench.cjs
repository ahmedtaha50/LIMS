// The bench-side result workbench in a real browser (roadmap M19 and M37): keyboard walk, one save for all rows, OOS shown at once,
// a stale row blocks the whole save, an overdue instrument cannot be picked, one audit row per changed value.
// Usage: BASE_URL=http://127.0.0.1:3000 SQL_DB_NAME=<db> node tests/e2e/result-workbench.cjs
const { psql, check, info, api, tokenOf, newPage, signIn, sampleInTesting, run, RUN } = require('./lib.cjs');

run(async (browser) => {
  const { id, material } = await sampleInTesting();
  const admin = await tokenOf('admin@gxp.com');
  const rows = psql(`SELECT id || '|' || parameter || '|' || coalesce(limit_kind, '') || '|' || coalesce(lower_text, '') || '|' || coalesce(upper_text, '') FROM results WHERE sample_id = '${id}' ORDER BY id`).split('\n').map(l => l.split('|'));
  info(`sample ${id} (${material}): ${rows.map(r => `${r[1]} ${r[2]} ${r[3]}..${r[4]}`).join('; ')}`);

  const due = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  const instId = `INST-E2E-${RUN}`;
  psql(`INSERT INTO instruments (id, name, type, status, calibration_due_date, last_calibration_date) VALUES ('${instId}', 'Overdue HPLC', 'HPLC', 'Active', '${due}', '2026-01-01')`);

  const page = await newPage(browser);
  await signIn(page, 'analyst1@gxp.com', `#/samples/${id}`);
  await page.waitForSelector('input[id^="value-"]');

  const inputs = await page.$$('input[id^="value-"]');
  const order = await Promise.all(inputs.map(i => i.evaluate(e => e.id.slice('value-'.length))));
  rows.sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])); // the grid's order (the specification's), not the database id order
  check('W1 one value input per parameter of the specification', inputs.length === rows.length, { inputs: inputs.length, rows: rows.length });

  const overdueOption = await page.$(`select[id^="instrument-"] option[value="${instId}"]`);
  const disabled = overdueOption ? await overdueOption.evaluate(o => o.disabled) : null;
  const label = overdueOption ? await overdueOption.textContent() : null;
  check('W2 the instrument 3 days overdue is disabled in the list and shows its due date', disabled === true && label.includes(due), { disabled, label });

  const valueFor = (r) => (r[2] === 'TEXT' ? 'Complies' : r[2] === 'PRESENCE' ? 'Absent' : (r[3] || r[4]));
  await inputs[0].focus();
  await page.keyboard.type(valueFor(rows[0]));
  await page.keyboard.press('Enter');
  const focused = await page.evaluate(() => document.activeElement && document.activeElement.id);
  check('W3 Enter moves the focus to the next row', rows.length < 2 || focused === `value-${rows[1][0]}`, { focused });

  const numeric = rows.findIndex(r => r[2] === 'RANGE' || r[2] === 'NLT' || r[2] === 'NMT');
  if (numeric >= 0) {
    const r = rows[numeric];
    const bad = r[2] === 'NLT' ? String(Number(r[3]) - 50) : String(Number(r[4]) + 50);
    await page.fill(`#value-${r[0]}`, bad);
    const chip = await page.textContent(`tr[data-row="${r[0]}"] td:nth-of-type(5)`);
    check('W4 a value outside the limits shows OOS at once, marked advisory (the server decides on save)', /OOS/.test(chip) && /advisory/i.test(chip), { chip });
    await page.fill(`#value-${r[0]}`, r[2] === 'NLT' ? r[3] : r[4]);
  }
  for (let i = 1; i < rows.length; i++) await page.fill(`#value-${rows[i][0]}`, valueFor(rows[i]));
  await page.waitForTimeout(1500);
  check('W5 nothing is saved by itself: no value is written before the save', psql(`SELECT count(*) FROM results WHERE sample_id = '${id}' AND value IS NOT NULL`) === '0');

  const seqBefore = Number(psql('SELECT coalesce(max(sequence), 0) FROM audit_trail'));
  await page.focus(`#value-${rows[0][0]}`);
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => document.body.innerText.includes('saved.'), null, { timeout: 10000 }).catch(() => {});
  const saved = psql(`SELECT count(*) FROM results WHERE sample_id = '${id}' AND value IS NOT NULL`);
  const audits = psql(`SELECT count(*) FROM audit_trail WHERE entity = 'Result' AND sequence > ${seqBefore} AND entity_id IN (SELECT id FROM results WHERE sample_id = '${id}')`);
  check('W6 Ctrl+S saves every row at once, with one audit row per value', saved === String(rows.length) && audits === String(rows.length), { saved, audits });

  if (numeric >= 0) {
    const r = rows[numeric];
    await page.waitForSelector(`input#value-${rows[0][0]}`);
    const cur = psql(`SELECT value FROM results WHERE id = '${r[0]}'`);
    const mine = r[2] === 'RANGE' ? r[4] : (r[2] === 'NLT' ? String(Number(r[3]) + 1) : String(Number(r[4]) / 2));
    const theirs = r[2] === 'RANGE' ? r[3] : (r[2] === 'NLT' ? String(Number(r[3]) + 2) : String(Number(r[4]) / 4));
    await page.fill(`#value-${r[0]}`, mine === cur ? theirs : mine);
    const reasonVisible = await page.isVisible(`#reason-${r[0]}`);
    const others = await page.$$('input[id^="reason-"]');
    check('W7 overwriting a value shows the reason field of that row only', reasonVisible && others.length === 1, { reasonVisible, n: others.length });
    await page.keyboard.press('Control+s');
    await page.waitForTimeout(800);
    const heldBack = await page.textContent(`tr[data-row-detail="${r[0]}"]`);
    check('W8 an overwrite without its reason is held back on the screen and names the reason', /reason/i.test(heldBack || ''), { heldBack });
    await page.fill(`#reason-${r[0]}`, 'worksheet re-read at the bench');
    await page.selectOption(`#reasonCode-${r[0]}`, 'TRANSCRIPTION_ERROR');
    const v = Number(psql(`SELECT version FROM results WHERE id = '${r[0]}'`));
    const other = await api(`/samples/${id}/results/${r[0]}`, { method: 'PUT', token: admin, body: { value: cur !== theirs ? theirs : mine, reason: 'colleague corrected the value', reasonCode: 'TRANSCRIPTION_ERROR', expectedVersion: v } });
    if (other.status !== 200) info(`colleague PUT ${other.status} ${JSON.stringify(other.body)}`);
    const before = psql('SELECT count(*) FROM audit_trail');
    await page.keyboard.press('Control+s');
    await page.waitForSelector(`tr[data-row="${r[0]}"][data-stale="true"]`, { timeout: 8000 }).catch(() => {});
    const stale = await page.$(`tr[data-row="${r[0]}"][data-stale="true"]`);
    const msg = await page.textContent(`tr[data-row-detail="${r[0]}"]`).catch(() => null);
    check('W9 a stale row blocks the whole save, is highlighted, and the screen says who changed it', !!stale && /changed by someone else/.test(msg || ''), { msg });
    check('W10 the refused save wrote nothing', psql('SELECT count(*) FROM audit_trail') === before);
  }
  check('W11 no uncaught exception', page.errors.length === 0, page.errors);
});
