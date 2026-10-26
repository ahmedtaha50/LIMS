import React, { useState, useEffect } from 'react';
import { useToast } from './ui/Toast';
import { FileText, Download, ShieldCheck, Activity, Users, Settings, Database, Filter, FileSpreadsheet, File, PieChart as PieIcon, BarChart as BarIcon } from 'lucide-react';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';
// jspdf-autotable 5 attaches doc.autoTable() only to a global window.jsPDF, which a bundled application does not have: call the function.
import { autoTable } from 'jspdf-autotable';
import { CoaPanel } from './CoaPanel';
import { apiFetch, errorMessage } from '../lib/api';
import { oosStage } from '../lib/constants/oos';
import { printDateTime } from '../lib/format';
import { applyGxPTheme } from '../lib/pdfUtils';
import { PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, LineChart, Line, ReferenceLine } from 'recharts';
import { TrendingUp } from 'lucide-react';

/**
 * The Reports screen. Client exports here (custom tables, dashboard, audit trail, OOS register, training matrix) are working copies:
 * every page is stamped "Uncontrolled Copy" and nobody picks another status. A Certificate of Analysis is never composed in the browser:
 * it is issued, numbered and signed on the server (CoaPanel, POST /coa/:sampleId) and listed here from the register (GET /coa/documents).
 */
const UNCONTROLLED = 'Uncontrolled Copy';

/** One CSV cell: quoted, and a leading = + - @ (a spreadsheet formula) neutralised so an exported value cannot run as a formula. */
export function csvCell(v: unknown): string {
  let text = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function Reports({ token }: { token: string }) {
  const [loadingReport, setLoadingReport] = useState<string | null>(null);
  const [batchNumber, setBatchNumber] = useState('');
  const [coaSampleId, setCoaSampleId] = useState('');
  const [openCoaSample, setOpenCoaSample] = useState<string | null>(null);
  const [register, setRegister] = useState<Array<{ id: string; label: string; sampleId: string; status: string; issuedAt: string; material: string }> | null>(null);
  
  // Dynamic Report Builder State
  const [selectedSource, setSelectedSource] = useState<string>('samples');
  const [availableColumns, setAvailableColumns] = useState<{key: string, label: string}[]>([]);
  const [selectedColumns, setSelectedColumns] = useState<string[]>([]);
  const [dynamicData, setDynamicData] = useState<any[]>([]);
  const [isFetchingData, setIsFetchingData] = useState(false);
  const [metrics, setMetrics] = useState<any>(null);
  
  // Trend Analysis State
  const [trendFilters, setTrendFilters] = useState<{materials: string[], parameters: string[]}>({ materials: [], parameters: [] });
  const [selectedMaterial, setSelectedMaterial] = useState<string>('');
  const [selectedParameter, setSelectedParameter] = useState<string>('');
  const [trendData, setTrendData] = useState<any[]>([]);

  useEffect(() => {
    fetch('/api/reports/metrics', { headers: { Authorization: `Bearer ${token}` } })
      .then(res => res.json())
      .then(data => setMetrics(data))
      .catch(err => console.error(err));
      
    fetch('/api/reports/filters', { headers: { Authorization: `Bearer ${token}` } })
      .then(res => res.json())
      .then(data => {
        setTrendFilters(data);
        if (data.materials.length > 0) setSelectedMaterial(data.materials[0]);
        if (data.parameters.length > 0) setSelectedParameter(data.parameters[0]);
      })
      .catch(err => console.error(err));
  }, [token]);

  useEffect(() => {
    if (selectedMaterial && selectedParameter) {
      fetch(`/api/reports/trends?material=${encodeURIComponent(selectedMaterial)}&parameter=${encodeURIComponent(selectedParameter)}`, { headers: { Authorization: `Bearer ${token}` } })
        .then(res => res.json())
        .then(data => setTrendData(data))
        .catch(err => console.error(err));
    }
  }, [selectedMaterial, selectedParameter, token]);


  React.useEffect(() => {
    // Configure columns based on source
    let cols: {key: string, label: string}[] = [];
    if (selectedSource === 'samples') {
      cols = [
        { key: 'id', label: 'Sample ID' },
        { key: 'material', label: 'Material' },
        { key: 'batch', label: 'Batch' },
        { key: 'state', label: 'Status' },
        { key: 'createdAt', label: 'Created At' }
      ];
    } else if (selectedSource === 'oos') {
      cols = [
        { key: 'id', label: 'OOS ID' },
        { key: 'sampleId', label: 'Sample ID' },
        { key: 'parameter', label: 'Parameter' },
        { key: 'status', label: 'Status' },
        { key: 'rootCause', label: 'Root Cause' },
        { key: 'capa', label: 'CAPA' }
      ];
    } else if (selectedSource === 'audit') {
      cols = [
        { key: 'sequence', label: 'Sequence' },
        { key: 'userId', label: 'User' },
        { key: 'action', label: 'Action' },
        { key: 'entity', label: 'Entity' },
        { key: 'reason', label: 'Reason' }
      ];
    }
    setAvailableColumns(cols);
    setSelectedColumns(cols.map(c => c.key));
  }, [selectedSource]);

  const toggleColumn = (colKey: string) => {
    if (selectedColumns.includes(colKey)) {
      setSelectedColumns(selectedColumns.filter(k => k !== colKey));
    } else {
      setSelectedColumns([...selectedColumns, colKey]);
    }
  };

  const fetchDynamicData = async () => {
    setIsFetchingData(true);
    try {
      let endpoint = '';
      if (selectedSource === 'samples') endpoint = '/api/samples';
      if (selectedSource === 'oos') endpoint = '/api/oos';
      if (selectedSource === 'audit') endpoint = '/api/audit';

      const headers = { Authorization: `Bearer ${token}` };
      let rows: any[];
      if (selectedSource === 'samples') {
        // GET /samples is paged by cursor (X-Next-Cursor): read every page.
        rows = [];
        let cursor: string | null = null;
        do {
          const res = await fetch(`${endpoint}?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { headers });
          if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
          rows.push(...await res.json());
          cursor = res.headers.get('X-Next-Cursor');
        } while (cursor);
      } else {
        const res = await fetch(endpoint, { headers });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
        const data = await res.json();
        rows = data.entries || data;
      }
      setDynamicData(rows);
      return rows;
    } catch(e: any) {
      toast(`Failed to fetch data for report: ${e.message || 'unknown error'}`, 'error');
      return [];
    } finally {
      setIsFetchingData(false);
    }
  };

  const exportDynamicPDF = async () => {
    const data = await fetchDynamicData();
    if (!data || data.length === 0) return toast('No data to export', 'error');
    
    const isLandscape = selectedColumns.length > 5;
    const doc = new jsPDF(isLandscape ? 'landscape' : 'portrait');
    
    const headers = availableColumns.filter(c => selectedColumns.includes(c.key)).map(c => c.label);
    const body = data.map((row: any) => 
      availableColumns.filter(c => selectedColumns.includes(c.key)).map(c => row[c.key] || 'N/A')
    );
    
    autoTable(doc, {
      startY: 50,
      head: [headers],
      body: body,
      theme: 'grid',
      styles: { fontSize: 8 },
      headStyles: { fillColor: [44, 62, 80], textColor: 255, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [245, 248, 250] }
    });
    
    applyGxPTheme(doc, `Custom ${selectedSource.toUpperCase()} Report`, UNCONTROLLED);

    doc.save(`GxP_${selectedSource}_Uncontrolled.pdf`);
    toast('PDF Exported Successfully', 'success');
  };

  
  const exportDashboardPDF = async () => {
    const element = document.getElementById('dashboard-export-target');
    if (!element) return;
    
    setLoadingReport('dashboard');
    try {
      const canvas = await html2canvas(element, { scale: 2, backgroundColor: '#ffffff' });
      const imgData = canvas.toDataURL('image/png');
      
      const doc = new jsPDF('landscape');
      
      const pageWidth = doc.internal.pageSize.getWidth();
      const pageHeight = doc.internal.pageSize.getHeight();
      
      // Calculate aspect ratio fit
      const imgWidth = pageWidth - 28; // 14mm margins
      const imgHeight = (canvas.height * imgWidth) / canvas.width;
      
      applyGxPTheme(doc, 'Batch Analytics & Trend Overview', UNCONTROLLED);
      
      // We start drawing the image below the GxP header (y=50)
      doc.addImage(imgData, 'PNG', 14, 50, imgWidth, imgHeight);
      
      doc.save('Batch_Overview_Dashboard.pdf');
      toast('Dashboard Exported Successfully', 'success');
    } catch(e) {
      console.error(e);
      toast('Failed to export dashboard', 'error');
    }
    setLoadingReport(null);
  };

  const exportDynamicCsv = async () => {
    const data = await fetchDynamicData();
    if (!data || data.length === 0) return toast('No data to export', 'error');

    const cols = availableColumns.filter(c => selectedColumns.includes(c.key));
    const csv = [cols.map(c => csvCell(c.label)).join(','), ...data.map((row: any) => cols.map(c => csvCell(row[c.key])).join(','))].join('\r\n');
    const url = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `Custom_${selectedSource}_Report.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    toast('CSV Exported Successfully', 'success');
  };

  const { toast } = useToast();
  
  
  /** The issued certificates of a batch, from the server's register (GET /coa/documents). */
  const loadRegister = async () => {
    if (!batchNumber.trim()) return toast.error('Enter a batch number to list its certificates.');
    setLoadingReport('batch');
    try {
      const rows = await apiFetch<NonNullable<typeof register>>(`/coa/documents?batch=${encodeURIComponent(batchNumber.trim())}`);
      setRegister(rows);
      if (rows.length === 0) toast.info(`No certificate has been issued for batch ${batchNumber.trim()}.`);
    } catch (e) {
      toast.error(errorMessage(e, 'The certificate register could not be loaded.'));
    }
    setLoadingReport(null);
  };

  const generateAuditReport = async () => {
    setLoadingReport('audit');
    try {
      const res = await fetch('/api/audit', { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const entries = data.entries || [];
      
      const doc = new jsPDF('landscape');
      
      const tableData = entries.map((e: any) => [
        printDateTime(e.timestamp),
        e.action,
        e.entity,
        e.entityId,
        e.actorName ? `${e.actorName} (${e.userId})` : e.userId,
        `${e.oldValue || ''} -> ${e.newValue || ''}`,
        e.reason || '-',
        e.hash.substring(0, 16) + '...'
      ]);

      autoTable(doc, {
        startY: 50,
        head: [['Time', 'Action', 'Entity', 'Record ID', 'User', 'Change', 'Reason', 'Hash']],
        body: tableData,
        theme: 'grid',
        styles: { fontSize: 7, overflow: 'linebreak', cellPadding: 2 },
        headStyles: { fillColor: [44, 62, 80] },
        alternateRowStyles: { fillColor: [248, 250, 252] },
        columnStyles: { 5: { cellWidth: 40 }, 7: { font: 'courier' } }
      });
      
      applyGxPTheme(doc, 'System Audit Trail (Part 11)', UNCONTROLLED);
      
      doc.save('Audit_Trail_Report.pdf');
      toast('Report Generated Successfully', 'success');
    } catch(e: any) {
      toast(`Failed to generate report: ${e.message || 'unknown error'}`, 'error');
    }
    setLoadingReport(null);
  };
  
  const generateOosReport = async () => {
    setLoadingReport('oos');
    try {
      const res = await fetch('/api/oos', { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      const doc = new jsPDF('landscape');

      const tableData = data.map((o: any) => [
        o.id,
        o.sampleId,
        o.dateRaised,
        oosStage(o),
        o.rootCause || 'Pending',
        o.conclusion || 'Pending'
      ]);

      autoTable(doc, {
        startY: 50,
        head: [['Investigation ID', 'Sample ID', 'Date Raised', 'Stage', 'Root Cause', 'CAPA / Conclusion']],
        body: tableData,
        theme: 'grid',
        styles: { fontSize: 8 },
        headStyles: { fillColor: [44, 62, 80] },
        alternateRowStyles: { fillColor: [248, 250, 252] },
        didParseCell: function(data: any) {
          if (data.cell.raw === 'Closed') data.cell.styles.textColor = [22, 163, 74];
          else if (typeof data.cell.raw === 'string' && (data.cell.raw.includes('Phase') || data.cell.raw === 'Pending QA' || data.cell.raw === 'Open')) data.cell.styles.textColor = [220, 38, 38];
        }
      });
      
      applyGxPTheme(doc, 'OOS & Deviations Register', UNCONTROLLED);
      
      doc.save('OOS_Investigations_Report.pdf');
      toast('Report Generated Successfully', 'success');
    } catch(e: any) {
      toast(`Failed to generate report: ${e.message || 'unknown error'}`, 'error');
    }
    setLoadingReport(null);
  };

  const generateTrainingMatrix = async () => {
    setLoadingReport('training');
    try {
      const res = await fetch('/api/training', { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const users = data.users || [];
      
      const doc = new jsPDF();
      
      const tableData = users.map((u: any) => [
        u.name || 'N/A',
        u.email,
        u.role,
        u.hasCompletedSoftwareTraining ? 'CERTIFIED' : 'PENDING'
      ]);

      autoTable(doc, {
        startY: 50,
        head: [['User Name', 'Email Address', 'System Role', 'LIMS Certification']],
        body: tableData,
        theme: 'grid',
        styles: { fontSize: 9 },
        headStyles: { fillColor: [44, 62, 80] },
        alternateRowStyles: { fillColor: [248, 250, 252] },
        didParseCell: function(data: any) {
          if (data.column.index === 3) {
            if (data.cell.raw === 'CERTIFIED') data.cell.styles.textColor = [22, 163, 74];
            else if (data.cell.raw === 'PENDING') data.cell.styles.textColor = [220, 38, 38];
          }
        }
      });
      
      applyGxPTheme(doc, 'System Users & Training Matrix', UNCONTROLLED);
      
      doc.save('Training_Matrix_Report.pdf');
      toast('Report Generated Successfully', 'success');
    } catch(e: any) {
      toast(`Failed to generate report: ${e.message || 'unknown error'}`, 'error');
    }
    setLoadingReport(null);
  };

  return (
    <div className="p-6">
      
      {/* Batch Overview Dashboard */}
      {metrics && (
        <div className="mb-8">
          
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-6 gap-4">
            <h2 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
              <PieIcon className="w-6 h-6 text-indigo-600" /> Batch Overview Dashboard
            </h2>
            <button 
              onClick={exportDashboardPDF}
              disabled={loadingReport === 'dashboard'}
              className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 transition-colors disabled:opacity-70"
            >
              {loadingReport === 'dashboard' ? <Activity className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
              Export Dashboard PDF
            </button>
          </div>
          <div id="dashboard-export-target" className="bg-slate-50 p-6 rounded-xl border border-slate-200">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

            
            {/* Status Distribution */}
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 flex flex-col items-center">
              <h3 className="text-lg font-bold text-slate-800 mb-4 w-full text-center">Batch Status Distribution</h3>
              <div className="w-full h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={metrics.batchStatus}
                      cx="50%"
                      cy="50%"
                      innerRadius={60}
                      outerRadius={80}
                      paddingAngle={5}
                      dataKey="value"
                    >
                      {metrics.batchStatus.map((entry: any, index: number) => {
                        const COLORS: Record<string, string> = {
                          'Testing': '#3b82f6',
                          'Pending Review': '#f59e0b',
                          'Approved': '#10b981',
                          'Rejected': '#ef4444'
                        };
                        return <Cell key={`cell-${index}`} fill={COLORS[entry.name] || '#94a3b8'} />;
                      })}
                    </Pie>
                    <Tooltip />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Pass/Fail Rates */}
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 flex flex-col items-center">
              <h3 className="text-lg font-bold text-slate-800 mb-4 w-full text-center">Result Pass/Fail Rates</h3>
              <div className="w-full h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={metrics.passFailRates}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="name" />
                    <YAxis />
                    <Tooltip cursor={{fill: 'transparent'}} />
                    <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                      {metrics.passFailRates.map((entry: any, index: number) => (
                         <Cell key={`cell-${index}`} fill={entry.name === 'Pass' ? '#10b981' : '#ef4444'} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Quick Metrics Cards */}
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 flex flex-col justify-center gap-6">
               <div className="p-4 bg-indigo-50 border border-indigo-100 rounded-lg text-center">
                  <div className="text-sm font-semibold text-indigo-800 uppercase tracking-wider mb-1">Total Samples</div>
                  <div className="text-4xl font-black text-indigo-600">{metrics.totalSamples}</div>
               </div>
               <div className="p-4 bg-amber-50 border border-amber-100 rounded-lg text-center">
                  <div className="text-sm font-semibold text-amber-800 uppercase tracking-wider mb-1">Pending Approval</div>
                  <div className="text-4xl font-black text-amber-600">{metrics.pendingApprovals || 0}</div>
               </div>
            </div>
                    </div>

          {/* Trend Analysis */}
          <div className="mt-8 bg-white rounded-xl shadow-sm border border-slate-200 p-6">
             <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-6 gap-4">
                <h3 className="text-lg font-bold text-slate-800 flex items-center gap-2">
                   <TrendingUp className="w-5 h-5 text-indigo-600" /> Statistical Trend Analysis (SPC)
                </h3>
                <div className="flex items-center gap-4">
                   <select 
                      className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm font-medium bg-slate-50 focus:ring-2 focus:ring-indigo-500 outline-none"
                      value={selectedMaterial}
                      onChange={e => setSelectedMaterial(e.target.value)}
                   >
                     <option value="" disabled>Select Product</option>
                     {trendFilters.materials.map(m => <option key={m} value={m}>{m}</option>)}
                   </select>
                   <select 
                      className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm font-medium bg-slate-50 focus:ring-2 focus:ring-indigo-500 outline-none"
                      value={selectedParameter}
                      onChange={e => setSelectedParameter(e.target.value)}
                   >
                     <option value="" disabled>Select Parameter</option>
                     {trendFilters.parameters.map(p => <option key={p} value={p}>{p}</option>)}
                   </select>
                </div>
             </div>
             
             {trendData.length > 0 ? (
               <div className="w-full h-80">
                 <ResponsiveContainer width="100%" height="100%">
                   <LineChart data={trendData} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
                     <CartesianGrid strokeDasharray="3 3" vertical={false} />
                     <XAxis dataKey="batch" tick={{fontSize: 12}} label={{ value: 'Batch Number', position: 'insideBottom', offset: -10 }} />
                     <YAxis tick={{fontSize: 12}} />
                     <Tooltip 
                       contentStyle={{ borderRadius: '8px', border: '1px solid #e2e8f0', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                       labelStyle={{ fontWeight: 'bold', color: '#1e293b', marginBottom: '4px' }}
                     />
                     <Legend verticalAlign="top" height={36} />
                     
                     {/* Dynamic Reference Lines for Specs if they exist in the first data point */}
                     {trendData[0]?.specMin !== null && trendData[0]?.specMin !== undefined && (
                        <ReferenceLine y={trendData[0].specMin} stroke="#ef4444" strokeDasharray="5 5" label={{ value: 'LSL', position: 'left', fill: '#ef4444', fontSize: 12 }} />
                     )}
                     {trendData[0]?.specMax !== null && trendData[0]?.specMax !== undefined && (
                        <ReferenceLine y={trendData[0].specMax} stroke="#ef4444" strokeDasharray="5 5" label={{ value: 'USL', position: 'left', fill: '#ef4444', fontSize: 12 }} />
                     )}
                     
                     <Line 
                       type="monotone" 
                       dataKey="value" 
                       name={`${selectedParameter} Value`}
                       stroke="#4f46e5" 
                       strokeWidth={2}
                       dot={{ r: 4, strokeWidth: 2, fill: '#fff' }}
                       activeDot={{ r: 6, stroke: '#4f46e5', strokeWidth: 2 }}
                     />
                   </LineChart>
                 </ResponsiveContainer>
               </div>
             ) : (
               <div className="flex flex-col items-center justify-center h-64 text-slate-400 bg-slate-50 rounded-lg border border-slate-100 border-dashed">
                 <TrendingUp className="w-12 h-12 mb-2 opacity-20" />
                 <p className="text-sm font-medium">No trend data available for this selection.</p>
               </div>
             )}
          </div>
          </div>
        </div>
      )}

      <h2 className="text-2xl font-bold text-slate-800 mb-6 flex items-center gap-2">
        <FileText className="w-6 h-6 text-indigo-600" /> Consolidated Reports
      </h2>
      
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        
        
        {/* Certificates of Analysis: issued and signed on the server, listed from the register */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 flex flex-col h-full">
          <div className="w-12 h-12 bg-indigo-100 text-indigo-600 rounded-full flex items-center justify-center mb-4">
            <FileText className="w-6 h-6" />
          </div>
          <h3 className="text-lg font-bold text-slate-800">Certificates of Analysis</h3>
          <p className="text-sm text-slate-500 mt-2 mb-4 flex-1">
            Certificates are issued per sample with a number and an e-signature, and every PDF is a registered controlled copy.
            List the certificates of a batch, or open the certificate of a sample.
          </p>
          <div className="flex gap-2 mb-2">
            <input type="text" aria-label="Batch number" placeholder="Batch number" value={batchNumber} onChange={e => setBatchNumber(e.target.value)} className="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 outline-none" />
            <button type="button" onClick={loadRegister} disabled={loadingReport === 'batch' || !batchNumber.trim()}
              className="px-3 py-2 bg-slate-900 text-white rounded-lg text-sm font-medium hover:bg-slate-800 disabled:opacity-70">List</button>
          </div>
          {register && register.length > 0 && (
            <ul className="text-sm mb-3 divide-y divide-slate-100">
              {register.map(d => (
                <li key={d.id} className="py-1 flex justify-between gap-2">
                  <button type="button" className="font-mono text-indigo-700 hover:underline" onClick={() => setOpenCoaSample(d.sampleId)}>{d.label}</button>
                  <span className={d.status === 'Issued' ? 'text-emerald-700' : 'text-red-700'}>{d.status}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="flex gap-2">
            <input type="text" aria-label="Sample ID" placeholder="Sample ID" value={coaSampleId} onChange={e => setCoaSampleId(e.target.value)} className="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 outline-none" />
            <button type="button" onClick={() => setOpenCoaSample(coaSampleId.trim())} disabled={!coaSampleId.trim()}
              className="px-3 py-2 bg-slate-900 text-white rounded-lg text-sm font-medium hover:bg-slate-800 disabled:opacity-70">Open</button>
          </div>
        </div>

        {/* Audit Trail Report */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 flex flex-col h-full">
          <div className="w-12 h-12 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center mb-4">
            <ShieldCheck className="w-6 h-6" />
          </div>
          <h3 className="text-lg font-bold text-slate-800">Audit Trail Export</h3>
          <p className="text-sm text-slate-500 mt-2 mb-6 flex-1">
            Generates a complete, chronologically ordered export of all system events. Contains full Cryptographic Hash chains and ALCOA+ reasoning for 21 CFR Part 11 compliance.
          </p>
          <button 
            onClick={generateAuditReport}
            disabled={loadingReport === 'audit'}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-slate-900 text-white rounded-lg text-sm font-medium hover:bg-slate-800 transition-colors disabled:opacity-70"
          >
            {loadingReport === 'audit' ? <Activity className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            Download PDF
          </button>
        </div>

        {/* OOS Trends */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 flex flex-col h-full">
          <div className="w-12 h-12 bg-red-100 text-red-600 rounded-full flex items-center justify-center mb-4">
            <Activity className="w-6 h-6" />
          </div>
          <h3 className="text-lg font-bold text-slate-800">OOS & Deviations</h3>
          <p className="text-sm text-slate-500 mt-2 mb-6 flex-1">
            Consolidated summary of all Out of Specification (OOS) investigations, including current phase status, assigned analysts, documented root causes, and implemented CAPAs.
          </p>
          <button 
            onClick={generateOosReport}
            disabled={loadingReport === 'oos'}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-slate-900 text-white rounded-lg text-sm font-medium hover:bg-slate-800 transition-colors disabled:opacity-70"
          >
            {loadingReport === 'oos' ? <Activity className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            Download PDF
          </button>
        </div>

        {/* Training Matrix */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 flex flex-col h-full">
          <div className="w-12 h-12 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center mb-4">
            <Users className="w-6 h-6" />
          </div>
          <h3 className="text-lg font-bold text-slate-800">Training Matrix</h3>
          <p className="text-sm text-slate-500 mt-2 mb-6 flex-1">
            A comprehensive matrix detailing all system users, their assigned roles, and their certification status for LIMS Software Usage, essential for system access audits.
          </p>
          <button 
            onClick={generateTrainingMatrix}
            disabled={loadingReport === 'training'}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-slate-900 text-white rounded-lg text-sm font-medium hover:bg-slate-800 transition-colors disabled:opacity-70"
          >
            {loadingReport === 'training' ? <Activity className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            Download PDF
          </button>
        </div>

      </div>

      {openCoaSample && (
        <div className="mt-8">
          <div className="flex justify-between items-center mb-2">
            <h2 className="text-lg font-bold text-slate-800">Sample {openCoaSample}</h2>
            <button type="button" className="text-sm text-slate-600 hover:underline" onClick={() => setOpenCoaSample(null)}>Close</button>
          </div>
          <div key={openCoaSample}><CoaPanel sampleId={openCoaSample} token={token} /></div>
        </div>
      )}

      {/* Dynamic Report Builder */}
      <div className="mt-8">
        <h2 className="text-2xl font-bold text-slate-800 mb-6 flex items-center gap-2">
          <Filter className="w-6 h-6 text-indigo-600" /> Dynamic Report Builder
        </h2>
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            {/* Left Col: Config */}
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-2">1. Select Data Source</label>
              <select 
                className="w-full border border-slate-300 rounded-lg px-4 py-2 bg-slate-50 text-slate-700 font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500 mb-6"
                value={selectedSource}
                onChange={e => setSelectedSource(e.target.value)}
              >
                <option value="samples">Samples & Testing</option>
                <option value="oos">OOS Investigations</option>
                <option value="audit">Audit Trail (System Events)</option>
              </select>

              <label className="block text-sm font-semibold text-slate-700 mb-2">2. Select Columns</label>
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 grid grid-cols-2 gap-3 mb-6">
                {availableColumns.map(col => (
                  <label key={col.key} className="flex items-center gap-2 cursor-pointer">
                    <input 
                      type="checkbox" 
                      className="rounded text-indigo-600 focus:ring-indigo-500 w-4 h-4" 
                      checked={selectedColumns.includes(col.key)}
                      onChange={() => toggleColumn(col.key)}
                    />
                    <span className="text-sm font-medium text-slate-700">{col.label}</span>
                  </label>
                ))}
              </div>
            </div>
            
            {/* Right Col: Actions */}
            <div className="flex flex-col justify-center gap-4">
              <p className="text-xs text-slate-500 mb-2">Exports are working copies: every page is stamped UNCONTROLLED COPY.</p>
              <label className="block text-sm font-semibold text-slate-700 mb-2">3. Export Report</label>
              <button 
                onClick={exportDynamicPDF}
                disabled={selectedColumns.length === 0 || isFetchingData}
                className="w-full flex items-center justify-center gap-3 px-4 py-4 bg-red-50 text-red-700 border border-red-200 rounded-xl font-bold hover:bg-red-100 transition-colors disabled:opacity-50"
              >
                {isFetchingData ? <Activity className="w-5 h-5 animate-spin" /> : <File className="w-5 h-5" />}
                Generate PDF Document
              </button>
              <button 
                onClick={exportDynamicCsv}
                disabled={selectedColumns.length === 0 || isFetchingData}
                className="w-full flex items-center justify-center gap-3 px-4 py-4 bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-xl font-bold hover:bg-emerald-100 transition-colors disabled:opacity-50"
              >
                {isFetchingData ? <Activity className="w-5 h-5 animate-spin" /> : <FileSpreadsheet className="w-5 h-5" />}
                Export to CSV (opens in Excel)
              </button>
              <p className="text-xs text-slate-500 text-center mt-2">
                CSV cells that would start a spreadsheet formula are neutralised.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

