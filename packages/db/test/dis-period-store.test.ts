import { randomUUID } from 'node:crypto';
import { CollectingTelemetry, reportingPeriods } from '@machvon/kernel';
import { AuditWriter } from '../src/audit-writer';
import { DisPeriodAutoclose, workingHoursPerDay } from '../src/dis-period-autoclose';
import { DIS_PERIOD_TRANSITION_METRIC, DisPeriodStore, periodMoveRecord, submitLabels, transitionLabels } from '../src/dis-period-store';
import type { PeriodRow, PeriodType } from '../src/dis-period-store';
import { BASELINE_PACK, applyBaseline, sealPack } from '../src/master-baseline';
import { MasterStore } from '../src/master-store';
import type { BaselineEntry } from '../src/master-baseline';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const periods = new DisPeriodStore();
const masters = new MasterStore();
const ACTOR = 1;
const PROJECT = '00000000-0000-4000-8000-0000000000a1';
const WORKER = '00000000-0000-4000-8000-000000000000';
const calendarEntry = BASELINE_PACK.entries.find((entry) => entry.masterType === 'CALENDAR') as BaselineEntry;
const calendarAt = (validFrom: string, attributes: Record<string, unknown>, legalBasis: string): BaselineEntry => ({ ...calendarEntry, validFrom, legalBasis, attributes: { ...calendarEntry.attributes, ...attributes } });
const at = (instant: string): Date => new Date(instant);

const as = <T>(work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(ACTOR)), work);
const asWorker = <T>(work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant({ tenantId: tenant, membershipId: WORKER, scopeVersion: 0 }, work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }) };
  }
  throw new Error('expected a refusal');
}

const generate = (fiscalYear: number, now: string, tenant = TENANT_A, extra: { calendarCode?: string; periodType?: PeriodType } = {}) =>
  as((tx) => periods.generate(tx, { calendarCode: extra.calendarCode ?? 'DEFAULT', fiscalYear, periodType: extra.periodType ?? 'WEEK' }, memberId(ACTOR), at(now)), tenant);
const byCode = async (code: string, tenant = TENANT_A): Promise<PeriodRow> => {
  const [found] = await owner<{ id: string }>('select id from machvon.reporting_period where code = $1', [code], tenant);
  const row = await as((tx) => periods.find(tx, (found as { id: string }).id), tenant);
  return row as PeriodRow;
};
const reset = (tenant = TENANT_A): Promise<unknown[]> => harness.owner(tenant, [['delete from machvon.period_reopen'], ['delete from machvon.reporting_period']]);

describe('DisPeriodStore (reporting periods: generation, soft close and lock, ST-DIS-001)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [{ n: 1, path: '/u1/' }]);
      await harness.seedMembership(tenant, ACTOR, 1);
    }
    // Tenant A: the calendar of the working assumption D03 (Saturday to Friday, Friday 10:00), confirmed as revision 2 from 1 December 2026.
    await asWorker((tx) => applyBaseline(tx, sealPack('DIS-A-1', [calendarEntry]), WORKER));
    await asWorker((tx) => applyBaseline(tx, sealPack('DIS-A-2', [calendarAt('2026-12-01', {}, 'D03 signed (revision 2)')]), WORKER));
    // Tenant B: weeks from Sunday to Saturday due on Saturday (revision 1), then due on Friday from 1 September 2026 (revision 2).
    await asWorker((tx) => applyBaseline(tx, sealPack('DIS-B-1', [calendarAt('2024-06-01', { week_starts_on: 'SUNDAY', deadline_weekday: 'SATURDAY' }, 'Calendar of the tenant B (1)')]), WORKER), TENANT_B);
    await asWorker((tx) => applyBaseline(tx, sealPack('DIS-B-2', [calendarAt('2026-09-01', { week_starts_on: 'SUNDAY', deadline_weekday: 'FRIDAY' }, 'Calendar of the tenant B (2)')]), WORKER), TENANT_B);
    // The working calendar that counts the days between a deadline and the lock exists for tenant A only (tenant B shows the refusal).
    await harness.owner(TENANT_A, [2026, 2027].map((year): [string, unknown[]] => [
      `insert into machvon.work_calendar_version (tenant_id, id, calendar_code, year, revision, working_days, holidays, compensated_workdays, legal_basis_ref, status, created_by, published_by, published_at)
       values ($1, $2, 'WORKDAY_VN', $3, 1, '[1,2,3,4,5]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'Labour Code 2019, Article 112', 'Published', $4, $4, now())`,
      [TENANT_A, randomUUID(), year, memberId(ACTOR)],
    ]));
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('generation from the reporting calendar', () => {
    afterEach(async () => {
      await reset();
      await reset(TENANT_B);
    });

    it('generates the weeks of 2027 once, each due on Friday at 03:00 UTC, and refuses a second generation as an overlap (AC-ST-DIS-001-3)', async () => {
      const first = await generate(2027, '2026-12-15T00:00:00Z');
      expect(first.periods).toHaveLength(53);
      expect(first.calendar).toMatchObject({ revision: 2, awaitingConfirmation: true });
      first.periods.forEach((period, index) => {
        expect(new Date(period.deadlineAt).getUTCDay()).toBe(5);
        expect(period.deadlineAt.slice(10)).toBe('T03:00:00.000Z');
        const next = first.periods[index + 1];
        if (next !== undefined) expect(Date.parse(next.startDate) - Date.parse(period.endDate)).toBe(86_400_000);
      });
      const stored = await owner<{ n: string; versions: string; revisions: string; statuses: string }>(
        `select count(*)::text as n, count(distinct calendar_version_id)::text as versions, string_agg(distinct calendar_version::text, ',') as revisions, string_agg(distinct status, ',') as statuses
           from machvon.reporting_period where fiscal_year = 2027`,
      );
      expect(stored[0]).toEqual({ n: '53', versions: '1', revisions: '2', statuses: 'OPEN' });
      expect(await refusal(generate(2027, '2026-12-15T00:00:00Z'))).toEqual({ code: 'PERIOD_OVERLAP', status: 409, detail: 'fiscal_year' });
      expect((await owner<{ n: string }>("select count(*)::text as n from machvon.reporting_period where fiscal_year = 2027"))[0]).toEqual({ n: '53' });
      // The year before and the year after fit without a gap or an overlap.
      expect((await generate(2026, '2026-12-15T00:00:00Z')).periods).toHaveLength(reportingPeriods({ weekStartsOn: 'SATURDAY', deadlineWeekday: 'FRIDAY', deadlineTime: '10:00', timezone: 'Asia/Ho_Chi_Minh' }, 2026).length);
      await expect(generate(2028, '2026-12-15T00:00:00Z')).resolves.toBeDefined();
    });

    it('generates the months of the enterprise calendar under codes of their own, beside the weeks of the weekly calendar, once (ENT-3a)', async () => {
      const weeks = await generate(2026, '2026-12-15T00:00:00Z');
      const months = await generate(2026, '2026-12-15T00:00:00Z', TENANT_A, { calendarCode: 'ENTERPRISE', periodType: 'MONTH' });
      expect(months.periods).toHaveLength(12);
      expect(months.periods.map((period) => period.code)).toEqual(expect.arrayContaining([expect.stringMatching(/^ENT-/)]));
      expect(months.periods.every((period) => period.code.startsWith('ENT-'))).toBe(true);
      expect(months.periods.every((period) => weeks.periods.every((week) => week.code !== period.code))).toBe(true);
      // The months are calendar months, as the enterprise snapshot asks of a period (`periodRefOf`).
      expect(months.periods[0]).toMatchObject({ startDate: '2026-01-01', endDate: '2026-01-31' });
      expect(months.periods[10]).toMatchObject({ startDate: '2026-11-01', endDate: '2026-11-30' });
      const stored = await owner<{ calendar_code: string; period_type: string; n: string }>(
        `select calendar_code, period_type, count(*)::text as n from machvon.reporting_period where calendar_code = 'ENTERPRISE' group by 1, 2`,
      );
      expect(stored).toEqual([{ calendar_code: 'ENTERPRISE', period_type: 'MONTH', n: '12' }]);
      expect(await refusal(generate(2026, '2026-12-15T00:00:00Z', TENANT_A, { calendarCode: 'ENTERPRISE', periodType: 'MONTH' }))).toEqual({ code: 'PERIOD_OVERLAP', status: 409, detail: 'fiscal_year' });
      // The enterprise calendar has no weeks.
      expect(await refusal(generate(2027, '2026-12-15T00:00:00Z', TENANT_A, { calendarCode: 'ENTERPRISE', periodType: 'WEEK' }))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'period_type' });
    });

    it('binds the periods to the calendar in force on the later of the day of the request and 1 January of the year', async () => {
      const early = await generate(2026, '2026-09-01T00:00:00Z');
      expect(early.calendar.revision).toBe(1);
      const later = await generate(2027, '2026-12-15T00:00:00Z');
      expect(later.calendar.revision).toBe(2);
      const rows = await owner<{ year: number; revision: number; version: string }>('select fiscal_year as year, calendar_version as revision, calendar_version_id as version from machvon.reporting_period group by 1, 2, 3 order by 1');
      expect(rows.map((row) => [row.year, row.revision])).toEqual([[2026, 1], [2027, 2]]);
      expect(rows[0]?.version).toBe(early.calendar.versionId);
      expect(rows[1]?.version).toBe(later.calendar.versionId);
      // The calendar entry shows the periods that were generated from it, so a change of the calendar is judged with that in view.
      const [entry] = await owner<{ master_record_id: string }>('select master_record_id from machvon.master_record_version where id = $1', [early.calendar.versionId]);
      const impact = await as((tx) => masters.impactOf(tx, (entry as { master_record_id: string }).master_record_id));
      expect(impact.counts['reporting_period.calendar_version_id']).toBe(early.periods.length + later.periods.length);
      // A year that begins later than the request is read as of its first day: the calendar that will be in force then.
      expect((await generate(2028, '2026-09-01T00:00:00Z')).calendar.revision).toBe(2);
    });

    it('generates the quarters and the year of a fiscal year from the same calendar, each type apart (schedule reader)', async () => {
      const quarters = await generate(2027, '2026-12-15T00:00:00Z', TENANT_A, { periodType: 'QUARTER' });
      expect(quarters.periods).toHaveLength(4);
      expect(quarters.periods[0]?.startDate).toBe('2027-01-01');
      expect(quarters.periods[3]?.endDate).toBe('2027-12-31');
      const year = await generate(2027, '2026-12-15T00:00:00Z', TENANT_A, { periodType: 'YEAR' });
      expect(year.periods).toHaveLength(1);
      expect([year.periods[0]?.startDate, year.periods[0]?.endDate]).toEqual(['2027-01-01', '2027-12-31']);
      const stored = await owner<{ period_type: string; n: string }>('select period_type, count(*)::text as n from machvon.reporting_period group by 1 order by 1');
      expect(stored).toEqual([{ period_type: 'QUARTER', n: '4' }, { period_type: 'YEAR', n: '1' }]);
    });

    it('refuses a request it cannot serve and writes nothing', async () => {
      expect(await refusal(generate(2027, '2026-12-15T00:00:00Z', TENANT_A, { calendarCode: 'OTHER' }))).toEqual({ code: 'CALENDAR_NOT_EFFECTIVE', status: 422, detail: 'calendar_code' });
      expect(await refusal(generate(2024, '2024-01-01T00:00:00Z'))).toEqual({ code: 'CALENDAR_NOT_EFFECTIVE', status: 422, detail: 'calendar_code' });
      expect(await refusal(generate(2027, '2026-12-15T00:00:00Z', TENANT_A, { periodType: 'HALF_YEAR' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'period_type' });
      expect(await refusal(generate(1969, '2026-12-15T00:00:00Z'))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'fiscal_year' });
      expect(await refusal(generate(10_000, '2026-12-15T00:00:00Z'))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'fiscal_year' });
      expect(await refusal(generate(2027.5, '2026-12-15T00:00:00Z'))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'fiscal_year' });
      expect(await refusal(generate(2027, '2026-12-15T00:00:00Z', TENANT_A, { calendarCode: '  ' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'calendar_code' });
      expect(await refusal(generate(2027, '2026-12-15T00:00:00Z', TENANT_A, { calendarCode: 'X'.repeat(51) }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'calendar_code' });
      expect((await owner<{ n: string }>('select count(*)::text as n from machvon.reporting_period'))[0]).toEqual({ n: '0' });
    });

    it('refuses the whole year when one existing period overlaps it, and when two requests race for the same year', async () => {
      const [version] = await owner<{ id: string }>("select id from machvon.master_record_version where master_type = 'CALENDAR' limit 1");
      const seed = (code: string, start: string, end: string): Promise<unknown[]> =>
        owner(
          `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
           values ($1, $2, $3, 1, $4::date, $5::date, $5::date + interval '3 hours', 'DEFAULT', 'WEEK', 2031, 'OPEN', $6, $7, $7)`,
          [TENANT_A, randomUUID(), code, start, end, (version as { id: string }).id, memberId(ACTOR)],
        );
      await seed('MANUAL-1', '2031-03-03', '2031-03-05');
      expect(await refusal(generate(2031, '2031-01-01T00:00:00Z'))).toEqual({ code: 'PERIOD_OVERLAP', status: 409, detail: 'fiscal_year' });
      expect((await owner<{ n: string }>('select count(*)::text as n from machvon.reporting_period'))[0]).toEqual({ n: '1' });
      // A period with the code of a generated one, far from its dates, is caught by the unique code, not by the dates.
      await reset();
      await seed('W2032-01', '1999-01-01', '1999-01-07');
      expect(await refusal(generate(2032, '2032-01-01T00:00:00Z'))).toEqual({ code: 'PERIOD_OVERLAP', status: 409, detail: 'fiscal_year' });
      await reset();
      const outcomes = await Promise.allSettled([generate(2033, '2033-01-01T00:00:00Z'), generate(2033, '2033-01-01T00:00:00Z')]);
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      const lost = outcomes.find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult;
      expect(lost.reason).toMatchObject({ code: 'PERIOD_OVERLAP', status: 409 });
    });

    it('keeps the periods of a tenant to itself', async () => {
      await generate(2027, '2026-12-15T00:00:00Z');
      const theirs = await generate(2027, '2026-12-15T00:00:00Z', TENANT_B);
      expect(theirs.calendar.revision).toBe(2);
      const mine = await as((tx) => periods.list(tx, { fiscalYear: 2027 }, { limit: 200, after: undefined }));
      expect(mine).toHaveLength(53);
      expect(await as((tx) => periods.find(tx, theirs.periods[0]?.id ?? ''))).toBeUndefined();
    });
  });

  describe('soft close and lock (AC-ST-DIS-001-1)', () => {
    let week40: PeriodRow;
    beforeAll(async () => {
      await reset();
      await generate(2026, '2026-09-01T00:00:00Z');
      week40 = await byCode('W2026-40');
    });
    afterAll(async () => {
      await reset();
    });

    it('starts OPEN with the deadline of the calendar it came from', () => {
      expect(week40).toMatchObject({ status: 'OPEN', startDate: '2026-09-26', endDate: '2026-10-02', deadlineAt: '2026-10-02T03:00:00.000Z', calendarRevision: 1, version: 1, softClosedAt: null, lockedAt: null, lockedBy: null });
    });

    it('refuses to soft close before the deadline, and with a stale or missing version', async () => {
      expect(await refusal(as((tx) => periods.softClose(tx, week40.id, 1, memberId(ACTOR), at('2026-10-02T02:59:59Z'))))).toEqual({ code: 'PERIOD_STATE_INVALID', status: 409, detail: 'deadline_at' });
      expect(await refusal(as((tx) => periods.softClose(tx, week40.id, 7, memberId(ACTOR), at('2026-10-02T03:05:00Z'))))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      expect(await refusal(as((tx) => periods.softClose(tx, randomUUID(), 1, memberId(ACTOR), at('2026-10-02T03:05:00Z'))))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(as((tx) => periods.lock(tx, week40.id, 1, memberId(ACTOR), at('2026-10-02T03:05:00Z'))))).toEqual({ code: 'PERIOD_STATE_INVALID', status: 409, detail: 'status' });
      expect((await byCode('W2026-40')).status).toBe('OPEN');
    });

    it('soft closes after the deadline, keeps taking reports as late, then locks and refuses them with PERIOD_LOCKED (AC-ST-DIS-001-1)', async () => {
      const closed = await as((tx) => periods.softClose(tx, week40.id, 1, memberId(ACTOR), at('2026-10-02T03:05:00Z')));
      expect(closed).toMatchObject({ status: 'SOFT_CLOSED', softClosedAt: '2026-10-02T03:05:00.000Z', lockedAt: null, version: 2 });
      // A maker submits in SOFT_CLOSED: accepted, and late (the deadline was 03:00:00Z).
      const judged = await as((tx) => periods.judge(tx, week40.id, PROJECT, at('2026-10-02T03:05:30Z')));
      expect(judged).toMatchObject({ late: true, deadlineAt: '2026-10-02T03:00:00.000Z', period: { status: 'SOFT_CLOSED' } });
      expect(await as((tx) => periods.closedFor(tx, week40.id, PROJECT, at('2026-10-02T03:05:30Z')))).toBe(false);
      expect(await refusal(as((tx) => periods.softClose(tx, week40.id, 2, memberId(ACTOR), at('2026-10-02T03:06:00Z'))))).toEqual({ code: 'PERIOD_STATE_INVALID', status: 409, detail: 'status' });
      const locked = await as((tx) => periods.lock(tx, week40.id, 2, memberId(ACTOR), at('2026-10-02T03:10:00Z')));
      expect(locked).toMatchObject({ status: 'LOCKED', lockedAt: '2026-10-02T03:10:00.000Z', lockedBy: memberId(ACTOR), version: 3 });
      expect(await refusal(as((tx) => periods.judge(tx, week40.id, PROJECT, at('2026-10-02T03:11:00Z'))))).toEqual({ code: 'PERIOD_LOCKED', status: 409 });
      expect(await as((tx) => periods.closedFor(tx, week40.id, PROJECT, at('2026-10-02T03:11:00Z')))).toBe(true);
      expect(await as((tx) => periods.closedFor(tx, randomUUID(), PROJECT, at('2026-10-02T03:11:00Z')))).toBe(true);
      expect(await refusal(as((tx) => periods.lock(tx, week40.id, 3, memberId(ACTOR), at('2026-10-02T03:11:00Z'))))).toEqual({ code: 'PERIOD_STATE_INVALID', status: 409, detail: 'status' });
      expect(await refusal(as((tx) => periods.judge(tx, randomUUID(), PROJECT, at('2026-10-02T03:11:00Z'))))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });

    it('holds the period against a close or a lock while a send is judged, until the send commits', async () => {
      const week42 = await byCode('W2026-42');
      const heldAgainst = await as(async (tx) => {
        await periods.judge(tx, week42.id, PROJECT, at('2026-10-02T02:00:00Z'));
        // Another connection that tries to move the period meanwhile waits for the send and gives up here after the time it is allowed.
        return refusal(harness.owner(TENANT_A, [["set lock_timeout = '300ms'"], ['select id from machvon.reporting_period where id = $1::uuid for update', [week42.id]]]));
      });
      expect(heldAgainst).toMatchObject({ code: '55P03' });
      expect(await owner('select id from machvon.reporting_period where id = $1::uuid for update', [week42.id])).toHaveLength(1);
    });

    it('does not let a tenant move the period of another', async () => {
      const week41 = await byCode('W2026-41');
      expect(await refusal(as((tx) => periods.softClose(tx, week41.id, 1, memberId(ACTOR), at('2026-12-31T00:00:00Z')), TENANT_B))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });

    it('lists the latest first with keyset pages and filters, and shows the history of reopening requests', async () => {
      const everything = await as((tx) => periods.list(tx, {}, { limit: 200, after: undefined }));
      expect(everything.length).toBeGreaterThan(50);
      expect(everything.map((row) => row.startDate)).toEqual([...everything.map((row) => row.startDate)].sort().reverse());
      const first = await as((tx) => periods.list(tx, { fiscalYear: 2026 }, { limit: 2, after: undefined }));
      const [head, tail] = first;
      const second = await as((tx) => periods.list(tx, { fiscalYear: 2026 }, { limit: 2, after: { code: (tail as PeriodRow).startDate, id: (tail as PeriodRow).id } }));
      expect([head, tail, ...second].map((row) => row?.code)).toEqual(everything.slice(0, 4).map((row) => row.code));
      expect((await as((tx) => periods.list(tx, { status: 'LOCKED' }, { limit: 10, after: undefined }))).map((row) => row.code)).toEqual(['W2026-40']);
      expect((await as((tx) => periods.list(tx, { periodType: 'WEEK', calendarCode: 'DEFAULT', status: 'OPEN', fiscalYear: 2026 }, { limit: 200, after: undefined }))).every((row) => row.status === 'OPEN')).toBe(true);
      expect(await as((tx) => periods.list(tx, { calendarCode: 'OTHER' }, { limit: 10, after: undefined }))).toEqual([]);

      const requestId = randomUUID();
      await owner(
        `insert into machvon.period_reopen (tenant_id, id, period_id, scope_kind, reason, requested_by, requested_window_hours, status, created_by, updated_by)
         values ($1, $2, $3, 'PERIOD', 'Correction of the figures after the lock', $4, 24, 'REQUESTED', $4, $4)`,
        [TENANT_A, requestId, week40.id, memberId(ACTOR)],
      );
      const history = await as((tx) => periods.reopens(tx, [week40.id, (head as PeriodRow).id], at('2026-10-05T00:00:00Z')));
      expect(history.get(week40.id)).toEqual([
        {
          id: requestId,
          periodId: week40.id,
          scopeKind: 'PERIOD',
          status: 'REQUESTED',
          windowUntil: null,
          requestedAt: expect.stringMatching(/Z$/),
          reason: 'Correction of the figures after the lock',
          requestedBy: memberId(ACTOR),
          requestedWindowHours: 24,
          approvedBy: null,
          decidedBy: null,
          decidedAt: null,
          decisionReason: null,
          projects: [],
          version: 1,
        },
      ]);
      expect(history.get((head as PeriodRow).id)).toBeUndefined();
      expect((await as((tx) => periods.reopens(tx, [], at('2026-10-05T00:00:00Z')))).size).toBe(0);
    });
  });

  describe('lateness by the calendar version the period is bound to (AC-ST-DIS-001-2)', () => {
    afterEach(async () => {
      await reset(TENANT_B);
    });

    it('judges a period of version 2 (due Friday) by 2 October and a period of version 1 (due Saturday) by 3 October (AC-ST-DIS-001-2)', async () => {
      // Version 2 of the tenant B is in force from 1 September: the weeks generated after it are due on Friday.
      await generate(2026, '2026-09-15T00:00:00Z', TENANT_B);
      const bound = await byCode('W2026-40', TENANT_B);
      expect(bound).toMatchObject({ calendarRevision: 2, startDate: '2026-09-27', deadlineAt: '2026-10-02T03:00:00.000Z' });
      const late = await as((tx) => periods.judge(tx, bound.id, PROJECT, at('2026-10-02T03:00:01Z')), TENANT_B);
      const inTime = await as((tx) => periods.judge(tx, bound.id, PROJECT, at('2026-10-02T02:59:59Z')), TENANT_B);
      const onTheDot = await as((tx) => periods.judge(tx, bound.id, PROJECT, at('2026-10-02T03:00:00Z')), TENANT_B);
      expect([late.late, inTime.late, onTheDot.late]).toEqual([true, false, false]);

      // The same week generated under version 1 stays due on Saturday after version 2 exists.
      await reset(TENANT_B);
      await generate(2026, '2026-08-15T00:00:00Z', TENANT_B);
      const older = await byCode('W2026-40', TENANT_B);
      expect(older).toMatchObject({ calendarRevision: 1, deadlineAt: '2026-10-03T03:00:00.000Z' });
      expect((await as((tx) => periods.judge(tx, older.id, PROJECT, at('2026-10-02T03:00:01Z')), TENANT_B)).late).toBe(false);
      expect((await as((tx) => periods.judge(tx, older.id, PROJECT, at('2026-10-03T03:00:01Z')), TENANT_B)).late).toBe(true);
      // The stored deadline is the one the bound version gives.
      expect((await as((tx) => periods.judge(tx, older.id, PROJECT, at('2026-10-03T03:00:01Z')), TENANT_B)).deadlineAt).toBe(older.deadlineAt);
    });
  });

  describe('the table keeps what the application checks', () => {
    let target: PeriodRow;
    beforeAll(async () => {
      await reset();
      await generate(2027, '2026-12-15T00:00:00Z');
      target = await byCode('W2027-10');
    });
    afterAll(async () => {
      await reset();
    });

    const update = (set: string, id = target.id): Promise<unknown[]> => owner(`update machvon.reporting_period set ${set} where id = $1`, [id]);

    it('refuses a move that is not a step of the state machine, a version that is not raised by one and a change of what was fixed at generation', async () => {
      await expect(update(`status = 'LOCKED', locked_at = now(), locked_by = '${memberId(ACTOR)}', version = version + 1`)).rejects.toThrow(/check constraint|moves only from/);
      await expect(update("status = 'SOFT_CLOSED', soft_closed_at = now(), version = version + 5")).rejects.toThrow(/raises its version by one/);
      await expect(update("deadline_at = deadline_at + interval '1 day', version = version + 1")).rejects.toThrow(/fixed when it is generated/);
      await expect(update("start_date = start_date + 1, version = version + 1")).rejects.toThrow(/fixed when it is generated|overlap/);
      await expect(update("calendar_version = 9, version = version + 1")).rejects.toThrow(/fixed when it is generated/);
      await expect(update("version = version + 1")).rejects.toThrow(/moves only from/);
      await expect(update("status = 'SOFT_CLOSED', version = version + 1")).rejects.toThrow(/reporting_period_soft_close_chk/);
    });

    it('refuses a timestamp that does not follow the status, and a locked period that changes or goes back', async () => {
      await update(`status = 'SOFT_CLOSED', soft_closed_at = '2027-03-12T04:00:00Z', version = version + 1`);
      await expect(update("soft_closed_at = null, status = 'OPEN', version = version + 1")).rejects.toThrow(/moves only from/);
      await expect(update(`status = 'LOCKED', locked_at = '2027-03-12T03:00:00Z', locked_by = '${memberId(ACTOR)}', version = version + 1`)).rejects.toThrow(/reporting_period_lock_order_chk/);
      await expect(update(`status = 'LOCKED', locked_at = '2027-03-13T03:00:00Z', version = version + 1`)).rejects.toThrow(/reporting_period_locker_chk/);
      await expect(update(`status = 'LOCKED', locked_at = '2027-03-13T03:00:00Z', locked_by = '${memberId(ACTOR)}', soft_closed_at = '2027-03-12T05:00:00Z', version = version + 1`)).rejects.toThrow(/never changes/);
      await update(`status = 'LOCKED', locked_at = '2027-03-13T03:00:00Z', locked_by = '${memberId(ACTOR)}', version = version + 1`);
      await expect(update("status = 'OPEN', soft_closed_at = null, locked_at = null, locked_by = null, version = version + 1")).rejects.toThrow(/never changes/);
      await expect(update('updated_at = now(), version = version + 1')).rejects.toThrow(/never changes/);
    });

    it('is never deleted by the application role, and refuses a period without its calendar version or fiscal year', async () => {
      await expect(as((tx) => tx.query('delete from machvon.reporting_period where id = $1::uuid', [target.id]))).rejects.toThrow(/permission denied/);
      const insert = (code: string, fiscalYear: string, versionId: string): Promise<unknown[]> =>
        owner(
          `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, calendar_version_id)
           values ($1, gen_random_uuid(), $2, 1, '2040-01-01', '2040-01-07', '2040-01-07T03:00:00Z', 'DEFAULT', 'WEEK', ${fiscalYear}, $3)`,
          [TENANT_A, code, versionId],
        );
      await expect(insert('CHK-1', '2040', randomUUID())).rejects.toThrow(/reporting_period_calendar_version_fk/);
      await expect(insert('CHK-1', 'null', target.calendarVersionId)).rejects.toThrow(/reporting_period_fiscal_year_chk/);
      await expect(insert(' padded ', '2040', target.calendarVersionId)).rejects.toThrow(/reporting_period_code_chk/);
      await expect(insert('', '2040', target.calendarVersionId)).rejects.toThrow(/reporting_period_code_chk/);
      await expect(
        owner("insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at) values ($1, gen_random_uuid(), 'CHK-2', 1, '2040-01-01', '2040-01-07', now())", [TENANT_A]),
      ).rejects.toThrow(/reporting_period_(calendar_version|fiscal_year)_chk/);
    });
  });

  describe('the job dis.period-autoclose', () => {
    const audit = new AuditWriter(harness.tenants);
    const run = (now: string, tenant = TENANT_A, job = new DisPeriodAutoclose(audit)) => asWorker((tx) => job.run(tx, WORKER, at(now)), tenant);
    const states = async (tenant = TENANT_A): Promise<Record<string, string>> =>
      Object.fromEntries((await owner<{ status: string; n: string }>('select status, count(*)::text as n from machvon.reporting_period group by status', [], tenant)).map((row) => [row.status, row.n]));

    beforeAll(async () => {
      await reset();
      await reset(TENANT_B);
      await generate(2026, '2026-01-01T00:00:00Z');
    });
    afterAll(async () => {
      await reset();
      await reset(TENANT_B);
    });

    it('soft closes the weeks past their deadline and locks those three working days past it, leaving the same audit rows and events', async () => {
      const total = (await owner<{ n: string }>('select count(*)::text as n from machvon.reporting_period'))[0]?.n;
      const metrics = new CollectingTelemetry();
      // W2026-40 is due on Friday 2 October at 10:00 (+07): the lock comes on Wednesday 7 October at 10:00; W2026-39 was locked on 30 September.
      const result = await run('2026-10-02T03:30:00Z', TENANT_A, new DisPeriodAutoclose(audit, { metrics }));
      expect(result).toEqual({ softClosed: 40, locked: 39, skipped: 0 });
      expect(await states()).toEqual({ OPEN: String(Number(total) - 40), SOFT_CLOSED: '1', LOCKED: '39' });
      const week40 = await byCode('W2026-40');
      const week39 = await byCode('W2026-39');
      expect([week40.status, week39.status, week39.lockedBy]).toEqual(['SOFT_CLOSED', 'LOCKED', WORKER]);
      const rows = await owner<{ action: string; n: string }>("select action, count(*)::text as n from machvon.audit_event where action like 'dis.period_%' group by action order by action");
      expect(rows).toEqual([{ action: 'dis.period_locked', n: '39' }, { action: 'dis.period_soft_closed', n: '40' }]);
      const events = await owner<{ type: string; n: string }>("select type, count(*)::text as n from machvon.outbox_event where aggregate_type = 'reporting_period' group by type order by type");
      expect(events).toEqual([{ type: 'period.locked.v1', n: '39' }, { type: 'period.soft_closed.v1', n: '40' }]);
      const sample = await owner<{ reason: string; safe_diff: Record<string, unknown> }>("select reason, safe_diff from machvon.audit_event where action = 'dis.period_locked' and resource_id = $1::uuid", [week39.id]);
      expect(sample[0]).toMatchObject({ reason: 'AUTO_LOCK_AFTER_WORKING_DAYS', safe_diff: { code: 'W2026-39', status: 'LOCKED', trigger: 'AUTO' } });
      const counters = metrics.snapshot().counters;
      expect(counters.find((counter) => counter.name === DIS_PERIOD_TRANSITION_METRIC && counter.labels.to === 'locked')).toMatchObject({ value: 39, labels: { trigger: 'auto' } });
      expect(counters.find((counter) => counter.name === DIS_PERIOD_TRANSITION_METRIC && counter.labels.to === 'soft_closed')?.value).toBe(40);
    });

    it('does nothing the second time, and locks the soft-closed week when its three working days have passed', async () => {
      expect(await run('2026-10-02T03:30:00Z')).toEqual({ softClosed: 0, locked: 0, skipped: 0 });
      expect(await run('2026-10-07T02:59:00Z')).toEqual({ softClosed: 0, locked: 0, skipped: 0 });
      expect(await run('2026-10-07T03:00:00Z')).toEqual({ softClosed: 0, locked: 1, skipped: 0 });
      expect((await byCode('W2026-40')).status).toBe('LOCKED');
    });

    it('leaves a period that a command is acting on to the next run', async () => {
      const week41 = await byCode('W2026-41');
      const held = await as(async (tx) => {
        await periods.find(tx, week41.id, true);
        return run('2026-10-09T03:30:00Z');
      });
      expect(held).toEqual({ softClosed: 0, locked: 0, skipped: 0 });
      expect((await byCode('W2026-41')).status).toBe('OPEN');
      expect(await run('2026-10-09T03:30:00Z')).toEqual({ softClosed: 1, locked: 0, skipped: 0 });
    });

    it('leaves a soft-closed period soft closed and counts it when the working calendar of its year is not published', async () => {
      await generate(2026, '2026-01-01T00:00:00Z', TENANT_B);
      const result = await run('2026-01-20T00:00:00Z', TENANT_B);
      expect(result.softClosed).toBeGreaterThan(0);
      expect(result).toMatchObject({ locked: 0, skipped: result.softClosed });
      expect(Object.keys(await states(TENANT_B)).sort()).toEqual(['OPEN', 'SOFT_CLOSED']);
    });

    it('propagates a failure that is not a missing calendar', async () => {
      const broken = new DisPeriodAutoclose(audit, { calendars: { source: () => Promise.reject(new Error('database unavailable')) } as never });
      await expect(run('2026-10-20T00:00:00Z', TENANT_A, broken)).rejects.toThrow('database unavailable');
    });
  });

  describe('the helpers', () => {
    it('counts the working hours of a day on the intervals and labels the metrics', () => {
      expect(workingHoursPerDay([{ from: '08:00', to: '12:00' }, { from: '13:00', to: '17:00' }])).toBe(8);
      expect(workingHoursPerDay([{ from: '07:30', to: '17:00' }])).toBe(9.5);
      expect(submitLabels(true)).toEqual({ late: 'true' });
      expect(submitLabels(false)).toEqual({ late: 'false' });
      expect(transitionLabels('soft_close', 'MANUAL')).toEqual({ to: 'soft_closed', trigger: 'manual' });
      expect(transitionLabels('lock', 'AUTO')).toEqual({ to: 'locked', trigger: 'auto' });
    });

    it('builds the same audit row and event for the command and the job', () => {
      const row = { id: randomUUID(), code: 'W2026-40', calendarCode: 'DEFAULT', periodType: 'WEEK', fiscalYear: 2026, startDate: '2026-09-26', endDate: '2026-10-02', deadlineAt: '2026-10-02T03:00:00.000Z', calendarRevision: 1, calendarVersionId: randomUUID(), status: 'LOCKED', softClosedAt: '2026-10-02T03:05:00.000Z', lockedAt: '2026-10-02T03:10:00.000Z', lockedBy: memberId(ACTOR), version: 3 } as PeriodRow;
      const record = periodMoveRecord('lock', row, 'Locked after review', 'MANUAL');
      expect(record.audit).toMatchObject({ action: 'dis.period_locked', resourceType: 'reporting_period', resourceId: row.id, reason: 'Locked after review' });
      expect(record.event).toMatchObject({ aggregateType: 'reporting_period', aggregateVersion: 3, type: 'period.locked.v1', eventKey: `reporting_period:${row.id}:3`, payload: { trigger: 'MANUAL', locked_at: row.lockedAt } });
      expect(periodMoveRecord('soft_close', { ...row, version: 2 }, 'Closed', 'AUTO').event.type).toBe('period.soft_closed.v1');
    });

    it('keeps the whole period before and after the move for the full audit detail (HT.06): the status it left, the one it reached, the instants and the actor', () => {
      const closed = { id: randomUUID(), code: 'W2026-40', calendarCode: 'DEFAULT', periodType: 'WEEK', fiscalYear: 2026, startDate: '2026-09-26', endDate: '2026-10-02', deadlineAt: '2026-10-02T03:00:00.000Z', calendarRevision: 1, calendarVersionId: randomUUID(), status: 'SOFT_CLOSED', softClosedAt: '2026-10-02T03:05:00.000Z', lockedAt: null, lockedBy: null, version: 2 } as PeriodRow;
      const closing = periodMoveRecord('soft_close', closed, 'Deadline passed', 'AUTO').audit.detail;
      expect(closing).toEqual({
        before: { status: 'OPEN', soft_closed_at: null, locked_at: null, locked_by: null },
        after: { status: 'SOFT_CLOSED', soft_closed_at: '2026-10-02T03:05:00.000Z', locked_at: null, locked_by: null, trigger: 'AUTO', reason: 'Deadline passed' },
      });
      const locked = { ...closed, status: 'LOCKED', lockedAt: '2026-10-03T03:00:00.000Z', lockedBy: memberId(ACTOR), version: 3 } as PeriodRow;
      expect(periodMoveRecord('lock', locked, 'Locked after review', 'MANUAL').audit.detail).toEqual({
        before: { status: 'SOFT_CLOSED', soft_closed_at: '2026-10-02T03:05:00.000Z', locked_at: null, locked_by: null },
        after: { status: 'LOCKED', soft_closed_at: '2026-10-02T03:05:00.000Z', locked_at: '2026-10-03T03:00:00.000Z', locked_by: memberId(ACTOR), trigger: 'MANUAL', reason: 'Locked after review' },
      });
    });
  });
});
