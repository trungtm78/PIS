import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The offline spool: every batch is written to disk before it is sent and leaves the spool only when the platform has taken it (`sent`) or refused it for good (`rejected`). A machine that loses its link, or is
 * restarted, loses nothing and sends nothing twice: a batch is named by its hash, a batch already sent is never put again, and the platform keys the command by the same name.
 * Writes are atomic (a temporary file renamed over the name), which works the same on Windows, macOS and Linux.
 */
export class Spool {
  constructor(directory) {
    this.directory = directory;
    this.pendingDir = join(directory, 'pending');
    this.sentDir = join(directory, 'sent');
    this.rejectedDir = join(directory, 'rejected');
  }

  #sequence = 0;

  async open() {
    for (const dir of [this.pendingDir, this.sentDir, this.rejectedDir]) await mkdir(dir, { recursive: true });
  }

  async #exists(dir, hash) {
    try {
      await readFile(join(dir, `${hash}.json`));
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }

  async #write(path, value) {
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(value));
    await rename(temporary, path);
  }

  /** Puts a batch in the spool unless it was already sent, rejected or is already waiting. Returns whether it was added. */
  async put(batch) {
    if ((await this.#exists(this.sentDir, batch.hash)) || (await this.#exists(this.rejectedDir, batch.hash)) || (await this.#exists(this.pendingDir, batch.hash))) return false;
    await this.#write(join(this.pendingDir, `${batch.hash}.json`), { batch, attempts: 0, last_error: null, next_attempt_at: null, queued_at: new Date().toISOString(), sequence: this.#sequence++ });
    return true;
  }

  /** The batches that wait, in the order they were queued, each with its state. */
  async pending() {
    const names = (await readdir(this.pendingDir)).filter((name) => name.endsWith('.json'));
    const entries = [];
    for (const name of names) entries.push(JSON.parse(await readFile(join(this.pendingDir, name), 'utf8')));
    return entries.sort((a, b) => (a.queued_at < b.queued_at ? -1 : a.queued_at > b.queued_at ? 1 : a.sequence - b.sequence));
  }

  async fail(hash, error, nextAttemptAt) {
    const path = join(this.pendingDir, `${hash}.json`);
    const entry = JSON.parse(await readFile(path, 'utf8'));
    await this.#write(path, { ...entry, attempts: entry.attempts + 1, last_error: error, next_attempt_at: nextAttemptAt });
  }

  async markSent(hash, receipt) {
    await this.#write(join(this.sentDir, `${hash}.json`), receipt);
    await rm(join(this.pendingDir, `${hash}.json`), { force: true });
  }

  async markRejected(hash, reason) {
    await this.#write(join(this.rejectedDir, `${hash}.json`), reason);
    await rm(join(this.pendingDir, `${hash}.json`), { force: true });
  }

  async counts() {
    const count = async (dir) => (await readdir(dir)).filter((name) => name.endsWith('.json')).length;
    return { pending: await count(this.pendingDir), sent: await count(this.sentDir), rejected: await count(this.rejectedDir) };
  }
}
