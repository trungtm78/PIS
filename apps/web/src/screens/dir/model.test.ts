import { describe, expect, it } from 'vitest';
import {
  BOARD_ORDER,
  NO_FILTER,
  addDays,
  appliedCount,
  asOfText,
  can,
  columnsOf,
  daysBetween,
  dayText,
  defaultPeriod,
  extensionProblem,
  idFrom,
  isDay,
  narrowsBeyondSummary,
  parseIds,
  phaseTone,
  queryOf,
  statusTone,
  toDirective,
  toDirectiveDetail,
  toDirectivePage,
  toLookup,
  toMeeting,
  toMeetingDetail,
  toMeetingPage,
  toPolicy,
  toReport,
  toSummary,
  toWidget,
  vietnamDay,
} from './model';
import type { Policy } from './model';
import { directive, meeting, overdueDirective, page, summary } from './test-support';

const POLICY: Policy = { code: 'DEFAULT', version: null, source: 'DEFAULT', unverified: true, reminderDaysBefore: [3, 1, 0], escalateAfterOverdueDays: 7, maxExtensions: 3, maxExtensionDays: 60, closeRequiresEvidence: true };

describe('the parsers of the directives', () => {
  it('reads a directive with its clock, assignee, open extension and who recorded it', () => {
    const line = toDirective(directive(1, { open_extension: { id: 'e1', proposed_due_on: '2026-12-01', requested_by: 'u1', version: 2 } }));
    expect(line).toMatchObject({ code: 'GB-2026-001/CD-01', status: 'OPEN', phase: 'DUE_LATER', daysToDue: 12, dueOn: '2026-11-20', scopeKind: 'PROJECT', assignee: { displayName: 'Nguyễn Văn A' }, createdBy: { displayName: 'Trần Thị B' }, openExtension: { id: 'e1', version: 2 } });
    expect(line?.project).toMatchObject({ code: 'DA-01' });
  });

  it('drops what is not a directive: no id, or a status this build does not know', () => {
    expect(toDirective(null)).toBeUndefined();
    expect(toDirective({ ...directive(1), id: '' })).toBeUndefined();
    expect(toDirective({ ...directive(1), status: 'LATE' })).toBeUndefined();
    expect(toDirectivePage({ items: [directive(1), { id: 'x' }, 7], next_cursor: 'c', as_of: 'a' })).toMatchObject({ items: [{ code: 'GB-2026-001/CD-01' }], nextCursor: 'c', asOf: 'a' });
    expect(toDirectivePage(page([], null)).nextCursor).toBeUndefined();
    expect(toDirectivePage('nothing').items).toEqual([]);
  });

  it('reads a directive about a unit, an unknown phase as the one before the reminders, and an unknown meeting type as other', () => {
    expect(toDirective(directive(1, { scope_kind: 'UNIT', project: null, phase: 'WHENEVER' }))).toMatchObject({ scopeKind: 'UNIT', project: null, phase: 'DUE_LATER' });
    expect(toMeeting(meeting(1, { meeting_type: 'DAILY' }))?.meetingType).toBe('OTHER');
  });

  it('reads a meeting with its counts by every status, 0 where the server left one out', () => {
    expect(toMeeting(meeting(1, { counts: { total: 2, by_status: { OPEN: 2 } } }))).toMatchObject({ total: 2, byStatus: { OPEN: 2, DONE: 0, OVERDUE: 0, IN_PROGRESS: 0, CANCELLED: 0 } });
    expect(toMeeting({ code: 'x' })).toBeUndefined();
    expect(toMeetingPage(page([meeting(1), meeting(2)], 'next'))).toMatchObject({ items: [{ code: 'GB-2026-001' }, { code: 'GB-2026-002' }], nextCursor: 'next' });
  });

  it('reads the detail of a meeting and refuses an answer without the meeting', () => {
    const detail = toMeetingDetail({ meeting: meeting(1), directives: [directive(1), directive(2)], truncated: true, actions: { add_directive: true, attach_minutes: false }, policy: {}, as_of: 'a' });
    expect(detail).toMatchObject({ truncated: true, actions: { addDirective: true, attachMinutes: false }, directives: [{ seq: 1 }, { seq: 2 }], asOf: 'a' });
    expect(detail?.policy).toMatchObject({ code: 'DEFAULT', unverified: true, reminderDaysBefore: [] });
    expect(toMeetingDetail({ directives: [] })).toBeUndefined();
    expect(toMeetingDetail(3)).toBeUndefined();
  });

  it('reads the detail of a directive: timeline, extensions, evidence and the buttons', () => {
    const detail = toDirectiveDetail({
      directive: directive(1),
      timeline: [{ id: 'ev1', type: 'PROGRESS', actor: { membership_id: 'm', display_name: 'An' }, occurred_at: 'x', note: 'ghi chú', progress_pct: 40, from_assignee_unit: null, to_assignee_unit: { id: 'u', code: 'U', name: 'N' }, approver: null }],
      extensions: [{ id: 'x1', from_due_on: '2026-11-20', proposed_due_on: '2026-12-01', reason: 'chờ', status: 'REQUESTED', requested_by: { membership_id: 'm', display_name: 'An' }, version: 1 }],
      evidence: [{ id: 'd1', document_version_id: 'v1', title: null, added_by: { membership_id: 'm', display_name: 'An' }, added_at: 'x' }],
      policy: POLICY && { code: 'DEFAULT', unverified: false, reminder_days_before: [3, 1, 0], max_extensions: 2, max_extension_days: 30, escalate_after_overdue_days: 5, close_requires_evidence: false },
      actions: { assign: true, record_progress: true, request_extension: false, decide_extension: true, close: false, cancel: true, reopen: false },
      as_of: 'a',
    });
    expect(detail).toMatchObject({
      timeline: [{ type: 'PROGRESS', progressPct: 40, note: 'ghi chú', toAssigneeUnit: { code: 'U' }, fromAssigneeUnit: null }],
      extensions: [{ status: 'REQUESTED', requestedBy: { displayName: 'An' }, decidedBy: null }],
      evidence: [{ documentVersionId: 'v1', title: null }],
      policy: { maxExtensions: 2, unverified: false, closeRequiresEvidence: false },
      actions: { assign: true, recordProgress: true, requestExtension: false, decideExtension: true, close: false, cancel: true, reopen: false },
    });
    expect(toDirectiveDetail({ timeline: [] })).toBeUndefined();
  });

  it('reads the summary with every status and each unit; an answer without a total is not a summary', () => {
    expect(toSummary(summary)).toMatchObject({ total: 9, byStatus: { OVERDUE: 2, OPEN: 3 }, dueSoon: 2, escalated: 1, byUnit: [{ unit: { code: 'BQL1' }, overdue: 2 }, { unit: { code: 'SXD' }, total: 3 }], definitions: { escalated: expect.any(String) }, policy: { reminderDaysBefore: [3, 1, 0] } });
    expect(toSummary({ by_status: {} })).toBeUndefined();
  });

  it('reads the report of a period, dropping the lines it cannot understand', () => {
    const report = toReport({
      period: { from: '2026-10-01', to: '2026-10-31' },
      counts: { total: 2, raised: 1, closed: 1, extended: 0, open_at_end: 1, overdue_at_end: 1, by_status: { OVERDUE: 1, DONE: 1 } },
      items: [
        { id: 'a', code: 'C1', meeting: { id: 'm', code: 'GB', meeting_date: '2026-10-01' }, scope_kind: 'UNIT', project: null, text: 't', assignee_unit: { id: 'u', code: 'U', name: 'N' }, due_on_at_end: '2026-10-20', status_at_end: 'OVERDUE', raised_in_period: true, closed_in_period: false, extended_in_period: false, open_at_end: true, last_note: 'n', last_note_on: '2026-10-05' },
        { id: 'b', status_at_end: 'LATE' },
        { status_at_end: 'DONE' },
      ],
      truncated: false,
      definitions: { raised: 'giao', n: 3 },
      as_of: 'a',
    });
    expect(report).toMatchObject({ from: '2026-10-01', counts: { total: 2, openAtEnd: 1, overdueAtEnd: 1, byStatus: { DONE: 1, OVERDUE: 1, OPEN: 0 } }, items: [{ code: 'C1', statusAtEnd: 'OVERDUE', openAtEnd: true, lastNote: 'n' }], definitions: { raised: 'giao' } });
    expect(report?.items).toHaveLength(1);
    expect(toReport({ counts: {} })).toBeUndefined();
  });

  it('reads the widget and the policy as the server gives them, an unconfirmed policy being the default to assume', () => {
    expect(toWidget({ counts: { overdue: 2, due_soon: 1, escalated: 1, open: 5 }, items: [overdueDirective(1)], truncated: false, definitions: {}, policy: {}, as_of: 'a' })).toMatchObject({ counts: { overdue: 2, dueSoon: 1, escalated: 1, open: 5 }, items: [{ status: 'OVERDUE', overdueDays: 5 }] });
    expect(toWidget({})).toBeUndefined();
    expect(toPolicy(undefined)).toMatchObject({ unverified: true, source: 'DEFAULT', code: 'DEFAULT' });
    expect(toPolicy({ source: 'RULE', version: 3, unverified: false })).toMatchObject({ source: 'RULE', version: 3, unverified: false });
  });

  it('keeps the rows of a lookup that have an id and a name', () => {
    expect(toLookup({ id: 'u', code: 'BQL1', name: 'Ban 1' }, 'unit')).toEqual([{ id: 'u', label: 'BQL1 · Ban 1' }]);
    expect(toLookup({ id: 'm', display_name: 'An' }, 'member')).toEqual([{ id: 'm', label: 'An' }]);
    expect(toLookup({ id: 'm' }, 'member')).toEqual([]);
    expect(toLookup({ code: 'x' }, 'project')).toEqual([]);
    expect(toLookup(null, 'unit')).toEqual([]);
  });
});

describe('the small rules', () => {
  it('knows the shape of an id, a real day and the text of a day and of a time', () => {
    expect(idFrom('00000000-0000-4000-8000-0000000000AA')).toBe('00000000-0000-4000-8000-0000000000aa');
    expect(idFrom('x')).toBeUndefined();
    expect(idFrom(null)).toBeUndefined();
    expect(isDay('2026-02-28')).toBe(true);
    expect(isDay('2026-02-30')).toBe(false);
    expect(isDay('')).toBe(false);
    expect(dayText('2026-11-08')).toBe('08/11/2026');
    expect(dayText(null)).toBe('');
    expect(dayText('hôm nay')).toBe('hôm nay');
    expect(asOfText('2026-11-08T03:05:00.000Z')).toBe('10:05 08/11/2026');
    expect(asOfText('2026-11-10T00:08:00.000Z')).toBe('07:08 10/11/2026');
    expect(asOfText('2026-11-08T20:30:00Z')).toBe('03:30 09/11/2026');
    expect(asOfText('2026-11-08T10:05:00+07:00')).toBe('10:05 08/11/2026');
    expect(asOfText('2026-11-08T10:05:00')).toBe('10:05 08/11/2026');
    expect(asOfText('x')).toBe('x');
  });

  it('counts days and the Vietnam day of an instant', () => {
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
    expect(daysBetween('2026-11-08', '2026-11-20')).toBe(12);
    expect(vietnamDay(new Date('2026-11-08T18:00:00Z'))).toBe('2026-11-09');
    expect(defaultPeriod('2026-11-08')).toEqual({ from: '2026-10-09', to: '2026-11-08' });
  });

  it('puts the late column first on the board and shows only the column a status filter names', () => {
    expect(BOARD_ORDER[0]).toBe('OVERDUE');
    expect(columnsOf(NO_FILTER)).toEqual(BOARD_ORDER);
    expect(columnsOf({ ...NO_FILTER, status: 'DONE' })).toEqual(['DONE']);
  });

  it('builds the query from what is set and counts what is applied', () => {
    expect(queryOf(NO_FILTER, { limit: 10 })).toEqual({ limit: 10 });
    const filter = { ...NO_FILTER, status: 'OVERDUE' as const, unitId: 'u', projectId: 'p', meetingId: 'm', assignedToMe: true, overdue: true, q: ' mặt bằng ', dueFrom: '2026-11-01', dueTo: '2026-11-30' };
    expect(queryOf(filter, { limit: 5, cursor: 'c' })).toEqual({ limit: 5, cursor: 'c', status: 'OVERDUE', unit_id: 'u', project_id: 'p', meeting_id: 'm', assigned_to_me: true, overdue: true, q: 'mặt bằng', due_from: '2026-11-01', due_to: '2026-11-30' });
    expect(appliedCount(filter)).toBe(9);
    expect(appliedCount(NO_FILTER)).toBe(0);
  });

  it('knows which filters the summary cannot follow', () => {
    expect(narrowsBeyondSummary(NO_FILTER)).toBe(false);
    expect(narrowsBeyondSummary({ ...NO_FILTER, unitId: 'u', projectId: 'p', meetingId: 'm', status: 'OPEN' })).toBe(false);
    for (const change of [{ assignedToMe: true }, { overdue: true }, { q: 'x' }, { dueFrom: '2026-11-01' }, { dueTo: '2026-11-01' }]) expect(narrowsBeyondSummary({ ...NO_FILTER, ...change })).toBe(true);
  });

  it('offers a command to a session that may, never to a read-only one, and to one whose permissions are not known', () => {
    expect(can(['directive.manage'], 'FULL', 'directive.manage')).toBe(true);
    expect(can(['directive.read'], 'FULL', 'directive.manage')).toBe(false);
    expect(can(['directive.manage'], 'READ_ONLY', 'directive.manage')).toBe(false);
    expect(can(undefined, undefined, 'directive.manage')).toBe(true);
  });

  it('reads the ids typed in a field: distinct, lower case, with what is not an id told apart', () => {
    const a = '00000000-0000-4000-8000-00000000000A';
    const b = '00000000-0000-4000-8000-00000000000b';
    expect(parseIds(`${a}, ${b}\n${a.toLowerCase()} oops`)).toEqual({ ids: [a.toLowerCase(), b], invalid: ['oops'] });
    expect(parseIds('  ')).toEqual({ ids: [], invalid: [] });
  });

  it('refuses a proposed day that is no day, not after the due day, too far, or one extension too many', () => {
    expect(extensionProblem('2026-11-20', 'x', POLICY, 0)).toBe('day');
    expect(extensionProblem('2026-11-20', '2026-11-20', POLICY, 0)).toBe('order');
    expect(extensionProblem('2026-11-20', '2027-01-20', POLICY, 0)).toBe('days');
    expect(extensionProblem('2026-11-20', '2026-12-01', POLICY, 3)).toBe('limit');
    expect(extensionProblem('2026-11-20', '2026-12-01', POLICY, 2)).toBeUndefined();
    expect(extensionProblem('2026-11-20', '2026-12-19', POLICY, 0)).toBeUndefined();
  });

  it('gives a status and a phase a tone', () => {
    expect(statusTone('OVERDUE')).toBe('danger');
    expect(statusTone('DONE')).toBe('success');
    expect(statusTone('IN_PROGRESS')).toBe('info');
    expect(statusTone('CANCELLED')).toBe('neutral');
    expect(statusTone('OPEN')).toBe('warning');
    expect(phaseTone('ESCALATED')).toBe('danger');
    expect(phaseTone('DUE_SOON')).toBe('warning');
    expect(phaseTone('ENDED')).toBe('neutral');
  });
});
