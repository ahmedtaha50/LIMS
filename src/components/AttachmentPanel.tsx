/**
 * Raw-data files of a sample (roadmap M20, r2-raw-data). The file goes to the server as it is (application/octet-stream), is kept in
 * the content-addressed blob store and is listed here with its SHA-256. Every download is re-hashed by the server first: a file that
 * no longer matches is refused (shown as an error, never as a download). Files are added while the sample is Logged or in Testing by
 * the people who enter results; nothing is ever replaced or removed.
 */
import { formatDateTime } from '../lib/format';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Paperclip, Upload } from 'lucide-react';
import { apiFetch, errorMessage } from '../lib/api';
import { ALLOWED_EXTENSIONS } from '../server/blobs/sniff';
import { useToast } from './ui/Toast';

export interface AttachmentRow {
  id: string; sampleId: string; resultId: string | null; fileName: string; mediaType: string; kind: string;
  bytes: number; sha256: string; uploadedBy: string; uploadedAt: string; description: string | null;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** The register: name, size, the full SHA-256, the result it belongs to, who added it and when. */
export function AttachmentList({ attachments, parameters, onDownload }: {
  attachments: AttachmentRow[]; parameters: Record<string, string>; onDownload: (a: AttachmentRow) => void;
}) {
  if (attachments.length === 0) return <p className="text-sm text-slate-500 italic">No raw data files attached.</p>;
  return (
    <table className="w-full text-sm text-start">
      <thead className="text-slate-500 border-b border-slate-200">
        <tr><th className="py-2 pe-3">File</th><th className="py-2 pe-3">Result</th><th className="py-2 pe-3">Size</th><th className="py-2 pe-3">SHA-256</th><th className="py-2 pe-3">Added</th><th className="py-2" /></tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {attachments.map(a => (
          <tr key={a.id}>
            <td className="py-2 pe-3 font-medium text-slate-900">{a.fileName}<div className="text-xs text-slate-500">{a.mediaType}</div></td>
            <td className="py-2 pe-3 text-slate-700">{a.resultId ? parameters[a.resultId] ?? a.resultId : 'Sample'}</td>
            <td className="py-2 pe-3 text-slate-700 whitespace-nowrap">{formatBytes(a.bytes)}</td>
            <td className="py-2 pe-3 font-mono text-xs text-slate-600 break-all">{a.sha256}</td>
            <td className="py-2 pe-3 text-xs text-slate-600">{a.uploadedBy}<div>{formatDateTime(a.uploadedAt)}</div></td>
            <td className="py-2 text-end">
              <button type="button" onClick={() => onDownload(a)} aria-label={`Download ${a.fileName}`}
                className="p-1.5 text-slate-500 hover:text-blue-700 hover:bg-blue-50 rounded"><Download className="w-4 h-4" /></button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function AttachmentPanel({ sampleId, results, canUpload, onChanged }: {
  sampleId: string; results: Array<{ id: string; parameter: string }>; canUpload: boolean; onChanged?: () => void;
}) {
  const { toast } = useToast();
  const [rows, setRows] = useState<AttachmentRow[]>([]);
  const [resultId, setResultId] = useState('');
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const r = await apiFetch<{ attachments: AttachmentRow[] }>(`/samples/${encodeURIComponent(sampleId)}/attachments`);
      setRows(r.attachments);
    } catch (e) { toast.error(errorMessage(e, 'The raw data files could not be loaded.')); }
  }, [sampleId]);
  useEffect(() => { load(); }, [load]);

  const upload = async (file: File) => {
    setBusy(true);
    try {
      const q = new URLSearchParams({ fileName: file.name, ...(resultId ? { resultId } : {}) });
      const r = await apiFetch<{ attachment: AttachmentRow }>(`/samples/${encodeURIComponent(sampleId)}/attachments?${q}`, {
        method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' }, replay: 'never',
      });
      toast.success(`${r.attachment.fileName} attached (sha256 ${r.attachment.sha256}).`);
      await load();
      onChanged?.();
    } catch (e) {
      toast.error(errorMessage(e, 'The file was not attached.'));
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const download = async (a: AttachmentRow) => {
    try {
      const blob = await apiFetch<Blob>(`/attachments/${encodeURIComponent(a.id)}/content`, { parse: 'blob' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = a.fileName;
      document.body.appendChild(link); link.click(); document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(errorMessage(e, `${a.fileName} could not be downloaded.`));
    }
  };

  const parameters = Object.fromEntries(results.map(r => [r.id, r.parameter]));
  return (
    <section aria-labelledby="raw-data-heading" className="bg-white border border-slate-200 rounded-xl shadow-sm p-4 mt-6">
      <h3 id="raw-data-heading" className="text-sm font-semibold text-slate-800 flex items-center gap-2 mb-3"><Paperclip className="w-4 h-4" /> Raw data files</h3>
      <AttachmentList attachments={rows} parameters={parameters} onDownload={download} />
      {canUpload && (
        <div className="flex flex-wrap items-end gap-2 mt-4">
          <label className="text-xs text-slate-600 flex flex-col gap-1">
            Belongs to
            <select value={resultId} onChange={e => setResultId(e.target.value)} className="px-2 py-1.5 border border-slate-300 rounded text-sm">
              <option value="">The sample</option>
              {results.map(r => <option key={r.id} value={r.id}>{r.parameter}</option>)}
            </select>
          </label>
          <input ref={fileInput} type="file" className="hidden" accept={ALLOWED_EXTENSIONS.map(e => `.${e}`).join(',')}
            onChange={e => { const f = e.target.files?.[0]; if (f) upload(f); }} aria-label="Raw data file" />
          <button type="button" disabled={busy} onClick={() => fileInput.current?.click()}
            className="px-3 py-1.5 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1">
            <Upload className="w-4 h-4" /> {busy ? 'Attaching…' : 'Attach file'}
          </button>
        </div>
      )}
    </section>
  );
}
