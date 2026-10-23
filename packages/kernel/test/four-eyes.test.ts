import { CHANGE_REQUEST_STATES, assertFourEyes, changeRequestNext, canTransition } from '../src/four-eyes';
import { DomainError } from '../src/errors';

const MAKER = '00000000-0000-4000-8000-0000000000a1';
const CHECKER = '00000000-0000-4000-8000-0000000000b1';

function refusal(work: () => unknown): DomainError {
  try {
    work();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a DomainError');
}

describe('assertFourEyes', () => {
  it('lets a checker who is not the maker decide', () => {
    expect(() => assertFourEyes(MAKER, CHECKER)).not.toThrow();
  });

  it('refuses the maker as their own checker with 403 SELF_APPROVAL_DENIED, whatever the letter case of the ids', () => {
    expect(refusal(() => assertFourEyes(MAKER, MAKER))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
    expect(refusal(() => assertFourEyes(MAKER.toUpperCase(), MAKER))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
  });

  it('refuses a missing maker or checker instead of letting an empty string pass for a different person', () => {
    expect(refusal(() => assertFourEyes('', CHECKER))).toMatchObject({ code: 'INVALID_REQUEST', status: 400 });
    expect(refusal(() => assertFourEyes(MAKER, ''))).toMatchObject({ code: 'INVALID_REQUEST', status: 400 });
  });
});

describe('the change request state machine', () => {
  it('walks Draft → Submitted → Approved → Applied and Submitted → Rejected', () => {
    expect(changeRequestNext('Draft', 'submit')).toBe('Submitted');
    expect(changeRequestNext('Submitted', 'approve')).toBe('Approved');
    expect(changeRequestNext('Approved', 'apply')).toBe('Applied');
    expect(changeRequestNext('Submitted', 'reject')).toBe('Rejected');
  });

  it('lets a rejected request go back to Draft for a new submission and nothing else leave a final state', () => {
    expect(changeRequestNext('Rejected', 'reopen')).toBe('Draft');
    for (const action of ['submit', 'approve', 'reject', 'apply', 'reopen'] as const) {
      expect(canTransition('Applied', action)).toBe(false);
    }
  });

  it('refuses every other move with 409 STAGE_TRANSITION_DENIED, naming only the states', () => {
    const error = refusal(() => changeRequestNext('Draft', 'approve'));
    expect(error).toMatchObject({ code: 'STAGE_TRANSITION_DENIED', status: 409, detail: 'Draft->approve' });
    for (const from of CHANGE_REQUEST_STATES) {
      for (const action of ['submit', 'approve', 'reject', 'apply', 'reopen'] as const) {
        if (!canTransition(from, action)) expect(refusal(() => changeRequestNext(from, action)).code).toBe('STAGE_TRANSITION_DENIED');
      }
    }
  });
});
