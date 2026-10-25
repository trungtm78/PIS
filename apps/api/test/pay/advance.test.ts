import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { payModule } from '../../src/modules/pay';
import { AdvanceController, AdvanceReadsController } from '../../src/modules/pay/advance.controller';
import { TENANT_A, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { AcceptanceWorld } from '../../../../packages/db/test/support/acceptance-fixtures';
import type { SeededContract } from '../../../../packages/db/test/support/acceptance-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(480_000);

const SIGNING_KEY = randomBytes(32);
const ROOT = 1;
const MAKER = 11; // advance.request, advance.cancel, advance.read
const RECOVERER = 12; // advance.recover, advance.read
const READER = 13; // advance.read
const NOBODY = 14;
const ELSEWHERE = 15; // the rights of MAKER over another branch
const MEMBERS = [MAKER, RECOVERER, READER, NOBODY, ELSEWHERE];
const OTHER_BRANCH = 5;

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the advance of a contract over HTTP (ST-PAY-004)', () => {
  const fixtures = new AcceptanceWorld();
  const harness = fixtures.harness;
  let app: RunningApp;

  const tokenOf = (member: number): string => signTenantContext({ tenantId: TENANT_A, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  async function call(method: string, url: string, options: { member: number; body?: unknown; ifMatch?: string; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  const rows = <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => fixtures.owner<R>(sql, params);
  const audits = (resourceId: string, action: string) => rows<{ safe_diff: Record<string, unknown>; actor_id: string; reason: string | null }>('select safe_diff, actor_id, reason from machvon.audit_event where resource_id = $1 and action = $2 order by occurred_at, id', [resourceId, action]);
  const events = (aggregateId: string, type: string) => rows<{ payload: Record<string, unknown>; aggregate_version: string }>('select payload, aggregate_version::text as aggregate_version from machvon.outbox_event where aggregate_id = $1 and type = $2 order by created_at, id', [aggregateId, type]);
  const advancesOf = (contractId: string) => rows<{ id: string; status: string }>('select id, status from machvon.contract_advance where contract_id = $1::uuid order by tranche_no', [contractId]);

  /** A contract being performed in the category given, worth 10bn, with a verified advance guarantee of 5bn. */
  async function contractOf(category = 'CONSTRUCTION', value = '10000000000'): Promise<SeededContract> {
    const contract = await fixtures.seedContract();
    await rows('update machvon.contract set advance_category = $2, contract_value_vnd = $3::numeric where id = $1::uuid', [contract.contractId, category, value]);
    await rows('update machvon.contract_party set work_value_vnd = $2::numeric where contract_id = $1::uuid', [contract.contractId, value]);
    const paper = (await fixtures.documentVersion()).id;
    await rows(
      `insert into machvon.guarantee
         (tenant_id, id, contract_id, kind, issuer, guarantee_no, amount_vnd, currency, valid_from, expires_at, status, verification_status, document_version_id, verified_by, verified_at, verification_method,
          verification_evidence_id, created_by, updated_by)
       values ($1, gen_random_uuid(), $2::uuid, 'ADVANCE', 'Bank', $3, 5000000000, 'VND', date '2026-01-02', now() + interval '1 year', 'ACTIVE', 'VERIFIED', $4::uuid, $5::uuid, now(), 'BANK_CONFIRMATION', $4::uuid, $6::uuid, $6::uuid)`,
      [TENANT_A, contract.contractId, `BL-${randomUUID().slice(0, 8)}`, paper, memberId(RECOVERER), memberId(MAKER)],
    );
    return contract;
  }
  const requestBody = (contract: SeededContract, amount: string, overrides: Record<string, unknown> = {}) => ({ party_id: contract.partyId, kind: 'CONTRACT', amount_vnd: amount, allocation_line_id: fixtures.lineId, ...overrides });
  const request = (member: number, contract: SeededContract, amount: string, overrides: Record<string, unknown> = {}, key?: string) =>
    call('POST', `/contracts/${contract.contractId}/advances`, { member, ...(key === undefined ? {} : { key }), body: requestBody(contract, amount, overrides) });
  const cancel = (member: number, id: string, version: number | string, reason = 'The advance is not needed.') => call('POST', `/advances/${id}/cancel`, { member, ifMatch: `"${version}"`, body: { reason } });
  const recover = async (member: number, id: string, version: number | string, amount: string, overrides: Record<string, unknown> = {}) =>
    call('POST', `/advances/${id}/recoveries`, { member, ifMatch: `"${version}"`, body: { amount_vnd: amount, basis: 'REFUND', evidence_document_version_id: (await fixtures.documentVersion()).id, ...overrides } });

  /** An advance of 2bn that is paid, 750m of it recovered already: what the Treasury will leave. */
  async function paidAdvance(contract: SeededContract): Promise<string> {
    const planned = await request(MAKER, contract, '2000000000', { kind: 'GPMB' });
    const id = planned.json.resource_id as string;
    await rows("update machvon.contract_advance set status = 'REQUESTED' where id = $1::uuid", [id]);
    await rows("update machvon.contract_advance set status = 'PAID', paid_vnd = 2000000000, paid_on = date '2026-07-01', recovery_deadline = date '2026-07-31' where id = $1::uuid", [id]);
    await rows("update machvon.contract_advance set status = 'RECOVERING', recovered_vnd = 750000000 where id = $1::uuid", [id]);
    await rows('update machvon.contract set advance_paid_vnd = 2000000000, advance_recovered_vnd = 750000000 where id = $1::uuid', [contract.contractId]);
    return id;
  }

  beforeAll(async () => {
    await fixtures.start();
    await harness.seedUnits(TENANT_A, [{ n: OTHER_BRANCH, path: `/${unitId(OTHER_BRANCH)}/` }]);
    for (const n of MEMBERS) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedRole(TENANT_A, 101, 'ADV_MAKER', ['advance.request', 'advance.cancel', 'advance.read'], 30);
    await harness.seedRole(TENANT_A, 102, 'ADV_RECOVERER', ['advance.recover', 'advance.read'], 40);
    await harness.seedRole(TENANT_A, 103, 'ADV_READER', ['advance.read'], 10);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: MAKER, role: 101, kind: 'TENANT' },
      { n: 2, member: RECOVERER, role: 102, kind: 'TENANT' },
      { n: 3, member: READER, role: 103, kind: 'TENANT' },
      { n: 4, member: ELSEWHERE, role: 101, kind: 'UNIT_SUBTREE', refs: [unitId(OTHER_BRANCH)] },
    ]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [AdvanceController, AdvanceReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 480_000);

  afterAll(async () => {
    if (app) await app.close();
    await fixtures.stop();
  }, 60_000);

  it('is registered in the module of PAY', () => {
    expect(payModule.controllers).toEqual(expect.arrayContaining([AdvanceController, AdvanceReadsController]));
  });

  it('AC-ST-PAY-004-1, UAT-AC325: plans the advance of a contract in force under a guarantee; the same key answers the same, audited and told once', async () => {
    const contract = await contractOf();
    const planned = await request(MAKER, contract, '1000000000', {}, 'advance-once-for-this-key');
    expect(planned).toMatchObject({
      status: 200,
      json: { status: 'PLANNED', resource_version: 1, amount_vnd: '1000000000', cap_vnd: '2000000000', cap_pct: '20', paid_vnd: '0', recovered_vnd: '0', outstanding_vnd: '0' },
    });
    expect(planned.json.cap_rule_version_id).toEqual(expect.any(String));
    // The rule is a fixture waiting for its confirmation, and the caller is told.
    expect(planned.json.warnings).toEqual([{ code: 'RULE_AWAITING_CONFIRMATION', detail: { cxn: 'CXN-02', cap_rule_version_id: planned.json.cap_rule_version_id } }]);
    expect(await request(MAKER, contract, '1000000000', {}, 'advance-once-for-this-key')).toEqual(planned);
    const id = planned.json.resource_id as string;
    expect(await advancesOf(contract.contractId)).toEqual([{ id, status: 'PLANNED' }]);
    const [audit] = await audits(id, 'advance.planned');
    expect(audit).toMatchObject({ actor_id: memberId(MAKER), safe_diff: { from_status: null, to_status: 'PLANNED', contract_id: contract.contractId, amount_vnd: '1000000000', cap_vnd: '2000000000', kind: 'CONTRACT', tranche_no: 1 } });
    const told = await events(id, 'pay.advance.planned.v1');
    expect(told).toHaveLength(1);
    expect(told[0]?.payload).toMatchObject({ advance_id: id, contract_id: contract.contractId, status: 'PLANNED', amount_vnd: '1000000000', version: 1, actor_id: memberId(MAKER) });
    // The cap is the server's: no API takes it, nor the status, nor what was paid.
    for (const field of ['cap_vnd', 'status', 'paid_vnd', 'cap_rule_version_id']) {
      expect(await request(MAKER, contract, '1000', { [field]: field === 'status' ? 'PAID' : '1' })).toMatchObject({ status: 400, json: { code: 'FIELD_NOT_ALLOWED' } });
    }
  });

  it('refuses in words what the conditions refuse: a contract not in force, a guarantee, the cap, the rule', async () => {
    const early = await contractOf();
    await rows("update machvon.contract set effective_from = date '2099-01-01' where id = $1::uuid", [early.contractId]);
    expect(await request(MAKER, early, '1000')).toMatchObject({ status: 422, json: { code: 'ADVANCE_CONTRACT_NOT_EFFECTIVE' } });
    const bare = await fixtures.seedContract();
    await rows("update machvon.contract set advance_category = 'CONSTRUCTION', contract_value_vnd = 10000000000 where id = $1::uuid", [bare.contractId]);
    await rows('update machvon.contract_party set work_value_vnd = 10000000000 where contract_id = $1::uuid', [bare.contractId]);
    expect(await request(MAKER, bare, '1000')).toMatchObject({ status: 422, json: { code: 'ADVANCE_GUARANTEE_REQUIRED', reason: 'NO_GUARANTEE' } });

    const capped = await contractOf();
    const over = await request(MAKER, capped, '2000000001');
    expect(over).toMatchObject({ status: 422, json: { code: 'ADVANCE_CAP_EXCEEDED', cap_vnd: '2000000000', cap_pct: '20', rule_awaiting_confirmation: true, cxn: 'CXN-02' } });
    expect(await advancesOf(capped.contractId)).toEqual([]);
    expect((await request(MAKER, capped, '2000000000')).status).toBe(200);

    const equipment = await contractOf('EQUIPMENT');
    expect(await request(MAKER, equipment, '1000')).toMatchObject({ status: 422, json: { code: 'ADVANCE_RULE_UNCONFIRMED', reason: 'NO_RULE' } });
    expect(await request(MAKER, capped, '0')).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
    expect(await call('POST', `/contracts/${randomUUID()}/advances`, { member: MAKER, body: requestBody(capped, '1000') })).toMatchObject({ status: 404 });
  });

  it('keeps the people apart: who may ask, who may cancel, who may recover, who may read, who may not see (UAT-AC325 authorization)', async () => {
    const contract = await contractOf();
    expect(await request(READER, contract, '1000')).toMatchObject({ status: 403 });
    expect(await request(RECOVERER, contract, '1000')).toMatchObject({ status: 403 });
    expect(await request(NOBODY, contract, '1000')).toMatchObject({ status: 403 });
    expect(await request(ELSEWHERE, contract, '1000')).toMatchObject({ status: 404 });
    const planned = await request(MAKER, contract, '1000000000');
    const id = planned.json.resource_id as string;
    expect(await cancel(READER, id, 1)).toMatchObject({ status: 403 });
    expect(await cancel(ELSEWHERE, id, 1)).toMatchObject({ status: 404 });
    expect(await advancesOf(contract.contractId)).toEqual([{ id, status: 'PLANNED' }]);
    expect(await call('GET', `/advances/${id}/recovery-plan`, { member: NOBODY })).toMatchObject({ status: 403 });
    expect(await call('GET', `/advances/${id}/recovery-plan`, { member: ELSEWHERE })).toMatchObject({ status: 404 });
    expect(await call('GET', '/advances', { member: NOBODY })).toMatchObject({ status: 403 });
  });

  it('cancels a planned advance with the version, once, audited and told once, and gives the cap back', async () => {
    const contract = await contractOf();
    const planned = await request(MAKER, contract, '1500000000');
    const id = planned.json.resource_id as string;
    expect(await cancel(MAKER, id, 5)).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
    expect(await call('POST', `/advances/${id}/cancel`, { member: MAKER, ifMatch: '"1"', body: { reason: '  ' } })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
    const done = await cancel(MAKER, id, 1);
    expect(done).toMatchObject({ status: 200, json: { status: 'CANCELLED', resource_version: 2 } });
    const [audit] = await audits(id, 'advance.cancelled');
    expect(audit).toMatchObject({ actor_id: memberId(MAKER), reason: 'The advance is not needed.', safe_diff: { from_status: 'PLANNED', to_status: 'CANCELLED' } });
    expect(await events(id, 'pay.advance.cancelled.v1')).toHaveLength(1);
    expect(await cancel(MAKER, id, 2)).toMatchObject({ status: 409, json: { code: 'ADVANCE_STATE_INVALID' } });
    expect((await request(MAKER, contract, '2000000000')).status).toBe(200);
  });

  it('AC-ST-PAY-004-4, UAT-AC61: records a recovery outside the payments up to what is owed; the figures, the audit row and the event follow', async () => {
    const contract = await contractOf();
    const id = await paidAdvance(contract);
    const version = Number((await rows<{ version: string }>('select version::text as version from machvon.contract_advance where id = $1::uuid', [id]))[0]?.version);
    expect(await recover(MAKER, id, version, '1000')).toMatchObject({ status: 403 });
    const over = await recover(RECOVERER, id, version, '1300000000');
    expect(over).toMatchObject({ status: 422, json: { code: 'ADVANCE_RECOVERY_EXCEEDED', outstanding_vnd: '1250000000', exceeds_by_vnd: '50000000' } });
    expect(await events(id, 'pay.advance.recovered.v1')).toEqual([]);
    const done = await recover(RECOVERER, id, version, '1250000000', { basis: 'COMPENSATION_PAYMENT' });
    expect(done).toMatchObject({ status: 200, json: { status: 'FULLY_RECOVERED', paid_vnd: '2000000000', recovered_vnd: '2000000000', outstanding_vnd: '0', resource_version: version + 1 } });
    const [audit] = await audits(id, 'advance.recovered');
    expect(audit).toMatchObject({ actor_id: memberId(RECOVERER), safe_diff: { from_status: 'RECOVERING', to_status: 'FULLY_RECOVERED', recovery_amount_vnd: '1250000000', basis: 'COMPENSATION_PAYMENT' } });
    expect((await events(id, 'pay.advance.recovered.v1'))[0]?.payload).toMatchObject({ advance_id: id, status: 'FULLY_RECOVERED', recovered_vnd: '2000000000', basis: 'COMPENSATION_PAYMENT' });
    expect(await recover(RECOVERER, id, version + 1, '1')).toMatchObject({ status: 409, json: { code: 'ADVANCE_STATE_INVALID' } });
    expect(await recover(RECOVERER, id, version, '1', { basis: 'GIFT' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
  });

  it('AC-ST-PAY-004-3: reads the advances and the plan of the recovery, with the buttons the caller may press and the days a land clearance advance is late', async () => {
    const contract = await contractOf('CONSTRUCTION', '20000000000');
    const planned = await request(MAKER, contract, '500000000');
    const plannedId = planned.json.resource_id as string;
    const id = await paidAdvance(contract);

    const plan = await call('GET', `/advances/${id}/recovery-plan`, { member: READER });
    expect(plan.status).toBe(200);
    expect(plan.json).toMatchObject({ target_recovered_vnd: expect.any(String), recovered_vnd: '750000000', outstanding_vnd: '1250000000', milestones: [{ at_pct: 25 }, { at_pct: 50 }, { at_pct: 75 }, { at_pct: 100 }], warnings: [{ code: 'RULE_AWAITING_CONFIRMATION' }] });
    expect(plan.json.advance).toMatchObject({ id, status: 'RECOVERING', kind: 'GPMB', recovery_deadline: '2026-07-31', actions: { cancel: false, record_recovery: false } });
    expect((plan.json.advance as { overdue_days: number }).overdue_days).toBeGreaterThan(0);

    const asRecoverer = await call('GET', `/advances/${id}/recovery-plan`, { member: RECOVERER });
    expect(asRecoverer.json.advance).toMatchObject({ actions: { cancel: false, record_recovery: true } });
    const listed = await call('GET', `/advances?contract_id=${contract.contractId}`, { member: MAKER });
    expect(listed.status).toBe(200);
    const items = listed.json.items as Array<Record<string, unknown>>;
    expect(items.map((item) => item.id)).toEqual([id, plannedId]);
    expect(items[1]).toMatchObject({ status: 'PLANNED', tranche_no: 1, amount_vnd: '500000000', actions: { cancel: true, record_recovery: false }, overdue_days: null, cap_rule_awaiting_confirmation: true });
    expect(items[0]).toMatchObject({ tranche_no: 2, actions: { cancel: false, record_recovery: false } });
    expect(listed.json.next_cursor).toBeNull();

    const paged = await call('GET', `/advances?contract_id=${contract.contractId}&limit=1`, { member: MAKER });
    expect(paged.json.next_cursor).toEqual(expect.any(String));
    const next = await call('GET', `/advances?contract_id=${contract.contractId}&limit=1&cursor=${encodeURIComponent(paged.json.next_cursor as string)}`, { member: MAKER });
    expect((next.json.items as Array<{ id: string }>).map((item) => item.id)).toEqual([plannedId]);
    expect(((await call('GET', `/advances?contract_id=${contract.contractId}&status=PLANNED`, { member: MAKER })).json.items as unknown[]).length).toBe(1);
    expect(await call('GET', '/advances?status=NOPE', { member: MAKER })).toMatchObject({ status: 422 });
    expect(await call('GET', '/advances?contract_id=x', { member: MAKER })).toMatchObject({ status: 422 });
    expect(await call('GET', `/advances/${randomUUID()}/recovery-plan`, { member: MAKER })).toMatchObject({ status: 404 });
  });

  it('AC-ST-PAY-004-2: of two requests that together go above the cap, sent together under two keys, one is planned and the other is told the cap', async () => {
    const contract = await contractOf();
    const replies = await Promise.all([request(MAKER, contract, '1500000000'), request(MAKER, contract, '1500000000')]);
    expect(replies.map((reply) => reply.status).sort()).toEqual([200, 422]);
    expect(replies.find((reply) => reply.status === 422)?.json).toMatchObject({ code: 'ADVANCE_CAP_EXCEEDED', cap_vnd: '500000000' });
    expect(await advancesOf(contract.contractId)).toHaveLength(1);
  });
});
