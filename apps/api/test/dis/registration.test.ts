import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { CapScheduleStore, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import { signTenantContext } from '@machvon/kernel';
import { RegistrationConsumer } from '../../src/modules/dis/registration.consumer';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import type { TenantDatabase } from '@machvon/db';

const SIGNING_KEY = randomBytes(32);
const ROOT = 1;
const FAMILY = 0xa8;
const MAKER = 1;
const CHECKER = 2;

interface Cell {
  bucket: 'CURRENT_YEAR' | 'CARRYOVER' | 'OTHER';
  level: 'CENTRAL' | 'LOCAL';
  cumulative: string;
  next: string;
  nextCtmtqg?: string;
}

/** FX-DIS-001: the six cells, 420 million paid in all, and 300 million registered for next month. */
const FX_DIS_001: Cell[] = [
  { bucket: 'CURRENT_YEAR', level: 'CENTRAL', cumulative: '100000000', next: '100000000', nextCtmtqg: '20000000' },
  { bucket: 'CURRENT_YEAR', level: 'LOCAL', cumulative: '200000000', next: '120000000' },
  { bucket: 'CARRYOVER', level: 'CENTRAL', cumulative: '30000000', next: '50000000' },
  { bucket: 'CARRYOVER', level: 'LOCAL', cumulative: '70000000', next: '30000000' },
  { bucket: 'OTHER', level: 'CENTRAL', cumulative: '0', next: '0' },
  { bucket: 'OTHER', level: 'LOCAL', cumulative: '20000000', next: '0' },
];

/** The registration for next month on an accepted report (ST-DIS-004, ST-DIS-017, the job dis.registration, CAP task TK-CAP-009-2). */
describe('the registration for next month over the outbox (ST-DIS-017)', () => {
  const harness = new AuthzHarness();
  let consumer: RegistrationConsumer;
  let counter = 0;
  const rows = async <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);
  async function seedReplica(statements: Array<[string, unknown[]]>): Promise<void> {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      for (const [sql, params] of statements) await client.query(sql, params);
    } finally {
      await client.end();
    }
  }
  const delivery = (reportId: string, over: Record<string, unknown> = {}, eventId = randomUUID(), type = 'report.accepted.v1', tenantId = TENANT_A) => ({
    id: eventId,
    tenantId,
    tenantContext: signTenantContext({ tenantId, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 }, SIGNING_KEY),
    type,
    payload: { tenant_id: tenantId, report_id: reportId, ...over },
  });

  /** A project of the unit and a period that ends on `end`; the report is a revision of it with the cells. */
  async function world(options: { end?: string; status?: string; projectStatus?: string; project?: string } = {}) {
    counter += 1;
    const projectId = options.project ?? id(FAMILY, 100 + counter);
    const periodId = id(FAMILY, 1000 + counter);
    const end = options.end ?? '2027-10-31';
    await seedReplica([
      ...(options.project !== undefined
        ? []
        : ([
            [
              `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
               values ($1, $2, $3, $3, $4, $5, 'INTERNAL', 1000, $6, 1, 'B')`,
              [TENANT_A, projectId, `RG-${counter}`, unitId(ROOT), id(FAMILY, 30), options.projectStatus ?? 'IMPLEMENTATION'],
            ],
          ] as Array<[string, unknown[]]>)),
      [
        `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
         values ($1, $2, $3, 1, $4::date - 6, $4::date, now(), $7, 'WEEK', extract(year from $4::date)::int, 'OPEN', $5, $6, $6)`,
        [TENANT_A, periodId, `RP-${counter}`, end, id(FAMILY, 40), WORKER_MEMBERSHIP_ID, `CAL-${counter}`],
      ],
    ]);
    return { projectId, periodId };
  }
  async function report(w: { projectId: string; periodId: string }, cells: Cell[], options: { revision?: number; status?: string; current?: boolean } = {}): Promise<string> {
    const reportId = randomUUID();
    const status = options.status ?? 'ACCEPTED';
    const accepted = status === 'ACCEPTED';
    await seedReplica([
      [
        `insert into machvon.report_revision
           (tenant_id, id, project_id, period_id, plan_version_id, revision, status, is_current, version, payload_hash, report_type, measurement_basis, submitted_by, submitted_at, accepted_by, accepted_at, amendment_reason, created_by, updated_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 1, repeat('a', 64), 'WEEKLY', 'YTD', $9, now(), $10, $11::timestamptz, $12, $9, $9)`,
        [TENANT_A, reportId, w.projectId, w.periodId, id(FAMILY, 31), options.revision ?? 1, status, options.current ?? accepted, memberId(MAKER), accepted ? memberId(CHECKER) : null, accepted ? new Date().toISOString() : null, (options.revision ?? 1) === 1 ? null : 'Correction of the registration for next month'],
      ],
      ...cells.map(
        (cell): [string, unknown[]] => [
          `insert into machvon.funding_snapshot_line (tenant_id, id, report_revision_id, bucket, budget_level, disbursed_cumulative_vnd, next_month_registered_vnd, next_month_ctmtqg_subset_vnd)
           values ($1, gen_random_uuid(), $2, $3, $4, $5::numeric, $6::numeric, $7::numeric)`,
          [TENANT_A, reportId, cell.bucket, cell.level, cell.cumulative, cell.next, cell.nextCtmtqg ?? null],
        ],
      ),
    ]);
    return reportId;
  }
  const registered = (projectId: string) =>
    rows<{ plan_year: number; month: number; bucket: string; budget_level: string; amount_vnd: string; ctmtqg_subset_vnd: string | null; revision: number; is_current: boolean; source_report_revision_id: string | null }>(
      `select plan_year, month, bucket, budget_level, amount_vnd::text as amount_vnd, ctmtqg_subset_vnd::text as ctmtqg_subset_vnd, revision, is_current, source_report_revision_id
         from machvon.disbursement_schedule_line where project_id = $1 and kind = 'REGISTERED' order by month, bucket, budget_level, revision`,
      [projectId],
    );

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: ROOT, path: `/${unitId(ROOT)}/` }]);
    consumer = new RegistrationConsumer({
      database: harness.tenants as TenantDatabase,
      security: { signingKey: SIGNING_KEY, membershipActive: () => Promise.resolve(true) } as never,
    });
  }, 300_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  it('AC-ST-DIS-017-1 / UAT-AC264: an accepted report of October with 300 million registered for next month creates the REGISTERED rows of November, with the CTMTQG kept apart, and a cell with nothing creates none', async () => {
    const w = await world();
    const reportId = await report(w, FX_DIS_001);
    expect(await consumer.handle(delivery(reportId))).toBe('processed');
    const made = await registered(w.projectId);
    expect(made.map((row) => [row.plan_year, row.month, row.bucket, row.budget_level, row.amount_vnd, row.ctmtqg_subset_vnd, row.revision, row.is_current])).toEqual([
      [2027, 11, 'CARRYOVER', 'CENTRAL', '50000000', null, 1, true],
      [2027, 11, 'CARRYOVER', 'LOCAL', '30000000', null, 1, true],
      [2027, 11, 'CURRENT_YEAR', 'CENTRAL', '100000000', '20000000', 1, true],
      [2027, 11, 'CURRENT_YEAR', 'LOCAL', '120000000', null, 1, true],
    ]);
    expect(made.every((row) => row.source_report_revision_id === reportId)).toBe(true);
    expect(made.reduce((sum, row) => sum + BigInt(row.amount_vnd), 0n)).toBe(300_000_000n);
    const audit = await rows<{ safe_diff: Record<string, unknown> }>("select safe_diff from machvon.audit_event where action = 'dis.registration_made' and resource_id = $1::uuid", [reportId]);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.safe_diff).toMatchObject({ report_id: reportId, month: '2027-11', skipped: null });
    expect(JSON.stringify(audit[0]?.safe_diff)).not.toContain(memberId(MAKER));
  });

  it('is done once for a delivery that comes twice, and a delivery of another type, of another tenant or without a report is not its business', async () => {
    const w = await world();
    const reportId = await report(w, FX_DIS_001);
    const event = delivery(reportId);
    expect(await consumer.handle(event)).toBe('processed');
    expect(await consumer.handle(event)).toBe('duplicate');
    expect(await registered(w.projectId)).toHaveLength(4);
    expect(await consumer.handle(delivery(reportId, {}, randomUUID(), 'report.returned.v1'))).toBe('ignored');
    expect(await consumer.handle(delivery(reportId, { tenant_id: TENANT_B }))).toBe('ignored');
    await expect(consumer.handle(delivery(reportId, { report_id: 'nope' }))).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
    expect(await registered(w.projectId)).toHaveLength(4);
  });

  it('a correction that is accepted takes the place of the registration: a new revision for each key, a cell reduced to nothing is registered as nothing, and the late delivery of the report it replaced (now superseded) registers nothing', async () => {
    const w = await world();
    const first = await report(w, FX_DIS_001, { revision: 1 });
    await consumer.handle(delivery(first));
    // The first is superseded when the correction is accepted; the correction registers 70 million less on one cell and nothing on another.
    const corrected: Cell[] = FX_DIS_001.map((cell) => (cell.bucket === 'CARRYOVER' && cell.level === 'LOCAL' ? { ...cell, next: '0' } : cell.bucket === 'CURRENT_YEAR' && cell.level === 'LOCAL' ? { ...cell, next: '50000000' } : cell));
    await seedReplica([[`update machvon.report_revision set status = 'SUPERSEDED', is_current = false, accepted_by = $2, accepted_at = now() where id = $1`, [first, memberId(CHECKER)]]]);
    const second = await report(w, corrected, { revision: 2 });
    expect(await consumer.handle(delivery(second))).toBe('processed');
    const made = await registered(w.projectId);
    const current = made.filter((row) => row.is_current).map((row) => [row.bucket, row.budget_level, row.amount_vnd, row.revision]);
    expect(current).toEqual([
      ['CARRYOVER', 'CENTRAL', '50000000', 2],
      ['CARRYOVER', 'LOCAL', '0', 2],
      ['CURRENT_YEAR', 'CENTRAL', '100000000', 2],
      ['CURRENT_YEAR', 'LOCAL', '50000000', 2],
    ]);
    expect(made.filter((row) => !row.is_current)).toHaveLength(4);
    // The delivery of the first report comes again late, under another event: it is superseded and says nothing.
    expect(await consumer.handle(delivery(first, {}, randomUUID()))).toBe('processed');
    expect((await registered(w.projectId)).filter((row) => row.is_current).map((row) => row.amount_vnd)).toEqual(['50000000', '0', '100000000', '50000000']);
    const late = await rows<{ safe_diff: Record<string, unknown> }>("select safe_diff from machvon.audit_event where action = 'dis.registration_made' and resource_id = $1::uuid order by occurred_at", [first]);
    expect(late[late.length - 1]?.safe_diff).toMatchObject({ skipped: 'NOT_ACCEPTED', registered: [] });
  });

  it('registers for January of the next year after a period that ends in December, and leaves the acceptance alone when that year is closed or the project no longer reports', async () => {
    const december = await world({ end: '2027-12-26' });
    await consumer.handle(delivery(await report(december, FX_DIS_001)));
    expect((await registered(december.projectId)).map((row) => [row.plan_year, row.month])).toEqual([[2028, 1], [2028, 1], [2028, 1], [2028, 1]]);
    await seedReplica([
      [
        `insert into machvon.fiscal_year_control (tenant_id, id, plan_year, status, soft_closed_at, soft_closed_by, close_reason, created_by, updated_by)
         values ($1, gen_random_uuid(), 2030, 'SOFT_CLOSED', now(), $2, 'The year is closed for the test of the registration', $2, $2)`,
        [TENANT_A, WORKER_MEMBERSHIP_ID],
      ],
    ]);
    const closed = await world({ end: '2029-12-30' });
    const closedReport = await report(closed, FX_DIS_001);
    expect(await consumer.handle(delivery(closedReport))).toBe('processed');
    expect(await registered(closed.projectId)).toEqual([]);
    const audit = await rows<{ safe_diff: Record<string, unknown> }>("select safe_diff from machvon.audit_event where action = 'dis.registration_made' and resource_id = $1::uuid", [closedReport]);
    expect(audit[0]?.safe_diff).toMatchObject({ skipped: 'FISCAL_YEAR_LOCKED', month: '2030-01' });
    const settled = await world({ projectStatus: 'CLOSED' });
    const settledReport = await report(settled, FX_DIS_001);
    expect(await consumer.handle(delivery(settledReport))).toBe('processed');
    expect(await registered(settled.projectId)).toEqual([]);
  });

  it('the later week wins whatever the order of the deliveries: two accepted reports of one project that end in the same month, the earlier one delivered again after the later one registers nothing over it', async () => {
    const first = await world({ end: '2027-10-17' });
    const second = await world({ end: '2027-10-24', project: first.projectId });
    const earlier = await report(first, FX_DIS_001);
    const lessNext = FX_DIS_001.map((cell) => (cell.bucket === 'CURRENT_YEAR' && cell.level === 'LOCAL' ? { ...cell, next: '40000000' } : cell));
    const later = await report(second, lessNext);
    // The later week is delivered first, then the earlier one, late and again.
    expect(await consumer.handle(delivery(later))).toBe('processed');
    expect(await consumer.handle(delivery(earlier))).toBe('processed');
    const current = (await registered(first.projectId)).filter((row) => row.is_current).map((row) => [row.bucket, row.budget_level, row.amount_vnd, row.source_report_revision_id === later]);
    expect(current).toEqual([
      ['CARRYOVER', 'CENTRAL', '50000000', true],
      ['CARRYOVER', 'LOCAL', '30000000', true],
      ['CURRENT_YEAR', 'CENTRAL', '100000000', true],
      ['CURRENT_YEAR', 'LOCAL', '40000000', true],
    ]);
    const left = await rows<{ safe_diff: Record<string, unknown> }>("select safe_diff from machvon.audit_event where action = 'dis.registration_made' and resource_id = $1::uuid", [earlier]);
    expect(left[0]?.safe_diff).toMatchObject({ skipped: 'NEWER_REPORT', registered: [] });
    // The check of the order under the lock of the key, which is what holds when the newer report is accepted between the check above and the write: an older source writes nothing over a newer one.
    const guarded = await (harness.tenants as TenantDatabase).withTenant({ tenantId: TENANT_A, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 }, (tx) =>
      new CapScheduleStore().registerUnlessNewer(
        tx,
        { projectId: first.projectId, planYear: 2027, granularity: 'MONTH', month: 11, kind: 'REGISTERED', bucket: 'CURRENT_YEAR', budgetLevel: 'LOCAL', amountVnd: '999', sourceReportRevisionId: earlier },
        { endDate: '2027-10-17', revision: 1 },
        WORKER_MEMBERSHIP_ID,
        () => ({ sql: 'true', params: [] }),
        new Date(),
      ),
    );
    expect(guarded).toBeUndefined();
    expect((await registered(first.projectId)).filter((row) => row.is_current && row.bucket === 'CURRENT_YEAR' && row.budget_level === 'LOCAL').map((row) => row.amount_vnd)).toEqual(['40000000']);
    // In the order of the weeks the later one replaces the earlier one with a new revision.
    const third = await world({ end: '2027-10-10', project: first.projectId });
    const oldest = await report(third, FX_DIS_001);
    const ordered = await world({ end: '2027-10-31', project: first.projectId });
    const newest = await report(ordered, lessNext);
    await consumer.handle(delivery(oldest));
    expect(await consumer.handle(delivery(newest))).toBe('processed');
    expect((await registered(first.projectId)).filter((row) => row.is_current).every((row) => row.source_report_revision_id === newest)).toBe(true);
  });

  it('a later week that registers nothing for a cell is not undone by the late delivery of an earlier week that registers an amount for it', async () => {
    const first = await world({ end: '2027-10-17' });
    const second = await world({ end: '2027-10-24', project: first.projectId });
    const earlier = await report(first, FX_DIS_001);
    const nothing = FX_DIS_001.map((cell) => (cell.bucket === 'CARRYOVER' ? { ...cell, next: '0' } : cell));
    const later = await report(second, nothing);
    // The later week is delivered first and registers nothing for the carried-over cells (there is no row to replace); the earlier week comes after.
    expect(await consumer.handle(delivery(later))).toBe('processed');
    expect(await consumer.handle(delivery(earlier))).toBe('processed');
    const current = (await registered(first.projectId)).filter((row) => row.is_current);
    expect(current.map((row) => [row.bucket, row.budget_level, row.amount_vnd, row.source_report_revision_id === later])).toEqual([
      ['CURRENT_YEAR', 'CENTRAL', '100000000', true],
      ['CURRENT_YEAR', 'LOCAL', '120000000', true],
    ]);
    const left = await rows<{ safe_diff: Record<string, unknown> }>("select safe_diff from machvon.audit_event where action = 'dis.registration_made' and resource_id = $1::uuid", [earlier]);
    expect(left[0]?.safe_diff).toMatchObject({ skipped: 'NEWER_REPORT', registered: [] });
  });

  it('serialises the registrations of one project and one month: a delivery waits for the one that holds the month, then judges the order of the weeks on what it left', async () => {
    const first = await world({ end: '2027-10-17' });
    const second = await world({ end: '2027-10-24', project: first.projectId });
    const earlier = await report(first, FX_DIS_001);
    const nothing = FX_DIS_001.map((cell) => ({ ...cell, next: '0', nextCtmtqg: undefined }));
    await report(second, nothing);
    const holder = new Client({ connectionString: harness.database.adminUrl });
    await holder.connect();
    try {
      // The consumer of the later week holds the month and has not committed (it sees no row for a zero and writes none).
      await holder.query('begin');
      await holder.query("select set_config('app.tenant_id', $1, true)", [TENANT_A]);
      await holder.query("select pg_advisory_xact_lock(hashtextextended('dis_registration:' || current_setting('app.tenant_id') || ':' || $1::text || ':' || $2::text, 0))", [first.projectId, '2027-11']);
      const pending = consumer.handle(delivery(earlier));
      const settled = await Promise.race([pending.then(() => 'finished'), new Promise((resolve) => setTimeout(() => resolve('waiting'), 700))]);
      expect(settled).toBe('waiting');
      await holder.query('commit');
      expect(await pending).toBe('processed');
    } finally {
      await holder.end();
    }
    // It judged the order after the wait: the later week is accepted, so the earlier one leaves the month alone.
    expect(await registered(first.projectId)).toEqual([]);
  });

  it('registers the amounts of a report that was accepted and then asked to be amended, which stays the current one until its correction is accepted', async () => {
    const w = await world();
    const reportId = await report(w, FX_DIS_001);
    await seedReplica([[`update machvon.report_revision set status = 'AMENDMENT_REQUESTED', returned_reason = 'The Treasury corrected a payment' where id = $1`, [reportId]]]);
    expect(await consumer.handle(delivery(reportId))).toBe('processed');
    expect((await registered(w.projectId)).reduce((sum, row) => sum + BigInt(row.amount_vnd), 0n)).toBe(300_000_000n);
  });

  it('waits for the acceptance of a correction that is being made and then sees the report superseded, so that an old delivery never writes its amounts over the ones of the correction', async () => {
    const w = await world();
    const first = await report(w, FX_DIS_001, { revision: 1 });
    const holder = new Client({ connectionString: harness.database.adminUrl });
    await holder.connect();
    try {
      await holder.query('begin');
      await holder.query('set local session_replication_role = replica');
      // The acceptance of the correction supersedes the first report in its transaction, which has not committed.
      await holder.query(`update machvon.report_revision set status = 'SUPERSEDED', is_current = false where id = $1`, [first]);
      const pending = consumer.handle(delivery(first));
      const settled = await Promise.race([pending.then(() => 'finished'), new Promise((resolve) => setTimeout(() => resolve('waiting'), 700))]);
      expect(settled).toBe('waiting');
      await holder.query('commit');
      expect(await pending).toBe('processed');
    } finally {
      await holder.end();
    }
    expect(await registered(w.projectId)).toEqual([]);
    const audit = await rows<{ safe_diff: Record<string, unknown> }>("select safe_diff from machvon.audit_event where action = 'dis.registration_made' and resource_id = $1::uuid", [first]);
    expect(audit[0]?.safe_diff).toMatchObject({ skipped: 'NOT_ACCEPTED' });
  });

  it('registers nothing for a report that is not accepted, or one that does not exist', async () => {
    const w = await world();
    const submitted = await report(w, FX_DIS_001, { status: 'SUBMITTED' });
    expect(await consumer.handle(delivery(submitted))).toBe('processed');
    expect(await consumer.handle(delivery(randomUUID()))).toBe('processed');
    expect(await registered(w.projectId)).toEqual([]);
    const skipped = await rows<{ skipped: string }>("select safe_diff ->> 'skipped' as skipped from machvon.audit_event where action = 'dis.registration_made' and resource_id = $1::uuid", [submitted]);
    expect(skipped[0]?.skipped).toBe('NOT_ACCEPTED');
  });
});
