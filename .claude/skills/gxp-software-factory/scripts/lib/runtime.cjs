// @ts-check
// How every tool of the factory runs. A tool is a module that exports `main(argv, io)` and returns its exit code:
//   - from the command line, `cli(main)` gives it the real console, stdin and exit code;
//   - from another tool or a test, `invoke(main, argv)` runs it in the same process and returns { code, out }.
// No tool touches process.argv, process.exit or the console directly, so each one can be tested as a function, and the
// conductor (factory.cjs) and the drill (selftest.cjs) call the others without starting a Node process for each call.
'use strict';
const fs = require('fs');
const path = require('path');
const util = require('util');

/** Thrown by io.exit(): unwinds the tool to its caller without ending the process. */
class Exit extends Error {
  /** @param {number} code */
  constructor(code) { super(`exit ${code}`); this.code = code; }
}

/**
 * @typedef {object} IO
 * @property {{ log: (...a: unknown[]) => void, error: (...a: unknown[]) => void }} console
 * @property {(code?: number) => never} exit
 * @property {() => string} stdin   the whole standard input (a tool reads it only when asked to read "-")
 */
/** @typedef {(argv: string[], io: IO) => number | void} Main */

/** @param {number | void} code */
const exitCode = (code) => (typeof code === 'number' ? code : 0);
/** @param {unknown} e @param {() => number} otherwise */
const caught = (e, otherwise) => { if (e instanceof Exit) return e.code; return otherwise(); };

/**
 * Runs a tool as a command. Sets process.exitCode instead of calling process.exit, so piped output is never cut off.
 * @param {Main} main
 */
function cli(main) {
  /** @type {IO} */
  const io = {
    console,
    exit: (code = 0) => { throw new Exit(code); },
    stdin: () => fs.readFileSync(0, 'utf8'),
  };
  let code;
  try { code = exitCode(main(process.argv.slice(2), io)); }
  catch (e) { code = caught(e, () => { throw e; }); }
  process.exitCode = code;
}

/**
 * Runs a tool in this process and captures what it prints (stdout and stderr together, in order, as a terminal shows them).
 * @param {Main} main
 * @param {string[]} argv
 * @param {{ input?: string, cwd?: string }} [opts]
 * @returns {{ code: number, out: string }}
 */
function invoke(main, argv, opts = {}) {
  /** @type {string[]} */
  const lines = [];
  const print = (/** @type {unknown[]} */ ...a) => { lines.push(util.format(...a)); };
  /** @type {IO} */
  const io = { console: { log: print, error: print }, exit: (code = 0) => { throw new Exit(code); }, stdin: () => opts.input || '' };
  const before = process.cwd();
  if (opts.cwd) process.chdir(opts.cwd);
  let code;
  try { code = exitCode(main([...argv], io)); }
  catch (e) {
    code = caught(e, () => { lines.push(`internal error: ${e instanceof Error ? e.stack : String(e)}`); return 70; });
  } finally { if (opts.cwd) process.chdir(before); }
  return { code, out: lines.length ? lines.join('\n') + '\n' : '' };
}

/** @type {Map<string, Main>} */
const loaded = new Map();
/**
 * Resolves a sibling tool by its file name ("roadmap-lint.cjs") to its main function; null for any other script.
 * @param {string} name
 * @returns {Main | null}
 */
function sibling(name) {
  const file = path.resolve(__dirname, '..', name);
  if (path.dirname(file) !== path.resolve(__dirname, '..') || !fs.existsSync(file)) return null;
  const hit = loaded.get(file);
  if (hit) return hit;
  const mod = require(file);
  if (!mod || typeof mod.main !== 'function') return null;
  loaded.set(file, mod.main);
  return mod.main;
}

module.exports = { Exit, cli, invoke, sibling };
