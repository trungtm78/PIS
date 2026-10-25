import { randomUUID } from 'node:crypto';
import { CtrAcceptanceStore } from '../src/ctr-acceptance-store';
import type { AcceptanceResult } from '../src/ctr-acceptance-store';
import type { ContractScopes } from '../src/ctr-contract-store';
import type { TenantTx } from '../src/tenant-database';
import { TENANT_A, contextFor, id, memberId } from './support/authz-fixtures';
import { seedAs } from './support/bid-proposal-fixtures';
import { CapWorld } from './support/cap-fixtures';
import { closeNcr as closeNcrAs, ncrStatement } from './support/ncr-fixtures';

const world = new CapWorld();
const harness = world.harness;
const acceptances = new CtrAcceptanceStore();
const FAMILY = 0xb0;
const CREATOR = 1;
const SENDER = 2;
const APPROVER = 3;
const SECOND_APPROVER = 4;
const REVOKER = 5;
const CONTRACTOR = id(FAMILY, 10);
const DOCUMENT = id(FAMILY, 30);
const VERSION = id(FAMILY, 31);
const DIRTY = id(FAMILY, 32);
const TODAY = '2026-07-25';
const contractScopes: ContractScopes = { update: () => ({ sql: 'true', params: [] }), read: () => ({ sql: 'true', params: [] }) };
const readOnly: ContractScopes = { update: () => ({ sql: 'false', params: [] }), read: () => ({ sql: 'true', params: [] }) };
const invisible: ContractScopes = { update: () => ({ sql: 'false', params: [] }), read: () => ({ sql: 'false', params: [] }) };
const everything = () => ({ sql: 'true', params: [] as unknown[] });
const nothing = () => ({ sql: 'false', params: [] as unknown[] });
const SIGNERS = [{ name: 'Representative of the owner', role: 'OWNER' }];

let PROJECT = '';
let LINE = '';
let PERIOD = '';
let OTHER_PERIOD = '';
let counter = 0;

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = CREATOR): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, memberId(member)), work);
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
  code: string;
  revisionId: string;
  /** B01: 8,000 m3 at 1,000,000; B02: 500 m3 at 2,000,000; B03: 10 at 1,234.5 (rounded to the dong, half up). */
  items: [string, string, string];
  partyId: string;
}

/** A contract being performed under revision 1, from 2026-01-02, worth nine billion; its BOQ is B01 (8,000 m3 at 1,000,000), B02 (500 m3 at 2,000,000) and B03 (10 at 1,234.5). */
async function seedContract(options: { value?: string; requiresQuality?: boolean; status?: string } = {}): Promise<Seeded> {
  counter += 1;
  const contractId = randomUUID();
  const revisionId = randomUUID();
  const packageId = randomUUID();
  const partyId = randomUUID();
  const code = `HD-N-${String(counter).padStart(4, '0')}`;
  const items: [string, string, string] = [randomUUID(), randomUUID(), randomUUID()];
  const line = (n: number, key: string, quantity: string, price: string, amount: string, retention: string): [string, unknown[]] => [
    `insert into machvon.boq_line (tenant_id, id, contract_revision_id, contract_id, boq_item_id, line_no, business_key, description, unit_code, quantity, unit_price, rounding_rule, amount_vnd, retention_pct, created_by)
     values ($1, gen_random_uuid(), $2, $3, $4, $5, $6, $7, 'M3', $8::numeric, $9::numeric, 'HALF_UP', $10::numeric, $11::numeric, $12)`,
    [TENANT_A, revisionId, contractId, items[n - 1], n, key, `Item ${key}`, quantity, price, amount, retention, memberId(CREATOR)],
  ];
  await seedAs(harness, [
    [
      `insert into machvon.procurement_package (tenant_id, id, project_id, code, budget_vnd, method, revision, status, allocation_line_id)
       values ($1, $2, $3, $4, 100000000000, 'OPEN', 1, 'AWARDED', $5)`,
      [TENANT_A, packageId, PROJECT, `PKG-${code}`, LINE],
    ],
    [
      `insert into machvon.contract
         (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, title, advance_category, is_joint_venture, requires_quality_acceptance, contract_value_vnd,
          created_by, updated_by, signed_on, effective_from)
       values ($1, $2, $3, $4, $5, $6, 'UNIT_PRICE', 'VND', 'ACTIVE', 1, 'Contract', 'OTHER', false, $8, $9::numeric, $7, $7, date '2026-01-01', date '2026-01-02')`,
      [TENANT_A, contractId, PROJECT, packageId, CONTRACTOR, code, memberId(CREATOR), options.requiresQuality === true, options.value ?? '9000000000'],
    ],
    [
      `insert into machvon.contract_revision (tenant_id, id, contract_id, revision, amount_vnd, document_version_id, valid_from, status, kind, version, created_by, updated_by)
       values ($1, $2, $3, 1, 9000000000, $4, date '2026-01-02', 'DRAFT', 'BASE', 1, $5, $5)`,
      [TENANT_A, revisionId, contractId, VERSION, memberId(CREATOR)],
    ],
    [
      `insert into machvon.boq_item (tenant_id, id, contract_id, business_key, description, unit_code, created_by, updated_by)
       values ($1, $2, $5, 'B01', 'Item B01', 'M3', $6, $6), ($1, $3, $5, 'B02', 'Item B02', 'M3', $6, $6), ($1, $4, $5, 'B03', 'Item B03', 'M3', $6, $6)`,
      [TENANT_A, items[0], items[1], items[2], contractId, memberId(CREATOR)],
    ],
    line(1, 'B01', '8000', '1000000', '8000000000', '5'),
    line(2, 'B02', '500', '2000000', '1000000000', '5'),
    line(3, 'B03', '10', '1234.5', '12345', '0'),
    [
      `insert into machvon.contract_party (tenant_id, id, contract_id, contractor_id, role, share_pct, work_value_vnd, status, valid_from, created_by, updated_by)
       values ($1, $2, $3, $4, 'SOLE', 100, 9000000000, 'ACTIVE', date '2026-01-02', $5, $5)`,
      [TENANT_A, partyId, contractId, CONTRACTOR, memberId(CREATOR)],
    ],
    [`update machvon.contract_revision set status = 'EFFECTIVE', decided_by = $2, decided_at = now() where id = $1::uuid`, [revisionId, memberId(CREATOR)]],
    [`update machvon.contract set current_revision_id = $2 where id = $1::uuid`, [contractId, revisionId]],
  ]);
  if (options.status !== undefined) {
    await owner(
      `update machvon.contract set status = $2::text, status_reason = case when $2::text in ('SUSPENDED', 'TERMINATED') then 'Stopped.' end,
              status_decision_document_version_id = case when $2::text in ('SUSPENDED', 'TERMINATED') then $3::uuid end where id = $1::uuid`,
      [contractId, options.status, VERSION],
    );
  }
  return { contractId, code, revisionId, items, partyId };
}

/** A measurement of an item in the period, written in the status given (approved by default, as the acceptance takes it). */
async function measured(seeded: Seeded, item: 0 | 1 | 2, quantity: string, options: { status?: string; period?: string; inspectionId?: string; party?: boolean; contractId?: string; unpriced?: boolean } = {}): Promise<string> {
  counter += 1;
  const measurementId = randomUUID();
  const status = options.status ?? 'APPROVED';
  const lineId = (await owner<{ id: string }>('select id from machvon.boq_line where contract_id = $1::uuid and boq_item_id = $2::uuid limit 1', [seeded.contractId, seeded.items[item]]))[0]?.id;
  await seedAs(harness, [
    [
      `insert into machvon.measurement
         (tenant_id, id, contract_id, contract_revision_id, boq_line_id, boq_item_id, party_id, period_id, quantity_period, quantity_cumulative, revision, status, evidence_refs, reference_no, inspection_id,
          created_by, updated_by, submitted_by, submitted_at, decided_by, decided_at, version)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::numeric, $9::numeric, $17, $10, jsonb_build_array(jsonb_build_object('document_version_id', $11::text)), $12, $13, $14, $14, $15, now(), $16, now(), 1)`,
      [
        TENANT_A,
        measurementId,
        options.contractId ?? seeded.contractId,
        seeded.revisionId,
        lineId,
        options.unpriced === true ? randomUUID() : seeded.items[item],
        options.party === true ? seeded.partyId : null,
        options.period ?? PERIOD,
        quantity,
        status,
        VERSION,
        `NK-${String(counter).padStart(5, '0')}`,
        options.inspectionId ?? null,
        memberId(CREATOR),
        status === 'DRAFT' ? null : memberId(CREATOR),
        status === 'APPROVED' ? memberId(APPROVER) : null,
        counter,
      ],
    ],
  ]);
  return measurementId;
}

const create = (seeded: Seeded, measurementIds: string[], overrides: Partial<{ periodId: string; documentVersionId: string; qualityAcceptanceId: string }> = {}, options: { member?: number; scopes?: ContractScopes; today?: string } = {}) =>
  as(
    (tx) => acceptances.create(tx, seeded.contractId, { measurementIds, periodId: PERIOD, documentVersionId: VERSION, ...overrides }, memberId(options.member ?? CREATOR), options.scopes ?? contractScopes, options.today ?? TODAY),
    options.member ?? CREATOR,
  );
const submit = (accepted: AcceptanceResult, options: { version?: number; member?: number; scopes?: ContractScopes; signers?: unknown } = {}) =>
  as((tx) => acceptances.submit(tx, accepted.id, options.version ?? accepted.version, { signerRefs: options.signers ?? SIGNERS }, memberId(options.member ?? SENDER), options.scopes ?? contractScopes), options.member ?? SENDER);
const decide = (accepted: AcceptanceResult, decision: string, options: { version?: number; member?: number; scopes?: ContractScopes; reason?: string; evidenceIds?: string[] } = {}) =>
  as(
    (tx) => acceptances.decide(tx, accepted.id, options.version ?? accepted.version, { decision, reason: options.reason ?? 'Checked against the measurements.', evidenceIds: options.evidenceIds ?? [] }, memberId(options.member ?? APPROVER), options.scopes ?? contractScopes),
    options.member ?? APPROVER,
  );
const revoke = (accepted: AcceptanceResult, options: { version?: number; member?: number; scopes?: ContractScopes; reason?: string; document?: string } = {}) =>
  as(
    (tx) =>
      acceptances.revoke(tx, accepted.id, options.version ?? accepted.version, { reason: options.reason ?? 'The measurements were found wrong.', approvalDocumentVersionId: options.document ?? VERSION }, memberId(options.member ?? REVOKER), options.scopes ?? contractScopes),
    options.member ?? REVOKER,
  );
/** An acceptance drafted from the measurements and sent. */
async function sent(seeded: Seeded, measurementIds: string[], overrides: Partial<{ qualityAcceptanceId: string }> = {}): Promise<AcceptanceResult> {
  return submit(await create(seeded, measurementIds, overrides));
}
const rowOf = async (acceptanceId: string) =>
  (
    await owner<{ status: string; version: string; accepted_amount_vnd: string; quality_acceptance_id: string | null; decided_by: string | null; submitted_by: string | null; acceptance_no: string; accepted_on: string; decision_reason: string | null; revoke_reason: string | null }>(
      'select status, version::text, accepted_amount_vnd::text, quality_acceptance_id, decided_by, submitted_by, acceptance_no, accepted_on::text, decision_reason, revoke_reason from machvon.acceptance where id = $1::uuid',
      [acceptanceId],
    )
  )[0];
const linesOf = (acceptanceId: string) =>
  owner<{ measurement_id: string; boq_item_id: string; party_id: string | null; quantity: string; unit_price_snapshot: string; amount_vnd: string; retention_pct_snapshot: string; active: boolean; contract_revision_id: string }>(
    'select measurement_id, boq_item_id, party_id, quantity::text, unit_price_snapshot::text, amount_vnd::text, retention_pct_snapshot::text, active, contract_revision_id from machvon.acceptance_line where acceptance_id = $1::uuid order by amount_vnd',
    [acceptanceId],
  );
const acceptedTotal = async (contractId: string) => (await owner<{ total: string }>('select accepted_total_vnd::text as total from machvon.contract where id = $1::uuid', [contractId]))[0]?.total;

/** Approved minutes of quality for the inspection of the contract (the minutes are QMS's: written straight to the table). */
async function qualityMinutes(seeded: Seeded, inspectionId: string, status = 'APPROVED'): Promise<string> {
  counter += 1;
  const minutesId = randomUUID();
  await seedAs(harness, [
    [
      `insert into machvon.quality_acceptance
         (tenant_id, id, project_id, contract_id, inspection_id, record_no, acceptance_scope, document_version_id, status, required_roles, content_hash, created_by, updated_by, version)
       values ($1, $2, $3, $4, $5, $6, 'WORK_ITEM', $7, 'DRAFT', '["CONTRACTOR","SUPERVISOR","OWNER"]'::jsonb, repeat('a', 64), $8, $8, 1)`,
      [TENANT_A, minutesId, PROJECT, seeded.contractId, inspectionId, `QA-${counter}`, VERSION, memberId(CREATOR)],
    ],
  ]);
  if (status === 'SIGNING') await owner("update machvon.quality_acceptance set status = 'SIGNING' where id = $1::uuid", [minutesId]);
  if (status === 'APPROVED' || status === 'REVOKED') {
    await owner("update machvon.quality_acceptance set status = 'SIGNING' where id = $1::uuid", [minutesId]);
    await owner("update machvon.quality_acceptance set status = 'APPROVED', decision_note = 'ok', approved_at = now(), approved_by = $2::uuid where id = $1::uuid", [minutesId, memberId(APPROVER)]);
  }
  if (status === 'REVOKED') await owner("update machvon.quality_acceptance set status = 'REVOKED', decision_note = 'ok', revoke_reason = 'Wrong.', revoked_at = now(), revoked_by = $2::uuid where id = $1::uuid", [minutesId, memberId(REVOKER)]);
  if (status === 'REJECTED') {
    await owner("update machvon.quality_acceptance set status = 'SIGNING' where id = $1::uuid", [minutesId]);
    await owner("update machvon.quality_acceptance set status = 'REJECTED', decision_note = 'no', rejected_at = now(), rejected_by = $2::uuid where id = $1::uuid", [minutesId, memberId(APPROVER)]);
  }
  return minutesId;
}

async function inspectionOf(seeded: Seeded, item: 0 | 1 | 2 = 1): Promise<string> {
  counter += 1;
  const inspectionId = randomUUID();
  await seedAs(harness, [
    [
      `insert into machvon.inspection (tenant_id, id, project_id, contract_id, boq_item_id, inspection_no, inspection_type, title, requested_by, requested_for, status, created_by, updated_by, version)
       values ($1, $2, $3, $4, $5, $6, 'CONCEALED_WORK', 'Inspection', $7, date '2026-01-01' + $8::int, 'REQUESTED', $7, $7, 1)`,
      [TENANT_A, inspectionId, PROJECT, seeded.contractId, seeded.items[item], `KT-${counter}`, memberId(CREATOR), counter],
    ],
  ]);
  return inspectionId;
}

async function ncr(seeded: Seeded, about: { measurementId?: string; inspectionId?: string } = {}, status = 'OPEN'): Promise<string> {
  const nid = randomUUID();
  await seedAs(harness, [
    [
      `insert into machvon.quality_nonconformance (tenant_id, id, project_id, contract_id, measurement_id, inspection_id, severity, action_owner_id, due_at, status, closure_evidence, blocks_acceptance)
       values ($1, $2, $3, $4, $5, $6, 'CRITICAL', $7, now() + interval '7 days', $8, '[]'::jsonb, true)`,
      [TENANT_A, nid, PROJECT, seeded.contractId, about.measurementId ?? null, about.inspectionId ?? null, memberId(CREATOR), status],
    ],
  ]);
  return nid;
}
const closeNcr = (nid: string) => closeNcrAs(harness.database.adminUrl, nid, memberId(APPROVER));

describe('the acceptance of work under a contract (ST-CTR-009)', () => {
  beforeAll(async () => {
    await world.start();
    for (const n of [SECOND_APPROVER, REVOKER]) await harness.seedMembership(TENANT_A, n, 1);
    const published = await world.publishedLine();
    PROJECT = published.projectId;
    LINE = published.lineId;
    PERIOD = randomUUID();
    OTHER_PERIOD = randomUUID();
    await seedAs(harness, [
      [`insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'QD', 'Record', 'INTERNAL', $3, $3)`, [TENANT_A, DOCUMENT, memberId(CREATOR)]],
      [
        `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
         values ($1, $2, $3, 1, 'tenants/ctr/record.pdf', repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL'),
                ($1, $4, $3, 2, 'tenants/ctr/unscanned.pdf', repeat('b', 64), 'application/pdf', 1, 'INTERNAL', 'PENDING', '{}'::jsonb, 'RENDERED_FINAL')`,
        [TENANT_A, VERSION, DOCUMENT, DIRTY],
      ],
      ...[PERIOD, OTHER_PERIOD].map(
        (periodId, n): [string, unknown[]] => [
          `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
           values ($1, $2, $3, 1, $4::date, $5::date, $5::date + interval '3 hours', 'CAL-N', 'MONTH', 2026, 'OPEN', gen_random_uuid(), $6, $6)`,
          [TENANT_A, periodId, `2026-0${n + 6}`, `2026-0${n + 6}-01`, `2026-0${n + 6}-28`, memberId(CREATOR)],
        ],
      ),
    ]);
  }, 240_000);

  afterAll(async () => {
    await world.stop();
  }, 60_000);

  describe('drafting', () => {
    it('AC-ST-CTR-009-1, UAT-AC63: takes approved measurements only, naming those that are not, and prices an approved one from the revision in force', async () => {
      const seeded = await seedContract();
      const submitted = await measured(seeded, 0, '1000', { status: 'SUBMITTED' });
      const approved = await measured(seeded, 1, '200');
      const draft = await measured(seeded, 0, '10', { status: 'DRAFT' });
      expect(await refusal(create(seeded, [submitted]))).toMatchObject({ code: 'MEASUREMENT_NOT_APPROVED', status: 422, extensions: { measurement_ids: [submitted] } });
      expect(await refusal(create(seeded, [approved, draft]))).toMatchObject({ code: 'MEASUREMENT_NOT_APPROVED', extensions: { measurement_ids: [draft] } });
      expect(await owner('select 1 from machvon.acceptance where contract_id = $1::uuid', [seeded.contractId])).toEqual([]);

      const made = await create(seeded, [approved]);
      expect(made).toMatchObject({ status: 'DRAFT', fromStatus: null, version: 1, acceptanceNo: 'NT-001', acceptedOn: TODAY, acceptedAmountVnd: '400000000', qualityAcceptanceId: null, acceptedTotalVnd: '0' });
      expect(made.lines).toEqual([expect.objectContaining({ measurementId: approved, quantity: '200.000000', unitPriceSnapshot: '2000000.000000', amountVnd: '400000000', retentionPctSnapshot: '5.0000', contractRevisionId: seeded.revisionId })]);
      expect(await rowOf(made.id)).toMatchObject({ status: 'DRAFT', accepted_amount_vnd: '400000000', acceptance_no: 'NT-001', accepted_on: TODAY });
      // The lines do not count as accepted until the acceptance is approved.
      expect((await linesOf(made.id))[0]).toMatchObject({ active: false, amount_vnd: '400000000' });
      expect(await acceptedTotal(seeded.contractId)).toBe('0');
    });

    it('sums the lines, rounds each to the dong the way its line of the BOQ is rounded, and numbers the acceptances of the contract', async () => {
      const seeded = await seedContract();
      const first = await measured(seeded, 0, '3.5');
      const second = await measured(seeded, 2, '3');
      const made = await create(seeded, [first, second]);
      // 3.5 x 1,000,000 = 3,500,000 and 3 x 1,234.5 = 3,703.5, which is 3,704.
      expect(made.lines.map((line) => line.amountVnd).sort()).toEqual(['3500000', '3704']);
      expect(made.acceptedAmountVnd).toBe('3503704');
      expect((await create(seeded, [await measured(seeded, 1, '1', { period: OTHER_PERIOD })], { periodId: OTHER_PERIOD })).acceptanceNo).toBe('NT-002');
    });

    it('UAT-AC58: takes the price of the revision in force on the day, and keeps it when a later revision comes', async () => {
      const seeded = await seedContract();
      const second = randomUUID();
      const early = await measured(seeded, 1, '500');
      const before = await create(seeded, [early], {}, { today: '2026-07-25' });
      expect(before.lines[0]).toMatchObject({ unitPriceSnapshot: '2000000.000000', amountVnd: '1000000000' });
      // Revision 2 puts B02 at 2,100,000 from 2026-08-01 and revision 1 is closed on that day.
      await seedAs(harness, [
        [
          `insert into machvon.contract_revision (tenant_id, id, contract_id, revision, amount_vnd, document_version_id, valid_from, status, kind, version, created_by, updated_by)
           values ($1, $2, $3, 2, 9250000000, $4, date '2026-08-01', 'DRAFT', 'AMENDMENT', 1, $5, $5)`,
          [TENANT_A, second, seeded.contractId, VERSION, memberId(CREATOR)],
        ],
        [
          `insert into machvon.boq_line (tenant_id, id, contract_revision_id, contract_id, boq_item_id, line_no, business_key, description, unit_code, quantity, unit_price, rounding_rule, amount_vnd, retention_pct, created_by)
           select tenant_id, gen_random_uuid(), $2, contract_id, boq_item_id, line_no, business_key, description, unit_code, quantity, case when business_key = 'B02' then 2100000 else unit_price end, rounding_rule, case when business_key = 'B02' then (quantity * 2100000)::numeric(24,0) else amount_vnd end, retention_pct, created_by
             from machvon.boq_line where contract_revision_id = $1::uuid`,
          [seeded.revisionId, second],
        ],
        [`update machvon.contract_revision set status = 'SUPERSEDED', valid_until = date '2026-08-01' where id = $1::uuid`, [seeded.revisionId]],
        [`update machvon.contract_revision set status = 'EFFECTIVE', decided_by = $2, decided_at = now() where id = $1::uuid`, [second, memberId(CREATOR)]],
      ]);
      const later = await measured(seeded, 1, '100', { period: OTHER_PERIOD });
      const after = await create(seeded, [later], { periodId: OTHER_PERIOD }, { today: '2026-08-02' });
      expect(after.lines[0]).toMatchObject({ unitPriceSnapshot: '2100000.000000', amountVnd: '210000000', contractRevisionId: second });
      // The acceptance of 07-25 keeps what it was worth; a day before any revision has no price to take.
      expect((await linesOf(before.id))[0]).toMatchObject({ unit_price_snapshot: '2000000.000000', amount_vnd: '1000000000', contract_revision_id: seeded.revisionId });
      expect(await refusal(create(seeded, [await measured(seeded, 0, '1', { period: OTHER_PERIOD })], { periodId: OTHER_PERIOD }, { today: '2025-12-31' }))).toMatchObject({ code: 'REVISION_NOT_EFFECTIVE', status: 422 });
    });

    it('refuses what an approved acceptance holds already, a measurement of another period, a contract that is not being performed, and a shape that is not one', async () => {
      const seeded = await seedContract();
      const taken = await measured(seeded, 0, '10');
      const accepted = await sent(seeded, [taken]);
      await decide(accepted, 'approve');
      expect(await refusal(create(seeded, [taken]))).toMatchObject({ code: 'MEASUREMENT_ALREADY_ACCEPTED', status: 409, extensions: { measurement_ids: [taken] } });
      const other = await measured(seeded, 1, '10', { period: OTHER_PERIOD });
      expect(await refusal(create(seeded, [other]))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'period_id' });
      const fresh = await measured(seeded, 1, '1');
      const refused = async (ids: string[], overrides: Partial<{ periodId: string; documentVersionId: string; qualityAcceptanceId: string }> = {}) => (await refusal(create(seeded, ids, overrides))).detail;
      expect(await refused([])).toBe('measurement_ids');
      expect(await refused(['nope'])).toBe('measurement_ids');
      expect(await refused([fresh, fresh])).toBe('measurement_ids');
      expect(await refused([randomUUID()])).toBe('measurement_ids');
      expect(await refused([fresh], { periodId: 'nope' })).toBe('period_id');
      expect(await refused([fresh], { periodId: randomUUID() })).toBe('period_id');
      expect(await refused([fresh], { documentVersionId: DIRTY })).toBe('document_version_id');
      expect(await refused([fresh], { documentVersionId: randomUUID() })).toBe('document_version_id');
      expect(await refused([fresh], { qualityAcceptanceId: 'nope' })).toBe('quality_acceptance_id');
      // A measurement of another contract is not found among the measurements of this one.
      const stranger = await seedContract();
      expect(await refused([await measured(stranger, 0, '1')])).toBe('measurement_ids');
      const suspended = await seedContract({ status: 'SUSPENDED' });
      expect(await refusal(create(suspended, [await measured(suspended, 0, '1')]))).toMatchObject({ code: 'CONTRACT_STATE_INVALID', status: 409 });
      expect(await refusal(create(seeded, [fresh], {}, { scopes: readOnly }))).toMatchObject({ status: 403 });
      expect(await refusal(create(seeded, [fresh], {}, { scopes: invisible }))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });

    it('refuses a measurement of an item the revision in force does not price, and an amount that rounds to nothing', async () => {
      const seeded = await seedContract();
      // The item has no line in the revision in force.
      const noPrice = await measured(seeded, 0, '1', { unpriced: true });
      expect(await refusal(create(seeded, [noPrice]))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'measurement_ids', extensions: { reason: 'NO_PRICE' } });
      const dust = await measured(seeded, 2, '0.000001');
      expect(await refusal(create(seeded, [dust]))).toMatchObject({ code: 'VALIDATION_FAILED', extensions: { reason: 'AMOUNT_NOT_POSITIVE' } });
    });

    it('prices an item by its line in the revision whichever party did the work, and keeps the party on the line', async () => {
      const seeded = await seedContract();
      const byParty = await measured(seeded, 0, '10', { party: true });
      const general = await measured(seeded, 0, '10', { period: OTHER_PERIOD });
      const made = await create(seeded, [byParty]);
      expect(made.lines[0]).toMatchObject({ unitPriceSnapshot: '1000000.000000', partyId: seeded.partyId, amountVnd: '10000000' });
      const other = await create(seeded, [general], { periodId: OTHER_PERIOD });
      expect(other.lines[0]).toMatchObject({ unitPriceSnapshot: '1000000.000000', partyId: null });
    });

    it('names minutes of quality that can never serve, and takes ones that are of the contract', async () => {
      const seeded = await seedContract({ requiresQuality: true });
      const inspectionId = await inspectionOf(seeded);
      const minutes = await qualityMinutes(seeded, inspectionId, 'SIGNING');
      const revoked = await qualityMinutes(seeded, await inspectionOf(seeded), 'REVOKED');
      const other = await seedContract();
      const foreign = await qualityMinutes(other, await inspectionOf(other));
      const measurement = await measured(seeded, 1, '5');
      expect(await refusal(create(seeded, [measurement], { qualityAcceptanceId: randomUUID() }))).toMatchObject({ code: 'QUALITY_ACCEPTANCE_REQUIRED', status: 422, extensions: { reason: 'UNKNOWN' } });
      expect(await refusal(create(seeded, [measurement], { qualityAcceptanceId: foreign }))).toMatchObject({ code: 'QUALITY_ACCEPTANCE_REQUIRED', extensions: { reason: 'UNKNOWN' } });
      expect(await refusal(create(seeded, [measurement], { qualityAcceptanceId: revoked }))).toMatchObject({ code: 'QUALITY_ACCEPTANCE_REQUIRED', extensions: { reason: 'REVOKED' } });
      const made = await create(seeded, [measurement], { qualityAcceptanceId: minutes });
      expect(made.qualityAcceptanceId).toBe(minutes);
    });
  });

  describe('sending', () => {
    it('sends a draft with the people who sign the paper, and keeps them', async () => {
      const seeded = await seedContract();
      const made = await create(seeded, [await measured(seeded, 0, '10')]);
      expect(await refusal(submit(made, { signers: [] }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'signer_refs' });
      expect(await refusal(submit(made, { signers: 'nobody' }))).toMatchObject({ detail: 'signer_refs' });
      expect(await refusal(submit(made, { signers: ['x'] }))).toMatchObject({ detail: 'signer_refs' });
      expect(await refusal(submit(made, { signers: Array.from({ length: 21 }, () => ({})) }))).toMatchObject({ detail: 'signer_refs' });
      expect(await refusal(submit(made, { signers: [{ name: 'x'.repeat(4001) }] }))).toMatchObject({ detail: 'signer_refs' });
      const done = await submit(made);
      expect(done).toMatchObject({ status: 'SUBMITTED', fromStatus: 'DRAFT', version: 2 });
      expect(await rowOf(made.id)).toMatchObject({ status: 'SUBMITTED', submitted_by: memberId(SENDER) });
      expect((await owner<{ signer_refs: unknown }>('select signer_refs from machvon.acceptance where id = $1::uuid', [made.id]))[0]?.signer_refs).toEqual(SIGNERS);
      expect(await refusal(submit(done))).toMatchObject({ code: 'ACCEPTANCE_STATE_INVALID', status: 409, extensions: { acceptance_status: 'SUBMITTED' } });
    });

    it('refuses a measurement that was corrected since, one that another acceptance holds, a contract not being performed, a stale version and minutes that were revoked', async () => {
      const seeded = await seedContract();
      const corrected = await measured(seeded, 0, '10');
      const draftOfCorrected = await create(seeded, [corrected]);
      await owner("update machvon.measurement set status = 'SUPERSEDED' where id = $1::uuid", [corrected]);
      expect(await refusal(submit(draftOfCorrected))).toMatchObject({ code: 'MEASUREMENT_NOT_APPROVED', extensions: { measurement_ids: [corrected] } });

      const contested = await measured(seeded, 1, '10');
      const first = await sent(seeded, [contested]);
      const second = await create(seeded, [contested]);
      await decide(first, 'approve');
      expect(await refusal(submit(second))).toMatchObject({ code: 'MEASUREMENT_ALREADY_ACCEPTED', status: 409, extensions: { measurement_ids: [contested] } });
      expect(await refusal(submit(second, { version: 99 }))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });

      const withQuality = await seedContract({ requiresQuality: true });
      const minutes = await qualityMinutes(withQuality, await inspectionOf(withQuality), 'APPROVED');
      const named = await create(withQuality, [await measured(withQuality, 2, '1')], { qualityAcceptanceId: minutes });
      await owner("update machvon.quality_acceptance set status = 'REVOKED', revoke_reason = 'Wrong.', revoked_at = now(), revoked_by = $2::uuid where id = $1::uuid", [minutes, memberId(REVOKER)]);
      expect(await refusal(submit(named))).toMatchObject({ code: 'QUALITY_ACCEPTANCE_REQUIRED', extensions: { reason: 'REVOKED' } });

      const stopped = await seedContract();
      const draftOfStopped = await create(stopped, [await measured(stopped, 0, '1')]);
      await owner("update machvon.contract set status = 'SUSPENDED', status_reason = 'Stopped.', status_decision_document_version_id = $2::uuid where id = $1::uuid", [stopped.contractId, VERSION]);
      expect(await refusal(submit(draftOfStopped))).toMatchObject({ code: 'CONTRACT_STATE_INVALID', status: 409 });
      expect(await refusal(submit(draftOfStopped, { scopes: readOnly }))).toMatchObject({ status: 403 });
      expect(await refusal(submit(draftOfStopped, { scopes: invisible }))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });
  });

  describe('deciding', () => {
    it('approves a sent acceptance: the lines count, the accepted total of the contract rises, and the approval is kept', async () => {
      const seeded = await seedContract();
      const accepted = await sent(seeded, [await measured(seeded, 1, '200')]);
      // Not by whoever drafted it or sent it.
      expect(await refusal(decide(accepted, 'approve', { member: CREATOR }))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await refusal(decide(accepted, 'approve', { member: SENDER }))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect((await rowOf(accepted.id))?.status).toBe('SUBMITTED');
      const done = await decide(accepted, 'approve', { reason: ' Matches the measurements. ' });
      expect(done).toMatchObject({ status: 'APPROVED', fromStatus: 'SUBMITTED', version: 3, decision: 'approve', reason: 'Matches the measurements.', acceptedTotalVnd: '400000000', acceptedAmountVnd: '400000000' });
      expect(await rowOf(accepted.id)).toMatchObject({ status: 'APPROVED', decided_by: memberId(APPROVER), decision_reason: 'Matches the measurements.' });
      expect((await linesOf(accepted.id))[0]).toMatchObject({ active: true });
      expect(await acceptedTotal(seeded.contractId)).toBe('400000000');
      expect(await refusal(decide(done, 'approve', { member: SECOND_APPROVER }))).toMatchObject({ code: 'ACCEPTANCE_STATE_INVALID', status: 409, extensions: { acceptance_status: 'APPROVED' } });
    });

    it('rejects an acceptance with the reason, and gives one back to the draft to be sent again', async () => {
      const seeded = await seedContract();
      const accepted = await sent(seeded, [await measured(seeded, 0, '10')]);
      expect(await refusal(decide(accepted, 'maybe'))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'decision' });
      expect(await refusal(decide(accepted, 'reject', { reason: '  ' }))).toMatchObject({ detail: 'reason' });
      expect(await refusal(decide(accepted, 'reject', { evidenceIds: ['nope'] }))).toMatchObject({ detail: 'evidence_ids' });
      expect(await refusal(decide(accepted, 'reject', { evidenceIds: [randomUUID()] }))).toMatchObject({ detail: 'evidence_ids' });
      const returned = await decide(accepted, 'return', { evidenceIds: [DOCUMENT] });
      expect(returned).toMatchObject({ status: 'DRAFT', fromStatus: 'SUBMITTED', decision: 'return', evidenceIds: [DOCUMENT] });
      expect(await rowOf(accepted.id)).toMatchObject({ status: 'DRAFT', submitted_by: null });
      const again = await submit(returned, { member: SECOND_APPROVER });
      const rejected = await decide(again, 'reject', { reason: 'The paper is the wrong one.' });
      expect(rejected).toMatchObject({ status: 'REJECTED', decision: 'reject' });
      expect(await rowOf(accepted.id)).toMatchObject({ status: 'REJECTED', decision_reason: 'The paper is the wrong one.' });
      expect((await linesOf(accepted.id))[0]).toMatchObject({ active: false });
      expect(await acceptedTotal(seeded.contractId)).toBe('0');
      expect(await refusal(decide(rejected, 'approve'))).toMatchObject({ code: 'ACCEPTANCE_STATE_INVALID' });
    });

    it('refuses to accept above the value of the contract, and says how much is left', async () => {
      const seeded = await seedContract({ value: '500000000' });
      const first = await sent(seeded, [await measured(seeded, 1, '200')]);
      await decide(first, 'approve');
      const second = await submit(await create(seeded, [await measured(seeded, 1, '51', { period: OTHER_PERIOD })], { periodId: OTHER_PERIOD }));
      expect(await refusal(decide(second, 'approve', { member: SECOND_APPROVER }))).toMatchObject({
        code: 'ACCEPTANCE_VALUE_EXCEEDS_CONTRACT',
        status: 422,
        extensions: { accepted_total_vnd: '400000000', amount_vnd: '102000000', contract_value_vnd: '500000000', remaining_vnd: '100000000' },
      });
      expect(await acceptedTotal(seeded.contractId)).toBe('400000000');
      expect((await rowOf(second.id))?.status).toBe('SUBMITTED');
      // What fits, to the dong, is accepted.
      const fits = await submit(await create(seeded, [await measured(seeded, 1, '50', { period: OTHER_PERIOD })], { periodId: OTHER_PERIOD }));
      expect((await decide(fits, 'approve', { member: SECOND_APPROVER })).acceptedTotalVnd).toBe('500000000');
    });

    it('refuses an approval on a contract that is no longer being performed, and one whose measurement was corrected since it was sent', async () => {
      const seeded = await seedContract();
      const measurement = await measured(seeded, 0, '10');
      const accepted = await sent(seeded, [measurement]);
      await owner("update machvon.measurement set status = 'SUPERSEDED' where id = $1::uuid", [measurement]);
      expect(await refusal(decide(accepted, 'approve'))).toMatchObject({ code: 'MEASUREMENT_NOT_APPROVED', extensions: { measurement_ids: [measurement] } });
      const stopped = await seedContract();
      const waiting = await sent(stopped, [await measured(stopped, 0, '1')]);
      await owner("update machvon.contract set status = 'SUSPENDED', status_reason = 'Stopped.', status_decision_document_version_id = $2::uuid where id = $1::uuid", [stopped.contractId, VERSION]);
      expect(await refusal(decide(waiting, 'approve'))).toMatchObject({ code: 'CONTRACT_STATE_INVALID', status: 409 });
      expect(await refusal(decide(waiting, 'approve', { scopes: readOnly }))).toMatchObject({ status: 403 });
      expect(await refusal(decide(waiting, 'approve', { scopes: invisible }))).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
      expect(await refusal(decide(waiting, 'approve', { version: 99 }))).toMatchObject({ code: 'VERSION_CONFLICT' });
    });
  });
  describe('the quality acceptance minutes and the serious non-conformances', () => {
    it('AC-ST-CTR-009-2, UAT-AC313: waits for approved minutes of quality, then for the serious non-conformance on the work to be closed, then is approved with the minutes linked', async () => {
      const seeded = await seedContract({ requiresQuality: true });
      const inspectionId = await inspectionOf(seeded, 1);
      const measurement = await measured(seeded, 1, '50', { inspectionId });
      const blocking = await ncr(seeded, { measurementId: measurement });
      const accepted = await sent(seeded, [measurement]);
      expect(await refusal(decide(accepted, 'approve'))).toMatchObject({ code: 'QUALITY_ACCEPTANCE_REQUIRED', status: 422, extensions: { reason: 'MISSING' } });
      // Minutes of quality that are still being signed do not serve, nor do ones for another inspection, nor revoked ones.
      const signing = await qualityMinutes(seeded, inspectionId, 'SIGNING');
      await qualityMinutes(seeded, await inspectionOf(seeded, 1), 'APPROVED');
      expect(await refusal(decide(accepted, 'approve'))).toMatchObject({ code: 'QUALITY_ACCEPTANCE_REQUIRED' });
      await owner("update machvon.quality_acceptance set status = 'REJECTED', decision_note = 'no', rejected_at = now(), rejected_by = $2::uuid where id = $1::uuid", [signing, memberId(APPROVER)]);
      await qualityMinutes(seeded, inspectionId, 'REVOKED');
      expect(await refusal(decide(accepted, 'approve'))).toMatchObject({ code: 'QUALITY_ACCEPTANCE_REQUIRED' });
      const serving = await qualityMinutes(seeded, inspectionId, 'APPROVED');
      expect(await refusal(decide(accepted, 'approve'))).toMatchObject({ code: 'OPEN_CRITICAL_NCR', status: 422, extensions: { nonconformance_ids: [blocking] } });
      expect((await rowOf(accepted.id))?.status).toBe('SUBMITTED');
      expect(await acceptedTotal(seeded.contractId)).toBe('0');
      await closeNcr(blocking);
      const done = await decide(accepted, 'approve');
      expect(done).toMatchObject({ status: 'APPROVED', qualityAcceptanceId: serving });
      expect(await rowOf(accepted.id)).toMatchObject({ status: 'APPROVED', quality_acceptance_id: serving });
      expect(await acceptedTotal(seeded.contractId)).toBe('100000000');
    });

    it('takes the minutes named on the acceptance when they are approved, and does not ask for any of a contract that does not ask for them', async () => {
      const seeded = await seedContract({ requiresQuality: true });
      const minutes = await qualityMinutes(seeded, await inspectionOf(seeded, 0), 'APPROVED');
      const named = await sent(seeded, [await measured(seeded, 0, '10')], { qualityAcceptanceId: minutes });
      expect((await decide(named, 'approve')).qualityAcceptanceId).toBe(minutes);
      const plain = await seedContract();
      const free = await decide(await sent(plain, [await measured(plain, 0, '10')]), 'approve');
      expect(free.qualityAcceptanceId).toBeNull();
    });

    it('stops at a serious non-conformance of the work or of the contract in general, and not at one about other work', async () => {
      const seeded = await seedContract();
      const inspectionOfB01 = await inspectionOf(seeded, 0);
      const inspectionOfB02 = await inspectionOf(seeded, 1);
      const measurement = await measured(seeded, 0, '10');
      const accepted = await sent(seeded, [measurement]);
      // About other work: another measurement, an inspection of another item.
      await ncr(seeded, { measurementId: await measured(seeded, 1, '10') });
      await ncr(seeded, { inspectionId: inspectionOfB02 });
      // Closed, or not serious.
      const closed = await ncr(seeded, { measurementId: measurement });
      await closeNcr(closed);
      const minor = await ncr(seeded, { measurementId: measurement });
      await ncrStatement(harness.database.adminUrl, "update machvon.quality_nonconformance set severity = 'MAJOR', blocks_acceptance = false where id = $1::uuid", [minor]);
      const general = await ncr(seeded);
      expect(await refusal(decide(accepted, 'approve'))).toMatchObject({ code: 'OPEN_CRITICAL_NCR', extensions: { nonconformance_ids: [general] } });
      await closeNcr(general);
      const ofItem = await ncr(seeded, { inspectionId: inspectionOfB01 });
      expect(await refusal(decide(accepted, 'approve'))).toMatchObject({ code: 'OPEN_CRITICAL_NCR', extensions: { nonconformance_ids: [ofItem] } });
      await closeNcr(ofItem);
      expect((await decide(accepted, 'approve')).status).toBe('APPROVED');
    });
  });

  describe('two acceptances of the same measurement', () => {
    it('AC-ST-CTR-009-3, UAT-AC314: approves exactly one of two sent at the same moment, over thirty rounds, and the loser stays sent with nothing accepted twice', async () => {
      const seeded = await seedContract({ value: '100000000000' });
      let expectedTotal = 0n;
      for (let round = 1; round <= 30; round += 1) {
        const contested = await measured(seeded, 1, '1');
        const left = await sent(seeded, [contested]);
        const right = await sent(seeded, [contested]);
        const outcomes = await Promise.allSettled([decide(left, 'approve', { member: APPROVER }), decide(right, 'approve', { member: SECOND_APPROVER })]);
        const won = outcomes.filter((outcome) => outcome.status === 'fulfilled');
        const lost = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
        expect({ round, won: won.length, lost: lost.length }).toEqual({ round, won: 1, lost: 1 });
        expect(lost[0]?.reason).toMatchObject({ code: 'MEASUREMENT_ALREADY_ACCEPTED', status: 409 });
        const winner = outcomes[0]?.status === 'fulfilled' ? left : right;
        const loser = winner === left ? right : left;
        expect(await rowOf(winner.id)).toMatchObject({ status: 'APPROVED' });
        expect(await rowOf(loser.id)).toMatchObject({ status: 'SUBMITTED' });
        expect(await owner('select id from machvon.acceptance_line where measurement_id = $1::uuid and active', [contested])).toHaveLength(1);
        expect((await linesOf(loser.id))[0]).toMatchObject({ active: false });
        expectedTotal += 2000000n;
        expect(await acceptedTotal(seeded.contractId)).toBe(expectedTotal.toString());
      }
    }, 240_000);

    it('lets the unique index decide when the pre-check is not enough: a second active line for the measurement is refused by the database', async () => {
      const seeded = await seedContract();
      const contested = await measured(seeded, 0, '10');
      const first = await sent(seeded, [contested]);
      const second = await create(seeded, [contested]);
      await decide(first, 'approve');
      await owner("update machvon.acceptance set status = 'SUBMITTED', submitted_by = $2::uuid, submitted_at = now() where id = $1::uuid", [second.id, memberId(SENDER)]);
      await owner("update machvon.acceptance set status = 'APPROVED', approved_at = now(), decided_by = $2::uuid, decision_reason = 'ok' where id = $1::uuid", [second.id, memberId(APPROVER)]);
      expect((await databaseRefusal(owner('update machvon.acceptance_line set active = true where acceptance_id = $1::uuid', [second.id]))).sqlstate).toBe('23505');
    });
  });

  describe('revoking', () => {
    const approvedOne = async (seeded: Seeded, quantity = '200') => decide(await sent(seeded, [await measured(seeded, 1, quantity)]), 'approve');

    it('withdraws an approved acceptance with the reason and the paper: the lines stop counting and the accepted total falls', async () => {
      const seeded = await seedContract();
      const approved = await approvedOne(seeded);
      expect(await acceptedTotal(seeded.contractId)).toBe('400000000');
      expect(await refusal(revoke(approved, { member: APPROVER }))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await refusal(revoke(approved, { member: SENDER }))).toMatchObject({ code: 'SELF_APPROVAL_DENIED' });
      expect(await refusal(revoke(approved, { reason: '  ' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'reason' });
      expect(await refusal(revoke(approved, { document: DIRTY }))).toMatchObject({ detail: 'approval_document_version_id' });
      expect(await refusal(revoke(approved, { document: 'nope' }))).toMatchObject({ detail: 'approval_document_version_id' });
      const revoked = await revoke(approved, { reason: ' Wrong measurements. ' });
      expect(revoked).toMatchObject({ status: 'REVOKED', fromStatus: 'APPROVED', acceptedTotalVnd: '0' });
      expect(await rowOf(approved.id)).toMatchObject({ status: 'REVOKED', revoke_reason: 'Wrong measurements.' });
      expect((await linesOf(approved.id))[0]).toMatchObject({ active: false });
      expect(await acceptedTotal(seeded.contractId)).toBe('0');
      expect(await refusal(revoke(revoked))).toMatchObject({ code: 'ACCEPTANCE_STATE_INVALID', status: 409, extensions: { acceptance_status: 'REVOKED' } });
      // The measurement is free to be accepted again.
      const again = await sent(seeded, [(await linesOf(approved.id))[0]?.measurement_id as string]);
      expect((await decide(again, 'approve')).acceptedTotalVnd).toBe('400000000');
    });

    it('refuses to withdraw while a payment request holds the acceptance, and withdraws it once the claim is released', async () => {
      const seeded = await seedContract();
      const approved = await approvedOne(seeded);
      const claim = randomUUID();
      await seedAs(harness, [
        [
          `insert into machvon.payment_request (tenant_id, id, project_id, contract_id, acceptance_id, currency, gross_vnd, advance_recovery_vnd, retention_vnd, tax_adjustment_vnd, net_vnd, status, version, claims_acceptance, request_no)
           values ($1, $2, $3, $4, $5, 'VND', 400000000, 0, 0, 0, 400000000, 'SUBMITTED', 1, true, 'DNTT-CLAIM')`,
          [TENANT_A, claim, PROJECT, seeded.contractId, approved.id],
        ],
      ]);
      expect(await refusal(revoke(approved))).toMatchObject({ code: 'ACCEPTANCE_ALREADY_CLAIMED', status: 409, extensions: { payment_request_id: claim } });
      expect((await rowOf(approved.id))?.status).toBe('APPROVED');
      expect(await acceptedTotal(seeded.contractId)).toBe('400000000');
      await owner("update machvon.payment_request set status = 'RETURNED', claims_acceptance = false, return_reason = 'Withdrawn.', returned_by = gen_random_uuid(), returned_at = now() where id = $1::uuid", [claim]);
      expect((await revoke(approved)).status).toBe('REVOKED');
    });

    it('revokes only approved acceptances, under the version and the scope', async () => {
      const seeded = await seedContract();
      const draft = await create(seeded, [await measured(seeded, 0, '1')]);
      expect(await refusal(revoke(draft))).toMatchObject({ code: 'ACCEPTANCE_STATE_INVALID', status: 409 });
      const approved = await approvedOne(await seedContract());
      expect(await refusal(revoke(approved, { version: 1 }))).toMatchObject({ code: 'VERSION_CONFLICT' });
      expect(await refusal(revoke(approved, { scopes: readOnly }))).toMatchObject({ status: 403 });
      expect(await refusal(revoke(approved, { scopes: invisible }))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });
  });

  describe('the database keeps the same rules', () => {
    it('keeps the lines and the edges: nothing about a line changes, a line counts only with an approved acceptance, and nothing is deleted', async () => {
      const seeded = await seedContract();
      const made = await create(seeded, [await measured(seeded, 1, '10')]);
      const line = (await owner<{ id: string }>('select id from machvon.acceptance_line where acceptance_id = $1::uuid', [made.id]))[0]?.id as string;
      const change = (set: string) => owner(`update machvon.acceptance_line set ${set} where id = $1::uuid`, [line]);
      expect((await databaseRefusal(change('amount_vnd = 1'))).sqlstate).toBe('23514');
      expect((await databaseRefusal(change('unit_price_snapshot = 1'))).sqlstate).toBe('23514');
      expect((await databaseRefusal(change('quantity = 1'))).sqlstate).toBe('23514');
      // It does not count before the acceptance is approved, and a line is not added to an acceptance once it is sent.
      expect((await databaseRefusal(change('active = true'))).sqlstate).toBe('23514');
      const insert = (parent: string, active: boolean) =>
        owner(
          `insert into machvon.acceptance_line (tenant_id, id, acceptance_id, measurement_id, boq_item_id, contract_revision_id, quantity, unit_price_snapshot, amount_vnd, active, created_by, updated_by)
           values ($1, gen_random_uuid(), $2, gen_random_uuid(), $3, $4, 1, 1, 1, $5, $6, $6)`,
          [TENANT_A, parent, seeded.items[0], seeded.revisionId, active, memberId(CREATOR)],
        );
      expect((await databaseRefusal(insert(made.id, true))).sqlstate).toBe('23514');
      const sentOne = await submit(made);
      expect((await databaseRefusal(insert(made.id, false))).sqlstate).toBe('23514');
      const bump = (set: string) => owner(`update machvon.acceptance set ${set} where id = $1::uuid`, [made.id]);
      expect((await databaseRefusal(bump("status = 'REVOKED'"))).sqlstate).toBe('23514');
      expect((await databaseRefusal(bump('document_version_id = gen_random_uuid()'))).sqlstate).toBe('23514');
      expect((await databaseRefusal(bump('accepted_amount_vnd = 1'))).sqlstate).toBe('23514');
      expect((await databaseRefusal(bump("measurement_ids = '[]'::jsonb"))).sqlstate).toBe('23514');
      expect((await databaseRefusal(bump("status = 'APPROVED', approved_at = now(), decided_by = submitted_by, decision_reason = 'ok'"))).sqlstate).toBe('23514');
      expect((await databaseRefusal(as((tx) => tx.query('delete from machvon.acceptance where id = $1::uuid', [made.id])))).sqlstate).toBe('42501');
      expect((await databaseRefusal(as((tx) => tx.query('delete from machvon.acceptance_line where id = $1::uuid', [line])))).sqlstate).toBe('42501');
      const approved = await decide(sentOne, 'approve');
      expect((await databaseRefusal(bump("decision_reason = 'changed'"))).sqlstate).toBe('23514');
      expect((await databaseRefusal(bump("status = 'SUBMITTED'"))).sqlstate).toBe('23514');
      expect((await databaseRefusal(change('active = false'))).sqlstate).toBe('23514');
      await revoke(approved);
      expect((await databaseRefusal(bump("status = 'APPROVED'"))).sqlstate).toBe('23514');
    });

    it('refuses an acceptance whose lines are not worth what it says when it is sent', async () => {
      const seeded = await seedContract();
      const made = await create(seeded, [await measured(seeded, 1, '10')]);
      await owner('alter table machvon.acceptance disable trigger acceptance_guard');
      try {
        await owner('update machvon.acceptance set accepted_amount_vnd = accepted_amount_vnd + 1 where id = $1::uuid', [made.id]);
      } finally {
        await owner('alter table machvon.acceptance enable trigger acceptance_guard');
      }
      expect((await databaseRefusal(owner("update machvon.acceptance set status = 'SUBMITTED', submitted_by = $2::uuid, submitted_at = now() where id = $1::uuid", [made.id, memberId(SENDER)]))).sqlstate).toBe('23514');
    });
  });

  describe('reading the acceptances', () => {
    it('lists the acceptances in the scope with their lines, the minutes of quality, the period and the non-conformances in the way', async () => {
      const seeded = await seedContract({ requiresQuality: true });
      const inspectionId = await inspectionOf(seeded, 1);
      const measurement = await measured(seeded, 1, '10', { inspectionId });
      const minutes = await qualityMinutes(seeded, inspectionId, 'SIGNING');
      const made = await create(seeded, [measurement], { qualityAcceptanceId: minutes });
      await ncr(seeded, { measurementId: measurement });
      const lines = await as((tx) => acceptances.list(tx, everything, { contractId: seeded.contractId }));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        id: made.id,
        acceptanceNo: 'NT-001',
        contract: { id: seeded.contractId, code: seeded.code, status: 'ACTIVE', requiresQualityAcceptance: true, contractValueVnd: '9000000000', acceptedTotalVnd: '0' },
        period: { id: PERIOD },
        documentVersionId: VERSION,
        acceptedOn: TODAY,
        status: 'DRAFT',
        acceptedAmountVnd: '20000000',
        quality: { id: minutes, status: 'SIGNING' },
        openCriticalNcr: 1,
        signerRefs: [],
        submittedBy: null,
        version: 1,
      });
      expect(lines[0]?.lines).toEqual([expect.objectContaining({ measurementId: measurement, businessKey: 'B02', unitCode: 'M3', unitPriceSnapshot: '2000000.000000', amountVnd: '20000000', active: false })]);
      const found = await as((tx) => acceptances.find(tx, made.id, everything));
      expect(found?.id).toBe(made.id);
      expect(await as((tx) => acceptances.find(tx, made.id, nothing))).toBeUndefined();
      expect(await as((tx) => acceptances.find(tx, randomUUID(), everything))).toBeUndefined();
      expect(await as((tx) => acceptances.list(tx, nothing, { contractId: seeded.contractId }))).toEqual([]);
    });

    it('lists the latest first and pages by the creation time and the id', async () => {
      const seeded = await seedContract();
      const made: string[] = [];
      for (let n = 0; n < 3; n += 1) made.push((await create(seeded, [await measured(seeded, 0, '1')])).id);
      const all = await as((tx) => acceptances.list(tx, everything, { contractId: seeded.contractId }));
      expect(all.map((line) => line.id)).toEqual([...made].reverse());
      const page = await as((tx) => acceptances.list(tx, everything, { contractId: seeded.contractId, limit: 2 }));
      expect(page.map((line) => line.id)).toEqual([made[2], made[1]]);
      const last = page[1] as (typeof page)[number];
      const rest = await as((tx) => acceptances.list(tx, everything, { contractId: seeded.contractId, after: { createdAt: last.createdAt, id: last.id } }));
      expect(rest.map((line) => line.id)).toEqual([made[0]]);
      expect((await as((tx) => acceptances.list(tx, everything, { limit: 1 }))).length).toBe(1);
    });
  });
});
