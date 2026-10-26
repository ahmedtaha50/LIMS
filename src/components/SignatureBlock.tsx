import { formatDateTime } from '../lib/format';
import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, HelpCircle, Loader2, RefreshCw, ShieldCheck, XCircle } from 'lucide-react';
import { useToast } from './ui/Toast';

/**
 * The e-signatures of one record (roadmap M07): who signed, with which meaning, when, why, and on which version of the record,
 * as they were when the signature was made, plus a Verify button that recomputes the record's hash on the server.
 * 21 CFR 11.50 (printed name, date and time, meaning) and 11.70 (signature linked to its record).
 *
 *   <SignatureBlock entityType="Specification" entityId={spec.id} token={token} reloadKey={spec.version} />
 *
 * `reloadKey` is anything that changes when the record is signed again (its version); the list is read again when it does.
 */

export interface SignatureBlockProps {
  entityType: string;
  entityId: string;
  token: string;
  reloadKey?: string | number;
  title?: string;
}

interface Manifestation {
  id: string;
  meaningCode: string | null;
  meaning: string;
  signerName: string | null;
  signerRole: string | null;
  authMethod: string | null;
  reason: string;
  timestamp: string;
  recordVersion: number;
  hashVersion: number;
}

export interface VerificationResult {
  valid: boolean;
  status: string;
  statusText?: string;
  contentHashMatches: boolean | null;
  chainIntact: boolean | null;
}

const VERDICT: Record<string, { tone: 'ok' | 'bad' | 'warn'; title: string }> = {
  valid: { tone: 'ok', title: 'Verified: record unchanged since it was signed' },
  'record-modified': { tone: 'bad', title: 'FAILED: the record was changed after it was signed' },
  'record-missing': { tone: 'bad', title: 'FAILED: the signed record no longer exists' },
  'chain-broken': { tone: 'bad', title: 'FAILED: the audit trail behind this signature was altered' },
  'audit-missing': { tone: 'bad', title: 'FAILED: the audit entry of this signature is missing' },
  'legacy-unverifiable': { tone: 'warn', title: 'Cannot be verified: signed before signatures could be recomputed' },
  unsupported: { tone: 'warn', title: 'Cannot be verified: record type not known to this version' },
};

const TONE_CLASS = {
  ok: 'bg-emerald-50 border-emerald-200 text-emerald-900',
  bad: 'bg-red-50 border-red-300 text-red-900',
  warn: 'bg-amber-50 border-amber-300 text-amber-900',
} as const;

/** The verdict of one verification, in words and colour. Green only for status "valid"; an HTTP 200 alone is not a verdict. */
export function SignatureVerdict({ result }: { result: VerificationResult }) {
  const v = VERDICT[result.status] ?? { tone: 'warn' as const, title: `Unrecognised verification status: ${result.status}` };
  const Icon = v.tone === 'ok' ? CheckCircle2 : v.tone === 'bad' ? XCircle : HelpCircle;
  return (
    <div role={v.tone === 'ok' ? 'status' : 'alert'} className={`p-3 border rounded-lg flex items-start gap-2.5 text-xs ${TONE_CLASS[v.tone]}`}>
      <Icon className="w-5 h-5 shrink-0 mt-0.5" />
      <div>
        <h4 className="font-bold">{v.title}</h4>
        {result.statusText && <p className="mt-0.5">{result.statusText}</p>}
        <p className="mt-1 font-mono text-[10px] opacity-80">
          hash {result.contentHashMatches === null ? 'not recomputable' : result.contentHashMatches ? 'matches' : 'does not match'}
          {' / '}audit chain {result.chainIntact === null ? 'not linked' : result.chainIntact ? 'intact' : 'broken'}
        </p>
      </div>
    </div>
  );
}

export function SignatureBlock({ entityType, entityId, token, reloadKey, title = 'Electronic Signatures' }: SignatureBlockProps) {
  const { toast } = useToast();
  const [rows, setRows] = useState<Manifestation[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, VerificationResult>>({});
  const [verifying, setVerifying] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch(`/api/signatures/entity/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}`, { headers: { Authorization: `Bearer ${token}` } });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error || `The signatures could not be loaded (HTTP ${res.status}).`);
      setRows(body as Manifestation[]);
      setResults({});
    } catch (e: any) {
      setRows(null);
      setLoadError(e.message || 'The signatures could not be loaded.');
      toast(e.message || 'The signatures could not be loaded.', 'error');
    }
  }, [entityType, entityId, token]);

  useEffect(() => { void load(); }, [load, reloadKey]);

  const verify = async (id: string) => {
    setVerifying(id);
    try {
      const res = await fetch(`/api/signatures/verify/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${token}` } });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error || `Verification failed (HTTP ${res.status}).`);
      setResults(prev => ({ ...prev, [id]: body as VerificationResult }));
      if (!(body as VerificationResult).valid) {
        toast(VERDICT[(body as VerificationResult).status]?.title ?? 'The signature did not verify.', 'error');
      }
    } catch (e: any) {
      toast(e.message || 'Signature verification failed.', 'error');
    } finally {
      setVerifying(null);
    }
  };

  return (
    <section className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden" aria-label={title}>
      <header className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-blue-600" />
          <h3 className="font-bold text-slate-800 text-sm">{title}</h3>
        </div>
        <span className="text-xs font-mono bg-blue-50 text-blue-700 px-2 py-0.5 rounded border border-blue-200 font-semibold">{rows?.length ?? 0}</span>
      </header>

      <div className="p-4 space-y-3">
        {rows === null && !loadError && <p className="text-xs text-slate-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading signatures...</p>}
        {loadError && (
          <div role="alert" className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-800 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <div className="flex-1">{loadError}</div>
            <button type="button" onClick={() => void load()} className="inline-flex items-center gap-1 font-semibold underline"><RefreshCw className="w-3 h-3" /> Retry</button>
          </div>
        )}
        {rows && rows.length === 0 && <p className="text-xs italic text-slate-500">This record has not been electronically signed.</p>}

        {rows?.map(r => {
          const t = new Date(r.timestamp);
          const result = results[r.id];
          return (
            <article key={r.id} className="p-3 rounded-lg border border-slate-200 bg-slate-50/60 space-y-2 text-xs text-slate-600">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="text-sm font-bold text-slate-900">{r.signerName ?? 'Unknown signer'}</span>
                  <span className="ms-2 text-slate-500">({r.signerRole ?? 'role not recorded'})</span>
                </div>
                <button
                  type="button"
                  onClick={() => void verify(r.id)}
                  disabled={verifying === r.id}
                  className="px-2.5 py-1 bg-slate-900 hover:bg-slate-800 text-white rounded text-xs font-medium inline-flex items-center gap-1 disabled:opacity-60"
                >
                  {verifying === r.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5 text-blue-400" />}
                  <span>{verifying === r.id ? 'Verifying...' : 'Verify'}</span>
                </button>
              </div>
              <p className="px-2 py-1 bg-blue-50 border border-blue-100 rounded text-blue-900 font-medium">{r.meaning}</p>
              <dl className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <div>
                  <dt className="text-slate-400">Signed</dt>
                  <dd className="font-medium text-slate-800">{formatDateTime(t)}</dd>
                  <dd className="font-mono text-[10px] text-slate-400">{t.toISOString()}</dd>
                </div>
                <div>
                  <dt className="text-slate-400">Record version</dt>
                  <dd className="font-mono font-semibold text-slate-800">#{r.recordVersion}</dd>
                </div>
                <div>
                  <dt className="text-slate-400">Authenticated by</dt>
                  <dd className="text-slate-800">{r.authMethod === 'password+totp' ? 'Password and authenticator code' : r.authMethod === 'password' ? 'Password' : 'Not recorded'}</dd>
                </div>
              </dl>
              {r.reason && <p><span className="font-semibold text-slate-500">Reason: </span><span className="italic text-slate-700">"{r.reason}"</span></p>}
              {r.hashVersion < 2 && <p className="text-[10px] text-amber-700">Signed by an earlier version of the application.</p>}
              {result && <SignatureVerdict result={result} />}
            </article>
          );
        })}
      </div>
    </section>
  );
}
