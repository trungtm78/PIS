import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { EffectiveAccess, Scope } from '@machvon/kernel';
import { CtrContractPartyStore, readParties } from '../src/ctr-contract-party-store';
import { CtrContractSource } from '../src/ctr-contract-source';
import type { PartyInput } from '../src/ctr-contract-party-store';
import { CtrContractStore, calendarDate, contractScope, partiesCheck, wholeAmount } from '../src/ctr-contract-store';
import type { ContractScopes, NewContract } from '../src/ctr-contract-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, id, memberId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const contracts = new CtrContractStore();
const parties = new CtrContractPartyStore(contracts);
const ACTOR = 1;
const TODAY = '2026-10-24';
const READ = 'contract.read';
const UPDATE = 'contract.update';
// Units: 1 is the province (/u1/), 2 the department below it (/u1/u2/), 3 another branch (/u3/).
const PROVINCE = 1;
const DEPARTMENT = 2;
const OTHER_BRANCH = 3;

const FAMILY = 0x91;
const PROJECT = id(FAMILY, 1);
const PROJECT_NO_PLAN = id(FAMILY, 2);
const PROJECT_OTHER_BRANCH = id(FAMILY, 3);
const PACKAGE = id(FAMILY, 11);
const PACKAGE_NO_PLAN = id(FAMILY, 12);
const PACKAGE_NOT_AWARDED = id(FAMILY, 13);
const PACKAGE_RESULT_SUBMITTED = id(FAMILY, 14);
const PACKAGE_TO_SECOND = id(FAMILY, 15);
const PACKAGE_TO_UNVERIFIED = id(FAMILY, 16);
const PACKAGE_TO_RESTRICTED = id(FAMILY, 17);
const PACKAGE_OTHER_BRANCH = id(FAMILY, 18);
const LEAD = id(FAMILY, 21);
const SECOND = id(FAMILY, 22);
const UNVERIFIED = id(FAMILY, 23);
const RESTRICTED = id(FAMILY, 24);
const DOCUMENT = id(FAMILY, 31);
const ABSENT = id(FAMILY, 99);

const as = <T>(work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(ACTOR)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string; extensions?: Record<string, unknown> }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string; extensions?: Record<string, unknown> };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }), ...(e.extensions === undefined ? {} : { extensions: e.extensions }) };
  }
  throw new Error('expected a refusal');
}

/** The SQLSTATE and the message of a statement the database refuses (the owner connection autocommits, so a deferred trigger fires at its end). */
async function databaseRefusal(work: Promise<unknown>): Promise<{ sqlstate: string; message: string }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; message: string };
    return { sqlstate: e.code ?? '', message: e.message };
  }
  throw new Error('expected the database to refuse');
}

const grant = (permission: string, scope: Scope): EffectiveAccess => ({
  membershipId: memberId(ACTOR),
  scopeVersion: 1,
  membershipActive: true,
  grants: [{ roleCode: 'TEST', rank: 10, permissions: [permission], scope, status: 'Active', effectiveFrom: new Date('2026-01-01T00:00:00Z'), effectiveUntil: null }],
});
const NOW = new Date();
const EVERYWHERE: ContractScopes = { update: contractScope(grant(UPDATE, { kind: 'TENANT' }), UPDATE, NOW), read: contractScope(grant(READ, { kind: 'TENANT' }), READ, NOW) };
const readOf = (access: EffectiveAccess) => contractScope(access, READ, NOW);

async function seedAs(statements: Array<[string, unknown[]]>): Promise<void> {
  const client = new Client({ connectionString: harness.database.adminUrl });
  await client.connect();
  try {
    // Foreign keys to the modules this story only reads are out of scope here, so the superuser seeds with them switched off.
    await client.query('set session_replication_role = replica');
    for (const [sql, params] of statements) await client.query(sql, params);
  } finally {
    await client.end();
  }
}

async function seedTenant(tenant: string): Promise<void> {
  await seedAs([
    [
      `insert into machvon.contractor (tenant_id, id, tax_identifier, legal_name, verification_status, profile_document_id)
       values ($1, $2, '0100000001', 'Lead Builders', 'VERIFIED', $6), ($1, $3, '0100000002', 'Second Builders', 'VERIFIED', $6),
              ($1, $4, '0100000003', 'Unverified Builders', 'UNVERIFIED', $6), ($1, $5, '0100000004', 'Restricted Builders', 'VERIFIED', $6)`,
      [tenant, LEAD, SECOND, UNVERIFIED, RESTRICTED, id(FAMILY, 40)],
    ],
    [
      `insert into machvon.contractor_restriction (tenant_id, id, contractor_id, kind, source, effective_from, decision_document_id, created_by, updated_by)
       values ($1, $2, $3, 'DEBARMENT', 'DECISION', date '2020-01-01', $5, $4, $4)`,
      [tenant, id(FAMILY, 41), RESTRICTED, memberId(ACTOR), id(FAMILY, 47)],
    ],
    [
      `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
       values ($1, $2, 'PRJ-A-001', 'Project with a plan', $5, $4, $6, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B'),
              ($1, $3, 'PRJ-A-002', 'Project without a plan', $5, $4, $6, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B'),
              ($1, $7, 'PRJ-A-003', 'Project of another branch', $8, $8, $6, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
      [tenant, PROJECT, PROJECT_NO_PLAN, unitId(PROVINCE), unitId(DEPARTMENT), id(FAMILY, 42), PROJECT_OTHER_BRANCH, unitId(OTHER_BRANCH)],
    ],
    [
      `insert into machvon.plan_version (tenant_id, id, project_id, fiscal_year, revision, decision_id, status, effective_at)
       values ($1, $2, $3, 2026, 1, $4, 'APPROVED', now()), ($1, $5, $6, 2026, 1, $4, 'DRAFT', now()), ($1, $7, $8, 2026, 1, $4, 'PUBLISHED', now())`,
      [tenant, id(FAMILY, 43), PROJECT, id(FAMILY, 44), id(FAMILY, 45), PROJECT_NO_PLAN, id(FAMILY, 46), PROJECT_OTHER_BRANCH],
    ],
    [
      `insert into machvon.procurement_package (tenant_id, id, project_id, code, budget_vnd, method, revision, status)
       values ($1, $2, $9, 'PKG-A-020', 10200000000, 'OPEN', 1, 'AWARDED'), ($1, $3, $10, 'PKG-A-021', 5000000000, 'OPEN', 1, 'AWARDED'),
              ($1, $4, $9, 'PKG-A-022', 3000000000, 'OPEN', 1, 'PLANNED'), ($1, $5, $9, 'PKG-A-023', 3000000000, 'OPEN', 1, 'EVALUATING'),
              ($1, $6, $9, 'PKG-A-024', 3000000000, 'OPEN', 1, 'AWARDED'), ($1, $7, $9, 'PKG-A-025', 3000000000, 'OPEN', 1, 'AWARDED'),
              ($1, $8, $9, 'PKG-A-026', 3000000000, 'OPEN', 1, 'AWARDED'), ($1, $11, $12, 'PKG-A-027', 3000000000, 'OPEN', 1, 'AWARDED')`,
      [tenant, PACKAGE, PACKAGE_NO_PLAN, PACKAGE_NOT_AWARDED, PACKAGE_RESULT_SUBMITTED, PACKAGE_TO_SECOND, PACKAGE_TO_UNVERIFIED, PACKAGE_TO_RESTRICTED, PROJECT, PROJECT_NO_PLAN, PACKAGE_OTHER_BRANCH, PROJECT_OTHER_BRANCH],
    ],
    [
      `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by)
       values ($1, $2, 'REFERENCE', 'HD', 'Contract draft', 'INTERNAL', $3, $3)`,
      [tenant, id(FAMILY, 47), memberId(ACTOR)],
    ],
    [
      `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
       values ($1, $2, $3, 1, 'tenants/ctr/draft.pdf', repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL')`,
      [tenant, DOCUMENT, id(FAMILY, 47)],
    ],
  ]);
  const award = (packageId: string, winner: string, status: string, n: number): [string, unknown[]] => [
    `insert into machvon.procurement_result (tenant_id, id, package_id, winner_contractor_id, award_price_vnd, outcome, status, decision_document_id, submitted_by, approved_by, approved_at, created_by, updated_by)
     values ($1, $2, $3, $4, 1000, 'AWARDED', $5, $6, $7, case when $5 = 'APPROVED' then $8::uuid end, case when $5 = 'APPROVED' then now() end, $7, $7)`,
    [tenant, id(FAMILY, 50 + n), packageId, winner, status, id(FAMILY, 47), memberId(ACTOR), memberId(ACTOR + 1)],
  ];
  await seedAs([
    award(PACKAGE, LEAD, 'APPROVED', 1),
    award(PACKAGE_NO_PLAN, LEAD, 'APPROVED', 2),
    award(PACKAGE_RESULT_SUBMITTED, LEAD, 'SUBMITTED', 3),
    award(PACKAGE_TO_SECOND, SECOND, 'APPROVED', 4),
    award(PACKAGE_TO_UNVERIFIED, UNVERIFIED, 'APPROVED', 5),
    award(PACKAGE_TO_RESTRICTED, RESTRICTED, 'APPROVED', 6),
    award(PACKAGE_OTHER_BRANCH, LEAD, 'APPROVED', 7),
  ]);
}

let counter = 0;
const input = (extra: Partial<NewContract> = {}): NewContract => {
  counter += 1;
  return {
    projectId: PROJECT,
    packageId: PACKAGE,
    contractorId: LEAD,
    code: `HD-A-${String(counter).padStart(3, '0')}`,
    title: 'Construction of the bridge',
    type: 'LUMP_SUM',
    advanceCategory: 'CONSTRUCTION',
    contractValueVnd: '10200000000',
    documentVersionId: DOCUMENT,
    ...extra,
  };
};
const create = (data: NewContract, tenant = TENANT_A) => as((tx) => contracts.create(tx, data, memberId(ACTOR), TODAY), tenant);
const row = async (contractId: string) => (await owner<Record<string, unknown>>('select * from machvon.contract where id = $1::uuid', [contractId]))[0];
const revisions = (contractId: string) => owner<Record<string, unknown>>('select * from machvon.contract_revision where contract_id = $1::uuid order by revision', [contractId]);
const members = (contractId: string) =>
  owner<{ contractor_id: string; role: string; share_pct: string; work_value_vnd: string; status: string; version: string }>(
    'select contractor_id, role, share_pct::text as share_pct, work_value_vnd::text as work_value_vnd, status, version::text as version from machvon.contract_party where contract_id = $1::uuid order by contractor_id',
    [contractId],
  );
const venture = (extra: Partial<NewContract> = {}) => create(input({ isJointVenture: true, contractValueVnd: '10000000000', ...extra }));
const split = (lead: string, second: string): PartyInput[] => [
  { contractorId: lead, role: 'LEAD', sharePct: '60.0000', workValueVnd: '6000000000' },
  { contractorId: second, role: 'MEMBER', sharePct: '40.0000', workValueVnd: '4000000000' },
];
const replace = (contractId: string, version: number, list: readonly PartyInput[], scopes: ContractScopes = EVERYWHERE) =>
  as((tx) => parties.replace(tx, contractId, version, list, memberId(ACTOR), scopes, TODAY));
const sign = async (contractId: string) => {
  await owner("update machvon.contract set status = 'IN_REVIEW' where id = $1::uuid", [contractId]);
  await owner("update machvon.contract set status = 'SIGNED', signed_on = date '2026-10-25' where id = $1::uuid", [contractId]);
};

describe('CtrContractStore (the contract register, ST-CTR-001)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: PROVINCE, path: '/u1/' },
        { n: DEPARTMENT, path: '/u1/u2/', parent: PROVINCE },
        { n: OTHER_BRANCH, path: '/u3/' },
      ]);
      await harness.seedMembership(tenant, ACTOR, PROVINCE);
      await harness.seedMembership(tenant, ACTOR + 1, PROVINCE);
    }
    await seedTenant(TENANT_A);
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('creating a draft', () => {
    it('refuses a value above the price of the package and names the ceiling, creates a DRAFT at the price, and refuses a project without an approved plan, creating no row (AC-ST-CTR-001-1)', async () => {
      const above = input({ code: 'HD-CEIL-1', contractValueVnd: '10300000000' });
      expect(await refusal(create(above))).toEqual({ code: 'CONTRACT_VALUE_EXCEEDS_CEILING', status: 422, detail: 'contract_value_vnd', extensions: { ceiling_vnd: '10200000000' } });
      expect(await owner('select count(*)::int as n from machvon.contract where code = $1', ['HD-CEIL-1'])).toEqual([{ n: 0 }]);

      const created = await create(input({ code: 'HD-CEIL-2', contractValueVnd: '10200000000' }));
      expect(created).toMatchObject({ version: 1, status: 'DRAFT', estimateCeilingVnd: '10200000000' });
      expect(await row(created.id)).toMatchObject({
        status: 'DRAFT',
        version: '1',
        currency: 'VND',
        contract_value_vnd: '10200000000',
        estimate_ceiling_vnd: '10200000000',
        accepted_total_vnd: '0',
        is_joint_venture: false,
        requires_quality_acceptance: true,
        created_by: memberId(ACTOR),
      });
      expect(await revisions(created.id)).toEqual([
        expect.objectContaining({ id: created.revisionId, revision: 1, kind: 'BASE', status: 'DRAFT', amount_vnd: '10200000000', document_version_id: DOCUMENT, version: '1' }),
      ]);

      const unplanned = input({ code: 'HD-PLAN-1', projectId: PROJECT_NO_PLAN, packageId: PACKAGE_NO_PLAN, contractValueVnd: '5000000000' });
      expect(await refusal(create(unplanned))).toEqual({ code: 'CAPITAL_PLAN_NOT_APPROVED', status: 422, detail: 'project_id' });
      expect(await owner('select count(*)::int as n from machvon.contract where code = $1', ['HD-PLAN-1'])).toEqual([{ n: 0 }]);
    });

    it('takes a plan that is already published as approved, and a lower ceiling than the price of the package, and refuses a higher one', async () => {
      const published = await create(input({ projectId: PROJECT_OTHER_BRANCH, packageId: PACKAGE_OTHER_BRANCH, contractValueVnd: '3000000000' }));
      expect(published.status).toBe('DRAFT');
      const lower = await create(input({ estimateCeilingVnd: '9000000000', contractValueVnd: '9000000000' }));
      expect(lower.estimateCeilingVnd).toBe('9000000000');
      expect(await refusal(create(input({ estimateCeilingVnd: '10200000001', contractValueVnd: '1' })))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'estimate_ceiling_vnd' });
      expect(await refusal(create(input({ estimateCeilingVnd: '9000000000', contractValueVnd: '9000000001' })))).toMatchObject({ code: 'CONTRACT_VALUE_EXCEEDS_CEILING', extensions: { ceiling_vnd: '9000000000' } });
    });

    it('refuses the same code in the tenant with CONTRACT_CODE_DUPLICATE but not in another tenant, and leaves exactly one contract (AC-ST-CTR-001-2)', async () => {
      const first = await create(input({ code: 'HD-A-300' }));
      expect(await refusal(create(input({ code: 'HD-A-300' })))).toEqual({ code: 'CONTRACT_CODE_DUPLICATE', status: 409, detail: 'code' });
      expect(await owner('select count(*)::int as n from machvon.contract where code = $1', ['HD-A-300'])).toEqual([{ n: 1 }]);
      expect((await row(first.id))?.id).toBe(first.id);
      await seedTenant(TENANT_B);
      expect(await create(input({ code: 'HD-A-300' }), TENANT_B)).toMatchObject({ status: 'DRAFT' });
    });

    it('refuses a package that is not awarded, one whose result is not approved, a package of another project, and a contractor that did not win it', async () => {
      expect(await refusal(create(input({ packageId: PACKAGE_NOT_AWARDED })))).toEqual({ code: 'PACKAGE_NOT_AWARDED', status: 422, detail: 'package_id' });
      expect(await refusal(create(input({ packageId: PACKAGE_RESULT_SUBMITTED })))).toMatchObject({ code: 'PACKAGE_NOT_AWARDED' });
      expect(await refusal(create(input({ packageId: PACKAGE_NO_PLAN })))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'package_id' });
      expect(await refusal(create(input({ packageId: ABSENT })))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'package_id' });
      expect(await refusal(create(input({ contractorId: SECOND })))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'contractor_id' });
    });

    it('refuses a contractor that is not verified or is restricted, and one that does not exist', async () => {
      expect(await refusal(create(input({ packageId: PACKAGE_TO_UNVERIFIED, contractorId: UNVERIFIED, contractValueVnd: '1000' })))).toEqual({ code: 'CONTRACTOR_NOT_VERIFIED', status: 422 });
      expect(await refusal(create(input({ packageId: PACKAGE_TO_RESTRICTED, contractorId: RESTRICTED, contractValueVnd: '1000' })))).toMatchObject({ code: 'CONTRACTOR_RESTRICTED', status: 422 });
      const stranger = await as((tx) => contracts.assertContractorMayContract(tx, ABSENT, TODAY)).catch((error: unknown) => error);
      expect(stranger).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'contractor_id' });
    });

    it('refuses what is not a contract: a code or a title that is empty, long or holds control characters, a value that is zero or not whole money, a date that does not exist, a document that does not exist', async () => {
      const bad = (extra: Partial<NewContract>) => refusal(create(input(extra)));
      expect(await bad({ code: '   ' })).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'code' });
      expect(await bad({ code: 'x'.repeat(51) })).toMatchObject({ detail: 'code' });
      expect(await bad({ title: 'A\u0000B' })).toMatchObject({ detail: 'title' });
      expect(await bad({ title: ' ' })).toMatchObject({ detail: 'title' });
      expect(await bad({ contractValueVnd: '0' })).toMatchObject({ detail: 'contract_value_vnd' });
      expect(await bad({ contractValueVnd: '10.5' })).toMatchObject({ detail: 'contract_value_vnd' });
      expect(await bad({ contractValueVnd: '1'.repeat(25) })).toMatchObject({ detail: 'contract_value_vnd' });
      expect(await bad({ completionDue: '2027-02-30' })).toMatchObject({ detail: 'completion_due' });
      expect(await bad({ completionDue: 'tomorrow' })).toMatchObject({ detail: 'completion_due' });
      expect(await bad({ documentVersionId: ABSENT })).toMatchObject({ detail: 'document_version_id' });
      const dated = await create(input({ completionDue: '2027-12-31', requiresQualityAcceptance: false, contractValueVnd: '0010000' }));
      expect(await row(dated.id)).toMatchObject({ completion_due: expect.anything(), requires_quality_acceptance: false, contract_value_vnd: '10000' });
    });

    it('keeps the identity of a contract for good: the database refuses a change of its code, contractor, project, package, kind or currency', async () => {
      const made = await create(input());
      for (const change of ["code = 'HD-OTHER'", `contractor_id = '${SECOND}'`, `project_id = '${PROJECT_NO_PLAN}'`, `package_id = '${PACKAGE_NO_PLAN}'`, "type = 'EPC'", "currency = 'USD'"]) {
        const refused = await databaseRefusal(owner(`update machvon.contract set ${change} where id = $1::uuid`, [made.id]));
        expect(refused.sqlstate).toBe('23514');
      }
    });
  });

  describe('the status', () => {
    it('moves only along the state machine: the database refuses a jump and takes the steps of the machine', async () => {
      const made = await create(input());
      for (const status of ['ACTIVE', 'SIGNED', 'COMPLETED', 'CLOSED', 'TERMINATED', 'SUSPENDED']) {
        expect((await databaseRefusal(owner(`update machvon.contract set status = '${status}' where id = $1::uuid`, [made.id]))).message).toContain('CONTRACT_STATE_INVALID');
      }
      await owner("update machvon.contract set status = 'IN_REVIEW' where id = $1::uuid", [made.id]);
      await owner("update machvon.contract set status = 'DRAFT' where id = $1::uuid", [made.id]);
      await owner("update machvon.contract set status = 'CANCELLED' where id = $1::uuid", [made.id]);
      expect((await databaseRefusal(owner("update machvon.contract set status = 'DRAFT' where id = $1::uuid", [made.id]))).sqlstate).toBe('23514');
    });
  });

  describe('revising a draft', () => {
    it('changes the allowlist, keeps the first revision in step and bumps the version once', async () => {
      const made = await create(input({ code: 'HD-REV-1' }));
      const done = await as((tx) =>
        contracts.reviseDraft(tx, made.id, 1, { title: ' New title ', completionDue: '2028-01-31', contractValueVnd: '9000000000', requiresQualityAcceptance: false }, memberId(ACTOR), EVERYWHERE),
      );
      expect(done.version).toBe(2);
      expect(done.changes.map((change) => change.field)).toEqual(['title', 'completion_due', 'requires_quality_acceptance', 'contract_value_vnd']);
      expect(await row(made.id)).toMatchObject({ title: 'New title', version: '2', contract_value_vnd: '9000000000', requires_quality_acceptance: false, updated_by: memberId(ACTOR) });
      expect(await revisions(made.id)).toEqual([expect.objectContaining({ amount_vnd: '9000000000', version: '2', status: 'DRAFT' })]);
      const second = await as((tx) => contracts.reviseDraft(tx, made.id, 2, { documentVersionId: DOCUMENT, estimateCeilingVnd: '9500000000' }, memberId(ACTOR), EVERYWHERE));
      expect(second.changes.map((change) => change.field)).toEqual(['estimate_ceiling_vnd']);
      expect(await row(made.id)).toMatchObject({ estimate_ceiling_vnd: '9500000000', version: '3' });
    });

    it('refuses a value above the ceiling and a ceiling below the value, a ceiling above the price of the package, a stale version, and an empty request', async () => {
      const made = await create(input({ code: 'HD-REV-2' }));
      const revise = (change: Parameters<CtrContractStore['reviseDraft']>[3], version = 1) => refusal(as((tx) => contracts.reviseDraft(tx, made.id, version, change, memberId(ACTOR), EVERYWHERE)));
      expect(await revise({ contractValueVnd: '10200000001' })).toMatchObject({ code: 'CONTRACT_VALUE_EXCEEDS_CEILING', extensions: { ceiling_vnd: '10200000000' } });
      expect(await revise({ estimateCeilingVnd: '10000000000' })).toMatchObject({ code: 'CONTRACT_VALUE_EXCEEDS_CEILING', extensions: { ceiling_vnd: '10000000000' } });
      expect(await revise({ estimateCeilingVnd: '10200000001' })).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'estimate_ceiling_vnd' });
      expect(await revise({ title: 'x' }, 7)).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      expect(await revise({})).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'body' });
      expect(await revise({ documentVersionId: ABSENT })).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'document_version_id' });
      expect((await row(made.id))?.version).toBe('1');
    });

    it('writes nothing for a request that changes nothing', async () => {
      const made = await create(input({ code: 'HD-REV-3' }));
      const done = await as((tx) => contracts.reviseDraft(tx, made.id, 1, { title: 'Construction of the bridge', contractValueVnd: '10200000000', requiresQualityAcceptance: true }, memberId(ACTOR), EVERYWHERE));
      expect(done).toEqual({ version: 1, status: 'DRAFT', changes: [] });
      expect((await row(made.id))?.version).toBe('1');
    });

    it('takes a change only while the contract is a DRAFT', async () => {
      const made = await create(input({ code: 'HD-REV-4' }));
      await owner("update machvon.contract set status = 'IN_REVIEW' where id = $1::uuid", [made.id]);
      expect(await refusal(as((tx) => contracts.reviseDraft(tx, made.id, 1, { title: 'Late' }, memberId(ACTOR), EVERYWHERE)))).toEqual({ code: 'CONTRACT_STATE_INVALID', status: 409 });
    });

    it('tells a contract the caller cannot update from one that is out of sight', async () => {
      const made = await create(input({ code: 'HD-REV-5' }));
      const readOnly: ContractScopes = { update: contractScope(grant(UPDATE, { kind: 'UNIT_SUBTREE', refIds: [unitId(OTHER_BRANCH)], paths: ['/u3/'] }), UPDATE, NOW), read: EVERYWHERE.read };
      expect(await refusal(as((tx) => contracts.reviseDraft(tx, made.id, 1, { title: 'No' }, memberId(ACTOR), readOnly)))).toEqual({ code: 'SCOPE_DENIED', status: 403 });
      const blind: ContractScopes = { update: readOnly.update, read: contractScope(grant(READ, { kind: 'UNIT_SUBTREE', refIds: [unitId(OTHER_BRANCH)], paths: ['/u3/'] }), READ, NOW) };
      expect(await refusal(as((tx) => contracts.reviseDraft(tx, made.id, 1, { title: 'No' }, memberId(ACTOR), blind)))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(as((tx) => contracts.reviseDraft(tx, ABSENT, 1, { title: 'No' }, memberId(ACTOR), EVERYWHERE)))).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    });
  });

  describe('cancelling a draft', () => {
    it('cancels a DRAFT and a contract in review with the reason in the history, rejects the draft revision, and refuses a second cancellation', async () => {
      const made = await create(input({ code: 'HD-CAN-1' }));
      const done = await as((tx) => contracts.cancelDraft(tx, made.id, 1, '  Awarded to the wrong lot  ', memberId(ACTOR), EVERYWHERE, TODAY));
      expect(done).toEqual({ version: 2, status: 'CANCELLED', fromStatus: 'DRAFT' });
      expect(await row(made.id)).toMatchObject({ status: 'CANCELLED', status_reason: 'Awarded to the wrong lot', version: '2' });
      expect(await revisions(made.id)).toEqual([expect.objectContaining({ status: 'REJECTED', version: '2' })]);
      expect(await owner('select from_status, to_status, reason, effective_on::text as effective_on, command, created_by from machvon.contract_status_change where contract_id = $1::uuid', [made.id])).toEqual([
        { from_status: 'DRAFT', to_status: 'CANCELLED', reason: 'Awarded to the wrong lot', effective_on: TODAY, command: 'cancelContractDraft', created_by: memberId(ACTOR) },
      ]);
      expect(await refusal(as((tx) => contracts.cancelDraft(tx, made.id, 2, 'Again', memberId(ACTOR), EVERYWHERE, TODAY)))).toMatchObject({ code: 'CONTRACT_STATE_INVALID', status: 409, extensions: { contract_status: 'CANCELLED', command: 'cancelContractDraft' } });

      const reviewed = await create(input({ code: 'HD-CAN-2' }));
      await owner("update machvon.contract set status = 'IN_REVIEW' where id = $1::uuid", [reviewed.id]);
      expect(await as((tx) => contracts.cancelDraft(tx, reviewed.id, 1, 'Withdrawn', memberId(ACTOR), EVERYWHERE, TODAY))).toMatchObject({ fromStatus: 'IN_REVIEW' });
    });

    it('refuses a missing reason, a stale version, a contract that was signed, and the history cannot be rewritten', async () => {
      const made = await create(input({ code: 'HD-CAN-3' }));
      expect(await refusal(as((tx) => contracts.cancelDraft(tx, made.id, 1, '  ', memberId(ACTOR), EVERYWHERE, TODAY)))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'reason' });
      expect(await refusal(as((tx) => contracts.cancelDraft(tx, made.id, 4, 'Late', memberId(ACTOR), EVERYWHERE, TODAY)))).toMatchObject({ code: 'VERSION_CONFLICT' });
      await owner("update machvon.contract set status = 'IN_REVIEW' where id = $1::uuid", [made.id]);
      await owner("update machvon.contract set status = 'SIGNED' where id = $1::uuid", [made.id]);
      expect(await refusal(as((tx) => contracts.cancelDraft(tx, made.id, 1, 'Late', memberId(ACTOR), EVERYWHERE, TODAY)))).toMatchObject({ code: 'CONTRACT_STATE_INVALID' });
      const cancelled = await create(input({ code: 'HD-CAN-4' }));
      await as((tx) => contracts.cancelDraft(tx, cancelled.id, 1, 'Wrong lot', memberId(ACTOR), EVERYWHERE, TODAY));
      expect((await databaseRefusal(as((tx) => tx.query("update machvon.contract_status_change set reason = 'edited' where contract_id = $1::uuid", [cancelled.id])))).message).toContain('permission denied');
    });
  });

  describe('joint-venture members', () => {
    it('refuses shares that do not add up to 100, accepts 60 and 40 with the work adding up to the value of the contract (AC-ST-CTR-001-3)', async () => {
      const made = await venture({ code: 'HD-JV-1' });
      const short: PartyInput[] = [
        { contractorId: LEAD, role: 'LEAD', sharePct: '60', workValueVnd: '6000000000' },
        { contractorId: SECOND, role: 'MEMBER', sharePct: '30', workValueVnd: '4000000000' },
      ];
      expect(await refusal(replace(made.id, 1, readParties(short.map((party) => ({ contractor_id: party.contractorId, role: party.role, share_pct: party.sharePct, work_value_vnd: party.workValueVnd })))))).toEqual({
        code: 'JV_SHARE_NOT_100',
        status: 422,
        detail: 'parties',
        extensions: { share_total: '90.0000' },
      });
      expect(await members(made.id)).toEqual([]);

      const done = await replace(made.id, 1, split(LEAD, SECOND));
      expect(done).toMatchObject({ version: 2, status: 'DRAFT', changed: true, check: { shareTotal: '100.0000', workValueTotal: '10000000000', sharesComplete: true, workMatchesValue: true } });
      expect(done.parties.map((party) => [party.contractorName, party.role, party.sharePct, party.workValueVnd])).toEqual([
        ['Lead Builders', 'LEAD', '60.0000', '6000000000'],
        ['Second Builders', 'MEMBER', '40.0000', '4000000000'],
      ]);
      expect((await row(made.id))?.version).toBe('2');
    });

    it('refuses work that does not add up to the value of the contract, naming both figures', async () => {
      const made = await venture({ code: 'HD-JV-2' });
      const heavy = split(LEAD, SECOND).map((party, index) => (index === 0 ? { ...party, workValueVnd: '6000000001' } : party));
      expect(await refusal(replace(made.id, 1, heavy))).toEqual({
        code: 'BOQ_TOTAL_MISMATCH',
        status: 422,
        detail: 'parties',
        extensions: { work_value_total_vnd: '10000000001', contract_value_vnd: '10000000000' },
      });
    });

    it('replaces the members together, withdraws a member that leaves without deleting it, brings a returning member back on its row, and writes nothing for the same members', async () => {
      const made = await venture({ code: 'HD-JV-3' });
      await replace(made.id, 1, split(LEAD, SECOND));
      const again = await replace(made.id, 2, split(LEAD, SECOND));
      expect(again).toMatchObject({ version: 2, changed: false });
      const swapped: PartyInput[] = [
        { contractorId: LEAD, role: 'LEAD', sharePct: '70.0000', workValueVnd: '7000000000', validFrom: '2026-11-01' },
        { contractorId: RESTRICTED, role: 'MEMBER', sharePct: '30.0000', workValueVnd: '3000000000' },
      ];
      expect(await refusal(replace(made.id, 2, swapped))).toMatchObject({ code: 'CONTRACTOR_RESTRICTED' });
      const third = id(FAMILY, 25);
      await seedAs([[`insert into machvon.contractor (tenant_id, id, tax_identifier, legal_name, verification_status, profile_document_id) values ($1, $2, '0100000005', 'Third Builders', 'VERIFIED', $3)`, [TENANT_A, third, id(FAMILY, 40)]]]);
      const moved = await replace(made.id, 2, [swapped[0] as PartyInput, { contractorId: third, role: 'MEMBER', sharePct: '30.0000', workValueVnd: '3000000000' }]);
      expect(moved).toMatchObject({ version: 3, changed: true });
      expect((await members(made.id)).map((member) => [member.contractor_id === LEAD ? 'lead' : member.contractor_id === SECOND ? 'second' : 'third', member.status, member.share_pct])).toEqual(
        expect.arrayContaining([['lead', 'ACTIVE', '70.0000'], ['second', 'WITHDRAWN', '40.0000'], ['third', 'ACTIVE', '30.0000']]),
      );
      expect((await owner<{ valid_from: string }>('select valid_from::text as valid_from from machvon.contract_party where contract_id = $1::uuid and contractor_id = $2::uuid', [made.id, LEAD]))[0]?.valid_from).toBe('2026-11-01');
      const back = await replace(made.id, 3, split(LEAD, SECOND));
      expect(back.parties.map((party) => party.contractorId).sort()).toEqual([LEAD, SECOND].sort());
      expect((await members(made.id)).filter((member) => member.contractor_id === SECOND)).toHaveLength(1);
    });

    it('refuses a member whose validity ends before it begins, whether it names the start or takes the day of the replacement, and writes nothing', async () => {
      const made = await venture({ code: 'HD-JV-VALID' });
      const withValidity = (validFrom: string | undefined, validUntil: string): PartyInput[] =>
        split(LEAD, SECOND).map((party, index) => (index === 1 ? { ...party, ...(validFrom === undefined ? {} : { validFrom }), validUntil } : party));
      expect(await refusal(replace(made.id, 1, withValidity('2026-12-01', '2026-11-30')))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'parties.1.valid_until' });
      // No start named: the member starts on the day of the replacement (TODAY), so an end before it is an end before the start.
      expect(await refusal(replace(made.id, 1, withValidity(undefined, '2026-10-23')))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'parties.1.valid_until' });
      expect(await members(made.id)).toEqual([]);
      expect((await row(made.id))?.version).toBe('1');
      // One day is a valid span.
      expect(await replace(made.id, 1, withValidity('2026-12-01', '2026-12-01'))).toMatchObject({ changed: true, version: 2 });
    });

    it('refuses what is not a venture: a contract of one contractor, two leads, no lead, a lead that is not the contractor of the contract, a member twice, a contractor that is not verified', async () => {
      const single = await create(input({ code: 'HD-JV-4' }));
      expect(await refusal(replace(single.id, 1, split(LEAD, SECOND)))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'parties' });
      const made = await venture({ code: 'HD-JV-5' });
      const twoLeads = split(LEAD, SECOND).map((party) => ({ ...party, role: 'LEAD' as const }));
      expect(await refusal(replace(made.id, 1, twoLeads))).toMatchObject({ detail: 'parties' });
      expect(await refusal(replace(made.id, 1, split(LEAD, SECOND).map((party) => ({ ...party, role: 'MEMBER' as const }))))).toMatchObject({ detail: 'parties' });
      expect(await refusal(replace(made.id, 1, split(SECOND, LEAD)))).toMatchObject({ detail: 'parties' });
      expect(await refusal(replace(made.id, 1, split(LEAD, LEAD)))).toMatchObject({ detail: 'parties.1.contractor_id' });
      expect(await refusal(replace(made.id, 1, split(LEAD, UNVERIFIED)))).toEqual({ code: 'CONTRACTOR_NOT_VERIFIED', status: 422 });
      expect(await refusal(replace(made.id, 1, split(LEAD, ABSENT)))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'parties.1.contractor_id' });
      expect(await refusal(replace(made.id, 9, split(LEAD, SECOND)))).toMatchObject({ code: 'VERSION_CONFLICT' });
      await owner("update machvon.contract set status = 'CANCELLED' where id = $1::uuid", [made.id]);
      expect(await refusal(replace(made.id, 1, split(LEAD, SECOND)))).toEqual({ code: 'CONTRACT_STATE_INVALID', status: 409 });
    });

    it('is judged again at commit by the database: after the contract is signed, a share that is dropped, a member that is removed and a member that is added are refused with SQLSTATE 23514 (AC-ST-CTR-001-3)', async () => {
      const made = await venture({ code: 'HD-JV-6' });
      await replace(made.id, 1, split(LEAD, SECOND));
      await sign(made.id);
      expect(await row(made.id)).toMatchObject({ status: 'SIGNED' });
      const dropped = await databaseRefusal(owner("update machvon.contract_party set share_pct = 50 where contract_id = $1::uuid and contractor_id = $2::uuid", [made.id, SECOND]));
      expect(dropped).toMatchObject({ sqlstate: '23514', message: expect.stringContaining('JV_SHARE_NOT_100') });
      expect((await databaseRefusal(owner('delete from machvon.contract_party where contract_id = $1::uuid and contractor_id = $2::uuid', [made.id, SECOND]))).sqlstate).toBe('23514');
      expect(
        (await databaseRefusal(owner(`insert into machvon.contract_party (tenant_id, id, contract_id, contractor_id, role, share_pct, work_value_vnd, valid_from, created_by, updated_by)
          values ($1, $2, $3, $4, 'MEMBER', 5, 1, date '2026-10-24', $5, $5)`, [TENANT_A, randomUUID(), made.id, UNVERIFIED, memberId(ACTOR)]))).sqlstate,
      ).toBe('23514');
      expect(await members(made.id)).toHaveLength(2);
      // A swap in one transaction that ends at 100 is fine: the check is at commit, on the result.
      const client = new Client({ connectionString: harness.database.urlFor('machvon_owner') });
      await client.connect();
      try {
        await client.query("select set_config('app.tenant_id', $1, false)", [TENANT_A]);
        await client.query('begin');
        await client.query('update machvon.contract_party set share_pct = 50, work_value_vnd = 5000000000 where contract_id = $1::uuid', [made.id]);
        await client.query('commit');
      } finally {
        await client.end();
      }
      expect((await members(made.id)).map((member) => member.share_pct)).toEqual(['50.0000', '50.0000']);
    });

    it('refuses to leave the draft states with members that do not add up to 100 or work that does not add up to the value, and a venture without members', async () => {
      const lacking = await venture({ code: 'HD-JV-7' });
      await owner("update machvon.contract set status = 'IN_REVIEW' where id = $1::uuid", [lacking.id]);
      expect((await databaseRefusal(owner("update machvon.contract set status = 'SIGNED' where id = $1::uuid", [lacking.id]))).message).toContain('JV_SHARE_NOT_100');
      const mismatch = await venture({ code: 'HD-JV-8' });
      await replace(mismatch.id, 1, split(LEAD, SECOND));
      await owner("update machvon.contract set status = 'IN_REVIEW' where id = $1::uuid", [mismatch.id]);
      await owner('update machvon.contract_party set work_value_vnd = work_value_vnd + 1 where contract_id = $1::uuid and role = $2', [mismatch.id, 'LEAD']);
      expect((await databaseRefusal(owner("update machvon.contract set status = 'SIGNED' where id = $1::uuid", [mismatch.id]))).message).toContain('BOQ_TOTAL_MISMATCH');
      const plain = await create(input({ code: 'HD-JV-9' }));
      await owner("update machvon.contract set status = 'IN_REVIEW' where id = $1::uuid", [plain.id]);
      await owner("update machvon.contract set status = 'SIGNED' where id = $1::uuid", [plain.id]);
      expect((await row(plain.id))?.status).toBe('SIGNED');
    });
  });

  describe('reading', () => {
    it('shows a guest contractor only the contracts of its grant, as a list of one and as a detail, and every other id as absent, also in another tenant (AC-ST-CTR-001-4)', async () => {
      const one = await create(input({ code: 'HD-G-001' }));
      const two = await create(input({ code: 'HD-G-002' }));
      const guest = grant(READ, { kind: 'CONTRACT', refIds: [one.id] });
      const page = await as((tx) => contracts.list(tx, readOf(guest), { limit: 10, after: undefined }));
      expect(page.map((line) => line.code)).toEqual(['HD-G-001']);
      expect(await as((tx) => contracts.find(tx, one.id, readOf(guest)))).toMatchObject({ code: 'HD-G-001', status: 'DRAFT' });
      expect(await as((tx) => contracts.find(tx, two.id, readOf(guest)))).toBeUndefined();
      expect(await as((tx) => contracts.find(tx, one.id, readOf(guest)), TENANT_B)).toBeUndefined();
      expect((await as((tx) => contracts.listRevisions(tx, readOf(guest), { limit: 10, after: undefined }))).map((revision) => revision.contractCode)).toEqual(['HD-G-001']);
      const foreignRevision = (await revisions(two.id))[0]?.id as string;
      expect(await as((tx) => contracts.findRevision(tx, foreignRevision, readOf(guest)))).toBeUndefined();
      const nothing = grant('ledger.read', { kind: 'CONTRACT', refIds: [one.id] });
      expect(await as((tx) => contracts.list(tx, readOf(nothing), { limit: 10, after: undefined }))).toEqual([]);
    });

    it('reads by the unit tree, the project and the investor, and pages by code and id', async () => {
      await create(input({ code: 'HD-P-001' }));
      await create(input({ code: 'HD-P-002' }));
      const other = await create(input({ code: 'HD-P-003', projectId: PROJECT_OTHER_BRANCH, packageId: PACKAGE_OTHER_BRANCH, contractValueVnd: '1000' }));
      const codes = async (access: EffectiveAccess, prefix = 'HD-P-') =>
        (await as((tx) => contracts.list(tx, readOf(access), { limit: 50, after: undefined }))).map((line) => line.code).filter((code) => code.startsWith(prefix));
      expect(await codes(grant(READ, { kind: 'TENANT' }))).toEqual(['HD-P-001', 'HD-P-002', 'HD-P-003']);
      // The investor unit (the province) reaches the contracts of a project that a department owns.
      expect(await codes(grant(READ, { kind: 'UNIT_ONLY', refIds: [unitId(PROVINCE)] }))).toEqual(['HD-P-001', 'HD-P-002']);
      expect(await codes(grant(READ, { kind: 'UNIT_SUBTREE', refIds: [unitId(OTHER_BRANCH)], paths: ['/u3/'] }))).toEqual(['HD-P-003']);
      expect(await codes(grant(READ, { kind: 'PROJECT', refIds: [PROJECT_OTHER_BRANCH] }))).toEqual(['HD-P-003']);
      expect(await codes(grant(READ, { kind: 'PROJECT', refIds: [ABSENT] }))).toEqual([]);
      const first = await as((tx) => contracts.list(tx, EVERYWHERE.read, { limit: 2, after: undefined }));
      const next = await as((tx) => contracts.list(tx, EVERYWHERE.read, { limit: 2, after: { code: first[1]?.code as string, id: first[1]?.id as string } }));
      expect((next[0]?.code as string) > (first[1]?.code as string)).toBe(true);
      const revisionPage = await as((tx) => contracts.listRevisions(tx, EVERYWHERE.read, { limit: 2, after: undefined }));
      const revisionNext = await as((tx) => contracts.listRevisions(tx, EVERYWHERE.read, { limit: 2, after: { code: revisionPage[1]?.key as string, id: revisionPage[1]?.id as string } }));
      expect((revisionNext[0]?.key as string) > (revisionPage[1]?.key as string)).toBe(true);
      expect(other.status).toBe('DRAFT');
    });

    it('names the project with the units its scope is judged by, and none for a project that is not in the tenant', async () => {
      const source = new CtrContractSource();
      expect(await as((tx) => source.projectRef(tx, PROJECT))).toEqual({
        id: PROJECT,
        status: 'IMPLEMENTATION',
        ownerUnit: { id: unitId(DEPARTMENT), path: '/u1/u2/' },
        investorUnit: { id: unitId(PROVINCE), path: '/u1/' },
      });
      await seedAs([[`update machvon.project set investor_unit_id = null where id = $1::uuid and tenant_id = $2`, [PROJECT_OTHER_BRANCH, TENANT_A]]]);
      expect(await as((tx) => source.projectRef(tx, PROJECT_OTHER_BRANCH))).toMatchObject({ investorUnit: null });
      expect(await as((tx) => source.projectRef(tx, ABSENT))).toBeUndefined();
      expect(await as((tx) => source.projectRef(tx, PROJECT), TENANT_B)).toMatchObject({ id: PROJECT });
    });

    it('gives the detail with the revision, the members and their sums, the history and the totals of the ledger', async () => {
      const made = await venture({ code: 'HD-D-001' });
      await replace(made.id, 1, split(LEAD, SECOND));
      await as((tx) => contracts.cancelDraft(tx, made.id, 2, 'Closed down', memberId(ACTOR), EVERYWHERE, TODAY));
      const detail = await as((tx) => contracts.find(tx, made.id, EVERYWHERE.read));
      expect(detail).toMatchObject({
        code: 'HD-D-001',
        status: 'CANCELLED',
        projectCode: 'PRJ-A-001',
        contractorName: 'Lead Builders',
        isJointVenture: true,
        advanceCategory: 'CONSTRUCTION',
        statusReason: 'Closed down',
        ledger: { acceptedTotalVnd: '0', paidTotalVnd: '0', advanceOutstandingVnd: '0', retentionHeldVnd: '0' },
        partiesCheck: { shareTotal: '100.0000', sharesComplete: true, workMatchesValue: true },
      });
      expect(detail?.revisions).toHaveLength(1);
      expect(detail?.parties).toHaveLength(2);
      expect(detail?.statusChanges).toEqual([expect.objectContaining({ fromStatus: 'DRAFT', toStatus: 'CANCELLED', reason: 'Closed down' })]);
      expect(detail?.reach).toEqual({ contractId: made.id, projectId: PROJECT, ownerUnit: { id: unitId(DEPARTMENT), path: '/u1/u2/' }, investorUnit: { id: unitId(PROVINCE), path: '/u1/' } });
    });
  });
});

describe('the rules of the register that need no database', () => {
  it('reads whole VND, rejecting anything that is not digits or is too long, and calendar dates, rejecting dates that do not exist', () => {
    expect(wholeAmount('0007', 'x')).toBe('7');
    expect(() => wholeAmount('1.5', 'x')).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED', detail: 'x' }));
    expect(() => wholeAmount('', 'x')).toThrow(expect.objectContaining({ detail: 'x' }));
    expect(calendarDate('2028-02-29', 'd')).toBe('2028-02-29');
    expect(() => calendarDate('2027-02-29', 'd')).toThrow(expect.objectContaining({ detail: 'd' }));
    expect(() => calendarDate('27-02-2027', 'd')).toThrow(expect.objectContaining({ detail: 'd' }));
  });

  it('adds up shares and work as exact decimals', () => {
    const list = [
      { sharePct: '33.3333', workValueVnd: '3' },
      { sharePct: '66.6667', workValueVnd: '7' },
    ];
    expect(partiesCheck(list, '10')).toEqual({ shareTotal: '100.0000', workValueTotal: '10', sharesComplete: true, workMatchesValue: true });
    expect(partiesCheck(list.slice(0, 1), '10')).toMatchObject({ shareTotal: '33.3333', sharesComplete: false, workMatchesValue: false });
    expect(partiesCheck([], '0')).toMatchObject({ shareTotal: '0', sharesComplete: false, workMatchesValue: true });
  });

  it('reads the members of the body strictly: the allowlist, the shapes and the range', () => {
    const member = (extra: Record<string, unknown> = {}) => ({ contractor_id: LEAD, role: 'LEAD', share_pct: '60', work_value_vnd: '6', ...extra });
    const two = (first: Record<string, unknown>) => [first, member({ contractor_id: SECOND, role: 'MEMBER', share_pct: '40.5' })];
    expect(readParties(two(member({ valid_from: '2026-11-01', valid_until: '2027-01-01' })))).toEqual([
      { contractorId: LEAD, role: 'LEAD', sharePct: '60.0000', workValueVnd: '6', validFrom: '2026-11-01', validUntil: '2027-01-01' },
      { contractorId: SECOND, role: 'MEMBER', sharePct: '40.5000', workValueVnd: '6', validFrom: undefined, validUntil: undefined },
    ]);
    const refused = (list: readonly unknown[]) => {
      try {
        readParties(list);
      } catch (error) {
        return { code: (error as { code: string }).code, detail: (error as { detail: string }).detail };
      }
      throw new Error('expected a refusal');
    };
    expect(refused(two(member({ status: 'ACTIVE' })))).toEqual({ code: 'FIELD_NOT_ALLOWED', detail: 'parties.0.status' });
    expect(refused([member()])).toEqual({ code: 'VALIDATION_FAILED', detail: 'parties' });
    expect(refused(Array.from({ length: 21 }, () => member()))).toEqual({ code: 'VALIDATION_FAILED', detail: 'parties' });
    expect(refused(['x', member()])).toEqual({ code: 'VALIDATION_FAILED', detail: 'parties.0' });
    expect(refused(two(member({ contractor_id: 'nope' })))).toEqual({ code: 'VALIDATION_FAILED', detail: 'parties.0.contractor_id' });
    expect(refused(two(member({ contractor_id: 7 })))).toEqual({ code: 'VALIDATION_FAILED', detail: 'parties.0.contractor_id' });
    expect(refused(two(member({ role: 'SOLE' })))).toEqual({ code: 'VALIDATION_FAILED', detail: 'parties.0.role' });
    for (const share of ['0', '0.0000', '100.1', '101', '-5', '5.12345', '1e2', 60, '']) expect(refused(two(member({ share_pct: share })))).toEqual({ code: 'VALIDATION_FAILED', detail: 'parties.0.share_pct' });
    expect(refused(two(member({ work_value_vnd: '1.5' })))).toEqual({ code: 'VALIDATION_FAILED', detail: 'parties.0.work_value_vnd' });
    expect(refused(two(member({ valid_from: '2026-02-30' })))).toEqual({ code: 'VALIDATION_FAILED', detail: 'parties.0.valid_from' });
    expect(readParties(two(member({ share_pct: '100' })))[0]?.sharePct).toBe('100.0000');
  });
});
