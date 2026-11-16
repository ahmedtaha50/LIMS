import { createHash } from 'node:crypto';

/**
 * A plain PDF (text only, Helvetica, A4) without a dependency: enough for a logbook export that a person can read, print
 * and file. Each page carries the export hash, which the system can recompute from the same data.
 */
const esc = (s: string) => s.replace(/[\\()]/g, m => '\\' + m).replace(/[^\x20-\x7e]/g, '?');
function wrap(line: string, width = 95): string[] {
  const out: string[] = [];
  let rest = line;
  while (rest.length > width) { const cut = rest.lastIndexOf(' ', width) > 20 ? rest.lastIndexOf(' ', width) : width; out.push(rest.slice(0, cut)); rest = '    ' + rest.slice(cut).trimStart(); }
  out.push(rest);
  return out;
}

export function textPdf(title: string, lines: string[]): { pdf: Buffer; sha256: string } {
  const sha256 = createHash('sha256').update(title + '\n' + lines.join('\n')).digest('hex');
  const all = lines.flatMap(l => wrap(l));
  const perPage = 60, pages: string[][] = [];
  for (let i = 0; i < Math.max(all.length, 1); i += perPage) pages.push(all.slice(i, i + perPage));
  const objs: string[] = [];
  const add = (s: string) => { objs.push(s); return objs.length; };
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pagesId = objs.length + 1 + pages.length * 2;
  const kids: number[] = [];
  pages.forEach((p, n) => {
    const body = ['BT', '/F1 9 Tf', '40 800 Td', '12 TL', `(${esc(title)}) Tj`, 'T*', `(Page ${n + 1} of ${pages.length} - export ${sha256.slice(0, 16)}) Tj`, 'T*', 'T*', ...p.map(l => `(${esc(l)}) Tj T*`), 'ET'].join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(body)} >>\nstream\n${body}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] /Contents ${content} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`));
  });
  add(`<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`);
  const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return { pdf: Buffer.from(out, 'latin1'), sha256 };
}
