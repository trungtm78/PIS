import { randomUUID } from 'node:crypto';
import { DIRECTIVE_POLICY_DEFAULTS, addDirectiveDays, vietnamDateOf } from '@machvon/kernel';
import type { DirectivePolicy } from '@machvon/kernel';
import { DirDirectiveStore } from '../src/dir-directive-store';
import type { DirectiveCommandResult, DirectiveFilter } from '../src/dir-directive-store';
import { HomeDirectiveSources } from '../src/home-directive-sources';
import { DEFAULT_SEVERITY_RULES } from '../src/home-work-rules';
import type { SourceContext } from '../src/home-work-sources';
import type { ScopeBuilder } from '../src/scope-version';
import type { TenantTx } from '../src/tenant-database';
import { TENANT_A, contextFor, id, memberId, unitId } from './support/authz-fixtures';
import { everything, nothing, seedAs } from './support/bid-proposal-fixtures';
import { BQL1, CapWorld, ROOT } from './support/cap-fixtures';

const world = new CapWorld();
const harness = world.harness;
const store = new DirDirectiveStore();
const POLICY: DirectivePolicy = DIRECTIVE_POLICY_DEFAULTS;
const FAMILY = 0xd1;
const SECRETARY = 11; // records the meeting and the directives
const ASSIGNEE = 12; // the person a directive is given to
const CLOSER = 13; // a third person: may close
const DECIDER = 14; // decides extensions
const HEAD = 15; // the head of the unit
const DOCUMENT = id(FAMILY, 1);
const VERSION_A = id(FAMILY, 2);
const VERSION_B = id(FAMILY, 3);
const INFECTED = id(FAMILY, 4);
const TODAY = '2026-11-08';
const REAL_TODAY = vietnamDateOf(new Date());
const DAY = (offset: number, from: string = TODAY): string => addDirectiveDays(from, offset);

let PROJECT = '';
let OTHER_PROJECT = '';

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = SECRETARY): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string; extensions?: Record<string, unknown> }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string; extensions?: Record<string, unknown> };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }), ...(e.extensions === undefined ? {} : { extensions: e.extensions }) };
  }
  throw new Error('expected a refusal');
}

const databaseRefusal = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    return (error as { message: string }).message;
  }
  throw new Error('expected the database to refuse');
};

const onProject =
  (projectId: string): ScopeBuilder =>
  (first) => ({ sql: `d.project_id = $${first}::uuid`, params: [projectId] });
const onAssigneeUnit =
  (unit: string): ScopeBuilder =>
  (first) => ({ sql: `au.id = $${first}::uuid`, params: [unit] });

let meetingCounter = 0;
async function meeting(date = '2026-10-01', today = TODAY, unit = unitId(ROOT)): Promise<{ id: string; code: string }> {
  meetingCounter += 1;
  const done = await as((tx) => store.createMeeting(tx, { meetingDate: date, meetingType: 'WEEKLY', title: `Giao ban tuần ${meetingCounter}`, unitId: unit }, memberId(SECRETARY), everything, today));
  return { id: done.id, code: done.code };
}

interface Given {
  directive: DirectiveCommandResult;
}
async function given(meetingId: string, options: { dueOn: string; projectId?: string | null; assigneeUnit?: number; assignee?: number | null; text?: string; actor?: number }): Promise<Given> {
  const projectId = options.projectId === undefined ? PROJECT : options.projectId;
  const directive = await as(
    (tx) =>
      store.addDirective(
        tx,
        meetingId,
        {
          scopeKind: projectId === null ? 'UNIT' : 'PROJECT',
          projectId: projectId ?? undefined,
          unitId: projectId === null ? unitId(BQL1) : undefined,
          text: options.text ?? 'Hoàn thành thủ tục giải phóng mặt bằng trước hạn.',
          assigneeUnitId: unitId(options.assigneeUnit ?? BQL1),
          assigneeMembershipId: options.assignee === null ? undefined : memberId(options.assignee ?? ASSIGNEE),
          dueOn: options.dueOn,
        },
        memberId(options.actor ?? SECRETARY),
        { meeting: everything, project: everything, unit: everything },
      ),
    options.actor ?? SECRETARY,
  );
  return { directive };
}

const stored = async (directiveId: string): Promise<{ status: string; due_on: string; closed_by: string | null; extension_count: number }> =>
  (await owner<{ status: string; due_on: string; closed_by: string | null; extension_count: number }>('select status, due_on::text as due_on, closed_by, extension_count from machvon.directive where id = $1::uuid', [directiveId]))[0] as {
    status: string;
    due_on: string;
    closed_by: string | null;
    extension_count: number;
  };
const events = (directiveId: string) => owner<{ event_type: string; actor_id: string; note: string | null }>('select event_type, actor_id, note from machvon.directive_event where directive_id = $1::uuid order by occurred_at, id', [directiveId]);

const sourceContext = (tx: TenantTx, view: 'mine' | 'scope', member: number, unitScope: ScopeBuilder = everything, projectScope: ScopeBuilder = everything): SourceContext => ({
  tx,
  membershipId: memberId(member),
  now: new Date(`${TODAY}T03:00:00Z`),
  today: TODAY,
  view,
  unitScope,
  projectScope,
  rules: DEFAULT_SEVERITY_RULES,
  counting: false,
});

describe('the directives of the steering meetings (governance deepening, lane DIR-1: CN.03, QT.02)', () => {
  beforeAll(async () => {
    await world.start();
    for (const n of [SECRETARY, ASSIGNEE, CLOSER, DECIDER, HEAD]) await harness.seedMembership(TENANT_A, n, ROOT);
    PROJECT = await world.project();
    OTHER_PROJECT = await world.project({ unitNumber: ROOT });
    await seedAs(harness, [
      [`insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'QD', 'Biên bản giao ban', 'INTERNAL', $3, $3)`, [TENANT_A, DOCUMENT, memberId(SECRETARY)]],
      ...(
        [
          [VERSION_A, 1, 'CLEAN'],
          [VERSION_B, 2, 'CLEAN'],
          [INFECTED, 3, 'INFECTED'],
        ] as const
      ).map(
        ([versionId, number, scan]): [string, unknown[]] => [
          `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
           values ($1, $2, $3, $4::integer, 'tenants/dir1/minutes-' || $4::integer::text || '.pdf', repeat('c', 64), 'application/pdf', 1, 'INTERNAL', $5, '{}'::jsonb, 'RENDERED_FINAL')`,
          [TENANT_A, versionId, DOCUMENT, number, scan],
        ],
      ),
    ]);
  }, 240_000);

  afterAll(async () => {
    await world.stop();
  }, 60_000);

  describe('the meeting', () => {
    it('is recorded with a code numbered in its year, and refuses a day to come, a kind that is none, a unit outside the scope or unknown, and a document that is infected', async () => {
      const first = await as((tx) => store.createMeeting(tx, { meetingDate: '2026-09-02', meetingType: 'MONTHLY', title: 'Giao ban tháng 9', summary: 'Bàn về giải ngân.', unitId: unitId(ROOT), minutesDocumentVersionId: VERSION_A }, memberId(SECRETARY), everything, TODAY));
      expect(first).toMatchObject({ code: 'GB-2026-001', version: 1, status: 'RECORDED', meetingDate: '2026-09-02', minutesDocumentVersionId: VERSION_A });
      const second = await as((tx) => store.createMeeting(tx, { meetingDate: '2026-09-09', meetingType: 'WEEKLY', title: 'Giao ban tuần 2', unitId: unitId(BQL1) }, memberId(SECRETARY), everything, TODAY));
      expect(second.code).toBe('GB-2026-002');
      const older = await as((tx) => store.createMeeting(tx, { meetingDate: '2025-12-30', meetingType: 'QUARTERLY', title: 'Giao ban quý 4', unitId: unitId(ROOT) }, memberId(SECRETARY), everything, TODAY));
      expect(older.code).toBe('GB-2025-001');

      const input = { meetingDate: '2026-09-10', meetingType: 'WEEKLY', title: 'Giao ban', unitId: unitId(ROOT) };
      const create = (changes: Partial<typeof input & { minutesDocumentVersionId: string }>, scope: ScopeBuilder = everything) => as((tx) => store.createMeeting(tx, { ...input, ...changes }, memberId(SECRETARY), scope, TODAY));
      expect(await refusal(create({ meetingDate: '2026-11-09' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'meeting_date', extensions: { reason: 'IN_THE_FUTURE' } });
      expect(await refusal(create({ meetingDate: '2026-02-30' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'meeting_date' });
      expect(await refusal(create({ meetingType: 'DAILY' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'meeting_type' });
      expect(await refusal(create({ title: '   ' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'title' });
      expect(await refusal(create({}, nothing))).toMatchObject({ code: 'SCOPE_DENIED', status: 403, detail: 'unit_id' });
      expect(await refusal(create({ unitId: randomUUID() }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'unit_id' });
      expect(await refusal(create({ minutesDocumentVersionId: INFECTED }))).toMatchObject({ code: 'DECISION_DOCUMENT_REQUIRED', detail: 'minutes_document_version_id' });
      expect(await refusal(create({ minutesDocumentVersionId: randomUUID() }))).toMatchObject({ code: 'DECISION_DOCUMENT_REQUIRED' });
    });

    it('attaches and replaces the minutes with the version, and refuses a stale version, an infected file and a meeting out of reach', async () => {
      const held = await meeting();
      const attached = await as((tx) => store.attachMinutes(tx, held.id, 1, VERSION_A, everything));
      expect(attached).toMatchObject({ version: 2, status: 'MINUTES_ATTACHED', minutesDocumentVersionId: VERSION_A });
      expect(await refusal(as((tx) => store.attachMinutes(tx, held.id, 1, VERSION_B, everything)))).toMatchObject({ code: 'VERSION_CONFLICT', extensions: { current_version: 2 } });
      expect(await refusal(as((tx) => store.attachMinutes(tx, held.id, 2, INFECTED, everything)))).toMatchObject({ code: 'DECISION_DOCUMENT_REQUIRED' });
      expect(await refusal(as((tx) => store.attachMinutes(tx, held.id, 2, VERSION_B, () => ({ sql: 'false', params: [] }))))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect((await as((tx) => store.attachMinutes(tx, held.id, 2, VERSION_B, everything))).minutesDocumentVersionId).toBe(VERSION_B);
    });
  });

  describe('giving a directive', () => {
    it('gives one about a project (judged by the owner unit of the project) and one about a unit, numbered in the meeting, with the first event of the timeline', async () => {
      const held = await meeting();
      const { directive } = await given(held.id, { dueOn: DAY(10) });
      expect(directive).toMatchObject({ code: `${held.code}/CD-01`, version: 1, status: 'OPEN', dueOn: DAY(10), projectId: PROJECT });
      const row = (await owner<{ scope_unit_id: string; scope_kind: string; original_due_on: string; due_on: string }>('select scope_unit_id, scope_kind, original_due_on::text, due_on::text from machvon.directive where id = $1::uuid', [directive.id]))[0];
      expect(row).toMatchObject({ scope_unit_id: unitId(BQL1), scope_kind: 'PROJECT', original_due_on: DAY(10), due_on: DAY(10) });
      const unitOnly = await given(held.id, { dueOn: DAY(20), projectId: null, assignee: null });
      expect(unitOnly.directive.code).toBe(`${held.code}/CD-02`);
      expect(await events(directive.id)).toEqual([{ event_type: 'CREATED', actor_id: memberId(SECRETARY), note: null }]);
    });

    it('refuses what the meeting and the scope do not allow: a due day before the meeting, both or neither of project and unit, an unknown assignee, a project outside the scope, and words that are empty', async () => {
      const held = await meeting('2026-10-05');
      const add = (changes: Record<string, unknown>, scopes = { meeting: everything, project: everything, unit: everything }) =>
        as((tx) => store.addDirective(tx, held.id, { scopeKind: 'PROJECT', projectId: PROJECT, text: 'Chỉ đạo', assigneeUnitId: unitId(BQL1), dueOn: DAY(5), ...changes } as never, memberId(SECRETARY), scopes));
      expect(await refusal(add({ dueOn: '2026-10-04' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'due_on', extensions: { reason: 'BEFORE_THE_MEETING' } });
      expect((await add({ dueOn: '2026-10-05' })).dueOn).toBe('2026-10-05');
      expect(await refusal(add({ unitId: unitId(BQL1) }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'unit_id' });
      expect(await refusal(add({ scopeKind: 'UNIT', projectId: PROJECT, unitId: unitId(BQL1) }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'project_id' });
      expect(await refusal(add({ scopeKind: 'UNIT', projectId: undefined, unitId: undefined }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'unit_id' });
      expect(await refusal(add({ scopeKind: 'WORLD' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'scope_kind' });
      expect(await refusal(add({ assigneeMembershipId: randomUUID() }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'assignee_membership_id' });
      expect(await refusal(add({ assigneeUnitId: randomUUID() }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'assignee_unit_id' });
      expect(await refusal(add({ projectId: randomUUID() }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'project_id' });
      expect(await refusal(add({}, { meeting: everything, project: nothing, unit: everything }))).toMatchObject({ code: 'SCOPE_DENIED', status: 403, detail: 'project_id' });
      expect(await refusal(add({ scopeKind: 'UNIT', projectId: undefined, unitId: unitId(BQL1) }, { meeting: everything, project: everything, unit: nothing }))).toMatchObject({ code: 'SCOPE_DENIED', detail: 'unit_id' });
      expect(await refusal(add({}, { meeting: nothing, project: everything, unit: everything }))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(add({ text: ' ' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'text' });
    });
  });

  describe('assigning, progress and evidence', () => {
    it('gives the directive to another unit and person (and takes the person off) with the old assignee on the timeline, and refuses no change, a stale version and an ended directive', async () => {
      const held = await meeting();
      const { directive } = await given(held.id, { dueOn: DAY(10) });
      const assign = (expected: number, input: Parameters<DirDirectiveStore['assign']>[3]) => as((tx) => store.assign(tx, directive.id, expected, input, memberId(SECRETARY), everything));
      expect(await refusal(assign(1, {}))).toMatchObject({ code: 'VALIDATION_FAILED', extensions: { reason: 'NOTHING_TO_ASSIGN' } });
      expect(await refusal(assign(1, { assigneeUnitId: unitId(BQL1), assigneeMembershipId: memberId(ASSIGNEE) }))).toMatchObject({ code: 'VALIDATION_FAILED', extensions: { reason: 'NO_CHANGE' } });
      expect(await refusal(assign(7, { assigneeUnitId: unitId(ROOT) }))).toMatchObject({ code: 'VERSION_CONFLICT', extensions: { current_version: 1 } });
      const moved = await assign(1, { assigneeUnitId: unitId(ROOT), assigneeMembershipId: memberId(HEAD), note: 'Giao cho đơn vị phụ trách pháp lý.' });
      expect(moved).toMatchObject({ version: 2, assigneeUnitId: unitId(ROOT) });
      const freed = await assign(2, { assigneeMembershipId: null });
      expect(freed.version).toBe(3);
      const [row] = await owner<{ assignee_unit_id: string; assignee_membership_id: string | null }>('select assignee_unit_id, assignee_membership_id from machvon.directive where id = $1::uuid', [directive.id]);
      expect(row).toEqual({ assignee_unit_id: unitId(ROOT), assignee_membership_id: null });
      const timeline = await owner<{ event_type: string; from_assignee_unit_id: string | null; to_assignee_unit_id: string | null; from_assignee_membership_id: string | null; to_assignee_membership_id: string | null }>(
        "select event_type, from_assignee_unit_id, to_assignee_unit_id, from_assignee_membership_id, to_assignee_membership_id from machvon.directive_event where directive_id = $1::uuid and event_type = 'ASSIGNED' order by occurred_at, id",
        [directive.id],
      );
      expect(timeline[0]).toEqual({ event_type: 'ASSIGNED', from_assignee_unit_id: unitId(BQL1), to_assignee_unit_id: unitId(ROOT), from_assignee_membership_id: memberId(ASSIGNEE), to_assignee_membership_id: memberId(HEAD) });
      expect(timeline[1]).toMatchObject({ from_assignee_membership_id: memberId(HEAD), to_assignee_membership_id: null });
      await as((tx) => store.cancel(tx, directive.id, 3, 'Không còn cần.', memberId(SECRETARY), everything));
      expect(await refusal(assign(4, { assigneeUnitId: unitId(BQL1) }))).toMatchObject({ code: 'DIRECTIVE_STATE_INVALID', status: 409, extensions: { status: 'CANCELLED', move: 'ASSIGN' } });
    });

    it('takes an open directive to in progress on the first note, keeps documents as evidence once, and refuses a percent that is none, an infected file, and a directive out of reach', async () => {
      const held = await meeting();
      const { directive } = await given(held.id, { dueOn: DAY(10) });
      const note = (input: Parameters<DirDirectiveStore['recordProgress']>[2], scope: ScopeBuilder = everything) => as((tx) => store.recordProgress(tx, directive.id, input, memberId(ASSIGNEE), scope), ASSIGNEE);
      expect(await refusal(note({ note: 'Đã gửi hồ sơ.', progressPct: 150 }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'progress_pct' });
      expect(await refusal(note({ note: 'Đã gửi hồ sơ.', evidenceDocumentVersionIds: [INFECTED] }))).toMatchObject({ code: 'DECISION_DOCUMENT_REQUIRED' });
      expect(await refusal(note({ note: ' ' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'note' });
      expect(await refusal(note({ note: 'Đã gửi hồ sơ.' }, nothing))).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
      const first = await note({ note: 'Đã gửi hồ sơ.', progressPct: 30, evidenceDocumentVersionIds: [VERSION_A, VERSION_A] });
      expect(first).toMatchObject({ status: 'IN_PROGRESS', version: 2 });
      expect((await stored(directive.id)).status).toBe('IN_PROGRESS');
      const second = await note({ note: 'Đã có ý kiến của sở.', progressPct: 60, evidenceDocumentVersionIds: [VERSION_A, VERSION_B] });
      expect(second).toMatchObject({ status: 'IN_PROGRESS', version: 3 });
      expect(Number((await owner<{ n: string }>('select count(*)::text as n from machvon.directive_evidence where directive_id = $1::uuid', [directive.id]))[0]?.n)).toBe(2);
      const progress = await owner<{ progress_pct: number | null }>("select progress_pct from machvon.directive_event where directive_id = $1::uuid and event_type = 'PROGRESS' order by occurred_at, id", [directive.id]);
      expect(progress.map((row) => row.progress_pct)).toEqual([30, 60]);
    });
  });

  describe('moving the due day', () => {
    it('is asked for with a reason within the policy, one request at a time, and decided by someone else; approving moves the day and counts it, rejecting leaves the day', async () => {
      const held = await meeting();
      const { directive } = await given(held.id, { dueOn: DAY(10) });
      const ask = (input: { proposedDueOn: string; reason: string }, policy = POLICY) => as((tx) => store.requestExtension(tx, directive.id, input, memberId(ASSIGNEE), everything, policy), ASSIGNEE);
      expect(await refusal(ask({ proposedDueOn: DAY(10), reason: 'Chờ ý kiến.' }))).toMatchObject({ code: 'DIRECTIVE_EXTENSION_INVALID', status: 422 });
      expect(await refusal(ask({ proposedDueOn: DAY(71), reason: 'Chờ ý kiến.' }))).toMatchObject({ code: 'DIRECTIVE_EXTENSION_INVALID', extensions: { max_extension_days: 60 } });
      expect(await refusal(ask({ proposedDueOn: DAY(20), reason: '  ' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'reason' });
      const asked = await ask({ proposedDueOn: DAY(20), reason: 'Chờ ý kiến của sở xây dựng.' });
      expect(asked).toMatchObject({ status: 'EXTENSION_REQUESTED', version: 2 });
      const extensionId = asked.extensionId as string;
      expect(await refusal(ask({ proposedDueOn: DAY(25), reason: 'Thêm một lần nữa.' }))).toMatchObject({ code: 'DIRECTIVE_EXTENSION_PENDING', status: 409 });

      const decide = (member: number, decision: string, expected = 1) => as((tx) => store.decideExtension(tx, extensionId, expected, { decision, reason: 'Đã xem xét.' }, memberId(member), everything, POLICY), member);
      expect(await refusal(decide(ASSIGNEE, 'approve'))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await refusal(decide(DECIDER, 'maybe'))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'decision' });
      expect(await refusal(decide(DECIDER, 'approve', 9))).toMatchObject({ code: 'VERSION_CONFLICT', extensions: { current_version: 1 } });
      const approved = await decide(DECIDER, 'approve');
      expect(approved).toMatchObject({ status: 'APPROVED', version: 2, dueOn: DAY(20), id: extensionId });
      expect(await stored(directive.id)).toMatchObject({ due_on: DAY(20), extension_count: 1 });
      expect((await owner<{ original_due_on: string }>('select original_due_on::text from machvon.directive where id = $1::uuid', [directive.id]))[0]?.original_due_on).toBe(DAY(10));
      expect(await refusal(decide(DECIDER, 'approve', 2))).toMatchObject({ code: 'DIRECTIVE_EXTENSION_STATE_INVALID', status: 409 });

      const again = await ask({ proposedDueOn: DAY(30), reason: 'Chờ thêm.' });
      const rejected = await as((tx) => store.decideExtension(tx, again.extensionId as string, 1, { decision: 'reject', reason: 'Đã gia hạn một lần.' }, memberId(DECIDER), everything, POLICY), DECIDER);
      expect(rejected.status).toBe('REJECTED');
      expect(await stored(directive.id)).toMatchObject({ due_on: DAY(20), extension_count: 1 });
      expect((await events(directive.id)).map((event) => event.event_type)).toEqual(['CREATED', 'EXTENSION_REQUESTED', 'EXTENSION_APPROVED', 'EXTENSION_REQUESTED', 'EXTENSION_REJECTED']);
      const [approval] = await owner<{ approver_id: string; from_due_on: string; to_due_on: string }>("select approver_id, from_due_on::text, to_due_on::text from machvon.directive_event where directive_id = $1::uuid and event_type = 'EXTENSION_APPROVED'", [directive.id]);
      expect(approval).toEqual({ approver_id: memberId(DECIDER), from_due_on: DAY(10), to_due_on: DAY(20) });
    });

    it('stops at the number of extensions the policy gives, and a policy that a tenant approved is the one that counts', async () => {
      const held = await meeting();
      const { directive } = await given(held.id, { dueOn: DAY(10) });
      const strict: DirectivePolicy = { ...POLICY, maxExtensions: 1, maxExtensionDays: 15 };
      const ask = (due: string) => as((tx) => store.requestExtension(tx, directive.id, { proposedDueOn: due, reason: 'Chờ ý kiến.' }, memberId(ASSIGNEE), everything, strict), ASSIGNEE);
      expect(await refusal(ask(DAY(26)))).toMatchObject({ code: 'DIRECTIVE_EXTENSION_INVALID', extensions: { max_extension_days: 15 } });
      const asked = await ask(DAY(25));
      await as((tx) => store.decideExtension(tx, asked.extensionId as string, 1, { decision: 'approve', reason: 'Đồng ý.' }, memberId(DECIDER), everything, strict), DECIDER);
      expect(await refusal(ask(DAY(30)))).toMatchObject({ code: 'DIRECTIVE_EXTENSION_LIMIT', status: 422, extensions: { max_extensions: 1 } });
    });
  });

  describe('closing, cancelling and reopening', () => {
    it('closes only with evidence and by a third person, ends the directive with who and when, and refuses to close while a request for time is open', async () => {
      const held = await meeting();
      const { directive } = await given(held.id, { dueOn: DAY(10) });
      const close = (member: number, input: Parameters<DirDirectiveStore['close']>[3], expected?: number, policy = POLICY) =>
        as(async (tx) => store.close(tx, directive.id, expected ?? (await currentVersion(tx)), input, memberId(member), everything, policy), member);
      const currentVersion = async (tx: TenantTx): Promise<number> => Number((await tx.query<{ version: string }>('select version::text as version from machvon.directive where id = $1::uuid', [directive.id]))[0]?.version);
      expect(await refusal(close(SECRETARY, { note: 'Xong.', evidenceDocumentVersionIds: [VERSION_A] }))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await refusal(close(ASSIGNEE, { note: 'Xong.', evidenceDocumentVersionIds: [VERSION_A] }))).toMatchObject({ code: 'SELF_APPROVAL_DENIED' });
      expect(await refusal(close(CLOSER, { note: 'Xong.' }))).toMatchObject({ code: 'DIRECTIVE_EVIDENCE_REQUIRED', status: 422 });
      expect(await refusal(close(CLOSER, { note: 'Xong.', evidenceDocumentVersionIds: [VERSION_A] }, 9))).toMatchObject({ code: 'VERSION_CONFLICT' });

      const asked = await as((tx) => store.requestExtension(tx, directive.id, { proposedDueOn: DAY(15), reason: 'Chờ ý kiến.' }, memberId(ASSIGNEE), everything, POLICY), ASSIGNEE);
      expect(await refusal(close(CLOSER, { note: 'Xong.', evidenceDocumentVersionIds: [VERSION_A] }))).toMatchObject({ code: 'DIRECTIVE_EXTENSION_PENDING', status: 409 });
      expect(await refusal(as((tx) => store.cancel(tx, directive.id, asked.version, 'Không còn cần.', memberId(CLOSER), everything), CLOSER))).toMatchObject({ code: 'DIRECTIVE_EXTENSION_PENDING' });
      await as((tx) => store.decideExtension(tx, asked.extensionId as string, 1, { decision: 'reject', reason: 'Đủ thời gian.' }, memberId(DECIDER), everything, POLICY), DECIDER);

      const done = await close(CLOSER, { note: 'Đã hoàn thành và có biên bản bàn giao.', evidenceDocumentVersionIds: [VERSION_A] });
      expect(done).toMatchObject({ status: 'DONE', storedStatus: 'DONE' });
      expect(await stored(directive.id)).toMatchObject({ status: 'DONE', closed_by: memberId(CLOSER) });
      expect(await refusal(close(CLOSER, { note: 'Lần nữa.', evidenceDocumentVersionIds: [VERSION_A] }, done.version))).toMatchObject({ code: 'DIRECTIVE_STATE_INVALID', status: 409 });
      expect((await events(directive.id)).at(-1)).toMatchObject({ event_type: 'CLOSED', actor_id: memberId(CLOSER), note: 'Đã hoàn thành và có biên bản bàn giao.' });
    });

    it('counts the evidence already kept: a directive with a document closes without a new one, and a policy that does not ask for evidence closes without any', async () => {
      const held = await meeting();
      const withEvidence = (await given(held.id, { dueOn: DAY(10) })).directive;
      const noted = await as((tx) => store.recordProgress(tx, withEvidence.id, { note: 'Có biên bản.', evidenceDocumentVersionIds: [VERSION_B] }, memberId(ASSIGNEE), everything), ASSIGNEE);
      const closed = await as((tx) => store.close(tx, withEvidence.id, noted.version, { note: 'Đã xong.' }, memberId(CLOSER), everything, POLICY), CLOSER);
      expect(closed.status).toBe('DONE');
      const plain = (await given(held.id, { dueOn: DAY(10) })).directive;
      const relaxed = await as((tx) => store.close(tx, plain.id, plain.version, { note: 'Đã xong, không cần tài liệu.' }, memberId(CLOSER), everything, { ...POLICY, closeRequiresEvidence: false }), CLOSER);
      expect(relaxed.status).toBe('DONE');
    });

    it('cancels with a reason and reopens a done directive to in progress and a cancelled one to open, clearing who ended it; an open directive is not reopened', async () => {
      const held = await meeting();
      const first = (await given(held.id, { dueOn: DAY(10) })).directive;
      expect(await refusal(as((tx) => store.reopen(tx, first.id, 1, 'Mở lại.', memberId(SECRETARY), everything)))).toMatchObject({ code: 'DIRECTIVE_STATE_INVALID' });
      const cancelled = await as((tx) => store.cancel(tx, first.id, 1, 'Dự án đã dừng.', memberId(SECRETARY), everything));
      expect(cancelled).toMatchObject({ status: 'CANCELLED', version: 2 });
      expect(await stored(first.id)).toMatchObject({ status: 'CANCELLED', closed_by: memberId(SECRETARY) });
      const reopened = await as((tx) => store.reopen(tx, first.id, 2, 'Dự án tiếp tục.', memberId(SECRETARY), everything));
      expect(reopened).toMatchObject({ status: 'OPEN', version: 3 });
      expect(await stored(first.id)).toMatchObject({ status: 'OPEN', closed_by: null });

      const second = (await given(held.id, { dueOn: DAY(10) })).directive;
      const closed = await as((tx) => store.close(tx, second.id, 1, { note: 'Xong.', evidenceDocumentVersionIds: [VERSION_A] }, memberId(CLOSER), everything, POLICY), CLOSER);
      const again = await as((tx) => store.reopen(tx, second.id, closed.version, 'Chưa đạt, làm lại.', memberId(SECRETARY), everything));
      expect(again.status).toBe('IN_PROGRESS');
      expect(await refusal(as((tx) => store.reopen(tx, second.id, again.version, 'Lần nữa.', memberId(SECRETARY), everything)))).toMatchObject({ code: 'DIRECTIVE_STATE_INVALID' });
    });
  });

  describe('what the database holds to', () => {
    it('refuses to close by the person who recorded it, to end a directive without who and when, to change what it is about, to keep its version, and to edit or remove the timeline or the evidence', async () => {
      const held = await meeting();
      const { directive } = await given(held.id, { dueOn: DAY(10) });
      expect(await databaseRefusal(owner("update machvon.directive set status = 'DONE', closed_by = created_by, closed_at = now(), version = version + 1 where id = $1::uuid", [directive.id]))).toMatch(/directive_closer_chk/);
      expect(await databaseRefusal(owner("update machvon.directive set status = 'CANCELLED', version = version + 1 where id = $1::uuid", [directive.id]))).toMatch(/directive_ended_chk/);
      expect(await databaseRefusal(owner("update machvon.directive set directive_text = 'Đổi nội dung', version = version + 1 where id = $1::uuid", [directive.id]))).toMatch(/never change/);
      expect(await databaseRefusal(owner('update machvon.directive set original_due_on = original_due_on - 1, due_on = due_on, version = version + 1 where id = $1::uuid', [directive.id]))).toMatch(/never change|directive_due_chk/);
      expect(await databaseRefusal(owner('update machvon.directive set updated_at = now() where id = $1::uuid', [directive.id]))).toMatch(/moves its version/);
      expect(await databaseRefusal(owner("update machvon.directive set due_on = due_on - 100, version = version + 1 where id = $1::uuid", [directive.id]))).toMatch(/directive_due_chk/);

      const noted = await as((tx) => store.recordProgress(tx, directive.id, { note: 'Có biên bản.', evidenceDocumentVersionIds: [VERSION_A] }, memberId(ASSIGNEE), everything), ASSIGNEE);
      expect(noted.version).toBe(2);
      for (const statement of [
        "update machvon.directive_event set note = 'Sửa' where directive_id = $1::uuid",
        'delete from machvon.directive_event where directive_id = $1::uuid',
        'delete from machvon.directive_evidence where directive_id = $1::uuid',
        "update machvon.directive_evidence set added_by = added_by where directive_id = $1::uuid",
      ]) {
        expect(await databaseRefusal(owner(statement, [directive.id]))).toMatch(/append-only/);
      }
      expect(await databaseRefusal(owner('truncate machvon.directive_evidence'))).toMatch(/append-only/);
      expect(await databaseRefusal(as((tx) => tx.query('delete from machvon.directive where id = $1::uuid', [directive.id])))).toMatch(/permission denied/);
      expect(await databaseRefusal(as((tx) => tx.query('update machvon.directive_event set note = $1', ['Sửa'])))).toMatch(/permission denied/);
      expect(await databaseRefusal(owner("insert into machvon.directive_event (tenant_id, directive_id, event_type, actor_id, directive_version) values (current_setting('app.tenant_id')::uuid, $1::uuid, 'PROGRESS', $2::uuid, 9)", [directive.id, memberId(SECRETARY)]))).toMatch(/directive_event_shape_chk/);
    });

    it('keeps the tenants apart: a row of one tenant is not seen by another', async () => {
      const held = await meeting();
      await given(held.id, { dueOn: DAY(10) });
      const rows = await harness.owner<{ n: string }>(id(FAMILY, 99), [['select count(*)::text as n from machvon.directive', []]]);
      expect(rows[0]?.n).toBe('0');
    });
  });

  describe('reading', () => {
    const today = TODAY;
    const list = (filter: DirectiveFilter, scope: ScopeBuilder = everything, limit = 200, after?: { rank: number; dueOn: string; id: string }) => as((tx) => store.list(tx, scope, filter, { limit, after }, today, POLICY));

    it('leads with what is late, then the nearest day, pages without losing a line, and narrows by status, meeting, project, unit, person, days and words', async () => {
      const held = await meeting('2026-10-01');
      const late = (await given(held.id, { dueOn: '2026-11-03', text: 'Chỉ đạo quá hạn về giải phóng mặt bằng.' })).directive;
      const soon = (await given(held.id, { dueOn: '2026-11-10', text: 'Chỉ đạo sắp đến hạn về nghiệm thu.' })).directive;
      const later = (await given(held.id, { dueOn: '2026-12-20', projectId: OTHER_PROJECT, assigneeUnit: ROOT, assignee: null, text: 'Chỉ đạo xa về quyết toán.' })).directive;
      const finished = (await given(held.id, { dueOn: '2026-10-05', text: 'Chỉ đạo đã xong.' })).directive;
      await as((tx) => store.close(tx, finished.id, 1, { note: 'Xong.', evidenceDocumentVersionIds: [VERSION_A] }, memberId(CLOSER), everything, POLICY), CLOSER);

      const mine = (await list({ meetingId: held.id })).map((line) => line.id);
      expect(mine).toEqual([late.id, soon.id, later.id, finished.id]);
      const overdueFirst = await list({ meetingId: held.id });
      expect(overdueFirst[0]).toMatchObject({ code: late.code, clock: { status: 'OVERDUE', phase: 'OVERDUE', overdueDays: 5 } });

      // Pages of two: the cursor goes on from the last line, and the finished one is last.
      const firstPage = await list({ meetingId: held.id }, everything, 2);
      expect(firstPage.map((line) => line.id)).toEqual([late.id, soon.id]);
      const anchor = store.anchorOf(firstPage[1] as (typeof firstPage)[number], today);
      expect(anchor).toEqual({ rank: 1, dueOn: '2026-11-10', id: soon.id });
      expect((await list({ meetingId: held.id }, everything, 2, anchor)).map((line) => line.id)).toEqual([later.id, finished.id]);

      expect((await list({ meetingId: held.id, status: 'OVERDUE' })).map((line) => line.id)).toEqual([late.id]);
      expect((await list({ meetingId: held.id, status: 'OPEN' })).map((line) => line.id)).toEqual([soon.id, later.id]);
      expect((await list({ meetingId: held.id, status: 'DONE' })).map((line) => line.id)).toEqual([finished.id]);
      expect((await list({ meetingId: held.id, overdue: true })).map((line) => line.id)).toEqual([late.id]);
      expect((await list({ meetingId: held.id, projectId: OTHER_PROJECT })).map((line) => line.id)).toEqual([later.id]);
      expect((await list({ meetingId: held.id, unitId: unitId(ROOT) })).map((line) => line.id).sort()).toEqual([...[late.id, soon.id, later.id, finished.id]].sort());
      expect((await list({ meetingId: held.id, unitId: unitId(BQL1) })).map((line) => line.id)).toEqual([late.id, soon.id, finished.id]);
      expect((await list({ meetingId: held.id, assigneeMembershipId: memberId(ASSIGNEE) })).length).toBe(3);
      expect((await list({ meetingId: held.id, dueFrom: '2026-11-05', dueTo: '2026-12-31' })).map((line) => line.id)).toEqual([soon.id, later.id]);
      expect((await list({ meetingId: held.id, q: 'nghiệm thu' })).map((line) => line.id)).toEqual([soon.id]);
      expect((await list({ meetingId: held.id, q: '100%_' })).length).toBe(0);
      expect(await refusal(list({ status: 'LATE' as never }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'status' });
      expect(await refusal(list({ dueFrom: '2026-13-01' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'due_from' });

      // The scope: a person who reaches only one project, or only the unit that must do it, sees only theirs; one who reaches nothing sees nothing.
      expect((await list({ meetingId: held.id }, onProject(OTHER_PROJECT))).map((line) => line.id)).toEqual([later.id]);
      expect((await list({ meetingId: held.id }, onAssigneeUnit(unitId(BQL1)))).map((line) => line.id)).toEqual([late.id, soon.id, finished.id]);
      expect(await list({ meetingId: held.id }, nothing)).toEqual([]);
    });

    it('reads one directive with its timeline, requests and evidence, and not one outside the scope', async () => {
      const held = await meeting();
      const { directive } = await given(held.id, { dueOn: DAY(10) });
      await as((tx) => store.recordProgress(tx, directive.id, { note: 'Có biên bản.', progressPct: 40, evidenceDocumentVersionIds: [VERSION_A] }, memberId(ASSIGNEE), everything), ASSIGNEE);
      const asked = await as((tx) => store.requestExtension(tx, directive.id, { proposedDueOn: DAY(30), reason: 'Chờ ý kiến.' }, memberId(ASSIGNEE), everything, POLICY), ASSIGNEE);
      const detail = await as((tx) => store.detail(tx, directive.id, everything, TODAY, POLICY));
      expect(detail?.directive).toMatchObject({ code: directive.code, storedStatus: 'IN_PROGRESS', evidenceCount: 1, openExtension: { id: asked.extensionId, proposedDueOn: DAY(30), requestedBy: memberId(ASSIGNEE) }, createdBy: { membershipId: memberId(SECRETARY), displayName: `User ${SECRETARY}` }, assignee: { displayName: `User ${ASSIGNEE}` } });
      expect(detail?.events.map((event) => event.type)).toEqual(['CREATED', 'PROGRESS', 'EXTENSION_REQUESTED']);
      expect(detail?.events[1]).toMatchObject({ note: 'Có biên bản.', progressPct: 40, actor: { displayName: `User ${ASSIGNEE}` } });
      expect(detail?.events[2]).toMatchObject({ fromDueOn: DAY(10), toDueOn: DAY(30) });
      expect(detail?.extensions).toHaveLength(1);
      expect(detail?.evidence).toMatchObject([{ documentVersionId: VERSION_A, title: 'Biên bản giao ban' }]);
      expect(await as((tx) => store.detail(tx, directive.id, nothing, TODAY, POLICY))).toBeUndefined();
      expect(await as((tx) => store.detail(tx, randomUUID(), everything, TODAY, POLICY))).toBeUndefined();
    });

    it('counts the directives of the scope by the status a reader sees, those due soon and those escalated, and by unit; the counts are the sum of the list', async () => {
      const summary = await as((tx) => store.summary(tx, everything, {}, TODAY, POLICY));
      const all = await list({});
      expect(summary.total).toBe(all.length);
      const byStatus = { OPEN: 0, IN_PROGRESS: 0, DONE: 0, OVERDUE: 0, CANCELLED: 0 };
      for (const line of all) byStatus[line.clock.status] += 1;
      expect(summary.byStatus).toEqual(byStatus);
      expect(summary.dueSoon).toBe(all.filter((line) => line.clock.phase === 'DUE_SOON' || line.clock.phase === 'DUE_TODAY').length);
      expect(summary.escalated).toBe(all.filter((line) => line.clock.phase === 'ESCALATED').length);
      expect(summary.byUnit.reduce((sum, row) => sum + row.total, 0)).toBe(summary.total);
      expect(summary.byUnit[0]?.overdue).toBeGreaterThanOrEqual(summary.byUnit[summary.byUnit.length - 1]?.overdue ?? 0);
      expect(summary.truncated).toBe(false);
      expect((await as((tx) => store.summary(tx, nothing, {}, TODAY, POLICY))).total).toBe(0);
      const onlyProject = await as((tx) => store.summary(tx, everything, { projectId: OTHER_PROJECT }, TODAY, POLICY));
      expect(onlyProject.total).toBe((await list({ projectId: OTHER_PROJECT })).length);
    });

    it('lists the meetings the latest first with the counts of their directives, and gives the directives of a meeting that the caller reaches', async () => {
      const held = await meeting('2026-10-20');
      await given(held.id, { dueOn: '2026-11-01' });
      await given(held.id, { dueOn: '2026-12-01', assignee: null });
      const meetings = await as((tx) => store.listMeetings(tx, everything, {}, { limit: 100, after: undefined }, TODAY));
      expect((meetings[0]?.meetingDate ?? '') >= (meetings[1]?.meetingDate ?? '')).toBe(true);
      const found = meetings.find((line) => line.id === held.id);
      expect(found).toMatchObject({ code: held.code, counts: { total: 2, byStatus: { OVERDUE: 1, OPEN: 1 } } });
      expect((await as((tx) => store.listMeetings(tx, everything, { meetingType: 'MONTHLY' }, { limit: 100, after: undefined }, TODAY))).every((line) => line.meetingType === 'MONTHLY')).toBe(true);
      expect((await as((tx) => store.listMeetings(tx, everything, { from: '2026-10-20', to: '2026-10-20' }, { limit: 100, after: undefined }, TODAY))).map((line) => line.id)).toContain(held.id);
      expect(await as((tx) => store.listMeetings(tx, nothing, {}, { limit: 100, after: undefined }, TODAY))).toEqual([]);
      const detail = await as((tx) => store.meetingDetail(tx, held.id, everything, everything, TODAY, POLICY));
      expect(detail?.directives.map((line) => line.seq)).toEqual([1, 2]);
      // A person who reaches only the unit that must do the directives reaches the meeting through them, and sees the directives they reach.
      const throughDirective: ScopeBuilder = (first) => ({ sql: `(false or exists (select 1 from machvon.directive d2 join machvon.organization_unit au2 on au2.tenant_id = d2.tenant_id and au2.id = d2.assignee_unit_id where d2.tenant_id = m.tenant_id and d2.meeting_id = m.id and au2.id = $${first}::uuid))`, params: [unitId(BQL1)] });
      expect((await as((tx) => store.meetingDetail(tx, held.id, throughDirective, onAssigneeUnit(unitId(BQL1)), TODAY, POLICY)))?.directives).toHaveLength(2);
      expect(await as((tx) => store.meetingDetail(tx, held.id, nothing, everything, TODAY, POLICY))).toBeUndefined();
    });
  });

  describe('the directives of a period for the next report (BR-DIR-07)', () => {
    it('replays each directive to the last day of the period, counts what was raised, closed, extended, open and overdue at its end, and leaves out what ended before it', async () => {
      const from = DAY(-30, REAL_TODAY);
      const to = REAL_TODAY;
      const held = await meeting(DAY(-20, REAL_TODAY), REAL_TODAY);
      const stillOpen = (await given(held.id, { dueOn: DAY(-5, REAL_TODAY) })).directive;
      const inProgress = (await given(held.id, { dueOn: DAY(10, REAL_TODAY) })).directive;
      await as((tx) => store.recordProgress(tx, inProgress.id, { note: 'Đang xử lý hồ sơ pháp lý.' }, memberId(ASSIGNEE), everything), ASSIGNEE);
      const closed = (await given(held.id, { dueOn: DAY(5, REAL_TODAY) })).directive;
      await as((tx) => store.close(tx, closed.id, 1, { note: 'Đã bàn giao.', evidenceDocumentVersionIds: [VERSION_A] }, memberId(CLOSER), everything, POLICY), CLOSER);
      const extended = (await given(held.id, { dueOn: DAY(-1, REAL_TODAY) })).directive;
      const asked = await as((tx) => store.requestExtension(tx, extended.id, { proposedDueOn: DAY(14, REAL_TODAY), reason: 'Chờ quyết định của UBND.' }, memberId(ASSIGNEE), everything, POLICY), ASSIGNEE);
      await as((tx) => store.decideExtension(tx, asked.extensionId as string, 1, { decision: 'approve', reason: 'Hợp lý.' }, memberId(DECIDER), everything, POLICY), DECIDER);
      const cancelled = (await given(held.id, { dueOn: DAY(8, REAL_TODAY) })).directive;
      await as((tx) => store.cancel(tx, cancelled.id, 1, 'Không còn cần.', memberId(SECRETARY), everything));

      const report = await as((tx) => store.forReport(tx, everything, { from, to }, { projectId: PROJECT }));
      const mine = report.items.filter((item) => item.meeting.id === held.id);
      expect(mine.map((item) => [item.code, item.statusAtEnd])).toEqual(
        expect.arrayContaining([
          [stillOpen.code, 'OVERDUE'],
          [inProgress.code, 'IN_PROGRESS'],
          [closed.code, 'DONE'],
          [extended.code, 'OPEN'],
          [cancelled.code, 'CANCELLED'],
        ]),
      );
      const itemOf = (code: string) => mine.find((item) => item.code === code);
      expect(itemOf(inProgress.code)).toMatchObject({ lastNote: 'Đang xử lý hồ sơ pháp lý.', facts: { raisedInPeriod: true, openAtEnd: true } });
      expect(itemOf(closed.code)?.facts).toMatchObject({ closedInPeriod: true, openAtEnd: false });
      expect(itemOf(extended.code)).toMatchObject({ dueOnAtEnd: DAY(14, REAL_TODAY), facts: { extendedInPeriod: true } });
      expect(itemOf(stillOpen.code)?.dueOnAtEnd).toBe(DAY(-5, REAL_TODAY));
      // The counts are those of the list.
      expect(report.counts.total).toBe(report.items.length);
      expect(report.counts.overdueAtEnd).toBe(report.items.filter((item) => item.statusAtEnd === 'OVERDUE').length);
      expect(report.counts.openAtEnd).toBe(report.items.filter((item) => item.facts.openAtEnd).length);
      expect(report.counts.byStatus.DONE).toBeGreaterThanOrEqual(1);
      expect(report.truncated).toBe(false);

      // A period that closed before the meeting does not contain it; one that begins after the directive ended and had no event in it leaves it out.
      const before = await as((tx) => store.forReport(tx, everything, { from: DAY(-60, REAL_TODAY), to: DAY(-40, REAL_TODAY) }, { projectId: PROJECT }));
      expect(before.items.some((item) => item.meeting.id === held.id)).toBe(false);
      const after = await as((tx) => store.forReport(tx, everything, { from: DAY(2, REAL_TODAY), to: DAY(30, REAL_TODAY) }, { projectId: PROJECT }));
      const afterItems = after.items.filter((item) => item.meeting.id === held.id).map((item) => item.code);
      expect(afterItems).toEqual(expect.arrayContaining([stillOpen.code, inProgress.code]));
      expect(afterItems).not.toContain(closed.code);
      expect(afterItems).not.toContain(cancelled.code);
      expect(await as((tx) => store.forReport(tx, nothing, { from, to }))).toMatchObject({ counts: { total: 0 }, items: [] });
      expect(await refusal(as((tx) => store.forReport(tx, everything, { from: to, to: from })))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'to' });
      expect(await refusal(as((tx) => store.forReport(tx, everything, { from: 'x', to })))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'from' });
    });
  });

  describe('the alert centre source DIRECTIVE', () => {
    const source = new HomeDirectiveSources();

    async function clockCases(): Promise<Record<string, string>> {
      const held = await meeting('2026-10-01');
      const cases: Record<string, string> = {};
      const make = async (key: string, dueOn: string, assignee: number | null, options: { assigneeUnit?: number } = {}) => {
        cases[key] = (await given(held.id, { dueOn, assignee, text: `Chỉ đạo ${key}`, ...options })).directive.id;
      };
      await make('later', DAY(4), ASSIGNEE);
      await make('soon', DAY(3), ASSIGNEE);
      await make('tomorrow', DAY(1), ASSIGNEE);
      await make('today', DAY(0), ASSIGNEE);
      await make('late', DAY(-1), ASSIGNEE);
      await make('week', DAY(-7), ASSIGNEE);
      await make('unit', DAY(-8), null, { assigneeUnit: ROOT });
      await make('other', DAY(-2), HEAD);
      return cases;
    }
    let cases: Record<string, string> = {};

    beforeAll(async () => {
      cases = await clockCases();
    });

    it('shows a directive from the earliest reminder day, to be acted on, and not one that is further away', async () => {
      const rows = await as((tx) => source.items(sourceContext(tx, 'scope', ASSIGNEE)));
      const mine = (key: string) => rows.find((row) => row.id === cases[key]);
      expect(mine('later')).toBeUndefined();
      expect(mine('soon')).toMatchObject({ kind: 'DIRECTIVE_DUE', source: 'DIRECTIVE', severity: 'ACTION', status: 'OPEN', dueOn: DAY(3), escalation: null, target: { screen: 'DIR-04', id: cases.soon }, lifecycle: 'NEW' });
      expect(mine('tomorrow')).toMatchObject({ kind: 'DIRECTIVE_DUE', severity: 'ACTION' });
      expect(mine('today')).toMatchObject({ kind: 'DIRECTIVE_DUE', severity: 'ACTION', title: expect.stringContaining('hôm nay') });
      expect(mine('soon')?.consequence).toContain('sắp đến hạn');
    });

    it('is overdue and to be acted on from the day after, urgent from the escalation day with the head of the unit named, and has the consequence of each', async () => {
      const rows = await as((tx) => source.items(sourceContext(tx, 'scope', ASSIGNEE)));
      const mine = (key: string) => rows.find((row) => row.id === cases[key]);
      expect(mine('late')).toMatchObject({ kind: 'DIRECTIVE_OVERDUE', severity: 'ACTION', status: 'OVERDUE', escalation: { level: 1, of: 2, nextAt: DAY(6), chain: ['Người thực hiện', 'Lãnh đạo đơn vị'] } });
      expect(mine('week')).toMatchObject({ kind: 'DIRECTIVE_OVERDUE', severity: 'URGENT', escalation: { level: 2, of: 2, nextAt: null } });
      expect(mine('unit')).toMatchObject({ severity: 'URGENT' });
      expect(mine('late')?.consequence).toContain('quá hạn');
      expect(mine('week')?.consequence).toContain('lãnh đạo đơn vị');
      expect(rows.every((row) => row.source === 'DIRECTIVE')).toBe(true);
    });

    it('is the work of the person it is given to; the head of the unit sees it as theirs only when it is escalated', async () => {
      // The person the directive is given to: theirs, escalated or not; not the one given to someone else.
      const assigneeRows = await as((tx) => source.items(sourceContext(tx, 'mine', ASSIGNEE, nothing, everything)), ASSIGNEE);
      const assigneeIds = new Set(assigneeRows.map((row) => row.id));
      expect(assigneeIds.has(cases.soon as string)).toBe(true);
      expect(assigneeIds.has(cases.week as string)).toBe(true);
      expect(assigneeIds.has(cases.other as string)).toBe(false);
      expect(assigneeIds.has(cases.unit as string)).toBe(false);
      // The head reaches the units by their scope: only what is escalated is theirs, and what was given to them.
      const headRows = await as((tx) => source.items(sourceContext(tx, 'mine', HEAD, everything, nothing)), HEAD);
      const headIds = new Set(headRows.map((row) => row.id));
      expect(headIds.has(cases.other as string)).toBe(true);
      expect(headIds.has(cases.week as string)).toBe(true);
      expect(headIds.has(cases.unit as string)).toBe(true);
      expect(headIds.has(cases.soon as string)).toBe(false);
      expect(headIds.has(cases.late as string)).toBe(false);
      // Nobody who reaches nothing sees any.
      expect(await as((tx) => source.items(sourceContext(tx, 'scope', ASSIGNEE, nothing, nothing)))).toEqual([]);
    });

    it('drops a directive once it is done or cancelled, and follows the extension that moved its day', async () => {
      const toClose = cases.late as string;
      await as((tx) => store.close(tx, toClose, 1, { note: 'Xong.', evidenceDocumentVersionIds: [VERSION_A] }, memberId(CLOSER), everything, POLICY), CLOSER);
      const afterClose = await as((tx) => source.items(sourceContext(tx, 'scope', ASSIGNEE)));
      expect(afterClose.some((row) => row.id === toClose)).toBe(false);
      const asked = await as((tx) => store.requestExtension(tx, cases.week as string, { proposedDueOn: DAY(10), reason: 'Chờ quyết định.' }, memberId(ASSIGNEE), everything, POLICY), ASSIGNEE);
      await as((tx) => store.decideExtension(tx, asked.extensionId as string, 1, { decision: 'approve', reason: 'Đồng ý.' }, memberId(DECIDER), everything, POLICY), DECIDER);
      const afterExtension = await as((tx) => source.items(sourceContext(tx, 'scope', ASSIGNEE)));
      expect(afterExtension.some((row) => row.id === cases.week)).toBe(false);
    });
  });
});
