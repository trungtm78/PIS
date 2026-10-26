import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { feedbackRecord, planRecord, timersRecord } from '../test-support';
import { toPlanLine } from '../plan/model';
import type { PlanLine } from '../plan/model';
import {
  EMPTY_APPROVE_FORM,
  EMPTY_FEEDBACK_FORM,
  EMPTY_NOTE_FORM,
  EMPTY_POST_FORM,
  FEEDBACK_CHANNELS,
  POSTING_STATUSES,
  approveBody,
  canApproveIt,
  canApprovePlan,
  canPost,
  canWritePosting,
  daysLeft,
  describeProblem,
  feedbackBody,
  handlesFeedback,
  postBody,
  postingElapsed,
  postingPlans,
  takesFeedback,
  toFeedbackLine,
  toPlanTimers,
  validateApprove,
  validateFeedback,
  validateNote,
  validatePost,
} from './model';

const plan = (overrides: Record<string, unknown> = {}): PlanLine => toPlanLine(planRecord(1, overrides)) as PlanLine;
const DOCUMENT = '00000000-0000-4000-8000-000000000a01';

describe('toFeedbackLine and toPlanTimers', () => {
  it('reads an opinion with the household it came from, or none, and how it was handled', () => {
    expect(toFeedbackLine(feedbackRecord(1, 'p'))).toEqual({
      id: feedbackRecord(1, 'p').id,
      householdId: feedbackRecord(1, 'p').household_id,
      householdCode: 'HH-000001',
      channel: 'MEETING',
      summary: 'Giá nhà quá thấp',
      status: 'OPEN',
      recordedOn: '2026-08-05',
      handledOn: null,
      handlingNote: null,
    });
    expect(toFeedbackLine(feedbackRecord(2, 'p', { household_id: null, household_code: null, status: 'HANDLED', handled_on: '2026-08-07', handling_note: 'Đã đo lại' }))).toMatchObject({
      householdId: null,
      householdCode: null,
      status: 'HANDLED',
      handledOn: '2026-08-07',
      handlingNote: 'Đã đo lại',
    });
  });

  it('drops an opinion it cannot read rather than showing it half', () => {
    expect(toFeedbackLine(null)).toBeUndefined();
    expect(toFeedbackLine([])).toBeUndefined();
    for (const field of ['id', 'channel', 'summary', 'status', 'recorded_on']) expect(toFeedbackLine(feedbackRecord(1, 'p', { [field]: undefined }))).toBeUndefined();
    expect(toFeedbackLine(feedbackRecord(1, 'p', { channel: 'SMOKE' }))).toBeUndefined();
    expect(toFeedbackLine(feedbackRecord(1, 'p', { status: 'LOST' }))).toBeUndefined();
  });

  it('reads the timers of a plan with the rule that counted each and what is left of it', () => {
    const timers = toPlanTimers(timersRecord('p', { feedback_open: 2, feedback_handled: 3, approved_on: '2026-09-01', payment_due_on: '2026-10-01', payment_remaining_days: 5 }));
    expect(timers).toMatchObject({ planId: 'p', status: 'POSTING', postingStartedOn: '2026-08-01', postingEndsOn: '2026-08-31', approvedOn: '2026-09-01', paymentDueOn: '2026-10-01', paymentRemainingDays: 5, feedbackOpen: 2, feedbackHandled: 3 });
    expect(timers?.deadlines).toEqual([
      {
        id: expect.any(String),
        timerCode: 'PLAN_POSTING_30',
        daysApplied: 30,
        startedOn: '2026-08-01',
        dueOn: '2026-08-31',
        satisfiedOn: null,
        status: 'RUNNING',
        remainingDays: 30,
        legalBasis: expect.stringContaining('Luật Đất đai 2024'),
        awaitingConfirmation: true,
      },
    ]);
    expect(toPlanTimers({ ...timersRecord('p'), deadlines: undefined })?.deadlines).toEqual([]);
    expect(toPlanTimers({ ...timersRecord('p'), deadlines: [{ id: 'x' }, null, 5] })?.deadlines).toEqual([]);
    expect(toPlanTimers({ ...timersRecord('p'), deadlines: [{ ...timersRecord('p').deadlines[0], timer_code: 'NOTHING' }] })?.deadlines).toEqual([]);
  });

  it('is nothing when the answer is not a set of timers', () => {
    expect(toPlanTimers(undefined)).toBeUndefined();
    for (const field of ['plan_id', 'status', 'feedback_open', 'feedback_handled']) expect(toPlanTimers({ ...timersRecord('p'), [field]: undefined })).toBeUndefined();
  });
});

describe('what a plan allows', () => {
  it('lists the plans that have to do with a posting', () => {
    const statuses = ['DRAFT', 'POSTING', 'POSTING_CLOSED', 'APPROVED', 'PAYING', 'COMPLETED', 'CANCELLED', 'REVISED'] as const;
    expect(postingPlans(statuses.map((status) => plan({ status }))).map((line) => line.status)).toEqual([...POSTING_STATUSES]);
  });

  it('posts a draft that has an amount, takes opinions while posted, handles them until the approval, and approves a plan whose posting closed', () => {
    const statuses = ['DRAFT', 'POSTING', 'POSTING_CLOSED', 'APPROVED', 'REVISED'] as const;
    expect(statuses.filter((status) => canPost(plan({ status, grand_total_vnd: '5' })))).toEqual(['DRAFT']);
    expect(canPost(plan({ status: 'DRAFT', grand_total_vnd: '0' }))).toBe(false);
    expect(statuses.filter((status) => takesFeedback(plan({ status })))).toEqual(['POSTING']);
    expect(statuses.filter((status) => handlesFeedback(plan({ status })))).toEqual(['POSTING', 'POSTING_CLOSED']);
    expect(statuses.filter((status) => canApproveIt(plan({ status })))).toEqual(['POSTING_CLOSED']);
  });

  it('counts the days left to a posting and closes it from the day it ends', () => {
    const posted = plan({ status: 'POSTING', posting_started_on: '2026-08-01', posting_ends_on: '2026-08-31' });
    expect(daysLeft(posted, '2026-08-30')).toBe(1);
    expect(daysLeft(posted, '2026-09-02')).toBe(-2);
    expect(postingElapsed(posted, '2026-08-30')).toBe(false);
    expect(postingElapsed(posted, '2026-08-31')).toBe(true);
    expect(postingElapsed(plan({ status: 'POSTING_CLOSED', posting_ends_on: '2020-01-01' }), '2026-08-31')).toBe(false);
    expect(postingElapsed(plan({ status: 'POSTING' }), '2026-08-31')).toBe(false);
    expect(daysLeft(plan(), '2026-08-31')).toBeNull();
  });

  it('gates the buttons by the permission and by a session that only reads', () => {
    expect(canWritePosting(['land.plan.write'], 'FULL')).toBe(true);
    expect(canWritePosting(['land.read'], 'FULL')).toBe(false);
    expect(canWritePosting(['land.plan.write'], 'READ_ONLY')).toBe(false);
    expect(canWritePosting(undefined, undefined)).toBe(true);
    expect(canApprovePlan(['land.plan.approve'], undefined)).toBe(true);
    expect(canApprovePlan(['land.plan.write'], undefined)).toBe(false);
    expect(canApprovePlan(['land.plan.approve'], 'READ_ONLY')).toBe(false);
  });
});

describe('the forms', () => {
  it('wants a day that has come and a place in words to post', () => {
    expect(validatePost(EMPTY_POST_FORM, '2026-10-26')).toEqual({ postingStartedOn: 'required', postingPlaceText: 'required' });
    expect(validatePost({ postingStartedOn: '2026-02-30', postingPlaceText: 'x' }, '2026-10-26')).toEqual({ postingStartedOn: 'invalid' });
    expect(validatePost({ postingStartedOn: '2026-10-27', postingPlaceText: 'x' }, '2026-10-26')).toEqual({ postingStartedOn: 'future' });
    expect(validatePost({ postingStartedOn: '2026-10-26', postingPlaceText: 'x'.repeat(2001) }, '2026-10-26')).toEqual({ postingPlaceText: 'tooLong' });
    expect(validatePost({ postingStartedOn: '2026-10-26', postingPlaceText: 'a\u0007b' }, '2026-10-26')).toEqual({ postingPlaceText: 'invalid' });
    expect(validatePost({ postingStartedOn: ' 2026-10-26 ', postingPlaceText: ' UBND ' }, '2026-10-26')).toEqual({});
    expect(postBody({ postingStartedOn: ' 2026-10-26 ', postingPlaceText: ' UBND ' })).toEqual({ posting_started_on: '2026-10-26', posting_place_text: 'UBND' });
  });

  it('wants a channel and words for an opinion, and names the household only when there is one', () => {
    expect(validateFeedback(EMPTY_FEEDBACK_FORM)).toEqual({ channel: 'required', summary: 'required' });
    expect(validateFeedback({ householdId: '', channel: 'LETTER', summary: 'Đề nghị đo lại' })).toEqual({});
    expect(feedbackBody({ householdId: '', channel: 'LETTER', summary: ' Đề nghị đo lại ' })).toEqual({ summary: 'Đề nghị đo lại', channel: 'LETTER' });
    expect(feedbackBody({ householdId: 'h-1', channel: 'MEETING', summary: 'x' })).toEqual({ summary: 'x', channel: 'MEETING', household_id: 'h-1' });
    expect(FEEDBACK_CHANNELS).toEqual(['IN_PERSON', 'LETTER', 'PORTAL', 'MEETING']);
  });

  it('wants words for a handling and for the summary at the closing', () => {
    expect(validateNote(EMPTY_NOTE_FORM)).toEqual({ note: 'required' });
    expect(validateNote({ note: 'x'.repeat(2001) })).toEqual({ note: 'tooLong' });
    expect(validateNote({ note: 'a\u0000b' })).toEqual({ note: 'invalid' });
    expect(validateNote({ note: ' Đã giải thích ' })).toEqual({});
  });

  it('wants a day that has come and is not before the posting ended, and a decision document, to approve', () => {
    const closed = plan({ status: 'POSTING_CLOSED', posting_ends_on: '2026-08-31' });
    expect(validateApprove(EMPTY_APPROVE_FORM, closed, '2026-10-26')).toEqual({ approvedOn: 'required', decisionDocumentVersionId: 'required' });
    expect(validateApprove({ approvedOn: 'soon', decisionDocumentVersionId: 'x' }, closed, '2026-10-26')).toEqual({ approvedOn: 'invalid', decisionDocumentVersionId: 'invalid' });
    expect(validateApprove({ approvedOn: '2026-10-27', decisionDocumentVersionId: DOCUMENT }, closed, '2026-10-26')).toEqual({ approvedOn: 'future' });
    expect(validateApprove({ approvedOn: '2026-08-30', decisionDocumentVersionId: DOCUMENT }, closed, '2026-10-26')).toEqual({ approvedOn: 'early' });
    expect(validateApprove({ approvedOn: '2026-08-31', decisionDocumentVersionId: DOCUMENT }, closed, '2026-10-26')).toEqual({});
    expect(validateApprove({ approvedOn: '2026-01-01', decisionDocumentVersionId: DOCUMENT }, plan({ status: 'POSTING_CLOSED' }), '2026-10-26')).toEqual({});
    expect(approveBody({ approvedOn: ' 2026-08-31 ', decisionDocumentVersionId: ` ${DOCUMENT.toUpperCase()} ` })).toEqual({ approved_on: '2026-08-31', decision_document_version_id: DOCUMENT });
  });
});

describe('describeProblem', () => {
  const fail = (code: string) => new ApiError({ status: 422, code, correlationId: 'c', extensions: {} });

  it('maps the refusals of the commands of the posting and the approval to what a dialog says', () => {
    const cases: Array<[string, string]> = [
      ['PLAN_STATE_INVALID', 'stateInvalid'],
      ['PLAN_HAS_NO_ITEMS', 'noItems'],
      ['INVENTORY_NOT_CONFIRMED', 'notConfirmed'],
      ['TIMER_RULE_UNCONFIRMED', 'ruleUnconfirmed'],
      ['POSTING_PERIOD_NOT_ELAPSED', 'notElapsed'],
      ['UNRESOLVED_FEEDBACK', 'unresolved'],
      ['SELF_APPROVAL_DENIED', 'selfApproval'],
      ['DECISION_DOCUMENT_REQUIRED', 'decisionRequired'],
      ['DOCUMENT_NOT_CLEAN', 'documentNotClean'],
      ['FEEDBACK_ALREADY_HANDLED', 'alreadyHandled'],
      ['VERSION_CONFLICT', 'versionConflict'],
      ['SCOPE_DENIED', 'scopeDenied'],
      ['VALIDATION_FAILED', 'validation'],
      ['INVALID_REQUEST', 'validation'],
      ['FIELD_NOT_ALLOWED', 'validation'],
      ['RESOURCE_NOT_FOUND', 'notFound'],
    ];
    for (const [code, problem] of cases) expect(describeProblem(fail(code))).toBe(problem);
    expect(describeProblem(fail('SOMETHING_ELSE'))).toBe('general');
    expect(describeProblem(new Error('boom'))).toBe('general');
  });
});
