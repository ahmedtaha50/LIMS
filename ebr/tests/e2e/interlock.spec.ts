import { expect, test } from '@playwright/test';
import { PW, asUser, go, newBatch, signIn } from './support/api.js';

test('a dirty mixer is refused at the step; once cleaned it is used and its logbook shows it in use (E13)', async ({ page, baseURL }, info) => {
  const vp = info.project.name, number = `B-MIX-${vp}`, mixer = `MX-E2E-${vp}`;
  const sup = await asUser(baseURL!, 'e2e-supervisor');
  await newBatch(sup, `E2E-MIX-${vp}`, number);
  await signIn(page, 'e2e-operator');
  await go(page, 'Batches', vp);
  await page.getByRole('button', { name: new RegExp(number) }).click();
  const step = page.getByRole('form', { name: 'Current step' });
  await step.getByLabel('Equipment code *').fill(mixer);
  await step.getByLabel('Your password (signature) *').fill(PW);
  await step.getByRole('button', { name: 'Sign step' }).click();
  await expect(step.getByRole('alert')).toContainText(`${mixer} Interlock mixer ${vp} is dirty`);

  // the operator cleans it in its logbook (screen tested in logbook.spec.ts), then the same step goes through
  const op = await asUser(baseURL!, 'e2e-operator');
  const lb = (await (await op.get('/api/logbooks?objectKind=equipment')).json()).find((l: { objectCode: string }) => l.objectCode === mixer);
  expect((await op.post(`/api/logbooks/${lb.id}/entries`, { data: { kind: 'cleaning', values: { method: 'major' }, password: PW } })).status()).toBe(201);
  await step.getByRole('button', { name: 'Sign step' }).click();
  await expect(page.getByRole('list', { name: 'Steps' }).getByText(/Mixer · ✓|✓ done/)).toBeVisible();

  await go(page, 'Logbooks', vp);
  await page.getByRole('button', { name: new RegExp(mixer) }).click();
  await expect(page.getByText('In use', { exact: true })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Entries' }).getByText(number, { exact: true })).toBeVisible();   // the start of use names the batch
});
