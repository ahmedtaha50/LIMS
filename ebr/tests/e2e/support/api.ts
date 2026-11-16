import { createHmac } from 'node:crypto';
import { expect, request, type APIRequestContext, type Page } from '@playwright/test';

export const PW = 'e2e password long enough';
/** RFC 6238 code of the seeded QA secret ("12345678901234567890"). */
export function totpNow() {
  const key = Buffer.from('12345678901234567890'), msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const h = createHmac('sha1', key).update(msg).digest(), o = h[h.length - 1]! & 15;
  return String((((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!) % 1_000_000).padStart(6, '0');
}
/** Another person working through the API (their own session), to prepare what a test does not exercise in the screen. */
export async function asUser(baseURL: string, username: string, code?: string): Promise<APIRequestContext> {
  const ctx = await request.newContext({ baseURL });
  const r = await ctx.post('/api/auth/login', { data: { username, password: PW, ...(code ? { totp: code } : {}) } });
  expect(r.status(), `sign-in of ${username}`).toBe(200);
  return ctx;
}
export async function signIn(page: Page, username: string, code?: string) {
  await page.goto('/');
  await page.getByLabel('User name').fill(username);
  await page.getByLabel('Password', { exact: true }).fill(PW);
  if (code) await page.getByLabel('Authenticator code').fill(code);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByLabel('Signed in as')).toBeVisible();
}
export const go = async (page: Page, title: string, project: string) =>
  (project === 'tablet' ? page.getByRole('navigation', { name: 'Main (bottom)' }) : page.getByRole('navigation', { name: 'Main', exact: true })).getByRole('button', { name: title, exact: true }).click();
/** Creates a batch from the seeded recipe with this code, as the supervisor; returns its id. */
export async function newBatch(sup: APIRequestContext, recipeCode: string, batchNumber: string) {
  const m = (await (await sup.get('/api/mbrs')).json()).find((x: { code: string }) => x.code === recipeCode);
  const r = await sup.post('/api/batches', { data: { mbrMasterId: m.id, batchNumber } });
  expect(r.status()).toBe(201);
  return (await r.json()) as { id: string; version: number; steps: Array<{ id: string; version: number }> };
}
