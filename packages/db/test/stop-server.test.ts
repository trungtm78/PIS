import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { stopServer } from '../src/test-database';

/**
 * `stopServer` is what stops the embedded PostgreSQL servers of the suites. The library it wraps waits for the `exit` event of the postmaster; these cases use a stand-in with the same shape (a `process` and a `stop`)
 * for the three things that can happen: the postmaster is already gone (the library would wait for ever), it stops in time, it does not stop (it is killed by its pid).
 */

const stopThatNeverEnds = (): Promise<void> => new Promise<void>(() => undefined);
const asServer = (process: Partial<ChildProcess> | undefined, stop: () => Promise<void>): Parameters<typeof stopServer>[0] => ({ process, stop }) as unknown as Parameters<typeof stopServer>[0];

function sleeper(): ChildProcess {
  return spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], { stdio: 'ignore' });
}

const exited = (child: ChildProcess): Promise<void> => new Promise((resolve) => (child.exitCode !== null || child.signalCode !== null ? resolve() : child.once('exit', () => resolve())));

describe('stopping an embedded server', () => {
  it('does not wait for the exit of a postmaster that has already exited', async () => {
    const child = sleeper();
    child.kill();
    await exited(child);
    const started = Date.now();
    await stopServer(asServer(child, stopThatNeverEnds), 60_000);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 30_000);

  it('does nothing for a server that was never started', async () => {
    await expect(stopServer(asServer(undefined, stopThatNeverEnds), 60_000)).resolves.toBeUndefined();
  });

  it('returns when the library stops the server in time, without killing anything', async () => {
    const child = sleeper();
    try {
      await stopServer(asServer(child, async () => undefined), 60_000);
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
    } finally {
      child.kill();
      await exited(child);
    }
  }, 30_000);

  it('kills by process tree a server that does not stop within the grace period', async () => {
    const child = sleeper();
    try {
      await stopServer(asServer(child, stopThatNeverEnds), 300);
      await exited(child);
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    } finally {
      child.kill();
    }
  }, 60_000);
});
