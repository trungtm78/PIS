import { randomUUID } from 'node:crypto';
import { AstWarrantyStore } from '../src/ast-warranty-store';
import type { CreateInput } from '../src/ast-warranty-store';
import type { HandoverScopes } from '../src/ast-handover-store';
import { applyBaseline, BASELINE_PACK } from '../src/master-baseline';
import type { TenantTx } from '../src/tenant-database';
import { TENANT_A, contextFor, id, memberId, unitId } from './support/authz-fixtures';
import { seedAs } from './support/bid-proposal-fixtures';
import { CapWorld } from './support/cap-fixtures';
import { asSuperuser } from './support/ncr-fixtures';

const world = new CapWorld();
const harness = world.harness;
const warranties = new AstWarrantyStore();
const FAMILY = 0xb5;
const MANAGER = 1;
const VERIFIER = 2;
const RECEIVER = 7;
const OTHER_UNIT = 8;
const CLEAN = id(FAMILY, 31);
const DOCUMENT = id(FAMILY, 30);
const CREATED = new Date('2026-12-20T03:00:00Z');
const AFTER_END = new Date('2027-09-02T03:00:00Z');
const all: HandoverScopes = { update: () => ({ sql: 'true', params: [] }), read: () => ({ sql: 'true', params: [] }) };
const readOnly: HandoverScopes = { update: () => ({ sql: 'false', params: [] }), read: () => ({ sql: 'true', params: [] }) };
const invisible: HandoverScopes = { update: () => ({ sql: 'false', params: [] }), read: () => ({ sql: 'false', params: [] }) };
const allRows = () => ({ sql: 'true', params: [] as unknown[] });
const noRows = () => ({ sql: 'false', params: [] as unknown[] });

let counter = 0;

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = MANAGER): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);
const stage = (sql: string, params: unknown[] = []): Promise<void> => asSuperuser(harness.database.adminUrl, sql, params);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string; extensions?: Record<string, unknown> }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string; extensions?: Record<string, unknown> };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }), ...(e.extensions === undefined ? {} : { extensions: e.extensions }) };
  }
  throw new Error('expected a refusal');
}

const databaseRefusal = async (work: Promise<unknown>): Promise<{ message: string; sqlstate: string }> => {
  try {
    await work;
  } catch (error) {
    const e = error as { message: string; code?: string };
    return { message: e.message, sqlstate: e.code ?? '' };
  }
  throw new Error('expected the database to refuse');
};

interface Seeded {
  contractId: string;
  projectId: string;
  handoverId: string;
  assetId: string;
}

/** A contract with a handover of the status asked for and one asset of it. */
async function seed(status = 'ACCEPTED'): Promise<Seeded> {
  counter += 1;
  const contractId = randomUUID();
  const handoverId = randomUUID();
  const assetId = randomUUID();
  const line = await world.publishedLine();
  await seedAs(harness, [
    [
      `insert into machvon.contract
         (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, title, advance_category, is_joint_venture, requires_quality_acceptance, contract_value_vnd,
          created_by, updated_by, signed_on, effective_from)
       values ($1, $2, $3, $4, $5, $6, 'UNIT_PRICE', 'VND', 'ACTIVE', 1, 'Contract', 'CONSTRUCTION', false, true, 10000000000::numeric, $7, $7, date '2026-01-02', date '2026-01-03')`,
      [TENANT_A, contractId, line.projectId, randomUUID(), randomUUID(), `HD-W-${String(counter).padStart(4, '0')}`, memberId(MANAGER)],
    ],
  ]);
  await stage(
    `insert into machvon.handover
       (tenant_id, id, project_id, contract_id, recipient_unit_id, document_version_id, punch_list, status, handover_no, handover_kind, created_by, updated_by, version, accepted_at, accepted_by, as_built_document_version_id)
     values ($1, $2, $3, $4, $5, $6, '[]'::jsonb, $7, $8, 'COMPLETION', $9, $9, 1, $10::timestamptz, $11, $12)`,
    [
      TENANT_A,
      handoverId,
      line.projectId,
      contractId,
      unitId(RECEIVER),
      CLEAN,
      status,
      `BG-W-${counter}`,
      memberId(MANAGER),
      status === 'ACCEPTED' ? '2026-12-10T03:00:00Z' : null,
      status === 'ACCEPTED' ? memberId(VERIFIER) : null,
      status === 'ACCEPTED' ? CLEAN : null,
    ],
  );
  await stage(
    `insert into machvon.asset_record (tenant_id, id, project_id, handover_id, asset_code, value_vnd, recipient_unit_id, name, source_contract_id, value_basis, status, registered_on, created_by, updated_by, version)
     values ($1, $2, $3, $4, $5, 1000::numeric, $6, 'Pump house', $7, 'CONTRACT_VALUE', 'REGISTERED', date '2026-12-11', $8, $8, 1)`,
    [TENANT_A, assetId, line.projectId, handoverId, `AS-W-${counter}`, unitId(RECEIVER), contractId, memberId(MANAGER)],
  );
  return { contractId, projectId: line.projectId, handoverId, assetId };
}

/** A guarantee of the contract; one that is active has been verified by somebody other than whoever registered it. */
async function guaranteeOf(contractId: string, options: { kind?: string; status?: string } = {}): Promise<string> {
  const guaranteeId = randomUUID();
  const active = (options.status ?? 'ACTIVE') === 'ACTIVE';
  await seedAs(harness, [
    [
      `insert into machvon.guarantee
         (tenant_id, id, contract_id, kind, issuer, guarantee_no, amount_vnd, expires_at, verification_status, status, verified_by, verified_at, verification_method, verification_evidence_id, created_by)
       values ($1, $2, $3, $4, 'Bank of the Province', $5, 500000000, timestamptz '2028-01-01T00:00:00Z', $6, $7, $8, case when $6 = 'VERIFIED' then now() end,
               case when $6 = 'VERIFIED' then 'ISSUER_CONFIRMATION' end, case when $6 = 'VERIFIED' then $9::uuid end, $10)`,
      [
        TENANT_A,
        guaranteeId,
        contractId,
        options.kind ?? 'WARRANTY',
        `BL-${randomUUID().slice(0, 8)}`,
        active ? 'VERIFIED' : 'UNVERIFIED',
        options.status ?? 'ACTIVE',
        active ? memberId(VERIFIER) : null,
        CLEAN,
        memberId(MANAGER),
      ],
    ],
  ]);
  return guaranteeId;
}

const input = (target: Seeded, overrides: Partial<CreateInput> = {}): CreateInput => ({
  contractId: target.contractId,
  handoverId: target.handoverId,
  scopeDescription: 'The whole pump house',
  startsOn: '2026-09-01',
  periodMonths: 12,
  constructionGrade: 'II',
  retentionAmountVnd: '150000000',
  ...overrides,
});
const create = (target: Seeded, overrides: Partial<CreateInput> = {}, scopes: HandoverScopes = all, now = CREATED) =>
  as((tx) => warranties.create(tx, input(target, overrides), memberId(MANAGER), scopes, now));
const close = (obligationId: string, scopes: HandoverScopes = all, now = AFTER_END, note?: string) => as((tx) => warranties.close(tx, obligationId, { note }, memberId(MANAGER), scopes, now));

/** A claim of the obligation, written straight to the database as its owner, so that the guards of the tables apply (the commands that file and answer claims are another story). */
const claim = (obligationId: string, claimNo: string, status = 'OPEN') =>
  owner(
    `insert into machvon.warranty_claim (tenant_id, id, obligation_id, claim_no, reported_on, reported_by, defect_description, severity, response_due_on, status, fixed_on, verified_by, verified_at, created_by, updated_by)
     values ($1, gen_random_uuid(), $2, $3, date '2027-08-20', $4, 'Crack in the wall', 'MAJOR', date '2027-08-27', $5,
             case when $5 in ('VERIFIED', 'CLOSED') then date '2027-08-25' end, case when $5 in ('VERIFIED', 'CLOSED') then $6::uuid end, case when $5 in ('VERIFIED', 'CLOSED') then now() end, $4, $4)`,
    [TENANT_A, obligationId, claimNo, memberId(MANAGER), status, memberId(VERIFIER)],
  );

const rowOf = async (obligationId: string) =>
  (
    await owner<{
      status: string;
      version: string;
      starts_on: string;
      ends_on: string;
      period_months: number;
      construction_grade: string | null;
      minimum_months: number | null;
      rule_version_id: string | null;
      retention_amount_vnd: string;
      warranty_guarantee_id: string | null;
      closed_by: string | null;
      closed_at: string | null;
      close_note: string | null;
    }>(
      `select status, version::text, starts_on::text, ends_on::text, period_months, construction_grade, minimum_months, rule_version_id, retention_amount_vnd::text, warranty_guarantee_id, closed_by, closed_at::text, close_note
         from machvon.warranty_obligation where id = $1::uuid`,
      [obligationId],
    )
  )[0];

describe('the warranty of a work (ST-AST-003)', () => {
  beforeAll(async () => {
    await world.start();
    await harness.seedUnits(TENANT_A, [
      { n: RECEIVER, path: `/${unitId(RECEIVER)}/` },
      { n: OTHER_UNIT, path: `/${unitId(OTHER_UNIT)}/` },
    ]);
    await seedAs(harness, [
      [
        `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'QD', 'Record', 'INTERNAL', $3, $3)`,
        [TENANT_A, DOCUMENT, memberId(MANAGER)],
      ],
      [
        `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
         values ($1, $2, $3, 1, 'tenants/ast/warranty.pdf', repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL')`,
        [TENANT_A, CLEAN, DOCUMENT],
      ],
    ]);
    await as((tx) => applyBaseline(tx, BASELINE_PACK, memberId(MANAGER), '2026-06-01'));
  }, 240_000);

  afterAll(async () => {
    await world.stop();
  }, 60_000);

  describe('creating an obligation', () => {
    it('AC-ST-AST-003-1, UAT-AC390: refuses a term below the minimum of the grade and creates one at the minimum, keeping the version of the rule and the end of the warranty', async () => {
      const target = await seed();
      expect(await refusal(create(target, { periodMonths: 6 }))).toMatchObject({ code: 'WARRANTY_PERIOD_BELOW_MINIMUM', status: 422, extensions: { minimum_months: 12, period_months: 6 } });
      expect(await owner('select 1 from machvon.warranty_obligation where handover_id = $1::uuid', [target.handoverId])).toHaveLength(0);
      const created = await create(target, { periodMonths: 12 });
      expect(created).toMatchObject({
        status: 'ACTIVE',
        fromStatus: null,
        version: 1,
        startsOn: '2026-09-01',
        endsOn: '2027-09-01',
        periodMonths: 12,
        constructionGrade: 'II',
        minimumMonths: 12,
        contractId: target.contractId,
      });
      const [rule] = await owner<{ id: string }>("select v.id from machvon.master_record_version v where v.master_type = 'AST_WARRANTY' and v.code = 'II' order by v.revision desc limit 1");
      expect(created.ruleVersionId).toBe(rule?.id);
      expect(await rowOf(created.id)).toMatchObject({
        status: 'ACTIVE',
        version: '1',
        ends_on: '2027-09-01',
        construction_grade: 'II',
        minimum_months: 12,
        rule_version_id: rule?.id,
        retention_amount_vnd: '150000000',
      });
    });

    it('holds a work of grade I or special to 24 months, and a work whose grade is not stated to the longest minimum', async () => {
      const target = await seed();
      expect(await refusal(create(target, { constructionGrade: 'I', periodMonths: 12 }))).toMatchObject({ code: 'WARRANTY_PERIOD_BELOW_MINIMUM', extensions: { minimum_months: 24 } });
      expect(await refusal(create(target, { constructionGrade: 'SPECIAL', periodMonths: 23 }))).toMatchObject({ code: 'WARRANTY_PERIOD_BELOW_MINIMUM', extensions: { minimum_months: 24 } });
      expect(await refusal(create(target, { constructionGrade: undefined, periodMonths: 12 }))).toMatchObject({ code: 'WARRANTY_PERIOD_BELOW_MINIMUM', extensions: { minimum_months: 24 } });
      const created = await create(target, { constructionGrade: undefined, periodMonths: 24 });
      expect(created).toMatchObject({ constructionGrade: null, minimumMonths: 24, endsOn: '2028-09-01' });
      expect((await rowOf(created.id))?.construction_grade).toBeNull();
    });

    it('says that no rule is in force rather than judging the term by a number of its own', async () => {
      const target = await seed();
      expect(await refusal(create(target, {}, all, new Date('2024-01-01T03:00:00Z')))).toMatchObject({ code: 'NO_EFFECTIVE_RULE', status: 422, detail: 'construction_grade' });
    });

    it('needs a warranty guarantee of the contract or an amount held back', async () => {
      const target = await seed();
      expect(await refusal(create(target, { retentionAmountVnd: undefined }))).toMatchObject({ code: 'GUARANTEE_REQUIRED', status: 422 });
      expect(await refusal(create(target, { retentionAmountVnd: '0' }))).toMatchObject({ code: 'GUARANTEE_REQUIRED' });
      const guaranteeId = await guaranteeOf(target.contractId);
      const created = await create(target, { retentionAmountVnd: undefined, warrantyGuaranteeId: guaranteeId });
      expect(created).toMatchObject({ warrantyGuaranteeId: guaranteeId, retentionAmountVnd: '0' });
      expect((await rowOf(created.id))?.warranty_guarantee_id).toBe(guaranteeId);
    });

    it('takes only an active warranty guarantee of this contract', async () => {
      const target = await seed();
      const other = await seed();
      const field = (reason: string) => ({ code: 'VALIDATION_FAILED', status: 422, detail: 'warranty_guarantee_id', extensions: { reason } });
      expect(await refusal(create(target, { warrantyGuaranteeId: await guaranteeOf(target.contractId, { kind: 'PERFORMANCE' }) }))).toMatchObject(field('NOT_A_WARRANTY_GUARANTEE'));
      expect(await refusal(create(target, { warrantyGuaranteeId: await guaranteeOf(other.contractId) }))).toMatchObject(field('NOT_A_GUARANTEE_OF_THE_CONTRACT'));
      expect(await refusal(create(target, { warrantyGuaranteeId: await guaranteeOf(target.contractId, { status: 'PENDING_VERIFICATION' }) }))).toMatchObject(field('GUARANTEE_NOT_ACTIVE'));
      expect(await refusal(create(target, { warrantyGuaranteeId: randomUUID() }))).toMatchObject(field('NOT_FOUND'));
    });

    it('is for an accepted handover of the contract, and for an asset of that handover', async () => {
      const pending = await seed('PUNCH_PENDING');
      expect(await refusal(create(pending))).toMatchObject({ code: 'HANDOVER_NOT_ACCEPTED', status: 422, extensions: { status: 'PUNCH_PENDING' } });
      const target = await seed();
      const other = await seed();
      expect(await refusal(create(target, { contractId: other.contractId }))).toMatchObject({
        code: 'VALIDATION_FAILED',
        detail: 'contract_id',
        extensions: { reason: 'NOT_THE_CONTRACT_OF_THE_HANDOVER' },
      });
      expect(await refusal(create(target, { assetId: other.assetId }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'asset_id', extensions: { reason: 'NOT_AN_ASSET_OF_THE_HANDOVER' } });
      expect(await refusal(create(target, { assetId: randomUUID() }))).toMatchObject({ detail: 'asset_id', extensions: { reason: 'NOT_FOUND' } });
      await stage("update machvon.asset_record set status = 'DISPOSED' where id = $1::uuid", [other.assetId]);
      expect(await refusal(create(other, { assetId: other.assetId }))).toMatchObject({ detail: 'asset_id', extensions: { reason: 'ASSET_DISPOSED' } });
      const created = await create(target, { assetId: target.assetId });
      expect(created.assetId).toBe(target.assetId);
    });

    it('is one obligation for a handover and an asset, and one for the whole handover', async () => {
      const target = await seed();
      await create(target, { assetId: target.assetId });
      await create(target);
      expect(await refusal(create(target, { assetId: target.assetId }))).toMatchObject({ code: 'WARRANTY_STATE_INVALID', status: 409, extensions: { reason: 'OBLIGATION_EXISTS' } });
      expect(await refusal(create(target))).toMatchObject({ code: 'WARRANTY_STATE_INVALID', status: 409 });
    });

    it('refuses what is not a well-formed request, before any rule is read', async () => {
      const target = await seed();
      const bad = async (overrides: Partial<CreateInput>, field: string) => expect(await refusal(create(target, overrides))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: field });
      await bad({ contractId: 'nope' }, 'contract_id');
      await bad({ handoverId: 'nope' }, 'handover_id');
      await bad({ assetId: 'nope' }, 'asset_id');
      await bad({ warrantyGuaranteeId: 'nope' }, 'warranty_guarantee_id');
      await bad({ scopeDescription: '   ' }, 'scope_description');
      await bad({ startsOn: '2026-02-30' }, 'starts_on');
      await bad({ periodMonths: 0 }, 'period_months');
      await bad({ periodMonths: 601 }, 'period_months');
      await bad({ periodMonths: 12.5 }, 'period_months');
      await bad({ retentionAmountVnd: '-1' }, 'retention_amount_vnd');
      await bad({ constructionGrade: 'V' }, 'construction_grade');
    });

    it('is judged by the scope of the caller: one it can read and not change is refused, one it cannot see does not exist', async () => {
      const target = await seed();
      expect(await refusal(create(target, {}, readOnly))).toMatchObject({ code: 'SCOPE_DENIED', status: 403 });
      expect(await refusal(create(target, {}, invisible))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await owner('select 1 from machvon.warranty_obligation where handover_id = $1::uuid', [target.handoverId])).toHaveLength(0);
    });
  });

  describe('closing an obligation', () => {
    it('AC-ST-AST-003-2, UAT-AC392: refuses while a claim is open, with its number, and closes once the claim is verified', async () => {
      const target = await seed();
      const obligation = await create(target);
      await claim(obligation.id, 'WC-002');
      expect(await refusal(close(obligation.id))).toMatchObject({ code: 'OPEN_WARRANTY_CLAIMS', status: 422, extensions: { open_claims: 1, claim_nos: ['WC-002'] } });
      expect((await rowOf(obligation.id))?.status).toBe('ACTIVE');
      await stage("update machvon.warranty_claim set status = 'VERIFIED', fixed_on = date '2027-08-25', verified_by = $2::uuid, verified_at = now() where obligation_id = $1::uuid", [
        obligation.id,
        memberId(VERIFIER),
      ]);
      const closed = await close(obligation.id, all, AFTER_END, 'All claims were answered.');
      expect(closed).toMatchObject({ status: 'CLOSED', fromStatus: 'ACTIVE', version: 2, openClaims: 0, handoverId: target.handoverId, contractId: target.contractId, endsOn: '2027-09-01' });
      expect(await rowOf(obligation.id)).toMatchObject({ status: 'CLOSED', version: '2', closed_by: memberId(MANAGER), close_note: 'All claims were answered.' });
      expect((await rowOf(obligation.id))?.closed_at).not.toBeNull();
    });

    it('refuses to close before the last day, whatever the claims, and closes on the last day', async () => {
      const target = await seed();
      const obligation = await create(target);
      expect(await refusal(close(obligation.id, all, new Date('2027-08-31T10:00:00Z')))).toMatchObject({ code: 'WARRANTY_NOT_EXPIRED', status: 422, extensions: { ends_on: '2027-09-01' } });
      await claim(obligation.id, 'WC-001');
      expect(await refusal(close(obligation.id, all, new Date('2027-08-31T10:00:00Z')))).toMatchObject({ code: 'WARRANTY_NOT_EXPIRED' });
      await stage("update machvon.warranty_claim set status = 'VERIFIED', fixed_on = date '2027-08-25', verified_by = $2::uuid, verified_at = now() where obligation_id = $1::uuid", [
        obligation.id,
        memberId(VERIFIER),
      ]);
      expect((await close(obligation.id, all, new Date('2027-09-01T03:00:00Z'))).status).toBe('CLOSED');
    });

    it('closes an obligation the job has already marked expired, and counts a disputed claim as open', async () => {
      const target = await seed();
      const obligation = await create(target);
      await stage("update machvon.warranty_obligation set status = 'EXPIRED' where id = $1::uuid", [obligation.id]);
      await claim(obligation.id, 'WC-009', 'DISPUTED');
      await claim(obligation.id, 'WC-010', 'CLOSED');
      expect(await refusal(close(obligation.id))).toMatchObject({ code: 'OPEN_WARRANTY_CLAIMS', extensions: { open_claims: 1, claim_nos: ['WC-009'] } });
      await stage(
        "update machvon.warranty_claim set status = 'VERIFIED', fixed_on = date '2027-08-25', verified_by = $2::uuid, verified_at = now() where claim_no = 'WC-009' and obligation_id = $1::uuid",
        [obligation.id, memberId(VERIFIER)],
      );
      expect(await close(obligation.id)).toMatchObject({ status: 'CLOSED', fromStatus: 'EXPIRED' });
    });

    it('is closed once, and a closed obligation takes no new claim', async () => {
      const target = await seed();
      const obligation = await create(target);
      await close(obligation.id);
      expect(await refusal(close(obligation.id))).toMatchObject({ code: 'WARRANTY_STATE_INVALID', status: 409, extensions: { status: 'CLOSED' } });
      const late = await databaseRefusal(claim(obligation.id, 'WC-LATE'));
      expect(late).toMatchObject({ sqlstate: '23514' });
      expect(late.message).toContain('WARRANTY_STATE_INVALID');
    });

    it('refuses an empty note and is judged by the scope of the caller', async () => {
      const target = await seed();
      const obligation = await create(target);
      expect(await refusal(close(obligation.id, all, AFTER_END, '   '))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'note' });
      expect(await refusal(close(obligation.id, readOnly))).toMatchObject({ code: 'SCOPE_DENIED', status: 403 });
      expect(await refusal(close(obligation.id, invisible))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(close(randomUUID()))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect((await rowOf(obligation.id))?.status).toBe('ACTIVE');
    });
  });

  describe('the database', () => {
    const insertSql = `insert into machvon.warranty_obligation
        (tenant_id, id, project_id, contract_id, handover_id, scope_description, starts_on, ends_on, period_months, retention_amount_vnd, status, created_by, updated_by)
       select h.tenant_id, gen_random_uuid(), h.project_id, h.contract_id, h.id, $2, date '2026-09-01', $3::date, $4, $5::numeric, $6, $7::uuid, $7::uuid from machvon.handover h where h.id = $1::uuid`;
    const insert = (target: Seeded, overrides: { description?: string; endsOn?: string; months?: number; retention?: string; status?: string } = {}) =>
      owner(insertSql, [
        target.handoverId,
        overrides.description ?? 'Whole work',
        overrides.endsOn ?? '2027-09-01',
        overrides.months ?? 12,
        overrides.retention ?? '1000',
        overrides.status ?? 'ACTIVE',
        memberId(MANAGER),
      ]);

    it('refuses an obligation that is not created active, whose end is not the start plus the term, that covers nothing or whose texts are empty', async () => {
      const target = await seed();
      expect((await databaseRefusal(insert(target, { status: 'CLOSED' }))).message).toContain('created active');
      expect((await databaseRefusal(insert(target, { endsOn: '2027-09-02' }))).message).toContain('warranty_obligation_term_chk');
      expect((await databaseRefusal(insert(target, { retention: '0' }))).message).toContain('warranty_obligation_cover_chk');
      expect((await databaseRefusal(insert(target, { description: '' }))).message).toContain('warranty_obligation_text_chk');
      await insert(target);
    });

    it('ends the warranty on the last day of a month that is shorter than the start day', async () => {
      const target = await seed();
      await owner(
        `insert into machvon.warranty_obligation (tenant_id, id, project_id, contract_id, handover_id, scope_description, starts_on, ends_on, period_months, retention_amount_vnd, created_by, updated_by)
         select h.tenant_id, gen_random_uuid(), h.project_id, h.contract_id, h.id, 'Short month', date '2026-01-31', date '2026-02-28', 1, 1, $2::uuid, $2::uuid from machvon.handover h where h.id = $1::uuid`,
        [target.handoverId, memberId(MANAGER)],
      );
    });

    it('keeps what an obligation is, the edges of its status and its closure', async () => {
      const target = await seed();
      const obligation = await create(target);
      const update = (set: string) => owner(`update machvon.warranty_obligation set ${set} where id = $1::uuid`, [obligation.id]);
      expect((await databaseRefusal(update("period_months = 24, ends_on = date '2028-09-01'"))).message).toContain('never changes');
      expect((await databaseRefusal(update('retention_amount_vnd = 1'))).message).toContain('never changes');
      expect((await databaseRefusal(update("scope_description = 'Another'"))).message).toContain('never changes');
      expect((await databaseRefusal(update("status = 'ACTIVE', alert_level_sent = 9"))).message).toContain('alert_level_sent');
      await update("status = 'EXPIRED'");
      expect((await databaseRefusal(update("status = 'ACTIVE'"))).message).toContain('this move of the status');
      await close(obligation.id);
      expect((await databaseRefusal(update("status = 'EXPIRED', closed_by = null, closed_at = null"))).message).toContain('does not change');
      expect((await databaseRefusal(update("close_note = 'rewritten'"))).message).toContain('does not change');
    });

    it('refuses to close an obligation with a claim open, whoever asks', async () => {
      const target = await seed();
      const obligation = await create(target);
      await claim(obligation.id, 'WC-OPEN');
      const closing = await databaseRefusal(
        owner("update machvon.warranty_obligation set status = 'CLOSED', closed_by = $2::uuid, closed_at = now() where id = $1::uuid", [obligation.id, memberId(MANAGER)]),
      );
      expect(closing).toMatchObject({ sqlstate: '23514' });
      expect(closing.message).toContain('OPEN_WARRANTY_CLAIMS');
      expect((await rowOf(obligation.id))?.status).toBe('ACTIVE');
    });

    it('does not let the runtime role delete an obligation or a claim', async () => {
      const target = await seed();
      const obligation = await create(target);
      await claim(obligation.id, 'WC-DEL');
      expect((await databaseRefusal(as((tx) => tx.query('delete from machvon.warranty_obligation where id = $1::uuid', [obligation.id])))).message).toContain('permission denied');
      expect((await databaseRefusal(as((tx) => tx.query('delete from machvon.warranty_claim where obligation_id = $1::uuid', [obligation.id])))).message).toContain('permission denied');
    });

    it('lets a verified claim be written on a closed obligation, but not a new open one nor the reopening of a resolved one', async () => {
      const target = await seed();
      const obligation = await create(target);
      await claim(obligation.id, 'WC-DONE', 'VERIFIED');
      await close(obligation.id);
      await claim(obligation.id, 'WC-LATE-OK', 'CLOSED');
      expect((await databaseRefusal(owner("update machvon.warranty_claim set status = 'OPEN' where obligation_id = $1::uuid and claim_no = 'WC-DONE'", [obligation.id]))).message).toContain(
        'the obligation is closed',
      );
    });
  });

  describe('reading', () => {
    it('lists the obligations in scope with the guarantee, the rule they were judged by and the claims, newest first, and pages with a cursor', async () => {
      const target = await seed();
      const guaranteeId = await guaranteeOf(target.contractId);
      const first = await create(target, { assetId: target.assetId, warrantyGuaranteeId: guaranteeId, retentionAmountVnd: '100' });
      const second = await create(target);
      await claim(first.id, 'WC-1');
      await claim(first.id, 'WC-2', 'VERIFIED');
      const lines = await as((tx) => warranties.list(tx, allRows, { handoverId: target.handoverId, today: '2026-12-20', limit: 10 }));
      expect(lines.map((line) => line.id)).toEqual([second.id, first.id]);
      expect(lines[1]).toMatchObject({
        id: first.id,
        contract: { id: target.contractId },
        handover: { id: target.handoverId, status: 'ACCEPTED' },
        asset: { id: target.assetId, name: 'Pump house' },
        startsOn: '2026-09-01',
        endsOn: '2027-09-01',
        periodMonths: 12,
        constructionGrade: 'II',
        minimumMonths: 12,
        rule: { awaitingConfirmation: true, cxn: 'CXN-EXE-04' },
        guarantee: { id: guaranteeId, issuer: 'Bank of the Province', amountVnd: '500000000', expiresOn: '2028-01-01' },
        retentionAmountVnd: '100',
        status: 'ACTIVE',
        openClaims: 1,
        totalClaims: 2,
        closedAt: null,
        version: 1,
      });
      expect(lines[0]).toMatchObject({ asset: null, guarantee: null, openClaims: 0, totalClaims: 0 });
      expect(lines[0]?.reach.recipientUnit.id).toBe(unitId(RECEIVER));
      const page = await as((tx) => warranties.list(tx, allRows, { handoverId: target.handoverId, today: '2026-12-20', limit: 2 }));
      const last = page[0];
      const next = await as((tx) => warranties.list(tx, allRows, { handoverId: target.handoverId, today: '2026-12-20', limit: 2, after: { code: last?.createdAt ?? '', id: last?.id ?? '' } }));
      expect(next.map((line) => line.id)).toEqual([first.id]);
    });

    it('filters by contract, by handover and by the status on the day, and sees only what the scope lets through', async () => {
      const target = await seed();
      const other = await seed();
      const kept = await create(target);
      await create(other);
      const ids = async (filter: { contractId?: string; handoverId?: string; status?: string; today?: string }, scope = allRows) =>
        (await as((tx) => warranties.list(tx, scope, { today: '2026-12-20', limit: 50, ...filter }))).map((line) => line.id);
      expect(await ids({ contractId: target.contractId })).toEqual([kept.id]);
      expect(await ids({ handoverId: other.handoverId })).toHaveLength(1);
      expect(await ids({ contractId: target.contractId, status: 'ACTIVE' })).toEqual([kept.id]);
      expect(await ids({ contractId: target.contractId, status: 'EXPIRED' })).toEqual([]);
      expect(await ids({ contractId: target.contractId, status: 'EXPIRED', today: '2027-09-01' })).toEqual([kept.id]);
      expect(await ids({ contractId: target.contractId, status: 'ACTIVE', today: '2027-09-01' })).toEqual([]);
      expect(await ids({ contractId: target.contractId }, noRows)).toEqual([]);
    });

    it('refuses a filter that is not one', async () => {
      const list = (filter: Partial<{ contractId: string; handoverId: string; status: string; today: string; limit: number }>) =>
        as((tx) => warranties.list(tx, allRows, { today: '2026-12-20', limit: 10, ...filter }));
      expect(await refusal(list({ contractId: 'nope' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'contract_id' });
      expect(await refusal(list({ handoverId: 'nope' }))).toMatchObject({ detail: 'handover_id' });
      expect(await refusal(list({ status: 'GONE' }))).toMatchObject({ detail: 'status' });
      expect(await refusal(list({ limit: 0 }))).toMatchObject({ detail: 'limit' });
      expect(await refusal(list({ limit: 202 }))).toMatchObject({ detail: 'limit' });
      expect(await refusal(list({ today: 'soon' }))).toMatchObject({ detail: 'today' });
    });
  });
});
