import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LANES, acquireLane, lockIsStale, main, runInLane } from './lane.mjs';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const FAST = { pollMs: 5, locale: 'en', log: () => undefined };

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'machvon-lane-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('two concurrent callers of one lane run one after the other', async () => {
  const { root, cleanup } = scratch();
  try {
    const events = [];
    const job = (name) => async () => {
      events.push(`start ${name}`);
      await wait(40);
      events.push(`end ${name}`);
      return 0;
    };
    await Promise.all([runInLane('db', job('a'), { root, ...FAST }), runInLane('db', job('b'), { root, ...FAST })]);
    assert.equal(events.length, 4);
    // Whoever started first ends before the other starts.
    assert.deepEqual(events.slice(0, 2).map((event) => event.split(' ')[1]).sort(), ['a', 'a']);
    assert.equal(events[1].startsWith('end'), true);
  } finally {
    cleanup();
  }
});

test('callers are served first in, first out', async () => {
  const { root, cleanup } = scratch();
  try {
    const order = [];
    const job = (name) => async () => {
      order.push(name);
      await wait(15);
      return 0;
    };
    const holders = [];
    for (const name of ['first', 'second', 'third', 'fourth']) {
      holders.push(runInLane('db', job(name), { root, ...FAST }));
      await wait(10); // distinct queue tickets
    }
    await Promise.all(holders);
    assert.deepEqual(order, ['first', 'second', 'third', 'fourth']);
  } finally {
    cleanup();
  }
});

test('different lanes do not block each other', async () => {
  const { root, cleanup } = scratch();
  try {
    const events = [];
    const job = (name) => async () => {
      events.push(`start ${name}`);
      await wait(40);
      events.push(`end ${name}`);
      return 0;
    };
    await Promise.all([runInLane('db', job('db'), { root, ...FAST }), runInLane('browser', job('browser'), { root, ...FAST })]);
    assert.deepEqual(events.slice(0, 2).sort(), ['start browser', 'start db']);
  } finally {
    cleanup();
  }
});

test('the exit code of the work is returned and the lane is released when the work throws', async () => {
  const { root, cleanup } = scratch();
  try {
    assert.equal(await runInLane('db', async () => 7, { root, ...FAST }), 7);
    await assert.rejects(
      runInLane('db', async () => {
        throw new Error('boom');
      }, { root, ...FAST }),
      /boom/,
    );
    // Free again: this call must not wait.
    assert.equal(await runInLane('db', async () => 0, { root, ...FAST, timeoutMs: 500 }), 0);
    assert.equal(existsSync(join(root, '.test-locks', 'db.lock')), false);
  } finally {
    cleanup();
  }
});

test('a lock held by a process that no longer exists is reclaimed', async () => {
  const { root, cleanup } = scratch();
  try {
    const lock = join(root, '.test-locks', 'db.lock');
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'holder.json'), JSON.stringify({ pid: 2_147_483_000, startedAt: Date.now() }));
    const messages = [];
    assert.equal(await runInLane('db', async () => 0, { root, pollMs: 5, locale: 'en', log: (line) => messages.push(line), timeoutMs: 2000 }), 0);
    assert.equal(messages.some((line) => line.includes('stale')), true);
  } finally {
    cleanup();
  }
});

test('a lock older than staleMs is reclaimed even when its process is alive', async () => {
  const { root, cleanup } = scratch();
  try {
    const lock = join(root, '.test-locks', 'db.lock');
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'holder.json'), JSON.stringify({ pid: process.pid, startedAt: Date.now() - 10_000 }));
    assert.equal(await runInLane('db', async () => 0, { root, ...FAST, staleMs: 1_000, timeoutMs: 2000 }), 0);
  } finally {
    cleanup();
  }
});

test('a fresh lock of a live process makes the caller wait, and the wait ends with an error at timeoutMs', async () => {
  const { root, cleanup } = scratch();
  try {
    const lock = join(root, '.test-locks', 'db.lock');
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'holder.json'), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    await assert.rejects(runInLane('db', async () => 0, { root, ...FAST, timeoutMs: 100 }), /timed out/);
    // The caller leaves no queue ticket behind.
    const queue = join(root, '.test-locks', 'db.queue');
    assert.equal(!existsSync(queue) || readdirSync(queue).length === 0, true);
  } finally {
    cleanup();
  }
});

test('a queue ticket of a dead process does not block the queue', async () => {
  const { root, cleanup } = scratch();
  try {
    const queue = join(root, '.test-locks', 'db.queue');
    mkdirSync(queue, { recursive: true });
    writeFileSync(join(queue, '0000000000001-2147483000-dead'), JSON.stringify({ pid: 2_147_483_000 }));
    assert.equal(await runInLane('db', async () => 0, { root, ...FAST, timeoutMs: 2000 }), 0);
  } finally {
    cleanup();
  }
});

test('an unknown lane is refused', async () => {
  const { root, cleanup } = scratch();
  try {
    await assert.rejects(runInLane('gpu', async () => 0, { root, ...FAST }), /unknown lane/);
    assert.deepEqual([...LANES].sort(), ['browser', 'db', 'heavy1', 'heavy2', 'verify']);
  } finally {
    cleanup();
  }
});

test('main runs the command under the lane, marks the lane as held for it and passes its exit code on', async () => {
  const { root, cleanup } = scratch();
  try {
    const lines = [];
    const code = await main(['db', '--', process.execPath, '-e', 'process.exit(process.env.MACHVON_LANE_HELD === "db" ? 3 : 9)'], {
      root,
      locale: 'en',
      log: (line) => lines.push(line),
    });
    assert.equal(code, 3);
    assert.equal(await main(['db'], { root, locale: 'en', log: (line) => lines.push(line) }), 2);
    assert.equal(await main(['nope', '--', process.execPath, '-v'], { root, locale: 'en', log: (line) => lines.push(line) }), 2);
    assert.equal(lines.length >= 2, true);
  } finally {
    cleanup();
  }
});

test('acquireLane holds the lane until release, and releasing twice is harmless', async () => {
  const { root, cleanup } = scratch();
  try {
    const held = await acquireLane('db', { root, ...FAST });
    // While held, a second caller times out.
    await assert.rejects(acquireLane('db', { root, ...FAST, timeoutMs: 60 }), /timed out/);
    held.release();
    held.release();
    const next = await acquireLane('db', { root, ...FAST, timeoutMs: 500 });
    next.release();
    assert.equal(existsSync(join(root, '.test-locks', 'db.lock')), false);
  } finally {
    cleanup();
  }
});

test('acquireLane returns a no-op handle when an ancestor already holds the lane', async () => {
  const { root, cleanup } = scratch();
  try {
    const handle = await acquireLane('db', { root, ...FAST, env: { MACHVON_LANE_HELD: 'db' } });
    assert.equal(handle.held, false);
    handle.release();
    assert.equal(existsSync(join(root, '.test-locks', 'db.lock')), false);
  } finally {
    cleanup();
  }
});

test('a queue ticket that is still being written is kept and keeps its place; tickets are written by rename', async () => {
  const { root, cleanup } = scratch();
  try {
    const queue = join(root, '.test-locks', 'db.queue');
    mkdirSync(queue, { recursive: true });
    const partial = join(queue, '0000000000001-1-partial');
    writeFileSync(partial, '{"pid"'); // a half written ticket of a process that is just queueing
    await assert.rejects(runInLane('db', async () => 0, { root, ...FAST, timeoutMs: 150 }), /timed out/);
    assert.equal(existsSync(partial), true, 'the half written ticket must survive');
    rmSync(partial);
    assert.equal(await runInLane('db', async () => 0, { root, ...FAST, timeoutMs: 1000 }), 0);
    assert.deepEqual(readdirSync(queue), [], 'no temporary or leftover ticket remains');
  } finally {
    cleanup();
  }
});

test('an unreadable ticket that stays unreadable past the grace period is dropped', async () => {
  const { root, cleanup } = scratch();
  try {
    const queue = join(root, '.test-locks', 'db.queue');
    mkdirSync(queue, { recursive: true });
    const broken = join(queue, '0000000000001-1-broken');
    writeFileSync(broken, 'not json');
    const old = new Date(Date.now() - 60_000);
    utimesSync(broken, old, old);
    assert.equal(await runInLane('db', async () => 0, { root, ...FAST, timeoutMs: 1000 }), 0);
    assert.equal(existsSync(broken), false);
  } finally {
    cleanup();
  }
});

test('a lock that vanished is not stale and does not throw', () => {
  const { root, cleanup } = scratch();
  try {
    assert.equal(lockIsStale(join(root, 'no-such.lock'), 1000, Date.now), false);
  } finally {
    cleanup();
  }
});

test('release removes only the lock this handle created, not one another process took after reclaiming it', async () => {
  const { root, cleanup } = scratch();
  try {
    const held = await acquireLane('db', { root, ...FAST });
    const lock = join(root, '.test-locks', 'db.lock');
    rmSync(lock, { recursive: true, force: true }); // reclaimed as stale by somebody else
    mkdirSync(lock);
    writeFileSync(join(lock, 'holder.json'), JSON.stringify({ pid: process.pid, startedAt: Date.now(), token: 'someone-else' }));
    held.release();
    assert.equal(existsSync(lock), true);
  } finally {
    cleanup();
  }
});

test('main takes the command and its arguments verbatim after the lane, with or without a leading separator', async () => {
  const { root, cleanup } = scratch();
  try {
    const script = join(root, 'args.mjs');
    writeFileSync(script, `process.exit(JSON.stringify(process.argv.slice(2)) === '["a","--","b"]' ? 4 : 5);`);
    const options = { root, locale: 'en', log: () => undefined };
    assert.equal(await main(['db', process.execPath, script, 'a', '--', 'b'], options), 4);
    assert.equal(await main(['db', '--', process.execPath, script, 'a', '--', 'b'], options), 4);
    assert.equal(await main(['db', '--'], options), 2);
    assert.equal(await main(['db'], options), 2);
  } finally {
    cleanup();
  }
});
