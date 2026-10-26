// Arrange helpers shared by the instrument-integration tests (roadmap M21). Not a test file.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { expect } from 'vitest';
import type { TestApp } from '../helpers/app';
import { insertActiveSpec, receiveSample, uniq } from '../helpers/fixtures';

export const PW = 'password';
export const FIXTURES = path.join(__dirname, '..', 'fixtures', 'instrument-data');
export const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name));
export const tempDir = (prefix: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`)));

export async function instrument(t: TestApp, over: { due?: string; status?: string } = {}) {
  const id = uniq('INST');
  await t.db.pool.query(
    `INSERT INTO instruments (id, name, type, status, calibration_due_date, last_calibration_date) VALUES ($1, 'Balance 1', 'Balance', $2, $3, '2026-01-01')`,
    [id, over.status ?? 'Active', over.due ?? '2099-12-31'],
  );
  return id;
}

/** A capture profile written by QA and approved by the Administrator (two people, as the rule demands). */
export async function approvedProfile(t: TestApp, H: Record<string, { Authorization: string }>, body: {
  instrumentId: string; parser: string; watchDir: string; mapping?: Record<string, unknown>; glob?: string; name?: string; approve?: boolean;
}) {
  const created = await t.request.post('/api/instrument-profiles').set(H.qa)
    .send({ name: body.name ?? uniq('Profile'), instrumentId: body.instrumentId, parser: body.parser, watchDir: body.watchDir, glob: body.glob ?? '*', mapping: body.mapping ?? {} });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  if (body.approve === false) return created.body as { id: string; version: number; status: string };
  const approved = await t.request.post(`/api/instrument-profiles/${created.body.id}/approve`).set(H.admin).send({ expectedVersion: created.body.version, password: PW });
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  return approved.body.profile as { id: string; version: number; status: string };
}

/** A sample in Testing with one result (Assay, %, 98.0 to 102.0). */
export async function sampleInTesting(t: TestApp, H: Record<string, { Authorization: string }>) {
  const material = uniq('Mat');
  await insertActiveSpec(t, material, [{ name: 'Assay', unit: '%', limit_kind: 'RANGE', lower: 98.0, upper: 102.0, decimals: 1, text: null }] as any);
  const created = await t.request.post('/api/samples').set(H.analyst1).send({ material, batch: uniq('B') });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  await receiveSample(t, created.body.id);
  const sub = await t.request.post(`/api/samples/${created.body.id}/transition`).set(H.analyst1).send({ action: 'submit', expectedVersion: 1 });
  expect(sub.status, JSON.stringify(sub.body)).toBe(200);
  const { rows } = await t.db.pool.query('SELECT id, version FROM results WHERE sample_id = $1', [created.body.id]);
  return { id: created.body.id as string, resultId: rows[0].id as string };
}

/** The upload route (the same ingestion the folder agent uses). */
export const upload = (t: TestApp, who: { Authorization: string }, profileId: string, fileName: string, content: Buffer | string) =>
  t.request.post('/api/instrument-files').set(who).set('Content-Type', 'application/octet-stream').query({ profileId, fileName }).send(Buffer.from(content));
