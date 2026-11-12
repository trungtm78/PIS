import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { addDirectiveDays, vietnamDateOf } from '@machvon/kernel';
import { TENANT_A, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { REPO_ROOT } from '../isolation/test-app';
import type { Doc } from './case-d-support';
import { assertStatus, codeOf, expectCheckFails } from './uat-kit';
import type { Reply } from './uat-kit';
import { ROOT_UNIT, UatWorld } from './uat-world';

/**
 * The design cases of the directives of the steering meetings that no suite named (docs/uat/dir/uat.json): PLAN-132 to PLAN-139 and DIR-E2E-02, on the whole enterprise edition over a real database.
 *
 * The time of a case: the directive controllers read the system clock (there is no port for it in the application), so the days of the cases are relative to the real day, as the suite dir.uat.test.ts does, and a
 * case that needs the day to move says how: the alert centre (my work) has the product's own clock port, which the world binds (`setClock`); the reads of the directive list take the real day, so the day is moved by
 * moving the due days of the rows by the same number of days (an advance of N days is the same relation between the due day and the day of the read); the history of a period is moved to the days of the case by
 * writing the days of the timeline events as a superuser (a command writes the real moment).
 */
jest.setTimeout(600_000);

const FAMILY = 0xd7;
const UNIT_A = 2; // U-1 of the cases: the unit the directives are given to
const UNIT_B = 3; // U-2: the unit the other reader reads
const TODAY = vietnamDateOf(new Date());
const YEAR = Number(TODAY.slice(0, 4));
const DAY = (offset: number, from: string = TODAY): string => addDirectiveDays(from, offset);
const noon = (day: string): Date => new Date(`${day}T05:00:00Z`); // 12:00 in Vietnam
const PERSONAS = {
  secretary: ['directive.meeting.manage', 'directive.manage', 'directive.close', 'directive.read'],
  assignee: ['directive.progress', 'directive.read', 'home.read'],
  closer: ['directive.close', 'directive.read'],
  decider: ['directive.extension.decide', 'directive.read'],
  reader: ['directive.read'],
  'reader-u2': ['directive.read'],
  dual: ['directive.progress', 'directive.extension.decide', 'directive.read'],
  leader: ['directive.read', 'home.read'],
};
const REASON = 'The steering meeting asked for more time.';

describe('UAT cases of the directives of the steering meetings (PLAN-132..139, DIR-E2E-02)', () => {
  const world = new UatWorld();
  const projectOne = id(FAMILY, 1);
  const projectTwo = id(FAMILY, 3);
  const projectThree = id(FAMILY, 4);
  const clean = id(FAMILY, 10);
  const infected = id(FAMILY, 12);

  beforeAll(async () => {
    await world.start(PERSONAS, {}, async (w) => {
      await w.harness.seedUnits(TENANT_A, [
        { n: UNIT_A, path: `/${unitId(ROOT_UNIT)}/${unitId(UNIT_A)}/`, parent: ROOT_UNIT },
        { n: UNIT_B, path: `/${unitId(ROOT_UNIT)}/${unitId(UNIT_B)}/`, parent: ROOT_UNIT },
      ]);
      // The reader of U-2 reads that unit only: its grant is on the subtree of U-2, not on the tenant.
      await w.harness.owner(TENANT_A, [
        [
          "update machvon.role_grant set scope_kind = 'UNIT_SUBTREE', scope_ref_ids = array[$2]::uuid[], scope_json = $3::jsonb where membership_id = $1::uuid",
          [memberId(w.member('reader-u2')), unitId(UNIT_B), JSON.stringify({ kind: 'UNIT_SUBTREE', ref_ids: [unitId(UNIT_B)] })],
        ],
      ]);
      const projects: Array<[string, unknown[]]> = [projectOne, projectTwo, projectThree].map((projectId, index) => [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, $3, 'Plant project', $4, $4, $5, 'INTERNAL', 1000000000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, projectId, `UAT-DIRC-P${index + 1}`, unitId(UNIT_A), id(FAMILY, 2)],
      ]);
      await w.seedAsAdmin([
        ...projects,
        [`insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'QD', 'Biên bản', 'INTERNAL', $3, $3)`, [TENANT_A, id(FAMILY, 11), memberId(1)]],
        [
          `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
           values ($1, $2, $3, 1, 'tenants/dirc/minutes-1.pdf', repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL')`,
          [TENANT_A, clean, id(FAMILY, 11)],
        ],
        [
          `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
           values ($1, $2, $3, 2, 'tenants/dirc/minutes-2.pdf', repeat('b', 64), 'application/pdf', 1, 'INTERNAL', 'INFECTED', '{}'::jsonb, 'RENDERED_FINAL')`,
          [TENANT_A, infected, id(FAMILY, 11)],
        ],
      ]);
    });
  }, 600_000);

  afterAll(() => world.stop(), 60_000);

  async function meeting(extra: Record<string, unknown> = {}): Promise<{ id: string; code: string }> {
    const made = await world.as('secretary', 'POST', '/steering-meetings', { body: { meeting_date: DAY(-10), meeting_type: 'WEEKLY', title: 'Giao ban tuần về giải ngân', unit_id: unitId(ROOT_UNIT), ...extra } });
    assertStatus(made, 200);
    return { id: made.json.resource_id as string, code: made.json.code as string };
  }

  async function directive(meetingId: string, extra: Record<string, unknown> = {}): Promise<{ id: string; code: string }> {
    const made = await world.as('secretary', 'POST', `/steering-meetings/${meetingId}/directives`, {
      body: { scope_kind: 'UNIT', unit_id: unitId(UNIT_A), text: 'Hoàn thành thủ tục giải phóng mặt bằng.', assignee_unit_id: unitId(UNIT_A), assignee_membership_id: world.idOf('assignee'), due_on: DAY(10), ...extra },
    });
    assertStatus(made, 200);
    return { id: made.json.resource_id as string, code: made.json.code as string };
  }

  const versionOf = async (directiveId: string): Promise<number> => Number((await world.rows<{ version: string }>('select version::text as version from machvon.directive where id = $1::uuid', [directiveId]))[0]?.version);
  const items = (reply: Reply): Array<Record<string, unknown>> => reply.json.items as Array<Record<string, unknown>>;
  const closeAs = (persona: string, directiveId: string, note = 'Đã bàn giao, có biên bản.'): Promise<Reply> =>
    versionOf(directiveId).then((version) => world.as(persona, 'POST', `/directives/${directiveId}/closure`, { ifMatch: version, body: { note, evidence_document_version_ids: [clean] } }));
  async function refusal(attempt: Promise<unknown>): Promise<string> {
    try {
      await attempt;
    } catch (error) {
      return String((error as Error).message);
    }
    throw new Error('the database accepted the statement');
  }
  /** Moves the days of the history of a directive to the days of a case: the command writes the real moment, the case is about days before it. */
  const placeInTime = (directiveId: string, days: { created?: string; progress?: string; closed?: string }): Promise<void> =>
    world.seedAsAdmin([
      ...(days.created === undefined ? [] : ([[`update machvon.directive_event set occurred_at = $2::timestamptz where directive_id = $1::uuid and event_type = 'CREATED'`, [directiveId, noon(days.created).toISOString()]]] as Array<[string, unknown[]]>)),
      ...(days.progress === undefined ? [] : ([[`update machvon.directive_event set occurred_at = $2::timestamptz where directive_id = $1::uuid and event_type = 'PROGRESS'`, [directiveId, noon(days.progress).toISOString()]]] as Array<[string, unknown[]]>)),
      ...(days.closed === undefined
        ? []
        : ([
            [`update machvon.directive_event set occurred_at = $2::timestamptz where directive_id = $1::uuid and event_type = 'CLOSED'`, [directiveId, noon(days.closed).toISOString()]],
            [`update machvon.directive set closed_at = $2::timestamptz where id = $1::uuid`, [directiveId, noon(days.closed).toISOString()]],
          ] as Array<[string, unknown[]]>)),
    ]);

  // The first case of the file makes the first meeting of the year: the code of a meeting is numbered inside the year of its day.
  it('UAT-PLAN-132 a meeting of a day to come is refused (422), minutes that are infected are refused (422 DECISION_DOCUMENT_REQUIRED), and the first meeting of the day to day is GB-year-001 and the next GB-year-002', async () => {
    // Prepared: a meeting of last year holds the place for the attached minutes (its own number series), so that the codes of this year start at 001.
    const earlier = await meeting({ meeting_date: `${YEAR - 1}-12-15`, title: 'Giao ban năm trước' });
    expect(earlier.code).toBe(`GB-${YEAR - 1}-001`);
    const body = { meeting_type: 'WEEKLY', title: 'Giao ban tuần', unit_id: unitId(ROOT_UNIT) };
    const before = (await world.rows('select 1 from machvon.steering_meeting')).length;
    assertStatus(await world.as('secretary', 'POST', '/steering-meetings', { body: { ...body, meeting_date: DAY(1) } }), 422, 'VALIDATION_FAILED');
    assertStatus(await world.as('secretary', 'POST', `/steering-meetings/${earlier.id}/minutes`, { ifMatch: 1, body: { document_version_id: infected } }), 422, 'DECISION_DOCUMENT_REQUIRED');
    expect((await world.rows('select 1 from machvon.steering_meeting')).length).toBe(before);
    expect((await world.rows<{ minutes: string | null }>('select minutes_document_version_id::text as minutes from machvon.steering_meeting where id = $1::uuid', [earlier.id]))[0]?.minutes).toBeNull();
    const first = await world.as('secretary', 'POST', '/steering-meetings', { body: { ...body, meeting_date: TODAY, minutes_document_version_id: clean } });
    assertStatus(first, 200);
    expect(first.json.code).toBe(`GB-${YEAR}-001`);
    expect((await world.rows<{ minutes: string }>('select minutes_document_version_id::text as minutes from machvon.steering_meeting where id = $1::uuid', [first.json.resource_id]))[0]?.minutes).toBe(clean);
    const second = await world.as('secretary', 'POST', '/steering-meetings', { body: { ...body, meeting_date: TODAY } });
    assertStatus(second, 200);
    expect(second.json.code).toBe(`GB-${YEAR}-002`);
    expect((await world.audits(first.json.resource_id as string, 'directive.meeting_created'))[0]).toMatchObject({ actor_id: world.idOf('secretary'), safe_diff: { code: `GB-${YEAR}-001` } });
  });

  it('UAT-PLAN-133 a directive due before its meeting, and one for a project and a unit together, are refused (422); one for the project alone is made for that project only; the text cannot be edited, a new directive is the way', async () => {
    const held = await meeting({ meeting_date: DAY(-10), title: 'Giao ban về chỉ đạo' });
    const url = `/steering-meetings/${held.id}/directives`;
    const before = (await world.rows('select 1 from machvon.directive')).length;
    assertStatus(await world.as('secretary', 'POST', url, { body: { scope_kind: 'PROJECT', project_id: projectOne, text: 'Quá sớm.', assignee_unit_id: unitId(UNIT_A), due_on: DAY(-12) } }), 422, 'VALIDATION_FAILED');
    assertStatus(await world.as('secretary', 'POST', url, { body: { scope_kind: 'PROJECT', project_id: projectOne, unit_id: unitId(UNIT_B), text: 'Cả dự án và đơn vị.', assignee_unit_id: unitId(UNIT_A), due_on: DAY(10) } }), 422, 'VALIDATION_FAILED');
    assertStatus(await world.as('secretary', 'POST', url, { body: { scope_kind: 'UNIT', project_id: projectOne, unit_id: unitId(UNIT_B), text: 'Cả đơn vị và dự án.', assignee_unit_id: unitId(UNIT_A), due_on: DAY(10) } }), 422, 'VALIDATION_FAILED');
    expect((await world.rows('select 1 from machvon.directive')).length).toBe(before);
    const made = await world.as('secretary', 'POST', url, { body: { scope_kind: 'PROJECT', project_id: projectOne, text: 'Hoàn thành giải phóng mặt bằng.', assignee_unit_id: unitId(UNIT_A), due_on: DAY(10) } });
    assertStatus(made, 200);
    expect(made.json.code).toBe(`${held.code}/CD-01`);
    expect((await world.rows<{ scope_kind: string; project_id: string; scope_unit_id: string }>('select scope_kind, project_id::text, scope_unit_id::text from machvon.directive where id = $1::uuid', [made.json.resource_id]))[0]).toEqual({ scope_kind: 'PROJECT', project_id: projectOne, scope_unit_id: unitId(UNIT_A) });
    // The instruction is not edited: the contract has no operation that edits a directive, a request to its address is no route, and the database refuses the new words.
    const paths = (JSON.parse(readFileSync(join(REPO_ROOT, 'Design', 'MACHVON_Design', '03_Engineering', 'openapi.json'), 'utf8')) as { paths: Record<string, Record<string, unknown>> }).paths;
    expect(Object.keys(paths['/directives/{id}'] ?? {}).filter((method) => ['put', 'patch', 'delete'].includes(method))).toEqual([]);
    for (const method of ['PATCH', 'PUT']) {
      const edited = await world.as('secretary', method, `/directives/${made.json.resource_id}`, { body: { text: 'Đổi lời chỉ đạo.' } });
      expect([404, 405]).toContain(edited.status);
    }
    expect(await refusal(world.rows("update machvon.directive set directive_text = 'Đổi lời chỉ đạo.', version = version + 1 where id = $1::uuid", [made.json.resource_id]))).toMatch(/never change/);
    expect((await world.rows<{ text: string }>('select directive_text as text from machvon.directive where id = $1::uuid', [made.json.resource_id]))[0]?.text).toBe('Hoàn thành giải phóng mặt bằng.');
    // A new directive in the same meeting is the way to change the instruction.
    const another = await directive(held.id, { text: 'Chỉ đạo thay thế.' });
    expect(another.code).toBe(`${held.code}/CD-02`);
  });

  it('UAT-PLAN-134 the list puts the overdue directive first, the summary counts equal the rows, a day later the other is overdue too, and the reader of another unit sees no row of the unit', async () => {
    const held = await meeting({ meeting_date: DAY(-30), title: 'Giao ban đọc danh sách' });
    const one = await directive(held.id, { due_on: DAY(-3), text: 'Chỉ đạo D1 đã quá hạn.' });
    const two = await directive(held.id, { due_on: DAY(4), text: 'Chỉ đạo D2 còn hạn.' });
    // Step 1: on the day D1 (due 3 days ago) is late and leads the list, D2 is open.
    const listed = await world.as('reader', 'GET', `/directives?meeting_id=${held.id}`);
    expect(items(listed).map((item) => item.id)).toEqual([one.id, two.id]);
    expect(items(listed)[0]).toMatchObject({ status: 'OVERDUE', stored_status: 'OPEN', overdue_days: 3 });
    expect(items(listed)[1]).toMatchObject({ status: 'OPEN', days_to_due: 4 });
    // Step 2: the counts of the summary equal the rows of the list, in total and by status.
    const summary = await world.as('reader', 'GET', `/directives/summary?meeting_id=${held.id}`);
    expect(summary.json.total).toBe(2);
    expect(summary.json.by_status).toMatchObject({ OVERDUE: 1, OPEN: 1 });
    expect(Object.values(summary.json.by_status as Record<string, number>).reduce((sum, value) => sum + value, 0)).toBe(items(listed).length);
    const everything = await world.as('reader', 'GET', '/directives?limit=200');
    const all = await world.as('reader', 'GET', '/directives/summary');
    expect(all.json.total).toBe(items(everything).length);
    // Step 3: five days on, D2 is overdue as well. The directive reads take the system clock: the day moves by moving the due days of both rows five days back.
    await world.seedAsAdmin([[`update machvon.directive set original_due_on = original_due_on - 5, due_on = due_on - 5 where id = any($1::uuid[])`, [[one.id, two.id]]]]);
    const later = await world.as('reader', 'GET', `/directives?meeting_id=${held.id}`);
    expect(items(later).map((item) => [item.id, item.status])).toEqual([[one.id, 'OVERDUE'], [two.id, 'OVERDUE']]);
    expect(items(later)[1]).toMatchObject({ overdue_days: 1 });
    expect((await world.as('reader', 'GET', `/directives/summary?meeting_id=${held.id}`)).json.by_status).toMatchObject({ OVERDUE: 2, OPEN: 0 });
    // Step 4: a reader whose grant is on U-2 reads no directive of U-1.
    const other = await world.as('reader-u2', 'GET', '/directives?limit=200');
    assertStatus(other, 200);
    expect(items(other)).toEqual([]);
    expect((await world.as('reader-u2', 'GET', '/directives/summary')).json.total).toBe(0);
    assertStatus(await world.as('reader-u2', 'GET', `/directives/${one.id}`), 404);
  });

  it('UAT-PLAN-135 as the day advances a directive is an action in the work list of the assignee three days before its day, overdue after it, and urgent and visible once to the head of the unit seven days after it', async () => {
    const held = await meeting({ meeting_date: DAY(-1), title: 'Giao ban đồng hồ' });
    const due = DAY(20);
    const given = await directive(held.id, { due_on: due, text: 'Chỉ đạo D3 theo dõi đồng hồ.' });
    const workOf = async (persona: string, day: string): Promise<Array<Doc>> => {
      world.setClock(noon(day));
      const reply = await world.as(persona, 'GET', '/home/my-work?limit=200');
      assertStatus(reply, 200);
      return items(reply).filter((item) => item.id === given.id) as Array<Doc>;
    };
    try {
      // Step 1: three days before the day, the item is in the work list of the assignee, to be acted on; the head of the unit does not see it.
      const soon = await workOf('assignee', DAY(-3, due));
      expect(soon).toHaveLength(1);
      expect(soon[0]).toMatchObject({ kind: 'DIRECTIVE_DUE', severity: 'ACTION', overdue: false, due_on: due, target: { screen: 'DIR-04', id: given.id } });
      expect(await workOf('leader', DAY(-3, due))).toHaveLength(0);
      // Not before the reminder window: ten days before the day nothing is raised.
      expect(await workOf('assignee', DAY(-10, due))).toHaveLength(0);
      // Step 2: the day after, it is overdue and still an action; the head of the unit still does not see it.
      const late = await workOf('assignee', DAY(1, due));
      expect(late).toHaveLength(1);
      expect(late[0]).toMatchObject({ kind: 'DIRECTIVE_OVERDUE', severity: 'ACTION', overdue: true, days_late: 1 });
      expect(late[0]?.escalation).not.toBeNull();
      expect(await workOf('leader', DAY(1, due))).toHaveLength(0);
      // Step 3: seven days after it is urgent, escalated, and in the list of the head of the unit once (and still in the one of the assignee).
      const urgent = await workOf('assignee', DAY(7, due));
      expect(urgent).toHaveLength(1);
      expect(urgent[0]).toMatchObject({ kind: 'DIRECTIVE_OVERDUE', severity: 'URGENT', overdue: true, days_late: 7 });
      expect(urgent[0]?.escalation).not.toBeNull();
      const head = await workOf('leader', DAY(7, due));
      expect(head).toHaveLength(1);
      expect(head[0]).toMatchObject({ kind: 'DIRECTIVE_OVERDUE', severity: 'URGENT', target: { screen: 'DIR-04', id: given.id } });
    } finally {
      world.setClock(undefined);
    }
  });

  it('UAT-PLAN-137 a request beyond the number of extensions is refused (422 DIRECTIVE_EXTENSION_LIMIT), one beyond the days (422 DIRECTIVE_EXTENSION_INVALID), the requester cannot decide it (403 SELF_APPROVAL_DENIED), and a directive with a request waiting cannot be closed (409 DIRECTIVE_EXTENSION_PENDING)', async () => {
    // The policy of the tenant is the built-in default (3 extensions, 60 days): the reader of the policy is not wired to an approved rule of the tenant (DirectivePolicyReader has no source), so the limits
    // of the case (2 and 15) cannot be set; the same checks are made at the limits that are in force.
    const held = await meeting({ meeting_date: DAY(-20), title: 'Giao ban gia hạn' });
    const exhausted = await directive(held.id, { due_on: DAY(5), text: 'D-2 đã gia hạn ba lần.' });
    let proposed = DAY(5);
    for (let round = 1; round <= 3; round += 1) {
      proposed = DAY(10, proposed);
      const asked = await world.as('assignee', 'POST', `/directives/${exhausted.id}/extension-requests`, { body: { proposed_due_on: proposed, reason: REASON } });
      assertStatus(asked, 200);
      assertStatus(await world.as('decider', 'POST', `/directive-extensions/${String(asked.json.extension_id)}/decision`, { ifMatch: 1, body: { decision: 'approve', reason: 'Đồng ý gia hạn.' } }), 200);
    }
    const limit = await world.as('assignee', 'POST', `/directives/${exhausted.id}/extension-requests`, { body: { proposed_due_on: DAY(10, proposed), reason: REASON } });
    assertStatus(limit, 422, 'DIRECTIVE_EXTENSION_LIMIT');
    expect(limit.json).toMatchObject({ max_extensions: 3 });
    expect((await world.rows('select 1 from machvon.directive_extension where directive_id = $1::uuid', [exhausted.id])).length).toBe(3);
    // Step 2: more days than the policy gives, on a directive that has had none.
    const fresh = await directive(held.id, { due_on: DAY(5), text: 'D-4 xin gia hạn quá dài.' });
    const tooLong = await world.as('assignee', 'POST', `/directives/${fresh.id}/extension-requests`, { body: { proposed_due_on: DAY(61, DAY(5)), reason: REASON } });
    assertStatus(tooLong, 422, 'DIRECTIVE_EXTENSION_INVALID');
    expect(tooLong.json).toMatchObject({ max_extension_days: 60 });
    // Step 3 and 4: the person who asked cannot decide their own request, and the directive with a request waiting cannot be closed.
    const waiting = await directive(held.id, { due_on: DAY(5), text: 'D-3 có đề nghị đang chờ.', assignee_membership_id: world.idOf('dual') });
    const own = await world.as('dual', 'POST', `/directives/${waiting.id}/extension-requests`, { body: { proposed_due_on: DAY(20), reason: REASON } });
    assertStatus(own, 200);
    assertStatus(await world.as('dual', 'POST', `/directive-extensions/${String(own.json.extension_id)}/decision`, { ifMatch: 1, body: { decision: 'approve', reason: 'Tự duyệt.' } }), 403, 'SELF_APPROVAL_DENIED');
    assertStatus(await closeAs('closer', waiting.id), 409, 'DIRECTIVE_EXTENSION_PENDING');
    expect((await world.rows<{ status: string }>('select status from machvon.directive where id = $1::uuid', [waiting.id]))[0]?.status).not.toBe('DONE');
    expect((await world.rows<{ status: string }>('select status from machvon.directive_extension where id = $1::uuid', [own.json.extension_id]))[0]?.status).toBe('REQUESTED');
  });

  it('UAT-PLAN-138 a closed directive is reopened with a reason and a history row, an open directive cannot be reopened (409 DIRECTIVE_STATE_INVALID), and the database refuses to edit or delete a history row', async () => {
    const held = await meeting({ meeting_date: DAY(-10), title: 'Giao ban mở lại' });
    const closedOne = await directive(held.id, { due_on: DAY(5), text: 'D-5 đã đóng.' });
    assertStatus(await closeAs('closer', closedOne.id), 200);
    expect((await world.rows<{ status: string }>('select status from machvon.directive where id = $1::uuid', [closedOne.id]))[0]?.status).toBe('DONE');
    // Step 1: the product opens a done directive again as IN_PROGRESS (a cancelled one as OPEN): it is a live directive again, with a REOPENED row in its timeline.
    const reopened = await world.as('secretary', 'POST', `/directives/${closedOne.id}/reopening`, { ifMatch: await versionOf(closedOne.id), body: { reason: 'Biên bản chưa đủ, làm lại.' } });
    assertStatus(reopened, 200);
    expect(reopened.json).toMatchObject({ status: 'IN_PROGRESS' });
    const history = await world.rows<{ event_type: string; note: string | null; actor_id: string }>(`select event_type, note, actor_id::text from machvon.directive_event where directive_id = $1::uuid order by directive_version, occurred_at`, [closedOne.id]);
    expect(history.map((row) => row.event_type)).toEqual(['CREATED', 'CLOSED', 'REOPENED']);
    expect(history[2]).toMatchObject({ note: 'Biên bản chưa đủ, làm lại.', actor_id: world.idOf('secretary') });
    expect((await world.audits(closedOne.id, 'directive.reopened'))[0]).toMatchObject({ actor_id: world.idOf('secretary'), reason: 'Biên bản chưa đủ, làm lại.' });
    expect((await world.as('reader', 'GET', `/directives/${closedOne.id}`)).json).toMatchObject({ directive: { stored_status: 'IN_PROGRESS' } });
    // Step 2: an open directive cannot be reopened.
    const openOne = await directive(held.id, { due_on: DAY(5), text: 'D-6 còn mở.' });
    assertStatus(await world.as('secretary', 'POST', `/directives/${openOne.id}/reopening`, { ifMatch: await versionOf(openOne.id), body: { reason: 'Mở lại.' } }), 409, 'DIRECTIVE_STATE_INVALID');
    // Step 3: nobody edits or removes a row of the history, the owner of the database included.
    for (const statement of ["update machvon.directive_event set note = 'Sửa' where directive_id = $1::uuid", 'delete from machvon.directive_event where directive_id = $1::uuid']) {
      expect(await refusal(world.rows(statement, [closedOne.id]))).toMatch(/append-only/);
    }
    expect((await world.rows('select 1 from machvon.directive_event where directive_id = $1::uuid', [closedOne.id])).length).toBe(3);
  });

  it('UAT-PLAN-139 the directives of a period as the input of the report: the one that closed after the period end is not done at its end and overdue, the one closed inside it is done, the totals equal the rows and each shows its latest note', async () => {
    // The period is the week that ended eleven days ago (the case is of the week 2026-W44, ended 2026-11-01), the directives are placed on its days.
    const end = DAY(-11);
    const start = DAY(-6, end);
    const held = await meeting({ meeting_date: DAY(-5, end), title: 'Giao ban tuần trước kỳ báo cáo' });
    const late = await directive(held.id, { scope_kind: 'PROJECT', unit_id: undefined, project_id: projectOne, due_on: end, text: 'D-7 hết hạn cuối kỳ, đóng sau kỳ.' });
    const done = await directive(held.id, { scope_kind: 'PROJECT', unit_id: undefined, project_id: projectOne, due_on: DAY(-1, end), text: 'D-8 đóng trong kỳ.' });
    assertStatus(await world.as('assignee', 'POST', `/directives/${late.id}/progress`, { body: { note: 'Đã gửi hồ sơ cho sở.', progress_pct: 40 } }), 200);
    assertStatus(await closeAs('closer', late.id, 'Đóng sau kỳ báo cáo.'), 200);
    assertStatus(await closeAs('closer', done.id, 'Đã hoàn thành trong kỳ.'), 200);
    await placeInTime(late.id, { created: DAY(-5, end), progress: DAY(-3, end), closed: DAY(2, end) });
    await placeInTime(done.id, { created: DAY(-5, end), closed: DAY(-2, end) });
    const report = await world.as('reader', 'GET', `/directives/for-report?from=${start}&to=${end}&project_id=${projectOne}`);
    assertStatus(report, 200);
    expect(report.json.period).toEqual({ from: start, to: end });
    const rows = items(report);
    expect(rows).toHaveLength(2);
    const byId = (directiveId: string): Record<string, unknown> | undefined => rows.find((row) => row.id === directiveId);
    expect(byId(late.id)).toMatchObject({ status_at_end: 'OVERDUE', open_at_end: true, closed_in_period: false, due_on_at_end: end, last_note: 'Đã gửi hồ sơ cho sở.', last_note_on: DAY(-3, end) });
    expect(byId(done.id)).toMatchObject({ status_at_end: 'DONE', open_at_end: false, closed_in_period: true, last_note: 'Đã hoàn thành trong kỳ.', last_note_on: DAY(-2, end) });
    const counts = report.json.counts as { total: number; closed: number; open_at_end: number; overdue_at_end: number; by_status: Record<string, number> };
    expect(counts).toMatchObject({ total: 2, closed: 1, open_at_end: 1, overdue_at_end: 1 });
    expect(counts.by_status).toMatchObject({ OVERDUE: 1, DONE: 1, OPEN: 0 });
    expect(Object.values(counts.by_status).reduce((sum, value) => sum + value, 0)).toBe(rows.length);
    // The same directives today: the one closed after the period is DONE now; the report of the period does not take the state of today.
    const today = await world.as('reader', 'GET', `/directives?project_id=${projectOne}&limit=200`);
    expect(items(today).find((row) => row.id === late.id)).toMatchObject({ status: 'DONE' });
  });

  it('UAT-DIR-E2E-02 a directive open in the period and closed after it is OPEN at the end of the period, the counts add up to the list, and a period that is none is refused (422)', async () => {
    // The week is a pair of days of the request (the report of directives has no calendar of its own): a week that ended 25 days ago.
    const end = DAY(-25);
    const start = DAY(-6, end);
    const held = await meeting({ meeting_date: DAY(-4, end), title: 'Giao ban tuần đã khóa' });
    const withProject = { scope_kind: 'PROJECT', unit_id: undefined, project_id: projectTwo };
    const closedLater = await directive(held.id, { ...withProject, due_on: DAY(20, end), text: 'Chỉ đạo mở trong kỳ, đóng sau kỳ.' });
    const stillOpen = await directive(held.id, { ...withProject, due_on: DAY(20, end), text: 'Chỉ đạo còn mở.' });
    assertStatus(await closeAs('closer', closedLater.id), 200);
    await placeInTime(closedLater.id, { created: DAY(-4, end), closed: DAY(3, end) });
    await placeInTime(stillOpen.id, { created: DAY(-4, end) });
    const report = await world.as('reader', 'GET', `/directives/for-report?from=${start}&to=${end}&project_id=${projectTwo}`);
    assertStatus(report, 200);
    const rows = items(report);
    expect(rows.find((row) => row.id === closedLater.id)).toMatchObject({ status_at_end: 'OPEN', open_at_end: true, closed_in_period: false, raised_in_period: true });
    expect(rows.find((row) => row.id === stillOpen.id)).toMatchObject({ status_at_end: 'OPEN', open_at_end: true });
    // Step 2: against the list, the closed directive is DONE today; the report counts it as open on the day the period ended, and the counts are the sum of the rows.
    const listed = await world.as('reader', 'GET', `/directives?project_id=${projectTwo}&limit=200`);
    expect(items(listed).find((row) => row.id === closedLater.id)).toMatchObject({ status: 'DONE' });
    expect(items(listed)).toHaveLength(rows.length);
    const counts = report.json.counts as { total: number; raised: number; closed: number; open_at_end: number; by_status: Record<string, number> };
    expect(counts).toMatchObject({ total: 2, raised: 2, closed: 0, open_at_end: 2 });
    expect(counts.by_status).toMatchObject({ OPEN: 2, DONE: 0 });
    expect(Object.values(counts.by_status).reduce((sum, value) => sum + value, 0)).toBe(rows.length);
    // Step 3: a period that is none (it ends before it begins, or it is not given) is a 422 of the contract.
    assertStatus(await world.as('reader', 'GET', `/directives/for-report?from=${end}&to=${start}&project_id=${projectTwo}`), 422, 'VALIDATION_FAILED');
    assertStatus(await world.as('reader', 'GET', `/directives/for-report?to=${end}`), 422, 'VALIDATION_FAILED');
    assertStatus(await world.as('reader', 'GET', `/directives/for-report?from=not-a-day&to=${end}`), 422);
  });

  it('negative control: the checks of this suite go red on an answer that is wrong on purpose', () => {
    expectCheckFails(() => assertStatus({ status: 200, json: {} }, 422, 'VALIDATION_FAILED'));
    expectCheckFails(() => assertStatus({ status: 422, json: { code: 'DECISION_DOCUMENT_REQUIRED' } }, 422, 'VALIDATION_FAILED'));
    expectCheckFails(() => {
      if (codeOf({ status: 409, json: { code: 'DIRECTIVE_STATE_INVALID' } }) !== 'DIRECTIVE_EXTENSION_PENDING') throw new Error('the code is not the one of the case');
    });
  });
});
