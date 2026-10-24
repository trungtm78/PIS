import { describe, expect, it } from 'vitest';
import { MAX_EVIDENCE, businessMomentToIso, closureActionsOf, closureRightsOf, extensionLink, extensionProblem, lastVerificationRequest, parseEvidence, reopenDeadline, verificationLink } from './closure-model';
import type { IssueEventView } from './issue-model';

const DOC_A = '00000000-0000-4000-8000-0000000000a1';
const DOC_B = '00000000-0000-4000-8000-0000000000b2';
const ME = '00000000-0000-4000-8000-0000000000f1';
const OTHER = '00000000-0000-4000-8000-0000000000f2';
const NOW = new Date('2026-10-24T01:00:00.000Z');

const event = (kind: IssueEventView['kind'], overrides: Partial<IssueEventView> = {}): IssueEventView => ({
  id: `e-${kind}`,
  kind,
  fromStatus: null,
  toStatus: null,
  fromAssignee: null,
  toAssignee: null,
  note: null,
  actor: null,
  createdAt: '2026-10-20T02:00:00.000Z',
  documentAttached: false,
  fromUnitId: null,
  toUnitId: null,
  evidenceIds: [],
  outcome: null,
  previousDueAt: null,
  newDueAt: null,
  ...overrides,
});

describe('the end of an issue: what the screens offer (ST-ISS-003)', () => {
  it('turns the permissions of the person into rights, and none of them while the system is read-only; an unknown list of permissions is not a refusal', () => {
    expect(closureRightsOf(['issue.work', 'issue.close'], true)).toEqual({ work: true, close: true, reopen: false, extend: false, escalate: false });
    expect(closureRightsOf(['issue.reopen', 'issue.extend', 'issue.escalate'], true)).toEqual({ work: false, close: false, reopen: true, extend: true, escalate: true });
    expect(closureRightsOf(['issue.work', 'issue.close', 'issue.reopen', 'issue.extend', 'issue.escalate'], false)).toEqual({ work: false, close: false, reopen: false, extend: false, escalate: false });
    expect(closureRightsOf(undefined, true)).toEqual({ work: true, close: true, reopen: true, extend: true, escalate: true });
  });

  it('offers the request to the handler alone, the closing and the extension never to the handler, and the reopening on a closed issue (BR-ISS-05)', () => {
    const all = { work: true, close: true, reopen: true, extend: true, escalate: true };
    const handled = (status: 'IN_PROGRESS' | 'PENDING_VERIFICATION' | 'CLOSED' | 'ASSIGNED', handler: string) => ({ status, assignee: { id: handler, name: 'A' } });
    expect(closureActionsOf(handled('IN_PROGRESS', ME), all, ME)).toEqual({ request: true, close: false, reopen: false, extend: false, escalate: true });
    expect(closureActionsOf(handled('IN_PROGRESS', OTHER), all, ME)).toEqual({ request: false, close: false, reopen: false, extend: true, escalate: true });
    expect(closureActionsOf(handled('PENDING_VERIFICATION', OTHER), all, ME)).toEqual({ request: false, close: true, reopen: false, extend: false, escalate: false });
    expect(closureActionsOf(handled('PENDING_VERIFICATION', ME), all, ME)).toEqual({ request: false, close: false, reopen: false, extend: false, escalate: false });
    expect(closureActionsOf(handled('CLOSED', OTHER), all, ME)).toEqual({ request: false, close: false, reopen: true, extend: false, escalate: false });
    expect(closureActionsOf(handled('ASSIGNED', OTHER), all, undefined)).toEqual({ request: false, close: false, reopen: false, extend: true, escalate: true });
    expect(closureActionsOf({ status: 'OPEN', assignee: null }, all, ME)).toEqual({ request: false, close: false, reopen: false, extend: true, escalate: false });
    expect(closureActionsOf(handled('IN_PROGRESS', OTHER), { work: false, close: false, reopen: false, extend: false, escalate: false }, ME)).toEqual({ request: false, close: false, reopen: false, extend: false, escalate: false });
  });

  it('finds the latest request for verification of the timeline', () => {
    const first = event('VERIFICATION_REQUESTED', { id: 'first' });
    const second = event('VERIFICATION_REQUESTED', { id: 'second' });
    expect(lastVerificationRequest([first, event('REASSIGNED'), second])?.id).toBe('second');
    expect(lastVerificationRequest([event('CREATED')])).toBeUndefined();
  });

  it('reads the evidence one document version id per line, once each, in lower case, and says what is wrong with it', () => {
    expect(parseEvidence(` ${DOC_A.toUpperCase()}\n${DOC_B}, ${DOC_A}\n`, true)).toEqual({ ids: [DOC_A, DOC_B], problem: undefined });
    expect(parseEvidence('', false)).toEqual({ ids: [], problem: undefined });
    expect(parseEvidence('  \n', true)).toEqual({ ids: [], problem: 'required' });
    expect(parseEvidence(`${DOC_A}\nnot-an-id`, true)).toEqual({ ids: [], problem: 'invalid' });
    const many = Array.from({ length: MAX_EVIDENCE + 1 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`);
    expect(parseEvidence(many.join('\n'), true).problem).toBe('tooMany');
    expect(parseEvidence(many.slice(0, MAX_EVIDENCE).join('\n'), true).problem).toBeUndefined();
  });

  it('reads a moment typed on the form as Vietnam time', () => {
    expect(businessMomentToIso('2026-10-26T09:30')).toBe('2026-10-26T02:30:00.000Z');
    expect(businessMomentToIso('')).toBeUndefined();
    expect(businessMomentToIso('2026-10-26')).toBeUndefined();
    expect(businessMomentToIso('2026-13-45T25:61')).toBeUndefined();
  });

  it('judges a new deadline: it must be a moment, later than the present one, and still ahead', () => {
    const due = '2026-10-26T02:30:00.000Z';
    expect(extensionProblem('', due, NOW)).toBe('required');
    expect(extensionProblem('2026-13-45T25:61', due, NOW)).toBe('invalid');
    expect(extensionProblem('2026-10-26T09:30', due, NOW)).toBe('notLater');
    expect(extensionProblem('2026-10-26T09:31', due, NOW)).toBeUndefined();
    // A deadline that has passed long ago: a date later than it but still in the past is refused.
    expect(extensionProblem('2026-10-20T09:31', '2026-10-19T02:30:00.000Z', NOW)).toBe('inThePast');
  });

  it('counts the last day a closed issue can be reopened from the day it was closed and the window the server told', () => {
    expect(reopenDeadline({ closedAt: '2026-10-01T02:00:00.000Z', reopenWindowDays: 30 })).toBe('2026-10-31T02:00:00.000Z');
    expect(reopenDeadline({ closedAt: null, reopenWindowDays: 30 })).toBeNull();
  });

  it('addresses the screens of the end of an issue by the id of the issue', () => {
    expect(verificationLink(DOC_A)).toBe(`/iss/iss-07?id=${DOC_A}`);
    expect(extensionLink(DOC_A)).toBe(`/iss/iss-04?id=${DOC_A}`);
  });
});
