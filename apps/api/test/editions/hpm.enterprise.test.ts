import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { registerEnterpriseIntegrationRules } from '@machvon/edition-enterprise/src/server.ts';
import { HpmFileWriter, ReportStoreIssuedReports, hpmPackageName } from '@machvon/edition-enterprise/src/server.ts';
import type { PeriodReopenPort } from '@machvon/edition-enterprise/src/server.ts';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { hpmModule } from '../../src/editions/enterprise';
import { HpmCorrectionController, HpmPushController, HpmReadsController } from '../../src/editions/enterprise/hpm.controller';
import { HPM_ISSUED_REPORTS, HPM_PERIOD_REOPEN, HPM_PORT } from '../../src/editions/enterprise/tokens';
import { FileService } from '../../src/modules/files/file.service';
import { FsObjectStorage } from '../../src/modules/files/fs-object-storage';
import { MockScanPort } from '../../src/modules/files/mock-scan';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

/**
 * The push of the issued reports to HPM through the application the enterprise edition mounts (ENT-2, R8, R17, R18). The name of this file ends in `.enterprise.test.ts`: it is one of the few sources that may name the
 * enterprise package. The adapter is the file writer with a sink in memory; no call goes anywhere (the sockets are watched).
 */
jest.setTimeout(300_000);

const SIGNING_KEY = randomBytes(32);
const ADMIN = 1; // every HPM permission over the tenant
const PUSHER = 2; // hpm.read, hpm.push
const RECEIVER = 3; // hpm.read, hpm.receipt
const PROPOSER = 4; // hpm.read, hpm.correction.propose
const DECIDER = 5; // hpm.read, hpm.correction.decide
const READER = 6; // hpm.read
const UNIT_ADMIN = 7; // every HPM permission over the unit tree of the department only
const NOBODY = 8;
const B_ADMIN = 1; // of tenant B
const ROOT = 1;
const DEPARTMENT = 2;
const HPM_ALL = ['hpm.read', 'hpm.admin', 'hpm.push', 'hpm.receipt', 'hpm.correction.propose', 'hpm.correction.decide'];
const LAYOUT = 'HPM-MONTHLY';

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

const shaOf = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const csv = (text: string): Uint8Array => new TextEncoder().encode(`code,value\n${text}\n`);

describe('the push of the issued reports to HPM (ENT-2, HPM-01, HPM-02)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let root: string;
  let files: FileService;
  let counter = 0;
  /** What the sink received, by package name; `failNext` makes the next writes fail (a disk that is full). */
  const written: Array<{ tenantId: string; name: string; bytes: Uint8Array }> = [];
  let failNext = 0;
  /** The reopenings of DIS that are in force, by id, with the report period each one reopens: another period is another answer. */
  const reopened = new Map<string, string>();
  const reopen: PeriodReopenPort = { status: (_tx, id, period) => Promise.resolve(!reopened.has(id) ? 'MISSING' : reopened.get(id) === period ? 'OPEN' : 'OTHER_PERIOD') };

  /** The name of the package the file writer gives a push of the root organisation (the tag of the organisation is part of it). */
  const packageName = (period: string, revision: number): string => hpmPackageName({ orgId: TENANT_A, layoutCode: LAYOUT, period, revision });

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: string, url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const audits = (resourceId: string, action: string) => rows<{ safe_diff: Record<string, unknown>; reason: string | null; actor_id: string }>('select safe_diff, reason, actor_id from machvon.audit_event where resource_id = $1 and action = $2', [resourceId, action]);
  const events = (aggregateId: string, type: string) => rows<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2 order by aggregate_version', [aggregateId, type]);

  /** A report put through the shared pipeline the way an issued copy is stored: the answer names the key and the hash. */
  async function report(content = `row-${(counter += 1)}`, tenantId = TENANT_A): Promise<{ key: string; sha: string }> {
    const bytes = csv(content);
    const stored = await files.upload({ tenantId, membershipId: memberId(ADMIN), scopeVersion: 1 }, { purpose: 'report_export', declaredType: 'text/csv', bytes });
    expect(stored.scanStatus).toBe('CLEAN');
    return { key: stored.key, sha: shaOf(bytes) };
  }

  const pushBody = (file: { key: string; sha: string }, period: string, revision: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ layout_code: LAYOUT, period, revision, sha256: file.sha, file_object_key: file.key, ...extra });
  const push = (member: number, file: { key: string; sha: string }, period: string, revision: number, extra: Record<string, unknown> = {}, key?: string): Promise<Reply> =>
    call('POST', '/hpm/pushes', { member, body: pushBody(file, period, revision, extra), ...(key === undefined ? {} : { key }) });
  /** The newest push of a period as the log shows it now (its version moves with every attempt and receipt). */
  const latest = async (period: string): Promise<{ id: string; version: number }> => {
    const listed = await call('GET', `/hpm/pushes?period=${period}`, { member: ADMIN });
    return (listed.json.items as Array<{ id: string; version: number }>)[0] as { id: string; version: number };
  };
  const pushOf = (reply: Reply): Record<string, unknown> => reply.json.push as Record<string, unknown>;
  const receipt = (member: number, pushId: string, version: number | string, body: Record<string, unknown>): Promise<Reply> => call('POST', `/hpm/pushes/${pushId}/receipt`, { member, ifMatch: `"${version}"`, body });
  const retry = (member: number, pushId: string, version: number | string): Promise<Reply> => call('POST', `/hpm/pushes/${pushId}/retry`, { member, ifMatch: `"${version}"`, body: {} });
  const propose = (member: number, period: string, fromRevision: number, reopenId: string): Promise<Reply> =>
    call('POST', '/hpm/corrections', { member, body: { layout_code: LAYOUT, period, from_revision: fromRevision, period_reopen_id: reopenId, reason: 'A late invoice changed the executed value of the month' } });
  const decide = (member: number, correctionId: string, version: number | string, decision: string, reason = 'The invoice and the reopening are in order'): Promise<Reply> =>
    call('POST', `/hpm/corrections/${correctionId}/decision`, { member, ifMatch: `"${version}"`, body: { decision, reason } });

  /** Pushes a report and has the receiver accept it: the period then stands as accepted. */
  async function accepted(period: string, revision: number, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const sent = await push(PUSHER, await report(), period, revision, extra);
    expect(sent.status).toBe(200);
    const row = pushOf(sent);
    const done = await receipt(RECEIVER, row.id as string, row.version as number, { outcome: 'ACCEPTED', reference: `HPM-${period}-${revision}` });
    expect(done.status).toBe(200);
    return row;
  }

  beforeAll(async () => {
    // The process of the enterprise edition registers its rules and alert types when it loads (load-enterprise.ts).
    registerEnterpriseIntegrationRules();
    root = await mkdtemp(join(tmpdir(), 'machvon-hpm-'));
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
      ]);
    }
    for (const n of [ADMIN, PUSHER, RECEIVER, PROPOSER, DECIDER, READER, UNIT_ADMIN, NOBODY]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_ADMIN, ROOT);
    await harness.seedRole(TENANT_A, 1, 'HPM_ADMIN', HPM_ALL, 50);
    await harness.seedRole(TENANT_A, 2, 'HPM_PUSHER', ['hpm.read', 'hpm.push'], 30);
    await harness.seedRole(TENANT_A, 3, 'HPM_RECEIVER', ['hpm.read', 'hpm.receipt'], 30);
    await harness.seedRole(TENANT_A, 4, 'HPM_PROPOSER', ['hpm.read', 'hpm.correction.propose'], 30);
    await harness.seedRole(TENANT_A, 5, 'HPM_DECIDER', ['hpm.read', 'hpm.correction.decide'], 30);
    await harness.seedRole(TENANT_A, 6, 'HPM_READER', ['hpm.read'], 20);
    await harness.seedRole(TENANT_B, 1, 'HPM_ADMIN', HPM_ALL, 50);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: ADMIN, role: 1, kind: 'TENANT' },
      { n: 2, member: PUSHER, role: 2, kind: 'TENANT' },
      { n: 3, member: RECEIVER, role: 3, kind: 'TENANT' },
      { n: 4, member: PROPOSER, role: 4, kind: 'TENANT' },
      { n: 5, member: DECIDER, role: 5, kind: 'TENANT' },
      { n: 6, member: READER, role: 6, kind: 'TENANT' },
      { n: 7, member: UNIT_ADMIN, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_ADMIN, role: 1, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    files = new FileService({ storage: new FsObjectStorage(root), scanner: new MockScanPort(), urlSecret: randomBytes(32) });
    const writer = new HpmFileWriter((tenantId, name, bytes) => {
      if (failNext > 0) {
        failNext -= 1;
        return Promise.reject(new Error('the disk is full at /secret/path'));
      }
      written.push({ tenantId, name, bytes });
      return Promise.resolve(`${tenantId}/${name}`);
    });
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [HpmReadsController, HpmPushController, HpmCorrectionController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: FileService, useValue: files },
        { provide: HPM_PORT, useValue: writer },
        { provide: HPM_PERIOD_REOPEN, useValue: reopen },
        { provide: HPM_ISSUED_REPORTS, useValue: new ReportStoreIssuedReports() },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
    await rm(root, { recursive: true, force: true });
  }, 60_000);

  it('is a module of the enterprise edition only, with its controllers', () => {
    expect(hpmModule.editions).toEqual(['enterprise']);
    for (const controller of [HpmReadsController, HpmPushController, HpmCorrectionController]) expect(hpmModule.controllers).toContain(controller);
  });

  describe('getHpmConnection (HPM-01)', () => {
    it('shows a tenant that never pushed as never pushed, on, PROPOSED and PENDING-EXTERNAL, with what HPM owes us and the numbers with their source, writing nothing to show it', async () => {
      const reader = await call('GET', '/hpm/connection', { member: READER });
      expect(reader.status).toBe(200);
      expect(reader.json).toMatchObject({
        connector_code: 'hpm.reports',
        mode: 'FILE_EXPORT',
        adapter_status: 'PROPOSED',
        registry_status: 'Draft',
        registered: false,
        enabled: true,
        package_format: 'HPM-FILE-WORKING-ASSUMPTION-2026.1',
        acceptance: 'PENDING_EXTERNAL',
        version: 1,
        api_adapter: { status: 'MISSING', reason: 'HPM_INTERFACE_PENDING' },
        health: { status: 'NEVER_PUSHED', age_hours: null, last_delivery_at: null, failed_pushes: 0, awaiting_receipt: 0, alert: null, push_blocked: false, rule: { source: 'DEFAULT', unverified: true, legal_status: 'UNVERIFIED', max_attempts: 5, warn_after_hours: 720, max_age_hours: 1080, stale_severity: 'ACTION' } },
        counts: { pushes: 0, written: 0, accepted: 0, failed: 0, rejected: 0 },
        actions: { may_switch: false, may_push: false, may_record_receipt: false, may_propose_correction: false, may_decide_correction: false },
      });
      expect((reader.json.pending_external as Array<{ code: string }>).map((item) => item.code)).toEqual(['HPM_INTERFACE']);
      expect(await rows('select 1 from machvon.ent_connection')).toHaveLength(0);
      const admin = await call('GET', '/hpm/connection', { member: ADMIN });
      expect(admin.json).toMatchObject({ actions: { may_switch: true, may_push: true, may_record_receipt: true, may_propose_correction: true, may_decide_correction: true } });
      const unit = await call('GET', '/hpm/connection', { member: UNIT_ADMIN });
      expect(unit.json).toMatchObject({ actions: { may_switch: false, may_push: false } });
    });

    it('is refused to a member without hpm.read and never shows another tenant', async () => {
      expect((await call('GET', '/hpm/connection', { member: NOBODY })).status).toBe(403);
      expect(await call('GET', '/hpm/connection', { member: B_ADMIN, tenantId: TENANT_B })).toMatchObject({ status: 200, json: { registered: false } });
    });
  });

  describe('submitHpmPush (HPM-01): the key, the package, the ledger', () => {
    it('writes the package once under the key (organisation, layout, period, revision), keeps the hash, the attempt and the answer of the adapter, audits it and announces it with ids and hashes only', async () => {
      const file = await report('executed,100');
      const sent = await push(PUSHER, file, '2026-M10', 1, { snapshot: { snapshot_id: randomUUID(), revision: 2, cutoff: '2026-10-31' } });
      expect(sent.status).toBe(200);
      expect(sent.json).toMatchObject({ status: 'SENT', resource_version: 2 });
      const row = pushOf(sent);
      expect(row).toMatchObject({
        key: `${TENANT_A}|${LAYOUT}|2026-M10|r1`,
        org_unit_id: TENANT_A,
        layout_code: LAYOUT,
        period: '2026-M10',
        revision: 1,
        sha256: file.sha,
        status: 'WRITTEN',
        attempts: 1,
        last_error_code: null,
        overwrites: false,
        acceptance: 'PENDING_EXTERNAL',
        pushed_by: memberId(PUSHER),
        receipt: null,
        response: { mode: 'FILE', receiver: 'AWAITING_RECEIPT', acceptance: 'PENDING_EXTERNAL', package_name: packageName('2026-M10', 1) },
        actions: { may_retry: true, may_record_receipt: false },
      });
      expect((row.attempt_log as Array<{ attempt_no: number; outcome: string }>).map((attempt) => [attempt.attempt_no, attempt.outcome])).toEqual([[1, 'WRITTEN']]);
      // The package carries the report byte for byte and the key.
      const package_ = written.find((entry) => entry.name === packageName('2026-M10', 1));
      expect(package_?.tenantId).toBe(TENANT_A);
      const unpacked = unzipSync(package_?.bytes as Uint8Array);
      const manifest = JSON.parse(strFromU8(unpacked['manifest.json'] as Uint8Array)) as Record<string, unknown>;
      expect(manifest).toMatchObject({ key: row.key, revision: 1, report_sha256: file.sha, acceptance: 'PENDING_EXTERNAL', snapshot: { revision: 2, cutoff: '2026-10-31' } });
      expect(strFromU8(unpacked[`report/${LAYOUT}_2026-M10_r1.csv`] as Uint8Array)).toBe('code,value\nexecuted,100\n');
      expect(row.response).toMatchObject({ package_sha256: shaOf(package_?.bytes as Uint8Array) });

      const [audit] = await audits(row.id as string, 'hpm.push_submitted');
      expect(audit).toMatchObject({ actor_id: memberId(PUSHER), safe_diff: { key: row.key, outcome: 'SENT', status: 'WRITTEN', attempts: 1, sha256: file.sha, acceptance: 'PENDING_EXTERNAL' } });
      const [event] = await events(row.id as string, 'hpm.push.sent.v1');
      expect(event?.payload).toMatchObject({ tenant_id: TENANT_A, push_id: row.id, key: row.key, outcome: 'SENT', attempts: 1, sha256: file.sha, actor_id: memberId(PUSHER) });
      expect(JSON.stringify(event?.payload)).not.toContain('executed,100');
    });

    it('answers ALREADY_DELIVERED to the same push again without a new attempt, a new row or a new package', async () => {
      const file = await report('same,bytes');
      const first = await push(PUSHER, file, '2026-M09', 1);
      const packages = written.length;
      const again = await push(PUSHER, file, '2026-M09', 1);
      expect(again.status).toBe(200);
      expect(again.json).toMatchObject({ status: 'ALREADY_DELIVERED', resource_id: pushOf(first).id });
      expect(pushOf(again)).toMatchObject({ attempts: 1, status: 'WRITTEN' });
      expect(written.length).toBe(packages);
      expect(await rows('select 1 from machvon.hpm_push where period = $1', ['2026-M09'])).toHaveLength(1);
      expect(await rows('select 1 from machvon.hpm_push_attempt a join machvon.hpm_push p on p.id = a.push_id where p.period = $1', ['2026-M09'])).toHaveLength(1);
    });

    it('refuses the same key with other content (409 HPM_KEY_REUSED) and writes nothing', async () => {
      const before = written.length;
      const other = await report('other,bytes');
      const refused = await push(PUSHER, other, '2026-M10', 1);
      expect(refused.status).toBe(409);
      expect(refused.json.code).toBe('HPM_KEY_REUSED');
      expect(written.length).toBe(before);
    });

    it('answers a repeated Idempotency-Key with the stored answer', async () => {
      const file = await report('keyed,bytes');
      const key = `key-${randomUUID()}`;
      const first = await push(PUSHER, file, '2026-M08', 1, {}, key);
      const second = await push(PUSHER, file, '2026-M08', 1, {}, key);
      expect(second.status).toBe(200);
      expect(second.json.resource_id).toBe(first.json.resource_id);
      expect(await rows('select 1 from machvon.hpm_push where period = $1', ['2026-M08'])).toHaveLength(1);
    });

    it('records a failed delivery and answers it, then re-sends the same key with the next attempt number and never makes a second row', async () => {
      const file = await report('flaky,bytes');
      failNext = 1;
      const failed = await push(PUSHER, file, '2026-M07', 1);
      expect(failed.status).toBe(200);
      expect(failed.json).toMatchObject({ status: 'FAILED' });
      const row = pushOf(failed);
      expect(row).toMatchObject({ status: 'FAILED', attempts: 1, last_error_code: 'HPM_DELIVERY_FAILED', actions: { may_retry: true } });
      // What the adapter said about its disk never reaches the log or the answer.
      expect(JSON.stringify(failed.json)).not.toContain('/secret/path');
      const health = await call('GET', '/hpm/connection', { member: READER });
      expect(health.json).toMatchObject({ health: { failed_pushes: 1, alert: { code: 'HPM_PUSH_FAILED', severity: 'ACTION' } } });

      const retried = await retry(PUSHER, row.id as string, row.version as number);
      expect(retried.status).toBe(200);
      expect(retried.json).toMatchObject({ status: 'SENT', resource_id: row.id });
      expect(pushOf(retried)).toMatchObject({ key: row.key, status: 'WRITTEN', attempts: 2, last_error_code: null });
      expect((pushOf(retried).attempt_log as Array<{ attempt_no: number; outcome: string; error_code: string | null }>).map((attempt) => [attempt.attempt_no, attempt.outcome, attempt.error_code])).toEqual([[2, 'WRITTEN', null], [1, 'FAILED', 'HPM_DELIVERY_FAILED']]);
      expect(await rows('select 1 from machvon.hpm_push where period = $1', ['2026-M07'])).toHaveLength(1);
      // The re-sent package carries the same key as the first try.
      const resent = written.filter((entry) => entry.name === packageName('2026-M07', 1));
      expect(resent).toHaveLength(1);
      expect(JSON.parse(strFromU8(unzipSync(resent[0]?.bytes as Uint8Array)['manifest.json'] as Uint8Array))).toMatchObject({ key: row.key, attempt: 2 });
      expect((await call('GET', '/hpm/connection', { member: READER })).json).toMatchObject({ health: { failed_pushes: 0, alert: null } });
    });

    it('stops retrying at the cap of the rule (409 HPM_RETRY_EXHAUSTED)', async () => {
      const file = await report('cap,bytes');
      failNext = 6;
      const first = await push(PUSHER, file, '2026-M06', 1);
      let row = pushOf(first);
      for (let attempt = 2; attempt <= 5; attempt += 1) {
        const next = await retry(PUSHER, row.id as string, row.version as number);
        expect(next.status).toBe(200);
        row = pushOf(next);
        expect(row).toMatchObject({ status: 'FAILED', attempts: attempt });
      }
      const over = await retry(PUSHER, row.id as string, row.version as number);
      expect(over.status).toBe(409);
      expect(over.json.code).toBe('HPM_RETRY_EXHAUSTED');
      failNext = 0;
    });

    it('refuses a retry with a stale version and a retry of a push that is not failed or written', async () => {
      const file = await report('versions,bytes');
      failNext = 1;
      const failed = pushOf(await push(PUSHER, file, '2026-M05', 1));
      expect((await retry(PUSHER, failed.id as string, 99)).status).toBe(409);
      expect(((await retry(PUSHER, failed.id as string, 99)).json as { code: string }).code).toBe('VERSION_CONFLICT');
      const done = await accepted('2026-M04', 1);
      const refused = await retry(PUSHER, done.id as string, (await latest('2026-M04')).version);
      expect(refused.status).toBe(409);
      expect(refused.json.code).toBe('HPM_PUSH_STATE_INVALID');
    });
  });

  describe('the order of the revisions (R17)', () => {
    it('refuses a copy older than the newest copy of the series: 409 REPORT_OUT_OF_DATE naming the current revision', async () => {
      const second = await push(PUSHER, await report('rev,two'), '2026-M03', 2);
      expect(second.status).toBe(200);
      const first = await push(PUSHER, await report('rev,one'), '2026-M03', 1);
      expect(first.status).toBe(409);
      expect(first.json).toMatchObject({ code: 'REPORT_OUT_OF_DATE', current_revision: 2 });
      expect(await rows('select 1 from machvon.hpm_push where period = $1', ['2026-M03'])).toHaveLength(1);
    });

    it('does not let a newer revision replace an accepted period without a reopened period and an approved correction, and names what is missing', async () => {
      await accepted('2026-M02', 1);
      const refused = await push(PUSHER, await report('rev,two,m02'), '2026-M02', 2);
      expect(refused.status).toBe(409);
      expect(refused.json).toMatchObject({ code: 'HPM_OVERWRITE_NOT_AUTHORISED', missing: ['PERIOD_REOPENED', 'APPROVED_CORRECTION'], accepted_revision: 1 });
      expect(await rows('select 1 from machvon.hpm_push where period = $1 and revision = 2', ['2026-M02'])).toHaveLength(0);
    });

    it('lets a newer revision replace an accepted period with the reopening and a correction approved by another person, uses the correction once, and refuses an older copy afterwards', async () => {
      const original = await report('rev,one,m01');
      const first = pushOf(await push(PUSHER, original, '2026-M01', 1));
      expect((await receipt(RECEIVER, first.id as string, first.version as number, { outcome: 'ACCEPTED', reference: 'HPM-M01-1' })).status).toBe(200);
      const reopenId = randomUUID();
      // The reopening is not in force yet: nothing can be proposed.
      const early = await propose(PROPOSER, '2026-M01', 1, reopenId);
      expect(early.status).toBe(409);
      expect(early.json).toMatchObject({ code: 'HPM_OVERWRITE_NOT_AUTHORISED', missing: ['PERIOD_REOPENED'] });
      reopened.set(reopenId, '2026-M01');
      const proposed = await propose(PROPOSER, '2026-M01', 1, reopenId);
      expect(proposed.status).toBe(200);
      expect(proposed.json).toMatchObject({ state: 'PROPOSED', from_revision: 1, period_reopen_id: reopenId, proposed_by: memberId(PROPOSER), actions: { may_decide: false } });
      const correctionId = proposed.json.id as string;
      const [proposedAudit] = await audits(correctionId, 'hpm.correction_proposed');
      expect(proposedAudit).toMatchObject({ actor_id: memberId(PROPOSER), reason: 'A late invoice changed the executed value of the month' });
      // One proposal at a time for a revision.
      expect((await propose(PROPOSER, '2026-M01', 1, reopenId)).json.code).toBe('HPM_CORRECTION_STATE_INVALID');
      // The proposer does not approve their own proposal.
      const own = await decide(PROPOSER, correctionId, 1, 'APPROVE');
      expect(own.status).toBe(403);
      // Not approved yet: still refused, now only the correction is missing.
      const waiting = await push(PUSHER, await report('rev,two,m01'), '2026-M01', 2, { correction_id: correctionId });
      expect(waiting.status).toBe(409);
      expect(waiting.json).toMatchObject({ code: 'HPM_OVERWRITE_NOT_AUTHORISED', missing: ['APPROVED_CORRECTION'] });
      const approved = await decide(DECIDER, correctionId, 1, 'APPROVE');
      expect(approved.status).toBe(200);
      expect(approved.json).toMatchObject({ status: 'APPROVED', resource_version: 2 });
      const [decidedAudit] = await audits(correctionId, 'hpm.correction_approved');
      expect(decidedAudit).toMatchObject({ actor_id: memberId(DECIDER), safe_diff: { state: 'APPROVED', proposed_by: memberId(PROPOSER) } });

      const replacement = await report('rev,two,m01');
      const sent = await push(PUSHER, replacement, '2026-M01', 2, { correction_id: correctionId });
      expect(sent.status).toBe(200);
      expect(pushOf(sent)).toMatchObject({ status: 'WRITTEN', revision: 2, overwrites: true, correction_id: correctionId });
      const consumed = await rows<{ state: string; consumed_by_push_id: string }>('select state, consumed_by_push_id from machvon.hpm_correction where id = $1', [correctionId]);
      expect(consumed[0]).toMatchObject({ state: 'CONSUMED', consumed_by_push_id: pushOf(sent).id });
      expect(await audits(correctionId, 'hpm.correction_consumed')).toHaveLength(1);
      // The correction is used once: another revision cannot use it.
      expect((await push(PUSHER, await report('rev,three,m01'), '2026-M01', 3, { correction_id: correctionId })).json.code).toBe('HPM_OVERWRITE_NOT_AUTHORISED');
      // Once the window of the reopening is over, a retry of the push that used the correction still re-sends the same key.
      reopened.delete(reopenId);
      failNext = 0;
      const again = await retry(PUSHER, pushOf(sent).id as string, pushOf(sent).version as number);
      expect(again.status).toBe(200);
      expect(again.json).toMatchObject({ status: 'SENT' });
      expect(pushOf(again).attempts).toBe(2);
      // The receiver accepts revision 2; revision 1 is now older than what it holds.
      const second = await receipt(RECEIVER, pushOf(sent).id as string, pushOf(again).version as number, { outcome: 'ACCEPTED', reference: 'HPM-M01-2' });
      expect(second.status).toBe(200);
      const stale = await call('POST', '/hpm/pushes', { member: PUSHER, body: pushBody(original, '2026-M01', 1) });
      expect(stale.status).toBe(409);
      expect(stale.json).toMatchObject({ code: 'REPORT_OUT_OF_DATE', current_revision: 2 });
    });

    it('lets the decider reject a correction and refuses a decision on one that was decided', async () => {
      await accepted('2025-M12', 1);
      const reopenId = randomUUID();
      reopened.set(reopenId, '2025-M12');
      const proposed = await propose(PROPOSER, '2025-M12', 1, reopenId);
      const rejected = await decide(DECIDER, proposed.json.id as string, 1, 'REJECT', 'The period stays as it was accepted');
      expect(rejected.status).toBe(200);
      expect(rejected.json.status).toBe('REJECTED');
      const again = await decide(DECIDER, proposed.json.id as string, 2, 'APPROVE');
      expect(again.status).toBe(409);
      expect(again.json.code).toBe('HPM_CORRECTION_STATE_INVALID');
      const listed = await call('GET', '/hpm/corrections?state=REJECTED', { member: ADMIN });
      expect((listed.json.items as Array<{ id: string }>).map((item) => item.id)).toContain(proposed.json.id);
    });

    it('does not take the reopening of another period for the reopening of the period of the report: October reopened does not let a correction of September be proposed, approved or used', async () => {
      await accepted('2024-M09', 1);
      const reopenId = randomUUID();
      reopened.set(reopenId, '2024-M10');
      const refused = await propose(PROPOSER, '2024-M09', 1, reopenId);
      expect(refused.status).toBe(409);
      expect(refused.json).toMatchObject({ code: 'HPM_OVERWRITE_NOT_AUTHORISED', missing: ['PERIOD_REOPENED'] });
      // Proposed while the reopening was right; the reopening then moved away from the period: the approval and the push both say the period is not reopened.
      reopened.set(reopenId, '2024-M09');
      const proposed = await propose(PROPOSER, '2024-M09', 1, reopenId);
      expect(proposed.status).toBe(200);
      reopened.set(reopenId, '2024-M10');
      const approval = await decide(DECIDER, proposed.json.id as string, 1, 'APPROVE');
      expect(approval.status).toBe(409);
      expect(approval.json).toMatchObject({ code: 'HPM_OVERWRITE_NOT_AUTHORISED', missing: ['PERIOD_REOPENED'] });
      const replacement = await push(PUSHER, await report('rev,two,m0924'), '2024-M09', 2, { correction_id: proposed.json.id });
      expect(replacement.status).toBe(409);
      expect(replacement.json).toMatchObject({ code: 'HPM_OVERWRITE_NOT_AUTHORISED', missing: expect.arrayContaining(['PERIOD_REOPENED']) });
    });

    it('refuses a correction for a revision the receiver never accepted', async () => {
      await push(PUSHER, await report('written,only'), '2025-M11', 1);
      const reopenId = randomUUID();
      reopened.set(reopenId, '2025-M11');
      expect((await propose(PROPOSER, '2025-M11', 1, reopenId)).status).toBe(404);
    });
  });

  describe('recordHpmReceipt (HPM-01)', () => {
    it('is recorded by somebody other than the pusher and accepts the package, audited and announced', async () => {
      const sent = pushOf(await push(ADMIN, await report('receipt,ok'), '2025-M10', 1));
      // The administrator holds both rights and still does not record the receipt of a push of their own.
      const own = await receipt(ADMIN, sent.id as string, sent.version as number, { outcome: 'ACCEPTED', reference: 'HPM-1' });
      expect(own.status).toBe(403);
      expect(own.json.code).toBe('SELF_APPROVAL_DENIED');
      expect(pushOf(await push(ADMIN, await report('receipt,ok'), '2025-M10', 1)).actions).toMatchObject({ may_record_receipt: false });
      const done = await receipt(RECEIVER, sent.id as string, sent.version as number, { outcome: 'ACCEPTED', reference: 'HPM-2025-10-0001' });
      expect(done.status).toBe(200);
      expect(done.json).toMatchObject({ status: 'ACCEPTED', resource_id: sent.id });
      const [audit] = await audits(sent.id as string, 'hpm.receipt_accepted');
      expect(audit).toMatchObject({ actor_id: memberId(RECEIVER), safe_diff: { status: 'ACCEPTED', receipt_reference: 'HPM-2025-10-0001', pushed_by: memberId(ADMIN) } });
      expect(await events(sent.id as string, 'hpm.push.receipt.recorded.v1')).toHaveLength(1);
      const listed = await call('GET', '/hpm/pushes?period=2025-M10', { member: ADMIN });
      expect((listed.json.items as Array<Record<string, unknown>>)[0]).toMatchObject({ status: 'ACCEPTED', receipt: { reference: 'HPM-2025-10-0001', by: memberId(RECEIVER) } });
      // A second receipt on the same push is a conflict of state.
      expect((await receipt(RECEIVER, sent.id as string, 99, { outcome: 'ACCEPTED', reference: 'X' })).status).toBe(409);
    });

    it('needs a note of ten characters to reject, and a push that was written', async () => {
      const sent = pushOf(await push(PUSHER, await report('receipt,no'), '2025-M09', 1));
      expect((await receipt(RECEIVER, sent.id as string, sent.version as number, { outcome: 'REJECTED', reference: 'HPM-9', note: 'short' })).status).toBe(422);
      const rejected = await receipt(RECEIVER, sent.id as string, sent.version as number, { outcome: 'REJECTED', reference: 'HPM-9', note: 'The totals of the capital sources do not add up' });
      expect(rejected.status).toBe(200);
      expect(rejected.json.status).toBe('REJECTED');
      // A rejected push is never sent again under its key: a correction is another revision.
      const refused = await retry(PUSHER, sent.id as string, (await latest('2025-M09')).version);
      expect(refused.status).toBe(409);
      expect(refused.json.code).toBe('HPM_PUSH_STATE_INVALID');
    });

    it('never records a copy made on a DEMO form as accepted (TEMPLATE_UNCONFIRMED, R18)', async () => {
      const sent = pushOf(await push(PUSHER, await report('demo,form'), '2025-M08', 1, { marks: { form_status: 'DEMO', demo_mark: 'DEMO MARK' } }));
      expect(sent).toMatchObject({ form_status: 'DEMO', demo_mark: 'DEMO MARK' });
      const refused = await receipt(RECEIVER, sent.id as string, sent.version as number, { outcome: 'ACCEPTED', reference: 'HPM-D' });
      expect(refused.status).toBe(409);
      expect(refused.json.code).toBe('TEMPLATE_UNCONFIRMED');
      const rows_ = await rows<{ status: string }>("select status from machvon.hpm_push where id = $1", [sent.id]);
      expect(rows_[0]?.status).toBe('WRITTEN');
    });
  });

  describe('an issued copy of the report engine (RPT-1c)', () => {
    let seeded = 0;
    /** An issued copy as the report engine keeps it: the workbook in its content-addressed store and the row of the copy. */
    async function seedIssue(period: string, revision: number, options: { tenantId?: string; formStatus?: string; snapshot?: boolean; supersedes?: string } = {}): Promise<{ id: string; sha: string; xlsx: Uint8Array }> {
      seeded += 1;
      const tenantId = options.tenantId ?? TENANT_A;
      const xlsx = new TextEncoder().encode(`workbook ${period} r${revision} #${seeded}`);
      const hash = shaOf(xlsx);
      const id = randomUUID();
      const demo = options.formStatus === 'DEMO';
      const client = new Client({ connectionString: harness.database.adminUrl });
      await client.connect();
      try {
        await client.query('set session_replication_role = replica');
        await client.query("insert into machvon.report_output_file (tenant_id, sha256, format, size_bytes, content, created_by) values ($1, $2, 'XLSX', $3, $4, $5)", [tenantId, hash, xlsx.length, Buffer.from(xlsx), memberId(ADMIN)]);
        await client.query(
          `insert into machvon.report_issue (tenant_id, id, layout_id, layout_code, layout_version, period_code, period, revision, supersedes_id, reason, draft_id, sha256, xlsx_sha256, xlsx_name, data_source, snapshot_ref, form_status, demo_mark, counts_as_accepted, prepared_by, checked_by, approved_by, issued_by)
           values ($1, $2, $3, $4, '1', $5, '{"kind":"MONTH","year":2026,"index":1}'::jsonb, $6, $7, $8, $9, $10, $10, $11, 'LIVE', $12::jsonb, $13, $14, $15, $16, $17, $18, $18)`,
          [
            tenantId,
            id,
            randomUUID(),
            LAYOUT,
            period,
            revision,
            options.supersedes ?? null,
            revision === 1 ? null : 'A correction after a late invoice',
            randomUUID(),
            hash,
            `HPM_${period}_r${revision}.xlsx`,
            options.snapshot === true ? JSON.stringify({ snapshotId: randomUUID(), revision: 3, cutoff: '2026-10-31' }) : null,
            options.formStatus ?? 'READY',
            demo ? 'DEMO MARK' : null,
            !demo,
            memberId(ADMIN),
            memberId(PUSHER),
            memberId(RECEIVER),
          ],
        );
      } finally {
        await client.end();
      }
      return { id, sha: hash, xlsx };
    }
    const byIssue = (issue: { id: string; sha: string }, period: string, revision: number, extra: Record<string, unknown> = {}): Promise<Reply> =>
      call('POST', '/hpm/pushes', { member: PUSHER, body: { layout_code: LAYOUT, period, revision, sha256: issue.sha, issue_id: issue.id, ...extra } });
    const deliveries = (issueId: string) => rows<{ event: string; channel: string; receiver: string; reference: string | null; recorded_by: string }>('select event, channel, receiver, reference, recorded_by from machvon.report_delivery where issue_id = $1 order by occurred_at, id', [issueId]);

    it('takes the file, the snapshot and the marks from the copy, and writes the delivery and the answer into the delivery log of the engine', async () => {
      const issue = await seedIssue('2024-M01', 1, { snapshot: true });
      const sent = await byIssue(issue, '2024-M01', 1);
      expect(sent.status).toBe(200);
      const row = pushOf(sent);
      expect(row).toMatchObject({ status: 'WRITTEN', snapshot: { revision: 3, cutoff: '2026-10-31' }, form_status: 'READY' });
      const package_ = written.find((entry) => entry.name === packageName('2024-M01', 1));
      const unpacked = unzipSync(package_?.bytes as Uint8Array);
      expect(unpacked['report/HPM_2024-M01_r1.xlsx']).toEqual(issue.xlsx);
      expect((await deliveries(issue.id)).map((entry) => [entry.event, entry.channel, entry.receiver, entry.recorded_by])).toEqual([['DELIVERED', 'HPM_PUSH', 'HPM', memberId(PUSHER)]]);
      // The same push again is the repeat of the ledger and writes no second delivery.
      expect((await byIssue(issue, '2024-M01', 1)).json.status).toBe('ALREADY_DELIVERED');
      const done = await receipt(RECEIVER, row.id as string, row.version as number, { outcome: 'ACCEPTED', reference: 'HPM-2024-01' });
      expect(done.status).toBe(200);
      expect((await deliveries(issue.id)).map((entry) => [entry.event, entry.reference])).toEqual([['DELIVERED', row.key], ['ACCEPTED', 'HPM-2024-01']]);
    });

    it('refuses what the caller says about a copy when it is not the copy (422), and a copy that does not exist or belongs to another tenant (404)', async () => {
      const issue = await seedIssue('2024-M02', 1);
      const wrongHash = await call('POST', '/hpm/pushes', { member: PUSHER, body: { layout_code: LAYOUT, period: '2024-M02', revision: 1, sha256: 'f'.repeat(64), issue_id: issue.id } });
      expect(wrongHash.status).toBe(422);
      expect(wrongHash.json.code).toBe('VALIDATION_FAILED');
      expect((await byIssue(issue, '2024-M03', 1)).status).toBe(422);
      expect((await byIssue(issue, '2024-M02', 2)).status).toBe(422);
      expect((await byIssue({ id: randomUUID(), sha: issue.sha }, '2024-M02', 1)).status).toBe(404);
      const foreign = await seedIssue('2024-M02', 1, { tenantId: TENANT_B });
      expect((await byIssue(foreign, '2024-M02', 1)).status).toBe(404);
      expect(await rows('select 1 from machvon.hpm_push where period = $1', ['2024-M02'])).toHaveLength(0);
    });

    it('judges staleness against the newest revision the engine issued, even when this ledger never saw it', async () => {
      const first = await seedIssue('2024-M04', 1);
      await seedIssue('2024-M04', 2, { supersedes: first.id });
      const stale = await byIssue(first, '2024-M04', 1);
      expect(stale.status).toBe(409);
      expect(stale.json).toMatchObject({ code: 'REPORT_OUT_OF_DATE', current_revision: 2 });
    });

    it('never records the receipt of a copy made on a DEMO form as accepted, in the ledger or in the log of the engine', async () => {
      const issue = await seedIssue('2024-M05', 1, { formStatus: 'DEMO' });
      const sent = pushOf(await byIssue(issue, '2024-M05', 1));
      expect(sent).toMatchObject({ form_status: 'DEMO', demo_mark: 'DEMO MARK' });
      expect((await receipt(RECEIVER, sent.id as string, sent.version as number, { outcome: 'ACCEPTED', reference: 'HPM-D' })).json.code).toBe('TEMPLATE_UNCONFIRMED');
      expect((await deliveries(issue.id)).map((entry) => entry.event)).toEqual(['DELIVERED']);
    });
  });

  describe('the connection state', () => {
    it('switches the push off and on with a reason, audits it, keeps the history, and refuses a push and a retry while it is off', async () => {
      const connection = await call('GET', '/hpm/connection', { member: ADMIN });
      const version = connection.json.version as number;
      const off = await call('POST', '/hpm/connection/state', { member: ADMIN, ifMatch: `"${version}"`, body: { enabled: false, reason: 'HPM is being migrated by the customer' } });
      expect(off.status).toBe(200);
      expect(off.json).toMatchObject({ status: 'DISABLED' });
      const [audit] = await audits(off.json.resource_id as string, 'hpm.connection_switched');
      expect(audit).toMatchObject({ reason: 'HPM is being migrated by the customer', safe_diff: { connector_code: 'hpm.reports', from_enabled: true, to_enabled: false } });
      const blocked = await push(PUSHER, await report('while,off'), '2025-M07', 1);
      expect(blocked.status).toBe(409);
      expect(blocked.json.code).toBe('HPM_CONNECTION_DISABLED');
      const view = await call('GET', '/hpm/connection', { member: READER });
      expect(view.json).toMatchObject({ enabled: false, state_reason: 'HPM is being migrated by the customer', health: { push_blocked: true, alert: null } });
      expect((view.json.history as Array<{ action: string }>).map((event) => event.action)).toEqual(['DISABLED', 'CREATED']);
      const again = await call('POST', '/hpm/connection/state', { member: ADMIN, ifMatch: `"${off.json.resource_version as number}"`, body: { enabled: false, reason: 'HPM is being migrated by the customer' } });
      expect(again.status).toBe(422);
      const on = await call('POST', '/hpm/connection/state', { member: ADMIN, ifMatch: `"${off.json.resource_version as number}"`, body: { enabled: true, reason: 'HPM has been migrated and is back' } });
      expect(on.status).toBe(200);
      expect((await push(PUSHER, await report('while,on'), '2025-M07', 1)).status).toBe(200);
    });

    it('is refused to anybody but the administrator on the whole tenant', async () => {
      const version = (await call('GET', '/hpm/connection', { member: ADMIN })).json.version as number;
      for (const member of [PUSHER, UNIT_ADMIN, READER]) {
        const refused = await call('POST', '/hpm/connection/state', { member, ifMatch: `"${version}"`, body: { enabled: false, reason: 'No right to do this at all' } });
        expect(refused.status).toBe(403);
      }
    });
  });

  describe('who may do what', () => {
    it('refuses the commands to a reader and to a unit administrator, and the reads of the log to a grant below the tenant', async () => {
      const file = await report('rights,bytes');
      expect((await push(READER, file, '2025-M06', 1)).status).toBe(403);
      expect((await push(UNIT_ADMIN, file, '2025-M06', 1)).status).toBe(403);
      expect((await push(RECEIVER, file, '2025-M06', 1)).status).toBe(403);
      expect((await call('GET', '/hpm/pushes', { member: UNIT_ADMIN })).status).toBe(403);
      expect((await call('GET', '/hpm/corrections', { member: UNIT_ADMIN })).status).toBe(403);
      expect((await call('GET', '/hpm/pushes', { member: NOBODY })).status).toBe(403);
      expect((await call('GET', '/hpm/pushes?status=NOPE', { member: ADMIN })).status).toBe(422);
      expect((await call('GET', '/hpm/pushes?limit=0', { member: ADMIN })).status).toBe(422);
      expect(await rows('select 1 from machvon.hpm_push where period = $1', ['2025-M06'])).toHaveLength(0);
    });

    it('does not let the proposer decide, nor the decider propose', async () => {
      const reopenId = randomUUID();
      reopened.set(reopenId, '2025-M05');
      await accepted('2025-M05', 1);
      expect((await propose(DECIDER, '2025-M05', 1, reopenId)).status).toBe(403);
      const proposed = await propose(PROPOSER, '2025-M05', 1, reopenId);
      expect(proposed.status).toBe(200);
      expect((await decide(PROPOSER, proposed.json.id as string, 1, 'APPROVE')).status).toBe(403);
    });

    it('pages the push log newest first with a cursor', async () => {
      const first = await call('GET', '/hpm/pushes?limit=3', { member: ADMIN });
      expect(first.status).toBe(200);
      const items = first.json.items as Array<{ last_attempt_at: string }>;
      expect(items).toHaveLength(3);
      expect(items.map((item) => item.last_attempt_at)).toEqual([...items.map((item) => item.last_attempt_at)].sort().reverse());
      expect(first.json.next_cursor).not.toBeNull();
      const next = await call('GET', `/hpm/pushes?limit=3&cursor=${first.json.next_cursor as string}`, { member: ADMIN });
      expect(next.status).toBe(200);
      const ids = new Set([...items, ...(next.json.items as Array<{ id: string }>)].map((item) => (item as { id?: string }).id));
      expect(ids.size).toBe(6);
    });
  });

  describe('another tenant (isolation)', () => {
    it('answers 404 to a member of tenant B for a push, a correction of tenant A, as for an id that does not exist', async () => {
      const sent = pushOf(await push(PUSHER, await report('isolation,bytes'), '2025-M04', 1));
      const unknown = randomUUID();
      const retried = await call('POST', `/hpm/pushes/${sent.id as string}/retry`, { member: B_ADMIN, tenantId: TENANT_B, ifMatch: '"1"', body: {} });
      const missing = await call('POST', `/hpm/pushes/${unknown}/retry`, { member: B_ADMIN, tenantId: TENANT_B, ifMatch: '"1"', body: {} });
      expect(retried.status).toBe(404);
      expect({ ...retried.json, correlationId: 'x', correlation_id: 'x' }).toEqual({ ...missing.json, correlationId: 'x', correlation_id: 'x' });
      const receipted = await call('POST', `/hpm/pushes/${sent.id as string}/receipt`, { member: B_ADMIN, tenantId: TENANT_B, ifMatch: '"1"', body: { outcome: 'ACCEPTED', reference: 'FOREIGN' } });
      expect(receipted.status).toBe(404);
      const decided = await call('POST', `/hpm/corrections/${randomUUID()}/decision`, { member: B_ADMIN, tenantId: TENANT_B, ifMatch: '"1"', body: { decision: 'APPROVE', reason: 'A foreign decision attempt' } });
      expect(decided.status).toBe(404);
      const listed = await call('GET', '/hpm/pushes', { member: B_ADMIN, tenantId: TENANT_B });
      expect(listed.status).toBe(200);
      expect(listed.json.items).toEqual([]);
      expect(JSON.stringify(listed.json)).not.toContain(sent.id as string);
      // A key of tenant A in the object store is not found for tenant B.
      const foreign = await call('POST', '/hpm/pushes', { member: B_ADMIN, tenantId: TENANT_B, body: pushBody(await report('foreign,bytes'), '2025-M04', 1) });
      expect(foreign.status).toBe(404);
    });
  });

  describe('the file writer never calls the network', () => {
    it('opens no connection but the ones to this test server, however many pushes, retries and receipts are made', async () => {
      const targets: string[] = [];
      const original = net.Socket.prototype.connect;
      const spy = jest.spyOn(net.Socket.prototype, 'connect').mockImplementation(function (this: net.Socket, ...args: unknown[]) {
        const first = args[0];
        const host = typeof first === 'object' && first !== null ? (first as { host?: string }).host : typeof args[1] === 'string' ? args[1] : 'localhost';
        targets.push(host ?? 'unix');
        return (original as (...parameters: unknown[]) => net.Socket).apply(this, args);
      });
      try {
        failNext = 1;
        const failed = pushOf(await push(PUSHER, await report('net,one'), '2025-M03', 1));
        await retry(PUSHER, failed.id as string, failed.version as number);
        const sent = pushOf(await push(PUSHER, await report('net,two'), '2025-M02', 1));
        await receipt(RECEIVER, sent.id as string, sent.version as number, { outcome: 'ACCEPTED', reference: 'NET' });
      } finally {
        spy.mockRestore();
      }
      // The pooled connection of the test client may be reused, so there may be no new connection at all: what must hold is that none goes anywhere but here, and that the writer did its work.
      for (const target of targets) expect(['127.0.0.1', 'localhost', '::1']).toContain(target);
      expect(written.some((entry) => entry.name === packageName('2025-M02', 1))).toBe(true);
    });
  });

  describe('the database holds the rules too', () => {
    it('refuses what the commands refuse: a second row for a key, a receipt by the pusher, a correction decided by its proposer, an acceptance of a demo copy, a change of what a push holds', async () => {
      const sent = pushOf(await push(PUSHER, await report('db,rules'), '2025-M01', 1));
      const attempt = (sql: string, params: unknown[] = []): Promise<unknown> => rows(sql, params);
      await expect(attempt(`update machvon.hpm_push set sha256 = $2 where id = $1`, [sent.id, 'f'.repeat(64)])).rejects.toThrow();
      await expect(attempt(`update machvon.hpm_push set status = 'ACCEPTED', receipt_by = pushed_by, receipt_at = now(), receipt_reference = 'X' where id = $1`, [sent.id])).rejects.toThrow();
      await expect(attempt(`update machvon.hpm_push set status = 'PENDING' where id = $1`, [sent.id])).rejects.toThrow();
      await expect(attempt(`update machvon.hpm_push_attempt set outcome = 'FAILED', error_code = 'X' where push_id = $1`, [sent.id])).rejects.toThrow();
      await expect(attempt(`delete from machvon.hpm_push_attempt where push_id = $1`, [sent.id])).rejects.toThrow();
      await expect(attempt(`update machvon.hpm_correction set state = 'APPROVED', decided_by = proposed_by, decided_at = now(), decision_reason = 'Approved by the same person' where true`)).rejects.toThrow();
      await expect(
        attempt(
          `insert into machvon.hpm_push (tenant_id, idempotency_key, org_unit_id, layout_code, period, revision, sha256, request_hash, file_object_key, package_format, status, pushed_by, created_by, updated_by)
           values ($1, $2, $3, $4, '2025-M01', 1, $5, $5, 'tenants/x/report_export/y', 'F', 'PENDING', $6, $6, $6)`,
          [TENANT_A, sent.key, TENANT_A, LAYOUT, 'a'.repeat(64), memberId(PUSHER)],
        ),
      ).rejects.toThrow();
    });
  });
});
