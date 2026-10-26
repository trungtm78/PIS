import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { complaintRecord } from '../test-support';
import {
  ANSWERABLE,
  COMPLAINT_STATUSES,
  EMPTY_FILE_FORM,
  EMPTY_RESOLVE_FORM,
  canFile,
  canResolve,
  complaintsOf,
  describeProblem,
  fileBody,
  isAnswerable,
  isOverdue,
  resolveBody,
  toComplaintLine,
  validateFile,
  validateResolve,
} from './model';
import type { ComplaintLine } from './model';

const complaint = (overrides: Record<string, unknown> = {}): ComplaintLine => toComplaintLine(complaintRecord(1, overrides)) as ComplaintLine;
const DOCUMENT = '00000000-0000-4000-8000-000000000e01';

describe('toComplaintLine', () => {
  it('reads a complaint with the household by its code, the days left and how it was answered', () => {
    expect(toComplaintLine(complaintRecord(1))).toEqual({
      id: complaintRecord(1).id,
      householdId: complaintRecord(1).household_id,
      householdCode: 'HH-000001',
      planId: null,
      complaintNo: 'LC-000001',
      filedOn: '2026-09-15',
      channel: 'MEETING',
      subject: 'PRICE',
      description: 'Giá nhà quá thấp so với thị trường',
      status: 'RECEIVED',
      dueOn: '2026-10-15',
      remainingDays: 5,
      resolvedOn: null,
      resolutionNote: null,
      resolutionDocumentVersionId: null,
      issueId: null,
      version: 1,
    });
    expect(toComplaintLine(complaintRecord(1, { status: 'ESCALATED', remaining_days: null, resolved_on: '2026-10-12', resolution_note: 'x', issue_id: 'i', plan_id: 'p' }))).toMatchObject({ remainingDays: null, resolvedOn: '2026-10-12', resolutionNote: 'x', issueId: 'i', planId: 'p' });
  });

  it('drops a complaint it cannot read rather than showing it half', () => {
    expect(toComplaintLine(null)).toBeUndefined();
    expect(toComplaintLine([])).toBeUndefined();
    for (const field of ['id', 'household_id', 'household_code', 'complaint_no', 'filed_on', 'channel', 'subject', 'description', 'status', 'due_on', 'version']) expect(toComplaintLine(complaintRecord(1, { [field]: undefined }))).toBeUndefined();
    expect(toComplaintLine(complaintRecord(1, { channel: 'SMOKE' }))).toBeUndefined();
    expect(toComplaintLine(complaintRecord(1, { status: 'LOST' }))).toBeUndefined();
  });
});

describe('what a complaint allows', () => {
  it('answers a complaint that waits, is under review or was escalated, and no other', () => {
    expect(COMPLAINT_STATUSES.filter((status) => isAnswerable(complaint({ status })))).toEqual([...ANSWERABLE]);
  });

  it('counts a complaint as overdue only when it waits and its day has passed', () => {
    expect(isOverdue(complaint({ remaining_days: -1 }))).toBe(true);
    expect(isOverdue(complaint({ remaining_days: 0 }))).toBe(false);
    expect(isOverdue(complaint({ remaining_days: null }))).toBe(false);
  });

  it('keeps the complaints of a status in the order of the read, or all of them', () => {
    const list = [complaint({ status: 'RECEIVED' }), complaint({ status: 'ESCALATED' }), complaint({ status: 'RECEIVED' })];
    expect(complaintsOf(list, '')).toHaveLength(3);
    expect(complaintsOf(list, 'ESCALATED')).toHaveLength(1);
    expect(complaintsOf(list, 'CLOSED')).toEqual([]);
  });

  it('gates the buttons by the permission and by a session that only reads', () => {
    expect(canFile(['land.complaint.write'], 'FULL')).toBe(true);
    expect(canFile(['land.complaint.resolve'], 'FULL')).toBe(false);
    expect(canFile(['land.complaint.write'], 'READ_ONLY')).toBe(false);
    expect(canFile(undefined, undefined)).toBe(true);
    expect(canResolve(['land.complaint.resolve'], undefined)).toBe(true);
    expect(canResolve(['land.complaint.write'], undefined)).toBe(false);
  });
});

describe('the forms', () => {
  it('wants a household, a channel, a subject, words and a day that has come to file', () => {
    const today = '2026-10-26';
    expect(validateFile(EMPTY_FILE_FORM, today)).toEqual({ householdId: 'required', channel: 'required', subject: 'required', description: 'required', filedOn: 'required' });
    const base = { householdId: 'h', planId: '', channel: 'LETTER' as const, subject: 'AREA' as const, description: 'Diện tích đo sai', filedOn: '2026-09-15' };
    expect(validateFile(base, today)).toEqual({});
    expect(validateFile({ ...base, filedOn: '2026-02-30' }, today)).toEqual({ filedOn: 'invalid' });
    expect(validateFile({ ...base, filedOn: '2026-10-27' }, today)).toEqual({ filedOn: 'future' });
    expect(validateFile({ ...base, description: 'x'.repeat(2001) }, today)).toEqual({ description: 'tooLong' });
    expect(validateFile({ ...base, description: 'a\u0000b' }, today)).toEqual({ description: 'invalid' });
  });

  it('names the unit of the household and the plan only when there is one', () => {
    const form = { householdId: 'h', planId: '', channel: 'LETTER' as const, subject: 'AREA' as const, description: ' Diện tích đo sai ', filedOn: ' 2026-09-15 ' };
    expect(fileBody('p', 'u', form)).toEqual({ project_id: 'p', household_id: 'h', owner_unit_id: 'u', channel: 'LETTER', subject: 'AREA', description: 'Diện tích đo sai', filed_on: '2026-09-15' });
    expect(fileBody('p', 'u', { ...form, planId: 'plan' })).toMatchObject({ plan_id: 'plan' });
  });

  it('wants an outcome, a day inside the life of the complaint, words, and a reply document for an acceptance or a rejection', () => {
    const today = '2026-10-26';
    const filed = complaint();
    expect(validateResolve(EMPTY_RESOLVE_FORM, filed, today)).toEqual({ outcome: 'required', resolvedOn: 'required', note: 'required' });
    const base = { outcome: 'RESOLVED_ACCEPTED' as const, resolvedOn: '2026-10-10', resolutionDocumentVersionId: DOCUMENT, note: 'Đã đo lại' };
    expect(validateResolve(base, filed, today)).toEqual({});
    expect(validateResolve({ ...base, resolutionDocumentVersionId: '' }, filed, today)).toEqual({ resolutionDocumentVersionId: 'required' });
    expect(validateResolve({ ...base, outcome: 'RESOLVED_REJECTED', resolutionDocumentVersionId: '' }, filed, today)).toEqual({ resolutionDocumentVersionId: 'required' });
    expect(validateResolve({ ...base, outcome: 'ESCALATED', resolutionDocumentVersionId: '' }, filed, today)).toEqual({});
    expect(validateResolve({ ...base, outcome: 'ESCALATED', resolutionDocumentVersionId: 'x' }, filed, today)).toEqual({ resolutionDocumentVersionId: 'invalid' });
    expect(validateResolve({ ...base, resolvedOn: 'soon' }, filed, today)).toEqual({ resolvedOn: 'invalid' });
    expect(validateResolve({ ...base, resolvedOn: '2026-10-27' }, filed, today)).toEqual({ resolvedOn: 'future' });
    expect(validateResolve({ ...base, resolvedOn: '2026-09-14' }, filed, today)).toEqual({ resolvedOn: 'early' });
    expect(validateResolve({ ...base, note: 'x'.repeat(2001) }, filed, today)).toEqual({ note: 'tooLong' });
    expect(validateResolve({ ...base, note: 'a\u0007b' }, filed, today)).toEqual({ note: 'invalid' });
  });

  it('sends the reply document in lower case, and none when there is none', () => {
    expect(resolveBody({ outcome: 'RESOLVED_ACCEPTED', resolvedOn: ' 2026-10-10 ', resolutionDocumentVersionId: ` ${DOCUMENT.toUpperCase()} `, note: ' Đã đo lại ' })).toEqual({
      outcome: 'RESOLVED_ACCEPTED',
      resolved_on: '2026-10-10',
      note: 'Đã đo lại',
      resolution_document_version_id: DOCUMENT,
    });
    expect(resolveBody({ outcome: 'ESCALATED', resolvedOn: '2026-10-10', resolutionDocumentVersionId: '', note: 'x' })).toEqual({ outcome: 'ESCALATED', resolved_on: '2026-10-10', note: 'x' });
  });
});

describe('describeProblem', () => {
  const fail = (code: string) => new ApiError({ status: 422, code, correlationId: 'c', extensions: {} });

  it('maps the refusals of the commands of the complaints to what a dialog says', () => {
    const cases: Array<[string, string]> = [
      ['HOUSEHOLD_NOT_FOUND', 'householdNotFound'],
      ['COMPLAINT_STATE_INVALID', 'stateInvalid'],
      ['DECISION_DOCUMENT_REQUIRED', 'documentRequired'],
      ['DOCUMENT_NOT_CLEAN', 'documentNotClean'],
      ['TIMER_RULE_UNCONFIRMED', 'ruleUnconfirmed'],
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
