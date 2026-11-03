import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_REASON,
  chainLink,
  describeProblem,
  emptyEvaluate,
  emptyOpen,
  emptyTiers,
  evaluateBody,
  inStage,
  isIncrease,
  openBody,
  requestLink,
  signedAmountText,
  stagesOf,
  tiersBody,
  tiersLink,
  toChain,
  toRequest,
  validateEvaluate,
  validateOpen,
  validateReason,
  validateTiers,
} from './model';
import type { EvaluateForm, OpenForm } from './model';
import { UUID_A, chain, config, guestRequest, request, requestId } from './test-support';

const problem = (code: string, status = 409, extensions: Record<string, unknown> = {}) => new ApiError({ status, code, correlationId: 'c', extensions });

describe('the tiers of a chain', () => {
  it('lists the tiers a project goes through, from the one a request starts at', () => {
    expect(stagesOf(3)).toEqual(['EVENT', 'PCO', 'CO']);
    expect(stagesOf(2)).toEqual(['PCO', 'CO']);
    expect(stagesOf(1)).toEqual(['CO']);
  });

  it('builds the addresses of the three screens', () => {
    expect(chainLink('p1')).toBe('/ctr/ctr-19?project=p1');
    expect(chainLink('p1', 'c1')).toBe('/ctr/ctr-19?project=p1&contract=c1');
    expect(tiersLink('p1')).toBe('/ctr/ctr-20?project=p1');
    expect(requestLink('c1')).toBe('/ctr/ctr-07?contract=c1');
    expect(requestLink()).toBe('/ctr/ctr-07');
  });

  it('asks for a tier count to be chosen, and sends it as a number', () => {
    expect(validateTiers(emptyTiers(undefined))).toEqual({ tierCount: 'required' });
    expect(validateTiers(emptyTiers(2))).toEqual({});
    expect(emptyTiers(3)).toEqual({ tierCount: '3' });
    expect(tiersBody({ tierCount: '2' })).toEqual({ tier_count: 2 });
    expect(tiersBody({ tierCount: '' })).toEqual({ tier_count: 1 });
  });
});

describe('what the server answers', () => {
  it('reads the chain with its tiers, its requests and what the caller may do', () => {
    const read = toChain(
      chain({
        config: config({ tier_count: 2, stages: ['PCO', 'CO'], locked: true, locked_at: '2026-10-24T01:00:00.000Z', locked_by_change: { id: requestId(1), code: 'PCO-001' } }),
        requests: [request(1, { stage: 'PCO', code: 'PCO-001', actions: { promote: true, evaluate: true, withdraw: false } }), 'junk', { id: 'x' }],
      }),
    );
    expect(read).toMatchObject({
      projectId: '00000000-0000-4000-8000-000100000001',
      config: { tierCount: 2, stages: ['PCO', 'CO'], locked: true, lockedAt: '2026-10-24T01:00:00.000Z', lockedBy: { id: requestId(1), code: 'PCO-001' }, version: 1 },
      canConfigure: true,
      canOpen: true,
    });
    expect(read?.requests).toHaveLength(1);
    expect(read?.requests[0]).toMatchObject({
      code: 'PCO-001',
      stage: 'PCO',
      status: 'SUBMITTED',
      contract: { code: 'HD-A-001', status: 'ACTIVE' },
      actions: { promote: true, evaluate: true, withdraw: false },
      detail: { eventKind: 'OWNER_INSTRUCTION', estimatedDeltaVnd: '400000000', evaluatedDeltaVnd: null, scheduleImpactDays: 10, reason: 'The owner instructed a wider footpath.' },
    });
  });

  it('reads a project with no tiers and no requests, and a chain that is not one', () => {
    const empty = toChain({ project_id: 'p', requests: undefined, actions: undefined });
    expect(empty).toEqual({ projectId: 'p', config: undefined, requests: [], canConfigure: false, canOpen: false });
    expect(toChain(null)).toBeUndefined();
    expect(toChain({})).toBeUndefined();
    expect(toChain(chain({ config: { tier_count: 4 } }))?.config).toBeUndefined();
    expect(toChain(chain({ config: config({ version: 'x' }) }))?.config).toBeUndefined();
  });

  it('reads a guest request without the assessment or the actions, and drops a row that has no place in the chain', () => {
    const [guest] = toRequest(guestRequest(1));
    expect(guest).toMatchObject({ code: 'CE-001', stage: 'EVENT', status: 'SUBMITTED', detail: undefined, actions: undefined });
    expect(toRequest({ ...guestRequest(1), stage: 'MIDDLE' })).toEqual([]);
    expect(toRequest({ ...guestRequest(1), status: 'LOST' })).toEqual([]);
    expect(toRequest({ ...guestRequest(1), contract: null })).toEqual([]);
    expect(toRequest({ ...guestRequest(1), version: '1' })).toEqual([]);
    expect(toRequest(null)).toEqual([]);
  });

  it('reads an event kind it does not know as none, and a missing code as null', () => {
    const [read] = toRequest(request(1, { event_kind: 'WHIM', code: null, schedule_impact_days: 'x', parent_id: requestId(2) }));
    expect(read).toMatchObject({ code: null, parentId: requestId(2), detail: { eventKind: null, scheduleImpactDays: 0 } });
  });

  it('groups the requests by tier', () => {
    const read = toChain(chain({ requests: [request(1), request(2, { stage: 'PCO' }), request(3)] }));
    expect(inStage(read?.requests ?? [], 'EVENT').map((r) => r.code)).toEqual(['CE-001', 'CE-003']);
    expect(inStage(read?.requests ?? [], 'CO')).toEqual([]);
  });

  it('writes a signed amount with the digits grouped, and never as a float', () => {
    expect(signedAmountText('400000000', 'vi')).toBe('400.000.000');
    expect(signedAmountText('-3000000', 'en')).toBe('-3,000,000');
    expect(signedAmountText('123456789012345678901234', 'en')).toBe('123,456,789,012,345,678,901,234');
    expect(signedAmountText('1.5', 'en')).toBe('1.5');
    expect(signedAmountText(null, 'en')).toBeNull();
  });
});

describe('the form that raises a request', () => {
  const form = (overrides: Partial<OpenForm> = {}): OpenForm => ({ ...emptyOpen(UUID_A), reason: 'A wider footpath.', ...overrides });

  it('asks for the baseline and the reason, and for nothing else', () => {
    expect(validateOpen(form())).toEqual({});
    expect(validateOpen(emptyOpen(''))).toEqual({ baselineRevisionId: 'required', reason: 'required' });
    expect(validateOpen(form({ baselineRevisionId: 'nope' }))).toEqual({ baselineRevisionId: 'uuid' });
    expect(validateOpen(form({ reason: '   ' }))).toEqual({ reason: 'required' });
    expect(validateOpen(form({ reason: 'x'.repeat(2001) }))).toEqual({ reason: 'tooLong' });
    expect(validateOpen(form({ reason: 'x'.repeat(2000) }))).toEqual({});
  });

  it('accepts a signed whole amount and a signed whole number of days within a hundred years', () => {
    expect(validateOpen(form({ estimatedDeltaVnd: '-400000000', scheduleImpactDays: '-5' }))).toEqual({});
    expect(validateOpen(form({ estimatedDeltaVnd: '1.5' }))).toEqual({ estimatedDeltaVnd: 'amount' });
    expect(validateOpen(form({ estimatedDeltaVnd: 'x' }))).toEqual({ estimatedDeltaVnd: 'amount' });
    expect(validateOpen(form({ scheduleImpactDays: '2.5' }))).toEqual({ scheduleImpactDays: 'days' });
    expect(validateOpen(form({ scheduleImpactDays: '36501' }))).toEqual({ scheduleImpactDays: 'days' });
    expect(validateOpen(form({ scheduleImpactDays: '36500' }))).toEqual({});
  });

  it('writes the body the server expects: the tier, the baseline, and only what was said', () => {
    expect(openBody(form(), 'PCO')).toEqual({ stage: 'PCO', baseline_revision_id: UUID_A, reason: 'A wider footpath.' });
    expect(openBody(form({ baselineRevisionId: UUID_A.toUpperCase(), eventKind: 'DESIGN_CHANGE', reason: '  A wider footpath.  ', estimatedDeltaVnd: ' -0400 ', scheduleImpactDays: ' 10 ' }), 'EVENT')).toEqual({
      stage: 'EVENT',
      baseline_revision_id: UUID_A,
      event_kind: 'DESIGN_CHANGE',
      reason: 'A wider footpath.',
      estimated_delta_vnd: '-400',
      schedule_impact_days: 10,
    });
  });
});

describe('the reason of a promotion or a withdrawal', () => {
  it('may not be empty or longer than 2000 characters', () => {
    expect(validateReason(EMPTY_REASON)).toEqual({ reason: 'required' });
    expect(validateReason({ reason: ' ' })).toEqual({ reason: 'required' });
    expect(validateReason({ reason: 'x'.repeat(2001) })).toEqual({ reason: 'tooLong' });
    expect(validateReason({ reason: 'Agreed.' })).toEqual({});
  });
});

describe('the assessment of a request', () => {
  const form = (overrides: Partial<EvaluateForm> = {}): EvaluateForm => ({ evaluatedDeltaVnd: '500000000', scheduleImpactDays: '20', fundingImpactNote: 'Paid from the plan.', scopeImpactNote: '', allocationLineId: UUID_A, ...overrides });

  it('starts from the last assessment, or the estimate, or nothing', () => {
    const [assessed] = toRequest(request(1, { evaluated_delta_vnd: '450000000', funding_impact_note: 'Revised.', scope_impact_note: 'Km 2.', allocation_line_id: UUID_A, schedule_impact_days: 12 }));
    expect(emptyEvaluate(assessed!)).toEqual({ evaluatedDeltaVnd: '450000000', scheduleImpactDays: '12', fundingImpactNote: 'Revised.', scopeImpactNote: 'Km 2.', allocationLineId: UUID_A });
    const [estimated] = toRequest(request(1));
    expect(emptyEvaluate(estimated!)).toEqual({ evaluatedDeltaVnd: '400000000', scheduleImpactDays: '10', fundingImpactNote: '', scopeImpactNote: '', allocationLineId: '' });
    const [guest] = toRequest(guestRequest(1));
    expect(emptyEvaluate(guest!)).toEqual({ evaluatedDeltaVnd: '', scheduleImpactDays: '', fundingImpactNote: '', scopeImpactNote: '', allocationLineId: '' });
  });

  it('asks for the amount, the days and the funding, and for the line only when the value increases', () => {
    expect(validateEvaluate(form())).toEqual({});
    expect(validateEvaluate({ evaluatedDeltaVnd: '', scheduleImpactDays: '', fundingImpactNote: '', scopeImpactNote: '', allocationLineId: '' })).toEqual({
      evaluatedDeltaVnd: 'required',
      scheduleImpactDays: 'required',
      fundingImpactNote: 'required',
    });
    expect(validateEvaluate(form({ evaluatedDeltaVnd: 'x' }))).toEqual({ evaluatedDeltaVnd: 'amount' });
    expect(validateEvaluate(form({ scheduleImpactDays: '1.5' }))).toEqual({ scheduleImpactDays: 'days' });
    expect(validateEvaluate(form({ fundingImpactNote: 'x'.repeat(2001) }))).toEqual({ fundingImpactNote: 'tooLong' });
    expect(validateEvaluate(form({ scopeImpactNote: 'x'.repeat(2001) }))).toEqual({ scopeImpactNote: 'tooLong' });
    expect(validateEvaluate(form({ allocationLineId: '' }))).toEqual({ allocationLineId: 'required' });
    expect(validateEvaluate(form({ allocationLineId: '', evaluatedDeltaVnd: '-5' }))).toEqual({});
    expect(validateEvaluate(form({ allocationLineId: '', evaluatedDeltaVnd: '0' }))).toEqual({});
    expect(validateEvaluate(form({ allocationLineId: 'nope', evaluatedDeltaVnd: '-5' }))).toEqual({ allocationLineId: 'uuid' });
  });

  it('knows an increase from a decrease, an unchanged value and a word', () => {
    expect(isIncrease('1')).toBe(true);
    expect(isIncrease(' 500000000 ')).toBe(true);
    expect(isIncrease('0')).toBe(false);
    expect(isIncrease('-1')).toBe(false);
    expect(isIncrease('x')).toBe(false);
    expect(isIncrease('')).toBe(false);
  });

  it('writes the body: the amount as a plain number, the optional parts only when they were said', () => {
    expect(evaluateBody(form())).toEqual({ evaluated_delta_vnd: '500000000', schedule_impact_days: 20, funding_impact_note: 'Paid from the plan.', allocation_line_id: UUID_A });
    expect(evaluateBody(form({ evaluatedDeltaVnd: ' -007 ', scheduleImpactDays: ' -3 ', scopeImpactNote: ' Km 2. ', allocationLineId: '' }))).toEqual({
      evaluated_delta_vnd: '-7',
      schedule_impact_days: -3,
      funding_impact_note: 'Paid from the plan.',
      scope_impact_note: 'Km 2.',
    });
    expect(evaluateBody(form({ allocationLineId: UUID_A.toUpperCase() })).allocation_line_id).toBe(UUID_A);
  });
});

describe('the refusals of the server in the words of the screen', () => {
  it.each([
    [problem('CHANGE_TIERS_LOCKED'), 'tiersLocked'],
    [problem('CHANGE_STAGE_NOT_ALLOWED', 422, { reason: 'TIERS_NOT_CONFIGURED' }), 'notConfigured'],
    [problem('CHANGE_STAGE_NOT_ALLOWED', 422, { reason: 'LAST_TIER' }), 'lastTier'],
    [problem('CHANGE_STAGE_NOT_ALLOWED', 422, { reason: 'STAGE_NOT_EVALUATED' }), 'notEvaluated'],
    [problem('CHANGE_STAGE_NOT_ALLOWED', 422, { allowed_stage: 'PCO', tier_count: 2 }), 'wrongStage'],
    [problem('CHANGE_STAGE_NOT_ALLOWED', 422, { reason: 'ONLY_CO_DECIDED' }), 'onlyCo'],
    [problem('SELF_APPROVAL_DENIED', 403), 'selfApproval'],
    [problem('RETROACTIVE_NOT_ALLOWED', 422), 'retroactive'],
    [problem('ACCEPTANCE_VALUE_EXCEEDS_CONTRACT', 422), 'floor'],
    [problem('DECISION_DOCUMENT_REQUIRED', 422), 'decisionDocument'],
    [problem('BOQ_TOTAL_MISMATCH', 422), 'boqMismatch'],
    [problem('SCOPE_DENIED', 403, { approver_role_id: 'role' }), 'delegation'],
    [problem('CHANGE_STATE_INVALID'), 'stateInvalid'],
    [problem('CONTRACT_STATE_INVALID'), 'contractState'],
    [problem('ALLOCATION_UNAVAILABLE', 422, { reason: 'ALLOCATION_LINE_REQUIRED' }), 'lineRequired'],
    [problem('ALLOCATION_UNAVAILABLE', 422, { reason: 'ABOVE_BLOCK' }), 'allocation'],
    [problem('CONTRACT_STATE_INVALID', 409, { reason: 'REVISION_PENDING' }), 'revisionPending'],
    [problem('SETTLEMENT_ALREADY_APPROVED'), 'settlementApproved'],
    [problem('VALUE_EXCEEDED', 409, { rule: 'REQUESTED_LE_ACCEPTED' }), 'valueExceeded'],
    [problem('ACCEPTANCE_STATE_INVALID', 409, { reason: 'NOT_ON_LEDGER' }), 'notOnLedger'],
    [problem('ACCEPTANCE_STATE_INVALID', 409, { reason: 'RETROACTIVELY_ADJUSTED' }), 'general'],
    [problem('VALIDATION_FAILED', 422, { reason: 'NOT_RETROACTIVE' }), 'notRetroactive'],
    [problem('VALIDATION_FAILED', 422, { reason: 'BEFORE_CONTRACT' }), 'beforeContract'],
    [problem('VALIDATION_FAILED', 422, { reason: 'NOT_AFTER_REVISION' }), 'afterRevision'],
    [problem('VALIDATION_FAILED', 422, { reason: 'AFFECTED_MISMATCH' }), 'affectedMismatch'],
    [problem('VERSION_CONFLICT'), 'versionConflict'],
    [problem('VALIDATION_FAILED', 422), 'validation'],
    [problem('INVALID_REQUEST', 400), 'validation'],
    [problem('FIELD_NOT_ALLOWED', 400), 'validation'],
    [problem('RESOURCE_NOT_FOUND', 404), 'notFound'],
    [problem('SCOPE_DENIED', 403), 'denied'],
    [problem('ENTITLEMENT_DENIED', 403), 'denied'],
    [problem('SESSION_EXPIRED', 401), 'session'],
    [problem('SOMETHING_ELSE', 500), 'general'],
    [new Error('boom'), 'general'],
  ])('%#: names the problem', (error, expected) => {
    expect(describeProblem(error).problem).toBe(expected);
  });

  it('carries the tier the chain starts at when the server said it', () => {
    expect(describeProblem(problem('CHANGE_STAGE_NOT_ALLOWED', 422, { allowed_stage: 'PCO' }))).toEqual({ problem: 'wrongStage', stage: 'PCO' });
    expect(describeProblem(problem('CHANGE_STAGE_NOT_ALLOWED', 422, { allowed_stage: 'MIDDLE' })).stage).toBeUndefined();
  });
});
