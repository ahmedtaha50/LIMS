import React, { useMemo, useState } from 'react';
import { Plus, Beaker, Upload, AlertCircle, Scan } from 'lucide-react';
import { useToast } from './ui/Toast';
import { BarcodeScanner } from './BarcodeScanner';
import { openScannedCode } from '../lib/useScanSink';
import { SampleDetail } from './SampleDetail';
import { RegisterSampleDialog } from './RegisterSampleDialog';
import { DataGrid, type Column, type GridFilter } from './DataGrid';
import { Badge, stateTone } from './ui/Badge';
import { Button } from './ui/Button';
import { inputClass } from './ui/Field';
import { Modal } from './ui/Modal';
import { apiFetch, ApiError } from '../lib/api';
import { localizedError, t, useLang } from '../i18n';
import { formatDateTime } from '../lib/format';
import { formatHash, navigate, readRoute } from '../lib/router';
import { SAMPLE_STATES } from '../lib/validations/samples';

/**
 * Samples (roadmap M24): register one or many, and the sample list. The list is the server's (GET /api/lists/samples: search,
 * state filter, sort and paging on the server, all in the URL); a sample opens at its own address, #/samples/<id>, so a pasted
 * link opens it and Back returns to the list as it was.
 */
interface SampleRow { id: string; material: string; batch: string; state: string; createdAt: string; createdByName: string | null; version: number }

// Ids, batches and versions are identifiers: <bdi dir="ltr"> keeps them left-to-right inside Arabic text. State names are regulated wording and
// stay in English until QA approves a translation.
const sampleColumns = (): Column<SampleRow>[] => [
  { key: 'id', header: t('samples.col.id'), sortable: true, className: '[direction:ltr] [unicode-bidi:isolate]' }, // the id is the row's link: a <bdi> inside it would hide its text from the page's own selectors
  { key: 'material', header: t('samples.col.material'), sortable: true, className: 'font-medium' },
  { key: 'batch', header: t('samples.col.batch'), sortable: true, render: r => <bdi dir="ltr">{r.batch}</bdi> },
  { key: 'state', header: t('samples.col.state'), sortable: true, render: r => <Badge tone={stateTone(r.state)}>{r.state}</Badge> },
  { key: 'createdAt', header: t('samples.col.registered'), sortable: true, render: r => <time dateTime={r.createdAt} dir="ltr">{formatDateTime(r.createdAt)}</time> },
  { key: 'version', header: t('samples.col.version'), render: r => <bdi dir="ltr" className="font-mono text-xs text-slate-600">v{r.version}</bdi> },
];
const sampleFilters = (): GridFilter[] => [{ key: 'state', label: t('samples.filter.state'), options: SAMPLE_STATES.map(s => ({ value: s, label: s })) }];
const DEFAULT_SORT = { key: 'createdAt', dir: 'desc' as const };
const sampleHref = (r: { id: string }) => formatHash('samples', [r.id]);

/** The list address the user came from, so "back" from a sample returns to the same search, filter, sort and page. */
let lastListHash = formatHash('samples');

export function Samples({ token, user, sampleId = null }: { token: string; user: any; sampleId?: string | null }) {
  const { lang } = useLang();
  const columns = useMemo(sampleColumns, [lang]);
  const filters = useMemo(sampleFilters, [lang]);
  const [material, setMaterial] = useState('');
  const [batch, setBatch] = useState('');
  const [isBulkModalOpen, setIsBulkModalOpen] = useState(false);
  const [bulkInput, setBulkInput] = useState('');
  const [bulkErrors, setBulkErrors] = useState<string[]>([]);
  const [isImporting, setIsImporting] = useState(false);
  const [isScannerOpen, setIsScannerOpen] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [isMasterOpen, setIsMasterOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const { toast } = useToast();

  if (!sampleId) {
    const r = readRoute();
    if (r.view === 'samples' && r.segments.length === 0) lastListHash = formatHash('samples', [], r.query);
  }

  const closeBulk = () => { setIsBulkModalOpen(false); setBulkErrors([]); };

  const handleBulkImport = async (e: React.FormEvent) => {
    e.preventDefault();
    setBulkErrors([]);
    const items = bulkInput.split('\n').map(l => l.trim()).filter(Boolean).map(line => {
      const [m, b] = line.split(',').map(s => s.trim());
      return { material: m, batch: b };
    });
    if (items.length === 0) { toast.error(t('samples.bulkNoData')); return; }
    setIsImporting(true);
    try {
      const data = await apiFetch<{ count: number }>('/samples/bulk-import', { method: 'POST', body: { items } });
      toast.success(t('samples.bulkDone', { count: data.count }));
      setBulkInput('');
      setIsBulkModalOpen(false);
      setReloadKey(k => k + 1);
    } catch (err) {
      if (err instanceof ApiError && Array.isArray(err.details)) {
        setBulkErrors(err.details.map((d: any) => typeof d === 'string' ? d : `${d.path ? `${d.path}: ` : ''}${d.message}`));
        toast.error(t('samples.bulkValidationToast'));
      } else {
        toast.error(localizedError(err, 'samples.bulkFailed'));
      }
    } finally {
      setIsImporting(false);
    }
  };

  // A scanned code is resolved by the server (GET /resolve) and opens the record's page; an unknown code is a toast.error.
  const handleScan = (scannedId: string) => {
    setIsScannerOpen(false);
    void openScannedCode(scannedId, toast);
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setRegistering(true);
    try {
      await apiFetch('/samples', { method: 'POST', body: { material, batch } });
      setMaterial(''); setBatch('');
      setReloadKey(k => k + 1);
      toast.success(t('samples.registered'));
    } catch (err) {
      toast.error(localizedError(err, 'samples.registerFailed'));
    } finally {
      setRegistering(false);
    }
  };

  if (sampleId) {
    // Keyed by id: opening another sample's address starts a fresh detail view.
    return <React.Fragment key={sampleId}><SampleDetail sampleId={sampleId} token={token} user={user} onBack={() => navigate(lastListHash)} /></React.Fragment>;
  }

  return (
    <>
      {isScannerOpen && <BarcodeScanner onScan={handleScan} onClose={() => setIsScannerOpen(false)} />}
      <div className="p-0 sm:p-2">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-2xl font-bold text-slate-800 flex items-center gap-2"><Beaker aria-hidden="true" /> {t('samples.title')}</h3>
          <Button variant="primary" className="!bg-slate-800 !border-slate-800 hover:!bg-slate-700" onClick={() => setIsScannerOpen(true)}>
            <Scan className="w-4 h-4" aria-hidden="true" /> {t('samples.scan')}
          </Button>
        </div>

        <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200 mb-8 flex flex-col lg:flex-row lg:items-center justify-between gap-6">
          <div className="flex-1">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
              <h4 className="text-lg font-semibold text-slate-800">{t('samples.registerSingle')}</h4>
              <Button size="sm" onClick={() => setIsMasterOpen(true)}>{t('samples.registerFromMaster')}</Button>
            </div>
            <form onSubmit={handleCreate} className="flex flex-col sm:flex-row gap-4 max-w-3xl">
              <label className="flex-1"><span className="sr-only">{t('samples.materialLabel')}</span>
                <input type="text" dir="auto" placeholder={t('samples.materialPlaceholder')} required value={material} onChange={e => setMaterial(e.target.value)} className={inputClass} />
              </label>
              <label className="flex-1"><span className="sr-only">{t('samples.batchLabel')}</span>
                <input type="text" dir="auto" placeholder={t('samples.batchPlaceholder')} required value={batch} onChange={e => setBatch(e.target.value)} className={inputClass} />
              </label>
              <Button type="submit" variant="primary" busy={registering} className="whitespace-nowrap">
                <Plus className="w-4 h-4" aria-hidden="true" /> {t('samples.register')}
              </Button>
            </form>
          </div>
          <div className="lg:ps-6 lg:border-s border-slate-200 flex flex-col items-start lg:items-center">
            <h4 className="text-sm font-semibold mb-3 text-slate-600 uppercase tracking-wider">{t('samples.highVolume')}</h4>
            <Button onClick={() => setIsBulkModalOpen(true)} className="!bg-indigo-50 !text-indigo-800 !border-indigo-200 hover:!bg-indigo-100 font-bold">
              <Upload className="w-4 h-4" aria-hidden="true" /> {t('samples.bulkImport')}
            </Button>
          </div>
        </div>

        <RegisterSampleDialog isOpen={isMasterOpen} onClose={() => setIsMasterOpen(false)}
          onRegistered={() => { setIsMasterOpen(false); setReloadKey(k => k + 1); }} />

        <Modal open={isBulkModalOpen} onClose={closeBulk} dismissible={!isImporting} size="lg" title={t('samples.bulkTitle')}
          description={t('samples.bulkDescription')}
          footer={<>
            <Button onClick={closeBulk} disabled={isImporting}>{t('common.cancel')}</Button>
            <Button variant="primary" type="submit" form="bulk-import-form" busy={isImporting} disabled={!bulkInput.trim()}>
              {isImporting ? t('samples.bulkValidating') : t('samples.bulkValidate')}
            </Button>
          </>}>
          <form id="bulk-import-form" onSubmit={handleBulkImport}>
            {bulkErrors.length > 0 && (
              <div role="alert" className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg">
                <div className="flex items-center gap-2 text-red-800 font-bold mb-2">
                  <AlertCircle className="w-5 h-5" aria-hidden="true" /> {t('samples.bulkFailedTitle')}
                </div>
                <ul dir="auto" className="list-disc ps-5 space-y-1 text-sm text-red-800 font-mono">
                  {bulkErrors.map((err, i) => <li key={i}>{err}</li>)}
                </ul>
                <p className="mt-3 text-xs text-red-800 italic">{t('samples.bulkNothingImported')}</p>
              </div>
            )}
            <div id="bulk-format" className="bg-blue-50 border border-blue-100 p-4 rounded-lg mb-4 text-sm text-blue-900">
              <strong className="font-bold">{t('samples.bulkFormat')}</strong> <code dir="ltr">Material Name, Batch Number</code> {t('samples.bulkFormatOne')}
              <br /><span className="text-xs mt-1 block">{t('samples.bulkFormatHint')}</span>
            </div>
            <label htmlFor="bulk-input" className="text-sm font-medium text-slate-700">{t('samples.bulkRows')}</label>
            <textarea
              id="bulk-input"
              aria-describedby="bulk-format"
              dir="auto"
              className={`${inputClass} h-64 font-mono resize-none mt-1`}
              placeholder={'Aspirin 500mg, BTX-99201\nParacetamol 250mg, PAR-22119\nIbuprofen 400mg, IBU-3344'}
              value={bulkInput}
              onChange={e => setBulkInput(e.target.value)}
            />
          </form>
        </Modal>

        <DataGrid<SampleRow>
          caption={t('samples.caption')}
          noun={t('samples.noun')}
          endpoint="/lists/samples"
          exportEndpoint="/lists/samples/export"
          columns={columns}
          filters={filters}
          defaultSort={DEFAULT_SORT}
          rowKey={r => r.id}
          rowHref={sampleHref}
          searchPlaceholder={t('samples.searchPlaceholder')}
          reloadKey={reloadKey}
        />
      </div>
    </>
  );
}
