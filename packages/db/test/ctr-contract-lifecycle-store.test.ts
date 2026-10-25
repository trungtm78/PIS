import { randomUUID } from 'node:crypto';
import { DomainError } from '@machvon/kernel';
import type { ContractScopes } from '../src/ctr-contract-store';
import { CtrContractLifecycleStore } from '../src/ctr-contract-lifecycle-store';
import type { CommitmentOutcome, ContractFacts, LifecycleHooks } from '../src/ctr-contract-lifecycle-store';
import { PmtGateStore } from '../src/pmt-gate-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, contextFor, id, memberId, unitId } from './support/authz-fixtures';
import { DEPARTMENT, PROVINCE, seedAs } from './support/bid-proposal-fixtures';

const harness = new AuthzHarness();
const lifecycle = new CtrContractLifecycleStore();
const gates = new PmtGateStore();
const FAMILY = 0xa7;
const DRAFTER = 1;
const SUBMITTER = 2;
const CHECKER = 3;
const SIGNER = 4;
const TODAY = '2026-10-25';
const VALUE = '10000000000';
const everything: ContractScopes = { update: () => ({ sql: 'true', params: [] }), read: () => ({ sql: 'true', params: [] }) };
const nothingUpdate: ContractScopes = { update: () => ({ sql: 'false', params: [] }), read: () => ({ sql: 'true', params: [] }) };

const PROJECT = id(FAMILY, 1);
const PROJECT_NO_PLAN = id(FAMILY, 2);
const PROJECT_PLANNING = id(FAMILY, 3);
const CONTRACTOR = id(FAMILY, 10);
const OTHER_CONTRACTOR = id(FAMILY, 11);
const UNVERIFIED_CONTRACTOR = id(FAMILY, 12);
const RESTRICTED_CONTRACTOR = id(FAMILY, 13);
const ALLOCATION_LINE = id(FAMILY, 20);
const DOCUMENT = id(FAMILY, 30);
const CLEAN = id(FAMILY, 31);
const PENDING = id(FAMILY, 32);
const INFECTED = id(FAMILY, 33);
const SEALED = id(FAMILY, 34);
const EVIDENCE = id(FAMILY, 35);

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = CHECKER): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string; extensions?: Record<string, unknown> }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string; extensions?: Record<string, unknown> };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }), ...(e.extensions === undefined ? {} : { extensions: e.extensions }) };
  }
  throw new Error('expected a refusal');
}

const databaseRefusal = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    return (error as { message: string }).message;
  }
  throw new Error('expected the database to refuse');
};

let counter = 0;

interface Options {
  status?: string;
  createdBy?: number;
  submittedBy?: number | null;
  category?: string;
  project?: string;
  contractor?: string;
  boqTotal?: string;
  jv?: boolean;
  withAllocation?: boolean;
  signedBy?: number;
  signedOn?: string;
}

interface Seeded {
  id: string;
  revisionId: string;
  packageId: string;
  code: string;
}

/** A contract in the status asked for, with its first revision, a bill of quantities that adds up, and a package on a line of capital. */
async function seedContract(options: Options = {}): Promise<Seeded> {
  counter += 1;
  const contractId = randomUUID();
  const revisionId = randomUUID();
  const packageId = randomUUID();
  const status = options.status ?? 'DRAFT';
  const code = `HD-${String(counter).padStart(4, '0')}`;
  const signed = !['DRAFT', 'IN_REVIEW', 'CANCELLED'].includes(status);
  await seedAs(harness, [
    [
      `insert into machvon.procurement_package (tenant_id, id, project_id, code, budget_vnd, method, revision, status, title, allocation_line_id, created_by, version)
       values ($1, $2, $3, $4, 20000000000, 'OPEN_BIDDING', 1, 'AWARDED', 'Package', $5, $6, 1)`,
      [TENANT_A, packageId, options.project ?? PROJECT, `GT-${code}`, options.withAllocation === false ? null : ALLOCATION_LINE, memberId(DRAFTER)],
    ],
    [
      `insert into machvon.contract
         (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, title, advance_category, is_joint_venture, requires_quality_acceptance,
          contract_value_vnd, estimate_ceiling_vnd, created_by, updated_by, submitted_by, signed_on, signed_by, signed_document_version_id)
       values ($1, $2, $3, $4, $5, $6, 'LUMP_SUM', 'VND', $7, 1, 'Contract', $8, $9, true, $10, 20000000000, $11, $11, $12, $13::date, $14, $15)`,
      [
        TENANT_A,
        contractId,
        options.project ?? PROJECT,
        packageId,
        options.contractor ?? CONTRACTOR,
        code,
        status,
        options.category ?? 'CONSTRUCTION',
        options.jv ?? false,
        VALUE,
        memberId(options.createdBy ?? DRAFTER),
        options.submittedBy === undefined ? (status === 'IN_REVIEW' || signed ? memberId(SUBMITTER) : null) : options.submittedBy === null ? null : memberId(options.submittedBy),
        signed ? (options.signedOn ?? '2026-10-01') : null,
        signed ? memberId(options.signedBy ?? SIGNER) : null,
        signed ? CLEAN : null,
      ],
    ],
    [
      `insert into machvon.contract_revision (tenant_id, id, contract_id, revision, amount_vnd, document_version_id, valid_from, status, kind, version, created_by, updated_by)
       values ($1, $2, $3, 1, $4, $5, date '2026-10-01', $6, 'BASE', 1, $7, $7)`,
      [TENANT_A, revisionId, contractId, VALUE, DOCUMENT_VERSION, status === 'CANCELLED' ? 'REJECTED' : 'DRAFT', memberId(DRAFTER)],
    ],
    [
      `insert into machvon.boq_line (tenant_id, id, contract_revision_id, contract_id, boq_item_id, line_no, business_key, description, unit_code, quantity, unit_price, rounding_rule, amount_vnd, created_by)
       values ($1, gen_random_uuid(), $2, $3, gen_random_uuid(), 1, 'B01', 'Works', 'LS', 1, $4, 'HALF_UP', $4, $5)`,
      [TENANT_A, revisionId, contractId, options.boqTotal ?? VALUE, memberId(DRAFTER)],
    ],
  ]);
  return { id: contractId, revisionId, packageId, code };
}

const DOCUMENT_VERSION = id(FAMILY, 36);

const hooks = (overrides: Partial<LifecycleHooks> = {}): LifecycleHooks & { authorise: jest.Mock; commit: jest.Mock } => {
  const outcome: CommitmentOutcome = { entryId: id(FAMILY, 90), replayed: false, warningAcknowledged: false };
  return {
    authorise: jest.fn(async (facts: ContractFacts) => void facts),
    commit: jest.fn(async () => outcome),
    ...overrides,
  } as LifecycleHooks & { authorise: jest.Mock; commit: jest.Mock };
};

const row = async (contractId: string) =>
  (
    await owner<{
      status: string;
      version: string;
      submitted_by: string | null;
      signed_by: string | null;
      signed_on: string | null;
      signed_document_version_id: string | null;
      conflict_decision_ref: string | null;
      activated_by: string | null;
      effective_from: string | null;
      current_revision_id: string | null;
      status_reason: string | null;
    }>(
      `select status, version::text, submitted_by, signed_by, signed_on::text, signed_document_version_id, conflict_decision_ref, activated_by, effective_from::text, current_revision_id, status_reason
         from machvon.contract where id = $1::uuid`,
      [contractId],
    )
  )[0];
const changes = (contractId: string) =>
  owner<{ from_status: string; to_status: string; reason: string; command: string; created_by: string; decision_document_version_id: string | null; effective_on: string }>(
    'select from_status, to_status, reason, command, created_by, decision_document_version_id, effective_on::text from machvon.contract_status_change where contract_id = $1::uuid order by created_at, id',
    [contractId],
  );

const submit = (seeded: Seeded, version = 1, note?: string, member = SUBMITTER, scopes = everything) => as((tx) => lifecycle.submit(tx, seeded.id, version, note, memberId(member), scopes, TODAY), member);
const giveBack = (seeded: Seeded, version = 1, reason = 'The bill of quantities has to be corrected.', member = CHECKER) =>
  as((tx) => lifecycle.returnToDraft(tx, seeded.id, version, reason, memberId(member), everything, TODAY), member);
const sign = (seeded: Seeded, version = 1, input: Partial<Parameters<CtrContractLifecycleStore['sign']>[3]> = {}, member = SIGNER, h: Pick<LifecycleHooks, 'authorise'> = hooks()) =>
  as((tx) => lifecycle.sign(tx, seeded.id, version, { signedOn: '2026-10-20', signedDocumentVersionId: CLEAN, ...input }, memberId(member), everything, TODAY, h), member);
const activate = (seeded: Seeded, version = 1, input: Partial<Parameters<CtrContractLifecycleStore['activate']>[3]> = {}, member = CHECKER, h: LifecycleHooks = hooks()) =>
  as((tx) => lifecycle.activate(tx, seeded.id, version, { effectiveFrom: '2026-11-01', reason: 'All conditions are met.', evidenceIds: [], ...input }, memberId(member), everything, TODAY, h), member);

const declare = (member: number, packageId: string, options: { contractorId?: string | null; decision?: 'ALLOWED' | 'RECUSED' | 'BLOCKED' | null } = {}) =>
  seedAs(harness, [
    [
      options.decision === undefined || options.decision === null
        ? `insert into machvon.bid_conflict_declaration (tenant_id, id, package_id, user_id, has_conflict, relation_text, contractor_id, created_by, updated_by)
           values ($1, $2, $3, $4, true, 'A relation.', $5, $4, $4)`
        : `insert into machvon.bid_conflict_declaration (tenant_id, id, package_id, user_id, has_conflict, relation_text, contractor_id, decision, decided_by, decided_at, decision_reason, created_by, updated_by)
           values ($1, $2, $3, $4, true, 'A relation.', $5, '${options.decision}', $6, now(), 'A reason that is long enough.', $4, $4)`,
      options.decision === undefined || options.decision === null
        ? [TENANT_A, randomUUID(), packageId, memberId(member), options.contractorId === undefined ? CONTRACTOR : options.contractorId]
        : [TENANT_A, randomUUID(), packageId, memberId(member), options.contractorId === undefined ? CONTRACTOR : options.contractorId, memberId(9)],
    ],
  ]);

describe('the review, the signing and the activation of a contract (ST-CTR-004)', () => {
  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [
      { n: PROVINCE, path: '/u1/' },
      { n: DEPARTMENT, path: '/u1/u2/', parent: PROVINCE },
    ]);
    for (const n of [DRAFTER, SUBMITTER, CHECKER, SIGNER, 9]) await harness.seedMembership(TENANT_A, n, PROVINCE);
    await seedAs(harness, [
      [
        `insert into machvon.contractor (tenant_id, id, tax_identifier, legal_name, verification_status, profile_document_id)
         values ($1, $2, '0100000001', 'Lead Builders', 'VERIFIED', $6), ($1, $3, '0100000002', 'Other Builders', 'VERIFIED', $6),
                ($1, $4, '0100000003', 'Unverified Builders', 'UNVERIFIED', $6), ($1, $5, '0100000004', 'Restricted Builders', 'VERIFIED', $6)`,
        [TENANT_A, CONTRACTOR, OTHER_CONTRACTOR, UNVERIFIED_CONTRACTOR, RESTRICTED_CONTRACTOR, DOCUMENT],
      ],
      [
        `insert into machvon.contractor_restriction (tenant_id, id, contractor_id, kind, source, effective_from, decision_document_id, created_by, updated_by)
         values ($1, $2, $3, 'DEBARMENT', 'DECISION', date '2020-01-01', $5, $4, $4)`,
        [TENANT_A, id(FAMILY, 40), RESTRICTED_CONTRACTOR, memberId(DRAFTER), DOCUMENT],
      ],
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, 'PRJ-L-001', 'Project with a plan', $5, $4, $6, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B'),
                ($1, $3, 'PRJ-L-002', 'Project without a plan', $5, $4, $6, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B'),
                ($1, $7, 'PRJ-L-003', 'Project still in planning', $5, $4, $6, 'INTERNAL', 1000, 'PIPELINE', 1, 'B')`,
        [TENANT_A, PROJECT, PROJECT_NO_PLAN, unitId(PROVINCE), unitId(DEPARTMENT), id(FAMILY, 41), PROJECT_PLANNING],
      ],
      [
        `insert into machvon.plan_version (tenant_id, id, project_id, fiscal_year, revision, decision_id, status, effective_at)
         values ($1, $2, $3, 2026, 1, $5, 'APPROVED', now()), ($1, $4, $6, 2026, 1, $5, 'APPROVED', now())`,
        [TENANT_A, id(FAMILY, 42), PROJECT, id(FAMILY, 43), id(FAMILY, 44), PROJECT_PLANNING],
      ],
      [
        `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'HD', 'Contract', 'INTERNAL', $3, $3), ($1, $4, 'ATTACHMENT', 'BID-PROPOSAL-FILE', 'A bid', 'CONFIDENTIAL', $3, $3)`,
        [TENANT_A, DOCUMENT, memberId(DRAFTER), id(FAMILY, 37)],
      ],
      [
        `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
         values ($1, $2, $3, 1, 'tenants/ctr/a.pdf', repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL'),
                ($1, $4, $3, 2, 'tenants/ctr/b.pdf', repeat('b', 64), 'application/pdf', 1, 'INTERNAL', 'PENDING', '{}'::jsonb, 'RENDERED_FINAL'),
                ($1, $5, $3, 3, 'tenants/ctr/c.pdf', repeat('c', 64), 'application/pdf', 1, 'INTERNAL', 'INFECTED', '{}'::jsonb, 'RENDERED_FINAL'),
                ($1, $7, $3, 4, 'tenants/ctr/d.pdf', repeat('d', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL'),
                ($1, $8, $6, 1, 'tenants/ctr/e.pdf', repeat('e', 64), 'application/pdf', 1, 'CONFIDENTIAL', 'CLEAN', '{}'::jsonb, 'ATTACHMENT')`,
        [TENANT_A, CLEAN, DOCUMENT, PENDING, INFECTED, id(FAMILY, 37), DOCUMENT_VERSION, SEALED],
      ],
      [`update machvon.document set subject_module = 'BID_PROPOSAL', subject_id = $2 where id = $1`, [id(FAMILY, 37), randomUUID()]],
      [
        `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'EVIDENCE', 'Evidence', 'INTERNAL', $3, $3)`,
        [TENANT_A, EVIDENCE, memberId(DRAFTER)],
      ],
    ]);
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  // The declarations belong to the case that made them: the next case starts with nobody in conflict.
  beforeEach(() => owner('delete from machvon.bid_conflict_declaration'));

  describe('submitContractForReview', () => {
    it('sends a complete draft to review: IN_REVIEW, who sent it, one row of the history, and the version moves', async () => {
      const seeded = await seedContract();
      const done = await submit(seeded, 1, '  Ready for the committee.  ');
      expect(done).toMatchObject({ id: seeded.id, code: seeded.code, fromStatus: 'DRAFT', status: 'IN_REVIEW', version: 2, reason: 'Ready for the committee.' });
      expect(await row(seeded.id)).toMatchObject({ status: 'IN_REVIEW', version: '2', submitted_by: memberId(SUBMITTER), status_reason: null });
      expect(await changes(seeded.id)).toEqual([{ from_status: 'DRAFT', to_status: 'IN_REVIEW', reason: 'Ready for the committee.', command: 'submitContractForReview', created_by: memberId(SUBMITTER), decision_document_version_id: null, effective_on: TODAY }]);
    });

    it('says what it did when no note was given', async () => {
      const seeded = await seedContract();
      expect((await submit(seeded)).reason).toBe('Sent to review');
    });

    it('refuses a stale version (409 VERSION_CONFLICT), a contract that is not a draft (409 CONTRACT_STATE_INVALID) and a contract outside the scope, and writes nothing', async () => {
      const seeded = await seedContract();
      expect(await refusal(submit(seeded, 7))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      expect(await refusal(submit(seeded, 1, undefined, SUBMITTER, nothingUpdate))).toMatchObject({ code: 'SCOPE_DENIED', status: 403 });
      const inReview = await seedContract({ status: 'IN_REVIEW' });
      expect(await refusal(submit(inReview))).toMatchObject({ code: 'CONTRACT_STATE_INVALID', status: 409, extensions: { contract_status: 'IN_REVIEW', command: 'submitContractForReview' } });
      expect(await refusal(as((tx) => lifecycle.submit(tx, randomUUID(), 1, undefined, memberId(SUBMITTER), everything, TODAY)))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await row(seeded.id)).toMatchObject({ status: 'DRAFT', version: '1' });
      expect(await changes(seeded.id)).toEqual([]);
    });

    it('refuses a bill of quantities that does not add up to the value of the contract (422 BOQ_TOTAL_MISMATCH), also when it is empty', async () => {
      const short = await seedContract({ boqTotal: '9999999999' });
      expect(await refusal(submit(short))).toMatchObject({ code: 'BOQ_TOTAL_MISMATCH', status: 422, extensions: { boq_total_vnd: '9999999999', contract_value_vnd: VALUE } });
      const empty = await seedContract();
      await seedAs(harness, [['delete from machvon.boq_line where contract_id = $1', [empty.id]]]);
      expect(await refusal(submit(empty))).toMatchObject({ code: 'BOQ_TOTAL_MISMATCH', extensions: { boq_total_vnd: '0' } });
    });

    it('refuses a project without an approved capital plan (422 CAPITAL_PLAN_NOT_APPROVED)', async () => {
      const seeded = await seedContract({ project: PROJECT_NO_PLAN });
      expect(await refusal(submit(seeded))).toMatchObject({ code: 'CAPITAL_PLAN_NOT_APPROVED', status: 422 });
    });

    it('refuses a contractor that is no longer verified or has been restricted since (422)', async () => {
      expect(await refusal(submit(await seedContract({ contractor: UNVERIFIED_CONTRACTOR })))).toMatchObject({ code: 'CONTRACTOR_NOT_VERIFIED', status: 422 });
      expect(await refusal(submit(await seedContract({ contractor: RESTRICTED_CONTRACTOR })))).toMatchObject({ code: 'CONTRACTOR_RESTRICTED', status: 422 });
    });

    it('refuses a joint venture whose members do not add up to 100 percent of the contract (422 JV_SHARE_NOT_100)', async () => {
      const seeded = await seedContract({ jv: true });
      const member = (contractor: string, role: string, share: string, work: string) =>
        seedAs(harness, [
          [
            `insert into machvon.contract_party (tenant_id, id, contract_id, contractor_id, role, share_pct, work_value_vnd, valid_from, status, created_by, updated_by)
             values ($1, gen_random_uuid(), $2, $3, $4, $5::numeric, $6::numeric, date '2026-10-01', 'ACTIVE', $7, $7)`,
            [TENANT_A, seeded.id, contractor, role, share, work, memberId(DRAFTER)],
          ],
        ]);
      await member(CONTRACTOR, 'LEAD', '60', '6000000000');
      await member(OTHER_CONTRACTOR, 'MEMBER', '30', '3000000000');
      expect(await refusal(submit(seeded))).toMatchObject({ code: 'JV_SHARE_NOT_100', status: 422, extensions: { share_total: '90.0000' } });
    });

    it('AC-ST-CTR-004-1, UAT-AC56: blocks a caller who declared a relation with the contractor, and names the declaration', async () => {
      const seeded = await seedContract();
      await declare(SUBMITTER, id(FAMILY, 99), { contractorId: CONTRACTOR });
      const blocked = await refusal(submit(seeded));
      expect(blocked).toMatchObject({ code: 'CONFLICT_OF_INTEREST_BLOCKED', status: 409, extensions: { contractor_id: CONTRACTOR, conflict_of: 'ACTOR' } });
      expect(typeof blocked.extensions?.declaration_id).toBe('string');
      expect(await row(seeded.id)).toMatchObject({ status: 'DRAFT', version: '1', submitted_by: null });
      expect(await changes(seeded.id)).toEqual([]);
    });

    it('asks the conflict before the state: a caller in conflict is told so about a contract in review as well', async () => {
      const inReview = await seedContract({ status: 'IN_REVIEW' });
      await declare(SUBMITTER, inReview.packageId, { contractorId: null });
      expect(await refusal(submit(inReview))).toMatchObject({ code: 'CONFLICT_OF_INTEREST_BLOCKED' });
    });

    it('lets through a conflict that was allowed, a conflict with another contractor and a conflict that was declared against another package of nobody', async () => {
      const allowed = await seedContract();
      await declare(SUBMITTER, allowed.packageId, { contractorId: CONTRACTOR, decision: 'ALLOWED' });
      expect((await submit(allowed)).status).toBe('IN_REVIEW');
      const other = await seedContract();
      await declare(SUBMITTER, other.packageId, { contractorId: OTHER_CONTRACTOR });
      expect((await submit(other)).status).toBe('IN_REVIEW');
      const elsewhere = await seedContract();
      await declare(SUBMITTER, id(FAMILY, 98), { contractorId: null });
      expect((await submit(elsewhere)).status).toBe('IN_REVIEW');
    });

    it('treats a conflict against the whole package, and a block from it, as standing between the caller and every contractor of the package', async () => {
      const whole = await seedContract({ contractor: OTHER_CONTRACTOR });
      await declare(CHECKER, whole.packageId, { contractorId: null });
      expect(await refusal(submit(whole, 1, undefined, CHECKER))).toMatchObject({ code: 'CONFLICT_OF_INTEREST_BLOCKED' });
      const blocked = await seedContract({ contractor: OTHER_CONTRACTOR });
      await declare(CHECKER, blocked.packageId, { contractorId: CONTRACTOR, decision: 'BLOCKED' });
      expect(await refusal(submit(blocked, 1, undefined, CHECKER))).toMatchObject({ code: 'CONFLICT_OF_INTEREST_BLOCKED' });
      const recused = await seedContract({ contractor: OTHER_CONTRACTOR });
      await declare(CHECKER, recused.packageId, { contractorId: CONTRACTOR, decision: 'RECUSED' });
      expect((await submit(recused, 1, undefined, CHECKER)).status).toBe('IN_REVIEW');
    });
  });

  describe('returnContractDraft', () => {
    it('gives a contract in review back to its drafter with the reason, by someone other than the people whose work it is', async () => {
      const seeded = await seedContract({ status: 'IN_REVIEW' });
      const done = await giveBack(seeded, 1, '  The bill of quantities has to be corrected.  ');
      expect(done).toMatchObject({ fromStatus: 'IN_REVIEW', status: 'DRAFT', version: 2, reason: 'The bill of quantities has to be corrected.' });
      expect(await row(seeded.id)).toMatchObject({ status: 'DRAFT', version: '2', submitted_by: null, status_reason: 'The bill of quantities has to be corrected.' });
      expect((await changes(seeded.id)).map((change) => [change.from_status, change.to_status, change.command, change.created_by])).toEqual([['IN_REVIEW', 'DRAFT', 'returnContractDraft', memberId(CHECKER)]]);
    });

    it('refuses the one who drafted it and the one who sent it (403 SELF_APPROVAL_DENIED), a draft (409), a stale version (409) and an empty reason (422)', async () => {
      const seeded = await seedContract({ status: 'IN_REVIEW' });
      expect(await refusal(giveBack(seeded, 1, 'Reason enough.', DRAFTER))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await refusal(giveBack(seeded, 1, 'Reason enough.', SUBMITTER))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await refusal(giveBack(seeded, 5))).toMatchObject({ code: 'VERSION_CONFLICT' });
      expect(await refusal(giveBack(seeded, 1, '   '))).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(await refusal(giveBack(await seedContract()))).toMatchObject({ code: 'CONTRACT_STATE_INVALID', status: 409 });
      expect(await row(seeded.id)).toMatchObject({ status: 'IN_REVIEW', version: '1' });
    });
  });

  describe('recordContractSigning', () => {
    it('signs a contract in review: SIGNED with the signer, the document and the date, and the history keeps the document', async () => {
      const seeded = await seedContract({ status: 'IN_REVIEW' });
      const h = hooks();
      const done = await sign(seeded, 1, {}, SIGNER, h);
      expect(done).toMatchObject({ fromStatus: 'IN_REVIEW', status: 'SIGNED', version: 2, signedOn: '2026-10-20', signedDocumentVersionId: CLEAN, conflictDecisionRef: null });
      expect(await row(seeded.id)).toMatchObject({ status: 'SIGNED', version: '2', signed_by: memberId(SIGNER), signed_on: '2026-10-20', signed_document_version_id: CLEAN, conflict_decision_ref: null });
      expect(await changes(seeded.id)).toEqual([
        { from_status: 'IN_REVIEW', to_status: 'SIGNED', reason: 'Signed on 2026-10-20', command: 'recordContractSigning', created_by: memberId(SIGNER), decision_document_version_id: CLEAN, effective_on: TODAY },
      ]);
      expect(h.authorise).toHaveBeenCalledTimes(1);
      expect(h.authorise.mock.calls[0]?.[0]).toMatchObject({ id: seeded.id, contractValueVnd: VALUE, advanceCategory: 'CONSTRUCTION', ownerUnit: { id: unitId(DEPARTMENT), path: '/u1/u2/' } });
    });

    it('AC-ST-CTR-004-3, UAT-AC317: refuses the one who drafted the contract and the one who sent it (403 SELF_APPROVAL_DENIED) and a signer above their delegation limit (the hook refuses)', async () => {
      const seeded = await seedContract({ status: 'IN_REVIEW' });
      expect(await refusal(sign(seeded, 1, {}, DRAFTER))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await refusal(sign(seeded, 1, {}, SUBMITTER))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      const over = hooks({ authorise: jest.fn(async () => { throw new DomainError('SCOPE_DENIED', 403); }) });
      expect(await refusal(sign(seeded, 1, {}, SIGNER, over))).toMatchObject({ code: 'SCOPE_DENIED', status: 403 });
      expect(await row(seeded.id)).toMatchObject({ status: 'IN_REVIEW', version: '1', signed_by: null });
    });

    it('refuses a stale version, a contract that is not in review, a date in the future and a date that does not exist', async () => {
      const seeded = await seedContract({ status: 'IN_REVIEW' });
      expect(await refusal(sign(seeded, 9))).toMatchObject({ code: 'VERSION_CONFLICT' });
      expect(await refusal(sign(await seedContract()))).toMatchObject({ code: 'CONTRACT_STATE_INVALID' });
      expect(await refusal(sign(seeded, 1, { signedOn: '2026-10-26' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'signed_on' });
      expect(await refusal(sign(seeded, 1, { signedOn: '2026-02-30' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'signed_on' });
      expect((await sign(seeded, 1, { signedOn: TODAY })).signedOn).toBe(TODAY);
    });

    it('refuses a signed file that is not clean (422 DOCUMENT_NOT_CLEAN), one that does not exist and a sealed bid (422 VALIDATION_FAILED)', async () => {
      const seeded = await seedContract({ status: 'IN_REVIEW' });
      expect(await refusal(sign(seeded, 1, { signedDocumentVersionId: PENDING }))).toMatchObject({ code: 'DOCUMENT_NOT_CLEAN', status: 422, extensions: { scan_status: 'PENDING' } });
      expect(await refusal(sign(seeded, 1, { signedDocumentVersionId: INFECTED }))).toMatchObject({ code: 'DOCUMENT_NOT_CLEAN', extensions: { scan_status: 'INFECTED' } });
      expect(await refusal(sign(seeded, 1, { signedDocumentVersionId: randomUUID() }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'signed_document_version_id' });
      expect(await refusal(sign(seeded, 1, { signedDocumentVersionId: SEALED }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'signed_document_version_id' });
      expect(await row(seeded.id)).toMatchObject({ status: 'IN_REVIEW', signed_by: null });
    });

    it('AC-ST-CTR-004-1, UAT-AC56: blocks a signer in conflict, and lets someone free of it sign over a reviewer in conflict only with the decision on the record', async () => {
      const seeded = await seedContract({ status: 'IN_REVIEW', submittedBy: SUBMITTER });
      await declare(SIGNER, seeded.packageId, { contractorId: CONTRACTOR });
      expect(await refusal(sign(seeded, 1, { conflictDecisionRef: 'QD-XL-001' }))).toMatchObject({ code: 'CONFLICT_OF_INTEREST_BLOCKED', extensions: { conflict_of: 'ACTOR' } });
      // The signer is free of the conflict in the next case: the reviewer is the one in conflict.
      await owner('delete from machvon.bid_conflict_declaration');
      const reviewed = await seedContract({ status: 'IN_REVIEW', submittedBy: CHECKER });
      await declare(CHECKER, reviewed.packageId, { contractorId: CONTRACTOR });
      expect(await refusal(sign(reviewed))).toMatchObject({ code: 'CONFLICT_OF_INTEREST_BLOCKED', status: 409, extensions: { conflict_of: 'REVIEWER' } });
      expect(await refusal(sign(reviewed, 1, { conflictDecisionRef: '   ' }))).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(await row(reviewed.id)).toMatchObject({ status: 'IN_REVIEW', signed_by: null, conflict_decision_ref: null });
      const done = await sign(reviewed, 1, { conflictDecisionRef: '  QD-XL-001  ' });
      expect(done).toMatchObject({ status: 'SIGNED', conflictDecisionRef: 'QD-XL-001', reason: 'Signed on 2026-10-20 under decision QD-XL-001' });
      expect(await row(reviewed.id)).toMatchObject({ status: 'SIGNED', signed_by: memberId(SIGNER), conflict_decision_ref: 'QD-XL-001' });
    });

    it('keeps a decision that was given though nobody was in conflict', async () => {
      const seeded = await seedContract({ status: 'IN_REVIEW' });
      expect((await sign(seeded, 1, { conflictDecisionRef: 'QD-XL-002' })).conflictDecisionRef).toBe('QD-XL-002');
    });
  });

  describe('activateContract', () => {
    const withGuarantee = (contractId: string, options: { status?: string; days?: number; kind?: string } = {}) =>
      seedAs(harness, [
        [
          `insert into machvon.guarantee
             (tenant_id, id, contract_id, kind, issuer, guarantee_no, amount_vnd, expires_at, verification_status, status, verified_by, verified_at, verification_method, verification_evidence_id, created_by)
           values ($1, gen_random_uuid(), $2, $3, 'Bank of the Province', $4, 500000000, now() + make_interval(days => $5), $8, $6,
                   case when $8 = 'VERIFIED' then $9::uuid end, case when $8 = 'VERIFIED' then now() end, case when $8 = 'VERIFIED' then 'ISSUER_CONFIRMATION' end, case when $8 = 'VERIFIED' then $10::uuid end, $7)`,
          [TENANT_A, contractId, options.kind ?? 'PERFORMANCE', `BL-${randomUUID().slice(0, 8)}`, options.days ?? 365, options.status ?? 'ACTIVE', memberId(DRAFTER), (options.status ?? 'ACTIVE') === 'ACTIVE' ? 'VERIFIED' : 'UNVERIFIED', memberId(CHECKER), EVIDENCE],
        ],
      ]);
    const seedRule = async (): Promise<string> => {
      const permitTypeId = id(FAMILY, 60);
      await seedAs(harness, [
        [
          `insert into machvon.permit_type (tenant_id, id, code, name, category, authority_text, legal_basis, effective_from, applies_to_rule, status, created_by, updated_by)
           values ($1, $2, 'GPXD', 'Building permit', 'OTHER', 'The authority', 'Fixture decree', '2025-01-01', '{}'::jsonb, 'PUBLISHED', $3, $3) on conflict do nothing`,
          [TENANT_A, permitTypeId, memberId(DRAFTER)],
        ],
      ]);
      const published = await as((tx) =>
        gates.publish(tx, { gateCode: 'CONTRACT_ACTIVATION', permitTypeId, requirement: 'VALID_PERMIT', appliesToRule: {}, legalBasis: 'Fixture decree', effectiveFrom: '2025-01-01' }, memberId(DRAFTER)),
      );
      return published.id;
    };
    const clearRules = () => owner('delete from machvon.permit_gate_rule');

    beforeEach(clearRules);

    it('activates a signed contract that meets every condition: ACTIVE from the date, the first revision effective, the value committed, and the history keeps the reason', async () => {
      const seeded = await seedContract({ status: 'SIGNED' });
      await withGuarantee(seeded.id);
      const h = hooks();
      const done = await activate(seeded, 1, { evidenceIds: [EVIDENCE.toUpperCase(), EVIDENCE] }, CHECKER, h);
      expect(done).toMatchObject({
        fromStatus: 'SIGNED',
        status: 'ACTIVE',
        version: 2,
        effectiveFrom: '2026-11-01',
        revisionId: seeded.revisionId,
        committedVnd: VALUE,
        allocationLineId: ALLOCATION_LINE,
        evidenceIds: [EVIDENCE],
        commitment: { entryId: id(FAMILY, 90), replayed: false },
      });
      expect(await row(seeded.id)).toMatchObject({ status: 'ACTIVE', version: '2', activated_by: memberId(CHECKER), effective_from: '2026-11-01', current_revision_id: seeded.revisionId, status_reason: null });
      const [revision] = await owner<{ status: string; valid_from: string; decided_by: string; version: string }>('select status, valid_from::text, decided_by, version::text from machvon.contract_revision where id = $1::uuid', [seeded.revisionId]);
      expect(revision).toEqual({ status: 'EFFECTIVE', valid_from: '2026-11-01', decided_by: memberId(CHECKER), version: '2' });
      expect(await changes(seeded.id)).toEqual([{ from_status: 'SIGNED', to_status: 'ACTIVE', reason: 'All conditions are met.', command: 'activateContract', created_by: memberId(CHECKER), decision_document_version_id: null, effective_on: '2026-11-01' }]);
      expect(h.commit).toHaveBeenCalledTimes(1);
      expect(h.commit.mock.calls[0]?.[0]).toMatchObject({ id: seeded.id, allocationLineId: ALLOCATION_LINE, contractValueVnd: VALUE });
    });

    it('AC-ST-CTR-004-2, UAT-AC302: judges the guarantee, then the permits, then the funds, and each refusal leaves the contract SIGNED and the next condition unasked', async () => {
      const seeded = await seedContract({ status: 'SIGNED' });
      const rule = await seedRule();
      const h = hooks({ commit: jest.fn(async () => { throw new DomainError('AVC_BLOCKED', 422); }) });
      // 1. No guarantee at all, then one that waits for its verification, then one that has expired: PERFORMANCE_GUARANTEE_MISSING each time, and nothing else is asked.
      expect(await refusal(activate(seeded, 1, {}, CHECKER, h))).toMatchObject({ code: 'PERFORMANCE_GUARANTEE_MISSING', status: 422 });
      await withGuarantee(seeded.id, { status: 'PENDING_VERIFICATION' });
      expect(await refusal(activate(seeded, 1, {}, CHECKER, h))).toMatchObject({ code: 'PERFORMANCE_GUARANTEE_MISSING' });
      await withGuarantee(seeded.id, { days: -5 });
      expect(await refusal(activate(seeded, 1, {}, CHECKER, h))).toMatchObject({ code: 'PERFORMANCE_GUARANTEE_MISSING' });
      expect(h.commit).not.toHaveBeenCalled();
      // 2. A verified guarantee, but the gate of the permits is not passed: PERMIT_GATE_BLOCKED names the gate and the rule. A guarantee that ends before the contract begins does not count.
      await withGuarantee(seeded.id);
      expect(await refusal(activate(seeded, 1, { effectiveFrom: '2030-01-01' }, CHECKER, h))).toMatchObject({ code: 'PERFORMANCE_GUARANTEE_MISSING' });
      const blocked = await refusal(activate(seeded, 1, {}, CHECKER, h));
      expect(blocked).toMatchObject({ code: 'PERMIT_GATE_BLOCKED', extensions: { gate_code: 'CONTRACT_ACTIVATION', blocking: [expect.objectContaining({ rule_id: rule, permit_type_code: 'GPXD' })] } });
      expect(h.commit).not.toHaveBeenCalled();
      // 3. The gate passes, the funds do not: FUND_COMMIT_FAILED with the cause, and the contract is still SIGNED.
      await clearRules();
      expect(await refusal(activate(seeded, 1, {}, CHECKER, h))).toMatchObject({ code: 'FUND_COMMIT_FAILED', status: 422, extensions: { cause: 'AVC_BLOCKED' } });
      expect(h.commit).toHaveBeenCalledTimes(1);
      expect(await row(seeded.id)).toMatchObject({ status: 'SIGNED', version: '1', activated_by: null, current_revision_id: null });
      expect(await changes(seeded.id)).toEqual([]);
      const [revision] = await owner<{ status: string }>('select status from machvon.contract_revision where id = $1::uuid', [seeded.revisionId]);
      expect(revision?.status).toBe('DRAFT');
      // 4. The funds allow it: ACTIVE.
      expect((await activate(seeded, 1, {}, CHECKER, hooks())).status).toBe('ACTIVE');
    });

    it('commits nothing for a contract that has no line of capital to commit against (422 FUND_COMMIT_FAILED, NO_ALLOCATION_LINE)', async () => {
      const seeded = await seedContract({ status: 'SIGNED', withAllocation: false });
      await withGuarantee(seeded.id);
      const h = hooks();
      expect(await refusal(activate(seeded, 1, {}, CHECKER, h))).toMatchObject({ code: 'FUND_COMMIT_FAILED', extensions: { cause: 'NO_ALLOCATION_LINE' } });
      expect(h.commit).not.toHaveBeenCalled();
    });

    it('asks no guarantee of a consulting contract and no permit of one that does not build', async () => {
      await seedRule();
      const consulting = await seedContract({ status: 'SIGNED', category: 'CONSULTING' });
      expect((await activate(consulting)).status).toBe('ACTIVE');
      const equipment = await seedContract({ status: 'SIGNED', category: 'EQUIPMENT' });
      await withGuarantee(equipment.id);
      expect((await activate(equipment)).status).toBe('ACTIVE');
    });

    it('refuses the one who drafted the contract (403 SELF_APPROVAL_DENIED), a contract that is not signed (409), a stale version (409) and a caller above their delegation limit', async () => {
      const seeded = await seedContract({ status: 'SIGNED' });
      await withGuarantee(seeded.id);
      expect(await refusal(activate(seeded, 1, {}, DRAFTER))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await refusal(activate(seeded, 4))).toMatchObject({ code: 'VERSION_CONFLICT' });
      expect(await refusal(activate(await seedContract({ status: 'IN_REVIEW' })))).toMatchObject({ code: 'CONTRACT_STATE_INVALID' });
      expect(await refusal(activate(seeded, 1, {}, CHECKER, hooks({ authorise: jest.fn(async () => { throw new DomainError('SCOPE_DENIED', 403); }) })))).toMatchObject({ code: 'SCOPE_DENIED' });
      expect(await row(seeded.id)).toMatchObject({ status: 'SIGNED', version: '1' });
    });

    it('refuses a project that is not in implementation (422 PROJECT_STAGE_INVALID), a date before the signature and evidence that does not exist (422 VALIDATION_FAILED)', async () => {
      const planning = await seedContract({ status: 'SIGNED', project: PROJECT_PLANNING });
      await withGuarantee(planning.id);
      expect(await refusal(activate(planning))).toMatchObject({ code: 'PROJECT_STAGE_INVALID', status: 422, extensions: { project_status: 'PIPELINE' } });
      const seeded = await seedContract({ status: 'SIGNED', signedOn: '2026-10-20' });
      await withGuarantee(seeded.id);
      expect(await refusal(activate(seeded, 1, { effectiveFrom: '2026-10-19' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'effective_from' });
      expect(await refusal(activate(seeded, 1, { effectiveFrom: '2026-13-01' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'effective_from' });
      expect(await refusal(activate(seeded, 1, { evidenceIds: [randomUUID()] }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'evidence_ids' });
      expect(await refusal(activate(seeded, 1, { reason: '  ' }))).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect((await activate(seeded, 1, { effectiveFrom: '2026-10-20', evidenceIds: [EVIDENCE] })).effectiveFrom).toBe('2026-10-20');
    });

    it('blocks a caller in conflict with the contractor', async () => {
      const seeded = await seedContract({ status: 'SIGNED' });
      await withGuarantee(seeded.id);
      await declare(CHECKER, id(FAMILY, 97), { contractorId: CONTRACTOR });
      expect(await refusal(activate(seeded))).toMatchObject({ code: 'CONFLICT_OF_INTEREST_BLOCKED' });
    });
  });

  describe('what the database keeps', () => {
    it('keeps the signature and the activation once written', async () => {
      const signed = await seedContract({ status: 'SIGNED' });
      for (const change of [`signed_by = '${memberId(CHECKER)}'`, `signed_on = date '2026-10-02'`, `signed_document_version_id = '${DOCUMENT_VERSION}'`, `conflict_decision_ref = 'QD-1'`]) {
        expect(await databaseRefusal(owner(`update machvon.contract set ${change} where id = $1::uuid`, [signed.id]))).toContain('signature of a contract does not change');
      }
      await owner(`update machvon.contract set status = 'ACTIVE', effective_from = date '2026-11-01', activated_by = $2::uuid where id = $1::uuid`, [signed.id, memberId(CHECKER)]);
      expect(await databaseRefusal(owner(`update machvon.contract set effective_from = date '2026-12-01' where id = $1::uuid`, [signed.id]))).toContain('activation of a contract does not change');
    });

    it('refuses a signer or an activator who drafted the contract', async () => {
      const seeded = await seedContract({ status: 'IN_REVIEW' });
      expect(await databaseRefusal(owner(`update machvon.contract set signed_by = created_by where id = $1::uuid`, [seeded.id]))).toContain('contract_signer_chk');
      expect(await databaseRefusal(owner(`update machvon.contract set activated_by = created_by where id = $1::uuid`, [seeded.id]))).toContain('contract_activator_chk');
      expect(await databaseRefusal(owner(`update machvon.contract set conflict_decision_ref = ' padded ' where id = $1::uuid`, [seeded.id]))).toContain('contract_conflict_decision_chk');
    });

    it('does not let the runtime role change or remove a row of the history of the status', async () => {
      const seeded = await seedContract();
      await submit(seeded);
      expect(await databaseRefusal(as((tx) => tx.query('update machvon.contract_status_change set reason = $2 where contract_id = $1::uuid', [seeded.id, 'Rewritten'])))).toContain('permission denied');
      expect(await databaseRefusal(as((tx) => tx.query('delete from machvon.contract_status_change where contract_id = $1::uuid', [seeded.id])))).toContain('permission denied');
      expect(await databaseRefusal(as((tx) => tx.query('truncate machvon.contract_status_change')))).toContain('permission denied');
    });

    it('keeps the state machine as the last word: the runtime role cannot write a status that is off the edges', async () => {
      const closed = await seedContract({ status: 'CANCELLED' });
      expect(await databaseRefusal(as((tx) => tx.query(`update machvon.contract set status = 'ACTIVE' where id = $1::uuid`, [closed.id])))).toContain('CONTRACT_STATE_INVALID');
    });
  });
});
