import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { toProposal } from '../proposal/model';
import {
  ANSWER_PERMISSION,
  MAX_QUESTION,
  READ_PERMISSION,
  SEND_PERMISSION,
  answerBody,
  canSend,
  declarationPath,
  describeProblem,
  emptySend,
  holds,
  mayAnswer,
  readFailure,
  recipientsOf,
  sendBody,
  statusAt,
  toClarification,
  toClarificationList,
  validateAnswer,
  validateSend,
  withAnswerDraft,
  withoutAnswerDraft,
} from './model';
import { FINDING, SOMEONE, guestView, opened, proposal, request } from './test-support';

const problem = (code: string, status = 422, extensions: Record<string, unknown> = {}) => new ApiError({ status, code, correlationId: 'c', extensions });
const NOW = new Date('2026-12-01T00:00:00.000Z');
const line = (overrides: Record<string, unknown> = {}) => {
  const read = toClarification(request(1, overrides));
  if (read === undefined) throw new Error('the request does not read');
  return read;
};
const ID = '00000000-0000-4000-8000-00d000000001';

describe('the clarification requests (ST-BID-011)', () => {
  it('names the permissions of the operations', () => {
    expect([READ_PERMISSION, ANSWER_PERMISSION, SEND_PERMISSION]).toEqual(['bid.clarification.read', 'bid.clarification.answer', 'bid.evaluate']);
  });

  describe('reading a request', () => {
    it('reads what the server says, with the evaluator and the basis of a staff view', () => {
      expect(line()).toEqual({
        id: request(1).id,
        package: { id: request(1).package.id, code: 'GT-1' },
        proposalId: request(1).proposal_id,
        contractor: { id: request(1).contractor.id, legalName: 'Công ty nhà thầu 1' },
        question: request(1).question,
        basis: { id: FINDING, criterionCode: 'C2' },
        dueAt: '2099-11-20T10:00:00.000Z',
        status: 'SENT',
        sentDocumentId: request(1).sent_document_id,
        answerDocumentId: null,
        answeredAt: null,
        answeredBy: null,
        answeredAsGuest: null,
        askedBy: { membershipId: SOMEONE, displayName: 'Chuyên gia Lê Văn Hai' },
        createdAt: '2026-11-10T03:00:00.000Z',
        canAnswer: true,
        version: 1,
      });
    });

    it('reads a contractor view without the evaluator and the basis, and an answered request with who answered', () => {
      expect(toClarification(guestView(1))).toMatchObject({ basis: null, askedBy: null });
      const answered = line({ status: 'ANSWERED', answer_document_id: ID, answered_at: '2026-11-11T03:00:00.000Z', answered_by: { membership_id: 'm', display_name: 'An' }, answered_as_guest: false, actions: { answer: false } });
      expect(answered).toMatchObject({ answerDocumentId: ID, answeredAt: '2026-11-11T03:00:00.000Z', answeredBy: { membershipId: 'm', displayName: 'An' }, answeredAsGuest: false, canAnswer: false });
      expect(line({ answered_by: { membership_id: 'm' } }).answeredBy).toEqual({ membershipId: 'm', displayName: '' });
      expect(line({ package: { id: request(1).package.id }, contractor: { id: request(1).contractor.id } })).toMatchObject({ package: { code: '' }, contractor: { legalName: '' } });
      expect(line({ basis_finding: { id: ID } }).basis).toEqual({ id: ID, criterionCode: '' });
      expect(line({ actions: undefined }).canAnswer).toBe(false);
    });

    it('leaves out what is not a request', () => {
      expect(toClarification(null)).toBeUndefined();
      expect(toClarification({ ...request(1), status: 'DONE' })).toBeUndefined();
      expect(toClarification({ ...request(1), version: '1' })).toBeUndefined();
      expect(toClarification({ ...request(1), question: undefined })).toBeUndefined();
      expect(toClarification({ ...request(1), id: 7 })).toBeUndefined();
      expect(toClarification({ ...request(1), package: undefined })).toBeUndefined();
      expect(toClarification({ ...request(1), contractor: {} })).toBeUndefined();
      expect(toClarification({ ...request(1), proposal_id: undefined })).toBeUndefined();
      expect(toClarification({ ...request(1), due_at: undefined })).toBeUndefined();
      expect(toClarification({ ...request(1), created_at: undefined })).toBeUndefined();
      expect(toClarificationList({ items: [request(1), { nope: true }, request(2)] }).map((item) => item.contractor.legalName)).toEqual(['Công ty nhà thầu 1', 'Công ty nhà thầu 2']);
      expect(toClarificationList({ items: 'x' })).toEqual([]);
      expect(toClarificationList(undefined)).toEqual([]);
    });
  });

  describe('time and rights', () => {
    it('shows a request nobody answered by its deadline as EXPIRED, and any other status as it is', () => {
      expect(statusAt(line({ due_at: '2026-12-01T00:00:01.000Z' }), NOW)).toBe('SENT');
      expect(statusAt(line({ due_at: '2026-12-01T00:00:00.000Z' }), NOW)).toBe('SENT');
      expect(statusAt(line({ due_at: '2026-11-30T23:59:59.000Z' }), NOW)).toBe('EXPIRED');
      expect(statusAt(line({ status: 'ANSWERED', due_at: '2020-01-01T00:00:00.000Z' }), NOW)).toBe('ANSWERED');
      expect(statusAt(line({ status: 'WITHDRAWN', due_at: '2020-01-01T00:00:00.000Z' }), NOW)).toBe('WITHDRAWN');
    });

    it('offers the answer only when the server says so, the request waits, its time is not up, the right is held and the session is not read-only', () => {
      const waiting = line();
      expect(mayAnswer(waiting, [ANSWER_PERMISSION], 'FULL', NOW)).toBe(true);
      expect(mayAnswer(waiting, undefined, undefined, NOW)).toBe(true);
      expect(mayAnswer(waiting, [ANSWER_PERMISSION], 'READ_ONLY', NOW)).toBe(false);
      expect(mayAnswer(waiting, [READ_PERMISSION], 'FULL', NOW)).toBe(false);
      expect(mayAnswer(line({ actions: { answer: false } }), [ANSWER_PERMISSION], 'FULL', NOW)).toBe(false);
      expect(mayAnswer(line({ due_at: '2020-01-01T00:00:00.000Z' }), [ANSWER_PERMISSION], 'FULL', NOW)).toBe(false);
      expect(mayAnswer(line({ status: 'ANSWERED' }), [ANSWER_PERMISSION], 'FULL', NOW)).toBe(false);
    });

    it('asks for the right to evaluate in a session that is not read-only', () => {
      expect(canSend([SEND_PERMISSION], 'FULL')).toBe(true);
      expect(canSend([SEND_PERMISSION], 'READ_ONLY')).toBe(false);
      expect(canSend([READ_PERMISSION], 'FULL')).toBe(false);
      expect(canSend(undefined, undefined)).toBe(true);
      expect(holds([], READ_PERMISSION)).toBe(false);
    });
  });

  describe('the recipients', () => {
    it('are the live proposals the caller has in full, by the name of the contractor', () => {
      const read = [opened(2, 1), proposal(3, 1), opened(4, 1, { status: 'SUPERSEDED' }), opened(1, 1)].flatMap((raw) => toProposal(raw) ?? []);
      expect(recipientsOf(read).map((recipient) => recipient.contractorName)).toEqual(['Công ty nhà thầu 1', 'Công ty nhà thầu 2']);
      expect(recipientsOf([])).toEqual([]);
      const same = [opened(5, 1, { contractor: { id: 'c5', legal_name: 'Same' } }), opened(6, 1, { contractor: { id: 'c6', legal_name: 'Same' } })].flatMap((raw) => toProposal(raw) ?? []);
      expect(recipientsOf(same).map((recipient) => recipient.proposalId)).toEqual(same.map((entry) => entry.id).sort());
    });
  });

  describe('asking', () => {
    const form = { proposalId: ID, question: 'Explain the unit price of item 7.', basisFindingId: '', dueAt: '2099-01-01T10:00' };

    it('is well formed with a recipient, a question of 10 to 4000 characters, an optional finding and a deadline ahead', () => {
      expect(validateSend(form, NOW)).toEqual({});
      expect(validateSend({ ...form, basisFindingId: ID.toUpperCase() }, NOW)).toEqual({});
      expect(validateSend({ ...form, question: ` ${'x'.repeat(10)} ` }, NOW)).toEqual({});
      expect(validateSend({ ...form, question: 'x'.repeat(MAX_QUESTION) }, NOW)).toEqual({});
    });

    it('names what is wrong', () => {
      expect(validateSend(emptySend(), NOW)).toEqual({ proposalId: 'required', question: 'tooShort', dueAt: 'required' });
      expect(validateSend({ ...form, question: ' short    ' }, NOW).question).toBe('tooShort');
      expect(validateSend({ ...form, question: 'x'.repeat(MAX_QUESTION + 1) }, NOW).question).toBe('tooLong');
      expect(validateSend({ ...form, basisFindingId: 'nope' }, NOW).basisFindingId).toBe('uuid');
      expect(validateSend({ ...form, dueAt: 'tomorrow' }, NOW).dueAt).toBe('moment');
      expect(validateSend({ ...form, dueAt: '2026-13-45T10:00' }, NOW).dueAt).toBe('moment');
      expect(validateSend({ ...form, dueAt: '2020-01-01T10:00' }, NOW).dueAt).toBe('past');
      expect(emptySend(ID).proposalId).toBe(ID);
    });

    it('sends the question trimmed, the deadline as an instant and the finding only when one was named', () => {
      expect(sendBody({ ...form, question: `  ${form.question} ` })).toEqual({ proposal_id: ID, question: form.question, due_at: new Date('2099-01-01T10:00').toISOString() });
      expect(sendBody({ ...form, basisFindingId: ` ${ID.toUpperCase()} ` }).basis_finding_id).toBe(ID);
    });
  });

  describe('answering', () => {
    it('rests on a document that is a UUID, sent trimmed and in lower case', () => {
      expect(validateAnswer(ID)).toBeUndefined();
      expect(validateAnswer('')).toBe('required');
      expect(validateAnswer('   ')).toBe('required');
      expect(validateAnswer('nope')).toBe('uuid');
      expect(answerBody(` ${ID.toUpperCase()} `)).toEqual({ answer_document_id: ID });
    });

    it('keeps what is typed for each request apart', () => {
      const one = withAnswerDraft({}, 'a', 'x');
      const two = withAnswerDraft(one, 'b', 'y');
      expect(two).toEqual({ a: 'x', b: 'y' });
      expect(withoutAnswerDraft(two, 'a')).toEqual({ b: 'y' });
      expect(one).toEqual({ a: 'x' });
    });
  });

  describe('refusals', () => {
    it('are worded by their code, and the reason of a validation failure tells a document already used', () => {
      const cases: Array<[unknown, string]> = [
        [problem('DUE_IN_PAST'), 'dueInPast'],
        [problem('PROPOSAL_NOT_OPEN', 409), 'proposalNotOpen'],
        [problem('CONFLICT_UNDECLARED', 403), 'undeclared'],
        [problem('CLARIFICATION_EXPIRED', 409), 'expired'],
        [problem('CLARIFICATION_STATE_INVALID', 409), 'answered'],
        [problem('VERSION_CONFLICT', 409), 'versionConflict'],
        [problem('VALIDATION_FAILED', 422, { reason: 'DOCUMENT_ALREADY_USED' }), 'documentUsed'],
        [problem('VALIDATION_FAILED'), 'validation'],
        [problem('INVALID_REQUEST', 400), 'validation'],
        [problem('FIELD_NOT_ALLOWED', 400), 'validation'],
        [problem('RESOURCE_NOT_FOUND', 404), 'notFound'],
        [problem('SCOPE_DENIED', 403), 'denied'],
        [problem('ENTITLEMENT_DENIED', 403), 'denied'],
        [problem('SESSION_EXPIRED', 401), 'session'],
        [problem('SOMETHING_ELSE', 500), 'general'],
        [new Error('network'), 'general'],
      ];
      for (const [error, expected] of cases) expect(describeProblem(error)).toBe(expected);
    });

    it('treats the refusal of a read for the declaration as a call to declare, not as an error of the screen', () => {
      expect(readFailure(problem('CONFLICT_UNDECLARED', 403))).toBe('undeclared');
      expect(readFailure(problem('RESOURCE_NOT_FOUND', 404))).toBeUndefined();
      expect(readFailure(new Error('x'))).toBeUndefined();
      expect(declarationPath('p/1')).toBe('/bid/bid-05?package=p%2F1');
    });
  });
});
