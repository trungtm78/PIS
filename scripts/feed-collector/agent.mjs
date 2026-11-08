import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { batchesOf, sha256Of } from './batch.mjs';
import { readTable } from './csv.mjs';
import { checkLayout, kindOfFile, rowsAsObjects } from './layout.mjs';
import { platformInfo } from './platform.mjs';
import { Spool } from './spool.mjs';

export const COLLECTOR_VERSION = '1.0.0';
const EXPORT_EXTENSIONS = /\.(csv|tsv|txt)$/i;
/** A file changed less than this many seconds ago may still be being written by the Finance application: it waits for the next run. */
export const SETTLE_SECONDS = 5;

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2));
  await rename(temporary, path);
}

/** The ledger of the exports already taken in (by the hash of their bytes): the same export is never taken in twice, whatever its name, and the source is never written to or emptied. */
async function ledgerOf(stateDir) {
  const path = join(stateDir, 'ingested.json');
  const held = await readJson(path, {});
  return { has: (sha) => held[sha] !== undefined, set: async (sha, entry) => { held[sha] = entry; await writeJson(path, held); }, entries: () => ({ ...held }) };
}

/** One export judged and put in the spool as batches. Returns what became of it. */
async function takeIn({ name, bytes, headers, rows, layoutVersion, spool, ledger, now, kindHint }) {
  const sha = sha256Of(bytes);
  if (ledger.has(sha)) return { name, outcome: 'KNOWN' };
  const kind = kindHint ?? kindOfFile(name, headers);
  const verdict = kind === undefined ? { ok: false, code: 'KIND_UNKNOWN', detail: {} } : checkLayout(kind, headers, layoutVersion);
  if (!verdict.ok) {
    await ledger.set(sha, { name, at: new Date(now()).toISOString(), status: 'REJECTED', code: verdict.code, detail: verdict.detail });
    return { name, outcome: 'REJECTED', code: verdict.code, detail: verdict.detail };
  }
  if (rows.length === 0) {
    await ledger.set(sha, { name, at: new Date(now()).toISOString(), status: 'REJECTED', code: 'IMPORT_EMPTY', detail: {} });
    return { name, outcome: 'REJECTED', code: 'IMPORT_EMPTY', detail: {} };
  }
  const batches = batchesOf({ kind, rows: rowsAsObjects(kind, headers, rows), fileSha256: sha, layoutVersion });
  let added = 0;
  for (const batch of batches) if (await spool.put(batch)) added += 1;
  await ledger.set(sha, { name, at: new Date(now()).toISOString(), status: 'SPOOLED', kind, batches: batches.length });
  return { name, outcome: 'SPOOLED', kind, batches: batches.length, added };
}

/** Reads the exports in a drop folder (CSV or TSV, UTF-8, any delimiter of the three). Files still being written are left for the next run. */
export async function ingestFolder({ dir, spool, ledger, layoutVersion, now = () => Date.now() }) {
  const results = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!entry.isFile() || !EXPORT_EXTENSIONS.test(entry.name)) continue;
    const path = join(dir, entry.name);
    const info = await stat(path);
    if (now() - info.mtimeMs < SETTLE_SECONDS * 1000) {
      results.push({ name: entry.name, outcome: 'SETTLING' });
      continue;
    }
    const bytes = new Uint8Array(await readFile(path));
    const table = readTable(bytes);
    results.push(await takeIn({ name: entry.name, bytes, headers: table.headers, rows: table.rows, layoutVersion, spool, ledger, now }));
  }
  return results;
}

/** Reads the export API of the Finance application: a JSON document `{ kind, rows: [{ column: value }] }`, or a list of them. */
export async function ingestApi({ url, bearer, fetchImpl, spool, ledger, layoutVersion, now = () => Date.now() }) {
  const response = await fetchImpl(url, { method: 'GET', headers: bearer === undefined ? {} : { authorization: `Bearer ${bearer}` } });
  if (!response.ok) return [{ name: url, outcome: 'UNAVAILABLE', status: response.status }];
  const bytes = new Uint8Array(await response.arrayBuffer());
  const document = JSON.parse(new TextDecoder().decode(bytes));
  const exports = Array.isArray(document) ? document : [document];
  const results = [];
  for (const [index, one] of exports.entries()) {
    const rowsOf = Array.isArray(one.rows) ? one.rows : [];
    const headers = [...new Set(rowsOf.flatMap((row) => Object.keys(row)))];
    const table = rowsOf.map((row) => headers.map((header) => String(row[header] ?? '')));
    // Each export of the answer is named by the hash of its own bytes, so that a changed export of the same kind is new and an unchanged one is known.
    const part = new TextEncoder().encode(JSON.stringify(one));
    results.push(await takeIn({ name: `${url}#${index}`, bytes: part, headers, rows: table, layoutVersion, spool, ledger, now, kindHint: one.kind }));
  }
  return results;
}

/** Sends the batches that wait, oldest first. A refusal for good sets a batch aside; a transient failure stops the run (the platform or the link is down: no use hammering it) and schedules the next try with a growing delay. */
export async function flush({ spool, client, now = () => Date.now(), retryBaseSeconds = 30, retryMaxSeconds = 3600 }) {
  const summary = { sent: 0, rejected: 0, deferred: 0, last_error: null };
  for (const entry of await spool.pending()) {
    if (entry.next_attempt_at !== null && Date.parse(entry.next_attempt_at) > now()) {
      summary.deferred += 1;
      continue;
    }
    const outcome = await client.push(entry.batch);
    if (outcome.ok) {
      await spool.markSent(entry.batch.hash, { sent_at: new Date(now()).toISOString(), status: outcome.status, kind: entry.batch.kind, rows: entry.batch.rows.length, attempts: entry.attempts + 1 });
      summary.sent += 1;
    } else if (!outcome.retry) {
      await spool.markRejected(entry.batch.hash, { rejected_at: new Date(now()).toISOString(), status: outcome.status, code: outcome.code, kind: entry.batch.kind, rows: entry.batch.rows.length });
      summary.rejected += 1;
    } else {
      const delay = Math.min(retryMaxSeconds, retryBaseSeconds * 2 ** entry.attempts);
      await spool.fail(entry.batch.hash, { status: outcome.status, code: outcome.code ?? null }, new Date(now() + delay * 1000).toISOString());
      summary.deferred += 1;
      summary.last_error = { status: outcome.status, code: outcome.code ?? null };
      break;
    }
  }
  return summary;
}

/** One pass of the collector: take in what the source has, send what waits, write the heartbeat (a file always; to the platform when an address is configured). */
export async function runOnce({ config, client, fetchImpl = globalThis.fetch, now = () => Date.now(), log = () => undefined }) {
  await mkdir(config.stateDir, { recursive: true });
  const spool = new Spool(join(config.stateDir, 'spool'));
  await spool.open();
  const ledger = await ledgerOf(config.stateDir);
  let taken = [];
  let sourceError = null;
  try {
    taken =
      config.source.type === 'folder'
        ? await ingestFolder({ dir: config.source.path, spool, ledger, layoutVersion: config.layoutVersion, now })
        : await ingestApi({ url: config.source.url, bearer: config.env[config.source.bearerEnv], fetchImpl, spool, ledger, layoutVersion: config.layoutVersion, now });
  } catch (error) {
    sourceError = String(error.message ?? error);
    log('source', { error: sourceError });
  }
  const sending = await flush({ spool, client, now, retryBaseSeconds: config.retryBaseSeconds, retryMaxSeconds: config.retryMaxSeconds });
  const counts = await spool.counts();
  const beat = {
    collector: 'feed-collector',
    version: COLLECTOR_VERSION,
    at: new Date(now()).toISOString(),
    platform: platformInfo(),
    source: config.source.type,
    layout_version: config.layoutVersion,
    spool: counts,
    last_error: sourceError !== null ? { source: sourceError } : sending.last_error,
  };
  await writeJson(join(config.stateDir, 'heartbeat.json'), beat);
  let remote = null;
  if (config.platform.heartbeatUrl !== null) remote = await client.heartbeat(config.platform.heartbeatUrl, beat);
  log('run', { taken: taken.length, ...sending, ...counts });
  return { taken, sending, counts, heartbeat: beat, remoteHeartbeat: remote };
}
