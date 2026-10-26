import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { ctrModule } from '../../src/modules/ctr';
import { RetentionController, RetentionReadsController } from '../../src/modules/ctr/retention.controller';
import { TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { AcceptanceWorld } from '../../../../packages/db/test/support/acceptance-fixtures';
import { adminStatement, settledPayment } from '../../../../packages/db/test/support/settled-payment';
import type { SettledPayment } from '../../../../packages/db/test/support/settled-payment';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(600_000);

const SIGNING_KEY = randomBytes(32);
const ROOT = 1;
const MAKER = 61;
const SENDER = 62; // sends the payment request: the retention is held in this name
const CHECKER = 63;
const MATCHER = 64;
const ACCOUNTANT = 71; // retention.release, ledger.read
const OFFICER = 72; // ledger.read: a contract officer without the right to release
const READER = 73; // ledger.read
const NOBODY = 74;
const ELSEWHERE = 75; // the rights of the accountant over another project
const GUEST = 76; // a guest contractor, whatever the grant
const FOREIGN = 77; // a member of another tenant with every right over the retention of that tenant
const MEMBERS = [MAKER, SENDER, CHECKER, MATCHER, ACCOUNTANT, OFFICER, READER, NOBODY, ELSEWHERE, GUEST];

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

interface HoldRow {
  id: string;
  held_vnd: string;
  released_vnd: string;
  status: string;
  version: string;
  boq_key: string;
}

describe('the release of the retention over HTTP (ST-CTR-010, AC-ST-CTR-010-1, AC-ST-CTR-010-2, UAT-AC309, UAT-AC397)', () => {
  const fixtures = new AcceptanceWorld();
  const harness = fixtures.harness;
  let app: RunningApp;
  let otherProject = '';

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: string, url: string, options: { member: number; body?: unknown; ifMatch?: string; key?: string; tenant?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenant), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  const rows = <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => fixtures.owner<R>(sql, params);
  const holdsOf = (contractId: string) =>
    rows<HoldRow>(
      `select h.id, h.held_vnd::text as held_vnd, h.released_vnd::text as released_vnd, h.status, h.version::text as version, i.business_key as boq_key
         from machvon.retention_hold h join machvon.boq_item i on i.id = h.boq_item_id where h.contract_id = $1::uuid order by i.business_key`,
      [contractId],
    );
  const audits = (resourceId: string) =>
    rows<{ safe_diff: Record<string, unknown>; actor_id: string }>(
      "select safe_diff, actor_id from machvon.audit_event where resource_id = $1 and action = 'retention.released' order by occurred_at, id",
      [resourceId],
    );
  const events = (aggregateId: string) =>
    rows<{ payload: Record<string, unknown> }>("select payload from machvon.outbox_event where aggregate_id = $1 and type = 'ctr.retention.released.v1' order by created_at, id", [aggregateId]);
  const ledgerEntries = (contractId: string) => rows("select id from machvon.cumulative_ledger_entry where contract_id = $1::uuid and entry_kind = 'RETENTION_RELEASE'", [contractId]);
  const contractRow = async (contractId: string) =>
    (await rows<{ held: string; released: string }>('select retention_held_vnd::text as held, retention_released_vnd::text as released from machvon.contract where id = $1::uuid', [contractId]))[0];

  /** A contract with a payment settled: 150m held back, 100m on B01 and 50m on B02, both until the end of the warranty. */
  async function paid(): Promise<{ payment: SettledPayment; b01: HoldRow; b02: HoldRow }> {
    const payment = await settledPayment(fixtures, { maker: MAKER, sender: SENDER, checker: CHECKER, matcher: MATCHER });
    await adminStatement(fixtures, "update machvon.retention_hold set release_condition = 'WARRANTY_END' where contract_id = $1::uuid", [payment.contractId]);
    const holds = await holdsOf(payment.contractId);
    const b01 = holds.find((hold) => hold.boq_key === 'B01');
    const b02 = holds.find((hold) => hold.boq_key === 'B02');
    if (b01 === undefined || b02 === undefined) throw new Error('the fixture holds no retention');
    return { payment, b01, b02 };
  }

  const warranty = (contractId: string, status: 'ACTIVE' | 'CLOSED') =>
    adminStatement(
      fixtures,
      `insert into machvon.warranty_obligation
         (tenant_id, id, project_id, contract_id, handover_id, scope_description, starts_on, ends_on, period_months, retention_amount_vnd, status, created_by, updated_by, closed_by, closed_at)
       values ($1, gen_random_uuid(), $2, $3, gen_random_uuid(), 'Whole work', date '2026-01-01', date '2027-01-01', 12, 1, $4, $5, $5, case when $4 = 'CLOSED' then $5::uuid end, case when $4 = 'CLOSED' then now() end)`,
      [TENANT_A, fixtures.projectId, contractId, status, memberId(MAKER)],
    );
  const closeWarranty = (contractId: string) =>
    adminStatement(fixtures, "update machvon.warranty_obligation set status = 'CLOSED', closed_by = $2::uuid, closed_at = now() where contract_id = $1::uuid", [contractId, memberId(MAKER)]);

  const release = (member: number, hold: HoldRow, body: Record<string, unknown> = {}, options: { version?: number | string; key?: string } = {}) =>
    call('POST', `/retention-holds/${hold.id}/release`, {
      member,
      ifMatch: `"${options.version ?? hold.version}"`,
      ...(options.key === undefined ? {} : { key: options.key }),
      body: { amount_vnd: hold.held_vnd, reason: 'The warranty has ended.', ...body },
    });

  beforeAll(async () => {
    await fixtures.start();
    for (const n of MEMBERS) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedRole(TENANT_A, 701, 'RET_ACCOUNTANT', ['retention.release', 'ledger.read'], 40);
    await harness.seedRole(TENANT_A, 702, 'RET_OFFICER', ['ledger.read'], 30);
    await fixtures.owner("update machvon.membership set membership_type = 'GUEST_CONTRACTOR', contractor_id = $2::uuid, valid_until = now() + interval '1 year' where id = $1::uuid", [
      memberId(GUEST),
      fixtures.contractorId,
    ]);
    await adminStatement(fixtures, "update machvon.project set status = 'IMPLEMENTATION', project_group = 'B' where id = $1::uuid", [fixtures.projectId]);
    const other = await fixtures.world.publishedLine({ allocated: '1000000000' });
    otherProject = other.projectId;
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: ACCOUNTANT, role: 701, kind: 'TENANT' },
      { n: 2, member: SENDER, role: 701, kind: 'TENANT' },
      { n: 3, member: OFFICER, role: 702, kind: 'TENANT' },
      { n: 4, member: READER, role: 702, kind: 'TENANT' },
      { n: 5, member: ELSEWHERE, role: 701, kind: 'PROJECT', refs: [otherProject] },
      { n: 6, member: GUEST, role: 701, kind: 'TENANT' },
    ]);
    await harness.seedUnits(TENANT_B, [{ n: ROOT, path: `/${unitId(ROOT)}/` }]);
    await harness.seedMembership(TENANT_B, FOREIGN, ROOT);
    await harness.seedRole(TENANT_B, 701, 'RET_ACCOUNTANT', ['retention.release', 'ledger.read'], 40);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: FOREIGN, role: 701, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [RetentionController, RetentionReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 600_000);

  afterAll(async () => {
    if (app) await app.close();
    await fixtures.stop();
  }, 60_000);

  it('is registered in the module of CTR', () => {
    expect(ctrModule.controllers).toEqual(expect.arrayContaining([RetentionController, RetentionReadsController]));
  });

  describe('releaseRetention (AC-ST-CTR-010-1, UAT-AC309)', () => {
    it('AC-ST-CTR-010-1, UAT-AC309: refuses a caller without the right, then a warranty that is open, then more than is held, and releases B01 on the exact amount, leaving B02 held', async () => {
      const { payment, b01, b02 } = await paid();
      await warranty(payment.contractId, 'ACTIVE');
      expect(await release(OFFICER, b01)).toMatchObject({ status: 403 });
      expect(await release(NOBODY, b01)).toMatchObject({ status: 403 });
      expect(await release(ACCOUNTANT, b01)).toMatchObject({ status: 422, json: { code: 'RELEASE_CONDITION_NOT_MET', condition: 'WARRANTY_END', reason: 'WARRANTY_OPEN', open_obligations: 1 } });
      await closeWarranty(payment.contractId);
      expect(await release(ACCOUNTANT, b01, { amount_vnd: '100000001' })).toMatchObject({ status: 422, json: { code: 'RELEASE_EXCEEDS_HELD', held_vnd: '100000000', left_vnd: '100000000' } });
      expect(await holdsOf(payment.contractId)).toEqual([expect.objectContaining({ boq_key: 'B01', status: 'HELD', released_vnd: '0' }), expect.objectContaining({ boq_key: 'B02', status: 'HELD' })]);

      const done = await release(ACCOUNTANT, b01, { amount_vnd: '100000000' });
      expect(done).toMatchObject({ status: 200, json: { status: 'RELEASED', resource_version: 2, resource_id: b01.id } });
      expect(await holdsOf(payment.contractId)).toEqual([
        expect.objectContaining({ boq_key: 'B01', status: 'RELEASED', released_vnd: '100000000', held_vnd: '100000000', version: '2' }),
        expect.objectContaining({ boq_key: 'B02', status: 'HELD', released_vnd: '0', held_vnd: '50000000', version: '1' }),
      ]);
      expect(await contractRow(payment.contractId)).toEqual({ held: '150000000', released: '100000000' });
      expect(b02.held_vnd).toBe('50000000');
      expect((await audits(b01.id))[0]).toMatchObject({
        actor_id: memberId(ACCOUNTANT),
        safe_diff: {
          from_status: 'HELD',
          to_status: 'RELEASED',
          amount_vnd: '100000000',
          released_vnd: '100000000',
          held_vnd: '100000000',
          release_condition: 'WARRANTY_END',
          contract_retention_released_vnd: '100000000',
          contract_id: payment.contractId,
        },
      });
      expect((await events(b01.id))[0]?.payload).toMatchObject({
        hold_id: b01.id,
        contract_id: payment.contractId,
        boq_item_id: expect.any(String),
        amount_vnd: '100000000',
        status: 'RELEASED',
        from_status: 'HELD',
        version: 2,
        actor_id: memberId(ACCOUNTANT),
      });
      expect(await ledgerEntries(payment.contractId)).toHaveLength(1);
    });

    it('AC-ST-CTR-010-2, AC-ST-CTR-013-2, UAT-AC397: answers the same key with the first body and writes nothing twice; a new key after the success has nothing left to release; the same key with another body is a conflict', async () => {
      const { payment, b01 } = await paid();
      await warranty(payment.contractId, 'CLOSED');
      const send = () => release(ACCOUNTANT, b01, { amount_vnd: '100000000' }, { key: 'release-once-for-this-key' });
      const first = await send();
      expect(first).toMatchObject({ status: 200, json: { status: 'RELEASED', resource_version: 2 } });
      expect(await send()).toEqual(first);
      expect(await audits(b01.id)).toHaveLength(1);
      expect(await events(b01.id)).toHaveLength(1);
      expect(await ledgerEntries(payment.contractId)).toHaveLength(1);
      expect(await release(ACCOUNTANT, b01, { amount_vnd: '99999999' }, { key: 'release-once-for-this-key' })).toMatchObject({ status: 409, json: { code: 'IDEMPOTENCY_CONFLICT' } });
      // A new key with the version the screen showed: the hold has nothing left, and that is the answer.
      expect(await release(ACCOUNTANT, b01, { amount_vnd: '100000000' })).toMatchObject({ status: 422, json: { code: 'RELEASE_EXCEEDS_HELD', left_vnd: '0' } });
      expect(await audits(b01.id)).toHaveLength(1);
      expect(await ledgerEntries(payment.contractId)).toHaveLength(1);
      expect(await contractRow(payment.contractId)).toEqual({ held: '150000000', released: '100000000' });
    });

    it('does not let whoever sent the payment release what was held from it, even holding the right', async () => {
      const { payment, b01 } = await paid();
      await warranty(payment.contractId, 'CLOSED');
      expect(await release(SENDER, b01)).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
      expect(await holdsOf(payment.contractId)).toEqual([expect.objectContaining({ status: 'HELD' }), expect.objectContaining({ status: 'HELD' })]);
      expect(await audits(b01.id)).toEqual([]);
    });

    it('refuses a stale version, what is badly formed, a field it does not know and a hold outside the scope', async () => {
      const { payment, b01 } = await paid();
      await warranty(payment.contractId, 'CLOSED');
      expect(await release(ACCOUNTANT, b01, {}, { version: 9 })).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
      expect(await release(ACCOUNTANT, b01, { amount_vnd: '12.5' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await release(ACCOUNTANT, b01, { amount_vnd: '0' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await release(ACCOUNTANT, b01, { reason: undefined })).toMatchObject({ status: 400, json: { code: 'INVALID_REQUEST' } });
      expect(await release(ACCOUNTANT, b01, { released_by: memberId(ACCOUNTANT) })).toMatchObject({ status: 400, json: { code: 'FIELD_NOT_ALLOWED' } });
      expect(await release(ACCOUNTANT, { ...b01, id: randomUUID() })).toMatchObject({ status: 404, json: { code: 'RESOURCE_NOT_FOUND' } });
      expect(await release(ELSEWHERE, b01)).toMatchObject({ status: 404 });
      expect(await holdsOf(payment.contractId)).toEqual([expect.objectContaining({ status: 'HELD', released_vnd: '0' }), expect.objectContaining({ status: 'HELD' })]);
    });
  });

  describe('listRetentionHolds', () => {
    it('lists the holds of the contract with the totals, the condition and what each person may do', async () => {
      const { payment, b01, b02 } = await paid();
      const url = `/contracts/${payment.contractId}/retention-holds`;
      const before = await call('GET', url, { member: READER });
      expect(before.status).toBe(200);
      expect(before.json.contract).toMatchObject({ id: payment.contractId, status: 'ACTIVE', retention_held_vnd: '150000000', retention_released_vnd: '0' });
      const items = before.json.items as Array<Record<string, unknown>>;
      expect(items).toHaveLength(2);
      expect(items.find((item) => item.id === b01.id)).toMatchObject({
        boq_item: { key: 'B01' },
        held_vnd: '100000000',
        released_vnd: '0',
        left_vnd: '100000000',
        release_condition: 'WARRANTY_END',
        release_not_before: null,
        status: 'HELD',
        condition: { met: false, reason: 'NO_WARRANTY' },
        allowed: { release: false },
        version: 1,
      });
      // The accountant may release; the condition says why not yet, until the warranty is closed.
      expect(((await call('GET', url, { member: ACCOUNTANT })).json.items as Array<Record<string, unknown>>).every((item) => (item.allowed as { release: boolean }).release)).toBe(true);
      await warranty(payment.contractId, 'CLOSED');
      await release(ACCOUNTANT, b01, { amount_vnd: '40000000' });
      const after = (await call('GET', url, { member: ACCOUNTANT })).json;
      expect(after.contract).toMatchObject({ retention_released_vnd: '40000000' });
      expect((after.items as Array<Record<string, unknown>>).find((item) => item.id === b01.id)).toMatchObject({
        status: 'PARTIALLY_RELEASED',
        released_vnd: '40000000',
        left_vnd: '60000000',
        condition: { met: true, reason: null },
        release_reason: 'The warranty has ended.',
        allowed: { release: true },
      });
      expect((after.items as Array<Record<string, unknown>>).find((item) => item.id === b02.id)).toMatchObject({ status: 'HELD', condition: { met: true, reason: null } });
      expect(Object.keys((after.items as Array<Record<string, unknown>>)[0] ?? {}).sort()).toEqual(
        [
          'acceptance_id',
          'allowed',
          'boq_item',
          'condition',
          'created_at',
          'decision_document_version_id',
          'held_vnd',
          'id',
          'left_vnd',
          'party_id',
          'payment_request_id',
          'release_condition',
          'release_not_before',
          'release_reason',
          'released_at',
          'released_vnd',
          'status',
          'version',
        ].sort(),
      );
    });

    it('filters by status, pages with a cursor, and refuses a filter that is not one', async () => {
      const { payment, b01 } = await paid();
      await warranty(payment.contractId, 'CLOSED');
      await release(ACCOUNTANT, b01, { amount_vnd: '100000000' });
      const url = `/contracts/${payment.contractId}/retention-holds`;
      expect(((await call('GET', `${url}?status=RELEASED`, { member: READER })).json.items as Array<{ id: string }>).map((item) => item.id)).toEqual([b01.id]);
      expect(((await call('GET', `${url}?status=HELD`, { member: READER })).json.items as unknown[]).length).toBe(1);
      const page = await call('GET', `${url}?limit=1`, { member: READER });
      expect((page.json.items as unknown[]).length).toBe(1);
      const next = await call('GET', `${url}?limit=1&cursor=${page.json.next_cursor as string}`, { member: READER });
      expect((next.json.items as unknown[]).length).toBe(1);
      expect(next.json.next_cursor).toBeNull();
      expect((await call('GET', `${url}?status=GONE`, { member: READER })).status).toBe(422);
      expect((await call('GET', `${url}?status=A&status=B`, { member: READER })).status).toBe(422);
      expect((await call('GET', `${url}?limit=0`, { member: READER })).status).toBe(422);
    });

    it('is for the staff who hold the right over the contract: not for a guest contractor, nor for whoever holds none, and not for a contract out of scope or in another tenant', async () => {
      const { payment } = await paid();
      const url = `/contracts/${payment.contractId}/retention-holds`;
      expect((await call('GET', url, { member: GUEST })).status).toBe(403);
      expect((await call('GET', url, { member: NOBODY })).status).toBe(403);
      expect((await call('GET', url, { member: ELSEWHERE })).status).toBe(404);
      expect((await call('GET', `/contracts/${randomUUID()}/retention-holds`, { member: READER })).status).toBe(404);
      expect((await call('GET', url, { member: FOREIGN, tenant: TENANT_B })).status).toBe(404);
    });
  });

  describe('another tenant (UAT-AC395)', () => {
    it('does not release the retention of the first tenant, whatever its rights in its own', async () => {
      const { payment, b01 } = await paid();
      await warranty(payment.contractId, 'CLOSED');
      expect(await call('POST', `/retention-holds/${b01.id}/release`, { member: FOREIGN, tenant: TENANT_B, ifMatch: '"1"', body: { amount_vnd: '1', reason: 'attempt' } })).toMatchObject({
        status: 404,
      });
      expect(await holdsOf(payment.contractId)).toEqual([expect.objectContaining({ status: 'HELD', released_vnd: '0' }), expect.objectContaining({ status: 'HELD' })]);
    });
  });
});
