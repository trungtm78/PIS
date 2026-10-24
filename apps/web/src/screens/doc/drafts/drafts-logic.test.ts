import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import type { Translator } from '../../../i18n';
import {
  authorityMessage,
  cancelCodeLabel,
  checklistLabel,
  circulationLabel,
  effectLabel,
  eventLabel,
  failureMessage,
  fieldProblemMessage,
  problemMessage,
  recipientKindLabel,
  signingModeLabel,
  statusLabel,
  statusMark,
  urgencyLabel,
} from './labels';
import { describeProblem } from './problems';
import {
  EMPTY_FORM,
  checklistBody,
  checklistComplete,
  createBody,
  editable,
  formOf,
  formProblems,
  groupDigits,
  isUuid,
  missingFields,
  newRecipient,
  nextRoute,
  payloadFields,
  payloadOf,
  placeholdersOf,
  reasonProblem,
  updateBody,
  valuesOf,
  vietnamDate,
} from './rules';
import { CANCEL_CODES, CIRCULATIONS, DOCUMENT_STATUSES, EFFECT_STATUSES, RECIPIENT_KINDS, REVIEW_CHECKLIST, SIGNING_MODES, URGENCIES, toDetail, toPage, toRow } from './types';

const SIGNER = '00000000-0000-4000-8000-0000000000b2';
const messages = vi_ as Record<string, string>;
const t = ((key: string, params?: Record<string, string | number>) => Object.entries(params ?? {}).reduce((out, [name, value]) => out.replace(`{${name}}`, String(value)), messages[key] ?? `MISSING ${key}`)) as Translator['t'];

describe('payloads and forms', () => {
  it('reads the placeholders of a body in order of first use, each once', () => {
    expect(placeholdersOf([{ text: '{{title}} and {{ body }}' }, { text: '{{title}} {{content_blocks.annex}}' }])).toEqual(['title', 'body', 'content_blocks.annex']);
    expect(placeholdersOf([])).toEqual([]);
  });

  it('asks for the required members first, leaves the fixed members to their own fields and writes running text in a text area', () => {
    const fields = payloadFields([{ text: '{{title}} {{body}} {{agency}} {{extra_text}} {{grounds}} {{note}}' }], ['body', 'title']);
    expect(fields.map((field) => [field.name, field.required, field.multiline])).toEqual([
      ['body', true, true],
      ['title', true, false],
      ['extra_text', false, true],
      ['grounds', false, true],
      ['note', false, false],
    ]);
  });

  it('builds a payload without empty values and with nested members for dotted names, and reads it back', () => {
    const payload = payloadOf({ agency: ' People Committee ', place: '  ', 'content_blocks.annex': 'Annex 1', 'content_blocks.other.deep': 'x', amount_vnd: '5' });
    expect(payload).toEqual({ agency: 'People Committee', content_blocks: { annex: 'Annex 1', other: { deep: 'x' } }, amount_vnd: '5' });
    expect(valuesOf({ ...payload, number: 5, list: ['a'], empty: null })).toEqual({ agency: 'People Committee', 'content_blocks.annex': 'Annex 1', 'content_blocks.other.deep': 'x', amount_vnd: '5' });
    // A name that is also the start of a longer name keeps the value of the longer one in a nested member.
    expect(payloadOf({ 'a.b': '1', 'a.c': '2' })).toEqual({ a: { b: '1', c: '2' } });
  });

  it('checks the shape of the form: the type, the unit and the summary, the amount, the people and the recipients', () => {
    const form = { ...EMPTY_FORM, values: { amount_vnd: '12.5' }, signerId: 'x', delegationId: 'y', signingMode: 'TUQ' as const, recipients: [newRecipient('PERSON', ' ')] };
    expect(formProblems(form, { creating: true }).map((problem) => `${problem.field}:${problem.code}`)).toEqual([
      'docTypeCode:REQUIRED',
      'unitId:REQUIRED',
      'title:REQUIRED',
      'amount_vnd:INVALID',
      'signerId:INVALID',
      'delegationId:INVALID',
      'recipients:REQUIRED',
    ]);
    expect(formProblems({ ...form, docTypeCode: 'QD', unitId: 'u', title: 'ab', values: {}, signerId: SIGNER, delegationId: '', recipients: [] }, { creating: false }).map((problem) => `${problem.field}:${problem.code}`)).toEqual([
      'title:TOO_SHORT',
      'delegationId:DELEGATION_REQUIRED',
    ]);
    expect(formProblems({ ...EMPTY_FORM, title: 'x'.repeat(501), delegationId: SIGNER }, { creating: false }).map((problem) => `${problem.field}:${problem.code}`)).toEqual(['title:TOO_LONG', 'delegationId:DELEGATION_NOT_ALLOWED']);
    expect(formProblems({ ...EMPTY_FORM, title: 'A title', recipients: Array.from({ length: 501 }, () => newRecipient('PERSON', 'n')) }, { creating: false }).map((problem) => problem.code)).toEqual(['TOO_LONG']);
    expect(formProblems({ ...EMPTY_FORM, title: 'A title' }, { creating: false })).toEqual([]);
    expect(isUuid(` ${SIGNER.toUpperCase()} `)).toBe(true);
    expect(isUuid('nope')).toBe(false);
  });

  it('names the members of the payload that are still empty, the fixed ones and those of the template', () => {
    const form = { ...EMPTY_FORM, values: { agency: 'A', body: ' ' } };
    expect(missingFields(form, ['body', 'title', 'agency'])).toEqual(['place', 'body', 'title']);
  });

  it('builds the body of the create and of the update command from the form', () => {
    const form = {
      ...EMPTY_FORM,
      docTypeCode: 'QD',
      templateCode: 'QD-DEFAULT',
      title: ' A title ',
      unitId: 'unit',
      values: { agency: 'A' },
      recipients: [newRecipient('INTERNAL_UNIT', ' Archive ', ' R-1 '), newRecipient('PERSON', 'Somebody', '')],
      signerId: ` ${SIGNER.toUpperCase()} `,
      signingMode: 'KT' as const,
      delegationId: ` ${SIGNER} `,
    };
    expect(createBody(form)).toEqual({
      doc_type_code: 'QD',
      template_code: 'QD-DEFAULT',
      title: 'A title',
      drafting_unit_id: 'unit',
      urgency: 'NORMAL',
      circulation: 'INTERNAL_CIRCULATION',
      payload: { agency: 'A' },
      recipients: [
        { kind: 'INTERNAL_UNIT', name: 'Archive', code: 'R-1' },
        { kind: 'PERSON', name: 'Somebody' },
      ],
      signing_mode: 'KT',
      signer_user_id: SIGNER,
      delegation_id: SIGNER,
    });
    expect(createBody({ ...form, templateCode: '', signerId: '', delegationId: '', signingMode: 'DIRECT' })).not.toHaveProperty('template_code');
    expect(updateBody(form)).toEqual({
      title: 'A title',
      urgency: 'NORMAL',
      payload: { agency: 'A' },
      recipients: [
        { kind: 'INTERNAL_UNIT', name: 'Archive', code: 'R-1' },
        { kind: 'PERSON', name: 'Somebody' },
      ],
      signing_mode: 'KT',
      signer_user_id: SIGNER,
      delegation_id: SIGNER,
    });
  });

  it('turns a stored draft back into a form', () => {
    const detail = toDetail({
      id: 'd',
      document_id: 'doc',
      title: 'T',
      doc_type_code: 'QD',
      status: 'DRAFT',
      urgency: 'HOA_TOC',
      circulation: 'PUBLIC',
      drafting_unit_id: 'u',
      signer_user_id: SIGNER,
      signing_mode: 'TL',
      delegation_id: SIGNER,
      payload: { agency: 'A', content_blocks: { annex: 'x' } },
      recipients: [{ kind: 'PERSON', name: 'N', code: 'C' }, { name: 'M', unit_id: 'u2' }],
    });
    const form = formOf(detail, 'QD-DEFAULT');
    expect(form).toMatchObject({ docTypeCode: 'QD', templateCode: 'QD-DEFAULT', title: 'T', unitId: 'u', urgency: 'HOA_TOC', circulation: 'PUBLIC', signerId: SIGNER, signingMode: 'TL', delegationId: SIGNER });
    expect(form.values).toEqual({ agency: 'A', 'content_blocks.annex': 'x' });
    expect(form.recipients.map((recipient) => [recipient.kind, recipient.name, recipient.code])).toEqual([
      ['PERSON', 'N', 'C'],
      ['EXTERNAL_AGENCY', 'M', ''],
    ]);
    expect(detail.recipients[1]?.unitId).toBe('u2');
    expect(formOf(toDetail({}), '').signerId).toBe('');
  });

  it('keeps the checklist and the reason honest', () => {
    expect(checklistComplete({})).toBe(false);
    expect(checklistComplete(Object.fromEntries(REVIEW_CHECKLIST.map((key) => [key, true])))).toBe(true);
    expect(checklistBody({ motto: true })).toEqual({ national_title: false, motto: true, agency_name: false, number_symbol: false, summary: false, body: false, signer_title: false, recipients: false });
    expect(reasonProblem('  ')).toBe('REQUIRED');
    expect(reasonProblem('short')).toBe('TOO_SHORT');
    expect(reasonProblem('long enough reason')).toBeUndefined();
  });

  it('knows the day in Vietnam, where work goes next and what can still be edited', () => {
    expect(vietnamDate(new Date('2026-10-23T18:30:00Z'))).toBe('2026-10-24');
    expect(vietnamDate(new Date('2026-10-23T16:59:00Z'))).toBe('2026-10-23');
    expect(['DRAFT', 'IN_REVIEW', 'SUBMITTED', 'SIGNED', 'ISSUED'].map(nextRoute)).toEqual(['editor', 'review', 'signing', 'numbering', 'none']);
    expect(editable('DRAFT')).toBe(true);
    expect(editable('IN_REVIEW')).toBe(false);
    expect(groupDigits('6000000000')).toBe('6.000.000.000');
    expect(groupDigits('999')).toBe('999');
    expect(groupDigits('1000')).toBe('1.000');
  });
});

describe('what the server answers', () => {
  it('reads a row and a page, falling back to safe values for anything unknown', () => {
    expect(toRow({})).toMatchObject({ id: '', status: 'DRAFT', effectStatus: 'PENDING', urgency: 'NORMAL', signingMode: 'DIRECT', signerUserId: null, documentNumber: null, version: 0 });
    expect(toRow({ status: 'WEIRD', urgency: 5, document_number: 7, version: 'x' })).toMatchObject({ status: 'DRAFT', urgency: 'NORMAL', documentNumber: 7, version: 0 });
    expect(toPage({ items: [{ id: 'a' }], next_cursor: 'n' })).toMatchObject({ items: [{ id: 'a' }], nextCursor: 'n' });
    expect(toPage(null)).toEqual({ items: [], nextCursor: undefined });
    expect(toPage({ items: 'x', next_cursor: null }).items).toEqual([]);
  });

  it('reads the detail with the latest review and the versions', () => {
    const detail = toDetail({
      id: 'd',
      latest_review: { kind: 'RETURNED', actor_id: 'a', comment: 'why', checklist: { motto: true }, file_sha256: 'f', occurred_at: 't' },
      versions: [{ id: 'v', stage: 'RENDERED_FINAL', checksum: 'c', page_count: 2 }, 'junk'],
      payload: 'not an object',
      recipients: 'not a list',
    });
    expect(detail.latestReview).toMatchObject({ kind: 'RETURNED', comment: 'why', fileSha256: 'f' });
    expect(detail.latestReview?.checklist?.motto).toBe(true);
    expect(detail.latestReview?.checklist?.body).toBe(false);
    expect(detail.versions).toEqual([{ id: 'v', stage: 'RENDERED_FINAL', checksum: 'c', pageCount: 2 }, { id: '', stage: '', checksum: '', pageCount: 0 }]);
    expect(detail.payload).toEqual({});
    expect(detail.recipients).toEqual([]);
    expect(toDetail({ latest_review: { kind: 'REVIEW_APPROVED' } }).latestReview).toMatchObject({ kind: 'REVIEW_APPROVED', checklist: null, comment: null });
    expect(toDetail({ latest_review: 'x' }).latestReview).toBeNull();
  });

  it('maps a failed command to the reason, the failures, the authority and the band', () => {
    const error = (code: string, extensions: Record<string, unknown> = {}, detail?: string) => new ApiError({ status: 422, code, correlationId: 'c', extensions, ...(detail === undefined ? {} : { detail }) });
    expect(describeProblem(new Error('x'))).toEqual({ reason: 'general', field: undefined, failures: [], authority: undefined, threshold: undefined });
    expect(describeProblem(error('SOMETHING_NEW'))).toMatchObject({ reason: 'general' });
    const codes: Record<string, string> = {
      VERSION_CONFLICT: 'conflict',
      DOCUMENT_STATE_INVALID: 'state',
      FORMAT_CHECK_FAILED: 'formatCheck',
      SIGNER_NOT_AUTHORIZED: 'notAuthorised',
      STATE_SECRET_NOT_SUPPORTED: 'stateSecret',
      TEMPLATE_NOT_EFFECTIVE: 'templateNotEffective',
      PAYLOAD_SCHEMA_INVALID: 'payloadInvalid',
      SELF_APPROVAL_DENIED: 'selfApproval',
      SUBJECT_REF_INVALID: 'subjectRef',
      NUMBER_ALREADY_ALLOCATED: 'numberAllocated',
      VALIDATION_FAILED: 'invalid',
      INVALID_REQUEST: 'invalid',
      FIELD_NOT_ALLOWED: 'invalid',
      RESOURCE_NOT_FOUND: 'notFound',
      SCOPE_DENIED: 'denied',
      ENTITLEMENT_DENIED: 'denied',
      SESSION_EXPIRED: 'session',
      IDEMPOTENCY_CONFLICT: 'duplicate',
    };
    for (const [code, reason] of Object.entries(codes)) expect(describeProblem(error(code)).reason).toBe(reason);
    const failures = [{ field: 'recipients', code: 'RECIPIENTS_REQUIRED' }, { field: 5 }, 'junk', { field: 'x', code: 'Y' }];
    const threshold = { document_type: 'QD', amount_vnd: '6', amount_min_vnd: '5', amount_max_vnd: null, approver_role_id: 'r' };
    expect(describeProblem(error('FORMAT_CHECK_FAILED', { failures }, 'recipients')).failures).toEqual([{ field: 'recipients', code: 'RECIPIENTS_REQUIRED' }, { field: 'x', code: 'Y' }]);
    expect(describeProblem(error('SIGNER_NOT_AUTHORIZED', { reason: 'ROLE_NOT_HELD', threshold }))).toMatchObject({
      authority: 'ROLE_NOT_HELD',
      threshold: { documentType: 'QD', amountVnd: '6', amountMinVnd: '5', amountMaxVnd: null, approverRoleId: 'r' },
    });
    expect(describeProblem(error('SIGNER_NOT_AUTHORIZED', { threshold: 'junk', failures: 'junk' }))).toMatchObject({ threshold: undefined, failures: [] });
    expect(describeProblem(error('SIGNER_NOT_AUTHORIZED', { threshold: {} })).threshold).toEqual({ documentType: '', amountVnd: null, amountMinVnd: null, amountMaxVnd: null, approverRoleId: null });
  });
});

describe('the words of the screens', () => {
  it('has a text for every status, effect, urgency, circulation, mode, kind, checklist item, cancel code and event', () => {
    const everything = [
      ...DOCUMENT_STATUSES.map((status) => statusLabel(t, status)),
      ...EFFECT_STATUSES.map((effect) => effectLabel(t, effect)),
      ...URGENCIES.map((urgency) => urgencyLabel(t, urgency)),
      ...CIRCULATIONS.map((circulation) => circulationLabel(t, circulation)),
      ...SIGNING_MODES.map((mode) => signingModeLabel(t, mode)),
      ...RECIPIENT_KINDS.map((kind) => recipientKindLabel(t, kind)),
      ...REVIEW_CHECKLIST.map((key) => checklistLabel(t, key)),
      ...CANCEL_CODES.map((code) => cancelCodeLabel(t, code)),
      ...['CREATED', 'REVIEW_REQUESTED', 'REVIEW_APPROVED', 'RETURNED', 'CANCELLED', 'LEADER_SIGNED', 'NUMBERED', 'SEALED', 'SOMETHING'].map((kind) => eventLabel(t, kind)),
    ];
    expect(everything.filter((text) => text.startsWith('MISSING') || text === '')).toEqual([]);
    expect(new Set(DOCUMENT_STATUSES.map((status) => statusLabel(t, status))).size).toBe(DOCUMENT_STATUSES.length);
    for (const status of DOCUMENT_STATUSES) expect(statusMark(status).length).toBeGreaterThan(0);
  });

  it('explains each failure code, each reason of authority with the band, each problem and each field problem', () => {
    const failures = ['RECIPIENTS_REQUIRED', 'SIGNER_REQUIRED', 'DELEGATION_REQUIRED', 'TEMPLATE_NOT_EFFECTIVE', 'PAYLOAD_FIELD_REQUIRED', 'CHECK_NOT_CONFIRMED', 'UNKNOWN'].map((code) =>
      failureMessage(t, { field: code === 'CHECK_NOT_CONFIRMED' ? 'format_checklist.motto' : 'payload.place', code }),
    );
    expect(failures.filter((text) => text.startsWith('MISSING'))).toEqual([]);
    expect(failures[4]).toContain('place');
    expect(failures[5]).toContain('motto');
    const band = { documentType: 'QD', amountVnd: '6', amountMinVnd: '5000000000', amountMaxVnd: null, approverRoleId: 'r' };
    expect(authorityMessage(t, 'ROLE_NOT_HELD', band)).toContain('5.000.000.000');
    expect(authorityMessage(t, 'ROLE_NOT_HELD', { ...band, amountMaxVnd: '9000000000' })).toContain('9.000.000.000');
    expect(authorityMessage(t, 'DELEGATOR_NOT_AUTHORIZED', band)).toContain('5.000.000.000');
    expect(authorityMessage(t, 'ROLE_NOT_HELD', undefined)).toBe(messages['doc.draft.authority.role']);
    expect(authorityMessage(t, 'ROLE_NOT_HELD', { ...band, amountMinVnd: null })).toBe(messages['doc.draft.authority.role']);
    const reasons = ['DOA_RULE_NOT_FOUND', 'SIGNER_INACTIVE', 'DELEGATION_MISSING', 'DELEGATION_EXPIRED', 'DELEGATION_INVALID', undefined, 'OTHER'].map((reason) => authorityMessage(t, reason, undefined));
    expect(new Set(reasons).size).toBe(6);
    for (const reason of ['conflict', 'state', 'formatCheck', 'notAuthorised', 'stateSecret', 'templateNotEffective', 'payloadInvalid', 'selfApproval', 'subjectRef', 'numberAllocated', 'invalid', 'notFound', 'denied', 'session', 'duplicate', 'general'] as const) {
      expect(problemMessage(t, { reason, field: undefined, failures: [], authority: undefined, threshold: undefined }).startsWith('MISSING')).toBe(false);
    }
    for (const code of ['REQUIRED', 'TOO_SHORT', 'TOO_LONG', 'INVALID', 'DELEGATION_REQUIRED', 'DELEGATION_NOT_ALLOWED'] as const) {
      expect(fieldProblemMessage(t, { field: 'f', code }).startsWith('MISSING')).toBe(false);
    }
  });
});
