// The module qualification screen in a real browser (roadmap M37): QA declares a module NotQualified with an electronic signature, the server then
// refuses writes to it (403 MODULE_NOT_QUALIFIED) while the page for it still opens; QA declares it Qualified again and writes work. An Analyst
// can read the register but is not offered the declaration.
const { psql, check, api, tokenOf, newPage, signIn, sign, run } = require('./lib.cjs');

run(async (browser) => {
  const analyst = await newPage(browser);
  await signIn(analyst, 'analyst1@gxp.com', '#/module-qualification');
  await analyst.waitForSelector('tr[data-module="eln"]');
  check('V1 an Analyst reads the register but is not offered the declaration', await analyst.locator('button:has-text("Declare...")').count() === 0);

  const qa = await newPage(browser);
  await signIn(qa, 'qa@gxp.com', '#/module-qualification');
  const row = qa.locator('tr[data-module="eln"]');
  await row.waitFor();
  check('V2 a module nobody has declared is shown as not declared, changes allowed', /Not declared: changes are allowed/.test(await row.innerText()));
  await row.locator('button:has-text("Declare...")').click();
  await qa.waitForSelector('[role=dialog] select');
  await qa.locator('[role=dialog] select').selectOption('NotQualified');
  await qa.locator('[role=dialog] input[maxlength="500"]').fill('OQ-ELN not executed');
  await qa.locator('[role=dialog] button:has-text("Sign...")').click();
  await sign(qa, { meaning: 'Module qualification decision', reason: 'ELN has no operational qualification yet' });
  const toast = await qa.waitForSelector('text=/declared NotQualified, signed/', { timeout: 10000 }).then(() => true, () => false);
  check('V3 the signed declaration is accepted and the screen says so', toast);
  check('V4 the row now says read-only in words', await qa.waitForFunction(() => /Read-only: changes are refused/.test(document.querySelector('tr[data-module="eln"]')?.textContent || ''), null, { timeout: 8000 }).then(() => true, () => false));
  check('V5 one QA signature with the MODULE_QUALIFICATION meaning is bound to version 1', psql(`SELECT meaning_code || '|' || signer_role || '|' || record_version FROM signatures WHERE entity_type = 'QualifiedModule' AND entity_id = 'eln'`) === 'MODULE_QUALIFICATION|QA|1');

  const token = await tokenOf('analyst1@gxp.com');
  const write = await api('/eln', { method: 'POST', token, body: {} });
  check('V6 a write to the module is refused by the server with MODULE_NOT_QUALIFIED', write.status === 403 && write.body.code === 'MODULE_NOT_QUALIFIED', write);
  check('V7 and the refusal is a security event', Number(psql(`SELECT count(*) FROM security_events WHERE event_type = 'AUTHZ_DENIED' AND detail::jsonb->>'module' = 'eln'`)) >= 1);
  const read = await api('/eln', { token });
  check('V8 the module\'s records are still readable', read.status === 200, read.status);

  await qa.locator('tr[data-module="eln"] button:has-text("Declare...")').click();
  await qa.waitForSelector('[role=dialog] select');
  await qa.locator('[role=dialog] select').selectOption('Qualified');
  await qa.locator('[role=dialog] button:has-text("Sign...")').click();
  await sign(qa, { meaning: 'Module qualification decision', reason: 'OQ executed and accepted by QA' });
  await qa.waitForSelector('text=/declared Qualified, signed/', { timeout: 10000 }).catch(() => {});
  const again = await api('/eln', { method: 'POST', token, body: {} });
  check('V9 once declared Qualified again, the same write reaches the module (it is refused for its own reasons, not for the scope)', again.status !== 403 || again.body.code !== 'MODULE_NOT_QUALIFIED', again);
  check('V10 no uncaught exception', analyst.errors.length === 0 && qa.errors.length === 0, [...analyst.errors, ...qa.errors]);
});
