import { EARLY_WARNING_POLICY_DEFAULTS, actionAlert, assertIssueDay, earlyWarningClocks, earlyWarningSummary, isEwOpen, issueKindOf, parseEarlyWarningPolicy, registerClockAlert, registerIssueText, reissuesOwed, statusAfterAction, statusAfterAssessment, validateAction, validateAssessment, validateClosure, validateMeeting, validateNewWarning } from '../src/ctr-early-warning';
import type { WarningFacts } from '../src/ctr-early-warning';
import type { DomainError } from '../src/errors';
import type { WorkCalendarContent, WorkCalendarSource } from '../src/working-time';

const refusal = (work: () => unknown): DomainError => {
  try {
    work();
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('expected a refusal');
};

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const W1 = '33333333-3333-4333-8333-333333333331';
const W2 = '33333333-3333-4333-8333-333333333332';
const policy = EARLY_WARNING_POLICY_DEFAULTS;
const today = '2026-06-30';

const calendar = (year: number): WorkCalendarContent => ({ calendar_code: 'WORKDAY_VN', year, working_days: [1, 2, 3, 4, 5], holidays: [], legal_basis_ref: 'test calendar' });
const sourceOf = (...contents: WorkCalendarContent[]): WorkCalendarSource => {
  const byYear = new Map(contents.map((content) => [content.year, content]));
  return { forYear: (year) => byYear.get(year) };
};

describe('the policy of the rhythm (a rule of the tenant, never a constant of a screen)', () => {
  it('reads one week, two weeks and one week as the starting values and refuses what it cannot understand', () => {
    expect(policy).toMatchObject({ initialIssueWithinDays: 7, meetingEveryDays: 14, reissueWithinDaysAfterMeeting: 7 });
    expect(parseEarlyWarningPolicy({ initial_issue_within_days: 5, meeting_every_days: 10, reissue_within_days_after_meeting: 3, approach_days: 2, basis: 'WORKING_DAYS' })).toEqual({ initialIssueWithinDays: 5, meetingEveryDays: 10, reissueWithinDaysAfterMeeting: 3, approachDays: 2, basis: 'WORKING_DAYS' });
    expect(refusal(() => parseEarlyWarningPolicy({ initial_issue_within_days: 0, meeting_every_days: 10, reissue_within_days_after_meeting: 3, approach_days: 2, basis: 'WORKING_DAYS' })).detail).toBe('initial_issue_within_days');
    expect(refusal(() => parseEarlyWarningPolicy({ initial_issue_within_days: 5, meeting_every_days: 10, reissue_within_days_after_meeting: 3, approach_days: 2, basis: 'HOURS' })).detail).toBe('basis');
    expect(refusal(() => parseEarlyWarningPolicy({ initial_issue_within_days: 5, meeting_every_days: 10, reissue_within_days_after_meeting: 3, approach_days: 2, basis: 'WORKING_DAYS', x: 1 })).detail).toBe('x');
  });
});

describe('raising and assessing a warning', () => {
  const base = { title: 'The crane contract may be late', description: 'The supplier says the crane arrives after the foundation pour.', category: 'TIME', raisedByParty: 'CONTRACTOR', raisedOn: '2026-06-20' };

  it('lets any party raise a warning, on a day that is not in the future', () => {
    expect(validateNewWarning(base, today)).toMatchObject({ category: 'TIME', raisedByParty: 'CONTRACTOR', raisedOn: '2026-06-20' });
    expect(validateNewWarning({ ...base, raisedByParty: 'SUPERVISOR' }, today).raisedByParty).toBe('SUPERVISOR');
    expect(refusal(() => validateNewWarning({ ...base, raisedByParty: 'NOBODY' }, today)).detail).toBe('raised_by_party');
    expect(refusal(() => validateNewWarning({ ...base, raisedOn: '2026-07-01' }, today)).detail).toBe('raised_on');
    expect(refusal(() => validateNewWarning({ ...base, category: 'MOOD' }, today)).detail).toBe('category');
    expect(refusal(() => validateNewWarning({ ...base, title: 'no' }, today)).detail).toBe('title');
  });

  it('never assesses a warning with the impact left blank: a number, or an explicit no impact', () => {
    expect(validateAssessment({ ownerMembershipId: OWNER, likelihood: 'HIGH', expectedTimeDays: 14, expectedCostVnd: '250000000' })).toEqual({ ownerMembershipId: OWNER, likelihood: 'HIGH', expectedTimeDays: 14, expectedCostVnd: '250000000', noImpactExpected: false });
    expect(validateAssessment({ ownerMembershipId: OWNER, likelihood: 'LOW', noImpactExpected: true })).toMatchObject({ expectedTimeDays: null, expectedCostVnd: null, noImpactExpected: true });
    expect(refusal(() => validateAssessment({ ownerMembershipId: OWNER, likelihood: 'LOW' })).detail).toBe('expected_time_days');
    expect(refusal(() => validateAssessment({ ownerMembershipId: OWNER, likelihood: 'LOW', noImpactExpected: true, expectedTimeDays: 3 })).detail).toBe('no_impact_expected');
    expect(refusal(() => validateAssessment({ ownerMembershipId: 'not-a-uuid', likelihood: 'LOW', expectedTimeDays: 0 })).detail).toBe('owner_membership_id');
    expect(refusal(() => validateAssessment({ ownerMembershipId: OWNER, likelihood: 'SURE', expectedTimeDays: 1 })).detail).toBe('likelihood');
    expect(refusal(() => validateAssessment({ ownerMembershipId: OWNER, likelihood: 'LOW', expectedCostVnd: '1.5' })).detail).toBe('expected_cost_vnd');
    // Zero days is a figure (the warning expects no delay but a cost), not a blank.
    expect(validateAssessment({ ownerMembershipId: OWNER, likelihood: 'LOW', expectedTimeDays: 0 }).expectedTimeDays).toBe(0);
  });

  it('moves a raised warning to assessed, then to mitigating with the first action, and refuses both on a closed warning', () => {
    expect(statusAfterAssessment('RAISED')).toBe('ASSESSED');
    expect(statusAfterAssessment('MITIGATING')).toBe('MITIGATING');
    expect(refusal(() => statusAfterAssessment('CLOSED_RESOLVED')).code).toBe('EARLY_WARNING_STATE_INVALID');
    expect(statusAfterAction('ASSESSED')).toBe('MITIGATING');
    expect(refusal(() => statusAfterAction('RAISED')).code).toBe('EARLY_WARNING_STATE_INVALID');
    expect(refusal(() => statusAfterAction('CLOSED_WITHDRAWN')).code).toBe('EARLY_WARNING_STATE_INVALID');
    expect(isEwOpen('MITIGATING')).toBe(true);
    expect(isEwOpen('CLOSED_MATERIALISED')).toBe(false);
  });

  it('gives a mitigation action words, a person and a due day that is not in the past', () => {
    expect(validateAction({ description: 'Order the crane from the second supplier.', ownerMembershipId: OWNER, dueOn: '2026-07-05' }, today)).toEqual({ description: 'Order the crane from the second supplier.', ownerMembershipId: OWNER, dueOn: '2026-07-05' });
    expect(validateAction({ description: 'Order the crane from the second supplier.', ownerMembershipId: OWNER, dueOn: today }, today).dueOn).toBe(today);
    expect(refusal(() => validateAction({ description: 'Order the crane from the second supplier.', ownerMembershipId: OWNER, dueOn: '2026-06-29' }, today)).detail).toBe('due_on');
    expect(refusal(() => validateAction({ description: 'x', ownerMembershipId: OWNER, dueOn: '2026-07-05' }, today)).detail).toBe('description');
  });
});

describe('closing a warning', () => {
  it('resolves a warning only without open actions and by somebody other than the person who answers for it', () => {
    expect(validateClosure({ outcome: 'RESOLVED', reason: 'The second supplier delivered on time.' }, 'MITIGATING', 0, OWNER, OTHER)).toMatchObject({ outcome: 'RESOLVED', status: 'CLOSED_RESOLVED', materialisedInto: null });
    expect(refusal(() => validateClosure({ outcome: 'RESOLVED', reason: 'The second supplier delivered on time.' }, 'MITIGATING', 1, OWNER, OTHER)).code).toBe('EARLY_WARNING_ACTIONS_OPEN');
    expect(refusal(() => validateClosure({ outcome: 'RESOLVED', reason: 'The second supplier delivered on time.' }, 'MITIGATING', 0, OWNER, OWNER.toUpperCase())).code).toBe('SELF_APPROVAL_DENIED');
  });

  it('names the change order or the claim a warning that came true became, and nothing for the other outcomes', () => {
    expect(validateClosure({ outcome: 'MATERIALISED', reason: 'The delay happened: a change order was raised.', materialisedInto: 'CHANGE_REQUEST', materialisedId: W1 }, 'ASSESSED', 2, OWNER, OWNER)).toMatchObject({ status: 'CLOSED_MATERIALISED', materialisedInto: 'CHANGE_REQUEST', materialisedId: W1 });
    expect(refusal(() => validateClosure({ outcome: 'MATERIALISED', reason: 'The delay happened: a change order was raised.' }, 'ASSESSED', 0, OWNER, OTHER)).detail).toBe('materialised_into');
    expect(refusal(() => validateClosure({ outcome: 'MATERIALISED', reason: 'The delay happened: a change order was raised.', materialisedInto: 'CLAIM', materialisedId: 'x' }, 'ASSESSED', 0, OWNER, OTHER)).detail).toBe('materialised_id');
    expect(refusal(() => validateClosure({ outcome: 'WITHDRAWN', reason: 'Raised in error by the supplier.', materialisedInto: 'CLAIM', materialisedId: W1 }, 'RAISED', 0, null, OTHER)).detail).toBe('materialised_into');
  });

  it('withdraws a raised warning, and refuses to resolve one that was never assessed, to reason in less than words, or to close one that is closed', () => {
    expect(validateClosure({ outcome: 'WITHDRAWN', reason: 'Raised in error by the supplier.' }, 'RAISED', 0, null, OTHER).status).toBe('CLOSED_WITHDRAWN');
    expect(refusal(() => validateClosure({ outcome: 'RESOLVED', reason: 'The second supplier delivered on time.' }, 'RAISED', 0, null, OTHER)).code).toBe('EARLY_WARNING_STATE_INVALID');
    expect(refusal(() => validateClosure({ outcome: 'RESOLVED', reason: 'ok' }, 'MITIGATING', 0, OWNER, OTHER)).detail).toBe('reason');
    expect(refusal(() => validateClosure({ outcome: 'RESOLVED', reason: 'The second supplier delivered on time.' }, 'CLOSED_RESOLVED', 0, OWNER, OTHER)).code).toBe('EARLY_WARNING_STATE_INVALID');
    expect(refusal(() => validateClosure({ outcome: 'LOST', reason: 'The second supplier delivered on time.' }, 'MITIGATING', 0, OWNER, OTHER)).detail).toBe('outcome');
  });
});

describe('the meeting that reviews the register', () => {
  const meeting = { heldOn: '2026-06-24', attendees: 'Owner, contractor, supervisor', notes: 'Crane risk reviewed.', reviews: [{ warning_id: W1, outcome: 'ACTION_AGREED', note: 'Second supplier.' }, { warning_id: W2, outcome: 'NO_CHANGE' }] };

  it('reviews every open warning exactly once', () => {
    const judged = validateMeeting(meeting, [W1, W2], today, '2026-06-01', null);
    expect(judged.reviews).toEqual([{ warningId: W1, outcome: 'ACTION_AGREED', note: 'Second supplier.' }, { warningId: W2, outcome: 'NO_CHANGE', note: null }]);
    expect(refusal(() => validateMeeting({ ...meeting, reviews: [meeting.reviews[0]] }, [W1, W2], today, null, null)).detail).toBe('reviews');
    expect(refusal(() => validateMeeting({ ...meeting, reviews: [meeting.reviews[0], meeting.reviews[0]] }, [W1, W2], today, null, null)).detail).toBe('reviews[1].warning_id');
    expect(refusal(() => validateMeeting(meeting, [W1], today, null, null)).detail).toBe('reviews[1].warning_id');
    expect(refusal(() => validateMeeting({ ...meeting, reviews: [{ warning_id: W1, outcome: 'SHRUG' }, meeting.reviews[1]] }, [W1, W2], today, null, null)).detail).toBe('reviews[0].outcome');
    expect(validateMeeting({ ...meeting, reviews: [] }, [], today, null, null).reviews).toEqual([]);
  });

  it('is held on a day that is not in the future, not before the contract began and after the previous meeting', () => {
    expect(refusal(() => validateMeeting({ ...meeting, heldOn: '2026-07-02' }, [W1, W2], today, null, null)).detail).toBe('held_on');
    expect(refusal(() => validateMeeting(meeting, [W1, W2], today, '2026-06-25', null)).detail).toBe('held_on');
    expect(refusal(() => validateMeeting(meeting, [W1, W2], today, null, '2026-06-24')).detail).toBe('held_on');
    expect(refusal(() => validateMeeting({ ...meeting, attendees: '' }, [W1, W2], today, null, null)).detail).toBe('attendees');
  });
});

describe('the clocks of the register', () => {
  const inForce = { active: true, startOn: '2026-06-01', firstIssueOn: null, lastMeetingOn: null, latestMeeting: null };

  it('owes the first issue a week after the contract starts, and a meeting two weeks after it', () => {
    const early = earlyWarningClocks(inForce, '2026-06-05', policy, undefined);
    expect(early.initial).toMatchObject({ state: 'APPROACHING', dueOn: '2026-06-08', daysLeft: 3 });
    expect(early.meeting).toMatchObject({ state: 'RUNNING', startedOn: '2026-06-01', dueOn: '2026-06-15' });
    expect(early.reissue).toBeNull();
    const late = earlyWarningClocks(inForce, '2026-06-10', policy, undefined);
    expect(late.initial).toMatchObject({ state: 'MISSED', daysLeft: -2 });
    expect(earlyWarningClocks({ ...inForce, firstIssueOn: '2026-06-08' }, '2026-06-30', policy, undefined).initial.state).toBe('MET');
    expect(earlyWarningClocks({ ...inForce, firstIssueOn: '2026-06-09' }, '2026-06-30', policy, undefined).initial.state).toBe('MET_LATE');
  });

  it('counts the next meeting from the latest one and the re-issue from the meeting it follows', () => {
    const afterMeeting = { ...inForce, firstIssueOn: '2026-06-05', lastMeetingOn: '2026-06-20', latestMeeting: { id: 'm1', heldOn: '2026-06-20', reissuedOn: null } };
    const clocks = earlyWarningClocks(afterMeeting, '2026-06-30', policy, undefined);
    expect(clocks.meeting).toMatchObject({ startedOn: '2026-06-20', dueOn: '2026-07-04', state: 'RUNNING' });
    expect(clocks.reissue).toMatchObject({ meetingId: 'm1', dueOn: '2026-06-27', state: 'MISSED' });
    expect(earlyWarningClocks({ ...afterMeeting, latestMeeting: { id: 'm1', heldOn: '2026-06-20', reissuedOn: '2026-06-26' } }, '2026-06-30', policy, undefined).reissue?.state).toBe('MET');
  });

  it('keeps no rhythm for a contract that is not in force or has not begun, and never invents a day for working days without a calendar', () => {
    for (const input of [{ ...inForce, active: false }, { ...inForce, startOn: null }]) {
      const clocks = earlyWarningClocks(input, '2026-09-01', policy, undefined);
      expect([clocks.initial.state, clocks.meeting.state]).toEqual(['NOT_STARTED', 'NOT_STARTED']);
      expect(registerClockAlert(clocks.initial)).toBeNull();
    }
    const working = { ...policy, basis: 'WORKING_DAYS' as const };
    expect(earlyWarningClocks(inForce, '2026-06-05', working, undefined).initial).toMatchObject({ state: 'CALENDAR_UNAVAILABLE', dueOn: null });
    // 2026-06-01 is a Monday: five working days is the next Monday, and a week of working days is seven.
    expect(earlyWarningClocks(inForce, '2026-06-05', working, sourceOf(calendar(2026))).initial).toMatchObject({ dueOn: '2026-06-10', basis: 'WORKING_DAYS' });
  });

  it('lists every meeting left without its re-issue once it is approaching or past, one clock per meeting', () => {
    const meetings = [
      { id: 'm1', heldOn: '2026-05-20', reissuedOn: null },
      { id: 'm2', heldOn: '2026-06-10', reissuedOn: '2026-06-12' },
      { id: 'm3', heldOn: '2026-06-26', reissuedOn: null },
      { id: 'm4', heldOn: '2026-06-24', reissuedOn: null },
    ];
    const owed = reissuesOwed(meetings, today, policy, undefined);
    expect(owed.map((entry) => [entry.meetingId, entry.state])).toEqual([['m1', 'MISSED'], ['m3', 'APPROACHING'], ['m4', 'APPROACHING']]);
  });

  it('names the alert of a clock: nothing while it runs far ahead or is met, a register alert for an issue, a meeting alert for a meeting', () => {
    const clocks = earlyWarningClocks({ ...inForce, firstIssueOn: null, lastMeetingOn: null }, '2026-06-20', policy, undefined);
    expect(registerClockAlert(clocks.initial)).toEqual({ kind: 'EW_REGISTER_OVERDUE', facet: 'OVERDUE', dueOn: '2026-06-08', code: 'INITIAL_ISSUE' });
    expect(registerClockAlert(clocks.meeting)).toEqual({ kind: 'EW_MEETING_OVERDUE', facet: 'OVERDUE', dueOn: '2026-06-15', code: 'MEETING' });
    const running = earlyWarningClocks(inForce, '2026-06-02', policy, undefined);
    expect(registerClockAlert(running.meeting)).toBeNull();
    expect(registerClockAlert(earlyWarningClocks({ ...inForce, firstIssueOn: '2026-06-03' }, '2026-06-20', policy, undefined).initial)).toBeNull();
    expect(registerClockAlert(earlyWarningClocks(inForce, '2026-06-06', policy, undefined).initial)).toMatchObject({ facet: 'DUE_SOON' });
  });

  it('raises an action alert only for an open action past its day', () => {
    expect(actionAlert('OPEN', '2026-06-29', today)).toEqual({ kind: 'EW_ACTION_OVERDUE', facet: 'OVERDUE', dueOn: '2026-06-29', code: 'ACTION' });
    expect(actionAlert('OPEN', today, today)).toBeNull();
    expect(actionAlert('DONE', '2026-06-01', today)).toBeNull();
    expect(actionAlert('CANCELLED', '2026-06-01', today)).toBeNull();
  });

  it('kinds an issue by what came before it, and refuses a day before the contract began or the meeting it follows', () => {
    expect(issueKindOf(0, null)).toBe('INITIAL');
    expect(issueKindOf(3, null)).toBe('PERIODIC');
    expect(issueKindOf(0, 'm1')).toBe('AFTER_MEETING');
    expect(assertIssueDay('2026-06-25', today, '2026-06-01', '2026-06-24')).toBe('2026-06-25');
    expect(refusal(() => assertIssueDay('2026-06-23', today, '2026-06-01', '2026-06-24')).detail).toBe('issued_on');
    expect(refusal(() => assertIssueDay('2026-05-30', today, '2026-06-01', null)).detail).toBe('issued_on');
    expect(refusal(() => assertIssueDay('2026-07-01', today, null, null)).detail).toBe('issued_on');
  });
});

describe('the report hooks of the register', () => {
  const row = (over: Partial<WarningFacts>): WarningFacts => ({ id: W1, code: 'EW-001', status: 'MITIGATING', category: 'TIME', raisedByParty: 'CONTRACTOR', likelihood: 'HIGH', ownerMembershipId: OWNER, expectedTimeDays: 14, expectedCostVnd: '250000000', noImpactExpected: false, openActions: 1, overdueActions: 0, raisedOn: '2026-06-01', version: 3, ...over });
  const rows: WarningFacts[] = [
    row({}),
    row({ id: W2, code: 'EW-002', status: 'RAISED', category: 'COST', raisedByParty: 'OWNER', likelihood: null, ownerMembershipId: null, expectedTimeDays: null, expectedCostVnd: null, openActions: 0, version: 1 }),
    row({ id: 'x3', code: 'EW-003', status: 'ASSESSED', expectedTimeDays: 3, expectedCostVnd: '50000000', overdueActions: 2 }),
    row({ id: 'x4', code: 'EW-004', status: 'CLOSED_RESOLVED', expectedTimeDays: 100, expectedCostVnd: '9000000000', openActions: 0 }),
    row({ id: 'x5', code: 'EW-005', status: 'ASSESSED', expectedTimeDays: null, expectedCostVnd: null, noImpactExpected: true }),
  ];

  it('adds the register up: counts, what nobody owns, and the impact that the open warnings expect together (closed ones add nothing)', () => {
    expect(earlyWarningSummary(rows)).toEqual({
      total: 5,
      open: 4,
      byStatus: { RAISED: 1, ASSESSED: 2, MITIGATING: 1, CLOSED_RESOLVED: 1, CLOSED_MATERIALISED: 0, CLOSED_WITHDRAWN: 0 },
      byCategory: { TIME: 4, COST: 1, QUALITY: 0, SAFETY: 0, SCOPE: 0, LEGAL: 0, ENVIRONMENT: 0, OTHER: 0 },
      byParty: { OWNER: 1, CONTRACTOR: 4, SUPERVISOR: 0, DESIGNER: 0, OTHER: 0 },
      withoutOwner: 1,
      unassessed: 1,
      exposureCostVnd: '300000000',
      exposureTimeDays: 17,
      impactUnknown: 1,
      overdueActions: 2,
    });
  });

  it('says nothing is known about the impact of a warning that has no figure and no explicit no-impact, instead of adding a zero', () => {
    expect(earlyWarningSummary([row({ expectedTimeDays: null, expectedCostVnd: null })]).impactUnknown).toBe(1);
    expect(earlyWarningSummary([row({ expectedTimeDays: null, expectedCostVnd: null, noImpactExpected: true })]).impactUnknown).toBe(0);
    expect(earlyWarningSummary([]).exposureCostVnd).toBe('0');
  });

  it('writes the same text for the same register whatever the order of the rows, and another text when a figure changes', () => {
    const text = registerIssueText(rows);
    expect(registerIssueText([...rows].reverse())).toBe(text);
    expect(text.split('\n')).toHaveLength(5);
    expect(registerIssueText(rows.map((entry) => (entry.code === 'EW-001' ? { ...entry, expectedTimeDays: 15 } : entry)))).not.toBe(text);
    expect(text.split('\n')[0]).toBe(`EW-001|MITIGATING|HIGH|14|250000000||${OWNER}|1|3`);
  });
});
