import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { describeProblem, emptyRelease, releaseBody, toHold, toHolds, validateRelease } from './model';
import type { HoldLine, ReleaseForm } from './model';
import { DECISION, hold, holdId, world } from './test-support';

const problem = (code: string, extensions: Record<string, unknown> = {}, status = 422) => new ApiError({ status, code, correlationId: 'c', extensions });
const line = (overrides: Record<string, unknown> = {}): HoldLine => toHold(hold(1, overrides)) as HoldLine;
const form = (overrides: Partial<ReleaseForm> = {}): ReleaseForm => ({ amount: ' 100000000 ', reason: ' Hết bảo hành ', decision: '', ...overrides });

describe('toHold', () => {
  it('reads a hold with its item, what is held, released and left, the condition, why it is not met, and whether the caller may release it', () => {
    expect(toHold(hold(1, { release_not_before: '2028-03-01', allowed: { release: true }, decision_document_version_id: DECISION }))).toEqual({
      id: holdId(1),
      item: { id: expect.any(String), key: 'B01', description: 'Hạng mục 1' },
      heldVnd: '100000000',
      releasedVnd: '0',
      leftVnd: '100000000',
      condition: 'WARRANTY_END',
      releaseNotBefore: '2028-03-01',
      status: 'HELD',
      blocker: 'WARRANTY_OPEN',
      releasedAt: null,
      releaseReason: null,
      hasDecision: true,
      canRelease: true,
      version: 1,
    });
    expect(toHold(hold(1, { condition: { met: true, reason: null } }))?.blocker).toBeNull();
  });

  it('keeps what is missing as nothing and refuses what cannot be shown', () => {
    expect(toHold({ ...hold(1), boq_item: { id: 'i' }, left_vnd: undefined, allowed: null, condition: null })).toMatchObject({
      item: { key: '', description: '' },
      leftVnd: '0',
      canRelease: false,
      blocker: null,
    });
    expect(toHold(null)).toBeUndefined();
    expect(toHold({ ...hold(1), status: 'GONE' })).toBeUndefined();
    expect(toHold({ ...hold(1), release_condition: 'ALWAYS' })).toBeUndefined();
    expect(toHold({ ...hold(1), version: 'one' })).toBeUndefined();
    expect(toHold({ ...hold(1), id: 7 })).toBeUndefined();
    expect(toHold({ ...hold(1), boq_item: {} })).toBeUndefined();
    expect(toHold({ ...hold(1), held_vnd: undefined })).toBeUndefined();
    expect(toHold({ ...hold(1), released_vnd: undefined })).toBeUndefined();
  });

  it('reads the contract with its totals and the holds it can show', () => {
    const state = world({ holds: [hold(1), { id: 'x' }, hold(2)] });
    expect(toHolds({ contract: state.contract, items: state.holds })).toMatchObject({
      contract: { id: expect.any(String), code: 'HD-A-001', status: 'COMPLETED', heldVnd: '150000000', releasedVnd: '0' },
      items: [{ id: holdId(1) }, { id: holdId(2) }],
    });
    expect(toHolds({ contract: { id: 'c' }, items: [] })).toEqual({ contract: { id: 'c', code: '', status: '', heldVnd: '0', releasedVnd: '0' }, items: [] });
    expect(toHolds(null)).toBeUndefined();
    expect(toHolds({ contract: {}, items: [] })).toBeUndefined();
    expect(toHolds({ contract: { id: 'c' }, items: 'none' })).toBeUndefined();
  });
});

describe('releasing', () => {
  it('opens with everything that is still held', () => {
    expect(emptyRelease(line({ left_vnd: '60000000' }))).toEqual({ amount: '60000000', reason: '', decision: '' });
  });

  it('sees what is wrong before it is sent: an amount in whole dong above nothing and at most what is left, and a reason', () => {
    expect(validateRelease(form(), line())).toEqual({});
    expect(validateRelease(form({ amount: '', reason: '' }), line())).toEqual({ amount: 'required', reason: 'required' });
    for (const amount of ['0', '000', '-1', '12.5', 'x', '1'.repeat(25)]) expect(validateRelease(form({ amount }), line())).toEqual({ amount: 'amount' });
    expect(validateRelease(form({ amount: '100000001' }), line())).toEqual({ amount: 'exceeds' });
    expect(validateRelease(form({ amount: '1' }), line())).toEqual({});
    expect(validateRelease(form({ reason: 'x'.repeat(2001) }), line())).toEqual({ reason: 'tooLong' });
  });

  it('needs the decision of the authority attached when that is the condition and none is, and only then', () => {
    const waiting = line({ release_condition: 'MANUAL_DECISION' });
    expect(validateRelease(form(), waiting)).toEqual({ decision: 'required' });
    expect(validateRelease(form({ decision: DECISION }), waiting)).toEqual({});
    expect(validateRelease(form({ decision: 'nope' }), waiting)).toEqual({ decision: 'uuid' });
    expect(validateRelease(form(), line({ release_condition: 'MANUAL_DECISION', decision_document_version_id: DECISION }))).toEqual({});
    expect(validateRelease(form(), line({ release_condition: 'COMPLETION' }))).toEqual({});
    expect(validateRelease(form({ decision: 'nope' }), line())).toEqual({ decision: 'uuid' });
  });

  it('sends the amount and the reason trimmed, and the decision in lower case when there is one', () => {
    expect(releaseBody(form())).toEqual({ amount_vnd: '100000000', reason: 'Hết bảo hành' });
    expect(releaseBody(form({ amount: '0007', decision: ` ${DECISION.toUpperCase()} ` }))).toEqual({ amount_vnd: '7', reason: 'Hết bảo hành', decision_document_version_id: DECISION });
  });
});

describe('describeProblem', () => {
  const none = { blocker: undefined, leftVnd: undefined, notBefore: undefined };

  it('words every refusal the release can meet, and keeps what the condition waits for and what is left', () => {
    expect(describeProblem(problem('RELEASE_CONDITION_NOT_MET', { reason: 'NOT_BEFORE', release_not_before: '2028-03-01' }))).toEqual({
      problem: 'conditionNotMet',
      blocker: 'NOT_BEFORE',
      leftVnd: undefined,
      notBefore: '2028-03-01',
    });
    expect(describeProblem(problem('RELEASE_CONDITION_NOT_MET', { reason: 'WARRANTY_OPEN' }))).toEqual({
      problem: 'conditionNotMet',
      blocker: 'WARRANTY_OPEN',
      leftVnd: undefined,
      notBefore: undefined,
    });
    expect(describeProblem(problem('RELEASE_CONDITION_NOT_MET'))).toEqual({ problem: 'conditionNotMet', ...none });
    expect(describeProblem(problem('RELEASE_EXCEEDS_HELD', { left_vnd: '60000000' }))).toEqual({ problem: 'exceedsHeld', blocker: undefined, leftVnd: '60000000', notBefore: undefined });
    expect(describeProblem(problem('SELF_APPROVAL_DENIED', {}, 403))).toEqual({ problem: 'selfApproval', ...none });
    expect(describeProblem(problem('DOCUMENT_NOT_CLEAN')).problem).toBe('notClean');
    expect(describeProblem(problem('VERSION_CONFLICT', {}, 409)).problem).toBe('versionConflict');
    expect(describeProblem(problem('PAYMENT_STATE_INVALID', {}, 409)).problem).toBe('paymentState');
    for (const code of ['VALIDATION_FAILED', 'INVALID_REQUEST', 'FIELD_NOT_ALLOWED']) expect(describeProblem(problem(code, {}, 400)).problem).toBe('validation');
    expect(describeProblem(problem('RESOURCE_NOT_FOUND', {}, 404)).problem).toBe('notFound');
    expect(describeProblem(problem('SCOPE_DENIED', {}, 403)).problem).toBe('denied');
    expect(describeProblem(problem('ENTITLEMENT_DENIED', {}, 403)).problem).toBe('denied');
    expect(describeProblem(problem('SESSION_EXPIRED', {}, 401)).problem).toBe('session');
    expect(describeProblem(problem('SOMETHING_ELSE', {}, 500)).problem).toBe('general');
    expect(describeProblem(new Error('x')).problem).toBe('general');
  });
});
