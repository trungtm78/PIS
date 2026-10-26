import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { CONTRACT, DECISION, PROJECT, detailRecord, engagementRecord } from './test-support';
import {
  EMPTY_CANCEL_FORM,
  EMPTY_CREATE_FORM,
  EMPTY_END_FORM,
  EMPTY_START_FORM,
  ENGAGEMENT_STATUSES,
  MAX_SCOPE_ITEMS,
  actionsOf,
  canManage,
  cancelBody,
  createBody,
  describeProblem,
  endBody,
  engagementsMatching,
  startBody,
  toEngagementDetail,
  toEngagementLine,
  todayInVietnam,
  validateCancel,
  validateCreate,
  validateEnd,
  validateStart,
} from './model';
import type { CreateForm, EngagementDetail } from './model';

const detail = (overrides: Record<string, unknown> = {}): EngagementDetail => toEngagementDetail(detailRecord(1, overrides)) as EngagementDetail;

const GOOD: CreateForm = {
  code: 'TTCP-2026-099',
  type: 'STATE_AUDIT',
  authorityKind: 'STATE_AUDIT_OFFICE',
  authorityName: 'Kiểm toán nhà nước',
  decisionDocumentId: DECISION,
  title: 'Kiểm toán đầu tư cầu',
  periodFrom: '2025-01-01',
  periodTo: '2025-12-31',
  coordinatorId: 'c',
  scope: [{ kind: 'PROJECT', id: PROJECT, code: 'DA-1', name: 'Cầu' }],
};

describe('toEngagementLine and toEngagementDetail', () => {
  it('reads an engagement with its coordinator, legal hold and scope count', () => {
    expect(toEngagementLine(engagementRecord(1, { legal_hold: { id: 'h', status: 'Active' } }))).toEqual({
      id: engagementRecord(1).id,
      code: 'TTCP-2026-001',
      type: 'ADMINISTRATIVE_INSPECTION',
      authorityKind: 'PROVINCIAL_INSPECTORATE',
      authorityName: 'Thanh tra tỉnh Cao Bằng',
      title: 'Thanh tra đầu tư cầu số 1',
      periodFrom: '2025-01-01',
      periodTo: '2025-12-31',
      status: 'PLANNED',
      coordinatorId: engagementRecord(1).coordinator && (engagementRecord(1).coordinator as { id: string }).id,
      coordinatorName: 'Nguyễn Văn An',
      holdId: 'h',
      holdStatus: 'Active',
      scopeCount: 2,
      version: 1,
    });
    expect(toEngagementLine(engagementRecord(1, { legal_hold: null, coordinator: { id: 'c' }, scope_count: undefined }))).toMatchObject({ holdId: null, holdStatus: null, coordinatorName: '', scopeCount: 0 });
  });

  it('drops an engagement it cannot read rather than showing it half', () => {
    expect(toEngagementLine(null)).toBeUndefined();
    expect(toEngagementLine([])).toBeUndefined();
    for (const field of ['id', 'engagement_code', 'engagement_type', 'authority_kind', 'authority_name', 'title', 'period_from', 'period_to', 'status', 'coordinator', 'version']) {
      expect(toEngagementLine(engagementRecord(1, { [field]: undefined }))).toBeUndefined();
    }
    expect(toEngagementLine(engagementRecord(1, { status: 'LOST' }))).toBeUndefined();
    expect(toEngagementLine(engagementRecord(1, { engagement_type: 'WALK' }))).toBeUndefined();
  });

  it('reads the file of an engagement and drops the scope items it cannot read', () => {
    expect(detail({ started_on: '2026-10-20', cancel_reason: 'x' })).toMatchObject({
      decision: { documentId: DECISION, title: 'Quyết định thanh tra cầu', symbol: '12/QD-TTCP', issuedOn: '2026-01-15', effectStatus: 'EFFECTIVE' },
      startedOn: '2026-10-20',
      fieldworkEndedOn: null,
      closedOn: null,
      cancelReason: 'x',
    });
    expect(detail().scope.map((item) => [item.kind, item.id, item.code, item.name])).toEqual([
      ['CONTRACT', CONTRACT, 'HD-A-001', 'Hợp đồng thi công cầu'],
      ['PROJECT', PROJECT, 'DA-2026-001', 'Cầu qua sông'],
    ]);
    expect(detail({ scope: [{ kind: 'ROOM', id: 'x' }, { kind: 'UNIT' }, null, { kind: 'UNIT', id: 'u' }] }).scope).toEqual([{ kind: 'UNIT', id: 'u', code: '', name: '' }]);
    expect(detail({ scope: 'none' }).scope).toEqual([]);
    expect(toEngagementDetail(detailRecord(1, { decision: undefined }))).toBeUndefined();
    expect(toEngagementDetail(null)).toBeUndefined();
    expect(detail({ decision: { document_id: DECISION } }).decision).toEqual({ documentId: DECISION, title: '', symbol: null, issuedOn: null, effectStatus: '' });
  });
});

describe('what an engagement allows', () => {
  it('offers the commands of the state and none once the engagement has a conclusion or is over', () => {
    expect(actionsOf('PLANNED')).toEqual(['start', 'cancel']);
    expect(actionsOf('ONGOING')).toEqual(['endFieldwork', 'cancel']);
    expect(actionsOf('AWAITING_CONCLUSION')).toEqual(['cancel']);
    for (const status of ['FOLLOW_UP', 'CLOSED', 'CANCELLED'] as const) expect(actionsOf(status)).toEqual([]);
    expect(ENGAGEMENT_STATUSES.map((status) => actionsOf(status).length)).toEqual([2, 2, 1, 0, 0, 0]);
  });

  it('gates the buttons by the permission and by a tenant that only reads', () => {
    expect(canManage(['aud.engagement.manage'], 'FULL')).toBe(true);
    expect(canManage(['aud.read'], 'FULL')).toBe(false);
    expect(canManage(['aud.engagement.manage'], 'READ_ONLY')).toBe(false);
    expect(canManage(undefined, undefined)).toBe(true);
  });

  it('finds engagements by the words in their code, title or authority, in any case, and all of them for no words', () => {
    const lines = [engagementRecord(1), engagementRecord(2, { authority_name: 'Kiểm toán nhà nước' })].map((raw) => toEngagementLine(raw)) as ReturnType<typeof toEngagementLine>[];
    const found = lines.flatMap((line) => (line === undefined ? [] : [line]));
    expect(engagementsMatching(found, '')).toHaveLength(2);
    expect(engagementsMatching(found, ' KIỂM TOÁN ')).toHaveLength(1);
    expect(engagementsMatching(found, 'ttcp-2026-001')).toHaveLength(1);
    expect(engagementsMatching(found, 'cầu số 2')).toHaveLength(1);
    expect(engagementsMatching(found, 'nothing')).toEqual([]);
  });

  it('counts the day of Vietnam, seven hours ahead of UTC', () => {
    expect(todayInVietnam(new Date('2026-10-25T17:00:00Z'))).toBe('2026-10-26');
    expect(todayInVietnam(new Date('2026-10-25T16:59:00Z'))).toBe('2026-10-25');
  });
});

describe('the registration form', () => {
  it('wants every field, and names the ones that are missing', () => {
    expect(validateCreate(EMPTY_CREATE_FORM)).toEqual({
      code: 'required',
      type: 'required',
      authorityKind: 'required',
      authorityName: 'required',
      decisionDocumentId: 'required',
      title: 'required',
      periodFrom: 'required',
      periodTo: 'required',
      coordinatorId: 'required',
      scope: 'required',
    });
    expect(validateCreate(GOOD)).toEqual({});
  });

  it('judges the lengths, the decision as an id, the days and their order, and the size of the scope', () => {
    expect(validateCreate({ ...GOOD, code: 'ab' })).toEqual({ code: 'tooShort' });
    expect(validateCreate({ ...GOOD, code: 'x'.repeat(61) })).toEqual({ code: 'tooLong' });
    expect(validateCreate({ ...GOOD, code: 'a\u0000bc' })).toEqual({ code: 'invalid' });
    expect(validateCreate({ ...GOOD, authorityName: 'x'.repeat(301) })).toEqual({ authorityName: 'tooLong' });
    expect(validateCreate({ ...GOOD, title: 'x'.repeat(501) })).toEqual({ title: 'tooLong' });
    expect(validateCreate({ ...GOOD, decisionDocumentId: 'nope' })).toEqual({ decisionDocumentId: 'invalid' });
    expect(validateCreate({ ...GOOD, periodFrom: '2025-02-30' })).toEqual({ periodFrom: 'invalid' });
    expect(validateCreate({ ...GOOD, periodTo: 'soon' })).toEqual({ periodTo: 'invalid' });
    expect(validateCreate({ ...GOOD, periodFrom: '2025-12-31', periodTo: '2025-01-01' })).toEqual({ periodTo: 'order' });
    expect(validateCreate({ ...GOOD, scope: Array.from({ length: MAX_SCOPE_ITEMS + 1 }, (_, n) => ({ kind: 'UNIT' as const, id: String(n), code: '', name: '' })) })).toEqual({ scope: 'tooLong' });
  });

  it('builds the body with the words trimmed, the decision in lower case and the scope as kinds and ids only', () => {
    expect(createBody({ ...GOOD, code: ' TTCP-2026-099 ', decisionDocumentId: ` ${DECISION.toUpperCase()} `, title: ' Kiểm toán đầu tư cầu ' })).toEqual({
      engagement_code: 'TTCP-2026-099',
      engagement_type: 'STATE_AUDIT',
      authority_kind: 'STATE_AUDIT_OFFICE',
      authority_name: 'Kiểm toán nhà nước',
      decision_document_id: DECISION,
      title: 'Kiểm toán đầu tư cầu',
      period_from: '2025-01-01',
      period_to: '2025-12-31',
      coordinator_user_id: 'c',
      scope: [{ kind: 'PROJECT', id: PROJECT }],
    });
  });
});

describe('the forms of the commands', () => {
  it('wants a start on a day that has come, and sends whether the hold is asked for', () => {
    const today = '2026-10-26';
    expect(validateStart(EMPTY_START_FORM, today)).toEqual({ startedOn: 'required' });
    expect(validateStart({ ...EMPTY_START_FORM, startedOn: '2026-02-30' }, today)).toEqual({ startedOn: 'invalid' });
    expect(validateStart({ ...EMPTY_START_FORM, startedOn: '2026-10-27' }, today)).toEqual({ startedOn: 'future' });
    expect(validateStart({ ...EMPTY_START_FORM, startedOn: '2026-10-26' }, today)).toEqual({});
    expect(startBody({ startedOn: ' 2026-10-20 ', placeLegalHold: false })).toEqual({ started_on: '2026-10-20', place_legal_hold: false });
    expect(EMPTY_START_FORM.placeLegalHold).toBe(true);
  });

  it('wants the end of the fieldwork between the start and today', () => {
    const today = '2026-10-26';
    const started = detail({ status: 'ONGOING', started_on: '2026-10-20' });
    expect(validateEnd(EMPTY_END_FORM, started, today)).toEqual({ onDate: 'required' });
    expect(validateEnd({ onDate: 'x' }, started, today)).toEqual({ onDate: 'invalid' });
    expect(validateEnd({ onDate: '2026-10-27' }, started, today)).toEqual({ onDate: 'future' });
    expect(validateEnd({ onDate: '2026-10-19' }, started, today)).toEqual({ onDate: 'early' });
    expect(validateEnd({ onDate: '2026-10-20' }, started, today)).toEqual({});
    expect(validateEnd({ onDate: '2026-10-01' }, detail({ started_on: null }), today)).toEqual({});
    expect(endBody({ onDate: ' 2026-10-21 ' })).toEqual({ on_date: '2026-10-21' });
  });

  it('wants a cancellation with a day that has come and a reason of at least ten characters', () => {
    const today = '2026-10-26';
    expect(validateCancel(EMPTY_CANCEL_FORM, today)).toEqual({ onDate: 'required', reason: 'required' });
    expect(validateCancel({ onDate: '2026-10-27', reason: 'short' }, today)).toEqual({ onDate: 'future', reason: 'tooShort' });
    expect(validateCancel({ onDate: '2026-10-21', reason: 'x'.repeat(2001) }, today)).toEqual({ reason: 'tooLong' });
    expect(validateCancel({ onDate: '2026-10-21', reason: 'a\u0007bcdefghijk' }, today)).toEqual({ reason: 'invalid' });
    expect(validateCancel({ onDate: '2026-10-21', reason: 'Cơ quan đã rút quyết định.' }, today)).toEqual({});
    expect(cancelBody({ onDate: ' 2026-10-21 ', reason: ' Cơ quan đã rút quyết định. ' })).toEqual({ on_date: '2026-10-21', reason: 'Cơ quan đã rút quyết định.' });
  });
});

describe('describeProblem', () => {
  const fail = (code: string) => new ApiError({ status: 409, code, correlationId: 'c', extensions: {} });

  it('maps the refusals of the commands of the engagements to what a dialog says', () => {
    const cases: Array<[string, string]> = [
      ['ENGAGEMENT_CODE_DUPLICATE', 'codeDuplicate'],
      ['DECISION_DOCUMENT_NOT_EFFECTIVE', 'decisionNotEffective'],
      ['ENGAGEMENT_STATE_INVALID', 'stateInvalid'],
      ['CONCLUSION_EXISTS', 'conclusionExists'],
      ['VERSION_CONFLICT', 'versionConflict'],
      ['SCOPE_DENIED', 'scopeDenied'],
      ['VALIDATION_FAILED', 'validation'],
      ['INVALID_REQUEST', 'validation'],
      ['FIELD_NOT_ALLOWED', 'validation'],
      ['RESOURCE_NOT_FOUND', 'notFound'],
    ];
    for (const [code, problem] of cases) expect(describeProblem(fail(code))).toBe(problem);
    expect(describeProblem(fail('SOMETHING_ELSE'))).toBe('general');
    expect(describeProblem(new Error('boom'))).toBe('general');
  });
});
