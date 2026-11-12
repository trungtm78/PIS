import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { registerEnterpriseIntegrationRules } from '@machvon/edition-enterprise/src/server.ts';
import { HpmFileWriter, ReportStoreIssuedReports, hpmPackageName } from '@machvon/edition-enterprise/src/server.ts';
import type { PeriodReopenPort } from '@machvon/edition-enterprise/src/server.ts';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
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

describe('the adjustment in the next period (ENT-3c, TH.01)', () => {
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


  const adjust = (member: number, extra: Record<string, unknown> = {}): Promise<Reply> =>
    call('POST', '/hpm/corrections', { member, body: { mode: 'ADJUST_NEXT_PERIOD', layout_code: LAYOUT, period: '2026-M10', from_revision: 1, subject_code: 'DISBURSED_CUM', amount_vnd: '-1500000', reason: 'The accepted month counted an invoice twice', ...extra } });
  const stateOf = (id: string) => rows<{ state: string; applied_push_id: string | null }>('select state, applied_push_id from machvon.hpm_adjustment where id = $1', [id]);
  const journal = (id: string) => rows<{ kind: string }>('select kind from machvon.hpm_adjustment_entry where adjustment_id = $1 order by at, kind', [id]);

  it('refuses an adjustment against a period the receiver has not accepted, and one whose next period is not computable', async () => {
    expect((await adjust(ADMIN)).status).toBe(404);
    expect(await adjust(ADMIN, { period: '2026-12-13' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
    expect(await adjust(ADMIN, { amount_vnd: '0' })).toMatchObject({ status: 422 });
  });

  it('is proposed by one person, decided by another, listed beside the corrections by overwrite, and journaled', async () => {
    await accepted('2026-M10', 1);
    const proposed = await adjust(PROPOSER);
    expect(proposed.status).toBe(200);
    expect(proposed.json).toMatchObject({ mode: 'ADJUST_NEXT_PERIOD', period: '2026-M10', from_revision: 1, target_period: '2026-M11', subject_code: 'DISBURSED_CUM', amount_vnd: '-1500000', state: 'PROPOSED', period_reopen_id: null, proposed_by: memberId(PROPOSER) });
    const id = proposed.json.id as string;
    // One open adjustment for a subject of a period.
    expect(await adjust(PROPOSER)).toMatchObject({ status: 409, json: { code: 'HPM_ADJUSTMENT_STATE_INVALID' } });
    const listed = await call('GET', '/hpm/corrections', { member: READER });
    expect((listed.json.items as Array<{ id: string; mode: string }>).find((one) => one.id === id)?.mode).toBe('ADJUST_NEXT_PERIOD');
    // The proposer does not decide their own: the admin who proposes cannot approve it either.
    const own = await adjust(ADMIN, { subject_code: 'OTHER_SUBJECT' });
    expect(await decide(ADMIN, own.json.id as string, own.json.version as number, 'APPROVE')).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
    const approved = await decide(DECIDER, id, proposed.json.version as number, 'APPROVE');
    expect(approved).toMatchObject({ status: 200, json: { status: 'APPROVED' } });
    expect((await stateOf(id))[0]).toEqual({ state: 'APPROVED', applied_push_id: null });
    expect((await journal(id)).map((row) => row.kind)).toEqual(['PROPOSED', 'APPROVED']);
    expect((await audits(id, 'hpm.adjustment_proposed'))[0]).toMatchObject({ actor_id: memberId(PROPOSER) });
    expect((await audits(id, 'hpm.adjustment_approved'))[0]).toMatchObject({ actor_id: memberId(DECIDER) });
    // A decided adjustment is not decided again.
    expect(await decide(DECIDER, id, (approved.json.resource_version as number), 'REJECT')).toMatchObject({ status: 409, json: { code: 'HPM_ADJUSTMENT_STATE_INVALID' } });
  });

  it('rides once on the push of the next period, and the accepted period is untouched', async () => {
    const [open] = await rows<{ id: string }>("select id from machvon.hpm_adjustment where subject_code = 'DISBURSED_CUM' and state = 'APPROVED'");
    const before = written.length;
    const sent = await push(PUSHER, await report('next,month'), '2026-M11', 1);
    expect(sent.status).toBe(200);
    const package_ = written.slice(before).find((entry) => entry.name === packageName('2026-M11', 1));
    const unpacked = unzipSync(package_?.bytes as Uint8Array);
    const name = Object.keys(unpacked).find((entry) => entry.endsWith('adjustments.json'));
    expect(name).toBeDefined();
    const carried = JSON.parse(strFromU8(unpacked[name as string] as Uint8Array)) as { target_period: string; adjustments: Array<{ id: string; amount_vnd: string }> };
    expect(carried.target_period).toBe('2026-M11');
    expect(carried.adjustments).toEqual([expect.objectContaining({ id: open?.id, amount_vnd: '-1500000' })]);
    const [applied] = await stateOf(open?.id as string);
    expect(applied).toMatchObject({ state: 'APPLIED', applied_push_id: pushOf(sent).id });
    expect((await journal(open?.id as string)).map((row) => row.kind)).toEqual(['PROPOSED', 'APPROVED', 'APPLIED']);
    // The accepted month stays as it was: still one accepted push of revision 1.
    expect(await rows("select 1 from machvon.hpm_push where period = '2026-M10' and status = 'ACCEPTED' and revision = 1")).toHaveLength(1);
    // The next period was sent, so the figure has no package left to ride on.
    const row = await latest('2026-M11');
    expect((await receipt(RECEIVER, row.id, row.version, { outcome: 'ACCEPTED', reference: 'HPM-2026-M11' })).status).toBe(200);
    expect(await adjust(PROPOSER, { subject_code: 'LATE_SUBJECT' })).toMatchObject({ status: 409, json: { code: 'HPM_ADJUSTMENT_STATE_INVALID' } });
  });
  it('gives an adjustment back when the receiver rejects the push that carried it, so the next push of the period carries it again and no figure is lost', async () => {
    await accepted('2026-M07', 1);
    const proposed = await adjust(PROPOSER, { period: '2026-M07', subject_code: 'RELEASED_SUBJECT', amount_vnd: '2500000' });
    expect(proposed.status).toBe(200);
    const id = proposed.json.id as string;
    expect((await decide(DECIDER, id, proposed.json.version as number, 'APPROVE')).status).toBe(200);
    // The first push of the target period carries it.
    const first = await push(PUSHER, await report('aug,first'), '2026-M08', 1);
    expect(first.status).toBe(200);
    expect((await stateOf(id))[0]).toMatchObject({ state: 'APPLIED', applied_push_id: pushOf(first).id });
    // While the package waits for the receipt, the subject of the period cannot be proposed again: a rejection would give the first back next to the second.
    expect(await adjust(PROPOSER, { period: '2026-M07', subject_code: 'RELEASED_SUBJECT', amount_vnd: '100' })).toMatchObject({ status: 409, json: { code: 'HPM_ADJUSTMENT_STATE_INVALID' } });
    // The receiver rejects that package: the adjustment is the receiver's no longer, it waits again, with the reason in the journal.
    const rejected = await receipt(RECEIVER, pushOf(first).id as string, pushOf(first).version as number, { outcome: 'REJECTED', reference: 'HPM-2026-M08-R1', note: 'The package does not match the layout' });
    expect(rejected).toMatchObject({ status: 200, json: { status: 'REJECTED' } });
    expect((await stateOf(id))[0]).toEqual({ state: 'APPROVED', applied_push_id: null });
    expect((await journal(id)).map((row) => row.kind)).toEqual(['PROPOSED', 'APPROVED', 'APPLIED', 'RELEASED']);
    expect((await audits(id, 'hpm.adjustment_released'))[0]).toMatchObject({ actor_id: memberId(RECEIVER) });
    // The corrected package of the period (the next revision, another key) carries it once more.
    const before = written.length;
    const second = await push(PUSHER, await report('aug,second'), '2026-M08', 2);
    expect(second.status).toBe(200);
    const unpacked = unzipSync(written.slice(before).find((entry) => entry.name === packageName('2026-M08', 2))?.bytes as Uint8Array);
    const carried = JSON.parse(strFromU8(unpacked[Object.keys(unpacked).find((entry) => entry.endsWith('adjustments.json')) as string] as Uint8Array)) as { adjustments: Array<{ id: string; amount_vnd: string }> };
    expect(carried.adjustments).toEqual([expect.objectContaining({ id, amount_vnd: '2500000' })]);
    expect((await stateOf(id))[0]).toMatchObject({ state: 'APPLIED', applied_push_id: pushOf(second).id });
    // A push that the receiver accepted keeps what it carried: nothing is released by an acceptance.
    expect((await receipt(RECEIVER, pushOf(second).id as string, pushOf(second).version as number, { outcome: 'ACCEPTED', reference: 'HPM-2026-M08-R2' })).status).toBe(200);
    expect((await stateOf(id))[0]).toMatchObject({ state: 'APPLIED', applied_push_id: pushOf(second).id });
  });
  it('does not let a rejection fail on data from before the proposal check: an adjustment that cannot come back (another one is open for the subject) stays applied and is put on record', async () => {
    await accepted('2026-M05', 1);
    const proposed = await adjust(PROPOSER, { period: '2026-M05', subject_code: 'BLOCKED_SUBJECT', amount_vnd: '700' });
    expect((await decide(DECIDER, proposed.json.id as string, proposed.json.version as number, 'APPROVE')).status).toBe(200);
    const sent = await push(PUSHER, await report('jun,first'), '2026-M06', 1);
    expect((await stateOf(proposed.json.id as string))[0]).toMatchObject({ state: 'APPLIED' });
    // What an earlier version allowed: a second open adjustment for the subject while the first rides on a push.
    await rows(
      `insert into machvon.hpm_adjustment (tenant_id, id, layout_code, source_period, source_revision, target_period, subject_code, amount_vnd, reason, state, proposed_by)
       select tenant_id, gen_random_uuid(), layout_code, source_period, source_revision, target_period, subject_code, 900, reason, 'PROPOSED', proposed_by from machvon.hpm_adjustment where id = $1`,
      [proposed.json.id],
    );
    const rejected = await receipt(RECEIVER, pushOf(sent).id as string, pushOf(sent).version as number, { outcome: 'REJECTED', reference: 'HPM-2026-M06-R1', note: 'The package does not match the layout' });
    expect(rejected).toMatchObject({ status: 200, json: { status: 'REJECTED' } });
    expect((await stateOf(proposed.json.id as string))[0]).toMatchObject({ state: 'APPLIED' });
    expect((await audits(proposed.json.id as string, 'hpm.adjustment_release_blocked'))[0]).toMatchObject({ actor_id: memberId(RECEIVER) });
    expect(await audits(proposed.json.id as string, 'hpm.adjustment_released')).toEqual([]);
  });
});
