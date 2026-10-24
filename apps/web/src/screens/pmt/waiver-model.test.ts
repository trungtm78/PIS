import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { waiverLine } from './dossier-test-support';
import {
  EMPTY_WAIVER_FILTER,
  EMPTY_WAIVER_FORM,
  FIELD_OF_DETAIL,
  WAIVER_MAX_DAYS,
  daysLeft,
  describeWaiverProblem,
  filterWaivers,
  grantBody,
  hasErrors,
  latestWaiverDay,
  phaseOf,
  toWaiver,
  validateRevoke,
  validateWaiver,
} from './waiver-model';
import type { WaiverForm, WaiverView } from './waiver-model';

const TODAY = '2026-10-24';
const DOCUMENT = '00000000-0000-4000-8000-000000000104';
const PROJECT = '00000000-0000-4000-8000-000000000103';
const TYPE = '00000000-0000-4000-8000-000000000106';
const form = (change: Partial<WaiverForm> = {}): WaiverForm => ({ projectId: PROJECT, gateCode: 'START_CONSTRUCTION', permitTypeId: TYPE, reason: 'Cơ quan cho phép khởi công trước', documentVersionId: DOCUMENT, validUntil: '2026-11-20', ...change });
const problem = (code: string, extensions: Record<string, unknown> = {}, detail?: string) => new ApiError({ status: 422, code, correlationId: 'c', extensions, ...(detail === undefined ? {} : { detail }) });
const view = (change: Record<string, unknown> = {}): WaiverView => toWaiver(waiverLine(1, change)) as WaiverView;

describe('reading a waiver', () => {
  it('reads the project, the gate, the permit type, the reason, the last day and the state', () => {
    expect(toWaiver(waiverLine(1))).toEqual({
      id: waiverLine(1).id,
      projectId: waiverLine(1).project.id,
      projectCode: 'DA-2026-001',
      projectName: 'Dự án số 1',
      gateCode: 'START_CONSTRUCTION',
      permitTypeId: waiverLine(1).permit_type_id,
      permitTypeCode: 'PERMIT_1',
      permitTypeName: 'Giấy phép 1',
      reason: 'Cơ quan có thẩm quyền cho phép khởi công trước 1',
      decisionDocumentVersionId: waiverLine(1).decision_document_version_id,
      validUntil: '2026-11-20',
      grantedOn: '2026-10-20',
      status: 'ACTIVE',
      revokedOn: null,
      revokedReason: null,
      version: 1,
    });
    expect(toWaiver(waiverLine(1, { status: 'REVOKED', revoked_on: '2026-10-22', revoked_reason: 'Giấy phép đã có' }))).toMatchObject({ status: 'REVOKED', revokedOn: '2026-10-22', revokedReason: 'Giấy phép đã có' });
    expect(toWaiver(waiverLine(1, { permit_type_name: undefined, project: { id: PROJECT } }))).toMatchObject({ permitTypeName: 'PERMIT_1', projectCode: '', projectName: '' });
  });

  it.each([
    ['not an object', 'x'],
    ['no id', { ...waiverLine(1), id: undefined }],
    ['no project', { ...waiverLine(1), project: null }],
    ['a gate that is not one', waiverLine(1, { gate_code: 'ANY' })],
    ['a state that is not one', waiverLine(1, { status: 'OPEN' })],
    ['no permit type', waiverLine(1, { permit_type_id: undefined })],
    ['no reason', waiverLine(1, { reason: '' })],
    ['no document', waiverLine(1, { decision_document_version_id: undefined })],
    ['no last day', waiverLine(1, { valid_until: undefined })],
    ['no day granted', waiverLine(1, { granted_on: undefined })],
    ['a version that is not whole', waiverLine(1, { version: 1.5 })],
  ])('refuses %s', (_name, raw) => {
    expect(toWaiver(raw)).toBeUndefined();
  });
});

describe('the days of a waiver', () => {
  it('counts the longest from today, today included, and the days left to the last day', () => {
    expect(WAIVER_MAX_DAYS).toBe(90);
    expect(latestWaiverDay(TODAY)).toBe('2027-01-21');
    expect(latestWaiverDay('2026-12-31')).toBe('2027-03-30');
    expect(daysLeft({ validUntil: TODAY }, TODAY)).toBe(0);
    expect(daysLeft({ validUntil: '2026-11-20' }, TODAY)).toBe(27);
    expect(daysLeft({ validUntil: '2026-10-20' }, TODAY)).toBe(-4);
  });

  it('is in force until the end of its last day, lapsed after it or once stored as expired, and revoked once revoked', () => {
    expect(phaseOf({ status: 'ACTIVE', validUntil: TODAY }, TODAY)).toBe('inForce');
    expect(phaseOf({ status: 'ACTIVE', validUntil: '2026-10-23' }, TODAY)).toBe('lapsed');
    expect(phaseOf({ status: 'EXPIRED', validUntil: '2026-12-01' }, TODAY)).toBe('lapsed');
    expect(phaseOf({ status: 'REVOKED', validUntil: '2026-12-01' }, TODAY)).toBe('revoked');
  });

  it('filters by state', () => {
    const list = [view({ status: 'ACTIVE' }), view({ status: 'EXPIRED' }), view({ status: 'REVOKED' })];
    expect(filterWaivers(list, EMPTY_WAIVER_FILTER)).toHaveLength(3);
    expect(filterWaivers(list, { status: 'EXPIRED' }).map((waiver) => waiver.status)).toEqual(['EXPIRED']);
  });
});

describe('validating the form before it is sent', () => {
  it('accepts a complete form with a last day within the longest', () => {
    expect(hasErrors(validateWaiver(form(), TODAY))).toBe(false);
    expect(hasErrors(validateWaiver(form({ validUntil: TODAY }), TODAY))).toBe(false);
    expect(hasErrors(validateWaiver(form({ validUntil: latestWaiverDay(TODAY) }), TODAY))).toBe(false);
  });

  it('says what is missing', () => {
    expect(validateWaiver(EMPTY_WAIVER_FORM, TODAY)).toEqual({ projectId: 'required', permitTypeId: 'required', reason: 'required', documentVersionId: 'required', validUntil: 'required' });
    expect(validateWaiver(form({ reason: '   ' }), TODAY).reason).toBe('required');
  });

  it('judges the reason, the document and the last day', () => {
    expect(validateWaiver(form({ reason: 'x'.repeat(2001) }), TODAY).reason).toBe('tooLong');
    expect(validateWaiver(form({ documentVersionId: 'nope' }), TODAY).documentVersionId).toBe('invalidId');
    expect(validateWaiver(form({ validUntil: '2026-02-30' }), TODAY).validUntil).toBe('invalidDate');
    expect(validateWaiver(form({ validUntil: '24/10/2026' }), TODAY).validUntil).toBe('invalidDate');
    expect(validateWaiver(form({ validUntil: '2026-10-23' }), TODAY).validUntil).toBe('pastDate');
    expect(validateWaiver(form({ validUntil: '2027-01-22' }), TODAY).validUntil).toBe('beyondMaximum');
  });

  it('judges the revocation reason', () => {
    expect(validateRevoke('  ')).toBe('required');
    expect(validateRevoke('x'.repeat(2001))).toBe('tooLong');
    expect(validateRevoke('Giấy phép đã có')).toBeUndefined();
  });
});

describe('the body of the command', () => {
  it('sends the allowlist of the contract, trimmed, with the document id in lower case', () => {
    expect(grantBody(form({ reason: '  Cơ quan cho phép  ', documentVersionId: ` ${DOCUMENT.toUpperCase()} ` }))).toEqual({
      project_id: PROJECT,
      gate_code: 'START_CONSTRUCTION',
      permit_type_id: TYPE,
      reason: 'Cơ quan cho phép',
      decision_document_version_id: DOCUMENT,
      valid_until: '2026-11-20',
    });
  });
});

describe('what the server refused', () => {
  it('names the reason, the longest and the last day the server counted', () => {
    expect(describeWaiverProblem(problem('WAIVER_TOO_LONG', { max_days: 90, latest_day: '2027-01-21' }, 'valid_until'))).toEqual({ reason: 'tooLong', field: 'valid_until', maxDays: 90, latestDay: '2027-01-21' });
    const reasons: Record<string, string> = {
      SELF_APPROVAL_DENIED: 'selfApproval',
      DECISION_DOCUMENT_REQUIRED: 'documentRequired',
      WAIVER_STATE_INVALID: 'stateInvalid',
      VALIDATION_FAILED: 'validation',
      FIELD_NOT_ALLOWED: 'validation',
      INVALID_REQUEST: 'validation',
      RESOURCE_NOT_FOUND: 'notFound',
      SCOPE_DENIED: 'denied',
      PERMISSION_DENIED: 'denied',
      SOMETHING_ELSE: 'general',
    };
    for (const [code, reason] of Object.entries(reasons)) expect(describeWaiverProblem(problem(code)).reason).toBe(reason);
    expect(describeWaiverProblem(new Error('offline'))).toEqual({ reason: 'general', field: undefined, maxDays: undefined, latestDay: undefined });
  });

  it('points a refusal at the field of the form it is about', () => {
    expect(FIELD_OF_DETAIL).toEqual({
      project_id: 'projectId',
      gate_code: 'gateCode',
      permit_type_id: 'permitTypeId',
      reason: 'reason',
      decision_document_version_id: 'documentVersionId',
      valid_until: 'validUntil',
    });
  });
});
