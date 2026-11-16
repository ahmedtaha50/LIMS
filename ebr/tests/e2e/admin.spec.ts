import { expect, test } from '@playwright/test';
import { go, PW, signIn, totpNow } from './support/api.js';

// E32: what was reachable only through the API is done on the screens, at tablet and desktop size.
test('E32#2 E32#4 E32#3: accounts, logbooks, logbook type versions, recipe copy and the audit trail on the screens', async ({ page }, info) => {
  const vp = info.project.name, VP = vp.toUpperCase();
  await signIn(page, `e2e-admin-${vp}`, totpNow());

  // E32#2: an account created with a role and a first password, then given a second role with a reason
  await go(page, 'Users', vp);
  const create = page.getByRole('form', { name: 'New account' });
  await create.getByLabel('User name *').fill(`e2e-made-${vp}`);
  await create.getByLabel('Full name *').fill(`Made on ${vp}`);
  await create.getByRole('checkbox', { name: 'operator' }).check();
  await create.getByLabel('First password *').fill(PW);
  await create.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText(`Account e2e-made-${vp} created.`)).toBeVisible();
  const row = page.getByRole('listitem').filter({ hasText: `e2e-made-${vp}` });
  await row.getByRole('button', { name: 'Change' }).click();
  const change = page.getByRole('form', { name: `Change account e2e-made-${vp}` });
  await change.getByRole('checkbox', { name: 'supervisor' }).check();
  await change.getByLabel('Reason *').fill('moved to the supervisor team');
  await change.getByRole('button', { name: 'Save' }).click();
  await expect(row.getByText(/operator, supervisor/)).toBeVisible();

  // E32#4: a logbook created for a room, changed, then retired with a signature
  await go(page, 'Logbooks', vp);
  await page.getByRole('button', { name: 'New logbook' }).click();
  const lb = page.getByRole('form', { name: 'New logbook' });
  await lb.getByLabel('Logbook type *').selectOption({ label: 'Room logbook' });
  await lb.getByLabel('Kind of object *').selectOption('room');
  await lb.getByLabel('Code *').fill(`RM-E32-${VP}`);
  await lb.getByLabel('Name *').fill(`Room made on ${vp}`);
  await lb.getByRole('button', { name: 'Create logbook' }).click();
  await expect(page.getByRole('heading', { name: `RM-E32-${VP} · Room made on ${vp}` })).toBeVisible();
  const retire = page.getByRole('form', { name: 'Retire logbook' });
  await retire.getByLabel('Reason *').fill('room converted to storage');
  await retire.getByLabel('Your password (signature)').fill(PW);
  await retire.getByRole('button', { name: 'Retire logbook' }).click();
  await expect(page.getByText('This logbook is retired: it can be read, not written.')).toBeVisible();

  // E32#4: a recipe version copied into a new recipe (draft)
  await go(page, 'Recipes (MBR)', vp);
  const card = page.getByRole('region', { name: `E2E-MIX-${vp} · Mixing E2E ${vp}` });
  await card.getByText('Copy into a new recipe').click();
  const copy = card.getByRole('form', { name: 'Copy version 1 into a new recipe' });
  await copy.getByLabel('Recipe code *').fill(`COPY-${VP}`);
  await copy.getByLabel('Product *').fill(`Copied on ${vp}`);
  await copy.getByRole('button', { name: 'Copy as a new draft' }).click();
  await expect(page.getByRole('region', { name: `COPY-${VP} · Copied on ${vp}` }).locator('p', { hasText: /Version 1 · draft/ })).toBeVisible();

  // E32#4: a new version of a logbook type started and its draft edited (each viewport its own type)
  await go(page, 'Logbook types', vp);
  const typeName = vp === 'tablet' ? 'Room logbook (built in)' : 'Equipment logbook (built in)';
  const type = page.getByRole('region', { name: typeName });
  await type.getByRole('button', { name: 'Start a new version' }).click();
  await expect(type.getByText(/Version 2/)).toBeVisible();
  await type.getByRole('button', { name: 'Edit draft' }).click();
  await type.getByRole('button', { name: 'Save draft' }).click();
  await expect(type.getByRole('button', { name: 'Edit draft' })).toBeVisible();

  // E32#3: the audit trail reviewed on the screen, the chain verified
  await go(page, 'Audit trail', vp);
  const filter = page.getByRole('form', { name: 'Filter the audit trail' });
  await filter.getByLabel('Action').fill('user.');
  await filter.getByRole('button', { name: 'Show' }).click();
  await expect(page.getByRole('list', { name: 'Audit entries' }).getByText('user.created').first()).toBeVisible();
  await page.getByRole('button', { name: 'Verify the chain' }).click();
  await expect(page.getByText(/The chain is intact: \d+ entries checked\./)).toBeVisible();
});
