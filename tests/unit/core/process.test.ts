import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import { installProcessHandlers } from '../../../src/server/core/process';

const setup = () => {
  const proc = new EventEmitter();
  const exit = vi.fn();
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const onFatal = vi.fn();
  const uninstall = installProcessHandlers({ proc: proc as any, exit, log, onFatal, exitDelayMs: 0 });
  return { proc, exit, log, onFatal, uninstall };
};

describe('installProcessHandlers', () => {
  it('logs an unhandled rejection and keeps the server running', () => {
    const { proc, exit, log } = setup();
    proc.emit('unhandledRejection', new Error('stray promise'), Promise.resolve());
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.objectContaining({ message: 'stray promise' }) }), 'unhandled promise rejection');
    expect(exit).not.toHaveBeenCalled();
  });

  it('tolerates a non-Error rejection reason', () => {
    const { proc, log } = setup();
    proc.emit('unhandledRejection', 'just a string', Promise.resolve());
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.objectContaining({ message: 'just a string' }) }), 'unhandled promise rejection');
  });

  it('logs an uncaught exception, runs the shutdown hook, then exits non-zero (state can no longer be trusted)', async () => {
    const { proc, exit, log, onFatal } = setup();
    proc.emit('uncaughtException', new Error('corrupt'));
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.objectContaining({ message: 'corrupt' }) }), 'uncaught exception, shutting down');
    expect(onFatal).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  });

  it('exits even when the shutdown hook itself throws', async () => {
    const proc = new EventEmitter();
    const exit = vi.fn();
    installProcessHandlers({ proc: proc as any, exit, log: { debug() {}, info() {}, warn() {}, error() {} }, onFatal: () => { throw new Error('hook'); }, exitDelayMs: 0 });
    proc.emit('uncaughtException', new Error('corrupt'));
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  });

  it('can be uninstalled', () => {
    const { proc, uninstall } = setup();
    uninstall();
    expect(proc.listenerCount('unhandledRejection')).toBe(0);
    expect(proc.listenerCount('uncaughtException')).toBe(0);
  });
});
