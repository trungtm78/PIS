import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, PmtGateStore, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { CapitalCommitments } from '../../src/modules/cap/commitment.port';
import { ctrModule } from '../../src/modules/ctr';
import { ContractController, ContractReadsController } from '../../src/modules/ctr/contract.controller';
import { ContractLifecycleController } from '../../src/modules/ctr/lifecycle.controller';
import { CapWorld, money } from '../../../../packages/db/test/support/cap-fixtures';
import { TENANT_A, id, memberId, roleId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { seedAs, seedContractor } from '../../../../packages/db/test/support/bid-proposal-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(480_000);

const SIGNING_KEY = randomBytes(32);
const FAMILY = 0xa8;
const ROOT = 1;
const DRAFTER = 11; // contract.update, contract.read
const SUBMITTER = 12; // contract.review.submit, contract.read
const REVIEWER = 13; // contract.review.decide, contract.read
const BAN = 14; // contract.sign, contract.activate: the band of the matrix up to 20 billion (rank 50)
const LOWER = 15; // the same permissions, rank 40: below the band
const PROVINCE = 16; // the same permissions, rank 60: the band above 20 billion
const READER = 17; // contract.read
const OMNI = 18; // every right of the life of a contract, rank 70
const NOBODY = 19;
const SELF = 20; // contract.update, contract.sign, contract.activate, contract.review.submit: a drafter who may also approve
const CONFLICTED = 21; // contract.review.submit and contract.sign, rank 50
const ELSEWHERE = 22; // the rights of BAN over another branch
const GUEST = 23; // the contractor of the contracts, reading the one it was invited to
const MEMBERS = [DRAFTER, SUBMITTER, REVIEWER, BAN, LOWER, PROVINCE, READER, OMNI, NOBODY, SELF, CONFLICTED, ELSEWHERE, GUEST];
const OTHER_BRANCH = 5;
const VALUE = '10000000000';
const BIG_VALUE = '25000000000';
const REASON = 'The bill of quantities has to be corrected.';
const TODAY = new Date().toISOString().slice(0, 10);

const LIFE = ['contract.review.submit', 'contract.review.decide', 'contract.sign', 'contract.activate', 'contract.update', 'contract.read'];

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the review, the signing and the activation of a contract over HTTP (ST-CTR-004)', () => {
  const world = new CapWorld();
  const harness = world.harness;
  const gates = new PmtGateStore();
  let app: RunningApp;
  let counter = 0;
  let cleanVersion = '';
  let contractor = '';

  const tokenOf = (member: number): string => signTenantContext({ tenantId: TENANT_A, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: string, url: string, options: { member: number; body?: unknown; ifMatch?: string; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  const rows = <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => world.owner<R>(sql, params);
  const audits = (resourceId: string, action: string, outcome = 'SUCCESS') =>
    rows<{ safe_diff: Record<string, unknown>; outcome: string; actor_id: string; reason: string | null }>('select safe_diff, outcome, actor_id, reason from machvon.audit_event where resource_id = $1 and action = $2 and outcome = $3 order by occurred_at', [resourceId, action, outcome]);
  const events = (aggregateId: string, type: string) => rows<{ payload: Record<string, unknown>; aggregate_version: string }>('select payload, aggregate_version::text as aggregate_version from machvon.outbox_event where aggregate_id = $1 and type = $2', [aggregateId, type]);
  const statusRows = (contractId: string) =>
    rows<{ from_status: string; to_status: string; command: string; created_by: string }>('select from_status, to_status, command, created_by from machvon.contract_status_change where contract_id = $1::uuid order by created_at, id', [contractId]);
  const stateOf = async (contractId: string) => (await rows<{ status: string; version: string }>('select status, version::text from machvon.contract where id = $1::uuid', [contractId]))[0];

  interface Contract {
    id: string;
    packageId: string;
    projectId: string;
    code: string;
  }
  interface Capital {
    lineId: string;
    projectId: string;
    balanceId: string;
  }

  /** A line of capital published for a project that is in implementation. */
  async function capital(allocatedBillions = 60): Promise<Capital> {
    const line = await world.publishedLine({ allocated: money(allocatedBillions), appropriationAmount: money(allocatedBillions + 20) });
    await world.owner("update machvon.project set status = 'IMPLEMENTATION' where id = $1::uuid", [line.projectId]);
    return { lineId: line.lineId, projectId: line.projectId, balanceId: line.balanceId };
  }

  /** A contract in the status asked for, with its first revision and a bill of quantities that adds up, under a package on the line of capital. */
  async function contract(line: Capital, options: { status?: string; value?: string; category?: string; createdBy?: number; submittedBy?: number | null; contractorId?: string } = {}): Promise<Contract> {
    counter += 1;
    const contractId = randomUUID();
    const revisionId = randomUUID();
    const packageId = randomUUID();
    const status = options.status ?? 'DRAFT';
    const value = options.value ?? VALUE;
    const signed = !['DRAFT', 'IN_REVIEW', 'CANCELLED'].includes(status);
    const code = `HD-${String(counter).padStart(4, '0')}-${contractId.slice(0, 4)}`;
    const effective = ['ACTIVE', 'SUSPENDED', 'COMPLETED', 'CLOSED'].includes(status);
    await seedAs(harness, [
      [
        `insert into machvon.procurement_package (tenant_id, id, project_id, code, budget_vnd, method, revision, status, title, allocation_line_id, created_by, version)
         values ($1, $2, $3, $4, 100000000000, 'OPEN_BIDDING', 1, 'AWARDED', 'Package', $5, $6, 1)`,
        [TENANT_A, packageId, line.projectId, `GT-${code}`, line.lineId, memberId(DRAFTER)],
      ],
      [
        `insert into machvon.contract
           (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, title, advance_category, is_joint_venture, requires_quality_acceptance,
            contract_value_vnd, estimate_ceiling_vnd, created_by, updated_by, submitted_by, signed_on, signed_by, signed_document_version_id, effective_from, activated_by,
            status_reason, status_decision_document_version_id)
         values ($1, $2, $3, $4, $5, $6, 'LUMP_SUM', 'VND', $7, 1, 'Contract', $8, false, true, $9, 100000000000, $10, $10, $11, $12::date, $13, $14, $15::date, $16, $17, $18)`,
        [
          TENANT_A,
          contractId,
          line.projectId,
          packageId,
          options.contractorId ?? contractor,
          code,
          status,
          options.category ?? 'CONSTRUCTION',
          value,
          memberId(options.createdBy ?? DRAFTER),
          options.submittedBy === undefined ? (status === 'IN_REVIEW' || signed ? memberId(SUBMITTER) : null) : options.submittedBy === null ? null : memberId(options.submittedBy),
          signed ? '2026-10-01' : null,
          signed ? memberId(BAN) : null,
          signed ? cleanVersion : null,
          effective ? '2026-10-02' : null,
          effective ? memberId(PROVINCE) : null,
          status === 'SUSPENDED' || status === 'TERMINATED' ? 'Decided by the authority.' : null,
          status === 'SUSPENDED' || status === 'TERMINATED' ? cleanVersion : null,
        ],
      ],
      [
        `insert into machvon.contract_revision (tenant_id, id, contract_id, revision, amount_vnd, document_version_id, valid_from, status, kind, version, created_by, updated_by, decided_by, decided_at)
         values ($1, $2, $3, 1, $4, $5, date '2026-10-01', $6, 'BASE', 1, $7, $7, $8, $9)`,
        [TENANT_A, revisionId, contractId, value, cleanVersion, effective ? 'EFFECTIVE' : status === 'CANCELLED' ? 'REJECTED' : 'DRAFT', memberId(DRAFTER), effective ? memberId(PROVINCE) : null, effective ? new Date().toISOString() : null],
      ],
      [
        `insert into machvon.boq_line (tenant_id, id, contract_revision_id, contract_id, boq_item_id, line_no, business_key, description, unit_code, quantity, unit_price, rounding_rule, amount_vnd, created_by)
         values ($1, gen_random_uuid(), $2, $3, gen_random_uuid(), 1, 'B01', 'Works', 'LS', 1, $4, 'HALF_UP', $4, $5)`,
        [TENANT_A, revisionId, contractId, value, memberId(DRAFTER)],
      ],
    ]);
    return { id: contractId, packageId, projectId: line.projectId, code };
  }

  const guarantee = (contractId: string, status: 'ACTIVE' | 'PENDING_VERIFICATION' = 'ACTIVE') =>
    seedAs(harness, [
      [
        `insert into machvon.guarantee
           (tenant_id, id, contract_id, kind, issuer, guarantee_no, amount_vnd, expires_at, verification_status, status, verified_by, verified_at, verification_method, verification_evidence_id, created_by)
         values ($1, gen_random_uuid(), $2, 'PERFORMANCE', 'Bank of the Province', $3, 500000000, now() + interval '365 days', $5,
                 $4, case when $5 = 'VERIFIED' then $6::uuid end, case when $5 = 'VERIFIED' then now() end, case when $5 = 'VERIFIED' then 'ISSUER_CONFIRMATION' end, case when $5 = 'VERIFIED' then $7::uuid end, $8)`,
        [TENANT_A, contractId, `BL-${randomUUID().slice(0, 8)}`, status, status === 'ACTIVE' ? 'VERIFIED' : 'UNVERIFIED', memberId(REVIEWER), id(FAMILY, 5), memberId(DRAFTER)],
      ],
    ]);

  const body = {
    submit: {},
    return: { reason: REASON },
    sign: () => ({ signed_on: TODAY, signed_document_version_id: cleanVersion }),
    activate: () => ({ decision: 'approve', reason: 'All the conditions are met.', evidence_ids: [], effective_from: TODAY }),
    cancel: { reason: 'The draft was a mistake.' },
  };
  const send = (member: number, command: 'submit' | 'return' | 'sign' | 'activate' | 'cancel', target: Contract, version: number | string = 1, override?: unknown): Promise<Reply> => {
    const path = { submit: 'submit-review', return: 'return', sign: 'sign', activate: 'activate', cancel: 'cancel' }[command];
    const payload = override ?? (typeof body[command] === 'function' ? (body[command] as () => unknown)() : body[command]);
    return call('POST', `/contracts/${target.id}/${path}`, { member, ifMatch: `"${version}"`, body: payload });
  };

  beforeAll(async () => {
    await world.start();
    await harness.seedUnits(TENANT_A, [{ n: OTHER_BRANCH, path: `/${unitId(OTHER_BRANCH)}/` }]);
    for (const n of MEMBERS) await harness.seedMembership(TENANT_A, n, ROOT);
    const roles: Array<[number, string, readonly string[], number]> = [
      [1, 'CTR_DRAFTER', ['contract.update', 'contract.read'], 20],
      [2, 'CTR_SUBMITTER', ['contract.review.submit', 'contract.read'], 20],
      [3, 'CTR_REVIEWER', ['contract.review.decide', 'contract.read'], 30],
      [4, 'BAN_LEADER', ['contract.sign', 'contract.activate', 'contract.read'], 50],
      [5, 'LOWER_LEADER', ['contract.sign', 'contract.activate', 'contract.read'], 40],
      [6, 'PROVINCE_LEADER', ['contract.sign', 'contract.activate', 'contract.read'], 60],
      [7, 'CTR_READER', ['contract.read'], 10],
      [8, 'CTR_OMNI', [...LIFE, 'ledger.read'], 70],
      [9, 'CTR_SELF', ['contract.update', 'contract.sign', 'contract.activate', 'contract.review.submit', 'contract.read'], 50],
      [10, 'CTR_CONFLICTED', ['contract.review.submit', 'contract.sign', 'contract.read'], 50],
    ];
    for (const [n, code, permissions, rank] of roles) await harness.seedRole(TENANT_A, 60 + n, code, permissions, rank);
    const grant = (n: number, member: number, role: number, extra: { kind?: 'TENANT' | 'UNIT_SUBTREE'; refs?: string[] } = {}) => ({ n, member, role: 60 + role, kind: extra.kind ?? 'TENANT', ...(extra.refs === undefined ? {} : { refs: extra.refs }) });
    await harness.seedGrants(TENANT_A, [
      grant(1, DRAFTER, 1),
      grant(2, SUBMITTER, 2),
      grant(3, REVIEWER, 3),
      grant(4, BAN, 4),
      grant(5, LOWER, 5),
      grant(6, PROVINCE, 6),
      grant(7, READER, 7),
      grant(8, OMNI, 8),
      grant(9, SELF, 9),
      grant(10, CONFLICTED, 10),
      grant(11, ELSEWHERE, 4, { kind: 'UNIT_SUBTREE', refs: [unitId(OTHER_BRANCH)] }),
    ]);
    // The matrix of delegation in force: a contract up to 20 billion is signed by the leaders of the Ban, above it by the leaders of the province.
    const matrix = id(FAMILY, 1);
    await world.owner(
      `insert into machvon.doa_matrix_version (tenant_id, id, revision, status, effective_from, legal_basis_ref, created_by, last_edited_by, version)
       values ($1, $2, 900, 'Draft', date '2020-01-01', 'Fixture regulation on the signature of contracts', $3, $3, 1)`,
      [TENANT_A, matrix, memberId(DRAFTER)],
    );
    await world.owner(
      `insert into machvon.doa_rule (tenant_id, id, matrix_version_id, document_type, unit_id, include_subtree, amount_min_vnd, amount_max_vnd, approver_role_id, position)
       values ($1, $2, $3, 'CTR_CONTRACT', $4, true, 0, 20000000000, $5, 0), ($1, $6, $3, 'CTR_CONTRACT', $4, true, 20000000000, null, $7, 1)`,
      [TENANT_A, id(FAMILY, 2), matrix, unitId(ROOT), roleId(64), id(FAMILY, 3), roleId(66)],
    );
    await world.owner("update machvon.doa_matrix_version set status = 'PendingApproval' where id = $1", [matrix]);
    await world.owner("update machvon.doa_matrix_version set status = 'Published', approved_by = $2, published_at = now() where id = $1", [matrix, memberId(REVIEWER)]);
    contractor = await seedContractor(harness);
    cleanVersion = id(FAMILY, 10);
    await seedAs(harness, [
      [`insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'HD', 'Signed contract', 'INTERNAL', $3, $3), ($1, $4, 'REFERENCE', 'EVIDENCE', 'Evidence', 'INTERNAL', $3, $3)`, [TENANT_A, id(FAMILY, 11), memberId(DRAFTER), id(FAMILY, 5)]],
      [
        `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
         values ($1, $2, $3, 1, 'tenants/ctr/signed.pdf', repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL'),
                ($1, $4, $3, 2, 'tenants/ctr/pending.pdf', repeat('b', 64), 'application/pdf', 1, 'INTERNAL', 'PENDING', '{}'::jsonb, 'RENDERED_FINAL')`,
        [TENANT_A, cleanVersion, id(FAMILY, 11), id(FAMILY, 12)],
      ],
    ]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [ContractController, ContractReadsController, ContractLifecycleController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
        CapitalCommitments,
      ],
    });
  }, 480_000);

  afterAll(async () => {
    if (app) await app.close();
    await world.stop();
  }, 60_000);

  beforeEach(async () => {
    await world.owner('delete from machvon.bid_conflict_declaration');
  });

  it('is registered in the module of CTR', () => {
    expect(ctrModule.controllers).toContain(ContractLifecycleController);
  });

  describe('submitContractForReview', () => {
    it('sends a complete draft to review, audits it and tells the world with ids and statuses only', async () => {
      const line = await capital();
      const target = await contract(line);
      const done = await send(SUBMITTER, 'submit', target, 1, { note: 'Ready for the committee.' });
      expect(done).toMatchObject({ status: 200, json: { status: 'IN_REVIEW', resource_version: 2, resource_id: target.id } });
      expect(await stateOf(target.id)).toEqual({ status: 'IN_REVIEW', version: '2' });
      expect(await statusRows(target.id)).toEqual([{ from_status: 'DRAFT', to_status: 'IN_REVIEW', command: 'submitContractForReview', created_by: memberId(SUBMITTER) }]);
      const [audit] = await audits(target.id, 'contract.review_requested');
      expect(audit).toMatchObject({ actor_id: memberId(SUBMITTER), safe_diff: { code: target.code, from_status: 'DRAFT', to_status: 'IN_REVIEW' } });
      const [event] = await events(target.id, 'ctr.contract.review_requested.v1');
      expect(event?.payload).toMatchObject({ contract_id: target.id, project_id: target.projectId, status: 'IN_REVIEW', from_status: 'DRAFT', version: 2, actor_id: memberId(SUBMITTER) });
      expect(event?.aggregate_version).toBe('2');
    });

    it('answers the same request with the same key once, and refuses a stale version with 409', async () => {
      const target = await contract(await capital());
      const first = await call('POST', `/contracts/${target.id}/submit-review`, { member: SUBMITTER, ifMatch: '"1"', key: 'submit-once-for-this-key', body: {} });
      const again = await call('POST', `/contracts/${target.id}/submit-review`, { member: SUBMITTER, ifMatch: '"1"', key: 'submit-once-for-this-key', body: {} });
      expect(again).toEqual(first);
      expect(await statusRows(target.id)).toHaveLength(1);
      expect(await send(OMNI, 'return', target, 1)).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
    });

    it('refuses a bill of quantities that does not add up, and leaves the draft as it was', async () => {
      const line = await capital();
      const short = await contract(line);
      await seedAs(harness, [['update machvon.boq_line set amount_vnd = amount_vnd - 1, unit_price = unit_price - 1 where contract_id = $1::uuid', [short.id]]]);
      expect(await send(SUBMITTER, 'submit', short)).toMatchObject({ status: 422, json: { code: 'BOQ_TOTAL_MISMATCH' } });
      expect(await stateOf(short.id)).toEqual({ status: 'DRAFT', version: '1' });
      expect(await statusRows(short.id)).toEqual([]);
    });

    it('is for whoever holds the permission: a reader, a member without a grant and a leader of the signing are refused', async () => {
      const target = await contract(await capital());
      expect((await send(READER, 'submit', target)).status).toBe(403);
      expect((await send(NOBODY, 'submit', target)).status).toBe(403);
      expect(await send(ELSEWHERE, 'submit', target)).toMatchObject({ status: 403 });
      expect(await stateOf(target.id)).toEqual({ status: 'DRAFT', version: '1' });
    });
  });

  describe('returnContractDraft', () => {
    it('gives a contract in review back with the reason, by a reviewer who is not its maker, and keeps the reason on the record', async () => {
      const target = await contract(await capital(), { status: 'IN_REVIEW' });
      const done = await send(REVIEWER, 'return', target);
      expect(done).toMatchObject({ status: 200, json: { status: 'DRAFT', resource_version: 2 } });
      expect(await statusRows(target.id)).toEqual([{ from_status: 'IN_REVIEW', to_status: 'DRAFT', command: 'returnContractDraft', created_by: memberId(REVIEWER) }]);
      const [audit] = await audits(target.id, 'contract.returned');
      expect(audit).toMatchObject({ reason: REASON, actor_id: memberId(REVIEWER) });
    });

    it('UAT-AC317: refuses the one who drafted it (403 SELF_APPROVAL_DENIED)', async () => {
      const target = await contract(await capital(), { status: 'IN_REVIEW', createdBy: OMNI });
      expect(await send(OMNI, 'return', target)).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
      expect(await stateOf(target.id)).toEqual({ status: 'IN_REVIEW', version: '1' });
    });
  });

  describe('recordContractSigning', () => {
    it('signs a contract in review within the delegation limit, keeping the document and the date, and tells the world', async () => {
      const target = await contract(await capital(), { status: 'IN_REVIEW' });
      const done = await send(BAN, 'sign', target);
      expect(done).toMatchObject({ status: 200, json: { status: 'SIGNED', resource_version: 2 } });
      const [stored] = await rows<{ status: string; signed_by: string; signed_on: string; signed_document_version_id: string; conflict_decision_ref: string | null }>(
        'select status, signed_by, signed_on::text, signed_document_version_id, conflict_decision_ref from machvon.contract where id = $1::uuid',
        [target.id],
      );
      expect(stored).toEqual({ status: 'SIGNED', signed_by: memberId(BAN), signed_on: TODAY, signed_document_version_id: cleanVersion, conflict_decision_ref: null });
      const [audit] = await audits(target.id, 'contract.signed');
      expect(audit).toMatchObject({ actor_id: memberId(BAN), safe_diff: { signed_on: TODAY, signed_document_version_id: cleanVersion, conflict_decision_ref: null } });
      expect((await events(target.id, 'ctr.contract.signed.v1'))[0]?.payload).toMatchObject({ status: 'SIGNED', signed_on: TODAY, actor_id: memberId(BAN) });
    });

    it('AC-ST-CTR-004-3, UAT-AC317: refuses the drafter (403 SELF_APPROVAL_DENIED), a leader below the band of 25 billion (403 SCOPE_DENIED) and a body with a status or a tenant, and accepts the leader of the province', async () => {
      const own = await contract(await capital(), { status: 'IN_REVIEW', createdBy: SELF, submittedBy: SUBMITTER });
      expect(await send(SELF, 'sign', own)).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
      const big = await contract(await capital(), { status: 'IN_REVIEW', value: BIG_VALUE });
      expect(await send(BAN, 'sign', big)).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
      expect(await send(LOWER, 'sign', big)).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
      expect(await send(BAN, 'sign', big, 1, { signed_on: TODAY, signed_document_version_id: cleanVersion, status: 'ACTIVE', tenant_id: TENANT_A })).toMatchObject({ status: 400, json: { code: 'FIELD_NOT_ALLOWED' } });
      expect(await stateOf(big.id)).toEqual({ status: 'IN_REVIEW', version: '1' });
      expect(await send(PROVINCE, 'sign', big)).toMatchObject({ status: 200, json: { status: 'SIGNED' } });
    });

    it('refuses a leader below the band of an ordinary contract as well (403 SCOPE_DENIED), and a signed file that is not clean (422 DOCUMENT_NOT_CLEAN)', async () => {
      const target = await contract(await capital(), { status: 'IN_REVIEW' });
      expect(await send(LOWER, 'sign', target)).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
      expect(await send(BAN, 'sign', target, 1, { signed_on: TODAY, signed_document_version_id: id(FAMILY, 12) })).toMatchObject({ status: 422, json: { code: 'DOCUMENT_NOT_CLEAN' } });
      expect(await stateOf(target.id)).toEqual({ status: 'IN_REVIEW', version: '1' });
    });

    it('AC-ST-CTR-004-1, UAT-AC56: blocks a reviewer and a signer in conflict with the contractor and keeps every blocked attempt in the audit trail; someone free of it signs with the decision on the record', async () => {
      const target = await contract(await capital(), { status: 'IN_REVIEW', submittedBy: SUBMITTER });
      const declaration = id(FAMILY, 20);
      await seedAs(harness, [
        [
          `insert into machvon.bid_conflict_declaration (tenant_id, id, package_id, user_id, has_conflict, relation_text, contractor_id, created_by, updated_by)
           values ($1, $2, $3, $4, true, 'A relation.', $5, $4, $4), ($1, $6, $3, $7, true, 'A relation.', $5, $7, $7)`,
          [TENANT_A, declaration, target.packageId, memberId(CONFLICTED), contractor, id(FAMILY, 21), memberId(SUBMITTER)],
        ],
      ]);
      // The one in conflict is told so whether they send the contract to review or sign it, and nothing changes.
      expect(await send(CONFLICTED, 'submit', target)).toMatchObject({ status: 409, json: { code: 'CONFLICT_OF_INTEREST_BLOCKED', conflict_of: 'ACTOR', declaration_id: declaration, contractor_id: contractor } });
      expect(await send(CONFLICTED, 'sign', target)).toMatchObject({ status: 409, json: { code: 'CONFLICT_OF_INTEREST_BLOCKED' } });
      expect(await stateOf(target.id)).toEqual({ status: 'IN_REVIEW', version: '1' });
      expect(await statusRows(target.id)).toEqual([]);
      // The leader is free of conflict but the reviewer who sent the contract was not: the decision that dealt with it has to be on the record.
      expect(await send(BAN, 'sign', target)).toMatchObject({ status: 409, json: { code: 'CONFLICT_OF_INTEREST_BLOCKED', conflict_of: 'REVIEWER' } });
      const done = await send(BAN, 'sign', target, 1, { signed_on: TODAY, signed_document_version_id: cleanVersion, conflict_decision_ref: 'QD-XL-001' });
      expect(done).toMatchObject({ status: 200, json: { status: 'SIGNED', resource_version: 2 } });
      const [stored] = await rows<{ conflict_decision_ref: string | null }>('select conflict_decision_ref from machvon.contract where id = $1::uuid', [target.id]);
      expect(stored?.conflict_decision_ref).toBe('QD-XL-001');
      const blocked = await audits(target.id, 'contract.conflict_blocked', 'DENIED');
      expect(blocked.map((entry) => [entry.actor_id, entry.safe_diff.command, entry.safe_diff.contractor_id, entry.safe_diff.declaration_id, entry.safe_diff.conflict_of])).toEqual([
        [memberId(CONFLICTED), 'submitContractForReview', contractor, declaration, 'ACTOR'],
        [memberId(CONFLICTED), 'recordContractSigning', contractor, declaration, 'ACTOR'],
        [memberId(BAN), 'recordContractSigning', contractor, id(FAMILY, 21), 'REVIEWER'],
      ]);
    });
  });

  describe('activateContract', () => {
    it('AC-ST-CTR-004-2, UAT-AC302: judges the guarantee, then the permits, then the funds; each refusal leaves the contract SIGNED; the last one posts one commitment and one pair of events', async () => {
      const small = await capital(5);
      const large = await capital(60);
      const target = await contract(small, { status: 'SIGNED' });
      await guarantee(target.id, 'PENDING_VERIFICATION');
      // 1. The guarantee waits for its verification.
      expect(await send(PROVINCE, 'activate', target)).toMatchObject({ status: 422, json: { code: 'PERFORMANCE_GUARANTEE_MISSING' } });
      await guarantee(target.id);
      // 2. The guarantee is in force but the project has no building permit: the gate names itself and the permit type.
      const permitType = id(FAMILY, 30);
      await seedAs(harness, [
        [
          `insert into machvon.permit_type (tenant_id, id, code, name, category, authority_text, legal_basis, effective_from, applies_to_rule, status, created_by, updated_by)
           values ($1, $2, 'GPXD', 'Building permit', 'OTHER', 'The authority', 'Fixture decree', '2025-01-01', '{}'::jsonb, 'PUBLISHED', $3, $3)`,
          [TENANT_A, permitType, memberId(DRAFTER)],
        ],
      ]);
      await world.as((tx) => gates.publish(tx, { gateCode: 'CONTRACT_ACTIVATION', permitTypeId: permitType, requirement: 'VALID_PERMIT', appliesToRule: {}, legalBasis: 'Fixture decree', effectiveFrom: '2025-01-01' }, memberId(DRAFTER)));
      expect(await send(PROVINCE, 'activate', target)).toMatchObject({
        status: 409,
        json: { code: 'PERMIT_GATE_BLOCKED', gate_code: 'CONTRACT_ACTIVATION', blocking: [expect.objectContaining({ permit_type_code: 'GPXD' })] },
      });
      await world.owner('delete from machvon.permit_gate_rule');
      // 3. The permits pass but the line of capital cannot take 10 billion more: the commitment fails and the contract is still SIGNED.
      const refused = await send(PROVINCE, 'activate', target);
      expect(refused).toMatchObject({ status: 422, json: { code: 'FUND_COMMIT_FAILED' } });
      expect(await stateOf(target.id)).toEqual({ status: 'SIGNED', version: '1' });
      expect(await rows('select 1 from machvon.capital_ledger_entry where source_ref_id = $1::uuid', [target.id])).toEqual([]);
      expect(await events(target.id, 'ctr.contract.activated.v1')).toEqual([]);
      // 4. The package is on a line that has the capital: ACTIVE.
      await world.owner('update machvon.procurement_package set allocation_line_id = $2::uuid where id = $1::uuid', [target.packageId, large.lineId]);
      const done = await send(PROVINCE, 'activate', target);
      expect(done).toMatchObject({ status: 200, json: { status: 'ACTIVE', resource_version: 2, resource_id: target.id } });
      const [stored] = await rows<{ status: string; effective_from: string; activated_by: string; current_revision_id: string }>('select status, effective_from::text, activated_by, current_revision_id from machvon.contract where id = $1::uuid', [target.id]);
      expect(stored).toMatchObject({ status: 'ACTIVE', effective_from: TODAY, activated_by: memberId(PROVINCE) });
      const [revision] = await rows<{ status: string }>('select status from machvon.contract_revision where id = $1::uuid', [stored?.current_revision_id]);
      expect(revision?.status).toBe('EFFECTIVE');
      const ledger = await rows<{ entry_type: string; amount_vnd: string; allocation_line_id: string }>('select entry_type, amount_vnd::text, allocation_line_id from machvon.capital_ledger_entry where source_ref_id = $1::uuid', [target.id]);
      expect(ledger).toEqual([{ entry_type: 'COMMIT', amount_vnd: VALUE, allocation_line_id: large.lineId }]);
      const activated = await events(target.id, 'ctr.contract.activated.v1');
      expect(activated).toHaveLength(1);
      expect(activated[0]?.payload).toMatchObject({ status: 'ACTIVE', effective_from: TODAY, committed_vnd: VALUE, allocation_line_id: large.lineId, actor_id: memberId(PROVINCE) });
      const changed = await events(target.id, 'ctr.commitment.changed.v1');
      expect(changed).toHaveLength(1);
      expect(changed[0]?.payload).toMatchObject({ contract_id: target.id, project_id: target.projectId, allocation_line_id: large.lineId, committed_vnd: VALUE });
      const [audit] = await audits(target.id, 'contract.activated');
      expect(audit).toMatchObject({ reason: 'All the conditions are met.', safe_diff: { committed_vnd: VALUE, effective_from: TODAY, allocation_line_id: large.lineId } });
      expect((await rows<{ committed: string }>('select committed_vnd::text as committed from machvon.allocation_balance where id = $1::uuid', [large.balanceId]))[0]?.committed).toBe(VALUE);
    });

    it('refuses the maker, a leader below the band, a decision other than approve and a date before the signature', async () => {
      const line = await capital();
      const target = await contract(line, { status: 'SIGNED', createdBy: SELF });
      await guarantee(target.id);
      expect(await send(SELF, 'activate', target)).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
      expect(await send(LOWER, 'activate', target)).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
      expect(await send(BAN, 'activate', target, 1, { decision: 'reject', reason: 'No.', evidence_ids: [], effective_from: TODAY })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await send(BAN, 'activate', target, 1, { decision: 'approve', reason: 'Yes.', evidence_ids: [], effective_from: '2026-09-30' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await stateOf(target.id)).toEqual({ status: 'SIGNED', version: '1' });
      expect(await send(BAN, 'activate', target)).toMatchObject({ status: 200, json: { status: 'ACTIVE' } });
    });
  });

  describe('the table of the states (AC-ST-CTR-004-4, UAT-AC300)', () => {
    const STATES = ['DRAFT', 'IN_REVIEW', 'SIGNED', 'ACTIVE', 'SUSPENDED', 'TERMINATED', 'COMPLETED', 'CLOSED', 'CANCELLED'];
    const COMMANDS = ['submit', 'return', 'sign', 'activate', 'cancel'] as const;
    const VALID: ReadonlyArray<readonly [string, string, string]> = [
      ['DRAFT', 'submit', 'IN_REVIEW'],
      ['IN_REVIEW', 'return', 'DRAFT'],
      ['IN_REVIEW', 'sign', 'SIGNED'],
      ['SIGNED', 'activate', 'ACTIVE'],
      ['DRAFT', 'cancel', 'CANCELLED'],
      ['IN_REVIEW', 'cancel', 'CANCELLED'],
    ];

    it('lets exactly the valid pairs through with a leader who holds every right, answers every other pair 409 CONTRACT_STATE_INVALID without a change, and writes one row of the history per valid move', async () => {
      const line = await capital(100);
      for (const state of STATES) {
        for (const command of COMMANDS) {
          const target = await contract(line, { status: state });
          if (state === 'SIGNED') await guarantee(target.id);
          const reply = await send(OMNI, command, target);
          const wanted = VALID.find(([from, via]) => from === state && via === command)?.[2];
          if (wanted !== undefined) {
            expect([state, command, reply.status, reply.json.status]).toEqual([state, command, 200, wanted]);
            expect(await statusRows(target.id)).toHaveLength(1);
          } else {
            expect([state, command, reply.status, reply.json.code]).toEqual([state, command, 409, 'CONTRACT_STATE_INVALID']);
            expect(await stateOf(target.id)).toEqual({ status: state, version: '1' });
            expect(await statusRows(target.id)).toEqual([]);
          }
        }
      }
    });

    it('has no generic write for the status or the tenant: PATCH and PUT answer 404', async () => {
      const target = await contract(await capital());
      expect((await call('PATCH', `/contracts/${target.id}`, { member: OMNI, body: { status: 'ACTIVE' } })).status).toBe(404);
      expect((await call('PUT', `/resources/contract/${target.id}`, { member: OMNI, body: { status: 'ACTIVE', tenant_id: TENANT_A } })).status).toBe(404);
      expect(await stateOf(target.id)).toEqual({ status: 'DRAFT', version: '1' });
    });
  });

  describe('getContractSummary', () => {
    it('shows the staff what stands before the activation and what they may do now, a reader the same with nothing to do, and a guest contractor the contract alone', async () => {
      const line = await capital();
      const target = await contract(line, { status: 'SIGNED', createdBy: SELF });
      const staff = await call('GET', `/contracts/${target.id}/summary`, { member: OMNI });
      expect(staff.status).toBe(200);
      expect(staff.json).toMatchObject({
        id: target.id,
        status: 'SIGNED',
        version: 1,
        signed_by: memberId(BAN),
        signed_document_version_id: cleanVersion,
        readiness: {
          boq: { total_vnd: VALUE, balanced: true },
          guarantee: { required: true, held: false },
          permit_gate: { required: true, status: 'PASSED', blocking: [] },
          capital: { allocation_line_id: line.lineId },
          project: { status: 'IMPLEMENTATION', in_implementation: true },
        },
        actions: { submit: false, return: false, sign: false, activate: true, cancel: false },
      });
      expect(await call('GET', `/contracts/${target.id}/summary`, { member: SELF })).toMatchObject({ json: { actions: { activate: false } } });
      const reader = await call('GET', `/contracts/${target.id}/summary`, { member: READER });
      expect(reader.status).toBe(200);
      expect(reader.json).toMatchObject({ id: target.id, status: 'SIGNED', actions: { submit: false, return: false, sign: false, activate: false, cancel: false } });
      expect(reader.json).not.toHaveProperty('accepted_total_vnd');
      // The contractor of the contract sees it, and nothing of how the staff judge it.
      await world.owner("update machvon.membership set membership_type = 'GUEST_CONTRACTOR', contractor_id = $2::uuid, valid_until = now() + interval '1 year' where id = $1::uuid", [memberId(GUEST), contractor]);
      await harness.seedGrants(TENANT_A, [{ n: 40, member: GUEST, role: 67, kind: 'CONTRACT', refs: [target.id] }]);
      const guest = await call('GET', `/contracts/${target.id}/summary`, { member: GUEST });
      expect(guest.status).toBe(200);
      expect(guest.json).toMatchObject({ id: target.id, status: 'SIGNED' });
      for (const hidden of ['readiness', 'actions', 'created_by', 'submitted_by', 'signed_by', 'conflict_decision_ref', 'status_changes', 'estimate_ceiling_vnd']) expect(guest.json).not.toHaveProperty(hidden);
    });

    it('follows the version of the contract: a move is seen at once, and a contract outside the scope does not exist', async () => {
      const target = await contract(await capital());
      expect((await call('GET', `/contracts/${target.id}/summary`, { member: OMNI })).json).toMatchObject({ status: 'DRAFT', version: 1 });
      await send(SUBMITTER, 'submit', target);
      expect((await call('GET', `/contracts/${target.id}/summary`, { member: OMNI })).json).toMatchObject({ status: 'IN_REVIEW', version: 2 });
      expect((await call('GET', `/contracts/${target.id}/summary`, { member: ELSEWHERE })).status).toBe(404);
      expect((await call('GET', `/contracts/${target.id}/summary`, { member: NOBODY })).status).toBe(403);
      expect((await call('GET', `/contracts/${randomUUID()}/summary`, { member: OMNI })).status).toBe(404);
    });
  });
});
