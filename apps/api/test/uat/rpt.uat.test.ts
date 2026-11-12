import { createHash, randomUUID } from 'node:crypto';
import { WORKER_MEMBERSHIP_ID } from '@machvon/db';
import { DIS_WEEKLY_CODE } from '@machvon/kernel';
import { TENANT_A, id, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { assertStatus, codeOf, expectCheckFails } from './uat-kit';
import type { Reply } from './uat-kit';
import { ROOT_UNIT, UatWorld } from './uat-world';

/**
 * UAT of the publishing of a report from a frozen snapshot (docs/uat/rpt/uat.json, HSKT row BC.01, screens RPT-01 to RPT-04): the preparer makes a draft from the frozen figures, a second person checks it,
 * a third approves, the approver issues an immutable copy with its hash, a correction is a new revision that names the one it replaces, a copy is delivered once, and every step leaves its row of the audit trail and its
 * event. Each case is named by its id in docs/uat/rpt/uat.json.
 */
jest.setTimeout(600_000);

const FAMILY = 0xb7;
const FIGURES = ['home.read'];
const ALL = ['rpt.read', 'rpt.generate', 'rpt.check', 'rpt.approve', 'rpt.issue', 'rpt.deliver', 'rpt.answer', ...FIGURES];
const PERSONAS = {
  'rpt-preparer': ['rpt.read', 'rpt.generate', ...FIGURES],
  'rpt-checker': ['rpt.read', 'rpt.check'],
  'rpt-approver': ['rpt.read', 'rpt.approve', 'rpt.issue'],
  'rpt-sender': ['rpt.read', 'rpt.deliver', 'rpt.answer'],
  'rpt-reader': ['rpt.read'],
  'rpt-all': ALL,
};
const today = new Date().toISOString().slice(0, 10);
const PERIOD = { kind: 'AS_OF', year: Number(today.slice(0, 4)), day: today };
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

describe('UAT of the publishing of a report from a frozen snapshot (BC.01, RPT-01..RPT-04)', () => {
  const world = new UatWorld();
  let counter = 0;
  let first = { issueId: '', draftId: '' };

  beforeAll(async () => {
    await world.start(PERSONAS, { 'rpt-all': ALL });
  }, 600_000);

  afterAll(() => world.stop(), 60_000);

  /** A frozen snapshot with one project whose line has 1000 billion from the Prime Minister, 250 added and `paid` paid by the Treasury: the figures a report is filled from. */
  async function snapshot(paid: string): Promise<string> {
    counter += 1;
    const periodId = id(FAMILY, 2000 + counter);
    const snapshotId = randomUUID();
    const projectId = id(FAMILY, 500 + counter);
    await world.seedAsAdmin([
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, $3, $3, $4, $5, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, projectId, `UAT-RPT-${counter}`, unitId(ROOT_UNIT), id(FAMILY, 30)],
      ],
      [
        `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
         values ($1, $2, $3, 1, date '2046-01-02' + $4::int, date '2046-01-02' + $4::int + 6, now(), 'DEFAULT', 'WEEK', $7, 'OPEN', $5, $6, $6)`,
        [TENANT_A, periodId, `UAT-RP-${counter}`, counter * 7, id(FAMILY, 40), WORKER_MEMBERSHIP_ID, PERIOD.year],
      ],
      [
        `insert into machvon.period_snapshot (tenant_id, id, period_id, snapshot_kind, as_of_at, as_of_date, treasury_cutoff_date, status, metric_set_version, definition_status, row_count, payload_sha256, frozen_by, frozen_at, supersedes_id, created_by, updated_by)
         values ($1, $2, $3, 'PERIOD_CLOSE', now(), $4::date, $4::date, 'FROZEN', 'DIS-METRICS-R1-PROPOSED', 'PROPOSED_PENDING_SIGNOFF', 1, repeat('a', 64), $5, now() + ($6::int * interval '1 second'), null, $5, $5)`,
        [TENANT_A, snapshotId, periodId, today, WORKER_MEMBERSHIP_ID, counter],
      ],
      [
        `insert into machvon.period_snapshot_line (tenant_id, id, snapshot_id, project_id, unit_id, bucket, budget_level, plan_pm_assigned_vnd, plan_local_added_vnd, plan_total_vnd, disbursed_treasury_vnd, treasury_coverage)
         values ($1, gen_random_uuid(), $2, $3, $4, 'CURRENT_YEAR', 'CENTRAL', 1000000000000, 250000000000, 1250000000000, $5::numeric, 'COMPLETE')`,
        [TENANT_A, snapshotId, projectId, unitId(ROOT_UNIT), paid],
      ],
    ]);
    return snapshotId;
  }

  const generate = (persona: string, extra: Record<string, unknown> = {}, period: Record<string, unknown> = PERIOD): Promise<Reply> =>
    world.as(persona, 'POST', '/report-engine/drafts', { body: { layout_code: DIS_WEEKLY_CODE, period, ...extra } });
  const step = (persona: string, draftId: string, version: number, action: 'check' | 'approve' | 'issue'): Promise<Reply> => world.as(persona, 'POST', `/report-engine/drafts/${draftId}/${action}`, { ifMatch: version });
  /** A draft of a correction made from a snapshot of its own, so that no case meets the draft of another. */
  async function freshDraft(label: string): Promise<string> {
    await snapshot(String(1_000_000_000 + counter * 1_000_000));
    const made = await generate('rpt-preparer', { reason: `UAT correction ${label} of the week` });
    assertStatus(made, 200);
    return made.json.draft_id as string;
  }
  const draftOf = async (draftId: string): Promise<Record<string, unknown>> => (await world.as('rpt-reader', 'GET', `/report-engine/drafts/${draftId}`)).json;

  it('UAT-RPT-E2E-01 the preparer makes a draft from the frozen figures, a second person checks, a third approves, the approver issues, and the copy is immutable with its hash, its signatories and its snapshot', async () => {
    const frozen = await snapshot('600000000000');
    const made = await generate('rpt-preparer');
    assertStatus(made, 200);
    expect(made.json).toMatchObject({ outcome: 'CREATED', issue_id: null, revision: 1 });
    const draftId = made.json.draft_id as string;
    const draft = await draftOf(draftId);
    expect(draft).toMatchObject({ state: 'DRAFT', layout_code: DIS_WEEKLY_CODE, base_revision: 0, data_source: 'LIVE', version: 1 });
    expect(draft.snapshot).toMatchObject({ snapshot_id: frozen, revision: 1 });
    expect((await world.audits(draftId, 'rpt.report_generated'))[0]?.safe_diff).toMatchObject({ layout_code: DIS_WEEKLY_CODE, snapshot_id: frozen });
    expect((await world.events(draftId, 'rpt.report.generated.v1'))[0]?.payload).toMatchObject({ draft_id: draftId, layout_code: DIS_WEEKLY_CODE, package_sha256: made.json.package_sha256 });
    assertStatus(await step('rpt-checker', draftId, 1, 'check'), 200);
    assertStatus(await step('rpt-approver', draftId, 2, 'approve'), 200);
    const issued = await step('rpt-approver', draftId, 3, 'issue');
    assertStatus(issued, 200);
    expect(issued.json).toMatchObject({ status: 'ISSUED', resource_version: 1 });
    const issueId = issued.json.resource_id as string;
    first = { issueId, draftId };
    const issue = (await world.as('rpt-reader', 'GET', `/report-engine/issues/${issueId}`)).json;
    expect(issue).toMatchObject({ revision: 1, supersedes_id: null, is_current: true, current_revision: 1, counts_as_accepted: true, layout_code: DIS_WEEKLY_CODE });
    expect(issue.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((issue.files as Array<{ format: string }>).map((one) => one.format)).toEqual(['XLSX', 'PDF']);
    const file = await world.as('rpt-reader', 'GET', `/report-engine/issues/${issueId}/files/XLSX`);
    assertStatus(file, 200);
    expect(sha(Buffer.from(file.json.content_base64 as string, 'base64'))).toBe((issue.files as Array<{ sha256: string }>)[0]?.sha256);
    expect((await world.audits(issueId, 'rpt.report_issued'))[0]?.safe_diff).toMatchObject({ revision: 1, sha256: issue.sha256, counts_as_accepted: true });
    expect((await world.events(issueId, 'rpt.report.issued.v1'))[0]?.payload).toMatchObject({ issue_id: issueId, revision: 1, sha256: issue.sha256 });
    // Insert-only: not even the owner of the database changes or removes an issued copy, and an issued draft is frozen too.
    await expect(world.rows('update machvon.report_issue set reason = $1 where id = $2', ['x'.repeat(12), issueId])).rejects.toThrow(/never changes/);
    await expect(world.rows('delete from machvon.report_issue where id = $1', [issueId])).rejects.toThrow(/never changes/);
    await expect(world.rows(`update machvon.report_draft set reason = 'x' where id = $1`, [draftId])).rejects.toThrow(/never changes/);
  });

  it('UAT-RPT-IDM-01 making the same report again gives the same draft or a DUPLICATE of the issued bytes, never a second copy', async () => {
    const same = await generate('rpt-preparer');
    expect(same.json).toMatchObject({ outcome: 'DUPLICATE', draft_id: null, revision: 1 });
    const heads = (await world.as('rpt-reader', 'GET', '/report-engine/issues?heads_only=true')).json.items as unknown[];
    expect(heads).toHaveLength(1);
    expect((await world.rows<{ n: string }>('select count(*)::text as n from machvon.report_issue where layout_code = $1', [DIS_WEEKLY_CODE]))[0]?.n).toBe('1');
    // A draft that is not issued yet: the same request answers the same draft.
    await snapshot('700000000000');
    const reason = { reason: 'The Treasury booked a payment of the week' };
    const made = await generate('rpt-preparer', reason);
    assertStatus(made, 200);
    const again = await generate('rpt-preparer', reason);
    expect(again.json).toMatchObject({ outcome: 'EXISTING', draft_id: made.json.draft_id });
  });

  it('UAT-RPT-STA-01 the steps go in order and nothing is skipped: approving before the check is 409, issuing before the approval is 409 REPORT_STATE_INVALID, a step done twice and a stale version are 409', async () => {
    const draftId = await freshDraft('STA-01');
    assertStatus(await step('rpt-approver', draftId, 1, 'approve'), 409);
    assertStatus(await step('rpt-approver', draftId, 1, 'issue'), 409, 'REPORT_STATE_INVALID');
    assertStatus(await step('rpt-all', draftId, 1, 'check'), 200);
    assertStatus(await step('rpt-all', draftId, 1, 'check'), 409);
    expect(await draftOf(draftId)).toMatchObject({ state: 'CHECKED' });
    assertStatus(await step('rpt-approver', draftId, 99, 'approve'), 409);
    expect((await world.rows<{ state: string }>('select state from machvon.report_draft where id = $1', [draftId]))[0]?.state).toBe('CHECKED');
  });

  it('UAT-RPT-SOD-01 preparer, checker and approver are three different people: the checker cannot approve, the approver is the one who issues, and whoever holds every right cannot do two steps (403 SELF_APPROVAL_DENIED)', async () => {
    const draftId = await freshDraft('SOD-01');
    assertStatus(await step('rpt-preparer', draftId, 1, 'check'), 403);
    assertStatus(await step('rpt-all', draftId, 1, 'check'), 200);
    assertStatus(await step('rpt-all', draftId, 2, 'approve'), 403, 'SELF_APPROVAL_DENIED');
    assertStatus(await step('rpt-preparer', draftId, 2, 'approve'), 403);
    assertStatus(await step('rpt-approver', draftId, 2, 'approve'), 200);
    assertStatus(await step('rpt-all', draftId, 3, 'issue'), 403, 'SELF_APPROVAL_DENIED');
    expect(await draftOf(draftId)).toMatchObject({ state: 'APPROVED' });
    assertStatus(await step('rpt-approver', draftId, 3, 'issue'), 200);
  });

  it('UAT-RPT-STA-02 a correction is a new revision that needs a reason and names the copy it replaces, and a draft made before the series moved is refused (409 REPORT_OUT_OF_DATE) with the current revision', async () => {
    await snapshot('930000000000');
    const unexplained = await generate('rpt-preparer');
    assertStatus(unexplained, 422, 'VALIDATION_FAILED');
    await snapshot('950000000000');
    const stale = await generate('rpt-preparer', { reason: 'Another correction of the same week' });
    const staleId = stale.json.draft_id as string;
    assertStatus(await step('rpt-checker', staleId, 1, 'check'), 200);
    assertStatus(await step('rpt-approver', staleId, 2, 'approve'), 200);
    await snapshot('960000000000');
    const rival = await generate('rpt-preparer', { reason: 'The rival correction of the same week' });
    const rivalId = rival.json.draft_id as string;
    assertStatus(await step('rpt-checker', rivalId, 1, 'check'), 200);
    assertStatus(await step('rpt-approver', rivalId, 2, 'approve'), 200);
    assertStatus(await step('rpt-approver', rivalId, 3, 'issue'), 200);
    const refused = await step('rpt-approver', staleId, 3, 'issue');
    assertStatus(refused, 409, 'REPORT_OUT_OF_DATE');
    expect(refused.json).toMatchObject({ current_revision: expect.any(Number) });
    const chain = (await world.as('rpt-reader', 'GET', `/report-engine/issues?layout_code=DIS-WEEKLY`)).json.items as Array<{ id: string; revision: number; supersedes_id: string | null }>;
    const second = chain.find((one) => one.revision === 2);
    expect(second?.supersedes_id).toBe(first.issueId);
  });

  it('UAT-RPT-IDM-02 a copy is delivered to a receiver once (the same again is 409 ALREADY_DELIVERED), a copy that a later revision replaced is refused, and the delivery log is append-only', async () => {
    const list = (await world.as('rpt-reader', 'GET', '/report-engine/issues?layout_code=DIS-WEEKLY')).json.items as Array<{ id: string; revision: number }>;
    const newest = Math.max(...list.map((one) => one.revision));
    const head = list.find((one) => one.revision === newest) as { id: string };
    const old = list.find((one) => one.revision === 1) as { id: string };
    const target = { receiver: 'KBNN', channel: 'DOWNLOAD', reference: 'letter 12/BC' };
    const stale = await world.as('rpt-sender', 'POST', `/report-engine/issues/${old.id}/deliveries`, { body: target });
    assertStatus(stale, 409, 'REPORT_OUT_OF_DATE');
    expect(stale.json).toMatchObject({ current_revision: newest });
    const done = await world.as('rpt-sender', 'POST', `/report-engine/issues/${head.id}/deliveries`, { body: target });
    assertStatus(done, 200);
    expect(done.json).toMatchObject({ receiver: 'KBNN', channel: 'DOWNLOAD', event: 'DELIVERED', revision: newest });
    assertStatus(await world.as('rpt-sender', 'POST', `/report-engine/issues/${head.id}/deliveries`, { body: target }), 409, 'ALREADY_DELIVERED');
    expect((await world.rows<{ n: string }>('select count(*)::text as n from machvon.report_delivery where issue_id = $1', [head.id]))[0]?.n).toBe('1');
    expect((await world.audits(head.id, 'rpt.report_delivered')).length).toBe(1);
    expect((await world.events(head.id, 'rpt.report.delivered.v1')).length).toBe(1);
    await expect(world.rows(`update machvon.report_delivery set note = 'x' where issue_id = $1`, [head.id])).rejects.toThrow(/append-only/);
    assertStatus(await world.as('rpt-reader', 'POST', `/report-engine/issues/${head.id}/deliveries`, { body: { ...target, receiver: 'PVN' } }), 403);
  });

  it('UAT-RPT-EDG-01 an unknown form is 404, a period of the wrong kind or year is 422, a channel a person may not write is 422, a rejection needs words, and an answer needs a delivery first', async () => {
    assertStatus(await world.as('rpt-preparer', 'POST', '/report-engine/drafts', { body: { layout_code: 'NO-SUCH', period: PERIOD } }), 404);
    assertStatus(await generate('rpt-preparer', {}, { kind: 'MONTH', year: PERIOD.year, index: 10 }), 422);
    assertStatus(await generate('rpt-preparer', {}, { kind: 'AS_OF', year: PERIOD.year - 1, day: today }), 422);
    const head = ((await world.as('rpt-reader', 'GET', '/report-engine/issues?heads_only=true')).json.items as Array<{ id: string }>)[0] as { id: string };
    assertStatus(await world.as('rpt-sender', 'POST', `/report-engine/issues/${head.id}/deliveries`, { body: { receiver: 'HPM', channel: 'HPM_PUSH' } }), 422);
    assertStatus(await world.as('rpt-sender', 'POST', `/report-engine/issues/${head.id}/deliveries`, { body: { receiver: 'bad receiver', channel: 'EMAIL' } }), 422);
    assertStatus(await world.as('rpt-sender', 'POST', `/report-engine/issues/${head.id}/answers`, { body: { receiver: 'KBNN', outcome: 'REJECTED' } }), 422);
    assertStatus(await world.as('rpt-sender', 'POST', `/report-engine/issues/${head.id}/answers`, { body: { receiver: 'NOBODY', outcome: 'ACCEPTED' } }), 409);
    assertStatus(await world.as('rpt-sender', 'POST', `/report-engine/issues/${head.id}/answers`, { body: { receiver: 'KBNN', outcome: 'ACCEPTED', reference: 'receipt 7' } }), 200);
    assertStatus(await world.as('rpt-sender', 'POST', `/report-engine/issues/${head.id}/answers`, { body: { receiver: 'KBNN', outcome: 'ACCEPTED' } }), 409);
  });

  it('UAT-RPT-ISO-01 a member of another tenant is answered 404 for a copy and a draft of this tenant, as for an id that does not exist, and cannot read its file', async () => {
    const foreign = await world.asTenantB(1, 'GET', `/report-engine/issues/${first.issueId}`);
    const nothing = await world.asTenantB(1, 'GET', `/report-engine/issues/${randomUUID()}`);
    expect([foreign.status, codeOf(foreign)]).toEqual([nothing.status, codeOf(nothing)]);
    assertStatus(foreign, 404);
    assertStatus(await world.asTenantB(1, 'GET', `/report-engine/issues/${first.issueId}/files/XLSX`), 404);
    assertStatus(await world.asTenantB(1, 'GET', `/report-engine/drafts/${first.draftId}`), 404);
  });

  it('negative control: the checks of this suite go red on an answer that is wrong on purpose', () => {
    expectCheckFails(() => assertStatus({ status: 200, json: {} }, 409, 'REPORT_OUT_OF_DATE'));
    expectCheckFails(() => assertStatus({ status: 409, json: { code: 'ALREADY_DELIVERED' } }, 409, 'REPORT_OUT_OF_DATE'));
  });
});
