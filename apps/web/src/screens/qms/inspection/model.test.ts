import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_SCHEDULE,
  canRequest,
  describeProblem,
  emptyRequest,
  emptyResult,
  hasProblems,
  instantOf,
  requestBody,
  resultBody,
  scheduleBody,
  toInspectionLine,
  toInspectionList,
  validateReason,
  validateRequest,
  validateResult,
  validateSchedule,
  vietnamToday,
} from './model';
import type { ChecklistRow, ResultForm } from './model';
import { CHECKLIST, contractId, inspection } from './test-support';

const problem = (code: string, extensions: Record<string, unknown> = {}) => new ApiError({ status: 422, code, correlationId: 'c', extensions });
const rows: ChecklistRow[] = CHECKLIST.map((item) => ({ ...item, outcome: null, note: null }));

describe('toInspectionLine', () => {
  it('reads an inspection with its regime, roles, checklist and what the caller may do', () => {
    const line = toInspectionLine(inspection(1, { boq_item: { id: 'i', business_key: 'B01', description: 'Bê tông' }, actions: { schedule: true, record: true, cancel: false }, location_text: 'Trụ T1' }));
    expect(line).toMatchObject({
      inspectionNo: 'KT-001',
      contract: { id: contractId(2), code: 'HD-A-002' },
      boqItem: { businessKey: 'B01' },
      inspectionType: 'MATERIAL_ENTRY',
      locationText: 'Trụ T1',
      status: 'REQUESTED',
      requiredRoles: ['CONTRACTOR', 'SUPERVISOR', 'OWNER'],
      regime: { label: 'Nghị định 06/2021/NĐ-CP', awaitingConfirmation: false, cxn: null },
      canSchedule: true,
      canRecord: true,
      canCancel: false,
      version: 1,
    });
    expect(line?.checklist.map((item) => item.code)).toEqual(['DOC', 'SAMPLE', 'SAFE']);
  });

  it('reads the answers of a recorded inspection, the participants and the warning of an unconfirmed regime', () => {
    const line = toInspectionLine(
      inspection(2, {
        status: 'RESULT_RECORDED',
        result: 'CONDITIONAL',
        result_note: 'Có điều kiện',
        participants: [{ membership_id: 'm1', display_name: 'Bình' }, { display_name: 'no id' }],
        checklist: [{ code: 'DOC', label: 'Hồ sơ', outcome: 'FAIL', note: 'bổ sung' }, { label: 'no code' }, { code: 'X' }],
        regime: { label: null, legal_basis: null, awaiting_confirmation: true, cxn: 'CXN-07' },
        required_roles: ['OWNER', 'NOBODY'],
      }),
    );
    expect(line?.result).toBe('CONDITIONAL');
    expect(line?.participants).toEqual([{ membershipId: 'm1', displayName: 'Bình' }]);
    expect(line?.checklist).toEqual([
      { code: 'DOC', label: 'Hồ sơ', outcome: 'FAIL', note: 'bổ sung' },
      { code: 'X', label: 'X', outcome: null, note: null },
    ]);
    expect(line?.regime).toEqual({ label: null, legalBasis: null, awaitingConfirmation: true, cxn: 'CXN-07' });
    expect(line?.requiredRoles).toEqual(['OWNER']);
  });

  it('tolerates the optional parts being absent and refuses a row that is not an inspection', () => {
    const bare = toInspectionLine({ id: 'a', contract: { id: 'c' }, inspection_type: 'SAFETY', status: 'CANCELLED', requested_for: '2026-10-30', version: 2, cancel_reason: 'Nhầm' });
    expect(bare).toMatchObject({ inspectionNo: '', title: '', requestedBy: null, boqItem: null, participants: [], checklist: [], requiredRoles: [], canSchedule: false, cancelReason: 'Nhầm', regime: { awaitingConfirmation: false } });
    expect(toInspectionLine(null)).toBeUndefined();
    expect(toInspectionLine({ ...inspection(1), status: 'UNKNOWN' })).toBeUndefined();
    expect(toInspectionLine({ ...inspection(1), version: 'x' })).toBeUndefined();
    expect(toInspectionList({ items: [inspection(1), { nope: true }] })).toHaveLength(1);
    expect(toInspectionList(undefined)).toEqual([]);
  });
});

describe('who may ask', () => {
  it('needs the permission unless it is not yet known, and a session that is not read-only', () => {
    expect(canRequest(['inspection.request'], 'FULL')).toBe(true);
    expect(canRequest(undefined, undefined)).toBe(true);
    expect(canRequest(['inspection.read'], 'FULL')).toBe(false);
    expect(canRequest(['inspection.request'], 'READ_ONLY')).toBe(false);
  });
});

describe('the request', () => {
  const full = { ...emptyRequest('2026-10-30', contractId(2)), inspectionType: 'SAFETY' as const, title: 'Kiểm tra an toàn' };

  it('asks for the contract, the kind, a title and a real day', () => {
    expect(validateRequest(emptyRequest('2026-10-30'))).toEqual({ contractId: 'required', inspectionType: 'required', title: 'required' });
    expect(validateRequest({ ...full, requestedFor: '' }).requestedFor).toBe('required');
    expect(validateRequest({ ...full, requestedFor: '2026-02-30' }).requestedFor).toBe('date');
    expect(validateRequest({ ...full, requestedFor: 'xx' }).requestedFor).toBe('date');
    expect(validateRequest({ ...full, title: 'x'.repeat(2001), locationText: 'y'.repeat(2001) })).toEqual({ title: 'tooLong', locationText: 'tooLong' });
    expect(validateRequest({ ...full, siteDiaryId: 'not-an-id' }).siteDiaryId).toBe('uuid');
    expect(validateRequest(full)).toEqual({});
  });

  it('sends only what was filled, trimmed', () => {
    expect(requestBody(full)).toEqual({ contract_id: contractId(2), inspection_type: 'SAFETY', title: 'Kiểm tra an toàn', requested_for: '2026-10-30' });
    expect(requestBody({ ...full, title: ' Hố móng ', boqItemId: 'item', locationText: ' T1 ', siteDiaryId: ' 00000000-0000-4000-8000-0000000000AB ' })).toEqual({
      contract_id: contractId(2),
      inspection_type: 'SAFETY',
      title: 'Hố móng',
      requested_for: '2026-10-30',
      boq_item_id: 'item',
      location_text: 'T1',
      site_diary_id: '00000000-0000-4000-8000-0000000000ab',
    });
    expect(requestBody(emptyRequest('2026-10-30')).inspection_type).toBe('OTHER');
  });
});

describe('the schedule', () => {
  const now = new Date('2026-10-25T03:00:00Z');

  it('reads the time of the Vietnam day as an instant', () => {
    expect(instantOf('2026-10-30T09:30')).toBe('2026-10-30T02:30:00.000Z');
    expect(instantOf('2026-10-30')).toBeUndefined();
    expect(instantOf('2026-02-30T09:30')).toBeUndefined();
  });

  it('asks for a time that is not past and at least one participant', () => {
    expect(validateSchedule(EMPTY_SCHEDULE, now)).toEqual({ scheduledAt: 'required', participantIds: 'noParticipant' });
    expect(validateSchedule({ scheduledAt: '2026-13-01T09:30', participantIds: ['m'] }, now)).toEqual({ scheduledAt: 'date' });
    expect(validateSchedule({ scheduledAt: '2026-10-25T09:00', participantIds: ['m'] }, now)).toEqual({ scheduledAt: 'past' });
    expect(validateSchedule({ scheduledAt: '2026-10-30T09:30', participantIds: ['m'] }, now)).toEqual({});
    expect(scheduleBody({ scheduledAt: '2026-10-30T09:30', participantIds: ['m'] })).toEqual({ scheduled_at: '2026-10-30T02:30:00.000Z', participant_membership_ids: ['m'] });
    expect(scheduleBody({ scheduledAt: 'garbage', participantIds: [] }).scheduled_at).toBe('garbage');
  });
});

describe('the result', () => {
  const answered = (outcomes: Array<'PASS' | 'FAIL' | 'NA' | ''>, notes: string[] = []): ResultForm => ({
    result: 'PASS',
    resultNote: 'Nhận xét',
    answers: Object.fromEntries(rows.map((item, index) => [item.code, { outcome: outcomes[index] ?? '', note: notes[index] ?? '' }])),
  });

  it('starts with nothing answered and asks for the result, the note and every item', () => {
    const form = emptyResult(rows);
    expect(Object.keys(form.answers)).toEqual(['DOC', 'SAMPLE', 'SAFE']);
    const problems = validateResult(form, rows);
    expect(problems).toMatchObject({ result: 'required', resultNote: 'required', answers: { DOC: 'unanswered', SAMPLE: 'unanswered', SAFE: 'unanswered' } });
    expect(hasProblems(problems)).toBe(true);
    expect(validateResult({ ...form, resultNote: 'x'.repeat(2001), answers: {} }, rows).resultNote).toBe('tooLong');
    expect(validateResult({ ...answered(['PASS', 'PASS', 'PASS'], ['', 'y'.repeat(2001)]), result: 'PASS' }, rows).answers).toEqual({ SAMPLE: 'tooLong' });
  });

  it('holds a result to the answers the way the server does', () => {
    expect(hasProblems(validateResult(answered(['PASS', 'NA', 'PASS']), rows))).toBe(false);
    expect(validateResult(answered(['PASS', 'FAIL', 'PASS']), rows).whole).toBe('passWithFailed');
    expect(validateResult({ ...answered(['PASS', 'PASS', 'PASS']), result: 'FAIL' }, rows).whole).toBe('noFailed');
    expect(validateResult({ ...answered(['PASS', 'PASS', 'NA']), result: 'CONDITIONAL' }, rows).whole).toBe('noFailed');
    expect(hasProblems(validateResult({ ...answered(['PASS', 'FAIL', 'PASS']), result: 'FAIL' }, rows))).toBe(false);
    expect(validateResult({ ...answered(['PASS', 'FAIL', 'FAIL'], ['', 'Bổ sung mẫu']), result: 'CONDITIONAL' }, rows).answers).toEqual({ SAFE: 'conditionUnstated' });
    expect(hasProblems(validateResult({ ...answered(['PASS', 'FAIL', 'PASS'], ['', 'Bổ sung mẫu']), result: 'CONDITIONAL' }, rows))).toBe(false);
  });

  it('sends every answer in the order of the checklist, a note only when there is one', () => {
    expect(resultBody({ ...answered(['PASS', 'FAIL', 'NA'], ['', ' Bổ sung ']), result: 'FAIL', resultNote: ' Không đạt ' }, rows)).toEqual({
      result: 'FAIL',
      result_note: 'Không đạt',
      checklist: [
        { code: 'DOC', outcome: 'PASS' },
        { code: 'SAMPLE', outcome: 'FAIL', note: 'Bổ sung' },
        { code: 'SAFE', outcome: 'NA' },
      ],
    });
    expect(resultBody({ result: '', resultNote: '', answers: {} }, rows).checklist.map((answer) => answer.outcome)).toEqual(['NA', 'NA', 'NA']);
  });
});

describe('the reason to cancel', () => {
  it('is required and bounded', () => {
    expect(validateReason('  ')).toBe('required');
    expect(validateReason('x'.repeat(2001))).toBe('tooLong');
    expect(validateReason('Nhầm hợp đồng')).toBeUndefined();
  });
});

describe('describeProblem', () => {
  it('words each refusal of the server', () => {
    expect(describeProblem(problem('PERMIT_GATE_BLOCKED'))).toBe('permitGate');
    expect(describeProblem(problem('CONTRACT_STATE_INVALID'))).toBe('contractState');
    expect(describeProblem(problem('INSPECTION_DUPLICATE'))).toBe('duplicate');
    expect(describeProblem(problem('REGIME_NOT_EFFECTIVE'))).toBe('regime');
    expect(describeProblem(problem('INSPECTION_STATE_INVALID'))).toBe('inspectionState');
    expect(describeProblem(problem('CHECKLIST_INCOMPLETE', { reason: 'ITEMS_MISSING' }))).toBe('checklistMissing');
    expect(describeProblem(problem('CHECKLIST_INCOMPLETE', { reason: 'RESULT_CONTRADICTS' }))).toBe('checklistContradicts');
    expect(describeProblem(problem('CHECKLIST_INCOMPLETE', { reason: 'CONDITION_UNSTATED' }))).toBe('checklistCondition');
    expect(describeProblem(problem('CHECKLIST_INCOMPLETE', { reason: 'ANSWER_DUPLICATED' }))).toBe('checklistInvalid');
    expect(describeProblem(problem('VERSION_CONFLICT'))).toBe('versionConflict');
    for (const code of ['VALIDATION_FAILED', 'INVALID_REQUEST', 'FIELD_NOT_ALLOWED']) expect(describeProblem(problem(code))).toBe('validation');
    expect(describeProblem(problem('RESOURCE_NOT_FOUND'))).toBe('notFound');
    for (const code of ['SCOPE_DENIED', 'ENTITLEMENT_DENIED']) expect(describeProblem(problem(code))).toBe('denied');
    expect(describeProblem(problem('SESSION_EXPIRED'))).toBe('session');
    expect(describeProblem(problem('SOMETHING_ELSE'))).toBe('general');
    expect(describeProblem(new Error('x'))).toBe('general');
  });
});

describe('vietnamToday', () => {
  it('is the day at UTC+7', () => {
    expect(vietnamToday(new Date('2026-10-25T18:00:00Z'))).toBe('2026-10-26');
    expect(vietnamToday(new Date('2026-10-25T16:59:00Z'))).toBe('2026-10-25');
    expect(vietnamToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
