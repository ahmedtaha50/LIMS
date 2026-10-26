/**
 * Roadmap M20 (r2-raw-data): raw data files kept as content-addressed blobs (21 CFR 211.194(a), 11.10(e), ALCOA+ original).
 *
 *   - POST /samples/:id/attachments streams the file (application/octet-stream, no base64, no JSON size limit) into
 *     BLOB_DIR/<sha256>, up to ATTACHMENT_MAX_BYTES; the type is decided by the file's first bytes against an allow-list;
 *   - the register row and its audit entry are written in one transaction; the register is append-only;
 *   - every download re-hashes the file: a single changed byte refuses the download (409) and writes an audit entry;
 *   - files are added by the people who enter results, while the sample is being tested, and never once it is Approved.
 */
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';
import { insertActiveSpec, uniq, receiveSample } from '../helpers/fixtures';

const BLOBS = fs.mkdtempSync(path.join(os.tmpdir(), 'rawdata-blobs-'));
process.env.BLOB_DIR = BLOBS;

let t: TestApp;
const H: Record<string, { Authorization: string }> = {};
beforeAll(async () => {
  t = await startTestApp();
  for (const u of ['admin', 'qa', 'reviewer', 'analyst1', 'analyst2']) H[u] = await t.auth(`${u}@gxp.com`);
});
afterAll(() => {
  delete process.env.BLOB_DIR;
  fs.rmSync(BLOBS, { recursive: true, force: true });
});
const sql = (text: string, params: unknown[] = []) => t.db.pool.query(text, params).then(r => r.rows);
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const pdf = (bytes: number) => {
  const b = crypto.randomBytes(bytes);
  Buffer.from('%PDF-1.7\n').copy(b, 0);
  return b;
};

async function sampleInTesting() {
  const material = uniq('Mat');
  await insertActiveSpec(t, material, [{ name: 'Assay', unit: '%', limit_kind: 'RANGE', lower: 98.0, upper: 102.0, decimals: 1, text: null }] as any);
  const created = await t.request.post('/api/samples').set(H.analyst1).send({ material, batch: uniq('B') });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  await receiveSample(t, created.body.id);
  const sub = await t.request.post(`/api/samples/${created.body.id}/transition`).set(H.analyst1).send({ action: 'submit', expectedVersion: 1 });
  expect(sub.status, JSON.stringify(sub.body)).toBe(200);
  const [r] = await sql('SELECT id FROM results WHERE sample_id = $1', [created.body.id]);
  return { id: created.body.id as string, resultId: r.id as string };
}
const upload = (who: string, sampleId: string, body: Buffer, query: Record<string, string>) =>
  t.request.post(`/api/samples/${sampleId}/attachments`).set(H[who]).set('Content-Type', 'application/octet-stream').query(query).send(body);

describe('upload and download', () => {
  it('a 20 MB file uploads with its sha256; the download is the same bytes, checked', async () => {
    const s = await sampleInTesting();
    const file = pdf(20 * 1024 * 1024);
    const res = await upload('analyst1', s.id, file, { fileName: 'HPLC run 42.pdf', resultId: s.resultId });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.attachment).toMatchObject({
      sampleId: s.id, resultId: s.resultId, fileName: 'HPLC run 42.pdf', mediaType: 'application/pdf', kind: 'pdf', bytes: file.length, sha256: sha(file), uploadedBy: 'usr-analyst1',
    });
    expect(sha(fs.readFileSync(path.join(BLOBS, sha(file))))).toBe(sha(file));

    const [audit] = await sql(`SELECT action, new_value, user_id FROM audit_trail WHERE entity = 'Attachment' AND entity_id = $1`, [res.body.attachment.id]);
    expect(audit).toMatchObject({ action: 'Create', user_id: 'usr-analyst1' });
    expect(JSON.parse(audit.new_value)).toMatchObject({ sha256: sha(file), bytes: file.length, fileName: 'HPLC run 42.pdf' });

    const list = await t.request.get(`/api/samples/${s.id}/attachments`).set(H.reviewer);
    expect(list.status).toBe(200);
    expect(list.body.attachments.map((a: any) => a.sha256)).toEqual([sha(file)]);

    const down = await t.request.get(`/api/attachments/${res.body.attachment.id}/content`).set(H.reviewer)
      .buffer(true).parse((r, cb) => { const parts: Buffer[] = []; r.on('data', (c: Buffer) => parts.push(c)); r.on('end', () => cb(null, Buffer.concat(parts))); });
    expect(down.status).toBe(200);
    expect(down.headers['content-type']).toMatch(/application\/pdf/);
    expect(down.headers['x-content-sha256']).toBe(sha(file));
    expect(down.headers['content-disposition']).toMatch(/attachment/);
    expect(sha(down.body as Buffer)).toBe(sha(file));
  });

  it('one changed byte on disk refuses the download and writes an audit entry', async () => {
    const s = await sampleInTesting();
    const file = pdf(64 * 1024);
    const res = await upload('analyst1', s.id, file, { fileName: 'spectrum.pdf' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const stored = path.join(BLOBS, sha(file));
    fs.chmodSync(stored, 0o644);
    const fd = fs.openSync(stored, 'r+');
    fs.writeSync(fd, Buffer.from([file[5000] ^ 0xff]), 0, 1, 5000);
    fs.closeSync(fd);

    const down = await t.request.get(`/api/attachments/${res.body.attachment.id}/content`).set(H.reviewer);
    expect(down.status).toBe(409);
    expect(down.body.code).toBe('ATTACHMENT_INTEGRITY_FAILED');
    expect(down.body.error).toMatch(/sha256/i);
    const audit = await sql(`SELECT action, user_id, reason FROM audit_trail WHERE entity = 'Attachment' AND entity_id = $1 ORDER BY sequence`, [res.body.attachment.id]);
    expect(audit.map(a => a.action)).toEqual(['Create', 'IntegrityCheckFailed']);
    expect(audit[1]).toMatchObject({ user_id: 'usr-reviewer' });
    expect(audit[1].reason).toContain(sha(file));

    fs.rmSync(stored);
    const gone = await t.request.get(`/api/attachments/${res.body.attachment.id}/content`).set(H.reviewer);
    expect(gone.status).toBe(409);
    expect(gone.body.error).toMatch(/missing/i);
  });

  it('the same content uploaded twice is stored once and registered twice', async () => {
    const s = await sampleInTesting();
    const file = pdf(1024);
    expect((await upload('analyst1', s.id, file, { fileName: 'a.pdf' })).status).toBe(201);
    expect((await upload('analyst1', s.id, file, { fileName: 'b.pdf' })).status).toBe(201);
    expect((await sql('SELECT file_name FROM attachments WHERE sample_id = $1 ORDER BY file_name', [s.id])).map(r => r.file_name)).toEqual(['a.pdf', 'b.pdf']);
    expect(fs.readdirSync(BLOBS).filter(f => f === sha(file))).toHaveLength(1);
  });
});

describe('what is accepted', () => {
  it('refuses a type outside the allow-list, a name whose extension does not match the content, and an empty file', async () => {
    const s = await sampleInTesting();
    const exe = Buffer.concat([Buffer.from('MZ'), crypto.randomBytes(2000)]);
    const a = await upload('analyst1', s.id, exe, { fileName: 'tool.exe' });
    expect(a.status, JSON.stringify(a.body)).toBe(415);
    const b = await upload('analyst1', s.id, exe, { fileName: 'report.pdf' });
    expect(b.status).toBe(415);
    const c = await upload('analyst1', s.id, pdf(100), { fileName: 'report.csv' });
    expect(c.status).toBe(415);
    const d = await upload('analyst1', s.id, Buffer.alloc(0), { fileName: 'empty.pdf' });
    expect(d.status).toBe(400);
    expect(await sql('SELECT 1 FROM attachments WHERE sample_id = $1', [s.id])).toHaveLength(0);
    expect(fs.readdirSync(BLOBS).filter(f => f.endsWith('.part'))).toEqual([]);
  });

  it('accepts a CSV export and a PNG, typed from their content', async () => {
    const s = await sampleInTesting();
    const csv = await upload('analyst1', s.id, Buffer.from('time,absorbance\n0.0,0.001\n0.1,0.152\n'), { fileName: 'uv.csv' });
    expect(csv.status, JSON.stringify(csv.body)).toBe(201);
    expect(csv.body.attachment).toMatchObject({ kind: 'text', mediaType: 'text/csv' });
    const png = await upload('analyst1', s.id, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(500)]), { fileName: 'plate.png' });
    expect(png.status).toBe(201);
    expect(png.body.attachment.mediaType).toBe('image/png');
  });

  it('refuses a file above ATTACHMENT_MAX_BYTES with 413 and keeps nothing', async () => {
    const s = await sampleInTesting();
    process.env.ATTACHMENT_MAX_BYTES = '4096';
    try {
      const res = await upload('analyst1', s.id, pdf(10_000), { fileName: 'big.pdf' });
      expect(res.status).toBe(413);
    } finally { delete process.env.ATTACHMENT_MAX_BYTES; }
    expect(await sql('SELECT 1 FROM attachments WHERE sample_id = $1', [s.id])).toHaveLength(0);
    expect(fs.readdirSync(BLOBS).filter(f => f.endsWith('.part'))).toEqual([]);
  });

  it('a file sent without a declared size (chunked) is cut off at the limit as it streams', async () => {
    const s = await sampleInTesting();
    const server = t.app.listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    process.env.ATTACHMENT_MAX_BYTES = '4096';
    try {
      const { port } = server.address() as { port: number };
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: `/api/samples/${s.id}/attachments?fileName=big.pdf`,
          headers: { ...H.analyst1, 'Content-Type': 'application/octet-stream', 'Transfer-Encoding': 'chunked' } }, res => { res.resume(); resolve(res.statusCode!); });
        req.on('error', reject);
        const body = pdf(10_000);
        for (let i = 0; i < body.length; i += 1000) req.write(body.subarray(i, i + 1000));
        req.end();
      });
      expect(status).toBe(413);
    } finally {
      delete process.env.ATTACHMENT_MAX_BYTES;
      await new Promise(r => server.close(r));
    }
    expect(await sql('SELECT 1 FROM attachments WHERE sample_id = $1', [s.id])).toHaveLength(0);
    expect(fs.readdirSync(BLOBS).filter(f => f.endsWith('.part'))).toEqual([]);
  });

  it('needs the octet-stream content type and only the declared query keys', async () => {
    const s = await sampleInTesting();
    const text = await t.request.post(`/api/samples/${s.id}/attachments`).set(H.analyst1).set('Content-Type', 'text/plain').query({ fileName: 'a.pdf' }).send('%PDF-1.7');
    expect(text.status).toBe(415);
    const json = await t.request.post(`/api/samples/${s.id}/attachments`).set(H.analyst1).query({ fileName: 'a.pdf' }).send({ data: 'JVBERi0=' });
    expect(json.status).toBe(400);
    const extra = await upload('analyst1', s.id, pdf(100), { fileName: 'a.pdf', uploadedBy: 'usr-qa' });
    expect(extra.status).toBe(400);
    const noName = await upload('analyst1', s.id, pdf(100), {});
    expect(noName.status).toBe(400);
  });
});

describe('who and when', () => {
  it('a Reviewer or QA cannot add raw data (403); a result of another sample is refused', async () => {
    const s = await sampleInTesting();
    for (const who of ['reviewer', 'qa']) expect((await upload(who, s.id, pdf(100), { fileName: 'a.pdf' })).status, who).toBe(403);
    const other = await sampleInTesting();
    expect((await upload('analyst1', s.id, pdf(100), { fileName: 'a.pdf', resultId: other.resultId })).status).toBe(404);
    expect((await upload('analyst1', 'SMP-NONE', pdf(100), { fileName: 'a.pdf' })).status).toBe(404);
  });

  it('nothing is added once the sample is Approved (423) or under review (409); the register is append-only', async () => {
    const s = await sampleInTesting();
    const first = await upload('analyst1', s.id, pdf(100), { fileName: 'a.pdf' });
    expect(first.status).toBe(201);
    await sql(`UPDATE samples SET state = 'Pending Review' WHERE id = $1`, [s.id]);
    expect((await upload('analyst1', s.id, pdf(100), { fileName: 'b.pdf' })).status).toBe(409);
    await sql(`UPDATE samples SET state = 'Approved' WHERE id = $1`, [s.id]);
    const locked = await upload('analyst1', s.id, pdf(100), { fileName: 'c.pdf' });
    expect(locked.status).toBe(423);
    await expect(sql(`UPDATE attachments SET file_name = 'x.pdf' WHERE id = $1`, [first.body.attachment.id])).rejects.toThrow(/append-only/);
    await expect(sql(`DELETE FROM attachments WHERE id = $1`, [first.body.attachment.id])).rejects.toThrow(/append-only/);
    // Reading stays possible after approval.
    expect((await t.request.get(`/api/attachments/${first.body.attachment.id}/content`).set(H.qa)).status).toBe(200);
  });
});
