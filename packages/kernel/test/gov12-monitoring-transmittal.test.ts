import { DomainError } from '../src/errors';
import { addDays, assertFeedbackMove, assertNoticeMayBeSent, assertPackReadyForNotice, daysBetween, monitoringDefaults, monitoringPolicyOf, nextMonitoringFeedbackStatus, noticeReading, packCompleteness, responseReading, summariseFeedback } from '../src/monitoring-file';
import { assertAnswerAllowed, assertContainerMove, assertTransmittalExtension, assertTransmittalShape, dueOnOf, reviewReading, transmittalDefaults, transmittalPolicyOf, transmittalProgress } from '../src/transmittal';
import type { RecipientAnswer } from '../src/transmittal';

const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
  return 'NO_ERROR';
};

const POLICY = monitoringDefaults();

describe('community monitoring notice (G4-8)', () => {
  it('counts 45 days from the day the duty began and reads the state of the notice by day', () => {
    expect(POLICY.notice_days).toBe(45);
    expect(addDays('2026-01-01', 45)).toBe('2026-02-15');
    const facts = { triggerOn: '2026-01-01', sentOn: null };
    expect(noticeReading(facts, '2026-01-10', POLICY)).toMatchObject({ state: 'PENDING', dueOn: '2026-02-15', daysLeft: 36 });
    expect(noticeReading(facts, '2026-02-10', POLICY).state).toBe('DUE_SOON');
    expect(noticeReading(facts, '2026-02-15', POLICY)).toMatchObject({ state: 'DUE_SOON', daysLeft: 0 });
    expect(noticeReading(facts, '2026-02-16', POLICY)).toMatchObject({ state: 'OVERDUE', daysLeft: -1 });
  });

  it('is on time when sent on the due day and late a day after; a file nobody started has no deadline', () => {
    expect(noticeReading({ triggerOn: '2026-01-01', sentOn: '2026-02-15' }, '2026-03-01', POLICY)).toMatchObject({ state: 'SENT_ON_TIME', daysLate: 0 });
    expect(noticeReading({ triggerOn: '2026-01-01', sentOn: '2026-02-16' }, '2026-03-01', POLICY)).toMatchObject({ state: 'SENT_LATE', daysLate: 1 });
    expect(noticeReading({ triggerOn: null, sentOn: null }, '2026-03-01', POLICY)).toEqual({ state: 'NOT_STARTED', dueOn: null, daysLeft: null, daysLate: null });
  });

  it('refuses a notice before the duty, in the future, or twice', () => {
    expect(codeOf(() => assertNoticeMayBeSent({ triggerOn: null, sentOn: null }, '2026-02-01', '2026-02-02'))).toBe('MONITORING_NOTICE_NOT_STARTED');
    expect(codeOf(() => assertNoticeMayBeSent({ triggerOn: '2026-01-01', sentOn: '2026-01-05' }, '2026-02-01', '2026-02-02'))).toBe('MONITORING_NOTICE_ALREADY_SENT');
    expect(codeOf(() => assertNoticeMayBeSent({ triggerOn: '2026-01-10', sentOn: null }, '2026-01-05', '2026-02-02'))).toBe('VALIDATION_FAILED');
    expect(codeOf(() => assertNoticeMayBeSent({ triggerOn: '2026-01-01', sentOn: null }, '2026-03-01', '2026-02-02'))).toBe('VALIDATION_FAILED');
    expect(codeOf(() => assertNoticeMayBeSent({ triggerOn: '2026-01-01', sentOn: null }, '2026-02-01', '2026-02-02'))).toBe('NO_ERROR');
  });

  it('reads the policy from rule params and refuses a damaged one', () => {
    expect(monitoringPolicyOf({ notice_days: 30, response_days: 10, reminder_days: 3 })).toEqual({ notice_days: 30, response_days: 10, reminder_days: 3 });
    expect(codeOf(() => monitoringPolicyOf({ notice_days: 0, response_days: 10, reminder_days: 3 }))).toBe('VALIDATION_FAILED');
    expect(codeOf(() => monitoringPolicyOf({ notice_days: 30, response_days: 10, reminder_days: 10 }))).toBe('VALIDATION_FAILED');
    expect(codeOf(() => monitoringPolicyOf({ notice_days: 30.5, response_days: 10, reminder_days: 3 }))).toBe('VALIDATION_FAILED');
    expect(daysBetween('2026-02-28', '2026-03-01')).toBe(1);
  });
});

describe('the pack of the notice and the feedback of the community', () => {
  it('needs the notice text, the project information and the schedule before the notice may go', () => {
    expect(packCompleteness(['NOTICE_TEXT']).requiredMissing).toEqual(['PROJECT_INFO', 'PLAN_SCHEDULE']);
    expect(codeOf(() => assertPackReadyForNotice(['NOTICE_TEXT', 'PROJECT_INFO']))).toBe('MONITORING_PACK_INCOMPLETE');
    expect(codeOf(() => assertPackReadyForNotice(['NOTICE_TEXT', 'PROJECT_INFO', 'PLAN_SCHEDULE']))).toBe('NO_ERROR');
    expect(packCompleteness(['NOTICE_TEXT', 'PROJECT_INFO', 'PLAN_SCHEDULE']).missing).toEqual(['BOARD_LIST', 'MEETING_MINUTES', 'FEEDBACK_REPORT']);
  });

  it('moves a feedback along its edges and refuses the others', () => {
    expect(nextMonitoringFeedbackStatus('RECEIVED', 'TAKE')).toBe('IN_REVIEW');
    expect(nextMonitoringFeedbackStatus('IN_REVIEW', 'RESPOND')).toBe('RESPONDED');
    expect(nextMonitoringFeedbackStatus('RESPONDED', 'CLOSE')).toBe('CLOSED');
    expect(nextMonitoringFeedbackStatus('CLOSED', 'REOPEN')).toBe('IN_REVIEW');
    expect(codeOf(() => nextMonitoringFeedbackStatus('RECEIVED', 'CLOSE'))).toBe('MONITORING_FEEDBACK_STATE_INVALID');
    expect(codeOf(() => nextMonitoringFeedbackStatus('CLOSED', 'RESPOND'))).toBe('MONITORING_FEEDBACK_STATE_INVALID');
  });

  it('does not let the person who answered close the answer, and asks a reason for a decline', () => {
    expect(codeOf(() => assertFeedbackMove({ move: 'CLOSE', actorId: 'a', responderId: 'a', reason: null }))).toBe('SELF_APPROVAL_DENIED');
    expect(codeOf(() => assertFeedbackMove({ move: 'CLOSE', actorId: 'b', responderId: 'a', reason: null }))).toBe('NO_ERROR');
    expect(codeOf(() => assertFeedbackMove({ move: 'DECLINE', actorId: 'b', responderId: null, reason: 'no' }))).toBe('VALIDATION_FAILED');
  });

  it('counts the response time from the day of receipt and summarises a file', () => {
    const open = responseReading({ receivedOn: '2026-03-01', respondedOn: null, status: 'RECEIVED' }, '2026-03-20', POLICY);
    expect(open).toMatchObject({ state: 'OVERDUE', dueOn: '2026-03-16', daysLeft: -4 });
    const onTime = responseReading({ receivedOn: '2026-03-01', respondedOn: '2026-03-16', status: 'RESPONDED' }, '2026-03-20', POLICY);
    const late = responseReading({ receivedOn: '2026-03-01', respondedOn: '2026-03-17', status: 'CLOSED' }, '2026-03-20', POLICY);
    const waiting = responseReading({ receivedOn: '2026-03-10', respondedOn: null, status: 'IN_REVIEW' }, '2026-03-20', POLICY);
    expect(onTime.state).toBe('ON_TIME');
    expect(late).toMatchObject({ state: 'LATE', daysLate: 1 });
    expect(waiting.state).toBe('DUE_SOON');
    expect(summariseFeedback([{ status: 'RECEIVED', response: open }, { status: 'RESPONDED', response: onTime }, { status: 'CLOSED', response: late }, { status: 'IN_REVIEW', response: waiting }])).toEqual({ feedbackTotal: 4, open: 2, overdue: 1, answeredOnTimePct: 50 });
    expect(summariseFeedback([]).answeredOnTimePct).toBeNull();
  });
});

describe('document transmittal (G4-11)', () => {
  const policy = transmittalDefaults();
  const progress = (answers: Array<{ required: boolean; answer: RecipientAnswer | null; dueOn?: string | null; answeredOn?: string | null }>, today: string) =>
    transmittalProgress(answers.map((one) => ({ required: one.required, answer: one.answer, review: reviewReading({ dueOn: one.dueOn === undefined ? '2026-04-06' : one.dueOn, required: one.required, answeredOn: one.answeredOn ?? (one.answer !== null ? '2026-04-02' : null) }, today, policy) })));

  it('sets the due day from the purpose: information asks nothing', () => {
    expect(dueOnOf('FOR_REVIEW', '2026-04-01', policy)).toBe('2026-04-06');
    expect(dueOnOf('FOR_APPROVAL', '2026-04-01', policy)).toBe('2026-04-11');
    expect(dueOnOf('FOR_INFORMATION', '2026-04-01', policy)).toBeNull();
  });

  it('reads the review state of a recipient by day', () => {
    expect(reviewReading({ dueOn: '2026-04-06', required: true, answeredOn: null }, '2026-04-01', policy).state).toBe('WAITING');
    expect(reviewReading({ dueOn: '2026-04-06', required: true, answeredOn: null }, '2026-04-05', policy).state).toBe('DUE_SOON');
    expect(reviewReading({ dueOn: '2026-04-06', required: true, answeredOn: null }, '2026-04-07', policy)).toMatchObject({ state: 'OVERDUE', daysLeft: -1 });
    expect(reviewReading({ dueOn: '2026-04-06', required: true, answeredOn: '2026-04-06' }, '2026-04-09', policy).state).toBe('ANSWERED_ON_TIME');
    expect(reviewReading({ dueOn: '2026-04-06', required: true, answeredOn: '2026-04-08' }, '2026-04-09', policy)).toMatchObject({ state: 'ANSWERED_LATE', daysLate: 2 });
    expect(reviewReading({ dueOn: null, required: false, answeredOn: null }, '2026-04-09', policy).state).toBe('NOT_ASKED');
  });

  it('summarises the answers of a transmittal', () => {
    const result = progress([{ required: true, answer: 'APPROVED' }, { required: true, answer: null }, { required: false, answer: 'REJECTED' }], '2026-04-08');
    expect(result).toMatchObject({ recipients: 3, required: 2, answered: 2, approved: 1, rejected: 1, overdue: 1, allRequiredAnswered: false });
    expect(progress([{ required: true, answer: 'APPROVED' }, { required: true, answer: 'APPROVED_WITH_COMMENTS' }], '2026-04-02').allRequiredAnswered).toBe(true);
  });

  it('moves a container WIP to Shared to Published to Archive, and never back from Published', () => {
    const approved = progress([{ required: true, answer: 'APPROVED' }], '2026-04-02');
    const base = { actorId: 'publisher', authorId: 'author', reason: null, latest: approved };
    expect(codeOf(() => assertContainerMove({ ...base, from: 'WIP', to: 'SHARED' }))).toBe('NO_ERROR');
    expect(codeOf(() => assertContainerMove({ ...base, from: 'WIP', to: 'SHARED', latest: null }))).toBe('TRANSMITTAL_REQUIRED');
    expect(codeOf(() => assertContainerMove({ ...base, from: 'WIP', to: 'PUBLISHED' }))).toBe('TRANSMITTAL_STATE_INVALID');
    expect(codeOf(() => assertContainerMove({ ...base, from: 'SHARED', to: 'PUBLISHED' }))).toBe('NO_ERROR');
    expect(codeOf(() => assertContainerMove({ ...base, from: 'SHARED', to: 'PUBLISHED', actorId: 'author' }))).toBe('SELF_APPROVAL_DENIED');
    expect(codeOf(() => assertContainerMove({ ...base, from: 'SHARED', to: 'PUBLISHED', latest: progress([{ required: true, answer: 'REJECTED' }], '2026-04-02') }))).toBe('TRANSMITTAL_NOT_APPROVED');
    expect(codeOf(() => assertContainerMove({ ...base, from: 'SHARED', to: 'PUBLISHED', latest: progress([{ required: true, answer: null }], '2026-04-02') }))).toBe('TRANSMITTAL_NOT_APPROVED');
    expect(codeOf(() => assertContainerMove({ ...base, from: 'PUBLISHED', to: 'WIP' }))).toBe('TRANSMITTAL_STATE_INVALID');
    expect(codeOf(() => assertContainerMove({ ...base, from: 'PUBLISHED', to: 'ARCHIVE' }))).toBe('VALIDATION_FAILED');
    expect(codeOf(() => assertContainerMove({ ...base, from: 'PUBLISHED', to: 'ARCHIVE', reason: 'Superseded by revision B' }))).toBe('NO_ERROR');
    expect(codeOf(() => assertContainerMove({ ...base, from: 'ARCHIVE', to: 'WIP' }))).toBe('TRANSMITTAL_STATE_INVALID');
  });

  it('checks the shape of a transmittal, an extension and an answer', () => {
    expect(codeOf(() => assertTransmittalShape({ purpose: 'FOR_REVIEW', documentIds: ['d1'], recipients: [{ required: false }] }))).toBe('VALIDATION_FAILED');
    expect(codeOf(() => assertTransmittalShape({ purpose: 'FOR_INFORMATION', documentIds: ['d1'], recipients: [{ required: false }] }))).toBe('NO_ERROR');
    expect(codeOf(() => assertTransmittalShape({ purpose: 'FOR_REVIEW', documentIds: ['d1', 'd1'], recipients: [{ required: true }] }))).toBe('VALIDATION_FAILED');
    expect(codeOf(() => assertTransmittalExtension({ dueOn: '2026-04-06', newDueOn: '2026-04-10', alreadyExtended: false, reason: 'Waiting for the survey' }, policy))).toBe('NO_ERROR');
    expect(codeOf(() => assertTransmittalExtension({ dueOn: '2026-04-06', newDueOn: '2026-05-10', alreadyExtended: false, reason: 'Waiting for the survey' }, policy))).toBe('VALIDATION_FAILED');
    expect(codeOf(() => assertTransmittalExtension({ dueOn: '2026-04-06', newDueOn: '2026-04-07', alreadyExtended: true, reason: 'Waiting for the survey' }, policy))).toBe('TRANSMITTAL_STATE_INVALID');
    expect(codeOf(() => assertAnswerAllowed({ answer: 'REJECTED', comment: null, alreadyAnswered: false }))).toBe('VALIDATION_FAILED');
    expect(codeOf(() => assertAnswerAllowed({ answer: 'APPROVED', comment: null, alreadyAnswered: true }))).toBe('TRANSMITTAL_STATE_INVALID');
    expect(transmittalPolicyOf({ review_days: 3, approval_days: 7, reminder_days: 1, max_extension_days: 5 }).review_days).toBe(3);
    expect(codeOf(() => transmittalPolicyOf({ review_days: 0, approval_days: 7, reminder_days: 1, max_extension_days: 5 }))).toBe('VALIDATION_FAILED');
  });
});
