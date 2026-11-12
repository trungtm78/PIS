import { randomUUID } from 'node:crypto';
import { addDirectiveDays, vietnamDateOf } from '@machvon/kernel';
import { TENANT_A, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { assertStatus, codeOf, expectCheckFails } from './uat-kit';
import type { Reply } from './uat-kit';
import { ROOT_UNIT, UatWorld } from './uat-world';

/**
 * UAT of the directives of the steering meetings (docs/uat/dir/uat.json, HSKT row CN.03 and QT.02, screens DIR-01 to DIR-05): the secretary records a meeting and gives directives, the assignee reports and
 * asks for time, somebody else decides, a third person closes with evidence; the cases that the design asks of a state machine (the illegal steps), of the two hands (nobody decides or closes what they made),
 * of an idempotent command (the same key twice) and of the rows the audit trail and the outbox keep. Each case is named by its id in docs/uat/dir/uat.json.
 */
jest.setTimeout(600_000);

const FAMILY = 0xd2;
const UNIT = 2; // the unit the directives are given to
const TODAY = vietnamDateOf(new Date());
const DAY = (offset: number): string => addDirectiveDays(TODAY, offset);
const REASON = 'The steering meeting asked for more time.';
const PERSONAS = {
  secretary: ['directive.meeting.manage', 'directive.manage', 'directive.close', 'directive.read'],
  assignee: ['directive.progress', 'directive.read'],
  closer: ['directive.close', 'directive.read'],
  decider: ['directive.extension.decide', 'directive.read'],
  reader: ['directive.read'],
  dual: ['directive.progress', 'directive.extension.decide', 'directive.read'],
};

describe('UAT of the directives of the steering meetings (CN.03, QT.02, DIR-01..DIR-05)', () => {
  const world = new UatWorld();
  const project = id(FAMILY, 1);
  const version = id(FAMILY, 10);
  const infected = id(FAMILY, 12);

  beforeAll(async () => {
    await world.start(PERSONAS, { secretary: PERSONAS.secretary }, async (w) => {
      await w.harness.seedUnits(TENANT_A, [{ n: UNIT, path: `/${unitId(ROOT_UNIT)}/${unitId(UNIT)}/`, parent: ROOT_UNIT }]);
      await w.seedAsAdmin([
        [
          `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
           values ($1, $2, 'UAT-DIR-P1', 'Plant project', $3, $3, $4, 'INTERNAL', 1000000000, 'IMPLEMENTATION', 1, 'B')`,
          [TENANT_A, project, unitId(UNIT), id(FAMILY, 2)],
        ],
        [`insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'QD', 'Biên bản', 'INTERNAL', $3, $3)`, [TENANT_A, id(FAMILY, 11), memberId(1)]],
        [
          `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
           values ($1, $2, $3, 1, 'tenants/dir/minutes-1.pdf', repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL')`,
          [TENANT_A, version, id(FAMILY, 11)],
        ],
        [
          `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
           values ($1, $2, $3, 2, 'tenants/dir/minutes-2.pdf', repeat('b', 64), 'application/pdf', 1, 'INTERNAL', 'INFECTED', '{}'::jsonb, 'RENDERED_FINAL')`,
          [TENANT_A, infected, id(FAMILY, 11)],
        ],
      ]);
    });
  }, 600_000);

  afterAll(() => world.stop(), 60_000);

  async function meeting(extra: Record<string, unknown> = {}): Promise<{ id: string; code: string }> {
    const made = await world.as('secretary', 'POST', '/steering-meetings', { body: { meeting_date: DAY(-30), meeting_type: 'WEEKLY', title: 'Giao ban tuần về giải ngân', unit_id: unitId(ROOT_UNIT), ...extra } });
    assertStatus(made, 200);
    return { id: made.json.resource_id as string, code: made.json.code as string };
  }

  async function directive(meetingId: string, extra: Record<string, unknown> = {}): Promise<{ id: string; code: string }> {
    const made = await world.as('secretary', 'POST', `/steering-meetings/${meetingId}/directives`, {
      body: { scope_kind: 'PROJECT', project_id: project, text: 'Hoàn thành thủ tục giải phóng mặt bằng.', assignee_unit_id: unitId(UNIT), assignee_membership_id: world.idOf('assignee'), due_on: DAY(10), ...extra },
    });
    assertStatus(made, 200);
    return { id: made.json.resource_id as string, code: made.json.code as string };
  }

  const versionOf = async (directiveId: string): Promise<number> => Number((await world.rows<{ version: string }>('select version::text as version from machvon.directive where id = $1::uuid', [directiveId]))[0]?.version);
  const items = (reply: Reply): Array<Record<string, unknown>> => reply.json.items as Array<Record<string, unknown>>;

  it('UAT-DIR-E2E-01 the secretary gives a directive, the assignee reports and asks for time, another person decides, a third closes it with evidence, and every step leaves an audit row and the timeline keeps them', async () => {
    const held = await meeting();
    const given = await directive(held.id, { due_on: DAY(5) });
    const url = (suffix: string): string => `/directives/${given.id}/${suffix}`;
    assertStatus(await world.as('assignee', 'POST', url('progress'), { body: { note: 'Đã gửi hồ sơ cho sở.', progress_pct: 30, evidence_document_version_ids: [version] } }), 200);
    expect((await world.audits(given.id, 'directive.progress_recorded'))[0]).toMatchObject({ actor_id: world.idOf('assignee'), safe_diff: { progress_pct: 30, evidence_count: 1 } });
    const asked = await world.as('assignee', 'POST', url('extension-requests'), { body: { proposed_due_on: DAY(20), reason: REASON } });
    assertStatus(asked, 200);
    const extensionId = asked.json.extension_id as string;
    const decided = await world.as('decider', 'POST', `/directive-extensions/${extensionId}/decision`, { ifMatch: 1, body: { decision: 'approve', reason: 'Đã xem xét và đồng ý.' } });
    assertStatus(decided, 200);
    expect(decided.json).toMatchObject({ status: 'APPROVED', due_on: DAY(20) });
    expect((await world.events(extensionId, 'directive.extension_decided.v1'))[0]?.payload).toMatchObject({ directive_id: given.id, decision: 'approve', actor_id: world.idOf('decider') });
    const closed = await world.as('closer', 'POST', url('closure'), { ifMatch: await versionOf(given.id), body: { note: 'Đã bàn giao mặt bằng, có biên bản.', evidence_document_version_ids: [version] } });
    assertStatus(closed, 200);
    expect(closed.json).toMatchObject({ status: 'DONE' });
    expect((await world.audits(given.id, 'directive.closed'))[0]).toMatchObject({ actor_id: world.idOf('closer'), reason: 'Đã bàn giao mặt bằng, có biên bản.' });
    expect((await world.events(given.id, 'directive.closed.v1'))[0]?.payload).toMatchObject({ status: 'DONE', actor_id: world.idOf('closer') });
    const detail = await world.as('reader', 'GET', `/directives/${given.id}`);
    expect((detail.json.timeline as Array<{ type: string }>).map((event) => event.type)).toEqual(['CREATED', 'PROGRESS', 'EXTENSION_REQUESTED', 'EXTENSION_APPROVED', 'CLOSED']);
  });

  it('UAT-DIR-IDM-01 recording the same meeting again under the same Idempotency-Key answers the first answer with one row, and the same key with another body is refused (409)', async () => {
    const body = { meeting_date: DAY(-3), meeting_type: 'MONTHLY', title: 'Giao ban tháng', summary: 'Rà soát tiến độ giải ngân.', unit_id: unitId(ROOT_UNIT) };
    const key = `uat-${randomUUID()}`;
    const made = await world.as('secretary', 'POST', '/steering-meetings', { body, key });
    assertStatus(made, 200);
    expect(String(made.json.code)).toMatch(/^GB-\d{4}-\d{3}$/);
    const again = await world.as('secretary', 'POST', '/steering-meetings', { body, key });
    expect(again.json).toMatchObject({ resource_id: made.json.resource_id, code: made.json.code });
    expect((await world.rows<{ n: string }>('select count(*)::text as n from machvon.steering_meeting where id = $1::uuid', [made.json.resource_id]))[0]?.n).toBe('1');
    assertStatus(await world.as('secretary', 'POST', '/steering-meetings', { body: { ...body, title: 'Khác' }, key }), 409);
    expect((await world.audits(made.json.resource_id as string, 'directive.meeting_created'))).toHaveLength(1);
  });

  it('UAT-DIR-IDM-02 five identical meetings sent at the same moment under one key make one meeting with one code', async () => {
    const body = { meeting_date: DAY(-4), meeting_type: 'WEEKLY', title: 'Giao ban đồng thời', unit_id: unitId(ROOT_UNIT) };
    const key = `uat-${randomUUID()}`;
    const replies = await Promise.all(Array.from({ length: 5 }, () => world.as('secretary', 'POST', '/steering-meetings', { body, key })));
    for (const reply of replies) expect([200, 409]).toContain(reply.status);
    const winners = replies.filter((reply) => reply.status === 200);
    expect(winners.length).toBeGreaterThanOrEqual(1);
    expect(new Set(winners.map((reply) => reply.json.resource_id)).size).toBe(1);
    expect((await world.rows<{ n: string }>(`select count(*)::text as n from machvon.steering_meeting where title = 'Giao ban đồng thời'`))[0]?.n).toBe('1');
  });

  it('UAT-DIR-EDG-01 a meeting day to come, a field the contract does not allow, an infected minute and an overdue date beyond the limit are refused and write nothing', async () => {
    const body = { meeting_date: DAY(-3), meeting_type: 'MONTHLY', title: 'Giao ban biên', unit_id: unitId(ROOT_UNIT) };
    const before = (await world.rows('select 1 from machvon.steering_meeting')).length;
    assertStatus(await world.as('secretary', 'POST', '/steering-meetings', { body: { ...body, meeting_date: DAY(1) } }), 422, 'VALIDATION_FAILED');
    assertStatus(await world.as('secretary', 'POST', '/steering-meetings', { body: { ...body, tenant_id: TENANT_A } }), 400, 'FIELD_NOT_ALLOWED');
    assertStatus(await world.as('secretary', 'POST', '/steering-meetings', { body: { ...body, minutes_document_version_id: infected } }), 422, 'DECISION_DOCUMENT_REQUIRED');
    expect((await world.rows('select 1 from machvon.steering_meeting')).length).toBe(before);
    const held = await meeting();
    assertStatus(await world.as('secretary', 'POST', `/steering-meetings/${held.id}/directives`, { body: { scope_kind: 'PROJECT', project_id: project, text: 'Quá hạn xa.', assignee_unit_id: unitId(UNIT), due_on: DAY(-31) } }), 422, 'VALIDATION_FAILED');
    assertStatus(await world.as('assignee', 'POST', `/directives/${(await directive(held.id)).id}/progress`, { body: { note: 'x', progress_pct: 101 } }), 422);
  });

  it('UAT-DIR-SOD-01 nobody closes what they recorded (403 SELF_APPROVAL_DENIED), nobody decides their own request for time, and a person without the right is refused', async () => {
    const held = await meeting();
    const given = await directive(held.id);
    const close = (persona: string, body: Record<string, unknown>, ifMatch?: number): Promise<Reply> => world.as(persona, 'POST', `/directives/${given.id}/closure`, { ifMatch: ifMatch ?? 1, body });
    assertStatus(await close('secretary', { note: 'Xong.', evidence_document_version_ids: [version] }), 403, 'SELF_APPROVAL_DENIED');
    assertStatus(await close('assignee', { note: 'Xong.', evidence_document_version_ids: [version] }), 403);
    assertStatus(await close('reader', { note: 'Xong.', evidence_document_version_ids: [version] }), 403);
    const own = await world.as('dual', 'POST', `/directives/${given.id}/extension-requests`, { body: { proposed_due_on: DAY(30), reason: REASON } });
    assertStatus(own, 200);
    assertStatus(await world.as('dual', 'POST', `/directive-extensions/${String(own.json.extension_id)}/decision`, { ifMatch: 1, body: { decision: 'approve', reason: 'Tự duyệt.' } }), 403, 'SELF_APPROVAL_DENIED');
    expect((await world.audits(String(own.json.extension_id), 'directive.extension_approved')).length).toBe(0);
    expect(await versionOf(given.id)).toBeGreaterThanOrEqual(1);
    expect((await world.rows<{ status: string }>('select status from machvon.directive where id = $1::uuid', [given.id]))[0]?.status).not.toBe('DONE');
  });

  it('UAT-DIR-STA-01 the illegal steps are refused: a second close, a reopening of an open directive, a second request while one waits, a second decision, and a stale version', async () => {
    const held = await meeting();
    const given = await directive(held.id);
    const url = (suffix: string): string => `/directives/${given.id}/${suffix}`;
    assertStatus(await world.as('secretary', 'POST', url('reopening'), { ifMatch: 1, body: { reason: 'Mở lại.' } }), 409);
    const asked = await world.as('assignee', 'POST', url('extension-requests'), { body: { proposed_due_on: DAY(20), reason: REASON } });
    assertStatus(asked, 200);
    assertStatus(await world.as('assignee', 'POST', url('extension-requests'), { body: { proposed_due_on: DAY(25), reason: REASON } }), 409, 'DIRECTIVE_EXTENSION_PENDING');
    const decision = (version_: number): Promise<Reply> => world.as('decider', 'POST', `/directive-extensions/${String(asked.json.extension_id)}/decision`, { ifMatch: version_, body: { decision: 'reject', reason: 'Đủ thời gian.' } });
    assertStatus(await decision(9), 409, 'VERSION_CONFLICT');
    assertStatus(await decision(1), 200);
    assertStatus(await decision(2), 409, 'DIRECTIVE_EXTENSION_STATE_INVALID');
    const closed = await world.as('closer', 'POST', url('closure'), { ifMatch: await versionOf(given.id), body: { note: 'Đã xong.', evidence_document_version_ids: [version] } });
    assertStatus(closed, 200);
    assertStatus(await world.as('closer', 'POST', url('closure'), { ifMatch: await versionOf(given.id), body: { note: 'Lần nữa.', evidence_document_version_ids: [version] } }), 409, 'DIRECTIVE_STATE_INVALID');
    assertStatus(await world.as('closer', 'POST', url('closure'), { ifMatch: 1, body: { note: 'Lỗi thời.', evidence_document_version_ids: [version] } }), 409);
  });

  it('UAT-DIR-STA-02 a directive is cancelled with a reason and reopened to open, each audited and each taking the version, and the transitions leave the right rows', async () => {
    const held = await meeting();
    const given = await directive(held.id);
    assertStatus(await world.as('secretary', 'POST', `/directives/${given.id}/cancellation`, { ifMatch: 7, body: { reason: REASON } }), 409, 'VERSION_CONFLICT');
    const cancelled = await world.as('secretary', 'POST', `/directives/${given.id}/cancellation`, { ifMatch: 1, body: { reason: 'Dự án đã dừng.' } });
    expect(cancelled.json).toMatchObject({ status: 'CANCELLED', resource_version: 2 });
    expect((await world.audits(given.id, 'directive.cancelled'))[0]).toMatchObject({ reason: 'Dự án đã dừng.' });
    assertStatus(await world.as('assignee', 'POST', `/directives/${given.id}/progress`, { body: { note: 'Không còn hiệu lực.' } }), 409);
    const reopened = await world.as('secretary', 'POST', `/directives/${given.id}/reopening`, { ifMatch: 2, body: { reason: 'Dự án tiếp tục.' } });
    expect(reopened.json).toMatchObject({ status: 'OPEN', resource_version: 3 });
    expect((await world.events(given.id, 'directive.reopened.v1'))[0]?.payload).toMatchObject({ status: 'OPEN' });
  });

  it('UAT-DIR-DAT-01 a directive past its day is overdue by the clock and not by a stored flag, is listed first, and the counts of the summary add up to the list', async () => {
    const held = await meeting({ meeting_date: DAY(-40), title: 'Giao ban đọc' });
    const late = await directive(held.id, { due_on: DAY(-10), text: 'Chỉ đạo quá hạn về nghiệm thu.' });
    const soon = await directive(held.id, { due_on: DAY(2), text: 'Chỉ đạo sắp đến hạn về quyết toán.' });
    const listed = await world.as('reader', 'GET', `/directives?meeting_id=${held.id}`);
    expect(items(listed).map((item) => item.id)).toEqual([late.id, soon.id]);
    expect(items(listed)[0]).toMatchObject({ status: 'OVERDUE', stored_status: 'OPEN', overdue_days: 10 });
    expect(items(listed)[1]).toMatchObject({ status: 'OPEN', days_to_due: 2 });
    expect((await world.rows<{ status: string }>('select status from machvon.directive where id = $1::uuid', [late.id]))[0]?.status).toBe('OPEN');
    const summary = await world.as('reader', 'GET', '/directives/summary');
    const everything = await world.as('reader', 'GET', '/directives?limit=200');
    const byStatus = summary.json.by_status as Record<string, number>;
    expect(Object.values(byStatus).reduce((sum, value) => sum + value, 0)).toBe(summary.json.total);
    expect(summary.json.total).toBe(items(everything).length);
    expect(byStatus.OVERDUE).toBe(items(everything).filter((item) => item.status === 'OVERDUE').length);
  });

  it('UAT-DIR-ISO-01 a member of another tenant is answered 404 for a directive and a meeting of this tenant, as for an id that does not exist, and reads an empty list', async () => {
    const held = await meeting();
    const given = await directive(held.id);
    const foreign = await world.asTenantB(1, 'GET', `/directives/${given.id}`);
    const nothing = await world.asTenantB(1, 'GET', `/directives/${randomUUID()}`);
    expect([foreign.status, codeOf(foreign)]).toEqual([nothing.status, codeOf(nothing)]);
    assertStatus(foreign, 404);
    assertStatus(await world.asTenantB(1, 'GET', `/steering-meetings/${held.id}`), 404);
    expect(items(await world.asTenantB(1, 'GET', '/directives'))).toEqual([]);
    assertStatus(await world.asTenantB(1, 'POST', `/directives/${given.id}/cancellation`, { ifMatch: 1, body: { reason: REASON } }), 404);
  });

  it('negative control: the checks of this suite go red on an answer that is wrong on purpose', () => {
    expectCheckFails(() => assertStatus({ status: 200, json: {} }, 403, 'SELF_APPROVAL_DENIED'));
    expectCheckFails(() => assertStatus({ status: 403, json: { code: 'PERMISSION_DENIED' } }, 403, 'SELF_APPROVAL_DENIED'));
  });
});
