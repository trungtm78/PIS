import { randomUUID } from 'node:crypto';
import { AuditWriter } from '../src/audit-writer';
import { ADVANCE_ALERT_EVENT, ADVANCE_ESCALATION_REASON, ADVANCE_OVERDUE_EVENT, PayAdvanceOverdueJob } from '../src/pay-advance-overdue-job';
import { PayAdvanceStore } from '../src/pay-advance-store';
import { CONTRACT, CONTRACTOR, IssWorld, PEOPLE, PROJECT, TENANT_A, UNIT_1, UNIT_2, id, memberId } from './support/iss-fixtures';

jest.setTimeout(600_000);

const world = new IssWorld();
const audit = new AuditWriter(world.harness.tenants);
const job = new PayAdvanceOverdueJob(audit);
const WORKER = memberId(PEOPLE.SYSTEM);
const PARTY = id(0x7d, 40);
/** 06:00 in Vietnam on a day: the hour the job works in. */
const morning = (day: string): Date => new Date(new Date(`${day}T06:00:00+07:00`).getTime());

let tranche = 0;
const run = (day: string) => world.as((tx) => job.run(tx, WORKER, morning(day)));

/** An advance that was paid on 1 July 2026 (kind GPMB: due 31 July) or a contract advance; `recovered` of it already came back. */
async function advanceOf(options: { kind?: 'GPMB' | 'CONTRACT'; recovered?: string } = {}): Promise<string> {
  tranche += 1;
  const kind = options.kind ?? 'GPMB';
  const advanceId = randomUUID();
  const recovered = options.recovered ?? '0';
  await world.owner(
    `insert into machvon.contract_advance
       (tenant_id, id, contract_id, party_id, tranche_no, kind, amount_vnd, cap_vnd, guarantee_id, status, paid_vnd, recovered_vnd, paid_on, recovery_deadline, created_by, updated_by)
     values ($1, $2::uuid, $3::uuid, $4::uuid, $5, $6, 1000000000, 2000000000, $7::uuid, $8, 1000000000, $9::numeric, date '2026-07-01', $10::date, $11::uuid, $11::uuid)`,
    [TENANT_A, advanceId, CONTRACT, PARTY, tranche, kind, kind === 'GPMB' ? null : GUARANTEE, recovered === '0' ? 'PAID' : 'RECOVERING', recovered, kind === 'GPMB' ? '2026-07-31' : null, memberId(PEOPLE.REPORTER)],
  );
  return advanceId;
}
const GUARANTEE = id(0x7d, 41);

const refusalOf = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    return (error as { code: string }).code;
  }
  throw new Error('expected a refusal');
};

const state = async (advanceId: string) =>
  (await world.owner<{ last_alert_level: number; overdue_since: string | null; version: string }>('select last_alert_level, overdue_since::text, version::text from machvon.contract_advance where id = $1::uuid', [advanceId]))[0];
const eventsOf = (advanceId: string, type: string) =>
  world.owner<{ payload: Record<string, unknown>; event_key: string }>('select payload, event_key from machvon.outbox_event where aggregate_id = $1::uuid and type = $2 order by created_at', [advanceId, type]);
const auditsOf = (advanceId: string, action: string) => world.owner<{ safe_diff: Record<string, unknown> }>('select safe_diff from machvon.audit_event where resource_id = $1 and action = $2', [advanceId, action]);

describe('the alerts of the advances that are not recovered in time (ST-PAY-011, UAT-AC328, UAT-AC329)', () => {
  beforeAll(async () => {
    await world.start();
    const by = memberId(PEOPLE.REPORTER);
    await world.owner(
      `insert into machvon.contract_party (tenant_id, id, contract_id, contractor_id, role, share_pct, work_value_vnd, status, valid_from, created_by, updated_by)
       values ($1, $2::uuid, $3::uuid, $4::uuid, 'SOLE', 100, 9000000000, 'ACTIVE', date '2026-01-02', $5::uuid, $5::uuid)`,
      [TENANT_A, PARTY, CONTRACT, CONTRACTOR, by],
    );
    await world.owner(
      `insert into machvon.guarantee
         (tenant_id, id, contract_id, kind, issuer, guarantee_no, amount_vnd, currency, valid_from, expires_at, status, verification_status, document_version_id, verified_by, verified_at, verification_method,
          verification_evidence_id, created_by, updated_by)
       values ($1, $2::uuid, $3::uuid, 'ADVANCE', 'Bank', 'BL-ADV-1', 5000000000, 'VND', date '2026-01-02', now() + interval '1 year', 'ACTIVE', 'VERIFIED', $4::uuid, $5::uuid, now(), 'BANK_CONFIRMATION', $4::uuid, $6::uuid, $6::uuid)`,
      [TENANT_A, GUARANTEE, CONTRACT, id(0x7d, 5), memberId(PEOPLE.ASSIGNER), by],
    );
  });
  afterAll(() => world.stop(), 60_000);
  // Each case works on its own advances: the passes look at every advance that is owed.
  beforeEach(async () => {
    await world.owner('delete from machvon.contract_advance');
  });

  it('AC-ST-PAY-011-1, UAT-AC328: warns a land clearance advance 7 days before its deadline, on it, the day after it and 7 days after it, each level once, and asks ISS for one issue', async () => {
    const advance = await advanceOf();
    expect(await run('2026-07-23')).toMatchObject({ alerted: { 1: 0, 2: 0, 3: 0, 4: 0 }, overdue: 0 });
    expect(await run('2026-07-24')).toMatchObject({ alerted: { 1: 1, 2: 0, 3: 0, 4: 0 }, overdue: 0 });
    expect(await state(advance)).toMatchObject({ last_alert_level: 1, overdue_since: null });
    // A second pass on the same day, and the next day, say nothing more.
    expect(await run('2026-07-24')).toMatchObject({ alerted: { 1: 0, 2: 0, 3: 0, 4: 0 } });
    expect(await run('2026-07-25')).toMatchObject({ alerted: { 1: 0, 2: 0, 3: 0, 4: 0 } });
    expect(await run('2026-07-31')).toMatchObject({ alerted: { 1: 0, 2: 1, 3: 0, 4: 0 } });
    expect((await state(advance))?.last_alert_level).toBe(2);
    expect(await run('2026-08-01')).toMatchObject({ alerted: { 1: 0, 2: 0, 3: 1, 4: 0 }, overdue: 1 });
    expect(await state(advance)).toMatchObject({ last_alert_level: 3, overdue_since: '2026-08-01' });

    const asked = await eventsOf(advance, ADVANCE_OVERDUE_EVENT);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.payload).toMatchObject({ source_ref_id: advance, source_module: 'PAY', severity: 'HIGH', project_id: PROJECT, contract_id: CONTRACT, owner_unit_id: UNIT_1, reference_code: `ADV-${advance.slice(0, 8)}`, kind: 'GPMB' });
    expect(JSON.stringify(asked[0]?.payload)).not.toMatch(/Lead Builders/);
    expect(await run('2026-08-01')).toMatchObject({ alerted: { 3: 0 }, overdue: 1 });
    expect(await eventsOf(advance, ADVANCE_OVERDUE_EVENT)).toHaveLength(1);

    const warned = await eventsOf(advance, ADVANCE_ALERT_EVENT);
    expect(warned.map((event) => event.payload.level)).toEqual([1, 2]);
    expect(warned[0]?.payload.notification).toMatchObject({ resource: { type: 'contract', id: CONTRACT, projectId: PROJECT, contractId: CONTRACT }, recipients: [memberId(PEOPLE.REPORTER)] });
    expect(await auditsOf(advance, 'pay.advance_alerted')).toHaveLength(2);
    expect(await auditsOf(advance, 'pay.advance_overdue')).toHaveLength(1);
    // Nothing marked the advance as recovered, and the version a screen holds did not move.
    expect(await world.owner('select 1 from machvon.contract_advance where id = $1::uuid and recovered_vnd = 0 and status = $2 and version = 1', [advance, 'PAID'])).toHaveLength(1);
  });

  it('UAT-AC328: raises the issue of an advance that is still owed a week after its deadline to the leader, and does it once', async () => {
    const advance = await advanceOf({ recovered: '400000000' });
    const issue = await world.open({ ...world.request({ sourceModule: 'PAY', sourceRefId: advance, ownerUnitId: UNIT_1 }) }, morning('2026-08-10'));
    // The issue was transferred to another unit: the escalation is judged by the unit that holds it now, not by the unit of the project.
    await world.owner('update machvon.issue set owner_unit_id = $2::uuid where id = $1::uuid', [issue.id, UNIT_2]);
    expect(await run('2026-08-10')).toMatchObject({ alerted: { 4: 1 }, escalated: 1 });
    expect(await state(advance)).toMatchObject({ last_alert_level: 4, overdue_since: '2026-08-01' });
    const escalations = await world.owner<{ level: number; reason: string; status: string; trigger: string }>('select level, reason, status, "trigger" from machvon.issue_escalation where issue_id = $1::uuid', [issue.id]);
    expect(escalations).toEqual([{ level: 2, reason: ADVANCE_ESCALATION_REASON, status: 'OPEN', trigger: 'SLA_AUTO' }]);
    expect(await world.owner('select 1 from machvon.outbox_event where aggregate_id = $1::uuid and type = $2', [issue.id, 'iss.issue.escalated.v1'])).toHaveLength(1);
    const [told] = await world.owner<{ payload: { owner_unit_id: string; notification: { resource: { ownerUnitId: string; ownerUnitPath: string } } } }>('select payload from machvon.outbox_event where aggregate_id = $1::uuid and type = $2', [issue.id, 'iss.issue.escalated.v1']);
    expect(told?.payload.notification.resource).toMatchObject({ ownerUnitId: UNIT_2, ownerUnitPath: '/u2/' });
    expect(await auditsOf(issue.id, 'iss.issue_escalated')).toHaveLength(1);
    // The recovery of 400m left 600m owed, and the pass does it no more (the issue was escalated for this reason: a closed escalation is not raised again).
    expect(await run('2026-08-11')).toMatchObject({ alerted: { 4: 0 }, escalated: 0 });
    expect(await world.owner('select 1 from machvon.issue_escalation where issue_id = $1::uuid', [issue.id])).toHaveLength(1);
  });

  it('sends the level an advance is at when it is first found late, leaves the issue alone when none is open, and raises it at a later pass once it is opened', async () => {
    const advance = await advanceOf();
    expect(await run('2026-09-15')).toMatchObject({ alerted: { 1: 0, 2: 0, 3: 0, 4: 1 }, escalated: 0 });
    expect(await state(advance)).toMatchObject({ last_alert_level: 4, overdue_since: '2026-08-01' });
    expect(await eventsOf(advance, ADVANCE_OVERDUE_EVENT)).toHaveLength(0);
    expect(await eventsOf(advance, ADVANCE_ALERT_EVENT)).toHaveLength(1);
    // The issue is opened (or released) later: the next pass raises it, and does not repeat the alert of the level.
    const issue = await world.open({ ...world.request({ sourceModule: 'PAY', sourceRefId: advance, ownerUnitId: UNIT_1 }) }, morning('2026-09-16'));
    expect(await run('2026-09-16')).toMatchObject({ alerted: { 4: 0 }, escalated: 1 });
    expect(await world.owner('select 1 from machvon.issue_escalation where issue_id = $1::uuid', [issue.id])).toHaveLength(1);
    // The issue was escalated for this reason: the next pass does not raise it again.
    expect(await run('2026-09-17')).toMatchObject({ escalated: 0 });
    expect(await eventsOf(advance, ADVANCE_ALERT_EVENT)).toHaveLength(1);
  });

  it('AC-ST-PAY-011-2, UAT-AC329: flags the advance of a contract that has ended with a balance owed, and not one that was recovered in full', async () => {
    const advance = await advanceOf({ kind: 'CONTRACT' });
    // The contract ended: the edges of its status belong to its own commands, so the fixture writes the end the way they leave it.
    await world.owner('alter table machvon.contract disable trigger contract_status_guard');
    await world.owner("update machvon.contract set status = 'TERMINATED', contract_value_vnd = 9000000000, status_reason = 'The contractor left the site', status_decision_document_version_id = $2::uuid, terminated_on = date '2026-12-30', terminated_by = $3::uuid where id = $1::uuid", [CONTRACT, id(0x7d, 5), memberId(PEOPLE.ASSIGNER)]);
    await world.owner('alter table machvon.contract enable trigger contract_status_guard');
    const full = await advanceOf({ kind: 'CONTRACT', recovered: '999999999' });
    await world.owner("update machvon.contract_advance set recovered_vnd = paid_vnd, status = 'FULLY_RECOVERED' where id = $1::uuid", [full]);
    expect(await run('2026-12-31')).toMatchObject({ alerted: { 3: 1 } });
    expect(await state(advance)).toMatchObject({ last_alert_level: 3, overdue_since: '2026-12-31' });
    expect((await eventsOf(advance, ADVANCE_OVERDUE_EVENT))[0]?.payload).toMatchObject({ kind: 'CONTRACT', source_ref_id: advance });
    expect(await state(full)).toMatchObject({ last_alert_level: 0 });
    expect(await run('2027-01-07')).toMatchObject({ alerted: { 4: 1 } });
    // A contract closed under an exception of the settlement can still be owed the advance: it stays on the board and keeps its level.
    await world.owner('alter table machvon.contract disable trigger contract_status_guard');
    await world.owner("update machvon.contract set status = 'CLOSED', signed_on = date '2026-01-02', effective_from = date '2026-01-02' where id = $1::uuid", [CONTRACT]);
    await world.owner('alter table machvon.contract enable trigger contract_status_guard');
    expect(await run('2027-01-08')).toMatchObject({ overdue: 1 });
  });

  it('reads one more row than a page of the largest size, so that the next page is known to exist', async () => {
    for (let n = 0; n < 201; n += 1) {
      const id = await advanceOf();
      await world.owner("update machvon.contract_advance set last_alert_level = 3, overdue_since = date '2026-08-01' where id = $1::uuid", [id]);
    }
    const everything = () => ({ sql: 'true', params: [] as unknown[] });
    const store = new PayAdvanceStore();
    expect(await world.as((tx) => store.overdue(tx, everything, { limit: 201 }))).toHaveLength(201);
    expect(await world.as((tx) => store.list(tx, everything, { limit: 201 }))).toHaveLength(201);
    expect(await world.as((tx) => store.overdue(tx, everything, { limit: 5000 }))).toHaveLength(201);
    expect(await world.as((tx) => store.overdue(tx, everything, { level: 3, limit: 2 }))).toHaveLength(2);
    expect(await refusalOf(world.as((tx) => store.overdue(tx, everything, { level: 5 })))).toBe('VALIDATION_FAILED');
  });
});
