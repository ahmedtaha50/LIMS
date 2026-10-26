/**
 * Instrument data capture (roadmap M21, r2-instrument-integration): what the folder agent and the uploads captured, and what an
 * analyst decides about it.
 *
 *   Values waiting   each captured value with the result it would update. Accept writes it through the normal result rules (a named
 *                    analyst, a calibrated instrument, the current result version); Reject needs a reason. A sample with a value waiting
 *                    cannot be submitted for review.
 *   Files            every captured file: parse status, the readable reason when it could not be read, where it went, its sha256.
 *   Profiles         the capture profiles (instrument, folder, pattern, parser, mapping). A profile is a Draft until a second person
 *                    approves it with an e-signature; an edit of an approved profile makes it a Draft again. Dry run shows the rows a
 *                    sample of file text would give.
 *
 * What the user may do comes from GET /permissions/me; the server decides again on every call. Every outcome is a toast or an inline
 * message. The chromatography data system stays the record of raw chromatographic data: only exported summary values come here.
 */
import { formatDateTime } from '../lib/format';
import React, { useCallback, useEffect, useState } from 'react';
import { Cable, Upload } from 'lucide-react';
import { apiFetch, errorMessage, type SelfUser } from '../lib/api';
import { hasPermission } from '../lib/permissions';
import { RESULT_CHANGE_CODES, VERSION_CODE_LABELS, type ResultChangeCode } from '../server/services/result-hooks/codes';
import { ElectronicSignatureModal } from './ElectronicSignatureModal';
import { Badge, stateTone, type Tone } from './ui/Badge';
import { Button } from './ui/Button';
import { Field, fieldErrors, inputClass } from './ui/Field';
import { Modal } from './ui/Modal';
import { useToast } from './ui/Toast';

export interface ImportValue {
  id: string; fileId: string; fileName: string; sha256: string; instrumentId: string; lineNo: number; sampleRef: string | null; parameter: string;
  value: string; unit: string | null; state: string; version: number;
  match: { resultId: string; sampleId: string; value: string | null; version: number; unit: string | null; sampleState: string } | null;
}
export interface CapturedFile {
  id: string; fileName: string; sha256: string; bytes: number; parseStatus: 'Parsed' | 'Failed'; parseError: string | null; rowCount: number;
  disposition: string; dispositionNote: string | null; receivedAt: string; source: string; profileName: string; instrumentName: string; instrumentId: string; pendingRows: number;
}
export interface Profile {
  id: string; name: string; instrumentId: string; instrumentName?: string; parser: string; watchDir: string; glob: string; mapping: Record<string, unknown>;
  status: string; version: number; createdBy: string; approvedBy: string | null;
}

const short = (sha: string) => sha.slice(0, 12);
const when = (s: string) => formatDateTime(s);
const PARSE_TONE: Record<string, Tone> = { Parsed: 'success', Failed: 'danger' };

// ---- the three tables (pure: rendered with the data they are given) --------------------------------------------------------------

export function ImportValuesTable({ rows, canDecide, busy, onAccept, onReject }: {
  rows: ImportValue[]; canDecide: boolean; busy: string | null; onAccept: (r: ImportValue) => void; onReject: (r: ImportValue) => void;
}) {
  if (rows.length === 0) return <p className="p-6 text-sm text-slate-600">No captured value is waiting for acceptance.</p>;
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">Captured instrument values waiting for acceptance</caption>
      <thead className="text-start text-xs uppercase text-slate-600 border-b border-slate-300">
        <tr><th scope="col" className="p-2">Sample</th><th scope="col" className="p-2">Parameter</th><th scope="col" className="p-2">Captured value</th><th scope="col" className="p-2">Result now</th><th scope="col" className="p-2">File</th><th scope="col" className="p-2">Decision</th></tr>
      </thead>
      <tbody>
        {rows.map(r => (
          <tr key={r.id} className="border-b border-slate-200 align-top" data-row={r.id}>
            <td className="p-2">{r.sampleRef ?? <span className="text-slate-600">no sample named</span>}</td>
            <td className="p-2">{r.parameter}</td>
            <td className="p-2 font-mono">{r.value}{r.unit ? ` ${r.unit}` : ''}</td>
            <td className="p-2">
              {r.match
                ? <span>{r.match.value ?? 'not entered'} <Badge tone={stateTone(r.match.sampleState)}>{r.match.sampleState}</Badge></span>
                : <span className="text-amber-800">No result named “{r.parameter}” for this sample: reject it, or accept it through the API with the result id.</span>}
            </td>
            <td className="p-2"><div>{r.fileName}, line {r.lineNo}</div><div className="font-mono text-xs text-slate-600" title={r.sha256}>{short(r.sha256)}</div></td>
            <td className="p-2">
              {canDecide ? (
                <div className="flex gap-2">
                  <Button size="sm" variant="primary" busy={busy === r.id} disabled={!r.match || r.match.sampleState !== 'Testing'} onClick={() => onAccept(r)}>Accept</Button>
                  <Button size="sm" variant="secondary" busy={busy === r.id} onClick={() => onReject(r)}>Reject</Button>
                </div>
              ) : <span className="text-xs text-slate-600">Analysts decide</span>}
              {r.match && r.match.sampleState !== 'Testing' && <div className="text-xs text-amber-800 mt-1">The sample is {r.match.sampleState}: results are entered while it is in Testing.</div>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function FilesTable({ files }: { files: CapturedFile[] }) {
  if (files.length === 0) return <p className="p-6 text-sm text-slate-600">No instrument file has been captured yet.</p>;
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">Captured instrument files</caption>
      <thead className="text-start text-xs uppercase text-slate-600 border-b border-slate-300">
        <tr><th scope="col" className="p-2">File</th><th scope="col" className="p-2">Instrument</th><th scope="col" className="p-2">Result of reading it</th><th scope="col" className="p-2">Where it went</th><th scope="col" className="p-2">Captured</th></tr>
      </thead>
      <tbody>
        {files.map(f => (
          <tr key={f.id} className="border-b border-slate-200 align-top" data-file={f.id}>
            <td className="p-2"><div>{f.fileName}</div><div className="font-mono text-xs text-slate-600" title={f.sha256}>{f.sha256}</div></td>
            <td className="p-2">{f.instrumentName}<div className="text-xs text-slate-600">{f.profileName}</div></td>
            <td className="p-2">
              <Badge tone={PARSE_TONE[f.parseStatus] ?? 'neutral'}>{f.parseStatus}</Badge>
              {f.parseStatus === 'Parsed' ? <div className="text-xs mt-1">{f.rowCount} value(s){f.pendingRows ? `, ${f.pendingRows} waiting` : ''}</div> : <div className="text-xs mt-1 text-red-800" role="note">{f.parseError}</div>}
            </td>
            <td className="p-2">{f.disposition}{f.dispositionNote && <div className="text-xs text-slate-600">{f.dispositionNote}</div>}</td>
            <td className="p-2 whitespace-nowrap">{when(f.receivedAt)}<div className="text-xs text-slate-600">{f.source === 'watch' ? 'watch folder' : 'handed in'}</div></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ProfilesTable({ profiles, canManage, canApprove, me, onEdit, onApprove, onRetire }: {
  profiles: Profile[]; canManage: boolean; canApprove: boolean; me: string | undefined;
  onEdit: (p: Profile) => void; onApprove: (p: Profile) => void; onRetire: (p: Profile) => void;
}) {
  if (profiles.length === 0) return <p className="p-6 text-sm text-slate-600">No capture profile is defined.</p>;
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">Capture profiles</caption>
      <thead className="text-start text-xs uppercase text-slate-600 border-b border-slate-300">
        <tr><th scope="col" className="p-2">Profile</th><th scope="col" className="p-2">Instrument</th><th scope="col" className="p-2">Folder and pattern</th><th scope="col" className="p-2">Parser</th><th scope="col" className="p-2">Status</th><th scope="col" className="p-2">Actions</th></tr>
      </thead>
      <tbody>
        {profiles.map(p => (
          <tr key={p.id} className="border-b border-slate-200 align-top" data-profile={p.id}>
            <td className="p-2">{p.name}<div className="text-xs text-slate-600">version {p.version}</div></td>
            <td className="p-2">{p.instrumentName ?? p.instrumentId}</td>
            <td className="p-2"><code className="text-xs break-all">{p.watchDir}</code><div className="text-xs text-slate-600">{p.glob}</div></td>
            <td className="p-2">{p.parser}<pre className="text-xs text-slate-600 whitespace-pre-wrap">{JSON.stringify(p.mapping)}</pre></td>
            <td className="p-2"><Badge tone={p.status === 'Approved' ? 'success' : p.status === 'Draft' ? 'warning' : 'neutral'}>{p.status}</Badge>
              {p.status === 'Draft' && <div className="text-xs text-slate-600 mt-1">Not watched until approved.</div>}</td>
            <td className="p-2">
              <div className="flex flex-wrap gap-2">
                {canManage && p.status !== 'Retired' && <Button size="sm" onClick={() => onEdit(p)}>Edit</Button>}
                {canApprove && p.status === 'Draft' && (me === p.createdBy
                  ? <span className="text-xs text-slate-600">Another person approves what you wrote.</span>
                  : <Button size="sm" variant="primary" onClick={() => onApprove(p)}>Approve…</Button>)}
                {canManage && p.status !== 'Retired' && <Button size="sm" variant="ghost" onClick={() => onRetire(p)}>Retire</Button>}
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---- the screen --------------------------------------------------------------------------------------------------------------------

type Tab = 'values' | 'files' | 'profiles';
const TABS: Array<{ id: Tab; label: string }> = [{ id: 'values', label: 'Values waiting' }, { id: 'files', label: 'Files' }, { id: 'profiles', label: 'Profiles' }];
const EMPTY_FORM = { id: '', version: 0, name: '', instrumentId: '', parser: 'generic-csv', watchDir: '', glob: '*', mapping: '{}', reason: '' };

export function ImportsReview({ user }: { user: SelfUser }) {
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>('values');
  const [permissions, setPermissions] = useState<string[] | null>(null);
  const [values, setValues] = useState<ImportValue[]>([]);
  const [files, setFiles] = useState<CapturedFile[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [parsers, setParsers] = useState<Array<{ id: string; label: string }>>([]);
  const [instruments, setInstruments] = useState<Array<{ id: string; name: string }>>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [accepting, setAccepting] = useState<ImportValue | null>(null);
  const [rejecting, setRejecting] = useState<ImportValue | null>(null);
  const [decision, setDecision] = useState({ reason: '', reasonCode: '' as '' | ResultChangeCode });
  const [form, setForm] = useState<typeof EMPTY_FORM | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [dry, setDry] = useState<{ text: string; out: string | null }>({ text: '', out: null });
  const [signing, setSigning] = useState<Profile | null>(null);
  const [retiring, setRetiring] = useState<Profile | null>(null);
  const [uploadProfile, setUploadProfile] = useState('');

  const can = (code: Parameters<typeof hasPermission>[1]) => hasPermission(permissions, code);
  const loadValues = useCallback(() => apiFetch<ImportValue[]>('/instrument-imports?state=Pending').then(setValues)
    .catch(e => toast.error(`The captured values could not be loaded: ${errorMessage(e)}`)), [toast]);
  const loadFiles = useCallback(() => apiFetch<CapturedFile[]>('/instrument-files').then(setFiles)
    .catch(e => toast.error(`The captured files could not be loaded: ${errorMessage(e)}`)), [toast]);
  const loadProfiles = useCallback(() => apiFetch<Profile[]>('/instrument-profiles').then(setProfiles)
    .catch(e => toast.error(`The capture profiles could not be loaded: ${errorMessage(e)}`)), [toast]);
  const reloadAll = useCallback(() => { void loadValues(); void loadFiles(); void loadProfiles(); }, [loadValues, loadFiles, loadProfiles]);

  useEffect(() => {
    apiFetch<{ permissions: string[] }>('/permissions/me').then(p => setPermissions(p.permissions))
      .catch(e => { setPermissions([]); toast.error(`Your permissions could not be loaded: ${errorMessage(e)}`); });
    apiFetch<Array<{ id: string; name: string }>>('/instruments').then(setInstruments).catch(e => toast.error(`The instruments could not be loaded: ${errorMessage(e)}`));
    apiFetch<Array<{ id: string; label: string }>>('/instrument-parsers').then(setParsers).catch(e => toast.error(`The parsers could not be loaded: ${errorMessage(e)}`));
    reloadAll();
  }, [toast, reloadAll]);

  const accept = async (r: ImportValue, extra: { reason?: string; reasonCode?: ResultChangeCode } = {}) => {
    if (!r.match) return;
    setBusy(r.id);
    try {
      await apiFetch(`/instrument-imports/${r.id}/accept`, { method: 'POST', body: { expectedVersion: r.version, resultId: r.match.resultId, expectedResultVersion: r.match.version, ...extra } });
      toast.success(`${r.parameter} of ${r.sampleRef} accepted from ${r.fileName}.`);
      setAccepting(null); setDecision({ reason: '', reasonCode: '' });
      reloadAll();
    } catch (e) { toast.error(errorMessage(e)); reloadAll(); } finally { setBusy(null); }
  };
  const startAccept = (r: ImportValue) => {
    if (r.match?.value) { setDecision({ reason: '', reasonCode: '' }); setAccepting(r); } else void accept(r);
  };
  const reject = async () => {
    if (!rejecting) return;
    if (decision.reason.trim().length < 5) { toast.error('Give the reason the value is not used (at least 5 characters).'); return; }
    setBusy(rejecting.id);
    try {
      await apiFetch(`/instrument-imports/${rejecting.id}/reject`, { method: 'POST', body: { expectedVersion: rejecting.version, reason: decision.reason.trim() } });
      toast.success('The captured value was rejected and the reason recorded.');
      setRejecting(null); setDecision({ reason: '', reasonCode: '' });
      reloadAll();
    } catch (e) { toast.error(errorMessage(e)); reloadAll(); } finally { setBusy(null); }
  };

  const upload = async (file: File | undefined) => {
    if (!file) return;
    if (!uploadProfile) { toast.error('Choose the capture profile the file belongs to.'); return; }
    try {
      const out = await apiFetch<{ status: string; message?: string; rowCount?: number }>(`/instrument-files?profileId=${encodeURIComponent(uploadProfile)}&fileName=${encodeURIComponent(file.name)}`,
        { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' } });
      if (out.status === 'Failed') toast.error(`${file.name} was kept but could not be read: ${out.message}`);
      else toast.success(`${file.name} captured: ${out.rowCount} value(s) wait for acceptance.`);
      reloadAll();
    } catch (e) { toast.error(errorMessage(e)); }
  };

  const saveProfile = async () => {
    if (!form) return;
    let mapping: unknown;
    try { mapping = JSON.parse(form.mapping || '{}'); } catch { setErrors({ mapping: 'The mapping is not valid JSON.' }); toast.error('The mapping is not valid JSON.'); return; }
    setErrors({});
    try {
      if (form.id) {
        if (form.reason.trim().length < 5) { setErrors({ reason: 'Give the reason for the change (at least 5 characters).' }); toast.error('Give the reason for the change.'); return; }
        await apiFetch(`/instrument-profiles/${form.id}`, { method: 'PUT', body: { expectedVersion: form.version, name: form.name, parser: form.parser, watchDir: form.watchDir, glob: form.glob, mapping, reason: form.reason.trim() } });
        toast.success('The profile was saved as a Draft: it needs a new approval before it captures data.');
      } else {
        await apiFetch('/instrument-profiles', { method: 'POST', body: { name: form.name, instrumentId: form.instrumentId, parser: form.parser, watchDir: form.watchDir, glob: form.glob, mapping } });
        toast.success('The profile was saved as a Draft: another person approves it.');
      }
      setForm(null); void loadProfiles();
    } catch (e) { setErrors(fieldErrors(e)); toast.error(errorMessage(e)); }
  };
  const dryRun = async () => {
    if (!form) return;
    let mapping: unknown;
    try { mapping = JSON.parse(form.mapping || '{}'); } catch { toast.error('The mapping is not valid JSON.'); return; }
    try {
      const out = await apiFetch<{ ok: boolean; rowCount: number; rows: Array<{ line: number; sampleRef: string | null; parameter: string; value: string; unit: string | null }>; error?: string }>(
        '/instrument-profiles/dry-run', { method: 'POST', body: { parser: form.parser, mapping, content: dry.text } });
      setDry({ ...dry, out: out.ok ? `${out.rowCount} value(s): ${out.rows.slice(0, 10).map(r => `${r.sampleRef ?? '?'} ${r.parameter} = ${r.value}${r.unit ? ` ${r.unit}` : ''}`).join('; ')}` : `Not readable: ${out.error}` });
    } catch (e) { setDry({ ...dry, out: null }); toast.error(errorMessage(e)); }
  };
  const sign = async (password: string, reason?: string, totpCode?: string) => {
    if (!signing) return;
    try {
      await apiFetch(`/instrument-profiles/${signing.id}/approve`, { method: 'POST', body: { expectedVersion: signing.version, password, ...(totpCode ? { totpCode } : {}), ...(reason ? { reason } : {}) } });
      toast.success(`Profile ${signing.name} approved: its folder is watched.`);
      setSigning(null); void loadProfiles();
    } catch (e) { toast.error(errorMessage(e)); throw e; }
  };
  const retire = async () => {
    if (!retiring) return;
    if (decision.reason.trim().length < 5) { toast.error('Give the reason the profile is retired (at least 5 characters).'); return; }
    try {
      await apiFetch(`/instrument-profiles/${retiring.id}/retire`, { method: 'POST', body: { expectedVersion: retiring.version, reason: decision.reason.trim() } });
      toast.success(`Profile ${retiring.name} retired.`);
      setRetiring(null); setDecision({ reason: '', reasonCode: '' }); void loadProfiles();
    } catch (e) { toast.error(errorMessage(e)); }
  };

  const approved = profiles.filter(p => p.status === 'Approved');
  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
      <div className="p-6 border-b border-slate-200 bg-slate-50 flex flex-wrap items-center gap-4">
        <Cable className="w-5 h-5 text-slate-700" aria-hidden="true" />
        <h2 className="text-lg font-semibold">Instrument imports</h2>
        <div role="tablist" aria-label="Instrument imports" className="flex gap-2 ms-auto">
          {TABS.map(x => (
            <Button key={x.id} size="sm" variant={tab === x.id ? 'primary' : 'secondary'} role="tab" aria-selected={tab === x.id} onClick={() => setTab(x.id)}>
              {x.label}{x.id === 'values' && values.length ? ` (${values.length})` : ''}
            </Button>
          ))}
        </div>
      </div>
      <p className="px-6 pt-4 text-xs text-slate-600">The instrument's own software stays the record of raw data. A captured value becomes a result only when a named analyst accepts it; the source file is kept as received (sha256).</p>

      {tab === 'values' && <div className="p-4 overflow-x-auto"><ImportValuesTable rows={values} canDecide={can('result.enter')} busy={busy} onAccept={startAccept} onReject={r => { setDecision({ reason: '', reasonCode: '' }); setRejecting(r); }} /></div>}

      {tab === 'files' && (
        <div className="p-4 overflow-x-auto">
          {can('result.enter') && (
            <div className="flex flex-wrap items-end gap-3 mb-4">
              <Field label="Hand in a file for profile">{p => (
                <select {...p} className={inputClass} value={uploadProfile} onChange={e => setUploadProfile(e.target.value)}>
                  <option value="">Choose a profile…</option>{approved.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>)}</Field>
              <Field label="File">{p => <input {...p} type="file" className={inputClass} onChange={e => { void upload(e.target.files?.[0]); e.target.value = ''; }} />}</Field>
              <Upload className="w-4 h-4 text-slate-500 mb-3" aria-hidden="true" />
            </div>
          )}
          <FilesTable files={files} />
        </div>
      )}

      {tab === 'profiles' && (
        <div className="p-4 overflow-x-auto">
          {can('instrument.profile.manage') && <div className="mb-4"><Button variant="primary" onClick={() => { setErrors({}); setDry({ text: '', out: null }); setForm({ ...EMPTY_FORM }); }}>New profile</Button></div>}
          <ProfilesTable profiles={profiles} canManage={can('instrument.profile.manage')} canApprove={can('instrument.profile.approve')} me={user?.id}
            onEdit={p => { setErrors({}); setDry({ text: '', out: null }); setForm({ id: p.id, version: p.version, name: p.name, instrumentId: p.instrumentId, parser: p.parser, watchDir: p.watchDir, glob: p.glob, mapping: JSON.stringify(p.mapping, null, 2), reason: '' }); }}
            onApprove={setSigning} onRetire={p => { setDecision({ reason: '', reasonCode: '' }); setRetiring(p); }} />
        </div>
      )}

      <Modal open={!!accepting} title="Replace the entered value?" onClose={() => setAccepting(null)}
        footer={<><Button onClick={() => setAccepting(null)}>Cancel</Button>
          <Button variant="primary" busy={!!busy} onClick={() => {
            if (!accepting) return;
            if (!decision.reasonCode || decision.reason.trim().length < 5) { toast.error('Choose the reason code and give a reason (at least 5 characters) for replacing a value.'); return; }
            void accept(accepting, { reason: decision.reason.trim(), reasonCode: decision.reasonCode });
          }}>Accept and replace</Button></>}>
        {accepting && <>
          <p className="text-sm mb-3">{accepting.parameter} of {accepting.sampleRef} is {accepting.match?.value}. Accepting {accepting.value}{accepting.unit ? ` ${accepting.unit}` : ''} from {accepting.fileName} replaces it, and the earlier value stays in the result history.</p>
          <Field label="Reason code" required>{p => <select {...p} className={inputClass} value={decision.reasonCode} onChange={e => setDecision({ ...decision, reasonCode: e.target.value as ResultChangeCode })}>
            <option value="">Choose…</option>{RESULT_CHANGE_CODES.map(c => <option key={c} value={c}>{VERSION_CODE_LABELS[c]}</option>)}</select>}</Field>
          <Field label="Reason" required className="mt-3">{p => <textarea {...p} className={inputClass} rows={3} value={decision.reason} onChange={e => setDecision({ ...decision, reason: e.target.value })} />}</Field>
        </>}
      </Modal>

      <Modal open={!!rejecting} title="Reject the captured value" onClose={() => setRejecting(null)}
        footer={<><Button onClick={() => setRejecting(null)}>Cancel</Button><Button variant="danger" busy={!!busy} onClick={() => void reject()}>Reject value</Button></>}>
        {rejecting && <>
          <p className="text-sm mb-3">{rejecting.parameter} = {rejecting.value}{rejecting.unit ? ` ${rejecting.unit}` : ''} from {rejecting.fileName}, line {rejecting.lineNo}. The value is not used; the file and this decision stay on record.</p>
          <Field label="Reason" required>{p => <textarea {...p} className={inputClass} rows={3} value={decision.reason} onChange={e => setDecision({ ...decision, reason: e.target.value })} />}</Field>
        </>}
      </Modal>

      <Modal open={!!retiring} title="Retire the capture profile" onClose={() => setRetiring(null)}
        footer={<><Button onClick={() => setRetiring(null)}>Cancel</Button><Button variant="danger" onClick={() => void retire()}>Retire</Button></>}>
        <p className="text-sm mb-3">{retiring?.name} stops capturing and cannot be used again. Files already captured stay.</p>
        <Field label="Reason" required>{p => <textarea {...p} className={inputClass} rows={3} value={decision.reason} onChange={e => setDecision({ ...decision, reason: e.target.value })} />}</Field>
      </Modal>

      <Modal open={!!form} title={form?.id ? `Edit ${form.name}` : 'New capture profile'} size="lg" onClose={() => setForm(null)}
        footer={<><Button onClick={() => setForm(null)}>Cancel</Button><Button variant="primary" onClick={() => void saveProfile()}>Save as draft</Button></>}>
        {form && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name" required error={errors.name}>{p => <input {...p} className={inputClass} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />}</Field>
            <Field label="Instrument" required error={errors.instrumentId}>{p => <select {...p} className={inputClass} value={form.instrumentId} disabled={!!form.id} onChange={e => setForm({ ...form, instrumentId: e.target.value })}>
              <option value="">Choose…</option>{instruments.map(i => <option key={i.id} value={i.id}>{i.id} {i.name}</option>)}</select>}</Field>
            <Field label="Parser" required error={errors.parser}>{p => <select {...p} className={inputClass} value={form.parser} onChange={e => setForm({ ...form, parser: e.target.value })}>
              {parsers.map(x => <option key={x.id} value={x.id}>{x.label}</option>)}</select>}</Field>
            <Field label="File-name pattern" hint="* and ? only, e.g. weigh-*.txt" error={errors.glob}>{p => <input {...p} className={inputClass} value={form.glob} onChange={e => setForm({ ...form, glob: e.target.value })} />}</Field>
            <Field label="Folder the instrument exports to" required className="col-span-2" hint="An absolute path on the server. The system creates processed/ and error/ inside it." error={errors.watchDir}>{p => <input {...p} className={inputClass} value={form.watchDir} onChange={e => setForm({ ...form, watchDir: e.target.value })} />}</Field>
            <Field label="Mapping (JSON)" className="col-span-2" hint="Which columns mean what. Unknown keys are refused." error={errors.mapping}>{p => <textarea {...p} className={`${inputClass} font-mono`} rows={5} value={form.mapping} onChange={e => setForm({ ...form, mapping: e.target.value })} />}</Field>
            {form.id && <Field label="Reason for the change" required className="col-span-2" hint="Editing an approved profile withdraws its approval." error={errors.reason}>{p => <input {...p} className={inputClass} value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })} />}</Field>}
            <Field label="Try it: paste the text of an exported file" className="col-span-2">{p => <textarea {...p} className={`${inputClass} font-mono`} rows={4} value={dry.text} onChange={e => setDry({ text: e.target.value, out: null })} />}</Field>
            <div className="col-span-2 flex items-center gap-3"><Button onClick={() => void dryRun()} disabled={!dry.text.trim()}>Dry run</Button>{dry.out && <p className="text-sm" role="status">{dry.out}</p>}</div>
          </div>
        )}
      </Modal>

      {signing && (
        <ElectronicSignatureModal user={{ ...user, email: user.email ?? undefined }} meaningCode="INSTRUMENT_PROFILE_APPROVAL" action="approve" entityName={`Capture profile ${signing.name}`} recordVersion={signing.version}
          onClose={() => setSigning(null)} onSign={sign}>
          <p className="text-sm mb-3">Instrument {signing.instrumentName ?? signing.instrumentId}, folder <code>{signing.watchDir}</code>, pattern {signing.glob}, parser {signing.parser}. Mapping: <code>{JSON.stringify(signing.mapping)}</code></p>
        </ElectronicSignatureModal>
      )}
    </div>
  );
}
