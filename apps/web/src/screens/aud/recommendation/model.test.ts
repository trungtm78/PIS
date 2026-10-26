import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { OTHER_PERSON, SELF, actionRecord, boardRecord } from '../test-support';
import {
  BOARD_COLUMNS,
  EMPTY_ASSIGN_FORM,
  EMPTY_COMPLETE_FORM,
  EMPTY_DECISION_FORM,
  EMPTY_DISPUTE_FORM,
  EMPTY_EVIDENCE_FORM,
  EMPTY_PLAN_FORM,
  EMPTY_VERIFY_FORM,
  assignBody,
  canAssign,
  canAttach,
  canComplete,
  canDecide,
  canDispute,
  canPlan,
  canSubmit,
  canVerify,
  completeBody,
  decisionBody,
  describeRemediation,
  disputeBody,
  evidenceBody,
  hadAHand,
  inColumn,
  isMine,
  lateDays,
  matching,
  planBody,
  toBoardItem,
  validateAssign,
  validateComplete,
  validateDecision,
  validateDispute,
  validateEvidence,
  validatePlan,
  validateVerify,
  verifyBody,
} from './model';
import type { BoardItem, Caller } from './model';

const TODAY = '2026-10-26';
const DOCUMENT = '00000000-0000-4000-8000-000000000021';
const item = (n = 1, overrides: Record<string, unknown> = {}): BoardItem => toBoardItem(boardRecord(n, overrides)) as BoardItem;
const caller = (permissions: readonly string[] | undefined, userId: string | undefined = SELF, mode: Caller['mode'] = undefined): Caller => ({ userId, permissions, mode });
const OWNER = ['aud.recommendation.execute'];
const LEADER = ['aud.recommendation.assign'];
const VERIFIER = ['aud.recommendation.verify'];

describe('what the reads answer', () => {
  it('reads a recommendation with its owner, its days, its dispute and its actions with their evidence', () => {
    const read = item(1, {
      status: 'IN_PROGRESS',
      actions: [actionRecord(1, { status: 'DONE', completed_on: '2026-10-24', evidence_document_id: DOCUMENT, version: 2 })],
      evidence_count: 1,
      submitted_by: OTHER_PERSON,
      dispute_reason: 'Khối lượng đã được giám sát xác nhận.',
      dispute_outcome: 'REJECTED_BY_AUTHORITY',
      verification_note: 'Chưa đủ chứng từ.',
    });
    expect(read).toMatchObject({
      code: 'KN-001',
      type: 'FINANCIAL_RECOVERY',
      amountVnd: '800000000',
      recoveredVnd: '0',
      ownerUnit: { name: 'Sở Xây dựng' },
      ownerUser: { id: SELF, name: 'Nguyễn Văn An' },
      dueOn: '2026-12-01',
      implementationDueOn: '2026-12-31',
      status: 'IN_PROGRESS',
      disputeOutcome: 'REJECTED_BY_AUTHORITY',
      verificationNote: 'Chưa đủ chứng từ.',
      submittedBy: OTHER_PERSON,
      evidenceCount: 1,
      version: 3,
      engagement: { code: 'TTCP-2026-001' },
    });
    expect(read.actions).toEqual([{ id: actionRecord(1).id, code: 'HD-01', description: 'Chấn chỉnh quy trình thanh toán.', plannedOn: '2026-11-15', completedOn: '2026-10-24', status: 'DONE', evidenceDocumentId: DOCUMENT, version: 2 }]);
  });

  it('keeps what is missing as null or empty, drops an action it cannot read, and drops a recommendation it cannot read rather than show it half', () => {
    const bare = item(2, { owner_unit: null, owner_user: null, due_on: null, implementation_due_on: null, amount_vnd: null, recovered_vnd: undefined, actions: [{ id: 'x' }, actionRecord(2)], evidence_count: undefined, dispute_outcome: 'LOST' });
    expect(bare).toMatchObject({ ownerUnit: null, ownerUser: null, dueOn: null, implementationDueOn: null, amountVnd: null, recoveredVnd: '0', evidenceCount: 0, disputeOutcome: null });
    expect(bare.actions.map((action) => action.code)).toEqual(['HD-02']);
    expect(item(3, { owner_unit: { id: 'u1' }, engagement: { id: 'e1' } })).toMatchObject({ ownerUnit: { code: '', name: '' }, engagement: { id: 'e1', code: '' } });
    for (const broken of [{ id: undefined }, { rec_type: 'X' }, { status: 'X' }, { version: 1.5 }, { engagement: null }, { description: 4 }]) expect(toBoardItem(boardRecord(4, broken))).toBeUndefined();
    expect(toBoardItem(null)).toBeUndefined();
    expect(toBoardItem([])).toBeUndefined();
  });

  it('narrows by the words typed and sorts into the columns of the board', () => {
    const items = [item(1, { owner_user: null }), item(2, { status: 'IN_PROGRESS', description: 'Sửa quy trình giải ngân.' }), item(3, { status: 'CLOSED' }), item(4, { status: 'OPEN' })];
    expect(matching(items, '  ').length).toBe(4);
    expect(matching(items, 'giải ngân').map((line) => line.code)).toEqual(['KN-002']);
    expect(matching(items, 'sở xây dựng').length).toBe(4);
    expect(matching(items, 'nguyễn văn an').map((line) => line.code)).toEqual(['KN-002', 'KN-003', 'KN-004']);
    expect(BOARD_COLUMNS).toEqual(['ASSIGNED', 'IN_PROGRESS', 'DISPUTED', 'PENDING_VERIFICATION', 'CLOSED']);
    expect(inColumn(items, 'IN_PROGRESS').map((line) => line.code)).toEqual(['KN-002']);
    expect(inColumn(items, 'DISPUTED')).toEqual([]);
  });
});

describe('the days a recommendation is late (BR-AUD-06)', () => {
  it('counts the days after the day it was due, and none on the day, before it, or while it is closed, cancelled or disputed', () => {
    expect(lateDays({ dueOn: '2026-10-20', status: 'IN_PROGRESS' }, TODAY)).toBe(6);
    expect(lateDays({ dueOn: '2026-10-25', status: 'ASSIGNED' }, TODAY)).toBe(1);
    expect(lateDays({ dueOn: TODAY, status: 'ASSIGNED' }, TODAY)).toBe(0);
    expect(lateDays({ dueOn: '2026-11-01', status: 'ASSIGNED' }, TODAY)).toBe(0);
    expect(lateDays({ dueOn: null, status: 'ASSIGNED' }, TODAY)).toBe(0);
    for (const status of ['CLOSED', 'CANCELLED', 'DISPUTED'] as const) expect(lateDays({ dueOn: '2026-10-01', status }, TODAY)).toBe(0);
    expect(lateDays({ dueOn: '2026-02-27', status: 'IN_PROGRESS' }, '2026-03-02')).toBe(3);
  });
});

describe('who may do what (AUD 2, BR-AUD-08)', () => {
  it('knows whether the work was given to the caller by name, or to their unit when no person was named', () => {
    expect(isMine(item(1), caller(OWNER))).toBe(true);
    expect(isMine(item(1), caller(OWNER, OTHER_PERSON))).toBe(false);
    expect(isMine(item(1, { owner_user: null }), caller(OWNER, OTHER_PERSON))).toBe(true);
    expect(isMine(item(1, { owner_user: null, owner_unit: null }), caller(OWNER))).toBe(false);
  });

  it('knows who had a hand in the work: the owner, the one who reported it and the one who raised the dispute', () => {
    expect(hadAHand(item(1), caller(VERIFIER))).toBe(true);
    expect(hadAHand(item(1, { owner_user: null, submitted_by: SELF }), caller(VERIFIER))).toBe(true);
    expect(hadAHand(item(1, { owner_user: null, disputed_by: SELF }), caller(VERIFIER))).toBe(true);
    expect(hadAHand(item(1), caller(VERIFIER, OTHER_PERSON))).toBe(false);
    expect(hadAHand(item(1), { userId: undefined, permissions: VERIFIER, mode: undefined })).toBe(false);
  });

  it('offers the assignment to a leader for a recommendation that is OPEN or ASSIGNED, in a tenant that is not read only', () => {
    for (const status of ['OPEN', 'ASSIGNED'] as const) expect(canAssign(item(1, { status }), caller(LEADER))).toBe(true);
    for (const status of ['IN_PROGRESS', 'PENDING_VERIFICATION', 'DISPUTED', 'CLOSED', 'CANCELLED'] as const) expect(canAssign(item(1, { status }), caller(LEADER))).toBe(false);
    expect(canAssign(item(1, { status: 'OPEN' }), caller(OWNER))).toBe(false);
    expect(canAssign(item(1, { status: 'OPEN' }), caller(LEADER, SELF, 'READ_ONLY'))).toBe(false);
    expect(canAssign(item(1, { status: 'OPEN' }), caller(undefined))).toBe(true);
  });

  it('offers the work to the owner in the states it fits: plan, complete, report, dispute and attach evidence', () => {
    const assigned = item(1, { status: 'ASSIGNED' });
    const working = item(1, { status: 'IN_PROGRESS', actions: [actionRecord(1), actionRecord(2, { status: 'DONE' })] });
    const [planned, done] = working.actions as [BoardItem['actions'][number], BoardItem['actions'][number]];
    const mine = caller(OWNER);
    expect([canPlan(assigned, mine), canPlan(working, mine), canPlan(item(1, { status: 'DISPUTED' }), mine)]).toEqual([true, true, false]);
    expect([canComplete(working, planned, mine), canComplete(working, done, mine), canComplete(assigned, planned, mine)]).toEqual([true, false, false]);
    expect([canSubmit(working, mine), canSubmit(assigned, mine)]).toEqual([true, false]);
    expect([canDispute(assigned, mine), canDispute(working, mine), canDispute(item(1, { status: 'PENDING_VERIFICATION' }), mine)]).toEqual([true, true, false]);
    for (const status of ['ASSIGNED', 'IN_PROGRESS', 'DISPUTED', 'PENDING_VERIFICATION'] as const) expect(canAttach(item(1, { status }), mine)).toBe(true);
    for (const status of ['OPEN', 'CLOSED', 'CANCELLED'] as const) expect(canAttach(item(1, { status }), mine)).toBe(false);
    // not the owner, no permission, or read only
    const stranger = caller(OWNER, OTHER_PERSON);
    expect([canPlan(assigned, stranger), canSubmit(working, stranger), canDispute(assigned, stranger), canAttach(assigned, stranger), canComplete(working, planned, stranger)]).toEqual([false, false, false, false, false]);
    expect([canPlan(assigned, caller(LEADER)), canSubmit(working, caller(['aud.read']))]).toEqual([false, false]);
    expect(canPlan(assigned, caller(OWNER, SELF, 'READ_ONLY'))).toBe(false);
  });

  it('offers the verification and the answer to a dispute to a verifier who had no hand in the work', () => {
    const pending = item(1, { status: 'PENDING_VERIFICATION', owner_user: { id: OTHER_PERSON, display_name: 'Trần Thị Bình' }, submitted_by: OTHER_PERSON });
    const disputed = item(1, { status: 'DISPUTED', owner_user: { id: OTHER_PERSON, display_name: 'Trần Thị Bình' }, disputed_by: OTHER_PERSON });
    expect([canVerify(pending, caller(VERIFIER)), canDecide(disputed, caller(VERIFIER))]).toEqual([true, true]);
    expect([canVerify(pending, caller(VERIFIER, OTHER_PERSON)), canDecide(disputed, caller(VERIFIER, OTHER_PERSON))]).toEqual([false, false]);
    expect([canVerify(pending, caller(OWNER)), canDecide(disputed, caller(OWNER))]).toEqual([false, false]);
    expect([canVerify(disputed, caller(VERIFIER)), canDecide(pending, caller(VERIFIER))]).toEqual([false, false]);
    expect(canVerify(pending, caller(VERIFIER, SELF, 'READ_ONLY'))).toBe(false);
  });
});

describe('the form of an assignment', () => {
  it('takes a unit and a day that is today or later and not after the deadline of the conclusion, and sends the person only when one is named', () => {
    const form = { ownerUnitId: 'u1', ownerUserId: '', dueOn: '2026-12-01' };
    expect(validateAssign(form, TODAY, '2026-12-31')).toEqual({});
    expect(assignBody(form)).toEqual({ owner_unit_id: 'u1', due_on: '2026-12-01' });
    expect(assignBody({ ...form, ownerUserId: 'p1' })).toEqual({ owner_unit_id: 'u1', owner_user_id: 'p1', due_on: '2026-12-01' });
    expect(validateAssign({ ...form, dueOn: TODAY }, TODAY, '2026-12-31')).toEqual({});
    expect(validateAssign(form, TODAY, null)).toEqual({});
  });

  it('says what is missing and what is wrong: a day in the past, after the deadline, not a day', () => {
    expect(validateAssign(EMPTY_ASSIGN_FORM, TODAY, null)).toEqual({ ownerUnitId: 'required', dueOn: 'required' });
    expect(validateAssign({ ownerUnitId: 'u1', ownerUserId: '', dueOn: '2026-10-25' }, TODAY, null)).toEqual({ dueOn: 'early' });
    expect(validateAssign({ ownerUnitId: 'u1', ownerUserId: '', dueOn: '2027-01-01' }, TODAY, '2026-12-31')).toEqual({ dueOn: 'afterDeadline' });
    expect(validateAssign({ ownerUnitId: 'u1', ownerUserId: '', dueOn: '2026-13-40' }, TODAY, null)).toEqual({ dueOn: 'invalid' });
  });
});

describe('the forms of the work', () => {
  it('plans an action with a code, what will be done and a day', () => {
    const form = { code: ' HD-01 ', description: '  Chấn chỉnh quy trình.  ', plannedOn: '2026-11-15' };
    expect(validatePlan(form)).toEqual({});
    expect(planBody(form)).toEqual({ action_code: 'HD-01', description: 'Chấn chỉnh quy trình.', planned_on: '2026-11-15' });
    expect(validatePlan(EMPTY_PLAN_FORM)).toEqual({ code: 'required', description: 'required', plannedOn: 'required' });
    expect(validatePlan({ code: 'x'.repeat(41), description: 'ngắn', plannedOn: 'x' })).toEqual({ code: 'tooLong', description: 'tooShort', plannedOn: 'invalid' });
  });

  it('completes an action on a day that has come with a document, which the body sends in lower case', () => {
    const form = { completedOn: '2026-10-24', evidenceDocumentId: DOCUMENT.toUpperCase() };
    expect(validateComplete(form, TODAY)).toEqual({});
    expect(completeBody(form)).toEqual({ completed_on: '2026-10-24', evidence_document_id: DOCUMENT });
    expect(validateComplete(EMPTY_COMPLETE_FORM, TODAY)).toEqual({ completedOn: 'required', evidenceDocumentId: 'required' });
    expect(validateComplete({ completedOn: '2026-10-27', evidenceDocumentId: 'abc' }, TODAY)).toEqual({ completedOn: 'future', evidenceDocumentId: 'invalid' });
  });

  it('disputes with at least 20 characters and a document', () => {
    const form = { reason: 'Khối lượng đã được giám sát xác nhận tại hiện trường.', documentId: DOCUMENT };
    expect(validateDispute(form)).toEqual({});
    expect(disputeBody(form)).toEqual({ dispute_reason: 'Khối lượng đã được giám sát xác nhận tại hiện trường.', dispute_document_id: DOCUMENT });
    expect(validateDispute(EMPTY_DISPUTE_FORM)).toEqual({ reason: 'required', documentId: 'required' });
    expect(validateDispute({ reason: 'quá ngắn', documentId: 'x' })).toEqual({ reason: 'tooShort', documentId: 'invalid' });
  });

  it('records the answer of the authority with a document', () => {
    expect(validateDecision({ outcome: 'ACCEPTED_BY_AUTHORITY', authorityDocumentId: DOCUMENT })).toEqual({});
    expect(decisionBody({ outcome: 'REJECTED_BY_AUTHORITY', authorityDocumentId: DOCUMENT.toUpperCase() })).toEqual({ outcome: 'REJECTED_BY_AUTHORITY', authority_document_id: DOCUMENT });
    expect(validateDecision(EMPTY_DECISION_FORM)).toEqual({ outcome: 'required', authorityDocumentId: 'required' });
    expect(validateDecision({ outcome: 'ACCEPTED_BY_AUTHORITY', authorityDocumentId: 'x' })).toEqual({ authorityDocumentId: 'invalid' });
  });

  it('verifies: a closure may name its basis, a return says what is left to do in words', () => {
    expect(validateVerify({ decision: 'CLOSE', closureBasisDocumentId: '', comment: '' })).toEqual({});
    expect(verifyBody({ decision: 'CLOSE', closureBasisDocumentId: DOCUMENT.toUpperCase(), comment: ' Đã kiểm tra. ' })).toEqual({ decision: 'CLOSE', closure_basis_document_id: DOCUMENT, comment: 'Đã kiểm tra.' });
    expect(verifyBody({ decision: 'CLOSE', closureBasisDocumentId: '', comment: '' })).toEqual({ decision: 'CLOSE' });
    expect(validateVerify({ decision: 'CLOSE', closureBasisDocumentId: 'x', comment: '' })).toEqual({ closureBasisDocumentId: 'invalid' });
    expect(validateVerify(EMPTY_VERIFY_FORM)).toEqual({ decision: 'required' });
    expect(validateVerify({ decision: 'RETURN', closureBasisDocumentId: '', comment: '' })).toEqual({ comment: 'required' });
    expect(validateVerify({ decision: 'RETURN', closureBasisDocumentId: '', comment: 'ngắn' })).toEqual({ comment: 'tooShort' });
    expect(validateVerify({ decision: 'RETURN', closureBasisDocumentId: 'ignored', comment: 'Còn thiếu chứng từ của đợt hai.' })).toEqual({});
    expect(verifyBody({ decision: 'RETURN', closureBasisDocumentId: DOCUMENT, comment: 'Còn thiếu chứng từ của đợt hai.' })).toEqual({ decision: 'RETURN', comment: 'Còn thiếu chứng từ của đợt hai.' });
    expect(validateVerify({ decision: 'CLOSE', closureBasisDocumentId: '', comment: 'x'.repeat(2001) })).toEqual({ comment: 'tooLong' });
  });

  it('puts evidence on the recommendation or on one of its actions, with a document and a note that is not too long', () => {
    expect(validateEvidence({ target: 'RECOMMENDATION', documentId: DOCUMENT, note: '' })).toEqual({});
    expect(evidenceBody({ target: 'RECOMMENDATION', documentId: DOCUMENT.toUpperCase(), note: ' Biên bản. ' }, 'r1')).toEqual({ owner_kind: 'RECOMMENDATION', owner_id: 'r1', document_id: DOCUMENT, note: 'Biên bản.' });
    expect(evidenceBody({ target: 'ACTION:a1', documentId: DOCUMENT, note: '' }, 'r1')).toEqual({ owner_kind: 'ACTION', owner_id: 'a1', document_id: DOCUMENT });
    expect(validateEvidence(EMPTY_EVIDENCE_FORM)).toEqual({ documentId: 'required' });
    expect(validateEvidence({ target: 'RECOMMENDATION', documentId: 'x', note: 'n'.repeat(1001) })).toEqual({ documentId: 'invalid', note: 'tooLong' });
  });
});

describe('what a refusal of the server comes to', () => {
  const refused = (code: string, extensions: Record<string, unknown> = {}) => new ApiError({ status: 422, code, correlationId: 'c', extensions });

  it('names the problem of each code the commands answer, and the general one for any other', () => {
    const cases: Array<[string, string]> = [
      ['NOT_OWNER', 'notOwner'],
      ['OWNER_OUT_OF_SCOPE', 'ownerOutOfScope'],
      ['DUE_AFTER_CONCLUSION_DEADLINE', 'dueAfterDeadline'],
      ['RECOMMENDATION_STATE_INVALID', 'recommendationState'],
      ['ACTION_STATE_INVALID', 'actionState'],
      ['ACTION_CODE_DUPLICATE', 'actionDuplicate'],
      ['EVIDENCE_REQUIRED', 'evidenceRequired'],
      ['OPEN_ACTIONS_REMAIN', 'openActions'],
      ['RECOVERY_INCOMPLETE', 'recoveryIncomplete'],
      ['SELF_APPROVAL_DENIED', 'selfApproval'],
      ['DOCUMENT_NOT_EFFECTIVE', 'documentNotEffective'],
      ['DECISION_DOCUMENT_NOT_EFFECTIVE', 'decisionNotEffective'],
      ['ENGAGEMENT_STATE_INVALID', 'engagementState'],
      ['VERSION_CONFLICT', 'versionConflict'],
      ['SCOPE_DENIED', 'scopeDenied'],
      ['VALIDATION_FAILED', 'validation'],
      ['INVALID_REQUEST', 'validation'],
      ['FIELD_NOT_ALLOWED', 'validation'],
      ['RESOURCE_NOT_FOUND', 'notFound'],
      ['SOMETHING_ELSE', 'general'],
    ];
    for (const [code, problem] of cases) expect(describeRemediation(refused(code)).problem).toBe(problem);
    expect(describeRemediation(new Error('offline'))).toEqual({ problem: 'general', deadline: undefined, remainingVnd: undefined });
  });

  it('carries the deadline when a day was after it and what is left when the recovery is not complete, and nothing otherwise', () => {
    expect(describeRemediation(refused('DUE_AFTER_CONCLUSION_DEADLINE', { implementation_due_on: '2026-12-31' }))).toEqual({ problem: 'dueAfterDeadline', deadline: '2026-12-31', remainingVnd: undefined });
    expect(describeRemediation(refused('RECOVERY_INCOMPLETE', { remaining_vnd: '100000000' }))).toEqual({ problem: 'recoveryIncomplete', deadline: undefined, remainingVnd: '100000000' });
    expect(describeRemediation(refused('RECOVERY_INCOMPLETE', { remaining_vnd: 'much' })).remainingVnd).toBeUndefined();
    expect(describeRemediation(refused('NOT_OWNER', { remaining_vnd: '5', implementation_due_on: '2026-01-01' }))).toEqual({ problem: 'notOwner', deadline: undefined, remainingVnd: undefined });
  });
});
