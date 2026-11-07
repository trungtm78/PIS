import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { CtrChangeChainStore, EffectiveAccessStore, InMemoryAuthzCache, PayLedgerStore, TenantDatabase } from '@machvon/db';
import type { ContractScopes } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { CapitalCommitments } from '../../src/modules/cap/commitment.port';
import { ctrModule } from '../../src/modules/ctr';
import { ChangeChainController } from '../../src/modules/ctr/change.controller';
import { ContractReadsController } from '../../src/modules/ctr/contract.controller';
import { CumulativeLedgerController } from '../../src/modules/pay/cumulative-ledger.controller';
import { TENANT_A, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { AcceptanceWorld } from '../../../../packages/db/test/support/acceptance-fixtures';
import type { ApprovedAcceptance, SeededContract } from '../../../../packages/db/test/support/acceptance-fixtures';
import { everything, seedAs } from '../../../../packages/db/test/support/bid-proposal-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { clearAdjustmentCheck, coverChange } from './reserve-cover';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(480_000);

const SIGNING_KEY = randomBytes(32);
const ROOT = 1;
const MAKER = 1; // raises and promotes the change order (a member of the fixtures of CAP)
const EVALUATOR = 2; // assesses it
const OTHER_BRANCH = 5;
const APPROVER = 11; // change.retroactive.approve, change.read, contract.read, ledger.read over the whole tenant
const NO_LEDGER = 12; // the same without ledger.read
const NOBODY = 13;
const ELSEWHERE = 14; // change.retroactive.approve over another branch only
const READER = 15; // change.read, contract.read, ledger.read: reads the board and the ledger, adjusts nothing
const MEMBERS = [APPROVER, NO_LEDGER, NOBODY, ELSEWHERE, READER];
const VERSION = id(0xb1, 31);
const BASIS = 'The owner agreed the new price from the first of June.';
const contractScopes: ContractScopes = { update: () => ({ sql: 'true', params: [] }), read: () => ({ sql: 'true', params: [] }) };

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the retroactive adjustment of a change order over HTTP (ST-CTR-016)', () => {
  const fixtures = new AcceptanceWorld();
  const harness = fixtures.harness;
  const chain = new CtrChangeChainStore();
  const ledger = new PayLedgerStore();
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
  const audits = (resourceId: string, action: string) => rows<{ safe_diff: Record<string, unknown>; actor_id: string; reason: string | null }>('select safe_diff, actor_id, reason from machvon.audit_event where resource_id = $1 and action = $2 and outcome = $3 order by occurred_at', [resourceId, action, 'SUCCESS']);
  const events = (aggregateId: string, type: string) => rows<{ payload: Record<string, unknown>; aggregate_version: string }>('select payload, aggregate_version::text as aggregate_version from machvon.outbox_event where aggregate_id = $1 and type = $2', [aggregateId, type]);
  const entriesOf = (contractId: string) =>
    rows<{ id: string; accepted_delta_vnd: string; requested_delta_vnd: string; adjustment_line_id: string; acceptance_id: string }>(
      "select id, accepted_delta_vnd::text, requested_delta_vnd::text, adjustment_line_id, acceptance_id from machvon.cumulative_ledger_entry where contract_id = $1::uuid and entry_kind = 'ADJUSTMENT' order by posted_at, id",
      [contractId],
    );
  const frozen = async (acceptanceId: string) => ({
    acceptance: (await rows<{ row: unknown }>('select to_jsonb(a) as row from machvon.acceptance a where id = $1::uuid', [acceptanceId]))[0]?.row,
    lines: (await rows<{ row: unknown }>('select to_jsonb(l) as row from machvon.acceptance_line l where acceptance_id = $1::uuid order by id', [acceptanceId])).map((each) => each.row),
  });
  const contractRow = async (contractId: string) => (await rows<{ contract_value_vnd: string; accepted_total_vnd: string; current_revision_id: string; version: string }>('select contract_value_vnd::text, accepted_total_vnd::text, current_revision_id, version::text from machvon.contract where id = $1::uuid', [contractId]))[0];
  const requestRow = async (requestId: string) => (await rows<{ status: string; retroactive: boolean; effective_on: string | null; version: string }>('select status, retroactive, effective_on::text, version::text from machvon.change_request where id = $1::uuid', [requestId]))[0];

  interface World {
    contract: SeededContract;
    approved: ApprovedAcceptance;
    request: string;
    version: number;
  }

  /** A contract with an approved acceptance of 500 m3 of B02 (one billion, dated 25 July) on the ledger, and a CO that was assessed (+100,000,000). */
  async function scenario(delta = '100000000', baselineRevisionId?: string, contractOf?: { contract: SeededContract; approved: ApprovedAcceptance }): Promise<World> {
    const contract = contractOf?.contract ?? (await fixtures.seedContract());
    const approved = contractOf?.approved ?? (await fixtures.approve(contract, [{ item: 1, quantity: '500' }]));
    if (contractOf === undefined) await fixtures.as((tx) => ledger.recognize(tx, { acceptanceId: approved.acceptance.id, requestId: randomUUID(), actor: memberId(MAKER) }), MAKER);
    const event = await fixtures.as((tx) => chain.create(tx, contract.contractId, { stage: 'EVENT', baselineRevisionId: baselineRevisionId ?? contract.revisionId, reason: 'The owner agreed a new price.', estimatedDeltaVnd: delta, scheduleImpactDays: 12 }, memberId(MAKER), contractScopes), MAKER);
    const pco = await fixtures.as((tx) => chain.promote(tx, event.id, 1, 'It is a change.', memberId(MAKER), contractScopes), MAKER);
    const co = await fixtures.as((tx) => chain.promote(tx, pco.id, 1, 'Priced.', memberId(MAKER), contractScopes), MAKER);
    const evaluated = await fixtures.as(
      (tx) => chain.evaluate(tx, co.id, 1, { evaluatedDeltaVnd: delta, scheduleImpactDays: 12, fundingImpactNote: 'Paid from the plan.', ...(BigInt(delta) > 0n ? { allocationLineId: fixtures.lineId } : {}) }, memberId(EVALUATOR), contractScopes, { available: async () => undefined }),
      EVALUATOR,
    );
    // An increase is approved only with a source (lane B2, G1-8): the contingency of the project is drawn for exactly this change order.
    if (BigInt(delta) > 0n) await coverChange(rows, { tenantId: TENANT_A, projectId: fixtures.projectId, changeId: co.id, amountVnd: delta, authorityDocumentVersionId: VERSION, requester: memberId(MAKER), approver: memberId(EVALUATOR) });
    return { contract, approved, request: co.id, version: evaluated.version };
  }

  const boq = (perM3 = '2100000', lump = '1000000') => [
    { business_key: 'B01', description: 'Item B01', unit_code: 'M3', quantity: '8000', unit_price: lump },
    { business_key: 'B02', description: 'Item B02', unit_code: 'M3', quantity: '500', unit_price: perM3 },
    { business_key: 'B03', description: 'Item B03', unit_code: 'M3', quantity: '10', unit_price: '1234.5' },
  ];
  const body = (target: World, overrides: Record<string, unknown> = {}) => ({
    adjustment_basis: BASIS,
    decision_document_version_id: VERSION,
    affected_acceptance_ids: [target.approved.acceptance.id],
    effective_on: '2026-06-01',
    boq_lines: boq(),
    ...overrides,
  });
  const adjust = (member: number, target: World, overrides: Record<string, unknown> = {}, options: { version?: number | string; key?: string } = {}) =>
    call('POST', `/change-requests/${target.request}/retroactive-adjustment`, { member, ifMatch: `"${options.version ?? target.version}"`, body: body(target, overrides), ...(options.key === undefined ? {} : { key: options.key }) });

  beforeAll(async () => {
    await fixtures.start();
    await harness.seedUnits(TENANT_A, [{ n: OTHER_BRANCH, path: `/${unitId(OTHER_BRANCH)}/` }]);
    for (const n of MEMBERS) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedRole(TENANT_A, 111, 'RETRO_APPROVER', ['change.retroactive.approve', 'change.read', 'contract.read', 'ledger.read'], 50);
    await harness.seedRole(TENANT_A, 112, 'RETRO_NO_LEDGER', ['change.retroactive.approve', 'change.read', 'contract.read'], 50);
    await harness.seedRole(TENANT_A, 113, 'RETRO_READER', ['change.read', 'contract.read', 'ledger.read'], 10);
    await harness.seedGrants(TENANT_A, [
      { n: 11, member: APPROVER, role: 111, kind: 'TENANT' },
      { n: 12, member: NO_LEDGER, role: 112, kind: 'TENANT' },
      { n: 13, member: ELSEWHERE, role: 111, kind: 'UNIT_SUBTREE', refs: [unitId(OTHER_BRANCH)] },
      { n: 14, member: READER, role: 113, kind: 'TENANT' },
    ]);
    await fixtures.as((tx) => chain.setTiers(tx, fixtures.projectId, 3, memberId(MAKER), everything), MAKER);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [ChangeChainController, ContractReadsController, CumulativeLedgerController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
        CapitalCommitments,
      ],
    });
  }, 480_000);

  afterEach(async () => {
    await seedAs(harness, [['delete from machvon.settlement_revision', []]]);
  });

  afterAll(async () => {
    if (app) await app.close();
    await fixtures.stop();
  }, 60_000);

  it('is registered in the module of CTR', () => {
    expect(ctrModule.controllers).toEqual(expect.arrayContaining([ChangeChainController, ContractReadsController]));
  });

  describe('approveRetroactiveAdjustment (AC-ST-CTR-016-1, UAT-AC58)', () => {
    it('AC-ST-CTR-016-1, UAT-AC58: answers 200, posts the adjustment on the ledger, leaves the acceptance as it was approved and records the decision and the affected acceptances', async () => {
      const target = await scenario();
      const before = await frozen(target.approved.acceptance.id);
      const done = await adjust(APPROVER, target);
      expect(done).toMatchObject({ status: 200, json: { status: 'APPROVED', resource_id: target.request, resource_version: target.version + 1 } });

      expect(await frozen(target.approved.acceptance.id)).toEqual(before);
      const [entry, ...others] = await entriesOf(target.contract.contractId);
      expect(others).toEqual([]);
      expect(entry).toMatchObject({ accepted_delta_vnd: '50000000', requested_delta_vnd: '0', acceptance_id: target.approved.acceptance.id });
      expect(await contractRow(target.contract.contractId)).toMatchObject({ contract_value_vnd: '9100000000', accepted_total_vnd: '1050000000' });
      expect(await requestRow(target.request)).toMatchObject({ status: 'APPROVED', retroactive: true, effective_on: '2026-06-01' });

      const [line] = await rows<{ id: string; adjustment_id: string; delta_vnd: string; acceptance_id: string }>('select id, adjustment_id, delta_vnd::text, acceptance_id from machvon.retroactive_adjustment_line where contract_id = $1::uuid', [target.contract.contractId]);
      expect(line).toMatchObject({ delta_vnd: '50000000', acceptance_id: target.approved.acceptance.id });
      expect(entry?.adjustment_line_id).toBe(line?.id);
      const [header] = await rows<{ decision_document_version_id: string; basis: string; effective_on: string; total_delta_vnd: string; created_by: string }>(
        'select decision_document_version_id, basis, effective_on::text, total_delta_vnd::text, created_by from machvon.retroactive_adjustment where id = $1::uuid',
        [line?.adjustment_id],
      );
      expect(header).toMatchObject({ decision_document_version_id: VERSION, basis: BASIS, effective_on: '2026-06-01', total_delta_vnd: '50000000', created_by: memberId(APPROVER) });

      const revisions = await rows<{ id: string; status: string; retroactive: boolean; amount_vnd: string }>('select id, status, retroactive, amount_vnd::text from machvon.contract_revision where contract_id = $1::uuid order by revision', [target.contract.contractId]);
      expect(revisions.map((revision) => [revision.status, revision.retroactive, revision.amount_vnd])).toEqual([
        ['SUPERSEDED', false, '9000000000'],
        ['EFFECTIVE', true, '9100000000'],
      ]);
    });

    it('AC-ST-CTR-016-1: lets a price fall take the contract below the accepted total it had when the adjusted total fits: 200, the accepted total and the value follow, and the ledger reconciles', async () => {
      const target = await scenario('-8040000000');
      // A fall of this size is a cumulative variation far above the threshold: the check of the project adjustment is cleared first (lane B2, G1-8).
      await clearAdjustmentCheck(rows, { tenantId: TENANT_A, projectId: fixtures.projectId, contractId: target.contract.contractId, changeId: target.request, cumulativePct: '99.00', documentVersionId: VERSION, requiredBy: memberId(MAKER), clearedBy: memberId(APPROVER) });
      const before = await contractRow(target.contract.contractId);
      const done = await adjust(APPROVER, target, { boq_lines: boq('1900000', '1') });
      expect(done).toMatchObject({ status: 200, json: { status: 'APPROVED' } });
      const after = await contractRow(target.contract.contractId);
      expect(after).toMatchObject({ contract_value_vnd: '960000000', accepted_total_vnd: '950000000' });
      expect(Number(after?.version)).toBe(Number(before?.version) + 2);
      expect((await entriesOf(target.contract.contractId)).map((entry) => entry.accepted_delta_vnd)).toEqual(['-50000000']);
      const events = await rows<{ aggregate_version: string }>("select aggregate_version::text from machvon.outbox_event where aggregate_id = $1 and type = 'ctr.commitment.changed.v1'", [target.contract.contractId]);
      expect(events.map((each) => each.aggregate_version)).toEqual([after?.version]);
      const page = await call('GET', `/contracts/${target.contract.contractId}/cumulative-ledger`, { member: READER });
      expect(page.json.reconciled).toBe(true);
    });

    it('AC-ST-CTR-016-1: counts the adjustment of an earlier change order once: 1,000 then 1,050 then 1,100 million posts +50 million the second time', async () => {
      const first = await scenario();
      expect((await adjust(APPROVER, first)).status).toBe(200);
      const [revision] = await rows<{ id: string }>('select id from machvon.contract_revision where contract_id = $1::uuid and retroactive', [first.contract.contractId]);
      // Two adjustments cannot be made on one day (a revision begins on a day of its own): the first is moved back a day, as if it had been made yesterday.
      await seedAs(harness, [
        ['update machvon.contract_revision set valid_until = valid_until - 1 where contract_id = $1::uuid and not retroactive', [first.contract.contractId]],
        ['update machvon.contract_revision set valid_from = valid_from - 1 where id = $1::uuid', [revision?.id]],
      ]);
      const second = await scenario('100000000', revision?.id, { contract: first.contract, approved: first.approved });
      const done = await adjust(APPROVER, second, { boq_lines: boq('2200000') });
      expect(done.status).toBe(200);
      expect((await entriesOf(first.contract.contractId)).map((entry) => entry.accepted_delta_vnd)).toEqual(['50000000', '50000000']);
      expect(await contractRow(first.contract.contractId)).toMatchObject({ contract_value_vnd: '9200000000', accepted_total_vnd: '1100000000' });
      const page = await call('GET', `/contracts/${first.contract.contractId}/cumulative-ledger`, { member: READER });
      expect((page.json.items as Array<{ accepted_vnd: string }>)[0]?.accepted_vnd).toBe('1100000000');
      expect(page.json.reconciled).toBe(true);
    });

    it('audits and tells the world with ids, days and amounts only: the change, the revision, the capital and the ledger', async () => {
      const target = await scenario();
      expect((await adjust(APPROVER, target)).status).toBe(200);
      const [revision] = (await rows<{ id: string }>('select id from machvon.contract_revision where contract_id = $1::uuid and retroactive', [target.contract.contractId]));
      const [applied] = await audits(target.request, 'change.retroactive_applied');
      expect(applied).toMatchObject({
        actor_id: memberId(APPROVER),
        reason: BASIS,
        safe_diff: { from_status: 'EVALUATED', to_status: 'APPROVED', effective_on: '2026-06-01', approved_delta_vnd: '100000000', total_adjustment_vnd: '50000000', revision_id: revision?.id, affected_acceptance_ids: [target.approved.acceptance.id] },
      });
      expect((await audits(revision?.id ?? '', 'contract.revision_created'))[0]?.safe_diff).toMatchObject({ retroactive: true, status: 'EFFECTIVE', change_request_id: target.request });
      expect((await audits(revision?.id ?? '', 'contract.revision_effective'))[0]?.safe_diff).toMatchObject({ from_value_vnd: '9000000000', to_value_vnd: '9100000000' });
      const [ledgerAudit] = await audits(target.contract.contractId, 'ledger.adjusted');
      expect(ledgerAudit?.safe_diff).toMatchObject({ total_adjustment_vnd: '50000000', entries: [expect.objectContaining({ acceptance_id: target.approved.acceptance.id, delta_vnd: '50000000' })] });

      const [applied_event] = await events(target.request, 'ctr.change.retroactive_applied.v1');
      expect(applied_event?.payload).toMatchObject({ change_request_id: target.request, contract_id: target.contract.contractId, effective_on: '2026-06-01', total_adjustment_vnd: '50000000', actor_id: memberId(APPROVER), version: target.version + 1 });
      expect(JSON.stringify(applied_event?.payload)).not.toContain('first of June');
      expect((await events(revision?.id ?? '', 'ctr.contract_revision.created.v1'))[0]?.payload).toMatchObject({ retroactive: true, revision: 2, amount_vnd: '9100000000' });
      const [commitment] = await events(target.contract.contractId, 'ctr.commitment.changed.v1');
      expect(commitment?.payload).toMatchObject({ contract_id: target.contract.contractId, committed_vnd: '9100000000', previous_committed_vnd: '9000000000', revision_id: revision?.id });
      expect((await events(target.contract.contractId, 'pay.ledger.adjusted.v1'))[0]?.payload).toMatchObject({ adjustment_id: expect.any(String), entries: 1, total_adjustment_vnd: '50000000', accepted_total_vnd: '1050000000' });
    });

    it('answers the same request with the same key once, and a different request with the same key as a conflict', async () => {
      const target = await scenario();
      const send = () => adjust(APPROVER, target, {}, { key: 'adjust-once-for-this-key' });
      const first = await send();
      expect(first.status).toBe(200);
      expect(await send()).toEqual(first);
      expect(await entriesOf(target.contract.contractId)).toHaveLength(1);
      const other = await call('POST', `/change-requests/${target.request}/retroactive-adjustment`, { member: APPROVER, ifMatch: `"${target.version}"`, key: 'adjust-once-for-this-key', body: body(target, { adjustment_basis: 'Another basis.' }) });
      expect(other).toMatchObject({ status: 409, json: { code: 'IDEMPOTENCY_CONFLICT' } });
    });

    it('needs the version of the request, and refuses another', async () => {
      const target = await scenario();
      const missing = await call('POST', `/change-requests/${target.request}/retroactive-adjustment`, { member: APPROVER, body: body(target) });
      expect([400, 412, 428]).toContain(missing.status);
      expect(await adjust(APPROVER, target, {}, { version: target.version + 5 })).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
      expect((await requestRow(target.request))?.status).toBe('EVALUATED');
    });

    it('refuses a second call: the change order is approved already', async () => {
      const target = await scenario();
      const done = await adjust(APPROVER, target);
      expect(await adjust(APPROVER, target, {}, { version: done.json.resource_version as number })).toMatchObject({ status: 409, json: { code: 'CHANGE_STATE_INVALID' } });
      expect(await entriesOf(target.contract.contractId)).toHaveLength(1);
    });

    it('AC-ST-CTR-016-1: is refused with 409 SETTLEMENT_ALREADY_APPROVED while a verified settlement has read the ledger, and writes nothing', async () => {
      const target = await scenario();
      await seedAs(harness, [
        [
          `insert into machvon.settlement_revision
             (tenant_id, id, project_id, contract_id, revision, settled_amount_vnd, outstanding_vnd, unrecovered_advance_vnd, audit_finding_refs, status, settlement_scope, project_group,
              submitted_by, submitted_at, submitted_on, deadline_rule_version_id, deadline_days, verification_due_on, verified_by, verified_at, verified_on, created_by, updated_by, version)
           values ($1, gen_random_uuid(), $2, $3, 1, 0, 0, 0, '[]'::jsonb, 'VERIFIED', 'CONTRACT', 'B', $4, now(), date '2026-08-01', gen_random_uuid(), 120, date '2026-12-01', $5, now(), date '2026-08-05', $4, $4, 1)`,
          [TENANT_A, fixtures.projectId, target.contract.contractId, memberId(MAKER), memberId(EVALUATOR)],
        ],
      ]);
      const refused = await adjust(APPROVER, target);
      expect(refused).toMatchObject({ status: 409, json: { code: 'SETTLEMENT_ALREADY_APPROVED' } });
      expect(await entriesOf(target.contract.contractId)).toEqual([]);
      expect((await requestRow(target.request))?.status).toBe('EVALUATED');
      expect((await contractRow(target.contract.contractId))?.contract_value_vnd).toBe('9000000000');
    });

    it('refuses whoever had a part in the chain or made the document (403 SELF_APPROVAL_DENIED), and whoever lacks the right in the scope', async () => {
      const target = await scenario();
      // The maker of the chain holds the right here, for this case only.
      await harness.seedGrants(TENANT_A, [{ n: 21, member: MAKER, role: 111, kind: 'TENANT' }]);
      expect(await adjust(MAKER, target)).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
      // The board does not offer the adjustment to a person of the chain either.
      const seen = ((await call('GET', `/projects/${fixtures.projectId}/change-chain?contract_id=${target.contract.contractId}`, { member: MAKER })).json.requests as Array<Record<string, unknown>>).find((each) => each.id === target.request);
      expect(seen?.actions).toMatchObject({ adjust: false });
      await seedAs(harness, [['delete from machvon.role_grant where membership_id = $1::uuid', [memberId(MAKER)]]]);
      // Whoever reads the contract but may not change it is refused; whoever cannot see it at all is told it does not exist.
      expect((await adjust(READER, target)).status).toBe(403);
      for (const member of [NOBODY, ELSEWHERE]) expect([403, 404]).toContain((await adjust(member, target)).status);
      expect(await adjust(APPROVER, { ...target, request: randomUUID() })).toMatchObject({ status: 404 });
      expect((await requestRow(target.request))?.status).toBe('EVALUATED');
      expect(await entriesOf(target.contract.contractId)).toEqual([]);
    });

    it('answers the refusals of the rules in their own codes, over HTTP', async () => {
      const target = await scenario();
      expect(await adjust(APPROVER, target, { decision_document_version_id: randomUUID() })).toMatchObject({ status: 422, json: { code: 'DECISION_DOCUMENT_REQUIRED' } });
      expect(await adjust(APPROVER, target, { effective_on: '2999-01-01' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await adjust(APPROVER, target, { affected_acceptance_ids: [] })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', reason: 'AFFECTED_MISMATCH', missing_acceptance_ids: [target.approved.acceptance.id] } });
      expect(await adjust(APPROVER, target, { adjustment_basis: undefined })).toMatchObject({ status: 400 });
      expect(await adjust(APPROVER, target, { tenant_id: TENANT_A, status: 'APPROVED' })).toMatchObject({ status: 400, json: { code: 'FIELD_NOT_ALLOWED' } });
      expect(await adjust(APPROVER, target, { boq_lines: [{ business_key: 'X' }] })).toMatchObject({ status: 422 });
      expect(await entriesOf(target.contract.contractId)).toEqual([]);
      expect((await requestRow(target.request))?.status).toBe('EVALUATED');
    });
  });

  describe('what the reads show afterwards', () => {
    it('shows the adjustment to the staff who read the ledger (the day, the basis, the total and each balance) and hides the money from those who do not', async () => {
      const target = await scenario();
      expect((await adjust(APPROVER, target)).status).toBe(200);
      const staff = await call('GET', `/resources/contract/${target.contract.contractId}`, { member: APPROVER });
      expect(staff.status).toBe(200);
      const adjustments = staff.json.retroactive_adjustments as Array<Record<string, unknown>>;
      expect(adjustments).toHaveLength(1);
      expect(adjustments[0]).toMatchObject({ change_request_id: target.request, effective_on: '2026-06-01', basis: BASIS, total_delta_vnd: '50000000', decision_document_version_id: VERSION });
      expect(adjustments[0]?.affected).toEqual([
        expect.objectContaining({ acceptance_id: target.approved.acceptance.id, boq_item_key: 'B02', old_amount_vnd: '1000000000', new_amount_vnd: '1050000000', delta_vnd: '50000000' }),
      ]);
      const revisions = staff.json.revisions as Array<Record<string, unknown>>;
      expect(revisions.map((revision) => [revision.revision, revision.retroactive])).toEqual([
        [1, false],
        [2, true],
      ]);
      const blind = await call('GET', `/resources/contract/${target.contract.contractId}`, { member: NO_LEDGER });
      expect(blind.status).toBe(200);
      expect(blind.json).not.toHaveProperty('retroactive_adjustments');
      expect((blind.json.revisions as Array<Record<string, unknown>>)[1]).toMatchObject({ retroactive: true });
    });

    it('offers the adjustment on the board to someone who may take it and flags the change order that was approved so', async () => {
      const target = await scenario();
      const board = async (member: number) => ((await call('GET', `/projects/${fixtures.projectId}/change-chain?contract_id=${target.contract.contractId}`, { member })).json.requests as Array<Record<string, unknown>>).find((each) => each.id === target.request);
      expect((await board(APPROVER))?.actions).toMatchObject({ adjust: true });
      expect((await board(READER))?.actions).toMatchObject({ adjust: false });
      expect((await board(APPROVER))?.retroactive).toBe(false);
      expect((await adjust(APPROVER, target)).status).toBe(200);
      expect(await board(APPROVER)).toMatchObject({ status: 'APPROVED', retroactive: true, effective_on: '2026-06-01', actions: { adjust: false } });
    });

    it('lists the entry on the ledger of the contract with its sign, and the balance reconciles with the accepted total', async () => {
      const target = await scenario();
      expect((await adjust(APPROVER, target)).status).toBe(200);
      const page = await call('GET', `/contracts/${target.contract.contractId}/cumulative-ledger`, { member: READER });
      expect(page.status).toBe(200);
      const items = page.json.items as Array<{ accepted_vnd: string; entries: Array<{ kind: string; accepted_delta_vnd: string; reversal_of_id: string | null }> }>;
      expect(items).toHaveLength(1);
      expect(items[0]?.accepted_vnd).toBe('1050000000');
      expect(items[0]?.entries.map((entry) => [entry.kind, entry.accepted_delta_vnd, entry.reversal_of_id])).toEqual([
        ['RECOGNIZE_ACCEPTANCE', '1000000000', null],
        ['ADJUSTMENT', '50000000', null],
      ]);
      expect(page.json.reconciled).toBe(true);
    });
  });
});
