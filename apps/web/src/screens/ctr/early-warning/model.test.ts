import { describe, expect, it } from 'vitest';
import { EMPTY_FILTER, assessBody, assessFormOf, closeBody, emptyAction, emptyClose, emptyMeeting, emptyRaise, isFiltered, isOpen, issueBody, meetingBody, meetingsAwaitingIssue, queryOf, raiseBody, validateAction, validateAssess, validateClose, validateIssue, validateMeeting, validateRaise } from './model';

const TODAY = '2026-11-08';
const OWNER = '00000000-0000-4000-8000-000000000050';
const W1 = '00000000-0000-4000-8000-000000000041';
const W2 = '00000000-0000-4000-8000-000000000042';

describe('the filter of the register', () => {
  it('sends only what the person chose', () => {
    expect(queryOf(EMPTY_FILTER)).toEqual({ limit: 50 });
    expect(queryOf({ contractId: 'c', status: 'RAISED', category: 'TIME', party: 'OWNER', open: true, mine: true }, 'next')).toEqual({ limit: 50, contract_id: 'c', status: 'RAISED', category: 'TIME', raised_by_party: 'OWNER', open: true, mine: true, cursor: 'next' });
    expect(isFiltered(EMPTY_FILTER)).toBe(false);
    expect(isFiltered({ ...EMPTY_FILTER, mine: true })).toBe(true);
    expect(isOpen('MITIGATING')).toBe(true);
    expect(isOpen('CLOSED_WITHDRAWN')).toBe(false);
  });
});

describe('raising and assessing a warning', () => {
  it('accepts any party and a day that is not in the future', () => {
    const form = { ...emptyRaise(TODAY), title: 'The crane may arrive late', description: 'The supplier says it arrives after the pour.' };
    expect(validateRaise(form, TODAY)).toEqual({});
    expect(raiseBody({ ...form, party: 'SUPERVISOR' })).toMatchObject({ raised_by_party: 'SUPERVISOR', category: 'TIME', raised_on: TODAY });
    expect(validateRaise({ ...form, raisedOn: '2026-11-09' }, TODAY).raisedOn).toBe('invalidDay');
    expect(validateRaise({ ...form, party: 'NOBODY' }, TODAY).party).toBe('pickOne');
    expect(validateRaise({ ...form, title: 'abc' }, TODAY).title).toBe('tooShort');
  });

  it('never assesses with the impact left blank: a figure, or the statement that none is expected', () => {
    const base = { ownerId: OWNER, likelihood: 'HIGH', timeDays: '', costVnd: '', noImpact: false };
    expect(validateAssess(base).timeDays).toBe('required');
    expect(validateAssess({ ...base, timeDays: '0' })).toEqual({});
    expect(validateAssess({ ...base, costVnd: '250000000' })).toEqual({});
    expect(validateAssess({ ...base, noImpact: true })).toEqual({});
    expect(validateAssess({ ...base, noImpact: true, timeDays: '3' }).noImpact).toBe('pickOne');
    expect(validateAssess({ ...base, timeDays: '3', ownerId: '' }).ownerId).toBe('pickOne');
    expect(validateAssess({ ...base, timeDays: '3', likelihood: '' }).likelihood).toBe('pickOne');
    expect(validateAssess({ ...base, costVnd: '1.5' }).costVnd).toBe('invalidAmount');
    expect(assessBody({ ...base, timeDays: '14', costVnd: '250000000' })).toEqual({ owner_membership_id: OWNER, likelihood: 'HIGH', expected_time_days: 14, expected_cost_vnd: '250000000' });
    expect(assessBody({ ...base, noImpact: true })).toEqual({ owner_membership_id: OWNER, likelihood: 'HIGH', no_impact_expected: true });
  });

  it('starts a re-assessment from what the warning already says', () => {
    expect(assessFormOf({ owner_membership_id: OWNER, likelihood: 'LOW', expected_time_days: 0, expected_cost_vnd: null, no_impact_expected: false })).toEqual({ ownerId: OWNER, likelihood: 'LOW', timeDays: '0', costVnd: '', noImpact: false });
  });

  it('gives an action a person, words and a day that is not in the past', () => {
    const form = { ...emptyAction(TODAY), description: 'Order the crane from the second supplier.', ownerId: OWNER };
    expect(validateAction(form, TODAY)).toEqual({});
    expect(validateAction({ ...form, dueOn: '2026-11-07' }, TODAY).dueOn).toBe('invalidDay');
    expect(validateAction({ ...form, ownerId: '' }, TODAY).ownerId).toBe('pickOne');
  });
});

describe('closing a warning', () => {
  it('refuses a resolution while an action is open, and a warning that came true without the change order or the claim it became', () => {
    const resolved = validateClose(emptyClose(), 'The second supplier delivered on time.', 2);
    expect(resolved.actionsOpen).toBe(true);
    expect(validateClose(emptyClose(), 'The second supplier delivered on time.', 0).actionsOpen).toBe(false);
    expect(validateClose({ ...emptyClose(), outcome: 'WITHDRAWN' }, 'Raised in error by the supplier.', 3).actionsOpen).toBe(false);
    const came = { ...emptyClose(), outcome: 'MATERIALISED' };
    expect(validateClose(came, 'The delay happened.', 0).errors.materialisedId).toBe('invalidId');
    expect(validateClose({ ...came, materialisedId: W1 }, 'The delay happened.', 0).errors).toEqual({});
    expect(validateClose(emptyClose(), 'short', 0).reason).toBe('tooShort');
    expect(closeBody({ ...came, into: 'CLAIM', materialisedId: ` ${W1} ` }, ' The delay happened. ')).toEqual({ outcome: 'MATERIALISED', reason: 'The delay happened.', materialised_into: 'CLAIM', materialised_id: W1 });
    expect(closeBody(emptyClose(), 'The second supplier delivered on time.')).toEqual({ outcome: 'RESOLVED', reason: 'The second supplier delivered on time.' });
  });
});

describe('the meeting and the issue of the register', () => {
  it('reviews every open warning: one that is left without a conclusion is named, and the meeting is held after the last one and not before the contract began', () => {
    const form = { ...emptyMeeting(TODAY), attendees: 'Owner, contractor, supervisor', outcomes: { [W1]: 'ACTION_AGREED' } };
    expect(validateMeeting(form, [W1, W2], TODAY, null, null).missing).toEqual([W2]);
    expect(validateMeeting({ ...form, outcomes: { [W1]: 'NO_CHANGE', [W2]: 'ESCALATED' } }, [W1, W2], TODAY, null, null)).toEqual({ errors: {}, missing: [] });
    expect(validateMeeting(form, [W1], TODAY, '2026-11-08', null).errors.heldOn).toBe('invalidDay');
    expect(validateMeeting(form, [W1], TODAY, null, '2026-11-09').errors.heldOn).toBe('invalidDay');
    expect(validateMeeting({ ...form, attendees: '' }, [W1], TODAY, null, null).errors.attendees).toBe('required');
    expect(validateMeeting({ ...form, outcomes: {} }, [], TODAY, null, null)).toEqual({ errors: {}, missing: [] });
  });

  it('builds the body with one review per open warning in the order given and the notes only where there are some', () => {
    const form = { ...emptyMeeting(TODAY), attendees: ' Owner, contractor ', notes: '', outcomes: { [W1]: 'ACTION_AGREED', [W2]: 'NO_CHANGE' }, notesOf: { [W1]: 'Second supplier' } };
    expect(meetingBody(form, [W1, W2])).toEqual({
      held_on: TODAY,
      attendees: 'Owner, contractor',
      reviews: [{ warning_id: W1, outcome: 'ACTION_AGREED', note: 'Second supplier' }, { warning_id: W2, outcome: 'NO_CHANGE' }],
    });
  });

  it('issues the register after a meeting that still waits for it, or on its own', () => {
    expect(validateIssue({ issuedOn: TODAY, meetingId: '' }, TODAY)).toEqual({});
    expect(validateIssue({ issuedOn: '2026-11-09', meetingId: '' }, TODAY).issuedOn).toBe('invalidDay');
    expect(issueBody({ issuedOn: TODAY, meetingId: '' })).toEqual({ issued_on: TODAY });
    expect(issueBody({ issuedOn: TODAY, meetingId: W1 })).toEqual({ issued_on: TODAY, meeting_id: W1 });
    const meetings = [{ id: 'a', reissued_on: null }, { id: 'b', reissued_on: '2026-11-02' }] as never;
    expect(meetingsAwaitingIssue({ meetings }).map((meeting) => meeting.id)).toEqual(['a']);
  });
});
