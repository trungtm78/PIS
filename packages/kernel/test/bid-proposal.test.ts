import {
  CONFLICT_DECISIONS,
  PROPOSAL_PARTS,
  PROPOSAL_STATUSES,
  conflictStanding,
  declarationStanding,
  milestoneMoment,
  proposalView,
  receiptRefusal,
  standingOpens,
} from '../src/bid-proposal';

const NOW = new Date('2026-11-11T08:00:00.000Z');
const OPENING = '2026-11-12T02:00:00.000Z';
const WINDOW = { openingAt: OPENING, closingAt: '2026-11-12T01:00:00.000Z' };
const NT1 = '00000000-0000-4000-8000-0000000000a1';
const NT2 = '00000000-0000-4000-8000-0000000000a2';

describe('the sealed proposal (ST-BID-004)', () => {
  it('names the parts of a bid, the states of a proposal and the three decisions of a conflict', () => {
    expect(PROPOSAL_PARTS).toEqual(['LEGAL', 'TECHNICAL', 'FINANCIAL', 'OTHER']);
    expect(PROPOSAL_STATUSES).toEqual(['RECEIVED', 'SUPERSEDED', 'WITHDRAWN']);
    expect(CONFLICT_DECISIONS).toEqual(['ALLOWED', 'RECUSED', 'BLOCKED']);
  });

  describe('the moment a milestone counts from', () => {
    it('is the day it happened, else the day it is planned for, else none', () => {
      expect(milestoneMoment({ plannedAt: '2026-11-12T02:00:00.000Z', actualAt: '2026-11-12T03:00:00.000Z' })).toBe('2026-11-12T03:00:00.000Z');
      expect(milestoneMoment({ plannedAt: '2026-11-12T02:00:00.000Z', actualAt: null })).toBe('2026-11-12T02:00:00.000Z');
      expect(milestoneMoment({ plannedAt: null, actualAt: null })).toBeNull();
      expect(milestoneMoment(undefined)).toBeNull();
    });
  });

  describe('whether a proposal is received', () => {
    it('is received while the bids are open and the proposal was handed in before the closing', () => {
      expect(receiptRefusal(WINDOW, '2026-11-10T02:00:00.000Z', NOW)).toBeUndefined();
      expect(receiptRefusal(WINDOW, '2026-11-12T01:00:00.000Z', new Date('2026-11-12T01:30:00.000Z'))).toBeUndefined();
    });

    it('is refused without a date for the opening, because there is no moment to unseal it at', () => {
      expect(receiptRefusal({ openingAt: null, closingAt: null }, '2026-11-10T02:00:00.000Z', NOW)).toBe('BID_OPENING_UNSET');
      expect(receiptRefusal({ openingAt: null, closingAt: '2026-11-12T01:00:00.000Z' }, '2026-11-10T02:00:00.000Z', NOW)).toBe('BID_OPENING_UNSET');
    });

    it('is refused once the bids are opened, whatever time the clerk says it was handed in', () => {
      expect(receiptRefusal(WINDOW, '2026-11-12T00:30:00.000Z', new Date(OPENING))).toBe('BID_CLOSED');
      expect(receiptRefusal(WINDOW, '2026-11-12T00:30:00.000Z', new Date('2026-11-13T00:00:00.000Z'))).toBe('BID_CLOSED');
    });

    it('is refused when it was handed in after the closing, and the opening is the closing when the package has none', () => {
      expect(receiptRefusal(WINDOW, '2026-11-12T01:00:00.001Z', new Date('2026-11-12T01:30:00.000Z'))).toBe('BID_CLOSED');
      expect(receiptRefusal({ openingAt: OPENING, closingAt: null }, '2026-11-12T01:59:00.000Z', new Date('2026-11-12T01:59:30.000Z'))).toBeUndefined();
      expect(receiptRefusal({ openingAt: OPENING, closingAt: null }, '2026-11-12T02:00:01.000Z', new Date('2026-11-12T01:59:30.000Z'))).toBe('BID_CLOSED');
    });

    it('is refused when the hand-in time is in the future beyond the skew of the clocks', () => {
      expect(receiptRefusal(WINDOW, '2026-11-11T08:04:00.000Z', NOW)).toBeUndefined();
      expect(receiptRefusal(WINDOW, '2026-11-11T08:06:00.000Z', NOW)).toBe('SUBMITTED_IN_FUTURE');
    });
  });

  describe('what a declaration means for the proposal of a contractor', () => {
    const conflict = (decision: 'ALLOWED' | 'RECUSED' | 'BLOCKED' | null, contractorId: string | null = NT1) => ({ hasConflict: true, decision, contractorId });

    it('is undeclared when nothing was declared, and clear when no conflict was', () => {
      expect(conflictStanding(undefined, NT1)).toBe('UNDECLARED');
      expect(conflictStanding({ hasConflict: false, decision: null, contractorId: null }, NT1)).toBe('CLEAR');
    });

    it('shuts the member out of the contractor of an undecided conflict, and not out of the others', () => {
      expect(conflictStanding(conflict(null), NT1)).toBe('PENDING');
      expect(conflictStanding(conflict(null), NT2)).toBe('CLEAR');
      expect(conflictStanding(conflict(null), NT1.toUpperCase())).toBe('PENDING');
    });

    it('shuts the member out of every contractor when the conflict names none', () => {
      expect(conflictStanding(conflict(null, null), NT2)).toBe('PENDING');
      expect(conflictStanding(conflict('RECUSED', null), NT2)).toBe('RECUSED');
    });

    it('recuses the member from the contractor of the relation and blocks them from the whole package on a block', () => {
      expect(conflictStanding(conflict('RECUSED'), NT1)).toBe('RECUSED');
      expect(conflictStanding(conflict('RECUSED'), NT2)).toBe('CLEAR');
      expect(conflictStanding(conflict('BLOCKED'), NT1)).toBe('BLOCKED');
      expect(conflictStanding(conflict('BLOCKED'), NT2)).toBe('BLOCKED');
    });

    it('opens what an approver allowed, whichever contractor it is', () => {
      expect(conflictStanding(conflict('ALLOWED'), NT1)).toBe('ALLOWED');
      expect(conflictStanding(conflict('ALLOWED', null), NT2)).toBe('ALLOWED');
    });

    it('opens the proposal only to a member with no conflict or an allowed one', () => {
      expect((['UNDECLARED', 'CLEAR', 'ALLOWED', 'PENDING', 'RECUSED', 'BLOCKED'] as const).filter(standingOpens)).toEqual(['CLEAR', 'ALLOWED']);
    });

    it('says what the whole declaration is, for the approver', () => {
      expect(declarationStanding({ hasConflict: false, decision: null, contractorId: null })).toBe('CLEAR');
      expect(declarationStanding(conflict(null))).toBe('PENDING');
      expect(declarationStanding(conflict('ALLOWED'))).toBe('ALLOWED');
      expect(declarationStanding(conflict('RECUSED'))).toBe('RECUSED');
      expect(declarationStanding(conflict('BLOCKED'))).toBe('BLOCKED');
    });
  });

  describe('what a caller sees of a proposal', () => {
    const base = { status: 'RECEIVED', released: true, evaluator: true, clerk: false, standing: 'CLEAR' } as const;

    it('shows a member who declared the whole proposal once it is released, and not before', () => {
      expect(proposalView(base)).toBe('FULL');
      expect(proposalView({ ...base, standing: 'ALLOWED' })).toBe('FULL');
      expect(proposalView({ ...base, released: false })).toBe('HIDDEN');
    });

    it('asks a member who has not declared to declare first, and hides the proposal from one who is recused, blocked or waiting', () => {
      expect(proposalView({ ...base, standing: 'UNDECLARED' })).toBe('DECLARATION_REQUIRED');
      expect(proposalView({ ...base, standing: 'PENDING' })).toBe('HIDDEN');
      expect(proposalView({ ...base, standing: 'RECUSED' })).toBe('HIDDEN');
      expect(proposalView({ ...base, standing: 'BLOCKED' })).toBe('HIDDEN');
    });

    it('shows the clerk the metadata at all times and never the contents, the replaced proposals included', () => {
      const clerk = { ...base, evaluator: false, clerk: true };
      expect(proposalView(clerk)).toBe('METADATA');
      expect(proposalView({ ...clerk, released: false })).toBe('METADATA');
      expect(proposalView({ ...clerk, status: 'SUPERSEDED' })).toBe('METADATA');
    });

    it('hides a replaced or withdrawn proposal from the evaluators, and everything from a caller who is neither', () => {
      expect(proposalView({ ...base, status: 'SUPERSEDED' })).toBe('HIDDEN');
      expect(proposalView({ ...base, status: 'WITHDRAWN' })).toBe('HIDDEN');
      expect(proposalView({ ...base, evaluator: false })).toBe('HIDDEN');
    });

    it('gives a caller who is both the clerk view while the evaluator view is closed to them', () => {
      const both = { ...base, clerk: true };
      expect(proposalView(both)).toBe('FULL');
      expect(proposalView({ ...both, standing: 'RECUSED' })).toBe('METADATA');
      expect(proposalView({ ...both, standing: 'UNDECLARED' })).toBe('METADATA');
    });
  });
});
