import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { feedModule } from '../../src/modules/finance-feed';
import { FeedConnectionController, FeedDifferenceController, FeedImportController, FeedMappingController } from '../../src/modules/finance-feed/feed.controller';
import { FeedReadsController } from '../../src/modules/finance-feed/feed-reads.controller';
import { FileService } from '../../src/modules/files/file.service';
import { FsObjectStorage } from '../../src/modules/files/fs-object-storage';
import { MockScanPort } from '../../src/modules/files/mock-scan';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(240_000);

const SIGNING_KEY = randomBytes(32);
const ADMIN = 1; // every feed permission over the tenant
const CHECKER = 2; // the right to read, approve a mapping and settle a difference
const READER = 3; // fin.feed.read only
const NOBODY = 4;
const B_ADMIN = 1; // of tenant B
const ROOT = 1;
const FAMILY = 0x98;
const FEED_ALL = ['fin.feed.read', 'fin.feed.admin', 'fin.feed.generator', 'fin.feed.preview', 'fin.feed.import', 'fin.feed.push', 'fin.feed.map', 'fin.feed.map.approve', 'fin.feed.reconcile', 'fin.feed.resolve'];
const PROJECT_HEADER = 'feed_project_code,as_of,project_name,sector_code,district_code,investor_code,our_project_code';
const PLAN_HEADER = 'feed_project_code,fiscal_year,fund_code,plan_amount,as_of';
const DISBURSEMENT_HEADER = 'feed_project_code,fiscal_year,month,fund_code,disbursed_month,disbursed_cumulative,reported_on,as_of';
const REASON = 'A reason of enough length.';

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

const shaOf = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const hostOf = (args: unknown[]): string | undefined => {
  const first = args[0];
  if (typeof first === 'object' && first !== null) return (first as { host?: string }).host;
  return typeof first === 'number' ? (typeof args[1] === 'string' ? args[1] : 'localhost') : undefined;
};
const csv = (...lines: string[]): Uint8Array => new TextEncoder().encode(lines.join('\n'));

describe('the feed of the Finance Department (FEED-1, FEED-01 to FEED-05)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let root: string;
  let files: FileService;
  let counter = 0;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: string, url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const audits = (resourceId: string, action: string) => rows<{ safe_diff: Record<string, unknown>; reason: string | null; actor_id: string; outcome: string }>('select safe_diff, reason, actor_id, outcome from machvon.audit_event where resource_id = $1 and action = $2', [resourceId, action]);
  const events = (aggregateId: string, type: string) => rows<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2 order by aggregate_version', [aggregateId, type]);

  async function seedAsAdmin(statements: Array<[string, unknown[]]>): Promise<void> {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      for (const [sql, params] of statements) await client.query(sql, params);
    } finally {
      await client.end();
    }
  }

  async function seedProject(): Promise<{ projectId: string; projectCode: string }> {
    counter += 1;
    const projectId = randomUUID();
    const projectCode = `PRJ-F${counter}-${projectId.slice(0, 4)}`;
    await seedAsAdmin([
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, $3, 'Feed project', $4, $4, $5, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, projectId, projectCode, unitId(ROOT), id(FAMILY, 90)],
      ],
    ]);
    return { projectId, projectCode };
  }

  async function upload(bytes: Uint8Array, tenantId = TENANT_A): Promise<{ key: string; sha: string }> {
    const stored = await files.upload({ tenantId, membershipId: memberId(ADMIN), scopeVersion: 1 }, { purpose: 'import', declaredType: 'text/csv', bytes });
    expect(stored.scanStatus).toBe('CLEAN');
    return { key: stored.key, sha: shaOf(bytes) };
  }

  const request = (kind: string, file: { key: string; sha: string }, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ kind, file_object_key: file.key, file_sha256: file.sha, ...extra });
  const preview = (member: number, kind: string, file: { key: string; sha: string }, extra: Record<string, unknown> = {}): Promise<Reply> => call('POST', '/finance-feed/imports/preview', { member, body: request(kind, file, extra) });
  const apply = (member: number, kind: string, file: { key: string; sha: string }, extra: Record<string, unknown> = {}): Promise<Reply> => call('POST', '/finance-feed/imports', { member, body: request(kind, file, extra) });

  async function uploadDoor(member: number, bytes: Uint8Array): Promise<Reply> {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'text/csv' }), 'export.csv');
    const response = await fetch(`${app.baseUrl}/finance-feed/imports/files`, { method: 'POST', headers: { [TENANT_HEADER]: tokenOf(member), 'idempotency-key': `key-${randomUUID()}` }, body: form });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'machvon-feed-'));
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: ROOT, path: `/${unitId(ROOT)}/` }]);
    for (const n of [ADMIN, CHECKER, READER, NOBODY]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_ADMIN, ROOT);
    await harness.seedRole(TENANT_A, 1, 'FEED_ADMIN', FEED_ALL, 50);
    await harness.seedRole(TENANT_A, 2, 'FEED_CHECKER', ['fin.feed.read', 'fin.feed.map.approve', 'fin.feed.resolve'], 30);
    await harness.seedRole(TENANT_A, 3, 'FEED_READER', ['fin.feed.read'], 20);
    await harness.seedRole(TENANT_B, 1, 'FEED_ADMIN', FEED_ALL, 50);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: ADMIN, role: 1, kind: 'TENANT' },
      { n: 2, member: CHECKER, role: 2, kind: 'TENANT' },
      { n: 3, member: READER, role: 3, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_ADMIN, role: 1, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    files = new FileService({ storage: new FsObjectStorage(root), scanner: new MockScanPort(), urlSecret: randomBytes(32) });
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [FeedConnectionController, FeedImportController, FeedMappingController, FeedDifferenceController, FeedReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: FileService, useValue: files },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
    await rm(root, { recursive: true, force: true });
  }, 60_000);

  it('is registered in the module of FEED', () => {
    for (const controller of [FeedConnectionController, FeedImportController, FeedMappingController, FeedDifferenceController, FeedReadsController]) expect(feedModule.controllers).toContain(controller);
  });

  describe('the connection (FEED-01)', () => {
    it('shows a tenant that never used it as never received, on and with the generator stopped, with the rules and their source, writing nothing to show it', async () => {
      const reader = await call('GET', '/finance-feed/connection', { member: READER });
      expect(reader.status).toBe(200);
      expect(reader.json).toMatchObject({
        connector_code: 'fin.sotaichinh',
        registered: false,
        enabled: true,
        layout_version: 'WORKING-ASSUMPTION-FIN-2026.1',
        acceptance: 'PENDING_EXTERNAL',
        version: 1,
        health: { status: 'NEVER_RECEIVED', age_hours: null, alert: null, rule: { source: 'DEFAULT', unverified: true, legal_status: 'UNVERIFIED', warn_after_hours: 24, max_age_hours: 48 }, policy: { tolerance_pct: 0.5, large_discrepancy_pct: 5, report_due_days: 5 } },
        generator: { state: 'STOPPED', epoch: 0 },
        actions: { set_state: false, control_generator: false, apply: false },
        mapping_counts: { PROPOSED: 0, ACTIVE: 0, REJECTED: 0, RETIRED: 0 },
        alerts: [],
      });
      expect((reader.json.channels as Array<{ channel: string; adapter_status: string; opens_network: boolean }>).map((channel) => [channel.channel, channel.adapter_status, channel.opens_network])).toEqual([['FILE', 'PROPOSED', false], ['API_PUSH', 'MISSING', false], ['GENERATOR', 'MOCK', false]]);
      expect((reader.json.layouts as Array<{ kind: string }>).map((layout) => layout.kind)).toEqual(['PROJECT', 'PLAN', 'DISBURSEMENT', 'MILESTONE']);
      expect(await rows('select 1 from machvon.finance_feed_connection')).toHaveLength(0);
      expect(await call('GET', '/finance-feed/connection', { member: ADMIN })).toMatchObject({ json: { actions: { set_state: true, control_generator: true, apply: true, propose_mapping: true, decide_mapping: true, reconcile: true, resolve: true } } });
    });

    it('is refused to a member without fin.feed.read and never shows another tenant', async () => {
      expect((await call('GET', '/finance-feed/connection', { member: NOBODY })).status).toBe(403);
      expect(await call('GET', '/finance-feed/connection', { member: B_ADMIN, tenantId: TENANT_B })).toMatchObject({ status: 200, json: { registered: false } });
    });

    it('is switched off and on with a reason, audited, announced with ids only, and a stale version is 409', async () => {
      const off = await call('POST', '/finance-feed/connection/state', { member: ADMIN, ifMatch: '"1"', body: { enabled: false, reason: 'Waiting for the official layout of the department' } });
      expect(off.status).toBe(200);
      expect(off.json).toMatchObject({ status: 'DISABLED', resource_version: 2 });
      const connectionId = off.json.resource_id as string;
      const [audit] = await audits(connectionId, 'fin.feed_connection_switched');
      expect(audit).toMatchObject({ outcome: 'SUCCESS', actor_id: memberId(ADMIN), safe_diff: { connector_code: 'fin.sotaichinh', from_enabled: true, to_enabled: false } });
      const [event] = await events(connectionId, 'fin.feed.connection.changed.v1');
      expect(event?.payload).toMatchObject({ tenant_id: TENANT_A, connection_id: connectionId, enabled: false, version: 2 });
      expect(JSON.stringify(event?.payload)).not.toContain('Waiting');
      const stale = await call('POST', '/finance-feed/connection/state', { member: ADMIN, ifMatch: '"1"', body: { enabled: true, reason: 'The layout was confirmed in writing' } });
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      expect((await call('POST', '/finance-feed/connection/state', { member: READER, ifMatch: '"2"', body: { enabled: true, reason: REASON } })).status).toBe(403);
      expect((await call('POST', '/finance-feed/connection/state', { member: ADMIN, ifMatch: '"2"', body: { enabled: true, reason: 'short' } })).status).toBe(422);
      // A file is not taken while the connection is off; a dry run always works.
      const file = await upload(csv(DISBURSEMENT_HEADER, 'F-OFF,2026,1,NSTW,10,10,2026-02-03,2026-02-03'));
      expect((await preview(ADMIN, 'DISBURSEMENT', file)).status).toBe(200);
      const blocked = await apply(ADMIN, 'DISBURSEMENT', file);
      expect([blocked.status, blocked.json.code]).toEqual([409, 'FEED_CONNECTION_DISABLED']);
      const back = await call('POST', '/finance-feed/connection/state', { member: ADMIN, ifMatch: '"2"', body: { enabled: true, reason: 'The layout was confirmed in writing' } });
      expect(back.json).toMatchObject({ status: 'ENABLED', resource_version: 3 });
      expect((await call('GET', '/finance-feed/connection', { member: READER })).json).toMatchObject({ registered: true, enabled: true, version: 3 });
    });
  });

  describe('files, dry run and apply (FEED-02), the push stub, no connection leaves the machine', () => {
    it('reads the door, previews without writing, applies once, says "already applied" for the same file, and opens no connection', async () => {
      const mine = await seedProject();
      const project = csv(PROJECT_HEADER, `F-100,2026-01-10,Road one,GT,D01,CDT-1,${mine.projectCode}`, 'F-101,2026-01-10,Road two,YT,D02,CDT-2,');
      const door = await uploadDoor(ADMIN, project);
      expect(door.status).toBe(200);
      expect(door.json).toMatchObject({ format: 'CSV', row_count: 2, matching_kinds: ['PROJECT'] });
      const file = await upload(project);
      const connect = jest.spyOn(net.Socket.prototype, 'connect');
      const httpRequest = jest.spyOn(http, 'request');
      const httpsRequest = jest.spyOn(https, 'request');
      const seen: unknown[][] = [];
      try {
        const dry = await preview(ADMIN, 'PROJECT', file);
        expect(dry.json).toMatchObject({ status: 'DRY_RUN', kind: 'PROJECT', layout_version: 'WORKING-ASSUMPTION-FIN-2026.1', acceptance: 'PENDING_EXTERNAL', already_applied: false, counts: { total: 2, valid: 2, errors: 0 } });
        expect((dry.json.rows as Array<Record<string, unknown>>).map((row) => row.outcome)).toEqual(['RECORD_AND_PROPOSE', 'RECORD']);
        expect(await rows('select 1 from machvon.finance_feed_record')).toEqual([]);
        const applied = await apply(ADMIN, 'PROJECT', file);
        expect(applied.status).toBe(200);
        expect(applied.json).toMatchObject({ status: 'APPLIED', counts: { total: 2, applied: 2, quarantined: 0 }, mappings_proposed: 1 });
        const runId = applied.json.resource_id as string;
        expect(await rows('select channel, kind, records_written from machvon.finance_feed_run where id = $1::uuid', [runId])).toEqual([{ channel: 'FILE', kind: 'PROJECT', records_written: 2 }]);
        const [importAudit] = await rows<{ safe_diff: Record<string, unknown> }>("select safe_diff from machvon.audit_event where action = 'fin.feed_import_applied' and safe_diff ->> 'run_id' = $1", [runId]);
        expect(importAudit?.safe_diff).toMatchObject({ kind: 'PROJECT', file_sha256: file.sha, records_written: 2, mappings_proposed: 1 });
        expect((await apply(ADMIN, 'PROJECT', file)).json.code).toBe('IMPORT_FILE_ALREADY_APPLIED');
        expect((await preview(ADMIN, 'PROJECT', file)).json).toMatchObject({ already_applied: true });
        const [event] = await events(runId, 'fin.feed.import.applied.v1');
        expect(event?.payload).toMatchObject({ tenant_id: TENANT_A, run_id: runId, kind: 'PROJECT', file_sha256: file.sha, mappings_proposed: 1 });
        const unknown = await preview(ADMIN, 'PROJECT', file, { mapping_version: 'OFFICIAL-1' });
        expect([unknown.status, unknown.json.code]).toEqual([422, 'FEED_LAYOUT_VERSION_UNKNOWN']);
        const push = await call('POST', '/finance-feed/push', { member: ADMIN, body: { kind: 'PROJECT', rows: [{ feed_project_code: 'P-1' }] } });
        expect([push.status, push.json.code]).toEqual([503, 'FEED_API_UNAVAILABLE']);
        expect((await call('POST', '/finance-feed/push', { member: READER, body: { kind: 'PROJECT', rows: [{ feed_project_code: 'P-1' }] } })).status).toBe(403);
        expect((await call('POST', '/finance-feed/imports', { member: CHECKER, body: request('PROJECT', file) })).status).toBe(403);
      } finally {
        seen.push(...(connect.mock.calls as unknown[][]));
        connect.mockRestore();
        httpRequest.mockRestore();
        httpsRequest.mockRestore();
      }
      const outgoing = seen.map(hostOf).filter((host): host is string => host !== undefined);
      expect(seen.length).toBeGreaterThan(0);
      expect(outgoing.filter((host) => !['127.0.0.1', '::1', 'localhost'].includes(host))).toEqual([]);
    });

    it('keeps the sources of the module free of any import of a module that can open a connection and of any call to fetch', async () => {
      const directory = join(__dirname, '..', '..', 'src', 'modules', 'finance-feed');
      for (const name of ['feed.controller.ts', 'feed-reads.controller.ts', 'feed-view.ts']) {
        const source = (await readFile(join(directory, name), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        expect(source).not.toMatch(/from\s+'node:(net|tls|http|https|http2|dns|dgram|child_process|cluster|worker_threads)'/);
        expect(source).not.toMatch(/\bfetch\s*\(/);
      }
      for (const name of ['finance-feed-store.ts', 'finance-feed-mapping-store.ts', 'finance-feed-import.ts', 'finance-feed-reader.ts']) {
        const source = (await readFile(join(__dirname, '..', '..', '..', '..', 'packages', 'db', 'src', name), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
        expect(source).not.toMatch(/from\s+'node:(net|tls|http|https|dns|dgram)'/);
        expect(source).not.toMatch(/\bfetch\s*\(/);
      }
    });
  });

  describe('the data generator (FEED-05) and the facts of the province', () => {
    it('is refused to a reader, starts with a reason and writes the records of a province under a run, and a second start is 409', async () => {
      expect((await call('POST', '/finance-feed/generator', { member: READER, ifMatch: '"3"', body: { action: 'START', reason: REASON } })).status).toBe(403);
      const view = await call('GET', '/finance-feed/connection', { member: READER });
      const version = view.json.version as number;
      const started = await call('POST', '/finance-feed/generator', { member: ADMIN, ifMatch: `"${version}"`, body: { action: 'START', reason: REASON, seed: 11, fiscal_year: 2026, current_month: 9, project_count: 20, late_units: 2, discrepancies: 3 } });
      expect(started.status).toBe(200);
      expect(started.json).toMatchObject({ status: 'RUNNING', generator: { state: 'RUNNING', epoch: 1, current_month: 9, seed: 11 } });
      const written = (started.json.run as { records_written: number }).records_written;
      expect(written).toBeGreaterThan(100);
      const again = await call('POST', '/finance-feed/generator', { member: ADMIN, ifMatch: `"${started.json.resource_version}"`, body: { action: 'START', reason: REASON } });
      expect([again.status, again.json.code]).toEqual([409, 'FEED_GENERATOR_STATE_INVALID']);
      const [audit] = await audits(started.json.resource_id as string, 'fin.feed_generator_moved');
      expect(audit).toMatchObject({ outcome: 'SUCCESS', reason: REASON, safe_diff: { move: 'START', state: 'RUNNING', epoch: 1, seed: 11 } });
      expect(await rows("select channel, count(*)::int as n from machvon.finance_feed_record where channel = 'GENERATOR' group by channel")).toEqual([{ channel: 'GENERATOR', n: written }]);

      const facts = await call('GET', '/finance-feed/facts?fiscal_year=2026&group_by=sector', { member: READER });
      expect(facts.status).toBe(200);
      expect(facts.json).toMatchObject({ fiscal_year: 2026, group_by: 'sector', freshness: { status: expect.any(String) }, acceptance: 'PENDING_EXTERNAL' });
      const groups = facts.json.groups as Array<{ key: string; plan: string; disbursed: string; rate_pct: string | null; channels: string[] }>;
      expect(groups.length).toBeGreaterThan(2);
      expect(groups.every((group) => group.channels.includes('GENERATOR') && /^\d+(\.\d+)?$/.test(group.plan))).toBe(true);
      expect((facts.json.totals as { projects: number }).projects).toBeGreaterThanOrEqual(20);
      const months = await call('GET', '/finance-feed/facts?fiscal_year=2026&group_by=month', { member: READER });
      expect((months.json.groups as unknown[]).length).toBe(12);
      expect((await call('GET', '/finance-feed/facts?group_by=sector', { member: READER })).status).toBe(422);
      expect((await call('GET', '/finance-feed/facts?fiscal_year=2026&group_by=planet', { member: READER })).status).toBe(422);
      const projects = await call('GET', '/finance-feed/projects?fiscal_year=2026&limit=5', { member: READER });
      expect((projects.json.items as unknown[]).length).toBe(5);
      expect(typeof projects.json.next_cursor).toBe('string');
      expect((await call('GET', '/finance-feed/facts?fiscal_year=2026&group_by=sector', { member: B_ADMIN, tenantId: TENANT_B })).json.groups).toEqual([]);

      const quality = await call('GET', '/finance-feed/quality?fiscal_year=2026&month=9', { member: READER });
      expect((quality.json.indicators as Array<{ code: string }>).map((indicator) => indicator.code)).toEqual(['FEED_COMPLETENESS', 'FEED_TIMELINESS', 'FEED_DISCREPANCY_RATE']);
      const runs = await call('GET', '/finance-feed/runs?channel=GENERATOR', { member: READER });
      const run = (runs.json.items as Array<{ id: string; channel: string; seed: number; counts: { written: number } }>)[0];
      expect(run).toMatchObject({ channel: 'GENERATOR', seed: 11, counts: { written } });
      expect((await call('GET', `/finance-feed/runs/${run?.id}`, { member: READER })).json).toMatchObject({ run: { id: run?.id } });

      const tick = await call('POST', '/finance-feed/generator', { member: ADMIN, ifMatch: `"${started.json.resource_version}"`, body: { action: 'TICK', reason: REASON } });
      expect(tick.json).toMatchObject({ generator: { state: 'RUNNING', epoch: 1, current_month: 10 } });
      const added = (tick.json.run as { records_written: number; records_skipped: number }).records_written;
      expect(added).toBeGreaterThan(0);
      expect(added).toBeLessThan(written);
      const stopped = await call('POST', '/finance-feed/generator', { member: ADMIN, ifMatch: `"${tick.json.resource_version}"`, body: { action: 'STOP', reason: REASON } });
      expect(stopped.json).toMatchObject({ status: 'STOPPED', run: null });
      const reseeded = await call('POST', '/finance-feed/generator', { member: ADMIN, ifMatch: `"${stopped.json.resource_version}"`, body: { action: 'RESEED', reason: REASON, seed: 12 } });
      expect(reseeded.json).toMatchObject({ generator: { state: 'STOPPED', epoch: 2, seed: 12 } });
      const history = (await call('GET', '/finance-feed/connection', { member: READER })).json.history as Array<{ action: string }>;
      expect(history.map((event) => event.action).slice(0, 4)).toEqual(['GENERATOR_RESEEDED', 'GENERATOR_STOPPED', 'GENERATOR_TICKED', 'GENERATOR_STARTED']);
    });
  });

  describe('the mapping of the codes (FEED-03) and the differences with our own figures (FEED-04)', () => {
    it('proposes by one person, is approved by another, and a person never approves their own proposal', async () => {
      const mine = await seedProject();
      const bytes = csv(PROJECT_HEADER, 'F-300,2026-01-10,Compared road,GT,D01,CDT-9,');
      const file = await upload(bytes);
      expect((await apply(ADMIN, 'PROJECT', file)).status).toBe(200);
      const bad = await call('POST', '/finance-feed/mappings', { member: ADMIN, body: { our_code: mine.projectCode, external_code: 'NOT-SENT', reason: REASON } });
      expect([bad.status, bad.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      const proposed = await call('POST', '/finance-feed/mappings', { member: ADMIN, body: { our_code: mine.projectCode, external_code: 'F-300', reason: REASON } });
      expect(proposed.status).toBe(200);
      expect(proposed.json).toMatchObject({ status: 'PROPOSED', our_code: mine.projectCode, external_code: 'F-300', can_decide: false });
      const mappingId = proposed.json.id as string;
      const self = await call('POST', `/finance-feed/mappings/${mappingId}/decision`, { member: ADMIN, ifMatch: '"1"', body: { decision: 'APPROVE', reason: REASON } });
      expect([self.status, self.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
      const approved = await call('POST', `/finance-feed/mappings/${mappingId}/decision`, { member: CHECKER, ifMatch: '"1"', body: { decision: 'APPROVE', reason: REASON } });
      expect(approved.json).toMatchObject({ status: 'ACTIVE', resource_version: 2 });
      expect((await events(mappingId, 'fin.feed.mapping.decided.v1'))[0]?.payload).toMatchObject({ status: 'ACTIVE', actor_id: memberId(CHECKER) });
      const listed = await call('GET', '/finance-feed/mappings?q=F-300', { member: READER });
      expect(listed.json).toMatchObject({ counts: { ACTIVE: 1 }, items: [{ external_code: 'F-300', status: 'ACTIVE', can_retire: false }] });
      const unmapped = await call('GET', '/finance-feed/unmapped', { member: READER });
      expect((unmapped.json.items as Array<{ feed_project_code: string }>).map((item) => item.feed_project_code)).not.toContain('F-300');
      const retired = await call('POST', `/finance-feed/mappings/${mappingId}/retire`, { member: ADMIN, ifMatch: '"2"', body: { reason: REASON } });
      expect(retired.json).toMatchObject({ status: 'RETIRED' });
      const again = await call('POST', `/finance-feed/mappings/${mappingId}/retire`, { member: ADMIN, ifMatch: '"3"', body: { reason: REASON } });
      expect([again.status, again.json.code]).toEqual([409, 'FEED_MAPPING_STATE_INVALID']);
    });

    it('compares the mapped project with the Treasury, opens an item with an owner, and only a person who is not a maker settles it', async () => {
      const mine = await seedProject();
      const loads: Array<[string, Uint8Array]> = [
        ['PROJECT', csv(PROJECT_HEADER, `F-400,2026-01-10,Compared again,GT,D01,CDT-9,${mine.projectCode}`)],
        ['PLAN', csv(PLAN_HEADER, 'F-400,2026,NSTW,1000000,2026-01-20')],
        ['DISBURSEMENT', csv(DISBURSEMENT_HEADER, 'F-400,2026,1,NSTW,400000,400000,2026-02-03,2026-02-03')],
      ];
      for (const [kind, bytes] of loads) expect((await apply(ADMIN, kind, await upload(bytes))).status).toBe(200);
      const [mapping] = (await call('GET', '/finance-feed/mappings?status=PROPOSED&q=F-400', { member: READER })).json.items as Array<{ id: string; version: number }>;
      expect((await call('POST', `/finance-feed/mappings/${mapping?.id}/decision`, { member: CHECKER, ifMatch: `"${mapping?.version}"`, body: { decision: 'APPROVE', reason: REASON } })).status).toBe(200);
      await seedAsAdmin([
        [
          `insert into machvon.treasury_transaction (tenant_id, id, project_id, external_id, provider, amount_vnd, confirmed_at, source_hash, source_kind, provider_event_id, direction)
           values ($1, $2, $3, $4, 'TREASURY', 300000, '2026-03-01T03:00:00Z', repeat('d', 64), 'CALLBACK_MOCK', $4, 'PAYMENT')`,
          [TENANT_A, randomUUID(), mine.projectId, `EXT-${randomUUID()}`],
        ],
      ]);
      // The maker of the records is the administrator: as owner he is skipped and named.
      const skipped = await call('POST', '/finance-feed/reconciliations', { member: ADMIN, body: { fiscal_year: 2026 } });
      expect(skipped.json).toMatchObject({ status: 'COMPLETED', skipped_owner_is_maker: ['F-400'], opened: [] });
      const run = await call('POST', '/finance-feed/reconciliations', { member: ADMIN, body: { fiscal_year: 2026, owner_id: memberId(CHECKER) } });
      expect(run.status).toBe(200);
      const opened = run.json.opened as Array<{ id: string; field: string; kind: string; large: boolean; owner_id: string; feed_value: string; our_value: string | null; version: number; can_resolve: boolean }>;
      expect(opened.map((item) => [item.field, item.kind, item.large, item.owner_id, item.feed_value, item.our_value]).sort()).toEqual([
        ['DISBURSED_VS_TREASURY', 'VALUE_MISMATCH', true, memberId(CHECKER), '400000', '300000'],
        ['PLAN_VS_DIS', 'MISSING_OURS', true, memberId(CHECKER), '1000000', null],
      ]);
      expect(await rows('select 1 from machvon.finance_feed_difference where feed_project_code = $1', ['F-400'])).toHaveLength(2);
      const [reconciliationAudit] = await audits(run.json.resource_id as string, 'fin.feed_reconciliation_run');
      expect(reconciliationAudit?.safe_diff).toMatchObject({ fiscal_year: 2026, differences_opened: 2, owner_id: memberId(CHECKER) });
      const item = opened[0];
      const maker = await call('POST', `/finance-feed/differences/${item?.id}/resolution`, { member: ADMIN, ifMatch: `"${item?.version}"`, body: { kind: 'KEEP_OURS', reason: 'Ours is right, checked.' } });
      expect([maker.status, maker.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
      const dispute = await call('POST', `/finance-feed/differences/${item?.id}/resolution`, { member: CHECKER, ifMatch: `"${item?.version}"`, body: { kind: 'DISPUTE', reason: 'The feed is wrong and we say so.' } });
      expect([dispute.status, dispute.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      const done = await call('POST', `/finance-feed/differences/${item?.id}/resolution`, { member: CHECKER, ifMatch: `"${item?.version}"`, body: { kind: 'ACCEPT_FEED', reason: 'The Treasury will catch up.' } });
      expect(done.json).toMatchObject({ status: 'RESOLVED', resource_version: 2 });
      expect((await events(item?.id as string, 'fin.feed.difference.resolved.v1'))[0]?.payload).toMatchObject({ resolution: 'ACCEPT_FEED', actor_id: memberId(CHECKER) });
      const twice = await call('POST', `/finance-feed/differences/${item?.id}/resolution`, { member: CHECKER, ifMatch: '"2"', body: { kind: 'KEEP_OURS', reason: 'Once more with feeling.' } });
      expect([twice.status, twice.json.code]).toEqual([409, 'FEED_DIFFERENCE_STATE_INVALID']);
      const worklist = await call('GET', '/finance-feed/differences?state=OPEN&fiscal_year=2026', { member: CHECKER });
      expect(worklist.json).toMatchObject({ counts: { open: 1, open_large: 1, resolved: 1, figures_compared: expect.any(Number) } });
      expect((worklist.json.items as Array<{ can_resolve: boolean }>)[0]?.can_resolve).toBe(true);
      expect((await call('GET', '/finance-feed/differences', { member: NOBODY })).status).toBe(403);
      expect((await call('GET', '/finance-feed/differences', { member: B_ADMIN, tenantId: TENANT_B })).json.items).toEqual([]);
      const alerts = (await call('GET', '/finance-feed/connection', { member: READER })).json.alerts as Array<{ code: string }>;
      expect(alerts.map((alert) => alert.code)).toContain('FEED_DISCREPANCY_LARGE');
    });
  });
});
