import { randomUUID } from 'node:crypto';
import { AuditWriter } from '../src/audit-writer';
import { CtrChangeChainStore } from '../src/ctr-change-chain-store';
import type { ChangeResult } from '../src/ctr-change-chain-store';
import { CtrChangeDecisionStore } from '../src/ctr-change-decision-store';
import type { DecisionHooks } from '../src/ctr-change-decision-store';
import type { ContractScopes } from '../src/ctr-contract-store';
import { CtrMeasurementStore } from '../src/ctr-measurement-store';
import type { MeasurementResult, RecordInput } from '../src/ctr-measurement-store';
import { CtrRevisionEffective } from '../src/ctr-revision-effective';
import { PmtGateStore } from '../src/pmt-gate-store';
import type { TenantTx } from '../src/tenant-database';
import { TENANT_A, contextFor, id, memberId } from './support/authz-fixtures';
import { everything, seedAs } from './support/bid-proposal-fixtures';
import { CapWorld } from './support/cap-fixtures';

const world = new CapWorld();
const harness = world.harness;
const measurements = new CtrMeasurementStore();
const chain = new CtrChangeChainStore();
const decisions = new CtrChangeDecisionStore();
const gates = new PmtGateStore();
const FAMILY = 0xac;
const RECORDER = 1;
const SUBMITTER = 2;
const APPROVER = 3;
const EVALUATOR = 4;
const JOB = 5;
const CONTRACTOR = id(FAMILY, 10);
const DOCUMENT = id(FAMILY, 30);
const VERSION = id(FAMILY, 31);
const EVIDENCE = id(FAMILY, 32);
const PERMIT_TYPE = id(FAMILY, 60);
const TODAY = '2026-07-20';
const NIGHT = new Date('2026-07-31T17:05:00Z');
const contractScopes: ContractScopes = { update: () => ({ sql: 'true', params: [] }), read: () => ({ sql: 'true', params: [] }) };
const readOnly: ContractScopes = { update: () => ({ sql: 'false', params: [] }), read: () => ({ sql: 'true', params: [] }) };
const invisible: ContractScopes = { update: () => ({ sql: 'false', params: [] }), read: () => ({ sql: 'false', params: [] }) };
const periods: string[] = [];

let PROJECT = '';
let LINE = '';
let counter = 0;

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = RECORDER): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, memberId(member)), work);
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
  /** B01: 8,000 m3 at 1,000,000; B02: 500 m3 at 2,000,000. */
  items: [string, string];
  partyId: string;
}

/** A contract being performed under revision 1, whose BOQ is B01 (8,000 m3, eight billion) and B02 (500 m3, one billion): nine billion. */
async function seedContract(status = 'ACTIVE', category = 'CONSTRUCTION'): Promise<Seeded> {
  counter += 1;
  const contractId = randomUUID();
  const revisionId = randomUUID();
  const packageId = randomUUID();
  const partyId = randomUUID();
  const code = `HD-M-${String(counter).padStart(4, '0')}`;
  const items: [string, string] = [randomUUID(), randomUUID()];
  const line = (n: number, key: string, quantity: string, price: string, amount: string): [string, unknown[]] => [
    `insert into machvon.boq_line (tenant_id, id, contract_revision_id, contract_id, boq_item_id, line_no, business_key, description, unit_code, quantity, unit_price, rounding_rule, amount_vnd, retention_pct, created_by)
     values ($1, gen_random_uuid(), $2, $3, $4, $5, $6, $7, 'M3', $8::numeric, $9::numeric, 'HALF_UP', $10::numeric, 5, $11)`,
    [TENANT_A, revisionId, contractId, items[n - 1], n, key, `Item ${key}`, quantity, price, amount, memberId(RECORDER)],
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
       values ($1, $2, $3, $4, $5, $6, 'UNIT_PRICE', 'VND', 'ACTIVE', 1, 'Contract', $8, false, true, 9000000000, $7, $7, date '2026-01-01', date '2026-01-02')`,
      [TENANT_A, contractId, PROJECT, packageId, CONTRACTOR, code, memberId(RECORDER), category],
    ],
    [
      `insert into machvon.contract_revision (tenant_id, id, contract_id, revision, amount_vnd, document_version_id, valid_from, status, kind, version, created_by, updated_by)
       values ($1, $2, $3, 1, 9000000000, $4, date '2026-01-02', 'DRAFT', 'BASE', 1, $5, $5)`,
      [TENANT_A, revisionId, contractId, VERSION, memberId(RECORDER)],
    ],
    [
      `insert into machvon.boq_item (tenant_id, id, contract_id, business_key, description, unit_code, created_by, updated_by)
       values ($1, $2, $4, 'B01', 'Item B01', 'M3', $5, $5), ($1, $3, $4, 'B02', 'Item B02', 'M3', $5, $5)`,
      [TENANT_A, items[0], items[1], contractId, memberId(RECORDER)],
    ],
    line(1, 'B01', '8000', '1000000', '8000000000'),
    line(2, 'B02', '500', '2000000', '1000000000'),
    [
      `insert into machvon.contract_party (tenant_id, id, contract_id, contractor_id, role, share_pct, work_value_vnd, status, valid_from, created_by, updated_by)
       values ($1, $2, $3, $4, 'SOLE', 100, 9000000000, 'ACTIVE', date '2026-01-02', $5, $5)`,
      [TENANT_A, partyId, contractId, CONTRACTOR, memberId(RECORDER)],
    ],
    [`update machvon.contract_revision set status = 'EFFECTIVE', decided_by = $2, decided_at = now() where id = $1::uuid`, [revisionId, memberId(RECORDER)]],
    [`update machvon.contract set current_revision_id = $2 where id = $1::uuid`, [contractId, revisionId]],
  ]);
  if (status !== 'ACTIVE') await setStatus(contractId, status);
  return { contractId, code, revisionId, items, partyId };
}

/** The contract in another status; a suspended or terminated one says why and on which document, as the lifecycle commands do. */
const setStatus = (contractId: string, status: string) =>
  owner(
    `update machvon.contract set status = $2::text, status_reason = case when $2::text in ('SUSPENDED', 'TERMINATED') then 'Stopped.' end,
            status_decision_document_version_id = case when $2::text in ('SUSPENDED', 'TERMINATED') then $3::uuid end where id = $1::uuid`,
    [contractId, status, VERSION],
  );

async function seedPeriods(count: number): Promise<void> {
  for (let n = 0; n < count; n += 1) {
    const periodId = randomUUID();
    periods.push(periodId);
    const month = String(n + 1).padStart(2, '0');
    await seedAs(harness, [
      [
        `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
         values ($1, $2, $3, 1, $4::date, $5::date, $5::date + interval '3 hours', 'CAL-M', 'MONTH', 2026, 'OPEN', gen_random_uuid(), $6, $6)`,
        [TENANT_A, periodId, `2026-${month}`, `2026-${month}-01`, `2026-${month}-28`, memberId(RECORDER)],
      ],
    ]);
  }
}

const evidence = [{ document_version_id: VERSION }];
const input = (seeded: Seeded, overrides: Partial<RecordInput> = {}): RecordInput => {
  counter += 1;
  return {
    contractRevisionId: seeded.revisionId,
    boqItemId: seeded.items[0],
    periodId: periods[0] as string,
    quantityPeriod: '3500',
    referenceNo: `NK-${String(counter).padStart(5, '0')}`,
    evidenceRefs: evidence,
    ...overrides,
  };
};
const record = (seeded: Seeded, overrides: Partial<RecordInput> = {}, options: { member?: number; scopes?: ContractScopes; today?: string } = {}) =>
  as((tx) => measurements.record(tx, seeded.contractId, input(seeded, overrides), memberId(options.member ?? RECORDER), options.scopes ?? contractScopes, options.today ?? TODAY), options.member ?? RECORDER);
const submit = (measurement: MeasurementResult, options: { version?: number; member?: number; scopes?: ContractScopes } = {}) =>
  as((tx) => measurements.submit(tx, measurement.id, options.version ?? measurement.version, memberId(options.member ?? SUBMITTER), options.scopes ?? contractScopes), options.member ?? SUBMITTER);
const decide = (measurement: MeasurementResult, decision: string, options: { version?: number; member?: number; scopes?: ContractScopes } = {}) =>
  as(
    (tx) => measurements.decide(tx, measurement.id, options.version ?? measurement.version, { decision, reason: 'Checked on site.', evidenceIds: [] }, memberId(options.member ?? APPROVER), options.scopes ?? contractScopes),
    options.member ?? APPROVER,
  );
const correct = (measurement: MeasurementResult, quantity: string, options: { version?: number; member?: number; scopes?: ContractScopes } = {}) =>
  as(
    (tx) => measurements.correct(tx, measurement.id, options.version ?? measurement.version, { quantityPeriod: quantity, correctionReason: 'Re-measured on site.', evidenceRefs: evidence }, memberId(options.member ?? RECORDER), options.scopes ?? contractScopes),
    options.member ?? RECORDER,
  );
/** A measurement recorded, submitted and approved. */
async function approved(seeded: Seeded, overrides: Partial<RecordInput> = {}): Promise<MeasurementResult> {
  const drafted = await record(seeded, overrides);
  const sent = await submit(drafted);
  return decide(sent, 'approve');
}
const rowOf = async (measurementId: string) =>
  (
    await owner<{ status: string; quantity_period: string; quantity_cumulative: string; revision: number; version: string; correction_of_id: string | null; reference_no: string | null; submitted_by: string | null; decided_by: string | null }>(
      'select status, quantity_period::text, quantity_cumulative::text, revision, version::text, correction_of_id, reference_no, submitted_by, decided_by from machvon.measurement where id = $1::uuid',
      [measurementId],
    )
  )[0];

const hooks = (): DecisionHooks => ({ authorise: jest.fn(async () => undefined), available: jest.fn(async () => undefined) }) as DecisionHooks;
/** A change order on the quantities of the BOQ that is approved for `effectiveOn`; the job puts it in force. */
async function changeOrder(seeded: Seeded, delta: string, boqLines: unknown): Promise<string> {
  const event = await as((tx) =>
    chain.create(tx, seeded.contractId, { stage: 'EVENT', baselineRevisionId: seeded.revisionId, reason: 'The owner instructed a change.', estimatedDeltaVnd: delta, scheduleImpactDays: 5 }, memberId(RECORDER), contractScopes),
  );
  const pco = await as((tx) => chain.promote(tx, event.id, 1, 'It is a change.', memberId(RECORDER), contractScopes));
  const co: ChangeResult = await as((tx) => chain.promote(tx, pco.id, 1, 'Priced.', memberId(RECORDER), contractScopes));
  const evaluated = await as(
    (tx) =>
      chain.evaluate(tx, co.id, 1, { evaluatedDeltaVnd: delta, scheduleImpactDays: 5, fundingImpactNote: 'Paid from the plan.', ...(BigInt(delta) > 0n ? { allocationLineId: LINE } : {}) }, memberId(EVALUATOR), contractScopes, { available: async () => undefined }),
    EVALUATOR,
  );
  const done = await as(
    (tx) => decisions.decide(tx, evaluated.id, evaluated.version, { decision: 'approve', reason: 'Within the plan.', evidenceIds: [], effectiveOn: '2026-08-01', decisionDocumentVersionId: VERSION, boqLines }, memberId(APPROVER), contractScopes, TODAY, hooks()),
    APPROVER,
  );
  return done.revision?.id as string;
}
const putInForce = () => as((tx) => new CtrRevisionEffective(new AuditWriter(harness.tenants)).run(tx, memberId(JOB), NIGHT), JOB);
const raisedBoq = (quantity: string) => [
  { business_key: 'B01', description: 'Item B01', unit_code: 'M3', quantity, unit_price: '1000000' },
  { business_key: 'B02', description: 'Item B02', unit_code: 'M3', quantity: '500', unit_price: '2000000' },
];

describe('the measurements of work under a contract (ST-CTR-008)', () => {
  beforeAll(async () => {
    await world.start();
    for (const n of [EVALUATOR, JOB]) await harness.seedMembership(TENANT_A, n, 1);
    const published = await world.publishedLine();
    PROJECT = published.projectId;
    LINE = published.lineId;
    await seedAs(harness, [
      [
        `insert into machvon.contractor (tenant_id, id, tax_identifier, legal_name, verification_status, profile_document_id)
         values ($1, $2, '0100000002', 'Lead Builders', 'VERIFIED', $3)`,
        [TENANT_A, CONTRACTOR, DOCUMENT],
      ],
      [`insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'QD', 'Record', 'INTERNAL', $3, $3), ($1, $4, 'REFERENCE', 'EVIDENCE', 'Evidence', 'INTERNAL', $3, $3)`, [TENANT_A, DOCUMENT, memberId(RECORDER), EVIDENCE]],
      [
        `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
         values ($1, $2, $3, 1, 'tenants/ctr/record.pdf', repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL')`,
        [TENANT_A, VERSION, DOCUMENT],
      ],
      [
        `insert into machvon.permit_type (tenant_id, id, code, name, category, authority_text, legal_basis, effective_from, applies_to_rule, status, created_by, updated_by)
         values ($1, $2, 'GPXD', 'Building permit', 'OTHER', 'The authority', 'Fixture decree', '2025-01-01', '{}'::jsonb, 'PUBLISHED', $3, $3)`,
        [TENANT_A, PERMIT_TYPE, memberId(RECORDER)],
      ],
    ]);
    await seedPeriods(5);
    await as((tx) => chain.setTiers(tx, PROJECT, 3, memberId(RECORDER), everything));
  }, 240_000);

  afterAll(async () => {
    await world.stop();
  }, 60_000);

  beforeEach(async () => {
    await owner('delete from machvon.permit_gate_rule');
  });

  describe('recording', () => {
    it('AC-ST-CTR-008-1, UAT-AC311: records the quantity of an item in a period as a draft, and the cumulative counts what was approved', async () => {
      const seeded = await seedContract();
      const first = await record(seeded, { quantityPeriod: '3500', referenceNo: ' NK-0001 ', partyId: seeded.partyId, evidenceRefs: [{ document_version_id: VERSION.toUpperCase() }] });
      expect(first).toMatchObject({
        contractId: seeded.contractId,
        businessKey: 'B01',
        quantityPeriod: '3500.000000',
        quantityCumulative: '3500.000000',
        revision: 1,
        status: 'DRAFT',
        fromStatus: null,
        version: 1,
        referenceNo: 'NK-0001',
        correctionOfId: null,
        remainingQuantity: '4500.000000',
        evidenceIds: [VERSION],
      });
      expect(await rowOf(first.id)).toMatchObject({ status: 'DRAFT', quantity_period: '3500.000000', submitted_by: null, decided_by: null });

      // A draft does not move the cumulative of the next period: only what was approved does.
      const second = await record(seeded, { periodId: periods[1] as string, quantityPeriod: '1000.5' });
      expect(second).toMatchObject({ quantityCumulative: '1000.500000', remainingQuantity: '3499.500000' });

      const sent = await submit(first);
      expect(sent).toMatchObject({ status: 'SUBMITTED', fromStatus: 'DRAFT', version: 2 });
      expect(await decide(sent, 'approve')).toMatchObject({ status: 'APPROVED', fromStatus: 'SUBMITTED', quantityCumulative: '3500.000000', version: 3 });

      const third = await record(seeded, { periodId: periods[2] as string, quantityPeriod: '1000' });
      expect(third.quantityCumulative).toBe('4500.000000');
      expect(await approved(seeded, { periodId: periods[3] as string, quantityPeriod: '500', boqItemId: seeded.items[1] })).toMatchObject({ businessKey: 'B02', quantityCumulative: '500.000000', remainingQuantity: '0.000000' });
    });

    it('AC-ST-CTR-008-1, UAT-AC311: refuses a negative period with CUMULATIVE_DECREASE_WITHOUT_CORRECTION and a zero or malformed one as invalid', async () => {
      const seeded = await seedContract();
      expect(await refusal(record(seeded, { quantityPeriod: '-500' }))).toMatchObject({ code: 'CUMULATIVE_DECREASE_WITHOUT_CORRECTION', status: 422, detail: 'quantity_period' });
      expect(await refusal(record(seeded, { quantityPeriod: '0' }))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'quantity_period' });
      expect(await refusal(record(seeded, { quantityPeriod: '1.0000001' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'quantity_period' });
      expect(await refusal(record(seeded, { referenceNo: '  ' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'reference_no' });
      expect(await refusal(record(seeded, { evidenceRefs: 'x' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'evidence_refs' });
      expect(await refusal(record(seeded, { evidenceRefs: [{ document_version_id: 'nope' }] }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'evidence_refs' });
      expect(await refusal(record(seeded, { evidenceRefs: [{ document_version_id: randomUUID() }] }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'evidence_refs' });
      expect(await refusal(record(seeded, { periodId: 'x' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'period_id' });
      expect(await refusal(record(seeded, { periodId: randomUUID() }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'period_id' });
      expect(await refusal(record(seeded, { boqItemId: randomUUID() }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'boq_item_id' });
      expect(await refusal(record(seeded, { partyId: randomUUID() }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'party_id' });
      expect(await refusal(record(seeded, { inspectionId: randomUUID() }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'inspection_id' });
      expect(await refusal(record(seeded, { contractRevisionId: randomUUID() }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'contract_revision_id' });
      expect(await owner('select id from machvon.measurement where contract_id = $1::uuid', [seeded.contractId])).toEqual([]);
    });

    it('AC-ST-CTR-008-2, UAT-AC312: lets the total reach the quantity of the item exactly and refuses one millionth more, and the change order that raises the quantity lets it through', async () => {
      const seeded = await seedContract();
      await approved(seeded, { periodId: periods[0] as string, quantityPeriod: '7999' });
      const exact = await approved(seeded, { periodId: periods[1] as string, quantityPeriod: '1' });
      expect(exact).toMatchObject({ quantityCumulative: '8000.000000', remainingQuantity: '0.000000' });

      const over = await refusal(record(seeded, { periodId: periods[2] as string, quantityPeriod: '0.000001' }));
      expect(over).toMatchObject({ code: 'QUANTITY_EXCEEDS_BOQ', status: 422, detail: 'quantity_period', extensions: { remaining_quantity: '0.000000', boq_quantity: '8000.000000', total_quantity: '8000.000001' } });
      expect(await refusal(record(seeded, { periodId: periods[2] as string, quantityPeriod: '2' }))).toMatchObject({ extensions: { remaining_quantity: '0.000000', total_quantity: '8002.000000' } });

      // A change order raises B01 to 8,100 m3; until its day the revision in force is revision 1, and the pending one takes no measurement.
      const pendingId = await changeOrder(seeded, '100000000', raisedBoq('8100'));
      expect(await refusal(record(seeded, { contractRevisionId: pendingId, periodId: periods[2] as string, quantityPeriod: '100' }))).toMatchObject({ code: 'REVISION_NOT_EFFECTIVE', status: 422 });
      await putInForce();
      expect(await refusal(record(seeded, { periodId: periods[2] as string, quantityPeriod: '100' }))).toMatchObject({ code: 'REVISION_NOT_EFFECTIVE', status: 422, extensions: { revision_status: 'SUPERSEDED' } });
      const raised = await record(seeded, { contractRevisionId: pendingId, periodId: periods[2] as string, quantityPeriod: '2' });
      expect(raised).toMatchObject({ quantityPeriod: '2.000000', quantityCumulative: '8002.000000', remainingQuantity: '98.000000', status: 'DRAFT' });
      expect(await refusal(record(seeded, { contractRevisionId: pendingId, periodId: periods[3] as string, quantityPeriod: '98.000001' }))).toMatchObject({ code: 'QUANTITY_EXCEEDS_BOQ', extensions: { boq_quantity: '8100.000000', remaining_quantity: '98.000000' } });
    }, 60_000);

    it('counts a draft and a submitted measurement against the quantity of the item, and gives the quantity back when it is rejected', async () => {
      const seeded = await seedContract();
      const draft = await record(seeded, { periodId: periods[0] as string, quantityPeriod: '8000' });
      expect(await refusal(record(seeded, { periodId: periods[1] as string, quantityPeriod: '1' }))).toMatchObject({ code: 'QUANTITY_EXCEEDS_BOQ', extensions: { remaining_quantity: '0.000000' } });
      const sent = await submit(draft);
      expect(await refusal(record(seeded, { periodId: periods[1] as string, quantityPeriod: '1' }))).toMatchObject({ code: 'QUANTITY_EXCEEDS_BOQ' });
      expect(await decide(sent, 'reject')).toMatchObject({ status: 'REJECTED', remainingQuantity: '8000.000000' });
      expect(await record(seeded, { periodId: periods[1] as string, quantityPeriod: '1' })).toMatchObject({ status: 'DRAFT', remainingQuantity: '7999.000000' });
    });

    it('records one measurement of an item in a period at a time, and the next one when the first was rejected', async () => {
      const seeded = await seedContract();
      const first = await record(seeded, { quantityPeriod: '10' });
      expect(await refusal(record(seeded, { quantityPeriod: '5' }))).toMatchObject({ code: 'MEASUREMENT_STATE_INVALID', status: 409, extensions: { reason: 'PERIOD_ALREADY_MEASURED', measurement_id: first.id } });
      // Another item or another period is free.
      expect(await record(seeded, { quantityPeriod: '5', boqItemId: seeded.items[1] })).toMatchObject({ status: 'DRAFT' });
      expect(await record(seeded, { quantityPeriod: '5', periodId: periods[1] as string })).toMatchObject({ status: 'DRAFT' });
      await decide(await submit(first), 'reject');
      expect(await record(seeded, { quantityPeriod: '5' })).toMatchObject({ revision: 2, status: 'DRAFT' });
    });

    it('refuses the number of a record that is used in the contract unless the person says why not, and lets a rejected or corrected one release it', async () => {
      const seeded = await seedContract();
      const first = await record(seeded, { referenceNo: 'NK-DUP', periodId: periods[0] as string, quantityPeriod: '10' });
      expect(await refusal(record(seeded, { referenceNo: 'NK-DUP', periodId: periods[1] as string, quantityPeriod: '10' }))).toMatchObject({ code: 'MEASUREMENT_REFERENCE_DUPLICATE', status: 409, detail: 'reference_no', extensions: { measurement_id: first.id } });
      const overridden = await record(seeded, { referenceNo: 'NK-DUP', periodId: periods[1] as string, quantityPeriod: '10', duplicateOverrideReason: 'The same form covers two periods.' });
      expect(overridden).toMatchObject({ referenceNo: 'NK-DUP', status: 'DRAFT' });
      // The number is the same in another contract.
      const other = await seedContract();
      expect(await record(other, { referenceNo: 'NK-DUP' })).toMatchObject({ status: 'DRAFT' });
      // The database keeps the rule when the store is bypassed.
      const direct = await databaseRefusal(
        owner(
          `insert into machvon.measurement (tenant_id, id, contract_id, contract_revision_id, boq_line_id, boq_item_id, period_id, quantity_period, quantity_cumulative, revision, status, evidence_refs, reference_no, created_by, updated_by)
           select tenant_id, gen_random_uuid(), contract_id, contract_revision_id, boq_line_id, boq_item_id, period_id, 1, 1, 9, 'DRAFT', '[]'::jsonb, reference_no, created_by, created_by from machvon.measurement where id = $1::uuid`,
          [first.id],
        ),
      );
      expect(direct.sqlstate).toBe('23505');
      await decide(await submit(first), 'reject');
      expect(await record(seeded, { referenceNo: 'NK-DUP', periodId: periods[2] as string, quantityPeriod: '10' })).toMatchObject({ status: 'DRAFT' });
    });

    it('answers for the contract: 404 outside the scope, 403 where it is only read, 409 unless it is being performed', async () => {
      const seeded = await seedContract();
      expect(await refusal(record(seeded, {}, { scopes: invisible }))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(record(seeded, {}, { scopes: readOnly }))).toMatchObject({ status: 403 });
      expect(await refusal(as((tx) => measurements.record(tx, randomUUID(), input(seeded), memberId(RECORDER), contractScopes, TODAY)))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      for (const status of ['SUSPENDED', 'TERMINATED', 'COMPLETED']) {
        const other = await seedContract(status);
        expect(await refusal(record(other))).toMatchObject({ code: 'CONTRACT_STATE_INVALID', status: 409, extensions: { contract_status: status } });
      }
      // The revision of another contract is not this contract's.
      const other = await seedContract();
      expect(await refusal(record(seeded, { contractRevisionId: other.revisionId }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'contract_revision_id' });
      expect(await refusal(record(seeded, { boqItemId: other.items[0] }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'boq_item_id' });
    });

    it('AC-ST-CTR-008-3, UAT-AC369: refuses a construction contract while the permits of the start of construction are missing, and records once they are', async () => {
      const seeded = await seedContract('ACTIVE', 'CONSTRUCTION');
      await as((tx) => gates.publish(tx, { gateCode: 'START_CONSTRUCTION', permitTypeId: PERMIT_TYPE, requirement: 'VALID_PERMIT', appliesToRule: {}, legalBasis: 'Fixture decree', effectiveFrom: '2025-01-01' }, memberId(RECORDER)));
      const blocked = await refusal(record(seeded));
      expect(blocked).toMatchObject({ code: 'PERMIT_GATE_BLOCKED', status: 422, extensions: { gate_code: 'START_CONSTRUCTION', blocking: [expect.objectContaining({ permit_type_code: 'GPXD' })] } });
      expect(await owner('select id from machvon.measurement where contract_id = $1::uuid', [seeded.contractId])).toEqual([]);
      // A contract that does not build is not held by the gate.
      const consulting = await seedContract('ACTIVE', 'CONSULTING');
      expect(await record(consulting)).toMatchObject({ status: 'DRAFT' });
      await owner('delete from machvon.permit_gate_rule');
      expect(await record(seeded)).toMatchObject({ status: 'DRAFT' });
    });

    it('records at the same moment only what fits: of two periods that each need the last of the quantity, one is recorded and the other refused', async () => {
      const seeded = await seedContract();
      await approved(seeded, { periodId: periods[0] as string, quantityPeriod: '7999' });
      const results = await Promise.allSettled([
        record(seeded, { periodId: periods[1] as string, quantityPeriod: '1' }, { member: RECORDER }),
        record(seeded, { periodId: periods[2] as string, quantityPeriod: '1' }, { member: SUBMITTER }),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      expect(failed?.reason).toMatchObject({ code: 'QUANTITY_EXCEEDS_BOQ' });
      const [total] = await owner<{ total: string }>("select sum(quantity_period)::text as total from machvon.measurement where contract_id = $1::uuid and status <> 'REJECTED'", [seeded.contractId]);
      expect(total?.total).toBe('8000.000000');
    });
  });

  describe('submitting and deciding', () => {
    it('submits a draft with its evidence, and refuses one without evidence, a stale version, a suspended contract and a measurement that is not a draft', async () => {
      const seeded = await seedContract();
      const bare = await record(seeded, { evidenceRefs: [] });
      expect(bare.evidenceIds).toEqual([]);
      expect(await refusal(submit(bare))).toMatchObject({ code: 'EVIDENCE_REQUIRED', status: 422, detail: 'evidence_refs' });
      expect(await rowOf(bare.id)).toMatchObject({ status: 'DRAFT', version: '1' });

      const draft = await record(seeded, { periodId: periods[1] as string });
      expect(await refusal(submit(draft, { version: 7 }))).toMatchObject({ status: 409 });
      expect(await refusal(submit(draft, { scopes: invisible }))).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
      expect(await refusal(submit({ ...draft, id: randomUUID() }))).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
      await setStatus(seeded.contractId, 'SUSPENDED');
      expect(await refusal(submit(draft))).toMatchObject({ code: 'CONTRACT_STATE_INVALID', status: 409 });
      await setStatus(seeded.contractId, 'ACTIVE');
      const sent = await submit(draft);
      expect(await rowOf(sent.id)).toMatchObject({ status: 'SUBMITTED', submitted_by: memberId(SUBMITTER) });
      expect(await refusal(submit(sent))).toMatchObject({ code: 'MEASUREMENT_STATE_INVALID', status: 409, extensions: { measurement_status: 'SUBMITTED' } });
    });

    it('is decided by someone other than whoever recorded or submitted it, and a decision on a draft is refused', async () => {
      const seeded = await seedContract();
      const draft = await record(seeded);
      expect(await refusal(decide(draft, 'approve'))).toMatchObject({ code: 'MEASUREMENT_STATE_INVALID', status: 409 });
      const sent = await submit(draft);
      expect(await refusal(decide(sent, 'approve', { member: RECORDER }))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await refusal(decide(sent, 'approve', { member: SUBMITTER }))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await refusal(decide(sent, 'maybe'))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'decision' });
      expect(await refusal(decide(sent, 'approve', { version: 9 }))).toMatchObject({ status: 409 });
      expect(await refusal(as((tx) => measurements.decide(tx, sent.id, sent.version, { decision: 'approve', reason: 'ok', evidenceIds: [randomUUID()] }, memberId(APPROVER), contractScopes), APPROVER))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'evidence_ids' });
      expect(await rowOf(sent.id)).toMatchObject({ status: 'SUBMITTED' });
      const done = await decide(sent, 'approve');
      expect(done).toMatchObject({ decision: 'approve', reason: 'Checked on site.', status: 'APPROVED' });
      expect(await rowOf(sent.id)).toMatchObject({ status: 'APPROVED', decided_by: memberId(APPROVER) });
    });

    it('gives a returned measurement back to its maker as a draft, which can be sent again', async () => {
      const seeded = await seedContract();
      const sent = await submit(await record(seeded));
      const returned = await decide(sent, 'return');
      expect(returned).toMatchObject({ status: 'DRAFT', fromStatus: 'SUBMITTED', decision: 'return' });
      expect(await submit(returned)).toMatchObject({ status: 'SUBMITTED' });
    });

    it('judges the quantity once more when it is approved: a change order that lowered the quantity under what is waiting refuses the approval', async () => {
      const seeded = await seedContract();
      const sent = await submit(await record(seeded, { quantityPeriod: '5000' }));
      await changeOrder(seeded, '-4000000000', raisedBoq('4000'));
      await putInForce();
      expect(await refusal(decide(sent, 'approve'))).toMatchObject({ code: 'QUANTITY_EXCEEDS_BOQ', status: 422, extensions: { boq_quantity: '4000.000000', total_quantity: '5000.000000' } });
      expect(await rowOf(sent.id)).toMatchObject({ status: 'SUBMITTED' });
      // It can still be given back, and rejected.
      expect(await decide(sent, 'return')).toMatchObject({ status: 'DRAFT' });
    });
  });

  describe('correcting', () => {
    it('AC-ST-CTR-008-1, UAT-AC311: corrects an approved measurement: it is superseded, the next revision is a draft with the new quantity, and the cumulative is counted without the old one', async () => {
      const seeded = await seedContract();
      const first = await approved(seeded, { periodId: periods[0] as string, quantityPeriod: '3500', referenceNo: 'NK-C1' });
      const second = await approved(seeded, { periodId: periods[1] as string, quantityPeriod: '1000' });
      expect(second.quantityCumulative).toBe('4500.000000');

      const fixed = await correct(first, '3000');
      expect(fixed).toMatchObject({ status: 'DRAFT', revision: 2, quantityPeriod: '3000.000000', quantityCumulative: '4000.000000', correctionOfId: first.id, referenceNo: 'NK-C1', remainingQuantity: '4000.000000', fromStatus: 'APPROVED', version: 1 });
      expect(await rowOf(first.id)).toMatchObject({ status: 'SUPERSEDED', version: '4' });
      expect(await rowOf(fixed.id)).toMatchObject({ status: 'DRAFT', correction_of_id: first.id, revision: 2 });
      const [reason] = await owner<{ correction_reason: string }>('select correction_reason from machvon.measurement where id = $1::uuid', [fixed.id]);
      expect(reason?.correction_reason).toBe('Re-measured on site.');

      // The correction is judged like a new measurement: it is decided by someone else and approved.
      const approvedAgain = await decide(await submit(fixed), 'approve');
      expect(approvedAgain).toMatchObject({ status: 'APPROVED', quantityCumulative: '4000.000000', revision: 2 });
      // A correction can go on: it is again the approved one that is corrected, with the next revision number.
      expect(await correct(approvedAgain, '0')).toMatchObject({ revision: 3, quantityPeriod: '0.000000', quantityCumulative: '1000.000000' });
    });

    it('refuses to correct what is not approved, a negative quantity, a quantity above the item, and a measurement in an active acceptance', async () => {
      const seeded = await seedContract();
      const draft = await record(seeded, { periodId: periods[0] as string, quantityPeriod: '100' });
      expect(await refusal(correct(draft, '50'))).toMatchObject({ code: 'MEASUREMENT_STATE_INVALID', status: 409, extensions: { measurement_status: 'DRAFT' } });
      const done = await decide(await submit(draft), 'approve');
      expect(await refusal(correct(done, '-1'))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'quantity_period' });
      expect(await refusal(correct(done, '8000.000001'))).toMatchObject({ code: 'QUANTITY_EXCEEDS_BOQ', status: 422 });
      // The refusal rolled the supersession back with it.
      expect(await rowOf(done.id)).toMatchObject({ status: 'APPROVED' });
      expect(await refusal(correct(done, '50', { scopes: readOnly }))).toMatchObject({ status: 403 });
      expect(await refusal(as((tx) => measurements.correct(tx, done.id, done.version, { quantityPeriod: '50', correctionReason: 'Re-measured.', evidenceRefs: [{ document_version_id: randomUUID() }] }, memberId(RECORDER), contractScopes)))).toMatchObject({ detail: 'evidence_refs' });

      const acceptanceId = randomUUID();
      await seedAs(harness, [
        [
          `insert into machvon.acceptance (tenant_id, id, contract_id, measurement_ids, document_version_id, signer_refs, status, version, acceptance_no, accepted_amount_vnd, created_by, updated_by)
           values ($1, $2, $3, jsonb_build_array($6::text), $4, '[]'::jsonb, 'DRAFT', 1, 'NT-1', 100000000, $5, $5)`,
          [TENANT_A, acceptanceId, seeded.contractId, VERSION, memberId(RECORDER), done.id],
        ],
        [
          `insert into machvon.acceptance_line (tenant_id, id, acceptance_id, measurement_id, boq_item_id, contract_revision_id, quantity, unit_price_snapshot, amount_vnd, created_by, updated_by)
           values ($1, gen_random_uuid(), $2, $3, $4, $5, 100, 1000000, 100000000, $6, $6)`,
          [TENANT_A, acceptanceId, done.id, seeded.items[0], seeded.revisionId, memberId(RECORDER)],
        ],
      ]);
      expect(await refusal(correct(done, '50'))).toMatchObject({ code: 'MEASUREMENT_IN_ACTIVE_ACCEPTANCE', status: 409, extensions: expect.objectContaining({ acceptance_line_id: expect.any(String) }) });
      expect(await rowOf(done.id)).toMatchObject({ status: 'APPROVED' });
      // When the acceptance no longer holds the line, the correction goes on.
      await seedAs(harness, [['update machvon.acceptance_line set active = false where measurement_id = $1::uuid', [done.id]]]);
      expect(await correct(done, '50')).toMatchObject({ status: 'DRAFT', quantityPeriod: '50.000000' });
    });

    it('corrects while the work is suspended and refuses once the contract is over', async () => {
      const seeded = await seedContract();
      const done = await approved(seeded);
      await setStatus(seeded.contractId, 'SUSPENDED');
      expect(await correct(done, '3000')).toMatchObject({ status: 'DRAFT', revision: 2 });
      const other = await seedContract();
      const finished = await approved(other);
      await setStatus(other.contractId, 'COMPLETED');
      expect(await refusal(correct(finished, '3000'))).toMatchObject({ code: 'CONTRACT_STATE_INVALID', status: 409 });
    });
  });

  describe('the guards of the database', () => {
    it('keeps a measurement in its place, along its edges, and what was approved as it is', async () => {
      const seeded = await seedContract();
      const draft = await record(seeded);
      const sent = await submit(draft);
      const done = await decide(sent, 'approve');
      const update = (sql: string, params: unknown[] = []) => databaseRefusal(as((tx) => tx.query(sql, params)));
      expect((await update("update machvon.measurement set period_id = $2::uuid where id = $1::uuid", [done.id, periods[4]])).sqlstate).toBe('23514');
      expect((await update("update machvon.measurement set quantity_period = 1 where id = $1::uuid", [done.id])).message).toMatch(/corrected, not edited/);
      expect((await update("update machvon.measurement set status = 'DRAFT' where id = $1::uuid", [done.id])).message).toMatch(/MEASUREMENT_STATE_INVALID/);
      expect((await update("update machvon.measurement set status = 'SUBMITTED' where id = $1::uuid", [done.id])).sqlstate).toBe('23514');

      const other = await seedContract();
      const waiting = await submit(await record(other));
      expect((await update("update machvon.measurement set quantity_period = 1 where id = $1::uuid", [waiting.id])).message).toMatch(/keeps what was sent/);
      expect((await update("update machvon.measurement set status = 'SUPERSEDED' where id = $1::uuid", [waiting.id])).sqlstate).toBe('23514');
      const rejected = await decide(waiting, 'reject');
      expect((await update("update machvon.measurement set status = 'DRAFT' where id = $1::uuid", [rejected.id])).message).toMatch(/is kept as it is/);
    });

    it('does not delete a measurement, takes no evidence of a draft away from a submitted one, and says who submitted what left the draft', async () => {
      const seeded = await seedContract();
      const draft = await record(seeded);
      expect((await databaseRefusal(as((tx) => tx.query('delete from machvon.measurement where id = $1::uuid', [draft.id])))).sqlstate).toBe('42501');
      const bare = await record(seeded, { periodId: periods[1] as string, evidenceRefs: [] });
      expect((await databaseRefusal(owner("update machvon.measurement set status = 'SUBMITTED', submitted_by = $2::uuid, submitted_at = now() where id = $1::uuid", [bare.id, memberId(SUBMITTER)]))).message).toMatch(/measurement_evidence_chk/);
    });
  });

  describe('the register', () => {
    const all = () => ({ sql: 'true', params: [] as unknown[] });
    const nothing = () => ({ sql: 'false', params: [] as unknown[] });
    const mine = memberId(RECORDER);

    it('lists the measurements of the contracts in the scope with their item, period and revision, and finds one', async () => {
      const seeded = await seedContract();
      const first = await record(seeded, { periodId: periods[0] as string, quantityPeriod: '10', partyId: seeded.partyId });
      const second = await record(seeded, { periodId: periods[1] as string, quantityPeriod: '20', boqItemId: seeded.items[1] });
      const other = await seedContract();
      await record(other, { periodId: periods[0] as string });

      const lines = await as((tx) => measurements.list(tx, all, mine, { contractId: seeded.contractId }));
      expect(lines.map((line) => line.id)).toEqual([first.id, second.id]);
      expect(lines[0]).toMatchObject({
        contract: { id: seeded.contractId, code: seeded.code, status: 'ACTIVE' },
        contractRevisionId: seeded.revisionId,
        contractRevisionNo: 1,
        boqItem: { businessKey: 'B01', description: 'Item B01', unitCode: 'M3' },
        boqQuantity: '8000.000000',
        remainingQuantity: '7990.000000',
        partyId: seeded.partyId,
        period: { id: periods[0], code: '2026-01' },
        quantityPeriod: '10.000000',
        quantityCumulative: '10.000000',
        revision: 1,
        status: 'DRAFT',
        createdBy: mine,
        submittedBy: null,
        version: 1,
        evidenceRefs: evidence,
      });
      expect(lines[0]?.reach).toMatchObject({ contractId: seeded.contractId, projectId: PROJECT });
      expect((await as((tx) => measurements.list(tx, all, mine, {}))).length).toBeGreaterThanOrEqual(3);
      expect(await as((tx) => measurements.list(tx, all, mine, { contractId: seeded.contractId, limit: 1 }))).toHaveLength(1);
      const next = await as((tx) => measurements.list(tx, all, mine, { contractId: seeded.contractId, after: { createdAt: lines[0]?.createdAt as string, id: first.id } }));
      expect(next.map((line) => line.id)).toEqual([second.id]);
      expect(await as((tx) => measurements.list(tx, nothing, mine, {}))).toEqual([]);
      expect((await as((tx) => measurements.find(tx, second.id, all, mine)))?.boqItem.businessKey).toBe('B02');
      expect(await as((tx) => measurements.find(tx, second.id, nothing, mine))).toBeUndefined();
      expect(await as((tx) => measurements.find(tx, randomUUID(), all, mine))).toBeUndefined();
    });

    it('keeps a draft to whoever recorded it until it is sent', async () => {
      const seeded = await seedContract();
      const draft = await record(seeded, { periodId: periods[0] as string });
      const sent = await submit(await record(seeded, { periodId: periods[1] as string }));
      const others = memberId(SUBMITTER);
      expect((await as((tx) => measurements.list(tx, all, mine, { contractId: seeded.contractId }))).map((line) => line.id)).toEqual([draft.id, sent.id]);
      expect((await as((tx) => measurements.list(tx, all, others, { contractId: seeded.contractId }))).map((line) => line.id)).toEqual([sent.id]);
      expect(await as((tx) => measurements.find(tx, draft.id, all, others))).toBeUndefined();
      expect((await as((tx) => measurements.find(tx, draft.id, all, mine)))?.status).toBe('DRAFT');
      expect((await as((tx) => measurements.find(tx, sent.id, all, others)))?.status).toBe('SUBMITTED');
    });
  });
});
