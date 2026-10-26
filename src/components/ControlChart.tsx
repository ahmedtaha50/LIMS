// Individuals control chart (roadmap M39, r3-spc). Straight lines between points (no smoothing), the centre line, the control limits,
// the 1 and 2 sigma zones, and the specification limits drawn apart from them. A rule violation is never shown by colour alone: it has
// its own marker shape and the rule id printed beside it; a point from an unapproved sample is a hollow ring. Each point can be
// focused and opens its sample. The same data is available below as a table (assistive technology and print).
import React from 'react';

export interface ChartViolation { rule: string; label: string; severity: string; side: string }
export interface ChartPointData {
  resultId: string; sampleId: string; batch: string; value: number; enteredAt: string; sampleState: string; approved: boolean;
  z: number | null; violations: ChartViolation[];
}
export interface ChartLimits { cl: number; sigma: number; ucl: number; lcl: number }

const W = 760; const H = 300; const PAD = { l: 56, r: 64, t: 16, b: 34 };

const fmt = (v: number) => (Math.abs(v) >= 1000 ? v.toFixed(0) : Math.abs(v) >= 100 ? v.toFixed(2) : v.toFixed(3));

/** The marker of a point: ring = unapproved; diamond = violation; square = warning; dot = in control. Shape carries the meaning. */
export function Marker({ x, y, kind }: { x: number; y: number; kind: 'ok' | 'unapproved' | 'warning' | 'violation' }) {
  if (kind === 'unapproved') return <circle cx={x} cy={y} r={4.5} fill="white" stroke="#475569" strokeWidth={2} />;
  if (kind === 'violation') return <polygon points={`${x},${y - 7} ${x + 7},${y} ${x},${y + 7} ${x - 7},${y}`} fill="#b91c1c" stroke="white" strokeWidth={1} />;
  if (kind === 'warning') return <rect x={x - 5} y={y - 5} width={10} height={10} fill="#b45309" stroke="white" strokeWidth={1} />;
  return <circle cx={x} cy={y} r={3.5} fill="#1d4ed8" />;
}

export const kindOf = (p: Pick<ChartPointData, 'approved' | 'violations'>): 'ok' | 'unapproved' | 'warning' | 'violation' =>
  !p.approved ? 'unapproved' : p.violations.some(v => v.severity === 'violation') ? 'violation' : p.violations.length ? 'warning' : 'ok';

export function ControlChart({ points, limits, spec, unit, title }: {
  points: ChartPointData[]; limits: ChartLimits | null; spec: { lower: number | null; upper: number | null }; unit?: string | null; title: string;
}) {
  if (points.length === 0) return <p className="text-sm text-slate-500">There are no approved results for this attribute in the selected window.</p>;
  const values = points.map(p => p.value);
  const marks = [...values];
  if (limits) marks.push(limits.ucl, limits.lcl);
  if (spec.lower != null) marks.push(spec.lower);
  if (spec.upper != null) marks.push(spec.upper);
  let lo = Math.min(...marks); let hi = Math.max(...marks);
  if (hi === lo) { hi += 1; lo -= 1; }
  const pad = (hi - lo) * 0.06; lo -= pad; hi += pad;
  const x = (i: number) => PAD.l + (points.length === 1 ? (W - PAD.l - PAD.r) / 2 : (i * (W - PAD.l - PAD.r)) / (points.length - 1));
  const y = (v: number) => PAD.t + ((hi - v) * (H - PAD.t - PAD.b)) / (hi - lo);
  const line = (v: number, label: string, cls: string, dash?: string) => (
    <g key={label}>
      <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} className={cls} strokeDasharray={dash} />
      <text x={W - PAD.r + 4} y={y(v) + 3} className="fill-slate-600" fontSize={10}>{label} {fmt(v)}</text>
    </g>
  );
  // The path joins the approved points only; an unapproved point sits on the chart without joining the line.
  const path = points.map((p, i) => ({ p, i })).filter(({ p }) => p.approved).map(({ p, i }, k) => `${k === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');

  return (
    <figure className="m-0">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label={`${title}: individuals control chart of ${points.length} results`}>
        <rect x={0} y={0} width={W} height={H} className="fill-white" />
        {limits && [1, 2].map(k => (
          <g key={k}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(limits.cl + k * limits.sigma)} y2={y(limits.cl + k * limits.sigma)} className="stroke-slate-200" strokeDasharray="2 4" />
            <line x1={PAD.l} x2={W - PAD.r} y1={y(limits.cl - k * limits.sigma)} y2={y(limits.cl - k * limits.sigma)} className="stroke-slate-200" strokeDasharray="2 4" />
          </g>
        ))}
        {limits && line(limits.ucl, 'UCL', 'stroke-red-600', '6 3')}
        {limits && line(limits.cl, 'CL', 'stroke-slate-700')}
        {limits && line(limits.lcl, 'LCL', 'stroke-red-600', '6 3')}
        {spec.upper != null && line(spec.upper, 'USL', 'stroke-violet-700', '1 3')}
        {spec.lower != null && line(spec.lower, 'LSL', 'stroke-violet-700', '1 3')}
        <path d={path} fill="none" className="stroke-blue-700" strokeWidth={1.5} strokeLinejoin="round" />
        {points.map((p, i) => {
          const kind = kindOf(p);
          const rules = p.violations.map(v => v.rule).join(' ');
          return (
            <a key={p.resultId} href={`#/samples/${p.sampleId}`} aria-label={`Sample ${p.sampleId}, batch ${p.batch}, ${p.value}${unit ? ` ${unit}` : ''}${rules ? `, rule ${rules}` : ''}${p.approved ? '' : ', not approved'}`}>
              <title>{`${p.sampleId} (batch ${p.batch})\n${new Date(p.enteredAt).toLocaleString()}\n${p.value}${unit ? ` ${unit}` : ''}${p.z === null ? '' : `  (${p.z.toFixed(2)} sigma)`}${rules ? `\nRule ${rules}` : ''}${p.approved ? '' : `\n${p.sampleState}: not approved, not used for the limits`}`}</title>
              <Marker x={x(i)} y={y(p.value)} kind={kind} />
              {rules && <text x={x(i)} y={y(p.value) - 10} textAnchor="middle" fontSize={9} className="fill-red-800 font-semibold">{p.violations[0].rule}</text>}
              <circle cx={x(i)} cy={y(p.value)} r={9} fill="transparent" />
            </a>
          );
        })}
        <text x={PAD.l} y={H - 8} fontSize={10} className="fill-slate-500">{new Date(points[0].enteredAt).toLocaleDateString()}</text>
        <text x={W - PAD.r} y={H - 8} fontSize={10} textAnchor="end" className="fill-slate-500">{new Date(points[points.length - 1].enteredAt).toLocaleDateString()}</text>
        <text x={(PAD.l + W - PAD.r) / 2} y={H - 8} fontSize={10} textAnchor="middle" className="fill-slate-500">results in the order they were entered</text>
      </svg>
      <figcaption className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600 mt-1">
        <span><svg width="12" height="12" className="inline"><circle cx="6" cy="6" r="3.5" fill="#1d4ed8" /></svg> in control</span>
        <span><svg width="14" height="14" className="inline"><polygon points="7,0 14,7 7,14 0,7" fill="#b91c1c" /></svg> rule violation (rule id beside it)</span>
        <span><svg width="12" height="12" className="inline"><rect x="1" y="1" width="10" height="10" fill="#b45309" /></svg> warning</span>
        <span><svg width="12" height="12" className="inline"><circle cx="6" cy="6" r="4.5" fill="white" stroke="#475569" strokeWidth="2" /></svg> not approved (not used for limits or rules)</span>
        <span>dashed red: control limits; dotted violet: specification limits</span>
      </figcaption>
    </figure>
  );
}
