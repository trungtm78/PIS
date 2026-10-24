import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_ADD_PERMIT,
  EMPTY_DECISION,
  EMPTY_RENEWAL,
  EMPTY_REVOCATION,
  actionsFor,
  daysRemaining,
  describePermitProblem,
  dossierLink,
  emptyMilestone,
  isExpiring,
  isValidOn,
  permitLink,
  projectsWithoutDossier,
  statusTone,
  stepsFor,
  toAddPermitBody,
  toDecisionBody,
  toDossier,
  toDossierLine,
  toMilestoneBody,
  toPermitDetail,
  toPermitLine,
  toProjectOption,
  toRenewalBody,
  toRevocationBody,
  validateAddPermit,
  validateDecision,
  validateMilestone,
  validateRenewal,
  validateRevocation,
  PERMIT_STATUSES,
} from './dossier-model';
import type { DecisionForm, PermitLineView } from './dossier-model';
import { DOCUMENT, dossier, dossierLine, milestone, permitDetail, permitLine, projectRow } from './dossier-test-support';

const TODAY = '2026-10-24';
const problem = (code: string, detail?: string) => new ApiError({ status: 409, code, correlationId: 'c', retryAfterSeconds: undefined, detail, extensions: {} });
const view = (overrides: Record<string, unknown> = {}): PermitLineView => toPermitLine(permitLine(1, overrides)) as PermitLineView;

describe('the readers of the dossier read model (PMT-01, PMT-02)', () => {
  it('reads a dossier line with its counts and the person in charge', () => {
    expect(toDossierLine(dossierLine(1, { owner_membership: { membership_id: 'm1', display_name: 'Nguyễn Văn A' }, project_component_code: 'HP1' }))).toMatchObject({
      projectCode: 'DA-2026-001',
      projectComponentCode: 'HP1',
      owner: { membershipId: 'm1', displayName: 'Nguyễn Văn A' },
      status: 'OPEN',
      readinessPct: '50.00',
      requiredCount: 2,
      satisfiedCount: 1,
      version: 1,
    });
    expect(toDossierLine(dossierLine(1))?.owner).toBeNull();
  });

  it.each([
    ['not an object', 'text'],
    ['without an id', { ...dossierLine(1), id: undefined }],
    ['with an unknown status', { ...dossierLine(1), status: 'ARCHIVED' }],
    ['with a readiness that is not a number', { ...dossierLine(1), readiness_pct: 'half' }],
    ['with a count that is not a whole number', { ...dossierLine(1), issued_count: 1.5 }],
    ['without a version', { ...dossierLine(1), version: undefined }],
  ])('leaves out a dossier line %s', (_name, raw) => {
    expect(toDossierLine(raw)).toBeUndefined();
  });

  it('reads a permit with the type version it was written under, and leaves out a permit it cannot trust', () => {
    expect(toPermitLine(permitLine(2, { permit_type_revision: 3, cxn_ref: 'CXN-EXE-03', responsible_membership: { membership_id: 'm2', display_name: 'B' }, no_expiry: true }))).toMatchObject({
      permitTypeCode: 'PERMIT_2',
      permitTypeRevision: 3,
      cxnRef: 'CXN-EXE-03',
      responsible: { membershipId: 'm2', displayName: 'B' },
      noExpiry: true,
      isRequired: true,
    });
    expect(toPermitLine({ ...permitLine(1), status: 'LOST' })).toBeUndefined();
    expect(toPermitLine({ ...permitLine(1), permit_type_revision: 'one' })).toBeUndefined();
    expect(toPermitLine(null)).toBeUndefined();
  });

  it('reads a dossier with its permits and skips the permit rows that are not readable', () => {
    const read = toDossier(dossier(1, [permitLine(1), { id: 'broken' }, permitLine(2, { status: 'ISSUED' })]));
    expect(read?.permits.map((permit) => permit.permitTypeCode)).toEqual(['PERMIT_1', 'PERMIT_2']);
    expect(toDossier({ ...dossier(1), permits: 'none' })?.permits).toEqual([]);
    expect(toDossier({ id: 'x' })).toBeUndefined();
  });

  it('reads a permit with its milestones in the order given and skips a milestone it cannot trust', () => {
    const read = toPermitDetail(permitDetail(1, { milestones: [milestone(1), milestone(2, { step_code: 'ACKNOWLEDGED' }), milestone(3, { step_code: 'NOPE' }), 'x'], document_version_id: DOCUMENT, revoke_reason: 'r' }));
    expect(read?.milestones.map((step) => step.stepCode)).toEqual(['SUBMITTED', 'ACKNOWLEDGED']);
    expect(read).toMatchObject({ dossierId: expect.any(String), documentVersionId: DOCUMENT, revokeReason: 'r', exemptionBasis: null });
    expect(toPermitDetail({ ...permitDetail(1), milestones: undefined })?.milestones).toEqual([]);
    expect(toPermitDetail({ ...permitDetail(1), project_code: undefined })).toBeUndefined();
    expect(toPermitDetail(permitLine(1))).toBeUndefined();
  });

  it('reads a project option and leaves out a row without an owner unit', () => {
    expect(toProjectOption(projectRow(1))).toMatchObject({ code: 'DA-2026-001', name: 'Dự án số 1' });
    expect(toProjectOption({ ...projectRow(1), owner_unit_id: undefined })).toBeUndefined();
    expect(toProjectOption(7)).toBeUndefined();
  });

  it('offers the projects that have no dossier of their own yet, and counts a dossier of a component as none', () => {
    const projects = [1, 2, 3].map((n) => toProjectOption(projectRow(n)) as NonNullable<ReturnType<typeof toProjectOption>>);
    const taken = [toDossierLine(dossierLine(1)), toDossierLine(dossierLine(2, { project_component_code: 'HP1' }))].flatMap((line) => line ?? []);
    expect(projectsWithoutDossier(projects, taken).map((project) => project.code)).toEqual(['DA-2026-002', 'DA-2026-003']);
  });

  it('links to the dossier and to the permit', () => {
    expect(dossierLink('a b')).toBe('/pmt/pmt-01?dossier=a%20b');
    expect(permitLink('p1')).toBe('/pmt/pmt-02?permit=p1');
  });
});

describe('what a permit status means on the screen', () => {
  it('gives every status a tone, a word comes with it', () => {
    expect(PERMIT_STATUSES.map((status) => [status, statusTone(status)])).toEqual([
      ['PLANNED', 'gray'],
      ['SUBMITTED', 'warn'],
      ['IN_APPRAISAL', 'warn'],
      ['SUPPLEMENT_REQUESTED', 'warn'],
      ['ISSUED', 'green'],
      ['REJECTED', 'red'],
      ['EXPIRED', 'red'],
      ['REVOKED', 'red'],
      ['SUPERSEDED', 'gray'],
      ['EXEMPTED', 'green'],
    ]);
  });

  it('counts the days to the last day, which is itself a day of validity (BR-PMT-01)', () => {
    expect(daysRemaining('2026-10-24', TODAY)).toBe(0);
    expect(daysRemaining('2026-12-23', TODAY)).toBe(60);
    expect(daysRemaining('2026-10-20', TODAY)).toBe(-4);
    expect(daysRemaining(null, TODAY)).toBeNull();
  });

  it('judges validity on a day by both ends, and only for an issued permit', () => {
    const issued = view({ status: 'ISSUED', valid_from: '2026-10-01', valid_until: '2026-10-31' });
    expect(isValidOn(issued, '2026-09-30')).toBe(false);
    expect(isValidOn(issued, '2026-10-01')).toBe(true);
    expect(isValidOn(issued, '2026-10-31')).toBe(true);
    expect(isValidOn(issued, '2026-11-01')).toBe(false);
    expect(isValidOn(view({ status: 'ISSUED', valid_from: '2026-10-01', no_expiry: true }), '2099-01-01')).toBe(true);
    expect(isValidOn(view({ status: 'ISSUED', valid_from: null, valid_until: '2026-10-31' }), TODAY)).toBe(true);
    expect(isValidOn(view({ status: 'ISSUED', valid_from: '2026-10-01', valid_until: null }), TODAY)).toBe(false);
    expect(isValidOn(view({ status: 'REVOKED', valid_from: '2026-10-01', valid_until: '2026-10-31' }), TODAY)).toBe(false);
  });

  it('calls a valid permit expiring inside 60 days and not before or after', () => {
    expect(isExpiring(view({ status: 'ISSUED', valid_from: '2026-01-01', valid_until: '2026-12-23' }), TODAY)).toBe(true);
    expect(isExpiring(view({ status: 'ISSUED', valid_from: '2026-01-01', valid_until: '2026-12-24' }), TODAY)).toBe(false);
    expect(isExpiring(view({ status: 'ISSUED', valid_from: '2026-01-01', valid_until: '2026-10-23' }), TODAY)).toBe(false);
    expect(isExpiring(view({ status: 'ISSUED', valid_from: '2026-01-01', no_expiry: true }), TODAY)).toBe(false);
  });

  it('offers the steps the status allows, as the server does (PMT 4)', () => {
    expect(PERMIT_STATUSES.map((status) => [status, stepsFor(status)])).toEqual([
      ['PLANNED', ['SUBMITTED']],
      ['SUBMITTED', ['ACKNOWLEDGED']],
      ['IN_APPRAISAL', ['APPRAISAL_MEETING', 'SUPPLEMENT_REQUESTED', 'DECISION']],
      ['SUPPLEMENT_REQUESTED', ['SUPPLEMENT_SUBMITTED']],
      ['ISSUED', ['HANDED_OVER']],
      ['REJECTED', []],
      ['EXPIRED', []],
      ['REVOKED', []],
      ['SUPERSEDED', []],
      ['EXEMPTED', []],
    ]);
  });

  it('offers a decision in appraisal, a renewal for an issued or expired permit that has an end, and a revocation of an issued one', () => {
    expect(actionsFor({ status: 'IN_APPRAISAL', noExpiry: false })).toMatchObject({ decide: true, renew: false, revoke: false });
    expect(actionsFor({ status: 'ISSUED', noExpiry: false })).toMatchObject({ decide: false, renew: true, revoke: true });
    expect(actionsFor({ status: 'ISSUED', noExpiry: true })).toMatchObject({ renew: false, revoke: true });
    expect(actionsFor({ status: 'EXPIRED', noExpiry: false })).toMatchObject({ renew: true, revoke: false });
    expect(actionsFor({ status: 'SUPERSEDED', noExpiry: false })).toEqual({ steps: [], decide: false, renew: false, revoke: false });
  });
});

describe('the milestone form', () => {
  it('needs the day a step happened on, never a day to come, and a planned day for a step that has not happened', () => {
    expect(validateMilestone(emptyMilestone('SUBMITTED'), TODAY)).toEqual({ actualOn: 'required' });
    expect(validateMilestone({ ...emptyMilestone('SUBMITTED'), actualOn: '2026-10-25' }, TODAY)).toEqual({ actualOn: 'future' });
    expect(validateMilestone({ ...emptyMilestone('SUBMITTED'), actualOn: '2026-13-01' }, TODAY)).toEqual({ actualOn: 'invalidDate' });
    expect(validateMilestone({ ...emptyMilestone('SUBMITTED'), actualOn: TODAY }, TODAY)).toEqual({});
    expect(validateMilestone(emptyMilestone('APPRAISAL_MEETING'), TODAY)).toEqual({ plannedOn: 'required' });
    expect(validateMilestone({ ...emptyMilestone('APPRAISAL_MEETING'), plannedOn: '2026-12-01' }, TODAY)).toEqual({});
    expect(validateMilestone({ ...emptyMilestone('APPRAISAL_MEETING'), actualOn: TODAY }, TODAY)).toEqual({});
  });

  it('refuses a planned day that is not a day, a note that is too long and a document that is not an id', () => {
    const form = { ...emptyMilestone('APPRAISAL_MEETING'), plannedOn: '2026-02-30', note: 'x'.repeat(2001), documentVersionId: 'scan' };
    expect(validateMilestone(form, TODAY)).toEqual({ plannedOn: 'invalidDate', note: 'tooLong', documentVersionId: 'invalidId' });
  });

  it('sends only what was typed, trimmed', () => {
    expect(toMilestoneBody({ step: 'SUBMITTED', plannedOn: '', actualOn: TODAY, note: '  Filed  ', documentVersionId: ` ${DOCUMENT} ` })).toEqual({
      step_code: 'SUBMITTED',
      actual_on: TODAY,
      note: 'Filed',
      document_version_id: DOCUMENT,
    });
    expect(toMilestoneBody(emptyMilestone('DECISION'))).toEqual({ step_code: 'DECISION' });
  });
});

describe('the decision form (AC-ST-PMT-002-1)', () => {
  const issue = (overrides: Partial<DecisionForm> = {}): DecisionForm => ({ ...EMPTY_DECISION, permitNo: 'GP-0001', validFrom: '2026-10-20', validUntil: '2027-10-19', documentVersionId: DOCUMENT, ...overrides });

  it('needs a number and the scan to issue a permit, and says so before the server does', () => {
    expect(validateDecision(EMPTY_DECISION, TODAY)).toEqual({ permitNo: 'required', documentVersionId: 'scanRequired' });
    expect(validateDecision(issue(), TODAY)).toEqual({});
    expect(validateDecision(issue({ permitNo: 'x'.repeat(101) }), TODAY)).toEqual({ permitNo: 'tooLong' });
    expect(validateDecision(issue({ documentVersionId: 'nope' }), TODAY)).toEqual({ documentVersionId: 'invalidId' });
  });

  it('refuses days that are not days, an issue day to come, an end before the start, and an end together with no expiry', () => {
    expect(validateDecision(issue({ issuedOn: '2026-10-25' }), TODAY)).toEqual({ issuedOn: 'future' });
    expect(validateDecision(issue({ issuedOn: '2026-02-30', validFrom: '2026-13-01', validUntil: '2026-00-00' }), TODAY)).toEqual({ issuedOn: 'invalidDate', validFrom: 'invalidDate', validUntil: 'invalidDate' });
    expect(validateDecision(issue({ validUntil: '2026-10-19' }), TODAY)).toEqual({ validUntil: 'dateOrder' });
    expect(validateDecision(issue({ noExpiry: true }), TODAY)).toEqual({ validUntil: 'endOrExpiry' });
    expect(validateDecision(issue({ noExpiry: true, validUntil: '' }), TODAY)).toEqual({});
    expect(validateDecision(issue({ validUntil: '' }), TODAY)).toEqual({});
  });

  it('needs a reason to reject, and no number or days', () => {
    expect(validateDecision({ ...EMPTY_DECISION, outcome: 'REJECTED' }, TODAY)).toEqual({ reason: 'required' });
    expect(validateDecision({ ...EMPTY_DECISION, outcome: 'REJECTED', reason: 'Incomplete file' }, TODAY)).toEqual({});
    expect(
      validateDecision({ ...EMPTY_DECISION, outcome: 'REJECTED', reason: 'r', permitNo: 'GP', issuedOn: TODAY, validFrom: TODAY, validUntil: TODAY, documentVersionId: 'bad' }, TODAY),
    ).toEqual({ permitNo: 'notAllowed', issuedOn: 'notAllowed', validFrom: 'notAllowed', validUntil: 'notAllowed', documentVersionId: 'invalidId' });
    expect(validateDecision({ ...EMPTY_DECISION, outcome: 'REJECTED', reason: 'r', noExpiry: true }, TODAY)).toEqual({ validUntil: 'notAllowed' });
  });

  it('sends what an issue or a rejection needs and nothing else', () => {
    expect(toDecisionBody(issue({ permitNo: ' GP-0001 ', issuedOn: '2026-10-20' }))).toEqual({
      outcome: 'ISSUED',
      permit_no: 'GP-0001',
      issued_on: '2026-10-20',
      valid_from: '2026-10-20',
      valid_until: '2027-10-19',
      document_version_id: DOCUMENT,
    });
    expect(toDecisionBody(issue({ noExpiry: true, validUntil: '' }))).toEqual({ outcome: 'ISSUED', permit_no: 'GP-0001', valid_from: '2026-10-20', no_expiry: true, document_version_id: DOCUMENT });
    expect(toDecisionBody(issue({ validFrom: '', validUntil: '' }))).toEqual({ outcome: 'ISSUED', permit_no: 'GP-0001', document_version_id: DOCUMENT });
    expect(toDecisionBody({ ...EMPTY_DECISION, outcome: 'REJECTED', reason: '  Incomplete  ', documentVersionId: DOCUMENT })).toEqual({ outcome: 'REJECTED', reason: 'Incomplete', document_version_id: DOCUMENT });
    expect(toDecisionBody({ ...EMPTY_DECISION, outcome: 'REJECTED', reason: 'r' })).toEqual({ outcome: 'REJECTED', reason: 'r' });
  });
});

describe('the renewal, revocation and add-permit forms', () => {
  const current = { validUntil: '2026-12-31' };

  it('needs a new number, a last day later than the last day before it and not in days gone, and the new scan', () => {
    expect(validateRenewal(EMPTY_RENEWAL, current, TODAY)).toEqual({ newPermitNo: 'required', newValidUntil: 'required', documentVersionId: 'required' });
    expect(validateRenewal({ newPermitNo: 'GP-2', newValidUntil: '2027-12-31', documentVersionId: DOCUMENT }, current, TODAY)).toEqual({});
    expect(validateRenewal({ newPermitNo: 'GP-2', newValidUntil: '2026-12-31', documentVersionId: DOCUMENT }, current, TODAY)).toEqual({ newValidUntil: 'dateOrder' });
    expect(validateRenewal({ newPermitNo: 'GP-2', newValidUntil: '2026-10-23', documentVersionId: DOCUMENT }, { validUntil: null }, TODAY)).toEqual({ newValidUntil: 'past' });
    expect(validateRenewal({ newPermitNo: 'GP-2', newValidUntil: '2026-10-24', documentVersionId: DOCUMENT }, { validUntil: null }, TODAY)).toEqual({});
    expect(validateRenewal({ newPermitNo: 'GP-2', newValidUntil: '2026-02-30', documentVersionId: 'x' }, current, TODAY)).toEqual({ newValidUntil: 'invalidDate', documentVersionId: 'invalidId' });
    expect(toRenewalBody({ newPermitNo: ' GP-2 ', newValidUntil: '2027-12-31', documentVersionId: ` ${DOCUMENT} ` })).toEqual({ new_permit_no: 'GP-2', new_valid_until: '2027-12-31', document_version_id: DOCUMENT });
  });

  it('needs a reason and the decision that takes a permit back', () => {
    expect(validateRevocation(EMPTY_REVOCATION)).toEqual({ reason: 'required', decisionDocumentVersionId: 'required' });
    expect(validateRevocation({ reason: 'r', decisionDocumentVersionId: DOCUMENT })).toEqual({});
    expect(validateRevocation({ reason: 'x'.repeat(2001), decisionDocumentVersionId: 'x' })).toEqual({ reason: 'tooLong', decisionDocumentVersionId: 'invalidId' });
    expect(toRevocationBody({ reason: ' r ', decisionDocumentVersionId: DOCUMENT })).toEqual({ reason: 'r', decision_document_version_id: DOCUMENT });
  });

  it('needs a permit type to add a permit, and sends the optional fields only when typed', () => {
    expect(validateAddPermit(EMPTY_ADD_PERMIT)).toEqual({ permitTypeId: 'required' });
    expect(validateAddPermit({ permitTypeId: 't', authorityName: 'x'.repeat(2001), expectedDecisionOn: '2026-02-30' })).toEqual({ authorityName: 'tooLong', expectedDecisionOn: 'invalidDate' });
    expect(toAddPermitBody({ permitTypeId: 't', authorityName: ' Sở ', expectedDecisionOn: '2026-12-01' })).toEqual({ permit_type_id: 't', authority_name: 'Sở', expected_decision_on: '2026-12-01' });
    expect(toAddPermitBody({ ...EMPTY_ADD_PERMIT, permitTypeId: 't' })).toEqual({ permit_type_id: 't' });
  });
});

describe('what a failed command means', () => {
  it.each([
    ['PERMIT_STATE_INVALID', 'stateInvalid'],
    ['VERSION_CONFLICT', 'versionConflict'],
    ['PERMIT_NO_DUPLICATE', 'numberDuplicate'],
    ['PERMIT_ALREADY_CURRENT', 'alreadyCurrent'],
    ['PERMIT_DOCUMENT_REQUIRED', 'documentRequired'],
    ['PERMIT_TYPE_NOT_EFFECTIVE', 'typeNotEffective'],
    ['DOSSIER_EXISTS', 'dossierExists'],
    ['VALIDATION_FAILED', 'validation'],
    ['FIELD_NOT_ALLOWED', 'validation'],
    ['INVALID_REQUEST', 'validation'],
    ['SCOPE_DENIED', 'denied'],
    ['PERMISSION_DENIED', 'denied'],
    ['RESOURCE_NOT_FOUND', 'notFound'],
    ['SOMETHING_ELSE', 'general'],
  ])('maps %s to %s', (code, reason) => {
    expect(describePermitProblem(problem(code, 'permit_no'))).toEqual({ reason, field: 'permit_no' });
  });

  it('maps a failure that is not an answer of the server to the general message', () => {
    expect(describePermitProblem(new Error('boom'))).toEqual({ reason: 'general', field: undefined });
  });
});
