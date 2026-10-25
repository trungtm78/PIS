import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_EVIDENCE,
  EMPTY_VERIFY,
  answerable,
  assignBody,
  canRaise,
  describeProblem,
  emptyAssign,
  emptyRaise,
  endOfDay,
  evidenceBody,
  inLane,
  laneOf,
  raiseBody,
  toNcrLine,
  toNcrList,
  validateAssign,
  validateEvidence,
  validateNote,
  validateRaise,
  validateVerify,
  verifiable,
  vietnamToday,
} from './model';
import type { RaiseForm } from './model';
import { ME, action, actionId, allowed, contractId, memberId, ncr, ncrId } from './test-support';

const problem = (code: string, status = 422) => new ApiError({ status, code, correlationId: 'c', extensions: {} });
const TODAY = '2026-10-25';
const UUID = '00000000-0000-4000-8000-000000000001';

const filled = (overrides: Partial<RaiseForm> = {}): RaiseForm => ({
  ...emptyRaise(TODAY, contractId(2)),
  severity: 'CRITICAL',
  sourceKind: 'SUPERVISOR_REMARK',
  title: ' Lớp bảo vệ thiếu ',
  description: 'Đo được 30 mm.',
  actionOwnerId: memberId(1),
  dueOn: '2026-11-05',
  ...overrides,
});

describe('toNcrLine', () => {
  it('reads a non-conformance with its actions and what the caller may do', () => {
    const line = toNcrLine(
      ncr(1, {
        severity: 'CRITICAL',
        blocks_acceptance: true,
        status: 'ACTION_ASSIGNED',
        overdue: true,
        root_cause: 'Ván khuôn xê dịch',
        reopen_count: 2,
        actions: [action(1), action(2, { status: 'REJECTED', verification_note: 'Vẫn thiếu', evidence_note: 'Đã đổ lại' }), { id: 'x' }],
        allowed: allowed({ assign: true, close: true }),
      }),
    );
    expect(line).toMatchObject({
      id: ncrId(1),
      ncrNo: 'NCR-001',
      severity: 'CRITICAL',
      blocksAcceptance: true,
      status: 'ACTION_ASSIGNED',
      overdue: true,
      rootCause: 'Ván khuôn xê dịch',
      reopenCount: 2,
      contract: { id: contractId(2), code: 'HD-A-002' },
      actionOwner: { membershipId: memberId(1), displayName: 'Giám sát Bình' },
      allowed: { assign: true, respond: false, verify: false, close: true, reopen: false },
      version: 1,
    });
    expect(line?.actions.map((item) => item.id)).toEqual([actionId(1), actionId(2)]);
    expect(line?.actions[1]).toMatchObject({ status: 'REJECTED', verificationNote: 'Vẫn thiếu', evidenceNote: 'Đã đổ lại' });
  });

  it('keeps what is missing as nothing and refuses what cannot be shown', () => {
    expect(toNcrLine({ ...ncr(1), source_kind: 'GOSSIP', contract: { id: contractId(2) }, actions: 'none', allowed: null, action_owner: null })).toMatchObject({
      sourceKind: null,
      contract: { code: '' },
      actions: [],
      actionOwner: { membershipId: '', displayName: '' },
      allowed: { assign: false, respond: false, verify: false, close: false, reopen: false },
    });
    expect(toNcrLine(null)).toBeUndefined();
    expect(toNcrLine({ ...ncr(1), severity: 'SEVERE' })).toBeUndefined();
    expect(toNcrLine({ ...ncr(1), status: 'GONE' })).toBeUndefined();
    expect(toNcrLine({ ...ncr(1), version: 'one' })).toBeUndefined();
    expect(toNcrLine({ ...ncr(1), contract: {} })).toBeUndefined();
    expect(toNcrLine({ ...ncr(1), id: 5 })).toBeUndefined();
    expect(toNcrList({ items: [ncr(1), { id: 'x' }, ncr(2)] }).map((line) => line.id)).toEqual([ncrId(1), ncrId(2)]);
    expect(toNcrList({ items: 'none' })).toEqual([]);
    expect(toNcrList(undefined)).toEqual([]);
  });
});

describe('the lanes of the board', () => {
  it('puts a reopened non-conformance where a raised one waits, the one due soonest first', () => {
    expect(laneOf('REOPENED')).toBe('OPEN');
    expect(laneOf('VERIFIED')).toBe('VERIFIED');
    const lines = [ncr(1, { due_at: '2026-12-01T00:00:00.000Z' }), ncr(2, { status: 'REOPENED', due_at: '2026-11-01T00:00:00.000Z' }), ncr(3, { status: 'CLOSED' })].flatMap(
      (raw) => toNcrLine(raw) ?? [],
    );
    expect(inLane(lines, 'OPEN').map((line) => line.id)).toEqual([ncrId(2), ncrId(1)]);
    expect(inLane(lines, 'CLOSED').map((line) => line.id)).toEqual([ncrId(3)]);
    expect(inLane(lines, 'VERIFIED')).toEqual([]);
  });

  it('offers the caller the actions they carry out and the actions they may verify, and only when the server allows it', () => {
    const mine = action(1, { owner: { membership_id: ME, display_name: 'Tôi' } });
    const given = action(2, { status: 'REJECTED', owner: { membership_id: ME, display_name: 'Tôi' } });
    const answered = action(3, { status: 'SUBMITTED', owner: { membership_id: ME, display_name: 'Tôi' } });
    const theirs = action(4);
    const theirsAnswered = action(5, { status: 'SUBMITTED' });
    const line = (patch: Record<string, unknown>) => toNcrLine(ncr(1, { actions: [mine, given, answered, theirs, theirsAnswered], ...patch }));
    expect(answerable(line({ allowed: allowed({ respond: true }) })!, ME).map((item) => item.id)).toEqual([actionId(1), actionId(2)]);
    expect(answerable(line({})!, ME)).toEqual([]);
    expect(verifiable(line({ allowed: allowed({ verify: true }) })!, ME).map((item) => item.id)).toEqual([actionId(5)]);
    expect(verifiable(line({})!, ME)).toEqual([]);
    expect(answerable(line({ allowed: allowed({ respond: true }) })!, undefined)).toEqual([]);
  });
});

describe('raising', () => {
  it('may be done by whoever holds the permission, or when it is not yet known, unless the session is read only', () => {
    expect(canRaise(['ncr.raise'], 'FULL')).toBe(true);
    expect(canRaise(undefined, undefined)).toBe(true);
    expect(canRaise(['ncr.raise'], 'READ_ONLY')).toBe(false);
    expect(canRaise(['quality_nonconformance.read'], 'FULL')).toBe(false);
  });

  it('starts from the day, the contract of the filter and nothing else', () => {
    expect(emptyRaise(TODAY)).toMatchObject({ contractId: '', severity: '', sourceKind: '', dueOn: TODAY });
    expect(emptyRaise(TODAY, contractId(3)).contractId).toBe(contractId(3));
    expect(vietnamToday(new Date('2026-10-25T18:00:00Z'))).toBe('2026-10-26');
    expect(vietnamToday(new Date('2026-10-25T16:59:00Z'))).toBe('2026-10-25');
    expect(vietnamToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('sees what is wrong before it is sent', () => {
    expect(validateRaise(filled(), TODAY)).toEqual({});
    expect(Object.keys(validateRaise(emptyRaise(TODAY), TODAY)).sort()).toEqual(['actionOwnerId', 'contractId', 'description', 'severity', 'sourceKind', 'title']);
    expect(validateRaise(filled({ title: 'x'.repeat(2001) }), TODAY)).toEqual({ title: 'tooLong' });
    expect(validateRaise(filled({ dueOn: '2026-10-24' }), TODAY)).toEqual({ dueOn: 'past' });
    expect(validateRaise(filled({ dueOn: '2026-02-30' }), TODAY)).toEqual({ dueOn: 'date' });
    expect(validateRaise(filled({ dueOn: '' }), TODAY)).toEqual({ dueOn: 'required' });
    expect(validateRaise(filled({ siteDiaryId: 'nope' }), TODAY)).toEqual({ siteDiaryId: 'uuid' });
    expect(validateRaise(filled({ sourceKind: 'INSPECTION' }), TODAY)).toEqual({ inspectionId: 'sourceReference' });
    expect(validateRaise(filled({ sourceKind: 'INSPECTION', inspectionId: 'nope' }), TODAY)).toEqual({ inspectionId: 'uuid' });
    expect(validateRaise(filled({ sourceKind: 'INSPECTION', inspectionId: UUID }), TODAY)).toEqual({});
    expect(validateRaise(filled({ sourceKind: 'MATERIAL_TEST' }), TODAY)).toEqual({ materialTestId: 'sourceReference' });
    expect(validateRaise(filled({ sourceKind: 'MATERIAL_TEST', materialTestId: 'nope' }), TODAY)).toEqual({ materialTestId: 'uuid' });
  });

  it('sends the words trimmed, the day as the end of the day in Vietnam, and the record only for its own source', () => {
    expect(raiseBody(filled())).toEqual({
      contract_id: contractId(2),
      severity: 'CRITICAL',
      title: 'Lớp bảo vệ thiếu',
      description: 'Đo được 30 mm.',
      source_kind: 'SUPERVISOR_REMARK',
      action_owner_id: memberId(1),
      due_at: '2026-11-05T16:59:00.000Z',
    });
    expect(raiseBody(filled({ sourceKind: 'INSPECTION', inspectionId: ` ${UUID.toUpperCase()} `, materialTestId: UUID }))).toMatchObject({ inspection_id: UUID });
    expect(raiseBody(filled({ sourceKind: 'INSPECTION', inspectionId: UUID }))).not.toHaveProperty('material_test_id');
    expect(raiseBody(filled({ sourceKind: 'MATERIAL_TEST', materialTestId: UUID, inspectionId: UUID }))).toMatchObject({ material_test_id: UUID });
    expect(raiseBody(filled({ siteDiaryId: ` ${UUID} ` }))).toMatchObject({ site_diary_id: UUID });
    expect(raiseBody(emptyRaise(TODAY))).toMatchObject({ severity: 'MINOR', source_kind: 'SELF_REPORT' });
    expect(endOfDay('2026-11-05')).toBe('2026-11-05T16:59:00.000Z');
    expect(endOfDay('2026-13-05')).toBeUndefined();
  });
});

describe('the other steps', () => {
  it('assigns an action with what is to be done, who does it and a day that is not past', () => {
    const form = { ...emptyAssign(TODAY), description: ' Đổ lại ', ownerId: memberId(2), dueOn: '2026-11-01' };
    expect(validateAssign(form, TODAY)).toEqual({});
    expect(Object.keys(validateAssign(emptyAssign(TODAY), TODAY)).sort()).toEqual(['description', 'ownerId']);
    expect(validateAssign({ ...form, dueOn: '2026-10-01' }, TODAY)).toEqual({ dueOn: 'past' });
    expect(assignBody(form)).toEqual({ description: 'Đổ lại', owner_membership_id: memberId(2), due_at: '2026-11-01T16:59:00.000Z' });
  });

  it('answers with a document or a photo and a note', () => {
    expect(validateEvidence(EMPTY_EVIDENCE)).toEqual({ documentVersionId: 'evidenceRequired', note: 'required' });
    expect(validateEvidence({ documentVersionId: UUID, photoId: '', note: 'Đã đổ lại' })).toEqual({});
    expect(validateEvidence({ documentVersionId: '', photoId: UUID, note: 'Đã đổ lại' })).toEqual({});
    expect(validateEvidence({ documentVersionId: 'nope', photoId: 'nope', note: 'x' })).toEqual({ documentVersionId: 'uuid', photoId: 'uuid' });
    expect(evidenceBody({ documentVersionId: ` ${UUID.toUpperCase()} `, photoId: '', note: ' Xong ' })).toEqual({ note: 'Xong', evidence_document_version_id: UUID });
    expect(evidenceBody({ documentVersionId: '', photoId: UUID, note: 'Xong' })).toEqual({ note: 'Xong', evidence_photo_id: UUID });
  });

  it('verifies with a verdict and a note, and closes or reopens with one note', () => {
    expect(validateVerify(EMPTY_VERIFY)).toEqual({ outcome: 'required', note: 'required' });
    expect(validateVerify({ outcome: 'REJECTED', note: 'Vẫn thiếu' })).toEqual({});
    expect(validateNote('')).toBe('required');
    expect(validateNote('x'.repeat(2001))).toBe('tooLong');
    expect(validateNote('Đã xong')).toBeUndefined();
  });
});

describe('describeProblem', () => {
  it('words every refusal the commands can meet', () => {
    expect(describeProblem(problem('CONTRACT_STATE_INVALID', 409))).toBe('contractState');
    expect(describeProblem(problem('NCR_STATE_INVALID', 409))).toBe('ncrState');
    expect(describeProblem(problem('CORRECTIVE_ACTION_STATE_INVALID', 409))).toBe('actionState');
    expect(describeProblem(problem('CORRECTIVE_ACTION_OPEN'))).toBe('actionsOpen');
    expect(describeProblem(problem('EVIDENCE_REQUIRED'))).toBe('evidenceRequired');
    expect(describeProblem(problem('DOCUMENT_NOT_CLEAN'))).toBe('notClean');
    expect(describeProblem(problem('FILE_NOT_CLEAN'))).toBe('notClean');
    expect(describeProblem(problem('SELF_APPROVAL_DENIED', 403))).toBe('selfApproval');
    expect(describeProblem(problem('VERSION_CONFLICT', 409))).toBe('versionConflict');
    for (const code of ['VALIDATION_FAILED', 'INVALID_REQUEST', 'FIELD_NOT_ALLOWED']) expect(describeProblem(problem(code, 400))).toBe('validation');
    expect(describeProblem(problem('RESOURCE_NOT_FOUND', 404))).toBe('notFound');
    expect(describeProblem(problem('SCOPE_DENIED', 403))).toBe('denied');
    expect(describeProblem(problem('ENTITLEMENT_DENIED', 403))).toBe('denied');
    expect(describeProblem(problem('SESSION_EXPIRED', 401))).toBe('session');
    expect(describeProblem(problem('SOMETHING_ELSE', 500))).toBe('general');
    expect(describeProblem(new Error('x'))).toBe('general');
  });
});
