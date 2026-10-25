import { randomUUID } from 'node:crypto';
import { AuditWriter } from '../src/audit-writer';
import { plainDecimal } from '../src/ctr-boq-lines';
import { CtrBoqStore } from '../src/ctr-boq-store';
import { CtrContractStore } from '../src/ctr-contract-store';
import { CtrChangeChainStore } from '../src/ctr-change-chain-store';
import type { ChangeResult } from '../src/ctr-change-chain-store';
import { CtrChangeDecisionStore } from '../src/ctr-change-decision-store';
import type { DecideInput, DecisionHooks } from '../src/ctr-change-decision-store';
import type { ContractScopes } from '../src/ctr-contract-store';
import { CtrRevisionEffective } from '../src/ctr-revision-effective';
import { CtrRevisionStore } from '../src/ctr-revision-store';
import type { TenantTx } from '../src/tenant-database';
import { TENANT_A, contextFor, id, memberId } from './support/authz-fixtures';
import { everything, seedAs } from './support/bid-proposal-fixtures';
import { CapWorld } from './support/cap-fixtures';

const world = new CapWorld();
const harness = world.harness;
const chain = new CtrChangeChainStore();
const decisions = new CtrChangeDecisionStore();
const revisions = new CtrRevisionStore();
const boq = new CtrBoqStore();
const FAMILY = 0xab;
const MAKER = 1;
const EVALUATOR = 2;
const APPROVER = 3;
const DOCUMENT_MAKER = 4;
const JOB = 5;
const CONTRACTOR = id(FAMILY, 10);
const DOCUMENT = id(FAMILY, 30);
const VERSION = id(FAMILY, 31);
const EVIDENCE = id(FAMILY, 32);
const TODAY = '2026-07-20';
const NIGHT = new Date('2026-07-31T17:05:00Z'); // 00:05 on 2026-08-01 in Vietnam
const contractScopes: ContractScopes = { update: () => ({ sql: 'true', params: [] }), read: () => ({ sql: 'true', params: [] }) };
const nothingUpdate: ContractScopes = { update: () => ({ sql: 'false', params: [] }), read: () => ({ sql: 'true', params: [] }) };
const invisible: ContractScopes = { update: () => ({ sql: 'false', params: [] }), read: () => ({ sql: 'false', params: [] }) };

let PROJECT = '';
let LINE = '';
let counter = 0;

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = MAKER): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, memberId(member)), work);
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
}

/** A contract being performed under revision 1, whose BOQ is B01 (9 billion) and B02 (500 m3 at 2,000,000, one billion): 10 billion. */
async function seedContract(status = 'ACTIVE'): Promise<Seeded> {
  counter += 1;
  const contractId = randomUUID();
  const revisionId = randomUUID();
  const packageId = randomUUID();
  const code = `HD-D-${String(counter).padStart(4, '0')}`;
  const items = [randomUUID(), randomUUID()];
  const line = (n: number, key: string, quantity: string, price: string, amount: string): [string, unknown[]] => [
    `insert into machvon.boq_line (tenant_id, id, contract_revision_id, contract_id, boq_item_id, line_no, business_key, description, unit_code, quantity, unit_price, rounding_rule, amount_vnd, retention_pct, created_by)
     values ($1, gen_random_uuid(), $2, $3, $4, $5, $6, $7, 'M3', $8::numeric, $9::numeric, 'HALF_UP', $10::numeric, 5, $11)`,
    [TENANT_A, revisionId, contractId, items[n - 1], n, key, `Item ${key}`, quantity, price, amount, memberId(MAKER)],
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
       values ($1, $2, $3, $4, $5, $6, 'UNIT_PRICE', 'VND', $7, 1, 'Contract', 'CONSTRUCTION', false, true, 10000000000, $8, $8, date '2026-01-01', date '2026-01-02')`,
      [TENANT_A, contractId, PROJECT, packageId, CONTRACTOR, code, status, memberId(MAKER)],
    ],
    [
      `insert into machvon.contract_revision (tenant_id, id, contract_id, revision, amount_vnd, document_version_id, valid_from, status, kind, version, created_by, updated_by)
       values ($1, $2, $3, 1, 10000000000, $4, date '2026-01-02', 'DRAFT', 'BASE', 1, $5, $5)`,
      [TENANT_A, revisionId, contractId, VERSION, memberId(MAKER)],
    ],
    [
      `insert into machvon.boq_item (tenant_id, id, contract_id, business_key, description, unit_code, created_by, updated_by)
       values ($1, $2, $4, 'B01', 'Item B01', 'M3', $5, $5), ($1, $3, $4, 'B02', 'Item B02', 'M3', $5, $5)`,
      [TENANT_A, items[0], items[1], contractId, memberId(MAKER)],
    ],
    line(1, 'B01', '1', '9000000000', '9000000000'),
    line(2, 'B02', '500', '2000000', '1000000000'),
    [
      `update machvon.contract_revision set status = 'EFFECTIVE', decided_by = $2, decided_at = now() where id = $1::uuid`,
      [revisionId, memberId(MAKER)],
    ],
    [`update machvon.contract set current_revision_id = $2 where id = $1::uuid`, [contractId, revisionId]],
  ]);
  return { contractId, code, revisionId };
}

/** The lines of the BOQ of the contract with new prices: B01 as a lump sum, B02 for 500 m3. */
const boqFor = (lump: string, perM3 = '2000000') => [
  { business_key: 'B01', description: 'Item B01', unit_code: 'M3', quantity: '1', unit_price: lump },
  { business_key: 'B02', description: 'Item B02', unit_code: 'M3', quantity: '500', unit_price: perM3 },
];

const hooks = (overrides: Partial<DecisionHooks> = {}): DecisionHooks & { authorise: jest.Mock; available: jest.Mock } =>
  ({ authorise: jest.fn(async () => undefined), available: jest.fn(async () => undefined), ...overrides }) as DecisionHooks & { authorise: jest.Mock; available: jest.Mock };

/** A CO that was assessed: raised and promoted by the maker, assessed by the evaluator. */
async function evaluatedCo(contract: Seeded, delta: string, baseline = contract.revisionId): Promise<ChangeResult> {
  const event = await as((tx) =>
    chain.create(tx, contract.contractId, { stage: 'EVENT', baselineRevisionId: baseline, reason: 'The owner instructed a change.', estimatedDeltaVnd: delta, scheduleImpactDays: 5 }, memberId(MAKER), contractScopes),
  );
  const pco = await as((tx) => chain.promote(tx, event.id, 1, 'It is a change.', memberId(MAKER), contractScopes));
  const co = await as((tx) => chain.promote(tx, pco.id, 1, 'Priced.', memberId(MAKER), contractScopes));
  const increase = BigInt(delta) > 0n;
  return as(
    (tx) =>
      chain.evaluate(tx, co.id, 1, { evaluatedDeltaVnd: delta, scheduleImpactDays: 5, fundingImpactNote: 'Paid from the plan.', ...(increase ? { allocationLineId: LINE } : {}) }, memberId(EVALUATOR), contractScopes, {
        available: async () => undefined,
      }),
    EVALUATOR,
  );
}

const approval = (overrides: Partial<DecideInput> = {}): DecideInput => ({
  decision: 'approve',
  reason: 'The change is within the plan.',
  evidenceIds: [],
  effectiveOn: '2026-08-01',
  decisionDocumentVersionId: VERSION,
  ...overrides,
});
const decide = (co: ChangeResult, input: DecideInput = approval(), options: { version?: number; member?: number; scopes?: ContractScopes; hooks?: DecisionHooks; today?: string } = {}) =>
  as((tx) => decisions.decide(tx, co.id, options.version ?? co.version, input, memberId(options.member ?? APPROVER), options.scopes ?? contractScopes, options.today ?? TODAY, options.hooks ?? hooks()), options.member ?? APPROVER);
const runJob = (now: Date = NIGHT) => as((tx) => new CtrRevisionEffective(new AuditWriter(harness.tenants)).run(tx, memberId(JOB), now), JOB);
const revisionsOf = (contractId: string) =>
  owner<{ id: string; revision: number; status: string; kind: string; amount_vnd: string; valid_from: string; valid_until: string | null; supersedes_id: string | null; change_request_id: string | null; version: string }>(
    'select id, revision, status, kind, amount_vnd::text, valid_from::text, valid_until::text, supersedes_id, change_request_id, version::text from machvon.contract_revision where contract_id = $1::uuid order by revision',
    [contractId],
  );
const contractRow = async (contractId: string) =>
  (await owner<{ contract_value_vnd: string; current_revision_id: string | null; version: string }>('select contract_value_vnd::text, current_revision_id, version::text from machvon.contract where id = $1::uuid', [contractId]))[0];
const requestRow = async (requestId: string) =>
  (await owner<{ status: string; version: string; approved_delta_vnd: string | null; effective_on: string | null; resulting_revision_id: string | null; decided_by: string | null; status_reason: string | null }>(
    'select status, version::text, approved_delta_vnd::text, effective_on::text, resulting_revision_id, decided_by, status_reason from machvon.change_request where id = $1::uuid',
    [requestId],
  ))[0];
const linesOf = (revisionId: string) =>
  owner<{ business_key: string; quantity: string; unit_price: string; amount_vnd: string }>('select business_key, quantity::text, unit_price::text, amount_vnd::text from machvon.boq_line where contract_revision_id = $1::uuid order by line_no', [revisionId]);

describe('the decision of a change order and the revisions it makes (ST-CTR-007)', () => {
  beforeAll(async () => {
    await world.start();
    for (const n of [DOCUMENT_MAKER, JOB]) await harness.seedMembership(TENANT_A, n, 1);
    const published = await world.publishedLine();
    PROJECT = published.projectId;
    LINE = published.lineId;
    await seedAs(harness, [
      [
        `insert into machvon.contractor (tenant_id, id, tax_identifier, legal_name, verification_status, profile_document_id)
         values ($1, $2, '0100000001', 'Lead Builders', 'VERIFIED', $3)`,
        [TENANT_A, CONTRACTOR, DOCUMENT],
      ],
      [`insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'QD', 'Decision', 'INTERNAL', $3, $3), ($1, $4, 'REFERENCE', 'EVIDENCE', 'Evidence', 'INTERNAL', $3, $3)`, [TENANT_A, DOCUMENT, memberId(DOCUMENT_MAKER), EVIDENCE]],
      [
        `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
         values ($1, $2, $3, 1, 'tenants/ctr/decision.pdf', repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL')`,
        [TENANT_A, VERSION, DOCUMENT],
      ],
    ]);
    await as((tx) => chain.setTiers(tx, PROJECT, 3, memberId(MAKER), everything));
  }, 240_000);

  afterAll(async () => {
    await world.stop();
  }, 60_000);

  // The job works for every contract of the tenant, so each case starts from a tenant with no revision waiting for its day.
  beforeEach(async () => {
    expect(await runJob(new Date('2030-01-01T00:00:00Z'))).toMatchObject({ blocked: 0, overdue: 0 });
  });

  describe('approving', () => {
    it('AC-ST-CTR-007-1, UAT-AC308: the maker is refused, the approver makes revision 2 PENDING_EFFECTIVE, the job puts it in force, and a change below what was accepted is refused', async () => {
      const contract = await seedContract();
      await owner('update machvon.contract set accepted_total_vnd = 3000000000 where id = $1::uuid', [contract.contractId]);
      const co = await evaluatedCo(contract, '500000000');
      expect(co).toMatchObject({ code: 'CO-001', stage: 'CO', status: 'EVALUATED' });

      expect(await refusal(decide(co, approval(), { member: MAKER }))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await refusal(decide(co, approval(), { member: EVALUATOR }))).toMatchObject({ code: 'SELF_APPROVAL_DENIED' });
      expect(await refusal(decide(co, approval(), { member: DOCUMENT_MAKER }))).toMatchObject({ code: 'SELF_APPROVAL_DENIED' });
      expect(await requestRow(co.id)).toMatchObject({ status: 'EVALUATED', resulting_revision_id: null });

      const hook = hooks();
      const done = await decide(co, approval({ reason: ' The change is within the plan. ', evidenceIds: [EVIDENCE.toUpperCase(), EVIDENCE] }), { hooks: hook });
      expect(done).toMatchObject({
        decision: 'approve',
        status: 'APPROVED',
        fromStatus: 'EVALUATED',
        version: 3,
        approvedDeltaVnd: '500000000',
        effectiveOn: '2026-08-01',
        decisionDocumentVersionId: VERSION,
        fromValueVnd: '10000000000',
        toValueVnd: '10500000000',
        reason: 'The change is within the plan.',
        evidenceIds: [EVIDENCE],
        allocationLineId: LINE,
        revision: { revision: 2, amountVnd: '10500000000', validFrom: '2026-08-01', status: 'PENDING_EFFECTIVE', supersedesId: contract.revisionId, boqLineCount: 2, boqTotalVnd: '10000000000' },
      });
      expect(hook.authorise).toHaveBeenCalledWith(expect.objectContaining({ amountVnd: '500000000', contractId: contract.contractId, projectId: PROJECT }));
      expect(hook.available).toHaveBeenCalledWith(LINE, '500000000');
      expect(await requestRow(co.id)).toMatchObject({ status: 'APPROVED', approved_delta_vnd: '500000000', effective_on: '2026-08-01', resulting_revision_id: done.revision?.id, decided_by: memberId(APPROVER), status_reason: 'The change is within the plan.' });
      expect(await revisionsOf(contract.contractId)).toMatchObject([
        { revision: 1, status: 'EFFECTIVE', kind: 'BASE', valid_until: null },
        { revision: 2, status: 'PENDING_EFFECTIVE', kind: 'CHANGE_ORDER', amount_vnd: '10500000000', valid_from: '2026-08-01', supersedes_id: contract.revisionId, change_request_id: co.id },
      ]);
      // The register says which change order made the revision and which revision it follows.
      const detail = await as((tx) => new CtrContractStore().find(tx, contract.contractId, everything));
      expect(detail?.revisions.map((r) => [r.revision, r.supersedesId, r.changeRequest])).toEqual([
        [1, null, null],
        [2, contract.revisionId, { id: co.id, code: 'CO-001' }],
      ]);
      // Nothing changes until the day: the contract is worth what it was, and the pending revision prices nothing.
      expect(await contractRow(contract.contractId)).toMatchObject({ contract_value_vnd: '10000000000', current_revision_id: contract.revisionId });
      expect((await as((tx) => revisions.pricingRevisionAt(tx, contract.contractId, '2026-08-02')))?.revision).toBe(1);
      expect(await as((tx) => new CtrRevisionEffective(new AuditWriter(harness.tenants)).run(tx, memberId(JOB), new Date('2026-07-30T17:05:00Z')))).toEqual({ activated: 0, blocked: 0, overdue: 0 });

      // The night of 1 August: revision 2 takes over, and exactly one revision is in force.
      expect(await runJob()).toEqual({ activated: 1, blocked: 0, overdue: 0 });
      expect(await revisionsOf(contract.contractId)).toMatchObject([
        { revision: 1, status: 'SUPERSEDED', valid_until: '2026-08-01' },
        { revision: 2, status: 'EFFECTIVE', valid_until: null },
      ]);
      expect((await revisionsOf(contract.contractId)).filter((revision) => revision.status === 'EFFECTIVE')).toHaveLength(1);
      expect(await contractRow(contract.contractId)).toMatchObject({ contract_value_vnd: '10500000000', current_revision_id: done.revision?.id });
      expect(await runJob()).toEqual({ activated: 0, blocked: 0, overdue: 0 });
      const [audit] = await owner<{ safe_diff: Record<string, unknown> }>("select safe_diff from machvon.audit_event where resource_id = $1 and action = 'contract.revision_effective'", [done.revision?.id]);
      expect(audit?.safe_diff).toMatchObject({ contract_id: contract.contractId, revision: 2, from_value_vnd: '10000000000', to_value_vnd: '10500000000', change_request_id: co.id });
      const [event] = await owner<{ payload: Record<string, unknown> }>("select payload from machvon.outbox_event where aggregate_id = $1 and type = 'ctr.commitment.changed.v1'", [contract.contractId]);
      expect(event?.payload).toMatchObject({ contract_id: contract.contractId, project_id: PROJECT, committed_vnd: '10500000000', previous_committed_vnd: '10000000000', revision: 2 });

      // CO-002 takes 8 billion from a contract that has accepted 3 billion: 2.5 billion is below the floor.
      const second = await evaluatedCo(contract, '-8000000000', done.revision?.id);
      expect(second.code).toBe('CO-002');
      expect(await refusal(decide(second, approval({ effectiveOn: '2026-09-01' }), { today: '2026-08-02' }))).toMatchObject({
        code: 'ACCEPTANCE_VALUE_EXCEEDS_CONTRACT',
        status: 422,
        extensions: { new_value_vnd: '2500000000', floor_vnd: '3000000000' },
      });
      expect(await requestRow(second.id)).toMatchObject({ status: 'EVALUATED' });
      expect(await revisionsOf(contract.contractId)).toHaveLength(2);
    });

    it('AC-ST-CTR-007-2, UAT-AC58: a revision prices from its day on and never before, and a change that reaches back is refused', async () => {
      const contract = await seedContract();
      const co = await evaluatedCo(contract, '50000000');
      // The new BOQ prices B02 at 2,100,000 (500 m3): the value is 10.05 billion.
      const done = await decide(
        co,
        approval({ boqLines: boqFor('9000000000', '2100000') }),
      );
      expect(done.revision).toMatchObject({ amountVnd: '10050000000', boqLineCount: 2, boqTotalVnd: '10050000000' });
      expect(done.revision?.boqImport).toMatchObject({ mode: 'REPLACE', linesImported: 2 });
      expect((await linesOf(done.revision?.id ?? '')).map((l) => [l.business_key, plainDecimal(l.unit_price), l.amount_vnd])).toEqual([
        ['B01', '9000000000', '9000000000'],
        ['B02', '2100000', '1050000000'],
      ]);
      // While it waits it prices nothing.
      const price = (day: string) => as((tx) => revisions.unitPriceAt(tx, contract.contractId, 'B02', day));
      expect((await price('2026-07-25'))?.unitPrice).toBe('2000000');
      expect((await price('2026-08-02'))?.unitPrice).toBe('2000000');
      await runJob();
      const before = await price('2026-07-25');
      const on = await price('2026-08-01');
      const after = await price('2026-08-02');
      expect([before?.revision.revision, before?.unitPrice]).toEqual([1, '2000000']);
      expect([on?.revision.revision, on?.unitPrice]).toEqual([2, '2100000']);
      expect([after?.revision.revision, after?.unitPrice]).toEqual([2, '2100000']);
      expect(after?.revision).toMatchObject({ kind: 'CHANGE_ORDER', validFrom: '2026-08-01', validUntil: null });
      expect(before?.revision.validUntil).toBe('2026-08-01');
      expect(await price('2026-01-01')).toBeUndefined();
      expect(await as((tx) => revisions.unitPriceAt(tx, contract.contractId, 'NO-SUCH-ITEM', '2026-08-02'))).toBeUndefined();

      // A change that takes effect before the day it is approved is refused, and nothing is written.
      const reaching = await evaluatedCo(contract, '10000000', done.revision?.id);
      expect(await refusal(decide(reaching, approval({ effectiveOn: '2026-06-01' }), { today: '2026-08-02' }))).toMatchObject({
        code: 'RETROACTIVE_NOT_ALLOWED',
        status: 422,
        detail: 'effective_on',
        extensions: { effective_on: '2026-06-01', approved_on: '2026-08-02' },
      });
      expect(await requestRow(reaching.id)).toMatchObject({ status: 'EVALUATED', resulting_revision_id: null });
      expect(await revisionsOf(contract.contractId)).toHaveLength(2);
    });

    it('starts the day it is approved by default, takes the assessment as the amount by default and may differ from it', async () => {
      const contract = await seedContract();
      const co = await evaluatedCo(contract, '100000000');
      const done = await decide(co, approval({ effectiveOn: undefined, approvedDeltaVnd: '60000000' }), { today: '2026-09-01' });
      expect(done).toMatchObject({ approvedDeltaVnd: '60000000', effectiveOn: '2026-09-01', toValueVnd: '10060000000' });
      const other = await seedContract();
      const same = await evaluatedCo(other, '-250000000');
      const lowered = await decide(same, approval({ approvedDeltaVnd: undefined, effectiveOn: undefined, boqLines: boqFor('8750000000') }));
      expect(lowered).toMatchObject({ approvedDeltaVnd: '-250000000', effectiveOn: TODAY, toValueVnd: '9750000000' });
      expect((await revisionsOf(other.contractId))[1]).toMatchObject({ amount_vnd: '9750000000', valid_from: TODAY });
    });

    it('chains the revisions of a contract in the order of their days and puts them in force one after the other, even after a missed night', async () => {
      const contract = await seedContract();
      const first = await evaluatedCo(contract, '100000000');
      const second = await evaluatedCo(contract, '200000000');
      const done = await decide(first, approval({ effectiveOn: '2026-08-01' }));
      expect(await refusal(decide(second, approval({ effectiveOn: '2026-08-01' })))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'effective_on', extensions: { reason: 'NOT_AFTER_REVISION', after: '2026-08-01' } });
      expect(await refusal(decide(second, approval({ effectiveOn: '2026-07-31' })))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'effective_on' });
      const next = await decide(second, approval({ effectiveOn: '2026-09-01' }));
      // It follows the pending revision, so the value is 10.1 + 0.2 billion.
      expect(next).toMatchObject({ fromValueVnd: '10100000000', toValueVnd: '10300000000', revision: { revision: 3, supersedesId: done.revision?.id } });
      expect(await runJob()).toEqual({ activated: 1, blocked: 0, overdue: 0 });
      expect(await contractRow(contract.contractId)).toMatchObject({ contract_value_vnd: '10100000000' });
      // The job did not run on 1 September: both are due and take over in order.
      expect(await runJob(new Date('2026-09-05T00:00:00Z'))).toEqual({ activated: 1, blocked: 0, overdue: 0 });
      expect(await revisionsOf(contract.contractId)).toMatchObject([
        { revision: 1, status: 'SUPERSEDED', valid_until: '2026-08-01' },
        { revision: 2, status: 'SUPERSEDED', valid_until: '2026-09-01' },
        { revision: 3, status: 'EFFECTIVE', valid_until: null },
      ]);
      expect(await contractRow(contract.contractId)).toMatchObject({ contract_value_vnd: '10300000000' });
    });

    it('takes two revisions that are both due in one pass, in the order of their days', async () => {
      const contract = await seedContract();
      const first = await evaluatedCo(contract, '100000000');
      const second = await evaluatedCo(contract, '200000000');
      await decide(first, approval({ effectiveOn: '2026-08-01' }));
      await decide(second, approval({ effectiveOn: '2026-09-01' }));
      expect(await runJob(new Date('2026-09-05T00:00:00Z'))).toEqual({ activated: 2, blocked: 0, overdue: 0 });
      expect(await revisionsOf(contract.contractId)).toMatchObject([{ status: 'SUPERSEDED' }, { status: 'SUPERSEDED', valid_until: '2026-09-01' }, { status: 'EFFECTIVE' }]);
      expect(await contractRow(contract.contractId)).toMatchObject({ contract_value_vnd: '10300000000' });
      expect(Number((await contractRow(contract.contractId))?.version)).toBe(3);
    });

    it('asks the delegation and the capital, and takes what they refuse as it comes', async () => {
      const contract = await seedContract();
      const co = await evaluatedCo(contract, '500000000');
      const limited = hooks({ authorise: jest.fn(async () => Promise.reject(Object.assign(new Error('limit'), { code: 'SCOPE_DENIED', status: 403 }))) });
      expect(await refusal(decide(co, approval(), { hooks: limited }))).toMatchObject({ code: 'SCOPE_DENIED', status: 403 });
      const exhausted = hooks({ available: jest.fn(async () => Promise.reject(Object.assign(new Error('blocked'), { code: 'ALLOCATION_UNAVAILABLE', status: 422 }))) });
      expect(await refusal(decide(co, approval(), { hooks: exhausted }))).toMatchObject({ code: 'ALLOCATION_UNAVAILABLE', status: 422 });
      // A decrease asks nothing of the capital, an increase that is approved above the assessment asks for the amount approved.
      const asked = hooks();
      const lower = await seedContract();
      await decide(await evaluatedCo(lower, '-5000000'), approval({ boqLines: boqFor('8995000000') }), { hooks: asked });
      expect(asked.available).not.toHaveBeenCalled();
      expect(asked.authorise).toHaveBeenCalledWith(expect.objectContaining({ amountVnd: '5000000' }));
      const bigger = hooks();
      const wide = await seedContract();
      await decide(await evaluatedCo(wide, '100000000'), approval({ approvedDeltaVnd: '130000000' }), { hooks: bigger });
      expect(bigger.available).toHaveBeenCalledWith(LINE, '130000000');
      expect(await requestRow(co.id)).toMatchObject({ status: 'EVALUATED' });
    });

    it('needs the line of capital for an increase that the assessment did not name, and a value above zero', async () => {
      const contract = await seedContract();
      const decrease = await evaluatedCo(contract, '-1000000');
      expect(await refusal(decide(decrease, approval({ approvedDeltaVnd: '1000000' })))).toMatchObject({ code: 'ALLOCATION_UNAVAILABLE', status: 422, extensions: { reason: 'ALLOCATION_LINE_REQUIRED' } });
      expect(await refusal(decide(decrease, approval({ approvedDeltaVnd: '-10000000000' })))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'approved_delta_vnd' });
      expect(await refusal(decide(decrease, approval({ approvedDeltaVnd: '1.5' })))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'approved_delta_vnd' });
      expect(await requestRow(decrease.id)).toMatchObject({ status: 'EVALUATED' });
    });

    it('keeps the value above what was paid net of the advance recovered', async () => {
      const contract = await seedContract();
      await owner('update machvon.contract set advance_paid_vnd = 1000000000, paid_total_vnd = 2500000000, advance_recovered_vnd = 200000000, accepted_total_vnd = 3000000000, requested_total_vnd = 2500000000 where id = $1::uuid', [contract.contractId]);
      const co = await evaluatedCo(contract, '-6700000001');
      expect(await refusal(decide(co))).toMatchObject({ code: 'ACCEPTANCE_VALUE_EXCEEDS_CONTRACT', extensions: { new_value_vnd: '3299999999', floor_vnd: '3300000000' } });
      const exact = await evaluatedCo(contract, '-6700000000');
      // The copy of the BOQ in force is above 3.3 billion: the change has to say which lines shrink.
      expect(await refusal(decide(exact))).toMatchObject({ code: 'BOQ_TOTAL_MISMATCH', status: 422 });
      expect((await decide(exact, approval({ boqLines: boqFor('2300000000') }))).toValueVnd).toBe('3300000000');
    });
  });

  describe('giving back and rejecting', () => {
    it('gives the change back to be assessed again, with the reason, and rejects it for good', async () => {
      const contract = await seedContract();
      const co = await evaluatedCo(contract, '100000000');
      const back = await decide(co, { decision: 'return', reason: 'The funding note is thin.', evidenceIds: [] });
      expect(back).toMatchObject({ decision: 'return', status: 'SUBMITTED', fromStatus: 'EVALUATED', version: 3, approvedDeltaVnd: null, revision: undefined });
      expect(await requestRow(co.id)).toMatchObject({ status: 'SUBMITTED', status_reason: 'The funding note is thin.', decided_by: null, resulting_revision_id: null });
      // It can be assessed again and decided again.
      const again = await as((tx) => chain.evaluate(tx, co.id, 3, { evaluatedDeltaVnd: '90000000', scheduleImpactDays: 5, fundingImpactNote: 'Revised.', allocationLineId: LINE }, memberId(EVALUATOR), contractScopes, { available: async () => undefined }), EVALUATOR);
      const rejected = await decide(again, { decision: 'reject', reason: 'The change is not needed.', evidenceIds: [] });
      expect(rejected).toMatchObject({ decision: 'reject', status: 'REJECTED', fromStatus: 'EVALUATED', version: 5 });
      expect(await requestRow(co.id)).toMatchObject({ status: 'REJECTED', status_reason: 'The change is not needed.', decided_by: memberId(APPROVER) });
      expect(await refusal(decide(again, approval(), { version: 5 }))).toMatchObject({ code: 'CHANGE_STATE_INVALID', status: 409, extensions: { change_status: 'REJECTED' } });
      expect(await revisionsOf(contract.contractId)).toHaveLength(1);
    });

    it('is not for the people who had a part in it, whatever the decision', async () => {
      const contract = await seedContract();
      const co = await evaluatedCo(contract, '100000000');
      for (const member of [MAKER, EVALUATOR]) {
        for (const decision of ['return', 'reject']) {
          expect(await refusal(decide(co, { decision, reason: 'No.', evidenceIds: [] }, { member }))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
        }
      }
      expect(await requestRow(co.id)).toMatchObject({ status: 'EVALUATED' });
    });
  });

  describe('what a decision is judged on', () => {
    it('judges the shape first: the decision, the reason, the evidence and the document', async () => {
      const contract = await seedContract();
      const co = await evaluatedCo(contract, '100000000');
      const bad: Array<[Partial<DecideInput>, string]> = [
        [{ decision: 'maybe' }, 'decision'],
        [{ reason: '   ' }, 'reason'],
        [{ reason: 'x'.repeat(2001) }, 'reason'],
        [{ evidenceIds: ['nope'] }, 'evidence_ids'],
        [{ evidenceIds: [randomUUID()] }, 'evidence_ids'],
        [{ evidenceIds: Array.from({ length: 51 }, () => randomUUID()) }, 'evidence_ids'],
        [{ effectiveOn: '2026-02-30' }, 'effective_on'],
        [{ effectiveOn: 'tomorrow' }, 'effective_on'],
      ];
      for (const [override, field] of bad) expect(await refusal(decide(co, approval(override)))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: field });
      expect(await refusal(decide(co, approval({ decisionDocumentVersionId: undefined })))).toMatchObject({ code: 'DECISION_DOCUMENT_REQUIRED', status: 422 });
      expect(await refusal(decide(co, approval({ decisionDocumentVersionId: randomUUID() })))).toMatchObject({ code: 'DECISION_DOCUMENT_REQUIRED' });
      await owner("update machvon.document_version set scan_status = 'INFECTED' where id = $1::uuid", [VERSION]);
      expect(await refusal(decide(co))).toMatchObject({ code: 'DECISION_DOCUMENT_REQUIRED' });
      await owner("update machvon.document_version set scan_status = 'CLEAN' where id = $1::uuid", [VERSION]);
      expect(await requestRow(co.id)).toMatchObject({ status: 'EVALUATED' });
    });

    it('judges the version, the tier, the state, the contract and the scope', async () => {
      const contract = await seedContract();
      const co = await evaluatedCo(contract, '100000000');
      expect(await refusal(decide(co, approval(), { version: 9 }))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      expect(await refusal(as((tx) => decisions.decide(tx, randomUUID(), 1, approval(), memberId(APPROVER), contractScopes, TODAY, hooks()), APPROVER))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(decide(co, approval(), { scopes: nothingUpdate }))).toMatchObject({ code: 'SCOPE_DENIED', status: 403 });
      expect(await refusal(decide(co, approval(), { scopes: invisible }))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      // An event is not decided; a CO that was not assessed is not either.
      const event = await as((tx) => chain.create(tx, contract.contractId, { stage: 'EVENT', baselineRevisionId: contract.revisionId, reason: 'Another notice.' }, memberId(MAKER), contractScopes));
      expect(await refusal(decide(event))).toMatchObject({ code: 'CHANGE_STAGE_NOT_ALLOWED', status: 422, extensions: { stage: 'EVENT', reason: 'ONLY_CO_DECIDED' } });
      const pco = await as((tx) => chain.promote(tx, event.id, 1, 'Priced.', memberId(MAKER), contractScopes));
      const fresh = await as((tx) => chain.promote(tx, pco.id, 1, 'Agreed.', memberId(MAKER), contractScopes));
      expect(await refusal(decide(fresh))).toMatchObject({ code: 'CHANGE_STATE_INVALID', status: 409, extensions: { change_status: 'SUBMITTED' } });
      await owner("update machvon.contract set status = 'COMPLETED' where id = $1::uuid", [contract.contractId]);
      expect(await refusal(decide(co))).toMatchObject({ code: 'CONTRACT_STATE_INVALID', status: 409, extensions: { contract_status: 'COMPLETED' } });
    });

    it('decides a change of a suspended contract', async () => {
      const contract = await seedContract();
      const co = await evaluatedCo(contract, '100000000');
      await owner("update machvon.contract set status = 'SUSPENDED', status_reason = 'Decided.', status_decision_document_version_id = $2 where id = $1::uuid", [contract.contractId, VERSION]);
      expect((await decide(co)).status).toBe('APPROVED');
    });

    it('refuses a BOQ that does not belong in the revision, whole', async () => {
      const contract = await seedContract();
      const co = await evaluatedCo(contract, '100000000');
      // 9 + 1.3 billion is above the 10.1 billion the change gives.
      expect(await refusal(decide(co, approval({ boqLines: boqFor('9000000000', '2600000') })))).toMatchObject({ code: 'BOQ_TOTAL_MISMATCH', status: 422 });
      expect(await refusal(decide(co, approval({ boqLines: [{ business_key: 'B01' }] })))).toMatchObject({ status: 422 });
      expect(await requestRow(co.id)).toMatchObject({ status: 'EVALUATED', resulting_revision_id: null });
      expect(await revisionsOf(contract.contractId)).toHaveLength(1);
      expect((await owner('select id from machvon.boq_import where contract_id = $1::uuid', [contract.contractId]))).toEqual([]);
    });
  });

  describe('the job', () => {
    it('leaves a revision that would take the contract below what was accepted since the approval, tells when it is a day late, and takes it once the floor allows', async () => {
      const contract = await seedContract();
      const co = await evaluatedCo(contract, '-500000000');
      await decide(co, approval({ boqLines: boqFor('8500000000') }));
      // The contract has accepted 9.8 billion by the night: 9.5 billion is below the floor.
      await owner('update machvon.contract set accepted_total_vnd = 9800000000 where id = $1::uuid', [contract.contractId]);
      expect(await runJob()).toEqual({ activated: 0, blocked: 1, overdue: 0 });
      expect(await runJob(new Date('2026-08-03T00:00:00Z'))).toEqual({ activated: 0, blocked: 1, overdue: 1 });
      expect((await revisionsOf(contract.contractId))[1]).toMatchObject({ status: 'PENDING_EFFECTIVE' });
      expect(await contractRow(contract.contractId)).toMatchObject({ contract_value_vnd: '10000000000' });
      await owner('update machvon.contract set accepted_total_vnd = 9000000000 where id = $1::uuid', [contract.contractId]);
      expect(await runJob(new Date('2026-08-03T00:00:00Z'))).toEqual({ activated: 1, blocked: 0, overdue: 0 });
      expect(await contractRow(contract.contractId)).toMatchObject({ contract_value_vnd: '9500000000' });
    });

    it('leaves a revision of a contract that is no longer being performed', async () => {
      const contract = await seedContract();
      await decide(await evaluatedCo(contract, '100000000'));
      await owner("update machvon.contract set status = 'COMPLETED' where id = $1::uuid", [contract.contractId]);
      expect(await runJob()).toEqual({ activated: 0, blocked: 1, overdue: 0 });
      expect((await revisionsOf(contract.contractId))[1]).toMatchObject({ status: 'PENDING_EFFECTIVE' });
      expect(await contractRow(contract.contractId)).toMatchObject({ contract_value_vnd: '10000000000' });
      // Put back as it was, so the next case finds nothing waiting that cannot take over.
      await seedAs(harness, [["update machvon.contract set status = 'ACTIVE' where id = $1::uuid", [contract.contractId]]]);
    });

    it('takes the revision with the BOQ it was approved with, and the BOQ of a pending change order can be put right before its day but not after', async () => {
      const contract = await seedContract();
      const done = await decide(await evaluatedCo(contract, '500000000'));
      // The copy of the BOQ in force is 10 billion against a value of 10.5: the lines can be completed by an import before the day.
      expect(done.revision).toMatchObject({ boqLineCount: 2, boqTotalVnd: '10000000000' });
      const imported = await as((tx) => boq.importLines(tx, done.revision?.id ?? '', 1, { mode: 'REPLACE', lines: boqFor('9500000000') }, memberId(MAKER), contractScopes));
      expect(imported.reconciliation.matches).toBe(true);
      expect(await runJob()).toEqual({ activated: 1, blocked: 0, overdue: 0 });
      expect(await contractRow(contract.contractId)).toMatchObject({ contract_value_vnd: '10500000000' });
      // Once it is in force the lines are fixed: an import is refused.
      expect(await refusal(as((tx) => boq.importLines(tx, done.revision?.id ?? '', 3, { mode: 'REPLACE', lines: boqFor('9500000000') }, memberId(MAKER), contractScopes)))).toMatchObject({ code: 'REVISION_NOT_DRAFT', status: 422 });
    });
  });

  describe('what the database keeps', () => {
    it('keeps the history of revisions as it was written: the place, the edges, the terms of a decided revision, the last day', async () => {
      const contract = await seedContract();
      const co = await evaluatedCo(contract, '100000000');
      const done = await decide(co);
      const pending = done.revision?.id ?? '';
      const update = (set: string, target = pending) => databaseRefusal(owner(`update machvon.contract_revision set ${set} where id = $1::uuid`, [target]));
      for (const change of ['revision = 9', "kind = 'AMENDMENT'", 'change_request_id = null', 'supersedes_id = null', 'contract_id = gen_random_uuid()', "created_at = now() - interval '1 day'"]) {
        expect((await update(change)).message).toContain('keeps its place in the history');
      }
      for (const change of ['amount_vnd = 1', "valid_from = date '2026-09-01'", 'document_version_id = gen_random_uuid()', 'retroactive = true', 'decided_by = null', 'decided_at = null']) {
        expect((await update(change)).message).toMatch(/keeps its terms|retroactive/);
      }
      expect((await update("valid_until = date '2026-09-01'")).message).toContain('written once');
      for (const status of ["status = 'DRAFT'", "status = 'SUPERSEDED'", "status = 'REJECTED'"]) expect((await update(status)).message).toContain('REVISION_STATE_INVALID');
      expect((await update("status = 'DRAFT'", contract.revisionId)).message).toContain('REVISION_STATE_INVALID');
      expect((await update("status = 'PENDING_EFFECTIVE'", contract.revisionId)).message).toContain('REVISION_STATE_INVALID');
      // A change order is one revision, and a revision comes from one change order.
      expect((await databaseRefusal(owner("update machvon.contract_revision set kind = 'CHANGE_ORDER' where id = $1::uuid", [contract.revisionId]))).message).toContain('keeps its place');
      expect((await databaseRefusal(owner('delete from machvon.contract_revision where id = $1::uuid', [pending]))).message).toBeDefined();
    });

    it('keeps a change order that was decided as it is, and says what a decided one needs', async () => {
      const contract = await seedContract();
      const co = await evaluatedCo(contract, '100000000');
      const done = await decide(co);
      const update = (set: string, target = co.id) => databaseRefusal(owner(`update machvon.change_request set ${set} where id = $1::uuid`, [target]));
      expect((await update("status_reason = 'Changed'")).message).toContain('is kept as it is');
      expect((await update("status = 'EVALUATED'")).message).toContain('is kept as it is');
      const other = await evaluatedCo(await seedContract(), '1000');
      expect((await update("status = 'APPROVED'", other.id)).message).toMatch(/change_request_(approved|decided|resulting_revision)_chk/);
      expect((await update("status = 'REJECTED'", other.id)).message).toContain('change_request_decided_chk');
      expect((await update(`resulting_revision_id = '${done.revision?.id}'`, other.id)).message).toContain('change_request_resulting_revision_chk');
      expect((await databaseRefusal(owner("insert into machvon.contract_revision (tenant_id, id, contract_id, revision, amount_vnd, document_version_id, valid_from, status, kind, decided_by, decided_at, version) select tenant_id, gen_random_uuid(), contract_id, 9, 1, document_version_id, date '2027-01-01', 'PENDING_EFFECTIVE', 'CHANGE_ORDER', decided_by, decided_at, 1 from machvon.contract_revision where id = $1::uuid", [done.revision?.id]))).message).toContain('contract_revision_change_order_chk');
      expect((await databaseRefusal(owner("insert into machvon.contract_revision (tenant_id, id, contract_id, revision, amount_vnd, document_version_id, valid_from, status, kind, change_request_id, decided_by, decided_at, version) select tenant_id, gen_random_uuid(), contract_id, 9, 1, document_version_id, date '2027-01-01', 'PENDING_EFFECTIVE', 'CHANGE_ORDER', change_request_id, decided_by, decided_at, 1 from machvon.contract_revision where id = $1::uuid", [done.revision?.id]))).message).toContain('contract_revision_change_request_uq');
    });

    it('lets the BOQ of a pending change order be written, and not that of a revision in force or one that was', async () => {
      const contract = await seedContract();
      const co = await evaluatedCo(contract, '100000000');
      const done = await decide(co);
      const pending = done.revision?.id ?? '';
      await owner("update machvon.boq_line set quantity = 600, amount_vnd = 1200000000 where contract_revision_id = $1::uuid and business_key = 'B02'", [pending]);
      expect((await linesOf(pending)).find((l) => l.business_key === 'B02')).toMatchObject({ quantity: '600.000000', amount_vnd: '1200000000' });
      expect((await databaseRefusal(owner("update machvon.boq_line set quantity = 1 where contract_revision_id = $1::uuid and business_key = 'B02'", [contract.revisionId]))).message).toContain('REVISION_NOT_DRAFT');
      await owner("update machvon.boq_line set quantity = 500, amount_vnd = 1000000000, unit_price = 2000000 where contract_revision_id = $1::uuid and business_key = 'B02'", [pending]);
      await runJob();
      expect((await databaseRefusal(owner("update machvon.boq_line set quantity = 1 where contract_revision_id = $1::uuid and business_key = 'B02'", [pending]))).message).toContain('REVISION_NOT_DRAFT');
    });
  });
});
