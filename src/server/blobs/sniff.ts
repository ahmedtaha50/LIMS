/**
 * What a raw-data file is, decided from its first bytes (never from the name or the Content-Type the client sends), against an
 * allow-list of the formats laboratory instruments and worksheets produce. The file name's extension must be one the detected format
 * uses, so a renamed executable or a PDF named .csv is refused. Text formats are recognised by content: valid UTF-8 without NUL bytes.
 */
export interface FileKind {
  kind: string;
  mediaType: string;
}

interface Format { kind: string; magic?: number[][]; text?: boolean; extensions: Record<string, string> }

const FORMATS: Format[] = [
  { kind: 'pdf', magic: [[0x25, 0x50, 0x44, 0x46, 0x2d]], extensions: { pdf: 'application/pdf' } },
  { kind: 'png', magic: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]], extensions: { png: 'image/png' } },
  { kind: 'jpeg', magic: [[0xff, 0xd8, 0xff]], extensions: { jpg: 'image/jpeg', jpeg: 'image/jpeg' } },
  { kind: 'tiff', magic: [[0x49, 0x49, 0x2a, 0x00], [0x4d, 0x4d, 0x00, 0x2a]], extensions: { tif: 'image/tiff', tiff: 'image/tiff' } },
  {
    kind: 'zip', magic: [[0x50, 0x4b, 0x03, 0x04]], extensions: {
      zip: 'application/zip',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    },
  },
  // AIA/ANDI chromatography files (netCDF classic and 64-bit offset) and HDF5 containers (netCDF-4, many instrument exports).
  { kind: 'netcdf', magic: [[0x43, 0x44, 0x46, 0x01], [0x43, 0x44, 0x46, 0x02]], extensions: { cdf: 'application/x-netcdf', nc: 'application/x-netcdf' } },
  { kind: 'hdf5', magic: [[0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a]], extensions: { h5: 'application/x-hdf5', hdf5: 'application/x-hdf5' } },
  {
    kind: 'text', text: true, extensions: {
      csv: 'text/csv', tsv: 'text/tab-separated-values', txt: 'text/plain', log: 'text/plain', xml: 'application/xml',
      jdx: 'chemical/x-jcamp-dx', dx: 'chemical/x-jcamp-dx',
    },
  },
];

/** Every extension the allow-list accepts (for the screen's file picker). */
export const ALLOWED_EXTENSIONS: string[] = FORMATS.flatMap(f => Object.keys(f.extensions)).sort();

const startsWith = (head: Buffer, magic: number[]) => head.length >= magic.length && magic.every((b, i) => head[i] === b);

/** Valid UTF-8 apart from a character cut at the end of the sample, and no NUL byte. */
function looksLikeText(head: Buffer, complete: boolean): boolean {
  if (head.includes(0)) return false;
  // A script is text too; it is refused so that nothing executable is kept under a harmless name.
  if (head[0] === 0x23 && head[1] === 0x21) return false;
  let end = head.length;
  if (!complete) {
    // Drop a trailing incomplete multi-byte sequence (at most 3 bytes).
    for (let back = 1; back <= 3 && end - back >= 0; back++) {
      const b = head[end - back];
      if ((b & 0xc0) === 0x80) continue;
      if (b >= 0xc0) end -= back;
      break;
    }
  }
  try { new TextDecoder('utf-8', { fatal: true }).decode(head.subarray(0, end)); return true; } catch { return false; }
}

export const extensionOf = (fileName: string): string => {
  const dot = fileName.lastIndexOf('.');
  return dot < 0 ? '' : fileName.slice(dot + 1).toLowerCase();
};

/**
 * The kind and media type of a file from its first bytes, or the reason it is refused. `complete` says whether `head` is the whole file
 * (a text check must then not allow for a character cut at the end).
 */
export function detectKind(head: Buffer, fileName: string, complete: boolean): { ok: true; value: FileKind } | { ok: false; reason: string } {
  const ext = extensionOf(fileName);
  const format = FORMATS.find(f => f.magic?.some(m => startsWith(head, m))) ?? (looksLikeText(head, complete) ? FORMATS.find(f => f.text) : undefined);
  if (!format) return { ok: false, reason: `This kind of file is not accepted as raw data. Accepted: ${ALLOWED_EXTENSIONS.map(e => `.${e}`).join(', ')}.` };
  const mediaType = format.extensions[ext];
  if (!mediaType) {
    return { ok: false, reason: `The content of "${fileName}" is ${format.kind === 'text' ? 'text' : `a ${format.kind.toUpperCase()} file`}, which is not saved as .${ext || '(no extension)'}; use ${Object.keys(format.extensions).map(e => `.${e}`).join(', ')}.` };
  }
  return { ok: true, value: { kind: format.kind, mediaType } };
}
