import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_REVISION,
  actionsFor,
  cxnTags,
  describeGenerationProblem,
  describeProblem,
  groupByMonth,
  isOverdue,
  lastDayOf,
  phaseOf,
  revisionBody,
  validateRevision,
  validateYear,
  vietnamToday,
  yearsAround,
} from './model';
import type { RevisionValues } from './model';
import { toForm, toGeneration, toObligation, toObligationPage } from './types';
import { formRow, obligationRow } from './test-support';

const form = (overrides: Record<string, unknown> = {}) => {
  const view = toForm(formRow(2, overrides));
  if (view === undefined) throw new Error('fixture form is invalid');
  return view;
};
const obligation = (n: number, overrides: Record<string, unknown> = {}) => {
  const view = toObligation(obligationRow(n, overrides));
  if (view === undefined) throw new Error('fixture obligation is invalid');
  return view;
};
const problem = (status: number, code: string, detail?: string) => new ApiError({ status, code, correlationId: 'c', ...(detail === undefined ? {} : { detail }) });

const VALID: RevisionValues = {
  formCode: 'TT44-M02',
  title: 'Overall report',
  reportKind: 'OVERALL_SEMIANNUAL',
  legalBasis: 'Circular 44/2026/TT-BTC [CXN-10]',
  legalConfirmationRef: '',
  effectiveFrom: '2026-01-01',
  effectiveUntil: '',
  docTemplateCode: 'MNE-TT44-M02',
  exportFormats: ['PDF', 'XLSX'],
  schemaText: '{"tables":[]}',
};

describe('the readers of the two lists', () => {
  it('reads a form row and keeps what the screen needs', () => {
    expect(form({ legal_confirmation_ref: 'CXN-10-OK', awaiting_confirmation: false, export_formats: ['XLSX', 'DOCX', 'PDF'] })).toMatchObject({
      formCode: 'TT44-M02',
      legalConfirmationRef: 'CXN-10-OK',
      awaitingConfirmation: false,
      exportFormats: ['XLSX', 'PDF'],
      docTemplateId: expect.any(String),
      version: 2,
    });
  });

  it('works out the confirmation when the row does not say it, and shows no row it cannot trust', () => {
    expect(toForm({ ...formRow(2), awaiting_confirmation: undefined })?.awaitingConfirmation).toBe(true);
    expect(toForm({ ...formRow(2), awaiting_confirmation: undefined, legal_confirmation_ref: 'CXN-10-OK' })?.awaitingConfirmation).toBe(false);
    for (const bad of [null, 'text', [], { ...formRow(2), report_kind: 'OTHER' }, { ...formRow(2), status: 'LIVE' }, { ...formRow(2), id: '' }, { ...formRow(2), form_code: undefined }]) {
      expect(toForm(bad)).toBeUndefined();
    }
    expect(toForm({ ...formRow(2), origin: 'TENANT' })?.origin).toBe('TENANT');
  });

  it('reads an obligation row, and drops one without a role, a status, an id or a due date', () => {
    expect(obligation(1)).toMatchObject({ reportingRole: 'INVESTOR', dueDate: '2026-07-10', cxnRefs: ['CXN-10'], awaitingConfirmation: true, daysLate: 0, isLate: false });
    expect(toObligation({ ...obligationRow(1), days_late: 'many', awaiting_confirmation: false })).toMatchObject({ daysLate: null, awaitingConfirmation: false });
    for (const bad of [null, 7, { ...obligationRow(1), reporting_role: 'MINISTER' }, { ...obligationRow(1), status: 'LOST' }, { ...obligationRow(1), mne_report_id: '' }, { ...obligationRow(1), due_date: '' }]) {
      expect(toObligation(bad)).toBeUndefined();
    }
  });

  it('reads a page with its cursor, an empty page for anything else, and the answer of a generation', () => {
    expect(toObligationPage({ items: [obligationRow(1), { broken: true }], next_cursor: 'abc' })).toMatchObject({ items: [{ reportId: expect.any(String) }], nextCursor: 'abc' });
    expect(toObligationPage({ items: [], next_cursor: null })).toEqual({ items: [], nextCursor: undefined });
    expect(toObligationPage('nothing')).toEqual({ items: [], nextCursor: undefined });
    expect(toGeneration({ created: 6, existing: 2, periods: 2, unresolved_roles: ['PLANNING_AGENCY', 'MINISTER'] })).toEqual({ created: 6, existing: 2, periods: 2, unresolvedRoles: ['PLANNING_AGENCY'] });
    expect(toGeneration(undefined)).toEqual({ created: 0, existing: 0, periods: 0, unresolvedRoles: [] });
  });
});

describe('dates and phases', () => {
  it('writes the Vietnam date of an instant and the last day of a half-open period', () => {
    expect(vietnamToday(Date.parse('2026-06-30T20:00:00Z'))).toBe('2026-07-01');
    expect(vietnamToday(Date.parse('2026-06-30T16:59:00Z'))).toBe('2026-06-30');
    expect(lastDayOf('2027-01-01')).toBe('2026-12-31');
    expect(lastDayOf('2026-03-01')).toBe('2026-02-28');
    expect(lastDayOf(null)).toBeNull();
    expect(lastDayOf('not a date')).toBe('not a date');
  });

  it('judges a revision on a date: draft, upcoming, in force, or ended on the day its end begins', () => {
    expect(phaseOf(form({ status: 'DRAFT' }), '2026-06-01')).toBe('draft');
    expect(phaseOf(form({ effective_from: '2026-07-01' }), '2026-06-30')).toBe('scheduled');
    expect(phaseOf(form(), '2026-06-30')).toBe('inForce');
    expect(phaseOf(form({ status: 'RETIRED', effective_until: '2026-07-01' }), '2026-06-30')).toBe('inForce');
    expect(phaseOf(form({ status: 'RETIRED', effective_until: '2026-07-01' }), '2026-07-01')).toBe('ended');
  });

  it('offers the years around today and the years that are loaded, once each', () => {
    expect(yearsAround('2026-10-24', [])).toEqual([2025, 2026, 2027]);
    expect(yearsAround('2026-10-24', [2030, 2027, 2020])).toEqual([2020, 2025, 2026, 2027, 2030]);
  });

  it('accepts a year of four digits in the range of the server', () => {
    expect(validateYear('2026')).toBe(2026);
    for (const bad of ['', '26', '20266', '1999', '3000', '20x6', ' 2026']) expect(validateYear(bad)).toBeUndefined();
  });
});

describe('what a person may do with a revision', () => {
  const context = { membershipId: 'ME', permissions: ['mne.read', 'mne.form.approve'] as readonly string[] | undefined, frozen: false, approve: 'mne.form.approve' };

  it('lets someone other than the maker publish a draft', () => {
    expect(actionsFor(form({ status: 'DRAFT', created_by: 'SOMEONE' }), context)).toEqual({ publish: true, publishNeedsOther: false });
  });

  it('tells the maker that another person has to publish, whatever the letter case of the ids', () => {
    expect(actionsFor(form({ status: 'DRAFT', created_by: 'me' }), context)).toEqual({ publish: false, publishNeedsOther: true });
  });

  it('offers nothing on a revision that is not a draft, to a person without the permission, or on a suspended tenant', () => {
    const none = { publish: false, publishNeedsOther: false };
    expect(actionsFor(form({ status: 'PUBLISHED' }), context)).toEqual(none);
    expect(actionsFor(form({ status: 'DRAFT' }), { ...context, permissions: ['mne.read'] })).toEqual(none);
    expect(actionsFor(form({ status: 'DRAFT' }), { ...context, frozen: true })).toEqual(none);
  });

  it('leaves the decision to the server while the grants are not known', () => {
    expect(actionsFor(form({ status: 'DRAFT', created_by: 'SOMEONE' }), { ...context, permissions: undefined }).publish).toBe(true);
    expect(actionsFor(form({ status: 'DRAFT', created_by: 'SOMEONE' }), { ...context, membershipId: undefined }).publish).toBe(true);
  });
});

describe('the labels and the calendar', () => {
  it('names the confirmations a legal parameter waits for, or [CXN] when its text names none', () => {
    expect(cxnTags(['CXN-10', 'CXN-13'])).toBe('[CXN-10] [CXN-13]');
    expect(cxnTags([])).toBe('[CXN]');
  });

  it('groups the obligations by the month of their due date, in calendar order', () => {
    const groups = groupByMonth([obligation(1, { due_date: '2027-02-10' }), obligation(2), obligation(3, { due_date: '2026-07-20' }), obligation(4, { due_date: '2027-02-01' })]);
    expect(groups.map((group) => [group.month, group.items.length])).toEqual([['2026-07', 2], ['2027-02', 2]]);
    expect(groupByMonth([])).toEqual([]);
  });

  it('calls an obligation overdue only when it is late with a count of days', () => {
    expect(isOverdue(obligation(1, { is_late: true, days_late: 5 }))).toBe(true);
    expect(isOverdue(obligation(1, { is_late: true, days_late: null }))).toBe(false);
    expect(isOverdue(obligation(1, { is_late: false, days_late: 0 }))).toBe(false);
  });
});

describe('the form of a new revision', () => {
  it('accepts a complete revision and writes the body of createMneFormVersion in the order of the formats', () => {
    expect(validateRevision(VALID)).toEqual({});
    expect(revisionBody(VALID)).toEqual({
      form_code: 'TT44-M02',
      title: 'Overall report',
      report_kind: 'OVERALL_SEMIANNUAL',
      legal_basis: 'Circular 44/2026/TT-BTC [CXN-10]',
      effective_from: '2026-01-01',
      schema_json: { tables: [] },
      doc_template_code: 'MNE-TT44-M02',
      export_formats: ['XLSX', 'PDF'],
    });
    expect(revisionBody({ ...VALID, legalConfirmationRef: ' CXN-10-OK ', effectiveUntil: '2027-01-01', formCode: ' TT44-M02 ' })).toMatchObject({
      legal_confirmation_ref: 'CXN-10-OK',
      effective_until: '2027-01-01',
      form_code: 'TT44-M02',
    });
  });

  it('starts from an empty draft that asks for everything', () => {
    expect(Object.keys(validateRevision(EMPTY_REVISION)).sort()).toEqual(['docTemplateCode', 'effectiveFrom', 'formCode', 'legalBasis', 'reportKind', 'title']);
  });

  it.each([
    ['formCode', { formCode: 'has space' }, 'format'],
    ['title', { title: 'ab' }, 'tooShort'],
    ['title', { title: 'x'.repeat(501) }, 'tooLong'],
    ['legalBasis', { legalBasis: '  ' }, 'required'],
    ['legalBasis', { legalBasis: 'x'.repeat(2001) }, 'tooLong'],
    ['legalConfirmationRef', { legalConfirmationRef: 'x'.repeat(51) }, 'tooLong'],
    ['effectiveFrom', { effectiveFrom: '2026-02-30' }, 'date'],
    ['effectiveUntil', { effectiveUntil: '2026-13-01' }, 'date'],
    ['effectiveUntil', { effectiveUntil: '2026-01-01' }, 'order'],
    ['docTemplateCode', { docTemplateCode: 'x'.repeat(81) }, 'tooLong'],
    ['exportFormats', { exportFormats: [] }, 'formats'],
    ['schemaText', { schemaText: '[1]' }, 'json'],
    ['schemaText', { schemaText: '{broken' }, 'json'],
    ['schemaText', { schemaText: 'null' }, 'json'],
  ] as Array<[keyof RevisionValues, Partial<RevisionValues>, string]>)('names the problem of %s (%j): %s', (field, overrides, expected) => {
    expect(validateRevision({ ...VALID, ...overrides })[field]).toBe(expected);
  });

  it('does not compare the end with a start that is itself wrong', () => {
    expect(validateRevision({ ...VALID, effectiveFrom: '', effectiveUntil: '2026-01-01' })).toEqual({ effectiveFrom: 'required' });
  });
});

describe('why a command failed', () => {
  it.each([
    ['VERSION_CONFLICT', 409, 'conflict'],
    ['SELF_APPROVAL_DENIED', 403, 'selfApproval'],
    ['REPORT_STATE_INVALID', 409, 'stateInvalid'],
    ['FORM_RANGE_OVERLAP', 409, 'rangeOverlap'],
    ['DOC_TEMPLATE_MISSING', 422, 'templateMissing'],
    ['LEGAL_BASIS_REQUIRED', 422, 'invalid'],
    ['VALIDATION_FAILED', 422, 'invalid'],
    ['INVALID_REQUEST', 400, 'invalid'],
    ['FIELD_NOT_ALLOWED', 400, 'invalid'],
    ['RESOURCE_NOT_FOUND', 404, 'notFound'],
    ['SCOPE_DENIED', 403, 'denied'],
    ['ENTITLEMENT_DENIED', 403, 'denied'],
    ['SESSION_EXPIRED', 401, 'session'],
    ['SOMETHING_NEW', 500, 'general'],
  ])('maps %s (%i) to %s', (code, status, reason) => {
    expect(describeProblem(problem(status, code, 'legal_basis'))).toEqual({ reason, field: 'legal_basis' });
  });

  it('maps a failure that is not an API error to the general message', () => {
    expect(describeProblem(new Error('boom'))).toEqual({ reason: 'general', field: undefined });
    expect(describeGenerationProblem(new Error('boom'))).toBe('general');
  });

  it.each([
    ['NO_EFFECTIVE_RULE', 422, 'noRule'],
    ['FORM_NOT_EFFECTIVE', 422, 'formNotEffective'],
    ['CALENDAR_NOT_EFFECTIVE', 422, 'calendar'],
    ['SCOPE_DENIED', 403, 'scopeDenied'],
    ['VALIDATION_FAILED', 422, 'invalid'],
    ['INVALID_REQUEST', 400, 'invalid'],
    ['SESSION_EXPIRED', 401, 'session'],
    ['SOMETHING_NEW', 500, 'general'],
  ])('maps the generation failure %s (%i) to %s', (code, status, expected) => {
    expect(describeGenerationProblem(problem(status, code))).toBe(expected);
  });
});
