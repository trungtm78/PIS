import type { DomainError } from '../src/errors.ts';
import { DECISION_LIMITS, STATUS_AFTER, correctionOf, correctionSourceRefusal, decisionOf, decisionOutcome } from '../src/dis-decision.ts';

const NOW = new Date('2026-10-26T03:00:00.000Z');
const LATER = '2026-11-02T03:00:00.000Z';
const ID = '6f1c1f0a-0f2b-4f6e-9a5e-3d0a7a3c9b11';

function refusal(work: () => unknown): { code: string; status: number; detail?: string } {
  try {
    work();
  } catch (error) {
    const e = error as DomainError;
    return { code: e.code, status: e.status, ...(e.detail === undefined ? {} : { detail: e.detail }) };
  }
  throw new Error('expected a refusal');
}

describe('the decision of a reviewer on a weekly report (ST-DIS-006, DIS 3 F2)', () => {
  it('reads an approval: the reason and the evidence, with nothing to return', () => {
    expect(decisionOf({ decision: 'approve', reason: '  Figures agree with the Treasury.  ', evidence_ids: [ID.toUpperCase()] }, NOW)).toEqual({
      decision: 'approve',
      reason: 'Figures agree with the Treasury.',
      evidenceIds: [ID],
      returnItems: [],
      dueAt: null,
    });
  });

  it('AC-ST-DIS-006-3 / UAT-AC260: a return names what to fix and by when: the items are required (422 on return_items), and so is a due date after the decision', () => {
    expect(refusal(() => decisionOf({ decision: 'return', reason: 'Not right.', evidence_ids: [] }, NOW))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'return_items' });
    expect(refusal(() => decisionOf({ decision: 'return', reason: 'Not right.', evidence_ids: [], return_items: [] }, NOW))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'return_items' });
    expect(refusal(() => decisionOf({ decision: 'return', reason: 'Not right.', evidence_ids: [], return_items: ['Fix the CTMTQG cell'] }, NOW))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'due_at' });
    expect(refusal(() => decisionOf({ decision: 'return', reason: 'Not right.', evidence_ids: [], return_items: ['Fix the CTMTQG cell'], due_at: NOW.toISOString() }, NOW))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'due_at' });
    const done = decisionOf({ decision: 'return', reason: 'Not right.', evidence_ids: [], return_items: ['  Fix the CTMTQG cell  ', 'Explain the fall'], due_at: LATER }, NOW);
    expect(done).toMatchObject({ decision: 'return', returnItems: ['Fix the CTMTQG cell', 'Explain the fall'] });
    expect(done.dueAt?.toISOString()).toBe(LATER);
  });

  it('judges each item of a return and the number of them', () => {
    const base = { decision: 'return', reason: 'Not right.', evidence_ids: [], due_at: LATER } as const;
    expect(refusal(() => decisionOf({ ...base, return_items: ['ab'] }, NOW))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'return_items[0]' });
    expect(refusal(() => decisionOf({ ...base, return_items: ['Fine item', 'x'.repeat(DECISION_LIMITS.itemMax + 1)] }, NOW))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'return_items[1]' });
    expect(refusal(() => decisionOf({ ...base, return_items: Array.from({ length: DECISION_LIMITS.itemsMax + 1 }, (_, n) => `Item number ${n}`) }, NOW))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'return_items' });
    expect(refusal(() => decisionOf({ ...base, return_items: ['Same item', 'same item'] }, NOW))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'return_items[1]' });
    expect(refusal(() => decisionOf({ ...base, return_items: [7 as unknown as string] }, NOW))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'return_items[0]' });
  });

  it('asks for a reason in words, evidence that is ids, and a date that is a date', () => {
    expect(refusal(() => decisionOf({ decision: 'approve', reason: '   ', evidence_ids: [] }, NOW))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'reason' });
    expect(refusal(() => decisionOf({ decision: 'approve', reason: 'x'.repeat(DECISION_LIMITS.reasonMax + 1), evidence_ids: [] }, NOW))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'reason' });
    expect(refusal(() => decisionOf({ decision: 'approve', reason: 'Fine.', evidence_ids: ['nope'] }, NOW))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'evidence_ids[0]' });
    expect(refusal(() => decisionOf({ decision: 'approve', reason: 'Fine.', evidence_ids: [ID, ID.toUpperCase()] }, NOW))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'evidence_ids[1]' });
    expect(refusal(() => decisionOf({ decision: 'approve', reason: 'Fine.', evidence_ids: Array.from({ length: DECISION_LIMITS.evidenceMax + 1 }, (_, n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`) }, NOW))).toEqual({
      code: 'VALIDATION_FAILED',
      status: 422,
      detail: 'evidence_ids',
    });
    expect(refusal(() => decisionOf({ decision: 'return', reason: 'Fine.', evidence_ids: [], return_items: ['Fix the cell'], due_at: 'next week' }, NOW))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'due_at' });
  });

  it('knows the decisions of the state machine only: a rejection is not one, and an approval carries no list to fix', () => {
    expect(refusal(() => decisionOf({ decision: 'reject', reason: 'No.', evidence_ids: [] }, NOW))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'decision' });
    expect(refusal(() => decisionOf({ decision: 'approve', reason: 'Fine.', evidence_ids: [], return_items: ['Fix the cell'] }, NOW))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'return_items' });
    expect(refusal(() => decisionOf({ decision: 'approve', reason: 'Fine.', evidence_ids: [], due_at: LATER }, NOW))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'due_at' });
  });

  it('asks for an amendment of an accepted report with a reason, with the items and the date when it names them', () => {
    expect(decisionOf({ decision: 'request_amendment', reason: 'The Treasury corrected a payment.', evidence_ids: [] }, NOW)).toMatchObject({ decision: 'request_amendment', returnItems: [], dueAt: null });
    const named = decisionOf({ decision: 'request_amendment', reason: 'The Treasury corrected a payment.', evidence_ids: [], return_items: ['Re-enter the central cell'], due_at: LATER }, NOW);
    expect(named.returnItems).toEqual(['Re-enter the central cell']);
    expect(named.dueAt?.toISOString()).toBe(LATER);
    expect(refusal(() => decisionOf({ decision: 'request_amendment', reason: 'Treasury.', evidence_ids: [], due_at: NOW.toISOString() }, NOW))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'due_at' });
  });

  it('moves a report along the graph: SUBMITTED or UNDER_REVIEW to ACCEPTED or RETURNED, ACCEPTED to AMENDMENT_REQUESTED, and nothing else (409 REPORT_STATE_INVALID)', () => {
    for (const status of ['SUBMITTED', 'UNDER_REVIEW'] as const) {
      expect(decisionOutcome(status, 'approve')).toBe('ACCEPTED');
      expect(decisionOutcome(status, 'return')).toBe('RETURNED');
      expect(refusal(() => decisionOutcome(status, 'request_amendment'))).toEqual({ code: 'REPORT_STATE_INVALID', status: 409, detail: 'status' });
    }
    expect(decisionOutcome('ACCEPTED', 'request_amendment')).toBe('AMENDMENT_REQUESTED');
    for (const status of ['DRAFT', 'ACCEPTED', 'RETURNED', 'AMENDMENT_REQUESTED', 'WITHDRAWN', 'SUPERSEDED'] as const) {
      expect(refusal(() => decisionOutcome(status, 'approve'))).toEqual({ code: 'REPORT_STATE_INVALID', status: 409, detail: 'status' });
      expect(refusal(() => decisionOutcome(status, 'return'))).toEqual({ code: 'REPORT_STATE_INVALID', status: 409, detail: 'status' });
    }
    for (const status of ['DRAFT', 'RETURNED', 'AMENDMENT_REQUESTED', 'WITHDRAWN', 'SUPERSEDED'] as const) {
      expect(refusal(() => decisionOutcome(status, 'request_amendment'))).toEqual({ code: 'REPORT_STATE_INVALID', status: 409, detail: 'status' });
    }
    expect(STATUS_AFTER).toEqual({ approve: 'ACCEPTED', return: 'RETURNED', request_amendment: 'AMENDMENT_REQUESTED' });
  });
});

describe('the correction of a report that was handed in (ST-DIS-006)', () => {
  it('AC-ST-DIS-006-2 / UAT-AC247: a correction states why, in words (422 CORRECTION_REASON_REQUIRED naming amendment_reason)', () => {
    expect(correctionOf({ amendment_reason: '  The Treasury corrected a payment of March.  ' })).toEqual({ amendmentReason: 'The Treasury corrected a payment of March.' });
    for (const reason of [undefined, '', '   ', 'too short', 'x'.repeat(DECISION_LIMITS.reasonMax + 1), 5]) {
      expect(refusal(() => correctionOf({ amendment_reason: reason as string }))).toEqual({ code: 'CORRECTION_REASON_REQUIRED', status: 422, detail: 'amendment_reason' });
    }
  });

  it('is made from a report that was accepted, returned, asked to be amended or withdrawn, and from no other (409 REPORT_STATE_INVALID)', () => {
    for (const status of ['ACCEPTED', 'RETURNED', 'AMENDMENT_REQUESTED', 'WITHDRAWN'] as const) expect(correctionSourceRefusal(status)).toBeUndefined();
    for (const status of ['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'SUPERSEDED'] as const) {
      expect(correctionSourceRefusal(status)).toMatchObject({ code: 'REPORT_STATE_INVALID', status: 409, detail: 'status' });
    }
  });
});
