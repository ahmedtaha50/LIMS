// Signing in with an authenticator code, in a real browser (roadmap M06 and M37). The first screen of the application must ask a TOTP user
// for the code (the old screen tested the wrong property and let such a user through with the token "undefined"), refuse a wrong code with
// a visible message, and accept the right one with a real session token. Reverting the fix in src/lib/api.ts turns L1 red.
const { psql, q, check, newPage, run, RUN, BASE_URL, ADMIN } = require('./lib.cjs');

const TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

run(async (browser) => {
  const { generateSync } = await import('otplib');
  const id = `usr-lt-${RUN}`;
  const email = `lt.${RUN}@gxp.test`;
  psql(`INSERT INTO users (id, uid, name, role, email, password_hash, has_completed_software_training, totp_secret, totp_enabled)
        SELECT '${id}', 'uid-${id}', ${q('LT Analyst')}, 'Analyst', '${email}', password_hash, true, '${TOTP_SECRET}', true FROM users WHERE lower(email) = lower('${ADMIN.email}')`);

  const page = await newPage(browser);
  await page.goto(BASE_URL + '/');
  await page.waitForSelector('input[type=email]');
  await page.fill('input[type=email]', email);
  await page.fill('input[type=password]', ADMIN.password);
  await page.click('button[type=submit]');
  const asked = await page.waitForSelector('input[name=code]', { timeout: 7000 }).then(() => true, () => false);
  check('L1 a user with an authenticator is asked for the code after the password', asked && /Authenticator code/i.test(await page.evaluate(() => document.body.innerText)));
  const token = () => page.evaluate(() => sessionStorage.getItem('gxp_token'));
  check('L2 no session exists before the code is given', (await token()) === null);

  if (asked) {
    await page.fill('input[name=code]', '000000');
    await page.click('button[type=submit]');
    const refused = await page.waitForSelector('[role=alert]', { timeout: 7000 }).then(() => true, () => false);
    check('L3 a wrong code is refused with a message on the screen, not silently', refused && /invalid/i.test(await page.locator('[role=alert]').first().innerText()));
    check('L4 and still no session exists', (await token()) === null);

    await page.fill('input[name=code]', generateSync({ secret: TOTP_SECRET }));
    await page.click('button[type=submit]');
    const entered = await page.waitForSelector('aside nav', { state: 'attached', timeout: 8000 }).then(() => true, () => false);
    check('L5 the right code reaches the application', entered);
    const t = await token();
    check('L6 with a real signed token (three parts), not the text "undefined"', !!t && t !== 'undefined' && t.split('.').length === 3, t);
    check('L7 the server has one active session for the user', psql(`SELECT count(*) FROM sessions WHERE user_id = '${id}' AND revoked_at IS NULL`) === '1');
  }
  check('L8 no uncaught exception', page.errors.length === 0, page.errors);
});
