import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_CLOSE,
  EMPTY_EXCEPTION,
  EMPTY_OPEN,
  EMPTY_VERIFY,
  closeBody,
  daysLeft,
  describeProblem,
  exceptionBody,
  openBody,
  owes,
  refreshBody,
  settlementLink,
  submitBody,
  toAnswer,
  toSettlement,
  urgencyOf,
  validateClose,
  validateException,
  validateOpen,
  validateRefresh,
  validateSubmit,
  validateVerify,
  verifyBody,
  vietnamDay,
  vndText,
} from './model';
import { actions, answer, sent, settlement, settlementId } from './test-support';

const UUID = '00000000-0000-4000-8000-000000000001';
const UUID_2 = '00000000-0000-4000-8000-000000000002';
const problem = (code: string, extensions: Record<string, unknown> = {}) => new ApiError({ status: 422, code, correlationId: 'c', extensions });

describe('reading a settlement', () => {
  it('reads the answer of the server with its figures, its deadline and what the caller may do', () => {
    const read = toSettlement(sent(1, { contract: { id: UUID, code: 'HD-1' }, settlement_scope: 'CONTRACT', audit_finding_refs: [UUID_2], actions: actions({ take_up: true }) }));
    expect(read).toMatchObject({
      id: settlementId(1),
      projectCode: 'DA-001',
      contractId: UUID,
      contractCode: 'HD-1',
      scope: 'CONTRACT',
      status: 'SUBMITTED',
      settledVnd: '9850000000',
      outstandingVnd: '150000000',
      projectGroup: 'B',
      verificationDueOn: '2027-03-30',
      deadlineDays: 180,
      ruleAwaitingConfirmation: true,
      auditFindingRefs: [UUID_2],
      version: 2,
      actions: { takeUp: true, refresh: false, close: false },
    });
    expect(toSettlement(settlement(1))?.auditFindingRefs).toBeNull();
    expect(toSettlement(settlement(1))?.projectGroup).toBeNull();
    expect(toSettlement(settlement(1, { fiscal_year: 2026 }))?.fiscalYear).toBe(2026);
    expect(toSettlement(settlement(1, { figures_refreshed_at: undefined }))?.figuresRefreshedAt).toBe(settlement(1).created_at);
    expect(toSettlement(settlement(1, { deadline_rule_awaiting_confirmation: 'yes' }))?.ruleAwaitingConfirmation).toBeNull();
  });

  it('refuses an answer that is not a settlement, rather than showing half of one', () => {
    expect(toSettlement(undefined)).toBeUndefined();
    expect(toSettlement('x')).toBeUndefined();
    expect(toSettlement(settlement(1, { id: 7 }))).toBeUndefined();
    expect(toSettlement(settlement(1, { status: 'DONE' }))).toBeUndefined();
    expect(toSettlement(settlement(1, { settlement_scope: 'WHOLE' }))).toBeUndefined();
    expect(toSettlement(settlement(1, { settled_amount_vnd: '1.5' }))).toBeUndefined();
    expect(toSettlement(settlement(1, { outstanding_vnd: -1 }))).toBeUndefined();
    expect(toSettlement(settlement(1, { version: 'x' }))).toBeUndefined();
    expect(toSettlement(settlement(1, { actions: undefined }))).toBeUndefined();
    expect(toSettlement(settlement(1, { project: undefined }))).toBeUndefined();
    expect(toSettlement(settlement(1, { created_at: undefined }))).toBeUndefined();
  });

  it('reads the answer of a command', () => {
    expect(toAnswer(answer())).toEqual({ id: settlementId(1), status: 'SUBMITTED', version: 2 });
    expect(toAnswer({ resource_id: UUID, resource_version: 3 })).toEqual({ id: UUID, status: '', version: 3 });
    expect(toAnswer({})).toBeUndefined();
    expect(toAnswer(null)).toBeUndefined();
  });

  it('knows when something is owed', () => {
    expect(owes({ outstandingVnd: '1', unrecoveredAdvanceVnd: '0' })).toBe(true);
    expect(owes({ outstandingVnd: '0', unrecoveredAdvanceVnd: '5' })).toBe(true);
    expect(owes({ outstandingVnd: '0', unrecoveredAdvanceVnd: '0' })).toBe(false);
  });

  it('counts the days to the deadline in Vietnam time and puts a settlement waiting for its verification in its urgency', () => {
    expect(vietnamDay(new Date('2026-10-26T16:59:59Z'))).toBe('2026-10-26');
    expect(vietnamDay(new Date('2026-10-26T17:00:00Z'))).toBe('2026-10-27');
    expect(daysLeft('2027-03-30', '2026-10-26')).toBe(155);
    expect(daysLeft('2026-10-20', '2026-10-26')).toBe(-6);
    expect(daysLeft('soon', '2026-10-26')).toBeUndefined();
    expect(daysLeft('2026-13-45', '2026-10-26')).toBeUndefined();
    const waiting = (status: string, due: string | null) => ({ status, verificationDueOn: due }) as Parameters<typeof urgencyOf>[0];
    expect(urgencyOf(waiting('SUBMITTED', '2026-10-25'), '2026-10-26')).toBe('late');
    expect(urgencyOf(waiting('SUBMITTED', '2026-10-26'), '2026-10-26')).toBe('near');
    expect(urgencyOf(waiting('VERIFYING', '2026-11-25'), '2026-10-26')).toBe('near');
    expect(urgencyOf(waiting('VERIFYING', '2026-11-26'), '2026-10-26')).toBe('later');
    expect(urgencyOf(waiting('VERIFIED', '2026-10-01'), '2026-10-26')).toBeUndefined();
    expect(urgencyOf(waiting('SUBMITTED', null), '2026-10-26')).toBeUndefined();
    expect(urgencyOf(waiting('SUBMITTED', 'x'), '2026-10-26')).toBeUndefined();
  });

  it('writes an amount the way the locale does and leaves anything else as it is', () => {
    expect(vndText('9850000000', 'vi')).toBe('9.850.000.000');
    expect(vndText('abc', 'vi')).toBe('abc');
  });

  it('leads to the workspace, with a settlement picked when one is named', () => {
    expect(settlementLink()).toBe('/pay/pay-15');
    expect(settlementLink(UUID)).toBe(`/pay/pay-15?settlement=${UUID}`);
  });
});

describe('opening a settlement', () => {
  it('asks for the project, and for the scope what it needs', () => {
    expect(validateOpen(EMPTY_OPEN)).toEqual({ projectId: 'required' });
    expect(validateOpen({ ...EMPTY_OPEN, projectId: 'x' })).toEqual({ projectId: 'uuid' });
    expect(validateOpen({ ...EMPTY_OPEN, projectId: UUID })).toEqual({});
    expect(validateOpen({ ...EMPTY_OPEN, projectId: UUID, scope: 'CONTRACT' })).toEqual({ contractId: 'required' });
    expect(validateOpen({ ...EMPTY_OPEN, projectId: UUID, scope: 'CONTRACT', contractId: 'x' })).toEqual({ contractId: 'uuid' });
    expect(validateOpen({ ...EMPTY_OPEN, projectId: UUID, scope: 'ANNUAL' })).toEqual({ fiscalYear: 'required' });
    for (const year of ['1999', '2101', '2026.5', 'x']) expect(validateOpen({ ...EMPTY_OPEN, projectId: UUID, scope: 'ANNUAL', fiscalYear: year })).toEqual({ fiscalYear: 'year' });
    expect(validateOpen({ ...EMPTY_OPEN, projectId: UUID, scope: 'ANNUAL', fiscalYear: '2026' })).toEqual({});
  });

  it('sends only the fields of the scope', () => {
    expect(openBody({ projectId: ` ${UUID} `, scope: 'PROJECT', contractId: UUID_2, fiscalYear: '2026' })).toEqual({ project_id: UUID, settlement_scope: 'PROJECT' });
    expect(openBody({ projectId: UUID, scope: 'CONTRACT', contractId: ` ${UUID_2} `, fiscalYear: '2026' })).toEqual({ project_id: UUID, settlement_scope: 'CONTRACT', contract_id: UUID_2 });
    expect(openBody({ projectId: UUID, scope: 'ANNUAL', contractId: UUID_2, fiscalYear: ' 2026 ' })).toEqual({ project_id: UUID, settlement_scope: 'ANNUAL', fiscal_year: 2026 });
  });
});

describe('the other commands', () => {
  it('reads the figures again with a note that may be left out and may not be too long', () => {
    expect(validateRefresh({ note: '' })).toEqual({});
    expect(validateRefresh({ note: 'x'.repeat(2000) })).toEqual({});
    expect(validateRefresh({ note: 'x'.repeat(2001) })).toEqual({ note: 'tooLong' });
    expect(refreshBody({ note: '  ' })).toEqual({});
    expect(refreshBody({ note: ' After July. ' })).toEqual({ note: 'After July.' });
  });

  it('sends on a real day that is not after today', () => {
    expect(validateSubmit({ submittedOn: '' }, '2026-10-26')).toEqual({ submittedOn: 'required' });
    for (const day of ['yesterday', '2026-02-30', '2026-13-01', '26/10/2026']) expect(validateSubmit({ submittedOn: day }, '2026-10-26')).toEqual({ submittedOn: 'day' });
    expect(validateSubmit({ submittedOn: '2026-10-27' }, '2026-10-26')).toEqual({ submittedOn: 'future' });
    expect(validateSubmit({ submittedOn: '2026-10-26' }, '2026-10-26')).toEqual({});
    expect(submitBody({ submittedOn: ' 2026-10-01 ' })).toEqual({ submitted_on: '2026-10-01' });
  });

  it('verifies with the findings and, when they are given, the conclusions of AUD by their identifiers', () => {
    expect(validateVerify(EMPTY_VERIFY)).toEqual({ findings: 'required' });
    expect(validateVerify({ findings: 'x'.repeat(2001), refs: '' })).toEqual({ findings: 'tooLong' });
    expect(validateVerify({ findings: 'Fine.', refs: 'nope' })).toEqual({ refs: 'uuids' });
    expect(validateVerify({ findings: 'Fine.', refs: Array.from({ length: 51 }, () => UUID).join(' ') })).toEqual({ refs: 'tooMany' });
    expect(validateVerify({ findings: 'Fine.', refs: `${UUID}, ${UUID_2};${UUID}` })).toEqual({});
    expect(verifyBody({ findings: ' Fine. ', refs: '' }, 'VERIFIED')).toEqual({ outcome: 'VERIFIED', findings: 'Fine.' });
    expect(verifyBody({ findings: 'Fine.', refs: `${UUID} ${UUID_2}` }, 'RETURNED')).toEqual({ outcome: 'RETURNED', findings: 'Fine.', audit_finding_refs: [UUID, UUID_2] });
  });

  it('approves the exception with a reason and the document that approves it', () => {
    expect(validateException(EMPTY_EXCEPTION)).toEqual({ reason: 'required', approvalDocumentVersionId: 'required' });
    expect(validateException({ reason: 'x'.repeat(2001), approvalDocumentVersionId: 'x' })).toEqual({ reason: 'tooLong', approvalDocumentVersionId: 'uuid' });
    expect(validateException({ reason: 'Waits.', approvalDocumentVersionId: UUID })).toEqual({});
    expect(exceptionBody({ reason: ' Waits. ', approvalDocumentVersionId: ` ${UUID} ` })).toEqual({ reason: 'Waits.', approval_document_version_id: UUID });
  });

  it('closes on the decision, with evidence that may be left out', () => {
    expect(validateClose(EMPTY_CLOSE)).toEqual({ reason: 'required', decisionDocumentVersionId: 'required' });
    expect(validateClose({ reason: 'x'.repeat(2001), decisionDocumentVersionId: 'x', evidence: 'nope' })).toEqual({ reason: 'tooLong', decisionDocumentVersionId: 'uuid', evidence: 'uuids' });
    expect(validateClose({ reason: 'Done.', decisionDocumentVersionId: UUID, evidence: Array.from({ length: 51 }, () => UUID).join(' ') })).toEqual({ evidence: 'tooMany' });
    expect(validateClose({ reason: 'Done.', decisionDocumentVersionId: UUID, evidence: '' })).toEqual({});
    expect(closeBody({ reason: ' Done. ', decisionDocumentVersionId: UUID, evidence: `${UUID_2}\n${UUID}` })).toEqual({
      decision: 'approve',
      reason: 'Done.',
      evidence_ids: [UUID_2, UUID],
      decision_document_version_id: UUID,
    });
    expect(closeBody({ reason: 'Done.', decisionDocumentVersionId: UUID, evidence: '' }).evidence_ids).toEqual([]);
  });
});

describe('the refusals of the server', () => {
  it('words each refusal of the settlement', () => {
    const cases: Array<[string, string]> = [
      ['SETTLEMENT_OPEN_EXISTS', 'openExists'],
      ['PROJECT_STAGE_INVALID', 'stageInvalid'],
      ['PROJECT_GROUP_MISSING', 'groupMissing'],
      ['DEADLINE_RULE_UNCONFIRMED', 'ruleUnconfirmed'],
      ['SETTLEMENT_STATE_INVALID', 'stateInvalid'],
      ['NO_OUTSTANDING_TO_EXCEPT', 'noOutstanding'],
      ['SETTLEMENT_HAS_OUTSTANDING', 'hasOutstanding'],
      ['DECISION_DOCUMENT_REQUIRED', 'decisionRequired'],
      ['APPROVAL_REQUIRED', 'approvalRequired'],
      ['DOCUMENT_NOT_CLEAN', 'notClean'],
      ['SELF_APPROVAL_DENIED', 'selfApproval'],
      ['VERSION_CONFLICT', 'versionConflict'],
      ['VALIDATION_FAILED', 'validation'],
      ['INVALID_REQUEST', 'validation'],
      ['FIELD_NOT_ALLOWED', 'validation'],
      ['RESOURCE_NOT_FOUND', 'notFound'],
      ['SCOPE_DENIED', 'denied'],
      ['ENTITLEMENT_DENIED', 'denied'],
      ['SESSION_EXPIRED', 'session'],
      ['SOMETHING_ELSE', 'general'],
    ];
    for (const [code, expected] of cases) expect(describeProblem(problem(code))).toBe(expected);
    expect(describeProblem(new Error('boom'))).toBe('general');
  });
});
