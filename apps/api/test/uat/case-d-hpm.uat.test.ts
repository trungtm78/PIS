import { createHash, randomUUID } from 'node:crypto';
import { BASELINE_PACK, applyBaseline } from '@machvon/db';
import type { TenantDatabase } from '@machvon/db';
import { FileService } from '../../src/modules/files';
import { TENANT_A } from '../../../../packages/db/test/support/authz-fixtures';
import { assertNoOutbound, recordConnections } from './case-d-support';
import type { Doc } from './case-d-support';
import { assertStatus, expectCheckFails } from './uat-kit';
import type { Reply } from './uat-kit';
import { UatWorld } from './uat-world';

/**
 * The design cases of the push to HPM that no suite named (docs/uat/hpm/uat.json): PLAN-169 (the commands of the push), PLAN-171 (the commands of the correction), HPM-E2E-02 (a correction of a period that HPM accepted,
 * with the reopening of the period granted by the real DIS: generated, closed and locked periods, a request and a decision of two people) and HPM-PX-01 (the labels of a push while the interface of HPM is unknown, PENDING-EXTERNAL PX-03).
 * The world is the whole enterprise edition over a real database with the file writer of the edition as HPM: what HPM answers is recorded by hand, as the design says. No mock stands in for a behaviour; "no outbound
 * network call" is measured by recording the connections the process opens.
 */
jest.setTimeout(600_000);

const LAYOUT = 'HPM-MONTHLY';
const REASON = 'A late invoice changed the executed value of the month';
const DECISION_REASON = 'The invoice and the reopening are in order';
const PERSONAS = {
  'hpm-admin': ['hpm.read', 'hpm.admin', 'hpm.push', 'hpm.receipt', 'hpm.correction.propose', 'hpm.correction.decide'],
  'hpm-pusher': ['hpm.read', 'hpm.push'],
  'hpm-receiver': ['hpm.read', 'hpm.receipt'],
  'hpm-proposer': ['hpm.read', 'hpm.correction.propose', 'hpm.correction.decide'],
  'hpm-approver': ['hpm.read', 'hpm.correction.decide'],
  'hpm-reader': ['hpm.read'],
  'dis-manager': ['period.manage', 'period.lock', 'reporting_period.read'],
  'dis-requester': ['period.reopen.request', 'reporting_period.read'],
  'dis-approver': ['period.reopen.approve', 'reporting_period.read'],
};
const SYSTEM_ACTOR = '00000000-0000-4000-8000-000000000000';

describe('UAT cases of the push to HPM (PLAN-169, PLAN-171, HPM-E2E-02, HPM-PX-01)', () => {
  const world = new UatWorld();
  let counter = 0;

  beforeAll(async () => {
    await world.start(PERSONAS, {}, async (w) => {
      // The reporting calendar of the platform: the periods of DIS are generated from it.
      await (w.harness.tenants as TenantDatabase).withTenant({ tenantId: TENANT_A, membershipId: SYSTEM_ACTOR, scopeVersion: 0 }, (tx) => applyBaseline(tx, BASELINE_PACK, SYSTEM_ACTOR));
    });
    // The weeks of 2025 of the reporting calendar of DIS: the reopening of a period is DIS's, and a push names it.
    assertStatus(await world.as('dis-manager', 'POST', '/reporting-periods/generate', { body: { calendar_code: 'DEFAULT', fiscal_year: 2025, period_type: 'WEEK' } }), 200);
  }, 600_000);

  afterAll(() => world.stop(), 60_000);

  /** A report file in the store of the tenant, as an issued copy leaves it: the key to name and the hash to state. */
  async function report(content = `row-${(counter += 1)}`): Promise<{ key: string; sha: string }> {
    const bytes = new TextEncoder().encode(`code,value\n${content}\n`);
    const stored = await world.get<FileService>(FileService).upload({ tenantId: TENANT_A, membershipId: world.idOf('hpm-admin'), scopeVersion: 1 }, { purpose: 'report_export', declaredType: 'text/csv', bytes });
    return { key: stored.key, sha: createHash('sha256').update(bytes).digest('hex') };
  }

  const push = (persona: string, file: { key: string; sha: string }, period: string, revision: number, extra: { key?: string; correction_id?: string } = {}): Promise<Reply> => {
    const { key, ...rest } = extra;
    return world.as(persona, 'POST', '/hpm/pushes', { ...(key === undefined ? {} : { key }), body: { layout_code: LAYOUT, period, revision, sha256: file.sha, file_object_key: file.key, ...rest } });
  };
  const pushOf = (reply: Reply): Doc => reply.json.push as Doc;
  const receipt = (persona: string, row: Record<string, unknown>, body: Record<string, unknown>, key?: string): Promise<Reply> =>
    world.as(persona, 'POST', `/hpm/pushes/${String(row.id)}/receipt`, { ...(key === undefined ? {} : { key }), ifMatch: row.version as number, body });
  const count = async (sql: string, params: unknown[] = []): Promise<number> => Number((await world.rows<{ n: string }>(`select count(*)::text as n from (${sql}) t`, params))[0]?.n);
  const currentOf = async (period: string): Promise<Doc> => ((await world.as('hpm-reader', 'GET', `/hpm/pushes?period=${period}`)).json.items as Array<Doc>)[0] as Doc;

  /** Pushes a report and has the receiver accept it: the period then stands as accepted. */
  async function accepted(period: string, content: string): Promise<Doc> {
    const sent = pushOf(await push('hpm-pusher', await report(content), period, 1));
    assertStatus(await receipt('hpm-receiver', sent, { outcome: 'ACCEPTED', reference: `HPM-${period}` }), 200);
    return currentOf(period);
  }

  /** The reopening of the week of `day`, as DIS gives it: the week is closed and locked after its deadline, one person asks for it for the whole period and another grants it for 72 hours. */
  async function reopenWeekOf(day: string): Promise<string> {
    const [week] = await world.rows<{ id: string }>('select id from machvon.reporting_period where calendar_code = $2 and period_type = $3 and start_date <= $1::date and end_date >= $1::date', [day, 'DEFAULT', 'WEEK']);
    if (week === undefined) throw new Error(`no week of the calendar holds ${day}`);
    assertStatus(await world.as('dis-manager', 'POST', `/reporting-periods/${week.id}/soft-close`, { ifMatch: 1, body: { reason: 'The deadline has passed' } }), 200);
    assertStatus(await world.as('dis-manager', 'POST', `/reporting-periods/${week.id}/lock`, { ifMatch: 2, body: { reason: 'Locked after the review' } }), 200);
    const asked = await world.as('dis-requester', 'POST', `/reporting-periods/${week.id}/reopen-requests`, { body: { scope_kind: 'PERIOD', reason: 'The Treasury returned the vouchers of the month', window_hours: 72 } });
    assertStatus(asked, 200);
    assertStatus(await world.as('dis-approver', 'POST', `/period-reopens/${String(asked.json.resource_id)}/decision`, { ifMatch: 1, body: { decision: 'approve', reason: 'The vouchers are documented', window_hours: 72 } }), 200);
    return asked.json.resource_id as string;
  }

  const propose = (persona: string, period: string, reopenId: string, key?: string): Promise<Reply> =>
    world.as(persona, 'POST', '/hpm/corrections', { ...(key === undefined ? {} : { key }), body: { layout_code: LAYOUT, period, from_revision: 1, period_reopen_id: reopenId, reason: REASON } });
  const decide = (persona: string, correctionId: string, version: number, decision = 'APPROVE', key?: string): Promise<Reply> =>
    world.as(persona, 'POST', `/hpm/corrections/${correctionId}/decision`, { ...(key === undefined ? {} : { key }), ifMatch: version, body: { decision, reason: DECISION_REASON } });

  it('UAT-PLAN-169 the commands of the push: a report is submitted, tried again and receipted, the same key repeats the first answer without new rows, a stale or conflicting request is refused with its code, the audit rows name the actor and no connection leaves the machine', async () => {
    const log = recordConnections();
    try {
      const file = await report('issued,report,169');
      // Step 1: submit, retry and record the receipt, each by the person who holds that right.
      const key = `uat-${randomUUID()}`;
      const sent = await push('hpm-pusher', file, '2024-M05', 1, { key });
      assertStatus(sent, 200);
      expect(sent.json).toMatchObject({ status: 'SENT' });
      const row = pushOf(sent);
      expect(row).toMatchObject({ status: 'WRITTEN', attempts: 1, acceptance: 'PENDING_EXTERNAL', pushed_by: world.idOf('hpm-pusher'), sha256: file.sha });
      const retryKey = `uat-${randomUUID()}`;
      const retried = await world.as('hpm-pusher', 'POST', `/hpm/pushes/${row.id}/retry`, { key: retryKey, ifMatch: row.version, body: {} });
      assertStatus(retried, 200);
      expect(pushOf(retried)).toMatchObject({ attempts: 2, status: 'WRITTEN' });
      const receiptKey = `uat-${randomUUID()}`;
      const done = await receipt('hpm-receiver', pushOf(retried), { outcome: 'ACCEPTED', reference: 'HPM-169' }, receiptKey);
      assertStatus(done, 200);
      expect(done.json).toMatchObject({ status: 'ACCEPTED', resource_id: row.id });
      // Step 2: the same key repeats the first answer; no new row, attempt, audit row or event.
      const attemptsOf = (): Promise<number> => count('select 1 from machvon.hpm_push_attempt where push_id = $1::uuid', [row.id]);
      expect(await attemptsOf()).toBe(2);
      const again = await push('hpm-pusher', file, '2024-M05', 1, { key });
      assertStatus(again, 200);
      expect(again.json).toMatchObject({ resource_id: row.id });
      const retriedAgain = await world.as('hpm-pusher', 'POST', `/hpm/pushes/${row.id}/retry`, { key: retryKey, ifMatch: row.version, body: {} });
      assertStatus(retriedAgain, 200);
      expect(pushOf(retriedAgain)).toMatchObject({ attempts: 2 });
      const receiptAgain = await receipt('hpm-receiver', pushOf(retried), { outcome: 'ACCEPTED', reference: 'HPM-169' }, receiptKey);
      assertStatus(receiptAgain, 200);
      expect(receiptAgain.json).toMatchObject({ status: 'ACCEPTED', resource_id: row.id });
      expect(await attemptsOf()).toBe(2);
      expect(await count('select 1 from machvon.hpm_push where period = $1', ['2024-M05'])).toBe(1);
      expect(await world.audits(row.id, 'hpm.push_submitted')).toHaveLength(1);
      expect(await world.audits(row.id, 'hpm.push_retried')).toHaveLength(1);
      expect(await world.audits(row.id, 'hpm.receipt_accepted')).toHaveLength(1);
      expect(await world.events(row.id, 'hpm.push.receipt.recorded.v1')).toHaveLength(1);
      // The same report under a new key is already delivered: no new attempt either.
      const delivered = await push('hpm-pusher', file, '2024-M05', 1);
      expect(delivered.json).toMatchObject({ status: 'ALREADY_DELIVERED', resource_id: row.id });
      expect(await attemptsOf()).toBe(2);
      // Step 3: a stale version, a conflicting content for the same period and revision, an older revision, and a second receipt are refused with their codes.
      const current = await currentOf('2024-M05');
      assertStatus(await world.as('hpm-pusher', 'POST', `/hpm/pushes/${row.id}/retry`, { ifMatch: 1, body: {} }), 409, 'VERSION_CONFLICT');
      assertStatus(await world.as('hpm-pusher', 'POST', `/hpm/pushes/${row.id}/retry`, { ifMatch: current.version, body: {} }), 409, 'HPM_PUSH_STATE_INVALID');
      assertStatus(await push('hpm-pusher', await report('other,content,169'), '2024-M05', 1), 409, 'HPM_KEY_REUSED');
      assertStatus(await receipt('hpm-receiver', current, { outcome: 'ACCEPTED', reference: 'HPM-169-again' }), 409, 'HPM_PUSH_STATE_INVALID');
      const head = pushOf(await push('hpm-pusher', await report('rev,two,169'), '2024-M06', 2));
      expect(head).toMatchObject({ revision: 2 });
      assertStatus(await push('hpm-pusher', await report('rev,one,169'), '2024-M06', 1), 409, 'REPORT_OUT_OF_DATE');
      expect(await count('select 1 from machvon.hpm_push where period = $1', ['2024-M06'])).toBe(1);
      // Step 4: the audit rows name the actor of each command.
      expect((await world.audits(row.id, 'hpm.push_submitted'))[0]).toMatchObject({ actor_id: world.idOf('hpm-pusher'), safe_diff: { outcome: 'SENT', sha256: file.sha } });
      expect((await world.audits(row.id, 'hpm.push_retried'))[0]).toMatchObject({ actor_id: world.idOf('hpm-pusher'), safe_diff: { attempts: 2 } });
      expect((await world.audits(row.id, 'hpm.receipt_accepted'))[0]).toMatchObject({ actor_id: world.idOf('hpm-receiver') });
    } finally {
      log.stop();
    }
    assertNoOutbound(log.targets);
  });

  it('UAT-PLAN-171 the commands of the correction: a correction is proposed and decided by two people, the same key repeats the first answer without new rows, a stale or settled request is refused with its code, the audit rows name the actor and no connection leaves the machine', async () => {
    const log = recordConnections();
    try {
      await accepted('2025-M08', 'issued,report,171');
      const reopenId = await reopenWeekOf('2025-08-13');
      // Step 1: propose and decide.
      const proposeKey = `uat-${randomUUID()}`;
      const proposed = await propose('hpm-proposer', '2025-M08', reopenId, proposeKey);
      assertStatus(proposed, 200);
      expect(proposed.json).toMatchObject({ state: 'PROPOSED', from_revision: 1, period_reopen_id: reopenId, proposed_by: world.idOf('hpm-proposer') });
      const correctionId = proposed.json.id as string;
      const decideKey = `uat-${randomUUID()}`;
      const approved = await decide('hpm-approver', correctionId, 1, 'APPROVE', decideKey);
      assertStatus(approved, 200);
      expect(approved.json).toMatchObject({ status: 'APPROVED', resource_version: 2 });
      // Step 2: the same key repeats the first answer; no new row, audit row or event.
      const proposedAgain = await propose('hpm-proposer', '2025-M08', reopenId, proposeKey);
      assertStatus(proposedAgain, 200);
      expect(proposedAgain.json).toMatchObject({ id: correctionId, state: 'PROPOSED' });
      const approvedAgain = await decide('hpm-approver', correctionId, 1, 'APPROVE', decideKey);
      assertStatus(approvedAgain, 200);
      expect(approvedAgain.json).toMatchObject({ status: 'APPROVED', resource_version: 2 });
      expect(await count('select 1 from machvon.hpm_correction where period = $1', ['2025-M08'])).toBe(1);
      expect(await world.audits(correctionId, 'hpm.correction_proposed')).toHaveLength(1);
      expect(await world.audits(correctionId, 'hpm.correction_approved')).toHaveLength(1);
      // Step 3: a second proposal for the revision, a second decision and a stale version are refused with their codes.
      assertStatus(await propose('hpm-proposer', '2025-M08', reopenId), 409, 'HPM_CORRECTION_STATE_INVALID');
      assertStatus(await decide('hpm-approver', correctionId, 2, 'REJECT'), 409, 'HPM_CORRECTION_STATE_INVALID');
      assertStatus(await decide('hpm-approver', correctionId, 1, 'REJECT'), 409, 'VERSION_CONFLICT');
      expect((await world.rows<{ state: string }>('select state from machvon.hpm_correction where id = $1::uuid', [correctionId]))[0]?.state).toBe('APPROVED');
      // Step 4: the audit rows name the actor of each command.
      expect((await world.audits(correctionId, 'hpm.correction_proposed'))[0]).toMatchObject({ actor_id: world.idOf('hpm-proposer'), reason: REASON });
      expect((await world.audits(correctionId, 'hpm.correction_approved'))[0]).toMatchObject({ actor_id: world.idOf('hpm-approver'), safe_diff: { state: 'APPROVED', proposed_by: world.idOf('hpm-proposer') } });
    } finally {
      log.stop();
    }
    assertNoOutbound(log.targets);
  });

  it('UAT-HPM-E2E-02 a correction of a period that HPM accepted: the decider cannot propose, the reopening of another period is refused, the proposer cannot approve their own, the decider approves, the new revision is pushed once and a third revision cannot use the same correction', async () => {
    const accepted05 = await accepted('2025-M05', 'issued,report,e2e02');
    expect(accepted05).toMatchObject({ status: 'ACCEPTED', revision: 1 });
    const mayReopen = await reopenWeekOf('2025-05-14');
    const julyReopen = await reopenWeekOf('2025-07-16');
    // Step 1: the person who decides does not hold the right to propose.
    const byDecider = await propose('hpm-approver', '2025-M05', mayReopen);
    assertStatus(byDecider, 403);
    expect(await count('select 1 from machvon.hpm_correction where period = $1', ['2025-M05'])).toBe(0);
    // Step 2: a reopening that DIS granted for another period is not the reopening of this one.
    const wrongPeriod = await propose('hpm-proposer', '2025-M05', julyReopen);
    assertStatus(wrongPeriod, 409, 'HPM_OVERWRITE_NOT_AUTHORISED');
    expect(wrongPeriod.json).toMatchObject({ missing: ['PERIOD_REOPENED'] });
    expect(await count('select 1 from machvon.hpm_correction where period = $1', ['2025-M05'])).toBe(0);
    // Step 3: with the right reopening the correction is proposed.
    const proposed = await propose('hpm-proposer', '2025-M05', mayReopen);
    assertStatus(proposed, 200);
    expect(proposed.json).toMatchObject({ state: 'PROPOSED', from_revision: 1, period_reopen_id: mayReopen, proposed_by: world.idOf('hpm-proposer') });
    const correctionId = proposed.json.id as string;
    // Step 4: the proposer, who holds the right to decide too, cannot approve their own proposal.
    assertStatus(await decide('hpm-proposer', correctionId, 1), 403, 'SELF_APPROVAL_DENIED');
    expect((await world.rows<{ state: string }>('select state from machvon.hpm_correction where id = $1::uuid', [correctionId]))[0]?.state).toBe('PROPOSED');
    // Step 5: the other person approves.
    const approved = await decide('hpm-approver', correctionId, 1);
    assertStatus(approved, 200);
    expect(approved.json).toMatchObject({ status: 'APPROVED' });
    expect((await world.audits(correctionId, 'hpm.correction_approved'))[0]).toMatchObject({ actor_id: world.idOf('hpm-approver') });
    // Step 6: revision 2 is pushed with the correction and the correction is used.
    const second = await push('hpm-pusher', await report('issued,report,e2e02,rev2'), '2025-M05', 2, { correction_id: correctionId });
    assertStatus(second, 200);
    expect(pushOf(second)).toMatchObject({ status: 'WRITTEN', revision: 2, overwrites: true, correction_id: correctionId });
    expect((await world.rows<{ state: string; consumed_by_push_id: string }>('select state, consumed_by_push_id::text from machvon.hpm_correction where id = $1::uuid', [correctionId]))[0]).toEqual({ state: 'CONSUMED', consumed_by_push_id: pushOf(second).id });
    expect(await world.audits(correctionId, 'hpm.correction_consumed')).toHaveLength(1);
    // Step 7: a third revision with the same correction is refused: it is used once.
    const third = await push('hpm-pusher', await report('issued,report,e2e02,rev3'), '2025-M05', 3, { correction_id: correctionId });
    assertStatus(third, 409, 'HPM_OVERWRITE_NOT_AUTHORISED');
    expect(await count('select 1 from machvon.hpm_push where period = $1 and revision = 3', ['2025-M05'])).toBe(0);
  });

  it('UAT-HPM-PX-01 while the interface of HPM is unknown every push carries acceptance PENDING_EXTERNAL, a receipt recorded by hand does not change it, and the connection and the log name what waits for the customer (the data of the PENDING-EXTERNAL band)', async () => {
    // Step 1: a report is pushed by the file writer, which stands for HPM.
    const sent = await push('hpm-pusher', await report('issued,report,px03'), '2024-M09', 1);
    assertStatus(sent, 200);
    expect(pushOf(sent)).toMatchObject({ status: 'WRITTEN', acceptance: 'PENDING_EXTERNAL' });
    expect((await world.audits(pushOf(sent).id as string, 'hpm.push_submitted'))[0]?.safe_diff).toMatchObject({ acceptance: 'PENDING_EXTERNAL' });
    // Step 2: the log (HPM-01) shows the acceptance column of every push, also after a receipt recorded by hand: HPM itself has answered nothing.
    assertStatus(await receipt('hpm-receiver', pushOf(sent), { outcome: 'ACCEPTED', reference: 'HAND-PX03' }), 200);
    const listed = await world.as('hpm-reader', 'GET', '/hpm/pushes?limit=200');
    assertStatus(listed, 200);
    const rows = listed.json.items as Array<{ acceptance: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const row of rows) expect(row.acceptance).toBe('PENDING_EXTERNAL');
    expect(rows.find((row) => (row as Record<string, unknown>).id === pushOf(sent).id)).toMatchObject({ status: 'ACCEPTED', acceptance: 'PENDING_EXTERNAL' });
    const connection = await world.as('hpm-reader', 'GET', '/hpm/connection');
    assertStatus(connection, 200);
    const waiting = connection.json.pending_external as Array<{ code: string; what: string; owner: string; consequence: string }>;
    expect(waiting.map((entry) => entry.code)).toContain('HPM_INTERFACE');
    for (const entry of waiting) for (const field of [entry.what, entry.owner, entry.consequence]) expect(field).not.toBe('');
    expect(connection.json).toMatchObject({ acceptance: 'PENDING_EXTERNAL' });
  });

  it('negative control: the checks of this suite go red on an answer that is wrong on purpose', () => {
    expectCheckFails(() => assertStatus({ status: 200, json: {} }, 409, 'HPM_KEY_REUSED'));
    expectCheckFails(() => assertStatus({ status: 409, json: { code: 'REPORT_OUT_OF_DATE' } }, 409, 'HPM_KEY_REUSED'));
    expectCheckFails(() => assertNoOutbound(['localhost', '198.51.100.9']));
  });
});
