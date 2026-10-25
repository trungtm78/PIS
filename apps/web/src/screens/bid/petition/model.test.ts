import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { EMPTY_RESOLVE, canReceive, describeProblem, emptyReceive, receiveBody, resolveBody, toPetitionLine, toPetitionList, validateReceive, validateResolve, vietnamToday } from './model';
import { PAPER, REPLY, contractorId, petition } from './test-support';

const problem = (code: string, extensions: Record<string, unknown> = {}) => new ApiError({ status: 422, code, correlationId: 'c', extensions });

describe('the petitions of contractors (ST-BID-007)', () => {
  it('reads a petition with its deadline, its standing and what the caller may do', () => {
    expect(toPetitionLine(petition(1, 1, { overdue: true, days_overdue: 3, handled_by: { membership_id: 'm1', display_name: 'An' }, viewer_in_conflict: true, actions: { resolve: false } }))).toMatchObject({
      package: { code: 'GT-1' },
      contractor: { legalName: 'Công ty nhà thầu 1' },
      petitionKind: 'PROCESS',
      receivedOn: '2026-11-25',
      dueOn: '2026-12-04',
      daysApplied: 7,
      status: 'RECEIVED',
      overdue: true,
      daysOverdue: 3,
      petitionDocumentId: PAPER,
      resolutionDocumentId: null,
      viewerInConflict: true,
      handledBy: { membershipId: 'm1', displayName: 'An' },
      canResolve: false,
      version: 1,
    });
  });

  it('fills what is missing and refuses an answer that is not a petition', () => {
    expect(toPetitionLine({ id: 'x', package: { id: 'p' }, contractor: { id: 'c' }, petition_kind: 'RESULT', status: 'RESOLVED', received_on: '2026-11-25', due_on: '2026-12-04', petition_document_id: 'd', version: 2 })).toMatchObject({
      package: { code: '' },
      contractor: { legalName: '' },
      daysApplied: 0,
      overdue: false,
      daysOverdue: 0,
      viewerInConflict: false,
      handledBy: null,
      canResolve: false,
    });
    expect(toPetitionLine({ ...petition(1, 1), petition_kind: 'OTHER' })).toBeUndefined();
    expect(toPetitionLine({ ...petition(1, 1), status: 'DONE' })).toBeUndefined();
    expect(toPetitionLine({ ...petition(1, 1), version: 'one' })).toBeUndefined();
    expect(toPetitionLine({ ...petition(1, 1), due_on: undefined })).toBeUndefined();
    expect(toPetitionLine('petition')).toBeUndefined();
    expect(toPetitionLine({ ...petition(1, 1), handled_by: { display_name: 'x' } })?.handledBy).toBeNull();
    expect(toPetitionList({ items: [petition(1, 1), 'x', petition(2, 1)] })).toHaveLength(2);
    expect(toPetitionList({ items: 'x' })).toEqual([]);
    expect(toPetitionList(null)).toEqual([]);
  });

  it('lets a caller log a petition when the permission is held or not yet known, and not in a read-only session', () => {
    expect(canReceive(['bid.petition.manage'], 'FULL')).toBe(true);
    expect(canReceive(undefined, undefined)).toBe(true);
    expect(canReceive(['bid.read'], 'FULL')).toBe(false);
    expect(canReceive(['bid.petition.manage'], 'READ_ONLY')).toBe(false);
  });

  it('counts the day in Vietnam', () => {
    expect(vietnamToday(new Date('2026-11-25T17:30:00Z'))).toBe('2026-11-26');
    expect(vietnamToday(new Date('2026-11-25T16:30:00Z'))).toBe('2026-11-25');
    expect(vietnamToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('judges the petition before it is sent: the kind, the contractor, a day that is a day and not after today, and the paper', () => {
    const today = '2026-11-25';
    expect(validateReceive({ ...emptyReceive(today), receivedOn: '' }, today)).toEqual({ petitionKind: 'required', contractorId: 'required', receivedOn: 'required', documentId: 'required' });
    const ok = { petitionKind: 'PROCESS' as const, contractorId: contractorId(1), receivedOn: today, documentId: PAPER };
    expect(validateReceive(ok, today)).toEqual({});
    expect(validateReceive({ ...ok, receivedOn: '2026-11-26' }, today).receivedOn).toBe('future');
    expect(validateReceive({ ...ok, receivedOn: '2026-02-30' }, today).receivedOn).toBe('date');
    expect(validateReceive({ ...ok, receivedOn: '25/11/2026' }, today).receivedOn).toBe('date');
    expect(validateReceive({ ...ok, documentId: 'nope' }, today).documentId).toBe('uuid');
  });

  it('builds the body of the petition from the form', () => {
    expect(receiveBody('pkg', { petitionKind: 'RESULT', contractorId: 'c', receivedOn: ' 2026-11-25 ', documentId: ` ${PAPER.toUpperCase()} ` })).toEqual({
      package_id: 'pkg',
      contractor_id: 'c',
      petition_kind: 'RESULT',
      received_on: '2026-11-25',
      petition_document_id: PAPER,
    });
    expect(receiveBody('pkg', { petitionKind: '', contractorId: 'c', receivedOn: '2026-11-25', documentId: PAPER }).petition_kind).toBe('PROCESS');
  });

  it('judges the answer: a way to deal with it and a document', () => {
    expect(validateResolve(EMPTY_RESOLVE)).toEqual({ outcome: 'required', documentId: 'required' });
    expect(validateResolve({ outcome: 'RESOLVED', documentId: 'nope' })).toEqual({ documentId: 'uuid' });
    expect(validateResolve({ outcome: 'ESCALATED', documentId: REPLY })).toEqual({});
    expect(resolveBody({ outcome: 'ESCALATED', documentId: ` ${REPLY.toUpperCase()} ` })).toEqual({ outcome: 'ESCALATED', resolution_document_id: REPLY });
    expect(resolveBody(EMPTY_RESOLVE).outcome).toBe('RESOLVED');
  });

  it('names the refusals of the server', () => {
    expect(describeProblem(problem('PETITION_OUT_OF_TIME', { reason: 'FUTURE' })).problem).toBe('outOfTimeFuture');
    expect(describeProblem(problem('PETITION_OUT_OF_TIME', { reason: 'NO_RESULT' })).problem).toBe('outOfTimeNoResult');
    expect(describeProblem(problem('PETITION_OUT_OF_TIME', { reason: 'BEFORE_RESULT' })).problem).toBe('outOfTimeBeforeResult');
    expect(describeProblem(problem('PETITION_OUT_OF_TIME', { reason: 'FILING_WINDOW_PASSED', last_day_to_file: '2026-11-25' }))).toEqual({ problem: 'outOfTimeFiling', lastDayToFile: '2026-11-25' });
    expect(describeProblem(problem('PETITION_OUT_OF_TIME', { reason: 'FILING_WINDOW_PASSED' }))).toEqual({ problem: 'outOfTimeFiling', lastDayToFile: undefined });
    expect(describeProblem(problem('PETITION_STATE_INVALID', { reason: 'DOCUMENT_ALREADY_LODGED' })).problem).toBe('documentLodged');
    expect(describeProblem(problem('PETITION_STATE_INVALID')).problem).toBe('petitionState');
    expect(describeProblem(problem('CONFLICT_OF_INTEREST_BLOCKED')).problem).toBe('conflict');
    expect(describeProblem(problem('TIMER_RULE_UNCONFIRMED')).problem).toBe('ruleUnconfirmed');
    expect(describeProblem(problem('CALENDAR_NOT_EFFECTIVE')).problem).toBe('calendar');
    expect(describeProblem(problem('VERSION_CONFLICT')).problem).toBe('versionConflict');
    for (const code of ['VALIDATION_FAILED', 'INVALID_REQUEST', 'FIELD_NOT_ALLOWED']) expect(describeProblem(problem(code)).problem).toBe('validation');
    expect(describeProblem(problem('RESOURCE_NOT_FOUND')).problem).toBe('notFound');
    expect(describeProblem(problem('SCOPE_DENIED')).problem).toBe('denied');
    expect(describeProblem(problem('ENTITLEMENT_DENIED')).problem).toBe('denied');
    expect(describeProblem(problem('SESSION_EXPIRED')).problem).toBe('session');
    expect(describeProblem(problem('SOMETHING_ELSE')).problem).toBe('general');
    expect(describeProblem(new Error('offline')).problem).toBe('general');
  });
});
