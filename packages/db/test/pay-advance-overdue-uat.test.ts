import { randomUUID } from 'node:crypto';
import { AuditWriter } from '../src/audit-writer';
import { INTAKE_CATEGORY_KEYS, IssIntake, readIntake } from '../src/iss-intake';
import { ADVANCE_ALERT_EVENT, ADVANCE_ESCALATION_REASON, ADVANCE_OVERDUE_EVENT, PayAdvanceOverdueJob } from '../src/pay-advance-overdue-job';
import { PayAdvanceStore } from '../src/pay-advance-store';
import type { ContractScopes } from '../src/ctr-contract-store';
import { CONTRACT, CONTRACTOR, DOCUMENT_CLEAN, IssWorld, PEOPLE, TENANT_A, id, memberId } from './support/iss-fixtures';

jest.setTimeout(600_000);

// UAT-AC328 end to end on the real database: the daily job (clock 06:00 Vietnam on the day), the notification of u.ketoan (the reporter of the world), the issue of ISS opened from the
// event the job writes (the intake the product runs on that event), the recovery recorded through the command, and the escalation of the pass after it.
const world = new IssWorld();
const audit = new AuditWriter(world.harness.tenants);
const job = new PayAdvanceOverdueJob(audit);
const advances = new PayAdvanceStore();
const intake = new IssIntake(world.issues);
const WORKER = memberId(PEOPLE.SYSTEM);
const KETOAN = memberId(PEOPLE.REPORTER);
const PARTY = id(0x7d, 50);
const everything: ContractScopes = { update: () => ({ sql: 'true', params: [] }), read: () => ({ sql: 'true', params: [] }) };
const morning = (day: string): Date => new Date(`${day}T06:00:00+07:00`);
const run = (day: string) => world.as((tx) => job.run(tx, WORKER, morning(day)));

const state = async (advanceId: string) =>
  (await world.owner<{ last_alert_level: number; overdue_since: string | null; status: string; recovered: string; outstanding: string }>(
    'select last_alert_level, overdue_since::text, status, recovered_vnd::text as recovered, outstanding_vnd::text as outstanding from machvon.contract_advance where id = $1::uuid',
    [advanceId],
  ))[0];
const eventsOf = (advanceId: string, type: string) =>
  world.owner<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1::uuid and type = $2 order by created_at', [advanceId, type]);
const issuesOf = (advanceId: string) => world.owner<{ id: string; source_module: string; title: string; status: string }>('select id, source_module, title, status from machvon.issue where source_ref_id = $1::uuid', [advanceId]);

describe('UAT-AC328 an advance that is not recovered in time: alerts by level, one issue, escalation, never marked recovered by itself', () => {
  beforeAll(async () => {
    await world.start();
    const by = KETOAN;
    await world.owner(
      `insert into machvon.contract_party (tenant_id, id, contract_id, contractor_id, role, share_pct, work_value_vnd, status, valid_from, created_by, updated_by)
       values ($1, $2::uuid, $3::uuid, $4::uuid, 'SOLE', 100, 9000000000, 'ACTIVE', date '2026-01-02', $5::uuid, $5::uuid)`,
      [TENANT_A, PARTY, CONTRACT, CONTRACTOR, by],
    );
    const category = await world.seedCategory(TENANT_A, 'ISSUE_CATEGORY', INTAKE_CATEGORY_KEYS.PAY);
    for (const severity of ['HIGH', 'MEDIUM']) {
      await world.as((tx) => world.policies.publish(tx, { code: `SLA-PAY-${severity}`, categoryVersionId: category, severity, calendarCode: 'WORKDAY_VN', responseHours: 4, resolveHours: 16, validFrom: '2026-08-01' }, WORKER));
    }
  }, 300_000);
  afterAll(() => world.stop(), 60_000);

  it('UAT-AC328: warns at 7 days before (07-24) and on the deadline (07-31), at 08-01 sets overdue_since, level 3 and ONE ISS issue (PAY), after a recovery of 400m the 600m stay owed and overdue, 08-08 is level 4 and escalates to level 2, and nothing marks it recovered', async () => {
    // ADV-G-001: land clearance (GPMB) advance of 1,000,000,000 paid on 2026-07-01 to the investor-side party, deadline 2026-07-31, nothing recovered.
    const advance = randomUUID();
    await world.owner(
      `insert into machvon.contract_advance
         (tenant_id, id, contract_id, party_id, tranche_no, kind, amount_vnd, cap_vnd, guarantee_id, status, paid_vnd, recovered_vnd, paid_on, recovery_deadline, created_by, updated_by)
       values ($1, $2::uuid, $3::uuid, $4::uuid, 1, 'GPMB', 1000000000, 2000000000, null, 'PAID', 1000000000, 0, date '2026-07-01', date '2026-07-31', $5::uuid, $5::uuid)`,
      [TENANT_A, advance, CONTRACT, PARTY, KETOAN],
    );
    await world.owner('update machvon.contract set contract_value_vnd = 9000000000, advance_paid_vnd = 1000000000 where id = $1::uuid', [CONTRACT]);

    // Before the window nothing is said.
    expect(await run('2026-07-23')).toMatchObject({ alerted: { 1: 0, 2: 0, 3: 0, 4: 0 }, overdue: 0 });

    // 07-24: level 1 (7 days left), the notification goes to u.ketoan.
    expect(await run('2026-07-24')).toMatchObject({ alerted: { 1: 1, 2: 0, 3: 0, 4: 0 }, overdue: 0 });
    expect(await state(advance)).toMatchObject({ last_alert_level: 1, overdue_since: null });
    const first = await eventsOf(advance, ADVANCE_ALERT_EVENT);
    expect(first).toHaveLength(1);
    expect(first[0]?.payload).toMatchObject({ level: 1, kind: 'GPMB', outstanding_vnd: '1000000000', recovery_deadline: '2026-07-31', notification: { recipients: [KETOAN] } });

    // 07-31: level 2 (due today).
    expect(await run('2026-07-31')).toMatchObject({ alerted: { 1: 0, 2: 1, 3: 0, 4: 0 } });
    expect((await state(advance))?.last_alert_level).toBe(2);

    // 08-01: overdue_since = 2026-08-01, level 3, ONE issue asked of ISS, and run again it asks for no second one.
    expect(await run('2026-08-01')).toMatchObject({ alerted: { 1: 0, 2: 0, 3: 1, 4: 0 }, overdue: 1 });
    expect(await state(advance)).toMatchObject({ last_alert_level: 3, overdue_since: '2026-08-01' });
    expect(await run('2026-08-01')).toMatchObject({ alerted: { 3: 0 }, overdue: 1 });
    const asked = await eventsOf(advance, ADVANCE_OVERDUE_EVENT);
    expect(asked).toHaveLength(1);
    const payload = asked[0]?.payload as Record<string, unknown>;
    expect(payload).toMatchObject({ source_module: 'PAY', source_ref_id: advance, severity: 'HIGH', outstanding_vnd: '1000000000', kind: 'GPMB' });
    // The intake of ISS opens the issue from that event, once, however many times the event is delivered.
    const reading = readIntake(ADVANCE_OVERDUE_EVENT, payload);
    if (reading.kind !== 'REQUEST') throw new Error('the overdue event is not an issue request');
    const delivery = randomUUID();
    expect((await world.as((tx) => intake.open(tx, reading.request, delivery, WORKER, morning('2026-08-01')))).kind).toBe('OPENED');
    expect((await world.as((tx) => intake.open(tx, reading.request, delivery, WORKER, morning('2026-08-01')))).kind).toBe('DUPLICATE');
    expect((await world.as((tx) => intake.open(tx, reading.request, randomUUID(), WORKER, morning('2026-08-01')))).kind).toBe('DUPLICATE');
    const issues = await issuesOf(advance);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ source_module: 'PAY', title: 'Advance overdue: ADV-' + advance.slice(0, 8), status: 'OPEN' });

    // 08-02: u.ketoan records a recovery of 400,000,000 through the command; the advance is not marked recovered by the pass.
    await world.as(async (tx) => {
      await advances.recordRecovery(tx, advance, 1, { amountVnd: '400000000', basis: 'REFUND', evidenceDocumentVersionId: DOCUMENT_CLEAN, requestId: randomUUID() }, KETOAN, everything);
    });
    expect(await state(advance)).toMatchObject({ status: 'RECOVERING', recovered: '400000000', outstanding: '600000000', overdue_since: '2026-08-01', last_alert_level: 3 });

    // 08-08: still overdue with 600,000,000 owed: level 4 and the issue is escalated to level 2 (the leader), once.
    expect(await run('2026-08-08')).toMatchObject({ alerted: { 4: 1 }, escalated: 1, overdue: 1 });
    expect(await state(advance)).toMatchObject({ last_alert_level: 4, overdue_since: '2026-08-01', status: 'RECOVERING', outstanding: '600000000' });
    const escalations = await world.owner<{ level: number; reason: string; trigger: string; status: string }>('select level, reason, "trigger", status from machvon.issue_escalation where issue_id = $1::uuid', [issues[0]?.id]);
    expect(escalations).toEqual([{ level: 2, reason: ADVANCE_ESCALATION_REASON, trigger: 'SLA_AUTO', status: 'OPEN' }]);
    expect(await run('2026-08-09')).toMatchObject({ alerted: { 4: 0 }, escalated: 0 });
    expect(await world.owner('select 1 from machvon.issue_escalation where issue_id = $1::uuid', [issues[0]?.id])).toHaveLength(1);

    // Nothing in the whole run marked the advance as fully recovered: the 600m stays owed.
    expect(await world.owner("select 1 from machvon.contract_advance where id = $1::uuid and status = 'FULLY_RECOVERED'", [advance])).toHaveLength(0);
    expect(await issuesOf(advance)).toHaveLength(1);
  });

  it('negative control: a check that expects the wrong level or amount fails', async () => {
    const advance = randomUUID();
    await world.owner(
      `insert into machvon.contract_advance
         (tenant_id, id, contract_id, party_id, tranche_no, kind, amount_vnd, cap_vnd, guarantee_id, status, paid_vnd, recovered_vnd, paid_on, recovery_deadline, created_by, updated_by)
       values ($1, $2::uuid, $3::uuid, $4::uuid, 2, 'GPMB', 100000000, 200000000, null, 'PAID', 100000000, 0, date '2026-07-01', date '2026-12-31', $5::uuid, $5::uuid)`,
      [TENANT_A, advance, CONTRACT, PARTY, KETOAN],
    );
    await run('2026-07-23');
    const row = await state(advance);
    expect(() => expect(row).toMatchObject({ last_alert_level: 1, overdue_since: '2026-08-01' })).toThrow();
    expect(() => expect(row).toMatchObject({ outstanding: '600000000' })).toThrow();
  });
});
