import { randomUUID } from 'node:crypto';
import { applyBaseline, sealPack } from '../src/master-baseline';
import type { BaselineEntry } from '../src/master-baseline';
import { PmtGateStore } from '../src/pmt-gate-store';
import { QmsInspectionStore } from '../src/qms-inspection-store';
import type { RequestInput } from '../src/qms-inspection-store';
import type { ContractScopes } from '../src/ctr-contract-store';
import type { TenantTx } from '../src/tenant-database';
import { TENANT_A, contextFor, id, memberId } from './support/authz-fixtures';
import { seedAs } from './support/bid-proposal-fixtures';
import { CapWorld } from './support/cap-fixtures';

const world = new CapWorld();
const harness = world.harness;
const inspections = new QmsInspectionStore();
const gates = new PmtGateStore();
const FAMILY = 0xad;
const REQUESTER = 1;
const SUPERVISOR = 2;
const FIRST = 3;
const SECOND = 4;
const GONE = 5;
const CONTRACTOR = id(FAMILY, 10);
const PERMIT_TYPE = id(FAMILY, 60);
const VERSION = id(FAMILY, 31);
const NOW = new Date('2026-12-20T03:00:00Z');
const contractScopes: ContractScopes = { update: () => ({ sql: 'true', params: [] }), read: () => ({ sql: 'true', params: [] }) };
const readOnly: ContractScopes = { update: () => ({ sql: 'false', params: [] }), read: () => ({ sql: 'true', params: [] }) };
const invisible: ContractScopes = { update: () => ({ sql: 'false', params: [] }), read: () => ({ sql: 'false', params: [] }) };
const everything = () => ({ sql: 'true', params: [] as unknown[] });
const nothing = () => ({ sql: 'false', params: [] as unknown[] });

let PROJECT = '';
let counter = 0;

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = REQUESTER): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, memberId(member)), work);
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
  item: string;
  diary: string;
}

/** A contract of a project with capital in force, with one item of the BOQ and one site diary. */
async function seedContract(options: { status?: string; category?: string } = {}): Promise<Seeded> {
  counter += 1;
  const contractId = randomUUID();
  const item = randomUUID();
  const diary = randomUUID();
  const code = `HD-K-${String(counter).padStart(4, '0')}`;
  const line = await world.publishedLine();
  await seedAs(harness, [
    [
      `insert into machvon.contract
         (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, title, advance_category, is_joint_venture, requires_quality_acceptance, contract_value_vnd,
          created_by, updated_by, signed_on, effective_from, status_reason, status_decision_document_version_id)
       values ($1, $2, $3, $4, $5, $6, 'UNIT_PRICE', 'VND', $7, 1, 'Contract', $8, false, true, 1000000, $9, $9, date '2026-01-01', date '2026-01-02', $10, $11)`,
      [TENANT_A, contractId, line.projectId, randomUUID(), CONTRACTOR, code, options.status ?? 'ACTIVE', options.category ?? 'CONSTRUCTION', memberId(REQUESTER), options.status === 'SUSPENDED' ? 'Stopped.' : null, options.status === 'SUSPENDED' ? VERSION : null],
    ],
    [`insert into machvon.boq_item (tenant_id, id, contract_id, business_key, description, unit_code, created_by, updated_by) values ($1, $2, $3, 'B01', 'Earthwork', 'M3', $4, $4)`, [TENANT_A, item, contractId, memberId(REQUESTER)]],
    [
      `insert into machvon.site_diary (tenant_id, id, project_id, contract_id, record_date, client_operation_id, content, author_id, version, created_by, updated_by)
       values ($1, $2, $3, $4, date '2026-12-20', gen_random_uuid(), '{}'::jsonb, $5, 1, $5, $5)`,
      [TENANT_A, diary, line.projectId, contractId, memberId(REQUESTER)],
    ],
  ]);
  PROJECT = line.projectId;
  return { contractId, item, diary };
}

const input = (seeded: Seeded, overrides: Partial<RequestInput> = {}): RequestInput => ({ contractId: seeded.contractId, inspectionType: 'CONCEALED_WORK', title: 'Concealed work, footing F1', requestedFor: '2026-12-31', ...overrides });
const request = (seeded: Seeded, overrides: Partial<RequestInput> = {}, options: { scopes?: ContractScopes; now?: Date } = {}) =>
  as((tx) => inspections.request(tx, input(seeded, overrides), memberId(REQUESTER), options.scopes ?? contractScopes, options.now ?? NOW));
const schedule = (inspectionId: string, version: number, overrides: Partial<{ scheduledAt: string; participantMembershipIds: string[] }> = {}, options: { scopes?: ContractScopes; now?: Date } = {}) =>
  as(
    (tx) =>
      inspections.schedule(tx, inspectionId, version, { scheduledAt: '2026-12-28T02:00:00Z', participantMembershipIds: [memberId(FIRST), memberId(SECOND)], ...overrides }, memberId(SUPERVISOR), options.scopes ?? contractScopes, options.now ?? NOW),
    SUPERVISOR,
  );
const PASSED = [
  { code: 'A', outcome: 'PASS' },
  { code: 'B', outcome: 'PASS' },
];
const record = (inspectionId: string, version: number, overrides: Partial<{ result: string; resultNote: string; checklist: unknown[] }> = {}, options: { scopes?: ContractScopes } = {}) =>
  as(
    (tx) => inspections.record(tx, inspectionId, version, { result: 'PASS', resultNote: 'Rebar and cover are right.', checklist: PASSED, ...overrides }, memberId(SUPERVISOR), options.scopes ?? contractScopes, NOW),
    SUPERVISOR,
  );
const cancel = (inspectionId: string, version: number, reason = 'The work was moved to the next week.', scopes: ContractScopes = contractScopes) =>
  as((tx) => inspections.cancel(tx, inspectionId, version, reason, memberId(REQUESTER), scopes, NOW));
const rowOf = async (inspectionId: string) =>
  (
    await owner<{ status: string; version: string; regime_rule_version_id: string | null; required_roles: string[]; regime_awaiting_confirmation: boolean; regime_cxn: string | null; checklist: Array<Record<string, unknown>>; result: string | null; scheduled_at: string | null; participant_membership_ids: string[]; inspection_no: string }>(
      'select status, version::text, regime_rule_version_id, required_roles, regime_awaiting_confirmation, regime_cxn, checklist, result, scheduled_at::text, participant_membership_ids, inspection_no from machvon.inspection where id = $1::uuid',
      [inspectionId],
    )
  )[0];
const versionId = async (code: string, revision: number) =>
  (await owner<{ id: string }>("select id from machvon.master_record_version where master_type = 'QMS_REGIME' and code = $1 and revision = $2", [code, revision]))[0]?.id;

const regime = (key: string, validFrom: string, roles: string[], extra: { validUntil?: string; confirmed?: boolean } = {}): BaselineEntry => ({
  masterType: 'QMS_REGIME',
  businessKey: key,
  label: `Regime ${key}`,
  attributes: {
    owner_module: 'QMS',
    awaiting_confirmation: extra.confirmed !== true,
    ...(extra.confirmed === true ? {} : { cxn: 'CXN-07' }),
    required_roles: roles,
    completion_required_roles: [...roles, 'DESIGNER'].filter((role, index, all) => all.indexOf(role) === index),
    checklists: [
      { inspection_type: 'CONCEALED_WORK', items: [{ code: 'A', label: 'Rebar to drawing' }, { code: 'B', label: 'Concrete cover' }] },
      { inspection_type: 'SAFETY', items: [{ code: 'S', label: 'Safety measures' }] },
    ],
  },
  validFrom,
  ...(extra.validUntil === undefined ? {} : { validUntil: extra.validUntil }),
  legalBasis: 'Decree fixture',
});

describe('the inspections of work under a contract (ST-QMS-004)', () => {
  beforeAll(async () => {
    await world.start();
    for (const n of [SECOND, GONE]) await harness.seedMembership(TENANT_A, n, 1);
    await owner("update machvon.membership set status = 'Suspended' where id = $1::uuid", [memberId(GONE)]);
    await seedAs(harness, [
      [
        `insert into machvon.permit_type (tenant_id, id, code, name, category, authority_text, legal_basis, effective_from, applies_to_rule, status, created_by, updated_by)
         values ($1, $2, 'GPXD', 'Building permit', 'OTHER', 'The authority', 'Fixture decree', '2025-01-01', '{}'::jsonb, 'PUBLISHED', $3, $3)`,
        [TENANT_A, PERMIT_TYPE, memberId(REQUESTER)],
      ],
    ]);
    // The platform's own regimes (ND-06-2021, ND-207-2026) are set aside so that the fixture's dates are the only ones in the way.
    await owner("update machvon.master_record_version set published_at = null where master_type = 'QMS_REGIME' and code in ('ND-06-2021', 'ND-207-2026')");
    // The regimes of the fixture: REG-FIX-1 until the end of 2026 (waiting for its confirmation), REG-FIX-2 from 2027 (waiting too, and DESIGNER signs as well), REG-FIX-3 from 2028 (confirmed).
    await as((tx) =>
      applyBaseline(
        tx,
        sealPack('QMS-FIXTURE', [
          regime('REG-FIX-1', '2026-01-01', ['CONTRACTOR', 'SUPERVISOR', 'OWNER'], { validUntil: '2027-01-01' }),
          regime('REG-FIX-2', '2027-01-01', ['CONTRACTOR', 'SUPERVISOR', 'OWNER', 'DESIGNER'], { validUntil: '2028-01-01' }),
          regime('REG-FIX-3', '2028-01-01', ['CONTRACTOR', 'SUPERVISOR', 'OWNER', 'DESIGNER'], { confirmed: true }),
        ]),
        memberId(REQUESTER),
        '2026-06-01',
      ),
    );
  }, 240_000);

  afterAll(async () => {
    await world.stop();
  }, 60_000);

  beforeEach(async () => {
    await owner('delete from machvon.permit_gate_rule');
  });

  describe('requesting (the regime by the date of the request)', () => {
    it('AC-ST-QMS-004-1, UAT-AC363: gives an inspection the regime in force on its day, with the roles that sign and the checklist, and says when the regime waits for its confirmation', async () => {
      const seeded = await seedContract();
      const first = await request(seeded, { requestedFor: '2026-12-31' });
      expect(first).toMatchObject({ inspectionNo: 'KT-001', status: 'REQUESTED', fromStatus: null, version: 1, requiredRoles: ['CONTRACTOR', 'SUPERVISOR', 'OWNER'], regimeAwaitingConfirmation: true, regimeRuleVersionId: await versionId('REG-FIX-1', 1) });
      expect(await rowOf(first.id)).toMatchObject({
        status: 'REQUESTED',
        regime_awaiting_confirmation: true,
        regime_cxn: 'CXN-07',
        required_roles: ['CONTRACTOR', 'SUPERVISOR', 'OWNER'],
        checklist: [{ code: 'A', label: 'Rebar to drawing' }, { code: 'B', label: 'Concrete cover' }],
      });

      const second = await request(seeded, { requestedFor: '2027-01-01' });
      expect(second).toMatchObject({ inspectionNo: 'KT-002', requiredRoles: ['CONTRACTOR', 'SUPERVISOR', 'OWNER', 'DESIGNER'], regimeAwaitingConfirmation: true, regimeRuleVersionId: await versionId('REG-FIX-2', 1) });

      // The confirmed regime of 2028 carries no warning.
      const third = await request(seeded, { requestedFor: '2028-03-01' });
      expect(third).toMatchObject({ regimeAwaitingConfirmation: false, regimeRuleVersionId: await versionId('REG-FIX-3', 1) });
      expect(await rowOf(third.id)).toMatchObject({ regime_awaiting_confirmation: false, regime_cxn: null });

      // The completion of the work is signed by the designer too, and the regime has no checklist for it.
      const completion = await request(seeded, { inspectionType: 'COMPLETION', requestedFor: '2026-12-30' });
      expect(completion.requiredRoles).toEqual(['CONTRACTOR', 'SUPERVISOR', 'OWNER', 'DESIGNER']);
      expect(await rowOf(completion.id)).toMatchObject({ checklist: [] });
    });

    it('keeps the regime an inspection was given when the rule data changes afterwards', async () => {
      const seeded = await seedContract();
      const before = await request(seeded, { requestedFor: '2027-01-15' });
      const was = await rowOf(before.id);
      // A new version of REG-FIX-2 takes effect on 2027-02-01: the one in force until then is closed there.
      await as((tx) => applyBaseline(tx, sealPack('QMS-FIXTURE-2', [regime('REG-FIX-2', '2027-02-01', ['CONTRACTOR', 'SUPERVISOR', 'OWNER'], { validUntil: '2028-01-01' })]), memberId(REQUESTER), '2026-06-01'));
      expect(await rowOf(before.id)).toEqual(was);
      expect(was?.required_roles).toEqual(['CONTRACTOR', 'SUPERVISOR', 'OWNER', 'DESIGNER']);
      // The inspection of a day before the change still reads the old version; one after it reads the new one.
      expect((await request(seeded, { requestedFor: '2027-01-20', boqItemId: seeded.item })).regimeRuleVersionId).toBe(await versionId('REG-FIX-2', 1));
      const later = await request(seeded, { requestedFor: '2027-02-10' });
      expect(later.regimeRuleVersionId).toBe(await versionId('REG-FIX-2', 2));
      expect(later.requiredRoles).toEqual(['CONTRACTOR', 'SUPERVISOR', 'OWNER']);
    });

    it('refuses a day that no regime covers: REGIME_NOT_EFFECTIVE', async () => {
      const seeded = await seedContract();
      expect(await refusal(request(seeded, { requestedFor: '2024-05-01' }))).toMatchObject({ code: 'REGIME_NOT_EFFECTIVE', status: 422, detail: 'requested_for' });
      expect(await owner('select 1 from machvon.inspection where contract_id = $1::uuid', [seeded.contractId])).toEqual([]);
    });

    it('refuses a shape that is not one', async () => {
      const seeded = await seedContract();
      const refused = async (overrides: Partial<RequestInput>) => (await refusal(request(seeded, overrides))).detail;
      expect(await refused({ inspectionType: 'OTHER_KIND' })).toBe('inspection_type');
      expect(await refused({ title: '  ' })).toBe('title');
      expect(await refused({ title: 'x'.repeat(2001) })).toBe('title');
      expect(await refused({ locationText: ' ' })).toBe('location_text');
      expect(await refused({ requestedFor: '2026-02-30' })).toBe('requested_for');
      expect(await refused({ requestedFor: '31/12/2026' })).toBe('requested_for');
      expect(await refused({ contractId: 'x' })).toBe('contract_id');
      expect(await refused({ boqItemId: 'x' })).toBe('boq_item_id');
      expect(await refused({ boqItemId: randomUUID() })).toBe('boq_item_id');
      expect(await refused({ siteDiaryId: 'x' })).toBe('site_diary_id');
      expect(await refused({ siteDiaryId: randomUUID() })).toBe('site_diary_id');
      expect(await owner('select 1 from machvon.inspection where contract_id = $1::uuid', [seeded.contractId])).toEqual([]);
    });

    it('takes the work, the place and the diary the request names', async () => {
      const seeded = await seedContract();
      const done = await request(seeded, { boqItemId: seeded.item.toUpperCase(), locationText: ' Footing F1, km 2 ', siteDiaryId: seeded.diary });
      expect(done.boqItemId).toBe(seeded.item);
      const [line] = await as((tx) => inspections.list(tx, everything, { contractId: seeded.contractId }));
      expect(line).toMatchObject({
        id: done.id,
        inspectionNo: 'KT-001',
        contract: { id: seeded.contractId, status: 'ACTIVE' },
        boqItem: { id: seeded.item, businessKey: 'B01', description: 'Earthwork' },
        inspectionType: 'CONCEALED_WORK',
        locationText: 'Footing F1, km 2',
        requestedFor: '2026-12-31',
        requestedBy: { membershipId: memberId(REQUESTER) },
        status: 'REQUESTED',
        siteDiaryId: seeded.diary,
        requiredRoles: ['CONTRACTOR', 'SUPERVISOR', 'OWNER'],
        regime: { label: 'Regime REG-FIX-1', legalBasis: 'Decree fixture', awaitingConfirmation: true, cxn: 'CXN-07' },
        version: 1,
      });
      expect(line?.checklist).toEqual([{ code: 'A', label: 'Rebar to drawing' }, { code: 'B', label: 'Concrete cover' }]);
      expect(line?.reach).toMatchObject({ contractId: seeded.contractId, projectId: PROJECT });
    });

    it('refuses a request for the same work, kind and day while one is open, and takes it again once that one is cancelled or for another day', async () => {
      const seeded = await seedContract();
      const first = await request(seeded, { boqItemId: seeded.item });
      expect(await refusal(request(seeded, { boqItemId: seeded.item }))).toMatchObject({ code: 'INSPECTION_DUPLICATE', status: 409, extensions: { inspection_id: first.id } });
      expect(await request(seeded, { boqItemId: seeded.item, requestedFor: '2026-12-30' })).toMatchObject({ status: 'REQUESTED' });
      expect(await request(seeded, { boqItemId: seeded.item, inspectionType: 'SAFETY' })).toMatchObject({ status: 'REQUESTED' });
      expect(await request(seeded, {})).toMatchObject({ status: 'REQUESTED' });
      expect(await refusal(request(seeded, {}))).toMatchObject({ code: 'INSPECTION_DUPLICATE' });
      await cancel(first.id, 1);
      expect(await request(seeded, { boqItemId: seeded.item })).toMatchObject({ status: 'REQUESTED' });
    });

    it('answers for the contract: 404 outside the scope, 403 where it is only read, 409 unless it is being performed', async () => {
      const seeded = await seedContract();
      expect(await refusal(request(seeded, {}, { scopes: invisible }))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(request(seeded, {}, { scopes: readOnly }))).toMatchObject({ status: 403 });
      expect(await refusal(request({ ...seeded, contractId: randomUUID() }))).toMatchObject({ status: 404 });
      const suspended = await seedContract({ status: 'SUSPENDED' });
      expect(await refusal(request(suspended))).toMatchObject({ code: 'CONTRACT_STATE_INVALID', status: 409, extensions: { contract_status: 'SUSPENDED' } });
    });

    it('AC-ST-QMS-004-2, UAT-AC369: refuses a construction contract while the permits of the start of construction are missing, and takes it once they are, or for a contract that does not build', async () => {
      const seeded = await seedContract({ category: 'CONSTRUCTION' });
      await as((tx) => gates.publish(tx, { gateCode: 'START_CONSTRUCTION', permitTypeId: PERMIT_TYPE, requirement: 'VALID_PERMIT', appliesToRule: {}, legalBasis: 'Fixture decree', effectiveFrom: '2025-01-01' }, memberId(REQUESTER)));
      expect(await refusal(request(seeded))).toMatchObject({ code: 'PERMIT_GATE_BLOCKED', status: 422, extensions: { gate_code: 'START_CONSTRUCTION', blocking: [expect.objectContaining({ permit_type_code: 'GPXD' })] } });
      expect(await owner('select 1 from machvon.inspection where contract_id = $1::uuid', [seeded.contractId])).toEqual([]);
      const consulting = await seedContract({ category: 'CONSULTING' });
      expect(await request(consulting)).toMatchObject({ status: 'REQUESTED' });
      await owner('delete from machvon.permit_gate_rule');
      expect(await request(seeded)).toMatchObject({ status: 'REQUESTED' });
    });
  });

  describe('scheduling', () => {
    it('schedules a request at a moment that has not passed with the people who take part', async () => {
      const seeded = await seedContract();
      const made = await request(seeded);
      const done = await schedule(made.id, 1);
      expect(done).toMatchObject({ status: 'SCHEDULED', fromStatus: 'REQUESTED', version: 2, scheduledAt: '2026-12-28T02:00:00.000Z', participantMembershipIds: [memberId(FIRST), memberId(SECOND)] });
      expect(await rowOf(made.id)).toMatchObject({ status: 'SCHEDULED', version: '2', participant_membership_ids: [memberId(FIRST), memberId(SECOND)] });
      const [line] = await as((tx) => inspections.list(tx, everything, { contractId: seeded.contractId }));
      expect(line).toMatchObject({ scheduledAt: '2026-12-28T02:00:00.000Z', participants: [{ membershipId: memberId(FIRST) }, { membershipId: memberId(SECOND) }], status: 'SCHEDULED' });
    });

    it('refuses a moment in the past, people who are not active members or are named twice or none, a stale version and a request in the wrong state', async () => {
      const seeded = await seedContract();
      const made = await request(seeded);
      expect(await refusal(schedule(made.id, 1, { scheduledAt: '2026-12-19T02:00:00Z' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'scheduled_at' });
      expect(await refusal(schedule(made.id, 1, { scheduledAt: 'tomorrow' }))).toMatchObject({ detail: 'scheduled_at' });
      expect(await refusal(schedule(made.id, 1, { participantMembershipIds: [] }))).toMatchObject({ detail: 'participant_membership_ids' });
      expect(await refusal(schedule(made.id, 1, { participantMembershipIds: [memberId(FIRST), memberId(FIRST)] }))).toMatchObject({ detail: 'participant_membership_ids' });
      expect(await refusal(schedule(made.id, 1, { participantMembershipIds: [memberId(GONE)] }))).toMatchObject({ detail: 'participant_membership_ids' });
      expect(await refusal(schedule(made.id, 1, { participantMembershipIds: [randomUUID()] }))).toMatchObject({ detail: 'participant_membership_ids' });
      expect(await refusal(schedule(made.id, 1, { participantMembershipIds: ['x'] }))).toMatchObject({ detail: 'participant_membership_ids' });
      expect(await refusal(schedule(made.id, 7))).toMatchObject({ status: 409 });
      expect(await refusal(schedule(made.id, 1, {}, { scopes: invisible }))).toMatchObject({ status: 404 });
      expect(await refusal(schedule(made.id, 1, {}, { scopes: readOnly }))).toMatchObject({ status: 403 });
      expect(await refusal(schedule(randomUUID(), 1))).toMatchObject({ status: 404 });
      expect((await rowOf(made.id))?.status).toBe('REQUESTED');
      await schedule(made.id, 1);
      expect(await refusal(schedule(made.id, 2))).toMatchObject({ code: 'INSPECTION_STATE_INVALID', status: 409, extensions: { inspection_status: 'SCHEDULED' } });
    });
  });

  describe('recording the result', () => {
    it('AC-ST-QMS-004-3, UAT-AC360: records a result against the checklist and keeps the inspection as it is afterwards', async () => {
      const seeded = await seedContract();
      const made = await request(seeded, { boqItemId: seeded.item });
      expect(await refusal(record(made.id, 1))).toMatchObject({ code: 'INSPECTION_STATE_INVALID', extensions: { inspection_status: 'REQUESTED' } });
      await schedule(made.id, 1);
      const done = await record(made.id, 2);
      expect(done).toMatchObject({ status: 'RESULT_RECORDED', fromStatus: 'SCHEDULED', result: 'PASS', version: 3, failedItemCodes: [] });
      expect(await rowOf(made.id)).toMatchObject({
        status: 'RESULT_RECORDED',
        result: 'PASS',
        checklist: [{ code: 'A', label: 'Rebar to drawing', outcome: 'PASS' }, { code: 'B', label: 'Concrete cover', outcome: 'PASS' }],
      });
      // Nothing changes the result afterwards: not another record, not a cancellation, not the database.
      expect(await refusal(record(made.id, 3, { result: 'FAIL' }))).toMatchObject({ code: 'INSPECTION_STATE_INVALID', extensions: { inspection_status: 'RESULT_RECORDED' } });
      expect(await refusal(cancel(made.id, 3))).toMatchObject({ code: 'INSPECTION_STATE_INVALID' });
      expect((await databaseRefusal(owner("update machvon.inspection set result_note = 'edited' where id = $1::uuid", [made.id]))).message).toMatch(/is kept as it is/);
      expect((await databaseRefusal(owner("update machvon.inspection set result = 'FAIL' where id = $1::uuid", [made.id]))).sqlstate).toBe('23514');
    });

    it('records a failed result with the items that failed, and a conditional one with its conditions', async () => {
      const seeded = await seedContract();
      const failed = await request(seeded, { requestedFor: '2026-12-29' });
      await schedule(failed.id, 1);
      const done = await record(failed.id, 2, { result: 'FAIL', checklist: [{ code: 'A', outcome: 'FAIL' }, { code: 'B', outcome: 'PASS' }] });
      expect(done).toMatchObject({ status: 'RESULT_RECORDED', result: 'FAIL', failedItemCodes: ['A'] });
      const conditional = await request(seeded, { requestedFor: '2026-12-30' });
      await schedule(conditional.id, 1);
      expect(await record(conditional.id, 2, { result: 'CONDITIONAL', checklist: [{ code: 'A', outcome: 'FAIL', note: 'Re-tie before the pour' }, { code: 'B', outcome: 'PASS' }] })).toMatchObject({
        result: 'CONDITIONAL',
        failedItemCodes: ['A'],
      });
      const [line] = await as((tx) => inspections.list(tx, everything, { contractId: seeded.contractId, limit: 1 }));
      expect(line).toMatchObject({ status: 'RESULT_RECORDED', result: 'CONDITIONAL', resultNote: 'Rebar and cover are right.' });
    });

    it('refuses a checklist that is not complete, a result that contradicts it, and a shape that is not one', async () => {
      const seeded = await seedContract();
      const made = await request(seeded);
      await schedule(made.id, 1);
      expect(await refusal(record(made.id, 2, { checklist: [{ code: 'A', outcome: 'PASS' }] }))).toMatchObject({ code: 'CHECKLIST_INCOMPLETE', status: 422, extensions: { reason: 'ITEMS_MISSING', codes: ['B'] } });
      expect(await refusal(record(made.id, 2, { checklist: [] }))).toMatchObject({ code: 'CHECKLIST_INCOMPLETE', extensions: { reason: 'ITEMS_MISSING', codes: ['A', 'B'] } });
      expect(await refusal(record(made.id, 2, { checklist: [...PASSED, { code: 'Z', outcome: 'PASS' }] }))).toMatchObject({ extensions: { reason: 'ANSWER_UNKNOWN' } });
      expect(await refusal(record(made.id, 2, { result: 'PASS', checklist: [{ code: 'A', outcome: 'FAIL' }, { code: 'B', outcome: 'PASS' }] }))).toMatchObject({ extensions: { reason: 'RESULT_CONTRADICTS' } });
      expect(await refusal(record(made.id, 2, { result: 'FAIL' }))).toMatchObject({ extensions: { reason: 'RESULT_CONTRADICTS' } });
      expect(await refusal(record(made.id, 2, { result: 'CONDITIONAL', checklist: [{ code: 'A', outcome: 'FAIL' }, { code: 'B', outcome: 'PASS' }] }))).toMatchObject({ extensions: { reason: 'CONDITION_UNSTATED' } });
      expect(await refusal(record(made.id, 2, { result: 'SOMETHING' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'result' });
      expect(await refusal(record(made.id, 2, { resultNote: ' ' }))).toMatchObject({ detail: 'result_note' });
      expect(await refusal(record(made.id, 2, { checklist: 'x' as never }))).toMatchObject({ detail: 'checklist' });
      expect(await refusal(record(made.id, 9))).toMatchObject({ status: 409 });
      expect(await refusal(record(made.id, 2, {}, { scopes: readOnly }))).toMatchObject({ status: 403 });
      expect((await rowOf(made.id))?.status).toBe('SCHEDULED');
    });

    it('takes an inspection with no checklist in its regime with an empty one, and none for a kind the regime has no list for', async () => {
      const seeded = await seedContract();
      const made = await request(seeded, { inspectionType: 'MATERIAL_ENTRY' });
      expect(await rowOf(made.id)).toMatchObject({ checklist: [] });
      await schedule(made.id, 1);
      expect(await record(made.id, 2, { checklist: [] })).toMatchObject({ status: 'RESULT_RECORDED', result: 'PASS' });
    });
  });

  describe('cancelling', () => {
    it('cancels a requested or a scheduled inspection with the reason, and nothing after that', async () => {
      const seeded = await seedContract();
      const requested = await request(seeded, { requestedFor: '2026-12-29' });
      expect(await cancel(requested.id, 1, '  Not needed.  ')).toMatchObject({ status: 'CANCELLED', fromStatus: 'REQUESTED', version: 2 });
      const [row] = await owner<{ cancel_reason: string; cancelled_at: string | null; status: string }>('select cancel_reason, cancelled_at::text, status from machvon.inspection where id = $1::uuid', [requested.id]);
      expect(row).toMatchObject({ status: 'CANCELLED', cancel_reason: 'Not needed.' });
      expect(row?.cancelled_at).not.toBeNull();
      const scheduled = await request(seeded, { requestedFor: '2026-12-30' });
      await schedule(scheduled.id, 1);
      expect(await cancel(scheduled.id, 2)).toMatchObject({ status: 'CANCELLED', fromStatus: 'SCHEDULED' });
      expect(await refusal(cancel(scheduled.id, 3))).toMatchObject({ code: 'INSPECTION_STATE_INVALID', extensions: { inspection_status: 'CANCELLED' } });
      expect(await refusal(schedule(scheduled.id, 3))).toMatchObject({ code: 'INSPECTION_STATE_INVALID' });
      const third = await request(seeded, { requestedFor: '2026-12-31', inspectionType: 'SAFETY' });
      expect(await refusal(cancel(third.id, 1, ' '))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'reason' });
      expect(await refusal(cancel(third.id, 4))).toMatchObject({ status: 409 });
      expect(await refusal(cancel(third.id, 1, 'why', invisible))).toMatchObject({ status: 404 });
    });
  });

  describe('the register and the guards of the database', () => {
    it('lists the inspections of the contracts in the scope, the latest day first, and finds one', async () => {
      const seeded = await seedContract();
      const first = await request(seeded, { requestedFor: '2026-12-25' });
      const second = await request(seeded, { requestedFor: '2026-12-31' });
      const other = await seedContract();
      await request(other);
      const lines = await as((tx) => inspections.list(tx, everything, { contractId: seeded.contractId }));
      expect(lines.map((line) => line.id)).toEqual([second.id, first.id]);
      expect((await as((tx) => inspections.list(tx, everything, {}))).length).toBeGreaterThanOrEqual(3);
      expect(await as((tx) => inspections.list(tx, nothing, {}))).toEqual([]);
      expect((await as((tx) => inspections.find(tx, first.id, everything)))?.inspectionNo).toBe('KT-001');
      expect(await as((tx) => inspections.find(tx, first.id, nothing))).toBeUndefined();
      expect(await as((tx) => inspections.find(tx, randomUUID(), everything))).toBeUndefined();
    });

    it('keeps what an inspection says, its edges and its shape, and does not delete one', async () => {
      const seeded = await seedContract();
      const made = await request(seeded);
      const update = (sql: string) => databaseRefusal(owner(`update machvon.inspection set ${sql} where id = $1::uuid`, [made.id]));
      expect((await update(`required_roles = '["OWNER"]'::jsonb`)).message).toMatch(/never changes/);
      expect((await update(`inspection_type = 'SAFETY'`)).message).toMatch(/never changes/);
      expect((await update(`regime_rule_version_id = gen_random_uuid()`)).message).toMatch(/never changes/);
      expect((await update(`title = 'another'`)).message).toMatch(/never changes/);
      expect((await update(`status = 'RESULT_RECORDED', result = 'PASS', result_note = 'x', result_recorded_by = created_by, result_recorded_at = now()`)).message).toMatch(/INSPECTION_STATE_INVALID|inspection_scheduled_chk/);
      expect((await update(`status = 'SCHEDULED'`)).message).toMatch(/inspection_scheduled_chk/);
      expect((await update(`status = 'CANCELLED'`)).message).toMatch(/inspection_cancel_chk/);
      expect((await update(`result = 'PASS'`)).message).toMatch(/inspection_recorded_chk/);
      expect((await databaseRefusal(as((tx) => tx.query('delete from machvon.inspection where id = $1::uuid', [made.id])))).sqlstate).toBe('42501');
      const insert = (overrides: string) =>
        databaseRefusal(
          owner(
            `insert into machvon.inspection (tenant_id, id, project_id, contract_id, inspection_no, inspection_type, title, requested_by, requested_for, status, created_by, updated_by, ${overrides.split('|')[0]})
             values ($1, gen_random_uuid(), $2, $3, $4, 'SAFETY', 'x', $5, date '2026-12-31', 'REQUESTED', $5, $5, ${overrides.split('|')[1]})`,
            [TENANT_A, PROJECT, seeded.contractId, `KT-${randomUUID().slice(0, 6)}`, memberId(REQUESTER)],
          ),
        );
      expect((await insert(`regime_awaiting_confirmation|true`)).message).toMatch(/inspection_regime_chk/);
      expect((await insert(`required_roles|'{}'::jsonb`)).message).toMatch(/inspection_lists_chk/);
      const duplicateNumber = await databaseRefusal(
        owner(
          `insert into machvon.inspection (tenant_id, id, project_id, contract_id, inspection_no, inspection_type, title, requested_by, requested_for, status, created_by, updated_by)
           values ($1, gen_random_uuid(), $2, $3, 'KT-001', 'SAFETY', 'x', $4, date '2026-11-01', 'REQUESTED', $4, $4)`,
          [TENANT_A, PROJECT, seeded.contractId, memberId(REQUESTER)],
        ),
      );
      expect(duplicateNumber.sqlstate).toBe('23505');
    });
  });
});
