import { DisFlow, ELSEWHERE_REVIEWER, MAKER, OTHER_MAKER, READER, REVIEWER, memberId } from './support/dis-flow-app';
import type { Reply } from './support/dis-flow-app';

/**
 * The characterisation layer of WF-1 (regression contract R4): one table of the outcomes of the review of a weekly report as they are today, with the tenant on its default definition (the single decision of
 * the unit reviewer). Each journey is recorded as what a caller can observe: the answer (status, code, detail), the state the report is left in, the rows of the audit trail and the events that were written,
 * and the number of workflow instances the engine holds. The tests of `report-decision.test.ts` pin the same outcomes one by one; this table is the one the staged definition is compared with, and it must
 * stay green whatever the engine does behind the decision.
 */
interface Observed {
  answer: { status: number; code?: unknown; detail?: unknown; reportStatus?: unknown; resultStatus?: unknown; resourceVersion?: unknown };
  report: { status: string; version: string; current: boolean; acceptedBy: 'REVIEWER' | null } | null;
  audit: string[];
  events: string[];
  instances: number;
}

describe('the review of a weekly report on the default definition: the outcomes WF-1 must keep (R4)', () => {
  const flow = new DisFlow();

  beforeAll(async () => {
    await flow.start({ tmpPrefix: 'machvon-dis-characterisation-' });
  }, 300_000);

  afterAll(async () => {
    await flow.stop();
  }, 60_000);

  const answerOf = (reply: Reply): Observed['answer'] => ({
    status: reply.status,
    ...(reply.json.code === undefined ? {} : { code: reply.json.code }),
    ...(reply.json.detail === undefined ? {} : { detail: reply.json.detail }),
    ...(reply.json.report_status === undefined ? {} : { reportStatus: reply.json.report_status }),
    ...(reply.status === 200 ? { resultStatus: reply.json.status, resourceVersion: reply.json.resource_version } : {}),
  });

  async function observe(reportId: string, reply: Reply): Promise<Observed> {
    const row = await flow.state(reportId);
    const trail = await flow.trail(reportId);
    const events = await flow.rows<{ type: string }>('select type from machvon.outbox_event where aggregate_id = $1 and type like $2 order by created_at, id', [reportId, 'report.%']);
    const instances = await flow.rows<{ n: string }>('select count(*)::text as n from machvon.workflow_instance where resource_id = $1', [reportId]);
    return {
      answer: answerOf(reply),
      report: row === undefined ? null : { status: row.status, version: row.version, current: row.is_current, acceptedBy: row.accepted_by === memberId(REVIEWER) ? 'REVIEWER' : null },
      audit: trail.map((entry) => entry.action).filter((action) => action.startsWith('dis.')),
      events: events.map((event) => event.type),
      instances: Number(instances[0]?.n ?? 0),
    };
  }

  const SUBMITTED_TRAIL = ['dis.report_created', 'dis.report_submitted'];
  const SUBMITTED_EVENTS = ['report.submitted.v1'];

  it('accept: ACCEPTED at version 3, the reviewer recorded, one accepted event, no workflow instance', async () => {
    const { reportId } = await flow.submitted();
    expect(await observe(reportId, await flow.approve(reportId, 2))).toEqual({
      answer: { status: 200, resultStatus: 'ACCEPTED', resourceVersion: 3 },
      report: { status: 'ACCEPTED', version: '3', current: true, acceptedBy: 'REVIEWER' },
      audit: [...SUBMITTED_TRAIL, 'dis.report_accepted'],
      events: [...SUBMITTED_EVENTS, 'report.accepted.v1'],
      instances: 0,
    } satisfies Observed);
  });

  it('return with its reason: RETURNED at version 3, one returned event, no workflow instance', async () => {
    const { reportId } = await flow.submitted();
    expect(await observe(reportId, await flow.giveBack(reportId, 2))).toEqual({
      answer: { status: 200, resultStatus: 'RETURNED', resourceVersion: 3 },
      report: { status: 'RETURNED', version: '3', current: false, acceptedBy: null },
      audit: [...SUBMITTED_TRAIL, 'dis.report_returned'],
      events: [...SUBMITTED_EVENTS, 'report.returned.v1'],
      instances: 0,
    } satisfies Observed);
  });

  it('request an amendment of an accepted report: AMENDMENT_REQUESTED at version 4, the report stays the current one', async () => {
    const { reportId } = await flow.submitted();
    await flow.approve(reportId, 2);
    const asked = await flow.decide(reportId, 3, { decision: 'request_amendment', reason: 'The Treasury corrected a payment.', evidence_ids: [] });
    expect(await observe(reportId, asked)).toEqual({
      answer: { status: 200, resultStatus: 'AMENDMENT_REQUESTED', resourceVersion: 4 },
      report: { status: 'AMENDMENT_REQUESTED', version: '4', current: true, acceptedBy: 'REVIEWER' },
      audit: [...SUBMITTED_TRAIL, 'dis.report_accepted', 'dis.report_amendment_requested'],
      events: [...SUBMITTED_EVENTS, 'report.accepted.v1', 'report.returned.v1'],
      instances: 0,
    } satisfies Observed);
  });

  it('the maker is 403 SELF_APPROVAL_DENIED and the report stays SUBMITTED with nothing written but the denial', async () => {
    const { reportId } = await flow.submitted();
    expect(await observe(reportId, await flow.approve(reportId, 2, MAKER))).toEqual({
      answer: { status: 403, code: 'SELF_APPROVAL_DENIED' },
      report: { status: 'SUBMITTED', version: '2', current: false, acceptedBy: null },
      audit: SUBMITTED_TRAIL,
      events: SUBMITTED_EVENTS,
      instances: 0,
    } satisfies Observed);
  });

  it('a decision on a report that was already returned is 409 REPORT_STATE_INVALID naming the status', async () => {
    const { reportId } = await flow.submitted();
    await flow.giveBack(reportId, 2);
    expect(await observe(reportId, await flow.approve(reportId, 3))).toEqual({
      answer: { status: 409, code: 'REPORT_STATE_INVALID', detail: 'status', reportStatus: 'RETURNED' },
      report: { status: 'RETURNED', version: '3', current: false, acceptedBy: null },
      audit: [...SUBMITTED_TRAIL, 'dis.report_returned'],
      events: [...SUBMITTED_EVENTS, 'report.returned.v1'],
      instances: 0,
    } satisfies Observed);
  });

  it('a stale version is 409 VERSION_CONFLICT and the report is as it was', async () => {
    const { reportId } = await flow.submitted();
    expect(await observe(reportId, await flow.approve(reportId, 1))).toMatchObject({ answer: { status: 409, code: 'VERSION_CONFLICT' }, report: { status: 'SUBMITTED', version: '2' }, instances: 0 });
  });

  it('what was handed in is not edited: 409 REVISION_IMMUTABLE naming the status, and the payload hash is unchanged', async () => {
    const { reportId, projectId, planId, period } = await flow.submitted();
    const before = await flow.state(reportId);
    const reply = await flow.save(reportId, flow.draft(projectId, period, planId), 2);
    expect(answerOf(reply)).toMatchObject({ status: 409, code: 'REVISION_IMMUTABLE' });
    expect(reply.json.report_status).toBe('SUBMITTED');
    expect(await flow.state(reportId)).toEqual(before);
  });

  it('a locked period takes no correction: 409 PERIOD_LOCKED and no revision is made', async () => {
    const { reportId, period } = await flow.submitted();
    await flow.giveBack(reportId, 2);
    await flow.lockPeriod(period);
    const reply = await flow.correct(reportId, 3, { amendment_reason: 'The Treasury corrected a payment.' });
    expect(answerOf(reply)).toMatchObject({ status: 409, code: 'PERIOD_LOCKED' });
    expect(await flow.rows('select id from machvon.report_revision where supersedes_id = $1', [reportId])).toEqual([]);
    expect(await flow.state(reportId)).toMatchObject({ status: 'RETURNED', version: '3' });
  });

  it('a correction of a returned report is a new revision that points at the first, which keeps its hash and is handed in again without an instance', async () => {
    const { reportId } = await flow.submitted();
    await flow.giveBack(reportId, 2);
    const first = await flow.state(reportId);
    const made = await flow.correct(reportId, 3, { amendment_reason: 'The Treasury corrected a payment of March.' });
    expect(made).toMatchObject({ status: 200, json: { status: 'DRAFT', resource_version: 1 } });
    const second = flow.idOf(made);
    expect(await flow.submit(second, 1)).toMatchObject({ status: 200, json: { status: 'SUBMITTED' } });
    expect(await flow.state(reportId)).toEqual(first);
    expect(await flow.state(second)).toMatchObject({ status: 'SUBMITTED', revision: 2, supersedes_id: reportId });
    expect(await flow.approve(second, 2)).toMatchObject({ status: 200, json: { status: 'ACCEPTED' } });
    expect(await flow.state(reportId)).toMatchObject({ status: 'RETURNED' });
    const instances = await flow.rows<{ n: string }>('select count(*)::text as n from machvon.workflow_instance');
    expect(instances[0]?.n).toBe('0');
  });

  it('validation comes before the state: a decision that is not one, a missing reason and evidence that is not an id are 422 on their field', async () => {
    const { reportId } = await flow.submitted();
    const base = { decision: 'approve', reason: 'The figures agree.', evidence_ids: [] };
    for (const [body, detail] of [
      [{ ...base, decision: 'reject' }, 'decision'],
      [{ ...base, reason: '   ' }, 'reason'],
      [{ ...base, evidence_ids: ['nope'] }, 'evidence_ids'],
    ] as const) {
      expect(answerOf(await flow.decide(reportId, 2, body))).toEqual({ status: 422, code: 'VALIDATION_FAILED', detail });
    }
    expect(await flow.state(reportId)).toMatchObject({ status: 'SUBMITTED', version: '2' });
  });

  it('who may decide: a reader and a maker without the right are 403, another branch and another tenant are 404', async () => {
    const { reportId } = await flow.submitted();
    expect((await flow.approve(reportId, 2, READER)).status).toBe(403);
    expect((await flow.approve(reportId, 2, OTHER_MAKER)).status).toBe(403);
    expect((await flow.approve(reportId, 2, ELSEWHERE_REVIEWER)).status).toBe(404);
    expect(await flow.state(reportId)).toMatchObject({ status: 'SUBMITTED', version: '2' });
  });
});
