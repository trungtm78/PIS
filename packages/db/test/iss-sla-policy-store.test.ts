import { randomUUID } from 'node:crypto';
import { vietnamDateOf } from '@machvon/kernel';
import { IssSlaDeadlines } from '../src/iss-sla-deadline';
import { IssSlaPolicyStore } from '../src/iss-sla-policy-store';
import type { SlaPolicyInput } from '../src/iss-sla-policy-store';
import { MasterStore } from '../src/master-store';
import type { MasterContent } from '../src/master-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, id, memberId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const masters = new MasterStore();
const STEWARD = 1;
const CHECKER = 2;
const PUBLISHER = 3;
const ACTOR = memberId(STEWARD);
const DECISION_DOCUMENT = id(0x70, 1);
/** The day the tests stand on: a policy may begin on it or later, never before. */
const TODAY = '2026-08-01';
const policies = new IssSlaPolicyStore({ today: () => TODAY });
const deadlines = new IssSlaDeadlines(policies);
const UNIT_1 = unitId(1);
const UNIT_2 = unitId(2);

const as = <T>(work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A, member = STEWARD): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
/** A moment written in Vietnam time (UTC+7). */
const vn = (iso: string): Date => new Date(`${iso}+07:00`);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }) };
  }
  throw new Error('expected a refusal');
}

const content = (overrides: Partial<MasterContent> = {}): MasterContent => ({ label: 'Category', attributes: {}, parentRecordId: null, validFrom: '2024-01-01', validUntil: null, legalBasis: null, ...overrides });

/** A published entry of the tenant and the version in force of it. */
async function inForce(masterType: string, key: string, attributes: Record<string, unknown> = {}, tenant = TENANT_A): Promise<{ recordId: string; versionId: string }> {
  const created = await as((tx) => masters.propose(tx, { masterType, businessKey: key, content: content({ label: `Label of ${key}`, attributes }), reason: 'Initial catalogue entry' }, memberId(STEWARD)), tenant, STEWARD);
  const submitted = await as((tx) => masters.submit(tx, created.changeRequestId, 1, memberId(STEWARD)), tenant, STEWARD);
  await as((tx) => masters.decide(tx, created.changeRequestId, submitted.version, 'approve', memberId(CHECKER)), tenant, CHECKER);
  const record = await as((tx) => masters.findRecord(tx, created.recordId), tenant, PUBLISHER);
  await as((tx) => masters.publish(tx, created.recordId, record?.version ?? 0, DECISION_DOCUMENT, memberId(PUBLISHER)), tenant, PUBLISHER);
  const versions = await owner<{ current_version_id: string }>('select current_version_id from machvon.master_record where id = $1::uuid', [created.recordId], tenant);
  return { recordId: created.recordId, versionId: versions[0]?.current_version_id ?? '' };
}

const policy = (categoryVersionId: string, overrides: Partial<SlaPolicyInput> = {}): SlaPolicyInput => ({
  code: 'SLA-TEST',
  categoryVersionId,
  severity: 'HIGH',
  calendarCode: 'WORKDAY_VN',
  responseHours: 4,
  resolveHours: 16,
  validFrom: '2026-08-15',
  ...overrides,
});
const publish = (input: SlaPolicyInput, tenant = TENANT_A) => as((tx) => policies.publish(tx, input, ACTOR), tenant);

let counter = 0;
/** A category that no other test uses, so each test owns its policies. */
async function category(): Promise<{ recordId: string; versionId: string }> {
  counter += 1;
  return inForce('ISSUE_CATEGORY', `CAT-${counter}-${randomUUID().slice(0, 6)}`);
}

async function seedCalendar(tenant: string, year: number, n: number, extras: { holidays?: string[]; compensated?: string[] }): Promise<string> {
  const calendarId = id(0x71, n);
  await owner(
    `insert into machvon.work_calendar_version (tenant_id, id, calendar_code, year, revision, working_days, holidays, compensated_workdays, legal_basis_ref, status, created_by, published_by, published_at)
     values ($1, $2, 'WORKDAY_VN', $3, 1, '[1,2,3,4,5]'::jsonb, $4::jsonb, $5::jsonb, 'Labour Code 2019, Article 112', 'Published', $6, $6, now())`,
    [tenant, calendarId, year, JSON.stringify((extras.holidays ?? []).map((date) => ({ date, name: 'Holiday' }))), JSON.stringify(extras.compensated ?? []), memberId(STEWARD)],
    tenant,
  );
  return calendarId;
}

describe('IssSlaPolicyStore and IssSlaDeadlines (SLA policies by category, severity and unit on the working calendar, ST-ISS-001)', () => {
  let calendar2026: string;

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: 1, path: '/u1/' },
        { n: 2, path: '/u2/' },
      ]);
      for (const n of [STEWARD, CHECKER, PUBLISHER]) await harness.seedMembership(tenant, n, 1);
      await harness.owner(tenant, [
        [
          `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by)
           values ($1, $2, 'INCOMING', 'CV', 'Decision', 'INTERNAL', $3, $3)`,
          [tenant, DECISION_DOCUMENT, memberId(STEWARD)],
        ],
      ]);
    }
    // 31 August 2026 is a holiday and Saturday 29 August is a make-up working day; 2027 has no special day.
    calendar2026 = await seedCalendar(TENANT_A, 2026, 1, { holidays: ['2026-08-31'], compensated: ['2026-08-29'] });
    await seedCalendar(TENANT_A, 2027, 2, {});
    await seedCalendar(TENANT_B, 2026, 3, {});
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('the deadline on the working calendar', () => {
    it('skips the weekend and the holiday, counts the make-up day, and returns the policy version with the calculation (AC-ST-ISS-001-1)', async () => {
      const { versionId } = await category();
      const published = await publish(policy(versionId, { code: 'SLA-AC1' }));
      expect(published).toMatchObject({ revision: 1, version: 1, supersededId: null });
      // Friday 28 August 16:00, 16 working hours: 1 hour on Friday, 9.5 on the make-up Saturday, then 5.5 hours on Tuesday 1 September (Monday is a holiday).
      const result = await as((tx) => deadlines.calculate(tx, { categoryVersionId: versionId, severity: 'HIGH', ownerUnitId: null, startAt: vn('2026-08-28T16:00:00') }));
      expect(result.dueAt.toISOString()).toBe('2026-09-01T06:00:00.000Z');
      expect(result.responseDueAt.toISOString()).toBe('2026-08-29T03:30:00.000Z');
      expect(result.policy).toMatchObject({ id: published.id, code: 'SLA-AC1', revision: 1, resolveHours: 16, calendarCode: 'WORKDAY_VN' });
      expect(result.calendarVersionIds).toEqual([calendar2026]);
    });

    it('moves a start outside working time to the next window, and runs into the next year on its calendar', async () => {
      const { versionId } = await category();
      await publish(policy(versionId, { code: 'SLA-WINDOW', responseHours: 4, resolveHours: 4, validFrom: '2026-12-01' }));
      const calculate = (startAt: string) => as((tx) => deadlines.calculate(tx, { categoryVersionId: versionId, severity: 'HIGH', ownerUnitId: null, startAt: vn(startAt) }));
      // Saturday 10:00 begins on Monday 07:30.
      expect((await calculate('2026-12-26T10:00:00')).dueAt.toISOString()).toBe('2026-12-28T04:30:00.000Z');
      // Thursday 31 December 16:00 plus 4 hours: 1 hour that day and 3 hours on Friday 1 January, on the calendar of 2027.
      const newYear = await calculate('2026-12-31T16:00:00');
      expect(newYear.dueAt.toISOString()).toBe('2027-01-01T03:30:00.000Z');
      expect(newYear.calendarVersionIds).toHaveLength(2);
    });

    it('refuses a day without a policy (SLA_POLICY_MISSING) and a year without a calendar (CALENDAR_NOT_EFFECTIVE)', async () => {
      const { versionId } = await category();
      await publish(policy(versionId, { code: 'SLA-GAPS' }));
      const calculate = (startAt: string, severity = 'HIGH') => as((tx) => deadlines.calculate(tx, { categoryVersionId: versionId, severity, ownerUnitId: null, startAt: vn(startAt) }));
      expect(await refusal(calculate('2026-08-14T10:00:00'))).toEqual({ code: 'SLA_POLICY_MISSING', status: 422 });
      expect(await refusal(calculate('2026-08-20T10:00:00', 'LOW'))).toEqual({ code: 'SLA_POLICY_MISSING', status: 422 });
      expect(await refusal(calculate('2028-01-03T10:00:00'))).toEqual({ code: 'CALENDAR_NOT_EFFECTIVE', status: 422, detail: 'year' });
      // The count that starts in 2027 and needs days of 2028 fails the same way: a deadline is never guessed.
      expect(await refusal(calculate('2027-12-31T16:00:00'))).toEqual({ code: 'CALENDAR_NOT_EFFECTIVE', status: 422, detail: 'year' });
    });
  });

  describe('which version applies', () => {
    it('keeps the version an issue was created under: a new revision applies from its date and not before (UAT-AC350)', async () => {
      const { versionId } = await category();
      const first = await publish(policy(versionId, { code: 'SLA-GPMB-HIGH', responseHours: 4, resolveHours: 72 }));
      const second = await publish(policy(versionId, { code: 'SLA-GPMB-HIGH', responseHours: 4, resolveHours: 48, validFrom: '2026-09-01' }));
      expect(second).toMatchObject({ revision: 2, version: 1, supersededId: first.id });
      const calculate = (startAt: string) => as((tx) => deadlines.calculate(tx, { categoryVersionId: versionId, severity: 'HIGH', ownerUnitId: null, startAt: vn(startAt) }));
      expect((await calculate('2026-08-20T09:00:00')).policy).toMatchObject({ id: first.id, revision: 1, resolveHours: 72 });
      expect((await calculate('2026-08-31T16:59:00')).policy).toMatchObject({ id: first.id, revision: 1 });
      const later = await calculate('2026-09-02T09:00:00');
      expect(later.policy).toMatchObject({ id: second.id, revision: 2, resolveHours: 48 });
      // 48 working hours from Wednesday 2 September 09:00 on a 9.5-hour window: 8 hours that day, 9.5 on each of the next four working days, 2 on Wednesday 9 September.
      expect(later.dueAt.toISOString()).toBe('2026-09-09T02:30:00.000Z');
      expect(await as((tx) => policies.find(tx, first.id))).toMatchObject({ status: 'RETIRED', validUntil: '2026-09-01', version: 2, resolveHours: 72, revision: 1 });
    });

    it('prefers the policy of the unit to the default of the tenant, from the day it begins', async () => {
      const { versionId } = await category();
      const base = await publish(policy(versionId, { code: 'SLA-DEFAULT', resolveHours: 40 }));
      const unit = await publish(policy(versionId, { code: 'SLA-UNIT', ownerUnitId: UNIT_1, resolveHours: 24, validFrom: '2026-09-01' }));
      const pick = (ownerUnitId: string | null, on: string) => as((tx) => policies.inForce(tx, { categoryVersionId: versionId, severity: 'HIGH', ownerUnitId, on }));
      expect((await pick(UNIT_1, '2026-08-31'))?.id).toBe(base.id);
      expect((await pick(UNIT_1, '2026-09-01'))?.id).toBe(unit.id);
      expect((await pick(UNIT_2, '2026-09-01'))?.id).toBe(base.id);
      expect((await pick(null, '2026-09-01'))?.id).toBe(base.id);
    });

    it('finds the policy of a category after the category is renamed, and refuses a version that is no longer in force', async () => {
      const { recordId, versionId } = await category();
      const written = await publish(policy(versionId, { code: 'SLA-RENAME' }));
      const today = vietnamDateOf(new Date());
      const change = await as((tx) => masters.createChange(tx, { kind: 'UPDATE', masterType: 'ISSUE_CATEGORY', masterRecordId: recordId, proposed: { label: 'Renamed category' }, effectiveFrom: today, reason: 'Rename' }, memberId(STEWARD)));
      const submitted = await as((tx) => masters.submit(tx, change.id, change.version, memberId(STEWARD)));
      await as((tx) => masters.decide(tx, change.id, submitted.version, 'approve', memberId(CHECKER)), TENANT_A, CHECKER);
      const record = await as((tx) => masters.findRecord(tx, recordId), TENANT_A, PUBLISHER);
      await as((tx) => masters.publish(tx, recordId, record?.version ?? 0, DECISION_DOCUMENT, memberId(PUBLISHER)), TENANT_A, PUBLISHER);
      const renamed = (await owner<{ current_version_id: string }>('select current_version_id from machvon.master_record where id = $1::uuid', [recordId]))[0]?.current_version_id ?? '';
      expect(renamed).not.toBe(versionId);
      const found = await as((tx) => policies.inForce(tx, { categoryVersionId: renamed, severity: 'HIGH', ownerUnitId: null, on: '2026-08-20' }));
      expect(found).toMatchObject({ id: written.id, categoryVersionId: versionId, categoryRecordId: recordId });
      // A new revision may be written against the new version of the category; the old version is retired and takes no new policy.
      expect(await publish(policy(renamed, { code: 'SLA-RENAME', validFrom: '2026-09-10' }))).toMatchObject({ revision: 2 });
      expect(await refusal(publish(policy(versionId, { code: 'SLA-OTHER', severity: 'LOW' })))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'category_version_id' });
    });
  });

  describe('overlap and retirement', () => {
    it('refuses a second policy for the same category, severity and unit while the first applies, and keeps the first as it was (AC-ST-ISS-001-2)', async () => {
      const { versionId } = await category();
      const first = await publish(policy(versionId, { code: 'SLA-FIRST', validFrom: '2026-08-15' }));
      expect(await refusal(publish(policy(versionId, { code: 'SLA-SECOND', validFrom: '2026-09-01' })))).toEqual({ code: 'SLA_POLICY_OVERLAP', status: 409 });
      expect(await refusal(publish(policy(versionId, { code: 'SLA-SECOND', validFrom: '2026-08-15', resolveHours: 20 })))).toEqual({ code: 'SLA_POLICY_OVERLAP', status: 409 });
      // Another severity and another unit are other keys.
      await publish(policy(versionId, { code: 'SLA-OTHER-SEVERITY', severity: 'LOW' }));
      await publish(policy(versionId, { code: 'SLA-OTHER-UNIT', ownerUnitId: UNIT_2 }));
      expect(await as((tx) => policies.find(tx, first.id))).toMatchObject({ code: 'SLA-FIRST', status: 'ACTIVE', validUntil: null, version: 1, resolveHours: 16 });
      expect(await as((tx) => policies.list(tx, { code: 'SLA-SECOND' }, { limit: 10, after: undefined }))).toEqual([]);
    });

    it('ends a policy from a date without touching what it said, and then frees the key from that date (AC-ST-ISS-001-2)', async () => {
      const { versionId } = await category();
      const written = await publish(policy(versionId, { code: 'SLA-ENDING' }));
      const retired = await as((tx) => policies.retire(tx, written.id, '2026-10-01', ACTOR));
      expect(retired.version).toBe(2);
      const row = await as((tx) => policies.find(tx, written.id));
      expect(row).toMatchObject({ status: 'RETIRED', validUntil: '2026-10-01', version: 2, responseHours: 4, resolveHours: 16, revision: 1, validFrom: '2026-08-15' });
      const pick = (on: string) => as((tx) => policies.inForce(tx, { categoryVersionId: versionId, severity: 'HIGH', ownerUnitId: null, on }));
      // Until its end date the version still applies to the issues created under it; from that date nothing applies.
      expect((await pick('2026-09-30'))?.id).toBe(written.id);
      expect(await pick('2026-10-01')).toBeUndefined();
      expect(await refusal(as((tx) => policies.retire(tx, written.id, '2026-11-01', ACTOR)))).toEqual({ code: 'SLA_POLICY_STATE_INVALID', status: 409, detail: 'status' });
      expect(await refusal(publish(policy(versionId, { code: 'SLA-NEXT', validFrom: '2026-09-30' })))).toEqual({ code: 'SLA_POLICY_OVERLAP', status: 409 });
      const next = await publish(policy(versionId, { code: 'SLA-NEXT', validFrom: '2026-10-01' }));
      expect((await pick('2026-10-01'))?.id).toBe(next.id);
      // A revision of the retired code may not begin inside the days it covered.
      expect(await refusal(publish(policy(versionId, { code: 'SLA-ENDING', validFrom: '2026-09-15' })))).toEqual({ code: 'SLA_POLICY_OVERLAP', status: 409 });
    });

    it('refuses to retire a policy that is not found, one of another tenant, and an end date that is not after the start or is in the past', async () => {
      const { versionId } = await category();
      const written = await publish(policy(versionId, { code: 'SLA-DATES', validFrom: '2026-09-10' }));
      expect(await refusal(as((tx) => policies.retire(tx, randomUUID(), '2026-12-01', ACTOR)))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(as((tx) => policies.retire(tx, written.id, '2026-12-01', ACTOR), TENANT_B))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      for (const until of ['2026-09-10', '2026-09-09', '2026-07-31', 'soon', '2026-02-30']) {
        expect(await refusal(as((tx) => policies.retire(tx, written.id, until, ACTOR)))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'valid_until' });
      }
      expect(await as((tx) => policies.find(tx, written.id))).toMatchObject({ status: 'ACTIVE', version: 1 });
    });

    it('has the database refuse what the checks of the store missed: an overlap, a changed version, a deleted version', async () => {
      const { recordId, versionId } = await category();
      const written = await publish(policy(versionId, { code: 'SLA-LAST-WORD' }));
      const raw = (status: string, from: string, until: string | null) =>
        owner(
          `insert into machvon.issue_sla_policy (tenant_id, id, code, revision, category_version_id, category_record_id, severity, calendar_code, response_hours, resolve_hours, valid_from, valid_until, status, created_by, updated_by)
           values ($1, $2, $6, 1, $3, $4, 'HIGH', 'WORKDAY_VN', 1, 2, $7::date, $8::date, $9, $5, $5)`,
          [TENANT_A, randomUUID(), versionId, recordId, ACTOR, `SLA-RAW-${from}`, from, until, status],
        );
      const sqlState = async (work: Promise<unknown>): Promise<string> => {
        try {
          await work;
        } catch (error) {
          return (error as { code?: string }).code ?? '';
        }
        return 'none';
      };
      // An ended row inside the period of the active one is an overlap; the exclusion constraint says so even where the unique index does not.
      expect(await sqlState(raw('RETIRED', '2026-09-01', '2026-09-30'))).toBe('23P01');
      expect(await sqlState(raw('ACTIVE', '2026-09-01', '2026-09-30'))).toBe('23514');
      expect(await sqlState(raw('RETIRED', '2026-09-30', '2026-09-01'))).toBe('23514');
      expect(await sqlState(owner('update machvon.issue_sla_policy set resolve_hours = 99 where id = $1::uuid', [written.id]))).toBe('23514');
      expect(await sqlState(owner("update machvon.issue_sla_policy set code = 'OTHER' where id = $1::uuid", [written.id]))).toBe('23514');
      expect(await sqlState(as((tx) => tx.query('delete from machvon.issue_sla_policy where id = $1::uuid', [written.id])))).toBe('42501');
      await as((tx) => policies.retire(tx, written.id, '2026-12-01', ACTOR));
      expect(await sqlState(owner("update machvon.issue_sla_policy set status = 'ACTIVE', valid_until = null where id = $1::uuid", [written.id]))).toBe('23514');
      expect(await as((tx) => policies.find(tx, written.id))).toMatchObject({ status: 'RETIRED', resolveHours: 16 });
    });

    it('does not let a revision of an ended policy begin inside the days the policy covered', async () => {
      const { versionId } = await category();
      const written = await publish(policy(versionId, { code: 'SLA-COVERED' }));
      await as((tx) => policies.retire(tx, written.id, '2026-10-01', ACTOR));
      expect(await refusal(publish(policy(versionId, { code: 'SLA-COVERED', validFrom: '2026-09-15' })))).toEqual({ code: 'SLA_POLICY_OVERLAP', status: 409 });
      expect(await publish(policy(versionId, { code: 'SLA-COVERED', validFrom: '2026-10-01' }))).toMatchObject({ revision: 2, supersededId: null });
    });

    it('turns the refusal of the database into an overlap when a racing publication got past the checks, and lets any other failure through', async () => {
      const { versionId } = await category();
      const failing = (failure: Error) => (tx: TenantTx): TenantTx => ({
        query: (sql, params) => (sql.includes('insert into machvon.issue_sla_policy') ? Promise.reject(failure) : tx.query(sql, params)),
      });
      const fail = (failure: Error) => refusal(as((tx) => policies.publish(failing(failure)(tx), policy(versionId, { code: 'SLA-RACING' }), ACTOR)));
      expect(await fail(Object.assign(new Error('exclusion'), { code: '23P01' }))).toEqual({ code: 'SLA_POLICY_OVERLAP', status: 409 });
      expect(await fail(Object.assign(new Error('unique'), { code: '23505', constraint: 'issue_sla_policy_active_uq' }))).toEqual({ code: 'SLA_POLICY_OVERLAP', status: 409 });
      expect(await fail(Object.assign(new Error('unique'), { code: '23505', constraint: 'issue_sla_policy_rev_uq' }))).toEqual({ code: '23505', status: 0 });
      expect(await fail(new Error('connection lost'))).toEqual({ code: '', status: 0 });
    });

    it('serialises two publications for the same key: one wins and the other is an overlap', async () => {
      const { versionId } = await category();
      const results = await Promise.allSettled([publish(policy(versionId, { code: 'SLA-RACE-A' })), publish(policy(versionId, { code: 'SLA-RACE-B' }))]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const failed = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
      expect(failed.reason).toMatchObject({ code: 'SLA_POLICY_OVERLAP', status: 409 });
    });
  });

  describe('what a policy must say', () => {
    const bad = async (overrides: Partial<SlaPolicyInput>, field: string, versionId?: string) => {
      const base = versionId ?? (await category()).versionId;
      expect(await refusal(publish(policy(base, { code: 'SLA-BAD', ...overrides })))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: field });
    };

    it.each([
      [{ code: '' }, 'code'],
      [{ code: 'has space' }, 'code'],
      [{ code: 'x'.repeat(101) }, 'code'],
      [{ calendarCode: '' }, 'calendar_code'],
      [{ calendarCode: 'y'.repeat(41) }, 'calendar_code'],
      [{ severity: 'URGENT' }, 'severity'],
      [{ responseHours: 0 }, 'response_hours'],
      [{ responseHours: 1.5 }, 'response_hours'],
      [{ responseHours: 20, resolveHours: 10 }, 'resolve_hours'],
      [{ resolveHours: 2401 }, 'resolve_hours'],
      [{ escalateL2Pct: 0 }, 'escalate_l2_pct'],
      [{ escalateL2Pct: 150, escalateL3Pct: 150 }, 'escalate_l3_pct'],
      [{ escalateL3Pct: 1001 }, 'escalate_l3_pct'],
      [{ validFrom: 'next week' }, 'valid_from'],
      [{ validFrom: '2026-02-30' }, 'valid_from'],
      [{ validFrom: '2026-07-31' }, 'valid_from'],
      [{ calendarCode: 'NO_SUCH_CALENDAR' }, 'calendar_code'],
      [{ ownerUnitId: randomUUID() }, 'owner_unit_id'],
    ] as Array<[Partial<SlaPolicyInput>, string]>)('refuses %j naming %s and writes nothing', async (overrides, field) => {
      await bad(overrides, field);
      expect(await owner("select count(*)::int as n from machvon.issue_sla_policy where code = 'SLA-BAD'")).toEqual([{ n: 0 }]);
    });

    it('refuses a category version that does not exist, one of another tenant and one of another type', async () => {
      await bad({}, 'category_version_id', randomUUID());
      await bad({}, 'category_version_id', (await inForce('ISSUE_CATEGORY', `FOREIGN-${randomUUID().slice(0, 6)}`, {}, TENANT_B)).versionId);
      await owner("insert into machvon.master_type_policy (tenant_id, master_type, scope, updated_by) values ($1, 'FUND_SOURCE', 'TENANT_ONLY', $2) on conflict do nothing", [TENANT_A, ACTOR]);
      const other = await inForce('FUND_SOURCE', `FS-${randomUUID().slice(0, 6)}`, { category: 'NSTW', relation: 'ADDITIVE' });
      await bad({}, 'category_version_id', other.versionId);
    });

    it('does not let a code move to another category, severity or unit, nor a revision begin on or before the one in force', async () => {
      const { versionId } = await category();
      await publish(policy(versionId, { code: 'SLA-FIXED', validFrom: '2026-09-10' }));
      await bad({ code: 'SLA-FIXED', severity: 'LOW', validFrom: '2026-10-01' }, 'code', versionId);
      await bad({ code: 'SLA-FIXED', ownerUnitId: UNIT_1, validFrom: '2026-10-01' }, 'code', versionId);
      await bad({ code: 'SLA-FIXED', validFrom: '2026-09-10' }, 'valid_from', versionId);
      await bad({ code: 'SLA-FIXED', validFrom: '2026-08-20' }, 'valid_from', versionId);
      await bad({ code: 'SLA-FIXED', validFrom: '2026-10-01' }, 'code', (await category()).versionId);
    });

    it('uses the defaults of the contract when the thresholds and the flags are left out, and keeps those that are given', async () => {
      const { versionId } = await category();
      const defaults = await publish(policy(versionId, { code: 'SLA-DEFAULTS' }));
      expect(await as((tx) => policies.find(tx, defaults.id))).toMatchObject({ escalateL2Pct: 100, escalateL3Pct: 150, requireIndependentVerifier: true, requireEvidence: true, ownerUnitId: null });
      const given = await publish(policy(versionId, { code: 'SLA-GIVEN', severity: 'LOW', escalateL2Pct: 80, escalateL3Pct: 120, requireIndependentVerifier: false, requireEvidence: false, ownerUnitId: UNIT_1 }));
      expect(await as((tx) => policies.find(tx, given.id))).toMatchObject({ escalateL2Pct: 80, escalateL3Pct: 120, requireIndependentVerifier: false, requireEvidence: false, ownerUnitId: UNIT_1 });
    });
  });

  describe('reading', () => {
    it('lists the versions of the tenant by category, code, severity, unit and status, newest first, in pages, and never those of another tenant', async () => {
      const { recordId, versionId } = await category();
      const a = await publish(policy(versionId, { code: 'SLA-LIST-A' }));
      const b = await publish(policy(versionId, { code: 'SLA-LIST-B', severity: 'LOW', ownerUnitId: UNIT_1 }));
      const c = await publish(policy(versionId, { code: 'SLA-LIST-C', severity: 'MEDIUM' }));
      await as((tx) => policies.retire(tx, c.id, '2026-12-01', ACTOR));
      const list = (filter: Parameters<IssSlaPolicyStore['list']>[1], after?: { code: string; id: string }, limit = 10) => as((tx) => policies.list(tx, filter, { limit, after }));
      expect((await list({ categoryRecordId: recordId })).map((row) => row.id)).toEqual([c.id, b.id, a.id]);
      expect((await list({ categoryRecordId: recordId, status: 'RETIRED' })).map((row) => row.id)).toEqual([c.id]);
      expect((await list({ categoryRecordId: recordId, severity: 'LOW' })).map((row) => row.id)).toEqual([b.id]);
      expect((await list({ categoryRecordId: recordId, ownerUnitId: UNIT_1 })).map((row) => row.id)).toEqual([b.id]);
      expect((await list({ code: 'SLA-LIST-A' })).map((row) => row.id)).toEqual([a.id]);
      const first = await list({ categoryRecordId: recordId }, undefined, 2);
      const last = first[first.length - 1];
      expect(first.map((row) => row.id)).toEqual([c.id, b.id]);
      expect((await list({ categoryRecordId: recordId }, { code: last?.createdAtKey ?? '', id: last?.id ?? '' }, 2)).map((row) => row.id)).toEqual([a.id]);
      expect(await as((tx) => policies.list(tx, { categoryRecordId: recordId }, { limit: 10, after: undefined }), TENANT_B)).toEqual([]);
      expect(await as((tx) => policies.find(tx, a.id), TENANT_B)).toBeUndefined();
      const [shown] = await list({ code: 'SLA-LIST-A' });
      expect(shown?.categoryKey).toMatch(/^CAT-/);
      expect(shown?.categoryLabel).toMatch(/^Label of CAT-/);
    });
  });

  describe('the real clock', () => {
    it('refuses a start date in the past with the default clock of the store', async () => {
      const { versionId } = await category();
      const real = new IssSlaPolicyStore();
      const refused = await refusal(as((tx) => real.publish(tx, policy(versionId, { code: 'SLA-REAL', validFrom: '2020-01-01' }), ACTOR)));
      expect(refused).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'valid_from' });
    });
  });
});
