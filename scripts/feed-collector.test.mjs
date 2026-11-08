import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runOnce } from './feed-collector/agent.mjs';
import { batchesOf, sha256Of } from './feed-collector/batch.mjs';
import { createClient } from './feed-collector/client.mjs';
import { credentialsOf, secretKeysIn, validateConfig } from './feed-collector/config.mjs';
import { delimiterOf, readTable } from './feed-collector/csv.mjs';
import { LAYOUT_VERSION, checkLayout, kindOfFile } from './feed-collector/layout.mjs';
import { platformInfo } from './feed-collector/platform.mjs';

// Only fakes: no test here sends anything anywhere. The fake `fetch` answers what the test scripts and records what it was asked.

const PROJECT = 'feed_project_code,as_of,project_name,sector_code,district_code,investor_code\nP-1,2026-01-10,Road one,GT,D01,CDT-1\nP-2,2026-01-10,"Road, two",YT,D02,CDT-2\n';
const DISBURSEMENT = 'feed_project_code;fiscal_year;month;fund_code;disbursed_month;disbursed_cumulative;reported_on;as_of\r\nP-1;2026;1;NSTW;100;100;2026-02-03;2026-02-03\r\n';

const fakeFetch = (script) => {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const answer = script(String(url), init, calls.length);
    if (answer instanceof Error) throw answer;
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  impl.calls = calls;
  return impl;
};

const tokenOr = (handler) => (url, init, n) => (url.endsWith('/oauth/token') ? { body: { access_token: 'T1', expires_in: 300 } } : handler(url, init, n));

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'feed-collector-'));
  const drop = join(root, 'drop');
  await mkdir(drop);
  const config = validateConfig({ source: { type: 'folder', path: drop }, platform: { baseUrl: 'https://platform.invalid' }, stateDir: join(root, 'state'), retryBaseSeconds: 10 }, { FEED_CLIENT_ID: 'collector', FEED_CLIENT_SECRET: 's3cret' });
  const old = new Date(Date.now() - 60_000);
  const put = async (name, text) => {
    await writeFile(join(drop, name), text);
    await utimes(join(drop, name), old, old);
  };
  return { root, drop, config, put, clean: () => rm(root, { recursive: true, force: true }) };
}

const clientOf = (fetchImpl, now) => createClient({ baseUrl: 'https://platform.invalid', tokenUrl: 'https://platform.invalid/oauth/token', clientId: 'collector', clientSecret: 's3cret', fetchImpl, ...(now === undefined ? {} : { now }) });

describe('the reading of an export', () => {
  it('reads a byte order mark, quoted cells with the delimiter in them, CRLF and the three delimiters', () => {
    const table = readTable(new TextEncoder().encode(`﻿${PROJECT}`));
    assert.deepEqual(table.headers.slice(0, 3), ['feed_project_code', 'as_of', 'project_name']);
    assert.equal(table.rows[1][2], 'Road, two');
    assert.equal(delimiterOf(DISBURSEMENT), ';');
    assert.equal(delimiterOf('a\tb\tc\n1\t2\t3'), '\t');
    assert.equal(readTable(new TextEncoder().encode(DISBURSEMENT)).rows[0][4], '100');
    assert.deepEqual(readTable(new TextEncoder().encode('')), { headers: [], rows: [] });
  });

  it('tells the kind by the name or by the only layout the header fits, and judges the layout version and the columns', () => {
    assert.equal(kindOfFile('Disbursement-2026-02.csv', []), 'DISBURSEMENT');
    assert.equal(kindOfFile('export.csv', readTable(new TextEncoder().encode(PROJECT)).headers), 'PROJECT');
    assert.equal(kindOfFile('export.csv', ['a', 'b']), undefined);
    assert.deepEqual(checkLayout('PROJECT', ['feed_project_code', 'as_of'], 'OFFICIAL-1').code, 'LAYOUT_VERSION_UNKNOWN');
    const missing = checkLayout('PLAN', ['Feed Project Code', 'fiscal-year']);
    assert.equal(missing.code, 'IMPORT_SCHEMA_INVALID');
    assert.deepEqual(missing.detail.missing_columns, ['fund_code', 'plan_amount', 'as_of']);
    assert.equal(checkLayout('PROJECT', ['feed_project_code', 'Feed Project Code']).code, 'DUPLICATE_COLUMNS');
    assert.equal(checkLayout('PROJECT', readTable(new TextEncoder().encode(PROJECT)).headers).ok, true);
  });

  it('names a batch by what it is made from: the same file gives the same batches, a changed file others', () => {
    const rows = Array.from({ length: 5 }, (_none, index) => ({ feed_project_code: `P-${index}` }));
    const a = batchesOf({ kind: 'PROJECT', rows, fileSha256: 'a'.repeat(64), maxRows: 2 });
    assert.equal(a.length, 3);
    assert.deepEqual(a.map((batch) => batch.rows.length), [2, 2, 1]);
    assert.deepEqual(batchesOf({ kind: 'PROJECT', rows, fileSha256: 'a'.repeat(64), maxRows: 2 }).map((batch) => batch.hash), a.map((batch) => batch.hash));
    assert.notEqual(batchesOf({ kind: 'PROJECT', rows, fileSha256: 'b'.repeat(64), maxRows: 2 })[0].hash, a[0].hash);
    assert.equal(new Set(a.map((batch) => batch.hash)).size, 3);
    assert.equal(a[0].mapping_version, LAYOUT_VERSION);
  });
});

describe('the configuration', () => {
  it('refuses a secret written in the file and a layout version the platform does not read, and reads the credentials from the environment or a file', async () => {
    assert.deepEqual(secretKeysIn({ platform: { clientSecret: 'x', clientSecretFile: 'path', clientSecretEnv: 'NAME' } }), ['platform.clientSecret']);
    const base = { source: { type: 'folder', path: 'drop' }, platform: { baseUrl: 'https://platform.invalid' } };
    assert.throws(() => validateConfig({ ...base, platform: { ...base.platform, clientSecret: 'x' } }), /secret must not be written/);
    assert.throws(() => validateConfig({ ...base, layoutVersion: 'OFFICIAL-1' }), /not read by the platform/);
    assert.throws(() => validateConfig({ ...base, intervalSeconds: 0 }), /intervalSeconds/);
    assert.throws(() => validateConfig({ source: { type: 'ftp' }, platform: base.platform }), /source.type/);
    const config = validateConfig(base, { FEED_CLIENT_ID: 'id' });
    await assert.rejects(credentialsOf(config), /client secret/);
    assert.deepEqual(await credentialsOf(validateConfig(base, { FEED_CLIENT_ID: 'id', FEED_CLIENT_SECRET: 's' })), { clientId: 'id', clientSecret: 's' });
    const root = await mkdtemp(join(tmpdir(), 'feed-secret-'));
    try {
      await writeFile(join(root, 'secret.txt'), 'from-file\n');
      const withFile = validateConfig({ ...base, platform: { ...base.platform, clientSecretFile: join(root, 'secret.txt') } }, { FEED_CLIENT_ID: 'id' });
      assert.deepEqual(await credentialsOf(withFile), { clientId: 'id', clientSecret: 'from-file' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('says which hardware it runs on and which are supported', () => {
    for (const [platform, arch] of [['linux', 'arm64'], ['linux', 'x64'], ['win32', 'x64'], ['win32', 'arm64'], ['darwin', 'arm64']]) {
      assert.equal(platformInfo({ platform, arch, version: '22.1.0', hostname: 'h', cpus: 4 }).supported, true, `${platform} ${arch}`);
    }
    assert.equal(platformInfo({ platform: 'linux', arch: 'riscv64', version: '22.1.0', hostname: 'h', cpus: 4 }).supported, false);
    const old = platformInfo({ platform: 'linux', arch: 'arm64', version: '18.0.0', hostname: 'h', cpus: 4 });
    assert.deepEqual([old.supported, old.node_ok], [false, false]);
  });
});

describe('the collector end to end, with a fake platform', () => {
  it('takes an export from the drop folder, sends each batch once with its hash as the idempotency key and a bearer token, and takes it in only once', async () => {
    const w = await workspace();
    try {
      await w.put('project-2026.csv', PROJECT);
      await w.put('disbursement.csv', DISBURSEMENT);
      const fetchImpl = fakeFetch(tokenOr(() => ({ body: { status: 'APPLIED' } })));
      const first = await runOnce({ config: w.config, client: clientOf(fetchImpl) });
      assert.deepEqual(first.taken.map((one) => [one.name, one.outcome, one.kind]), [['disbursement.csv', 'SPOOLED', 'DISBURSEMENT'], ['project-2026.csv', 'SPOOLED', 'PROJECT']]);
      assert.equal(first.sending.sent, 2);
      assert.deepEqual(first.counts, { pending: 0, sent: 2, rejected: 0 });
      const pushes = fetchImpl.calls.filter((call) => call.url.endsWith('/finance-feed/push'));
      assert.equal(pushes.length, 2);
      const sent = pushes.map((call) => JSON.parse(call.init.body)).find((body) => body.kind === 'PROJECT');
      assert.equal(sent.kind, 'PROJECT');
      assert.equal(sent.mapping_version, LAYOUT_VERSION);
      assert.deepEqual(sent.rows[1], { feed_project_code: 'P-2', as_of: '2026-01-10', project_name: 'Road, two', sector_code: 'YT', district_code: 'D02', investor_code: 'CDT-2' });
      assert.match(pushes[0].init.headers['idempotency-key'], /^batch-[0-9a-f]{64}$/);
      assert.equal(pushes[0].init.headers.authorization, 'Bearer T1');
      assert.equal(fetchImpl.calls.filter((call) => call.url.endsWith('/oauth/token')).length, 1);
      assert.match(String(fetchImpl.calls[0].init.body), /client_credentials/);

      const second = await runOnce({ config: w.config, client: clientOf(fetchImpl) });
      assert.deepEqual(second.taken.map((one) => one.outcome), ['KNOWN', 'KNOWN']);
      assert.equal(fetchImpl.calls.filter((call) => call.url.endsWith('/finance-feed/push')).length, 2);
      // The same export under another name is the same export.
      await w.put('project-copy.csv', PROJECT);
      assert.equal((await runOnce({ config: w.config, client: clientOf(fetchImpl) })).taken.find((one) => one.name === 'project-copy.csv').outcome, 'KNOWN');
      const beat = JSON.parse(await readFile(join(w.config.stateDir, 'heartbeat.json'), 'utf8'));
      assert.deepEqual(beat.spool, { pending: 0, sent: 2, rejected: 0 });
      assert.equal(beat.collector, 'feed-collector');
      assert.equal(typeof beat.platform.arch, 'string');
    } finally {
      await w.clean();
    }
  });

  it('keeps a batch in the offline spool while the link or the platform is down, tries again later with a growing delay and sends it once when the platform answers', async () => {
    const w = await workspace();
    try {
      await w.put('project.csv', PROJECT);
      let clock = Date.parse('2026-11-08T10:00:00Z');
      const now = () => clock;
      let mode = 'down';
      const fetchImpl = fakeFetch(
        tokenOr(() => {
          if (mode === 'down') return new Error('connect ECONNREFUSED');
          if (mode === 'unavailable') return { status: 503, body: { code: 'FEED_API_UNAVAILABLE' } };
          return { body: { status: 'APPLIED' } };
        }),
      );
      const client = clientOf(fetchImpl, now);
      const config = { ...w.config };
      const offline = await runOnce({ config, client, now, fetchImpl });
      assert.deepEqual(offline.counts, { pending: 1, sent: 0, rejected: 0 });
      assert.equal(offline.sending.last_error.code, 'NETWORK');
      assert.equal(offline.heartbeat.last_error.code, 'NETWORK');
      // Not yet time: it is not tried again at once.
      const callsBefore = fetchImpl.calls.length;
      await runOnce({ config, client, now, fetchImpl });
      assert.equal(fetchImpl.calls.length, callsBefore);
      clock += 11_000;
      mode = 'unavailable';
      const unavailable = await runOnce({ config, client, now, fetchImpl });
      assert.equal(unavailable.sending.last_error.code, 'FEED_API_UNAVAILABLE');
      const [waiting] = await new (await import('./feed-collector/spool.mjs')).Spool(join(config.stateDir, 'spool')).pending();
      assert.equal(waiting.attempts, 2);
      assert.equal(Date.parse(waiting.next_attempt_at) - clock, 20_000);
      clock += 21_000;
      mode = 'up';
      const done = await runOnce({ config, client, now, fetchImpl });
      assert.deepEqual(done.counts, { pending: 0, sent: 1, rejected: 0 });
      assert.equal(fetchImpl.calls.filter((call) => call.url.endsWith('/finance-feed/push')).length, 3);
      const keys = new Set(fetchImpl.calls.filter((call) => call.url.endsWith('/finance-feed/push')).map((call) => call.init.headers['idempotency-key']));
      assert.equal(keys.size, 1);
    } finally {
      await w.clean();
    }
  });

  it('sets a batch aside when the platform refuses it for good, asks for a new token on a 401, and sends a heartbeat when it is configured', async () => {
    const w = await workspace();
    try {
      await w.put('project.csv', PROJECT);
      let tokens = 0;
      let pushes = 0;
      const fetchImpl = fakeFetch((url) => {
        if (url.endsWith('/oauth/token')) {
          tokens += 1;
          return { body: { access_token: `T${tokens}`, expires_in: 300 } };
        }
        if (url.endsWith('/finance-feed/heartbeat')) return { status: 404 };
        pushes += 1;
        return pushes === 1 ? { status: 401 } : { status: 422, body: { code: 'VALIDATION_FAILED' } };
      });
      const config = { ...w.config, platform: { ...w.config.platform, heartbeatUrl: 'https://platform.invalid/finance-feed/heartbeat' } };
      const result = await runOnce({ config, client: clientOf(fetchImpl) });
      assert.equal(tokens, 2);
      assert.deepEqual(result.counts, { pending: 0, sent: 0, rejected: 1 });
      assert.deepEqual(result.remoteHeartbeat, { ok: false, status: 404 });
      const rejected = JSON.parse(await readFile(join(w.config.stateDir, 'spool', 'rejected', (await readdir(join(w.config.stateDir, 'spool', 'rejected')))[0]), 'utf8'));
      assert.deepEqual([rejected.status, rejected.code], [422, 'VALIDATION_FAILED']);
    } finally {
      await w.clean();
    }
  });

  it('does not send an export the platform would refuse as a whole, and leaves a file that is still being written for the next run', async () => {
    const w = await workspace();
    try {
      await w.put('plan.csv', 'feed_project_code,fiscal_year\nP-1,2026\n');
      await w.put('mystery.csv', 'a,b\n1,2\n');
      await w.put('empty-disbursement.csv', DISBURSEMENT.split('\r\n')[0] + '\r\n');
      await writeFile(join(w.drop, 'project-fresh.csv'), PROJECT);
      await w.put('notes.pdf', 'not an export');
      const fetchImpl = fakeFetch(tokenOr(() => ({ body: {} })));
      const result = await runOnce({ config: w.config, client: clientOf(fetchImpl) });
      const by = Object.fromEntries(result.taken.map((one) => [one.name, one]));
      assert.equal(by['plan.csv'].code, 'IMPORT_SCHEMA_INVALID');
      assert.deepEqual(by['plan.csv'].detail.missing_columns, ['fund_code', 'plan_amount', 'as_of']);
      assert.equal(by['mystery.csv'].code, 'KIND_UNKNOWN');
      assert.equal(by['empty-disbursement.csv'].code, 'IMPORT_EMPTY');
      assert.equal(by['project-fresh.csv'].outcome, 'SETTLING');
      assert.equal(by['notes.pdf'], undefined);
      assert.equal(fetchImpl.calls.length, 0);
      assert.deepEqual(result.counts, { pending: 0, sent: 0, rejected: 0 });
      // The source is never written to or emptied.
      assert.equal((await readdir(w.drop)).length, 5);
    } finally {
      await w.clean();
    }
  });

  it('reads the export API of the Finance application the same way', async () => {
    const w = await workspace();
    try {
      const config = { ...w.config, source: { type: 'api', url: 'https://finance.invalid/export', bearerEnv: 'FEED_SOURCE_BEARER' }, env: { ...w.config.env, FEED_SOURCE_BEARER: 'SRC' } };
      const document = [{ kind: 'PROJECT', rows: [{ feed_project_code: 'P-9', as_of: '2026-01-10', project_name: 'From the API', sector_code: 'GT', district_code: 'D01', investor_code: 'C1', unknown_column: 'left out' }] }];
      const fetchImpl = fakeFetch(tokenOr((url) => (url === 'https://finance.invalid/export' ? { body: document } : { body: {} })));
      const result = await runOnce({ config, client: clientOf(fetchImpl), fetchImpl });
      assert.deepEqual(result.taken.map((one) => [one.outcome, one.kind]), [['SPOOLED', 'PROJECT']]);
      const source = fetchImpl.calls.find((call) => call.url === 'https://finance.invalid/export');
      assert.equal(source.init.headers.authorization, 'Bearer SRC');
      const push = JSON.parse(fetchImpl.calls.find((call) => call.url.endsWith('/finance-feed/push')).init.body);
      assert.deepEqual(Object.keys(push.rows[0]).sort(), ['as_of', 'district_code', 'feed_project_code', 'investor_code', 'project_name', 'sector_code']);
      assert.equal((await runOnce({ config, client: clientOf(fetchImpl), fetchImpl })).taken[0].outcome, 'KNOWN');
      const down = fakeFetch((url) => (url === 'https://finance.invalid/export' ? { status: 500 } : { body: {} }));
      assert.deepEqual((await runOnce({ config, client: clientOf(down), fetchImpl: down })).taken, [{ name: 'https://finance.invalid/export', outcome: 'UNAVAILABLE', status: 500 }]);
    } finally {
      await w.clean();
    }
  });
});

describe('the collector is portable and sends nothing by itself', () => {
  it('imports only modules of node and its own files, has no native dependency and no process spawning', async () => {
    const directory = fileURLToPath(new URL('./feed-collector/', import.meta.url));
    for (const name of (await readdir(directory)).filter((file) => file.endsWith('.mjs'))) {
      const source = (await readFile(join(directory, name), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
      assert.deepEqual(imports.filter((specifier) => !specifier.startsWith('./') && !specifier.startsWith('node:')), [], name);
      assert.doesNotMatch(source, /child_process|require\s*\(|\.node['"]|node-gyp|ffi/, name);
    }
  });

  it('sends only through the fetch it is given: with a fake that fails, nothing else leaves', async () => {
    const calls = [];
    const failing = async (url) => {
      calls.push(String(url));
      throw new Error('offline');
    };
    const outcome = await clientOf(failing).push({ hash: sha256Of('x'), kind: 'PROJECT', rows: [], mapping_version: LAYOUT_VERSION });
    assert.deepEqual([outcome.ok, outcome.retry, outcome.code], [false, true, 'NETWORK']);
    assert.deepEqual(calls, ['https://platform.invalid/oauth/token']);
  });
});
