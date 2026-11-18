import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { installFatalHandlers } from '../server/fatal';

function setup() {
  const proc = Object.assign(new EventEmitter(), { exit: (code: number): never => { exits.push(code); return undefined as never; } });
  const exits: number[] = [];
  const lines: string[] = [];
  installFatalHandlers(proc, (line) => lines.push(line));
  return { proc, exits, lines };
}

describe('installFatalHandlers', () => {
  it('logs an uncaught exception with its message and stack, then exits 1 once', () => {
    const { proc, exits, lines } = setup();
    const err = new Error('boom');
    proc.emit('uncaughtException', err);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(`[jt] fatal uncaughtException: boom\n${err.stack}`);
    expect(exits).toEqual([1]);
  });

  it('logs an unhandled rejection with an Error reason, then exits 1 once', () => {
    const { proc, exits, lines } = setup();
    const err = new TypeError('bad promise');
    proc.emit('unhandledRejection', err, Promise.resolve());
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(`[jt] fatal unhandledRejection: bad promise\n${err.stack}`);
    expect(exits).toEqual([1]);
  });

  it('logs a non-Error rejection value as text without a stack', () => {
    const { proc, exits, lines } = setup();
    proc.emit('unhandledRejection', 'nope', Promise.resolve());
    expect(lines).toEqual(['[jt] fatal unhandledRejection: nope']);
    expect(exits).toEqual([1]);
  });
});
