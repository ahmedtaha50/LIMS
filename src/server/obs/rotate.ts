import fs from 'fs';
import path from 'path';

export interface RotatingFile {
  /** Appends one line (a newline is added). Never throws: a full disk must not take the caller down. */
  write(line: string): void;
  close(): void;
}

export interface RotatingFileOptions {
  /** A file is rotated before a write that would take it past this size. Default 5 MB. */
  maxBytes?: number;
  /** Total files kept, the live one included: name, name.1, ... Default 10. */
  maxFiles?: number;
}

/**
 * Size-based log rotation without a dependency: `name` is always the newest, `name.1` the one before, and the
 * oldest is deleted once `maxFiles` is reached. Synchronous on purpose, so a line written just before a crash is on disk.
 */
export function createRotatingFile(file: string, opts: RotatingFileOptions = {}): RotatingFile {
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const maxFiles = Math.max(1, opts.maxFiles ?? 10);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  let fd: number | null = null;
  let size = 0;

  const open = () => {
    fd = fs.openSync(file, 'a', 0o600);
    size = fs.fstatSync(fd).size;
  };
  const close = () => {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* already closed */ } fd = null; }
  };
  const rotate = () => {
    close(); // Windows cannot rename an open file
    const last = `${file}.${maxFiles - 1}`;
    if (maxFiles === 1) { fs.rmSync(file, { force: true }); return; }
    fs.rmSync(last, { force: true });
    for (let i = maxFiles - 2; i >= 1; i--) {
      if (fs.existsSync(`${file}.${i}`)) fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    }
    fs.renameSync(file, `${file}.1`);
  };

  return {
    write(line) {
      try {
        const data = Buffer.from(line + '\n');
        if (fd === null) open();
        if (size > 0 && size + data.length > maxBytes) { rotate(); open(); }
        fs.writeSync(fd!, data);
        size += data.length;
      } catch { /* logging must never throw */ }
    },
    close,
  };
}
