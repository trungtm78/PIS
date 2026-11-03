import { randomBytes, randomUUID } from 'node:crypto';
import { Controller, Post, Param, ParseUUIDPipe } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, IdempotencyStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { DomainError, loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../src/command.decorator';
import { commandResult } from '../../src/command-result';
import type { CommandResult } from '../../src/command-result';
import type { CommandScope } from '../../src/command-scope';
import { CommandModule } from '../../src/command.module';
import { OperationId } from '../../src/operation-id.decorator';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { BatchSlots, SYNC_BATCH_SLOTS, SyncSlotGuard, SyncSlotInterceptor } from '../../src/sync/batch-slots';
import { HttpSyncOperationInvoker, SYNC_OPERATION_INVOKER, forwardedHeaders } from '../../src/sync/operation-invoker';
import { SyncController } from '../../src/sync/sync.controller';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const PHONE_USER = 1; // may submit, create issues, record measurements and edit reports
const LIMITED = 2; // may submit batches and nothing else
const OTHER_USER = 3; // another person with the same rights
const NOBODY = 4; // may not even submit batches
const OTHER_TENANT_USER = 1; // of tenant B

/** What the operations behind the sync endpoint have done in this process: a command carried out twice would show here. */
const carried = { issues: 0, submits: new Map<string, number>(), results: new Map<string, number>(), slotsSeen: [] as number[] };
const slots = new BatchSlots(1, 2_000);
let slowMs = 0;
const slow = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, slowMs));
const reportVersions = new Map<string, number>();
const inspectionVersions = new Map<string, number>();
let measurementsDown = true;

const audit = (scope: CommandScope, action: string, resourceId: string) => scope.audit({ action, resourceType: 'stub', resourceId, classification: 'INTERNAL', diff: {} });

@Controller()
class StubOperations {
  @Post('issues')
  @OperationId('createIssue')
  @Command({ operation: 'createIssue' })
  async createIssue(@Scope() scope: CommandScope): Promise<CommandResult> {
    carried.slotsSeen.push(slots.inUse);
    await slow();
    carried.issues += 1;
    const id = randomUUID();
    await audit(scope, 'issue.created', id);
    return commandResult(scope, 'CREATED', 1, id);
  }

  @Post('reports/:id/submit')
  @OperationId('post_reports_id_submit')
  @Command({ operation: 'post_reports_id_submit', versioned: true })
  async submit(@Scope() scope: CommandScope, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    if (id === LOCKED_REPORT) throw new DomainError('PERIOD_LOCKED', 422);
    await slow();
    const current = reportVersions.get(id) ?? 1;
    if ((scope.expectedVersion ?? 0) !== current) throw new DomainError('VERSION_CONFLICT', 409, undefined, { extensions: { current_version: current } });
    reportVersions.set(id, current + 1);
    carried.submits.set(id, (carried.submits.get(id) ?? 0) + 1);
    await audit(scope, 'report.submitted', id);
    return commandResult(scope, 'SUBMITTED', current + 1, id);
  }

  @Post('inspections/:id/result')
  @OperationId('recordInspectionResult')
  @Command({ operation: 'recordInspectionResult', versioned: true })
  async inspect(@Scope() scope: CommandScope, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    const current = inspectionVersions.get(id) ?? 1;
    if ((scope.expectedVersion ?? 0) !== current) throw new DomainError('VERSION_CONFLICT', 409, undefined, { extensions: { current_version: current } });
    inspectionVersions.set(id, current + 1);
    carried.results.set(id, (carried.results.get(id) ?? 0) + 1);
    await audit(scope, 'inspection.result_recorded', id);
    return commandResult(scope, 'RESULT_RECORDED', current + 1, id);
  }

  @Post('contracts/:id/measurements')
  @OperationId('recordMeasurement')
  @Command({ operation: 'recordMeasurement' })
  async measure(@Scope() scope: CommandScope, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    if (measurementsDown) throw new Error('database is restarting');
    await audit(scope, 'measurement.recorded', id);
    return commandResult(scope, 'RECORDED', 1, id);
  }
}

const LOCKED_REPORT = '00000000-0000-4000-8000-0000000000e1';
const REPORT_A = '00000000-0000-4000-8000-0000000000e2';
const REPORT_B = '00000000-0000-4000-8000-0000000000e3';
const CONTRACT = '00000000-0000-4000-8000-0000000000e4';
const INSPECTION = '00000000-0000-4000-8000-0000000000e5';

interface Reply {
  status: number;
  json: Record<string, unknown>;
}
interface Item {
  idempotency_key: string;
  command_type: string;
  base_server_version: number;
  payload: Record<string, unknown>;
}

describe('the commands a phone queued offline (ST-MOB-005, MOB-41)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let counter = 0;
  const devices = new Map<number, string>();

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  const rows = <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

  async function call(method: 'GET' | 'POST', url: string, options: { member?: number; tenantId?: string; body?: unknown; key?: string } = {}): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member ?? PHONE_USER, options.tenantId), 'content-type': 'application/json' };
    if (method === 'POST') headers['idempotency-key'] = options.key ?? `batch-${randomUUID()}`;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, ...(method === 'POST' ? { body: JSON.stringify(options.body ?? {}) } : {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  const key = (): string => `queued-${(counter += 1).toString().padStart(4, '0')}-${randomUUID()}`;
  // The payloads are the ones the operations ask for: the platform checks them as it would online.
  const issuePayload = (title = 'A road is blocked') => ({ project_id: randomUUID(), category_version_id: randomUUID(), severity: 'HIGH', title, description: 'The access road to the site is blocked.', owner_unit_id: randomUUID(), client_operation_id: randomUUID() });
  const issue = (overrides: Partial<Item> = {}): Item => ({ idempotency_key: key(), command_type: 'issue.create', base_server_version: 0, payload: issuePayload(), ...overrides });
  const submitReport = (id: string, version: number, overrides: Partial<Item> = {}): Item => ({ idempotency_key: key(), command_type: 'report.submit', base_server_version: version, payload: { report_id: id }, ...overrides });
  const send = (items: Item[], options: { member?: number; device?: string; key?: string; tenantId?: string } = {}) =>
    call('POST', '/sync/batches', { member: options.member ?? PHONE_USER, ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }), ...(options.key === undefined ? {} : { key: options.key }), body: { device_id: options.device ?? (devices.get(options.member ?? PHONE_USER) as string), items } });
  const results = (reply: Reply): Array<{ idempotency_key: string; status: string; code?: string; server_version?: number }> => reply.json.results as never;
  const lookup = (idempotencyKey: string, member = PHONE_USER, tenantId = TENANT_A) => call('GET', `/sync/commands/${idempotencyKey}`, { member, tenantId });
  const receipts = (idempotencyKey: string) => rows<{ status: string; code: string | null; server_version: string | null; result_ref: string | null; command_type: string; membership_id: string; request_hash: string }>('select status, code, server_version::text as server_version, result_ref, command_type, membership_id, request_hash from machvon.sync_command_receipt where idempotency_key = $1', [idempotencyKey]);

  async function device(tenant: string, member: number): Promise<string> {
    const deviceId = randomUUID();
    await harness.owner(tenant, [
      [
        `insert into machvon.device_registration (tenant_id, id, membership_id, device_public_id, push_secret_ref, platform, last_seen_at, token_fingerprint, permission_state, app_version)
         values ($1, $2, $3, $4, $5, 'android', now(), repeat('a', 64), 'granted', '1.0.0')`,
        [tenant, deviceId, memberId(member), `public-${deviceId}`, `secret://push/${tenant}/${deviceId}`],
      ],
    ]);
    return deviceId;
  }

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: 1, path: `/${unitId(1)}/` }]);
    for (const member of [PHONE_USER, LIMITED, OTHER_USER, NOBODY]) await harness.seedMembership(TENANT_A, member, 1, { validFrom: '2026-01-01T00:00:00Z' });
    await harness.seedMembership(TENANT_B, OTHER_TENANT_USER, 1, { validFrom: '2026-01-01T00:00:00Z' });
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedRole(tenant, 1, 'PHONE', ['sync.submit', 'sync.upload', 'issue.create', 'report.submit', 'report.edit', 'measurement.record', 'inspection.record'], 5);
      await harness.seedRole(tenant, 2, 'SYNC_ONLY', ['sync.submit'], 5);
    }
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: PHONE_USER, role: 1, kind: 'TENANT' },
      { n: 2, member: LIMITED, role: 2, kind: 'TENANT' },
      { n: 3, member: OTHER_USER, role: 1, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: OTHER_TENANT_USER, role: 1, kind: 'TENANT' }]);
    for (const member of [PHONE_USER, LIMITED, OTHER_USER, NOBODY]) devices.set(member, await device(TENANT_A, member));
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [SyncController, StubOperations],
      providers: [
        { provide: SYNC_BATCH_SLOTS, useValue: slots },
        SyncSlotGuard,
        SyncSlotInterceptor,
        { provide: TenantDatabase, useValue: tenants },
        { provide: SYNC_OPERATION_INVOKER, useClass: HttpSyncOperationInvoker },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await harness.stop();
  }, 60_000);

  describe('a batch', () => {
    it('AC-ST-MOB-005-3 UAT-AC358: five commands with one refused are answered one by one: the four good ones are accepted, the batch is not failed, and each leaves a receipt', async () => {
      const good = [issue(), issue(), submitReport(REPORT_A, 1), issue()];
      const locked = submitReport(LOCKED_REPORT, 1);
      const before = carried.issues;
      const reply = await send([good[0] as Item, good[1] as Item, locked, good[2] as Item, good[3] as Item]);
      expect(reply.status).toBe(200);
      expect(results(reply).map((result) => [result.idempotency_key, result.status, result.code])).toEqual([
        [(good[0] as Item).idempotency_key, 'accepted', undefined],
        [(good[1] as Item).idempotency_key, 'accepted', undefined],
        [locked.idempotency_key, 'rejected', 'PERIOD_LOCKED'],
        [(good[2] as Item).idempotency_key, 'accepted', undefined],
        [(good[3] as Item).idempotency_key, 'accepted', undefined],
      ]);
      expect(carried.issues - before).toBe(3);
      for (const item of [...good, locked]) expect(await receipts(item.idempotency_key)).toHaveLength(1);
      expect((await receipts(locked.idempotency_key))[0]).toMatchObject({ status: 'rejected', code: 'PERIOD_LOCKED', command_type: 'report.submit' });
    });

    it('takes a command based on an older version of the record as a conflict, with the version the server holds, and never carries it out', async () => {
      const first = submitReport(REPORT_B, 1);
      expect(results(await send([first]))[0]).toMatchObject({ status: 'accepted', server_version: 2 });
      // A second phone based its submit on version 1, which is no longer the record.
      const stale = submitReport(REPORT_B, 1);
      const reply = await send([stale]);
      expect(results(reply)[0]).toEqual({ idempotency_key: stale.idempotency_key, status: 'conflict', code: 'VERSION_CONFLICT', server_version: 2 });
      expect(carried.submits.get(REPORT_B)).toBe(1);
      expect((await receipts(stale.idempotency_key))[0]).toMatchObject({ status: 'conflict', code: 'VERSION_CONFLICT', server_version: '2' });
      expect((await lookup(stale.idempotency_key)).json).toEqual({ status: 'conflict', code: 'VERSION_CONFLICT' });
    });

    it('AC-ST-MOB-021-3: the result of an inspection is carried out by recordInspectionResult over the version the phone read; one based on an older version is a conflict and is not carried out', async () => {
      const result = (version: number): Item => ({
        idempotency_key: key(),
        command_type: 'inspection.result',
        base_server_version: version,
        payload: { inspection_id: INSPECTION, result: 'CONDITIONAL', result_note: 'Replace the steel', checklist: [{ code: 'K1', outcome: 'FAIL', note: 'wrong bar' }, { code: 'K2', outcome: 'PASS' }] },
      });
      const first = result(1);
      expect(results(await send([first]))[0]).toMatchObject({ status: 'accepted', server_version: 2, idempotency_key: first.idempotency_key });
      expect((await receipts(first.idempotency_key))[0]).toMatchObject({ status: 'accepted', command_type: 'inspection.result', result_ref: INSPECTION });
      // A second inspector based the result on version 1, which is no longer the inspection.
      const stale = result(1);
      expect(results(await send([stale]))[0]).toEqual({ idempotency_key: stale.idempotency_key, status: 'conflict', code: 'VERSION_CONFLICT', server_version: 2 });
      expect(carried.results.get(INSPECTION)).toBe(1);
      // The first answer was lost: the same command sent again is answered from its receipt and recorded once.
      expect(results(await send([first]))[0]).toMatchObject({ status: 'accepted', server_version: 2 });
      expect(carried.results.get(INSPECTION)).toBe(1);
    });

    it('AC-ST-MOB-005-1 UAT-AC502: after the response was lost, the lookup by key says ACCEPTED, and sending the batch again carries nothing out a second time', async () => {
      const queued = submitReport(REPORT_A, 2);
      expect((await lookup(queued.idempotency_key)).json).toEqual({ status: 'not_received' });
      const first = await send([queued]);
      expect(results(first)[0]).toMatchObject({ status: 'accepted', server_version: 3 });
      const executed = carried.submits.get(REPORT_A);
      const unknown = await lookup(queued.idempotency_key);
      expect(unknown.json).toMatchObject({ status: 'accepted', result_ref: REPORT_A });
      // The phone does not know it was accepted and sends it again, under a batch key of its own: the answer is the same and the report is not submitted twice.
      const again = await send([queued]);
      expect(results(again)).toEqual(results(first));
      expect(carried.submits.get(REPORT_A)).toBe(executed);
      expect(await receipts(queued.idempotency_key)).toHaveLength(1);
    });

    it('AC-ST-MOB-005-2 UAT-AC503: the same batch key with another body is 409 IDEMPOTENCY_CONFLICT and the first answer stands; the same command key with another command is refused, not carried out', async () => {
      const batchKey = `batch-${randomUUID()}`;
      const original = issue();
      const first = await send([original], { key: batchKey });
      expect(first.status).toBe(200);
      const different = await send([issue()], { key: batchKey });
      expect([different.status, different.json.code]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);
      expect((await send([original], { key: batchKey })).json).toEqual(first.json);
      // Another batch reuses the key of the command for another payload.
      const before = carried.issues;
      const changed = await send([{ ...original, payload: issuePayload('Another title') }]);
      expect(results(changed)[0]).toEqual({ idempotency_key: original.idempotency_key, status: 'rejected', code: 'IDEMPOTENCY_CONFLICT' });
      expect(carried.issues).toBe(before);
      expect((await receipts(original.idempotency_key))[0]).toMatchObject({ status: 'accepted' });
    });

    it('does not remember what may go away: a command whose operation failed is answered as refused for now, leaves no receipt, and is carried out when it is sent again', async () => {
      measurementsDown = true;
      const queued: Item = { idempotency_key: key(), command_type: 'measurement.record', base_server_version: 0, payload: { contract_id: CONTRACT, contract_revision_id: randomUUID(), boq_item_id: randomUUID(), period_id: randomUUID(), quantity_period: '4', reference_no: 'BB-01', evidence_refs: [{ document_version_id: randomUUID() }] } };
      const failed = await send([queued]);
      expect(results(failed)[0]).toMatchObject({ status: 'rejected', code: 'INTERNAL_ERROR' });
      expect(await receipts(queued.idempotency_key)).toEqual([]);
      expect((await lookup(queued.idempotency_key)).json).toEqual({ status: 'not_received' });
      measurementsDown = false;
      expect(results(await send([queued]))[0]).toMatchObject({ status: 'accepted' });
      expect((await lookup(queued.idempotency_key)).json).toMatchObject({ status: 'accepted', result_ref: CONTRACT });
    });

    it('keeps a key bound to its command even when the answer was lost: another command sent with the same key later is refused, not carried out', async () => {
      measurementsDown = true;
      const shared = key();
      const lost: Item = { idempotency_key: shared, command_type: 'measurement.record', base_server_version: 0, payload: { contract_id: CONTRACT, contract_revision_id: randomUUID(), boq_item_id: randomUUID(), period_id: randomUUID(), quantity_period: '4', reference_no: 'BB-02', evidence_refs: [{ document_version_id: randomUUID() }] } };
      expect(results(await send([lost]))[0]).toMatchObject({ status: 'rejected', code: 'INTERNAL_ERROR' });
      expect(await receipts(shared)).toEqual([]);
      expect(await rows('select command_type from machvon.sync_command_claim where idempotency_key = $1', [shared])).toEqual([{ command_type: 'measurement.record' }]);
      // The same key for another command: the first one may have been carried out, so this one is not.
      const before = carried.issues;
      const other: Item = { idempotency_key: shared, command_type: 'issue.create', base_server_version: 0, payload: issuePayload() };
      expect(results(await send([other]))[0]).toEqual({ idempotency_key: shared, status: 'rejected', code: 'IDEMPOTENCY_CONFLICT' });
      expect(carried.issues).toBe(before);
      expect(await receipts(shared)).toEqual([]);
      // The same command is still carried out when it is sent again.
      measurementsDown = false;
      expect(results(await send([lost]))[0]).toMatchObject({ status: 'accepted' });
    });

    it('judges each command again by the operation it stands for: a member without the right to create issues has the command refused, and it is remembered', async () => {
      const queued = issue();
      const before = carried.issues;
      const reply = await send([queued], { member: LIMITED });
      expect(results(reply)[0]).toEqual({ idempotency_key: queued.idempotency_key, status: 'rejected', code: 'SCOPE_DENIED' });
      expect(carried.issues).toBe(before);
      expect((await receipts(queued.idempotency_key))[0]).toMatchObject({ status: 'rejected', code: 'SCOPE_DENIED' });
    });

    it('refuses a command it cannot carry out as written, for good: a report id that is not a UUID, a diary that is not named', async () => {
      const bad: Item = { idempotency_key: key(), command_type: 'report.submit', base_server_version: 1, payload: { report_id: '../../system/tenants' } };
      expect(results(await send([bad]))[0]).toEqual({ idempotency_key: bad.idempotency_key, status: 'rejected', code: 'VALIDATION_FAILED' });
      expect((await receipts(bad.idempotency_key))[0]).toMatchObject({ status: 'rejected', code: 'VALIDATION_FAILED' });
      // A key the contract does not allow fails the request before anything is carried out.
      expect((await send([{ ...issue(), idempotency_key: 'too-short' }])).status).toBe(422);
      const odd: Item = { ...issue(), idempotency_key: `odd key ${randomUUID()}` };
      expect(results(await send([odd]))[0]).toEqual({ idempotency_key: odd.idempotency_key, status: 'rejected', code: 'VALIDATION_FAILED' });
      expect(await receipts(odd.idempotency_key)).toEqual([]);
    });
  });

  describe('two batches at the same moment', () => {
    it('carries a key out once: the same key sent as two different commands at once is one command and one refusal, never two effects', async () => {
      slowMs = 300;
      try {
        const shared = key();
        const asIssue: Item = { idempotency_key: shared, command_type: 'issue.create', base_server_version: 0, payload: issuePayload() };
        const asSubmit: Item = { idempotency_key: shared, command_type: 'report.submit', base_server_version: 1, payload: { report_id: randomUUID() } };
        const issuesBefore = carried.issues;
        const submitsBefore = [...carried.submits.values()].reduce((sum, count) => sum + count, 0);
        const [first, second] = await Promise.all([send([asIssue]), send([asSubmit])]);
        const outcomes = [results(first)[0], results(second)[0]];
        expect(outcomes.filter((result) => result?.status === 'accepted')).toHaveLength(1);
        expect(outcomes.filter((result) => result?.status === 'rejected' && result.code === 'IDEMPOTENCY_CONFLICT')).toHaveLength(1);
        const effects = carried.issues - issuesBefore + ([...carried.submits.values()].reduce((sum, count) => sum + count, 0) - submitsBefore);
        expect(effects).toBeLessThanOrEqual(1);
        expect(await receipts(shared)).toHaveLength(1);
      } finally {
        slowMs = 0;
      }
    });

    it('answers the same command sent twice at once with one effect and the same answer twice', async () => {
      slowMs = 300;
      try {
        const queued = issue();
        const before = carried.issues;
        const [first, second] = await Promise.all([send([queued]), send([queued])]);
        expect(results(first)).toEqual(results(second));
        expect(results(first)[0]).toMatchObject({ status: 'accepted' });
        expect(carried.issues - before).toBe(1);
      } finally {
        slowMs = 0;
      }
    });

    it('lets only as many batches run at once as there are slots, and the others wait their turn instead of being refused', async () => {
      slowMs = 150;
      try {
        carried.slotsSeen.length = 0;
        const replies = await Promise.all([send([issue()]), send([issue()]), send([issue()])]);
        expect(replies.map((reply) => reply.status)).toEqual([200, 200, 200]);
        expect(Math.max(...carried.slotsSeen)).toBeLessThanOrEqual(1);
        expect(slots.inUse).toBe(0);
      } finally {
        slowMs = 0;
      }
    });
  });

  describe('how long a receipt is kept', () => {
    it('keeps the idempotency record of a command a batch forwards for 7 days, as the queue, and not the 72 hours of an ordinary call; a client cannot ask for it', async () => {
      const queued = issue();
      await send([queued]);
      const lifetime = async (idempotencyKey: string): Promise<number> => {
        const [row] = await rows<{ days: number }>("select extract(epoch from (expires_at - created_at)) / 86400 as days from machvon.idempotency_record where operation = 'createIssue' order by created_at desc limit 1");
        void idempotencyKey;
        return Number(row?.days);
      };
      expect(await lifetime(queued.idempotency_key)).toBeGreaterThan(6.9);
      // An ordinary call, even with the header and a guess for the value, keeps its record 72 hours.
      const headers = { [TENANT_HEADER]: tokenOf(PHONE_USER), 'content-type': 'application/json', 'idempotency-key': `direct-${randomUUID()}`, 'x-machvon-sync-forward': 'a-guess' };
      const direct = await fetch(`${app.baseUrl}/issues`, { method: 'POST', headers, body: JSON.stringify(issuePayload()) });
      expect(direct.status).toBe(201);
      expect(await lifetime('direct')).toBeLessThan(3.1);
    });


    it('keeps a receipt 7 days: the purge of the idempotency records removes the older ones and leaves the others', async () => {
      const old = key();
      const fresh = key();
      for (const [idempotencyKey, age] of [[old, '8 days'], [fresh, '6 days']] as const) {
        await rows(
          `insert into machvon.sync_command_receipt (tenant_id, id, device_id, membership_id, idempotency_key, command_type, status, request_hash, received_at)
           values ($1, gen_random_uuid(), $2, $3, $4, 'issue.create', 'accepted', repeat('a', 64), now() - $5::interval)`,
          [TENANT_A, devices.get(OTHER_USER), memberId(OTHER_USER), idempotencyKey, age],
        );
      }
      const removed = await new IdempotencyStore(harness.tenants as TenantDatabase).purgeExpired({ tenantId: TENANT_A, membershipId: memberId(PHONE_USER), scopeVersion: 1 });
      expect(removed).toBeGreaterThanOrEqual(1);
      expect(await receipts(old)).toEqual([]);
      expect(await receipts(fresh)).toHaveLength(1);
    });
  });

  describe('who may send, and what a receipt may show', () => {
    it('is for the phone of the member who sends: another member’s device, a removed device and one that does not exist are 403, and so is a member without sync.submit', async () => {
      const mine = issue();
      expect((await send([mine], { device: devices.get(OTHER_USER) as string })).status).toBe(403);
      expect((await send([mine], { device: randomUUID() })).status).toBe(403);
      await rows('update machvon.device_registration set revoked_at = now(), push_secret_ref = null, revoke_reason = $2 where id = $1', [devices.get(LIMITED), 'USER_REVOKED']);
      expect((await send([mine], { member: LIMITED })).status).toBe(403);
      expect((await send([mine], { member: NOBODY })).status).toBe(403);
      expect(await receipts(mine.idempotency_key)).toEqual([]);
    });

    it('asks for 1 to 50 commands, and no batch for another tenant: a key sent as another member or tenant is not received', async () => {
      expect((await call('POST', '/sync/batches', { body: { device_id: devices.get(PHONE_USER), items: [] } })).status).toBe(422);
      const many = Array.from({ length: 51 }, () => issue());
      expect((await send(many)).status).toBe(422);
      const queued = issue();
      await send([queued]);
      expect((await lookup(queued.idempotency_key, OTHER_USER)).json).toEqual({ status: 'not_received' });
      expect((await lookup(queued.idempotency_key, OTHER_TENANT_USER, TENANT_B)).json).toEqual({ status: 'not_received' });
      expect((await lookup('short')).status).toBe(422);
    });

    it('keeps no payload: the receipt holds a hash of the command and its answer, and the audit row holds counts only', async () => {
      const queued = issue({ payload: issuePayload('A very distinctive title 7f3a') });
      await send([queued]);
      const [receipt] = await receipts(queued.idempotency_key);
      expect(receipt?.request_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(await rows('select * from machvon.sync_command_receipt where idempotency_key = $1', [queued.idempotency_key]))).not.toContain('distinctive');
      const audit = await rows<{ safe_diff: Record<string, unknown> }>("select safe_diff from machvon.audit_event where action = 'sync.batch_submitted' order by occurred_at desc limit 1");
      expect(audit[0]?.safe_diff).toMatchObject({ items: 1, accepted: 1, conflict: 0, rejected: 0 });
      expect(JSON.stringify(audit)).not.toContain(queued.idempotency_key);
    });

    it('writes a receipt once and never changes it', async () => {
      const queued = issue();
      await send([queued]);
      await expect(rows("update machvon.sync_command_receipt set status = 'rejected' where idempotency_key = $1", [queued.idempotency_key])).rejects.toThrow(/written once/);
    });

    it('tells the platform of an accepted and of a refused command once, and of a conflict not at all', async () => {
      const accepted = issue();
      const refused = submitReport(LOCKED_REPORT, 1);
      await send([accepted, refused]);
      await send([accepted, refused]);
      const events = await rows<{ type: string; payload: Record<string, unknown> }>("select type, payload from machvon.outbox_event where type like 'sync.command_%' and payload->>'idempotency_key' = any($1)", [[accepted.idempotency_key, refused.idempotency_key]]);
      expect(events.map((event) => event.type).sort()).toEqual(['sync.command_accepted.v1', 'sync.command_rejected.v1']);
      expect(JSON.stringify(events)).not.toContain('title');
    });
  });
});

describe('the slots that bound the batches', () => {
  it('gives a slot to each of the first, makes the others wait, and passes a freed slot on in order', async () => {
    const small = new BatchSlots(2, 1_000);
    const first = await small.acquire();
    const second = await small.acquire();
    expect(small.inUse).toBe(2);
    const order: string[] = [];
    const third = small.acquire().then((release) => {
      order.push('third');
      return release;
    });
    const fourth = small.acquire().then((release) => {
      order.push('fourth');
      return release;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(order).toEqual([]);
    first();
    (await third)();
    second();
    (await fourth)();
    expect(order).toEqual(['third', 'fourth']);
    expect(small.inUse).toBe(0);
  });

  it('gives a slot back once however often it is returned, and refuses with 503 the one that waited too long', async () => {
    const small = new BatchSlots(1, 100);
    const release = await small.acquire();
    release();
    release();
    expect(small.inUse).toBe(0);
    const held = await small.acquire();
    await expect(small.acquire()).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', status: 503 });
    // The one that gave up took nothing with it: the slot is free again when the holder returns it.
    held();
    expect(small.inUse).toBe(0);
    (await small.acquire())();
  });
});

describe('the slots when a client goes away', () => {
  it('keeps the slot of a batch that is still working after its client has gone, and gives it back when the work is over', async () => {
    const small = new BatchSlots(1, 2_000);
    const guard = new SyncSlotGuard(small);
    const interceptor = new SyncSlotInterceptor();
    const listeners: Array<() => void> = [];
    const request: Record<string, unknown> = {};
    const context = { switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ once: (_event: string, listener: () => void) => listeners.push(listener) }) }) } as never;
    expect(await guard.canActivate(context)).toBe(true);
    expect(small.inUse).toBe(1);
    let finish: () => void = () => undefined;
    const { Observable } = await import('rxjs');
    const work = new Observable<string>((subscriber) => {
      finish = () => {
        subscriber.next('done');
        subscriber.complete();
      };
    });
    const running = interceptor.intercept(context, { handle: () => work }).subscribe();
    // The client closes the connection; the batch has begun, so the slot stays with it.
    for (const listener of listeners) listener();
    expect(small.inUse).toBe(1);
    finish();
    running.unsubscribe();
    expect(small.inUse).toBe(0);
  });

  it('gives the slot back when the work never begins, and when the client goes away while it waits', async () => {
    const small = new BatchSlots(1, 2_000);
    const guard = new SyncSlotGuard(small);
    const fake = () => {
      const listeners: Array<() => void> = [];
      const context = { switchToHttp: () => ({ getRequest: () => ({}), getResponse: () => ({ once: (_event: string, listener: () => void) => listeners.push(listener) }) }) } as never;
      return { context, close: () => listeners.forEach((listener) => listener()) };
    };
    const first = fake();
    expect(await guard.canActivate(first.context)).toBe(true);
    // Refused before the handler: the response closes and the slot goes back.
    first.close();
    expect(small.inUse).toBe(0);
    // Another holds the slot; a second client waits and goes away before it is its turn.
    const holder = fake();
    await guard.canActivate(holder.context);
    const waiter = fake();
    const waiting = guard.canActivate(waiter.context);
    waiter.close();
    holder.close();
    await expect(waiting).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(small.inUse).toBe(0);
  });
});

describe('the credentials a batch hands to the calls it makes', () => {
  it('copies the credentials and the context of the batch and drops what belongs to that one request', () => {
    expect(
      forwardedHeaders({
        authorization: 'Bearer abc',
        'X-Custom-Context': 'tenant-a',
        host: 'evil.example',
        'content-length': '12',
        'content-type': 'application/json',
        'idempotency-key': 'batch-key',
        'if-match': '"3"',
        'accept-encoding': 'gzip',
        connection: 'keep-alive',
        cookie: ['a=1', 'b=2'],
        missing: undefined,
      }),
    ).toEqual({ authorization: 'Bearer abc', 'x-custom-context': 'tenant-a', cookie: 'a=1, b=2' });
  });
});
