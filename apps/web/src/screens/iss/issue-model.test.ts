import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_FILTER,
  EMPTY_FORM,
  actionsOf,
  boardOf,
  describeProblem,
  dueStateOf,
  eventsPageOf,
  filterIssues,
  hasPermission,
  toCreateBody,
  toEvent,
  toIssueLine,
  toIssueView,
  toAssigneeOption,
  toProjectOption,
  validateForm,
  workspaceLink,
} from './issue-model';
import type { IssueForm, IssueLine } from './issue-model';
import { detail, event, issue, member, person, project } from './test-support';

const line = (n: number, overrides: Record<string, unknown> = {}): IssueLine => toIssueLine(issue(n, overrides)) as IssueLine;
const problem = (code: string, detailText?: string) => new ApiError({ status: 422, code, correlationId: 'c', detail: detailText, extensions: {} });

describe('the readers of the issue reads', () => {
  it('reads a line of the list and what a guest does not get', () => {
    expect(line(1, { assignee: person(2), overdue_since: '2026-10-01T02:00:00.000Z', overdue_days: 3, escalation_level: 2, source_module: 'PMT' })).toMatchObject({
      code: 'VM-2026-000001',
      severity: 'HIGH',
      status: 'OPEN',
      assignee: { id: person(2).membership_id, name: person(2).display_name },
      overdueDays: 3,
      escalationLevel: 2,
      sourceModule: 'PMT',
      respondedAt: null,
    });
    const guest = line(2, { assignee: null, reported_by: null, source_ref_id: null });
    expect(guest.assignee).toBeNull();
    expect(guest.reporter).toBeNull();
  });

  it('shows only what it can trust: a line without its identity, severity, status or deadline is left out', () => {
    expect(toIssueLine(null)).toBeUndefined();
    expect(toIssueLine([])).toBeUndefined();
    for (const missing of ['id', 'code', 'title', 'project_id', 'owner_unit_id', 'opened_at', 'response_due_at', 'due_at', 'version']) {
      expect(toIssueLine({ ...issue(1), [missing]: undefined })).toBeUndefined();
    }
    expect(toIssueLine(issue(1, { severity: 'URGENT' }))).toBeUndefined();
    expect(toIssueLine(issue(1, { status: 'DONE' }))).toBeUndefined();
    expect(toIssueLine(issue(1, { source_module: 'XYZ' }))?.sourceModule).toBe('MANUAL');
    expect(toIssueLine(issue(1, { escalation_level: 'x' }))?.escalationLevel).toBe(0);
  });

  it('reads the workspace: the text, the SLA, the position and the timeline, leaving out an event it cannot trust', () => {
    const view = toIssueView(
      detail(1, {
        geo_consent: true,
        geo: { lat: '10.800000', lng: '106.700000', accuracy_m: '60.00', low_accuracy: true },
        events: [event(1, 'CREATED'), { id: 5, kind: 'CREATED' }, event(2, 'TRANSFERRED', { payload: { from_unit_id: 'a', to_unit_id: 'b' }, document_version_id: 'd', note: 'Lý do' })],
      }),
    );
    expect(view).toMatchObject({
      description: expect.stringContaining('bồi thường') as string,
      sla: { policyCode: 'SLA-GPMB-HIGH', policyRevision: 2, responseHours: 4, resolveHours: 72, requireEvidence: true, requireIndependentVerifier: true, calendarCode: 'WORKDAY_VN' },
      geoConsent: true,
      geo: { lat: '10.800000', lng: '106.700000', accuracyM: '60.00', lowAccuracy: true },
    });
    expect(view?.events.map((item) => item.kind)).toEqual(['CREATED', 'TRANSFERRED']);
    expect(view?.events[1]).toMatchObject({ fromUnitId: 'a', toUnitId: 'b', note: 'Lý do', documentAttached: true });
    const bare = toIssueView({ ...detail(2), description: null, sla: null, geo: null, events: undefined });
    expect(bare).toMatchObject({ description: null, sla: null, geo: null, geoConsent: false, events: [] });
    expect(toIssueView(null)).toBeUndefined();
    expect(toIssueView({ ...detail(1), id: undefined })).toBeUndefined();
    expect(toIssueView(detail(1, { sla: { policy_code: 'X' }, geo: { lat: '1' } }))).toMatchObject({ sla: null, geo: null });
  });

  it('reads the extensions, the reopening window and the evidence, the outcome and the dates that an event of the end of an issue carries (ST-ISS-003)', () => {
    const view = toIssueView(
      detail(1, {
        extensions: { used: 1, limit: 2 },
        reopen_window_days: 30,
        events: [
          event(1, 'VERIFICATION_REQUESTED', { payload: { evidence_document_version_ids: ['d1', 7, 'd2'] } }),
          event(2, 'REASSIGNED', { payload: { outcome: 'VERIFICATION_REFUSED' } }),
          event(3, 'EXTENDED', { payload: { previous_due_at: '2026-10-21T10:00:00.000Z', new_due_at: '2026-10-23T10:00:00.000Z' } }),
        ],
      }),
    );
    expect(view).toMatchObject({ extensions: { used: 1, limit: 2 }, reopenWindowDays: 30 });
    expect(view?.events[0]).toMatchObject({ evidenceIds: ['d1', 'd2'], outcome: null, previousDueAt: null });
    expect(view?.events[1]).toMatchObject({ evidenceIds: [], outcome: 'VERIFICATION_REFUSED' });
    expect(view?.events[2]).toMatchObject({ previousDueAt: '2026-10-21T10:00:00.000Z', newDueAt: '2026-10-23T10:00:00.000Z' });
    expect(toIssueView(detail(2, { extensions: undefined, reopen_window_days: undefined }))).toMatchObject({ extensions: { used: 0, limit: 0 }, reopenWindowDays: 0 });
  });

  it('maps the refusals of the end of an issue to the reasons the screens tell', () => {
    const refusal = (code: string) => describeProblem(new ApiError({ status: 422, code, correlationId: 'c', extensions: {} })).reason;
    expect(refusal('EVIDENCE_REQUIRED')).toBe('evidenceRequired');
    expect(refusal('SELF_APPROVAL_DENIED')).toBe('selfApproval');
    expect(refusal('EXTENSION_LIMIT_REACHED')).toBe('extensionLimit');
    expect(refusal('REOPEN_WINDOW_EXPIRED')).toBe('reopenWindow');
  });

  it('reads an event and the page of a timeline with its cursor', () => {
    expect(toEvent(event(1, 'ASSIGNED', { to_assignee: person(2), from_status: 'OPEN', to_status: 'ASSIGNED' }))).toMatchObject({ kind: 'ASSIGNED', toAssignee: { name: person(2).display_name }, fromStatus: 'OPEN' });
    expect(toEvent(event(1, 'EXPLODED'))).toBeUndefined();
    expect(toEvent(null)).toBeUndefined();
    expect(eventsPageOf({ events: [event(1, 'CREATED'), 3], next_cursor: 'abc' })).toMatchObject({ nextCursor: 'abc', events: [{ kind: 'CREATED' }] });
    expect(eventsPageOf(null)).toEqual({ events: [], nextCursor: undefined });
  });

  it('reads the people and the projects of the choices, leaving out those that cannot be chosen', () => {
    expect(toAssigneeOption(member(1))).toEqual([{ id: member(1).membership_id, name: member(1).display_name }]);
    expect(toAssigneeOption(member(3, { display_name: undefined }))[0]?.name).toBe(member(3).membership_id);
    expect(toAssigneeOption({ display_name: 'x' })).toEqual([]);
    expect(toAssigneeOption(null)).toEqual([]);
    expect(toProjectOption(project(1))).toEqual([{ id: project(1).id, code: project(1).code, name: project(1).name }]);
    expect(toProjectOption({ id: 'x' })).toEqual([]);
    expect(toProjectOption(null)).toEqual([]);
  });
});

describe('the board and its filters', () => {
  const lines = [
    line(1, { status: 'OPEN', severity: 'LOW' }),
    line(2, { status: 'ASSIGNED', assignee: person(1), title: 'Giấy phép đã hết hạn', severity: 'HIGH' }),
    line(3, { status: 'IN_PROGRESS', assignee: person(2), overdue_since: '2026-10-01T02:00:00.000Z', severity: 'HIGH' }),
  ];

  it('has a column for every status, in the order of the state machine, so that an empty one is seen to be empty', () => {
    const board = boardOf(lines);
    expect(board.map((column) => column.status)).toEqual(['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ESCALATED', 'PENDING_VERIFICATION', 'CLOSED', 'REOPENED']);
    expect(board.map((column) => column.lines.length)).toEqual([1, 1, 1, 0, 0, 0, 0]);
  });

  it('filters by status, severity, the person it is given to and the overdue ones, and searches without caring for accents or case', () => {
    const ids = (filter: Partial<typeof EMPTY_FILTER>, membership: string | null = person(1).membership_id) => filterIssues(lines, { ...EMPTY_FILTER, ...filter }, membership ?? undefined).map((item) => item.code.slice(-1));
    expect(ids({})).toEqual(['1', '2', '3']);
    expect(ids({ status: 'ASSIGNED' })).toEqual(['2']);
    expect(ids({ severity: 'HIGH' })).toEqual(['2', '3']);
    expect(ids({ assignedToMe: true })).toEqual(['2']);
    expect(ids({ assignedToMe: true }, null)).toEqual([]);
    expect(ids({ overdueOnly: true })).toEqual(['3']);
    expect(ids({ query: 'giay phep' })).toEqual(['2']);
    expect(ids({ query: ' GIẤY PHÉP ' })).toEqual(['2']);
    expect(ids({ query: person(2).display_name.toLowerCase() })).toEqual(['3']);
    expect(ids({ query: 'không có' })).toEqual([]);
  });

  it('judges a deadline in words: closed, overdue (by the day it became overdue or by the clock), due within a day, on track', () => {
    const now = new Date('2026-10-24T00:00:00.000Z');
    const state = (overrides: Record<string, unknown>) => dueStateOf(line(1, overrides), now);
    expect(state({ status: 'CLOSED', overdue_since: '2026-10-01T02:00:00.000Z' })).toBe('closed');
    expect(state({ overdue_since: '2026-10-01T02:00:00.000Z', due_at: '2999-01-01T00:00:00.000Z' })).toBe('overdue');
    expect(state({ due_at: '2026-10-23T23:59:59.000Z' })).toBe('overdue');
    expect(state({ due_at: '2026-10-24T20:00:00.000Z' })).toBe('dueSoon');
    expect(state({ due_at: '2026-10-26T00:00:00.000Z' })).toBe('onTrack');
  });

  it('addresses the workspace of an issue by its id', () => {
    expect(workspaceLink('abc')).toBe('/iss/iss-03?id=abc');
  });
});

describe('the form of ISS-02', () => {
  const filled: IssueForm = { ...EMPTY_FORM, projectId: 'p', ownerUnitId: 'u', categoryVersionId: 'c', title: ' Chậm bàn giao ', description: ' Mô tả ' };

  it('names what is missing and what is too long', () => {
    expect(validateForm(EMPTY_FORM)).toEqual({ projectId: 'required', ownerUnitId: 'required', categoryVersionId: 'required', title: 'required', description: 'required' });
    expect(validateForm({ ...filled, title: 'x'.repeat(201), description: 'y'.repeat(2001) })).toEqual({ title: 'tooLong', description: 'tooLong' });
    expect(validateForm(filled)).toEqual({});
  });

  it('refuses a position without consent, half a position, and coordinates that are not on the earth', () => {
    expect(validateForm({ ...filled, geoLat: '10.8', geoLng: '106.7' })).toEqual({ geoConsent: 'consentRequired' });
    expect(validateForm({ ...filled, geoConsent: true, geoLat: '10.8' })).toEqual({ geoLng: 'pairRequired' });
    expect(validateForm({ ...filled, geoConsent: true, geoLng: '106.7' })).toEqual({ geoLat: 'pairRequired' });
    expect(validateForm({ ...filled, geoConsent: true, geoAccuracy: '12' })).toEqual({ geoLat: 'pairRequired', geoLng: 'pairRequired' });
    expect(validateForm({ ...filled, geoConsent: true, geoLat: '91', geoLng: '181', geoAccuracy: '-1' })).toEqual({ geoLat: 'invalidLatitude', geoLng: 'invalidLongitude', geoAccuracy: 'invalidAccuracy' });
    expect(validateForm({ ...filled, geoConsent: true, geoLat: 'north', geoLng: 'east' })).toEqual({ geoLat: 'invalidLatitude', geoLng: 'invalidLongitude' });
    expect(validateForm({ ...filled, geoConsent: true, geoLat: '-10.123456', geoLng: '106.7', geoAccuracy: '12.5' })).toEqual({});
    expect(validateForm({ ...filled, geoConsent: true })).toEqual({});
  });

  it('builds the body with the operation id of the intention, and sends a position only with its consent', () => {
    const operation = '00000000-0000-4000-8000-0000000000e1';
    expect(toCreateBody(filled, operation)).toEqual({
      project_id: 'p',
      category_version_id: 'c',
      severity: 'MEDIUM',
      title: 'Chậm bàn giao',
      description: 'Mô tả',
      owner_unit_id: 'u',
      client_operation_id: operation,
    });
    expect(toCreateBody({ ...filled, geoConsent: true }, operation)).toMatchObject({ geo_consent: true });
    expect(toCreateBody({ ...filled, geoConsent: true }, operation)).not.toHaveProperty('geo_lat');
    expect(toCreateBody({ ...filled, geoConsent: true, geoLat: ' 10.8 ', geoLng: '106.7', geoAccuracy: ' 12 ' }, operation)).toMatchObject({ geo_consent: true, geo_lat: '10.8', geo_lng: '106.7', geo_accuracy_m: '12' });
    expect(toCreateBody({ ...filled, geoConsent: true, geoLat: '10.8', geoLng: '106.7' }, operation)).not.toHaveProperty('geo_accuracy_m');
    // Coordinates left in the form after the consent was taken back never travel.
    expect(toCreateBody({ ...filled, geoConsent: false, geoLat: '10.8', geoLng: '106.7' }, operation)).not.toHaveProperty('geo_lat');
  });
});

describe('what the commands answer', () => {
  it('maps the codes of the commands to what the screens say, and keeps the field the server names', () => {
    const reasons = Object.entries({
      SLA_POLICY_MISSING: 'noPolicy',
      DUPLICATE_SOURCE_OPEN: 'duplicateSource',
      ISSUE_STATE_INVALID: 'stateInvalid',
      ASSIGNEE_OUT_OF_SCOPE: 'assigneeOutOfScope',
      DOCUMENT_NOT_CLEAN: 'documentNotClean',
      VERSION_CONFLICT: 'versionConflict',
      IDEMPOTENCY_CONFLICT: 'operationConflict',
      VALIDATION_FAILED: 'validation',
      FIELD_NOT_ALLOWED: 'validation',
      SCOPE_DENIED: 'denied',
      RESOURCE_NOT_FOUND: 'notFound',
      SOMETHING_ELSE: 'general',
    });
    for (const [code, reason] of reasons) expect(describeProblem(problem(code)).reason).toBe(reason);
    expect(describeProblem(problem('VALIDATION_FAILED', 'geo_consent'))).toEqual({ reason: 'validation', field: 'geo_consent' });
    expect(describeProblem(new Error('offline'))).toEqual({ reason: 'general', field: undefined });
  });
});

describe('what the buttons of the workspace follow', () => {
  const both = { assign: true, work: true };
  const me = person(1).membership_id;

  it('offers a command only in the states that allow it, to those who hold its permission', () => {
    expect(actionsOf(line(1, { status: 'OPEN' }), both, me)).toEqual({ assign: true, start: false, comment: true, transfer: true });
    expect(actionsOf(line(1, { status: 'ASSIGNED', assignee: person(1) }), both, me)).toEqual({ assign: true, start: true, comment: true, transfer: true });
    expect(actionsOf(line(1, { status: 'ASSIGNED', assignee: person(2) }), both, me).start).toBe(false);
    expect(actionsOf(line(1, { status: 'ASSIGNED', assignee: person(1) }), both, undefined).start).toBe(false);
    expect(actionsOf(line(1, { status: 'IN_PROGRESS' }), both, me)).toMatchObject({ assign: true, start: false });
    expect(actionsOf(line(1, { status: 'PENDING_VERIFICATION' }), both, me)).toMatchObject({ assign: false, comment: true, transfer: true });
    expect(actionsOf(line(1, { status: 'CLOSED' }), both, me)).toEqual({ assign: false, start: false, comment: false, transfer: false });
    expect(actionsOf(line(1, { status: 'OPEN' }), { assign: false, work: false }, me)).toEqual({ assign: false, start: false, comment: false, transfer: false });
  });

  it('treats a session without a list of permissions as unrestricted, as the shell does', () => {
    expect(hasPermission(undefined, 'issue.create')).toBe(true);
    expect(hasPermission(['issue.read'], 'issue.create')).toBe(false);
    expect(hasPermission(['issue.create'], 'issue.create')).toBe(true);
  });
});
